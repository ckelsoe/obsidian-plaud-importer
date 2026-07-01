// -----------------------------------------------------------------------------
// auto-sync.ts
//
// Pure, Obsidian-free logic for the optional background sync (issue #5). The
// scheduler in main.ts drives the timer and I/O; everything decision-shaped
// lives here so it is unit-testable with plain data.
//
// Detection model (verified live 2026-07-01): the list endpoint returns a
// per-recording `version_ms` edit cursor and can be sorted `sort_by=edit_time`
// descending. So a recording edited today (even an old one) sorts to the top,
// and the FIRST already-current recording marks the boundary below which
// everything is unchanged. Candidate selection is therefore O(new + changed)
// per tick, not O(vault).
// -----------------------------------------------------------------------------

import type { PlaudRecordingId, Recording } from './plaud-client';
import type { ImportedRecord } from './vault-index';
import {
	categoryAllowsReauth,
	filterVisibleRecordings,
	type ErrorCategory,
} from './import-core';

/**
 * Per-recording classification against the vault index.
 *  - `new`: not in the vault. Import it.
 *  - `changed`: in the vault with a stored marker, and the listed `version_ms`
 *    is strictly greater. Re-import (overwrite) it.
 *  - `up-to-date-boundary`: in the vault with a stored marker and listed
 *    `version_ms` <= stored. Proof it has not changed; because the list is
 *    edit-time-descending, everything BELOW it is also unchanged, so this is
 *    the stop signal.
 *  - `up-to-date-current`: in the vault but no comparable marker (imported
 *    before this feature, or the list omitted `version_ms`). Migration rule:
 *    treat as current so enabling auto-sync never mass-overwrites an existing
 *    library. NOT a stop signal (we cannot prove the boundary), so paging
 *    continues past it.
 *  - `skipped-wait-pull`: still syncing from the capture device
 *    (`wait_pull === 1`); skip and catch it on a later tick.
 */
export type AutoSyncClassification =
	| 'new'
	| 'changed'
	| 'up-to-date-boundary'
	| 'up-to-date-current'
	| 'skipped-wait-pull';

export function classifyRecording(
	recording: Recording,
	index: ReadonlyMap<PlaudRecordingId, ImportedRecord>,
): AutoSyncClassification {
	if (recording.waitPull === true) {
		return 'skipped-wait-pull';
	}
	const existing = index.get(recording.id);
	if (existing === undefined) {
		return 'new';
	}
	// Migration / unknowable: no stored marker, or the list omitted version_ms
	// this time. Cannot prove a change, so treat as current and keep paging.
	if (existing.versionMs === undefined || recording.versionMs === undefined) {
		return 'up-to-date-current';
	}
	return recording.versionMs > existing.versionMs
		? 'changed'
		: 'up-to-date-boundary';
}

export interface AutoSyncCandidate {
	readonly recording: Recording;
	/** Drives the headless duplicate policy: skip-for-new, overwrite-for-changed. */
	readonly kind: 'new' | 'changed';
}

export interface SelectCandidatesResult {
	readonly candidates: readonly AutoSyncCandidate[];
	/**
	 * True when a definitively up-to-date recording was reached (the boundary).
	 * The scheduler stops paging when this is set.
	 */
	readonly reachedUpToDate: boolean;
}

/**
 * Classify one edit-time-descending page against the index and collect the
 * importable candidates. Trashed recordings are removed first (auto-sync never
 * imports trash regardless of the show-trash display setting). Iteration stops
 * at the first `up-to-date-boundary`: everything after it in the page is older
 * and unchanged.
 */
export function selectAutoSyncCandidates(
	page: readonly Recording[],
	index: ReadonlyMap<PlaudRecordingId, ImportedRecord>,
): SelectCandidatesResult {
	// Never import trash. filterVisibleRecordings preserves order.
	const visible = filterVisibleRecordings(page, false);
	const candidates: AutoSyncCandidate[] = [];
	let reachedUpToDate = false;
	for (const recording of visible) {
		const classification = classifyRecording(recording, index);
		if (classification === 'up-to-date-boundary') {
			reachedUpToDate = true;
			break;
		}
		if (classification === 'new' || classification === 'changed') {
			candidates.push({ recording, kind: classification });
		}
		// 'skipped-wait-pull' and 'up-to-date-current' fall through: skip, keep going.
	}
	return { candidates, reachedUpToDate };
}

// -----------------------------------------------------------------------------
// Auth-pause state machine
// -----------------------------------------------------------------------------

/**
 * In-memory auto-sync run state. `paused` short-circuits ticks after an auth
 * failure (a rejected/expired 24h token) until the user re-auths;
 * `consecutiveTransientFailures` is available for optional backoff.
 */
export interface AutoSyncState {
	readonly paused: boolean;
	readonly consecutiveTransientFailures: number;
}

export const INITIAL_AUTO_SYNC_STATE: AutoSyncState = {
	paused: false,
	consecutiveTransientFailures: 0,
};

/** The bucket a tick's result falls into for the state machine. */
export type AutoSyncTickOutcome = 'ok' | 'auth' | 'transient';

/**
 * Map an error category to a tick outcome. Auth (token-rejected /
 * not-configured) pauses; everything else is transient (retry next tick, no
 * pause). Single-sources the auth predicate with the import runner via
 * `categoryAllowsReauth`.
 */
export function tickOutcomeForCategory(category: ErrorCategory): AutoSyncTickOutcome {
	return categoryAllowsReauth(category) ? 'auth' : 'transient';
}

/** Pure reducer: auth pauses, transient increments the counter, ok resumes. */
export function nextAutoSyncState(
	state: AutoSyncState,
	outcome: AutoSyncTickOutcome,
): AutoSyncState {
	switch (outcome) {
		case 'auth':
			return { paused: true, consecutiveTransientFailures: 0 };
		case 'transient':
			return {
				paused: state.paused,
				consecutiveTransientFailures: state.consecutiveTransientFailures + 1,
			};
		case 'ok':
			return INITIAL_AUTO_SYNC_STATE;
	}
}

// -----------------------------------------------------------------------------
// Interval coercion
// -----------------------------------------------------------------------------

export const AUTO_SYNC_INTERVAL_PRESETS = [15, 30, 60, 120, 240, 480, 1440] as const;
export const AUTO_SYNC_INTERVAL_FLOOR = 15;
export const AUTO_SYNC_INTERVAL_CEILING = 1440;
export const AUTO_SYNC_INTERVAL_DEFAULT = 60;

/**
 * Coerce a settings value (number, or a string from a dropdown) into a valid
 * interval in minutes: floor 15, ceiling 1440, non-numeric falls back to the
 * 60-minute default. Keeps a background timer from ever being scheduled at an
 * absurd or zero interval.
 */
export function coerceIntervalMinutes(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) {
		return AUTO_SYNC_INTERVAL_DEFAULT;
	}
	return Math.min(AUTO_SYNC_INTERVAL_CEILING, Math.max(AUTO_SYNC_INTERVAL_FLOOR, Math.floor(n)));
}
