// JWT helpers for the silent session refresh (Release B).
//
// The refresh itself is performed by re-capturing a fresh workspace token (WT)
// from a hidden sign-in window on the persistent Plaud partition (see
// plaud-login.ts `openPlaudLogin({ headless: true })`). Empirically the direct
// `POST /auth/refresh-user-token` call returns a USER token (typ UT, ~30 days),
// not the WORKSPACE token (typ WT, 24h) the data API needs; Plaud mints the WT
// in a separate step, which the web app does on load. Letting the app do that
// and re-capturing the WT (exactly as at login) sidesteps replicating Plaud's
// token derivation.
//
// These pure helpers decode the WT's `exp` (to schedule the refresh ~5 min
// before expiry) and validate a captured token is a fresh WT (fail-safe: never
// replace the stored token with something that is not a future-dated WT).

// A JWT, optionally bearer-prefixed.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const ACCESS_TOKEN_TYP = 'WT';

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

/**
 * Reads a string claim from the JWT payload, or null when the value is not a
 * decodable JWT or the claim is absent / not a string. Used by the direct
 * net-refresh path to pull `wid` (workspace id) and `client_id` off the stored
 * workspace token without a separate API round-trip.
 */
export function readJwtPayloadClaim(value: string, claim: string): string | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const parts = match[0].split('.');
	if (parts.length < 2) {
		return null;
	}
	const payload = decodeJwtSegment(parts[1]);
	if (payload === null) {
		return null;
	}
	const raw = payload[claim];
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
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
