import { parseV4RefreshResponse, performV4Refresh } from '../plaud-refresh-v4';
import type { PlaudHttpFetcher, PlaudHttpResponse } from '../plaud-client-re';

// Build a minimal unsigned JWT. The module only reads unverified payload/header
// claims, so an unsigned token with a dummy signature is a faithful fixture.
function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function makeJwt(header: unknown, payload: unknown): string {
	return `${b64url(header)}.${b64url(payload)}.sig`;
}

const WID = 'ws_clF1vOqcHS';
const STORED_WT = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ wid: WID, client_id: 'web', sub: 'x' },
);
const FRESH_WT = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ wid: WID, sub: 'x', exp: 9_999_999_999 },
);
const REFRESH_TOKEN = 'stored-workspace-refresh-token';
const ROTATED_REFRESH_TOKEN = 'rotated-workspace-refresh-token';

function jsonResponse(status: number, body: unknown): PlaudHttpResponse {
	const text = JSON.stringify(body);
	return { status, json: JSON.parse(text) as unknown, text };
}

function recordingFetch(responses: PlaudHttpResponse[]): {
	fetch: PlaudHttpFetcher;
	calls: Array<{
		url: string;
		method: string;
		headers: Readonly<Record<string, string>>;
		body?: string;
	}>;
} {
	const calls: Array<{
		url: string;
		method: string;
		headers: Readonly<Record<string, string>>;
		body?: string;
	}> = [];
	let i = 0;
	const fetch: PlaudHttpFetcher = (req) => {
		calls.push({
			url: req.url,
			method: req.method,
			headers: req.headers,
			body: req.body,
		});
		return Promise.resolve(responses[i++]);
	};
	return { fetch, calls };
}

describe('parseV4RefreshResponse', () => {
	it('extracts the fresh workspace token and the rotated refresh token', () => {
		expect(
			parseV4RefreshResponse({
				status: 0,
				data: {
					workspace_token: FRESH_WT,
					refresh_token: ROTATED_REFRESH_TOKEN,
					wt_expires_at: 123,
				},
			}),
		).toEqual({ token: FRESH_WT, refreshToken: ROTATED_REFRESH_TOKEN });
	});

	it('returns null when the rotated refresh token is missing', () => {
		// A fresh WT with no new refresh token cannot be renewed again (the bearer
		// just spent is single-use), so it is not a usable success.
		expect(
			parseV4RefreshResponse({
				status: 0,
				data: { workspace_token: FRESH_WT },
			}),
		).toBeNull();
	});

	it('returns null on a non-zero status or a missing workspace token', () => {
		expect(
			parseV4RefreshResponse({
				status: -420,
				data: { workspace_token: FRESH_WT, refresh_token: 'x' },
			}),
		).toBeNull();
		expect(
			parseV4RefreshResponse({ status: 0, data: { refresh_token: 'x' } }),
		).toBeNull();
		expect(
			parseV4RefreshResponse({
				status: 0,
				data: { workspace_token: '', refresh_token: 'x' },
			}),
		).toBeNull();
	});
});

describe('performV4Refresh', () => {
	const okBody = {
		status: 0,
		data: {
			workspace_token: FRESH_WT,
			refresh_token: ROTATED_REFRESH_TOKEN,
			wt_expires_at: 999,
		},
	};

	it('bearers the refresh token and returns the fresh WT plus the rotated one', async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, okBody)]);
		const result = await performV4Refresh({
			currentToken: STORED_WT,
			refreshToken: REFRESH_TOKEN,
			baseUrl: 'https://api-test.plaud.ai',
			deviceId: 'dev-123',
			fetch,
		});
		expect(result).toEqual({
			token: FRESH_WT,
			refreshToken: ROTATED_REFRESH_TOKEN,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			`https://api-test.plaud.ai/user-app/auth/workspace/refresh/${WID}`,
		);
		expect(calls[0].method).toBe('POST');
		expect(calls[0].body).toBe('{}');
		expect(calls[0].headers.authorization).toBe(`Bearer ${REFRESH_TOKEN}`);
		expect(calls[0].headers['x-scope-type']).toBe('workspace');
		expect(calls[0].headers['x-scope-id']).toBe(WID);
		expect(calls[0].headers['x-device-id']).toBe('dev-123');
		expect(calls[0].headers['app-platform']).toBe('web');
	});

	it('omits x-device-id when none was captured', async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, okBody)]);
		await performV4Refresh({
			currentToken: STORED_WT,
			refreshToken: REFRESH_TOKEN,
			baseUrl: 'https://api-test.plaud.ai',
			fetch,
		});
		expect(calls[0].headers['x-device-id']).toBeUndefined();
	});

	it('returns null (no call) when the stored token has no ws_ wid', async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await performV4Refresh({
			currentToken: makeJwt({ typ: 'WT' }, { sub: 'x' }),
			refreshToken: REFRESH_TOKEN,
			baseUrl: 'https://api-test.plaud.ai',
			fetch,
		});
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('returns null (no call) when the refresh token is empty', async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await performV4Refresh({
			currentToken: STORED_WT,
			refreshToken: '   ',
			baseUrl: 'https://api-test.plaud.ai',
			fetch,
		});
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('returns null (no call) when the base host is not a trusted Plaud host', async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await performV4Refresh({
			currentToken: STORED_WT,
			refreshToken: REFRESH_TOKEN,
			baseUrl: 'https://evil.com',
			fetch,
		});
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('returns null on a non-2xx response', async () => {
		const { fetch } = recordingFetch([
			{ status: 500, json: null, text: 'oops' },
		]);
		await expect(
			performV4Refresh({
				currentToken: STORED_WT,
				refreshToken: REFRESH_TOKEN,
				baseUrl: 'https://api-test.plaud.ai',
				fetch,
			}),
		).resolves.toBeNull();
	});

	it('returns null on an in-band WRT_EXPIRED (-420)', async () => {
		const { fetch } = recordingFetch([
			jsonResponse(200, {
				status: -420,
				msg: 'workspace refresh token expired',
			}),
		]);
		await expect(
			performV4Refresh({
				currentToken: STORED_WT,
				refreshToken: REFRESH_TOKEN,
				baseUrl: 'https://api-test.plaud.ai',
				fetch,
			}),
		).resolves.toBeNull();
	});

	it('returns null when the body is not JSON', async () => {
		const { fetch } = recordingFetch([
			{ status: 200, json: null, text: 'not json' },
		]);
		await expect(
			performV4Refresh({
				currentToken: STORED_WT,
				refreshToken: REFRESH_TOKEN,
				baseUrl: 'https://api-test.plaud.ai',
				fetch,
			}),
		).resolves.toBeNull();
	});

	it('returns null (never throws) when the transport throws', async () => {
		const fetch: PlaudHttpFetcher = () =>
			Promise.reject(new Error('network down'));
		await expect(
			performV4Refresh({
				currentToken: STORED_WT,
				refreshToken: REFRESH_TOKEN,
				baseUrl: 'https://api-test.plaud.ai',
				fetch,
			}),
		).resolves.toBeNull();
	});

	it('never throws when the injected log sink throws', async () => {
		const fetch: PlaudHttpFetcher = () => Promise.reject(new Error('down'));
		await expect(
			performV4Refresh({
				currentToken: STORED_WT,
				refreshToken: REFRESH_TOKEN,
				baseUrl: 'https://api-test.plaud.ai',
				fetch,
				log: () => {
					throw new Error('logger boom');
				},
			}),
		).resolves.toBeNull();
	});

	it('redacts a JWT-shaped string from a logged failure body', async () => {
		const jwt = 'aaaaaaaa.bbbbbbbb.cccccccc';
		const { fetch } = recordingFetch([
			{ status: 500, json: null, text: `oops ${jwt} boom` },
		]);
		const logged: Array<{ body?: string }> = [];
		const result = await performV4Refresh({
			currentToken: STORED_WT,
			refreshToken: REFRESH_TOKEN,
			baseUrl: 'https://api-test.plaud.ai',
			fetch,
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
});
