import {
	decodeJwtPayload,
	isUsableUserToken,
	readTokenClientId,
} from '../plaud-token';
import { jwtTyp } from '../plaud-refresh';

// Build a minimal unsigned JWT from a header and payload object. The helpers
// only read unverified claims, so an unsigned token with a dummy signature
// segment is a faithful fixture.
function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function makeJwt(header: unknown, payload: unknown): string {
	return `${b64url(header)}.${b64url(payload)}.sig`;
}

// Fixed clock (ms). Fixtures pick exp relative to this so the future-exp check
// is deterministic and does not drift with the real wall clock.
const NOW_MS = 1_780_000_000_000; // 2026-05-28
const FUTURE_EXP = 1_800_000_000; // seconds → 2027-01-15, after NOW_MS
const PAST_EXP = 1_770_000_000; // seconds → 2026-02-01, before NOW_MS

// The ~300-day user token the plugin now captures: payload carries a future exp
// and a client_id (plus sub/aud/iat/region), header typ is not 'WT'.
const LONG_LIVED_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{
		sub: 'user-123',
		aud: 'plaud',
		exp: FUTURE_EXP,
		iat: 1_774_000_000,
		client_id: 'web',
		region: 'us',
	},
);

// The 24h workspace token: typ 'WT', carries exp and client_id too (so the
// capture guard accepts it while live), plus the wid claim the guard ignores.
const WORKSPACE_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ sub: 'user-123', exp: FUTURE_EXP, client_id: 'web', wid: 'ws-1', region: 'us' },
);

// The neighboring profile/ID JWT in the same localStorage: payload is only
// {email,id,name}, NO exp. Decodes cleanly but the data API -3900's it.
const PROFILE_JWT = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ email: 'a@b.com', id: 'user-123', name: 'A B' },
);

// A long-lived-shaped token whose exp is already in the past: a stale token left
// in localStorage after a lapsed session.
const EXPIRED_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'user-123', exp: PAST_EXP, client_id: 'web', region: 'us' },
);

// The paired refresh token (typ WRT). It carries a future exp and a client_id,
// but the data API -3901's it, so the guard must reject it by header type.
const REFRESH_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WRT' },
	{ sub: 'user-123', exp: FUTURE_EXP, client_id: 'web', region: 'us' },
);

describe('isUsableUserToken (capture guard)', () => {
	it('accepts a live long-lived user token (future exp and client_id)', () => {
		expect(isUsableUserToken(LONG_LIVED_TOKEN, NOW_MS)).toBe(true);
	});

	it('accepts a bearer-prefixed token (the localStorage value form)', () => {
		expect(isUsableUserToken(`bearer ${LONG_LIVED_TOKEN}`, NOW_MS)).toBe(true);
	});

	it('accepts a live workspace token too (it also carries exp and client_id)', () => {
		expect(isUsableUserToken(WORKSPACE_TOKEN, NOW_MS)).toBe(true);
	});

	it('rejects the neighboring profile JWT (no exp claim)', () => {
		expect(isUsableUserToken(PROFILE_JWT, NOW_MS)).toBe(false);
	});

	it('rejects an already-expired token still sitting in localStorage', () => {
		expect(isUsableUserToken(EXPIRED_TOKEN, NOW_MS)).toBe(false);
	});

	it('rejects the paired refresh token (typ WRT) despite a future exp', () => {
		expect(isUsableUserToken(REFRESH_TOKEN, NOW_MS)).toBe(false);
	});

	it('rejects a token whose exp exactly equals now (not strictly future)', () => {
		const atBoundary = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: NOW_MS / 1000, client_id: 'web' },
		);
		expect(isUsableUserToken(atBoundary, NOW_MS)).toBe(false);
	});

	it('rejects a token whose exp is present but not numeric', () => {
		const badExp = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: 'soon', client_id: 'web' },
		);
		expect(isUsableUserToken(badExp, NOW_MS)).toBe(false);
	});

	it('rejects a token with a future exp but an empty client_id', () => {
		const noClient = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: FUTURE_EXP, client_id: '' },
		);
		expect(isUsableUserToken(noClient, NOW_MS)).toBe(false);
	});

	it('rejects a token with a future exp but a missing client_id', () => {
		const noClient = makeJwt({ alg: 'HS256', typ: 'JWT' }, { exp: FUTURE_EXP });
		expect(isUsableUserToken(noClient, NOW_MS)).toBe(false);
	});

	it('rejects non-JWT and empty values', () => {
		expect(isUsableUserToken('', NOW_MS)).toBe(false);
		expect(isUsableUserToken('not-a-jwt', NOW_MS)).toBe(false);
		expect(isUsableUserToken('eyJ-only-one-segment', NOW_MS)).toBe(false);
	});

	it('rejects a valid JWT embedded in a longer string (exact three segments only)', () => {
		// The parser splits on '.' and requires exactly three base64url segments,
		// so a trailing suffix (or any non-base64url character) is rejected rather
		// than having an inner JWT plucked out and stored.
		expect(isUsableUserToken(`${LONG_LIVED_TOKEN} trailing`, NOW_MS)).toBe(false);
		expect(isUsableUserToken(`prefix ${LONG_LIVED_TOKEN}`, NOW_MS)).toBe(false);
		expect(isUsableUserToken(`${LONG_LIVED_TOKEN}.extra`, NOW_MS)).toBe(false);
	});

	it('defaults nowMs to the current time when omitted', () => {
		// Build fixtures relative to the real clock so the assertion never drifts
		// into failure at a fixed calendar date.
		const nowSec = Math.floor(Date.now() / 1000);
		const live = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: nowSec + 86_400, client_id: 'web' },
		);
		const dead = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: nowSec - 86_400, client_id: 'web' },
		);
		expect(isUsableUserToken(live)).toBe(true);
		expect(isUsableUserToken(dead)).toBe(false);
	});
});

describe('readTokenClientId', () => {
	it('reads the client_id claim from a valid token', () => {
		expect(readTokenClientId(LONG_LIVED_TOKEN)).toBe('web');
	});

	it('returns null when the claim is absent', () => {
		expect(readTokenClientId(PROFILE_JWT)).toBeNull();
	});

	it('returns null for a non-JWT value', () => {
		expect(readTokenClientId('garbage')).toBeNull();
	});
});

describe('decodeJwtPayload', () => {
	it('decodes the payload of a valid token', () => {
		const payload = decodeJwtPayload(LONG_LIVED_TOKEN);
		expect(payload).not.toBeNull();
		expect(payload?.client_id).toBe('web');
		expect(payload?.exp).toBe(FUTURE_EXP);
	});

	it('returns null for a value that is not a decodable JWT', () => {
		expect(decodeJwtPayload('nope')).toBeNull();
	});
});

// The refresh-neutralization predicate: main.ts gates every refresh path on
// jwtTyp(token) === 'WT'. A long-lived user token must read as non-'WT' (so
// refresh never runs and never clobbers it with a 24h WT), while a real
// workspace token still reads as 'WT'.
describe('refresh neutralization predicate (jwtTyp)', () => {
	it('reads the long-lived user token as a non-WT typ', () => {
		expect(jwtTyp(LONG_LIVED_TOKEN)).not.toBe('WT');
	});

	it('reads the workspace token as WT', () => {
		expect(jwtTyp(WORKSPACE_TOKEN)).toBe('WT');
	});
});
