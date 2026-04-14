import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
	ReverseEngineeredPlaudClient,
	type PlaudHttpFetcher,
	type PlaudHttpRequest,
	type PlaudHttpResponse,
} from '../plaud-client-re';

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
		// Plaud's /file/simple/web returns start_time as unix MILLISECONDS.
		// Commit 4c corrected this after real-API testing — the initial
		// assumption was seconds (from stale research notes).
		start_time: 1744628400000, // 2025-04-14 11:00 UTC (unix ms)
		end_time: 1744629000000,
		duration: 600,
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
} {
	let captured: PlaudHttpRequest | undefined;
	const fetcher: PlaudHttpFetcher = async (req) => {
		captured = req;
		return response;
	};
	return { fetcher, lastRequest: () => captured };
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
	it('issues POST against /ai/transsumm/{id} with empty JSON body', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary(ID);

		const req = lastRequest();
		expect(req?.method).toBe('POST');
		expect(req?.url).toBe('https://api.plaud.ai/ai/transsumm/rec-abc-123');
		expect(req?.body).toBe('{}');
	});

	it('sends Content-Type: application/json when a body is present', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary(ID);

		expect(lastRequest()?.headers['Content-Type']).toBe('application/json');
	});

	it('still sends Authorization Bearer header', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'my-jwt', fetcher);

		await client.getTranscriptAndSummary(ID);

		expect(lastRequest()?.headers.Authorization).toBe('Bearer my-jwt');
	});

	it('URL-encodes the recording id', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(transsummEnvelope()));
		const client = new ReverseEngineeredPlaudClient(() => 'tok', fetcher);

		await client.getTranscriptAndSummary('id with/slash' as PlaudRecordingId);

		expect(lastRequest()?.url).toBe(
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
