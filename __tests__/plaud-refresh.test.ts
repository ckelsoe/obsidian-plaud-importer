import {
	decodeJwtExpMs,
	isFreshAccessToken,
	jwtTyp,
	parseRefreshResponse,
	refreshPlaudSession,
	type RefreshTransport,
} from '../plaud-refresh';

// Build a minimal unsigned JWT with the given header `typ` and payload `exp`
// (seconds). The refresh module only reads unverified claims (typ, exp), so an
// unsigned token with a dummy signature segment is a faithful fixture.
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
const FRESH_WRT = makeJwt('WRT', FUTURE_EXP_S);

describe('jwtTyp / decodeJwtExpMs', () => {
	it('reads the header typ', () => {
		expect(jwtTyp(FRESH_WT)).toBe('WT');
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
	it('rejects a WRT (wrong typ) even if unexpired', () => {
		expect(isFreshAccessToken(FRESH_WRT, NOW)).toBe(false);
	});
});

describe('parseRefreshResponse', () => {
	it('returns success with tokens for status 0 and a fresh WT', () => {
		const parsed = parseRefreshResponse(
			{ status: 0, access_token: FRESH_WT, refresh_token: FRESH_WRT },
			NOW,
		);
		expect(parsed).toEqual({
			kind: 'success',
			accessToken: FRESH_WT,
			refreshToken: FRESH_WRT,
		});
	});

	it('treats a missing refresh_token as null (not a failure)', () => {
		const parsed = parseRefreshResponse({ status: 0, access_token: FRESH_WT }, NOW);
		expect(parsed).toEqual({ kind: 'success', accessToken: FRESH_WT, refreshToken: null });
	});

	it('fails (fail-safe) when status 0 returns an expired WT', () => {
		const parsed = parseRefreshResponse({ status: 0, access_token: EXPIRED_WT }, NOW);
		expect(parsed.kind).toBe('failure');
	});

	it('fails when status 0 returns a non-WT token', () => {
		const parsed = parseRefreshResponse({ status: 0, access_token: FRESH_WRT }, NOW);
		expect(parsed.kind).toBe('failure');
	});

	it('fails when access_token is missing', () => {
		expect(parseRefreshResponse({ status: 0 }, NOW).kind).toBe('failure');
	});

	it('fails on a non-zero status with a message', () => {
		const parsed = parseRefreshResponse({ status: -1, msg: 'token invalid or expired' }, NOW);
		expect(parsed.kind).toBe('failure');
	});

	it('detects a region switch to a trusted plaud host', () => {
		const parsed = parseRefreshResponse(
			{ status: 100, data: { domains: { api: 'https://api-euc1.plaud.ai' } } },
			NOW,
		);
		expect(parsed).toEqual({ kind: 'switch', apiBaseUrl: 'https://api-euc1.plaud.ai' });
	});

	it('does not treat an untrusted host as a switch', () => {
		const parsed = parseRefreshResponse(
			{ status: 100, data: { domains: { api: 'https://evil.example' } } },
			NOW,
		);
		expect(parsed.kind).toBe('failure');
	});

	it('rejects an embedded-credential host', () => {
		const parsed = parseRefreshResponse(
			{ status: 100, data: { domains: { api: 'https://api.plaud.ai@evil.example' } } },
			NOW,
		);
		expect(parsed.kind).toBe('failure');
	});

	it('fails on a non-object body', () => {
		expect(parseRefreshResponse(null, NOW).kind).toBe('failure');
		expect(parseRefreshResponse('nope', NOW).kind).toBe('failure');
	});
});

// A transport double recording the requests it received.
function transport(
	responses: Array<{ status: number; json: unknown; text?: string }>,
	cookieHeader: string | null = 'urt=cookievalue',
): RefreshTransport & { calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
	const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
	let i = 0;
	return {
		calls,
		post: async (req) => {
			calls.push({ url: req.url, headers: { ...req.headers }, body: req.body });
			const r = responses[Math.min(i, responses.length - 1)];
			i += 1;
			return { status: r.status, json: r.json, text: r.text ?? '' };
		},
		readCookieHeader: async () => cookieHeader,
	};
}

describe('refreshPlaudSession', () => {
	const base = { apiBaseUrl: 'https://api.plaud.ai', now: () => NOW };

	it('posts empty body to the refresh endpoint with cookie and bearer', async () => {
		const t = transport([
			{ status: 200, json: { status: 0, access_token: FRESH_WT, refresh_token: FRESH_WRT } },
		]);
		const result = await refreshPlaudSession({ ...base, refreshToken: FRESH_WRT, transport: t });
		expect(result).toEqual({
			ok: true,
			accessToken: FRESH_WT,
			refreshToken: FRESH_WRT,
			apiBaseUrl: 'https://api.plaud.ai',
		});
		expect(t.calls[0].url).toBe('https://api.plaud.ai/auth/refresh-user-token');
		expect(t.calls[0].body).toBe('{}');
		expect(t.calls[0].headers.Cookie).toBe('urt=cookievalue');
		expect(t.calls[0].headers.Authorization).toBe(`Bearer ${FRESH_WRT}`);
	});

	it('omits the Authorization header when no refresh token is stored', async () => {
		const t = transport([{ status: 200, json: { status: 0, access_token: FRESH_WT } }]);
		const result = await refreshPlaudSession({ ...base, refreshToken: null, transport: t });
		expect(result.ok).toBe(true);
		expect(t.calls[0].headers.Authorization).toBeUndefined();
	});

	it('strips a bearer prefix from the stored refresh token', async () => {
		const t = transport([{ status: 200, json: { status: 0, access_token: FRESH_WT } }]);
		await refreshPlaudSession({ ...base, refreshToken: `bearer ${FRESH_WRT}`, transport: t });
		expect(t.calls[0].headers.Authorization).toBe(`Bearer ${FRESH_WRT}`);
	});

	it('follows a single region switch and retries against the new host', async () => {
		const t = transport([
			{ status: 200, json: { status: 100, data: { domains: { api: 'https://api-euc1.plaud.ai' } } } },
			{ status: 200, json: { status: 0, access_token: FRESH_WT } },
		]);
		const result = await refreshPlaudSession({ ...base, refreshToken: FRESH_WRT, transport: t });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.apiBaseUrl).toBe('https://api-euc1.plaud.ai');
		}
		expect(t.calls).toHaveLength(2);
		expect(t.calls[1].url).toBe('https://api-euc1.plaud.ai/auth/refresh-user-token');
	});

	it('does not loop on a second region switch', async () => {
		const t = transport([
			{ status: 200, json: { status: 100, data: { domains: { api: 'https://api-euc1.plaud.ai' } } } },
			{ status: 200, json: { status: 100, data: { domains: { api: 'https://api-usw2.plaud.ai' } } } },
		]);
		const result = await refreshPlaudSession({ ...base, refreshToken: null, transport: t });
		expect(result.ok).toBe(false);
		expect(t.calls).toHaveLength(2);
	});

	it('fails on a 401 without switching or throwing', async () => {
		const t = transport([{ status: 401, json: { status: -1, msg: 'unauthorized' } }]);
		const result = await refreshPlaudSession({ ...base, refreshToken: FRESH_WRT, transport: t });
		expect(result.ok).toBe(false);
	});

	it('maps a transport rejection to a failure, never throwing', async () => {
		const t: RefreshTransport = {
			post: async () => {
				throw new Error('offline');
			},
			readCookieHeader: async () => null,
		};
		const result = await refreshPlaudSession({ ...base, refreshToken: null, transport: t });
		expect(result).toEqual({ ok: false, reason: 'transport error: offline' });
	});

	it('sends no Cookie header when the partition has no cookies', async () => {
		const t = transport(
			[{ status: 200, json: { status: 0, access_token: FRESH_WT } }],
			null,
		);
		await refreshPlaudSession({ ...base, refreshToken: FRESH_WRT, transport: t });
		expect(t.calls[0].headers.Cookie).toBeUndefined();
	});
});
