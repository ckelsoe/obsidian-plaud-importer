import {
	extractWorkspaceId,
	normalizeTrustedOrigin,
	parseWorkspaceTokenResponse,
	performNetRefresh,
	readRegionRedirect,
	type SessionPost,
} from '../plaud-refresh-net';

// Build a minimal unsigned JWT with the given payload claims. The helpers only
// read unverified payload claims, so an unsigned token with a dummy signature is
// a faithful fixture.
function makeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown): string =>
		Buffer.from(JSON.stringify(obj))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${b64url({ alg: 'HS256', typ: 'WT' })}.${b64url(payload)}.sig`;
}

const WID = 'ws_clF1vOqcHS';
const STORED_WT = makeJwt({ wid: WID, client_id: 'web', sub: 'x' });
const FRESH_WT = makeJwt({ wid: WID, sub: 'x', exp: 9_999_999_999 });

describe('extractWorkspaceId', () => {
	it('returns the wid claim when it looks like a workspace id', () => {
		expect(extractWorkspaceId(STORED_WT)).toBe(WID);
	});
	it('returns null when wid is missing or not a ws_ id', () => {
		expect(extractWorkspaceId(makeJwt({ sub: 'x' }))).toBeNull();
		expect(extractWorkspaceId(makeJwt({ wid: 'mem_x' }))).toBeNull();
		expect(extractWorkspaceId('not-a-token')).toBeNull();
	});
});

describe('normalizeTrustedOrigin', () => {
	it('returns the origin (no path) for a trusted plaud https host', () => {
		expect(normalizeTrustedOrigin('https://api.plaud.ai/x?y=1')).toBe(
			'https://api.plaud.ai',
		);
		expect(normalizeTrustedOrigin('https://api-euc1.plaud.ai')).toBe(
			'https://api-euc1.plaud.ai',
		);
	});
	it('rejects non-https, non-plaud, or malformed urls', () => {
		expect(normalizeTrustedOrigin('http://api.plaud.ai')).toBeNull();
		expect(normalizeTrustedOrigin('https://evil.com')).toBeNull();
		expect(normalizeTrustedOrigin('https://plaud.ai.evil.com')).toBeNull();
		expect(normalizeTrustedOrigin('not a url')).toBeNull();
	});
});

describe('readRegionRedirect', () => {
	it('returns the origin for a -302 pointing at a trusted plaud host', () => {
		expect(
			readRegionRedirect({
				status: -302,
				data: { domains: { api: 'https://api-euc1.plaud.ai/x?y=1' } },
			}),
		).toBe('https://api-euc1.plaud.ai');
	});
	it('returns null for non-redirect status, non-plaud host, or non-https', () => {
		expect(readRegionRedirect({ status: 0 })).toBeNull();
		expect(
			readRegionRedirect({
				status: -302,
				data: { domains: { api: 'https://evil.com' } },
			}),
		).toBeNull();
		expect(
			readRegionRedirect({
				status: -302,
				data: { domains: { api: 'http://api.plaud.ai' } },
			}),
		).toBeNull();
		expect(
			readRegionRedirect({ status: -302, data: { domains: {} } }),
		).toBeNull();
	});
});

describe('parseWorkspaceTokenResponse', () => {
	it('extracts the workspace token and rotated refresh token', () => {
		expect(
			parseWorkspaceTokenResponse({
				status: 0,
				data: {
					workspace_token: 'eyJ.wt.sig',
					refresh_token: 'urt-value',
				},
			}),
		).toEqual({ token: 'eyJ.wt.sig', refreshToken: 'urt-value' });
	});
	it('treats an absent refresh token as null', () => {
		expect(
			parseWorkspaceTokenResponse({
				status: 0,
				data: { workspace_token: 'eyJ.wt.sig' },
			}),
		).toEqual({ token: 'eyJ.wt.sig', refreshToken: null });
	});
	it('returns null on non-success status or a missing token', () => {
		expect(
			parseWorkspaceTokenResponse({
				status: -1,
				data: { workspace_token: 'eyJ.wt.sig' },
			}),
		).toBeNull();
		expect(parseWorkspaceTokenResponse({ status: 0, data: {} })).toBeNull();
		expect(
			parseWorkspaceTokenResponse({
				status: 0,
				data: { workspace_token: '' },
			}),
		).toBeNull();
	});
});

describe('performNetRefresh', () => {
	const okRefresh = JSON.stringify({ status: 0, data: {} });
	const okMint = JSON.stringify({
		status: 0,
		data: { workspace_token: FRESH_WT, refresh_token: 'new-urt' },
	});

	function recordingPost(
		responses: Array<{ status: number; text: string }>,
	): { post: SessionPost; calls: Array<{ url: string; body: string }> } {
		const calls: Array<{ url: string; body: string }> = [];
		let i = 0;
		const post: SessionPost = (url, body) => {
			calls.push({ url, body });
			return Promise.resolve(responses[i++]);
		};
		return { post, calls };
	}

	it('runs refresh then mint and returns the fresh WT', async () => {
		const { post, calls } = recordingPost([
			{ status: 200, text: okRefresh },
			{ status: 200, text: okMint },
		]);
		const result = await performNetRefresh({
			currentToken: STORED_WT,
			baseUrl: 'https://api.plaud.ai',
			post,
		});
		expect(result).toEqual({
			token: FRESH_WT,
			refreshToken: 'new-urt',
			apiBaseUrl: null,
		});
		expect(calls[0]).toEqual({
			url: 'https://api.plaud.ai/auth/refresh-user-token',
			body: '{}',
		});
		expect(calls[1]).toEqual({
			url: `https://api.plaud.ai/user-app/auth/workspace/token/${WID}`,
			body: '{}',
		});
	});

	it('follows a region redirect once and mints against the new host', async () => {
		const redirect = JSON.stringify({
			status: -302,
			data: { domains: { api: 'https://api-euc1.plaud.ai' } },
		});
		const { post, calls } = recordingPost([
			{ status: 200, text: redirect },
			{ status: 200, text: okRefresh },
			{ status: 200, text: okMint },
		]);
		const result = await performNetRefresh({
			currentToken: STORED_WT,
			baseUrl: 'https://api.plaud.ai',
			post,
		});
		expect(result?.apiBaseUrl).toBe('https://api-euc1.plaud.ai');
		expect(calls[2].url).toBe(
			`https://api-euc1.plaud.ai/user-app/auth/workspace/token/${WID}`,
		);
	});

	it('returns null (no call) when the stored token has no wid', async () => {
		const { post, calls } = recordingPost([]);
		const result = await performNetRefresh({
			currentToken: makeJwt({ sub: 'x' }),
			baseUrl: 'https://api.plaud.ai',
			post,
		});
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('returns null (no call) when the stored base host is not a trusted plaud host', async () => {
		const { post, calls } = recordingPost([]);
		const result = await performNetRefresh({
			currentToken: STORED_WT,
			baseUrl: 'https://evil.com',
			post,
		});
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('returns null when refresh is not JSON, fails, or the mint fails', async () => {
		const bad = {
			currentToken: STORED_WT,
			baseUrl: 'https://api.plaud.ai',
		};
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([{ status: 200, text: 'nope' }]).post,
			}),
		).resolves.toBeNull();
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([
					{ status: 200, text: JSON.stringify({ status: -1 }) },
				]).post,
			}),
		).resolves.toBeNull();
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([
					{ status: 200, text: okRefresh },
					{ status: 200, text: JSON.stringify({ status: -1 }) },
				]).post,
			}),
		).resolves.toBeNull();
	});

	it('returns null (never throws) when the transport throws', async () => {
		const post: SessionPost = () =>
			Promise.reject(new Error('network down'));
		await expect(
			performNetRefresh({
				currentToken: STORED_WT,
				baseUrl: 'https://api.plaud.ai',
				post,
			}),
		).resolves.toBeNull();
	});

	it('redacts a JWT-shaped string from a logged error body', async () => {
		const jwt = 'aaaaaaaa.bbbbbbbb.cccccccc';
		const { post } = recordingPost([
			{ status: 200, text: `oops ${jwt} boom` },
		]);
		const logged: Array<{ body?: string }> = [];
		const result = await performNetRefresh({
			currentToken: STORED_WT,
			baseUrl: 'https://api.plaud.ai',
			post,
			log: (_message, payload) =>
				logged.push(payload as { body?: string }),
		});
		expect(result).toBeNull();
		const bodies = logged
			.map((p) => p?.body)
			.filter((b): b is string => typeof b === 'string')
			.join(' ');
		expect(bodies).toContain('[redacted-token]');
		expect(bodies).not.toContain(jwt);
	});

	it('never throws when the injected log sink throws', async () => {
		const post: SessionPost = () => Promise.reject(new Error('down'));
		await expect(
			performNetRefresh({
				currentToken: STORED_WT,
				baseUrl: 'https://api.plaud.ai',
				post,
				log: () => {
					throw new Error('logger boom');
				},
			}),
		).resolves.toBeNull();
	});
});
