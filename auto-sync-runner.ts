// -----------------------------------------------------------------------------
// auto-sync-runner.ts
//
// The auto-sync TICK: page the edit-time-descending list, accumulate the new
// and changed candidates (stopping at the up-to-date boundary or the caps),
// then hand them to the caller's importer. Orchestration only, with every I/O
// concern injected, so the paging / stop / cap logic is unit-testable with fake
// deps and no Obsidian or network. The pure per-recording classification lives
// in auto-sync.ts; the writer/attachment/network plumbing lives in main.ts.
// -----------------------------------------------------------------------------

import type { PlaudRecordingId, Recording } from './plaud-client';
import type { ImportedRecord } from './vault-index';
import { selectAutoSyncCandidates } from './auto-sync';
import type { SourceFilter } from './import-core';

export interface AutoSyncTickDeps {
	/** One page of the list, edit-time descending (sort_by=edit_time). */
	listPage(skip: number, limit: number): Promise<readonly Recording[]>;
	/** Fresh vault index (plaud-id -> {path, versionMs}) for this tick. */
	buildIndex(): Map<PlaudRecordingId, ImportedRecord>;
	/**
	 * Import the selected recordings. `newRecs` are created (skip-for-new),
	 * `changedRecs` overwrite the matched note. Returns how many of each landed.
	 */
	importCandidates(
		newRecs: readonly Recording[],
		changedRecs: readonly Recording[],
	): Promise<{ imported: number; updated: number }>;
	readonly pageSize: number;
	/** Max candidates to import in one tick (bounds a large first run). */
	readonly maxImportsPerTick: number;
	/** Max pages to scan in one tick (bounds an empty-index first run). */
	readonly maxPagesPerTick: number;
	/**
	 * Recording ids the user permanently ignored. Excluded from candidate
	 * selection so auto-sync never pulls them. Omitted -> nothing ignored.
	 */
	readonly ignoredIds?: ReadonlySet<PlaudRecordingId>;
	/**
	 * Recording-source filter (issue #110). A recording from a blocked source is
	 * skipped exactly like an ignored one. Rebuilt from settings each tick so a
	 * change takes effect on the next run. Omitted -> nothing filtered.
	 */
	readonly sourceFilter?: SourceFilter;
	log?(message: string, payload?: unknown): void;
}

export interface AutoSyncTickResult {
	readonly imported: number;
	readonly updated: number;
	readonly pagesScanned: number;
	readonly reachedUpToDate: boolean;
	readonly cappedByImports: boolean;
	readonly cappedByPages: boolean;
}

/**
 * Run one tick. Never throws for a benign empty result; propagates a thrown
 * listPage/importCandidates error to the caller so the scheduler's state
 * machine can classify it (auth pause vs transient).
 */
export async function runAutoSyncTick(
	deps: AutoSyncTickDeps,
): Promise<AutoSyncTickResult> {
	const index = deps.buildIndex();
	const newRecs: Recording[] = [];
	const changedRecs: Recording[] = [];
	let skip = 0;
	let pagesScanned = 0;
	let reachedUpToDate = false;
	let cappedByImports = false;
	let cappedByPages = false;

	while (true) {
		if (pagesScanned >= deps.maxPagesPerTick) {
			cappedByPages = true;
			break;
		}
		const page = await deps.listPage(skip, deps.pageSize);
		pagesScanned += 1;
		if (page.length === 0) {
			break;
		}
		const { candidates, reachedUpToDate: hitBoundary } =
			selectAutoSyncCandidates(
				page,
				index,
				deps.ignoredIds,
				deps.sourceFilter,
			);
		for (const candidate of candidates) {
			if (newRecs.length + changedRecs.length >= deps.maxImportsPerTick) {
				cappedByImports = true;
				break;
			}
			if (candidate.kind === 'new') {
				newRecs.push(candidate.recording);
			} else {
				changedRecs.push(candidate.recording);
			}
		}
		if (hitBoundary) {
			reachedUpToDate = true;
			break;
		}
		if (cappedByImports) {
			break;
		}
		// A short page means the remote has no more rows to offer.
		if (page.length < deps.pageSize) {
			break;
		}
		skip += page.length;
	}

	deps.log?.('auto-sync candidates selected', {
		newCount: newRecs.length,
		changedCount: changedRecs.length,
		pagesScanned,
		reachedUpToDate,
		cappedByImports,
		cappedByPages,
	});

	if (newRecs.length === 0 && changedRecs.length === 0) {
		return {
			imported: 0,
			updated: 0,
			pagesScanned,
			reachedUpToDate,
			cappedByImports,
			cappedByPages,
		};
	}

	const { imported, updated } = await deps.importCandidates(
		newRecs,
		changedRecs,
	);
	return {
		imported,
		updated,
		pagesScanned,
		reachedUpToDate,
		cappedByImports,
		cappedByPages,
	};
}
