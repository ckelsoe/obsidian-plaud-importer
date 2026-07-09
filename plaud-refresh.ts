// JWT helpers and scheduling math for the silent session refresh (Release B).
//
// The refresh itself is the direct, windowless two-step call in
// plaud-refresh-net.ts (POST /auth/refresh-user-token over the partition
// cookies, then the workspace-token mint). The background NEVER opens a
// window: when the windowless refresh fails, the caller pauses and prompts the
// user to reconnect. The old hidden-window fallback is gone; its login page
// leaked web.plaud.ai popup tabs into the default browser.
//
// These pure helpers decode the WT's `exp`, compute the proactive-refresh
// schedule (including the 32-bit setTimeout clamp and the skip-if-fresh
// guard), and validate a captured token is a fresh WT (fail-safe: never
// replace the stored token with something that is not a future-dated WT).

// A JWT, optionally bearer-prefixed.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const ACCESS_TOKEN_TYP = 'WT';

// Silent-refresh scheduling. Refresh this long before the access token's `exp`
// so a slow round-trip still lands before expiry.
export const REFRESH_LEAD_MS = 5 * 60 * 1000;
// Never schedule a refresh sooner than this, so a past-due or about-to-expire
// token triggers one prompt refresh rather than a tight loop.
export const REFRESH_MIN_DELAY_MS = 30 * 1000;
// When the stored token is opaque (no decodable `exp`), poll at this cadence as
// a fallback so a session can still be kept alive.
export const REFRESH_OPAQUE_FALLBACK_MS = 60 * 60 * 1000;
// window.setTimeout stores its delay as a 32-bit signed int; anything above
// 2,147,483,647 ms (about 24.8 days) overflows and fires almost immediately.
// A long-lived token (a ~137-day exp was observed in the wild) would otherwise
// schedule an instant, spurious refresh whose failure loop reopened a sign-in
// window every backoff interval. Cap the schedule well under the ceiling; an
// early wake-up is a no-op because the runner re-checks token life before
// refreshing (isRefreshDue).
export const REFRESH_MAX_DELAY_MS = 20 * 24 * 60 * 60 * 1000;
// Backoff after a failed refresh, indexed by (failure streak - 1) and clamped to
// the last entry. Keeps a dead 30-day refresh token from hammering the endpoint
// (Plaud counts refreshes per hour) while still retrying periodically.
export const REFRESH_RETRY_BACKOFF_MS = [
	5 * 60 * 1000,
	15 * 60 * 1000,
	30 * 60 * 1000,
	60 * 60 * 1000,
];

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
 * True when the stored token is close enough to expiry (inside the lead
 * window) that a proactive refresh should actually run. An opaque token (no
 * decodable `exp`) counts as due, matching the hourly-poll fallback. Guards
 * the scheduled runner so an early timer fire (the REFRESH_MAX_DELAY_MS clamp,
 * or a backoff retry that outlived its failure) never refreshes a token that
 * still has ample life.
 */
export function isRefreshDue(token: string, nowMs: number): boolean {
	const expMs = decodeJwtExpMs(token);
	return expMs === null || expMs - nowMs <= REFRESH_LEAD_MS;
}

/**
 * Delay until the next proactive-refresh timer fire. On a failure streak the
 * delay is the retry backoff; otherwise it is expiry-driven (`exp` minus the
 * lead), floored at REFRESH_MIN_DELAY_MS for past-due tokens, with an hourly
 * poll for opaque tokens. Always clamped to REFRESH_MAX_DELAY_MS so the value
 * stays inside setTimeout's 32-bit range.
 */
export function computeRefreshDelay(
	token: string,
	failureStreak: number,
	nowMs: number,
): number {
	let delay: number;
	if (failureStreak > 0) {
		const index = Math.min(failureStreak - 1, REFRESH_RETRY_BACKOFF_MS.length - 1);
		delay = REFRESH_RETRY_BACKOFF_MS[index];
	} else {
		const expMs = decodeJwtExpMs(token);
		delay =
			expMs === null
				? REFRESH_OPAQUE_FALLBACK_MS
				: Math.max(REFRESH_MIN_DELAY_MS, expMs - REFRESH_LEAD_MS - nowMs);
	}
	return Math.min(delay, REFRESH_MAX_DELAY_MS);
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
