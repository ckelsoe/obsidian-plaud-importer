import type { PlaudRecordingId, Recording } from '../plaud-client';
import type { ImportedRecord } from '../vault-index';
import {
	classifyRecording,
	selectAutoSyncCandidates,
	nextAutoSyncState,
	tickOutcomeForCategory,
	coerceIntervalMinutes,
	isUpdateAvailable,
	INITIAL_AUTO_SYNC_STATE,
} from '../auto-sync';

function rec(
	overrides: Partial<Omit<Recording, 'id'>> & { id: string },
): Recording {
	return {
		id: overrides.id as PlaudRecordingId,
		title: overrides.title ?? `title-${overrides.id}`,
		createdAt: overrides.createdAt ?? new Date('2026-06-01T00:00:00Z'),
		endsAt: overrides.endsAt ?? new Date('2026-06-01T00:01:00Z'),
		durationSeconds: overrides.durationSeconds ?? 60,
		captureOffsetMinutes: overrides.captureOffsetMinutes ?? null,
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

describe('classifyRecording', () => {
	it('classifies a recording not in the index as new', () => {
		expect(
			classifyRecording(rec({ id: 'a', versionMs: 100 }), idx([])),
		).toBe('new');
	});

	it('classifies a listed version_ms greater than stored as changed', () => {
		const index = idx([['a', { path: 'p', versionMs: 100 }]]);
		expect(classifyRecording(rec({ id: 'a', versionMs: 200 }), index)).toBe(
			'changed',
		);
	});

	it('classifies listed <= stored (with a marker) as the up-to-date boundary', () => {
		const index = idx([['a', { path: 'p', versionMs: 200 }]]);
		expect(classifyRecording(rec({ id: 'a', versionMs: 200 }), index)).toBe(
			'up-to-date-boundary',
		);
		expect(classifyRecording(rec({ id: 'a', versionMs: 150 }), index)).toBe(
			'up-to-date-boundary',
		);
	});

	it('treats a missing stored marker as current, not changed (migration)', () => {
		const index = idx([['a', { path: 'p' }]]); // no versionMs
		expect(classifyRecording(rec({ id: 'a', versionMs: 999 }), index)).toBe(
			'up-to-date-current',
		);
	});

	it('treats a missing listed version_ms as current (cannot compare)', () => {
		const index = idx([['a', { path: 'p', versionMs: 100 }]]);
		expect(
			classifyRecording(rec({ id: 'a', versionMs: undefined }), index),
		).toBe('up-to-date-current');
	});

	it('imports a wait_pull recording that already has content ready', () => {
		// wait_pull tracks the device audio pull, not transcript/summary
		// readiness: a transcribed recording must import even while wait_pull=1.
		expect(
			classifyRecording(
				rec({ id: 'a', versionMs: 999, waitPull: true }),
				idx([]),
			),
		).toBe('new');
	});

	it('skips a wait_pull recording only when it has no content yet', () => {
		expect(
			classifyRecording(
				rec({
					id: 'a',
					versionMs: 999,
					waitPull: true,
					transcriptAvailable: false,
					summaryAvailable: false,
				}),
				idx([]),
			),
		).toBe('skipped-wait-pull');
	});

	it('classifies an ignored recording as ignored (ignore wins over new/changed)', () => {
		const ignoredIds = new Set(['a' as PlaudRecordingId]);
		// New but ignored.
		expect(
			classifyRecording(
				rec({ id: 'a', versionMs: 100 }),
				idx([]),
				ignoredIds,
			),
		).toBe('ignored');
		// Changed (listed > stored) but ignored.
		const index = idx([['a', { path: 'p', versionMs: 100 }]]);
		expect(
			classifyRecording(
				rec({ id: 'a', versionMs: 200 }),
				index,
				ignoredIds,
			),
		).toBe('ignored');
	});

	it('does not classify a non-ignored recording as ignored', () => {
		const ignoredIds = new Set(['other' as PlaudRecordingId]);
		expect(
			classifyRecording(
				rec({ id: 'a', versionMs: 100 }),
				idx([]),
				ignoredIds,
			),
		).toBe('new');
	});
});

describe('selectAutoSyncCandidates', () => {
	it('scans the whole page so a new recording below an up-to-date one is still caught', () => {
		// Bug B regression: after a backlog builds up (e.g. auto-sync was
		// auth-paused), a NEW recording can sort BELOW an already-synced
		// (up-to-date-boundary) recording in edit-time order. The scan must not
		// stop at the boundary, or that new recording is stranded forever.
		const index = idx([
			['changed-old', { path: 'c', versionMs: 100 }],
			['boundary', { path: 'b', versionMs: 500 }],
			['below-synced', { path: 'x', versionMs: 10 }],
		]);
		const page = [
			rec({ id: 'brand-new', versionMs: 900 }),
			rec({ id: 'changed-old', versionMs: 800 }),
			rec({ id: 'boundary', versionMs: 500 }), // == stored -> up-to-date, do NOT stop
			rec({ id: 'below-synced', versionMs: 5 }), // in index, up-to-date, skip
			rec({ id: 'also-new', versionMs: 1 }), // NEW, below the boundary -> must be caught
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			index,
		);
		expect(reachedUpToDate).toBe(false); // the page produced candidates
		expect(candidates.map((c) => `${c.recording.id}:${c.kind}`)).toEqual([
			'brand-new:new',
			'changed-old:changed',
			'also-new:new',
		]);
	});

	it('reaches the frontier only when the whole page is proven up-to-date', () => {
		const index = idx([
			['a', { path: 'a', versionMs: 500 }],
			['b', { path: 'b', versionMs: 500 }],
		]);
		const page = [
			rec({ id: 'a', versionMs: 500 }), // up-to-date-boundary
			rec({ id: 'b', versionMs: 400 }), // up-to-date-boundary
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			index,
		);
		expect(candidates).toEqual([]);
		expect(reachedUpToDate).toBe(true);
	});

	it('does NOT reach the frontier on a page of only legacy (no-marker) notes', () => {
		// up-to-date-current rows cannot prove the frontier (migration rule): a
		// ready recording can still sit below them on a later page.
		const index = idx([
			['legacy-a', { path: 'a' }], // no versionMs
			['legacy-b', { path: 'b' }],
		]);
		const page = [
			rec({ id: 'legacy-a', versionMs: 900 }),
			rec({ id: 'legacy-b', versionMs: 800 }),
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			index,
		);
		expect(candidates).toEqual([]);
		expect(reachedUpToDate).toBe(false);
	});

	it('does NOT reach the frontier on a page of only pending wait_pull notes', () => {
		const page = [
			rec({
				id: 'p1',
				versionMs: 900,
				waitPull: true,
				transcriptAvailable: false,
				summaryAvailable: false,
			}),
			rec({
				id: 'p2',
				versionMs: 800,
				waitPull: true,
				transcriptAvailable: false,
				summaryAvailable: false,
			}),
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			idx([]),
		);
		expect(candidates).toEqual([]);
		expect(reachedUpToDate).toBe(false);
	});

	it('does not stop on a missing-marker note and never flags it changed', () => {
		const index = idx([['legacy', { path: 'l' }]]); // no versionMs
		const page = [
			rec({ id: 'legacy', versionMs: 999 }), // migration: skip, do NOT stop
			rec({ id: 'new-below', versionMs: 5 }), // must still be reached
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			index,
		);
		expect(reachedUpToDate).toBe(false);
		expect(candidates.map((c) => c.recording.id)).toEqual(['new-below']);
	});

	it('never imports trashed recordings', () => {
		const page = [
			rec({ id: 'trash', versionMs: 900, isTrashed: true }),
			rec({ id: 'keep', versionMs: 800 }),
		];
		const { candidates } = selectAutoSyncCandidates(page, idx([]));
		expect(candidates.map((c) => c.recording.id)).toEqual(['keep']);
	});

	it('skips a content-less wait_pull recording but keeps scanning', () => {
		const page = [
			rec({
				id: 'pending',
				versionMs: 900,
				waitPull: true,
				transcriptAvailable: false,
				summaryAvailable: false,
			}),
			rec({ id: 'ready', versionMs: 800 }),
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			idx([]),
		);
		expect(reachedUpToDate).toBe(false);
		expect(candidates.map((c) => c.recording.id)).toEqual(['ready']);
	});

	it('imports a wait_pull recording that has content (transcribed but audio still pulling)', () => {
		const page = [
			rec({ id: 'pending-with-content', versionMs: 900, waitPull: true }),
		];
		const { candidates } = selectAutoSyncCandidates(page, idx([]));
		expect(candidates.map((c) => c.recording.id)).toEqual([
			'pending-with-content',
		]);
	});

	it('skips an ignored recording and keeps scanning so a ready one below is caught', () => {
		const ignoredIds = new Set(['ignored-top' as PlaudRecordingId]);
		const page = [
			rec({ id: 'ignored-top', versionMs: 900 }), // ignored -> skip, NOT a frontier
			rec({ id: 'ready-below', versionMs: 800 }), // new -> candidate
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			idx([]),
			ignoredIds,
		);
		expect(candidates.map((c) => c.recording.id)).toEqual(['ready-below']);
		expect(reachedUpToDate).toBe(false);
	});

	it('a page of only ignored recordings is not a frontier (paging continues)', () => {
		const ignoredIds = new Set([
			'i1' as PlaudRecordingId,
			'i2' as PlaudRecordingId,
		]);
		const page = [
			rec({ id: 'i1', versionMs: 900 }),
			rec({ id: 'i2', versionMs: 800 }),
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(
			page,
			idx([]),
			ignoredIds,
		);
		expect(candidates).toEqual([]);
		expect(reachedUpToDate).toBe(false);
	});
});

describe('nextAutoSyncState', () => {
	it('pauses on an auth outcome', () => {
		expect(nextAutoSyncState(INITIAL_AUTO_SYNC_STATE, 'auth')).toEqual({
			paused: true,
			consecutiveTransientFailures: 0,
		});
	});

	it('counts transient failures without pausing', () => {
		const s1 = nextAutoSyncState(INITIAL_AUTO_SYNC_STATE, 'transient');
		expect(s1).toEqual({ paused: false, consecutiveTransientFailures: 1 });
		expect(
			nextAutoSyncState(s1, 'transient').consecutiveTransientFailures,
		).toBe(2);
	});

	it('a transient failure while paused stays paused', () => {
		const paused = { paused: true, consecutiveTransientFailures: 0 };
		expect(nextAutoSyncState(paused, 'transient').paused).toBe(true);
	});

	it('ok resumes and resets the counter', () => {
		const paused = { paused: true, consecutiveTransientFailures: 3 };
		expect(nextAutoSyncState(paused, 'ok')).toEqual(
			INITIAL_AUTO_SYNC_STATE,
		);
	});
});

describe('tickOutcomeForCategory', () => {
	it('maps auth categories to auth (pause)', () => {
		expect(tickOutcomeForCategory('token-rejected')).toBe('auth');
		expect(tickOutcomeForCategory('not-configured')).toBe('auth');
	});

	it('maps everything else to transient', () => {
		for (const c of [
			'rate-limited',
			'server-error',
			'network-error',
			'parse-error',
			'api-error',
		] as const) {
			expect(tickOutcomeForCategory(c)).toBe('transient');
		}
	});
});

describe('isUpdateAvailable', () => {
	it('is true only when both versions are known and listed > stored', () => {
		expect(isUpdateAvailable(200, 100)).toBe(true);
		expect(isUpdateAvailable(100, 100)).toBe(false);
		expect(isUpdateAvailable(50, 100)).toBe(false);
	});

	it('is false when either version is missing (legacy note or omitted)', () => {
		expect(isUpdateAvailable(200, undefined)).toBe(false);
		expect(isUpdateAvailable(undefined, 100)).toBe(false);
		expect(isUpdateAvailable(undefined, undefined)).toBe(false);
	});
});

describe('coerceIntervalMinutes', () => {
	it('floors below 15 to 15', () => {
		expect(coerceIntervalMinutes('5')).toBe(15);
		expect(coerceIntervalMinutes(0)).toBe(15);
		expect(coerceIntervalMinutes(-100)).toBe(15);
	});

	it('caps above 1440 to 1440', () => {
		expect(coerceIntervalMinutes(99999)).toBe(1440);
	});

	it('passes through a valid preset (string or number)', () => {
		expect(coerceIntervalMinutes('60')).toBe(60);
		expect(coerceIntervalMinutes(240)).toBe(240);
	});

	it('falls back to 60 for non-numeric input', () => {
		expect(coerceIntervalMinutes('abc')).toBe(60);
		expect(coerceIntervalMinutes(undefined)).toBe(60);
		expect(coerceIntervalMinutes(NaN)).toBe(60);
	});

	it('treats null/empty/whitespace as absent (60), not as 0 floored to 15', () => {
		expect(coerceIntervalMinutes(null)).toBe(60);
		expect(coerceIntervalMinutes('')).toBe(60);
		expect(coerceIntervalMinutes('   ')).toBe(60);
		// A genuine zero (number or string) is still an explicit too-low value
		// and floors to 15, not the default.
		expect(coerceIntervalMinutes(0)).toBe(15);
		expect(coerceIntervalMinutes('0')).toBe(15);
	});
});
