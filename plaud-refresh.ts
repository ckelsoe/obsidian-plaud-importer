// Silent Plaud session refresh (Release B).
//
// Plaud issues a short access token (JWT typ WT, 24h) and a long refresh token
// (urt, 30 days, rotated on use). The web app silently POSTs
// `{apiBase}/auth/refresh-user-token` before the WT expires and gets a fresh
// WT + URT back, so the browser stays logged in for weeks. Our plugin captured
// only the WT and never refreshed, so it hard-failed at ~24h. This module
// replicates that refresh call.
//
// The exact credential the endpoint wants is not fully pinned (an httpOnly
// cookie sent with the request, or an in-memory URT bearer added by the web
// app's axios interceptor). Live tests showed the WT bearer alone and a bare
// cross-origin cookie call each fail. So this sends BOTH candidates in one
// request: the Plaud partition's cookies (read straight from Electron's cookie
// jar, including httpOnly) AND, when we captured it at sign-in, the rotating
// refresh token (WRT) as a bearer. One of the two is the real credential.
//
// Fail-safe by construction: a caller is only ever told to overwrite the stored
// token when the endpoint returns HTTP 2xx, `status: 0`, and an access token
// that decodes as typ WT with a future exp. Every other outcome is a failure
// the caller falls through on, leaving today's token untouched.
//
// The HTTP call and cookie read are injected (RefreshTransport) so the response
// handling is unit-testable without Electron; main.ts wires the real transport.

import type { DebugLogger } from './debug-logger';

const REFRESH_ENDPOINT_PATH = '/auth/refresh-user-token';

// The refresh response is a soft envelope like the data API's: HTTP 200 with a
// `status` field. `0` is success; a region mismatch carries the correct host
// under `data.domains.api` and expects a retry there.
const REFRESH_SUCCESS_STATUS = 0;

// Trusted hosts a region switch may redirect the refresh to. The request
// carries credentials, so the redirect target is a trust boundary: only ever
// follow it to a Plaud host.
const ALLOWED_HOST_SUFFIX = '.plaud.ai';
const ALLOWED_EXACT_HOSTS = new Set(['plaud.ai', 'api.plaud.ai']);

// A JWT, optionally bearer-prefixed.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const ACCESS_TOKEN_TYP = 'WT';

/** One HTTP round-trip the refresh needs, plus a read of the partition cookies. */
export interface RefreshTransport {
	/**
	 * POST the given body to `url` with the given headers. Must map any transport
	 * failure (offline, TLS) to a rejected promise, and any HTTP status to a
	 * resolved `{ status, json, text }` (never throw on a 4xx/5xx), mirroring the
	 * Plaud client's Obsidian `requestUrl` adapter.
	 */
	post(req: {
		readonly url: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
	}): Promise<{ status: number; json: unknown; text: string }>;
	/**
	 * Return the `Cookie` header value for the given URL from the Plaud sign-in
	 * partition (including httpOnly cookies), or null when unavailable. Never
	 * throws — a failure resolves to null so the bearer path can still carry the
	 * request.
	 */
	readCookieHeader(url: string): Promise<string | null>;
}

export interface RefreshSessionOptions {
	/** Current Plaud API origin (e.g. https://api.plaud.ai). */
	readonly apiBaseUrl: string;
	/** Stored rotating refresh token (WRT) to send as a bearer, or null. */
	readonly refreshToken: string | null;
	readonly transport: RefreshTransport;
	readonly debugLogger?: DebugLogger;
	/** Injectable clock for testing the exp validation. Defaults to Date.now. */
	readonly now?: () => number;
}

export interface RefreshSuccess {
	readonly ok: true;
	/** Fresh access token (validated typ WT with a future exp). */
	readonly accessToken: string;
	/** Fresh rotating refresh token from the body, or null when absent. */
	readonly refreshToken: string | null;
	/** Origin the refresh succeeded against (may differ after a region switch). */
	readonly apiBaseUrl: string;
}

export interface RefreshFailure {
	readonly ok: false;
	/** Non-identifying reason for the debug log. Never carries a token value. */
	readonly reason: string;
}

export type RefreshResult = RefreshSuccess | RefreshFailure;

/** Reads the JWT header `typ`, or null when the value is not a decodable JWT. */
export function jwtTyp(value: string): string | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const header = decodeJwtSegment(match[0].split('.')[0]);
	return header !== null && typeof header.typ === 'string' ? header.typ : null;
}

/**
 * Reads the JWT `exp` claim as unix MILLISECONDS, or null when the token is not
 * a decodable JWT or has no numeric `exp`. Used to schedule a refresh ~5 min
 * before the access token expires and to enforce the fail-safe future-exp check.
 */
export function decodeJwtExpMs(value: string): number | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const parts = match[0].split('.');
	if (parts.length < 2) {
		return null;
	}
	const payload = decodeJwtSegment(parts[1]);
	if (payload === null || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
		return null;
	}
	return payload.exp * 1000;
}

function decodeJwtSegment(seg: string): Record<string, unknown> | null {
	try {
		const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
		// atob is always present in Obsidian's Electron renderer (and Node 18+);
		// avoid the Node `Buffer` global, which is untyped in the marketplace
		// scan's type-checked lint and trips the no-unsafe-* rules.
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** True when the token decodes as an access token (typ WT) with a future exp. */
export function isFreshAccessToken(token: string, nowMs: number): boolean {
	if (jwtTyp(token) !== ACCESS_TOKEN_TYP) {
		return false;
	}
	const exp = decodeJwtExpMs(token);
	return exp !== null && exp > nowMs;
}

type ParsedRefresh =
	| { readonly kind: 'success'; readonly accessToken: string; readonly refreshToken: string | null }
	| { readonly kind: 'switch'; readonly apiBaseUrl: string }
	| { readonly kind: 'failure'; readonly reason: string };

/**
 * Interpret a refresh response body. Success requires `status: 0` and an access
 * token that is a fresh WT (fail-safe). A non-success body carrying a trusted
 * `data.domains.api` host is a region switch to retry against. Everything else
 * is a failure. Pure and exported for unit testing.
 */
export function parseRefreshResponse(body: unknown, nowMs: number): ParsedRefresh {
	if (!isRecord(body)) {
		return { kind: 'failure', reason: 'response body is not an object' };
	}
	const status = typeof body.status === 'number' ? body.status : null;
	if (status === REFRESH_SUCCESS_STATUS) {
		const accessToken =
			typeof body.access_token === 'string' ? body.access_token.trim() : '';
		if (accessToken.length === 0) {
			return { kind: 'failure', reason: 'success status but no access_token' };
		}
		if (!isFreshAccessToken(accessToken, nowMs)) {
			// Never hand back a token that is not a fresh WT: the caller would
			// otherwise overwrite a still-usable token with a worse one.
			return {
				kind: 'failure',
				reason: 'access_token is not a fresh WT (wrong typ or already expired)',
			};
		}
		const refreshToken =
			typeof body.refresh_token === 'string' && body.refresh_token.trim().length > 0
				? body.refresh_token.trim()
				: null;
		return { kind: 'success', accessToken, refreshToken };
	}
	// Region switch: a non-success body may point at the correct regional host.
	const switchHost = readRegionSwitchHost(body);
	if (switchHost !== null) {
		return { kind: 'switch', apiBaseUrl: switchHost };
	}
	const msg = typeof body.msg === 'string' && body.msg.length > 0 ? body.msg : '(no message)';
	return {
		kind: 'failure',
		reason: `refresh rejected (status ${status ?? 'absent'}: ${msg})`,
	};
}

// Reads a region-switch target from a non-success refresh body. The web app
// reads `data.domains.api` (falling back to `data.domain`); mirror that and
// restrict to trusted Plaud https hosts, returning a bare origin.
function readRegionSwitchHost(body: Record<string, unknown>): string | null {
	const data = body.data;
	if (!isRecord(data)) {
		return null;
	}
	const domains = data.domains;
	const candidate =
		isRecord(domains) && typeof domains.api === 'string'
			? domains.api
			: typeof data.domain === 'string'
				? data.domain
				: null;
	if (candidate === null) {
		return null;
	}
	return normalizePlaudOrigin(candidate);
}

// Normalize a host into a trusted Plaud https origin (scheme + host, no path,
// no userinfo), or null when it is not one. Rejects embedded credentials
// (https://api.plaud.ai@evil.example parses with hostname evil.example).
function normalizePlaudOrigin(value: string): string | null {
	const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
		return null;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	if (!ALLOWED_EXACT_HOSTS.has(host) && !host.endsWith(ALLOWED_HOST_SUFFIX)) {
		return null;
	}
	// Rebuild from the NORMALIZED hostname (lowercased, trailing dot stripped)
	// plus any explicit port, not parsed.host — which would carry a trailing dot
	// or mixed case through and break equality and cookie/host matching.
	const portSuffix = parsed.port === '' ? '' : `:${parsed.port}`;
	return `https://${host}${portSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Attempt one silent session refresh. Sends the Plaud partition cookies and the
 * stored refresh-token bearer (whichever is present) to
 * `{apiBase}/auth/refresh-user-token`, following a single region switch. Returns
 * a fresh WT (+ rotated URT) on success, or a failure the caller falls through
 * on. Never throws: a transport rejection becomes a `RefreshFailure`.
 */
export async function refreshPlaudSession(
	options: RefreshSessionOptions,
): Promise<RefreshResult> {
	const now = options.now ?? (() => Date.now());
	const bearer =
		options.refreshToken !== null && options.refreshToken.trim().length > 0
			? options.refreshToken.trim().replace(/^bearer\s+/i, '')
			: null;

	// Fail closed: the request carries credentials (cookies + refresh bearer), so
	// the destination is a trust boundary. Validate the caller-provided base host
	// too, not just region-switch targets, so a corrupted stored apiBaseUrl can
	// never steer the credentials at an arbitrary host.
	const startOrigin = normalizePlaudOrigin(options.apiBaseUrl);
	if (startOrigin === null) {
		return { ok: false, reason: 'api base url is not a trusted Plaud https origin' };
	}

	const attempt = async (origin: string, depth: number): Promise<RefreshResult> => {
		// `origin` is always a normalized trusted origin (startOrigin, or a
		// validated switch target).
		const url = `${origin}${REFRESH_ENDPOINT_PATH}`;
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		};
		let cookieHeader: string | null = null;
		try {
			cookieHeader = await options.transport.readCookieHeader(url);
		} catch {
			cookieHeader = null;
		}
		if (cookieHeader !== null && cookieHeader.length > 0) {
			headers.Cookie = cookieHeader;
		}
		if (bearer !== null) {
			headers.Authorization = `Bearer ${bearer}`;
		}

		let response: { status: number; json: unknown; text: string };
		try {
			// Empty JSON object body, matching the web app's `post(url, {}, ...)`.
			response = await options.transport.post({ url, headers, body: '{}' });
		} catch (err) {
			return {
				ok: false,
				reason: `transport error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		logRefresh(options.debugLogger, `POST ${REFRESH_ENDPOINT_PATH} -> ${response.status}`);

		if (response.status < 200 || response.status >= 300) {
			return { ok: false, reason: `HTTP ${response.status} from refresh endpoint` };
		}

		const parsed = parseRefreshResponse(response.json, now());
		if (parsed.kind === 'switch') {
			if (depth >= 1 || parsed.apiBaseUrl === origin) {
				return { ok: false, reason: 'refresh region switch did not resolve' };
			}
			logRefresh(options.debugLogger, `region switch to ${parsed.apiBaseUrl}, retrying`);
			return attempt(parsed.apiBaseUrl, depth + 1);
		}
		if (parsed.kind === 'failure') {
			return { ok: false, reason: parsed.reason };
		}
		return {
			ok: true,
			accessToken: parsed.accessToken,
			refreshToken: parsed.refreshToken,
			apiBaseUrl: origin,
		};
	};

	return attempt(startOrigin, 0);
}

// Debug breadcrumb. Never logs a token, cookie, or the Authorization header —
// only the endpoint path and HTTP status, so a copied debug log is safe to share.
function logRefresh(logger: DebugLogger | undefined, message: string): void {
	if (logger?.enabled === true) {
		logger.log({ kind: 'note', endpoint: REFRESH_ENDPOINT_PATH, message });
	}
}
