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

// isUpdateAvailable moved to import-core.ts (the acyclic pure base) so the list-
// view filter can share it without a cycle. Re-exported here so existing import
// paths (`import { isUpdateAvailable } from './auto-sync'`) keep resolving.
export { isUpdateAvailable } from './import-core';

/**
 * Per-recording classification against the vault index.
 *  - `new`: not in the vault. Import it.
 *  - `changed`: in the vault with a stored marker, and the listed `version_ms`
 *    is strictly greater. Re-import (overwrite) it.
 *  - `up-to-date-boundary`: in the vault with a stored marker and listed
 *    `version_ms` <= stored. Proof this recording has not changed. It is NOT a
 *    hard stop signal on its own: a NEW (never-imported) recording can sort
 *    below it in edit-time order once a backlog accumulates (for example while
 *    auto-sync was auth-paused), so paging must not terminate at the first one.
 *    `selectAutoSyncCandidates` stops only after a whole page yields nothing to
 *    import.
 *  - `up-to-date-current`: in the vault but no comparable marker (imported
 *    before this feature, or the list omitted `version_ms`). Migration rule:
 *    treat as current so enabling auto-sync never mass-overwrites an existing
 *    library. NOT a stop signal (we cannot prove the boundary), so paging
 *    continues past it.
 *  - `skipped-wait-pull`: still syncing from the capture device
 *    (`wait_pull === 1`); skip and catch it on a later tick.
 *  - `ignored`: the user permanently ignored this recording (its id is in the
 *    ignore set). Skip it and keep paging, exactly like `skipped-wait-pull`: it
 *    is NOT a frontier, so an importable recording below it is still reached.
 */
export type AutoSyncClassification =
	| 'new'
	| 'changed'
	| 'up-to-date-boundary'
	| 'up-to-date-current'
	| 'skipped-wait-pull'
	| 'ignored';

/** Shared empty ignore set so callers that pass none avoid allocating one. */
const NO_IGNORED_IDS: ReadonlySet<PlaudRecordingId> = new Set();

export function classifyRecording(
	recording: Recording,
	index: ReadonlyMap<PlaudRecordingId, ImportedRecord>,
	ignoredIds: ReadonlySet<PlaudRecordingId> = NO_IGNORED_IDS,
): AutoSyncClassification {
	// Ignore wins over every other state: an ignored recording must never be
	// imported by auto-sync, even if it is new or has changed in Plaud.
	if (ignoredIds.has(recording.id)) {
		return 'ignored';
	}
	// `wait_pull` tracks the device's ORIGINAL-AUDIO pull (the list's
	// `ori_ready`), NOT transcript/summary readiness. A recording is routinely
	// fully transcribed and summarized (`transcriptAvailable` / `summaryAvailable`
	// true) while `wait_pull` is still 1 for a long time; observed live at 30
	// minutes to 24 hours after the transcript was ready. Skipping on `wait_pull`
	// alone therefore withholds importable notes from auto-sync for that whole
	// window, even though the content is complete (verified: the transcript/
	// summary fetch succeeds on a `wait_pull === 1` recording). Only skip when
	// there is genuinely no content yet; a transcribed recording imports now and
	// its audio, if enabled, stays best-effort, matching the manual import path.
	// If the recording later changes, `version_ms` advances and it re-syncs.
	if (
		recording.waitPull === true &&
		!recording.transcriptAvailable &&
		!recording.summaryAvailable
	) {
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
	 * True only when EVERY recording on the page is a proven-unchanged
	 * `up-to-date-boundary` (in the vault, with a version marker, listed
	 * `version_ms` <= stored). That is the real synced frontier, so the
	 * scheduler stops paging. A page is deliberately NOT a frontier when it
	 * still holds any candidate, any `up-to-date-current` (legacy note with no
	 * marker, per the migration rule), or any `skipped-wait-pull` row: an
	 * importable recording can sort below those on a later page, so paging must
	 * continue. This replaces both the old "first up-to-date recording" break
	 * (stranded new recordings below it) and the interim "zero candidates" stop
	 * (stranded ready recordings below an all-legacy or all-wait_pull page).
	 */
	readonly reachedUpToDate: boolean;
}

/**
 * Classify one edit-time-descending page against the index and collect the
 * importable candidates. Trashed recordings are removed first (auto-sync never
 * imports trash regardless of the show-trash display setting).
 *
 * The WHOLE page is scanned rather than stopping at the first already-synced
 * recording: a `new` (never-imported) recording can sit below an
 * `up-to-date-boundary` one in edit-time order once a backlog accumulates (for
 * example after auto-sync was auth-paused and several recordings piled up), so
 * an early break would strand it. Paging stops only when the whole page is
 * proven up-to-date (see `reachedUpToDate`), which the scheduler combines with
 * its page / import caps.
 */
export function selectAutoSyncCandidates(
	page: readonly Recording[],
	index: ReadonlyMap<PlaudRecordingId, ImportedRecord>,
	ignoredIds: ReadonlySet<PlaudRecordingId> = NO_IGNORED_IDS,
): SelectCandidatesResult {
	// Never import trash. filterVisibleRecordings preserves order.
	const visible = filterVisibleRecordings(page, false);
	const candidates: AutoSyncCandidate[] = [];
	// The frontier is reached only if the page has at least one recording and
	// every one of them is an `up-to-date-boundary`. Any candidate, legacy
	// (`up-to-date-current`), pending (`skipped-wait-pull`), or `ignored` row
	// means an importable recording could still be below, so we must keep paging.
	let sawRecording = false;
	let allProvenUpToDate = true;
	for (const recording of visible) {
		sawRecording = true;
		const classification = classifyRecording(recording, index, ignoredIds);
		if (classification === 'new' || classification === 'changed') {
			candidates.push({ recording, kind: classification });
			allProvenUpToDate = false;
		} else if (classification !== 'up-to-date-boundary') {
			// 'up-to-date-current' (legacy), 'skipped-wait-pull' (pending), or
			// 'ignored': non-importable here, but NOT a frontier. Skip and keep
			// scanning so a ready recording below is still reached.
			allProvenUpToDate = false;
		}
	}
	return { candidates, reachedUpToDate: sawRecording && allProvenUpToDate };
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
	// Only a real number or a non-empty numeric string counts. null, undefined,
	// '' and whitespace must NOT go through Number() (which maps them to 0 and
	// then to the 15-minute floor); a corrupt/absent setting should land on the
	// 60-minute default, not silently become the most frequent interval.
	let n: number;
	if (typeof value === 'number') {
		n = value;
	} else if (typeof value === 'string' && value.trim() !== '') {
		n = Number(value);
	} else {
		n = NaN;
	}
	if (!Number.isFinite(n)) {
		return AUTO_SYNC_INTERVAL_DEFAULT;
	}
	return Math.min(AUTO_SYNC_INTERVAL_CEILING, Math.max(AUTO_SYNC_INTERVAL_FLOOR, Math.floor(n)));
}
