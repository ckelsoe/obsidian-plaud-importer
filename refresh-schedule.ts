// When to run the silent session refresh, as a pure decision.
//
// Plaud's v2 workspace token (WT) lives exactly 24 hours (measured 2026-07-26:
// `exp - iat` is 86400 on the nose). The refresh re-mints it from the sign-in
// partition's cookies, so it has to land BEFORE that expiry, not after.
//
// There is no retry ladder here, and that is deliberate. The mint's own step-1
// response reports `login_total_per_hour: 10`, a server-side ceiling on how
// often an account may refresh. A backoff ladder against a genuinely dead
// session spends that budget and can lock the account out of refreshing at all,
// which is the opposite of what a recovery path should do. One attempt per
// cycle; a failure pauses and asks the user to reconnect, and the next success
// re-arms the normal cadence. The retired 0.32.0 subsystem had a four-step
// ladder (REFRESH_RETRY_BACKOFF_MS); it is not restored.
//
// Deliberately free of Obsidian and Electron imports so the timing rules are
// unit-testable without the plugin runtime.

import { WARN_LEAD_SHORT_MS, clampTimerDelayMs } from './session-expiry';
import { decodeJwtPayload } from './plaud-token';

/**
 * Refresh this long before the token's `exp`.
 *
 * Derived from the pre-expiry warning's lead rather than picked independently,
 * and it MUST stay larger than it. A renewal that starts at the same moment the
 * warning does is not silent: the two timers come due together, and while the
 * refresh is still waiting on its two network calls the warning puts a
 * "Reconnect now" notice on screen, which a successful refresh then quietly
 * takes away again. A healthy session would flash a false alarm every cycle,
 * which is precisely what unattended renewal is supposed to remove.
 *
 * Running a clear margin earlier means the ordinary path is: refresh, succeed,
 * store a fresh 24 hour token, and the warning is re-derived against THAT
 * token and never fires at all. When the refresh fails the warning is not
 * delayed by this choice either: onSessionRefreshFailed reconciles the warning
 * immediately rather than waiting for its own timer.
 */
export const REFRESH_LEAD_MS = 2 * WARN_LEAD_SHORT_MS;

/**
 * The nominal cadence this produces on a healthy 24 hour token. Exported for
 * the copy that describes it and for the tests that pin it; the schedule itself
 * is always derived from the real `exp`, never from this constant, because the
 * issued lifetime is measured and never assumed.
 */
export const NOMINAL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 - REFRESH_LEAD_MS;

/**
 * Delay until the next refresh attempt, or null when the stored value carries
 * no readable expiry and therefore cannot be scheduled against.
 *
 * Null means "do not arm a timer". A token that does not decode is not one this
 * path can keep alive, and an arbitrary poll against it would burn the hourly
 * refresh budget to no purpose; the pre-expiry warning and Reconnect are the
 * recovery for that case. Everything else is `exp` minus the lead, clamped by
 * clampTimerDelayMs into [30s, 20 days]: the floor keeps an already-due or
 * past-due token from spinning a tight loop, and the ceiling keeps the delay
 * under setTimeout's 32-bit ms limit, which a long-lived token overflowed in
 * the 2026-07-09 bug (the timer fired instantly and retried forever).
 */
export function computeRefreshDelayMs(
	token: string,
	nowMs: number,
): number | null {
	const payload = decodeJwtPayload(token);
	if (payload === null) {
		return null;
	}
	const exp = payload.exp;
	if (typeof exp !== 'number' || !Number.isFinite(exp)) {
		return null;
	}
	return clampTimerDelayMs(exp * 1000 - REFRESH_LEAD_MS - nowMs);
}

/**
 * True when the token is close enough to expiry that a refresh should actually
 * run now. Guards the timer callback: the 20 day clamp above means a wake-up
 * can arrive long before the token is due, and re-checking here turns that
 * early wake into a cheap no-op re-arm instead of a wasted mint call against
 * the hourly ceiling.
 */
export function isRefreshDue(token: string, nowMs: number): boolean {
	const payload = decodeJwtPayload(token);
	if (payload === null) {
		return false;
	}
	const exp = payload.exp;
	if (typeof exp !== 'number' || !Number.isFinite(exp)) {
		return false;
	}
	return exp * 1000 - nowMs <= REFRESH_LEAD_MS;
}
