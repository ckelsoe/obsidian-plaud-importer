/**
 * The managed body block (issue #59).
 *
 * Every note the importer writes wraps its generated body (title, summary,
 * template outputs, attachments, audio, transcript) in two HTML-comment marker
 * lines. Reading view hides them. A re-import replaces only what sits between
 * the markers, so anything the user writes above or below the block survives
 * byte-for-byte. Frontmatter stays plugin-merged as before (#58).
 *
 * A note with no markers (imported before this feature) is rebuilt whole on
 * its next re-import, which adds the markers; protection starts from there.
 * A note whose markers are ambiguous (one missing, duplicated, or out of
 * order) is never overwritten: the writer refuses and reports it.
 */

export const MANAGED_BLOCK_START = '<!-- plaud:managed:start -->';
export const MANAGED_BLOCK_END = '<!-- plaud:managed:end -->';

const START_LINE = /^<!-- plaud:managed:start -->[^\S\n]*$/gm;
const END_LINE = /^<!-- plaud:managed:end -->[^\S\n]*$/gm;

/**
 * Where a note's managed block sits.
 *   - 'none': no markers at all (a legacy note, or the user removed both).
 *   - 'malformed': markers present but not exactly one start before one end.
 *   - 'ok': `before` runs up to the start marker line, `inner` is everything
 *     between the two marker lines, `after` begins right after the end marker
 *     text (so it keeps the end line's newline and any trailing content).
 */
export type ManagedBlockLocation =
	| { readonly kind: 'none' }
	| { readonly kind: 'malformed'; readonly reason: string }
	| {
			readonly kind: 'ok';
			readonly before: string;
			readonly inner: string;
			readonly after: string;
	  };

// Single-line forms of the patterns above. No `g` flag, so `test` keeps no
// `lastIndex` state and the regexes can be shared.
const START_ONE_LINE = new RegExp(START_LINE.source);
const END_ONE_LINE = new RegExp(END_LINE.source);

/** True when `line` (one line, no newline) is a start or end marker line. */
export function isManagedMarkerLine(line: string): boolean {
	return START_ONE_LINE.test(line) || END_ONE_LINE.test(line);
}

/** Every whole-line match of `pattern`, using a fresh regex so no `lastIndex` leaks between calls. */
function lineMatches(content: string, pattern: RegExp): RegExpExecArray[] {
	return [...content.matchAll(new RegExp(pattern.source, pattern.flags))];
}

/**
 * Find the managed block in a note. Markers count only when alone on their
 * line, so a marker quoted inline in the user's prose is ignored.
 */
export function locateManagedBlock(content: string): ManagedBlockLocation {
	const starts = lineMatches(content, START_LINE);
	const ends = lineMatches(content, END_LINE);
	if (starts.length === 0 && ends.length === 0) {
		return { kind: 'none' };
	}
	const [start] = starts;
	const [end] = ends;
	if (starts.length !== 1 || ends.length !== 1 || !start || !end) {
		return {
			kind: 'malformed',
			reason: `expected one start and one end marker, found ${String(starts.length)} start and ${String(ends.length)} end`,
		};
	}
	if (end.index < start.index) {
		return {
			kind: 'malformed',
			reason: 'the end marker comes before the start marker',
		};
	}
	const startLineEnd = start.index + start[0].length;
	// The inner region starts on the line after the start marker. A start
	// marker on the file's last line (impossible here, since an end follows)
	// would leave nothing to skip.
	const innerStart =
		content.charAt(startLineEnd) === '\n' ? startLineEnd + 1 : startLineEnd;
	return {
		kind: 'ok',
		before: content.slice(0, start.index),
		inner: content.slice(innerStart, end.index),
		after: content.slice(end.index + end[0].length),
	};
}

/**
 * Wrap a rendered body in the markers, in the canonical layout `formatMarkdown`
 * emits: marker, blank line, body, blank line, marker. Shared by the renderer
 * and every post-write rewrite so repeated passes never drift the whitespace.
 */
export function wrapManagedBody(body: string): string {
	return `${MANAGED_BLOCK_START}\n\n${body.trim()}\n\n${MANAGED_BLOCK_END}`;
}

/**
 * Apply a body rewrite (the attachments or audio section insert) to the managed
 * block only, so it never reads or edits the user's text outside it and an
 * "append at the end" lands inside the block rather than after it. A note
 * without markers gets the rewrite over the whole content, which is the pre-#59
 * behavior. A note whose markers were damaged after it was written (the user
 * edited it mid-import) is returned unchanged: the whole note may be theirs.
 */
export function transformManagedBody(
	content: string,
	transform: (body: string) => string,
): string {
	const located = locateManagedBlock(content);
	if (located.kind === 'none') {
		return transform(content);
	}
	if (located.kind === 'malformed') {
		return content;
	}
	return `${located.before}${wrapManagedBody(transform(located.inner))}${located.after}`;
}

/**
 * The managed block's text and the 0-based line its first line sits on, for a
 * caller that searches the block and reports a whole-note line number (the
 * transcript fold), plus whether the user has text after the block. Without a
 * well-formed block the whole note is the region.
 */
export function managedBodyRegion(content: string): {
	readonly body: string;
	readonly lineOffset: number;
	readonly textBelow: boolean;
} {
	const located = locateManagedBlock(content);
	if (located.kind !== 'ok') {
		return { body: content, lineOffset: 0, textBelow: false };
	}
	const precedingLines = `${located.before}${MANAGED_BLOCK_START}\n`;
	return {
		body: located.inner,
		lineOffset: precedingLines.split('\n').length - 1,
		textBelow: located.after.trim().length > 0,
	};
}

/** Offset just past a leading `---` frontmatter block, or 0 when there is none. */
function frontmatterEnd(content: string): number {
	if (!/^---[^\S\n]*\n/.test(content)) {
		return 0;
	}
	const close = /\n---[^\S\n]*(?:\n|$)/.exec(content.slice(3));
	if (close === null) {
		return 0;
	}
	return 3 + close.index + close[0].length;
}

/**
 * The note an overwrite should write, given what is on disk and the freshly
 * rendered note. Returns `rendered` unchanged when the existing note has no
 * markers (a full rebuild, which also adopts the markers). With a well-formed
 * block, keeps the existing text between the frontmatter and the start marker
 * and after the end marker, and takes the new frontmatter and block from
 * `rendered`. Returns null when the existing markers are malformed, so the
 * caller leaves the note untouched.
 */
export function spliceManagedBlock(
	existing: string,
	rendered: string,
): string | null {
	const current = locateManagedBlock(existing);
	if (current.kind === 'none') {
		return rendered;
	}
	if (current.kind === 'malformed') {
		return null;
	}
	const fresh = locateManagedBlock(rendered);
	if (fresh.kind !== 'ok') {
		// The renderer always emits one block; without it there is nothing to
		// splice in, and a full rebuild would destroy the user's text.
		return null;
	}
	const newFrontmatter = rendered.slice(0, frontmatterEnd(rendered));
	const userAbove = current.before.slice(frontmatterEnd(current.before));
	return `${newFrontmatter}${userAbove}${wrapManagedBody(fresh.inner)}${current.after}`;
}
