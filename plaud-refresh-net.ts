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
// SCOPE, and it is narrow: this COOKIE refresh works ONLY for sessions captured
// through the embedded sign-in window, because only that window populates the
// partition. SSO (which completes in the external browser) and bookmarklet
// captures leave the partition empty, so the caller gates on the recorded
// sign-in method and does not attempt THIS path for them. That is a decision,
// not an oversight. A v4 SSO/browser session is not left to reconnect manually:
// it renews through the cookieless BEARER path in plaud-refresh-v4.ts instead,
// which the caller routes to for signInMethod 'browser'.
//
// And it is not indefinite. Refreshing rotates the 30 day user refresh token
// but does NOT extend its expiry (measured: `urt_expire_at` unchanged across a
// successful refresh), so unattended operation ends about 30 days after
// sign-in. User-facing copy must say about 30 days, never "yearly" and never
// "indefinite".

import { decodeJwtPayload } from './plaud-token';
import { isTrustedPlaudHost } from './plaud-hosts';
import { redactJwtLike } from './jwt-redact';
import {
	HTTP_GONE,
	classifyEnvelope,
	classifyHttpStatus,
	denied,
	isSsoRequired,
	unreachable,
	type RefreshFailure,
} from './refresh-failure';

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
	/** Wait between conflict retries. Injected so tests do not sleep. */
	readonly sleep?: (ms: number) => Promise<void>;
	/**
	 * Checked before every request after the first. False when the caller no
	 * longer owns this refresh (sign-out, a new credential, unload) or has no
	 * request budget left, so a conflict retry or the mint does not go out on
	 * a session nobody is using.
	 */
	readonly mayContinue?: () => boolean;
}

/**
 * First 200 chars of a response body, for a failure diagnostic, with any
 * JWT-shaped substring redacted first. A failing auth/refresh response should
 * not carry a token, but redacting guarantees the debug logger's no-secrets
 * contract holds even if one ever slips into an error body.
 */
function bodySnippet(text: string): string {
	const redacted = redactJwtLike(text, '[redacted-token]');
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
	return isTrustedPlaudHost(parsed.hostname)
		? `${parsed.protocol}//${parsed.host}`
		: null;
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

// Step 1 conflict retry, copied from Plaud's own 4.0 app: an in-band -4302 or
// an HTTP 409 on /auth/refresh-user-token is retried up to three more times,
// one second apart. Both read as "another refresh is rotating this session
// right now", not as a dead session. Bounded and fast, so it costs at most
// three extra calls against the hourly ceiling and only when Plaud asks.
const STATUS_REFRESH_CONFLICT = -4302;
const HTTP_CONFLICT = 409;
const MAX_CONFLICT_RETRIES = 3;
const CONFLICT_RETRY_DELAY_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * Run the two-step direct refresh. Returns a candidate WT (never stores it),
 * or a classified failure: `denied` when the session is over and only the user
 * can fix it, `unreachable` when Plaud could not be reached or answered
 * something unrecognized (see refresh-failure.ts). Never throws.
 */
export async function performNetRefresh(
	deps: NetRefreshDeps,
): Promise<NetRefreshResult | RefreshFailure> {
	// Wrap the injected sink so a throwing logger can never break this function's
	// "never throws" contract (it runs in the background refresh timer).
	const log = (message: string, payload?: unknown): void => {
		try {
			deps.log?.(message, payload);
		} catch {
			// A logging failure must not propagate into the timer or the sync tick.
		}
	};
	const sleep = deps.sleep ?? defaultSleep;
	const mayContinue = deps.mayContinue ?? (() => true);
	try {
		const wid = extractWorkspaceId(deps.currentToken);
		if (wid === null) {
			log(
				'net refresh aborted: stored token has no wid claim to mint against',
			);
			// Only a fresh sign-in can supply one, so this is not worth a retry.
			return denied('session-ended');
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
			return denied('session-ended');
		}
		let apiBaseUrl: string | null = null;
		let redirects = 0;
		let conflicts = 0;
		for (;;) {
			const res = await deps.post(
				`${base}${REFRESH_USER_TOKEN_PATH}`,
				'{}',
				headers,
			);
			const envelope = parseEnvelope(res.text);
			// The SSO demand outranks everything, whatever the HTTP status.
			if (envelope !== null && isSsoRequired(envelope)) {
				log(
					'net refresh step 1 (refresh-user-token): company SSO required',
					{
						httpStatus: res.status,
					},
				);
				return denied('sso-required', res.status);
			}
			// An HTTP 409, or an in-band -4302 on a 2xx. A -4302 riding on a
			// 401/403 is a refusal, classified below by its HTTP status.
			const conflict =
				res.status === HTTP_CONFLICT ||
				(res.status >= 200 &&
					res.status < 300 &&
					envelope?.status === STATUS_REFRESH_CONFLICT);
			if (conflict) {
				if (conflicts < MAX_CONFLICT_RETRIES) {
					conflicts++;
					log(
						'net refresh step 1 (refresh-user-token): conflict, retrying',
						{
							httpStatus: res.status,
							envelopeStatus: envelope?.status,
							attempt: conflicts,
						},
					);
					await sleep(CONFLICT_RETRY_DELAY_MS);
					if (!mayContinue()) {
						log(
							'net refresh stopped: the caller no longer owns this refresh or has no request budget left',
						);
						return unreachable('stopped before a conflict retry');
					}
					continue;
				}
				log(
					'net refresh step 1 (refresh-user-token): conflict retries exhausted',
					{
						httpStatus: res.status,
						envelopeStatus: envelope?.status,
					},
				);
				return unreachable('refresh conflict retries exhausted');
			}
			// A non-2xx status decides on its own, JSON body or not: a 401 with
			// {"message":"Unauthorized"} is a refusal, not an unknown status.
			// Only the SSO demand in such a body is more specific.
			if (res.status < 200 || res.status >= 300) {
				const failure =
					envelope !== null && isSsoRequired(envelope)
						? denied('sso-required', res.status)
						: classifyHttpStatus(res.status);
				log(
					'net refresh step 1 (refresh-user-token): non-2xx response',
					{
						httpStatus: res.status,
						body: bodySnippet(res.text),
						failure,
					},
				);
				return failure;
			}
			if (envelope === null) {
				log(
					'net refresh step 1 (refresh-user-token): non-JSON response',
					{
						httpStatus: res.status,
						body: bodySnippet(res.text),
					},
				);
				return unreachable('non-JSON response');
			}
			if (envelope.status === STATUS_OK) {
				break;
			}
			const redirect = readRegionRedirect(envelope);
			if (redirect !== null && redirects === 0) {
				redirects++;
				base = redirect;
				apiBaseUrl = redirect;
				if (!mayContinue()) {
					return unreachable('stopped before the region retry');
				}
				continue;
			}
			const failure =
				redirect !== null
					? unreachable('second region redirect')
					: classifyEnvelope(envelope);
			log('net refresh step 1 (refresh-user-token): non-OK envelope', {
				httpStatus: res.status,
				envelopeStatus: envelope.status,
				message: envelopeMessage(envelope),
				failure,
			});
			return failure;
		}

		// Step 2: mint the workspace token. The fresh UT cookie from step 1 is
		// already in the session jar, so this call just needs the cookie + wid.
		if (!mayContinue()) {
			log(
				'net refresh stopped before the mint: the caller no longer owns this refresh',
			);
			return unreachable('stopped before the mint');
		}
		const mint = await deps.post(
			`${base}${WORKSPACE_TOKEN_PATH_PREFIX}${wid}`,
			'{}',
			headers,
		);
		// Plaud's app reads HTTP 410 on the mint as "user not found".
		if (mint.status === HTTP_GONE) {
			log('net refresh step 2 (workspace token mint): HTTP 410', {
				httpStatus: mint.status,
			});
			return denied('user-not-found', mint.status);
		}
		const mintEnvelope = parseEnvelope(mint.text);
		if (mint.status < 200 || mint.status >= 300) {
			const failure =
				mintEnvelope !== null && isSsoRequired(mintEnvelope)
					? denied('sso-required', mint.status)
					: classifyHttpStatus(mint.status);
			log('net refresh step 2 (workspace token mint): non-2xx response', {
				httpStatus: mint.status,
				body: bodySnippet(mint.text),
				failure,
			});
			return failure;
		}
		if (mintEnvelope === null) {
			log(
				'net refresh step 2 (workspace token mint): non-JSON response',
				{
					httpStatus: mint.status,
					body: bodySnippet(mint.text),
				},
			);
			return unreachable('non-JSON response');
		}
		const parsed = parseWorkspaceTokenResponse(mintEnvelope);
		if (parsed === null) {
			const failure =
				mintEnvelope.status === STATUS_OK
					? unreachable('mint succeeded without a workspace_token')
					: classifyEnvelope(mintEnvelope);
			log(
				'net refresh step 2 (workspace token mint): no workspace_token',
				{
					httpStatus: mint.status,
					envelopeStatus: mintEnvelope.status,
					message: envelopeMessage(mintEnvelope),
					failure,
				},
			);
			return failure;
		}
		log('net refresh succeeded via the direct (windowless) path');
		return {
			token: parsed.token,
			refreshToken: parsed.refreshToken,
			apiBaseUrl,
		};
	} catch (err) {
		// A refresh bug must never throw into the timer or the auto-sync tick.
		// A throw here is the transport (timeout, offline, DNS), so transient.
		log('net refresh threw', {
			error: err instanceof Error ? err.message : String(err),
		});
		return unreachable('transport error');
	}
}

// --- Electron runtime adapter (guarded; untyped remote surface) --------------

interface ElectronSessionFetchResponse {
	status: number;
	text(): Promise<string>;
}

/**
 * An AbortSignal created in the MAIN process, held here as a remote proxy.
 * Deliberately not typed as the renderer's AbortSignal: issue #148 was exactly
 * that confusion. session.fetch runs in the main process and checks
 * `instanceof AbortSignal` against the main process's own class, so a renderer
 * signal arrives as a proxy and is rejected before any request goes out
 * ("RequestInit: Expected signal ... to be an instance of AbortSignal"). A
 * main-process signal round-trips back to its real object and passes.
 */
interface MainProcessSignal {
	readonly __mainProcessSignal: unique symbol;
}

interface ElectronSessionLike {
	fetch?(
		url: string,
		options: {
			method: string;
			body: string;
			headers: Record<string, string>;
			credentials?: 'include' | 'omit' | 'same-origin';
			signal?: MainProcessSignal;
		},
	): Promise<ElectronSessionFetchResponse>;
}
interface ElectronRemoteLike {
	session?: { fromPartition(partition: string): ElectronSessionLike };
	getGlobal?(name: string): unknown;
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

type MainTimeout = (ms: number) => MainProcessSignal;

/**
 * The main process's `AbortSignal.timeout`, bound to its class, or null when
 * the remote surface does not expose it. Null is a hard stop for the caller:
 * a refresh POST with no working timeout could stall forever and wedge every
 * later refresh behind the in-flight guard, which is worse than reporting the
 * refresh unavailable.
 */
function mainProcessTimeout(remote: ElectronRemoteLike): MainTimeout | null {
	if (typeof remote.getGlobal !== 'function') {
		return null;
	}
	const mainAbortSignal = remote.getGlobal('AbortSignal');
	if (!isRecord(mainAbortSignal) && typeof mainAbortSignal !== 'function') {
		return null;
	}
	const timeout: unknown = Reflect.get(mainAbortSignal, 'timeout');
	if (typeof timeout !== 'function') {
		return null;
	}
	return (ms) =>
		Reflect.apply(timeout, mainAbortSignal, [ms]) as MainProcessSignal;
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
	let timeoutSignal: MainTimeout | null = null;
	try {
		const remote = requireElectron()?.remote;
		session = remote?.session?.fromPartition(partition);
		timeoutSignal =
			remote === undefined ? null : mainProcessTimeout(remote);
	} catch {
		return null;
	}
	if (session === undefined || !hasFetch(session) || timeoutSignal === null) {
		return null;
	}
	const makeSignal = timeoutSignal;
	return async (url, body, headers) => {
		// Member call (not a detached reference) so `this` stays bound to session.
		// credentials:'include' is REQUIRED: these POSTs authenticate purely with
		// the partition's httpOnly Plaud cookies, and fetch's default same-origin
		// credentials mode would send none (the call has no document origin that
		// matches api.plaud.ai), so the refresh would silently 401/return empty.
		// The abort signal bounds the whole call (request AND body read): the
		// caller holds refreshInFlight/reauthInFlight until this settles, so a
		// stalled request with no timeout would wedge every future refresh and
		// the manual Sign in until restart. The signal is made in the main
		// process, fresh per call; see MainProcessSignal for why (issue #148).
		const res = await session.fetch(url, {
			method: 'POST',
			body,
			headers: { ...headers },
			credentials: 'include',
			signal: makeSignal(NET_REFRESH_TIMEOUT_MS),
		});
		const text = await res.text();
		return { status: res.status, text };
	};
}
