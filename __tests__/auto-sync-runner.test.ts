import type { PlaudRecordingId, Recording } from '../plaud-client';
import type { ImportedRecord } from '../vault-index';
import { runAutoSyncTick, type AutoSyncTickDeps } from '../auto-sync-runner';

function rec(id: string, versionMs: number): Recording {
	return {
		id: id as PlaudRecordingId,
		title: `t-${id}`,
		createdAt: new Date('2026-06-01T00:00:00Z'),
		durationSeconds: 60,
		transcriptAvailable: true,
		summaryAvailable: true,
		isTrashed: false,
		versionMs,
	};
}

function idx(
	entries: ReadonlyArray<readonly [string, number | undefined]>,
): Map<PlaudRecordingId, ImportedRecord> {
	return new Map(
		entries.map(([id, v]) => [
			id as PlaudRecordingId,
			{ path: `Plaud/${id}.md`, versionMs: v },
		]),
	);
}

function deps(
	over: Partial<AutoSyncTickDeps> & { pages: readonly Recording[][] } & {
		index?: Map<PlaudRecordingId, ImportedRecord>;
	},
): {
	deps: AutoSyncTickDeps;
	importCalls: Array<{ newIds: string[]; changedIds: string[] }>;
	listSkips: number[];
} {
	const importCalls: Array<{ newIds: string[]; changedIds: string[] }> = [];
	const listSkips: number[] = [];
	const pages = over.pages;
	const d: AutoSyncTickDeps = {
		pageSize: over.pageSize ?? 10,
		maxImportsPerTick: over.maxImportsPerTick ?? 100,
		maxPagesPerTick: over.maxPagesPerTick ?? 10,
		ignoredIds: over.ignoredIds,
		listPage: async (skip) => {
			listSkips.push(skip);
			const pageIndex = Math.floor(skip / (over.pageSize ?? 10));
			return pages[pageIndex] ?? [];
		},
		buildIndex: () => over.index ?? new Map(),
		importCandidates: async (newRecs, changedRecs) => {
			importCalls.push({
				newIds: newRecs.map((r) => r.id),
				changedIds: changedRecs.map((r) => r.id),
			});
			return { imported: newRecs.length, updated: changedRecs.length };
		},
	};
	return { deps: d, importCalls, listSkips };
}

describe('runAutoSyncTick', () => {
	it('scans the whole page (splitting new/changed) instead of stopping at an up-to-date one', async () => {
		const index = idx([
			['changed', 500],
			['boundary', 900],
		]);
		const { deps: d, importCalls } = deps({
			index,
			pageSize: 10,
			pages: [
				[
					rec('new1', 1000),
					rec('changed', 600), // > stored 500 -> changed
					rec('boundary', 900), // == stored -> up-to-date, do NOT stop
					rec('new-below', 1), // NEW, below the up-to-date one -> still caught
				],
			],
		});
		const result = await runAutoSyncTick(d);
		// The page produced candidates, so we did not reach the "nothing to
		// import" frontier; the short page (4 < 10) is what ends paging.
		expect(result.reachedUpToDate).toBe(false);
		expect(result.pagesScanned).toBe(1);
		expect(importCalls).toEqual([
			{ newIds: ['new1', 'new-below'], changedIds: ['changed'] },
		]);
		expect(result.imported).toBe(2);
		expect(result.updated).toBe(1);
	});

	it('keeps paging past up-to-date recordings and stops on the first page with no candidates', async () => {
		const index = idx([
			['synced-a', 500],
			['synced-b', 500],
			['synced-c', 500],
		]);
		const {
			deps: d,
			listSkips,
			importCalls,
		} = deps({
			index,
			pageSize: 2,
			pages: [
				[rec('a', 900), rec('b', 800)], // page 1: both new -> keep going
				[rec('c', 700), rec('synced-a', 500)], // page 2: new + up-to-date -> keep going
				[rec('synced-b', 400), rec('synced-c', 300)], // page 3: all up-to-date -> STOP
				[rec('should-not-load', 1)], // page 4: never loaded
			],
		});
		const result = await runAutoSyncTick(d);
		expect(result.reachedUpToDate).toBe(true); // page 3 yielded zero candidates
		expect(result.pagesScanned).toBe(3);
		expect(listSkips).toEqual([0, 2, 4]); // never asked for page 4
		expect(importCalls[0].newIds).toEqual(['a', 'b', 'c']);
	});

	it('caps by maxPagesPerTick on a cold index (nothing up to date)', async () => {
		const { deps: d } = deps({
			index: new Map(),
			pageSize: 2,
			maxPagesPerTick: 2,
			pages: [
				[rec('a', 9), rec('b', 8)],
				[rec('c', 7), rec('d', 6)],
				[rec('e', 5), rec('f', 4)],
			],
		});
		const result = await runAutoSyncTick(d);
		expect(result.cappedByPages).toBe(true);
		expect(result.pagesScanned).toBe(2);
	});

	it('caps by maxImportsPerTick', async () => {
		const { deps: d, importCalls } = deps({
			index: new Map(),
			pageSize: 10,
			maxImportsPerTick: 3,
			pages: [
				[
					rec('a', 9),
					rec('b', 8),
					rec('c', 7),
					rec('d', 6),
					rec('e', 5),
				],
			],
		});
		const result = await runAutoSyncTick(d);
		expect(result.cappedByImports).toBe(true);
		// only the first 3 accumulated
		expect(importCalls[0].newIds).toEqual(['a', 'b', 'c']);
	});

	it('does not call importCandidates when there is nothing to do', async () => {
		const index = idx([['a', 900]]);
		const { deps: d, importCalls } = deps({
			index,
			pageSize: 10,
			pages: [[rec('a', 900)]], // == stored -> boundary, no candidates
		});
		const result = await runAutoSyncTick(d);
		expect(importCalls).toEqual([]);
		expect(result.imported).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.reachedUpToDate).toBe(true);
	});

	it('excludes ignored recordings from the tick candidates', async () => {
		const { deps: d, importCalls } = deps({
			index: new Map(),
			pageSize: 10,
			ignoredIds: new Set(['junk' as PlaudRecordingId]),
			pages: [[rec('junk', 900), rec('keep', 800)]],
		});
		const result = await runAutoSyncTick(d);
		expect(importCalls[0].newIds).toEqual(['keep']);
		expect(result.imported).toBe(1);
	});

	it('stops on a short page (remote exhausted) without a boundary', async () => {
		const { deps: d } = deps({
			index: new Map(),
			pageSize: 10,
			pages: [[rec('a', 9), rec('b', 8)]], // 2 < pageSize 10 -> exhausted
		});
		const result = await runAutoSyncTick(d);
		expect(result.reachedUpToDate).toBe(false);
		expect(result.pagesScanned).toBe(1);
	});
});
