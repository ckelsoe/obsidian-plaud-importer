import type { PlaudRecordingId, Recording } from '../plaud-client';
import type { ImportedRecord } from '../vault-index';
import { filterListView, type ListViewFilter } from '../import-core';

function rec(overrides: Partial<Omit<Recording, 'id'>> & { id: string }): Recording {
	return {
		id: overrides.id as PlaudRecordingId,
		title: overrides.title ?? `title-${overrides.id}`,
		createdAt: overrides.createdAt ?? new Date('2026-06-01T00:00:00Z'),
		durationSeconds: overrides.durationSeconds ?? 60,
		transcriptAvailable: overrides.transcriptAvailable ?? true,
		summaryAvailable: overrides.summaryAvailable ?? true,
		isTrashed: overrides.isTrashed ?? false,
		folderId: overrides.folderId,
		tags: overrides.tags,
		versionMs: overrides.versionMs,
		waitPull: overrides.waitPull,
	};
}

function idx(
	entries: ReadonlyArray<readonly [string, ImportedRecord]>,
): Map<PlaudRecordingId, ImportedRecord> {
	return new Map(entries.map(([id, r]) => [id as PlaudRecordingId, r]));
}

function ignored(ids: readonly string[]): Set<PlaudRecordingId> {
	return new Set(ids.map((id) => id as PlaudRecordingId));
}

function filter(over: Partial<ListViewFilter>): ListViewFilter {
	return {
		showTrashed: over.showTrashed ?? false,
		hideProcessed: over.hideProcessed ?? false,
		hideUpdates: over.hideUpdates ?? false,
		hideIgnored: over.hideIgnored ?? false,
		index: over.index ?? idx([]),
		ignoredIds: over.ignoredIds ?? ignored([]),
	};
}

function ids(recordings: readonly Recording[]): string[] {
	return recordings.map((r) => r.id);
}

describe('filterListView', () => {
	it('hides a processed-and-unchanged recording when hideProcessed is on', () => {
		const index = idx([['a', { path: 'a.md', versionMs: 100 }]]);
		const page = [
			rec({ id: 'a', versionMs: 100 }), // in index, unchanged -> hidden
			rec({ id: 'b', versionMs: 200 }), // not in index -> shown
		];
		expect(ids(filterListView(page, filter({ hideProcessed: true, index })))).toEqual([
			'b',
		]);
	});

	it('always shows a changed recording even when hideProcessed is on (governed by hideUpdates)', () => {
		const index = idx([['a', { path: 'a.md', versionMs: 100 }]]);
		const page = [rec({ id: 'a', versionMs: 200 })]; // listed > stored -> update available
		expect(ids(filterListView(page, filter({ hideProcessed: true, index })))).toEqual([
			'a',
		]);
	});

	it('hides a changed recording when hideUpdates is on', () => {
		const index = idx([['a', { path: 'a.md', versionMs: 100 }]]);
		const page = [
			rec({ id: 'a', versionMs: 200 }), // update available -> hidden by hideUpdates
			rec({ id: 'b', versionMs: 500 }), // new -> still shown
		];
		expect(ids(filterListView(page, filter({ hideUpdates: true, index })))).toEqual([
			'b',
		]);
	});

	it('hideUpdates does not hide an unchanged processed recording', () => {
		const index = idx([['a', { path: 'a.md', versionMs: 100 }]]);
		const page = [rec({ id: 'a', versionMs: 100 })]; // unchanged
		// hideUpdates on but hideProcessed off -> unchanged import still shows.
		expect(
			ids(filterListView(page, filter({ hideUpdates: true, hideProcessed: false, index }))),
		).toEqual(['a']);
	});

	it('hideProcessed and hideUpdates together hide every imported row, new still shows', () => {
		const index = idx([
			['unchanged', { path: 'u.md', versionMs: 100 }],
			['changed', { path: 'c.md', versionMs: 100 }],
		]);
		const page = [
			rec({ id: 'unchanged', versionMs: 100 }),
			rec({ id: 'changed', versionMs: 200 }),
			rec({ id: 'new', versionMs: 500 }),
		];
		expect(
			ids(
				filterListView(
					page,
					filter({ hideProcessed: true, hideUpdates: true, index }),
				),
			),
		).toEqual(['new']);
	});

	it('always shows a new (not-in-index) recording when hideProcessed is on', () => {
		const page = [rec({ id: 'fresh', versionMs: 500 })];
		expect(
			ids(filterListView(page, filter({ hideProcessed: true, index: idx([]) }))),
		).toEqual(['fresh']);
	});

	it('shows a processed recording when hideProcessed is off', () => {
		const index = idx([['a', { path: 'a.md', versionMs: 100 }]]);
		const page = [rec({ id: 'a', versionMs: 100 })];
		expect(ids(filterListView(page, filter({ hideProcessed: false, index })))).toEqual([
			'a',
		]);
	});

	it('hides ignored recordings when hideIgnored is on (even never-imported ones)', () => {
		const page = [
			rec({ id: 'junk', versionMs: 900 }), // never imported, ignored -> hidden
			rec({ id: 'keep', versionMs: 800 }),
		];
		expect(
			ids(
				filterListView(
					page,
					filter({ hideIgnored: true, ignoredIds: ignored(['junk']) }),
				),
			),
		).toEqual(['keep']);
	});

	it('shows ignored recordings when hideIgnored is off', () => {
		const page = [rec({ id: 'junk', versionMs: 900 })];
		expect(
			ids(
				filterListView(
					page,
					filter({ hideIgnored: false, ignoredIds: ignored(['junk']) }),
				),
			),
		).toEqual(['junk']);
	});

	it('never shows trash unless showTrashed is on', () => {
		const page = [
			rec({ id: 'trash', isTrashed: true }),
			rec({ id: 'keep' }),
		];
		expect(ids(filterListView(page, filter({ showTrashed: false })))).toEqual(['keep']);
		expect(ids(filterListView(page, filter({ showTrashed: true })))).toEqual([
			'trash',
			'keep',
		]);
	});

	it('applies each toggle independently', () => {
		const index = idx([['done', { path: 'done.md', versionMs: 100 }]]);
		const page = [
			rec({ id: 'done', versionMs: 100 }), // processed-unchanged
			rec({ id: 'junk', versionMs: 900 }), // ignored
			rec({ id: 'trash', isTrashed: true }), // trash
			rec({ id: 'new', versionMs: 500 }), // plain new
		];
		// All filters on: only the plain-new recording survives.
		expect(
			ids(
				filterListView(
					page,
					filter({
						hideProcessed: true,
						hideIgnored: true,
						showTrashed: false,
						index,
						ignoredIds: ignored(['junk']),
					}),
				),
			),
		).toEqual(['new']);
		// All filters off: everything shows, order preserved.
		expect(
			ids(
				filterListView(
					page,
					filter({
						hideProcessed: false,
						hideIgnored: false,
						showTrashed: true,
						index,
						ignoredIds: ignored(['junk']),
					}),
				),
			),
		).toEqual(['done', 'junk', 'trash', 'new']);
	});

	it('a trashed recording is dropped before the ignore/processed checks', () => {
		// Trash wins regardless of ignore/processed state when showTrashed is off.
		const index = idx([['t', { path: 't.md', versionMs: 100 }]]);
		const page = [rec({ id: 't', versionMs: 100, isTrashed: true })];
		expect(
			ids(
				filterListView(
					page,
					filter({
						showTrashed: false,
						hideProcessed: false,
						hideIgnored: false,
						index,
					}),
				),
			),
		).toEqual([]);
	});
});
