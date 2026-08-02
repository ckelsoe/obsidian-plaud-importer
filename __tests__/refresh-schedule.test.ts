import {
	NOMINAL_REFRESH_INTERVAL_MS,
	REFRESH_LEAD_MS,
	computeRefreshDelayMs,
	isRefreshDue,
} from '../refresh-schedule';
import {
	MAX_TIMER_DELAY_MS,
	MIN_TIMER_DELAY_MS,
	WARN_LEAD_SHORT_MS,
} from '../session-expiry';

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function tokenExpiringAt(expMs: number): string {
	return `${b64url({ alg: 'HS256', typ: 'WT' })}.${b64url({
		sub: 'u1',
		client_id: 'web',
		wid: 'ws_clF1vOqcHS',
		exp: Math.floor(expMs / 1000),
	})}.sig`;
}
/** Payload written raw so exp survives as a non-JSON-representable value. */
function tokenWithRawPayload(payloadJson: string): string {
	return `${b64url({ alg: 'HS256', typ: 'WT' })}.${Buffer.from(payloadJson)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')}.sig`;
}

const NOW = 1_785_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('computeRefreshDelayMs', () => {
	it('lands one lead time before expiry', () => {
		const token = tokenExpiringAt(NOW + 24 * HOUR);
		expect(computeRefreshDelayMs(token, NOW)).toBe(
			24 * HOUR - REFRESH_LEAD_MS,
		);
	});

	it('produces the nominal cadence on Plaud 24 hour token', () => {
		// The cadence is derived from the real exp, never from the constant, so
		// this pins that the two actually agree on the shape Plaud issues.
		const token = tokenExpiringAt(NOW + 24 * HOUR);
		expect(computeRefreshDelayMs(token, NOW)).toBe(
			NOMINAL_REFRESH_INTERVAL_MS,
		);
	});

	it('runs a clear margin BEFORE the pre-expiry warning would fire', () => {
		// If these two leads were equal the timers would come due together and
		// a healthy session would show a "Reconnect now" notice on every cycle,
		// which a successful refresh would then take away. Renewal has to win
		// the race by construction, not by luck.
		expect(REFRESH_LEAD_MS).toBeGreaterThan(WARN_LEAD_SHORT_MS);
		const token = tokenExpiringAt(NOW + 24 * HOUR);
		const refreshAt = computeRefreshDelayMs(token, NOW);
		const warnAt = 24 * HOUR - WARN_LEAD_SHORT_MS;
		expect(refreshAt).not.toBeNull();
		expect(refreshAt as number).toBeLessThan(warnAt);
	});

	it('floors a past-due token instead of spinning a tight loop', () => {
		// A refresh that keeps firing burns the ~10-per-hour server ceiling.
		const token = tokenExpiringAt(NOW - 5 * HOUR);
		expect(computeRefreshDelayMs(token, NOW)).toBe(MIN_TIMER_DELAY_MS);
	});

	it('clamps a long-lived token under the 32-bit setTimeout ceiling', () => {
		// The 2026-07-09 overflow: a ~137 day exp overflowed the 32-bit delay
		// and fired instantly, retrying forever.
		const token = tokenExpiringAt(NOW + 137 * 24 * HOUR);
		const delay = computeRefreshDelayMs(token, NOW);
		expect(delay).toBe(MAX_TIMER_DELAY_MS);
		expect(delay).toBeLessThan(2 ** 31 - 1);
	});

	it('declines to schedule against an unreadable value', () => {
		expect(computeRefreshDelayMs('not-a-jwt', NOW)).toBeNull();
	});

	it('declines to schedule against a token with no numeric exp', () => {
		const token = tokenWithRawPayload('{"sub":"u1","client_id":"web"}');
		expect(computeRefreshDelayMs(token, NOW)).toBeNull();
	});

	it('declines to schedule against a non-finite exp', () => {
		// JSON.parse yields Infinity here; arithmetic on it would produce NaN
		// and setTimeout(NaN) fires immediately, which is the retry storm again.
		const token = tokenWithRawPayload(
			'{"sub":"u1","client_id":"web","exp":1e400}',
		);
		expect(computeRefreshDelayMs(token, NOW)).toBeNull();
	});
});

describe('isRefreshDue', () => {
	it('is false while the token still has ample life', () => {
		expect(isRefreshDue(tokenExpiringAt(NOW + 24 * HOUR), NOW)).toBe(false);
	});

	it('is true inside the lead window', () => {
		expect(isRefreshDue(tokenExpiringAt(NOW + HOUR), NOW)).toBe(true);
	});

	it('is true once expired', () => {
		expect(isRefreshDue(tokenExpiringAt(NOW - HOUR), NOW)).toBe(true);
	});

	it('is false for a value it cannot read, so no call is spent on it', () => {
		expect(isRefreshDue('not-a-jwt', NOW)).toBe(false);
	});

	it('guards the early wake the 20 day clamp creates', () => {
		// A token 137 days out is armed at 20 days by the clamp. When that timer
		// fires the token is nowhere near due, and the runner must re-arm rather
		// than spend a mint call.
		const token = tokenExpiringAt(NOW + 137 * 24 * HOUR);
		const wake = NOW + MAX_TIMER_DELAY_MS;
		expect(isRefreshDue(token, wake)).toBe(false);
	});
});
