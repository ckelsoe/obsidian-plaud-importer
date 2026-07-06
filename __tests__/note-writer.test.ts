import {
	NoteWriter,
	NoteWriterError,
	NoteWriterCancelledError,
	buildNoteName,
	DEFAULT_NOTE_NAME_TEMPLATE,
	extractPlaudIdFromFrontmatter,
	extractPlaudPlaceholderFlag,
	extractSpeakers,
	findTranscriptHeadingLine,
	formatChapterIndexSection,
	formatDurationHoursMinutes,
	formatFrontmatter,
	formatMarkdown,
	formatNoteName,
	formatPlaceholderMarkdown,
	formatPlaudWebUrl,
	formatTimestamp,
	formatTranscriptSection,
	groupTranscriptByChapters,
	isValidNoteNameTemplate,
	isValidReplacementChar,
	migrateLegacyDateTemplate,
	mergeTagSources,
	buildNoteTags,
	type TagBuildOptions,
	renameRecordingNote,
	resolveSubfolder,
	sanitizeFilename,
	TEMPLATE_PREVIEW_DATE,
	TEMPLATE_PREVIEW_TITLE,
	substitutePlaudPlaceholders,
	type FileLike,
	type FolderLike,
	type TranscriptChapterGroup,
	type VaultLike,
} from '../note-writer';
import type {
	Chapter,
	ConsumerNote,
	PlaudRecordingId,
	Recording,
	Summary,
	Transcript,
	TranscriptSegment,
} from '../plaud-client';
// The plugin gets moment from Obsidian (mapped to the jest mock, which re-exports
// the real moment). Reaching it the same way here shares that one singleton, so a
// test can flip the global locale and observe the formatter's pinned English.
import { moment } from 'obsidian';

// Fixtures ------------------------------------------------------------------

function makeRecording(overrides: Partial<Recording> = {}): Recording {
	return {
		id: 'abc123' as PlaudRecordingId,
		title: 'Morning standup',
		createdAt: new Date(2026, 3, 14, 9, 30), // 2026-04-14 09:30 local
		durationSeconds: 600,
		transcriptAvailable: true,
		summaryAvailable: true,
		isTrashed: false,
		...overrides,
	};
}

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
	return {
		id: 'abc123' as PlaudRecordingId,
		segments: [
			{ startSeconds: 0, endSeconds: 14, speaker: 'Charles', text: 'Thanks for making time.' },
			{ startSeconds: 14, endSeconds: 45, speaker: 'Mary', text: 'Of course, glad to be here.' },
		],
		rawText: 'Thanks for making time. Of course, glad to be here.',
		...overrides,
	};
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
	return {
		id: 'abc123' as PlaudRecordingId,
		text: '- Mary wants to revisit pricing\n- Charles to draft three options',
		...overrides,
	};
}

// sanitizeFilename ----------------------------------------------------------

describe('sanitizeFilename', () => {
	it('passes through a clean ASCII title', () => {
		expect(sanitizeFilename('Morning standup')).toBe('Morning standup');
	});

	it('preserves unicode (café, umlauts, emoji, CJK)', () => {
		expect(sanitizeFilename('Morgen café')).toBe('Morgen café');
		expect(sanitizeFilename('Über Ümlauts')).toBe('Über Ümlauts');
		expect(sanitizeFilename('会議メモ')).toBe('会議メモ');
	});

	it.each([
		['angle brackets', 'Meeting <foo>', 'Meeting -foo-'],
		['colons', 'Q2: Review', 'Q2- Review'],
		['double quotes', 'She said "hi"', 'She said -hi-'],
		['forward slash', 'A/B test', 'A-B test'],
		['backslash', 'C:\\path', 'C--path'],
		['pipe', 'foo|bar', 'foo-bar'],
		['question mark', 'Why?', 'Why-'],
		['asterisk', 'important*', 'important-'],
		['square brackets (wikilink collision)', 'Note [draft]', 'Note -draft-'],
	])('replaces %s with dashes', (_label, input, expected) => {
		expect(sanitizeFilename(input)).toBe(expected);
	});

	it('strips ASCII control characters', () => {
		expect(sanitizeFilename('Meet\x00ing\x1fnotes')).toBe('Meet-ing-notes');
	});

	it('trims leading and trailing whitespace', () => {
		expect(sanitizeFilename('   spaced out   ')).toBe('spaced out');
	});

	it('strips trailing dots and spaces (Windows silently drops them)', () => {
		expect(sanitizeFilename('Meeting notes....')).toBe('Meeting notes');
		expect(sanitizeFilename('Meeting notes .')).toBe('Meeting notes');
	});

	it('strips leading dots and spaces', () => {
		expect(sanitizeFilename('...hidden file')).toBe('hidden file');
	});

	it('collapses runs of whitespace including newlines into single spaces', () => {
		expect(sanitizeFilename('line one\nline two\n\tindented')).toBe(
			'line one line two indented',
		);
	});

	it('clamps titles longer than 200 characters', () => {
		const longTitle = 'A'.repeat(300);
		const result = sanitizeFilename(longTitle);
		expect(result.length).toBeLessThanOrEqual(200);
		expect(result).toBe('A'.repeat(200));
	});

	it('returns "Untitled" for an empty string', () => {
		expect(sanitizeFilename('')).toBe('Untitled');
	});

	it('returns "Untitled" for whitespace-only input', () => {
		expect(sanitizeFilename('   \t\n  ')).toBe('Untitled');
	});

	it('returns "Untitled" when input is entirely invalid characters', () => {
		expect(sanitizeFilename('...')).toBe('Untitled');
	});

	it.each([
		['CON'], ['PRN'], ['AUX'], ['NUL'],
		['COM1'], ['COM9'], ['LPT1'], ['LPT9'],
	])('prefixes reserved Windows device name %s with underscore', (name) => {
		expect(sanitizeFilename(name)).toBe(`_${name}`);
	});

	it('matches reserved names case-insensitively', () => {
		expect(sanitizeFilename('con')).toBe('_con');
		expect(sanitizeFilename('Nul')).toBe('_Nul');
	});

	it('prefixes a reserved device name that carries an extension', () => {
		// Windows treats the base before the first dot as the device, so "CON.txt"
		// is reserved too; the underscore prefix neutralizes it.
		expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
		expect(sanitizeFilename('nul.md')).toBe('_nul.md');
		// A name whose base is not a device stays unchanged.
		expect(sanitizeFilename('console.log')).toBe('console.log');
	});

	it('uses a configured replacement character instead of a dash', () => {
		expect(sanitizeFilename('Q2: Review', '_')).toBe('Q2_ Review');
		expect(sanitizeFilename('A/B test', '_')).toBe('A_B test');
		expect(sanitizeFilename('foo|bar<baz>', '~')).toBe('foo~bar~baz~');
	});

	it('inserts a replacement containing $ literally (no regex back-reference)', () => {
		// A '$' replacement must not be read as a replacement-string special.
		expect(sanitizeFilename('A/B', '$')).toBe('A$B');
	});

	it('falls back to a dash when given an unsafe replacement (defense-in-depth)', () => {
		// An exported function must not trust its caller: an unsafe replacement
		// (a forbidden char, separator, dot/space, control code, empty, or
		// multi-char) would reintroduce what the sanitizer removes, so it coerces
		// to '-' rather than emitting the unsafe value.
		expect(sanitizeFilename('A/B', '/')).toBe('A-B');
		expect(sanitizeFilename('A/B', '\\')).toBe('A-B');
		expect(sanitizeFilename('A:B', '.')).toBe('A-B');
		expect(sanitizeFilename('A|B', '')).toBe('A-B');
		expect(sanitizeFilename('A|B', '__')).toBe('A-B');
	});
});

describe('isValidReplacementChar', () => {
	it.each([['-'], ['_'], ['~'], ['+'], ['a'], ['9'], ['$'], ['@']])(
		'accepts the safe single character %p',
		(char) => {
			expect(isValidReplacementChar(char)).toBe(true);
		},
	);

	it.each([
		['empty', ''],
		['two characters', '--'],
		['slash', '/'],
		['backslash', '\\'],
		['colon', ':'],
		['asterisk', '*'],
		['question mark', '?'],
		['angle bracket', '<'],
		['pipe', '|'],
		['double quote', '"'],
		['open bracket', '['],
		['close bracket', ']'],
		['dot', '.'],
		['space', ' '],
		['control char', '\x00'],
	])('rejects %s', (_label, value) => {
		expect(isValidReplacementChar(value)).toBe(false);
	});
});

// formatTimestamp -----------------------------------------------------------

describe('formatTimestamp', () => {
	it.each([
		[0, '00:00'],
		[5, '00:05'],
		[59, '00:59'],
		[60, '01:00'],
		[65, '01:05'],
		[599, '09:59'],
		[3599, '59:59'],
		[3600, '1:00:00'],
		[3725, '1:02:05'],
		[7325, '2:02:05'],
	])('formats %d seconds as %s', (input, expected) => {
		expect(formatTimestamp(input)).toBe(expected);
	});

	it('clamps negative and non-finite inputs to 00:00', () => {
		expect(formatTimestamp(-1)).toBe('00:00');
		expect(formatTimestamp(Number.NaN)).toBe('00:00');
		expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('00:00');
	});

	it('floors fractional seconds', () => {
		expect(formatTimestamp(65.9)).toBe('01:05');
	});
});

// extractSpeakers -----------------------------------------------------------

describe('extractSpeakers', () => {
	it('returns an empty array for null transcript', () => {
		expect(extractSpeakers(null)).toEqual([]);
	});

	it('returns an empty array when no segments have speakers', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 10, text: 'foo' },
				{ startSeconds: 10, endSeconds: 20, text: 'bar' },
			],
		});
		expect(extractSpeakers(t)).toEqual([]);
	});

	it('deduplicates while preserving first-seen order', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 5, speaker: 'Alice', text: 'a' },
				{ startSeconds: 5, endSeconds: 10, speaker: 'Bob', text: 'b' },
				{ startSeconds: 10, endSeconds: 15, speaker: 'Alice', text: 'c' },
				{ startSeconds: 15, endSeconds: 20, speaker: 'Charlie', text: 'd' },
			],
		});
		expect(extractSpeakers(t)).toEqual(['Alice', 'Bob', 'Charlie']);
	});

	it('trims whitespace from speaker names before deduplicating', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 5, speaker: '  Alice ', text: 'a' },
				{ startSeconds: 5, endSeconds: 10, speaker: 'Alice', text: 'b' },
			],
		});
		expect(extractSpeakers(t)).toEqual(['Alice']);
	});

	it('ignores empty and whitespace-only speakers', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 5, speaker: '', text: 'a' },
				{ startSeconds: 5, endSeconds: 10, speaker: '   ', text: 'b' },
				{ startSeconds: 10, endSeconds: 15, speaker: 'Alice', text: 'c' },
			],
		});
		expect(extractSpeakers(t)).toEqual(['Alice']);
	});
});

// formatDurationHoursMinutes ------------------------------------------------

describe('formatDurationHoursMinutes', () => {
	it.each([
		[0, '0s'],
		[1, '1s'],
		[45, '45s'],
		[59, '59s'],
		[60, '1m'],
		[90, '2m'],        // rounds to nearest minute (1.5m → 2m)
		[119, '2m'],
		[600, '10m'],
		[1800, '30m'],
		[3599, '1h'],      // 59m 59s rounds to 60m which pops into 1h
		[3600, '1h'],
		[5430, '1h 31m'],  // 1h 30.5m rounds to 1h 31m
		[7200, '2h'],
		[7260, '2h 1m'],
		[36000, '10h'],
		[93600, '26h'],    // very long (26h)
	])('formats %d seconds as %s', (input, expected) => {
		expect(formatDurationHoursMinutes(input)).toBe(expected);
	});

	it('returns "0s" for negative input', () => {
		expect(formatDurationHoursMinutes(-10)).toBe('0s');
	});

	it('returns "0s" for NaN and Infinity', () => {
		expect(formatDurationHoursMinutes(Number.NaN)).toBe('0s');
		expect(formatDurationHoursMinutes(Number.POSITIVE_INFINITY)).toBe('0s');
	});

	it('omits the minutes suffix for whole-hour durations', () => {
		expect(formatDurationHoursMinutes(3600)).toBe('1h');
		expect(formatDurationHoursMinutes(7200)).toBe('2h');
	});
});

// buildNoteName -------------------------------------------------------------

describe('buildNoteName', () => {
	const apr14 = new Date(2026, 3, 14); // 2026-04-14 local

	it('uses the default template for a dateless title', () => {
		expect(buildNoteName('Quarterly review', apr14)).toBe(
			'2026-04-14 Quarterly review',
		);
	});

	it('collapses an empty or whitespace-only title to just the date', () => {
		expect(buildNoteName('   ', apr14)).toBe('2026-04-14');
	});

	// The recording date REPLACES whatever date the title starts with, in every
	// recognized form: the title's date is stripped, the template's date tokens
	// carry the recording date (createdAt = 2026-04-14 here).

	it('replaces a Plaud MM-DD prefix with the recording date', () => {
		expect(buildNoteName('04-13 Meeting notes', apr14)).toBe(
			'2026-04-14 Meeting notes',
		);
	});

	it('replaces a bare MM-DD title', () => {
		expect(buildNoteName('04-13', apr14)).toBe('2026-04-14');
	});

	it('replaces single-digit, slash, dot, year-first, US, and 2-digit-year dates', () => {
		expect(buildNoteName('4-13 Meeting', apr14)).toBe('2026-04-14 Meeting');
		expect(buildNoteName('04/13 Meeting', apr14)).toBe('2026-04-14 Meeting');
		expect(buildNoteName('04.13 Standup', apr14)).toBe('2026-04-14 Standup');
		expect(buildNoteName('2025-12-31 Party', apr14)).toBe('2026-04-14 Party');
		expect(buildNoteName('2025/12/31 Gala', apr14)).toBe('2026-04-14 Gala');
		expect(buildNoteName('12/31/2025 Recap', apr14)).toBe('2026-04-14 Recap');
		expect(buildNoteName('2026-04-13 Done', apr14)).toBe('2026-04-14 Done');
		expect(buildNoteName('04-13-26 Sprint', apr14)).toBe('2026-04-14 Sprint');
	});

	it('strips a date glued to text (04/13-Meeting) too', () => {
		expect(buildNoteName('04/13-Meeting', apr14)).toBe('2026-04-14 Meeting');
	});

	it('trims leading whitespace before detecting the date', () => {
		expect(buildNoteName('  04-13 Padded  ', apr14)).toBe('2026-04-14 Padded');
	});

	it('takes the day from the recording, not the title (day can shift)', () => {
		// The title's own date is only stripped; the value is always the recording
		// date. The title says 01-02 but the recording is 2025-12-31, so 12-31 lands.
		const dec31_2025 = new Date(2025, 11, 31);
		expect(buildNoteName('01-02 Year-end review', dec31_2025)).toBe(
			'2025-12-31 Year-end review',
		);
	});

	// Leads that are NOT a plausible date are kept verbatim, with the recording
	// date placed by the template, so a title that never showed a date still sorts.

	it('keeps a phone-number-like lead that is not a date', () => {
		expect(buildNoteName('1-800 customer service', apr14)).toBe(
			'2026-04-14 1-800 customer service',
		);
	});

	it('keeps digits with no date separator', () => {
		expect(buildNoteName('1234 sales report', apr14)).toBe(
			'2026-04-14 1234 sales report',
		);
	});

	it('keeps an ID-like numeric prefix that is not a real date', () => {
		expect(buildNoteName('123-4 Widget spec', apr14)).toBe(
			'2026-04-14 123-4 Widget spec',
		);
	});

	it('keeps an out-of-range slash prefix', () => {
		expect(buildNoteName('45/67 notes', apr14)).toBe('2026-04-14 45/67 notes');
	});

	it('keeps a version-like prefix rather than reading it as a date', () => {
		expect(buildNoteName('1.2.3 release notes', apr14)).toBe(
			'2026-04-14 1.2.3 release notes',
		);
	});

	// --- custom templates: date position and order ---

	it('puts the date at the end when the template does', () => {
		expect(
			buildNoteName('04-13 Team sync', apr14, '{{title}} {{YYYY}}-{{MM}}-{{DD}}'),
		).toBe('Team sync 2026-04-14');
	});

	it('applies a US-order template', () => {
		expect(
			buildNoteName('Team sync', apr14, '{{MM}}-{{DD}}-{{YYYY}} {{title}}'),
		).toBe('04-14-2026 Team sync');
	});

	it('applies a EU-order template', () => {
		expect(
			buildNoteName('Team sync', apr14, '{{DD}}-{{MM}}-{{YYYY}} {{title}}'),
		).toBe('14-04-2026 Team sync');
	});

	it('applies a named-month template', () => {
		expect(
			buildNoteName('Team sync', apr14, '{{MMM}} {{D}}, {{YYYY}} - {{title}}'),
		).toBe('Apr 14, 2026 - Team sync');
	});

	it('renders a whole date layout inside one {{ }} pair', () => {
		// Moment formats the entire inner string as one unit, so combined tokens and
		// their separators live in a single {{ }} (the issue #30 reporter's ask).
		expect(
			buildNoteName('Team sync', apr14, '{{YYYY-MM-DD dddd}} {{title}}'),
		).toBe('2026-04-14 Tuesday Team sync');
	});

	it('drops a stray separator when the title was only a date', () => {
		// "04-13" strips to an empty title, so the trailing "{{title}}" leaves no gap.
		expect(
			buildNoteName('04-13', apr14, '{{YYYY}}-{{MM}}-{{DD}} {{title}}'),
		).toBe('2026-04-14');
	});

	it('falls back to the recording date when the template renders empty', () => {
		// A {{title}}-only template plus a date-only title strips to nothing, so the
		// recording's ISO date is used instead of a blank name and a blank H1.
		expect(buildNoteName('04-13', apr14, '{{title}}')).toBe('2026-04-14');
	});
});

// formatNoteName ------------------------------------------------------------

describe('formatNoteName', () => {
	const d = new Date(2026, 6, 3); // 2026-07-03 local (Jul 3)

	it('renders the default ISO template with the title', () => {
		expect(formatNoteName('{{YYYY}}-{{MM}}-{{DD}} {{title}}', d, 'Sync')).toBe(
			'2026-07-03 Sync',
		);
	});

	it('places the title wherever the template puts it', () => {
		expect(formatNoteName('{{title}} {{YYYY}}-{{MM}}-{{DD}}', d, 'Sync')).toBe(
			'Sync 2026-07-03',
		);
	});

	it('renders US and EU orders', () => {
		expect(formatNoteName('{{MM}}-{{DD}}-{{YYYY}}', d, '')).toBe('07-03-2026');
		expect(formatNoteName('{{DD}}-{{MM}}-{{YYYY}}', d, '')).toBe('03-07-2026');
	});

	it('supports a 2-digit year and single-digit month/day', () => {
		expect(formatNoteName('{{M}}-{{D}}-{{YY}}', d, '')).toBe('7-3-26');
	});

	it('supports short and long month names and the weekday name', () => {
		expect(formatNoteName('{{MMM}} {{D}}, {{YYYY}}', d, '')).toBe('Jul 3, 2026');
		expect(formatNoteName('{{MMMM}} {{D}}', d, '')).toBe('July 3');
		// dddd (weekday name) is new under Moment; the reporter asked for it.
		expect(formatNoteName('{{dddd}}', d, '')).toBe('Friday');
	});

	it('supports the composite, week, and quarter tokens', () => {
		expect(formatNoteName('{{YYYY-MM}}', d, '')).toBe('2026-07');
		expect(formatNoteName('Q{{Q}}', d, '')).toBe('Q3');
		// Jan 4 2026 is in ISO week 1; WW is the ISO week (moment ww would be 02).
		expect(formatNoteName('W{{WW}}', new Date(2026, 0, 4), '')).toBe('W01');
	});

	it('renders a whole layout, tokens and separators, inside one {{ }}', () => {
		expect(formatNoteName('{{YYYY-MM-DD - dddd MMMM D}}', d, '')).toBe(
			'2026-07-03 - Friday July 3',
		);
	});

	it('leaves literal text and separators untouched', () => {
		expect(formatNoteName('{{YYYY}}_{{MM}}_{{DD}}', d, '')).toBe('2026_07_03');
	});

	it('collapses whitespace and trims when the title is empty', () => {
		expect(formatNoteName('{{YYYY}}-{{MM}}-{{DD}} {{title}}', d, '')).toBe(
			'2026-07-03',
		);
	});

	it('does not throw on an unknown token or an unclosed brace (real Moment)', () => {
		// The pre-Moment engine threw on these; Moment does not, so the settings
		// preview and isValidNoteNameTemplate are the safety net instead.
		expect(() => formatNoteName('{{nope}}', d, 'X')).not.toThrow();
		expect(() => formatNoteName('{{YYYY', d, '')).not.toThrow();
		// An unclosed brace has no matching {{ }} pair, so it stays literal.
		expect(formatNoteName('{{YYYY', d, '')).toBe('{{YYYY');
	});

	it('substitutes the title before the Moment call, so braces in it are literal', () => {
		// {{title}} is replaced first and its value is not re-scanned for tokens, so
		// a recording title that itself contains "{{" renders verbatim.
		expect(formatNoteName('{{title}}', d, 'Notes {{draft}}')).toBe(
			'Notes {{draft}}',
		);
	});
});

// isValidNoteNameTemplate ---------------------------------------------------

describe('isValidNoteNameTemplate', () => {
	it('accepts the default and preset templates', () => {
		expect(isValidNoteNameTemplate(DEFAULT_NOTE_NAME_TEMPLATE)).toBe(true);
		expect(isValidNoteNameTemplate('{{MM}}-{{DD}}-{{YYYY}} {{title}}')).toBe(true);
		expect(isValidNoteNameTemplate('{{title}} {{YYYY}}-{{MM}}-{{DD}}')).toBe(true);
	});

	it('accepts a comma, period, underscore, space, and parentheses', () => {
		// A comma is filesystem-safe on all three OSes, so it is accepted.
		expect(isValidNoteNameTemplate('{{MMM}} {{D}}, {{YYYY}} - {{title}}')).toBe(true);
		expect(isValidNoteNameTemplate('{{YYYY}}.{{MM}}.{{DD}} ({{title}})')).toBe(true);
		expect(isValidNoteNameTemplate('{{YYYY}}_{{MM}}_{{DD}}_{{title}}')).toBe(true);
	});

	it('rejects a template whose render contains a path separator', () => {
		expect(isValidNoteNameTemplate('{{YYYY}}/{{MM}}/{{DD}}')).toBe(false);
		expect(isValidNoteNameTemplate('{{YYYY}}\\{{MM}} {{title}}')).toBe(false);
	});

	it('rejects a colon, including one produced by a time token', () => {
		// A literal colon and an HH:mm token both land a colon in the filename;
		// real Moment happily renders the time token, so render-safety must catch it.
		expect(isValidNoteNameTemplate('{{YYYY}}:{{MM}} {{title}}')).toBe(false);
		expect(isValidNoteNameTemplate('{{HH:mm}}')).toBe(false);
		expect(isValidNoteNameTemplate('{{YYYY}} {{HH:mm}} {{title}}')).toBe(false);
	});

	it('rejects the other Windows-forbidden filename characters', () => {
		expect(isValidNoteNameTemplate('{{title}}?')).toBe(false);
		expect(isValidNoteNameTemplate('{{title}}*')).toBe(false);
		expect(isValidNoteNameTemplate('<{{title}}>')).toBe(false);
		expect(isValidNoteNameTemplate('{{title}} | {{YYYY}}')).toBe(false);
	});

	it('accepts real Moment tokens that the old engine rejected as wrong-case', () => {
		// The whole point of issue #30: uppercase YYYY/DD and the weekday token are
		// valid now, not rejected as unknown.
		expect(isValidNoteNameTemplate('{{YYYY}}-{{MM}}-{{DD}}')).toBe(true);
		expect(isValidNoteNameTemplate('{{dddd}} {{title}}')).toBe(true);
	});

	it('rejects a trailing dot, which Windows silently drops from a filename', () => {
		expect(isValidNoteNameTemplate('{{YYYY}}-{{MM}}-{{DD}}.')).toBe(false);
	});
});

// resolveSubfolder ----------------------------------------------------------

describe('resolveSubfolder', () => {
	const jun4 = new Date(2026, 5, 4); // 2026-06-04 local

	it('returns empty string for an empty or whitespace template (flat behavior)', () => {
		expect(resolveSubfolder('', jun4)).toBe('');
		expect(resolveSubfolder('   ', jun4)).toBe('');
	});

	it('expands {{YYYY}}, {{MM}}, {{DD}} from the recording date', () => {
		expect(resolveSubfolder('{{YYYY}}', jun4)).toBe('2026');
		expect(resolveSubfolder('{{MM}}', jun4)).toBe('06');
		expect(resolveSubfolder('{{DD}}', jun4)).toBe('04');
	});

	it('expands a composite date inside one {{ }}', () => {
		expect(resolveSubfolder('{{YYYY-MM}}', jun4)).toBe('2026-06');
	});

	it('supports the named-month and weekday tokens (parity with note names)', () => {
		// These worked only in note names before; issue #30 unifies the vocabulary.
		expect(resolveSubfolder('{{MMMM}}', jun4)).toBe('June');
		expect(resolveSubfolder('{{YYYY}}/{{MM MMMM}}', jun4)).toBe('2026/06 June');
		expect(resolveSubfolder('{{dddd}}', jun4)).toBe('Thursday');
	});

	it('supports nested tokens and literal path text', () => {
		expect(resolveSubfolder('{{YYYY}}/{{MM}}', jun4)).toBe('2026/06');
		expect(resolveSubfolder('meetings/{{YYYY-MM}}', jun4)).toBe('meetings/2026-06');
	});

	it('keeps literal separators a user puts between tokens', () => {
		// A dash between year and month.
		expect(resolveSubfolder('{{YYYY}}-{{MM}}', jun4)).toBe('2026-06');
		// Day-first ordering for non-US users, with their own separators.
		expect(resolveSubfolder('{{DD}}-{{MM}}-{{YYYY}}', jun4)).toBe('04-06-2026');
		// Literal text around a token.
		expect(resolveSubfolder('Q{{Q}}-{{YYYY}}', jun4)).toBe('Q2-2026');
	});

	it('tolerates inner whitespace around a single token', () => {
		expect(resolveSubfolder('{{ YYYY-MM }}', jun4)).toBe('2026-06');
	});

	it('does not throw on an unknown-looking token (real Moment)', () => {
		// The pre-Moment engine threw here; Moment renders the format instead, and
		// the settings preview is what surfaces a wrong token now.
		expect(() => resolveSubfolder('{{YYY}}', jun4)).not.toThrow();
	});

	it('resolves to _undated when the recording date is missing or invalid', () => {
		expect(resolveSubfolder('{{YYYY-MM}}', new Date(Number.NaN))).toBe('_undated');
	});

	it('rejects a template that would escape the vault', () => {
		expect(() => resolveSubfolder('../{{YYYY}}', jun4)).toThrow(NoteWriterError);
	});

	it('rejects a literal segment that is a reserved Windows device name', () => {
		// These fail folder creation on Windows and can only come from literal text
		// a user typed (no date token renders one), so the template is refused
		// rather than a folder silently relocated. Case-insensitive.
		expect(() => resolveSubfolder('CON/{{YYYY}}', jun4)).toThrow(NoteWriterError);
		expect(() => resolveSubfolder('{{YYYY}}/nul', jun4)).toThrow(NoteWriterError);
		expect(() => resolveSubfolder('lpt1', jun4)).toThrow(NoteWriterError);
	});

	it('rejects a reserved device name that carries an extension (CON.txt)', () => {
		// Windows keys reserved names off the base before the first dot, so
		// "CON.txt" and "NUL.md" are the device too, not just the bare name.
		expect(() => resolveSubfolder('CON.txt/{{YYYY}}', jun4)).toThrow(NoteWriterError);
		expect(() => resolveSubfolder('{{YYYY}}/nul.md', jun4)).toThrow(NoteWriterError);
		// A dotted segment whose base is NOT reserved stays legal.
		expect(resolveSubfolder('2026.06/{{DD}}', jun4)).toBe('2026.06/04');
	});

	it('rewrites ASCII control characters in a literal segment', () => {
		// A control char cannot come from a date token, but a pasted literal could
		// carry one; it is rewritten to a dash the same way sanitizeFilename does,
		// so folder creation does not fail on Windows.
		expect(resolveSubfolder('a\x01b/{{YYYY}}', jun4)).toBe('a-b/2026');
	});

	it('rejects a segment longer than one path component can hold', () => {
		// The folder analogue of sanitizeFilename's length clamp: a single level
		// over the 200-char limit fails folder creation, so the template is refused.
		const tooLong = 'x'.repeat(201);
		expect(() => resolveSubfolder(`${tooLong}/{{YYYY}}`, jun4)).toThrow(NoteWriterError);
		// A 200-char segment is at the limit and still allowed.
		expect(resolveSubfolder(`${'x'.repeat(200)}/{{MM}}`, jun4)).toBe(`${'x'.repeat(200)}/06`);
	});

	it('rejects a segment ending in a dot or space (Windows drops them)', () => {
		// A trailing dot/space makes "2026 " and "2026" collide on Windows, which
		// breaks the duplicate guard. A trailing token on a non-final segment is the
		// reachable case; the whole-path ends are already trimmed by normalizeFolderPath.
		expect(() => resolveSubfolder('{{YYYY}} /{{MM}}', jun4)).toThrow(NoteWriterError);
		expect(() => resolveSubfolder('{{YYYY}}./{{MM}}', jun4)).toThrow(NoteWriterError);
	});

	it('does not reject ordinary date-token output that merely contains reserved letters', () => {
		// Regression guard: month/weekday names are never a bare reserved name, so
		// the new check must not over-block a normal template.
		expect(resolveSubfolder('{{MMMM}}/{{YYYY}}', jun4)).toBe('June/2026');
		expect(resolveSubfolder('{{dddd}}', jun4)).toBe('Thursday');
		// "COMMS" is not a reserved name even though "COM" prefixes it.
		expect(resolveSubfolder('COMMS/{{YYYY}}', jun4)).toBe('COMMS/2026');
	});

	it('returns the flat path for a template that normalizes to empty', () => {
		// "/" and "." normalize to '' (no real segment). Sanitizing an empty
		// segment would otherwise yield a stray "Untitled" folder.
		expect(resolveSubfolder('/', jun4)).toBe('');
		expect(resolveSubfolder('.', jun4)).toBe('');
	});

	it('sanitizes a Windows-forbidden character a Moment format renders into a segment', () => {
		// A colon from a time token would fail folder creation on Windows; it is
		// rewritten to a dash so the import does not fail, while a literal '/' stays
		// an intentional nesting separator.
		const withTime = new Date(2026, 5, 4, 14, 5); // 2026-06-04 14:05 local
		expect(resolveSubfolder('{{HH:mm}}', withTime)).toBe('14-05');
		expect(resolveSubfolder('{{YYYY}}/{{HH:mm}}', withTime)).toBe('2026/14-05');
	});

	it('uses local-time fields, matching the date: frontmatter basis', () => {
		// A late-evening local time must not roll into the next UTC day.
		const lateLocal = new Date(2026, 0, 31, 23, 30); // 2026-01-31 23:30 local
		expect(resolveSubfolder('{{YYYY-MM}}/{{DD}}', lateLocal)).toBe('2026-01/31');
	});

	it('expands {{WW}} to a zero-padded ISO week number', () => {
		// Jan 4 is always in ISO week 1, by definition of the standard.
		expect(resolveSubfolder('{{WW}}', new Date(2026, 0, 4))).toBe('01');
		// Mid-year sanity: the result is always a two-digit string.
		expect(resolveSubfolder('{{WW}}', jun4)).toMatch(/^\d{2}$/);
	});

	it('pairs {{YYYY}} with {{WW}} for week-foldered layouts', () => {
		expect(resolveSubfolder('{{YYYY}}/W{{WW}}', new Date(2026, 0, 4))).toBe('2026/W01');
	});

	it('expands {{Q}} to the calendar quarter', () => {
		expect(resolveSubfolder('{{Q}}', new Date(2026, 0, 15))).toBe('1'); // Jan
		expect(resolveSubfolder('{{Q}}', new Date(2026, 2, 31))).toBe('1'); // Mar
		expect(resolveSubfolder('{{Q}}', new Date(2026, 3, 1))).toBe('2'); // Apr
		expect(resolveSubfolder('{{Q}}', jun4)).toBe('2'); // Jun
		expect(resolveSubfolder('{{Q}}', new Date(2026, 11, 31))).toBe('4'); // Dec
	});

	// {{title}} support (issue #30 follow-up) for folder-note layouts.
	it('expands {{title}} to the recording title', () => {
		expect(resolveSubfolder('{{title}}', jun4, 'Team sync')).toBe('Team sync');
		expect(resolveSubfolder('{{YYYY}}/{{title}}', jun4, 'Team sync')).toBe(
			'2026/Team sync',
		);
	});

	it('strips a leading date from a {{title}} folder, matching the note name', () => {
		expect(resolveSubfolder('{{title}}', jun4, '06-04 Team sync')).toBe('Team sync');
		expect(resolveSubfolder('{{title}}', jun4, '2026-06-04 Team sync')).toBe(
			'Team sync',
		);
	});

	it('flattens a slash or backslash in a title so it stays one folder', () => {
		// A slash in a title must NOT create an extra nesting level; it is flattened
		// to the replacement char before the path split.
		expect(resolveSubfolder('{{title}}', jun4, 'Q3/Q4 sync')).toBe('Q3-Q4 sync');
		// normalizeFolderPath turns a stray backslash into '/', so it is flattened
		// too, before that conversion.
		expect(resolveSubfolder('{{title}}', jun4, 'a\\b')).toBe('a-b');
		// A literal '/' the user types between tokens still nests.
		expect(resolveSubfolder('{{YYYY}}/{{title}}', jun4, 'A/B')).toBe('2026/A-B');
	});

	it('uses the configured replacement char for a flattened title separator', () => {
		expect(resolveSubfolder('{{title}}', jun4, 'Q3/Q4', '_')).toBe('Q3_Q4');
	});

	it('sanitizes other forbidden characters in a {{title}} folder per segment', () => {
		// A colon in the title is not a path separator, so the per-segment folder
		// sanitizer rewrites it (to the replacement char) after the split.
		expect(resolveSubfolder('{{title}}', jun4, 'Q2: review')).toBe('Q2- review');
	});

	it('does not throw on a title that is unusable as a raw folder segment', () => {
		// Unlike an authored template literal, a recording title is data: a reserved
		// device name, a trailing dot/space, or an over-length title must sanitize
		// (like a filename) rather than throw and abort the import.
		expect(resolveSubfolder('{{title}}', jun4, 'CON')).toBe('_CON');
		expect(resolveSubfolder('{{title}}', jun4, 'Team sync.')).toBe('Team sync');
		expect(resolveSubfolder('{{title}}', jun4, 'Team sync ')).toBe('Team sync');
		expect(resolveSubfolder('{{title}}', jun4, 'x'.repeat(201))).toBe(
			'x'.repeat(200),
		);
	});

	it('buckets an empty-title folder to _untitled instead of collapsing', () => {
		// A title that reduces to empty (only a date, blank, or only punctuation
		// that sanitizes away) would otherwise resolve to '' and drop the note into
		// the output root, or produce a folder literally named 'Untitled'.
		expect(resolveSubfolder('{{title}}', jun4, '2026-06-04')).toBe('_untitled');
		expect(resolveSubfolder('{{title}}', jun4, '')).toBe('_untitled');
		expect(resolveSubfolder('{{title}}', jun4, '   ')).toBe('_untitled');
		expect(resolveSubfolder('{{title}}', jun4, '.')).toBe('_untitled');
		expect(resolveSubfolder('{{title}}', jun4, '...')).toBe('_untitled');
	});

	it('does not bucket a template that still has a date level around an empty title', () => {
		// Only a fully-empty result buckets; a surviving date segment keeps nesting.
		expect(resolveSubfolder('{{YYYY}}/{{title}}', jun4, '')).toBe('2026');
	});
});

// migrateLegacyDateTemplate -------------------------------------------------

describe('migrateLegacyDateTemplate', () => {
	const jul3 = new Date(2026, 6, 3); // 2026-07-03 local (Friday)

	// The three DANGER tokens: each renders a PLAUSIBLE but wrong value under
	// Moment if left unmigrated, so the rewrite is mandatory, not cosmetic. Each
	// assertion proves the migrated template renders exactly the legacy output.
	it('rewrites {{dd}} to {{DD}}, preserving the day-of-month output', () => {
		expect(migrateLegacyDateTemplate('{{dd}}')).toBe('{{DD}}');
		// Legacy dd = "03"; unmigrated Moment dd = "Fr" (weekday abbreviation).
		expect(formatNoteName(migrateLegacyDateTemplate('{{dd}}'), jul3, '')).toBe('03');
	});

	it('rewrites {{d}} to {{D}}, preserving the day-of-month output', () => {
		expect(migrateLegacyDateTemplate('{{d}}')).toBe('{{D}}');
		// Legacy d = "3"; unmigrated Moment d = "5" (day-of-week number).
		expect(formatNoteName(migrateLegacyDateTemplate('{{d}}'), jul3, '')).toBe('3');
	});

	it('rewrites {{ww}} to {{WW}}, preserving the ISO week output', () => {
		expect(migrateLegacyDateTemplate('{{ww}}')).toBe('{{WW}}');
		// Jan 4 2026 is ISO week 01; unmigrated Moment ww = "02" (LOCALE week).
		const jan4 = new Date(2026, 0, 4);
		expect(formatNoteName(migrateLegacyDateTemplate('{{ww}}'), jan4, '')).toBe('01');
	});

	it('recases the remaining year tokens, preserving output', () => {
		expect(migrateLegacyDateTemplate('{{yyyy}}')).toBe('{{YYYY}}');
		expect(migrateLegacyDateTemplate('{{yy}}')).toBe('{{YY}}');
		expect(migrateLegacyDateTemplate('{{yyyy-MM}}')).toBe('{{YYYY-MM}}');
		// Legacy yy = "26"; unmigrated Moment yy = "2026" (full year).
		expect(formatNoteName(migrateLegacyDateTemplate('{{yy}}'), jul3, '')).toBe('26');
	});

	it('migrates the old default note-name template output-preservingly', () => {
		const oldDefault = '{{yyyy}}-{{MM}}-{{dd}} {{title}}';
		expect(migrateLegacyDateTemplate(oldDefault)).toBe(DEFAULT_NOTE_NAME_TEMPLATE);
		// The migrated template renders the exact legacy note name.
		expect(formatNoteName(migrateLegacyDateTemplate(oldDefault), jul3, 'Sync')).toBe(
			'2026-07-03 Sync',
		);
	});

	it('migrates a legacy subfolder template output-preservingly', () => {
		const jun4 = new Date(2026, 5, 4);
		expect(migrateLegacyDateTemplate('{{yyyy}}/W{{ww}}')).toBe('{{YYYY}}/W{{WW}}');
		expect(
			resolveSubfolder(migrateLegacyDateTemplate('{{yyyy}}/W{{ww}}'), jun4),
		).toBe('2026/W23');
	});

	it('leaves already-Moment tokens, {{title}}, MMMM, MM, and Q untouched', () => {
		expect(
			migrateLegacyDateTemplate('{{YYYY}}-{{MM}}-{{DD}} {{title}}'),
		).toBe('{{YYYY}}-{{MM}}-{{DD}} {{title}}');
		expect(migrateLegacyDateTemplate('{{MMMM}} {{MM}} {{Q}} {{title}}')).toBe(
			'{{MMMM}} {{MM}} {{Q}} {{title}}',
		);
	});

	it('is idempotent: a second pass changes nothing', () => {
		const once = migrateLegacyDateTemplate('{{yyyy}}-{{MM}}-{{dd}} {{title}}');
		expect(migrateLegacyDateTemplate(once)).toBe(once);
	});

	it('never throws and passes through a hand-edited unclosed template', () => {
		expect(() => migrateLegacyDateTemplate('{{yyyy')).not.toThrow();
		expect(migrateLegacyDateTemplate('{{yyyy')).toBe('{{yyyy');
	});
});

// locale independence -------------------------------------------------------

describe('English locale is pinned (issue #30 output-preservation)', () => {
	// The pre-Moment engine emitted English month/weekday names from hardcoded
	// tables. Obsidian's moment follows the app display language, so the formatter
	// pins 'en' to keep a migrated {{MMMM}}/{{dddd}} template output-preserving on
	// a non-English Obsidian UI.
	it('renders English names even when the global Moment locale is not English', () => {
		const previousLocale = moment.locale();
		// A synthetic non-English locale, so the test needs no extra locale package.
		// defineLocale also switches the active locale to it as a side effect.
		moment.defineLocale('xx-test', {
			months: 'Mo1_Mo2_Mo3_Mo4_Mo5_Mo6_Mo7_Mo8_Mo9_Mo10_Mo11_Mo12'.split('_'),
			weekdays: 'Dy0_Dy1_Dy2_Dy3_Dy4_Dy5_Dy6'.split('_'),
		});
		try {
			// Sanity: the global locale really did switch (guards the test itself).
			expect(moment(new Date(2026, 5, 4)).format('MMMM')).toBe('Mo6');
			// The plugin's formatters must still emit English.
			const jun4 = new Date(2026, 5, 4); // June 4 2026 (a Thursday)
			expect(formatNoteName('{{MMMM}}', jun4, '')).toBe('June');
			expect(formatNoteName('{{dddd}}', jun4, '')).toBe('Thursday');
			expect(resolveSubfolder('{{MMMM}}', jun4)).toBe('June');
		} finally {
			moment.locale(previousLocale);
		}
	});
});

// template preview rendering ------------------------------------------------

describe('settings live preview', () => {
	it('renders the subfolder preview against the shared sample date', () => {
		// The sample recording is 2026-07-05 (a Sunday); this is what the settings
		// preview shows under the subfolder field.
		expect(resolveSubfolder('{{YYYY}}/{{MM MMMM}}', TEMPLATE_PREVIEW_DATE)).toBe(
			'2026/07 July',
		);
	});

	it('renders the note-name preview against the shared sample recording', () => {
		expect(
			buildNoteName(
				TEMPLATE_PREVIEW_TITLE,
				TEMPLATE_PREVIEW_DATE,
				DEFAULT_NOTE_NAME_TEMPLATE,
			),
		).toBe('2026-07-05 Team sync');
		// A whole layout in one {{ }} previews as one unit (Sunday, the sample day).
		expect(
			buildNoteName(
				TEMPLATE_PREVIEW_TITLE,
				TEMPLATE_PREVIEW_DATE,
				'{{YYYY-MM-DD dddd}} {{title}}',
			),
		).toBe('2026-07-05 Sunday Team sync');
	});
});

// formatPlaudWebUrl ---------------------------------------------------------

describe('formatPlaudWebUrl', () => {
	it('builds the canonical web.plaud.ai/file/{id} URL for a real hex ID', () => {
		expect(formatPlaudWebUrl('4cba85e559d7f7c9058bf71c23d86d2d')).toBe(
			'https://web.plaud.ai/file/4cba85e559d7f7c9058bf71c23d86d2d',
		);
	});

	it('URL-encodes IDs that contain reserved characters (defense-in-depth)', () => {
		expect(formatPlaudWebUrl('id/with/slash')).toBe(
			'https://web.plaud.ai/file/id%2Fwith%2Fslash',
		);
		expect(formatPlaudWebUrl('id with space')).toBe(
			'https://web.plaud.ai/file/id%20with%20space',
		);
	});

	it('passes through plain alphanumeric IDs without encoding', () => {
		expect(formatPlaudWebUrl('abc123')).toBe('https://web.plaud.ai/file/abc123');
	});
});

// formatFrontmatter --------------------------------------------------------

describe('formatFrontmatter', () => {
	it('includes all required fields in the documented order', () => {
		const fm = formatFrontmatter(makeRecording(), ['Charles', 'Mary']);
		const lines = fm.split('\n');
		expect(lines[0]).toBe('---');
		expect(lines).toContain('plaud-id: abc123');
		expect(lines).toContain('plaud-url: "https://web.plaud.ai/file/abc123"');
		expect(lines).toContain('date: 2026-04-14');
		expect(lines).toContain('duration-seconds: 600');
		// The human-readable duration starts with a digit so yamlScalar
		// force-quotes it (digit-leading values look like numbers to YAML
		// and must be quoted to parse as strings).
		expect(lines).toContain('duration: "10m"');
		expect(lines).toContain('speakers: [Charles, Mary]');
		expect(lines).toContain('source: plaud');
		expect(lines[lines.length - 1]).toBe('---');
	});

	it('places plaud-url directly after plaud-id', () => {
		const fm = formatFrontmatter(makeRecording(), []);
		const lines = fm.split('\n');
		const idIdx = lines.findIndex((l) => l.startsWith('plaud-id:'));
		const urlIdx = lines.findIndex((l) => l.startsWith('plaud-url:'));
		expect(idIdx).toBeGreaterThan(0);
		expect(urlIdx).toBe(idIdx + 1);
	});

	it('includes a human-readable duration field alongside duration-seconds', () => {
		// 5400s → 90m → 1h 30m (crosses hour boundary)
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: 5400 }),
			[],
		);
		expect(fm).toContain('duration-seconds: 5400');
		expect(fm).toContain('duration: "1h 30m"');
	});

	it('formats very short durations as seconds in the duration field', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: 42 }),
			[],
		);
		expect(fm).toContain('duration-seconds: 42');
		expect(fm).toContain('duration: "42s"');
	});

	it('formats whole-hour durations without a trailing 0m', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: 7200 }),
			[],
		);
		expect(fm).toContain('duration: "2h"');
	});

	it('omits the speakers line when speakers is empty', () => {
		const fm = formatFrontmatter(makeRecording(), []);
		expect(fm).not.toMatch(/speakers:/);
	});

	it('omits the tags line when recording.tags is absent', () => {
		const fm = formatFrontmatter(makeRecording({ tags: undefined }), []);
		expect(fm).not.toMatch(/tags:/);
	});

	it('emits plaud-version-ms as a raw number when versionMs is present (auto-sync cursor)', () => {
		const fm = formatFrontmatter(makeRecording({ versionMs: 1782918853105 }), []);
		expect(fm).toContain('plaud-version-ms: 1782918853105');
	});

	it('omits plaud-version-ms when versionMs is absent', () => {
		const fm = formatFrontmatter(makeRecording({ versionMs: undefined }), []);
		expect(fm).not.toMatch(/plaud-version-ms:/);
	});

	it('includes tags when recording.tags has values', () => {
		const fm = formatFrontmatter(
			makeRecording({ tags: ['meeting', 'q2'] }),
			[],
		);
		expect(fm).toContain('tags: [meeting, q2]');
	});

	it('quotes YAML scalars with special characters', () => {
		const fm = formatFrontmatter(makeRecording(), ['Ana: Chen', 'Bo "B" Li']);
		expect(fm).toContain('speakers: ["Ana: Chen", "Bo \\"B\\" Li"]');
	});

	it('omits the keywords line when keywords is absent or empty', () => {
		expect(formatFrontmatter(makeRecording(), [])).not.toMatch(/keywords:/);
		expect(formatFrontmatter(makeRecording(), [], null, [])).not.toMatch(
			/keywords:/,
		);
	});

	it('emits the keywords line after tags when keywords has values', () => {
		const fm = formatFrontmatter(
			makeRecording({ tags: ['meeting'] }),
			[],
			null,
			['AI Agent', 'Customer Data'],
		);
		expect(fm).toContain('keywords: [AI Agent, Customer Data]');
		expect(fm.indexOf('tags:')).toBeLessThan(fm.indexOf('keywords:'));
	});

	it('quotes keyword values with special characters', () => {
		const fm = formatFrontmatter(makeRecording(), [], null, [
			'Q2: Review',
			'true',
		]);
		expect(fm).toContain('keywords: ["Q2: Review", "true"]');
	});

	// plaud-folder (issue #16): resolved folder NAMES for the recording. Kept
	// separate from tags: so the pretty name survives; the field is an array to
	// tolerate multi-folder data even though single-folder is the Plaud norm.

	it('emits a single folder name as a plaud-folder array', () => {
		const fm = formatFrontmatter(
			makeRecording({ tags: ['work'] }),
			[],
			null,
			undefined,
			['Daily Journal'],
		);
		expect(fm).toContain('plaud-folder: [Daily Journal]');
	});

	it('emits multiple folder names, quoting ones with special characters', () => {
		const fm = formatFrontmatter(makeRecording(), [], null, undefined, [
			'Daily Journal',
			'B&B',
		]);
		expect(fm).toContain('plaud-folder: [Daily Journal, "B&B"]');
	});

	it('omits plaud-folder when folders is absent or empty', () => {
		expect(formatFrontmatter(makeRecording(), [])).not.toMatch(/plaud-folder:/);
		expect(
			formatFrontmatter(makeRecording(), [], null, undefined, []),
		).not.toMatch(/plaud-folder:/);
	});

	// datetime property (issue #32). The recording is 2026-04-14 09:30 local.
	it('omits the datetime line when the template is absent or empty', () => {
		expect(formatFrontmatter(makeRecording(), [])).not.toMatch(/^datetime:/m);
		expect(
			formatFrontmatter(makeRecording(), [], null, undefined, undefined, ''),
		).not.toMatch(/^datetime:/m);
		expect(
			formatFrontmatter(makeRecording(), [], null, undefined, undefined, '   '),
		).not.toMatch(/^datetime:/m);
	});

	it('emits a 24-hour datetime, quoted for the colon', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			null,
			undefined,
			undefined,
			'{{YYYY-MM-DD HH:mm}}',
		);
		expect(fm).toContain('datetime: "2026-04-14 09:30"');
	});

	it('emits a 12-hour datetime with AM/PM', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			null,
			undefined,
			undefined,
			'{{h:mm A}}',
		);
		expect(fm).toContain('datetime: "9:30 AM"');
	});

	it('emits an ISO datetime carrying the local UTC offset', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			null,
			undefined,
			undefined,
			'{{YYYY-MM-DDTHH:mm:ssZ}}',
		);
		// The offset depends on the machine time zone, so assert the shape, not a
		// fixed offset. The wall-clock stays 09:30:00 because the sample date was
		// built from local components and Moment formats in local time.
		expect(fm).toMatch(/^datetime: "2026-04-14T09:30:00[+-]\d\d:\d\d"$/m);
	});

	it('keeps date as YYYY-MM-DD and places datetime right after it', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			null,
			undefined,
			undefined,
			'{{YYYY-MM-DD HH:mm}}',
		);
		const lines = fm.split('\n');
		const dateIdx = lines.findIndex((l) => l.startsWith('date:'));
		expect(lines[dateIdx]).toBe('date: 2026-04-14');
		expect(lines[dateIdx + 1]).toBe('datetime: "2026-04-14 09:30"');
	});

	it('clamps negative/infinite durations in the duration-seconds line', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: -10 }),
			[],
		);
		expect(fm).toContain('duration-seconds: 0');
	});

	it('floors fractional durations', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: 600.9 }),
			[],
		);
		expect(fm).toContain('duration-seconds: 600');
	});

	it('always includes source: plaud for Dataview discovery', () => {
		const fm = formatFrontmatter(makeRecording(), []);
		expect(fm).toContain('source: plaud');
	});

	// Summary extras emit conditional plaud-* lines. Each line appears
	// only when the corresponding extra is present on Summary; missing
	// extras produce no output, so older recordings stay clean.

	it('omits all plaud-* extras lines when summary is undefined', () => {
		const fm = formatFrontmatter(makeRecording(), []);
		expect(fm).not.toMatch(/plaud-headline:/);
		expect(fm).not.toMatch(/plaud-category:/);
		expect(fm).not.toMatch(/plaud-language:/);
		expect(fm).not.toMatch(/plaud-template:/);
		expect(fm).not.toMatch(/plaud-model:/);
		expect(fm).not.toMatch(/plaud-note-id:/);
		expect(fm).not.toMatch(/plaud-summary-id:/);
		expect(fm).not.toMatch(/plaud-summary-version:/);
	});

	it('omits all plaud-* extras lines when summary has only id+text', () => {
		const fm = formatFrontmatter(makeRecording(), [], makeSummary());
		expect(fm).not.toMatch(/plaud-headline:/);
		expect(fm).not.toMatch(/plaud-template:/);
	});

	it('emits exactly the extras lines for fields present on Summary', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			makeSummary({
				headline: 'Q2 Planning',
				category: 'ai-meeting',
				language: 'en',
				template: 'ai-meeting',
				model: 'azure-sweden-central-gpt-5',
				noteId: 'note-abc',
				summaryId: 'sum-xyz',
				version: '3',
			}),
		);
		// yamlScalar leaves `Q2 Planning` unquoted because the pattern
		// allows letters / digits / spaces. `azure-sweden-central-gpt-5`
		// is also pattern-safe (hyphens allowed). `"3"` gets quoted only
		// because it leads with a digit.
		expect(fm).toContain('plaud-headline: Q2 Planning');
		expect(fm).toContain('plaud-category: ai-meeting');
		expect(fm).toContain('plaud-language: en');
		expect(fm).toContain('plaud-template: ai-meeting');
		expect(fm).toContain('plaud-model: azure-sweden-central-gpt-5');
		expect(fm).toContain('plaud-note-id: note-abc');
		expect(fm).toContain('plaud-summary-id: sum-xyz');
		expect(fm).toContain('plaud-summary-version: "3"');
	});

	it('emits partial extras and omits the rest', () => {
		const fm = formatFrontmatter(
			makeRecording(),
			[],
			makeSummary({ template: 'lecture', language: 'en' }),
		);
		expect(fm).toContain('plaud-template: lecture');
		expect(fm).toContain('plaud-language: en');
		expect(fm).not.toMatch(/plaud-headline:/);
		expect(fm).not.toMatch(/plaud-model:/);
	});
});

// formatMarkdown -----------------------------------------------------------

describe('formatMarkdown', () => {
	it('produces frontmatter, H1, open-in-plaud link, summary, and transcript callout in order', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		// Order assertions: find each anchor's index and verify monotonic.
		const fmStart = md.indexOf('---');
		const h1 = md.indexOf('# 2026-04-14 Morning standup');
		const plaudLink = md.indexOf('[Open in Plaud →](');
		const summaryH2 = md.indexOf('## Summary');
		const callout = md.indexOf('> [!note]- Transcript');
		expect(fmStart).toBeGreaterThanOrEqual(0);
		expect(h1).toBeGreaterThan(fmStart);
		expect(plaudLink).toBeGreaterThan(h1);
		expect(summaryH2).toBeGreaterThan(plaudLink);
		expect(callout).toBeGreaterThan(summaryH2);
	});

	it('puts the Open in Plaud link on its own line directly after the H1 (blank line separator)', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		// A bare regex over the full body ensures the link is exactly on
		// the line after the H1 with one blank line between them — if a
		// future change accidentally wraps the link inside the summary
		// section, this catches it.
		expect(md).toMatch(
			/^# 2026-04-14 Morning standup\n\n\[Open in Plaud →\]\(https:\/\/web\.plaud\.ai\/file\/abc123\)\n/m,
		);
	});

	it('appends an AI Suggestions section after Summary when present', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary({ aiSuggestion: 'Follow up with the team on action items.' }),
		);
		const summaryH2 = md.indexOf('## Summary');
		const aiSuggestionsH2 = md.indexOf('## AI Suggestions');
		const callout = md.indexOf('> [!note]- Transcript');
		expect(aiSuggestionsH2).toBeGreaterThan(summaryH2);
		expect(aiSuggestionsH2).toBeLessThan(callout);
		expect(md).toContain('Follow up with the team on action items.');
	});

	it('omits the AI Suggestions section when summary lacks aiSuggestion', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		expect(md).not.toContain('## AI Suggestions');
	});

	it('builds the Open in Plaud link from formatPlaudWebUrl for the recording ID', () => {
		const md = formatMarkdown(
			makeRecording({ id: '4cba85e559d7f7c9058bf71c23d86d2d' as PlaudRecordingId }),
			makeTranscript(),
			makeSummary(),
		);
		expect(md).toContain(
			'[Open in Plaud →](https://web.plaud.ai/file/4cba85e559d7f7c9058bf71c23d86d2d)',
		);
	});

	it('replaces a title date with the recording date in the H1', () => {
		const md = formatMarkdown(
			makeRecording({ title: '04-13 Client kickoff' }),
			makeTranscript(),
			makeSummary(),
		);
		// createdAt is 2026-04-14, which replaces the title's 04-13.
		expect(md).toContain('# 2026-04-14 Client kickoff');
		expect(md).not.toMatch(/^# 04-13/m);
	});

	it('prepends the recording date to a dateless title in the H1', () => {
		const md = formatMarkdown(
			makeRecording({ title: 'Quarterly review' }),
			makeTranscript(),
			makeSummary(),
		);
		// makeRecording() uses createdAt of 2026-04-14 → dateless gets that date
		expect(md).toContain('# 2026-04-14 Quarterly review');
		expect(md).not.toMatch(/^# Quarterly review/m);
	});

	it('renders transcript segments as one callout line each with [MM:SS] markers', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		expect(md).toContain('> **[00:00]** Charles: Thanks for making time.');
		expect(md).toContain('> **[00:14]** Mary: Of course, glad to be here.');
	});

	it('uses 1:MM:SS format for transcript segments past the one-hour mark', () => {
		const longTranscript = makeTranscript({
			segments: [
				{ startSeconds: 3725, endSeconds: 3740, speaker: 'Charles', text: 'Late in the call.' },
			],
		});
		const md = formatMarkdown(makeRecording(), longTranscript, makeSummary());
		expect(md).toContain('> **[1:02:05]** Charles: Late in the call.');
	});

	it('uses "Unknown" when a segment has no speaker', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 5, text: 'anonymous line' },
			],
		});
		const md = formatMarkdown(makeRecording(), t, makeSummary());
		expect(md).toContain('> **[00:00]** Unknown: anonymous line');
	});

	it('collapses newlines inside a transcript segment to single spaces', () => {
		const t = makeTranscript({
			segments: [
				{ startSeconds: 0, endSeconds: 5, speaker: 'Charles', text: 'one\n two\n\n  three' },
			],
		});
		const md = formatMarkdown(makeRecording(), t, makeSummary());
		expect(md).toContain('> **[00:00]** Charles: one two three');
	});

	it('handles a null transcript with a placeholder callout', () => {
		const md = formatMarkdown(makeRecording(), null, makeSummary());
		expect(md).toContain('> [!note]- Transcript');
		expect(md).toContain('> _No transcript available._');
	});

	it('handles a null summary with a placeholder', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), null);
		expect(md).toContain('## Summary');
		expect(md).toContain('_No summary available._');
	});

	it('renders summary sections as H3 when present', () => {
		const summary: Summary = {
			id: 'abc123' as PlaudRecordingId,
			text: 'ignored when sections present',
			sections: [
				{ heading: 'Key takeaways', body: '- First\n- Second' },
				{ heading: 'Action items', body: 'Charles to draft.' },
			],
		};
		const md = formatMarkdown(makeRecording(), makeTranscript(), summary);
		expect(md).toContain('### Key takeaways');
		expect(md).toContain('- First');
		expect(md).toContain('### Action items');
		expect(md).not.toContain('ignored when sections present');
	});

	it('uses summary.text when sections is absent', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		expect(md).toContain('- Mary wants to revisit pricing');
		expect(md).toContain('- Charles to draft three options');
	});

	it('strips a leading markdown heading from summary text', () => {
		const summary = makeSummary({
			text: '# Strategic Realignment\n\nFirst normal paragraph.\n\nSecond paragraph.',
		});
		const md = formatMarkdown(makeRecording(), makeTranscript(), summary);
		expect(md).toContain('## Summary\n\nFirst normal paragraph.');
		expect(md).not.toContain('## Summary\n\n# Strategic Realignment');
	});

	it('converts dashed summary separators to thematic breaks without setext-heading side effects', () => {
		const summary = makeSummary({
			text: 'First paragraph.\n------------\n## Next section',
		});
		const md = formatMarkdown(makeRecording(), makeTranscript(), summary);
		expect(md).toContain('First paragraph.\n***\n## Next section');
		expect(md).not.toContain('First paragraph.\n------------');
	});

	it('handles an empty transcript segments array with a placeholder', () => {
		const t = makeTranscript({ segments: [] });
		const md = formatMarkdown(makeRecording(), t, makeSummary());
		expect(md).toContain('> _No transcript available._');
	});
});

// NoteWriter class ---------------------------------------------------------

type FakeVault = VaultLike & {
	files: Map<string, string>;
	folders: Set<string>;
	createdPaths: string[];
	overwrittenPaths: string[];
	createFolderCalls: string[];
};

function makeFakeVault(): FakeVault {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const createdPaths: string[] = [];
	const overwrittenPaths: string[] = [];
	const createFolderCalls: string[] = [];

	const vault: FakeVault = {
		files,
		folders,
		createdPaths,
		overwrittenPaths,
		createFolderCalls,
		getFileByPath(path: string): FileLike | null {
			return files.has(path) ? { path } : null;
		},
		getFolderByPath(path: string): FolderLike | null {
			return folders.has(path) ? { path } : null;
		},
		async createFolder(path: string): Promise<FolderLike> {
			createFolderCalls.push(path);
			folders.add(path);
			return { path };
		},
		async create(path: string, data: string): Promise<FileLike> {
			files.set(path, data);
			createdPaths.push(path);
			return { path };
		},
		async read(file: FileLike): Promise<string> {
			return files.get(file.path) ?? '';
		},
		async process(file: FileLike, fn: (data: string) => string): Promise<string> {
			const current = files.get(file.path) ?? '';
			const next = fn(current);
			files.set(file.path, next);
			overwrittenPaths.push(file.path);
			return next;
		},
	};
	return vault;
}

// renameRecordingNote ------------------------------------------------------

/**
 * Wrap a FakeVault with a RenameFileFn that moves entries (a markdown file in
 * `files`, or a folder in `folders`) and records each (old, new) call in order.
 * Mirrors `app.fileManager.renameFile` closely enough for the cascade tests:
 * the note and the assets-folder marker both move.
 */
function makeFakeRename(vault: FakeVault): {
	rename: (oldPath: string, newPath: string) => Promise<void>;
	calls: Array<[string, string]>;
} {
	const calls: Array<[string, string]> = [];
	const rename = async (oldPath: string, newPath: string): Promise<void> => {
		calls.push([oldPath, newPath]);
		if (vault.files.has(oldPath)) {
			const content = vault.files.get(oldPath) ?? '';
			vault.files.delete(oldPath);
			vault.files.set(newPath, content);
		}
		if (vault.folders.has(oldPath)) {
			vault.folders.delete(oldPath);
			vault.folders.add(newPath);
		}
	};
	return { rename, calls };
}

describe('renameRecordingNote', () => {
	it('no-ops when the old and new paths are identical', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/note.md', '---\nplaud-id: abc123\n---\n');
		const { rename, calls } = makeFakeRename(vault);

		const result = await renameRecordingNote(
			vault,
			rename,
			'Plaud/note.md',
			'Plaud/note.md',
		);

		expect(result).toEqual({ notePath: 'Plaud/note.md', assetsFolderRenamed: false });
		expect(calls).toEqual([]);
	});

	it('renames the assets folder first, then the note', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		vault.folders.add('Plaud/old-assets');
		const { rename, calls } = makeFakeRename(vault);

		const result = await renameRecordingNote(
			vault,
			rename,
			'Plaud/old.md',
			'Plaud/new.md',
		);

		// Folder before note so the note's embeds repoint before it moves.
		expect(calls).toEqual([
			['Plaud/old-assets', 'Plaud/new-assets'],
			['Plaud/old.md', 'Plaud/new.md'],
		]);
		expect(result.assetsFolderRenamed).toBe(true);
		expect(vault.files.has('Plaud/new.md')).toBe(true);
		expect(vault.folders.has('Plaud/new-assets')).toBe(true);
	});

	it('renames only the note when no assets folder exists', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		const { rename, calls } = makeFakeRename(vault);

		const result = await renameRecordingNote(
			vault,
			rename,
			'Plaud/old.md',
			'Plaud/new.md',
		);

		expect(calls).toEqual([['Plaud/old.md', 'Plaud/new.md']]);
		expect(result.assetsFolderRenamed).toBe(false);
	});

	it('cascades only the assets folder when the note has already moved (listener case)', async () => {
		const vault = makeFakeVault();
		// Obsidian already renamed the note to the new path; the old path is empty.
		vault.files.set('Plaud/new.md', '---\nplaud-id: abc123\n---\n');
		vault.folders.add('Plaud/old-assets');
		const { rename, calls } = makeFakeRename(vault);

		const result = await renameRecordingNote(
			vault,
			rename,
			'Plaud/old.md',
			'Plaud/new.md',
		);

		// Only the folder moves; the note step is skipped.
		expect(calls).toEqual([['Plaud/old-assets', 'Plaud/new-assets']]);
		expect(result.assetsFolderRenamed).toBe(true);
	});

	it('throws before moving anything when a different recording owns the target', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		vault.files.set('Plaud/new.md', '---\nplaud-id: zzz999\n---\n');
		vault.folders.add('Plaud/old-assets');
		const { rename, calls } = makeFakeRename(vault);

		await expect(
			renameRecordingNote(vault, rename, 'Plaud/old.md', 'Plaud/new.md'),
		).rejects.toThrow(/belongs to recording zzz999/);
		// Nothing moved.
		expect(calls).toEqual([]);
		expect(vault.folders.has('Plaud/old-assets')).toBe(true);
	});

	it('rolls back the assets-folder rename when the note rename fails', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		vault.folders.add('Plaud/old-assets');
		const calls: Array<[string, string]> = [];
		const rename = async (oldPath: string, newPath: string): Promise<void> => {
			calls.push([oldPath, newPath]);
			if (oldPath.endsWith('.md')) {
				throw new Error('note rename boom');
			}
			if (vault.folders.has(oldPath)) {
				vault.folders.delete(oldPath);
				vault.folders.add(newPath);
			}
		};

		await expect(
			renameRecordingNote(vault, rename, 'Plaud/old.md', 'Plaud/new.md'),
		).rejects.toThrow('note rename boom');

		// Folder moved, note rename threw, folder rolled back to the old name.
		expect(calls).toEqual([
			['Plaud/old-assets', 'Plaud/new-assets'],
			['Plaud/old.md', 'Plaud/new.md'],
			['Plaud/new-assets', 'Plaud/old-assets'],
		]);
		expect(vault.folders.has('Plaud/old-assets')).toBe(true);
		expect(vault.folders.has('Plaud/new-assets')).toBe(false);
	});

	it('throws when the destination assets folder is already occupied', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		vault.folders.add('Plaud/old-assets');
		vault.folders.add('Plaud/new-assets');
		const { rename, calls } = makeFakeRename(vault);

		await expect(
			renameRecordingNote(vault, rename, 'Plaud/old.md', 'Plaud/new.md'),
		).rejects.toThrow(/attachments folder/);
		expect(calls).toEqual([]);
	});

	it('throws when a FILE (not a folder) occupies the destination assets path', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/old.md', '---\nplaud-id: abc123\n---\n');
		vault.folders.add('Plaud/old-assets');
		// A stray file sitting exactly where the assets folder would move.
		vault.files.set('Plaud/new-assets', 'not a folder');
		const { rename, calls } = makeFakeRename(vault);

		await expect(
			renameRecordingNote(vault, rename, 'Plaud/old.md', 'Plaud/new.md'),
		).rejects.toThrow(/already exists there/);
		expect(calls).toEqual([]);
	});
});

describe('NoteWriter', () => {
	it('creates the output folder if it does not exist', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(vault.folders.has('Plaud')).toBe(true);
	});

	it('does not recreate the output folder if it already exists', async () => {
		const vault = makeFakeVault();
		vault.folders.add('Plaud');
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		// Folder is only in the set once (no double-creation).
		expect(vault.folders.size).toBe(1);
	});

	it('writes to <outputFolder>/<sanitized-title>.md', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(
			makeRecording({ title: 'Meeting / notes : draft' }),
			makeTranscript(),
			makeSummary(),
		);

		expect(outcome.status).toBe('created');
		expect(outcome.path).toBe('Plaud/2026-04-14 Meeting - notes - draft.md');
		expect(vault.files.has('Plaud/2026-04-14 Meeting - notes - draft.md')).toBe(true);
	});

	it('puts the recording date in the filename so files sort chronologically', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(
			makeRecording({ title: '04-13 Client kickoff' }),
			makeTranscript(),
			makeSummary(),
		);

		// createdAt is 2026-04-14, which replaces the title's 04-13.
		expect(outcome.path).toBe('Plaud/2026-04-14 Client kickoff.md');
	});

	it('keeps the filename and H1 in sync when the date is applied', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(
			makeRecording({ title: '04-13 Securing a data sandbox' }),
			makeTranscript(),
			makeSummary(),
		);

		const body = vault.files.get('Plaud/2026-04-14 Securing a data sandbox.md') ?? '';
		expect(body).toContain('# 2026-04-14 Securing a data sandbox');
	});

	it('renames the note (filename and H1) with a US-order note-name template', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: 'Plaud',
			onDuplicate: 'skip',
			noteNameTemplate: '{{MM}}-{{DD}}-{{YYYY}} {{title}}',
		});

		const outcome = await writer.writeNote(
			makeRecording({ title: '04-13 Client kickoff' }),
			makeTranscript(),
			makeSummary(),
		);

		// The title's 04-13 is stripped; the recording date (04-14) fills the
		// template. Filename and H1 stay identical.
		expect(outcome.path).toBe('Plaud/04-14-2026 Client kickoff.md');
		const body = vault.files.get('Plaud/04-14-2026 Client kickoff.md') ?? '';
		expect(body).toContain('# 04-14-2026 Client kickoff');
	});

	it('places the date at the end when the note-name template does', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: 'Plaud',
			onDuplicate: 'skip',
			noteNameTemplate: '{{title}} {{MMM}} {{D}}, {{YYYY}}',
		});

		const outcome = await writer.writeNote(
			makeRecording({ title: 'Quarterly review' }),
			makeTranscript(),
			makeSummary(),
		);

		// Date-at-end plus a named month with a comma (filesystem-safe).
		expect(outcome.path).toBe('Plaud/Quarterly review Apr 14, 2026.md');
		const body = vault.files.get('Plaud/Quarterly review Apr 14, 2026.md') ?? '';
		expect(body).toContain('# Quarterly review Apr 14, 2026');
	});

	it('ignores a per-call template override so the filename and H1 stay in sync', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: 'Plaud',
			onDuplicate: 'skip',
			noteNameTemplate: '{{YYYY}}-{{MM}}-{{DD}} {{title}}',
		});

		// A caller passes a DIFFERENT template in the per-call formatOptions; the
		// writer's template must still drive both the filename and the H1 so the
		// two never diverge.
		const outcome = await writer.writeNote(
			makeRecording({ title: 'Quarterly review' }),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ noteNameTemplate: '{{MM}}-{{DD}}-{{YYYY}} {{title}}' },
		);

		expect(outcome.path).toBe('Plaud/2026-04-14 Quarterly review.md');
		const body = vault.files.get('Plaud/2026-04-14 Quarterly review.md') ?? '';
		expect(body).toContain('# 2026-04-14 Quarterly review');
	});

	it('writes at vault root when outputFolder is empty', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: '', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.path).toBe('2026-04-14 Morning standup.md');
		expect(vault.folders.size).toBe(0); // no folder created
	});

	it('normalizes a folder path with leading/trailing slashes', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: '/Plaud/', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.path).toBe('Plaud/2026-04-14 Morning standup.md');
	});

	it('normalizes Windows-style backslash folder paths', async () => {
		// Regression for #7: a "\Inbox" output folder kept its backslash, so the
		// path never matched what Obsidian's createFolder normalized it to.
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: '\\Inbox', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.path).toBe('Inbox/2026-04-14 Morning standup.md');
		expect(vault.createFolderCalls).toEqual(['Inbox']);
	});

	it('does not fail subsequent imports when the output folder already exists', async () => {
		// Regression for #7: the second import must not throw "Folder already
		// exists". Simulate Obsidian's real behaviour, where createFolder rejects
		// an existing path while getFolderByPath disagrees about that path.
		const vault = makeFakeVault();
		vault.getFolderByPath = () => null;
		vault.createFolder = async (path: string) => {
			vault.createFolderCalls.push(path);
			throw new Error(`Folder already exists.`);
		};
		const writer = new NoteWriter(vault, { outputFolder: 'Inbox', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('created');
		expect(outcome.path).toBe('Inbox/2026-04-14 Morning standup.md');
	});

	it('throws at construction when outputFolder contains path-traversal segments', () => {
		const vault = makeFakeVault();
		// ".." inside a compound path is still a traversal attempt — reject
		// at construction time rather than silently stripping it.
		expect(
			() =>
				new NoteWriter(vault, {
					outputFolder: 'Plaud/../escape',
					onDuplicate: 'skip',
				}),
		).toThrow(/escape the vault/);
	});

	it('skips writing when file exists and onDuplicate is skip', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/2026-04-14 Morning standup.md', 'existing content');
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('skipped');
		expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toBe('existing content');
		expect(vault.createdPaths).toEqual([]);
		expect(vault.overwrittenPaths).toEqual([]);
	});

	it('overwrites via process() when file exists and onDuplicate is overwrite', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/2026-04-14 Morning standup.md', 'existing content');
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'overwrite' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('overwritten');
		expect(vault.overwrittenPaths).toContain('Plaud/2026-04-14 Morning standup.md');
		expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toContain('# 2026-04-14 Morning standup');
		expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).not.toBe('existing content');
	});

	describe('prompt policy', () => {
		it('invokes the callback with the target context when a same-id duplicate exists', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/2026-04-14 Morning standup.md', '---\nplaud-id: abc123\n---\n');
			const received: Array<{
				recordingId: string;
				recordingTitle: string;
				targetPath: string;
			}> = [];
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'prompt',
				promptOnDuplicate: async (ctx) => {
					received.push({
						recordingId: ctx.recordingId,
						recordingTitle: ctx.recordingTitle,
						targetPath: ctx.targetPath,
					});
					return 'overwrite';
				},
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('overwritten');
			expect(received).toEqual([
				{
					recordingId: 'abc123',
					recordingTitle: 'Morning standup',
					targetPath: 'Plaud/2026-04-14 Morning standup.md',
				},
			]);
		});

		it('skips the write when the callback returns skip', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/2026-04-14 Morning standup.md', '---\nplaud-id: abc123\n---\noriginal');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'prompt',
				promptOnDuplicate: async () => 'skip',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('skipped');
			expect(vault.overwrittenPaths).toEqual([]);
			expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toBe(
				'---\nplaud-id: abc123\n---\noriginal',
			);
		});

		it('throws NoteWriterCancelledError when the callback returns cancel', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/2026-04-14 Morning standup.md', '---\nplaud-id: abc123\n---\n');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'prompt',
				promptOnDuplicate: async () => 'cancel',
			});

			await expect(
				writer.writeNote(makeRecording(), makeTranscript(), makeSummary()),
			).rejects.toThrow(NoteWriterCancelledError);
			expect(vault.overwrittenPaths).toEqual([]);
		});

		it('does not invoke the callback when the file does not exist yet', async () => {
			const vault = makeFakeVault();
			const promptSpy = jest.fn(async () => 'overwrite' as const);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'prompt',
				promptOnDuplicate: promptSpy,
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('created');
			expect(promptSpy).not.toHaveBeenCalled();
		});
	});

	it('returns the created status when the file is new', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('created');
		expect(vault.createdPaths).toEqual(['Plaud/2026-04-14 Morning standup.md']);
	});

	describe('subfolder template', () => {
		it('omitted template keeps the flat output-folder path', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(vault.createdPaths).toEqual(['Plaud/2026-04-14 Morning standup.md']);
		});

		it('resolves {{YYYY-MM}} from the recording date and nests the note under it', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				subfolderTemplate: '{{YYYY-MM}}',
				onDuplicate: 'skip',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			// makeRecording().createdAt is 2026-04-14 local.
			expect(outcome.path).toBe('Plaud/2026-04/2026-04-14 Morning standup.md');
			expect(vault.createdPaths).toEqual(['Plaud/2026-04/2026-04-14 Morning standup.md']);
			expect(vault.folders.has('Plaud/2026-04')).toBe(true);
		});

		it('applies the subfolder to an empty output folder', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, {
				outputFolder: '',
				subfolderTemplate: '{{YYYY}}/{{MM}}',
				onDuplicate: 'skip',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.path).toBe('2026/04/2026-04-14 Morning standup.md');
		});
	});

	describe('cross-folder dedup via existingPathForPlaudId', () => {
		const PRIOR = 'Plaud/2026-04-14 Morning standup.md';
		const priorContent = '---\nplaud-id: abc123\n---\n# 2026-04-14 Morning standup\n';

		function vaultWithPriorNote(): FakeVault {
			const vault = makeFakeVault();
			vault.files.set(PRIOR, priorContent);
			vault.folders.add('Plaud');
			return vault;
		}

		it('skips instead of writing a second copy when the recording exists in another subfolder', async () => {
			const vault = vaultWithPriorNote();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				subfolderTemplate: '{{YYYY-MM}}',
				onDuplicate: 'skip',
				existingPathForPlaudId: (id) => (id === 'abc123' ? PRIOR : null),
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('skipped');
			expect(outcome.path).toBe(PRIOR);
			expect(vault.createdPaths).toEqual([]);
			expect(vault.files.has('Plaud/2026-04/2026-04-14 Morning standup.md')).toBe(false);
		});

		it('overwrites the existing note in place rather than creating a duplicate', async () => {
			const vault = vaultWithPriorNote();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				subfolderTemplate: '{{YYYY-MM}}',
				onDuplicate: 'overwrite',
				existingPathForPlaudId: (id) => (id === 'abc123' ? PRIOR : null),
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('overwritten');
			expect(outcome.path).toBe(PRIOR);
			expect(vault.overwrittenPaths).toEqual([PRIOR]);
			expect(vault.createdPaths).toEqual([]);
		});

		it('creates a new note at the resolved subfolder when the lookup finds nothing', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				subfolderTemplate: '{{YYYY-MM}}',
				onDuplicate: 'skip',
				existingPathForPlaudId: () => null,
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('created');
			expect(vault.createdPaths).toEqual(['Plaud/2026-04/2026-04-14 Morning standup.md']);
		});

		it('falls through to create when the lookup returns a stale path with no file', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				subfolderTemplate: '{{YYYY-MM}}',
				onDuplicate: 'skip',
				existingPathForPlaudId: () => 'Plaud/ghost.md',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('created');
			expect(vault.createdPaths).toEqual(['Plaud/2026-04/2026-04-14 Morning standup.md']);
		});
	});

	describe('auto-migration via migrateExistingNote (Issue A)', () => {
		const OLD = 'Plaud/2026-04-14 Old title.md';
		const NEW = 'Plaud/2026-04-14 New title.md';
		const content = '---\nplaud-id: abc123\n---\n# 2026-04-14 Old title\n';

		function migratingWriterVault(): {
			vault: FakeVault;
			migrateCalls: Array<[string, string]>;
			writer: NoteWriter;
		} {
			const vault = makeFakeVault();
			vault.files.set(OLD, content);
			vault.folders.add('Plaud');
			const migrateCalls: Array<[string, string]> = [];
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
				existingPathForPlaudId: (id) => (id === 'abc123' ? OLD : null),
				migrateExistingNote: async (oldPath, newPath) => {
					migrateCalls.push([oldPath, newPath]);
					const c = vault.files.get(oldPath) ?? '';
					vault.files.delete(oldPath);
					vault.files.set(newPath, c);
				},
			});
			return { vault, migrateCalls, writer };
		}

		it('renames the note to its recomputed target, then overwrites at the new path', async () => {
			const { vault, migrateCalls, writer } = migratingWriterVault();

			const outcome = await writer.writeNote(
				makeRecording({ title: 'New title' }),
				makeTranscript(),
				makeSummary(),
			);

			expect(migrateCalls).toEqual([[OLD, NEW]]);
			expect(outcome.status).toBe('overwritten');
			expect(outcome.path).toBe(NEW);
			expect(vault.files.has(NEW)).toBe(true);
			expect(vault.files.has(OLD)).toBe(false);
			expect(vault.overwrittenPaths).toEqual([NEW]);
		});

		it('does not migrate when the target equals the existing path', async () => {
			const vault = makeFakeVault();
			vault.files.set(NEW, content);
			vault.folders.add('Plaud');
			const migrateCalls: Array<[string, string]> = [];
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
				migrateExistingNote: async (oldPath, newPath) => {
					migrateCalls.push([oldPath, newPath]);
				},
			});

			const outcome = await writer.writeNote(
				makeRecording({ title: 'New title' }),
				makeTranscript(),
				makeSummary(),
			);

			expect(migrateCalls).toEqual([]);
			expect(outcome.status).toBe('overwritten');
			expect(outcome.path).toBe(NEW);
		});

		it('throws instead of overwriting a stale path when the migration did not land the note', async () => {
			const vault = makeFakeVault();
			vault.files.set(OLD, content);
			vault.folders.add('Plaud');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
				existingPathForPlaudId: (id) => (id === 'abc123' ? OLD : null),
				// Buggy injector: resolves without actually moving the note, so
				// nothing lands at the target path.
				migrateExistingNote: async () => {},
			});

			await expect(
				writer.writeNote(
					makeRecording({ title: 'New title' }),
					makeTranscript(),
					makeSummary(),
				),
			).rejects.toThrow(/did not land the note at its target/);
			// The stale note is left untouched, not overwritten.
			expect(vault.overwrittenPaths).toEqual([]);
		});

		it('wraps a non-NoteWriterError thrown by the migration as a NoteWriterError', async () => {
			const vault = makeFakeVault();
			vault.files.set(OLD, content);
			vault.folders.add('Plaud');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
				existingPathForPlaudId: (id) => (id === 'abc123' ? OLD : null),
				migrateExistingNote: async () => {
					throw new Error('renameFile failed');
				},
			});

			const err = await writer
				.writeNote(makeRecording({ title: 'New title' }), makeTranscript(), makeSummary())
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(NoteWriterError);
			expect((err as NoteWriterError).message).toMatch(
				/Failed to migrate .* renameFile failed/,
			);
			expect(vault.overwrittenPaths).toEqual([]);
		});

		it('does not migrate on a skip decision', async () => {
			const vault = makeFakeVault();
			vault.files.set(OLD, content);
			vault.folders.add('Plaud');
			const migrateCalls: Array<[string, string]> = [];
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'skip',
				existingPathForPlaudId: (id) => (id === 'abc123' ? OLD : null),
				migrateExistingNote: async (oldPath, newPath) => {
					migrateCalls.push([oldPath, newPath]);
				},
			});

			const outcome = await writer.writeNote(
				makeRecording({ title: 'New title' }),
				makeTranscript(),
				makeSummary(),
			);

			expect(outcome.status).toBe('skipped');
			expect(outcome.path).toBe(OLD);
			expect(migrateCalls).toEqual([]);
		});
	});

	it('writes the full markdown body including frontmatter, title, summary, and callout', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		const body = vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? '';
		expect(body).toContain('plaud-id: abc123');
		expect(body).toContain('# 2026-04-14 Morning standup');
		expect(body).toContain('## Summary');
		expect(body).toContain('> [!note]- Transcript');
		expect(body).toContain('> **[00:00]** Charles: Thanks for making time.');
	});

	describe('nested output folders', () => {
		it('creates each missing ancestor folder in turn', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud/Archive/2026',
				onDuplicate: 'skip',
			});

			await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(vault.folders.has('Plaud')).toBe(true);
			expect(vault.folders.has('Plaud/Archive')).toBe(true);
			expect(vault.folders.has('Plaud/Archive/2026')).toBe(true);
			expect(vault.createFolderCalls).toEqual([
				'Plaud',
				'Plaud/Archive',
				'Plaud/Archive/2026',
			]);
		});

		it('skips ancestors that already exist', async () => {
			const vault = makeFakeVault();
			vault.folders.add('Plaud');
			vault.folders.add('Plaud/Archive');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud/Archive/2026',
				onDuplicate: 'skip',
			});

			await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			// Only the missing leaf gets created.
			expect(vault.createFolderCalls).toEqual(['Plaud/Archive/2026']);
		});
	});

	describe('collision detection via plaud-id frontmatter', () => {
		it('throws NoteWriterError when existing note has a DIFFERENT plaud-id', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/2026-04-14 Morning standup.md',
				'---\nplaud-id: DIFFERENT_RECORDING\ndate: 2026-04-01\nduration-seconds: 100\nsource: plaud\n---\n\n# Old recording\n',
			);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
			});

			await expect(
				writer.writeNote(makeRecording(), makeTranscript(), makeSummary()),
			).rejects.toBeInstanceOf(NoteWriterError);
		});

		it('includes both plaud-ids in the collision error message', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/2026-04-14 Morning standup.md',
				'---\nplaud-id: OLD_ID_42\n---\n\n# Old\n',
			);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'skip',
			});

			await expect(
				writer.writeNote(makeRecording({ id: 'NEW_ID_99' as never }), makeTranscript(), makeSummary()),
			).rejects.toThrow(/OLD_ID_42.*NEW_ID_99/);
		});

		it('allows overwrite when existing note has the SAME plaud-id (re-import)', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/2026-04-14 Morning standup.md',
				'---\nplaud-id: abc123\n---\n\n# Old version\n',
			);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('overwritten');
			expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toContain('# 2026-04-14 Morning standup');
		});

		it('allows skip when existing note has the SAME plaud-id (idempotent re-import)', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/2026-04-14 Morning standup.md',
				'---\nplaud-id: abc123\n---\n\n# Old\n',
			);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'skip',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('skipped');
		});

		it('allows overwrite when existing note has no parseable plaud-id (legacy file)', async () => {
			// A pre-existing hand-written note has no frontmatter at all.
			// Collision detection returns null, so we fall through to the
			// duplicate policy — which is the pragmatic default.
			const vault = makeFakeVault();
			vault.files.set('Plaud/2026-04-14 Morning standup.md', 'Just some text, no frontmatter.');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('overwritten');
		});
	});

	describe('advertised-but-null guard', () => {
		it('throws when transcriptAvailable is true but transcript is null', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			await expect(
				writer.writeNote(
					makeRecording({ transcriptAvailable: true }),
					null,
					makeSummary(),
				),
			).rejects.toBeInstanceOf(NoteWriterError);
		});

		it('writes a partial note with a placeholder when summary is advertised but null and a transcript exists', async () => {
			// Older recordings: Plaud advertises a summary (is_summary) but it
			// is unretrievable. As long as a transcript exists, write the note
			// with a "_No summary available._" placeholder rather than failing.
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			const outcome = await writer.writeNote(
				makeRecording({ summaryAvailable: true, transcriptAvailable: true }),
				makeTranscript(),
				null,
			);

			expect(outcome.status).toBe('created');
			const body = vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? '';
			expect(body).toContain('## Summary');
			expect(body).toContain('_No summary available._');
		});

		it('throws when an advertised summary is null and no transcript is available either', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			await expect(
				writer.writeNote(
					makeRecording({ summaryAvailable: true, transcriptAvailable: false }),
					null,
					null,
				),
			).rejects.toBeInstanceOf(NoteWriterError);
		});

		it('accepts null transcript when transcriptAvailable is false', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			const outcome = await writer.writeNote(
				makeRecording({ transcriptAvailable: false, summaryAvailable: false }),
				null,
				null,
			);

			expect(outcome.status).toBe('created');
			const body = vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? '';
			expect(body).toContain('_No transcript available._');
			expect(body).toContain('_No summary available._');
		});
	});

	describe('construction-time validation', () => {
		it('throws NoteWriterError on an invalid onDuplicate value', () => {
			const vault = makeFakeVault();
			expect(
				() =>
					new NoteWriter(vault, {
						outputFolder: 'Plaud',
						onDuplicate: 'wipe-the-vault' as never,
					}),
			).toThrow(NoteWriterError);
		});

		it('throws NoteWriterError at construction time on outputFolder traversal', () => {
			const vault = makeFakeVault();
			expect(
				() =>
					new NoteWriter(vault, {
						outputFolder: '../escape-the-vault',
						onDuplicate: 'skip',
					}),
			).toThrow(/escape the vault/);
		});
	});

	describe('error context wrapping', () => {
		it('wraps vault.create errors with recording id and target path', async () => {
			const vault = makeFakeVault();
			vault.create = async () => {
				throw new Error('EACCES permission denied');
			};
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			// Error message format: "Failed to create <path> for recording <id>: <cause>"
			await expect(
				writer.writeNote(makeRecording(), makeTranscript(), makeSummary()),
			).rejects.toThrow(/Plaud\/2026-04-14 Morning standup\.md.*abc123.*EACCES/);
		});

		it('wraps vault.process errors with recording id and target path', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/2026-04-14 Morning standup.md',
				'---\nplaud-id: abc123\n---\n',
			);
			vault.process = async () => {
				throw new Error('disk full');
			};
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'overwrite' });

			await expect(
				writer.writeNote(makeRecording(), makeTranscript(), makeSummary()),
			).rejects.toThrow(/abc123.*disk full/);
		});

		it('wraps vault.read errors during collision check', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/2026-04-14 Morning standup.md', 'existing');
			vault.read = async () => {
				throw new Error('read blew up');
			};
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			await expect(
				writer.writeNote(makeRecording(), makeTranscript(), makeSummary()),
			).rejects.toThrow(/collisions.*read blew up/);
		});
	});
});

// YAML hardening tests -----------------------------------------------------

describe('formatFrontmatter YAML hardening', () => {
	it('quotes reserved YAML boolean/null words in plaud-id', () => {
		// Plaud IDs are typically hex, but defend against the pathological
		// case where an ID coincidentally matches a YAML reserved word.
		const fm = formatFrontmatter(makeRecording({ id: 'null' as never }), []);
		expect(fm).toContain('plaud-id: "null"');
	});

	it.each([
		'true', 'True', 'TRUE',
		'false', 'False', 'FALSE',
		'yes', 'Yes', 'YES',
		'no', 'No', 'NO',
		'on', 'On', 'ON',
		'off', 'Off', 'OFF',
		'null', 'Null', 'NULL',
		'~',
	])('quotes reserved YAML token %s when it appears in speakers', (token) => {
		const fm = formatFrontmatter(makeRecording(), [token]);
		expect(fm).toMatch(new RegExp(`speakers: \\["${token}"\\]`));
	});

	it('quotes numeric-looking plaud-ids (prevents parse as number)', () => {
		const fm = formatFrontmatter(makeRecording({ id: '12345' as never }), []);
		expect(fm).toContain('plaud-id: "12345"');
	});

	it('quotes date-looking plaud-ids', () => {
		const fm = formatFrontmatter(makeRecording({ id: '2026-04-14' as never }), []);
		expect(fm).toContain('plaud-id: "2026-04-14"');
	});

	it('escapes newlines inside quoted values', () => {
		const fm = formatFrontmatter(makeRecording(), ['multi\nline name']);
		expect(fm).toContain('"multi\\nline name"');
		// Must not contain a raw newline inside the quoted value.
		expect(fm).not.toMatch(/"multi\n/);
	});

	it('escapes tabs and carriage returns inside quoted values', () => {
		const fm = formatFrontmatter(makeRecording(), ['tabs\there', 'cr\rhere']);
		expect(fm).toContain('\\t');
		expect(fm).toContain('\\r');
	});

	it('escapes backslashes before double quotes', () => {
		const fm = formatFrontmatter(makeRecording(), ['path\\with\\slash']);
		expect(fm).toContain('"path\\\\with\\\\slash"');
	});

	it('does not quote a normal letter-initial alphanumeric value', () => {
		const fm = formatFrontmatter(makeRecording({ id: 'abc123' as never }), ['Charles']);
		expect(fm).toContain('plaud-id: abc123');
		expect(fm).toContain('speakers: [Charles]');
	});

	it('quotes values that start with a digit (could parse as number)', () => {
		const fm = formatFrontmatter(makeRecording(), ['42Answer']);
		expect(fm).toContain('"42Answer"');
	});

	it('emits duration-seconds: 0 when durationSeconds is NaN', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: Number.NaN }),
			[],
		);
		expect(fm).toContain('duration-seconds: 0');
		expect(fm).not.toContain('NaN');
	});

	it('emits duration-seconds: 0 when durationSeconds is Infinity', () => {
		const fm = formatFrontmatter(
			makeRecording({ durationSeconds: Number.POSITIVE_INFINITY }),
			[],
		);
		expect(fm).toContain('duration-seconds: 0');
		expect(fm).not.toContain('Infinity');
	});
});

// extractPlaudIdFromFrontmatter --------------------------------------------

describe('extractPlaudIdFromFrontmatter', () => {
	it('extracts an unquoted plaud-id', () => {
		const content = '---\nplaud-id: abc123\ndate: 2026-04-14\n---\n\n# foo';
		expect(extractPlaudIdFromFrontmatter(content)).toBe('abc123');
	});

	it('extracts a double-quoted plaud-id and unescapes it', () => {
		const content = '---\nplaud-id: "abc\\"123"\n---\n\n';
		expect(extractPlaudIdFromFrontmatter(content)).toBe('abc"123');
	});

	it('extracts a single-quoted plaud-id', () => {
		const content = "---\nplaud-id: 'abc123'\n---\n\n";
		expect(extractPlaudIdFromFrontmatter(content)).toBe('abc123');
	});

	it('returns null when there is no frontmatter', () => {
		expect(extractPlaudIdFromFrontmatter('# just a title\n\nbody')).toBeNull();
	});

	it('returns null when frontmatter has no plaud-id key', () => {
		const content = '---\ndate: 2026-04-14\n---\n\nbody';
		expect(extractPlaudIdFromFrontmatter(content)).toBeNull();
	});

	it('returns null when plaud-id is empty after quote stripping', () => {
		const content = '---\nplaud-id: ""\n---\n\n';
		expect(extractPlaudIdFromFrontmatter(content)).toBeNull();
	});

	it('handles CRLF line endings', () => {
		const content = '---\r\nplaud-id: abc123\r\n---\r\n\r\nbody';
		expect(extractPlaudIdFromFrontmatter(content)).toBe('abc123');
	});

	it('round-trips a quoted id from formatFrontmatter', () => {
		// The frontmatter writer quotes reserved words and numeric IDs;
		// the extractor must round-trip them.
		const fm = formatFrontmatter(makeRecording({ id: 'null' as never }), []);
		expect(extractPlaudIdFromFrontmatter(fm)).toBe('null');
	});
});

// ---------------------------------------------------------------------------
// mergeTagSources — DD-004 (2026-04-14): AI keyword merging rules
// ---------------------------------------------------------------------------

describe('mergeTagSources', () => {
	it('returns an empty list when both inputs are empty or undefined', () => {
		expect(mergeTagSources(undefined, undefined)).toEqual([]);
		expect(mergeTagSources([], [])).toEqual([]);
		expect(mergeTagSources(undefined, [])).toEqual([]);
	});

	it('lowercases base tags and preserves their insertion order', () => {
		expect(mergeTagSources(['Work', 'Meeting', 'Planning'], undefined)).toEqual([
			'work',
			'meeting',
			'planning',
		]);
	});

	it('slugifies AI keywords with plaud/ prefix, lowercase, and dashes', () => {
		expect(
			mergeTagSources(undefined, [
				'AI Agent',
				'Customer Data',
				'AWS Environment',
			]),
		).toEqual(['plaud/ai-agent', 'plaud/customer-data', 'plaud/aws-environment']);
	});

	it('collapses multiple whitespace runs into a single dash', () => {
		expect(mergeTagSources(undefined, ['Hello    World'])).toEqual([
			'plaud/hello-world',
		]);
	});

	it('strips leading and trailing whitespace (and the dashes they would produce)', () => {
		expect(mergeTagSources(undefined, ['  Leading', 'Trailing  '])).toEqual([
			'plaud/leading',
			'plaud/trailing',
		]);
	});

	it('drops empty and whitespace-only entries on both sides', () => {
		expect(mergeTagSources(['', '   ', 'Keep'], ['', '   ', 'Keep Me'])).toEqual([
			'keep',
			'plaud/keep-me',
		]);
	});

	it('deduplicates base tags case-insensitively, first occurrence wins', () => {
		expect(mergeTagSources(['Work', 'work', 'WORK'], undefined)).toEqual([
			'work',
		]);
	});

	it('deduplicates AI keywords case-insensitively after slugification', () => {
		expect(
			mergeTagSources(undefined, ['AI Agent', 'ai agent', 'AI AGENT']),
		).toEqual(['plaud/ai-agent']);
	});

	it('appends AI tags after base tags regardless of input order', () => {
		const result = mergeTagSources(['manual'], ['AI Topic']);
		expect(result).toEqual(['manual', 'plaud/ai-topic']);
	});

	it('does not collapse a base tag with a similarly-named AI tag, because the AI tag has the plaud/ prefix', () => {
		// A plain `ai-agent` base tag and the AI-derived `plaud/ai-agent`
		// are distinct strings — the namespace is the whole point of
		// prefixing. Both should survive the merge.
		const result = mergeTagSources(['ai-agent'], ['AI Agent']);
		expect(result).toEqual(['ai-agent', 'plaud/ai-agent']);
	});

	it('collapses two AI entries that slugify to the same form', () => {
		// "AI Agent" and "ai   agent" both slugify to plaud/ai-agent.
		const result = mergeTagSources(undefined, ['AI Agent', 'ai   agent']);
		expect(result).toEqual(['plaud/ai-agent']);
	});

	it('preserves a base tag whose lowercased form equals a would-be AI prefix match', () => {
		// If a curated tag happens to already be `plaud/ai-agent`, the AI
		// merge must dedup against it and not re-emit a duplicate.
		const result = mergeTagSources(['plaud/ai-agent'], ['AI Agent']);
		expect(result).toEqual(['plaud/ai-agent']);
	});

	it('silently skips non-string entries in either list', () => {
		// Defense in depth: caller should never pass us numbers, but if
		// Plaud's format drifts to include non-strings we should drop them
		// instead of crashing the note writer.
		const result = mergeTagSources(
			['real', 42 as unknown as string],
			['valid', null as unknown as string],
		);
		expect(result).toEqual(['real', 'plaud/valid']);
	});

	it('end-to-end: real-data-shape example from the 2026-04-14 capture', () => {
		// Base list is empty (filetag_id_list was empty in Charles's test
		// data) and the 9 AI keywords land as the only tags on the note.
		const result = mergeTagSources([], [
			'AI Agent',
			'Customer Data',
			'AWS Environment',
			'Semantic Search',
			'ImageRight',
			'Cloud Code',
			'Roper Architecture',
			'DevOps',
			'Workflow Modernization',
		]);
		expect(result).toEqual([
			'plaud/ai-agent',
			'plaud/customer-data',
			'plaud/aws-environment',
			'plaud/semantic-search',
			'plaud/imageright',
			'plaud/cloud-code',
			'plaud/roper-architecture',
			'plaud/devops',
			'plaud/workflow-modernization',
		]);
	});
});

// ---------------------------------------------------------------------------
// buildNoteTags — tag mode settings (2026-06-10): which sources land in
// tags:, custom tag parsing, and the keywords: property output
// ---------------------------------------------------------------------------

describe('buildNoteTags', () => {
	const BASE = ['Work', 'Meeting'];
	const AI = ['AI Agent', 'Customer Data'];

	function opts(overrides: Partial<TagBuildOptions> = {}): TagBuildOptions {
		return {
			tagMode: 'plaud',
			customTags: '',
			aiKeywordsAsProperty: true,
			...overrides,
		};
	}

	describe('tag modes', () => {
		it("mode 'none' emits no tags at all, even custom ones", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'none', customTags: 'pinned' }));
			expect(result.tags).toEqual([]);
		});

		it("mode 'custom' emits only the custom tags", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'custom', customTags: 'plaud-meeting' }));
			expect(result.tags).toEqual(['plaud-meeting']);
		});

		it("mode 'plaud' emits base tags plus custom tags, no AI keywords", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'plaud', customTags: 'plaud-meeting' }));
			expect(result.tags).toEqual(['work', 'meeting', 'plaud-meeting']);
		});

		it("mode 'all' emits base, custom, then slugified AI tags in that order", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'all', customTags: 'plaud-meeting' }));
			expect(result.tags).toEqual([
				'work',
				'meeting',
				'plaud-meeting',
				'plaud/ai-agent',
				'plaud/customer-data',
			]);
		});

		it("mode 'all' with empty custom tags matches the legacy mergeTagSources output", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'all' }));
			expect(result.tags).toEqual(mergeTagSources(BASE, AI));
		});
	});

	describe('custom tag parsing', () => {
		it('splits on commas, trims, lowercases, drops empties, and dedups', () => {
			const result = buildNoteTags(undefined, undefined, opts({
				tagMode: 'custom',
				customTags: 'a,, b ,A',
			}));
			expect(result.tags).toEqual(['a', 'b']);
		});

		it('an empty custom tags string contributes nothing', () => {
			const result = buildNoteTags(BASE, undefined, opts({ tagMode: 'plaud', customTags: '' }));
			expect(result.tags).toEqual(['work', 'meeting']);
		});

		it('custom tags dedup case-insensitively against base tags', () => {
			const result = buildNoteTags(['Work'], undefined, opts({
				tagMode: 'plaud',
				customTags: 'WORK, extra',
			}));
			expect(result.tags).toEqual(['work', 'extra']);
		});
	});

	describe('keywords property output', () => {
		it('returns trimmed original-cased keywords when the mode excludes AI and the toggle is on', () => {
			const result = buildNoteTags(BASE, ['  AI Agent ', 'Customer Data'], opts({ tagMode: 'plaud' }));
			expect(result.keywords).toEqual(['AI Agent', 'Customer Data']);
		});

		it('dedups keywords case-insensitively, first occurrence wins', () => {
			const result = buildNoteTags(undefined, ['AI Agent', 'ai agent'], opts({ tagMode: 'none' }));
			expect(result.keywords).toEqual(['AI Agent']);
		});

		it('drops empty and non-string keyword entries', () => {
			const result = buildNoteTags(undefined, ['', '   ', 42 as unknown as string, 'Real'], opts());
			expect(result.keywords).toEqual(['Real']);
		});

		it('is empty when the toggle is off', () => {
			const result = buildNoteTags(BASE, AI, opts({ aiKeywordsAsProperty: false }));
			expect(result.keywords).toEqual([]);
		});

		it("is empty in mode 'all' because the keywords already live in tags:", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'all' }));
			expect(result.keywords).toEqual([]);
		});

		it("is populated in mode 'none' — the mode governs tags:, the toggle governs the property", () => {
			const result = buildNoteTags(BASE, AI, opts({ tagMode: 'none' }));
			expect(result.tags).toEqual([]);
			expect(result.keywords).toEqual(['AI Agent', 'Customer Data']);
		});
	});

	it('end-to-end: the 2026-04-14 capture with the keywords property opted in', () => {
		// Same real-data shape as the mergeTagSources end-to-end case, in
		// tagMode 'plaud' with the property toggle explicitly on. The toggle
		// is OFF by default (see DEFAULT_SETTINGS); this exercises the opt-in
		// path where the 9 AI keywords move from tags: to keywords:.
		const result = buildNoteTags([], [
			'AI Agent',
			'Customer Data',
			'AWS Environment',
			'Semantic Search',
			'ImageRight',
			'Cloud Code',
			'Roper Architecture',
			'DevOps',
			'Workflow Modernization',
		], opts());
		expect(result.tags).toEqual([]);
		expect(result.keywords).toEqual([
			'AI Agent',
			'Customer Data',
			'AWS Environment',
			'Semantic Search',
			'ImageRight',
			'Cloud Code',
			'Roper Architecture',
			'DevOps',
			'Workflow Modernization',
		]);
	});
});

// ---------------------------------------------------------------------------
// groupTranscriptByChapters — DD-004 item 2 follow-up (2026-04-14)
// ---------------------------------------------------------------------------

describe('groupTranscriptByChapters', () => {
	function seg(startSeconds: number, text = 'text'): TranscriptSegment {
		return { startSeconds, endSeconds: startSeconds + 5, text, speaker: 'A' };
	}
	function tx(segments: readonly TranscriptSegment[]): Transcript {
		return { id: 'abc' as PlaudRecordingId, segments, rawText: '' };
	}

	it('returns [] when transcript is null', () => {
		expect(
			groupTranscriptByChapters(null, [{ title: 'A', startSeconds: 0 }]),
		).toEqual([]);
	});

	it('returns [] when transcript has no segments', () => {
		expect(
			groupTranscriptByChapters(tx([]), [{ title: 'A', startSeconds: 0 }]),
		).toEqual([]);
	});

	it('returns [] when chapters is undefined or empty', () => {
		expect(groupTranscriptByChapters(tx([seg(0)]), undefined)).toEqual([]);
		expect(groupTranscriptByChapters(tx([seg(0)]), [])).toEqual([]);
	});

	it('assigns segments to chapters by last startSeconds <= segment.startSeconds', () => {
		const segments = [seg(0, 'intro'), seg(30, 'intro-2'), seg(60, 'main'), seg(120, 'main-2'), seg(200, 'wrap')];
		const chapters: readonly Chapter[] = [
			{ title: 'Intro', startSeconds: 0 },
			{ title: 'Main', startSeconds: 60 },
			{ title: 'Wrap', startSeconds: 180 },
		];
		const groups = groupTranscriptByChapters(tx(segments), chapters);
		expect(groups).toHaveLength(3);
		expect(groups[0].segments.map((s) => s.text)).toEqual(['intro', 'intro-2']);
		expect(groups[1].segments.map((s) => s.text)).toEqual(['main', 'main-2']);
		expect(groups[2].segments.map((s) => s.text)).toEqual(['wrap']);
	});

	it('assigns segments that start before the first chapter to the first chapter', () => {
		const segments = [seg(0, 'early'), seg(10, 'also-early'), seg(60, 'main')];
		const chapters: readonly Chapter[] = [
			{ title: 'Main block', startSeconds: 30 },
		];
		const groups = groupTranscriptByChapters(tx(segments), chapters);
		expect(groups).toHaveLength(1);
		expect(groups[0].segments.map((s) => s.text)).toEqual(['early', 'also-early', 'main']);
	});

	it('gives non-empty groups a blockId of "t-ch-{idx}"', () => {
		const groups = groupTranscriptByChapters(
			tx([seg(0), seg(60)]),
			[
				{ title: 'Intro', startSeconds: 0 },
				{ title: 'Main', startSeconds: 60 },
			],
		);
		expect(groups[0].blockId).toBe('t-ch-0');
		expect(groups[1].blockId).toBe('t-ch-1');
	});

	it('gives empty groups a null blockId so the caller can skip linking', () => {
		// Two chapters but only one segment near the start — the second
		// chapter gets no segments and therefore no block id.
		const groups = groupTranscriptByChapters(
			tx([seg(0)]),
			[
				{ title: 'A', startSeconds: 0 },
				{ title: 'B', startSeconds: 300 },
			],
		);
		expect(groups[0].blockId).toBe('t-ch-0');
		expect(groups[1].blockId).toBeNull();
		expect(groups[1].segments).toEqual([]);
	});

	it('drops chapters with blank titles before bucketing', () => {
		const groups = groupTranscriptByChapters(
			tx([seg(0), seg(60)]),
			[
				{ title: '   ', startSeconds: 0 },
				{ title: 'Real', startSeconds: 30 },
			],
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].chapter.title).toBe('Real');
		// Both segments attach to the sole surviving chapter.
		expect(groups[0].segments).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// formatChapterIndexSection — linked chapters list
// ---------------------------------------------------------------------------

describe('formatChapterIndexSection', () => {
	function makeGroup(
		chapter: Chapter,
		blockId: string | null,
		segmentCount = 1,
	): TranscriptChapterGroup {
		const segments: TranscriptSegment[] = [];
		for (let i = 0; i < segmentCount; i++) {
			segments.push({
				startSeconds: chapter.startSeconds + i,
				endSeconds: chapter.startSeconds + i + 1,
				text: 'seg',
				speaker: 'A',
			});
		}
		return { chapter, blockId, segments };
	}

	it('returns empty string for empty groups', () => {
		expect(formatChapterIndexSection([])).toBe('');
	});

	it('renders each chapter row as a bullet wiki link and attaches the ^plaud-chapters block id', () => {
		const groups: readonly TranscriptChapterGroup[] = [
			makeGroup({ title: 'Introduction', startSeconds: 0 }, 't-ch-0'),
			makeGroup({ title: 'Main', startSeconds: 125 }, 't-ch-1'),
			makeGroup({ title: 'Conclusion', startSeconds: 600 }, 't-ch-2'),
		];
		expect(formatChapterIndexSection(groups)).toBe(
			[
				'##### Chapters',
				'',
				'- [[#00:00 Introduction|**[00:00]** Introduction]]',
				'- [[#02:05 Main|**[02:05]** Main]]',
				'- [[#10:00 Conclusion|**[10:00]** Conclusion]]',
				'',
				'^plaud-chapters',
			].join('\n'),
		);
	});

	it('falls back to plain text for groups with null blockId', () => {
		const groups: readonly TranscriptChapterGroup[] = [
			makeGroup({ title: 'Linked', startSeconds: 0 }, 't-ch-0'),
			makeGroup({ title: 'Empty', startSeconds: 300 }, null, 0),
		];
		const out = formatChapterIndexSection(groups);
		expect(out).toContain('- [[#00:00 Linked|**[00:00]** Linked]]');
		expect(out).toContain('- **[05:00]** Empty');
		expect(out).not.toContain('#null');
	});

	it('sanitizes wiki-link delimiter characters out of the anchor text', () => {
		const groups = [
			makeGroup({ title: 'Main | topic [x] #id', startSeconds: 0 }, 't-ch-0'),
		];
		const out = formatChapterIndexSection(groups);
		expect(out).toContain('- [[#00:00 Main - topic -x- -id|**[00:00]** Main | topic [x] #id]]');
	});

	it('uses h:MM:SS for chapters past the hour mark', () => {
		const groups = [makeGroup({ title: 'Late', startSeconds: 3700 }, 't-ch-0')];
		expect(formatChapterIndexSection(groups)).toContain('**[1:01:40]** Late');
	});
});

// ---------------------------------------------------------------------------
// formatTranscriptSection — grouped vs single-callout
// ---------------------------------------------------------------------------

describe('formatTranscriptSection', () => {
	it('falls back to the single flat transcript callout when groups is empty', () => {
		const transcript = makeTranscript();
		const out = formatTranscriptSection(transcript, [], 4);
		expect(out).toContain('> [!note]- Transcript');
		expect(out).toContain('> **[00:00]** Charles: Thanks for making time.');
		expect(out).not.toMatch(/> ### /);
	});

	it('renders a placeholder callout when transcript is null', () => {
		const out = formatTranscriptSection(null, [], 4);
		expect(out).toBe('> [!note]- Transcript\n> _No transcript available._');
	});

	it('emits #### Transcript and ##### MM:SS Title sub-headings when headerLevel is 4', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'hi', speaker: 'A' },
			{ startSeconds: 60, endSeconds: 65, text: 'mid', speaker: 'B' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Intro', startSeconds: 0 },
				segments: [segs[0]],
				blockId: 't-ch-0',
			},
			{
				chapter: { title: 'Middle', startSeconds: 60 },
				segments: [segs[1]],
				blockId: 't-ch-1',
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			4,
		);
		expect(out).toMatch(/^#### Transcript\n/);
		expect(out).toContain('##### Chapters');
		expect(out).toContain('##### 00:00 Intro');
		expect(out).toContain('##### 01:00 Middle');
		expect(out).toContain('[[#^plaud-chapters|Back to Chapters]]');
		expect(out).toMatch(/##### 00:00 Intro\n\n\[\[#\^plaud-chapters\|Back to Chapters\]\]\n\n\*\*\[00:00\]\*\* A: hi/);
		expect(out).toMatch(/##### 01:00 Middle\n\n\[\[#\^plaud-chapters\|Back to Chapters\]\]\n\n\*\*\[01:00\]\*\* B: mid/);
		expect(out).not.toContain('> [!note]- Transcript');
	});

	it('uses H2 wrapping + H3 sub-headings when headerLevel is 2', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'hi', speaker: 'A' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Intro', startSeconds: 0 },
				segments: [segs[0]],
				blockId: 't-ch-0',
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			2,
		);
		expect(out).toMatch(/^## Transcript\n/);
		expect(out).toContain('### 00:00 Intro');
	});

	it('clamps child heading level to H6 when wrap is already H6', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'hi', speaker: 'A' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Intro', startSeconds: 0 },
				segments: [segs[0]],
				blockId: 't-ch-0',
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			6,
		);
		expect(out).toMatch(/^###### Transcript\n/);
		expect(out).toContain('###### 00:00 Intro');
	});

	it('sanitizes wiki-link delimiter characters out of the chapter sub-heading', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'hi', speaker: 'A' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Main | topic [x] #id', startSeconds: 0 },
				segments: [segs[0]],
				blockId: 't-ch-0',
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			4,
		);
		expect(out).toContain('##### 00:00 Main - topic -x- -id');
	});

	it('skips groups that have no segments (no sub-heading emitted)', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'only', speaker: 'A' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Intro', startSeconds: 0 },
				segments: segs,
				blockId: 't-ch-0',
			},
			{
				chapter: { title: 'Empty', startSeconds: 300 },
				segments: [],
				blockId: null,
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			4,
		);
		expect(out).toContain('##### 00:00 Intro');
		expect(out).not.toContain('##### 05:00 Empty');
	});

	it('falls back to flat callout if every group is empty', () => {
		const segs: TranscriptSegment[] = [
			{ startSeconds: 0, endSeconds: 5, text: 'orphan', speaker: 'A' },
		];
		const groups: readonly TranscriptChapterGroup[] = [
			{
				chapter: { title: 'Unused', startSeconds: 500 },
				segments: [],
				blockId: null,
			},
		];
		const out = formatTranscriptSection(
			{ id: 'abc' as PlaudRecordingId, segments: segs, rawText: '' },
			groups,
			4,
		);
		expect(out).toContain('> [!note]- Transcript');
		expect(out).toContain('orphan');
		expect(out).not.toMatch(/### /);
	});
});

// ---------------------------------------------------------------------------
// substitutePlaudPlaceholders — fills in `$[audio_start_time]` etc.
// ---------------------------------------------------------------------------

describe('substitutePlaudPlaceholders', () => {
	const rec = makeRecording({
		title: 'Q2 Planning',
		// 2026-05-13 14:04:22 local — explicit local-time constructor so
		// the test isn't timezone-dependent.
		createdAt: new Date(2026, 4, 13, 14, 4, 22),
		durationSeconds: 600,
	});
	const transcript: Transcript = {
		id: rec.id,
		rawText: '',
		segments: [
			{ startSeconds: 0, endSeconds: 5, speaker: 'Charles', text: 'hi' },
			{ startSeconds: 5, endSeconds: 10, speaker: 'Mary', text: 'hello' },
		],
	};

	it('substitutes $[audio_start_time] with YYYY-MM-DD HH:MM:SS local time', () => {
		const out = substitutePlaudPlaceholders(
			'Date & Time:  $[audio_start_time]',
			rec,
			transcript,
		);
		expect(out).toBe('Date & Time:  2026-05-13 14:04:22');
	});

	it('substitutes $[audio_title] with the recording title', () => {
		const out = substitutePlaudPlaceholders('Title: $[audio_title]', rec, transcript);
		expect(out).toBe('Title: Q2 Planning');
	});

	it('substitutes $[audio_duration] with the human-readable duration', () => {
		const out = substitutePlaudPlaceholders(
			'Duration: $[audio_duration]',
			rec,
			transcript,
		);
		expect(out).toBe('Duration: 10m');
	});

	it('substitutes $[speakers] with a comma-separated speaker list', () => {
		const out = substitutePlaudPlaceholders('Speakers: $[speakers]', rec, transcript);
		expect(out).toBe('Speakers: Charles, Mary');
	});

	it('leaves $[speakers] untouched when the transcript has no speakers', () => {
		const noSpeakers: Transcript = {
			id: rec.id,
			rawText: '',
			segments: [{ startSeconds: 0, endSeconds: 5, text: 'hi' }],
		};
		const out = substitutePlaudPlaceholders('Speakers: $[speakers]', rec, noSpeakers);
		expect(out).toBe('Speakers: $[speakers]');
	});

	it('leaves unknown placeholders untouched (forward compatibility)', () => {
		const out = substitutePlaudPlaceholders(
			'Mystery: $[future_field] vs Title: $[audio_title]',
			rec,
			transcript,
		);
		expect(out).toBe('Mystery: $[future_field] vs Title: Q2 Planning');
	});

	it('substitutes every occurrence (global, not just first)', () => {
		const out = substitutePlaudPlaceholders(
			'$[audio_start_time] / $[audio_start_time]',
			rec,
			transcript,
		);
		expect(out).toBe('2026-05-13 14:04:22 / 2026-05-13 14:04:22');
	});

	it('returns text unchanged when no placeholders are present', () => {
		expect(substitutePlaudPlaceholders('No tokens here', rec, transcript)).toBe(
			'No tokens here',
		);
	});

	it('returns an empty string unchanged without recursing into the regex', () => {
		expect(substitutePlaudPlaceholders('', rec, transcript)).toBe('');
	});
});

describe('formatMarkdown — placeholder substitution end-to-end', () => {
	it('substitutes $[audio_start_time] inside the Summary body', () => {
		const rec = makeRecording({
			createdAt: new Date(2026, 4, 13, 14, 4, 22),
		});
		const transcript = makeTranscript();
		const summary = makeSummary({
			text: '> Date & Time:  $[audio_start_time]\n> Location: [Insert Location]',
		});
		const md = formatMarkdown(rec, transcript, summary);
		expect(md).toContain('Date & Time:  2026-05-13 14:04:22');
		expect(md).not.toContain('$[audio_start_time]');
	});

	it('substitutes $[audio_start_time] inside the AI Suggestions body', () => {
		const rec = makeRecording({
			createdAt: new Date(2026, 4, 13, 14, 4, 22),
		});
		const summary = makeSummary({
			aiSuggestion: 'Follow up on items from $[audio_start_time].',
		});
		const md = formatMarkdown(rec, makeTranscript(), summary);
		expect(md).toContain('Follow up on items from 2026-05-13 14:04:22.');
	});
});

// ---------------------------------------------------------------------------
// formatMarkdown with chapters — end-to-end integration
// ---------------------------------------------------------------------------

describe('formatMarkdown with chapters', () => {
	it('renders a Transcript heading with inline Chapters index and chapter sections', () => {
		const recording = makeRecording();
		const transcript: Transcript = {
			id: recording.id,
			rawText: '',
			segments: [
				{ startSeconds: 0, endSeconds: 30, text: 'hello', speaker: 'A' },
				{ startSeconds: 60, endSeconds: 90, text: 'world', speaker: 'B' },
			],
		};
		const summary: Summary = {
			id: recording.id,
			text: 'Summary body goes here.',
		};
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
			{ title: 'Close', startSeconds: 60 },
		];
		const md = formatMarkdown(recording, transcript, summary, chapters);

		// Inline chapter index under Transcript.
		expect(md).toContain('##### Chapters');
		expect(md).toContain('- [[#00:00 Opening|**[00:00]** Opening]]');
		expect(md).toContain('- [[#01:00 Close|**[01:00]** Close]]');

		// Default header level 4 → #### Transcript wrap + ##### chapter subs.
		expect(md).toContain('#### Transcript');
		expect(md).toContain('##### 00:00 Opening');
		expect(md).toContain('##### 01:00 Close');
		// Each chapter section contains a quick return link to the index.
		expect(md).toMatch(/##### 00:00 Opening\n\n\[\[#\^plaud-chapters\|Back to Chapters\]\]\n\n\*\*\[00:00\]\*\* A: hello/);
		expect(md).toMatch(/##### 01:00 Close\n\n\[\[#\^plaud-chapters\|Back to Chapters\]\]\n\n\*\*\[01:00\]\*\* B: world/);
		// Chapters index carries the ^plaud-chapters block id.
		expect(md).toContain('^plaud-chapters');
		// Horizontal rule separates summary from transcript area.
		expect(md).toContain('## Summary\n\nSummary body goes here.\n\n---\n\n#### Transcript');

		// No [!note]- Transcript callout wrapper in the chaptered path.
		expect(md).not.toContain('> [!note]- Transcript');

		// Ordering: Summary → Transcript wrap.
		const summaryIdx = md.indexOf('## Summary');
		const transcriptIdx = md.indexOf('#### Transcript');
		expect(summaryIdx).toBeLessThan(transcriptIdx);
	});

	it('honors a custom transcriptHeaderLevel setting', () => {
		const recording = makeRecording();
		const transcript: Transcript = {
			id: recording.id,
			rawText: '',
			segments: [
				{ startSeconds: 0, endSeconds: 10, text: 'hi', speaker: 'A' },
			],
		};
		const summary: Summary = { id: recording.id, text: 'body' };
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
		];
		const md = formatMarkdown(recording, transcript, summary, chapters, {
			transcriptHeaderLevel: 2,
		});
		expect(md).toContain('## Transcript');
		expect(md).toContain('### 00:00 Opening');
		expect(md).not.toContain('#### Transcript');
	});

	it('omits the transcript section entirely when includeTranscript is false', () => {
		const recording = makeRecording();
		const transcript = makeTranscript();
		const summary: Summary = { id: recording.id, text: 'body' };
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
		];
		const md = formatMarkdown(recording, transcript, summary, chapters, {
			includeTranscript: false,
		});
		// No transcript wrap or body.
		expect(md).not.toContain('#### Transcript');
		expect(md).not.toContain('##### 00:00 Opening');
		expect(md).not.toContain('> [!note]- Transcript');
	});

	it('omits the Chapters section entirely when chapters is undefined', () => {
		const recording = makeRecording();
		const transcript = makeTranscript();
		const summary: Summary = { id: recording.id, text: 'Body' };

		const md = formatMarkdown(recording, transcript, summary);

		expect(md).not.toContain('##### Chapters');
		expect(md).toContain('> [!note]- Transcript');
		expect(md.indexOf('## Summary')).toBeLessThan(
			md.indexOf('> [!note]- Transcript'),
		);
	});

	it('omits the Chapters section when the list is empty', () => {
		const recording = makeRecording();
		const transcript = makeTranscript();
		const summary: Summary = { id: recording.id, text: 'Body' };

		const md = formatMarkdown(recording, transcript, summary, []);

		expect(md).not.toContain('##### Chapters');
		expect(md).toContain('> [!note]- Transcript');
	});
});

// ---------------------------------------------------------------------------
// findTranscriptHeadingLine — fold-target lookup for auto-fold integration
// ---------------------------------------------------------------------------

describe('findTranscriptHeadingLine', () => {
	it('returns the 0-based line index of the wrapping Transcript heading at the given level', () => {
		const md = [
			'# Title',
			'',
			'## Summary',
			'',
			'body',
			'',
			'#### Transcript',
			'',
			'##### 00:00 Intro',
			'body',
		].join('\n');
		expect(findTranscriptHeadingLine(md, 4)).toBe(6);
	});

	it('returns the LAST match so an earlier duplicate heading cannot shadow the real transcript', () => {
		// A consumer_note body heading can demote to exactly `#### Transcript`
		// and render before the real wrapping transcript heading. The real one
		// is always the final section, so the last match is the correct fold target.
		const md = [
			'## Template outputs',
			'### Verbatim',
			'#### Transcript',
			'decoy body',
			'',
			'---',
			'',
			'#### Transcript',
			'',
			'##### 00:00 Intro',
		].join('\n');
		expect(findTranscriptHeadingLine(md, 4)).toBe(7);
	});

	it('returns null when no wrapping heading matches at the given level', () => {
		const md = '## Summary\n\nbody\n\n> [!note]- Transcript\n> **[00:00]** A: hi';
		expect(findTranscriptHeadingLine(md, 4)).toBeNull();
	});

	it('distinguishes header levels — level 4 misses a level 2 heading', () => {
		const md = '## Transcript\n### 00:00 Intro\nbody';
		expect(findTranscriptHeadingLine(md, 4)).toBeNull();
		expect(findTranscriptHeadingLine(md, 2)).toBe(0);
	});

	it('does not match chapter sub-headings, only the wrap', () => {
		const md = '#### Transcript\n##### 05:00 Transcript\nbody';
		expect(findTranscriptHeadingLine(md, 4)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// NoteWriter.writeNote.foldInfo — fold metadata surfaced to the caller
// ---------------------------------------------------------------------------

type WriteNoteOutcome = Awaited<ReturnType<NoteWriter['writeNote']>>;
type CreatedWriteOutcome = Extract<WriteNoteOutcome, { status: 'created' }>;

function expectCreatedOutcome(outcome: WriteNoteOutcome): CreatedWriteOutcome {
	expect(outcome.status).toBe('created');
	if (outcome.status !== 'created') {
		throw new Error('Expected created outcome');
	}
	return outcome;
}

describe('NoteWriter.writeNote foldInfo', () => {
	function makeVault(): { vault: VaultLike; created: Map<string, string> } {
		const created = new Map<string, string>();
		const vault: VaultLike = {
			getFileByPath: () => null,
			getFolderByPath: () => ({ path: '' }),
			createFolder: async () => undefined,
			create: async (path, data) => {
				created.set(path, data);
				return { path };
			},
			read: async () => '',
			process: async () => '',
		};
		return { vault, created };
	}

	it('surfaces transcriptHeadingLine and totalLines when chapters are present', async () => {
		const { vault } = makeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: '',
			onDuplicate: 'skip',
		});
		const recording = makeRecording();
		const transcript = makeTranscript();
		const summary = makeSummary();
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
			{ title: 'Close', startSeconds: 14 },
		];

		const outcome = await writer.writeNote(recording, transcript, summary, chapters);
		const created = expectCreatedOutcome(outcome);
		expect(created.foldInfo).toBeDefined();
		expect(created.foldInfo?.transcriptHeadingLine).toBeGreaterThan(0);
		expect(created.foldInfo?.totalLines).toBeGreaterThan(
			created.foldInfo?.transcriptHeadingLine ?? 0,
		);
	});

	it('omits foldInfo when chapters are absent', async () => {
		const { vault } = makeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: '',
			onDuplicate: 'skip',
		});
		const outcome = await writer.writeNote(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
		);
		const created = expectCreatedOutcome(outcome);
		expect(created.foldInfo).toBeUndefined();
	});

	it('omits foldInfo when chapters are present but includeTranscript is false', async () => {
		const { vault } = makeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: '',
			onDuplicate: 'skip',
			includeTranscript: false,
		});
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
		];
		const outcome = await writer.writeNote(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			chapters,
		);
		const created = expectCreatedOutcome(outcome);
		expect(created.foldInfo).toBeUndefined();
	});

	it('uses the configured transcriptHeaderLevel to find the fold target', async () => {
		const { vault } = makeVault();
		const writer = new NoteWriter(vault, {
			outputFolder: '',
			onDuplicate: 'skip',
			transcriptHeaderLevel: 2,
		});
		const chapters: readonly Chapter[] = [
			{ title: 'Opening', startSeconds: 0 },
		];
		const outcome = await writer.writeNote(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			chapters,
		);
		const created = expectCreatedOutcome(outcome);
		// With H2 configured, findTranscriptHeadingLine locates `## Transcript`.
		expect(created.foldInfo).toBeDefined();
	});
});

// extractPlaudPlaceholderFlag ------------------------------------------------

describe('extractPlaudPlaceholderFlag', () => {
	it('returns true when the frontmatter carries plaud-placeholder: true', () => {
		const content = '---\nplaud-id: abc\nplaud-placeholder: true\n---\n\n# Note';
		expect(extractPlaudPlaceholderFlag(content)).toBe(true);
	});

	it('accepts quoted and yes forms case-insensitively', () => {
		expect(
			extractPlaudPlaceholderFlag('---\nplaud-placeholder: "true"\n---'),
		).toBe(true);
		expect(extractPlaudPlaceholderFlag('---\nplaud-placeholder: YES\n---')).toBe(
			true,
		);
	});

	it('returns false for a real note with no marker', () => {
		const content = '---\nplaud-id: abc\nsource: plaud\n---\n\n# Note';
		expect(extractPlaudPlaceholderFlag(content)).toBe(false);
	});

	it('returns false when the marker is explicitly false or absent frontmatter', () => {
		expect(
			extractPlaudPlaceholderFlag('---\nplaud-placeholder: false\n---'),
		).toBe(false);
		expect(extractPlaudPlaceholderFlag('no frontmatter here')).toBe(false);
	});
});

// formatPlaceholderMarkdown --------------------------------------------------

describe('formatPlaceholderMarkdown', () => {
	it('carries the recording id, link, marker, and reason', () => {
		const md = formatPlaceholderMarkdown(
			makeRecording({ id: 'rec-9' as PlaudRecordingId, title: 'Strategy sync' }),
			'Plaud reported: status=-12 msg=start trans task error',
		);
		expect(md).toContain('plaud-id: rec-9');
		expect(md).toContain('plaud-placeholder: true');
		expect(md).toContain(formatPlaudWebUrl('rec-9'));
		expect(md).toContain('[Open in Plaud →]');
		expect(md).toContain('# 2026-04-14 Strategy sync');
		expect(md).toContain('start trans task error');
	});

	it('is recognized as a placeholder by extractPlaudPlaceholderFlag', () => {
		const md = formatPlaceholderMarkdown(makeRecording(), 'because reasons');
		expect(extractPlaudPlaceholderFlag(md)).toBe(true);
		// And it still carries a parseable plaud-id for collision/dedup checks.
		expect(extractPlaudIdFromFrontmatter(md)).toBe('abc123');
	});

	it('flattens newlines in the reason so the callout stays well-formed', () => {
		const md = formatPlaceholderMarkdown(
			makeRecording(),
			'line one\nline two',
		);
		expect(md).toContain('line one line two');
		expect(md).not.toContain('line one\nline two');
	});

	// datetime property (issue #32): the placeholder path mirrors formatFrontmatter,
	// so it must emit datetime under the same conditions to stay in sync.
	it('omits the datetime line when no datetime template is given', () => {
		expect(formatPlaceholderMarkdown(makeRecording(), 'reason')).not.toMatch(
			/^datetime:/m,
		);
		expect(
			formatPlaceholderMarkdown(makeRecording(), 'reason', DEFAULT_NOTE_NAME_TEMPLATE, ''),
		).not.toMatch(/^datetime:/m);
	});

	it('emits the datetime line, quoted, when a datetime template is given', () => {
		const md = formatPlaceholderMarkdown(
			makeRecording(),
			'reason',
			DEFAULT_NOTE_NAME_TEMPLATE,
			'{{YYYY-MM-DD HH:mm}}',
		);
		const lines = md.split('\n');
		const dateIdx = lines.findIndex((l) => l.startsWith('date:'));
		expect(lines[dateIdx]).toBe('date: 2026-04-14');
		expect(lines[dateIdx + 1]).toBe('datetime: "2026-04-14 09:30"');
	});
});

// NoteWriter.writePlaceholderNote --------------------------------------------

describe('NoteWriter.writePlaceholderNote', () => {
	it('creates a placeholder note when none exists', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writePlaceholderNote(makeRecording(), 'no content yet');

		expect(outcome.status).toBe('created');
		expect(outcome.path).toBe('Plaud/2026-04-14 Morning standup.md');
		const body = vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? '';
		expect(extractPlaudPlaceholderFlag(body)).toBe(true);
	});

	it('refreshes an existing placeholder rather than duplicating it', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });
		await writer.writePlaceholderNote(makeRecording(), 'first reason');

		const outcome = await writer.writePlaceholderNote(makeRecording(), 'second reason');

		expect(outcome.status).toBe('refreshed');
		expect(vault.files.size).toBe(1);
		expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toContain('second reason');
	});

	it('keeps an existing real note and never downgrades it to a stub', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });
		await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());
		const realBody = vault.files.get('Plaud/2026-04-14 Morning standup.md');

		const outcome = await writer.writePlaceholderNote(makeRecording(), 'plaud erred');

		expect(outcome.status).toBe('kept-existing');
		// The real note is untouched: still has the summary, no placeholder marker.
		expect(vault.files.get('Plaud/2026-04-14 Morning standup.md')).toBe(realBody);
		expect(
			extractPlaudPlaceholderFlag(vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? ''),
		).toBe(false);
	});

	it('throws a collision error when a note for a DIFFERENT recording occupies the path', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });
		vault.files.set(
			'Plaud/2026-04-14 Morning standup.md',
			'---\nplaud-id: someone-else\n---\n\n# 2026-04-14 Morning standup',
		);

		await expect(
			writer.writePlaceholderNote(makeRecording(), 'plaud erred'),
		).rejects.toThrow(NoteWriterError);
	});
});

// writeNote placeholder supersession -----------------------------------------

describe('NoteWriter.writeNote superseding a placeholder', () => {
	it('overwrites a placeholder with real content even under the skip policy', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });
		await writer.writePlaceholderNote(makeRecording(), 'no content yet');

		const outcome = await writer.writeNote(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
		);

		// Skip policy would normally leave an existing note alone, but a
		// placeholder must always yield to real content.
		expect(outcome.status).toBe('overwritten');
		const body = vault.files.get('Plaud/2026-04-14 Morning standup.md') ?? '';
		expect(extractPlaudPlaceholderFlag(body)).toBe(false);
		expect(body).toContain('## Summary');
	});

	it('overwrites a placeholder without invoking the duplicate prompt', async () => {
		const vault = makeFakeVault();
		const promptOnDuplicate = jest.fn();
		const writer = new NoteWriter(vault, {
			outputFolder: 'Plaud',
			onDuplicate: 'prompt',
			promptOnDuplicate,
		});
		await writer.writePlaceholderNote(makeRecording(), 'no content yet');

		const outcome = await writer.writeNote(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
		);

		expect(outcome.status).toBe('overwritten');
		// Replacing our own stub needs no user decision.
		expect(promptOnDuplicate).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// consumer_note template outputs — folded into the note as a section (#15)
// ---------------------------------------------------------------------------

describe('formatMarkdown consumer_note template outputs', () => {
	const consumerNotes: readonly ConsumerNote[] = [
		{ heading: 'Key Points', markdown: '- First point\n- Second point' },
		{ heading: 'Daily Journal', markdown: '## Reflections\n\nA good day.' },
	];

	it('renders a Template outputs block with one subsection per output', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes },
		);
		expect(md).toContain('## Template outputs');
		expect(md).toContain('### Key Points');
		expect(md).toContain('### Daily Journal');
		// Bodies are embedded as native Markdown, not re-quoted into a callout.
		expect(md).toContain('- First point');
		// A body heading is demoted to nest under its `### <tab>` title (the
		// shallowest body heading lands at H4) so it cannot end the fold early.
		expect(md.split('\n')).toContain('#### Reflections');
		expect(md.split('\n')).not.toContain('## Reflections');
	});

	it('renders no block when there are no template outputs', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		expect(md).not.toContain('## Template outputs');
	});

	it('renders no block when consumerNotes is an empty array', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [] },
		);
		expect(md).not.toContain('## Template outputs');
	});

	it('places the block after the Summary and before the transcript', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes },
		);
		const summaryAt = md.indexOf('## Summary');
		const templatesAt = md.indexOf('## Template outputs');
		const transcriptAt = md.indexOf('> [!note]- Transcript');
		expect(summaryAt).toBeLessThan(templatesAt);
		expect(templatesAt).toBeLessThan(transcriptAt);
	});

	it('does not de-duplicate a transcript-style tab against the pipeline transcript', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Verbatim Transcript', markdown: 'Speaker 1: hello' }] },
		);
		// The user's "Verbatim Transcript" template renders as its own section...
		expect(md).toContain('### Verbatim Transcript');
		expect(md).toContain('Speaker 1: hello');
		// ...while the pipeline transcript callout is still present below it.
		expect(md).toContain('> [!note]- Transcript');
	});

	it('falls back to a generic title when a tab name is blank', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: '   ', markdown: 'body' }] },
		);
		expect(md).toContain('### Template output');
	});

	it('demotes a top-level body heading so it nests under its tab title', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Outline', markdown: '# Top\n\n## Sub' }] },
		);
		const lines = md.split('\n');
		// Shallowest body heading (H1) shifts to H4; the H2 shifts in step to H5.
		expect(lines).toContain('#### Top');
		expect(lines).toContain('##### Sub');
		expect(lines).not.toContain('# Top');
	});

	it('leaves a # inside a fenced code block untouched while demoting real headings', () => {
		const body = '## Real heading\n\n```\n# not a heading\n```';
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Mixed', markdown: body }] },
		);
		const lines = md.split('\n');
		expect(lines).toContain('#### Real heading');
		expect(lines).toContain('# not a heading');
	});

	it('leaves a body whose headings are already H4 or deeper unchanged', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Deep', markdown: '#### Already deep\n\ntext' }] },
		);
		expect(md.split('\n')).toContain('#### Already deep');
	});

	it('neutralizes a dash separator in a body so it is not read as a setext heading', () => {
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Notes', markdown: 'Action items\n---\nFollow up' }] },
		);
		const lines = md.split('\n');
		const idx = lines.indexOf('Action items');
		expect(idx).toBeGreaterThan(-1);
		// The line after the paragraph is a thematic break, not a setext underline,
		// so 'Action items' renders as a paragraph rather than a giant H2.
		expect(lines[idx + 1]).toBe('***');
	});

	it('preserves a dash line inside a fenced code block (does not rewrite it to ***)', () => {
		const body = 'Config example:\n\n```yaml\n---\nname: x\n---\n```';
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Config', markdown: body }] },
		);
		// The literal YAML `---` lines inside the fence stay verbatim; the setext
		// rewrite is fence-aware, so no `***` is produced from this body.
		expect(md).toContain('name: x');
		expect(md).not.toContain('***');
	});

	it('keeps a fenced block open across a shorter or mismatched fence line', () => {
		// A ``` line inside a ~~~ block must NOT close it, so the `## Inside`
		// heading stays code (untouched) while the real `## Real` heading demotes.
		const body = '~~~text\n```\n## Inside\n~~~\n\n## Real';
		const md = formatMarkdown(
			makeRecording(),
			makeTranscript(),
			makeSummary(),
			undefined,
			{ consumerNotes: [{ heading: 'Fences', markdown: body }] },
		);
		const lines = md.split('\n');
		expect(lines).toContain('## Inside');
		expect(lines).toContain('#### Real');
	});
});
