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
		start_time: 1744628400, // 2025-04-14 11:00 UTC (unix seconds)
		end_time: 1744629000,
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

// Constructor ---------------------------------------------------------------

describe('ReverseEngineeredPlaudClient constructor', () => {
	const fetcher: PlaudHttpFetcher = async () => ok(listEnvelope([]));

	it('throws when token is empty', () => {
		expect(() => new ReverseEngineeredPlaudClient('', fetcher)).toThrow(/token is required/);
	});

	it('throws when token is whitespace-only', () => {
		expect(() => new ReverseEngineeredPlaudClient('   ', fetcher)).toThrow(/token is required/);
	});

	it('trims surrounding whitespace from the token', async () => {
		const { fetcher: f, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('  my-jwt  ', f);
		await client.listRecordings();
		expect(lastRequest()?.headers.Authorization).toBe('Bearer my-jwt');
	});
});

// listRecordings — happy path -----------------------------------------------

describe('listRecordings happy path', () => {
	it('returns a normalized Recording for each raw item', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record()])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings();

		expect(result).toHaveLength(1);
		const r = result[0];
		expect(r.id).toBe('abc123');
		expect(r.title).toBe('Morning standup');
		expect(r.durationSeconds).toBe(600);
		expect(r.transcriptAvailable).toBe(true);
		expect(r.summaryAvailable).toBe(true);
		// start_time is seconds on the wire; createdAt is a Date in millis.
		expect(r.createdAt.getTime()).toBe(1744628400 * 1000);
	});

	it('returns an empty array when the list is empty', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings();

		expect(result).toEqual([]);
	});

	it('maps optional tags from filetag_id_list', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ filetag_id_list: ['tag-a', 'tag-b'] })])),
		);
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.tags).toEqual(['tag-a', 'tag-b']);
	});

	it('leaves tags undefined when filetag_id_list is missing', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([record()])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const [r] = await client.listRecordings();

		expect(r.tags).toBeUndefined();
	});
});

// listRecordings — request shape --------------------------------------------

describe('listRecordings request shape', () => {
	it('targets /file/simple/web on api.plaud.ai by default', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await client.listRecordings();

		const req = lastRequest();
		expect(req?.url).toMatch(/^https:\/\/api\.plaud\.ai\/file\/simple\/web\?/);
	});

	it('respects a custom baseUrl for region overrides', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher, {
			baseUrl: 'https://api-euc1.plaud.ai',
		});

		await client.listRecordings();

		expect(lastRequest()?.url).toMatch(/^https:\/\/api-euc1\.plaud\.ai\//);
	});

	it('sends Authorization: Bearer and standard headers', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('my-jwt', fetcher);

		await client.listRecordings();

		const headers = lastRequest()?.headers ?? {};
		expect(headers.Authorization).toBe('Bearer my-jwt');
		expect(headers.Accept).toBe('application/json');
		expect(headers['User-Agent']).toMatch(/obsidian-plaud-importer/);
	});

	it('sends the documented query params (skip, limit, is_trash, sort_by, is_desc)', async () => {
		const { fetcher, lastRequest } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

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
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await client.listRecordings({ limit: 10 });

		const url = new URL(lastRequest()?.url ?? '');
		expect(url.searchParams.get('limit')).toBe('10');
	});
});

// listRecordings — filter behavior ------------------------------------------

describe('listRecordings filter behavior', () => {
	function threeRecords(): Record<string, unknown>[] {
		return [
			record({ id: 'r1', start_time: 1700000000, is_trans: true }),
			record({ id: 'r2', start_time: 1720000000, is_trans: false }),
			record({ id: 'r3', start_time: 1740000000, is_trans: true }),
		];
	}

	it('filters out recordings with hasTranscript=false when filter.hasTranscript=true', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings({ hasTranscript: true });

		expect(result.map((r) => r.id)).toEqual(['r1', 'r3']);
	});

	it('filters by since date', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		// 1720000000 unix seconds = 2024-07-03 11:46:40 UTC
		const result = await client.listRecordings({ since: new Date(1720000000 * 1000) });

		expect(result.map((r) => r.id)).toEqual(['r2', 'r3']);
	});

	it('filters by until date', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope(threeRecords())));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings({ until: new Date(1720000000 * 1000) });

		expect(result.map((r) => r.id)).toEqual(['r1', 'r2']);
	});
});

// listRecordings — HTTP status handling ------------------------------------

describe('listRecordings HTTP status handling', () => {
	it('throws PlaudAuthError on HTTP 401', async () => {
		const { fetcher } = captureFetcher(status(401));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudAuthError);
	});

	it('throws PlaudApiError with status 500 on HTTP 500', async () => {
		const { fetcher } = captureFetcher(status(500));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toMatchObject({
			status: 500,
		});
	});

	it('throws PlaudApiError with status 429 on HTTP 429 (rate limit)', async () => {
		const { fetcher } = captureFetcher(status(429));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toMatchObject({
			status: 429,
		});
	});

	it('throws PlaudApiError on HTTP 503 with the status in the message', async () => {
		const { fetcher } = captureFetcher(status(503));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/503/);
	});

	it('treats HTTP 204 as an empty list', async () => {
		const { fetcher } = captureFetcher({ status: 204, json: null, text: '' });
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings();
		expect(result).toEqual([]);
	});

	it('throws PlaudParseError when a 2xx response has a null body', async () => {
		const { fetcher } = captureFetcher({
			status: 200,
			json: null,
			text: '<html>cloudflare challenge</html>',
		});
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('wraps a fetcher-thrown network error in PlaudApiError', async () => {
		const fetcher: PlaudHttpFetcher = async () => {
			throw new Error('ECONNRESET');
		};
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudApiError);
	});
});

// listRecordings — parse errors ---------------------------------------------

describe('listRecordings parse errors', () => {
	it('throws PlaudParseError when envelope is missing data_file_list', async () => {
		const { fetcher } = captureFetcher(ok({ status: 0, msg: 'ok' }));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when envelope is an array (not an object)', async () => {
		const { fetcher } = captureFetcher(ok([]));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('throws PlaudParseError when a record is missing required fields', async () => {
		const { fetcher } = captureFetcher(
			ok(listEnvelope([{ id: 'abc', filename: 'broken' /* missing rest */ }])),
		);
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

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
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('rejects start_time beyond year 2100 as likely milliseconds-mistaken-for-seconds', async () => {
		// Year 2100 in unix seconds is 4102444800. A unix-millis value like
		// 1744628400000 (year 2025) masquerading as seconds would land in
		// year 57226 — this test pins the sanity check.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ start_time: 1744628400000 })])),
		);
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toThrow(/milliseconds/i);
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
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

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
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(client.listRecordings()).rejects.toBeInstanceOf(PlaudParseError);
	});

	it('tolerates extra unknown fields in the response (forward-compat with Plaud)', async () => {
		// If Plaud adds a new field, we should keep working. Structural types
		// already allow this; this test pins the decision so nobody adds a
		// too-strict whitelist later.
		const { fetcher } = captureFetcher(
			ok(listEnvelope([record({ some_new_field_from_plaud: 'whatever' })])),
		);
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		const result = await client.listRecordings();
		expect(result).toHaveLength(1);
	});
});

// listRecordings — filter validation ----------------------------------------

describe('listRecordings filter validation', () => {
	it('throws PlaudApiError when filter.folderId is set (not supported by /file/simple/web)', async () => {
		const { fetcher } = captureFetcher(ok(listEnvelope([])));
		const client = new ReverseEngineeredPlaudClient('tok', fetcher);

		await expect(
			client.listRecordings({ folderId: 'anything' }),
		).rejects.toBeInstanceOf(PlaudApiError);
	});
});
