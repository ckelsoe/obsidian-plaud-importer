import { decodeJwtExpMs, isFreshAccessToken, jwtTyp } from '../plaud-refresh';

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
