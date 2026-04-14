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

export type DuplicatePolicy = 'skip' | 'overwrite';

/**
 * Markdown heading level. Matches Obsidian's H1-H6 and validates
 * settings deserialization: any other value is rejected at runtime so
 * a malformed `data.json` can't produce zero or seven `#` characters.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface NoteWriterOptions {
	readonly outputFolder: string;
	readonly onDuplicate: DuplicatePolicy;
	/**
	 * When false, the writer omits the transcript section entirely
	 * (no flat callout, no heading-wrapped chaptered form). The
	 * generated note still contains frontmatter, summary, and the
	 * chapters list (if available). Defaults to true when the caller
	 * doesn't supply a value.
	 */
	readonly includeTranscript?: boolean;
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
	// eslint-disable-next-line no-control-regex
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
 * Prepend the year from `date` onto a recording title that starts with
 * Plaud's default MM-DD prefix. Titles that already have a YYYY-MM-DD
 * prefix or no date prefix at all are returned unchanged.
 *
 *   expandTitleWithYear("04-13 Meeting", 2026-04-13)
 *     === "2026-04-13 Meeting"
 *   expandTitleWithYear("2026-04-13 Meeting", 2026-04-13)
 *     === "2026-04-13 Meeting"  (already expanded)
 *   expandTitleWithYear("Meeting notes", 2026-04-13)
 *     === "Meeting notes"  (no MM-DD prefix)
 *
 * This runs once in writeNote and is used for both the filename (via
 * sanitizeFilename) and the H1 heading (via formatMarkdown) so the two
 * stay in sync.
 */
export function expandTitleWithYear(title: string, date: Date): string {
	const trimmed = title.trim();
	// Already has a full YYYY-MM-DD prefix — don't double-prefix.
	if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
		return trimmed;
	}
	// Has a MM-DD prefix followed by whitespace or end-of-string — prepend
	// the year from the recording's createdAt so the title reads as a full
	// YYYY-MM-DD date followed by the original description.
	if (/^\d{2}-\d{2}(\s|$)/.test(trimmed)) {
		return `${date.getFullYear()}-${trimmed}`;
	}
	return trimmed;
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
	const seen = new Set<string>();
	const out: string[] = [];

	for (const tag of baseTags ?? []) {
		if (typeof tag !== 'string') {
			continue;
		}
		const normalized = tag.trim().toLowerCase();
		if (normalized.length === 0 || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		out.push(normalized);
	}

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
		out.push(prefixed);
	}

	return out;
}

export function formatFrontmatter(
	recording: Recording,
	speakers: readonly string[],
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
	lines.push('source: plaud');
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

function formatSummaryBody(summary: Summary | null): string {
	if (!summary) {
		return '_No summary available._';
	}
	if (summary.sections && summary.sections.length > 0) {
		return summary.sections
			.map((section) => `### ${section.heading}\n\n${section.body.trim()}`)
			.join('\n\n');
	}
	return summary.text.trim();
}

/**
 * One chapter paired with the transcript segments that belong to it.
 * `blockId` is the Obsidian block identifier attached at the end of
 * this chapter's transcript segments inside the single unified
 * `[!note]- Transcript` callout. The chapters mini-TOC at the top of
 * the same callout links to this block id via `[[#^${blockId}|...]]`
 * so clicking a chapter row jumps down to the matching slice of the
 * transcript while everything stays in one collapsible block. When a
 * chapter has zero segments the block id is `null`, and the TOC row
 * renders as plain text since there's no jump target to emit.
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
 * Render the external `[!note]- Chapters` callout above the transcript.
 * Each row is an Obsidian wiki link to the matching chapter sub-heading
 * inside the transcript section — real headings, reliably indexed, so
 * jumps resolve in every view mode. Rows for chapters with no
 * transcript segments render as plain text because there's no heading
 * target. `transcriptHeaderLevel` is accepted for API parity with
 * `formatTranscriptSection` but the wiki-link text only needs the
 * heading content (Obsidian resolves the anchor by text match
 * regardless of level).
 *
 * The callout is collapsed by default (`-` suffix) and provides the
 * always-visible "what's in this recording" TOC that sits above the
 * transcript.
 */
export function formatChaptersCallout(
	groups: readonly TranscriptChapterGroup[],
	_transcriptHeaderLevel: HeadingLevel = 4,
): string {
	if (groups.length === 0) {
		return '';
	}
	const lines: string[] = ['> [!note]- Chapters'];
	let rendered = 0;
	for (const group of groups) {
		const title = group.chapter.title.trim();
		if (title.length === 0) {
			continue;
		}
		const stamp = formatTimestamp(group.chapter.startSeconds);
		const display = `**[${stamp}]** ${title}`;
		if (group.blockId === null) {
			lines.push(`> ${display}`);
		} else {
			// Wiki-link target is the exact heading text emitted by
			// formatTranscriptSection: "MM:SS Title" (with the same
			// sanitized title). Same generation site in both places to
			// keep the two from drifting.
			const sanitizedTitle = title.replace(/[|[\]#]/g, '-');
			const anchor = `${stamp} ${sanitizedTitle}`;
			lines.push(`> [[#${anchor}|${display}]]`);
		}
		rendered += 1;
	}
	if (rendered === 0) {
		return '';
	}
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
 * configured `headerLevel` followed by one sub-heading per chapter at
 * `headerLevel + 1`. Plain-paragraph segment lines live under each
 * sub-heading. A chapters callout elsewhere in the note links to the
 * sub-headings via `[[#MM:SS Title]]`. The wrapping heading is the
 * single fold target — auto-folding it hides every chapter and all
 * segment bodies in one block, without breaking heading-anchor link
 * resolution (the wrapping heading's children are still indexed even
 * while folded).
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
		const lines: string[] = ['> [!note]- Transcript'];
		for (const segment of transcript.segments) {
			lines.push(formatTranscriptLine(segment));
		}
		return lines.join('\n');
	}

	const wrapPrefix = '#'.repeat(headerLevel);
	const chapterPrefix = '#'.repeat(Math.min(headerLevel + 1, 6));
	const lines: string[] = [`${wrapPrefix} Transcript`, ''];
	let rendered = 0;
	for (const group of groups) {
		if (group.blockId === null || group.segments.length === 0) {
			continue;
		}
		if (rendered > 0) {
			lines.push('');
		}
		const stamp = formatTimestamp(group.chapter.startSeconds);
		const title = group.chapter.title.trim();
		const sanitizedTitle = title.replace(/[|[\]#]/g, '-');
		lines.push(`${chapterPrefix} ${stamp} ${sanitizedTitle}`);
		lines.push('');
		for (const segment of group.segments) {
			lines.push(formatTranscriptBodyLine(segment));
		}
		rendered += 1;
	}
	if (rendered === 0) {
		// All groups were empty — fall back to the flat callout so the
		// note never loses its transcript entirely.
		const fallback = ['> [!note]- Transcript'];
		for (const segment of transcript.segments) {
			fallback.push(formatTranscriptLine(segment));
		}
		return fallback.join('\n');
	}
	return lines.join('\n');
}

/**
 * Render a single transcript segment as a plain-paragraph markdown line
 * (no callout `>` prefix). Used by the chaptered path, where segments
 * live directly under the per-chapter sub-heading. The stamp/speaker/
 * text layout matches `formatTranscriptLine`'s callout version so the
 * note looks consistent regardless of which branch rendered it.
 */
function formatTranscriptBodyLine(segment: TranscriptSegment): string {
	const stamp = formatTimestamp(segment.startSeconds);
	const speaker = segment.speaker?.trim() || 'Unknown';
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return `**[${stamp}]** ${speaker}: ${text}`;
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
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === prefix) {
			return i;
		}
	}
	return null;
}

function formatTranscriptLine(segment: TranscriptSegment): string {
	const stamp = formatTimestamp(segment.startSeconds);
	const speaker = segment.speaker?.trim() || 'Unknown';
	// Collapse newlines inside a single segment so each segment becomes
	// exactly one callout line. Callouts with line breaks render oddly.
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return `> **[${stamp}]** ${speaker}: ${text}`;
}

/**
 * Render options for `formatMarkdown`. All fields are optional; the
 * defaults match the pre-settings behavior (transcript included,
 * wrapping heading at H4).
 */
export interface FormatMarkdownOptions {
	readonly includeTranscript?: boolean;
	readonly transcriptHeaderLevel?: HeadingLevel;
}

export function formatMarkdown(
	recording: Recording,
	transcript: Transcript | null,
	summary: Summary | null,
	chapters?: readonly Chapter[],
	options: FormatMarkdownOptions = {},
): string {
	const includeTranscript = options.includeTranscript ?? true;
	const headerLevel: HeadingLevel = options.transcriptHeaderLevel ?? 4;

	const speakers = extractSpeakers(transcript);
	const expandedTitle = expandTitleWithYear(recording.title, recording.createdAt);
	const groups = groupTranscriptByChapters(transcript, chapters);
	const externalChaptersSection = formatChaptersCallout(groups, headerLevel);
	const transcriptSection = includeTranscript
		? formatTranscriptSection(transcript, groups, headerLevel)
		: '';
	const parts: string[] = [
		formatFrontmatter(recording, speakers),
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
		'## Summary',
		'',
		formatSummaryBody(summary),
		'',
	];
	if (externalChaptersSection.length > 0) {
		parts.push(externalChaptersSection, '');
	}
	if (transcriptSection.length > 0) {
		parts.push(transcriptSection, '');
	}
	return parts.join('\n');
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
	private readonly onDuplicate: DuplicatePolicy;
	private readonly defaultFormatOptions: FormatMarkdownOptions;

	constructor(vault: VaultLike, options: NoteWriterOptions) {
		if (options.onDuplicate !== 'skip' && options.onDuplicate !== 'overwrite') {
			throw new NoteWriterError(
				`Invalid onDuplicate policy "${String(options.onDuplicate)}" — expected 'skip' or 'overwrite'`,
			);
		}
		this.vault = vault;
		this.outputFolder = normalizeFolderPath(options.outputFolder);
		this.onDuplicate = options.onDuplicate;
		this.defaultFormatOptions = {
			includeTranscript: options.includeTranscript,
			transcriptHeaderLevel: options.transcriptHeaderLevel,
		};
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
		if (recording.summaryAvailable && summary === null) {
			throw new NoteWriterError(
				`Recording ${recording.id} advertised a summary but none was provided — refusing to write a partial note`,
			);
		}

		await this.ensureFolder(this.outputFolder);

		// Expand the title with its year if it uses Plaud's MM-DD default
		// naming — applies to both the filename and the H1 so they stay in
		// sync. formatMarkdown below calls the same helper.
		const expandedTitle = expandTitleWithYear(
			recording.title,
			recording.createdAt,
		);
		const filename = `${sanitizeFilename(expandedTitle)}.md`;
		const targetPath =
			this.outputFolder === '' ? filename : `${this.outputFolder}/${filename}`;
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

		const existing = this.vault.getFileByPath(targetPath);
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

		// A file already exists at this path. Before honoring the duplicate
		// policy, check whether it belongs to a DIFFERENT recording — two
		// distinct Plaud recordings can sanitize to the same filename, and
		// silently overwriting or skipping would cause data loss that the
		// user would never know about.
		let existingContent: string;
		try {
			existingContent = await this.vault.read(existing);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to read existing ${targetPath} while checking for collisions: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		const existingPlaudId = extractPlaudIdFromFrontmatter(existingContent);
		if (existingPlaudId !== null && existingPlaudId !== recording.id) {
			throw new NoteWriterError(
				`Filename collision at ${targetPath}: this note belongs to recording ${existingPlaudId}, not ${recording.id}. Rename one of the source recordings in Plaud or delete the existing note to re-import.`,
			);
		}

		if (this.onDuplicate === 'skip') {
			return { status: 'skipped', path: targetPath };
		}

		// onDuplicate === 'overwrite' — use process so the write is atomic
		// and respects any other plugin's read-modify-write of the same file.
		// The callback ignores the previous content by design: we are
		// replacing the entire file with our regenerated markdown.
		try {
			await this.vault.process(existing, () => markdown);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to overwrite ${targetPath} for recording ${recording.id}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		return { status: 'overwritten', path: targetPath, foldInfo };
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
					throw new NoteWriterError(
						`Failed to create folder "${partial}": ${
							cause instanceof Error ? cause.message : String(cause)
						}`,
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
