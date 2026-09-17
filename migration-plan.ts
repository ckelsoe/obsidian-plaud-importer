// The migration plan: which existing notes would have their stale recording id
// rewritten, computed from the current recording list and the vault index. Pure
// and exported so the preview UI and the apply step run the SAME logic (the
// preview can never claim something different from what Apply does), and so the
// matching is exhaustively unit-testable.
//
// A note is healed in one of two ways:
//   - via 'id' (exact): the note matches the recording by CANONICAL id but stored
//     the bare/old form of that id (see canonicalPlaudId). The rewrite is an
//     identity, not a guess, so it needs no guard. This is the common case: the
//     v4 portal keeps every v3 id as `of_<v3id>`, and an old note stored `<v3id>`.
//   - via 'start-time'/'date' (fuzzy): the note's id does not resolve at all, so
//     it is matched by an id-independent stable key (see stable-key.ts). Two
//     guards keep a fuzzy heal from ever pointing a note at the wrong meeting:
//       - the vault index stores at most one note per fallback key (a key shared
//         by two notes is disabled), and
//       - the heal fires only when exactly ONE recording carries that key, so a
//         coarse day match with two same-day, same-duration recordings is left
//         alone.

import {
	findImportedNote,
	type ImportedIndex,
	type RecordingIdentity,
} from './vault-index';
import { stableKeysFromRecording } from './stable-key';

/** The recording fields the planner needs, plus the title/time it surfaces so a
 * user can eyeball that a matched note and recording are the same meeting. */
export interface PlannableRecording extends RecordingIdentity {
	readonly title: string;
}

/** One note the migration would rewrite. */
export interface MigrationHeal {
	readonly notePath: string;
	/** The note's current (stale) plaud-id. */
	readonly fromId: string;
	/** The current recording id to write. */
	readonly toId: string;
	/** How the note was matched to the recording. `id` is an exact canonical-id
	 * match (the note held the bare/old form of the same id); the others are
	 * id-independent time matches. */
	readonly via: 'id' | 'start-time' | 'date';
	/** The matched recording's title, so the match can be verified by eye. */
	readonly recordingTitle: string;
	/** The matched recording's local date and time, `YYYY-MM-DD HH:mm`. */
	readonly recordingWhen: string;
	/** The current recording's version_ms, written alongside the id. */
	readonly versionMs?: number;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local `YYYY-MM-DD HH:mm` for a Date, matching how the day key is computed. */
function localWhen(d: Date): string {
	return (
		`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
		` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
	);
}

export interface MigrationPlan {
	/** Notes that would be rewritten. */
	readonly heals: readonly MigrationHeal[];
	/** Recordings already matched to a note by id (nothing to do). */
	readonly alreadyCurrent: number;
	/** Recordings that match no note in the vault (a new recording). */
	readonly unmatchedRecordings: number;
	/** Total recordings scanned. */
	readonly recordingCount: number;
	/** Plaud notes in the output folder (index size). */
	readonly noteCount: number;
}

function countPerKey(
	recordings: readonly RecordingIdentity[],
	pick: (keys: ReturnType<typeof stableKeysFromRecording>) => string | null,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of recordings) {
		const key = pick(
			stableKeysFromRecording(r.createdAt.getTime(), r.durationSeconds),
		);
		if (key !== null) out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

export function planMigration(
	recordings: readonly PlannableRecording[],
	index: ImportedIndex,
	versionOf: (recording: RecordingIdentity) => number | undefined = () =>
		undefined,
): MigrationPlan {
	// Recording-side uniqueness guards, one per fallback key kind.
	const perInstant = countPerKey(recordings, (k) => k.instant);
	const perDay = countPerKey(recordings, (k) => k.day);

	const heals: MigrationHeal[] = [];
	let alreadyCurrent = 0;
	let unmatched = 0;

	const pushHeal = (
		recording: PlannableRecording,
		record: { path: string; plaudId?: string },
		via: MigrationHeal['via'],
	): void => {
		heals.push({
			notePath: record.path,
			fromId: record.plaudId ?? '(unknown)',
			toId: recording.id,
			via,
			recordingTitle: recording.title,
			recordingWhen: localWhen(recording.createdAt),
			versionMs: versionOf(recording),
		});
	};

	for (const recording of recordings) {
		const match = findImportedNote(index, recording);
		if (match === null) {
			unmatched += 1;
			continue;
		}
		if (match.matchedBy === 'id') {
			// Exact canonical-id match. Already the current id, or the note stored
			// the bare/old form and we rewrite it to the current id. No guard: an
			// exact identity can never point at the wrong meeting.
			if (match.record.plaudId === recording.id) {
				alreadyCurrent += 1;
			} else {
				pushHeal(recording, match.record, 'id');
			}
			continue;
		}
		const keys = stableKeysFromRecording(
			recording.createdAt.getTime(),
			recording.durationSeconds,
		);
		// Fuzzy time match: heal only when exactly one recording carries the
		// matched key, so a note can never be rewritten toward the wrong meeting.
		if (match.matchedBy === 'instant') {
			if (keys.instant === null || perInstant.get(keys.instant) !== 1) {
				continue;
			}
			pushHeal(recording, match.record, 'start-time');
		} else {
			if (keys.day === null || perDay.get(keys.day) !== 1) {
				continue;
			}
			pushHeal(recording, match.record, 'date');
		}
	}

	return {
		heals,
		alreadyCurrent,
		unmatchedRecordings: unmatched,
		recordingCount: recordings.length,
		noteCount: index.byId.size,
	};
}
