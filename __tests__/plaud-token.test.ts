import {
	decodeJwtHeader,
	decodeJwtPayload,
	describeTokenLifetime,
	formatSessionStatus,
	isUsableUserToken,
	isWorkspaceToken,
	readTokenClientId,
	readTokenLifetime,
	SHORT_LIFETIME_HOURS,
} from '../plaud-token';

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
	{
		sub: 'user-123',
		exp: FUTURE_EXP,
		client_id: 'web',
		wid: 'ws-1',
		region: 'us',
	},
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

describe('isWorkspaceToken (refresh gate, NOT a capture gate)', () => {
	it('is true only for a header typ of WT', () => {
		expect(isWorkspaceToken(WORKSPACE_TOKEN)).toBe(true);
		expect(isWorkspaceToken(LONG_LIVED_TOKEN)).toBe(false);
		expect(isWorkspaceToken('not-a-token')).toBe(false);
	});

	it('does not narrow what capture accepts', () => {
		// The refresh is WT-only, but capture must keep taking a long-lived
		// pre-v2 token where one still exists. These two guards disagreeing on
		// LONG_LIVED_TOKEN is the point, not a bug.
		expect(isUsableUserToken(LONG_LIVED_TOKEN, NOW_MS)).toBe(true);
		expect(isWorkspaceToken(LONG_LIVED_TOKEN)).toBe(false);
	});
});

describe('isUsableUserToken (capture guard)', () => {
	it('accepts a live long-lived user token (future exp and client_id)', () => {
		expect(isUsableUserToken(LONG_LIVED_TOKEN, NOW_MS)).toBe(true);
	});

	it('accepts a bearer-prefixed token (the localStorage value form)', () => {
		expect(isUsableUserToken(`bearer ${LONG_LIVED_TOKEN}`, NOW_MS)).toBe(
			true,
		);
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
		const noClient = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: FUTURE_EXP },
		);
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
		expect(isUsableUserToken(`${LONG_LIVED_TOKEN} trailing`, NOW_MS)).toBe(
			false,
		);
		expect(isUsableUserToken(`prefix ${LONG_LIVED_TOKEN}`, NOW_MS)).toBe(
			false,
		);
		expect(isUsableUserToken(`${LONG_LIVED_TOKEN}.extra`, NOW_MS)).toBe(
			false,
		);
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

describe('decodeJwtHeader', () => {
	it('decodes the header of a valid token', () => {
		const header = decodeJwtHeader(WORKSPACE_TOKEN);
		expect(header?.typ).toBe('WT');
		expect(header?.alg).toBe('HS256');
	});

	it('returns null for a value that is not a decodable JWT', () => {
		expect(decodeJwtHeader('nope')).toBeNull();
	});
});

// Issue #78: session lifetime varies by account (24h observed on APSE1, ~300
// days on US), so the plugin measures exp - iat instead of assuming. These
// tests pin the measurement contract: report null rather than guess when iat
// is absent, and never treat lifetime as a gate (the capture-guard pins for
// that live in the isUsableUserToken describe above: the workspace-token
// acceptance and the defaults-nowMs 24h-remaining case).
// A live token issued for exactly 24 hours, captured ~2.8h into its life,
// matching the issue #78 report shape. Module-scoped: the lifetime,
// description, and session-status suites all use it.
const IAT_24H = 1_779_990_000;
const SHORT_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{
		sub: 'user-123',
		exp: IAT_24H + 86_400,
		iat: IAT_24H,
		client_id: 'web',
		region: 'aws:ap-southeast-1',
	},
);

describe('readTokenLifetime', () => {
	it('measures a 24-hour issued lifetime', () => {
		const life = readTokenLifetime(SHORT_TOKEN, NOW_MS);
		expect(life).not.toBeNull();
		expect(life?.lifetimeHours).toBe(24);
		expect(life?.issuedAtMs).toBe(IAT_24H * 1000);
		expect(life?.expMs).toBe((IAT_24H + 86_400) * 1000);
		expect(life?.remainingMs).toBe((IAT_24H + 86_400) * 1000 - NOW_MS);
		expect(life?.typ).toBe('JWT');
		expect(life?.hasWid).toBe(false);
	});

	it('measures the long-lived token at its true value', () => {
		const life = readTokenLifetime(LONG_LIVED_TOKEN, NOW_MS);
		expect(life?.lifetimeHours).toBeCloseTo(
			(FUTURE_EXP - 1_774_000_000) / 3600,
		);
		expect(life?.remainingMs).toBe(FUTURE_EXP * 1000 - NOW_MS);
		expect(life?.typ).toBe('JWT');
		expect(life?.hasWid).toBe(false);
	});

	it('reports a null lifetime for the workspace token (no iat), with typ and wid', () => {
		const life = readTokenLifetime(WORKSPACE_TOKEN, NOW_MS);
		expect(life).not.toBeNull();
		expect(life?.lifetimeHours).toBeNull();
		expect(life?.issuedAtMs).toBeNull();
		expect(life?.expMs).toBe(FUTURE_EXP * 1000);
		expect(life?.typ).toBe('WT');
		expect(life?.hasWid).toBe(true);
	});

	it('reports a negative remainingMs for an expired token', () => {
		const life = readTokenLifetime(EXPIRED_TOKEN, NOW_MS);
		expect(life).not.toBeNull();
		expect(life?.remainingMs).toBeLessThan(0);
	});

	it('returns null for a token without a numeric exp', () => {
		expect(readTokenLifetime(PROFILE_JWT, NOW_MS)).toBeNull();
		const badExp = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: 'soon', iat: IAT_24H, client_id: 'web' },
		);
		expect(readTokenLifetime(badExp, NOW_MS)).toBeNull();
	});

	it('returns null for a non-JWT value', () => {
		expect(readTokenLifetime('not-a-jwt', NOW_MS)).toBeNull();
		expect(readTokenLifetime('', NOW_MS)).toBeNull();
	});

	it('reports a null lifetime when iat is present but not numeric', () => {
		const badIat = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: FUTURE_EXP, iat: 'yesterday', client_id: 'web' },
		);
		const life = readTokenLifetime(badIat, NOW_MS);
		expect(life).not.toBeNull();
		expect(life?.lifetimeHours).toBeNull();
		expect(life?.issuedAtMs).toBeNull();
	});

	it('reads a bearer-prefixed value (the localStorage form)', () => {
		const life = readTokenLifetime(`bearer ${SHORT_TOKEN}`, NOW_MS);
		expect(life?.lifetimeHours).toBe(24);
	});

	it('reads a value with whitespace before the bearer prefix (manually linked secret)', () => {
		// Regression for the trim-before-strip hardening: the API accepts this
		// form (the client trims first), so the helpers must read it too.
		const value = `  bearer ${SHORT_TOKEN}`;
		expect(readTokenLifetime(value, NOW_MS)?.lifetimeHours).toBe(24);
		expect(isUsableUserToken(value, NOW_MS)).toBe(true);
	});

	it('defaults nowMs to the current time when omitted', () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const live = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: nowSec + 86_400, iat: nowSec, client_id: 'web' },
		);
		const life = readTokenLifetime(live);
		expect(life?.remainingMs).toBeGreaterThan(0);
	});

	it('classifies 24h as short and the long-lived token as not short', () => {
		// Pins the threshold ordering the capture-time heads-up depends on.
		const short = readTokenLifetime(SHORT_TOKEN, NOW_MS);
		const long = readTokenLifetime(LONG_LIVED_TOKEN, NOW_MS);
		expect(short?.lifetimeHours ?? Infinity).toBeLessThanOrEqual(
			SHORT_LIFETIME_HOURS,
		);
		expect(long?.lifetimeHours ?? 0).toBeGreaterThan(SHORT_LIFETIME_HOURS);
	});
});

// Date strings from toLocaleDateString vary with the host locale, so these
// assertions match shapes, never exact dates.
describe('describeTokenLifetime', () => {
	it('describes a live short token by hours left and issued hours', () => {
		const desc = describeTokenLifetime(
			readTokenLifetime(SHORT_TOKEN, NOW_MS),
		);
		expect(desc).toMatch(/^About \d+ hours? left \(issued for 24 hours\)$/);
	});

	it('describes a long-lived token by expiry date and issued days', () => {
		const desc = describeTokenLifetime(
			readTokenLifetime(LONG_LIVED_TOKEN, NOW_MS),
		);
		expect(desc).toMatch(/^Expires .+ \(issued for about \d+ days\)$/);
	});

	it('describes an expired token as expired, with an unknown issued life', () => {
		const desc = describeTokenLifetime(
			readTokenLifetime(EXPIRED_TOKEN, NOW_MS),
		);
		expect(desc).toMatch(/^Expired .+ \(issued lifetime unknown\)$/);
	});

	it('reports unknown for an unreadable value', () => {
		expect(describeTokenLifetime(null)).toBe(
			'Expiry unknown (the stored value is not a readable Plaud token)',
		);
	});

	it('uses the singular for a one-hour issued lifetime', () => {
		const iat = 1_779_999_000;
		const oneHour = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: iat + 3_600, iat, client_id: 'web' },
		);
		expect(
			describeTokenLifetime(readTokenLifetime(oneHour, NOW_MS)),
		).toContain('issued for 1 hour)');
	});

	it('treats a nonsense negative lifetime (iat past exp) as unknown', () => {
		const bad = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ exp: FUTURE_EXP, iat: FUTURE_EXP + 999_999, client_id: 'web' },
		);
		expect(describeTokenLifetime(readTokenLifetime(bad, NOW_MS))).toContain(
			'issued lifetime unknown',
		);
	});
});

// Pins the never-leak contract of the session-status block (issue #78): claim
// NAMES and the allowlisted claim values may appear; the token value and the
// identity claim values (sub, wid, email, id, name) must never appear.
describe('formatSessionStatus', () => {
	const base = {
		pluginVersion: '0.33.0',
		apiBaseUrl: 'https://api.plaud.ai',
		signInMethod: 'browser',
	};

	it('reports the measured lifetime and hasWid without leaking identity', () => {
		const out = formatSessionStatus({ ...base, tokenValue: SHORT_TOKEN });
		expect(out).toContain('plugin: 0.33.0');
		expect(out).toContain('signInMethod: browser');
		expect(out).toContain('token.lifetimeHours: 24');
		expect(out).toContain('token.hasWid: false');
		expect(out).toContain('token.region: aws:ap-southeast-1');
		expect(out).not.toContain(SHORT_TOKEN);
		expect(out).not.toContain('user-123');
	});

	it('surfaces a workspace token by typ and hasWid, never the wid value', () => {
		const out = formatSessionStatus({
			...base,
			tokenValue: WORKSPACE_TOKEN,
		});
		expect(out).toContain('token.header.typ: WT');
		expect(out).toContain('token.hasWid: true');
		expect(out).toContain('token.lifetimeHours: (no iat claim)');
		expect(out).not.toContain('ws-1');
		expect(out).not.toContain(WORKSPACE_TOKEN);
		expect(out).not.toContain('user-123');
	});

	it('identifies a mis-linked profile JWT by claim names, never values', () => {
		const out = formatSessionStatus({ ...base, tokenValue: PROFILE_JWT });
		expect(out).toContain('token.claimNames: email, id, name');
		expect(out).toContain('no numeric exp claim');
		expect(out).not.toContain('a@b.com');
		expect(out).not.toContain(PROFILE_JWT);
	});

	it('reports a missing or unreadable token plainly', () => {
		expect(formatSessionStatus({ ...base, tokenValue: '' })).toContain(
			'token: none stored',
		);
		expect(
			formatSessionStatus({ ...base, tokenValue: 'garbage' }),
		).toContain('token: stored, but not a readable Plaud token');
		expect(
			formatSessionStatus({ ...base, signInMethod: '', tokenValue: '' }),
		).toContain('signInMethod: (not recorded)');
	});
});
