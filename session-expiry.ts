// Pure scheduling logic for the pre-expiry session warning (issue #78,
// 0.34.0). Decides WHEN to warn that the stored Plaud session is about to
// expire, and when to next re-evaluate, from a measured TokenLifetime. No
// Obsidian or Electron import, so it stays unit-testable like
// reconnect-routing.ts.
//
// Design constraints:
// - The warn lead is short (2h) for short or unknown issued lifetimes and
//   long (7 days) otherwise: a 24-hour session cannot absorb a 7-day lead,
//   and an unknown lifetime must not assume one.
// - Timer delays are clamped under the 32-bit setTimeout ceiling (PR #63:
//   a ~137-day delay overflowed the ceiling and fired ~319ms later).
//   Re-derived here, deliberately NOT copied from the deleted 0.31.0
//   refresh module.
// - The warning fires ONCE per credential, keyed on the exact expMs, so a
//   restart inside the warn window does not re-nag.
// - Nothing here gates an API call; expiry state only drives a notice.

import { SHORT_LIFETIME_HOURS, type TokenLifetime } from './plaud-token';

/** Warn lead for short or unknown issued lifetimes: 2 hours. */
export const WARN_LEAD_SHORT_MS = 2 * 60 * 60 * 1000;
/** Warn lead for long issued lifetimes: 7 days. */
export const WARN_LEAD_LONG_MS = 7 * 24 * 60 * 60 * 1000;
/** Never arm a timer shorter than this; batches rapid credential churn. */
export const MIN_TIMER_DELAY_MS = 30 * 1000;
/**
 * Never arm a timer longer than this: 20 days sits safely under the 32-bit
 * setTimeout ceiling (~24.8 days). A longer wait re-arms itself on fire.
 */
export const MAX_TIMER_DELAY_MS = 20 * 24 * 60 * 60 * 1000;

/** What the caller should do now, and when to look again. */
export interface SessionExpiryDecision {
	/**
	 * 'none': nothing to track (no token, or not a decodable JWT).
	 * 'scheduled': before the warn window; re-evaluate after armDelayMs.
	 * 'warn': inside the warn window (or already past expiry) and not yet
	 * warned for this expMs; show the notice once and stamp warnedForExpMs.
	 * 'quiet': inside the warn window but already warned for this expMs.
	 */
	action: 'none' | 'scheduled' | 'warn' | 'quiet';
	/** The expiry under consideration, epoch ms; null when action is 'none'. */
	expMs: number | null;
	/** True when the credential is already past its exp. */
	expired: boolean;
	/** Delay to the next re-evaluation, clamped; null when nothing to arm. */
	armDelayMs: number | null;
}

/** Lead time before expiry at which the warning should fire. */
export function warnLeadMs(lifetimeHours: number | null): number {
	return lifetimeHours !== null && lifetimeHours > SHORT_LIFETIME_HOURS
		? WARN_LEAD_LONG_MS
		: WARN_LEAD_SHORT_MS;
}

/** Clamps a timer delay into [MIN_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS]. */
export function clampTimerDelayMs(delayMs: number): number {
	return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TIMER_DELAY_MS, delayMs));
}

/**
 * The single decision point: given the clock, the measured lifetime of the
 * stored credential, and the expMs the user was last warned about (0 = never),
 * says whether to warn now, stay quiet, or re-check later. remainingMs is
 * derived from expMs and nowMs here, NOT taken from the TokenLifetime, whose
 * own remainingMs is relative to the clock at measurement time.
 */
export function sessionExpiryDecision(
	nowMs: number,
	life: TokenLifetime | null,
	warnedForExpMs: number,
): SessionExpiryDecision {
	if (life === null) {
		return {
			action: 'none',
			expMs: null,
			expired: false,
			armDelayMs: null,
		};
	}
	const lead = warnLeadMs(life.lifetimeHours);
	const remainingMs = life.expMs - nowMs;
	const expired = remainingMs <= 0;
	if (remainingMs > lead) {
		// Before the warn window. Arm for expiry-minus-lead; the clamp ceiling
		// makes a very long wait re-arm on fire instead of overflowing.
		return {
			action: 'scheduled',
			expMs: life.expMs,
			expired: false,
			armDelayMs: clampTimerDelayMs(remainingMs - lead),
		};
	}
	if (warnedForExpMs === life.expMs) {
		return {
			action: 'quiet',
			expMs: life.expMs,
			expired,
			armDelayMs: null,
		};
	}
	return { action: 'warn', expMs: life.expMs, expired, armDelayMs: null };
}
