import type { PlaudRecordingId, Recording } from '../plaud-client';
import type { ImportedRecord } from '../vault-index';
import {
	classifyRecording,
	selectAutoSyncCandidates,
	nextAutoSyncState,
	tickOutcomeForCategory,
	coerceIntervalMinutes,
	INITIAL_AUTO_SYNC_STATE,
} from '../auto-sync';

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

describe('classifyRecording', () => {
	it('classifies a recording not in the index as new', () => {
		expect(classifyRecording(rec({ id: 'a', versionMs: 100 }), idx([]))).toBe('new');
	});

	it('classifies a listed version_ms greater than stored as changed', () => {
		const index = idx([['a', { path: 'p', versionMs: 100 }]]);
		expect(classifyRecording(rec({ id: 'a', versionMs: 200 }), index)).toBe('changed');
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
		expect(classifyRecording(rec({ id: 'a', versionMs: undefined }), index)).toBe(
			'up-to-date-current',
		);
	});

	it('skips a recording still syncing from the device (wait_pull)', () => {
		expect(
			classifyRecording(rec({ id: 'a', versionMs: 999, waitPull: true }), idx([])),
		).toBe('skipped-wait-pull');
	});
});

describe('selectAutoSyncCandidates', () => {
	it('collects new and changed, and stops at the first up-to-date boundary', () => {
		// edit-time-descending page: a changed-old recording sits ABOVE the
		// boundary and must still be caught; everything after the boundary is
		// skipped without classification.
		const index = idx([
			['changed-old', { path: 'c', versionMs: 100 }],
			['boundary', { path: 'b', versionMs: 500 }],
			['below', { path: 'x', versionMs: 10 }],
		]);
		const page = [
			rec({ id: 'brand-new', versionMs: 900 }),
			rec({ id: 'changed-old', versionMs: 800 }),
			rec({ id: 'boundary', versionMs: 500 }), // == stored -> boundary, STOP
			rec({ id: 'below', versionMs: 5 }), // never examined
			rec({ id: 'also-new', versionMs: 1 }), // never examined
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(page, index);
		expect(reachedUpToDate).toBe(true);
		expect(candidates.map((c) => `${c.recording.id}:${c.kind}`)).toEqual([
			'brand-new:new',
			'changed-old:changed',
		]);
	});

	it('does not stop on a missing-marker note and never flags it changed', () => {
		const index = idx([['legacy', { path: 'l' }]]); // no versionMs
		const page = [
			rec({ id: 'legacy', versionMs: 999 }), // migration: skip, do NOT stop
			rec({ id: 'new-below', versionMs: 5 }), // must still be reached
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(page, index);
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

	it('skips wait_pull recordings but keeps scanning', () => {
		const page = [
			rec({ id: 'pending', versionMs: 900, waitPull: true }),
			rec({ id: 'ready', versionMs: 800 }),
		];
		const { candidates, reachedUpToDate } = selectAutoSyncCandidates(page, idx([]));
		expect(reachedUpToDate).toBe(false);
		expect(candidates.map((c) => c.recording.id)).toEqual(['ready']);
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
		expect(nextAutoSyncState(s1, 'transient').consecutiveTransientFailures).toBe(2);
	});

	it('a transient failure while paused stays paused', () => {
		const paused = { paused: true, consecutiveTransientFailures: 0 };
		expect(nextAutoSyncState(paused, 'transient').paused).toBe(true);
	});

	it('ok resumes and resets the counter', () => {
		const paused = { paused: true, consecutiveTransientFailures: 3 };
		expect(nextAutoSyncState(paused, 'ok')).toEqual(INITIAL_AUTO_SYNC_STATE);
	});
});

describe('tickOutcomeForCategory', () => {
	it('maps auth categories to auth (pause)', () => {
		expect(tickOutcomeForCategory('token-rejected')).toBe('auth');
		expect(tickOutcomeForCategory('not-configured')).toBe('auth');
	});

	it('maps everything else to transient', () => {
		for (const c of ['rate-limited', 'server-error', 'network-error', 'parse-error', 'api-error'] as const) {
			expect(tickOutcomeForCategory(c)).toBe('transient');
		}
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
});
