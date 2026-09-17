// Tests for vault-index. The builders are a pure walk over an Obsidian
// App-shaped object; we hand them a minimal stub that mimics
// `vault.getMarkdownFiles()` and `metadataCache.getFileCache()`. No real
// Obsidian runtime needed.

import type { App, TFile } from 'obsidian';
import type { PlaudRecordingId } from '../plaud-client';
import {
	buildImportedIndex,
	buildImportedIndexWithColdCheck,
	canonicalPlaudId,
	findImportedNote,
	outputFolderCacheIsCold,
	type RecordingIdentity,
} from '../vault-index';

interface FakeFile {
	readonly path: string;
}

interface FakeFrontmatter {
	readonly [key: string]: unknown;
}

function makeApp(
	entries: ReadonlyArray<readonly [string, FakeFrontmatter | null]>,
): App {
	const files: FakeFile[] = entries.map(([path]) => ({ path }));
	const fmByPath = new Map<string, FakeFrontmatter | null>(entries);
	const app = {
		vault: {
			getMarkdownFiles: (): readonly TFile[] =>
				files as unknown as TFile[],
		},
		metadataCache: {
			getFileCache: (
				file: TFile,
			): { frontmatter?: FakeFrontmatter } | null => {
				const fm = fmByPath.get(file.path);
				if (fm === null || fm === undefined) return null;
				return { frontmatter: fm };
			},
		},
	};
	return app as unknown as App;
}

function rec(
	id: string,
	startIso: string,
	durationSeconds: number,
): RecordingIdentity {
	return { id, createdAt: new Date(startIso), durationSeconds };
}

describe('buildImportedIndex byId', () => {
	it('indexes notes inside the configured output folder', () => {
		const app = makeApp([
			['Plaud/note-a.md', { 'plaud-id': 'rec-a' }],
			['Plaud/note-b.md', { 'plaud-id': 'rec-b' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.size).toBe(2);
		expect(index.byId.get('rec-a' as PlaudRecordingId)?.path).toBe(
			'Plaud/note-a.md',
		);
		expect(index.byId.get('rec-b' as PlaudRecordingId)?.path).toBe(
			'Plaud/note-b.md',
		);
	});

	it('skips notes outside the output folder', () => {
		const app = makeApp([
			['Plaud/inside.md', { 'plaud-id': 'rec-inside' }],
			['Other/outside.md', { 'plaud-id': 'rec-outside' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.size).toBe(1);
		expect(index.byId.has('rec-inside' as PlaudRecordingId)).toBe(true);
		expect(index.byId.has('rec-outside' as PlaudRecordingId)).toBe(false);
	});

	it('recurses into subfolders under the output folder', () => {
		const app = makeApp([
			['Plaud/2026/q2/meeting.md', { 'plaud-id': 'rec-nested' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.get('rec-nested' as PlaudRecordingId)?.path).toBe(
			'Plaud/2026/q2/meeting.md',
		);
	});

	it('treats empty outputFolder as vault root and matches everything', () => {
		const app = makeApp([
			['top.md', { 'plaud-id': 'rec-top' }],
			['nested/a.md', { 'plaud-id': 'rec-nested' }],
		]);
		expect(buildImportedIndex(app, '').byId.size).toBe(2);
	});

	it('strips leading/trailing slashes from outputFolder before matching', () => {
		const app = makeApp([['Plaud/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(buildImportedIndex(app, '/Plaud').byId.size).toBe(1);
		expect(buildImportedIndex(app, 'Plaud/').byId.size).toBe(1);
		expect(buildImportedIndex(app, '/Plaud/').byId.size).toBe(1);
	});

	it('reads plaud-version-ms into versionMs; absent or malformed stays undefined', () => {
		const app = makeApp([
			[
				'Plaud/num.md',
				{ 'plaud-id': 'rec-num', 'plaud-version-ms': 1782918853105 },
			],
			[
				'Plaud/str.md',
				{ 'plaud-id': 'rec-str', 'plaud-version-ms': '1744628400000' },
			],
			['Plaud/none.md', { 'plaud-id': 'rec-none' }],
			[
				'Plaud/bad.md',
				{ 'plaud-id': 'rec-bad', 'plaud-version-ms': 'not-a-number' },
			],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.get('rec-num' as PlaudRecordingId)?.versionMs).toBe(
			1782918853105,
		);
		expect(index.byId.get('rec-str' as PlaudRecordingId)?.versionMs).toBe(
			1744628400000,
		);
		expect(
			index.byId.get('rec-none' as PlaudRecordingId)?.versionMs,
		).toBeUndefined();
		expect(
			index.byId.get('rec-bad' as PlaudRecordingId)?.versionMs,
		).toBeUndefined();
	});

	it('normalizes Windows-style backslash outputFolder before matching', () => {
		const app = makeApp([['Inbox/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(buildImportedIndex(app, '\\Inbox').byId.size).toBe(1);
		expect(buildImportedIndex(app, '\\Inbox\\').byId.size).toBe(1);
	});

	it('does NOT match a folder by prefix that shares a name', () => {
		const app = makeApp([
			['Plaud-archive/old.md', { 'plaud-id': 'rec-old' }],
			['Plaud/new.md', { 'plaud-id': 'rec-new' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.size).toBe(1);
		expect(index.byId.has('rec-new' as PlaudRecordingId)).toBe(true);
	});

	it('skips notes with no frontmatter or no plaud-id', () => {
		const app = makeApp([
			['Plaud/no-fm.md', null],
			['Plaud/empty-fm.md', {}],
			['Plaud/numeric.md', { 'plaud-id': 12345 }],
			['Plaud/empty.md', { 'plaud-id': '' }],
			['Plaud/with-id.md', { 'plaud-id': 'rec-ok' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.size).toBe(1);
		expect(index.byId.has('rec-ok' as PlaudRecordingId)).toBe(true);
	});

	it('captures the note plaud-id, summary version, and id from frontmatter', () => {
		const app = makeApp([
			[
				'Plaud/rich.md',
				{
					'plaud-id': 'rec-rich',
					'plaud-summary-version': '3',
					'plaud-summary-id': 'sum-xyz',
				},
			],
		]);
		const entry = buildImportedIndex(app, 'Plaud').byId.get(
			'rec-rich' as PlaudRecordingId,
		);
		expect(entry?.plaudId).toBe('rec-rich');
		expect(entry?.summaryVersion).toBe('3');
		expect(entry?.summaryId).toBe('sum-xyz');
	});

	it('keeps the last-seen byId entry when two files share a plaud-id', () => {
		const app = makeApp([
			['Plaud/first.md', { 'plaud-id': 'rec-dup' }],
			['Plaud/second.md', { 'plaud-id': 'rec-dup' }],
		]);
		const index = buildImportedIndex(app, 'Plaud');
		expect(index.byId.size).toBe(1);
		expect(index.byId.get('rec-dup' as PlaudRecordingId)?.path).toBe(
			'Plaud/second.md',
		);
	});
});

describe('canonicalPlaudId', () => {
	it('strips a single leading of_ (the v3-id-in-v4 prefix)', () => {
		expect(canonicalPlaudId('of_ab4db03305b77f8e67f345ab89b163ab')).toBe(
			'ab4db03305b77f8e67f345ab89b163ab',
		);
	});

	it('leaves a bare v3 id unchanged', () => {
		expect(canonicalPlaudId('ab4db03305b77f8e67f345ab89b163ab')).toBe(
			'ab4db03305b77f8e67f345ab89b163ab',
		);
	});

	it('leaves v4-native f_ and f_s_ ids unchanged', () => {
		expect(canonicalPlaudId('f_01a0588d059a745dbc44dd8719f71111')).toBe(
			'f_01a0588d059a745dbc44dd8719f71111',
		);
		expect(canonicalPlaudId('f_s_01a001db08d87201955b23809f4ce1a1')).toBe(
			'f_s_01a001db08d87201955b23809f4ce1a1',
		);
	});
});

describe('findImportedNote by canonical id', () => {
	// The exact case from the real vault: a note stored the bare v3 id; the v4
	// recording carries the same id with an of_ prefix. They are one meeting.
	it('matches a bare-id note to its of_-prefixed v4 recording by id', () => {
		const index = buildImportedIndex(
			makeApp([
				[
					'Plaud/bare.md',
					{ 'plaud-id': '340aec0e020aaee63768f043b7841393' },
				],
			]),
			'Plaud',
		);
		const match = findImportedNote(
			index,
			rec(
				'of_340aec0e020aaee63768f043b7841393',
				'2026-04-23T15:00:00Z',
				42,
			),
		);
		expect(match?.matchedBy).toBe('id');
		expect(match?.record.path).toBe('Plaud/bare.md');
		// The note still reports its stored (bare) id, so a migration can rewrite it.
		expect(match?.record.plaudId).toBe('340aec0e020aaee63768f043b7841393');
	});

	it('matches an of_ note to its of_ recording by id (already current)', () => {
		const index = buildImportedIndex(
			makeApp([
				[
					'Plaud/prefixed.md',
					{ 'plaud-id': 'of_ab4db03305b77f8e67f345ab89b163ab' },
				],
			]),
			'Plaud',
		);
		const match = findImportedNote(
			index,
			rec(
				'of_ab4db03305b77f8e67f345ab89b163ab',
				'2026-06-25T12:00:00Z',
				226,
			),
		);
		expect(match?.matchedBy).toBe('id');
		expect(match?.record.plaudId).toBe(
			'of_ab4db03305b77f8e67f345ab89b163ab',
		);
	});
});

describe('buildImportedIndex fallback keys + findImportedNote', () => {
	// A note with a precise start-time and duration, imported under an OLD id.
	const NOTE = {
		'plaud-id': 'old-v3-id',
		'start-time': '2026-08-07T14:52:11-04:00',
		date: '2026-08-07',
		'duration-seconds': 600,
	};

	it('finds a recording by id first', () => {
		const index = buildImportedIndex(
			makeApp([['Plaud/a.md', NOTE]]),
			'Plaud',
		);
		const match = findImportedNote(
			index,
			rec('old-v3-id', '2026-08-07T18:52:11Z', 600),
		);
		expect(match?.matchedBy).toBe('id');
		expect(match?.record.path).toBe('Plaud/a.md');
	});

	it('finds a recording whose id CHANGED by the precise instant key', () => {
		const index = buildImportedIndex(
			makeApp([['Plaud/a.md', NOTE]]),
			'Plaud',
		);
		// Same meeting (same start instant + duration), brand-new v4 id.
		const match = findImportedNote(
			index,
			rec('f_s_new_v4_id', '2026-08-07T18:52:41Z', 600),
		);
		expect(match?.matchedBy).toBe('instant');
		expect(match?.record.path).toBe('Plaud/a.md');
		expect(match?.record.plaudId).toBe('old-v3-id');
	});

	it('falls back to the day key for a date-only legacy note', () => {
		const legacy = {
			'plaud-id': 'old-id',
			date: '2026-06-25',
			'duration-seconds': 226,
		};
		const index = buildImportedIndex(
			makeApp([['Plaud/legacy.md', legacy]]),
			'Plaud',
		);
		// A recording whose local day is 2026-06-25 and duration 226; derive the
		// instant from a local Date so the day lines up regardless of runner TZ.
		const startLocalNoon = new Date(2026, 5, 25, 12, 0, 0).toISOString();
		const match = findImportedNote(
			index,
			rec('new-id', startLocalNoon, 226),
		);
		expect(match?.matchedBy).toBe('day');
		expect(match?.record.path).toBe('Plaud/legacy.md');
	});

	it('does NOT match on an ambiguous fallback key (two notes share it)', () => {
		// Two different meetings that collapse to the same instant + duration.
		const index = buildImportedIndex(
			makeApp([
				['Plaud/one.md', NOTE],
				[
					'Plaud/two.md',
					{
						'plaud-id': 'other-old-id',
						'start-time': '2026-08-07T14:52:59-04:00',
						date: '2026-08-07',
						'duration-seconds': 600,
					},
				],
			]),
			'Plaud',
		);
		const match = findImportedNote(
			index,
			rec('some-v4-id', '2026-08-07T18:52:11Z', 600),
		);
		expect(match).toBeNull();
	});

	it('returns null for a genuinely new recording', () => {
		const index = buildImportedIndex(
			makeApp([['Plaud/a.md', NOTE]]),
			'Plaud',
		);
		const match = findImportedNote(
			index,
			rec('brand-new', '2026-09-01T10:00:00Z', 123),
		);
		expect(match).toBeNull();
	});
});

describe('outputFolderCacheIsCold', () => {
	it('is cold when a note under the folder has no parsed cache yet', () => {
		expect(
			outputFolderCacheIsCold(
				makeApp([['Plaud/cold.md', null]]),
				'Plaud',
			),
		).toBe(true);
	});

	it('is NOT cold when every note under the folder is parsed', () => {
		const app = makeApp([
			['Plaud/a.md', { 'plaud-id': 'rec-a' }],
			['Plaud/b.md', {}],
		]);
		expect(outputFolderCacheIsCold(app, 'Plaud')).toBe(false);
	});

	it('is NOT cold when the folder has no notes', () => {
		expect(outputFolderCacheIsCold(makeApp([]), 'Plaud')).toBe(false);
		expect(
			outputFolderCacheIsCold(makeApp([['Other/x.md', null]]), 'Plaud'),
		).toBe(false);
	});
});

describe('buildImportedIndexWithColdCheck', () => {
	it('is cold (and yields no index) when a note under the folder is unparsed', () => {
		const app = makeApp([
			['Plaud/a.md', { 'plaud-id': 'rec-a' }],
			['Plaud/cold.md', null],
		]);
		expect(buildImportedIndexWithColdCheck(app, 'Plaud').isCold).toBe(true);
	});

	it('is warm and returns the same byId map as buildImportedIndex', () => {
		const app = makeApp([
			['Plaud/a.md', { 'plaud-id': 'rec-a', 'plaud-version-ms': 111 }],
			['Plaud/sub/b.md', { 'plaud-id': 'rec-b' }],
			['Other/outside.md', { 'plaud-id': 'rec-outside' }],
		]);
		const state = buildImportedIndexWithColdCheck(app, 'Plaud');
		expect(state.isCold).toBe(false);
		if (state.isCold) return;
		const reference = buildImportedIndex(app, 'Plaud');
		expect([...state.index.byId.entries()]).toEqual([
			...reference.byId.entries(),
		]);
		expect(
			state.index.byId.get('rec-a' as PlaudRecordingId)?.versionMs,
		).toBe(111);
		expect(state.index.byId.has('rec-outside' as PlaudRecordingId)).toBe(
			false,
		);
	});

	it('is warm with an empty index when the folder has no notes', () => {
		const state = buildImportedIndexWithColdCheck(makeApp([]), 'Plaud');
		expect(state.isCold).toBe(false);
		if (state.isCold) return;
		expect(state.index.byId.size).toBe(0);
	});
});
