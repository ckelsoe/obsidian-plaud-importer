import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
	ReverseEngineeredPlaudClient,
	findTransactionPolishLink,
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

// data_result_summ shape variations (the four-shape trap) -------------------

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
	it('throws PlaudParseError when end_time is before start_time', async () => {
		const { fetcher } = captureFetcher(
			ok(transsummEnvelope({
				data_result: [
					{ start_time: 10000, end_time: 5000, content: 'backwards', speaker: '' },
				],
			})),
		);
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await expect(client.getTranscriptAndSummary(ID)).rejects.toThrow(
			/end_time.*before.*start_time/,
		);
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
		// Summary still comes from /ai/transsumm/ — the polish flow
		// only overrides the transcript, not the summary source.
		expect(summary?.text).toContain('Key points');
		// All three endpoints should have been called.
		const urls = requests().map((r) => r.url);
		expect(urls.some((u) => u.includes('/ai/transsumm/'))).toBe(true);
		expect(urls.some((u) => u.includes('/file/detail/'))).toBe(true);
		expect(urls.some((u) => u.includes('/polish'))).toBe(true);
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
