// Recognize an already-imported meeting when its Plaud recording id has changed.
//
// The v4 portal re-issued every recording id (a v3 id like `ab4db033…` becomes a
// v4 id like `f_s_01a0…`, a different value, not just a new prefix). So the id
// stored in an existing note's `plaud-id` no longer matches the same meeting in
// the v4 list, and id-only dedup would treat every already-downloaded meeting as
// new and re-import it as a duplicate.
//
// The fix is to fall back to keys derived from properties that DO survive the id
// change: the recording's start instant and its duration. Two keys, most precise
// first:
//
//   instant  minute-rounded start time + duration. Requires a precise start,
//            which the note's `start-time` frontmatter carries on 2026-08+
//            imports. A match here is high confidence: safe to DEDUP and to HEAL
//            (rewrite the stale id onto the note).
//   day      calendar day + duration. The only key a date-only older note can
//            offer. Coarser, so it is used to DEDUP (never re-import) but never
//            to heal, and the caller disables any key shared by two notes so two
//            different meetings can never be merged.
//
// This module is pure (no Obsidian, Moment, or note-writer imports) so the keys
// are exhaustively unit-testable. The day is computed in the machine's local
// zone, matching how note-writer wrote a recording that carries no capture-zone
// offset (every v4 recording), so a recording's day key lines up with the note's
// stored `date`.

/** The id-independent keys for one meeting. `null` when the source lacks the
 * fields to build that key. */
export interface StableKeys {
	readonly instant: string | null;
	readonly day: string | null;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local-zone `YYYY-MM-DD` for a unix-ms instant, matching note-writer's
 * `formatDateYmd` for a recording with no capture offset. */
function localDayYmd(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function normalizeDuration(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const n = Number(value.trim());
		return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
	}
	return null;
}

/** Keys for a listed recording: its start instant (unix ms) and duration
 * (seconds). */
export function stableKeysFromRecording(
	startMs: number,
	durationSeconds: number,
): StableKeys {
	const dur = normalizeDuration(durationSeconds);
	if (dur === null || !Number.isFinite(startMs)) {
		return { instant: null, day: null };
	}
	return {
		instant: `i:${Math.floor(startMs / 60000)}:${dur}`,
		day: `d:${localDayYmd(startMs)}:${dur}`,
	};
}

/** Keys for an existing note, from its frontmatter. `start-time` is a precise
 * ISO instant with offset; `date` is a `YYYY-MM-DD` day; `duration-seconds` is an
 * integer. A missing or malformed field just yields a `null` for that key. */
export function stableKeysFromFrontmatter(
	fm: Record<string, unknown>,
): StableKeys {
	const dur = normalizeDuration(fm['duration-seconds']);
	if (dur === null) {
		return { instant: null, day: null };
	}
	let instant: string | null = null;
	const startTime = fm['start-time'];
	if (typeof startTime === 'string' && startTime.trim().length > 0) {
		const ms = Date.parse(startTime.trim());
		// Date.parse of an ISO string with an offset yields the absolute instant,
		// so the offset the note was written in does not matter here.
		if (Number.isFinite(ms)) {
			instant = `i:${Math.floor(ms / 60000)}:${dur}`;
		}
	}
	let day: string | null = null;
	const date = fm['date'];
	if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
		day = `d:${date.trim()}:${dur}`;
	}
	return { instant, day };
}
