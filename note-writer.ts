// Writes Plaud recordings into the vault as markdown notes. The markdown
// format is fixed by dev-docs/00-viability-findings.md §8.3:
//
//   ---
//   plaud-id: <id>
//   date: <YYYY-MM-DD>
//   duration-seconds: <n>
//   speakers: [Alice, Bob]
//   tags: [meeting, interview]
//   source: plaud
//   ---
//
//   # <title>
//
//   ## Summary
//   <summary body>
//
//   > [!note]- Transcript
//   > **[MM:SS]** Speaker: text
//   > ...
//
// The file exists as a separate module from main.ts / import-modal.ts so
// that unit tests can cover the pure format helpers in isolation. The
// NoteWriter class takes a VaultLike structural interface — tests inject a
// plain object; main.ts passes this.app.vault directly (Obsidian's Vault
// class satisfies VaultLike structurally).

import type {
	Chapter,
	ConsumerNote,
	Recording,
	Summary,
	Transcript,
	TranscriptSegment,
} from './plaud-client';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown by NoteWriter for any writer-level failure. Callers should catch
 * this specifically to render a clear message; anything else escaping from
 * writeNote is a bug.
 */
export class NoteWriterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NoteWriterError';
	}
}

// -----------------------------------------------------------------------------
// Structural DI interface — Vault from Obsidian assigns to this directly.
// -----------------------------------------------------------------------------

export interface FileLike {
	readonly path: string;
}

export interface FolderLike {
	readonly path: string;
}

export interface VaultLike {
	getFileByPath(path: string): FileLike | null;
	getFolderByPath(path: string): FolderLike | null;
	createFolder(path: string): Promise<unknown>;
	create(path: string, data: string): Promise<FileLike>;
	read(file: FileLike): Promise<string>;
	process(file: FileLike, fn: (data: string) => string): Promise<string>;
}

export type DuplicatePolicy = 'skip' | 'overwrite' | 'prompt';

/**
 * Context passed to the prompt callback when a same-recording duplicate
 * is encountered. Intentionally minimal: the callback's job is to ask
 * the user a yes/no/cancel question, not to render recording metadata.
 */
export interface DuplicatePromptContext {
	readonly recordingId: string;
	readonly recordingTitle: string;
	readonly targetPath: string;
}

/**
 * Decision returned by the prompt callback. Sticky "apply to all"
 * escalation lives at the caller layer — from the writer's point of
 * view each call either overwrites this file, skips this file, or
 * aborts the whole batch.
 */
export type DuplicatePromptDecision = 'overwrite' | 'skip' | 'cancel';

export type DuplicatePromptCallback = (
	context: DuplicatePromptContext,
) => Promise<DuplicatePromptDecision>;

/**
 * Thrown when the user cancels an in-progress import from the per-file
 * duplicate prompt. Distinct from NoteWriterError so callers can break
 * the batch loop without treating it as a write failure.
 */
export class NoteWriterCancelledError extends Error {
	constructor(message = 'Import cancelled by user from duplicate prompt') {
		super(message);
		this.name = 'NoteWriterCancelledError';
	}
}

/**
 * Markdown heading level. Matches Obsidian's H1-H6 and validates
 * settings deserialization: any other value is rejected at runtime so
 * a malformed `data.json` can't produce zero or seven `#` characters.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface NoteWriterOptions {
	readonly outputFolder: string;
	/**
	 * Optional subfolder template appended to `outputFolder`, resolved per
	 * recording against its date via `resolveSubfolder`. Empty or omitted
	 * reproduces the flat `outputFolder`-only layout. See `resolveSubfolder`
	 * for the token list and rules.
	 */
	readonly subfolderTemplate?: string;
	/**
	 * Optional vault-wide lookup from a `plaud-id` to the path of an existing
	 * note for that recording, anywhere under the output folder. Lets the
	 * writer find a prior import that lives in a DIFFERENT subfolder (for
	 * example after the user edits `subfolderTemplate`) so it applies the
	 * duplicate policy to that note instead of silently writing a second copy.
	 * Returns null when no prior note exists. When omitted, the writer falls
	 * back to the path-scoped check only.
	 */
	readonly existingPathForPlaudId?: (plaudId: string) => string | null;
	readonly onDuplicate: DuplicatePolicy;
	/**
	 * Required when `onDuplicate === 'prompt'`. Invoked per duplicate
	 * same-recording match so the caller can ask the user what to do.
	 * Ignored for 'skip' and 'overwrite'. Construction throws if the
	 * policy is 'prompt' but this callback is missing.
	 */
	readonly promptOnDuplicate?: DuplicatePromptCallback;
	/**
	 * When false, the writer omits the transcript section entirely
	 * (no flat callout, no heading-wrapped chaptered form). The
	 * generated note still contains frontmatter, summary, and the
	 * chapters list (if available). Defaults to true when the caller
	 * doesn't supply a value.
	 */
	readonly includeTranscript?: boolean;
	/**
	 * When false, the writer omits the summary section entirely.
	 * Defaults to true when omitted.
	 */
	readonly includeSummary?: boolean;
	/**
	 * Markdown heading level used for the wrapping `Transcript`
	 * heading when chapters are present. Per-chapter sub-headings
	 * render one level deeper (e.g. `transcriptHeaderLevel: 4` →
	 * `#### Transcript` + `##### MM:SS Title`). Defaults to 4 when
	 * the caller doesn't supply a value — deep enough to nest under
	 * the `## Summary` H2 without colliding with it, and the default
	 * Obsidian heading fold behavior treats H4 as a natural fold
	 * point for a "supporting content" section.
	 */
	readonly transcriptHeaderLevel?: HeadingLevel;
}

/**
 * Fold metadata surfaced by `writeNote` for callers that want to apply
 * Obsidian fold state after the write. Populated only when the note
 * was actually written (`created` or `overwritten`) AND the generated
 * markdown contains a wrapping transcript heading. `transcriptHeadingLine`
 * is the 0-based line index of the single heading the caller should
 * fold (the wrapping `Transcript` heading at the configured level);
 * `totalLines` is the full line count of the rendered markdown needed
 * to build a complete `FoldInfo` payload for `app.foldManager.save`.
 */
export interface WriteFoldInfo {
	readonly transcriptHeadingLine: number;
	readonly totalLines: number;
}

export type WriteOutcome =
	| {
			readonly status: 'created';
			readonly path: string;
			readonly foldInfo?: WriteFoldInfo;
	  }
	| {
			readonly status: 'overwritten';
			readonly path: string;
			readonly foldInfo?: WriteFoldInfo;
	  }
	| { readonly status: 'skipped'; readonly path: string };

/**
 * Result of writing a placeholder note for an unprocessed recording.
 *   - 'created': no prior note existed; a fresh stub was written.
 *   - 'refreshed': an older placeholder existed and was rewritten.
 *   - 'kept-existing': a real (non-placeholder) note already existed for this
 *     recording, so it was left untouched. Never downgrade real content to a
 *     stub.
 */
export type PlaceholderWriteOutcome = {
	readonly status: 'created' | 'refreshed' | 'kept-existing';
	readonly path: string;
};

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing).
// -----------------------------------------------------------------------------

/**
 * Sanitize a Plaud recording title into a filename that is legal on Windows,
 * macOS, and Linux and doesn't collide with Obsidian's wikilink parser.
 * Never throws, always returns a non-empty string.
 */
export function sanitizeFilename(title: string): string {
	// Strip leading/trailing whitespace first so subsequent length checks
	// don't operate on padded input.
	let out = title.trim();

	// Collapse runs of whitespace (including newlines and tabs) into single
	// spaces FIRST. A multi-line title should flatten to a space-separated
	// single line, not gain dashes at every line break.
	out = out.replace(/\s+/g, ' ');

	// Now replace the Windows-forbidden chars, square brackets (wikilink
	// collision), and any remaining non-whitespace control characters with
	// dashes. Whitespace control chars like \t and \n were already handled
	// by the step above, so what's left is things like NUL (\x00) and the
	// other non-whitespace control codes.
	// eslint-disable-next-line no-control-regex -- intentional: this class strips NUL and other non-whitespace control codes from the filename
	out = out.replace(/[<>:"/\\|?*\x00-\x08\x0b\x0c\x0e-\x1f[\]]/g, '-');

	// Strip trailing dots and spaces — Windows silently drops them from
	// filenames, which causes "File.md" and "File .md" to collide.
	out = out.replace(/[. ]+$/, '');
	out = out.replace(/^[. ]+/, '');

	// Clamp length: 200 chars leaves room for ".md" + any disambiguation
	// suffix the vault layer might add. Filesystems typically cap at 255.
	if (out.length > 200) {
		out = out.slice(0, 200).trim();
		// Re-strip trailing dots/spaces after the slice.
		out = out.replace(/[. ]+$/, '');
	}

	// Reserved Windows device names — even with an extension these can
	// confuse legacy code. Prefix with an underscore to neutralize.
	const reserved = new Set([
		'CON', 'PRN', 'AUX', 'NUL',
		'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
		'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
	]);
	if (reserved.has(out.toUpperCase())) {
		out = `_${out}`;
	}

	// Empty-after-sanitization fallback. This can happen for titles that are
	// entirely punctuation or whitespace.
	if (out.length === 0) {
		out = 'Untitled';
	}

	return out;
}

/**
 * Format seconds as a clock-style timestamp for use in a transcript marker.
 * Always uses two-digit minutes and seconds. Emits hours only when the
 * timestamp crosses the one-hour mark.
 *
 *   formatTimestamp(0)     === "00:00"
 *   formatTimestamp(65)    === "01:05"
 *   formatTimestamp(3725)  === "1:02:05"
 */
export function formatTimestamp(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return '00:00';
	}
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => String(n).padStart(2, '0');
	if (h > 0) {
		return `${h}:${pad(m)}:${pad(s)}`;
	}
	return `${pad(m)}:${pad(s)}`;
}

/**
 * Build the public web-app URL for a Plaud recording. This is the link a
 * user clicks to open the recording in Plaud's browser UI. The pattern
 * `https://web.plaud.ai/file/{id}` was confirmed from a live Plaud
 * session on 2026-04-14 — see `dev-docs/deferred-decisions.md` DD-002
 * for the stable-ID risk that makes this a tracked deferred decision
 * rather than a permanent constant.
 *
 * The ID is passed through `encodeURIComponent` for defense-in-depth,
 * matching the same treatment `plaud-client-re.ts` applies to the ID
 * when building the `/ai/transsumm/{id}` API URL. Real Plaud IDs are
 * 32-char hex strings that need no encoding, but a future ID format
 * change (slashes, dots, etc.) would silently produce broken URLs
 * without this guard.
 */
export function formatPlaudWebUrl(recordingId: string): string {
	return `https://web.plaud.ai/file/${encodeURIComponent(recordingId)}`;
}

/**
 * Substitute Plaud's template placeholders inside a markdown body. Plaud's
 * summary templates contain tokens like `$[audio_start_time]` that the
 * Plaud web UI replaces with concrete values on the client before
 * rendering. Their API returns the RAW template body, so without this
 * substitution our notes would show literal `$[audio_start_time]` text
 * where a date should be.
 *
 * Known placeholders (filled in from the recording / transcript we
 * already have on hand):
 *   $[audio_start_time]  → "YYYY-MM-DD HH:MM:SS" in local time
 *   $[audio_title]       → recording.title
 *   $[audio_duration]    → human-readable duration
 *   $[speakers]          → comma-separated speaker list
 *
 * Unknown placeholders are left untouched so user notes are never
 * silently mangled by a regex on a token we don't have data for. New
 * tokens Plaud adds in future templates show through verbatim and a
 * follow-up can wire them in once we know what they should resolve to.
 */
export function substitutePlaudPlaceholders(
	markdown: string,
	recording: Recording,
	transcript: Transcript | null,
): string {
	if (markdown.length === 0) return markdown;
	return markdown.replace(/\$\[([a-z0-9_]+)\]/g, (match, key: string) => {
		switch (key) {
			case 'audio_start_time':
				return formatLocalDateTime(recording.createdAt);
			case 'audio_title':
				return recording.title;
			case 'audio_duration':
				return formatDurationHoursMinutes(recording.durationSeconds);
			case 'speakers': {
				const speakers = extractSpeakers(transcript);
				return speakers.length > 0 ? speakers.join(', ') : match;
			}
			default:
				return match;
		}
	});
}

/**
 * Local-time "YYYY-MM-DD HH:MM:SS" formatter that matches the wall-clock
 * format Plaud's own UI uses (e.g. `2026-05-13 14:04:22`). Local time so
 * the rendered note reads naturally for the user who recorded it; this
 * matches what they see on web.plaud.ai.
 */
function formatLocalDateTime(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Extract the deduplicated, ordered list of distinct speakers from a
 * transcript. First-seen order is preserved so frontmatter reads naturally.
 */
export function extractSpeakers(transcript: Transcript | null): readonly string[] {
	if (!transcript) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const segment of transcript.segments) {
		const name = segment.speaker?.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

function formatDateYmd(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Tokens recognized in a destination subfolder template. Each expands from
 * the recording's own date, using the SAME local-time basis as the `date:`
 * frontmatter field (formatDateYmd) so the folder and the field never
 * disagree about which day a recording belongs to.
 */
const SUBFOLDER_TOKENS = ['yyyy', 'MM', 'dd', 'yyyy-MM', 'ww', 'Q'] as const;

/**
 * ISO 8601 week number (1-53) for a date, computed from its LOCAL calendar
 * day so it agrees with the other tokens' local-time basis. Week 1 is the
 * week containing the first Thursday of the year; weeks start Monday. The
 * arithmetic runs in UTC purely to sidestep DST hour shifts — only the
 * local Y/M/D are fed in, so the result is the local day's ISO week.
 *
 * Caveat for templates that pair `{{yyyy}}` with `{{ww}}`: ISO weeks belong
 * to an ISO week-year that can differ from the calendar year by one at the
 * Dec/Jan boundary (e.g. 2027-01-01 can be ISO week 53). `{{yyyy}}` is the
 * calendar year, so a handful of boundary recordings may file under a
 * calendar year that disagrees with their ISO week. This is cosmetic for
 * foldering and avoids exposing a second, confusing week-year token.
 */
function isoWeekNumber(year: number, monthIndex: number, day: number): number {
	const d = new Date(Date.UTC(year, monthIndex, day));
	const dayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
	d.setUTCDate(d.getUTCDate() - dayOfWeek + 3); // shift to the week's Thursday
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
	const msPerWeek = 7 * 24 * 60 * 60 * 1000;
	return 1 + Math.round((d.getTime() - firstThursday.getTime()) / msPerWeek);
}

/**
 * Resolve a user-configured subfolder template against a recording's date.
 *
 * The result is a vault-relative subpath (no leading/trailing slash) that the
 * caller appends to the output folder. Keying off the recording date (not the
 * import date) keeps the resolved path a pure function of the recording's own
 * metadata, so the same recording always lands in the same folder and the
 * duplicate guard keeps working across re-imports.
 *
 * Rules:
 *  - An empty or whitespace-only template returns '' (flat, current behavior).
 *  - Literal path text is preserved: `meetings/{{yyyy}}` is valid.
 *  - An unknown `{{token}}` throws, so a typo surfaces instead of silently
 *    creating a `{{yyy}}` folder.
 *  - A missing or invalid recording date resolves to the `_undated` bucket
 *    rather than collapsing tokens to empty path segments.
 *  - The expanded path runs through normalizeFolderPath, so `..` traversal and
 *    redundant slashes are rejected/cleaned the same as the output folder.
 */
export function resolveSubfolder(template: string, date: Date): string {
	if (template.trim() === '') {
		return '';
	}
	const dateValid = date instanceof Date && !Number.isNaN(date.getTime());
	const pad = (n: number): string => String(n).padStart(2, '0');
	const expand = (token: string): string => {
		switch (token) {
			case 'yyyy':
				return String(date.getFullYear());
			case 'MM':
				return pad(date.getMonth() + 1);
			case 'dd':
				return pad(date.getDate());
			case 'yyyy-MM':
				return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
			case 'ww':
				return pad(
					isoWeekNumber(date.getFullYear(), date.getMonth(), date.getDate()),
				);
			case 'Q':
				return String(Math.floor(date.getMonth() / 3) + 1);
			default:
				return '';
		}
	};
	let sawUndatedToken = false;
	const replaced = template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_match, raw: string) => {
		const token = raw.trim();
		if (!(SUBFOLDER_TOKENS as readonly string[]).includes(token)) {
			throw new NoteWriterError(
				`Unknown subfolder template token "{{${token}}}" — valid tokens: ${SUBFOLDER_TOKENS.join(', ')}`,
			);
		}
		if (!dateValid) {
			sawUndatedToken = true;
			return '';
		}
		return expand(token);
	});
	if (sawUndatedToken) {
		return '_undated';
	}
	return normalizeFolderPath(replaced);
}

/**
 * Join an output folder with a resolved subfolder, tolerating either side
 * being empty so the flat case (`subfolder === ''`) reproduces the original
 * `outputFolder`-only path exactly.
 */
function joinFolderPath(base: string, sub: string): string {
	if (base === '') {
		return sub;
	}
	if (sub === '') {
		return base;
	}
	return `${base}/${sub}`;
}

/**
 * Ensure a recording title carries a leading YYYY-MM-DD date so notes sort
 * chronologically in the file explorer and group by day.
 *
 * - A title already led by a full YYYY-MM-DD (dash) date is returned unchanged.
 * - Plaud's default MM-DD (dash) prefix gets the year from `date` prepended.
 * - A title led by any other date form (slash or dot separators, a single-digit
 *   month/day, or a year-first date) is left unchanged, so a title that already
 *   shows a date is never given a second one.
 * - A truly dateless title gets the full YYYY-MM-DD from `date` prepended.
 *
 *   "04-13 Meeting"     -> "2026-04-13 Meeting"          (MM-DD: prepend year)
 *   "2026-04-13 Done"   -> "2026-04-13 Done"             (already a full date)
 *   "Quarterly review"  -> "2026-04-13 Quarterly review" (dateless: prepend)
 *   "06/13 Sync"        -> "06/13 Sync"                  (other date form: kept)
 *
 * The date is the recording's createdAt, the same value formatDateYmd writes to
 * the `date:` frontmatter, so the filename prefix and that field agree. Runs
 * once in writeNote for both the filename (via sanitizeFilename) and the H1
 * heading (via formatMarkdown) so the two stay in sync.
 */
export function expandTitleWithYear(title: string, date: Date): string {
	const trimmed = title.trim();
	// Already a full YYYY-MM-DD (dash) prefix: canonical, leave as-is.
	if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
		return trimmed;
	}
	// Plaud's default MM-DD (dash) prefix: prepend the year from the
	// recording's createdAt so the title reads as a full YYYY-MM-DD date
	// followed by the original description.
	if (/^\d{2}-\d{2}(\s|$)/.test(trimmed)) {
		return `${date.getFullYear()}-${trimmed}`;
	}
	// Some other leading date form (slash or dot separators, a single-digit
	// month/day, or a year-first date). Ordered after the two dash branches
	// so it only sees the forms they did not handle. Leave it unchanged
	// rather than prepend a second date onto a title that already shows one.
	if (/^\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,4})?(?:\s|$)/.test(trimmed)) {
		return trimmed;
	}
	// Truly dateless: prepend the full recording date so the note sorts by
	// day. An empty title collapses to just the date.
	const ymd = formatDateYmd(date);
	return trimmed ? `${ymd} ${trimmed}` : ymd;
}

/**
 * Format a duration (in seconds) as a readable "hours and minutes" string
 * for the `duration` frontmatter field. The accompanying `duration-seconds`
 * field keeps the raw integer so Dataview can do arithmetic.
 *
 *   formatDurationHoursMinutes(45)     === "45s"
 *   formatDurationHoursMinutes(90)     === "2m"
 *   formatDurationHoursMinutes(600)    === "10m"
 *   formatDurationHoursMinutes(3600)   === "1h"
 *   formatDurationHoursMinutes(5430)   === "1h 31m"
 *   formatDurationHoursMinutes(0)      === "0s"
 */
export function formatDurationHoursMinutes(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return '0s';
	}
	const total = Math.round(seconds);
	if (total < 60) {
		return `${total}s`;
	}
	const totalMinutes = Math.round(total / 60);
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes - h * 60;
	if (m === 0) {
		return `${h}h`;
	}
	return `${h}h ${m}m`;
}

// Reserved YAML tokens that parse as something other than a string if left
// unquoted. Covers all the common casings a real title/id could match.
const YAML_RESERVED_TOKENS = new Set([
	'true', 'True', 'TRUE',
	'false', 'False', 'FALSE',
	'yes', 'Yes', 'YES',
	'no', 'No', 'NO',
	'on', 'On', 'ON',
	'off', 'Off', 'OFF',
	'null', 'Null', 'NULL',
	'~',
]);

/**
 * Quote a YAML scalar if it could be misparsed as something other than a
 * string. Uses double-quoted form with `\\`, `"`, and whitespace control
 * characters escaped. Plain strings that are unambiguously string-typed and
 * contain no special characters pass through unquoted.
 *
 * Rules for unquoted pass-through:
 *  - Must start with an ASCII letter (no leading digit/minus — avoids
 *    number and date parsing), underscore forbidden at the start.
 *  - Remaining characters must be alphanumeric, space, underscore, period,
 *    or hyphen.
 *  - Must not match any YAML_RESERVED_TOKEN — so a speaker named "Yes" or a
 *    Plaud ID that happens to be "null" gets quoted.
 */
function yamlScalar(value: string): string {
	if (
		value.length > 0 &&
		/^[A-Za-z][A-Za-z0-9 _.-]*$/.test(value) &&
		!YAML_RESERVED_TOKENS.has(value)
	) {
		return value;
	}
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
	return `"${escaped}"`;
}

function yamlArray(items: readonly string[]): string {
	return `[${items.map(yamlScalar).join(', ')}]`;
}

/**
 * Merge curated base tags with Plaud's AI-generated keywords into a single
 * deduplicated tag list for a note's `tags:` frontmatter.
 *
 * The normalization rules were chosen by Charles on 2026-04-14 after the
 * DD-004 investigation turned up Plaud's `aiContentHeader.keywords` field:
 *
 *  1. **Namespace** — AI keywords are prefixed with `plaud/` so they never
 *     mingle with user-curated tags in a nested tag search. Base tags keep
 *     whatever namespace Plaud's list endpoint gave them.
 *  2. **Slugify** — AI keywords are lowercased, their internal whitespace
 *     runs are collapsed to single dashes, and leading / trailing dashes
 *     are stripped. `"AI Agent"` becomes `plaud/ai-agent`.
 *  3. **Dedup** — both input lists are lowercased for comparison so two
 *     entries that differ only in case collapse to one. The first
 *     occurrence wins (base tags before AI tags).
 *  4. **Ordering** — base tags first in their original insertion order,
 *     then AI tags appended in Plaud's original insertion order.
 *
 * Returns a new frozen-style `readonly string[]`; callers must not mutate.
 * Empty or whitespace-only entries on either side are dropped before any
 * other processing — they should never end up in a YAML array.
 */
export function mergeTagSources(
	baseTags: readonly string[] | undefined,
	aiKeywords: readonly string[] | undefined,
): readonly string[] {
	return buildNoteTags(baseTags, aiKeywords, {
		tagMode: 'all',
		customTags: '',
		aiKeywordsAsProperty: false,
	}).tags;
}

/** Which tag sources land in the note's `tags:` frontmatter. */
export type TagMode = 'none' | 'custom' | 'plaud' | 'all';

export interface TagBuildOptions {
	readonly tagMode: TagMode;
	/** Raw comma-separated value from the "Custom tags" setting. */
	readonly customTags: string;
	/**
	 * When AI keywords are excluded from `tags:` (every mode except `all`),
	 * surface them as a `keywords:` frontmatter property instead.
	 */
	readonly aiKeywordsAsProperty: boolean;
}

export interface NoteTagResult {
	/** Final list for the `tags:` frontmatter key. May be empty. */
	readonly tags: readonly string[];
	/** List for the `keywords:` frontmatter key. Empty when not wanted. */
	readonly keywords: readonly string[];
}

/**
 * Build the tag and keyword lists for a note's frontmatter from the two
 * Plaud sources plus the user's custom tags, honoring the tag settings.
 *
 * Tag selection by mode:
 *  - `none`: no tags at all (custom tags excluded too).
 *  - `custom`: only the user's custom tags.
 *  - `plaud`: human-set Plaud tags plus custom tags. AI keywords dropped.
 *  - `all`: everything, matching the pre-settings behavior.
 *
 * Normalization reuses the DD-004 rules documented on `mergeTagSources`:
 * base and custom tags are trimmed, lowercased, and deduped
 * case-insensitively; AI keywords are slugified and prefixed `plaud/`.
 * Output order: base tags, then custom tags, then AI tags, each group in
 * its original insertion order, first occurrence winning on collision.
 *
 * The `keywords` result holds the trimmed ORIGINAL keyword strings (no
 * slugify, no prefix, case-insensitive dedup). It is populated whenever
 * the mode excludes AI keywords from `tags:` and `aiKeywordsAsProperty`
 * is on. A `keywords:` property never pollutes Obsidian's tag pane but
 * stays searchable and Dataview-queryable.
 */
export function buildNoteTags(
	baseTags: readonly string[] | undefined,
	aiKeywords: readonly string[] | undefined,
	options: TagBuildOptions,
): NoteTagResult {
	const seen = new Set<string>();
	const tags: string[] = [];

	const pushPlainTag = (tag: string): void => {
		if (typeof tag !== 'string') {
			return;
		}
		const normalized = tag.trim().toLowerCase();
		if (normalized.length === 0 || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		tags.push(normalized);
	};

	if (options.tagMode === 'plaud' || options.tagMode === 'all') {
		for (const tag of baseTags ?? []) {
			pushPlainTag(tag);
		}
	}

	if (options.tagMode !== 'none') {
		for (const tag of options.customTags.split(',')) {
			pushPlainTag(tag);
		}
	}

	if (options.tagMode === 'all') {
		for (const keyword of aiKeywords ?? []) {
			if (typeof keyword !== 'string') {
				continue;
			}
			const slug = keyword
				.trim()
				.toLowerCase()
				.replace(/\s+/g, '-')
				.replace(/^-+|-+$/g, '');
			if (slug.length === 0) {
				continue;
			}
			const prefixed = `plaud/${slug}`;
			if (seen.has(prefixed)) {
				continue;
			}
			seen.add(prefixed);
			tags.push(prefixed);
		}
	}

	const keywords: string[] = [];
	if (options.tagMode !== 'all' && options.aiKeywordsAsProperty) {
		const seenKeywords = new Set<string>();
		for (const keyword of aiKeywords ?? []) {
			if (typeof keyword !== 'string') {
				continue;
			}
			const trimmed = keyword.trim();
			if (trimmed.length === 0) {
				continue;
			}
			const dedupKey = trimmed.toLowerCase();
			if (seenKeywords.has(dedupKey)) {
				continue;
			}
			seenKeywords.add(dedupKey);
			keywords.push(trimmed);
		}
	}

	return { tags, keywords };
}

export function formatFrontmatter(
	recording: Recording,
	speakers: readonly string[],
	summary?: Summary | null,
	keywords?: readonly string[],
	folders?: readonly string[],
): string {
	const duration = Number.isFinite(recording.durationSeconds)
		? Math.max(0, Math.floor(recording.durationSeconds))
		: 0;

	const lines: string[] = ['---'];
	lines.push(`plaud-id: ${yamlScalar(recording.id)}`);
	// plaud-url is a clickable breadcrumb back to the Plaud web app.
	// yamlScalar force-quotes it (colons and slashes aren't in the
	// unquoted allowlist), which is what we want — YAML treats an
	// unquoted `https://...` scalar as a mapping key + value on some
	// parsers.
	lines.push(`plaud-url: ${yamlScalar(formatPlaudWebUrl(recording.id))}`);
	lines.push(`date: ${formatDateYmd(recording.createdAt)}`);
	lines.push(`duration-seconds: ${duration}`);
	// Human-readable duration alongside the raw seconds so users can read
	// it at a glance without the note also pretending to support Dataview
	// arithmetic on a pre-formatted string.
	lines.push(`duration: ${yamlScalar(formatDurationHoursMinutes(duration))}`);
	if (speakers.length > 0) {
		lines.push(`speakers: ${yamlArray(speakers)}`);
	}
	if (recording.tags && recording.tags.length > 0) {
		lines.push(`tags: ${yamlArray(recording.tags)}`);
	}
	// Resolved Plaud folder name(s) for the recording (issue #16). Separate from
	// tags: this keeps the original folder name (case, spaces, `&`) for humans
	// and Dataview, while tags: carries the slugified tag form. Emitted only for
	// filed recordings; unfiled ones get no key.
	if (folders && folders.length > 0) {
		lines.push(`plaud-folder: ${yamlArray(folders)}`);
	}
	// AI keywords demoted from tags by the tag-mode setting. A plain
	// frontmatter property is searchable and Dataview-queryable but does
	// not feed Obsidian's vault-wide tag pane.
	if (keywords && keywords.length > 0) {
		lines.push(`keywords: ${yamlArray(keywords)}`);
	}
	lines.push('source: plaud');
	// Auto-sync change cursor: the recording's edit version (unix ms). Stored so
	// a later sync can compare the list's current version_ms against it and
	// re-import only when Plaud actually changed the recording. Emitted as a raw
	// number (no quoting) so metadataCache surfaces it as a number. Absent for
	// recordings whose list payload omitted version_ms.
	if (recording.versionMs !== undefined) {
		lines.push(`plaud-version-ms: ${recording.versionMs}`);
	}

	// Optional Plaud summary extras. Each line is emitted only when the
	// corresponding field is present on the Summary. Missing summary or
	// missing fields produces no output — frontmatter stays clean for
	// recordings that pre-date the flat GPT-5 schema and for any future
	// Plaud shape that drops one of these fields. Add new known extras
	// here without changing any other call site.
	if (summary) {
		const extras: ReadonlyArray<readonly [string, string | undefined]> = [
			['plaud-headline', summary.headline],
			['plaud-category', summary.category],
			['plaud-language', summary.language],
			['plaud-template', summary.template],
			['plaud-model', summary.model],
			['plaud-note-id', summary.noteId],
			['plaud-summary-id', summary.summaryId],
			['plaud-summary-version', summary.version],
		];
		for (const [key, value] of extras) {
			if (value !== undefined) {
				lines.push(`${key}: ${yamlScalar(value)}`);
			}
		}
	}

	lines.push('---');
	return lines.join('\n');
}

/**
 * Extract the `plaud-id` value from a note's YAML frontmatter, if any. Used
 * by the writer to detect filename collisions — if a note already exists at
 * the target path with a different plaud-id, writing would destroy someone
 * else's recording and we must refuse loudly.
 *
 * Returns null if the content has no frontmatter, no plaud-id key, or the
 * frontmatter is malformed enough that we can't parse the id.
 */
export function extractPlaudIdFromFrontmatter(content: string): string | null {
	const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!block) {
		return null;
	}
	const idLine = block[1].match(/^plaud-id:\s*(.*?)\s*$/m);
	if (!idLine) {
		return null;
	}
	let value = idLine[1].trim();
	// Strip matched surrounding quotes (YAML double-quoted form).
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
		// Unescape the standard double-quoted escapes we emit.
		value = value
			.replace(/\\"/g, '"')
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r')
			.replace(/\\t/g, '\t')
			.replace(/\\\\/g, '\\');
	}
	return value.length > 0 ? value : null;
}

/**
 * Detect whether a note's YAML frontmatter carries the `plaud-placeholder:
 * true` marker. A placeholder note is a stub the importer writes when Plaud
 * confirmed (via an in-band server error) that it has no transcript or summary
 * for a recording yet; it holds only the link and recording ID. The writer
 * uses this to let a later real import always supersede a placeholder,
 * regardless of the user's duplicate policy, and to avoid downgrading a real
 * note back to a stub.
 *
 * Returns false for any note without frontmatter, without the key, or with the
 * key set to anything other than a truthy `true`/`yes` token.
 */
export function extractPlaudPlaceholderFlag(content: string): boolean {
	const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!block) {
		return false;
	}
	const markerLine = block[1].match(/^plaud-placeholder:\s*(.*?)\s*$/m);
	if (!markerLine) {
		return false;
	}
	const value = markerLine[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
	return value === 'true' || value === 'yes';
}

function formatSummaryBody(summary: Summary | null): string {
	if (!summary) {
		return '_No summary available._';
	}
	if (summary.sections && summary.sections.length > 0) {
		return summary.sections
			.map((section) => `### ${section.heading}\n\n${section.body.trim()}`)
			.join('\n\n');
	}
	return neutralizeSetextDashes(stripLeadingSummaryHeading(summary.text.trim()));
}

function stripLeadingSummaryHeading(text: string): string {
	// Plaud often prefixes summary markdown with a top-level heading that
	// repeats the note title. Keep note content natural by removing only the
	// first leading ATX heading block and preserving everything else.
	const withoutHeading = text.replace(/^#{1,6}[^\n]*\n+/, '');
	return withoutHeading.trim().length > 0 ? withoutHeading.trim() : text;
}

function neutralizeSetextDashes(text: string): string {
	// A line of dashes directly after a paragraph is interpreted as a setext
	// heading underline in markdown, which incorrectly turns the preceding
	// paragraph into a giant heading. Convert dashed separators to `***`
	// thematic breaks to preserve normal paragraph rendering. The consumer_note
	// path uses normalizeConsumerNoteBody (fence-aware) instead of this helper.
	return text.replace(/^-{3,}\s*$/gm, '***');
}

/**
 * One chapter paired with the transcript segments that belong to it.
 * `blockId` is a stable per-chapter identifier used only as an
 * internal "has segment content" marker for formatting decisions. When
 * a chapter has zero segments the block id is `null`, and its chapters
 * list row renders as plain text since there's no jump target.
 */
export interface TranscriptChapterGroup {
	readonly chapter: Chapter;
	readonly segments: readonly TranscriptSegment[];
	readonly blockId: string | null;
}

/**
 * Partition a transcript into one group per chapter by advancing the
 * chapter cursor every time a segment's `startSeconds` crosses into the
 * next chapter's window. Segments that start before the first chapter
 * (an unusual but possible shape) attach to the first chapter so the
 * transcript is never silently truncated.
 *
 * Each group's `headingAnchor` is `"MM:SS Title"` when the group has at
 * least one segment, `null` otherwise. The caller uses this to decide
 * whether the chapters-list row should be a wiki link to a real heading
 * inside the transcript or fall back to plain text.
 *
 * Returns `[]` when either the transcript or the chapters list is
 * empty, signaling the caller to fall back to the unlinked
 * single-callout transcript the plugin rendered before DD-004's chapter
 * work landed.
 */
export function groupTranscriptByChapters(
	transcript: Transcript | null,
	chapters: readonly Chapter[] | undefined,
): readonly TranscriptChapterGroup[] {
	if (!transcript || transcript.segments.length === 0) {
		return [];
	}
	if (!chapters || chapters.length === 0) {
		return [];
	}

	// Drop chapters with blank titles up-front so they don't consume
	// heading slots and so the chapter list renders consistently with
	// what the parser dropped.
	const cleanChapters = chapters.filter((c) => c.title.trim().length > 0);
	if (cleanChapters.length === 0) {
		return [];
	}

	const buckets: TranscriptSegment[][] = cleanChapters.map(() => []);
	for (const segment of transcript.segments) {
		// Find the last chapter whose startSeconds is <= segment.startSeconds.
		// Chapters are assumed to be in ascending order (parseOutlineBody
		// preserves the Plaud wire order, which is ascending).
		let idx = 0;
		for (let i = 0; i < cleanChapters.length; i++) {
			if (cleanChapters[i].startSeconds <= segment.startSeconds) {
				idx = i;
			} else {
				break;
			}
		}
		buckets[idx].push(segment);
	}

	return cleanChapters.map((chapter, i) => {
		const segments = buckets[i];
		return {
			chapter,
			segments,
			blockId: segments.length > 0 ? `t-ch-${i}` : null,
		};
	});
}

/**
 * Block ID attached to the in-section "Chapters" index block inside the
 * `Transcript` heading. Each chapter section renders a "Back to
 * Chapters" wiki-link that targets this id, so readers can jump up to
 * the chapter list without scrolling.
 *
 * Exported so tests can reference the exact id string without
 * duplicating it. Obsidian block ids must match `^[a-zA-Z0-9-]+` —
 * `plaud-chapters` satisfies that and is namespaced with the plugin
 * slug so it doesn't collide with user-curated block ids in the
 * same note.
 */
export const CHAPTERS_BLOCK_ID = 'plaud-chapters';

/**
 * Sanitizes a chapter title for safe use inside a heading anchor.
 * Obsidian heading wiki-links split on `|` and `#`, and square brackets
 * can interfere with wikilink parsing in edge cases.
 */
function sanitizeChapterHeadingTitle(title: string): string {
	return title.replace(/[|[\]#]/g, '-');
}

/**
 * Returns the exact heading text emitted for a chapter section inside
 * the transcript block. Kept in one helper so both the chapter index
 * links and heading renderer cannot drift.
 */
function chapterHeadingText(chapter: Chapter): string {
	const stamp = formatTimestamp(chapter.startSeconds);
	return `${stamp} ${sanitizeChapterHeadingTitle(chapter.title.trim())}`;
}

/**
 * Render the "Chapters" subsection that sits immediately under the
 * wrapping `Transcript` heading. Each row links down to a chapter
 * heading in the transcript body, and a block id is appended after the
 * list so chapter sections can link back up via
 * `[[#^plaud-chapters|Back to Chapters]]`.
 */
export function formatChapterIndexSection(
	groups: readonly TranscriptChapterGroup[],
	headerLevel: HeadingLevel = 4,
): string {
	if (groups.length === 0) {
		return '';
	}
	const prefix = '#'.repeat(Math.min(headerLevel + 1, 6));
	const lines: string[] = [`${prefix} Chapters`, ''];
	let rendered = 0;
	for (const group of groups) {
		const title = group.chapter.title.trim();
		if (title.length === 0) {
			continue;
		}
		const stamp = formatTimestamp(group.chapter.startSeconds);
		const display = `**[${stamp}]** ${title}`;
		if (group.blockId === null) {
			lines.push(`- ${display}`);
		} else {
			const anchor = chapterHeadingText(group.chapter);
			lines.push(`- [[#${anchor}|${display}]]`);
		}
		rendered += 1;
	}
	if (rendered === 0) {
		return '';
	}
	lines.push('');
	// Block id on its own line directly after the chapter list so the
	// section's "Back to Chapters" links have a stable target.
	lines.push(`^${CHAPTERS_BLOCK_ID}`);
	return lines.join('\n');
}

/**
 * Render the transcript section.
 *
 * **No chapters** — emit the original collapsed `[!note]- Transcript`
 * callout (v0.1 behavior). Nothing to jump to, so callout collapse
 * handles the "don't dominate the note" problem directly.
 *
 * **With chapters** — emit a wrapping `Transcript` heading at the
 * configured `headerLevel`, then a `Chapters` subsection with links to
 * each chapter heading below, then a horizontal rule and the chaptered
 * transcript body. Each chapter heading includes a "Back to Chapters"
 * link that jumps to the chapters list block id.
 *
 * `headerLevel + 1 > 6` clamps to 6 so a `transcriptHeaderLevel: 6`
 * setting still produces valid markdown (both wrap and chapter
 * headings render at H6, collapsing the hierarchy but preserving the
 * fold target). Empty groups (chapters with no segments) contribute
 * no sub-heading and no body.
 */
export function formatTranscriptSection(
	transcript: Transcript | null,
	groups: readonly TranscriptChapterGroup[],
	headerLevel: HeadingLevel,
): string {
	if (!transcript || transcript.segments.length === 0) {
		return '> [!note]- Transcript\n> _No transcript available._';
	}
	if (groups.length === 0) {
		return formatFlatTranscriptCallout(transcript.segments);
	}

	const wrapPrefix = '#'.repeat(headerLevel);
	const chapterPrefix = '#'.repeat(Math.min(headerLevel + 1, 6));
	const chapterIndexSection = formatChapterIndexSection(groups, headerLevel);
	const lines: string[] = [`${wrapPrefix} Transcript`, ''];
	if (chapterIndexSection.length > 0) {
		lines.push(chapterIndexSection, '', '---', '');
	}
	let rendered = 0;
	for (const group of groups) {
		if (group.blockId === null || group.segments.length === 0) {
			continue;
		}
		if (rendered > 0) {
			lines.push('');
		}
		const headingText = chapterHeadingText(group.chapter);
		lines.push(`${chapterPrefix} ${headingText}`);
		lines.push('');
		lines.push(`[[#^${CHAPTERS_BLOCK_ID}|Back to Chapters]]`);
		lines.push('');
		for (const segment of group.segments) {
			lines.push(formatTranscriptBodyLine(segment));
		}
		rendered += 1;
	}
	if (rendered === 0) {
		// All groups were empty — fall back to the flat callout so the
		// note never loses its transcript entirely.
		return formatFlatTranscriptCallout(transcript.segments);
	}
	return lines.join('\n');
}

/**
 * Render a single transcript segment as a plain-paragraph markdown line
 * (no callout `>` prefix). Used by the chaptered path, where segments
 * live directly under a chapter heading.
 */
function formatTranscriptBodyLine(segment: TranscriptSegment): string {
	return formatTranscriptEntry(segment);
}

/**
 * Find the 0-based line number of the wrapping `Transcript` heading at
 * the given level in a rendered markdown string, or `null` when no
 * such heading exists (no-chapters path, or no transcript at all).
 *
 * Used by import-modal.ts to build a single-entry `FoldInfo` payload:
 * folding this one heading collapses the entire chaptered transcript
 * while leaving the chapters-list callout above it fully visible.
 */
export function findTranscriptHeadingLine(
	markdown: string,
	headerLevel: HeadingLevel,
): number | null {
	const prefix = `${'#'.repeat(headerLevel)} Transcript`;
	const lines = markdown.split('\n');
	// Search from the end: the transcript is always the final section, so the
	// last exact match is the real wrapping heading. A consumer_note body
	// heading that demotes to the same text (e.g. `#### Transcript`) renders
	// earlier in the note and must not shadow the real fold target.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] === prefix) {
			return i;
		}
	}
	return null;
}

/**
 * The fixed H2 heading that wraps all consumer_note template outputs. Defined
 * once so the renderer and the fold-line finder agree on the exact string.
 */
const TEMPLATE_OUTPUTS_HEADING = '## Template outputs';

/**
 * Render the user's extra Plaud AI template outputs as a single
 * `## Template outputs` block, one `### <template name>` subsection per output
 * with its Markdown body. Bodies are trusted Markdown from Plaud and embedded
 * natively (no callout re-quoting) so headings, lists, and tables render. The
 * block is left expanded: it sits above the (collapsed) transcript, and folding
 * its H2 would subsume the deeper transcript heading. Inclusion mirrors the
 * user's Plaud-side template selection, so a transcript-style template is
 * rendered too and never de-duplicated against the pipeline transcript.
 */
function formatConsumerNotesSection(consumerNotes: readonly ConsumerNote[]): string {
	const parts: string[] = [TEMPLATE_OUTPUTS_HEADING, ''];
	for (const note of consumerNotes) {
		const title = note.heading.trim() || 'Template output';
		// One fence-aware pass nests the body's ATX headings under the `### <tab>`
		// title and rewrites bare `---` separators (which would otherwise render
		// as setext headings) to `***`, while leaving code-fence content intact.
		const body = normalizeConsumerNoteBody(note.markdown.trim());
		parts.push(`### ${title}`, '', body, '');
	}
	// The block always starts with the heading (no leading whitespace), so
	// trim() only strips the trailing blank line; formatMarkdown adds its own
	// separator after the section.
	return parts.join('\n').trim();
}

interface CodeFence {
	readonly marker: '`' | '~';
	readonly length: number;
}

/** Parse a line that opens or closes a fenced code block into its marker. */
function parseCodeFence(line: string): CodeFence | null {
	const match = line.match(/^\s*(`{3,}|~{3,})/);
	if (match === null) {
		return null;
	}
	const run = match[1];
	return { marker: run[0] === '`' ? '`' : '~', length: run.length };
}

/**
 * Advance fenced-code state by one line. A fence closes only on a line whose
 * marker matches the opener and whose run is at least as long, so a shorter or
 * different-marker fence line inside a block (e.g. ``` inside a ~~~ block) stays
 * content rather than ending the block prematurely.
 */
function nextFenceState(active: CodeFence | null, line: string): CodeFence | null {
	const fence = parseCodeFence(line);
	if (fence === null) {
		return active;
	}
	if (active === null) {
		return fence;
	}
	return fence.marker === active.marker && fence.length >= active.length
		? null
		: active;
}

/**
 * Normalize a consumer_note body for embedding under its `### <template>` title
 * in a single fence-aware pass:
 *  - Re-level ATX headings so the shallowest sits at H4 (one below the title).
 *    Without this a body `#`/`##`/`###` would pollute the note outline as a
 *    sibling of Summary.
 *  - Rewrite a bare `---` dash run (which after a paragraph renders as a giant
 *    setext heading) to a `***` thematic break.
 * Both transforms skip fenced code blocks, so a `#` comment or a literal `---`
 * inside a code fence is preserved verbatim. This is the fence-aware counterpart
 * of the summary path's neutralizeSetextDashes. Heading text and code content
 * are preserved; only heading depth and bare dash separators change.
 */
function normalizeConsumerNoteBody(markdown: string): string {
	const lines = markdown.split('\n');
	// First pass: shallowest ATX heading level outside code fences.
	let activeFence: CodeFence | null = null;
	let minLevel = 7;
	for (const line of lines) {
		const prevFence = activeFence;
		activeFence = nextFenceState(prevFence, line);
		// Skip fence delimiter lines and anything inside a fence.
		if (prevFence !== null || activeFence !== null) {
			continue;
		}
		const m = line.match(/^(#{1,6})\s/);
		if (m) {
			minLevel = Math.min(minLevel, m[1].length);
		}
	}
	const shift = minLevel < 4 ? 4 - minLevel : 0;
	// Second pass: outside fences, demote headings and neutralize setext dashes.
	activeFence = null;
	const out = lines.map((line) => {
		const prevFence = activeFence;
		activeFence = nextFenceState(prevFence, line);
		if (prevFence !== null || activeFence !== null) {
			return line;
		}
		if (shift > 0) {
			const heading = line.match(/^(#{1,6})(\s.*)$/);
			if (heading !== null) {
				return `${'#'.repeat(Math.min(6, heading[1].length + shift))}${heading[2]}`;
			}
		}
		if (/^-{3,}\s*$/.test(line)) {
			return '***';
		}
		return line;
	});
	return out.join('\n');
}

function formatTranscriptLine(segment: TranscriptSegment): string {
	return `> ${formatTranscriptEntry(segment)}`;
}

function formatFlatTranscriptCallout(
	segments: readonly TranscriptSegment[],
): string {
	const lines: string[] = ['> [!note]- Transcript'];
	for (const segment of segments) {
		lines.push(formatTranscriptLine(segment));
	}
	return lines.join('\n');
}

function formatTranscriptEntry(segment: TranscriptSegment): string {
	const stamp = formatTimestamp(segment.startSeconds);
	const speaker = segment.speaker?.trim() || 'Unknown';
	// Collapse newlines inside a single segment so each segment becomes
	// exactly one line in either rendering mode.
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return `**[${stamp}]** ${speaker}: ${text}`;
}

/**
 * Render options for `formatMarkdown`. All fields are optional; the
 * defaults match the pre-settings behavior (transcript included,
 * wrapping heading at H4).
 */
export interface FormatMarkdownOptions {
	readonly includeTranscript?: boolean;
	readonly includeSummary?: boolean;
	readonly transcriptHeaderLevel?: HeadingLevel;
	/**
	 * AI keywords to surface as a `keywords:` frontmatter property.
	 * Produced by `buildNoteTags` when the tag mode excludes AI keywords
	 * from `tags:` and the keep-as-property setting is on.
	 */
	readonly keywords?: readonly string[];
	/**
	 * Resolved Plaud folder NAMES for this recording, written to the
	 * `plaud-folder:` frontmatter field (issue #16). These are the human names
	 * behind the recording's `filetag_id_list`, in original case (the `tags:`
	 * field gets slugified variants; this field keeps the pretty name). Empty or
	 * omitted emits no `plaud-folder:` line. In Plaud a recording is normally in
	 * a single folder, but the field is an array to tolerate multi-folder data.
	 */
	readonly folders?: readonly string[];
	/**
	 * Extra Plaud AI template outputs (Key Points, Daily Journal, etc.) to
	 * render in the note as a `## Template outputs` block. Empty or omitted
	 * renders no block. Independent of `includeSummary`: these mirror the
	 * user's own Plaud-side template selection.
	 */
	readonly consumerNotes?: readonly ConsumerNote[];
}

export function formatMarkdown(
	recording: Recording,
	transcript: Transcript | null,
	summary: Summary | null,
	chapters?: readonly Chapter[],
	options: FormatMarkdownOptions = {},
): string {
	const includeTranscript = options.includeTranscript ?? true;
	const includeSummary = options.includeSummary ?? true;
	const headerLevel: HeadingLevel = options.transcriptHeaderLevel ?? 4;

	const speakers = extractSpeakers(transcript);
	const expandedTitle = expandTitleWithYear(recording.title, recording.createdAt);
	const groups = groupTranscriptByChapters(transcript, chapters);
	const transcriptSection = includeTranscript
		? formatTranscriptSection(transcript, groups, headerLevel)
		: '';
	const parts: string[] = [
		formatFrontmatter(recording, speakers, summary, options.keywords, options.folders),
		'',
		`# ${expandedTitle}`,
		'',
		// Visible "Open in Plaud" link right under the H1. Duplicates
		// the plaud-url frontmatter field on purpose: frontmatter is for
		// Dataview / automation, this line is for the human reading the
		// note. The raw URL goes unescaped inside the markdown link
		// target — safe because formatPlaudWebUrl encodes the ID and the
		// host/path template contains no parentheses.
		`[Open in Plaud →](${formatPlaudWebUrl(recording.id)})`,
		'',
	];
	if (includeSummary) {
		const renderedSummary: Summary | null =
			summary !== null
				? {
						...summary,
						text: substitutePlaudPlaceholders(summary.text, recording, transcript),
					}
				: null;
		parts.push('## Summary', '', formatSummaryBody(renderedSummary), '');
		if (renderedSummary?.aiSuggestion) {
			const renderedSuggestion = substitutePlaudPlaceholders(
				renderedSummary.aiSuggestion,
				recording,
				transcript,
			).trim();
			parts.push('## AI Suggestions', '', renderedSuggestion, '');
		}
	}
	const consumerNotes = options.consumerNotes ?? [];
	if (consumerNotes.length > 0) {
		parts.push(formatConsumerNotesSection(consumerNotes), '');
	}
	if (transcriptSection.length > 0) {
		parts.push('---', '', transcriptSection, '');
	}
	return parts.join('\n');
}

/**
 * Build a placeholder note for a recording Plaud has no transcript or summary
 * for yet. Written only when Plaud affirmatively reported it cannot produce
 * content (an in-band server error such as `-12 start trans task error`), so
 * the user still gets a note in the vault carrying the recording ID and a
 * working link back to Plaud. The `plaud-placeholder: true` frontmatter marker
 * lets a later successful import overwrite this stub automatically.
 *
 * `reason` is a short, single-line human explanation (typically the classified
 * error message). Newlines are flattened so the callout stays well-formed.
 */
export function formatPlaceholderMarkdown(
	recording: Recording,
	reason: string,
): string {
	const url = formatPlaudWebUrl(recording.id);
	const expandedTitle = expandTitleWithYear(recording.title, recording.createdAt);
	const flatReason = reason.replace(/\s*\r?\n\s*/g, ' ').trim();
	const lines: string[] = [
		'---',
		`plaud-id: ${yamlScalar(recording.id)}`,
		`plaud-url: ${yamlScalar(url)}`,
		`date: ${formatDateYmd(recording.createdAt)}`,
		'source: plaud',
		// Marker that distinguishes this stub from a real note. extractPlaud-
		// PlaceholderFlag keys on it so a later real import always replaces it.
		'plaud-placeholder: true',
		'---',
		'',
		`# ${expandedTitle}`,
		'',
		`[Open in Plaud →](${url})`,
		'',
		'> [!warning] Not imported: Plaud has no transcript or summary',
		'> Plaud has no transcript or summary available for this recording. This is a',
		'> Plaud-side condition, not a problem reading the data. A common cause is that',
		'> the audio has no detectable speech (Plaud shows "No speech detected"). It can',
		'> also mean the recording is still processing. Open it in Plaud to see the exact',
		'> reason. If Plaud later has content for it, re-run the import and this',
		'> placeholder is replaced automatically. If Plaud reports no speech, there is',
		'> nothing to import.',
		'>',
		`> Recording ID: \`${recording.id}\``,
	];
	if (flatReason.length > 0) {
		lines.push('>', `> Plaud reported: ${flatReason}`);
	}
	lines.push('');
	return lines.join('\n');
}

// -----------------------------------------------------------------------------
// NoteWriter class — handles vault-level file creation and duplicate policy.
// -----------------------------------------------------------------------------

export class NoteWriter {
	private readonly vault: VaultLike;
	// outputFolder stored here is the NORMALIZED form — construction throws
	// if the raw input had path-traversal segments, so this value is always
	// safe to concatenate with a filename.
	private readonly outputFolder: string;
	private readonly subfolderTemplate: string;
	private readonly existingPathForPlaudId?: (plaudId: string) => string | null;
	private readonly onDuplicate: DuplicatePolicy;
	private readonly promptOnDuplicate?: DuplicatePromptCallback;
	private readonly defaultFormatOptions: FormatMarkdownOptions;

	constructor(vault: VaultLike, options: NoteWriterOptions) {
		if (
			options.onDuplicate !== 'skip' &&
			options.onDuplicate !== 'overwrite' &&
			options.onDuplicate !== 'prompt'
		) {
			throw new NoteWriterError(
				`Invalid onDuplicate policy "${String(options.onDuplicate)}" — expected 'skip', 'overwrite', or 'prompt'`,
			);
		}
		if (options.onDuplicate === 'prompt' && typeof options.promptOnDuplicate !== 'function') {
			throw new NoteWriterError(
				"Invalid onDuplicate policy 'prompt' — a promptOnDuplicate callback is required",
			);
		}
		this.vault = vault;
		this.outputFolder = normalizeFolderPath(options.outputFolder);
		this.subfolderTemplate = options.subfolderTemplate ?? '';
		this.existingPathForPlaudId = options.existingPathForPlaudId;
		this.onDuplicate = options.onDuplicate;
		this.promptOnDuplicate = options.promptOnDuplicate;
		this.defaultFormatOptions = {
			includeTranscript: options.includeTranscript,
			includeSummary: options.includeSummary,
			transcriptHeaderLevel: options.transcriptHeaderLevel,
		};
	}

	/**
	 * Resolve the per-recording destination path (folder + sanitized filename),
	 * creating the destination folder if needed. Shared by writeNote and
	 * writePlaceholderNote so both land a recording at the exact same path.
	 */
	private async resolveTargetPath(recording: Recording): Promise<string> {
		const subfolder = resolveSubfolder(this.subfolderTemplate, recording.createdAt);
		const destinationFolder = joinFolderPath(this.outputFolder, subfolder);
		await this.ensureFolder(destinationFolder);
		const expandedTitle = expandTitleWithYear(recording.title, recording.createdAt);
		const filename = `${sanitizeFilename(expandedTitle)}.md`;
		return destinationFolder === '' ? filename : `${destinationFolder}/${filename}`;
	}

	/**
	 * Find a prior note for this recording. First the exact target path; then,
	 * if none, the vault-wide lookup that catches an earlier import living in a
	 * DIFFERENT subfolder (for example after the user edited the subfolder
	 * template). Returns the matched file and its path, or a null file when no
	 * prior note exists.
	 */
	private findExistingNote(
		recording: Recording,
		targetPath: string,
	): { existing: FileLike | null; notePath: string } {
		let existing = this.vault.getFileByPath(targetPath);
		let notePath = targetPath;
		if (existing === null && this.existingPathForPlaudId) {
			const priorPath = this.existingPathForPlaudId(recording.id);
			if (priorPath !== null && priorPath !== targetPath) {
				const priorFile = this.vault.getFileByPath(priorPath);
				if (priorFile !== null) {
					existing = priorFile;
					notePath = priorPath;
				}
			}
		}
		return { existing, notePath };
	}

	/**
	 * Read an existing note and assert it belongs to this recording. Two
	 * distinct Plaud recordings can sanitize to the same filename; overwriting
	 * or skipping the wrong one would lose data silently, so a mismatched
	 * plaud-id throws a loud collision error. Returns the file content for the
	 * caller to inspect (for example, the placeholder marker).
	 */
	private async readExistingContent(
		existing: FileLike,
		notePath: string,
		recordingId: string,
	): Promise<string> {
		let existingContent: string;
		try {
			existingContent = await this.vault.read(existing);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to read existing ${notePath} while checking for collisions: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		const existingPlaudId = extractPlaudIdFromFrontmatter(existingContent);
		if (existingPlaudId !== null && existingPlaudId !== recordingId) {
			throw new NoteWriterError(
				`Filename collision at ${notePath}: this note belongs to recording ${existingPlaudId}, not ${recordingId}. Rename one of the source recordings in Plaud or delete the existing note to re-import.`,
			);
		}
		return existingContent;
	}

	/**
	 * Write a stub note for a recording Plaud reported it cannot transcribe or
	 * summarize yet (an in-band server error such as `-12 start trans task
	 * error`). The stub carries the recording ID and a link back to Plaud so
	 * the user keeps a breadcrumb, and is marked `plaud-placeholder: true` so a
	 * later successful import replaces it automatically. Never downgrades a real
	 * note to a stub: when a non-placeholder note already exists for the
	 * recording it is left untouched.
	 */
	async writePlaceholderNote(
		recording: Recording,
		reason: string,
	): Promise<PlaceholderWriteOutcome> {
		const targetPath = await this.resolveTargetPath(recording);
		const markdown = formatPlaceholderMarkdown(recording, reason);
		const { existing, notePath } = this.findExistingNote(recording, targetPath);
		if (existing === null) {
			try {
				await this.vault.create(targetPath, markdown);
			} catch (cause) {
				throw new NoteWriterError(
					`Failed to create placeholder ${targetPath} for recording ${recording.id}: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				);
			}
			return { status: 'created', path: targetPath };
		}
		const existingContent = await this.readExistingContent(
			existing,
			notePath,
			recording.id,
		);
		if (!extractPlaudPlaceholderFlag(existingContent)) {
			// A real note already exists for this recording, so keep it. The fetch
			// failed this run, but a prior import succeeded, so the good content
			// wins over a stub.
			return { status: 'kept-existing', path: notePath };
		}
		// Refresh the older placeholder so its reason text stays current.
		try {
			await this.vault.process(existing, () => markdown);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to refresh placeholder ${notePath} for recording ${recording.id}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		return { status: 'refreshed', path: notePath };
	}

	async writeNote(
		recording: Recording,
		transcript: Transcript | null,
		summary: Summary | null,
		chapters?: readonly Chapter[],
		formatOptions?: FormatMarkdownOptions,
	): Promise<WriteOutcome> {
		// Defense-in-depth: refuse to write a note that advertises content
		// it doesn't have. The ImportModal is responsible for not calling us
		// with a failed fetch, but catching it here too means a future caller
		// bug becomes a loud error instead of a silently-incomplete note.
		if (recording.transcriptAvailable && transcript === null) {
			throw new NoteWriterError(
				`Recording ${recording.id} advertised a transcript but none was provided — refusing to write a partial note`,
			);
		}
		// A summary Plaud advertised (is_summary) can be genuinely
		// unretrievable on older recordings: the transcript endpoint returns
		// the in-band -12 error and the detail bundle carries no auto_sum_note,
		// so there is no summary to fetch from any source. Per the 2026-06-26
		// decision, still write the note WHEN a transcript exists — the body
		// renders a "_No summary available._" placeholder under the Summary
		// heading — but never write a contentless note when the transcript is
		// missing too. (A missing-but-advertised transcript already threw
		// above; this also covers a not-advertised null transcript.)
		if (recording.summaryAvailable && summary === null && transcript === null) {
			throw new NoteWriterError(
				`Recording ${recording.id} advertised a summary but neither a summary nor a transcript could be retrieved — refusing to write an empty note`,
			);
		}

		// Resolve the per-recording destination path. The subfolder template
		// keys off the recording date, so the resolved path is a pure function
		// of the recording's own metadata and stays stable across re-imports.
		const targetPath = await this.resolveTargetPath(recording);
		const effectiveFormatOptions: FormatMarkdownOptions = {
			...this.defaultFormatOptions,
			...formatOptions,
		};
		const markdown = formatMarkdown(
			recording,
			transcript,
			summary,
			chapters,
			effectiveFormatOptions,
		);

		// Compute fold metadata once per write. `transcriptHeadingLine`
		// is null when the markdown lacks a wrapping transcript heading
		// (no chapters, transcript excluded, or empty-segment fallback)
		// which the caller should treat as "no fold state to apply".
		const headerLevel: HeadingLevel =
			effectiveFormatOptions.transcriptHeaderLevel ?? 4;
		const transcriptHeadingLine = findTranscriptHeadingLine(markdown, headerLevel);
		const foldInfo: WriteFoldInfo | undefined =
			transcriptHeadingLine !== null
				? {
						transcriptHeadingLine,
						totalLines: markdown.split('\n').length,
					}
				: undefined;

		// Look for a prior note for this recording (exact path, then cross-folder
		// lookup). Matching cross-folder is what stops a subfolder-template
		// change from writing a second copy of a recording already imported
		// elsewhere. The existing note is left in place — this is dedup, not
		// migration; moving notes is a separate, opt-in feature.
		const { existing, notePath } = this.findExistingNote(recording, targetPath);
		if (existing === null) {
			try {
				await this.vault.create(targetPath, markdown);
			} catch (cause) {
				throw new NoteWriterError(
					`Failed to create ${targetPath} for recording ${recording.id}: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				);
			}
			return { status: 'created', path: targetPath, foldInfo };
		}

		// A note for this recording already exists (at notePath). Read it and
		// assert it belongs to this recording (throws on a filename collision
		// with a DIFFERENT recording).
		const existingContent = await this.readExistingContent(
			existing,
			notePath,
			recording.id,
		);

		// Real content always supersedes a placeholder stub: if the existing
		// note is a placeholder we wrote for an unprocessed recording, overwrite
		// it with the now-available content regardless of the duplicate policy.
		// This is what makes the placeholder self-healing: a later import that
		// actually has the transcript/summary replaces the stub even under a
		// 'skip' or 'prompt' policy that would otherwise leave it stranded.
		const supersedingPlaceholder = extractPlaudPlaceholderFlag(existingContent);

		if (!supersedingPlaceholder && this.onDuplicate === 'skip') {
			return { status: 'skipped', path: notePath };
		}

		// Resolve prompt-mode into a concrete action. 'skip' short-circuits,
		// 'cancel' throws, anything else falls through to the overwrite path
		// shared with onDuplicate === 'overwrite'. Skipped entirely when we are
		// superseding a placeholder: replacing our own stub with real content
		// needs no user decision.
		if (this.onDuplicate === 'prompt' && !supersedingPlaceholder) {
			if (!this.promptOnDuplicate) {
				throw new NoteWriterError(
					'promptOnDuplicate callback missing at write time — this is a plugin bug',
				);
			}
			const decision = await this.promptOnDuplicate({
				recordingId: recording.id,
				recordingTitle: recording.title,
				targetPath: notePath,
			});
			if (decision === 'cancel') {
				throw new NoteWriterCancelledError();
			}
			if (decision !== 'overwrite' && decision !== 'skip') {
				throw new NoteWriterError(
					`promptOnDuplicate returned invalid decision "${String(decision)}"`,
				);
			}
			if (decision === 'skip') {
				return { status: 'skipped', path: notePath };
			}
		}

		// Overwrite path — use process so the write is atomic and
		// respects any other plugin's read-modify-write of the same
		// file. The callback ignores the previous content by design: we
		// are replacing the entire file with our regenerated markdown.
		try {
			await this.vault.process(existing, () => markdown);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to overwrite ${notePath} for recording ${recording.id}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		return { status: 'overwritten', path: notePath, foldInfo };
	}

	/**
	 * Walk the folder path and create each missing ancestor in turn.
	 * Obsidian's createFolder throws if the folder already exists, so each
	 * segment is checked first.
	 */
	private async ensureFolder(folderPath: string): Promise<void> {
		if (folderPath === '') {
			return;
		}
		const segments = folderPath.split('/');
		for (let i = 1; i <= segments.length; i++) {
			const partial = segments.slice(0, i).join('/');
			const existing = this.vault.getFolderByPath(partial);
			if (existing === null) {
				try {
					await this.vault.createFolder(partial);
				} catch (cause) {
					// Treat "already exists" as success: getFolderByPath and
					// createFolder can disagree about a path (normalization,
					// case-insensitive filesystems, or a concurrent import that
					// created the folder between the check and the create). The
					// folder we needed is there either way, so this is idempotent.
					const message =
						cause instanceof Error ? cause.message : String(cause);
					if (/already exists/i.test(message)) {
						continue;
					}
					throw new NoteWriterError(
						`Failed to create folder "${partial}": ${message}`,
					);
				}
			}
		}
	}
}

/**
 * Normalize a user-configured output folder. Throws if the path contains
 * `..` segments that would escape the vault — silently stripping them
 * would be a lie to the user about where their files went.
 */
function normalizeFolderPath(folder: string): string {
	const cleaned = folder
		.trim()
		// Windows users type paths like "\Inbox". Obsidian's createFolder
		// normalizes "\" to "/" internally, but getFolderByPath does a literal
		// index lookup — so an un-normalized backslash makes the existence check
		// miss the folder Obsidian actually created, and every later import
		// re-attempts the create and fails with "Folder already exists".
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/{2,}/g, '/');
	const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.some((s) => s === '..')) {
		throw new NoteWriterError(
			`Output folder "${folder}" contains ".." which would escape the vault — use a vault-relative path`,
		);
	}
	return segments.join('/');
}
