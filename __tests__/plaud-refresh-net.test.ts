import {
	buildPartitionPost,
	extractWorkspaceId,
	normalizeTrustedOrigin,
	parseWorkspaceTokenResponse,
	performNetRefresh,
	readRegionRedirect,
	type SessionPost,
} from '../plaud-refresh-net';
import { at } from './helpers/checked';
import { isRefreshFailure } from '../refresh-failure';

/** The successful result, or a test failure naming the refresh failure. */
function success<T>(result: T): Exclude<T, { failed: unknown }> {
	if (isRefreshFailure(result)) {
		throw new Error(
			`expected a refreshed token, got ${JSON.stringify(result)}`,
		);
	}
	return result as Exclude<T, { failed: unknown }>;
}

// Build a minimal unsigned JWT with the given payload claims. The helpers only
// read unverified payload claims, so an unsigned token with a dummy signature is
// a faithful fixture.
function makeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown): string =>
		Buffer.from(JSON.stringify(obj)).toString('base64url');
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
			return Promise.resolve(at(responses, i++));
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
		expect(success(result).apiBaseUrl).toBe('https://api-euc1.plaud.ai');
		expect(at(calls, 2).url).toBe(
			`https://api-euc1.plaud.ai/user-app/auth/workspace/token/${WID}`,
		);
	});

	it('is denied (no call) when the stored token has no wid', async () => {
		const { post, calls } = recordingPost([]);
		const result = await performNetRefresh({
			currentToken: makeJwt({ sub: 'x' }),
			baseUrl: 'https://api.plaud.ai',
			post,
		});
		expect(result).toEqual({ failed: 'denied', reason: 'session-ended' });
		expect(calls).toHaveLength(0);
	});

	it('is denied (no call) when the stored base host is not a trusted plaud host', async () => {
		const { post, calls } = recordingPost([]);
		const result = await performNetRefresh({
			currentToken: STORED_WT,
			baseUrl: 'https://evil.com',
			post,
		});
		expect(result).toEqual({ failed: 'denied', reason: 'session-ended' });
		expect(calls).toHaveLength(0);
	});

	it('is unreachable when refresh is not JSON or either step returns an unrecognized status', async () => {
		const bad = {
			currentToken: STORED_WT,
			baseUrl: 'https://api.plaud.ai',
		};
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([{ status: 200, text: 'nope' }]).post,
			}),
		).resolves.toMatchObject({ failed: 'unreachable' });
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([
					{ status: 200, text: JSON.stringify({ status: -1 }) },
				]).post,
			}),
		).resolves.toMatchObject({ failed: 'unreachable' });
		await expect(
			performNetRefresh({
				...bad,
				post: recordingPost([
					{ status: 200, text: okRefresh },
					{ status: 200, text: JSON.stringify({ status: -1 }) },
				]).post,
			}),
		).resolves.toMatchObject({ failed: 'unreachable' });
	});

	it('is unreachable (never throws) when the transport throws', async () => {
		const post: SessionPost = () =>
			Promise.reject(new Error('network down'));
		await expect(
			performNetRefresh({
				currentToken: STORED_WT,
				baseUrl: 'https://api.plaud.ai',
				post,
			}),
		).resolves.toMatchObject({ failed: 'unreachable' });
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
		expect(isRefreshFailure(result)).toBe(true);
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
		).resolves.toMatchObject({ failed: 'unreachable' });
	});
});

// --- Electron adapter: where the timeout signal is made (issue #148) --------
//
// session.fetch runs in the MAIN process and checks `instanceof AbortSignal`
// against the main process's class. A signal made in the renderer crosses the
// remote bridge as a proxy and fails that check, so every refresh threw before
// sending anything. These pin that the signal comes from the main process's
// AbortSignal.timeout, fresh per request, and that the adapter reports
// unavailable rather than send an unbounded request when it cannot make one.

interface AdapterFetchCall {
	url: string;
	signal: unknown;
}

interface FakeRemoteOptions {
	/** Replaces remote.getGlobal; `null` removes it. */
	getGlobal?: ((name: string) => unknown) | null;
}

function installFakeRemote(options: FakeRemoteOptions = {}): {
	fetches: AdapterFetchCall[];
	timeouts: number[];
} {
	const fetches: AdapterFetchCall[] = [];
	const timeouts: number[] = [];
	const mainAbortSignal = {
		timeout: (ms: number) => {
			timeouts.push(ms);
			return { mainSignal: timeouts.length };
		},
	};
	const remote: Record<string, unknown> = {
		session: {
			fromPartition: () => ({
				fetch: (url: string, init: { signal?: unknown }) => {
					fetches.push({ url, signal: init.signal });
					return Promise.resolve({
						status: 200,
						text: () => Promise.resolve('{"status":0}'),
					});
				},
			}),
		},
	};
	if (options.getGlobal !== null) {
		remote.getGlobal =
			options.getGlobal ??
			((name: string) =>
				name === 'AbortSignal' ? mainAbortSignal : undefined);
	}
	const win = window as unknown as { require: (id: string) => unknown };
	win.require = () => ({ remote });
	return { fetches, timeouts };
}

describe('buildPartitionPost timeout signal (issue #148)', () => {
	afterEach(() => {
		delete (window as unknown as { require?: unknown }).require;
	});

	it('passes a main-process signal, never a renderer AbortSignal', async () => {
		const { fetches, timeouts } = installFakeRemote();
		const post = buildPartitionPost('persist:plaud-test');
		expect(post).not.toBeNull();
		await post?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {});
		expect(timeouts).toEqual([30_000]);
		const signal = at(fetches, 0).signal;
		expect(signal).toEqual({ mainSignal: 1 });
		expect(signal).not.toBeInstanceOf(AbortSignal);
	});

	it('makes a fresh signal for every request', async () => {
		const { fetches } = installFakeRemote();
		const post = buildPartitionPost('persist:plaud-test');
		await post?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {});
		await post?.(
			'https://api.plaud.ai/user-app/auth/workspace/token/ws_x',
			'{}',
			{},
		);
		expect(fetches.map((f) => f.signal)).toEqual([
			{ mainSignal: 1 },
			{ mainSignal: 2 },
		]);
	});

	it('reports unavailable when the remote has no getGlobal', () => {
		installFakeRemote({ getGlobal: null });
		expect(buildPartitionPost('persist:plaud-test')).toBeNull();
	});

	it('reports unavailable when the main AbortSignal has no timeout', () => {
		installFakeRemote({ getGlobal: () => ({}) });
		expect(buildPartitionPost('persist:plaud-test')).toBeNull();
	});

	it('reports unavailable when getGlobal returns nothing', () => {
		installFakeRemote({ getGlobal: () => undefined });
		expect(buildPartitionPost('persist:plaud-test')).toBeNull();
	});

	it('reports unavailable, without throwing, when getGlobal throws', () => {
		installFakeRemote({
			getGlobal: () => {
				throw new Error('remote gone');
			},
		});
		expect(buildPartitionPost('persist:plaud-test')).toBeNull();
	});
});

// --- Classification and the step 1 conflict retry ---------------------------

describe('performNetRefresh failure classification', () => {
	const okRefreshBody = JSON.stringify({ status: 0, data: {} });
	const okMintBody = JSON.stringify({
		status: 0,
		data: { workspace_token: FRESH_WT, refresh_token: 'new-urt' },
	});

	function scriptedPost(responses: Array<{ status: number; text: string }>): {
		post: SessionPost;
		urls: string[];
	} {
		const urls: string[] = [];
		let i = 0;
		const post: SessionPost = (url) => {
			urls.push(url);
			return Promise.resolve(at(responses, i++));
		};
		return { post, urls };
	}

	const base = { currentToken: STORED_WT, baseUrl: 'https://api.plaud.ai' };

	it('retries step 1 on -4302 and then succeeds, as Plaud does', async () => {
		const sleeps: number[] = [];
		const { post, urls } = scriptedPost([
			{ status: 200, text: JSON.stringify({ status: -4302 }) },
			{ status: 409, text: '' },
			{ status: 200, text: okRefreshBody },
			{ status: 200, text: okMintBody },
		]);
		const result = await performNetRefresh({
			...base,
			post,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		expect(success(result).token).toBe(FRESH_WT);
		expect(sleeps).toEqual([1000, 1000]);
		expect(urls).toHaveLength(4);
	});

	it('gives up after three conflict retries as transient', async () => {
		const conflict = {
			status: 200,
			text: JSON.stringify({ status: -4302 }),
		};
		const { post, urls } = scriptedPost([
			conflict,
			conflict,
			conflict,
			conflict,
		]);
		const result = await performNetRefresh({
			...base,
			post,
			sleep: () => Promise.resolve(),
		});
		expect(result).toMatchObject({ failed: 'unreachable' });
		expect(urls).toHaveLength(4);
	});

	it('does not retry a refused session', async () => {
		const { post, urls } = scriptedPost([
			{ status: 200, text: JSON.stringify({ status: -401 }) },
		]);
		const result = await performNetRefresh({
			...base,
			post,
			sleep: () => Promise.resolve(),
		});
		expect(result).toEqual({
			failed: 'denied',
			reason: 'session-ended',
			status: -401,
		});
		expect(urls).toHaveLength(1);
	});

	it('reads HTTP 410 on the mint as user not found', async () => {
		const { post } = scriptedPost([
			{ status: 200, text: okRefreshBody },
			{ status: 410, text: '' },
		]);
		await expect(performNetRefresh({ ...base, post })).resolves.toEqual({
			failed: 'denied',
			reason: 'user-not-found',
			status: 410,
		});
	});

	it('reads SSO_REQUIRED on the mint as company SSO', async () => {
		const { post } = scriptedPost([
			{ status: 200, text: okRefreshBody },
			{
				status: 200,
				text: JSON.stringify({
					status: -1,
					data: {
						error_code: 'SSO_REQUIRED',
						workos_organization_id: 'org_1',
					},
				}),
			},
		]);
		await expect(
			performNetRefresh({ ...base, post }),
		).resolves.toMatchObject({
			failed: 'denied',
			reason: 'sso-required',
		});
	});

	it('treats a 401 or 403 with a JSON body as refused on either step', async () => {
		const unauthorized = JSON.stringify({ message: 'Unauthorized' });
		await expect(
			performNetRefresh({
				...base,
				post: scriptedPost([{ status: 401, text: unauthorized }]).post,
			}),
		).resolves.toMatchObject({ failed: 'denied', reason: 'session-ended' });
		await expect(
			performNetRefresh({
				...base,
				post: scriptedPost([
					{ status: 200, text: okRefreshBody },
					{ status: 403, text: unauthorized },
				]).post,
			}),
		).resolves.toMatchObject({ failed: 'denied', reason: 'session-ended' });
	});

	it('treats -4302 on a 401 as a refusal, not a conflict', async () => {
		const { post, urls } = scriptedPost([
			{ status: 401, text: JSON.stringify({ status: -4302 }) },
		]);
		await expect(
			performNetRefresh({
				...base,
				post,
				sleep: () => Promise.resolve(),
			}),
		).resolves.toMatchObject({ failed: 'denied', reason: 'session-ended' });
		expect(urls).toHaveLength(1);
	});

	it('reads an SSO demand ahead of a 409', async () => {
		const { post, urls } = scriptedPost([
			{
				status: 409,
				text: JSON.stringify({
					status: -1,
					data: {
						error_code: 'SSO_REQUIRED',
						workos_organization_id: 'org_1',
					},
				}),
			},
		]);
		await expect(
			performNetRefresh({
				...base,
				post,
				sleep: () => Promise.resolve(),
			}),
		).resolves.toMatchObject({ failed: 'denied', reason: 'sso-required' });
		expect(urls).toHaveLength(1);
	});

	it('stops before the mint when the caller no longer owns the refresh', async () => {
		const { post, urls } = scriptedPost([
			{ status: 200, text: okRefreshBody },
			{ status: 200, text: okMintBody },
		]);
		const result = await performNetRefresh({
			...base,
			post,
			mayContinue: () => false,
		});
		expect(result).toMatchObject({ failed: 'unreachable' });
		expect(urls).toHaveLength(1);
	});

	it('treats a 5xx with no JSON as transient and a 401 as refused', async () => {
		await expect(
			performNetRefresh({
				...base,
				post: scriptedPost([{ status: 503, text: 'busy' }]).post,
			}),
		).resolves.toMatchObject({ failed: 'unreachable' });
		await expect(
			performNetRefresh({
				...base,
				post: scriptedPost([{ status: 401, text: 'no' }]).post,
			}),
		).resolves.toMatchObject({ failed: 'denied', reason: 'session-ended' });
	});
});
