import { createSequentialPageFetcher } from '../list-paging';
import type {
	PlaudClient,
	Recording,
	RecordingFilter,
	RecordingPage,
} from '../plaud-client';

function rec(id: string): Recording {
	return {
		id: id as Recording['id'],
		title: id,
		createdAt: new Date(0),
		endsAt: new Date(0),
		durationSeconds: 0,
		captureOffsetMinutes: null,
		transcriptAvailable: false,
		summaryAvailable: false,
		isTrashed: false,
	};
}

// Offset stub: records the filters it was called with.
function offsetClient(pages: Record<number, Recording[]>): {
	client: PlaudClient;
	calls: RecordingFilter[];
} {
	const calls: RecordingFilter[] = [];
	const client = {
		listRecordings: (filter?: RecordingFilter) => {
			calls.push(filter ?? {});
			return Promise.resolve(pages[filter?.skip ?? 0] ?? []);
		},
	} as unknown as PlaudClient;
	return { client, calls };
}

// Cursor stub: serves pages keyed by the incoming cursor, records call filters.
function cursorClient(
	pagesByCursor: Record<string, RecordingPage>,
	firstKey = '<first>',
): { client: PlaudClient; calls: RecordingFilter[] } {
	const calls: RecordingFilter[] = [];
	const client = {
		listRecordings: () => Promise.resolve([]),
		listRecordingsPage: (filter?: RecordingFilter) => {
			calls.push(filter ?? {});
			const key = filter?.cursor ?? firstKey;
			return Promise.resolve(
				pagesByCursor[key] ?? { recordings: [], nextCursor: null },
			);
		},
	} as unknown as PlaudClient;
	return { client, calls };
}

describe('createSequentialPageFetcher (offset client)', () => {
	it('passes skip/limit/sortBy straight through to listRecordings', async () => {
		const { client, calls } = offsetClient({
			0: [rec('a'), rec('b')],
			2: [rec('c')],
		});
		const fetch = createSequentialPageFetcher(client, 'edit_time');
		expect(await fetch(0, 2)).toHaveLength(2);
		expect(await fetch(2, 2)).toHaveLength(1);
		expect(calls).toEqual([
			{ sortBy: 'edit_time', skip: 0, limit: 2 },
			{ sortBy: 'edit_time', skip: 2, limit: 2 },
		]);
	});
});

describe('createSequentialPageFetcher (cursor client)', () => {
	it('emulates sequential offset from cursors and stops when exhausted', async () => {
		const { client, calls } = cursorClient({
			'<first>': { recordings: [rec('a'), rec('b')], nextCursor: 'C1' },
			C1: { recordings: [rec('c'), rec('d')], nextCursor: 'C2' },
			C2: { recordings: [rec('e')], nextCursor: null },
		});
		const fetch = createSequentialPageFetcher(client, 'created' as never);

		// skip 0 starts with no cursor.
		expect((await fetch(0, 2)).map((r) => r.id)).toEqual(['a', 'b']);
		// skip > 0 continues from the stored cursor (C1), regardless of the skip value.
		expect((await fetch(2, 2)).map((r) => r.id)).toEqual(['c', 'd']);
		expect((await fetch(4, 2)).map((r) => r.id)).toEqual(['e']);
		// The last page returned nextCursor null, so the next call is empty.
		expect(await fetch(5, 2)).toEqual([]);

		expect(calls[0]).toMatchObject({ cursor: undefined, limit: 2 });
		expect(calls[1]).toMatchObject({ cursor: 'C1' });
		expect(calls[2]).toMatchObject({ cursor: 'C2' });
		// The 4th fetch short-circuited on the exhausted cursor: no 4th call.
		expect(calls).toHaveLength(3);
	});

	it('skip 0 restarts the scan (resets the cursor)', async () => {
		const { client, calls } = cursorClient({
			'<first>': { recordings: [rec('a')], nextCursor: 'C1' },
			C1: { recordings: [rec('b')], nextCursor: null },
		});
		const fetch = createSequentialPageFetcher(client, 'edit_time');
		await fetch(0, 1); // -> C1
		await fetch(1, 1); // -> exhausted (null)
		await fetch(0, 1); // restart: cursor undefined again
		expect(calls[0]).toMatchObject({ cursor: undefined });
		expect(calls[2]).toMatchObject({ cursor: undefined });
	});

	it('buffers short underlying pages so a page is short only at the true end', async () => {
		// Every underlying cursor page has just 1 record but more remain. With a
		// requested limit of 3, the adapter must combine them into full pages so
		// callers that treat "short page = end" do not stop early.
		const { client, calls } = cursorClient({
			'<first>': { recordings: [rec('a')], nextCursor: 'C1' },
			C1: { recordings: [rec('b')], nextCursor: 'C2' },
			C2: { recordings: [rec('c')], nextCursor: 'C3' },
			C3: { recordings: [rec('d')], nextCursor: null },
		});
		const fetch = createSequentialPageFetcher(client, 'edit_time');

		// First page: combined a+b+c into a full page of 3 (three underlying calls).
		expect((await fetch(0, 3)).map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(calls).toHaveLength(3);
		// Second page: only d remains, so this is short (= the real end).
		expect((await fetch(3, 3)).map((r) => r.id)).toEqual(['d']);
		// Past the end: empty.
		expect(await fetch(6, 3)).toEqual([]);
	});

	it('treats a non-advancing empty page as the end (no infinite loop)', async () => {
		const { client } = cursorClient({
			// A misbehaving server: empty records but a non-null cursor.
			'<first>': { recordings: [], nextCursor: 'STUCK' },
		});
		const fetch = createSequentialPageFetcher(client, 'edit_time');
		expect(await fetch(0, 3)).toEqual([]);
	});

	it('does not restart page one when skip > 0 arrives with no prior page', async () => {
		const { client, calls } = cursorClient({
			'<first>': { recordings: [rec('a')], nextCursor: 'C1' },
		});
		const fetch = createSequentialPageFetcher(client, 'edit_time');
		// A stray skip > 0 without a preceding skip 0 must not silently fetch page one.
		expect(await fetch(10, 1)).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});
