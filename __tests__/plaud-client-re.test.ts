import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
	ReverseEngineeredPlaudClient,
	findAiKeywords,
	findAttachmentAssets,
	findConsumerNoteEntries,
	findNewerSummaryMarkdown,
	findOutlineLink,
	findTransactionPolishLink,
	parseAudioTempUrl,
	parseOutlineBody,
	type PlaudHttpFetcher,
	type PlaudHttpRequest,
	type PlaudHttpResponse,
} from '../plaud-client-re';
import {
	BufferedDebugLogger,
	type DebugEvent,
} from '../debug-logger';

// Helpers -------------------------------------------------------------------

function ok(json: unknown): PlaudHttpResponse {
	return { status: 200, json, text: JSON.stringify(json) };
}

function status(code: number): PlaudHttpResponse {
	return { status: code, json: null, text: '' };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'abc123',
		filename: 'Morning standup',
		fullname: 'REC_20260414_0900.wav',
		filesize: 1024,
		file_md5: 'deadbeef',
		// Plaud's /file/simple/web returns start_time as unix MILLISECONDS
		// and duration as a millisecond delta. Both confirmed from
		// real-API capture on 2026-04-14 — e.g., a 21-minute recording
		// came back with `duration: 1303000` (1303000 ms = 1303 s).
		start_time: 1744628400000, // 2025-04-14 11:00 UTC (unix ms)
		end_time: 1744629000000,
		duration: 600000, // 600000 ms = 600 s = 10 minutes
		version: 1,
		version_ms: 1744628400000,
		edit_time: 1744628400,
		is_trash: false,
		is_trans: true,
		is_summary: true,
		serial_number: '8810B30227298497',
		...overrides,
	};
}

function listEnvelope(items: unknown[]): Record<string, unknown> {
	return {
		status: 0,
		msg: 'success',
		request_id: 'req-xyz',
		data_file_total: items.length,
		data_file_list: items,
	};
}

function captureFetcher(response: PlaudHttpResponse): {
	fetcher: PlaudHttpFetcher;
	lastRequest: () => PlaudHttpRequest | undefined;
	firstRequest: () => PlaudHttpRequest | undefined;
	allRequests: () => readonly PlaudHttpRequest[];
} {
	const captured: PlaudHttpRequest[] = [];
	const fetcher: PlaudHttpFetcher = async (req) => {
		captured.push(req);
		return response;
	};
	return {
		fetcher,
		lastRequest: () => captured[captured.length - 1],
		firstRequest: () => captured[0],
		allRequests: () => captured,
	};
}

// Token provider semantics -------------------------------------------------
//
// The client takes a PlaudTokenProvider function that it calls on every API
// request. That means: (a) settings changes take effect without reconstructing
// the client; (b) "not configured yet" is just a provider that returns null —
// no special construction path; (c) token validation happens at call time,
// never at construction time.

describe('token provider semantics', () => {
	it('does not validate the token at construction time', () => {
		const fetcher: PlaudHttpFetcher = async () => ok(listEnvelope([]));
		// None of these should throw — construction is always legal. The
		// provider is only called when an API call is made.
		expect(() => new ReverseEngineeredPlaudClient(() => null, fetcher)).not.toThrow();
		expect(() => new ReverseEngineeredPlaudClient(() => '', fetcher)).not.toThrow();
		expect(() => new ReverseEngineeredPlaudClient(() => '   ', fetcher)).not.toThrow();
	});

	it('throws PlaudAuthError with a "token configured" message when provider returns null', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => null, fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
		await expect(client.listRecordings()).rejects.toThrow(/no plaud token configured/i);
	});

	it('throws PlaudAuthError when provider returns an empty string', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => '', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
	});

	it('throws PlaudAuthError when provider returns whitespace-only', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => '   ', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
	});

	it('trims surrounding whitespace before sending the Authorization header', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => '  my-jwt  ', fetcher);

		await client.listRecordings();

		expect(lastRequest()?.headers.Authorization).toBe('Bearer my-jwt');
	});

	it('calls the provider on every request (settings changes take effect immediately)', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		let currentToken: string | null = 'first-token';
		const client = new ReverseEngineeredPlaudClient(() => currentToken, fetcher);

		await client.listRecordings();
		// Simulate the user updating their token in settings.
		currentToken = 'second-token';
		await client.listRecordings();
		// And revoking it entirely.
		currentToken = null;
		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
	});
});

// listRecordings — happy path -----------------------------------------------

describe('listRecordings happy path', () => {
	it('returns a normalized Recording for each raw item', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record()])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();

		expect(result).toHaveLength(1);
		const r = result[0];
		expect(r.id).toBe('abc123');
		expect(r.title).toBe('Morning standup');
		expect(r.durationSeconds).toBe(600);
		expect(r.transcriptAvailable).toBe(true);
		expect(r.summaryAvailable).toBe(true);
		// start_time is milliseconds on the wire; createdAt is a Date
		// constructed directly from the ms value.
		expect(r.createdAt.getTime()).toBe(1744628400000);
	});

	it('returns an empty array when the list is empty', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();

		expect(result).toEqual([]);
	});

	it('maps optional tags from filetag_id_list', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ filetag_id_list: ['tag-a', 'tag-b'] })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.tags).toEqual(['tag-a', 'tag-b']);
	});

	it('leaves tags undefined when filetag_id_list is missing', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record()])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.tags).toBeUndefined();
	});

	it('maps is_trash to isTrashed', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ is_trash: true })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.isTrashed).toBe(true);
	});

	it('defaults isTrashed to false when is_trash is absent', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ is_trash: undefined })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.isTrashed).toBe(false);
	});
});

// listRecordings — request shape --------------------------------------------

describe('listRecordings request shape', () => {
	it('targets /file/simple/web on api.plaud.ai by default', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings();

		const req = lastRequest();
		expect(req?.url).toMatch(/^https:\/\/api\.plaud\.ai\/file\/simple\/web\?/);
	});

	it('respects a custom baseUrl for region overrides', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			baseUrl: 'https://api-euc1.plaud.ai',
		});

		await client.listRecordings();

		expect(lastRequest()?.url).toMatch(/^https:\/\/api-euc1\.plaud\.ai\//);
	});

	it('sends Authorization: Bearer and standard headers', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'my-jwt', fetcher);

		await client.listRecordings();

		const headers = lastRequest()?.headers ?? {};
		expect(headers.Authorization).toBe('Bearer my-jwt');
		expect(headers.Accept).toBe('application/json');
		expect(headers['User-Agent']).toMatch(/obsidian-plaud-importer/);
	});

	// Regression for the 2026-06-18 `status: -3901 "token type does not match
	// parse mode"` breakage. Plaud's data API rejects a token when the
	// `app-platform` header disagrees with the token's `client_id` claim, so
	// the client derives the header from the token. Verified against a live
	// web.plaud.ai token (client_id 'web').
	const jwt = (payload: Record<string, unknown>): string => {
		const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
		return `${enc({ alg: 'HS256', typ: 'WT' })}.${enc(payload)}.sig`;
	};

	it("derives app-platform from a web token's client_id", async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => jwt({ client_id: 'web' }), fetcher);

		await client.listRecordings();

		const headers = lastRequest()?.headers ?? {};
		expect(headers['app-platform']).toBe('web');
		expect(headers['edit-from']).toBe('web');
	});

	it("derives app-platform from an app token's client_id (no forced mismatch)", async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => jwt({ client_id: 'app' }), fetcher);

		await client.listRecordings();

		const headers = lastRequest()?.headers ?? {};
		expect(headers['app-platform']).toBe('app');
		expect(headers['edit-from']).toBe('app');
	});

	it('falls back to web when the token carries no client_id claim', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'opaque-token', fetcher);

		await client.listRecordings();

		expect(lastRequest()?.headers['app-platform']).toBe('web');
	});

	it('sends the documented query params (skip, limit, is_trash, sort_by, is_desc)', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings();

		const url = new URL(lastRequest()?.url ?? '');
		expect(url.searchParams.get('skip')).toBe('0');
		expect(url.searchParams.get('limit')).toBe('50');
		expect(url.searchParams.get('is_trash')).toBe('2');
		expect(url.searchParams.get('sort_by')).toBe('start_time');
		expect(url.searchParams.get('is_desc')).toBe('true');
	});

	it('passes a custom limit from the filter into the query string', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings({ limit: 10 });

		const url = new URL(lastRequest()?.url ?? '');
		expect(url.searchParams.get('limit')).toBe('10');
	});

	it('passes a custom skip from the filter into the query string', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings({ skip: 20, limit: 10 });

		const url = new URL(lastRequest()?.url ?? '');
		expect(url.searchParams.get('skip')).toBe('20');
		expect(url.searchParams.get('limit')).toBe('10');
	});
});

// listRecordings — regional endpoint auto-detection -------------------------
//
// Plaud routes EU and other non-US accounts to regional hosts. Hitting the US
// host with such an account returns HTTP 200 whose JSON body is a soft
// redirect: { status: -302, msg: "user region mismatch",
// data: { domains: { api: "https://api-euc1.plaud.ai" } } }. The client must
// switch to the returned host, persist it via onBaseUrlChanged, and retry.

describe('regional endpoint auto-detection', () => {
	function regionRedirect(apiHost: string): PlaudHttpResponse {
		return ok({
			status: -302,
			msg: 'user region mismatch',
			data: { domains: { api: apiHost } },
		});
	}

	// A fetcher that returns each queued response in order, repeating the last
	// one once the queue is drained. Lets a single client see a redirect first
	// and a real payload on retry.
	function sequenceFetcher(responses: readonly PlaudHttpResponse[]): {
		fetcher: PlaudHttpFetcher;
		allRequests: () => readonly PlaudHttpRequest[];
	} {
		const captured: PlaudHttpRequest[] = [];
		let call = 0;
		const fetcher: PlaudHttpFetcher = async (req) => {
			captured.push(req);
			const response = responses[Math.min(call, responses.length - 1)];
			call += 1;
			return response;
		};
		return { fetcher, allRequests: () => captured };
	}

	it('follows the region redirect and retries against the returned host', async () => {
		const { fetcher, allRequests } = sequenceFetcher([
			regionRedirect('https://api-euc1.plaud.ai'),
			ok(listEnvelope([])),
		]);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings();

		const requests = allRequests();
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toMatch(/^https:\/\/api\.plaud\.ai\//);
		expect(requests[1]?.url).toMatch(/^https:\/\/api-euc1\.plaud\.ai\/file\/simple\/web\?/);
		// The retry preserves the original path and query verbatim.
		expect(requests[1]?.url).toContain('sort_by=start_time');
	});

	it('fires onBaseUrlChanged exactly once with the regional host', async () => {
		const { fetcher } = sequenceFetcher([
			regionRedirect('https://api-euc1.plaud.ai'),
			ok(listEnvelope([])),
		]);
		const changes: string[] = [];
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			onBaseUrlChanged: (url) => changes.push(url),
		});

		await client.listRecordings();

		expect(changes).toEqual(['https://api-euc1.plaud.ai']);
	});

	it('caches the detected host so later calls skip the redirect', async () => {
		// Only the first call sees the redirect. After the client caches the
		// regional host, a second listRecordings must go straight there.
		const captured: PlaudHttpRequest[] = [];
		let call = 0;
		const fetcher: PlaudHttpFetcher = async (req) => {
			captured.push(req);
			call += 1;
			// First request only: region mismatch. Everything after: success.
			return call === 1
				? regionRedirect('https://api-euc1.plaud.ai')
				: ok(listEnvelope([]));
		};
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.listRecordings(); // redirect + retry (2 requests)
		await client.listRecordings(); // cached host (1 request)

		expect(captured).toHaveLength(3);
		expect(captured[2]?.url).toMatch(/^https:\/\/api-euc1\.plaud\.ai\//);
	});

	it('throws rather than looping when a second redirect is returned', async () => {
		// Every response is a redirect to a different host. The client must
		// follow exactly one and then give up.
		let call = 0;
		const fetcher: PlaudHttpFetcher = async () => {
			call += 1;
			return regionRedirect(`https://api-region${call}.plaud.ai`);
		};
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudApiError);
		await expect(client.listRecordings()).rejects.toThrow(/refusing to loop/i);
	});

	it('ignores a -302 whose api domain is missing or not https', async () => {
		// A malformed redirect must not hijack the base URL; it should fall
		// through to the normal parser, which rejects the shape.
		const { fetcher } = sequenceFetcher([
			ok({ status: -302, msg: 'user region mismatch', data: { domains: {} } }),
		]);
		const changes: string[] = [];
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			onBaseUrlChanged: (url) => changes.push(url),
		});

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
		expect(changes).toEqual([]);
	});

	// The retry re-sends the Bearer token, so the redirect target is a
	// credential trust boundary. A -302 must never steer the token at a
	// non-Plaud host.
	it.each([
		['a non-Plaud host', 'https://evil.example'],
		['a lookalike host', 'https://api.plaud.ai.evil.example'],
		['a suffix-without-dot host', 'https://notplaud.ai'],
		['a userinfo bypass', 'https://api.plaud.ai@evil.example'],
		['a non-https scheme', 'http://api-euc1.plaud.ai'],
	])('rejects a region redirect to %s without changing the base URL', async (_label, host) => {
		const { fetcher, allRequests } = sequenceFetcher([regionRedirect(host)]);
		const changes: string[] = [];
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			onBaseUrlChanged: (url) => changes.push(url),
		});

		// The poisoned -302 is not a valid list payload, so the parser
		// rejects it — but crucially the host is never adopted and the token
		// is never re-sent anywhere.
		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
		expect(changes).toEqual([]);
		// Only the original request to the US host was made — no retry.
		expect(allRequests()).toHaveLength(1);
		expect(allRequests()[0]?.url).toMatch(/^https:\/\/api\.plaud\.ai\//);
	});

	it('strips any path or query an attacker appends to an otherwise-valid host', async () => {
		const { fetcher, allRequests } = sequenceFetcher([
			regionRedirect('https://api-euc1.plaud.ai/evil/path?x=1'),
			ok(listEnvelope([])),
		]);
		const changes: string[] = [];
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			onBaseUrlChanged: (url) => changes.push(url),
		});

		await client.listRecordings();

		// Only scheme + host survive; the retry uses the real endpoint path.
		expect(changes).toEqual(['https://api-euc1.plaud.ai']);
		expect(allRequests()[1]?.url).toMatch(
			/^https:\/\/api-euc1\.plaud\.ai\/file\/simple\/web\?/,
		);
		expect(allRequests()[1]?.url).not.toContain('/evil/path');
	});
});

// listRecordings — filter behavior ------------------------------------------

describe('listRecordings filter behavior', () => {
	function threeRecords(): Record<string, unknown>[] {
		// Unix ms values: r1 = 2023-11-14, r2 = 2024-07-03, r3 = 2025-02-20.
		return [
			record({ id: 'r1', start_time: 1700000000000, is_trans: true }),
			record({ id: 'r2', start_time: 1720000000000, is_trans: false }),
			record({ id: 'r3', start_time: 1740000000000, is_trans: true }),
		];
	}

	it('filters out recordings with hasTranscript=false when filter.hasTranscript=true', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings({ hasTranscript: true });

		expect(result.map((r) => r.id)).toEqual(['r1', 'r3']);
	});

	it('filters by since date', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		// 1720000000000 unix ms = 2024-07-03 11:46:40 UTC (same as r2)
		const result = await client.listRecordings({ since: new Date(1720000000000) });

		expect(result.map((r) => r.id)).toEqual(['r2', 'r3']);
	});

	it('filters by until date', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings({ until: new Date(1720000000000) });

		expect(result.map((r) => r.id)).toEqual(['r1', 'r2']);
	});
});

// listRecordings — HTTP status handling ------------------------------------

describe('listRecordings HTTP status handling', () => {
	it('throws PlaudAuthError on HTTP 401', async () => {
		const { fetcher } = captureFetcher(status(401));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
	});

	it('throws PlaudApiError with status 500 on HTTP 500', async () => {
		const { fetcher } = captureFetcher(status(500));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toMatchObject({
			status: 500,
		});
	});

	it('throws PlaudApiError with status 429 on HTTP 429 (rate limit)', async () => {
		const { fetcher } = captureFetcher(status(429));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toMatchObject({
			status: 429,
		});
	});

	it('throws PlaudApiError on HTTP 503 with the status in the message', async () => {
		const { fetcher } = captureFetcher(status(503));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/503/);
	});

	it('treats HTTP 204 as an empty list', async () => {
		const { fetcher } = captureFetcher({ status: 204, json: null, text: '' });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();
		expect(result).toEqual([]);
	});

	it('throws PlaudParseError when a 2xx response has a null body', async () => {
		const { fetcher } = captureFetcher({
			status: 200,
			json: null,
			text: '<html>cloudflare challenge</html>',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('wraps a fetcher-thrown network error in PlaudApiError', async () => {
		const fetcher: PlaudHttpFetcher = async () => {
			throw new Error('ECONNRESET');
		};
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudApiError);
	});
});

// listRecordings — parse errors ---------------------------------------------

describe('listRecordings parse errors', () => {
	it('throws PlaudParseError when envelope is missing data_file_list', async () => {
		const { fetcher } = captureFetcher(ok({ status: 0, msg: 'ok' }));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when envelope is an array (not an object)', async () => {
		const { fetcher } = captureFetcher(ok([]));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when a record is missing required fields', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([{ id: 'abc', filename: 'broken' /* missing rest */ }])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it.each([
		['negative duration', { duration: -5 }],
		['NaN duration', { duration: Number.NaN }],
		['Infinity duration', { duration: Number.POSITIVE_INFINITY }],
		// 48h + 1 ms in ms — triggers the unit-confusion canary that
		// catches a future regression where `duration` is accidentally
		// populated from a unix ms timestamp instead of a delta.
		['duration beyond 48h', { duration: 48 * 60 * 60 * 1000 + 1 }],
		['zero start_time', { start_time: 0 }],
		['negative start_time', { start_time: -100 }],
		['NaN start_time', { start_time: Number.NaN }],
		['empty id', { id: '' }],
		['empty filename', { filename: '' }],
	])('rejects records with %s', async (_label, overrides) => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record(overrides)])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('converts the real-API duration (ms) to seconds — regression test for 2026-04-14 unit-confusion bug', async () => {
		// Real-API capture from 2026-04-14 for a 21m 43s recording came
		// back with `duration: 1303000`. If this ever regresses to being
		// stored as-is (milliseconds leaking into the Recording domain
		// object), a 21-minute meeting shows as "361h 57m" in the
		// generated note frontmatter.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ id: 'real-sample', duration: 1303000 })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();

		expect(result).toHaveLength(1);
		expect(result[0].durationSeconds).toBe(1303);
	});

	it('rejects start_time before year 2000 as likely seconds-mistaken-for-milliseconds', async () => {
		// Plaud uses unix MILLISECONDS for start_time. A seconds-valued
		// timestamp like 1744628400 (year 2025 in seconds) would land in
		// January 1970 if interpreted as ms — pin the sanity check so a
		// regression to the old "seconds" assumption fails loudly.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ start_time: 1744628400 })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/seconds/i);
	});

	it('rejects start_time beyond year 2100 as likely not-a-unix-timestamp', async () => {
		// Year 2100 in unix ms is 4102444800000. Anything beyond that is
		// almost certainly a unit-confusion bug (e.g., seconds-squared,
		// microseconds misinterpreted) — reject loudly.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ start_time: 5_000_000_000_000 })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/year 2100/);
	});

	it('aggregates multiple per-record parse failures into one error with counts', async () => {
		// Three bad records out of five. Error message should name 3/5 and
		// show the first few indexes that failed.
		const { fetcher } = captureFetcher(
			ok(
				listEnvelope([
					record({ id: 'r1' }),
					record({ id: 'r2', duration: -1 }),
					record({ id: 'r3' }),
					record({ id: 'r4', start_time: 0 }),
					record({ id: 'r5', filename: '' }),
				]),
			),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/3\/5/);
	});

	it('preserves valid records when a neighbor is invalid (aggregate error instead of silent drop)', async () => {
		// This is the inverse of the previous test: verify that an aggregate
		// parse error still fires even with some valid neighbors, i.e. the
		// client doesn't silently drop the bad record and pretend success.
		const { fetcher } = captureFetcher(
			ok(
				listEnvelope([
					record({ id: 'good' }),
					record({ id: 'bad', duration: Number.NaN }),
				]),
			),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('tolerates extra unknown fields in the response (forward-compat with Plaud)', async () => {
		// If Plaud adds a new field, we should keep working. Structural types
		// already allow this; this test pins the decision so nobody adds a
		// too-strict whitelist later.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ some_new_field_from_plaud: 'whatever' })])),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();
		expect(result).toHaveLength(1);
	});
});

// listRecordings — in-band error envelopes ----------------------------------
//
// Plaud signals failures as HTTP 200 with a NEGATIVE `status` and a `msg`,
// no data payload. Before this was handled, the body fell through to
// parseListResponse and surfaced as a misleading "unexpected shape / plugin
// may need an update" parse error. These fixtures are the exact envelopes
// captured from a real broken session on 2026-06-18.

describe('listRecordings in-band error envelopes', () => {
	it('maps -419 "workspace token expired" to a PlaudAuthError (token_rejected), not a parse error', async () => {
		const { fetcher } = captureFetcher(
			ok({ status: -419, msg: 'workspace token expired' }),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const err = await client.listRecordings().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaudAuthError);
		expect(err).not.toBeInstanceOf(PlaudParseError);
		expect((err as PlaudAuthError).reason).toBe('token_rejected');
	});

	it('routes any "expired" message to token_rejected even on a novel code', async () => {
		const { fetcher } = captureFetcher(
			ok({ status: -1234, msg: 'session token expired' }),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const err = await client.listRecordings().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaudAuthError);
		expect((err as PlaudAuthError).reason).toBe('token_rejected');
	});

	it('maps -3901 "token type does not match parse mode" to a non-parse in-band PlaudApiError', async () => {
		const { fetcher } = captureFetcher(
			ok({ status: -3901, msg: 'token type does not match parse mode' }),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const err = await client.listRecordings().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaudApiError);
		expect(err).not.toBeInstanceOf(PlaudParseError);
		expect(err).not.toBeInstanceOf(PlaudAuthError);
		// "in-band error from" is the discriminator classifyError uses to route
		// these to the api-error category and surface Plaud's own message.
		expect((err as PlaudApiError).message).toContain('in-band error from');
		expect((err as PlaudApiError).message).toContain(
			'token type does not match parse mode',
		);
	});

	it('does not trip on a valid list (status 0) — success path is unaffected', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record()])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.listRecordings();
		expect(result).toHaveLength(1);
	});
});

// listRecordings — filter validation ----------------------------------------

describe('listRecordings filter validation', () => {
	it('throws PlaudApiError when filter.folderId is set (not supported by /file/simple/web)', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(
			client.listRecordings({ folderId: 'anything' }),
		).rejects.toBeInstanceOf(PlaudApiError);
	});
});

// =============================================================================
// getTranscriptAndSummary — POST /ai/transsumm/{id}
// =============================================================================

import type { PlaudRecordingId } from '../plaud-client';

function transsummEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: 0,
		msg: 'success',
		request_id: 'req-abc',
		data_result: [
			{
				start_time: 0,
				end_time: 4500,
				content: 'Hello there.',
				speaker: 'Speaker 1',
				original_speaker: 'Speaker 1',
			},
			{
				start_time: 4500,
				end_time: 9000,
				content: 'How are you doing today?',
				speaker: 'Speaker 2',
				original_speaker: 'Speaker 2',
			},
		],
		data_result_summ: JSON.stringify({
			content: { markdown: '## Key points\n- Greeting exchanged' },
		}),
		outline_result: null,
		...overrides,
	};
}

const ID = 'rec-abc-123' as PlaudRecordingId;

// Request shape -------------------------------------------------------------

describe('getTranscriptAndSummary request shape', () => {
	// NOTE: as of the 2026-04-14 polished-transcript work, `getTranscriptAndSummary`
	// makes TWO sequential calls — first POST /ai/transsumm/{id}, then GET
	// /file/detail/{id} to look for a polish. These tests care about the
	// transsumm call (the FIRST request), so they use firstRequest() rather
	// than lastRequest() which would now return the /file/detail/ request.
	it('issues POST against /ai/transsumm/{id} with empty JSON body', async () => {
		const { fetcher, firstRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary(ID);

		const req = firstRequest();
		expect(req?.method).toBe('POST');
		expect(req?.url).toBe('https://api.plaud.ai/ai/transsumm/rec-abc-123');
		expect(req?.body).toBe('{}');
	});

	it('sends Content-Type: application/json when a body is present', async () => {
		const { fetcher, firstRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary(ID);

		expect(firstRequest()?.headers['Content-Type']).toBe('application/json');
	});

	it('still sends Authorization Bearer header', async () => {
		const { fetcher, firstRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'my-jwt', fetcher);

		await client.getTranscriptAndSummary(ID);

		expect(firstRequest()?.headers.Authorization).toBe('Bearer my-jwt');
	});

	it('URL-encodes the recording id', async () => {
		const { fetcher, firstRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary('id with/slash' as PlaudRecordingId);

		expect(firstRequest()?.url).toBe(
			'https://api.plaud.ai/ai/transsumm/id%20with%2Fslash',
		);
	});

	it('rejects empty id without making a request', async () => {
		let called = false;
		const fetcher: PlaudHttpFetcher = async () => {
			called = true;
			return ok(transsummEnvelope());
		};
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(
			client.getTranscriptAndSummary('' as PlaudRecordingId),
		).rejects.toBeInstanceOf(PlaudApiError);
		expect(called).toBe(false);
	});
});

// Legacy-transsumm failure fallback (older recordings) ----------------------
//
// Older recordings return an in-band `status=-12 "start trans task error"`
// from POST /ai/transsumm/{id} (the endpoint appears to start a transcription
// task that cannot run for archived recordings). That used to abort the whole
// recording. /file/detail/{id} is a plain read of stored data and still
// carries the summary/transcript, so the legacy failure must be best-effort.

describe('getTranscriptAndSummary legacy-transsumm -12 fallback', () => {
	// Routes the two endpoints independently: transsumm fails in-band, detail
	// succeeds (or not, per the second test).
	function routed(
		transsummResponse: PlaudHttpResponse,
		detailResponse: PlaudHttpResponse,
	): PlaudHttpFetcher {
		return async (req) => {
			if (req.url.includes('/ai/transsumm/')) {
				return transsummResponse;
			}
			if (req.url.includes('/file/detail/')) {
				return detailResponse;
			}
			return status(404);
		};
	}

	const transsummMinus12 = ok({
		status: -12,
		msg: 'start trans task error',
	});

	const detailWithNewerSummary = ok({
		status: 0,
		msg: 'success',
		data: {
			pre_download_content_list: [
				{
					data_id: 'auto_sum:owner:fileid',
					data_content: '## Key points\n- Recovered from /file/detail',
				},
			],
		},
	});

	it('recovers the summary from /file/detail when transsumm returns -12', async () => {
		const client = new ReverseEngineeredPlaudClient(
			() => 'tok',
			routed(transsummMinus12, detailWithNewerSummary),
		);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.summary).not.toBeNull();
		expect(result.summary?.text).toContain('Recovered from /file/detail');
	});

	it('surfaces the original -12 error when /file/detail also yields nothing', async () => {
		const emptyDetail = ok({ status: 0, msg: 'success', data: {} });
		const client = new ReverseEngineeredPlaudClient(
			() => 'tok',
			routed(transsummMinus12, emptyDetail),
		);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(
			/start trans task error/,
		);
	});
});

// Happy path response parsing ----------------------------------------------

describe('getTranscriptAndSummary happy path', () => {
	it('returns both transcript and summary when both are present', async () => {
		const { fetcher } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.transcript).not.toBeNull();
		expect(result.summary).not.toBeNull();
		expect(result.transcript?.id).toBe(ID);
		expect(result.summary?.id).toBe(ID);
	});

	it('converts transcript timestamps from milliseconds to seconds', async () => {
		const { fetcher } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		// First segment: start_time 0 ms → 0 s, end_time 4500 ms → 4.5 s
		expect(transcript?.segments[0].startSeconds).toBe(0);
		expect(transcript?.segments[0].endSeconds).toBe(4.5);
		// Second segment: 4500 ms → 4.5 s, 9000 ms → 9 s
		expect(transcript?.segments[1].startSeconds).toBe(4.5);
		expect(transcript?.segments[1].endSeconds).toBe(9);
	});

	it('maps content → text and preserves speaker', async () => {
		const { fetcher } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments[0].text).toBe('Hello there.');
		expect(transcript?.segments[0].speaker).toBe('Speaker 1');
		expect(transcript?.segments[1].text).toBe('How are you doing today?');
		expect(transcript?.segments[1].speaker).toBe('Speaker 2');
	});

	it('prefers the user-assigned speaker name over the raw diarization label', async () => {
		// Real-API testing on 2026-04-14 showed that `original_speaker`
		// holds Plaud's raw diarization output ("Speaker 1", "Speaker 2")
		// while `speaker` holds the label the user assigned in Plaud's UI
		// (e.g., "Charles", "Mary"). Prefer the user-edited name.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 0, end_time: 1000, content: 'foo', speaker: 'Charles', original_speaker: 'Speaker 1' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments[0].speaker).toBe('Charles');
	});

	it('falls back to original_speaker when speaker is empty', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 0, end_time: 1000, content: 'foo', speaker: '', original_speaker: 'Speaker 1' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments[0].speaker).toBe('Speaker 1');
	});

	it('leaves speaker undefined when both speaker and original_speaker are empty', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 0, end_time: 1000, content: 'anonymous', speaker: '', original_speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments[0].speaker).toBeUndefined();
	});

	it('joins all segment text into rawText', async () => {
		const { fetcher } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.rawText).toBe('Hello there. How are you doing today?');
	});
});

// data_result_summ shape variations (the five-shape trap) -------------------

describe('getTranscriptAndSummary summary normalization', () => {
	it('handles JSON-encoded string with content.markdown (typical case)', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: JSON.stringify({
					content: { markdown: '## Headline\n- bullet' },
				}),
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## Headline\n- bullet');
	});

	it('handles structured object with content.markdown', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					content: { markdown: 'Short recording summary' },
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('Short recording summary');
	});

	it('handles structured object with content as a direct string', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { content: 'Direct string content' },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('Direct string content');
	});

	it('handles malformed JSON string by treating it as raw markdown', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: 'this is not JSON, just plain markdown',
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('this is not JSON, just plain markdown');
	});

	it('returns null summary when data_result_summ is null', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result_summ: null })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary).toBeNull();
	});

	it('returns null summary when content.markdown is empty after trim', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { content: { markdown: '   \n\t   ' } },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary).toBeNull();
	});

	it('returns null summary when raw is an empty string', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result_summ: '' })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary).toBeNull();
	});

	it('trims surrounding whitespace from extracted markdown', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { content: { markdown: '   ## title\n- a   ' } },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## title\n- a');
	});

	// Shape 5 — flat GPT-5 schema rolled out by Plaud around 2026-05.
	// Top-level `markdown` is the canonical rendered output; `summary` is a
	// fallback when `markdown` is absent. The `content` wrapper is gone.

	it('handles flat GPT-5 schema with top-level markdown', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## Action items\n- ship it',
					summary: '## Action items\n- ship it',
					first_summary: 'pre-edit raw',
					endpoint: 'azure-sweden-central-gpt-5',
					header: { category: 'ai-meeting', headline: 'Test' },
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## Action items\n- ship it');
	});

	it('falls back to flat top-level summary when markdown is absent', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					summary: '## Fallback path',
					first_summary: 'noisy raw output',
					endpoint: 'azure-sweden-central-gpt-5',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## Fallback path');
	});

	it('returns null when flat markdown is empty after trim', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '   \n\t   ',
					endpoint: 'azure-sweden-central-gpt-5',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary).toBeNull();
	});

	it('prefers flat markdown over first_summary when both present', async () => {
		// first_summary is the pre-persona-edit raw output; markdown is the
		// canonical post-processed rendering. We must NOT pick first_summary.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					first_summary: 'RAW — DO NOT USE',
					markdown: 'CANONICAL',
					summary: 'CANONICAL',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('CANONICAL');
	});
});

// Summary extras — flat GPT-5 schema (shape 5) surfaces extra metadata
// alongside the markdown. The parser must pull each known extra as
// best-effort and never blow up when a field is missing or wrong-typed.

describe('getTranscriptAndSummary summary extras (flat schema)', () => {
	it('extracts all known extras from a complete flat envelope', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					summary: '## body',
					first_summary: 'raw',
					ai_suggestion: 'Consider following up with the team on action items.',
					endpoint: 'azure-sweden-central-gpt-5',
					model: 'gpt-5-2025-08',
					language: 'en',
					note_id: 'note-abc',
					summary_id: 'sum-xyz',
					version: 3,
					summ_type: 'ai-meeting',
					select_prompt_type: 'meeting',
					header: { category: 'ai-meeting', headline: 'Q2 Planning' },
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## body');
		expect(summary?.aiSuggestion).toBe('Consider following up with the team on action items.');
		expect(summary?.language).toBe('en');
		expect(summary?.template).toBe('ai-meeting');
		expect(summary?.model).toBe('gpt-5-2025-08');
		expect(summary?.noteId).toBe('note-abc');
		expect(summary?.summaryId).toBe('sum-xyz');
		expect(summary?.version).toBe('3');
		expect(summary?.headline).toBe('Q2 Planning');
		expect(summary?.category).toBe('ai-meeting');
	});

	it('falls back to endpoint when model field is absent', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					endpoint: 'azure-sweden-central-gpt-5',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.model).toBe('azure-sweden-central-gpt-5');
	});

	it('falls back to select_prompt_type when summ_type is absent', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					select_prompt_type: 'lecture',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.template).toBe('lecture');
	});

	it('returns Summary with only id+text when no extras are present', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { markdown: '## just the body' },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## just the body');
		expect(summary?.aiSuggestion).toBeUndefined();
		expect(summary?.headline).toBeUndefined();
		expect(summary?.category).toBeUndefined();
		expect(summary?.language).toBeUndefined();
		expect(summary?.template).toBeUndefined();
		expect(summary?.model).toBeUndefined();
		expect(summary?.noteId).toBeUndefined();
		expect(summary?.summaryId).toBeUndefined();
		expect(summary?.version).toBeUndefined();
	});

	it('silently drops extras that are not strings (no throw)', async () => {
		// Plaud could ship a field as a number, null, array, or object
		// where we expect a string. The parser must NOT throw — it must
		// just leave that field undefined and continue.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					ai_suggestion: 42,
					language: null,
					summ_type: ['array', 'not', 'string'],
					note_id: { nested: 'object' },
					header: 'string-not-object',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## body');
		expect(summary?.aiSuggestion).toBeUndefined();
		expect(summary?.language).toBeUndefined();
		expect(summary?.template).toBeUndefined();
		expect(summary?.noteId).toBeUndefined();
		expect(summary?.headline).toBeUndefined();
		expect(summary?.category).toBeUndefined();
	});

	it('silently drops empty-string extras after trim', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					ai_suggestion: '   \n\t   ',
					language: '',
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.aiSuggestion).toBeUndefined();
		expect(summary?.language).toBeUndefined();
	});

	it('ignores unknown extra keys without breaking', async () => {
		// Forward-compatibility: a future Plaud release that adds a brand
		// new top-level field must not break the parser.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: {
					markdown: '## body',
					ai_suggestion: 'do the thing',
					some_future_field: 'whatever',
					another_new_thing: { deeply: { nested: true } },
				},
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## body');
		expect(summary?.aiSuggestion).toBe('do the thing');
	});

	it('does not extract extras when using legacy nested content shape', async () => {
		// Shape 2 envelopes have no peer fields alongside `content`, so
		// extras stay undefined — but the parser must still not blow up.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { content: { markdown: '## legacy body' } },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { summary } = await client.getTranscriptAndSummary(ID);

		expect(summary?.text).toBe('## legacy body');
		expect(summary?.aiSuggestion).toBeUndefined();
		expect(summary?.headline).toBeUndefined();
	});
});

// data_result_summ shape-drift detection (throws loudly on unknown shapes)

describe('getTranscriptAndSummary summary shape-drift detection', () => {
	it('throws PlaudParseError when a JSON-looking string fails to parse', async () => {
		// A raw string that begins with `{` is interpreted as an attempt
		// at structured JSON. A parse failure means Plaud shipped broken
		// data — don't silently treat it as markdown because the note
		// would render as literal JSON gibberish.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: '{broken: no close brace',
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when JSON-parsed value is not an object', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result_summ: JSON.stringify([1, 2, 3]) })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when content is an object but has no markdown field', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { content: { html: '<p>unexpected</p>' } },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when content is neither a string nor an object', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result_summ: { content: 12345 } })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when the outer object has no content field at all', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result_summ: { notes: 'wrong-shape', title: 'nope' },
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudParseError,
		);
	});
});

// Segment validation: backwards timestamps and unit sanity

describe('getTranscriptAndSummary segment validation', () => {
	it('clamps end_time up to start_time when Plaud sends them backwards', async () => {
		// Real-API capture on 2026-06-10: recording 9a3a1db8... contained
		// data_result[61] with end_time 1596940 and start_time 1610440
		// (13.5s backwards, mid-recording). The parser used to reject the
		// whole transcript for that one boundary; now it keeps the segment
		// and clamps the end to the (authoritative) start.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 1610440, end_time: 1596940, content: 'backwards', speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);
		expect(transcript?.segments[0].startSeconds).toBe(1610.44);
		expect(transcript?.segments[0].endSeconds).toBe(1610.44);
		expect(transcript?.segments[0].text).toBe('backwards');
	});

	it('allows end_time equal to start_time (zero-length segment)', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 1000, end_time: 1000, content: 'blip', speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);
		expect(transcript?.segments[0].startSeconds).toBe(1);
		expect(transcript?.segments[0].endSeconds).toBe(1);
	});

	it('throws PlaudParseError when start_time exceeds the 24h plausible bound (unit-confusion canary)', async () => {
		// 25 hours in "seconds" = 90000. If the producer accidentally
		// sends seconds instead of milliseconds, the first sub-hour
		// segment would arrive as 3600 — which is plausible as ms
		// (3.6s) — but anything beyond 24h in ms is 86,400,000 — the
		// canary fires when a producer sends 30000 as ms (30s) but
		// actually meant 30 seconds = 30000ms, which is fine.
		// Genuine bug: producer sends 90000 intending 90s, interpreted
		// as 90000ms = 90s. Safe.
		// Real canary case: producer sends value > 24h of ms, meaning
		// they confused units and sent something like 1744628400000
		// (a unix millis timestamp, not a segment offset).
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{
						start_time: 1744628400000, // unix millis masquerading as segment offset
						end_time: 1744628500000,
						content: 'confused units',
						speaker: '',
					},
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(
			/24h|milliseconds/i,
		);
	});

	it('accepts segments up to 24h that are merely long', async () => {
		// A 23h58m segment is valid even if unlikely.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{
						start_time: 86_000_000,
						end_time: 86_100_000,
						content: 'late in the day',
						speaker: '',
					},
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);
		expect(transcript?.segments).toHaveLength(1);
	});
});

// Null-transcript handling --------------------------------------------------

describe('getTranscriptAndSummary missing data', () => {
	it('returns null transcript when data_result is null', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result: null })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript).toBeNull();
	});

	it('returns an empty-but-present transcript when data_result is an empty array', async () => {
		// [] and null carry different wire signals: null means "not yet
		// processed" (caller should retry or wait), [] means "Plaud
		// processed this and produced zero segments" (silent audio, etc).
		// Preserve the distinction so the NoteWriter's advertised-but-null
		// guard doesn't trip on the processed-but-empty case.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result: [] })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript).not.toBeNull();
		expect(transcript?.segments).toEqual([]);
		expect(transcript?.rawText).toBe('');
	});

	it('returns both null when neither transcript nor summary is present', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result: null, data_result_summ: null })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.transcript).toBeNull();
		expect(result.summary).toBeNull();
	});
});

// Parse errors --------------------------------------------------------------

describe('getTranscriptAndSummary parse errors', () => {
	it('throws PlaudParseError when response body is not an object', async () => {
		const { fetcher } = captureFetcher(ok(['not', 'an', 'envelope']));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when data_result is not an array', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ data_result: 'not-an-array' })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when a segment is missing required fields', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [{ start_time: 0, end_time: 1000 /* no content */ }],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when a segment has negative start_time', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: -1, end_time: 1000, content: 'x', speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when a segment has NaN end_time', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 0, end_time: Number.NaN, content: 'x', speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('includes the segment index in the parse error message', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 0, end_time: 1000, content: 'ok', speaker: 'A' },
					{ start_time: 1000, end_time: 2000 /* missing content */ },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(/\[1\]/);
	});
});

// In-band errors and HTTP errors -------------------------------------------

describe('getTranscriptAndSummary error mapping', () => {
	it('throws PlaudApiError when response has string err_code set', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				err_code: 'ai_pipeline_failed',
				err_msg: 'transcription pipeline returned no data',
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(
			/ai_pipeline_failed/,
		);
	});

	it('throws PlaudApiError when err_code is a non-zero number', async () => {
		// Plaud may send err_code as a number (e.g. 4001). Previous
		// implementation only matched strings and silently dropped
		// numeric error codes.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				err_code: 4001,
				err_msg: 'quota exceeded',
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(/4001/);
	});

	it('accepts non-zero status values when err_code is empty (real-API observation)', async () => {
		// Real-API testing on 2026-04-14 showed Plaud returning
		// `status: 1, err_code: "", msg: "success"` on legitimate
		// success responses. The status field is apparently NOT a
		// 0=success signal — err_code is the only reliable failure
		// discriminator. Pin this so a future refactor doesn't
		// reintroduce the "status must be 0" assumption.
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({ status: 1, msg: 'success', err_code: '' })),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);
		expect(result.transcript).not.toBeNull();
		expect(result.summary).not.toBeNull();
	});

	it('accepts a missing status field when err_code is absent', async () => {
		const { fetcher } = captureFetcher(
			ok({ msg: 'ok', data_result: null, data_result_summ: null }),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);
		expect(result.transcript).toBeNull();
		expect(result.summary).toBeNull();
	});

	it('throws PlaudAuthError on HTTP 401', async () => {
		const { fetcher } = captureFetcher(status(401));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudAuthError);
	});

	it('throws PlaudApiError with status 500 on HTTP 500', async () => {
		const { fetcher } = captureFetcher(status(500));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toMatchObject({
			status: 500,
		});
	});

	it('wraps a fetcher-thrown network error in PlaudApiError', async () => {
		const fetcher: PlaudHttpFetcher = async () => {
			throw new Error('ETIMEDOUT');
		};
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudApiError);
	});
});

// -----------------------------------------------------------------------------
// Debug logger integration — verify the client emits request/response/parsed
// events when a debug logger is attached, never leaks Authorization headers,
// and stays silent when no logger is passed.
// -----------------------------------------------------------------------------

function silentSink(): (message: string, payload?: unknown) => void {
	return (): void => {
		// swallow the live console mirror during tests
	};
}

describe('debug logger integration', () => {
	it('emits request and response events with the endpoint path when a logger is attached', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			debugLogger: logger,
		});

		await client.listRecordings();

		const events = logger.snapshot();
		expect(events.length).toBeGreaterThanOrEqual(2);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain('request');
		expect(kinds).toContain('response');

		const requestEvent = events.find((e) => e.kind === 'request');
		expect(requestEvent?.endpoint).toBe('/file/simple/web');
		expect(requestEvent?.message).toMatch(/GET \/file\/simple\/web/);

		const responseEvent = events.find((e) => e.kind === 'response');
		expect(responseEvent?.endpoint).toBe('/file/simple/web');
		expect(responseEvent?.message).toMatch(/200/);
	});

	it('never includes Authorization or any header in the request event payload', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'super-secret-jwt', fetcher, {
			debugLogger: logger,
		});

		await client.listRecordings();

		const dump = JSON.stringify(logger.snapshot());
		// The token must not appear in any captured payload — neither the
		// raw JWT nor the "Authorization" header name.
		expect(dump).not.toContain('super-secret-jwt');
		expect(dump).not.toContain('Authorization');
		expect(dump).not.toContain('Bearer ');
	});

	it('emits a parsed event with a summarized recording list after successful listRecordings', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record({ id: 'r1' })])));
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			debugLogger: logger,
		});

		await client.listRecordings();

		const parsed = logger.snapshot().find((e: DebugEvent) => e.kind === 'parsed');
		expect(parsed).toBeDefined();
		expect(parsed?.endpoint).toBe('/file/simple/web');
		expect(parsed?.message).toMatch(/parsed 1 recordings/);
		expect(parsed?.payload).toEqual([
			expect.objectContaining({
				id: 'r1',
				title: 'Morning standup',
				durationSeconds: 600,
				transcriptAvailable: true,
				summaryAvailable: true,
			}),
		]);
	});

	it('emits a parsed event after getTranscriptAndSummary with the resolved segment count', async () => {
		const { fetcher } = captureFetcher(
			ok({
				err_code: '',
				status: 0,
				data_result: [
					{ start_time: 0, end_time: 1000, content: 'hello', speaker: 'Charles' },
				],
				data_result_summ: JSON.stringify({ content: { markdown: 'Meeting summary.' } }),
			}),
		);
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			debugLogger: logger,
		});

		await client.getTranscriptAndSummary('rec-abc-123' as unknown as Parameters<typeof client.getTranscriptAndSummary>[0]);

		// After the 2026-04-14 polished-transcript work, the parsed event
		// is emitted by the higher-level getTranscriptAndSummary wrapper
		// (not fetchLegacyTranssumm), so the endpoint label is the synthetic
		// `/getTranscriptAndSummary` marker. The test here asserts on the
		// segment-count payload rather than the endpoint label since that
		// is what downstream consumers actually care about.
		const parsed = logger
			.snapshot()
			.find(
				(e: DebugEvent) =>
					e.kind === 'parsed' && typeof e.message === 'string' && e.message.includes('segments'),
			);
		expect(parsed).toBeDefined();
		expect(parsed?.message).toMatch(/raw fallback \(1 segments\)/);
	});

	it('emits an error event when the fetcher rejects', async () => {
		const fetcher: PlaudHttpFetcher = async () => {
			throw new Error('ETIMEDOUT');
		};
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			debugLogger: logger,
		});

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudApiError);

		const errorEvent = logger.snapshot().find((e: DebugEvent) => e.kind === 'error');
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message).toMatch(/ETIMEDOUT/);
	});

	it('does not capture any events when no logger is passed (zero-cost when debug is off)', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		// Construct without `debugLogger` — the client's hot path must
		// handle this case without touching any logger method.
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		// The mere absence of a throw proves no logger method was called.
		await expect(client.listRecordings()).resolves.toBeDefined();
	});

	it('does not emit events when a logger is attached but enabled=false', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const logger = new BufferedDebugLogger(false, { consoleSink: silentSink() });
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher, {
			debugLogger: logger,
		});

		await client.listRecordings();

		expect(logger.snapshot()).toEqual([]);
	});
});

// =============================================================================
// findTransactionPolishLink — pure helper for walking /file/detail/ response
// =============================================================================

describe('findTransactionPolishLink', () => {
	function fileDetail(contentList: unknown[]): Record<string, unknown> {
		return {
			status: 0,
			msg: 'success',
			request_id: 'req-xyz',
			data: {
				file_id: 'abc123',
				file_name: 'Meeting',
				duration: 1303000,
				content_list: contentList,
				extra_data: {},
			},
		};
	}

	function polishItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			data_id: 'source_transaction_polish:xxx:abc123',
			data_type: 'transaction_polish',
			task_status: 1,
			err_code: '',
			err_msg: '',
			data_link: 'https://s3.amazonaws.com/polished.json?X-Amz-Signature=fake',
			extra: {},
			...overrides,
		};
	}

	function transactionItem(): Record<string, unknown> {
		return {
			data_id: 'source_transaction:xxx:abc123',
			data_type: 'transaction',
			task_status: 1,
			data_link: 'https://s3.amazonaws.com/raw.json.gz?X-Amz-Signature=fake',
		};
	}

	it('returns the polish data_link when a successful transaction_polish entry exists', () => {
		const raw = fileDetail([transactionItem(), polishItem()]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBe('https://s3.amazonaws.com/polished.json?X-Amz-Signature=fake');
	});

	it('returns null when content_list has no transaction_polish entry', () => {
		const raw = fileDetail([transactionItem()]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('returns null when content_list is absent entirely (never-polished recording)', () => {
		const raw = { status: 0, data: { file_id: 'abc123' } };
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('returns null when task_status for the polish entry is not 1 (still processing)', () => {
		const raw = fileDetail([polishItem({ task_status: 0 })]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('returns null when task_status for the polish entry indicates failure (>1)', () => {
		const raw = fileDetail([polishItem({ task_status: 2 })]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('returns null when the polish entry has no data_link', () => {
		const raw = fileDetail([polishItem({ data_link: '' })]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('returns null when data_link is not a string', () => {
		const raw = fileDetail([polishItem({ data_link: null })]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBeNull();
	});

	it('throws PlaudParseError when the response body is not an object', () => {
		expect(() =>
			findTransactionPolishLink('not an object', '/file/detail/abc123'),
		).toThrow(PlaudParseError);
	});

	it('throws PlaudParseError when response.data is missing', () => {
		expect(() =>
			findTransactionPolishLink({ status: 0 }, '/file/detail/abc123'),
		).toThrow(PlaudParseError);
	});

	it('throws PlaudParseError when content_list is present but not an array', () => {
		const raw = { status: 0, data: { content_list: 'bogus' } };
		expect(() =>
			findTransactionPolishLink(raw, '/file/detail/abc123'),
		).toThrow(PlaudParseError);
	});

	it('picks the polish entry regardless of position in content_list', () => {
		// Real responses have 4+ items: transaction, outline, transaction_polish,
		// auto_sum_note. The polish may not be at a fixed index, so the finder
		// must scan by data_type rather than relying on position.
		const raw = fileDetail([
			transactionItem(),
			{ data_type: 'outline', task_status: 1, data_link: 'https://s3/outline' },
			polishItem({ data_link: 'https://s3/polish-at-idx-2' }),
			{ data_type: 'auto_sum_note', task_status: 1, data_link: 'https://s3/sum' },
		]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBe('https://s3/polish-at-idx-2');
	});

	it('skips non-object items in content_list gracefully', () => {
		const raw = fileDetail([null, 'string', 42, polishItem()]);
		const link = findTransactionPolishLink(raw, '/file/detail/abc123');
		expect(link).toBe('https://s3.amazonaws.com/polished.json?X-Amz-Signature=fake');
	});
});

// =============================================================================
// getTranscriptAndSummary — polished-transcript path (2026-04-14 feature)
// =============================================================================

/**
 * Route requests to different canned responses based on the URL path.
 * Needed because the polished-transcript flow now makes up to three
 * calls per recording: POST /ai/transsumm/{id}, GET /file/detail/{id},
 * and GET <S3 URL>. Each test case specifies which response goes to
 * which path.
 */
function routeFetcher(routes: {
	readonly transsumm?: PlaudHttpResponse;
	readonly detail?: PlaudHttpResponse;
	readonly polish?: PlaudHttpResponse;
	readonly throwOn?: 'transsumm' | 'detail' | 'polish';
}): {
	fetcher: PlaudHttpFetcher;
	requests: () => readonly PlaudHttpRequest[];
} {
	const captured: PlaudHttpRequest[] = [];
	const defaultResponse: PlaudHttpResponse = { status: 404, json: null, text: '' };
	const fetcher: PlaudHttpFetcher = async (req) => {
		captured.push(req);
		if (req.url.includes('/ai/transsumm/')) {
			if (routes.throwOn === 'transsumm') throw new Error('synthetic transsumm failure');
			return routes.transsumm ?? defaultResponse;
		}
		if (req.url.includes('/file/detail/')) {
			if (routes.throwOn === 'detail') throw new Error('synthetic detail failure');
			return routes.detail ?? defaultResponse;
		}
		// Anything else is assumed to be the S3 pre-signed polish URL.
		if (routes.throwOn === 'polish') throw new Error('synthetic polish failure');
		return routes.polish ?? defaultResponse;
	};
	return { fetcher, requests: () => captured };
}

function polishedSegment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		start_time: 0,
		end_time: 1000,
		content: 'Hey Charles. How you doing?',
		speaker: 'Charles Kelsoe',
		original_speaker: 'Speaker 1',
		...overrides,
	};
}

function fileDetailWithPolishUrl(polishUrl: string): Record<string, unknown> {
	return {
		status: 0,
		msg: 'success',
		request_id: '',
		data: {
			file_id: 'abc123',
			file_name: 'Meeting',
			duration: 1303000,
			content_list: [
				{
					data_type: 'transaction',
					task_status: 1,
					data_link: 'https://s3/raw.json.gz?sig=x',
				},
				{
					data_type: 'outline',
					task_status: 1,
					data_link: 'https://s3/outline?sig=x',
				},
				{
					data_type: 'transaction_polish',
					task_status: 1,
					data_link: polishUrl,
				},
				{
					data_type: 'auto_sum_note',
					task_status: 1,
					data_link: 'https://s3/sum?sig=x',
				},
			],
			extra_data: { has_replaced_speaker: true },
		},
	};
}

describe('getTranscriptAndSummary polished-transcript path', () => {
	it('uses the polished transcript (with real speaker names) when available', async () => {
		const { fetcher, requests } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailWithPolishUrl('https://s3/polish?sig=x')),
			polish: ok([
				polishedSegment({
					speaker: 'Charles Kelsoe',
					original_speaker: 'Speaker 1',
					content: 'Hey.',
				}),
				polishedSegment({
					start_time: 1000,
					end_time: 2000,
					speaker: 'Vijay Muniswamy',
					original_speaker: 'Speaker 2',
					content: 'Hi Charles.',
				}),
			]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript, summary } = await client.getTranscriptAndSummary(ID);

		// Polished path must be used — speaker names come from the
		// polish file, NOT the raw transsumm response.
		expect(transcript).not.toBeNull();
		expect(transcript?.segments.map((s) => s.speaker)).toEqual([
			'Charles Kelsoe',
			'Vijay Muniswamy',
		]);
		// This fixture's /file/detail/ response has no auto_sum_note
		// entry in pre_download_content_list, so the summary falls back
		// to /ai/transsumm/'s legacy summary. The newer-summary override
		// path is covered by its own test block below.
		expect(summary?.text).toContain('Key points');
		// All three endpoints should have been called.
		const urls = requests().map((r) => r.url);
		expect(urls.some((u) => u.includes('/ai/transsumm/'))).toBe(true);
		expect(urls.some((u) => u.includes('/file/detail/'))).toBe(true);
		expect(urls.some((u) => u.includes('/polish'))).toBe(true);
	});

	it('recovers the raw transcript from /file/detail when transsumm -12s and there is no polish', async () => {
		// Older recording: transsumm fails in-band, the detail bundle has a
		// raw `transaction` entry but was never polished and has no
		// auto_sum_note. The raw transcript link must be followed so the
		// recording still imports.
		const detailRawOnly = ok({
			status: 0,
			msg: 'success',
			data: {
				content_list: [
					{
						data_type: 'transaction',
						task_status: 1,
						data_link: 'https://s3/raw-transcript?sig=x',
					},
				],
			},
		});
		const { fetcher, requests } = routeFetcher({
			transsumm: ok({ status: -12, msg: 'start trans task error' }),
			detail: detailRawOnly,
			// routeFetcher routes any non-transsumm/non-detail URL here, which
			// covers the raw transcript S3 link.
			polish: ok([
				polishedSegment({
					speaker: 'Speaker 1',
					original_speaker: 'Speaker 1',
					content: 'Raw line one.',
				}),
				polishedSegment({
					start_time: 1000,
					end_time: 2000,
					speaker: 'Speaker 2',
					original_speaker: 'Speaker 2',
					content: 'Raw line two.',
				}),
			]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript).not.toBeNull();
		expect(transcript?.segments).toHaveLength(2);
		expect(transcript?.segments[0].text).toContain('Raw line one');
		// The raw S3 link was fetched without the Bearer token.
		const rawReq = requests().find((r) => r.url.includes('/raw-transcript'));
		expect(rawReq?.headers.Authorization).toBeUndefined();
	});

	it('fetches the pre-signed S3 URL WITHOUT Authorization (skipAuth)', async () => {
		const { fetcher, requests } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailWithPolishUrl('https://s3/polish?sig=x')),
			polish: ok([polishedSegment()]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'super-secret-jwt', fetcher);

		await client.getTranscriptAndSummary(ID);

		const polishReq = requests().find((r) => r.url.includes('/polish'));
		expect(polishReq).toBeDefined();
		// The S3 request MUST NOT carry the Bearer token — S3 pre-signed
		// URLs already authenticate via the query string and adding a
		// Bearer would be a cross-service credential leak.
		expect(polishReq?.headers.Authorization).toBeUndefined();
		// But the other two requests (api.plaud.ai) MUST still carry it.
		const authedUrls = requests()
			.filter((r) => r.headers.Authorization !== undefined)
			.map((r) => r.url);
		expect(authedUrls.some((u) => u.includes('/ai/transsumm/'))).toBe(true);
		expect(authedUrls.some((u) => u.includes('/file/detail/'))).toBe(true);
	});

	it('falls back to the raw /ai/transsumm/ transcript when /file/detail/ has no polish entry', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()), // has Speaker 1 / Speaker 2
			detail: ok({
				status: 0,
				msg: 'success',
				data: { file_id: 'abc', content_list: [] }, // empty content_list
			}),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('falls back to the raw transcript when /file/detail/ itself fails', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			throwOn: 'detail',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		// Must not throw — /file/detail/ failure is non-fatal for the
		// overall call. Raw transcript becomes the result.
		const { transcript } = await client.getTranscriptAndSummary(ID);
		expect(transcript).not.toBeNull();
		expect(transcript?.segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('falls back to the raw transcript when the S3 polish fetch fails', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailWithPolishUrl('https://s3/polish?sig=x')),
			throwOn: 'polish',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);
		expect(transcript?.segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('propagates a raw /ai/transsumm/ failure (legacy errors are still fatal)', async () => {
		// The polish path is best-effort and swallowed on failure, but
		// /ai/transsumm/ is still the authoritative source for the summary
		// (and the fallback transcript), so errors there MUST still reach
		// the caller.
		const { fetcher } = routeFetcher({
			throwOn: 'transsumm',
			detail: ok(fileDetailWithPolishUrl('https://s3/polish?sig=x')),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(PlaudApiError);
	});

	it('regression test: real-data 2026-04-14 case (3 raw voices collapsed to 2 real people)', async () => {
		// Reproduces the real-data case from the 2026-04-14 reverse-engineering:
		// Plaud's diarization detected 3 voices (Speaker 1/2/3) but the user
		// in the web app renamed Speaker 2 AND Speaker 3 both to "Vijay Muniswamy".
		// The polish file reflects that N→1 collapse, so the resulting
		// transcript has only 2 distinct speakers.
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailWithPolishUrl('https://s3/polish?sig=x')),
			polish: ok([
				polishedSegment({
					speaker: 'Charles Kelsoe',
					original_speaker: 'Speaker 1',
				}),
				polishedSegment({
					start_time: 1000,
					end_time: 2000,
					speaker: 'Vijay Muniswamy',
					original_speaker: 'Speaker 2',
				}),
				polishedSegment({
					start_time: 2000,
					end_time: 3000,
					speaker: 'Vijay Muniswamy',
					original_speaker: 'Speaker 3',
				}),
			]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript } = await client.getTranscriptAndSummary(ID);

		const distinctSpeakers = new Set(transcript?.segments.map((s) => s.speaker));
		expect(distinctSpeakers).toEqual(new Set(['Charles Kelsoe', 'Vijay Muniswamy']));
		expect(transcript?.segments).toHaveLength(3);
	});
});

// =============================================================================
// findNewerSummaryMarkdown — DD-004: swap Summary source (2026-04-14)
// =============================================================================

describe('findNewerSummaryMarkdown', () => {
	function fileDetailWithSummary(
		preDownload: unknown[],
	): Record<string, unknown> {
		return {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				pre_download_content_list: preDownload,
				extra_data: {},
			},
		};
	}

	// Real pre_download_content_list entries are keyed by `data_id`
	// (prefix "auto_sum:") and carry NO `data_type` field. The finder must
	// match on data_id; keying on data_type silently broke in 0.11.0.
	function autoSumNoteItem(
		content: unknown,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			data_id: 'auto_sum:xxx:abc123',
			data_content: content,
			...overrides,
		};
	}

	it('returns the newer summary markdown when an auto_sum_note entry is present', () => {
		const md =
			'**Participants:** Charles Kelsoe, Vijay Muniswamy\n\nKey points...';
		const raw = fileDetailWithSummary([autoSumNoteItem(md)]);
		const result = findNewerSummaryMarkdown(raw, '/file/detail/abc123');
		expect(result).toBe(md);
	});

	it('trims leading and trailing whitespace', () => {
		const raw = fileDetailWithSummary([autoSumNoteItem('   # Summary  \n  ')]);
		const result = findNewerSummaryMarkdown(raw, '/file/detail/abc123');
		expect(result).toBe('# Summary');
	});

	it('extracts ai_content from a JSON envelope data_content (newer shape)', () => {
		// The production wire shape: data_content is a JSON envelope, not bare
		// markdown. The markdown body lives under `ai_content`.
		const envelope = JSON.stringify({
			category: 'Meeting Minutes',
			summary_id: '20250801164611-v2@abc-1',
			ai_content: '> Date & Time\n## Overview\nBody text.',
		});
		const raw = fileDetailWithSummary([autoSumNoteItem(envelope)]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc123')).toBe(
			'> Date & Time\n## Overview\nBody text.',
		);
	});

	it('matches the auto_sum entry by data_id prefix, not data_type', () => {
		// Regression guard for the 0.11.0 silent summary loss: real entries
		// carry only a data_id like "auto_sum:<owner>:<fileId>" and no
		// data_type, so the finder must key on data_id.
		const raw = fileDetailWithSummary([
			{ data_id: 'auto_sum:owner:abc123', data_content: '## Real summary' },
		]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc123')).toBe(
			'## Real summary',
		);
	});

	it('returns a bare (non-JSON) markdown data_content verbatim', () => {
		const raw = fileDetailWithSummary([
			autoSumNoteItem('The transcript is brief, no summary is needed.'),
		]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc123')).toBe(
			'The transcript is brief, no summary is needed.',
		);
	});

	it('returns null when the JSON envelope ai_content trims to empty', () => {
		const raw = fileDetailWithSummary([
			autoSumNoteItem(JSON.stringify({ ai_content: '   ' })),
		]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc123')).toBeNull();
	});

	it('throws PlaudParseError when data_content looks like JSON but fails to parse', () => {
		const raw = fileDetailWithSummary([autoSumNoteItem('{ broken')]);
		expect(() =>
			findNewerSummaryMarkdown(raw, '/file/detail/abc123'),
		).toThrow(PlaudParseError);
	});

	it('throws PlaudParseError when the JSON envelope lacks an ai_content string', () => {
		const raw = fileDetailWithSummary([
			autoSumNoteItem(JSON.stringify({ category: 'x', summary_id: 'y' })),
		]);
		expect(() =>
			findNewerSummaryMarkdown(raw, '/file/detail/abc123'),
		).toThrow(PlaudParseError);
	});

	it('returns null when pre_download_content_list is absent', () => {
		const raw = { status: 0, data: { file_id: 'abc' } };
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when pre_download_content_list is empty', () => {
		const raw = fileDetailWithSummary([]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when no entry has an auto_sum: data_id', () => {
		const raw = fileDetailWithSummary([
			{ data_id: 'source_transaction:xxx', data_content: 'nope' },
		]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when auto_sum_note entry has no data_content string', () => {
		const raw = fileDetailWithSummary([autoSumNoteItem(null)]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when data_content is present but whitespace only', () => {
		const raw = fileDetailWithSummary([autoSumNoteItem('   \n  ')]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBeNull();
	});

	it('skips non-object items in the list gracefully', () => {
		const raw = fileDetailWithSummary([
			null,
			'string',
			42,
			autoSumNoteItem('real content'),
		]);
		expect(findNewerSummaryMarkdown(raw, '/file/detail/abc')).toBe('real content');
	});

	it('throws PlaudParseError when response body is not an object', () => {
		expect(() =>
			findNewerSummaryMarkdown('not an object', '/file/detail/abc'),
		).toThrow(PlaudParseError);
	});

	it('throws PlaudParseError when response.data is missing', () => {
		expect(() =>
			findNewerSummaryMarkdown({ status: 0 }, '/file/detail/abc'),
		).toThrow(PlaudParseError);
	});

	it('throws PlaudParseError when pre_download_content_list is not an array', () => {
		const raw = {
			status: 0,
			data: { pre_download_content_list: 'bogus' },
		};
		expect(() =>
			findNewerSummaryMarkdown(raw, '/file/detail/abc'),
		).toThrow(PlaudParseError);
	});
});

// =============================================================================
// findAiKeywords — DD-004: AI keywords → tags (2026-04-14)
// =============================================================================

describe('findAiKeywords', () => {
	function fileDetailWithKeywords(
		keywords: unknown,
	): Record<string, unknown> {
		return {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				extra_data: {
					aiContentHeader: {
						keywords,
					},
				},
			},
		};
	}

	it('returns the full keyword list when present', () => {
		const raw = fileDetailWithKeywords([
			'AI Agent',
			'Customer Data',
			'AWS Environment',
		]);
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([
			'AI Agent',
			'Customer Data',
			'AWS Environment',
		]);
	});

	it('trims whitespace and drops empty strings', () => {
		const raw = fileDetailWithKeywords([
			'  Good Tag  ',
			'',
			'   ',
			'Another',
		]);
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([
			'Good Tag',
			'Another',
		]);
	});

	it('silently drops non-string items so mid-field drift degrades gracefully', () => {
		const raw = fileDetailWithKeywords([
			'keep me',
			42,
			null,
			{ label: 'object drift' },
			'keep me too',
		]);
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([
			'keep me',
			'keep me too',
		]);
	});

	it('returns [] when extra_data is absent', () => {
		const raw = { status: 0, data: { file_id: 'abc' } };
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([]);
	});

	it('returns [] when aiContentHeader is absent', () => {
		const raw = { status: 0, data: { extra_data: {} } };
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([]);
	});

	it('returns [] when keywords field is absent', () => {
		const raw = {
			status: 0,
			data: { extra_data: { aiContentHeader: {} } },
		};
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([]);
	});

	it('returns [] when keywords is not an array', () => {
		const raw = {
			status: 0,
			data: { extra_data: { aiContentHeader: { keywords: 'bogus' } } },
		};
		expect(findAiKeywords(raw, '/file/detail/abc')).toEqual([]);
	});

	it('throws PlaudParseError when response body is not an object', () => {
		expect(() => findAiKeywords('nope', '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when response.data is missing', () => {
		expect(() => findAiKeywords({ status: 0 }, '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});
});

// =============================================================================
// findAttachmentAssets — supplemental downloadable assets from /file/detail
// =============================================================================

describe('findAttachmentAssets', () => {
	function fileDetailWithAssets(
		contentList: unknown,
		preDownloadList?: unknown,
	): Record<string, unknown> {
		return {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				content_list: contentList,
				pre_download_content_list: preDownloadList,
			},
		};
	}

	it('returns unknown data_type entries with data_link URLs', () => {
		const raw = fileDetailWithAssets([
			{ data_type: 'transaction', task_status: 1, data_link: 'https://s3/raw' },
			{ data_type: 'transaction_polish', task_status: 1, data_link: 'https://s3/polish' },
			{
				data_type: 'screenshot',
				task_status: 1,
				data_link: 'https://s3/shot1.png?sig=x',
				file_name: 'screenshot-1',
				mime_type: 'image/png',
			},
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{
				dataType: 'screenshot',
				url: 'https://s3/shot1.png?sig=x',
				name: 'screenshot-1',
				mimeType: 'image/png',
			},
		]);
	});

	it('collects from both content_list and pre_download_content_list', () => {
		const raw = fileDetailWithAssets(
			[
				{ data_type: 'slide_image', task_status: 1, data_link: 'https://s3/a.png' },
			],
			[
				{ data_type: 'screen_capture', task_status: 1, data_link: 'https://s3/b.png' },
			],
		);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{ dataType: 'slide_image', url: 'https://s3/a.png', name: undefined, mimeType: undefined },
			{ dataType: 'screen_capture', url: 'https://s3/b.png', name: undefined, mimeType: undefined },
		]);
	});

	it('drops entries that are not task_status=1 when task_status is present', () => {
		const raw = fileDetailWithAssets([
			{ data_type: 'screenshot', task_status: 0, data_link: 'https://s3/not-ready' },
			{ data_type: 'screenshot', task_status: 2, data_link: 'https://s3/failed' },
			{ data_type: 'screenshot', task_status: 1, data_link: 'https://s3/ready' },
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{ dataType: 'screenshot', url: 'https://s3/ready', name: undefined, mimeType: undefined },
		]);
	});

	it('deduplicates repeated URLs', () => {
		const raw = fileDetailWithAssets([
			{ data_type: 'screenshot', task_status: 1, data_link: 'https://s3/a' },
			{ data_type: 'screen_capture', task_status: 1, data_link: 'https://s3/a' },
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{ dataType: 'screenshot', url: 'https://s3/a', name: undefined, mimeType: undefined },
		]);
	});

	it('extracts attachment URLs from data_content when data_link is absent', () => {
		const raw = fileDetailWithAssets([
			{
				data_type: 'mindmap_asset',
				task_status: 1,
				file_name: 'mindmap',
				data_content: {
					url: 'https://cdn.example.com/mindmap-1.png?sig=x',
				},
			},
			{
				data_type: 'card_asset',
				task_status: 1,
				file_name: 'card',
				data_content: JSON.stringify({
					picture_link: 'https://cdn.example.com/card-1.png?sig=x',
				}),
			},
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{
				dataType: 'mindmap_asset',
				url: 'https://cdn.example.com/mindmap-1.png?sig=x',
				name: 'mindmap',
				mimeType: undefined,
			},
			{
				dataType: 'card_asset',
				url: 'https://cdn.example.com/card-1.png?sig=x',
				name: 'card',
				mimeType: undefined,
			},
		]);
	});

	it('keeps relative permanent paths discovered in data_content', () => {
		const raw = fileDetailWithAssets([
			{
				data_type: 'mindmap_asset',
				task_status: 1,
				data_content: {
					file_path: 'permanent/abc123/mindmap/result.png',
				},
			},
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{
				dataType: 'mindmap_asset',
				url: 'permanent/abc123/mindmap/result.png',
				name: undefined,
				mimeType: undefined,
			},
		]);
	});

	it('collects attachment links from download_link_map and infers card/mindmap types', () => {
		const raw = {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				content_list: [],
				pre_download_content_list: [],
				download_link_map: {
					'permanent/abc/mindmap/result.png': 'https://cdn.example.com/mindmap.png?sig=x',
					'permanent/abc/card/result.png': 'https://cdn.example.com/card.png?sig=x',
				},
			},
		};
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{
				dataType: 'mindmap',
				url: 'https://cdn.example.com/mindmap.png?sig=x',
				name: 'result.png',
				mimeType: undefined,
			},
			{
				dataType: 'card',
				url: 'https://cdn.example.com/card.png?sig=x',
				name: 'result.png',
				mimeType: undefined,
			},
		]);
	});

	it('rejects gzipped pipeline data blobs from download maps so they do not leak in as .gz attachments', () => {
		// Regression: older recordings carried the transcript/outline/summary
		// data files (.json.gz / .md.gz) in download_path_mapping. Without a
		// guard these surfaced as bogus "File N" .gz attachment links. A real
		// card PNG in the same map must still come through.
		const raw = {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				content_list: [],
				pre_download_content_list: [],
				download_path_mapping: {
					'permanent/abc/file_transcript/abc/trans_result.json.gz':
						'https://cdn.example.com/trans_result.json.gz?sig=x',
					'permanent/abc/file_outline/abc/outline.json.gz':
						'https://cdn.example.com/outline.json.gz?sig=x',
					'permanent/abc/file_summary/abc/ai_content.md.gz':
						'https://cdn.example.com/ai_content.md.gz?sig=x',
					'permanent/abc/card/result.png': 'https://cdn.example.com/card.png?sig=x',
				},
			},
		};
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([
			{
				dataType: 'card',
				url: 'https://cdn.example.com/card.png?sig=x',
				name: 'result.png',
				mimeType: undefined,
			},
		]);
	});

	it('rejects gzipped pipeline data blobs carried on content_list entries with non-pipeline data_types', () => {
		// Defense in depth: even if an entry is NOT one of the excluded
		// pipeline data_types, a .gz data_link is still not an attachment.
		const raw = fileDetailWithAssets([
			{
				data_type: 'source',
				task_status: 1,
				data_link:
					'https://cdn.example.com/permanent/abc/file_transcript/abc/trans_result.json.gz?sig=x',
			},
		]);
		expect(findAttachmentAssets(raw, '/file/detail/abc')).toEqual([]);
	});

	it('throws PlaudParseError when response body is not an object', () => {
		expect(() => findAttachmentAssets('nope', '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when response.data is missing', () => {
		expect(() => findAttachmentAssets({ status: 0 }, '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});
});

// =============================================================================
// getTranscriptAndSummary — DD-004: newer-summary + keyword propagation
// =============================================================================

describe('getTranscriptAndSummary DD-004 paths', () => {
	function fileDetailFull(options: {
		readonly polishUrl?: string;
		readonly outlineUrl?: string;
		readonly newerSummary?: string;
		readonly keywords?: readonly string[];
		readonly attachments?: ReadonlyArray<{
			readonly dataType: string;
			readonly url: string;
			readonly name?: string;
			readonly mimeType?: string;
		}>;
	}): Record<string, unknown> {
		const contentList: unknown[] = [];
		if (options.polishUrl !== undefined) {
			contentList.push({
				data_type: 'transaction_polish',
				task_status: 1,
				data_link: options.polishUrl,
			});
		}
		if (options.outlineUrl !== undefined) {
			contentList.push({
				data_type: 'outline',
				task_status: 1,
				data_link: options.outlineUrl,
			});
		}
		for (const attachment of options.attachments ?? []) {
			contentList.push({
				data_type: attachment.dataType,
				task_status: 1,
				data_link: attachment.url,
				file_name: attachment.name,
				mime_type: attachment.mimeType,
			});
		}
		const preDownload: unknown[] = [];
		if (options.newerSummary !== undefined) {
			preDownload.push({
				data_id: 'auto_sum:owner:abc123',
				data_content: options.newerSummary,
			});
		}
		const extraData: Record<string, unknown> = {};
		if (options.keywords !== undefined) {
			extraData.aiContentHeader = { keywords: options.keywords };
		}
		return {
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				content_list: contentList,
				pre_download_content_list: preDownload,
				extra_data: extraData,
			},
		};
	}

	it('prefers the newer auto_sum_note summary over the legacy /ai/transsumm/ summary', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()), // legacy summary says "Key points..."
			detail: ok(
				fileDetailFull({
					newerSummary:
						'**Participants:** Charles Kelsoe, Vijay Muniswamy\n\nNewer summary body.',
				}),
			),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.summary?.text).toContain('Vijay Muniswamy');
		expect(result.summary?.text).toContain('Newer summary body.');
		expect(result.summary?.text).not.toContain('Key points');
	});

	it('falls back to the legacy summary when /file/detail/ has no auto_sum_note entry', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailFull({})), // no newerSummary
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.summary?.text).toContain('Key points');
	});

	it('falls back to the legacy summary when /file/detail/ itself throws', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			throwOn: 'detail',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.summary?.text).toContain('Key points');
	});

	it('extracts ai_content when the newer summary is a JSON envelope', async () => {
		// The real production wire shape: data_content is a JSON envelope and
		// the markdown body lives under `ai_content`.
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()), // legacy summary says "Key points..."
			detail: ok(
				fileDetailFull({
					newerSummary: JSON.stringify({
						category: 'Meeting Minutes',
						summary_id: 'sid-1',
						ai_content: '**Participants:** Charles, Vijay\n\nEnvelope body.',
					}),
				}),
			),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.summary?.text).toBe(
			'**Participants:** Charles, Vijay\n\nEnvelope body.',
		);
		expect(result.summary?.text).not.toContain('Key points');
	});

	it('keeps the polished transcript when the newer summary envelope is malformed', async () => {
		// Robustness: a drift in the auto_sum data_content (here, broken JSON)
		// must not abort the bundle and take the polished transcript down with
		// it. The summary throw is isolated inside fetchFileDetailBundle; the
		// transcript still resolves to the polish file and the summary falls
		// back to the legacy /ai/transsumm body.
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(
				fileDetailFull({
					polishUrl: 'https://s3/polish?sig=x',
					newerSummary: '{ "ai_content": broken',
				}),
			),
			polish: ok([polishedSegment({ speaker: 'Charles Kelsoe', content: 'Hi.' })]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const { transcript, summary } = await client.getTranscriptAndSummary(ID);

		expect(transcript?.segments.map((s) => s.speaker)).toEqual([
			'Charles Kelsoe',
		]);
		expect(summary?.text).toContain('Key points');
	});

	it('propagates AI keywords on the result when present', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(
				fileDetailFull({
					keywords: ['AI Agent', 'Customer Data', 'AWS Environment'],
				}),
			),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.aiKeywords).toEqual([
			'AI Agent',
			'Customer Data',
			'AWS Environment',
		]);
	});

	it('returns undefined aiKeywords when the keyword list is empty', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailFull({ keywords: [] })),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.aiKeywords).toBeUndefined();
	});

	it('returns undefined aiKeywords when /file/detail/ throws', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			throwOn: 'detail',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.aiKeywords).toBeUndefined();
	});

	it('propagates chapters on the result when /file/detail/ has an outline link and the parser recognizes the body', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailFull({ outlineUrl: 'https://s3/outline?sig=x' })),
		});
		// Override the routeFetcher default for the outline hop by passing
		// through polish route (it's a catch-all for "anything else").
		const client = new ReverseEngineeredPlaudClient(
			() => 'tok',
			async (req) => {
				if (req.url.includes('/ai/transsumm/')) {
					return ok(transsummEnvelope());
				}
				if (req.url.includes('/file/detail/')) {
					return ok(
						fileDetailFull({ outlineUrl: 'https://s3/outline?sig=x' }),
					);
				}
				if (req.url.includes('outline')) {
					return ok([
						{ title: 'Introduction', start_time: 0, end_time: 60000 },
						{ title: 'Main topic', start_time: 60000, end_time: 180000 },
						{ title: 'Wrap up', start_time: 180000, end_time: 240000 },
					]);
				}
				return fetcher(req);
			},
		);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.chapters).toEqual([
			{ title: 'Introduction', startSeconds: 0, endSeconds: 60 },
			{ title: 'Main topic', startSeconds: 60, endSeconds: 180 },
			{ title: 'Wrap up', startSeconds: 180, endSeconds: 240 },
		]);
	});

	it('returns undefined chapters when /file/detail/ has no outline link', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(fileDetailFull({})), // no outlineUrl
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.chapters).toBeUndefined();
	});

	it('returns undefined chapters when /file/detail/ throws', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			throwOn: 'detail',
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.chapters).toBeUndefined();
	});

	it('propagates supplemental attachment assets discovered from /file/detail/', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(
				fileDetailFull({
					attachments: [
						{
							dataType: 'screenshot',
							url: 'https://s3/screens/1.png?sig=x',
							name: 'screen-1',
							mimeType: 'image/png',
						},
						{
							dataType: 'slide_image',
							url: 'https://s3/screens/2.jpg?sig=x',
							name: 'slide-2',
							mimeType: 'image/jpeg',
						},
					],
				}),
			),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.attachments).toEqual([
			{
				dataType: 'screenshot',
				url: 'https://s3/screens/1.png?sig=x',
				name: 'screen-1',
				mimeType: 'image/png',
			},
			{
				dataType: 'slide_image',
				url: 'https://s3/screens/2.jpg?sig=x',
				name: 'slide-2',
				mimeType: 'image/jpeg',
			},
		]);
	});

	it('combines all three DD-004 sources in one successful call', async () => {
		// End-to-end regression: polished transcript + newer summary + keywords
		// all arrive on the result from a single /file/detail/ round trip.
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok(
				fileDetailFull({
					polishUrl: 'https://s3/polish?sig=x',
					newerSummary: '**Participants:** Charles, Vijay\n\nNew body.',
					keywords: ['Topic A', 'Topic B'],
				}),
			),
			polish: ok([
				polishedSegment({
					speaker: 'Charles Kelsoe',
					original_speaker: 'Speaker 1',
				}),
				polishedSegment({
					start_time: 1000,
					end_time: 2000,
					speaker: 'Vijay Muniswamy',
					original_speaker: 'Speaker 2',
				}),
			]),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.transcript?.segments.map((s) => s.speaker)).toEqual([
			'Charles Kelsoe',
			'Vijay Muniswamy',
		]);
		expect(result.summary?.text).toContain('New body.');
		expect(result.aiKeywords).toEqual(['Topic A', 'Topic B']);
	});
});

// =============================================================================
// findOutlineLink — DD-004 item 2: chapters (2026-04-14)
// =============================================================================

describe('findOutlineLink', () => {
	function fileDetailOutline(contentList: unknown[]): Record<string, unknown> {
		return {
			status: 0,
			msg: 'success',
			data: { file_id: 'abc123', content_list: contentList, extra_data: {} },
		};
	}

	function outlineItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			data_type: 'outline',
			task_status: 1,
			data_link: 'https://s3.amazonaws.com/outline.json?X-Amz-Signature=fake',
			...overrides,
		};
	}

	it('returns the outline data_link when a successful outline entry exists', () => {
		const raw = fileDetailOutline([
			{ data_type: 'transaction', task_status: 1, data_link: 'https://s3/raw' },
			outlineItem(),
		]);
		const link = findOutlineLink(raw, '/file/detail/abc123');
		expect(link).toBe('https://s3.amazonaws.com/outline.json?X-Amz-Signature=fake');
	});

	it('returns null when content_list has no outline entry', () => {
		const raw = fileDetailOutline([
			{ data_type: 'transaction', task_status: 1, data_link: 'https://s3/raw' },
		]);
		expect(findOutlineLink(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when outline task_status is not 1', () => {
		const raw = fileDetailOutline([outlineItem({ task_status: 0 })]);
		expect(findOutlineLink(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when outline entry has empty data_link', () => {
		const raw = fileDetailOutline([outlineItem({ data_link: '' })]);
		expect(findOutlineLink(raw, '/file/detail/abc')).toBeNull();
	});

	it('returns null when content_list is absent', () => {
		const raw = { status: 0, data: { file_id: 'abc' } };
		expect(findOutlineLink(raw, '/file/detail/abc')).toBeNull();
	});

	it('throws PlaudParseError when response body is not an object', () => {
		expect(() => findOutlineLink('nope', '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});

	it('throws PlaudParseError when content_list is not an array', () => {
		const raw = { status: 0, data: { content_list: 'bogus' } };
		expect(() => findOutlineLink(raw, '/file/detail/abc')).toThrow(
			PlaudParseError,
		);
	});
});

// =============================================================================
// parseOutlineBody — DD-004 item 2: defensive multi-shape parser
// =============================================================================

describe('parseOutlineBody', () => {
	it('parses a bare array of {title, start_time, end_time} in ms', () => {
		const raw = [
			{ title: 'Intro', start_time: 0, end_time: 60000 },
			{ title: 'Body', start_time: 60000, end_time: 180000 },
		];
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0, endSeconds: 60 },
			{ title: 'Body', startSeconds: 60, endSeconds: 180 },
		]);
	});

	it('accepts alternate title keys (heading, name, topic)', () => {
		expect(
			parseOutlineBody([
				{ heading: 'A', start_time: 0 },
				{ name: 'B', start_time: 1000 },
				{ topic: 'C', start_time: 2000 },
			]),
		).toEqual([
			{ title: 'A', startSeconds: 0 },
			{ title: 'B', startSeconds: 1 },
			{ title: 'C', startSeconds: 2 },
		]);
	});

	it('accepts alternate start keys (startTime, start, start_ms, begin)', () => {
		expect(
			parseOutlineBody([
				{ title: 'A', startTime: 0 },
				{ title: 'B', start: 1000 },
				{ title: 'C', start_ms: 2000 },
				{ title: 'D', begin: 3000 },
			]),
		).toEqual([
			{ title: 'A', startSeconds: 0 },
			{ title: 'B', startSeconds: 1 },
			{ title: 'C', startSeconds: 2 },
			{ title: 'D', startSeconds: 3 },
		]);
	});

	it('accepts string-encoded numeric timestamps', () => {
		expect(
			parseOutlineBody([{ title: 'A', start_time: '5000', end_time: '10000' }]),
		).toEqual([{ title: 'A', startSeconds: 5, endSeconds: 10 }]);
	});

	it('parses a JSON-encoded string wrapping a bare array', () => {
		const raw = JSON.stringify([{ title: 'Intro', start_time: 0 }]);
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0 },
		]);
	});

	it('unwraps an envelope { content: [...] }', () => {
		const raw = { content: [{ title: 'Intro', start_time: 0 }] };
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0 },
		]);
	});

	it('unwraps a nested envelope { content: { topics: [...] } }', () => {
		const raw = {
			content: { topics: [{ title: 'Intro', start_time: 0 }] },
		};
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0 },
		]);
	});

	it('unwraps { content: { outline: [...] } }', () => {
		const raw = {
			content: { outline: [{ title: 'Intro', start_time: 0 }] },
		};
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0 },
		]);
	});

	it('unwraps a string-encoded content field (JSON of JSON)', () => {
		const raw = {
			content: JSON.stringify([{ title: 'Intro', start_time: 0 }]),
		};
		expect(parseOutlineBody(raw)).toEqual([
			{ title: 'Intro', startSeconds: 0 },
		]);
	});

	it('returns [] for an unrecognized shape', () => {
		expect(parseOutlineBody({ garbage: true })).toEqual([]);
		expect(parseOutlineBody(42)).toEqual([]);
		expect(parseOutlineBody(null)).toEqual([]);
	});

	it('returns [] for a malformed JSON string', () => {
		expect(parseOutlineBody('not json {{{')).toEqual([]);
	});

	it('drops entries without a title', () => {
		expect(
			parseOutlineBody([
				{ start_time: 0 },
				{ title: 'Keep me', start_time: 1000 },
				{ title: '   ', start_time: 2000 },
			]),
		).toEqual([{ title: 'Keep me', startSeconds: 1 }]);
	});

	it('drops entries without a finite start time', () => {
		expect(
			parseOutlineBody([
				{ title: 'No start' },
				{ title: 'Bad start', start_time: 'xyz' },
				{ title: 'Keep', start_time: 1000 },
			]),
		).toEqual([{ title: 'Keep', startSeconds: 1 }]);
	});

	it('preserves ordering from the source array', () => {
		expect(
			parseOutlineBody([
				{ title: 'Third', start_time: 180000 },
				{ title: 'First', start_time: 0 },
				{ title: 'Second', start_time: 60000 },
			]),
		).toEqual([
			{ title: 'Third', startSeconds: 180 },
			{ title: 'First', startSeconds: 0 },
			{ title: 'Second', startSeconds: 60 },
		]);
	});
});

describe('findConsumerNoteEntries', () => {
	function fileDetail(contentList: unknown[]): Record<string, unknown> {
		return {
			status: 0,
			data: { file_id: 'abc123', content_list: contentList },
		};
	}

	const KEY_POINTS_LINK =
		'https://s3.amazonaws.com/key-points.md?X-Amz-Signature=fake';

	function consumerNoteItem(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			data_id: 'note:899720e9:abc123',
			data_type: 'consumer_note',
			task_status: 1,
			data_tab_name: 'Key Points',
			data_title: 'Key Points for the meeting',
			data_link: KEY_POINTS_LINK,
			extra: {
				used_template: { template_name: 'Key Points', template_type: 'official' },
			},
			...overrides,
		};
	}

	it('returns the template name and link for each ready entry, in order', () => {
		const journalLink = 'https://s3.amazonaws.com/journal.md?X-Amz-Signature=fake';
		const raw = fileDetail([
			consumerNoteItem(),
			consumerNoteItem({
				data_link: journalLink,
				extra: { used_template: { template_name: 'Daily Journal' } },
			}),
		]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([
			{ heading: 'Key Points', dataLink: KEY_POINTS_LINK },
			{ heading: 'Daily Journal', dataLink: journalLink },
		]);
	});

	it('uses the template name as the heading, even when the tab label differs', () => {
		const raw = fileDetail([
			consumerNoteItem({
				data_tab_name: 'Note',
				extra: { used_template: { template_name: 'Meeting Summary' } },
			}),
		]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([
			{ heading: 'Meeting Summary', dataLink: KEY_POINTS_LINK },
		]);
	});

	it('skips entries that are not yet ready (task_status !== 1)', () => {
		const raw = fileDetail([consumerNoteItem({ task_status: 0 })]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([]);
	});

	it('skips entries with no usable data_link', () => {
		const raw = fileDetail([consumerNoteItem({ data_link: '' })]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([]);
	});

	it('ignores content types other than consumer_note', () => {
		const raw = fileDetail([
			{
				data_type: 'transaction',
				task_status: 1,
				data_link: 'https://s3.amazonaws.com/raw.json?X-Amz-Signature=fake',
			},
			consumerNoteItem(),
		]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([
			{ heading: 'Key Points', dataLink: KEY_POINTS_LINK },
		]);
	});

	it('falls back to tab label, then title, then a generic label, when no template name', () => {
		const link2 = 'https://s3.amazonaws.com/x2.md?X-Amz-Signature=fake';
		const link3 = 'https://s3.amazonaws.com/x3.md?X-Amz-Signature=fake';
		const raw = fileDetail([
			// No used_template -> fall back to the tab label.
			consumerNoteItem({ extra: {} }),
			// No template name and no tab label -> fall back to the entry title.
			consumerNoteItem({ extra: {}, data_tab_name: undefined, data_link: link2 }),
			// Nothing usable -> generic label.
			consumerNoteItem({
				extra: {},
				data_tab_name: undefined,
				data_title: undefined,
				data_link: link3,
			}),
		]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([
			{ heading: 'Key Points', dataLink: KEY_POINTS_LINK },
			{ heading: 'Key Points for the meeting', dataLink: link2 },
			{ heading: 'Template output', dataLink: link3 },
		]);
	});

	it('de-duplicates entries that share a data_link', () => {
		const raw = fileDetail([consumerNoteItem(), consumerNoteItem()]);
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toHaveLength(1);
	});

	it('returns [] when content_list is absent', () => {
		const raw = { status: 0, data: { file_id: 'abc123' } };
		expect(findConsumerNoteEntries(raw, '/file/detail/abc123')).toEqual([]);
	});

	it('is excluded from findAttachmentAssets so it never downloads as a binary file', () => {
		const raw = fileDetail([
			consumerNoteItem(),
			{
				data_type: 'screenshot',
				task_status: 1,
				data_link: 'https://s3.amazonaws.com/shot.png?X-Amz-Signature=fake',
			},
		]);
		const dataTypes = findAttachmentAssets(raw, '/file/detail/abc123').map(
			(asset) => asset.dataType,
		);
		expect(dataTypes).not.toContain('consumer_note');
		expect(dataTypes).toContain('screenshot');
	});
});

describe('getTranscriptAndSummary consumer_note template outputs', () => {
	it('fetches each consumer_note body and surfaces it on the returned bundle', async () => {
		// Regression guard: the bundle assembled inside fetchFileDetailBundle
		// must actually be surfaced on the TranscriptAndSummary return. Because
		// consumerNotes is optional, an omission compiles clean — this end-to-end
		// test is what proves the field reaches the caller.
		const detail = ok({
			status: 0,
			msg: 'success',
			data: {
				file_id: 'abc123',
				content_list: [
					{
						data_type: 'consumer_note',
						task_status: 1,
						data_tab_name: 'Key Points',
						data_link: 'https://s3/key-points.md?sig=x',
					},
				],
			},
		});
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail,
			// The consumer_note body is the only non-transsumm/non-detail fetch,
			// so it routes here; served as raw text/plain Markdown, not JSON.
			polish: { status: 200, json: null, text: '- Point one\n- Point two' },
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.consumerNotes).toEqual([
			{ heading: 'Key Points', markdown: '- Point one\n- Point two' },
		]);
	});

	it('omits consumerNotes when the recording has none', async () => {
		const { fetcher } = routeFetcher({
			transsumm: ok(transsummEnvelope()),
			detail: ok({ status: 0, data: { file_id: 'abc123', content_list: [] } }),
		});
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.consumerNotes).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getAudioTempUrl: GET /file/temp-url/{id}
// ---------------------------------------------------------------------------

function audioTempUrlEnvelope(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		status: 0,
		msg: 'success',
		data: {
			temp_url: 'https://s3.amazonaws.com/rec.ogg?X-Amz-Signature=fake',
			temp_url_opus: '',
			...overrides,
		},
	};
}

describe('getAudioTempUrl request shape', () => {
	it('issues an authenticated GET against /file/temp-url/{id}', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(audioTempUrlEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'my-jwt', fetcher);

		await client.getAudioTempUrl(ID);

		const req = lastRequest();
		expect(req?.method ?? 'GET').toBe('GET');
		expect(req?.url).toBe('https://api.plaud.ai/file/temp-url/rec-abc-123');
		expect(req?.headers.Authorization).toBe('Bearer my-jwt');
	});

	it('URL-encodes the recording id', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(audioTempUrlEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getAudioTempUrl('id with/slash' as PlaudRecordingId);

		expect(lastRequest()?.url).toBe(
			'https://api.plaud.ai/file/temp-url/id%20with%2Fslash',
		);
	});

	it('returns the presigned temp_url from the data envelope', async () => {
		const { fetcher } = captureFetcher(ok(audioTempUrlEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		const url = await client.getAudioTempUrl(ID);

		expect(url).toBe('https://s3.amazonaws.com/rec.ogg?X-Amz-Signature=fake');
	});

	it('returns null when temp_url is missing or empty', async () => {
		const { fetcher } = captureFetcher(ok(audioTempUrlEnvelope({ temp_url: '' })));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		expect(await client.getAudioTempUrl(ID)).toBeNull();
	});
});

describe('parseAudioTempUrl', () => {
	it('extracts temp_url from a well-formed envelope', () => {
		expect(
			parseAudioTempUrl(
				{ data: { temp_url: 'https://s3/audio.ogg' } },
				'/file/temp-url/x',
			),
		).toBe('https://s3/audio.ogg');
	});

	it('returns null for a missing, empty, or non-string temp_url', () => {
		expect(parseAudioTempUrl({ data: {} }, '/file/temp-url/x')).toBeNull();
		expect(parseAudioTempUrl({ data: { temp_url: '   ' } }, '/file/temp-url/x')).toBeNull();
		expect(parseAudioTempUrl({ data: { temp_url: 42 } }, '/file/temp-url/x')).toBeNull();
	});

	it('throws PlaudParseError on a structurally invalid envelope', () => {
		expect(() => parseAudioTempUrl({}, '/file/temp-url/x')).toThrow(PlaudParseError);
		expect(() => parseAudioTempUrl(null, '/file/temp-url/x')).toThrow(PlaudParseError);
	});
});
