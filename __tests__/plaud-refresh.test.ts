import {
	computeRefreshDelay,
	decodeJwtExpMs,
	isFreshAccessToken,
	isRefreshDue,
	jwtTyp,
	REFRESH_LEAD_MS,
	REFRESH_MAX_DELAY_MS,
	REFRESH_MIN_DELAY_MS,
	REFRESH_OPAQUE_FALLBACK_MS,
	REFRESH_RETRY_BACKOFF_MS,
} from '../plaud-refresh';

// Build a minimal unsigned JWT with the given header `typ` and payload `exp`
// (seconds). The helpers only read unverified claims (typ, exp), so an unsigned
// token with a dummy signature segment is a faithful fixture.
function makeJwt(typ: string, expSeconds: number | null): string {
	const b64url = (obj: unknown): string =>
		Buffer.from(JSON.stringify(obj))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	const header = b64url({ alg: 'HS256', typ });
	const payload = b64url(expSeconds === null ? { sub: 'x' } : { sub: 'x', exp: expSeconds });
	return `${header}.${payload}.sig`;
}

const NOW = 1_780_000_000_000; // fixed clock in ms
const FUTURE_EXP_S = Math.floor(NOW / 1000) + 24 * 3600; // +24h
const PAST_EXP_S = Math.floor(NOW / 1000) - 60; // 1 min ago

const FRESH_WT = makeJwt('WT', FUTURE_EXP_S);
const EXPIRED_WT = makeJwt('WT', PAST_EXP_S);
const FRESH_UT = makeJwt('UT', FUTURE_EXP_S); // the user token the refresh endpoint returns
const FRESH_WRT = makeJwt('WRT', FUTURE_EXP_S);
// Mirrors the token that produced the window storm: header typ JWT (not WT)
// with an exp ~137 days out, whose exp-driven delay overflows setTimeout's
// 32-bit signed range (2,147,483,647 ms) and used to fire immediately.
const LONG_EXP_S = Math.floor(NOW / 1000) + 137 * 24 * 3600;
const LONG_LIVED_JWT = makeJwt('JWT', LONG_EXP_S);
const NO_EXP_WT = makeJwt('WT', null);

describe('jwtTyp / decodeJwtExpMs', () => {
	it('reads the header typ', () => {
		expect(jwtTyp(FRESH_WT)).toBe('WT');
		expect(jwtTyp(FRESH_UT)).toBe('UT');
		expect(jwtTyp(FRESH_WRT)).toBe('WRT');
		expect(jwtTyp(`bearer ${FRESH_WT}`)).toBe('WT');
	});

	it('returns null for a non-JWT', () => {
		expect(jwtTyp('not-a-token')).toBeNull();
		expect(decodeJwtExpMs('not-a-token')).toBeNull();
	});

	it('reads exp as milliseconds', () => {
		expect(decodeJwtExpMs(FRESH_WT)).toBe(FUTURE_EXP_S * 1000);
	});

	it('returns null when exp is absent', () => {
		expect(decodeJwtExpMs(makeJwt('WT', null))).toBeNull();
	});
});

describe('isFreshAccessToken', () => {
	it('accepts a WT with a future exp', () => {
		expect(isFreshAccessToken(FRESH_WT, NOW)).toBe(true);
	});
	it('rejects an expired WT', () => {
		expect(isFreshAccessToken(EXPIRED_WT, NOW)).toBe(false);
	});
	it('rejects a UT (the refresh-endpoint token type) even if unexpired', () => {
		expect(isFreshAccessToken(FRESH_UT, NOW)).toBe(false);
	});
	it('rejects a WRT even if unexpired', () => {
		expect(isFreshAccessToken(FRESH_WRT, NOW)).toBe(false);
	});
});

describe('computeRefreshDelay', () => {
	it('schedules a normal 24h token at exp minus the lead, unclamped', () => {
		const delay = computeRefreshDelay(FRESH_WT, 0, NOW);
		expect(delay).toBe(FUTURE_EXP_S * 1000 - REFRESH_LEAD_MS - NOW);
		expect(delay).toBeLessThan(REFRESH_MAX_DELAY_MS);
	});

	it('clamps a long-lived token under the 32-bit setTimeout ceiling', () => {
		// Prove the fixture matters: unclamped, this delay overflows setTimeout.
		const unclamped = LONG_EXP_S * 1000 - REFRESH_LEAD_MS - NOW;
		expect(unclamped).toBeGreaterThan(2_147_483_647);
		const delay = computeRefreshDelay(LONG_LIVED_JWT, 0, NOW);
		expect(delay).toBe(REFRESH_MAX_DELAY_MS);
		expect(delay).toBeLessThan(2_147_483_647);
	});

	it('floors a past-due token at the minimum delay', () => {
		expect(computeRefreshDelay(EXPIRED_WT, 0, NOW)).toBe(REFRESH_MIN_DELAY_MS);
	});

	it('polls hourly for a token with no decodable exp', () => {
		expect(computeRefreshDelay(NO_EXP_WT, 0, NOW)).toBe(REFRESH_OPAQUE_FALLBACK_MS);
		expect(computeRefreshDelay('not-a-token', 0, NOW)).toBe(REFRESH_OPAQUE_FALLBACK_MS);
	});

	it('uses the failure backoff on a streak, clamped to the last entry', () => {
		expect(computeRefreshDelay(FRESH_WT, 1, NOW)).toBe(REFRESH_RETRY_BACKOFF_MS[0]);
		expect(computeRefreshDelay(FRESH_WT, 4, NOW)).toBe(
			REFRESH_RETRY_BACKOFF_MS[REFRESH_RETRY_BACKOFF_MS.length - 1],
		);
		expect(computeRefreshDelay(FRESH_WT, 9, NOW)).toBe(
			REFRESH_RETRY_BACKOFF_MS[REFRESH_RETRY_BACKOFF_MS.length - 1],
		);
	});

	it('backoff ignores the token exp (still inside the clamp)', () => {
		expect(computeRefreshDelay(LONG_LIVED_JWT, 1, NOW)).toBe(REFRESH_RETRY_BACKOFF_MS[0]);
	});
});

describe('isRefreshDue', () => {
	it('is not due for a 24h token well outside the lead window', () => {
		expect(isRefreshDue(FRESH_WT, NOW)).toBe(false);
	});

	it('is not due for the long-lived non-WT token that caused the storm', () => {
		// The skip-if-fresh guard: an early (clamped) timer fire on this token
		// must be a no-op re-arm, never a refresh attempt.
		expect(isRefreshDue(LONG_LIVED_JWT, NOW)).toBe(false);
	});

	it('is due once exp is inside the lead window', () => {
		const soon = makeJwt('WT', Math.floor(NOW / 1000) + 3 * 60); // +3 min < 5 min lead
		expect(isRefreshDue(soon, NOW)).toBe(true);
	});

	it('is due for an expired token', () => {
		expect(isRefreshDue(EXPIRED_WT, NOW)).toBe(true);
	});

	it('is due for a token with no decodable exp (matches the hourly poll)', () => {
		expect(isRefreshDue(NO_EXP_WT, NOW)).toBe(true);
		expect(isRefreshDue('not-a-token', NOW)).toBe(true);
	});
});
