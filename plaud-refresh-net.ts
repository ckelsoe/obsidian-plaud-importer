// Direct, windowless session refresh. The ONLY background renewal path.
//
// Two API calls on the persistent Plaud sign-in partition. The hidden
// BrowserWindow re-capture this replaced is gone: a background refresh never
// opens a window (the hidden window's login page leaked web.plaud.ai popup
// tabs into the default browser). Reverse-engineered from a full login HAR
// on 2026-07-06 (see dev-docs/plaud-importer/2026-07-06-token-refresh-mechanism.md,
// "WT-mint endpoint IDENTIFIED"). Both the user token (UT) and workspace token
// (WT) live ~24h, so after a day both are stale and the refresh is two steps:
//
//   1. POST /auth/refresh-user-token           empty body; the URT cookie mints a
//                                               fresh UT and rotates the URT cookie
//   2. POST /user-app/auth/workspace/token/{wid}  body {}; the fresh UT cookie
//                                               mints the 24h WT the data API needs
//
// Auth on both calls is the partition's httpOnly cookies, NOT a bearer header
// (the real requests carry no Authorization; the login response body even
// returns empty token strings). A session-bound transport is therefore
// mandatory: it auto-attaches those cookies AND persists call 1's rotated
// Set-Cookie into the jar so call 2 sees the fresh UT. Manual cookie forwarding
// would drop the rotation between the two calls.
//
// FAIL-SAFE: this module only ever RETURNS a candidate token; it never writes
// storage. The caller re-validates (typ WT, future exp) before replacing
// anything, and on any null result the background pauses and prompts the user
// to reconnect. Every step is guarded and the orchestrator never throws.
//
// Hands-on validated 2026-07-09: a manual "Refresh session now" on 0.28.0
// completed this path live end to end (debug log: "net refresh succeeded via
// the direct (windowless) path", next refresh scheduled ~24h out). A failure
// here is benign: it returns null and the caller treats the refresh as failed.
//
// Re-validated 2026-07-26 against Plaud's v2 auth, which the module survives
// unchanged in shape. What was re-measured on a live account that day:
//   - Both steps still authenticate by COOKIE. Presenting either token as a
//     bearer is rejected (`-1002`); the mint succeeds with no Authorization
//     header and the partition's cookies attached.
//   - HTTP status is useless here. Every one of those outcomes is HTTP 200, so
//     selection and error handling read the in-band envelope `status`, which is
//     what this module already does.
//   - The Electron partition really does carry those cookies. That was the one
//     unproven assumption in the whole design (everything else had been measured
//     in Chrome), so it was gated before this module was restored: inside
//     Obsidian, the sign-in partition holds `pld_ut`/`pld_urt` and
//     `session.fetch` attaches them, mint returning in-band `status: 0`. Those
//     two cookies are the whole of the session as far as this module is
//     concerned; the workspace token comes from the caller, out of Obsidian's
//     secret storage. Re-confirmed 2026-08-01 by enumerating a live partition.
//
// The partition is now PER VAULT (issue #87) and arrives as an argument rather
// than a module constant. See plaud-partition.ts.
//
// SCOPE, and it is narrow: this works ONLY for sessions captured through the
// embedded sign-in window, because only that window populates the partition.
// SSO (which completes in the external browser) and bookmarklet captures leave
// the partition empty, so the caller gates on the recorded sign-in method and
// does not attempt this for them. Those users reconnect manually. That is a
// decision, not an oversight.
//
// And it is not indefinite. Refreshing rotates the 30 day user refresh token
// but does NOT extend its expiry (measured: `urt_expire_at` unchanged across a
// successful refresh), so unattended operation ends about 30 days after
// sign-in. User-facing copy must say about 30 days, never "yearly" and never
// "indefinite".

import { decodeJwtPayload } from './plaud-token';

/**
 * A non-empty string claim off the stored token's payload, or null.
 *
 * Reads through plaud-token's decoder rather than a private one: that decoder
 * splits on exactly three base64url segments and refuses a `prefix.<jwt>.suffix`
 * value, which the retired module's unanchored regex search would have accepted.
 * Every other path in the plugin already decodes through it, so sharing it keeps
 * one definition of "a readable token".
 */
function readJwtPayloadClaim(value: string, claim: string): string | null {
	const payload = decodeJwtPayload(value);
	if (payload === null) {
		return null;
	}
	const raw = payload[claim];
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

const REFRESH_USER_TOKEN_PATH = '/auth/refresh-user-token';
const WORKSPACE_TOKEN_PATH_PREFIX = '/user-app/auth/workspace/token/';

// Bound each refresh POST so a stalled request cannot hang the refresh path
// forever. The two calls each complete in a couple of seconds normally; 30s is
// generous headroom. An abort rejects the post, performNetRefresh catches it
// and returns null, and the refresh reports failure cleanly.
const NET_REFRESH_TIMEOUT_MS = 30 * 1000;

// Plaud's "success" status in a JSON envelope. Anything else is treated as a
// failure (fall back), except the region-redirect status handled below.
const STATUS_OK = 0;
// Region-mismatch soft redirect: HTTP 200 whose body carries the regional host
// in data.domains.api. Matches detectRegionRedirect() in plaud-client-re.ts.
const STATUS_REGION_REDIRECT = -302;

// Only ever talk to Plaud's own hosts, even when a redirect body names the
// target. A tampered redirect must not steer a cookie-authenticated call to an
// arbitrary origin.
const ALLOWED_HOST_SUFFIX = '.plaud.ai';
const ALLOWED_EXACT_HOSTS = new Set(['plaud.ai', 'api.plaud.ai']);

/** A single session-bound POST. Injected so tests drive it without Electron. */
export interface SessionPost {
	(
		url: string,
		body: string,
		headers: Readonly<Record<string, string>>,
	): Promise<{ status: number; text: string }>;
}

export interface NetRefreshDeps {
	/** The stored workspace token (may be expired). Source of `wid`/`client_id`. */
	readonly currentToken: string;
	/** Current API origin, no trailing slash, e.g. `https://api.plaud.ai`. */
	readonly baseUrl: string;
	/** Session-bound transport (partition cookie jar). */
	readonly post: SessionPost;
	/**
	 * Optional diagnostic sink. Called at each step/failure so one debug run
	 * pinpoints why the direct path fell back to the window. Only ever receives
	 * HTTP status, the envelope's numeric status, and a short body snippet of a
	 * FAILING response; never a token value.
	 */
	readonly log?: (message: string, payload?: unknown) => void;
}

/**
 * First 200 chars of a response body, for a failure diagnostic, with any
 * JWT-shaped substring redacted first. A failing auth/refresh response should
 * not carry a token, but redacting guarantees the debug logger's no-secrets
 * contract holds even if one ever slips into an error body.
 */
function bodySnippet(text: string): string {
	const redacted = text.replace(
		/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		'[redacted-token]',
	);
	return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted;
}

/** A human-readable `message`/`msg` field off an envelope, when present. */
function envelopeMessage(
	envelope: Record<string, unknown>,
): string | undefined {
	if (typeof envelope.message === 'string') return envelope.message;
	if (typeof envelope.msg === 'string') return envelope.msg;
	return undefined;
}

export interface NetRefreshResult {
	/** The fresh workspace token (typ WT). Caller validates before storing. */
	readonly token: string;
	/** The rotated workspace refresh token, when the mint returned one. */
	readonly refreshToken: string | null;
	/** A regional API origin to persist, when a redirect moved us. */
	readonly apiBaseUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Parse a JSON envelope, or null when the text is not a JSON object. */
function parseEnvelope(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The `wid` claim off the stored token, validated to look like a workspace id.
 * Exported for direct unit testing.
 */
export function extractWorkspaceId(token: string): string | null {
	const wid = readJwtPayloadClaim(token, 'wid');
	return wid !== null && wid.startsWith('ws_') ? wid : null;
}

/**
 * Normalize a URL to its origin (scheme + host, no path/query/userinfo) IF it is
 * a trusted Plaud https host, else null. The cookie-authenticated POSTs attach
 * the partition's httpOnly Plaud session, so every target host this module talks
 * to must pass through here first: a malformed or tampered base/redirect must
 * never be able to steer those cookies at an arbitrary origin. Exported for
 * unit testing.
 */
export function normalizeTrustedOrigin(raw: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	const trusted =
		ALLOWED_EXACT_HOSTS.has(host) || host.endsWith(ALLOWED_HOST_SUFFIX);
	return trusted ? `${parsed.protocol}//${parsed.host}` : null;
}

/**
 * Pull a validated regional origin from a redirect envelope, or null when the
 * body is not a redirect or the target is not a trusted Plaud https host.
 * Exported for unit testing.
 */
export function readRegionRedirect(
	envelope: Record<string, unknown>,
): string | null {
	if (envelope.status !== STATUS_REGION_REDIRECT) {
		return null;
	}
	const data = envelope.data;
	if (!isRecord(data)) {
		return null;
	}
	const domains = data.domains;
	if (!isRecord(domains)) {
		return null;
	}
	const api = domains.api;
	return typeof api === 'string' ? normalizeTrustedOrigin(api) : null;
}

/**
 * Extract the workspace token + rotated refresh token from a mint response,
 * or null when the envelope is not a success carrying a `workspace_token`
 * string. Exported for unit testing.
 */
export function parseWorkspaceTokenResponse(
	envelope: Record<string, unknown>,
): { token: string; refreshToken: string | null } | null {
	if (envelope.status !== STATUS_OK) {
		return null;
	}
	const data = envelope.data;
	if (!isRecord(data)) {
		return null;
	}
	const token = data.workspace_token;
	if (typeof token !== 'string' || token.length === 0) {
		return null;
	}
	const refresh = data.refresh_token;
	return {
		token,
		refreshToken:
			typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
	};
}

// Headers common to Plaud's browser API calls, minus auth (cookies) and the
// per-request nonce. app-platform/edit-from track the token's client_id so the
// server's parse-mode check agrees (see plaud-client-re.ts). x-device-id is
// deliberately omitted: it lives in the partition's localStorage, out of reach
// without a window, and the mint call authenticates by cookie. If the server
// turns out to require it, this path fails and the refresh reports failure.
function baseHeaders(clientId: string): Record<string, string> {
	return {
		accept: 'application/json, text/plain, */*',
		'content-type': 'application/json',
		'app-platform': clientId,
		'app-language': 'en',
		'edit-from': clientId,
		origin: 'https://web.plaud.ai',
		referer: 'https://web.plaud.ai/',
	};
}

/**
 * Run the two-step direct refresh. Returns a candidate WT (never stores it),
 * or null on any failure so the caller can pause and prompt the user. Never
 * throws.
 */
export async function performNetRefresh(
	deps: NetRefreshDeps,
): Promise<NetRefreshResult | null> {
	// Wrap the injected sink so a throwing logger can never break this function's
	// "never throws" contract (it runs in the background refresh timer).
	const log = (message: string, payload?: unknown): void => {
		try {
			deps.log?.(message, payload);
		} catch {
			// A logging failure must not propagate into the timer or the sync tick.
		}
	};
	try {
		const wid = extractWorkspaceId(deps.currentToken);
		if (wid === null) {
			log(
				'net refresh aborted: stored token has no wid claim to mint against',
			);
			return null;
		}
		const clientId =
			readJwtPayloadClaim(deps.currentToken, 'client_id') ?? 'web';
		const headers = baseHeaders(clientId);

		// Validate the starting host BEFORE any cookie-bearing POST: a malformed
		// or tampered stored base must never send the partition's Plaud session
		// cookies to a non-Plaud origin. Redirect targets are validated the same
		// way inside the loop.
		let base = normalizeTrustedOrigin(deps.baseUrl);
		if (base === null) {
			log(
				'net refresh aborted: stored base URL is not a trusted Plaud host',
				{
					baseUrl: deps.baseUrl,
				},
			);
			return null;
		}
		let apiBaseUrl: string | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await deps.post(
				`${base}${REFRESH_USER_TOKEN_PATH}`,
				'{}',
				headers,
			);
			const envelope = parseEnvelope(res.text);
			if (envelope === null) {
				log(
					'net refresh step 1 (refresh-user-token): non-JSON response',
					{
						httpStatus: res.status,
						body: bodySnippet(res.text),
					},
				);
				return null;
			}
			if (envelope.status === STATUS_OK) {
				break;
			}
			const redirect = readRegionRedirect(envelope);
			if (redirect === null || attempt === 1) {
				log(
					'net refresh step 1 (refresh-user-token): non-OK envelope',
					{
						httpStatus: res.status,
						envelopeStatus: envelope.status,
						message: envelopeMessage(envelope),
					},
				);
				return null;
			}
			base = redirect;
			apiBaseUrl = redirect;
		}

		// Step 2: mint the workspace token. The fresh UT cookie from step 1 is
		// already in the session jar, so this call just needs the cookie + wid.
		const mint = await deps.post(
			`${base}${WORKSPACE_TOKEN_PATH_PREFIX}${wid}`,
			'{}',
			headers,
		);
		const mintEnvelope = parseEnvelope(mint.text);
		if (mintEnvelope === null) {
			log(
				'net refresh step 2 (workspace token mint): non-JSON response',
				{
					httpStatus: mint.status,
					body: bodySnippet(mint.text),
				},
			);
			return null;
		}
		const parsed = parseWorkspaceTokenResponse(mintEnvelope);
		if (parsed === null) {
			log(
				'net refresh step 2 (workspace token mint): no workspace_token',
				{
					httpStatus: mint.status,
					envelopeStatus: mintEnvelope.status,
					message: envelopeMessage(mintEnvelope),
				},
			);
			return null;
		}
		log('net refresh succeeded via the direct (windowless) path');
		return {
			token: parsed.token,
			refreshToken: parsed.refreshToken,
			apiBaseUrl,
		};
	} catch (err) {
		// A refresh bug must never throw into the timer or the auto-sync tick.
		log('net refresh threw', {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

// --- Electron runtime adapter (guarded; untyped remote surface) --------------

interface ElectronSessionFetchResponse {
	status: number;
	text(): Promise<string>;
}
interface ElectronSessionLike {
	fetch?(
		url: string,
		options: {
			method: string;
			body: string;
			headers: Record<string, string>;
			credentials?: 'include' | 'omit' | 'same-origin';
			signal?: AbortSignal;
		},
	): Promise<ElectronSessionFetchResponse>;
}
interface ElectronRemoteLike {
	session?: { fromPartition(partition: string): ElectronSessionLike };
}
interface ElectronLike {
	remote?: ElectronRemoteLike;
}

type SessionWithFetch = ElectronSessionLike & {
	fetch: NonNullable<ElectronSessionLike['fetch']>;
};

function hasFetch(session: ElectronSessionLike): session is SessionWithFetch {
	return typeof session.fetch === 'function';
}

function requireElectron(): ElectronLike | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		return req('electron') as ElectronLike;
	} catch {
		return null;
	}
}

/**
 * Build a session-bound POST over the sign-in partition using Electron's
 * `session.fetch` (Electron 28+, present on Obsidian 1.11.4's runtime). Returns
 * null when the remote/session/fetch surface is unavailable, in which case the
 * silent refresh cannot run on this build.
 *
 * `partition` MUST be the same value plaud-login.ts signed in against, which is
 * why both callers derive it from the one definition in plaud-partition.ts. A
 * mismatch is silent and nasty: the cookie jar this authenticates against would
 * simply be empty, so every renewal would fail as though the session had died.
 */
export function buildPartitionPost(partition: string): SessionPost | null {
	// fromPartition() is inside the try, not just the require. Returning
	// `| null` is this function's whole contract for "not available on this
	// build", and a throw from the partition lookup would break that contract
	// for every caller: the manual command surfaces it as an unhandled
	// rejection with no feedback, and the scheduler cannot tell "unavailable"
	// from "broken". Whatever goes wrong reaching the remote surface, the
	// answer callers need is the same one.
	let session: ElectronSessionLike | undefined;
	try {
		session = requireElectron()?.remote?.session?.fromPartition(partition);
	} catch {
		return null;
	}
	if (session === undefined || !hasFetch(session)) {
		return null;
	}
	return async (url, body, headers) => {
		// Member call (not a detached reference) so `this` stays bound to session.
		// credentials:'include' is REQUIRED: these POSTs authenticate purely with
		// the partition's httpOnly Plaud cookies, and fetch's default same-origin
		// credentials mode would send none (the call has no document origin that
		// matches api.plaud.ai), so the refresh would silently 401/return empty.
		// The abort signal bounds the whole call (request AND body read): the
		// caller holds refreshInFlight/reauthInFlight until this settles, so a
		// stalled request with no timeout would wedge every future refresh and
		// the manual Sign in until restart.
		const res = await session.fetch(url, {
			method: 'POST',
			body,
			headers: { ...headers },
			credentials: 'include',
			signal: AbortSignal.timeout(NET_REFRESH_TIMEOUT_MS),
		});
		const text = await res.text();
		return { status: res.status, text };
	};
}
