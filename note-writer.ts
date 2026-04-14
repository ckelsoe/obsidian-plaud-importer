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

export interface NoteWriterOptions {
	readonly outputFolder: string;
	readonly onDuplicate: DuplicatePolicy;
}

export type WriteOutcome =
	| { readonly status: 'created'; readonly path: string }
	| { readonly status: 'overwritten'; readonly path: string }
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

export function formatFrontmatter(
	recording: Recording,
	speakers: readonly string[],
): string {
	const duration = Number.isFinite(recording.durationSeconds)
		? Math.max(0, Math.floor(recording.durationSeconds))
		: 0;

	const lines: string[] = ['---'];
	lines.push(`plaud-id: ${yamlScalar(recording.id)}`);
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

function formatTranscriptCallout(transcript: Transcript | null): string {
	if (!transcript || transcript.segments.length === 0) {
		return '> [!note]- Transcript\n> _No transcript available._';
	}
	const lines = ['> [!note]- Transcript'];
	for (const segment of transcript.segments) {
		lines.push(formatTranscriptLine(segment));
	}
	return lines.join('\n');
}

function formatTranscriptLine(segment: TranscriptSegment): string {
	const stamp = formatTimestamp(segment.startSeconds);
	const speaker = segment.speaker?.trim() || 'Unknown';
	// Collapse newlines inside a single segment so each segment becomes
	// exactly one callout line. Callouts with line breaks render oddly.
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return `> **[${stamp}]** ${speaker}: ${text}`;
}

export function formatMarkdown(
	recording: Recording,
	transcript: Transcript | null,
	summary: Summary | null,
): string {
	const speakers = extractSpeakers(transcript);
	const expandedTitle = expandTitleWithYear(recording.title, recording.createdAt);
	const parts: string[] = [
		formatFrontmatter(recording, speakers),
		'',
		`# ${expandedTitle}`,
		'',
		'## Summary',
		'',
		formatSummaryBody(summary),
		'',
		formatTranscriptCallout(transcript),
		'',
	];
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

	constructor(vault: VaultLike, options: NoteWriterOptions) {
		if (options.onDuplicate !== 'skip' && options.onDuplicate !== 'overwrite') {
			throw new NoteWriterError(
				`Invalid onDuplicate policy "${String(options.onDuplicate)}" — expected 'skip' or 'overwrite'`,
			);
		}
		this.vault = vault;
		this.outputFolder = normalizeFolderPath(options.outputFolder);
		this.onDuplicate = options.onDuplicate;
	}

	async writeNote(
		recording: Recording,
		transcript: Transcript | null,
		summary: Summary | null,
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
		const markdown = formatMarkdown(recording, transcript, summary);

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
			return { status: 'created', path: targetPath };
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
		return { status: 'overwritten', path: targetPath };
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
