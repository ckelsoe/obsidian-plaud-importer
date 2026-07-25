// Shared JWT claim helpers for captured Plaud tokens.
//
// Deliberately free of any Obsidian or Electron import so it stays a pure,
// unit-testable module and survives the refresh-subsystem removal. It backs the
// long-lived-user-token capture guard used by every sign-in path.
//
// Plaud's web app keeps the user token in `localStorage` under the `token`
// key on web.plaud.ai. On the US accounts observed so far that token is
// long-lived (~300 days), but the lifetime is NOT guaranteed per account or
// region: issue #78 reported a 24-hour token under the same key on an APSE1
// account. So measure `exp - iat` (readTokenLifetime below); never assume a
// lifetime that was not observed. The payload carries `exp` and `client_id`
// (plus `sub, aud, iat, region`), unlike the 24h workspace token (`typ: WT`,
// `wid` claim) the plugin used to scrape off request headers. A neighboring
// localStorage key is a profile/ID JWT whose payload is only
// `{email, id, name}` with no `exp`; it decodes cleanly but the data API
// rejects it with `-3900 "invalid auth header"`. So the guard validates the
// decoded claims, never the key name.

// A single base64url segment. Anchored with one character class, so it is
// linear-time: no polynomial/ReDoS backtracking on adversarial input.
const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

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

// Splits a (possibly bearer-prefixed) token into its three base64url JWT
// segments, or null when the value is not EXACTLY three non-empty base64url
// segments. Parsing by an exact split rather than an unanchored search both
// avoids the polynomial-regex class and refuses a `prefix.<jwt>.suffix` value
// that a search would have accepted and then stored verbatim.
function jwtSegments(value: string): [string, string, string] | null {
	// Trim BEFORE stripping the prefix, matching the trim-first normalization
	// in plaud-login.ts, main.ts storeAccessToken, and plaud-client-re.ts: a
	// manually linked secret can carry leading whitespace ahead of "bearer",
	// and the API accepts that value, so the helpers here must read it too.
	const token = value.trim().replace(/^bearer\s+/i, '').trim();
	const parts = token.split('.');
	if (parts.length !== 3) {
		return null;
	}
	if (!parts.every((part) => B64URL_SEGMENT.test(part))) {
		return null;
	}
	return [parts[0], parts[1], parts[2]];
}

/** Decodes the JWT payload, or null when the value is not a decodable JWT. */
export function decodeJwtPayload(value: string): Record<string, unknown> | null {
	const parts = jwtSegments(value);
	if (parts === null) {
		return null;
	}
	return decodeSegment(parts[1]);
}

/** Decodes the JWT header, or null when the value is not a decodable JWT. */
export function decodeJwtHeader(value: string): Record<string, unknown> | null {
	const parts = jwtSegments(value);
	if (parts === null) {
		return null;
	}
	return decodeSegment(parts[0]);
}

/** Reads the JWT header `typ`, or null when the value is not a decodable JWT. */
function jwtHeaderTyp(value: string): string | null {
	const header = decodeJwtHeader(value);
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
 * Advisory threshold, in hours: a measured issued lifetime at or below this is
 * "short". The 24h tokens issue #78 reported fall under it; every long-lived
 * token observed so far (~137 to ~300 days) is far above it. Advisory only:
 * lifetime informs status text and a capture-time heads-up, never a gate.
 */
export const SHORT_LIFETIME_HOURS = 72;

/** Measured lifetime facts about a stored token. All *Ms fields are epoch ms. */
export interface TokenLifetime {
	/** `exp` converted to ms. */
	expMs: number;
	/** `iat` converted to ms, or null when the token carries no `iat` claim. */
	issuedAtMs: number | null;
	/** Issued lifetime in hours (`exp - iat`), or null when `iat` is absent. */
	lifetimeHours: number | null;
	/** Time until expiry relative to `nowMs`; negative when already expired. */
	remainingMs: number;
	/** JWT header `typ`, or null when the header carries none. */
	typ: string | null;
	/** True when the payload carries a string `wid` (workspace) claim. */
	hasWid: boolean;
}

/**
 * Measures a token's lifetime from its own claims, or returns null when the
 * value is not a JWT with a numeric `exp`. `lifetimeHours` is null when `iat`
 * is absent or non-numeric: report "unknown", never guess a lifetime that was
 * not observed (issue #78: lifetime varies by account, and the observed
 * workspace tokens carry no `iat` at all). Pure and side-effect free; `nowMs`
 * is injectable for tests.
 */
export function readTokenLifetime(
	value: string,
	nowMs: number = Date.now(),
): TokenLifetime | null {
	const payload = decodeJwtPayload(value);
	if (payload === null) {
		return null;
	}
	const exp = payload.exp;
	if (typeof exp !== 'number' || !Number.isFinite(exp)) {
		return null;
	}
	const iat = payload.iat;
	const issuedAtMs =
		typeof iat === 'number' && Number.isFinite(iat) ? iat * 1000 : null;
	// `exp`/`iat` are Unix timestamps in SECONDS; all returned fields are ms.
	const expMs = exp * 1000;
	return {
		expMs,
		issuedAtMs,
		lifetimeHours:
			issuedAtMs === null ? null : (expMs - issuedAtMs) / 3_600_000,
		remainingMs: expMs - nowMs,
		typ: jwtHeaderTyp(value),
		hasWid: typeof payload.wid === 'string',
	};
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
 * future `exp` and a `client_id`, but the data API `-3901`s it, so storing it
 * as the credential would strand the session on an unusable token.
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

/**
 * Renders a measured lifetime as a capitalized status fragment, e.g.
 * "About 18 hours left (issued for 24 hours)" or "Expires 15 Jan 2027 (issued
 * for about 300 days)". Reports "unknown" rather than guessing when the value
 * is unreadable, carries no `iat`, or measures nonsense (`iat` at or past
 * `exp`). Lives here rather than in main.ts so the wording contract is pinned
 * by unit tests.
 */
export function describeTokenLifetime(life: TokenLifetime | null): string {
	if (life === null) {
		return 'Expiry unknown (the stored value is not a readable Plaud token)';
	}
	const expiryDate = new Date(life.expMs).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
	let issued: string;
	if (life.lifetimeHours === null || life.lifetimeHours <= 0) {
		issued = 'issued lifetime unknown';
	} else if (life.lifetimeHours <= SHORT_LIFETIME_HOURS) {
		const hours = Math.max(1, Math.round(life.lifetimeHours));
		issued = `issued for ${hours} hour${hours === 1 ? '' : 's'}`;
	} else {
		issued = `issued for about ${Math.round(life.lifetimeHours / 24)} days`;
	}
	if (life.remainingMs <= 0) {
		return `Expired ${expiryDate} (${issued})`;
	}
	const remainingHours = life.remainingMs / 3_600_000;
	if (remainingHours < 48) {
		const rounded = Math.max(1, Math.round(remainingHours));
		return `About ${rounded} hour${rounded === 1 ? '' : 's'} left (${issued})`;
	}
	return `Expires ${expiryDate} (${issued})`;
}

/** Inputs for formatSessionStatus; `tokenValue` is '' when none is stored. */
export interface SessionStatusInput {
	pluginVersion: string;
	apiBaseUrl: string;
	signInMethod: string;
	tokenValue: string;
}

/**
 * Builds the privacy-safe session-status block behind the "Debug: copy
 * session status to clipboard" command (issue #78). Emits the plugin version,
 * API base URL, recorded sign-in method, and a redacted token projection:
 * header `typ`/`alg`, payload claim NAMES, the values of the non-identifying
 * claims (`client_id`, `region`, `auth_method`, `exp`, `iat`), the computed
 * lifetime, and a derived `hasWid` boolean. NEVER `sub`, `wid`, `jti`,
 * `email`, or the token value, so the output is safe to paste into a public
 * issue. Kept pure so the never-leak contract is pinned by tests, not only by
 * review.
 */
export function formatSessionStatus(input: SessionStatusInput): string {
	const lines: string[] = [
		`plugin: ${input.pluginVersion}`,
		`apiBaseUrl: ${input.apiBaseUrl}`,
		`signInMethod: ${input.signInMethod === '' ? '(not recorded)' : input.signInMethod}`,
	];
	const value = input.tokenValue;
	if (value.length === 0) {
		lines.push('token: none stored');
		return lines.join('\n');
	}
	const payload = decodeJwtPayload(value);
	if (payload === null) {
		lines.push('token: stored, but not a readable Plaud token');
		return lines.join('\n');
	}
	const claimText = (claim: unknown): string =>
		typeof claim === 'string' || typeof claim === 'number'
			? String(claim)
			: '(none)';
	const header = decodeJwtHeader(value);
	lines.push(
		`token.header.typ: ${claimText(header?.typ)}`,
		`token.header.alg: ${claimText(header?.alg)}`,
		`token.claimNames: ${Object.keys(payload).sort().join(', ')}`,
	);
	const life = readTokenLifetime(value);
	if (life === null) {
		// A decodable JWT without a numeric exp is a realistic mis-link (the
		// neighboring profile JWT). The claim names above identify it; say why
		// there is no lifetime to report.
		lines.push('token: has no numeric exp claim (not a Plaud session token)');
		return lines.join('\n');
	}
	lines.push(
		`token.client_id: ${claimText(payload.client_id)}`,
		`token.region: ${claimText(payload.region)}`,
		`token.auth_method: ${claimText(payload.auth_method)}`,
		`token.exp: ${claimText(payload.exp)}`,
		`token.iat: ${claimText(payload.iat)}`,
		`token.lifetimeHours: ${
			life.lifetimeHours === null
				? '(no iat claim)'
				: String(Math.round(life.lifetimeHours * 100) / 100)
		}`,
		`token.hasWid: ${String(life.hasWid)}`,
		`token.status: ${describeTokenLifetime(life)}`,
	);
	return lines.join('\n');
}
