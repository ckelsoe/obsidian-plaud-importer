import {
	PlaudV4Client,
	embedV4SummaryImages,
	parseMarkMemoArray,
	summaryHeadingFor,
	type PlaudV4ClientOptions,
} from '../plaud-client-v4';
import {
	PlaudApiError,
	PlaudAuthError,
	type PlaudHttpFetcher,
	type PlaudHttpRequest,
	type PlaudHttpResponse,
	type PlaudTokenProvider,
} from '../plaud-client-re';
import type { PlaudRecordingId } from '../plaud-client';

// Response helpers ----------------------------------------------------------

function okJson(json: unknown): PlaudHttpResponse {
	return { status: 200, json, text: JSON.stringify(json) };
}

function okText(text: string): PlaudHttpResponse {
	return { status: 200, json: null, text };
}

const TRANSCRIPT_URL = 'https://s3.example/transcript?sig=abc';
const SUMMARY_URL = 'https://s3.example/summary?sig=abc';
const OUTLINE_URL = 'https://s3.example/outline?sig=abc';
const AUDIO_URL = 'https://s3.example/audio?sig=abc';

function detailEnvelope(
	overrides: {
		objects?: unknown[];
		keywords?: unknown;
		node?: Record<string, unknown>;
	} = {},
): PlaudHttpResponse {
	const objects = overrides.objects ?? [
		{
			object_type: 'TRANSCRIPT',
			mime_type: 'text/vnd.plaud.transcript+json',
			content_url: TRANSCRIPT_URL,
		},
		{
			object_type: 'SUMMARY',
			mime_type: 'text/vnd.plaud.summary+markdown',
			content_url: SUMMARY_URL,
		},
		{
			object_type: 'OUTLINE',
			mime_type: 'text/vnd.plaud.outline+json',
			content_url: OUTLINE_URL,
		},
		{
			object_type: 'AUDIO',
			mime_type: 'audio/ogg',
			content_url: AUDIO_URL,
		},
	];
	return okJson({
		status: 0,
		data: {
			node: {
				node_id: 'n_sp_f1',
				version_ms: 1755200500000,
				name: 'Meeting',
				folder: { folder_id: 'fld1', name: 'Recordings' },
				...overrides.node,
			},
			meta: {
				file_id: 'f1',
				duration: 4803000,
				keywords: overrides.keywords ?? ['alpha', 'pilot'],
			},
			objects,
		},
	});
}

function listEnvelope(
	items: unknown[],
	nextCursor: string | null = 'CURSOR2',
): PlaudHttpResponse {
	return okJson({
		status: 0,
		data: { items, next_cursor: nextCursor },
	});
}

function listItem(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		node_id: 'n_sp_f1',
		parent_id: 'n_root',
		file_id: 'f1',
		name: 'Meeting',
		duration_ms: 4803000,
		created_at_show_ms: 1755200000000, // 2025-08 (unix ms)
		updated_at_show_ms: 1755200500000,
		version_ms: 1755200500000,
		parent_folder: {
			folder_id: 'fld1',
			name: 'Recordings',
			system_folder_type: 1,
		},
		status: 0,
		file_task_status: 1,
		...overrides,
	};
}

const TRANSCRIPT_BODY = JSON.stringify([
	{
		content: 'Hello everyone.',
		speaker: 'Charles',
		original_speaker: 'Speaker 1',
		start_time: 1000,
		end_time: 2000,
	},
	{
		content: 'Second segment.',
		speaker: 'Mary',
		original_speaker: 'Speaker 2',
		start_time: 2000,
		end_time: 4000,
	},
]);

const OUTLINE_BODY = JSON.stringify([
	{ start_time: 0, end_time: 5000, topic: 'Intro' },
	{ start_time: 5000, end_time: 10000, topic: 'Demo' },
]);

const SUMMARY_BODY = '# Summary\n\n- Key point one\n- Key point two\n';

const SUMMARY_BETA_URL = 'https://s3.example/summary-beta?sig=abc';
const SUMMARY_BETA_BODY = '# Beta\n\n- Bullet a\n- Bullet b\n- Bullet c\n';

// A detail carrying two summary objects: the classic SUMMARY and a SUMMARY_BETA.
function detailWithTwoSummaries(): PlaudHttpResponse {
	return okJson({
		status: 0,
		data: {
			node: { node_id: 'n_sp_f1', version_ms: 1, name: 'Meeting' },
			meta: { file_id: 'f1', keywords: [] },
			objects: [
				{ object_type: 'SUMMARY', content_url: SUMMARY_URL },
				{ object_type: 'SUMMARY_BETA', content_url: SUMMARY_BETA_URL },
			],
		},
	});
}

const MARKS_URL = 'https://s3.example/marks?sig=abc';
// Deliberately out of timestamp order to exercise the parser's sort. Round
// millisecond values keep offsetSeconds exact for equality assertions.
const MARK_BODY = JSON.stringify([
	{ timestamp: 3000, mark_type: 2, picture_link: 'c_03' },
	{ timestamp: 1000, mark_type: 2, picture_link: 'c_01' },
	{ timestamp: 2000, mark_type: 2, picture_link: 'c_02' },
]);
const MARK_RCM: Record<string, string> = {
	c_01: 'https://s3.example/mark1.png?sig=a',
	c_02: 'https://s3.example/mark2.png?sig=b',
	c_03: 'https://s3.example/mark3.png?sig=c',
};

// A detail response carrying a MARK_MEMO object plus the relation_content_mapping
// that resolves its picture_link ids. Summary is present so the note is non-empty.
function detailWithMarks(): PlaudHttpResponse {
	return okJson({
		status: 0,
		data: {
			node: { node_id: 'n_sp_f1', version_ms: 1, name: 'Meeting' },
			meta: { file_id: 'f1', keywords: [] },
			objects: [
				{
					object_type: 'MARK_MEMO',
					mime_type: 'application/json',
					content_url: MARKS_URL,
				},
				{ object_type: 'SUMMARY', content_url: SUMMARY_URL },
			],
			relation_content_mapping: MARK_RCM,
		},
	});
}

// A routing fetcher that returns canned responses by URL substring and records
// every request so header/scope assertions are possible.
function routingFetcher(
	routes: Array<{ match: string; response: PlaudHttpResponse }>,
): {
	fetcher: PlaudHttpFetcher;
	requests: () => readonly PlaudHttpRequest[];
	requestFor: (substr: string) => PlaudHttpRequest | undefined;
} {
	const captured: PlaudHttpRequest[] = [];
	const fetcher: PlaudHttpFetcher = async (req) => {
		captured.push(req);
		const hit = routes.find((r) => req.url.includes(r.match));
		if (hit === undefined) {
			throw new Error(`no route for ${req.url}`);
		}
		return hit.response;
	};
	return {
		fetcher,
		requests: () => captured,
		requestFor: (substr) => captured.find((r) => r.url.includes(substr)),
	};
}

const TOKEN: PlaudTokenProvider = () => 'eyJfake.token.value';

function makeClient(
	fetcher: PlaudHttpFetcher,
	options: Partial<PlaudV4ClientOptions> = {},
	tokenProvider: PlaudTokenProvider = TOKEN,
): PlaudV4Client {
	return new PlaudV4Client(tokenProvider, fetcher, {
		baseUrl: 'https://api-staging-apne1.plaud.ai',
		workspaceId: 'ws_test',
		deviceId: 'dev123',
		...options,
	});
}

const ID = 'f1' as PlaudRecordingId;

// Listing -------------------------------------------------------------------

describe('PlaudV4Client.listRecordingsPage', () => {
	it('maps v4 list items to Recording and returns the cursor', async () => {
		const { fetcher, requestFor } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher);

		const page = await client.listRecordingsPage();
		expect(page.nextCursor).toBe('CURSOR2');
		expect(page.recordings).toHaveLength(1);
		const rec = page.recordings[0];
		expect(rec.id).toBe('f1');
		expect(rec.title).toBe('Meeting');
		expect(rec.createdAt.getTime()).toBe(1755200000000);
		expect(rec.endsAt.getTime()).toBe(1755200000000 + 4803000);
		expect(rec.durationSeconds).toBe(4803);
		expect(rec.tags).toEqual(['fld1']);
		expect(rec.systemFolderType).toBe(1);
		expect(rec.versionMs).toBe(1755200500000);
		expect(rec.captureOffsetMinutes).toBeNull();
		expect(rec.isTrashed).toBe(false);
		// The v4 list does not carry availability; note-writer treats
		// transcriptAvailable as a promise, so we must not over-advertise.
		expect(rec.transcriptAvailable).toBe(false);
		expect(rec.summaryAvailable).toBe(false);
		// ...but both-false means UNKNOWN, so the import runner must fetch
		// instead of skipping the recording as no-content.
		expect(rec.contentAvailabilityUnknown).toBe(true);

		// Scope + auth headers are present on the list call.
		const req = requestFor('/recordings/all')!;
		expect(req.headers['Authorization']).toBe('Bearer eyJfake.token.value');
		expect(req.headers['x-scope-id']).toBe('ws_test');
		expect(req.headers['x-scope-type']).toBe('workspace');
		expect(req.headers['app-platform']).toBe('web');
		expect(req.headers['x-device-id']).toBe('dev123');
		expect(req.url).toContain('page_size=300');
		expect(req.url).toContain('sort_by=created');
	});

	it('passes a cursor and maps sortBy=edit_time to updated', async () => {
		const { fetcher, requestFor } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([], null) },
		]);
		const client = makeClient(fetcher);

		const page = await client.listRecordingsPage({
			cursor: 'ABC',
			sortBy: 'edit_time',
		});
		expect(page.nextCursor).toBeNull();
		const req = requestFor('/recordings/all')!;
		expect(req.url).toContain('cursor=ABC');
		expect(req.url).toContain('sort_by=updated');
	});

	it('listRecordings returns just the recordings array', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher);
		const recs = await client.listRecordings();
		expect(recs).toHaveLength(1);
		expect(recs[0].id).toBe('f1');
	});

	it('getFolderCatalog surfaces folders discovered while listing', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher);
		await client.listRecordingsPage();
		const folders = await client.getFolderCatalog();
		expect(folders).toEqual([{ id: 'fld1', name: 'Recordings' }]);
	});

	it('getFolderCatalog drops folders from a previous workspace', async () => {
		let ws = 'ws_A';
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher, { workspaceId: () => ws });
		await client.listRecordingsPage();
		expect(await client.getFolderCatalog()).toEqual([
			{ id: 'fld1', name: 'Recordings' },
		]);

		ws = 'ws_B';
		expect(await client.getFolderCatalog()).toEqual([]);
	});

	it('getFolderCatalog drops folders from a previous host', async () => {
		let host = 'https://api-staging-apne1.plaud.ai';
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher, { baseUrl: () => host });
		await client.listRecordingsPage();
		host = 'https://api.plaud.ai';
		expect(await client.getFolderCatalog()).toEqual([]);
	});

	it('getFolderCatalog ignores a listing that was in flight across a switch', async () => {
		let ws = 'ws_A';
		const fetcher: PlaudHttpFetcher = async (req) => {
			if (req.url.includes('/recordings/all')) {
				// The switch lands while this request is awaiting its response.
				ws = 'ws_B';
				return listEnvelope([listItem()]);
			}
			throw new Error(`no route for ${req.url}`);
		};
		const client = makeClient(fetcher, { workspaceId: () => ws });
		await client.listRecordingsPage();
		expect(await client.getFolderCatalog()).toEqual([]);
	});

	it('rejects a folderId filter loudly', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([]) },
		]);
		const client = makeClient(fetcher);
		await expect(
			client.listRecordingsPage({ folderId: 'x' }),
		).rejects.toBeInstanceOf(PlaudApiError);
	});

	it('rejects a non-zero skip (v4 pages by cursor, not offset)', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher);
		await expect(
			client.listRecordingsPage({ skip: 50 }),
		).rejects.toBeInstanceOf(PlaudApiError);
	});

	it('accepts skip: 0 (first page)', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([listItem()]) },
		]);
		const client = makeClient(fetcher);
		const page = await client.listRecordingsPage({ skip: 0 });
		expect(page.recordings).toHaveLength(1);
	});

	it('throws on a malformed items field instead of reporting empty', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/recordings/all',
				response: okJson({ status: 0, data: { items: null } }),
			},
		]);
		const client = makeClient(fetcher);
		await expect(client.listRecordingsPage()).rejects.toMatchObject({
			name: 'PlaudParseError',
		});
	});
});

// Detail: transcript / summary / outline ------------------------------------

describe('PlaudV4Client.getTranscriptAndSummary', () => {
	function detailRoutes() {
		return routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: 'transcript', response: okText(TRANSCRIPT_BODY) },
			{ match: 'summary', response: okText(SUMMARY_BODY) },
			{ match: 'outline', response: okText(OUTLINE_BODY) },
		]);
	}

	it('assembles transcript, summary and chapters from objects[]', async () => {
		const { fetcher } = detailRoutes();
		const client = makeClient(fetcher);

		const result = await client.getTranscriptAndSummary(ID);

		expect(result.transcript).not.toBeNull();
		expect(result.transcript!.segments).toHaveLength(2);
		expect(result.transcript!.segments[0].speaker).toBe('Charles');
		expect(result.transcript!.segments[0].startSeconds).toBe(1);
		expect(result.transcript!.segments[0].endSeconds).toBe(2);
		expect(result.transcript!.segments[0].text).toBe('Hello everyone.');

		expect(result.summary).not.toBeNull();
		expect(result.summary!.text).toContain('# Summary');

		expect(result.chapters).toBeDefined();
		expect(result.chapters).toHaveLength(2);
		expect(result.chapters![0].title).toBe('Intro');
		expect(result.chapters![0].startSeconds).toBe(0);
		expect(result.chapters![0].endSeconds).toBe(5);

		expect(result.aiKeywords).toEqual(['alpha', 'pilot']);
	});

	it('prefers POLISHED_TRANSCRIPT when it has a content_url', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/files/detail/',
				response: detailEnvelope({
					objects: [
						{
							object_type: 'TRANSCRIPT',
							mime_type: 'text/vnd.plaud.transcript+json',
							content_url: 'https://s3.example/raw?sig=1',
						},
						{
							object_type: 'POLISHED_TRANSCRIPT',
							mime_type:
								'text/vnd.plaud.polished_transcript+json',
							content_url: 'https://s3.example/polished?sig=1',
						},
					],
				}),
			},
			{ match: 'polished', response: okText(TRANSCRIPT_BODY) },
			{
				match: 'raw',
				response: okText(
					'[{"content":"WRONG","start_time":0,"end_time":1}]',
				),
			},
		]);
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.transcript!.segments[0].text).toBe('Hello everyone.');
	});

	it('returns null transcript/summary when their content_url is absent', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/files/detail/',
				response: detailEnvelope({
					objects: [
						{
							object_type: 'POLISHED_TRANSCRIPT',
							mime_type:
								'text/vnd.plaud.polished_transcript+json',
							content_url: '',
						},
					],
					keywords: [],
				}),
			},
		]);
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.transcript).toBeNull();
		expect(result.summary).toBeNull();
		expect(result.chapters).toBeUndefined();
		expect(result.aiKeywords).toBeUndefined();
	});

	it('throws (does not return empty) when an advertised content_url fails', async () => {
		// A present-but-failing content_url must NOT be treated as "no content",
		// or a transient failure could overwrite an existing note's transcript.
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{
				match: 'transcript',
				response: { status: 503, json: null, text: 'upstream down' },
			},
			{ match: 'summary', response: okText(SUMMARY_BODY) },
			{ match: 'outline', response: okText(OUTLINE_BODY) },
		]);
		const client = makeClient(fetcher);
		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('throws when an advertised summary_url returns a 403 (expired)', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: 'transcript', response: okText(TRANSCRIPT_BODY) },
			{
				match: 'summary',
				response: { status: 403, json: null, text: 'expired' },
			},
			{ match: 'outline', response: okText(OUTLINE_BODY) },
		]);
		const client = makeClient(fetcher);
		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('pulls all summaries: SUMMARY primary plus SUMMARY_BETA as an additional', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailWithTwoSummaries() },
			{ match: 'summary-beta', response: okText(SUMMARY_BETA_BODY) },
			{ match: 'summary', response: okText(SUMMARY_BODY) },
		]);
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.summary?.text).toContain('Key point one');
		expect(result.additionalSummaries).toHaveLength(1);
		expect(result.additionalSummaries![0].heading).toBe('Summary (beta)');
		expect(result.additionalSummaries![0].text).toContain('Bullet a');
	});

	it('leaves additionalSummaries undefined when only one summary exists', async () => {
		const { fetcher } = detailRoutes();
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.summary).not.toBeNull();
		expect(result.additionalSummaries).toBeUndefined();
	});

	it('throws (does not drop a summary) when an additional summary fetch fails', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailWithTwoSummaries() },
			{
				match: 'summary-beta',
				response: { status: 503, json: null, text: 'down' },
			},
			{ match: 'summary', response: okText(SUMMARY_BODY) },
		]);
		const client = makeClient(fetcher);
		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('parses MARK_MEMO screenshots, resolves ids, and sorts by offset', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailWithMarks() },
			{ match: 'marks', response: okText(MARK_BODY) },
			{ match: 'summary', response: okText(SUMMARY_BODY) },
		]);
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.marks).toBeDefined();
		expect(result.marks).toHaveLength(3);
		expect(result.marks!.map((m) => m.offsetSeconds)).toEqual([1, 2, 3]);
		expect(result.marks!.map((m) => m.url)).toEqual([
			'https://s3.example/mark1.png?sig=a',
			'https://s3.example/mark2.png?sig=b',
			'https://s3.example/mark3.png?sig=c',
		]);
		expect(result.marks![0].markType).toBe(2);
	});

	it('omits marks when the recording has no MARK_MEMO object', async () => {
		const { fetcher } = detailRoutes();
		const client = makeClient(fetcher);
		const result = await client.getTranscriptAndSummary(ID);
		expect(result.marks).toBeUndefined();
	});

	it('throws (does not silently drop) when the MARK_MEMO content_url fails', async () => {
		// Mirrors the transcript/summary guard: a transient failure must not
		// resolve to "no marks" and overwrite an existing note's screenshots.
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailWithMarks() },
			{
				match: 'marks',
				response: { status: 503, json: null, text: 'down' },
			},
			{ match: 'summary', response: okText(SUMMARY_BODY) },
		]);
		const client = makeClient(fetcher);
		await expect(client.getTranscriptAndSummary(ID)).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});
});

// Audio ---------------------------------------------------------------------

describe('PlaudV4Client.getAudioTempUrl', () => {
	it('returns the AUDIO object content_url', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
		]);
		const client = makeClient(fetcher);
		const url = await client.getAudioTempUrl(ID);
		expect(url).toBe(AUDIO_URL);
	});

	it('reuses the cached detail (single detail fetch for detail+audio)', async () => {
		const { fetcher, requests } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: 'transcript', response: okText(TRANSCRIPT_BODY) },
			{ match: 'summary', response: okText(SUMMARY_BODY) },
			{ match: 'outline', response: okText(OUTLINE_BODY) },
		]);
		const client = makeClient(fetcher);
		await client.getTranscriptAndSummary(ID);
		await client.getAudioTempUrl(ID);
		const detailCalls = requests().filter((r) =>
			r.url.includes('/files/detail/'),
		);
		expect(detailCalls).toHaveLength(1);
	});

	it('returns null when there is no AUDIO object', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/files/detail/',
				response: detailEnvelope({ objects: [] }),
			},
		]);
		const client = makeClient(fetcher);
		expect(await client.getAudioTempUrl(ID)).toBeNull();
	});

	it('refetches the detail after the cache TTL expires', async () => {
		const nowSpy = jest.spyOn(Date, 'now');
		try {
			const { fetcher, requests } = routingFetcher([
				{ match: '/files/detail/', response: detailEnvelope() },
			]);
			const client = makeClient(fetcher);
			nowSpy.mockReturnValue(1_000_000);
			await client.getAudioTempUrl(ID);
			// Advance past the 60s TTL so the memo is considered stale.
			nowSpy.mockReturnValue(1_000_000 + 61_000);
			await client.getAudioTempUrl(ID);
			const detailCalls = requests().filter((r) =>
				r.url.includes('/files/detail/'),
			);
			expect(detailCalls).toHaveLength(2);
		} finally {
			nowSpy.mockRestore();
		}
	});
});

// Auth / errors -------------------------------------------------------------

describe('PlaudV4Client auth and error handling', () => {
	it('throws not_configured when the token provider returns null', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([]) },
		]);
		const client = makeClient(fetcher, {}, () => null);
		await expect(client.listRecordings()).rejects.toMatchObject({
			name: 'PlaudAuthError',
			reason: 'not_configured',
		});
	});

	it('reports not_configured when signed in but no workspace is captured', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/recordings/all', response: listEnvelope([]) },
		]);
		// A valid token but an empty workspace: the sign-in predates workspace
		// capture. This is a configuration state, not a retryable network fault.
		const client = makeClient(fetcher, { workspaceId: '' });
		await expect(client.listRecordings()).rejects.toMatchObject({
			name: 'PlaudAuthError',
			reason: 'not_configured',
		});
	});

	it('maps a 401 to a token_rejected PlaudAuthError', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/recordings/all',
				response: { status: 401, json: null, text: '' },
			},
		]);
		const client = makeClient(fetcher);
		await expect(client.listRecordings()).rejects.toMatchObject({
			name: 'PlaudAuthError',
			reason: 'token_rejected',
		});
	});

	it('routes a negative in-band status to an error', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/recordings/all',
				response: okJson({
					status: -419,
					msg: 'workspace token expired',
				}),
			},
		]);
		const client = makeClient(fetcher);
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudAuthError,
		);
	});

	it('updateTitle is not yet supported on v4', async () => {
		const { fetcher } = routingFetcher([]);
		const client = makeClient(fetcher);
		await expect(
			client.updateTitle(ID, 'New title'),
		).rejects.toBeInstanceOf(PlaudApiError);
	});
});

// Credential safety: base-URL host allowlist --------------------------------

describe('PlaudV4Client base URL host guard', () => {
	// The host is validated per request (before the bearer is attached), not at
	// construction, so a host captured after construction is re-checked.
	it('accepts a regional plaud.ai host', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/recordings/all',
				response: listEnvelope([listItem()]),
			},
		]);
		const client = makeClient(fetcher, {
			baseUrl: 'https://api-staging-apne1.plaud.ai',
		});
		await expect(client.listRecordings()).resolves.toHaveLength(1);
	});

	it('rejects a non-plaud.ai host so the token is never sent there', async () => {
		const { fetcher } = routingFetcher([]);
		const client = makeClient(fetcher, {
			baseUrl: 'https://evil.example.com',
		});
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('rejects a lookalike host that merely contains plaud.ai', async () => {
		const { fetcher } = routingFetcher([]);
		const client = makeClient(fetcher, {
			baseUrl: 'https://plaud.ai.evil.com',
		});
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('rejects a non-https scheme', async () => {
		const { fetcher } = routingFetcher([]);
		const client = makeClient(fetcher, { baseUrl: 'http://api.plaud.ai' });
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudApiError,
		);
	});

	it('reads the base URL from a provider each call (host captured post-construction)', async () => {
		let host = '';
		const { fetcher, requestFor } = routingFetcher([
			{
				match: '/recordings/all',
				response: listEnvelope([listItem()]),
			},
		]);
		const client = makeClient(fetcher, { baseUrl: () => host });
		// Empty host fails the allowlist before any bearer is sent.
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudApiError,
		);
		// Capture happens; the provider now returns a real host, no rebuild.
		host = 'https://api-staging-apne1.plaud.ai';
		await expect(client.listRecordings()).resolves.toHaveLength(1);
		expect(requestFor('/recordings/all')!.url).toContain(
			'api-staging-apne1.plaud.ai',
		);
	});

	it('reads the workspace id from a provider each call', async () => {
		let ws = '';
		const { fetcher, requestFor } = routingFetcher([
			{
				match: '/recordings/all',
				response: listEnvelope([listItem()]),
			},
		]);
		const client = makeClient(fetcher, { workspaceId: () => ws });
		await expect(client.listRecordings()).rejects.toBeInstanceOf(
			PlaudApiError,
		);
		ws = 'ws_captured';
		await client.listRecordings();
		expect(requestFor('/recordings/all')!.headers['x-scope-id']).toBe(
			'ws_captured',
		);
	});
});

describe('embedV4SummaryImages', () => {
	const CID = 'c_0123456789abcdef0123456789abcdef';
	const SIGNED = 'https://api-apne1.staging.theplaud.com/x/pic.png?sig=abc';
	const map = { [CID]: SIGNED };

	it('rewrites a plain-link image marker to a real image embed', () => {
		// The v4 summary embeds an image as a link whose URL carries the content
		// id; the mapping resolves that id to the pre-signed image URL.
		const summary = `intro\n\n[](https://web.example/view?id=${CID})\n\nrest`;
		expect(embedV4SummaryImages(summary, map)).toBe(
			`intro\n\n![](${SIGNED})\n\nrest`,
		);
	});

	it('keeps alt text and rewrites an existing image marker', () => {
		const summary = `![poster](https://web.example/view?id=${CID})`;
		expect(embedV4SummaryImages(summary, map)).toBe(`![poster](${SIGNED})`);
	});

	it('leaves a marker whose id is not in the map untouched', () => {
		const summary =
			'![x](https://web.example/view?id=c_ffffffffffffffffffffffffffffffff)';
		expect(embedV4SummaryImages(summary, map)).toBe(summary);
	});

	it('is a no-op for an empty map or a summary with no markers', () => {
		expect(embedV4SummaryImages('plain text', map)).toBe('plain text');
		expect(embedV4SummaryImages(`[](https://x/view?id=${CID})`, {})).toBe(
			`[](https://x/view?id=${CID})`,
		);
	});
});

describe('parseMarkMemoArray', () => {
	const MAP: Record<string, string> = {
		c_a: 'https://s3.example/a.png',
		c_b: 'https://s3.example/b.png',
	};

	it('resolves picture ids, converts ms to seconds, and sorts by offset', () => {
		const marks = parseMarkMemoArray(
			[
				{ timestamp: 2000, mark_type: 2, picture_link: 'c_b' },
				{ timestamp: 1000, mark_type: 2, picture_link: 'c_a' },
			],
			MAP,
		);
		expect(marks).toEqual([
			{ offsetSeconds: 1, url: 'https://s3.example/a.png', markType: 2 },
			{ offsetSeconds: 2, url: 'https://s3.example/b.png', markType: 2 },
		]);
	});

	it('drops entries whose picture_link is missing or does not resolve', () => {
		const marks = parseMarkMemoArray(
			[
				{ timestamp: 1000, mark_type: 2 },
				{ timestamp: 1000, mark_type: 2, picture_link: 'c_missing' },
				{ timestamp: 1000, mark_type: 2, picture_link: 'c_a' },
			],
			MAP,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].url).toBe('https://s3.example/a.png');
	});

	it('clamps a missing or out-of-range timestamp to 0', () => {
		const marks = parseMarkMemoArray(
			[{ picture_link: 'c_a' }, { timestamp: -5, picture_link: 'c_b' }],
			MAP,
		);
		expect(marks.map((m) => m.offsetSeconds)).toEqual([0, 0]);
	});

	it('omits markType when it is not a finite number', () => {
		const marks = parseMarkMemoArray(
			[{ picture_link: 'c_a', mark_type: 'photo' }],
			MAP,
		);
		expect(marks[0].markType).toBeUndefined();
	});

	it('returns [] for a non-array body', () => {
		expect(parseMarkMemoArray({}, MAP)).toEqual([]);
		expect(parseMarkMemoArray(null, MAP)).toEqual([]);
	});
});

describe('summaryHeadingFor', () => {
	it('labels the classic SUMMARY as "Summary"', () => {
		expect(summaryHeadingFor('SUMMARY')).toBe('Summary');
	});

	it('labels a variant as "Summary (<suffix>)"', () => {
		expect(summaryHeadingFor('SUMMARY_BETA')).toBe('Summary (beta)');
		expect(summaryHeadingFor('SUMMARY_QUICK_TAKE')).toBe(
			'Summary (quick take)',
		);
	});

	it('falls back to "Summary" for a non-string or unprefixed type', () => {
		expect(summaryHeadingFor(undefined)).toBe('Summary');
		expect(summaryHeadingFor(42)).toBe('Summary');
	});
});

describe('PlaudV4Client.updateTitle', () => {
	const renameOk = okJson({
		status: 0,
		data: { items: [], parent_items: [], failed: [], warnings: [] },
	});
	const renameConflict = okJson({
		status: -1800313,
		msg: 'node version conflict',
	});

	it('renames the node with name + origin_version and workspace scope', async () => {
		const { fetcher, requestFor } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: '/nodes/rename/', response: renameOk },
		]);
		const client = makeClient(fetcher);

		await client.updateTitle(ID, '  New Title  ');

		const req = requestFor('/nodes/rename/')!;
		expect(req.method).toBe('PATCH');
		expect(req.url).toContain('/file-app/v4/nodes/rename/n_sp_f1');
		expect(JSON.parse(req.body!)).toEqual({
			name: 'New Title',
			origin_version: 1755200500000,
		});
		expect(req.headers['Authorization']).toBe('Bearer eyJfake.token.value');
		expect(req.headers['x-scope-id']).toBe('ws_test');
		expect(req.headers['x-scope-type']).toBe('workspace');
	});

	it('throws without any write when the title is blank', async () => {
		const { fetcher, requests } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: '/nodes/rename/', response: renameOk },
		]);
		const client = makeClient(fetcher);

		await expect(client.updateTitle(ID, '   ')).rejects.toBeInstanceOf(
			PlaudApiError,
		);
		expect(requests()).toHaveLength(0);
	});

	it('re-reads a fresh version and retries once on a node version conflict', async () => {
		let detailCalls = 0;
		let renameCalls = 0;
		const fetcher: PlaudHttpFetcher = async (req) => {
			if (req.url.includes('/files/detail/')) {
				detailCalls++;
				return detailEnvelope({
					node: { version_ms: detailCalls === 1 ? 100 : 200 },
				});
			}
			if (req.url.includes('/nodes/rename/')) {
				renameCalls++;
				return renameCalls === 1 ? renameConflict : renameOk;
			}
			throw new Error(`no route for ${req.url}`);
		};
		const client = makeClient(fetcher);

		await client.updateTitle(ID, 'New Title');
		expect(detailCalls).toBe(2);
		expect(renameCalls).toBe(2);
	});

	it('propagates the conflict when the retry also conflicts', async () => {
		const { fetcher } = routingFetcher([
			{ match: '/files/detail/', response: detailEnvelope() },
			{ match: '/nodes/rename/', response: renameConflict },
		]);
		const client = makeClient(fetcher);

		await expect(client.updateTitle(ID, 'New Title')).rejects.toMatchObject(
			{ inBandStatus: -1800313 },
		);
	});

	it('throws a parse error when the detail node has no node_id', async () => {
		const { fetcher } = routingFetcher([
			{
				match: '/files/detail/',
				response: detailEnvelope({ node: { node_id: undefined } }),
			},
			{ match: '/nodes/rename/', response: renameOk },
		]);
		const client = makeClient(fetcher);

		await expect(client.updateTitle(ID, 'New Title')).rejects.toThrow(
			/node_id or version_ms/,
		);
	});
});

describe('PlaudV4Client.getDeviceCatalog', () => {
	const deviceListEnvelope = (devices: unknown[]): PlaudHttpResponse =>
		okJson({ status: 0, msg: 'ok', data_devices: devices });
	const DEV = {
		sn: 'SN1',
		name: 'My NotePin',
		model: 888,
		version_number: 1,
	};

	it('fetches once and reuses the cache for the same account and host', async () => {
		let calls = 0;
		const fetcher: PlaudHttpFetcher = async (req) => {
			if (req.url.includes('/device-app/device/list')) {
				calls++;
				return deviceListEnvelope([DEV]);
			}
			throw new Error(`no route for ${req.url}`);
		};
		const client = makeClient(fetcher);

		const a = await client.getDeviceCatalog();
		const b = await client.getDeviceCatalog();
		expect(calls).toBe(1);
		expect(a).toBe(b);
		expect(a).toHaveLength(1);
		expect(a[0].name).toBe('My NotePin');
	});

	it('refetches when the workspace changes (account switch on one client)', async () => {
		let calls = 0;
		let ws = 'ws_A';
		const fetcher: PlaudHttpFetcher = async (req) => {
			if (req.url.includes('/device-app/device/list')) {
				calls++;
				return deviceListEnvelope([{ ...DEV, name: `dev-${calls}` }]);
			}
			throw new Error(`no route for ${req.url}`);
		};
		const client = makeClient(fetcher, { workspaceId: () => ws });

		const first = await client.getDeviceCatalog();
		ws = 'ws_B';
		const second = await client.getDeviceCatalog();

		expect(calls).toBe(2);
		expect(first[0].name).toBe('dev-1');
		expect(second[0].name).toBe('dev-2');
	});
});
