// Shared JWT claim helpers for captured Plaud tokens.
//
// Deliberately free of any Obsidian or Electron import so it stays a pure,
// unit-testable module and survives the refresh-subsystem removal. It backs the
// long-lived-user-token capture guard used by every sign-in path.
//
// Plaud's web app keeps the ~300-day user token in `localStorage` under the
// `token` key on web.plaud.ai. That token's payload carries `exp` and
// `client_id` (plus `sub, aud, iat, region`), unlike the 24h workspace token
// (`typ: WT`, `wid` claim) the plugin used to scrape off request headers. A
// neighboring localStorage key is a profile/ID JWT whose payload is only
// `{email, id, name}` with no `exp`; it decodes cleanly but the data API
// rejects it with `-3900 "invalid auth header"`. So the guard validates the
// decoded claims, never the key name.

// A JWT, optionally bearer-prefixed.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

// JWT header `typ` of the paired REFRESH token. The data API rejects it with
// `-3901 "token type does not match parse mode"` if it is ever sent as the data
// credential, so the capture guard must never accept one even though it carries
// a future `exp` and a `client_id`.
const REFRESH_TOKEN_TYP = 'WRT';

// Decodes one base64url JWT segment to an object, or null when it is not valid
// base64url JSON. atob is always present in Obsidian's Electron renderer and in
// Node 18+ (the jest env); the Node `Buffer` global is avoided because it is
// untyped under the marketplace scan's type-checked lint.
function decodeSegment(seg: string): Record<string, unknown> | null {
	try {
		const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Decodes the JWT payload, or null when the value is not a decodable JWT. */
export function decodeJwtPayload(value: string): Record<string, unknown> | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const parts = match[0].split('.');
	if (parts.length < 2) {
		return null;
	}
	return decodeSegment(parts[1]);
}

/** Reads the JWT header `typ`, or null when the value is not a decodable JWT. */
function jwtHeaderTyp(value: string): string | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const header = decodeSegment(match[0].split('.')[0]);
	return header !== null && typeof header.typ === 'string' ? header.typ : null;
}

/**
 * Reads the JWT payload `client_id` claim, or null when the value is not a
 * decodable JWT or the claim is absent / not a non-empty string. The data API
 * derives the `app-platform`/`edit-from` request headers from this claim, so a
 * captured token must carry it.
 */
export function readTokenClientId(value: string): string | null {
	const payload = decodeJwtPayload(value);
	if (payload === null) {
		return null;
	}
	const raw = payload.client_id;
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Capture guard: true only when the token's payload carries a non-empty string
 * `client_id` AND a numeric `exp` that is still in the future. This is the sole
 * test any sign-in path applies before storing a captured value.
 *
 * The claim checks accept the long-lived user token (and, incidentally, a
 * workspace token, which carries both claims) and reject the neighboring
 * profile/ID JWT (no `exp`) that the API would `-3900` on. The future-`exp`
 * check additionally rejects an ALREADY-EXPIRED token: Plaud's localStorage can
 * still hold a dead token from a lapsed session, and capturing it would settle
 * sign-in (and close the login window) with an unusable credential, trapping the
 * user in a reconnect loop. Requiring a live token keeps the window open until
 * a real re-auth writes a fresh token. `nowMs` is injectable for tests.
 *
 * A paired REFRESH token (typ `WRT`) is rejected outright: it also carries a
 * future `exp` and a `client_id`, but the data API `-3901`s it, and storing it
 * as the credential would also fool the refresh-neutralization guard (which
 * treats any non-`WT` token as a long-lived user token).
 *
 * Validate the claims, never the key name.
 */
export function isUsableUserToken(value: string, nowMs: number = Date.now()): boolean {
	if (jwtHeaderTyp(value) === REFRESH_TOKEN_TYP) {
		return false;
	}
	const payload = decodeJwtPayload(value);
	if (payload === null) {
		return false;
	}
	const exp = payload.exp;
	const clientId = payload.client_id;
	if (typeof clientId !== 'string' || clientId.length === 0) {
		return false;
	}
	if (typeof exp !== 'number' || !Number.isFinite(exp)) {
		return false;
	}
	// `exp` is a Unix timestamp in SECONDS; compare in milliseconds.
	return exp * 1000 > nowMs;
}
