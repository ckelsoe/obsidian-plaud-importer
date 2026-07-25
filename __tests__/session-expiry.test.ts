import type { TokenLifetime } from '../plaud-token';
import {
	clampTimerDelayMs,
	MAX_TIMER_DELAY_MS,
	MIN_TIMER_DELAY_MS,
	sessionExpiryDecision,
	WARN_LEAD_LONG_MS,
	WARN_LEAD_SHORT_MS,
	warnLeadMs,
} from '../session-expiry';

const NOW_MS = 1_780_000_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Builds a measured lifetime the way readTokenLifetime would report it. The
// decision function must derive remaining time from expMs and its own nowMs,
// so remainingMs here is deliberately stale garbage.
function life(overrides: Partial<TokenLifetime> & { expMs: number }): TokenLifetime {
	return {
		issuedAtMs: null,
		lifetimeHours: null,
		remainingMs: -999_999,
		typ: 'JWT',
		hasWid: false,
		...overrides,
	};
}

describe('warnLeadMs', () => {
	it('uses the short lead for short and unknown lifetimes', () => {
		expect(warnLeadMs(24)).toBe(WARN_LEAD_SHORT_MS);
		expect(warnLeadMs(null)).toBe(WARN_LEAD_SHORT_MS);
	});

	it('uses the long lead for long lifetimes', () => {
		expect(warnLeadMs(7222)).toBe(WARN_LEAD_LONG_MS);
	});

	it('treats exactly SHORT_LIFETIME_HOURS as short (boundary pin)', () => {
		// The > (not >=) is load-bearing: it matches describeTokenLifetime's
		// "<= 72 is short" so the two features never disagree at the edge.
		expect(warnLeadMs(72)).toBe(WARN_LEAD_SHORT_MS);
	});
});

describe('clampTimerDelayMs', () => {
	it('clamps into [30s, 20 days]', () => {
		expect(clampTimerDelayMs(0)).toBe(MIN_TIMER_DELAY_MS);
		expect(clampTimerDelayMs(-5)).toBe(MIN_TIMER_DELAY_MS);
		expect(clampTimerDelayMs(5 * DAY_MS)).toBe(5 * DAY_MS);
		expect(clampTimerDelayMs(300 * DAY_MS)).toBe(MAX_TIMER_DELAY_MS);
		// The whole point of the ceiling: stay under the 32-bit setTimeout
		// overflow (PR #63).
		expect(MAX_TIMER_DELAY_MS).toBeLessThan(2_147_483_647);
	});
});

describe('sessionExpiryDecision', () => {
	it('does nothing without a readable lifetime', () => {
		const d = sessionExpiryDecision(NOW_MS, null, 0);
		expect(d.action).toBe('none');
		expect(d.armDelayMs).toBeNull();
	});

	it('schedules ahead of the warn window for a 24h token', () => {
		const expMs = NOW_MS + 20 * HOUR_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			0,
		);
		expect(d.action).toBe('scheduled');
		expect(d.armDelayMs).toBe(20 * HOUR_MS - WARN_LEAD_SHORT_MS);
	});

	it('clamps the armed delay for a ~300-day token instead of overflowing', () => {
		const expMs = NOW_MS + 300 * DAY_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 7200 }),
			0,
		);
		expect(d.action).toBe('scheduled');
		expect(d.armDelayMs).toBe(MAX_TIMER_DELAY_MS);
	});

	it('warns inside the lead window when not yet warned for this exp', () => {
		const expMs = NOW_MS + HOUR_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			0,
		);
		expect(d.action).toBe('warn');
		expect(d.expMs).toBe(expMs);
		expect(d.expired).toBe(false);
	});

	it('stays quiet when already warned for the same exp', () => {
		const expMs = NOW_MS + HOUR_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			expMs,
		);
		expect(d.action).toBe('quiet');
	});

	it('warns again for a fresh credential with a different exp', () => {
		const expMs = NOW_MS + HOUR_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			expMs - 86_400_000,
		);
		expect(d.action).toBe('warn');
	});

	it('warns once for an already-expired credential', () => {
		const expMs = NOW_MS - HOUR_MS;
		const first = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			0,
		);
		expect(first.action).toBe('warn');
		expect(first.expired).toBe(true);
		const second = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			expMs,
		);
		expect(second.action).toBe('quiet');
	});

	it('uses the long lead for a long-lived token', () => {
		// 5 days out with a ~300-day lifetime: inside the 7-day lead, so warn.
		const expMs = NOW_MS + 5 * DAY_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 7200 }),
			0,
		);
		expect(d.action).toBe('warn');
	});

	it('warns when remaining time exactly equals the lead (window edge)', () => {
		const expMs = NOW_MS + WARN_LEAD_SHORT_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			0,
		);
		expect(d.action).toBe('warn');
	});

	it('clamps a tiny scheduled delay up to the 30s floor', () => {
		const expMs = NOW_MS + WARN_LEAD_SHORT_MS + 5_000;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 24 }),
			0,
		);
		expect(d.action).toBe('scheduled');
		expect(d.armDelayMs).toBe(MIN_TIMER_DELAY_MS);
	});

	it('schedules an unclamped long-lead delay for a long token 10 days out', () => {
		const expMs = NOW_MS + 10 * DAY_MS;
		const d = sessionExpiryDecision(
			NOW_MS,
			life({ expMs, lifetimeHours: 7200 }),
			0,
		);
		expect(d.action).toBe('scheduled');
		expect(d.armDelayMs).toBe(10 * DAY_MS - WARN_LEAD_LONG_MS);
	});

	it('treats an unknown lifetime with the short lead, not the long one', () => {
		// 3 days out, lifetime unknown: outside the 2h short lead, so a long
		// lead must NOT put it in the warn window.
		const expMs = NOW_MS + 3 * DAY_MS;
		const d = sessionExpiryDecision(NOW_MS, life({ expMs }), 0);
		expect(d.action).toBe('scheduled');
		expect(d.armDelayMs).toBe(3 * DAY_MS - WARN_LEAD_SHORT_MS);
	});
});
