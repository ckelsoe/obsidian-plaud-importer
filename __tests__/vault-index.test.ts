// Tests for vault-index. The function is a pure walk over an Obsidian
// App shaped object — we hand it a minimal stub that mimics
// `vault.getMarkdownFiles()` and `metadataCache.getFileCache()`. No
// real Obsidian runtime needed.

import type { App, TFile } from 'obsidian';
import type { PlaudRecordingId } from '../plaud-client';
import { buildPlaudIdIndex, outputFolderHasMarkdown } from '../vault-index';

interface FakeFile {
	readonly path: string;
}

interface FakeFrontmatter {
	readonly [key: string]: unknown;
}

function makeApp(entries: ReadonlyArray<readonly [string, FakeFrontmatter | null]>): App {
	const files: FakeFile[] = entries.map(([path]) => ({ path }));
	const fmByPath = new Map<string, FakeFrontmatter | null>(entries);
	const app = {
		vault: {
			getMarkdownFiles: (): readonly TFile[] => files as unknown as TFile[],
		},
		metadataCache: {
			getFileCache: (file: TFile): { frontmatter?: FakeFrontmatter } | null => {
				const fm = fmByPath.get(file.path);
				if (fm === null || fm === undefined) return null;
				return { frontmatter: fm };
			},
		},
	};
	return app as unknown as App;
}

describe('buildPlaudIdIndex', () => {
	it('indexes notes inside the configured output folder', () => {
		const app = makeApp([
			['Plaud/note-a.md', { 'plaud-id': 'rec-a' }],
			['Plaud/note-b.md', { 'plaud-id': 'rec-b' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(2);
		expect(index.get('rec-a' as PlaudRecordingId)?.path).toBe('Plaud/note-a.md');
		expect(index.get('rec-b' as PlaudRecordingId)?.path).toBe('Plaud/note-b.md');
	});

	it('skips notes outside the output folder', () => {
		const app = makeApp([
			['Plaud/inside.md', { 'plaud-id': 'rec-inside' }],
			['Other/outside.md', { 'plaud-id': 'rec-outside' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(1);
		expect(index.has('rec-inside' as PlaudRecordingId)).toBe(true);
		expect(index.has('rec-outside' as PlaudRecordingId)).toBe(false);
	});

	it('recurses into subfolders under the output folder', () => {
		const app = makeApp([
			['Plaud/2026/q2/meeting.md', { 'plaud-id': 'rec-nested' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.get('rec-nested' as PlaudRecordingId)?.path).toBe(
			'Plaud/2026/q2/meeting.md',
		);
	});

	it('treats empty outputFolder as vault root and matches everything', () => {
		const app = makeApp([
			['top.md', { 'plaud-id': 'rec-top' }],
			['nested/a.md', { 'plaud-id': 'rec-nested' }],
		]);
		const index = buildPlaudIdIndex(app, '');
		expect(index.size).toBe(2);
	});

	it('strips leading/trailing slashes from outputFolder before matching', () => {
		const app = makeApp([['Plaud/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(buildPlaudIdIndex(app, '/Plaud').size).toBe(1);
		expect(buildPlaudIdIndex(app, 'Plaud/').size).toBe(1);
		expect(buildPlaudIdIndex(app, '/Plaud/').size).toBe(1);
	});

	it('reads plaud-version-ms into versionMs; absent or malformed stays undefined', () => {
		const app = makeApp([
			['Plaud/num.md', { 'plaud-id': 'rec-num', 'plaud-version-ms': 1782918853105 }],
			['Plaud/str.md', { 'plaud-id': 'rec-str', 'plaud-version-ms': '1744628400000' }],
			['Plaud/none.md', { 'plaud-id': 'rec-none' }],
			['Plaud/bad.md', { 'plaud-id': 'rec-bad', 'plaud-version-ms': 'not-a-number' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.get('rec-num' as PlaudRecordingId)?.versionMs).toBe(1782918853105);
		expect(index.get('rec-str' as PlaudRecordingId)?.versionMs).toBe(1744628400000);
		expect(index.get('rec-none' as PlaudRecordingId)?.versionMs).toBeUndefined();
		expect(index.get('rec-bad' as PlaudRecordingId)?.versionMs).toBeUndefined();
	});

	it('normalizes Windows-style backslash outputFolder before matching', () => {
		// Regression for #7: a "\Inbox" setting must match notes Obsidian
		// stored under "Inbox", so the imported badge and duplicate detection
		// keep working for Windows users.
		const app = makeApp([['Inbox/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(buildPlaudIdIndex(app, '\\Inbox').size).toBe(1);
		expect(buildPlaudIdIndex(app, '\\Inbox\\').size).toBe(1);
	});

	it('does NOT match a folder by prefix that shares a name (Plaud-archive vs Plaud)', () => {
		const app = makeApp([
			['Plaud-archive/old.md', { 'plaud-id': 'rec-old' }],
			['Plaud/new.md', { 'plaud-id': 'rec-new' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(1);
		expect(index.has('rec-new' as PlaudRecordingId)).toBe(true);
		expect(index.has('rec-old' as PlaudRecordingId)).toBe(false);
	});

	it('skips notes with no frontmatter', () => {
		const app = makeApp([
			['Plaud/no-fm.md', null],
			['Plaud/empty-fm.md', {}],
			['Plaud/with-id.md', { 'plaud-id': 'rec-ok' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(1);
		expect(index.has('rec-ok' as PlaudRecordingId)).toBe(true);
	});

	it('skips frontmatter entries where plaud-id is not a non-empty string', () => {
		const app = makeApp([
			['Plaud/numeric.md', { 'plaud-id': 12345 }],
			['Plaud/empty.md', { 'plaud-id': '' }],
			['Plaud/whitespace.md', { 'plaud-id': '   ' }],
			['Plaud/object.md', { 'plaud-id': { nested: true } }],
			['Plaud/array.md', { 'plaud-id': ['rec-array'] }],
			['Plaud/ok.md', { 'plaud-id': 'rec-ok' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(1);
		expect(index.get('rec-ok' as PlaudRecordingId)?.path).toBe('Plaud/ok.md');
	});

	it('captures summary version and id from frontmatter when present', () => {
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
		const entry = buildPlaudIdIndex(app, 'Plaud').get('rec-rich' as PlaudRecordingId);
		expect(entry?.summaryVersion).toBe('3');
		expect(entry?.summaryId).toBe('sum-xyz');
	});

	it('leaves summary version and id undefined when those fields are absent', () => {
		const app = makeApp([
			['Plaud/lean.md', { 'plaud-id': 'rec-lean' }],
		]);
		const entry = buildPlaudIdIndex(app, 'Plaud').get('rec-lean' as PlaudRecordingId);
		expect(entry?.summaryVersion).toBeUndefined();
		expect(entry?.summaryId).toBeUndefined();
	});

	it('keeps the last-seen entry when two files share a plaud-id', () => {
		// Duplicate ids should be rare (it implies a manual copy or
		// legacy bug), but the index must not throw on them. Last wins.
		const app = makeApp([
			['Plaud/first.md', { 'plaud-id': 'rec-dup' }],
			['Plaud/second.md', { 'plaud-id': 'rec-dup' }],
		]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(1);
		expect(index.get('rec-dup' as PlaudRecordingId)?.path).toBe('Plaud/second.md');
	});

	it('returns an empty map when no files match', () => {
		const app = makeApp([]);
		const index = buildPlaudIdIndex(app, 'Plaud');
		expect(index.size).toBe(0);
	});
});

describe('outputFolderHasMarkdown', () => {
	it('is true when the output folder contains a note (same matching as the index)', () => {
		const app = makeApp([['Plaud/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(outputFolderHasMarkdown(app, 'Plaud')).toBe(true);
	});

	it('normalizes Windows backslashes like the index does', () => {
		const app = makeApp([['Inbox/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(outputFolderHasMarkdown(app, '\\Inbox')).toBe(true);
	});

	it('is false when the folder has no notes (a genuinely empty folder)', () => {
		const app = makeApp([['Other/a.md', { 'plaud-id': 'rec-a' }]]);
		expect(outputFolderHasMarkdown(app, 'Plaud')).toBe(false);
		expect(outputFolderHasMarkdown(makeApp([]), 'Plaud')).toBe(false);
	});
});
