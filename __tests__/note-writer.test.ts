import {
	NoteWriter,
	NoteWriterError,
	NoteWriterCancelledError,
	expandTitleWithYear,
	extractPlaudIdFromFrontmatter,
	extractSpeakers,
	findTranscriptHeadingLine,
	formatChapterIndexSection,
	formatDurationHoursMinutes,
	formatFrontmatter,
	formatMarkdown,
	formatPlaudWebUrl,
	formatTimestamp,
	formatTranscriptSection,
	groupTranscriptByChapters,
	mergeTagSources,
	sanitizeFilename,
	type FileLike,
	type FolderLike,
	type TranscriptChapterGroup,
	type VaultLike,
} from '../note-writer';
import type {
	Chapter,
	PlaudRecordingId,
	Recording,
	Summary,
	Transcript,
	TranscriptSegment,
} from '../plaud-client';

// Fixtures ------------------------------------------------------------------

function makeRecording(overrides: Partial<Recording> = {}): Recording {
	return {
		id: 'abc123' as PlaudRecordingId,
		title: 'Morning standup',
		createdAt: new Date(2026, 3, 14, 9, 30), // 2026-04-14 09:30 local
		durationSeconds: 600,
		transcriptAvailable: true,
		summaryAvailable: true,
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

// expandTitleWithYear -------------------------------------------------------

describe('expandTitleWithYear', () => {
	const apr14 = new Date(2026, 3, 14); // 2026-04-14 local

	it('prepends the year to a MM-DD-prefixed title', () => {
		expect(expandTitleWithYear('04-13 Meeting notes', apr14)).toBe(
			'2026-04-13 Meeting notes',
		);
	});

	it('prepends the year to a bare MM-DD title with no body', () => {
		expect(expandTitleWithYear('04-13', apr14)).toBe('2026-04-13');
	});

	it('leaves titles that already have a YYYY-MM-DD prefix unchanged', () => {
		expect(expandTitleWithYear('2025-12-31 New Year Eve', apr14)).toBe(
			'2025-12-31 New Year Eve',
		);
	});

	it('leaves titles without any date prefix unchanged', () => {
		expect(expandTitleWithYear('Quarterly review', apr14)).toBe(
			'Quarterly review',
		);
	});

	it('does not prefix a title that merely contains digits', () => {
		// "1-800 customer service" does not start with \d{2}-\d{2}, so it
		// should pass through unchanged — no year prefix.
		expect(expandTitleWithYear('1-800 customer service', apr14)).toBe(
			'1-800 customer service',
		);
	});

	it('does not prefix a title with a single-digit "month"', () => {
		// "4-13 Meeting" starts with \d-\d{2} not \d{2}-\d{2}, so the
		// pattern doesn't match and the title passes through.
		expect(expandTitleWithYear('4-13 Meeting', apr14)).toBe('4-13 Meeting');
	});

	it('does not double-prefix when the title already starts with the same year', () => {
		expect(expandTitleWithYear('2026-04-13 Done', apr14)).toBe(
			'2026-04-13 Done',
		);
	});

	it('uses the year from the recording date, not the title', () => {
		// If the user dates a note 12-31 but its createdAt is 2025, the
		// year from createdAt wins. This is Plaud's own year, not a
		// user-interpreted one.
		const dec31_2025 = new Date(2025, 11, 31);
		expect(expandTitleWithYear('12-31 Year-end review', dec31_2025)).toBe(
			'2025-12-31 Year-end review',
		);
	});

	it('trims leading whitespace before detecting the MM-DD prefix', () => {
		expect(expandTitleWithYear('  04-13 Padded  ', apr14)).toBe(
			'2026-04-13 Padded',
		);
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
});

// formatMarkdown -----------------------------------------------------------

describe('formatMarkdown', () => {
	it('produces frontmatter, H1, open-in-plaud link, summary, and transcript callout in order', () => {
		const md = formatMarkdown(makeRecording(), makeTranscript(), makeSummary());
		// Order assertions: find each anchor's index and verify monotonic.
		const fmStart = md.indexOf('---');
		const h1 = md.indexOf('# Morning standup');
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
			/^# Morning standup\n\n\[Open in Plaud →\]\(https:\/\/web\.plaud\.ai\/file\/abc123\)\n/m,
		);
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

	it('expands MM-DD titles with the year from createdAt in the H1', () => {
		const md = formatMarkdown(
			makeRecording({ title: '04-13 Client kickoff' }),
			makeTranscript(),
			makeSummary(),
		);
		// makeRecording() uses createdAt of 2026-04-14 → year 2026
		expect(md).toContain('# 2026-04-13 Client kickoff');
		expect(md).not.toMatch(/^# 04-13/m);
	});

	it('leaves non-MM-DD titles unchanged in the H1', () => {
		const md = formatMarkdown(
			makeRecording({ title: 'Quarterly review' }),
			makeTranscript(),
			makeSummary(),
		);
		expect(md).toContain('# Quarterly review');
		expect(md).not.toMatch(/# 2026-.*Quarterly review/);
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
		expect(outcome.path).toBe('Plaud/Meeting - notes - draft.md');
		expect(vault.files.has('Plaud/Meeting - notes - draft.md')).toBe(true);
	});

	it('expands MM-DD titles with the year for the filename so files sort chronologically', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(
			makeRecording({ title: '04-13 Client kickoff' }),
			makeTranscript(),
			makeSummary(),
		);

		// makeRecording's createdAt is 2026-04-14 → year 2026
		expect(outcome.path).toBe('Plaud/2026-04-13 Client kickoff.md');
	});

	it('keeps the filename and H1 in sync when both expand', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(
			makeRecording({ title: '04-13 Securing a data sandbox' }),
			makeTranscript(),
			makeSummary(),
		);

		const body = vault.files.get('Plaud/2026-04-13 Securing a data sandbox.md') ?? '';
		expect(body).toContain('# 2026-04-13 Securing a data sandbox');
	});

	it('writes at vault root when outputFolder is empty', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: '', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.path).toBe('Morning standup.md');
		expect(vault.folders.size).toBe(0); // no folder created
	});

	it('normalizes a folder path with leading/trailing slashes', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: '/Plaud/', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.path).toBe('Plaud/Morning standup.md');
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
		vault.files.set('Plaud/Morning standup.md', 'existing content');
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('skipped');
		expect(vault.files.get('Plaud/Morning standup.md')).toBe('existing content');
		expect(vault.createdPaths).toEqual([]);
		expect(vault.overwrittenPaths).toEqual([]);
	});

	it('overwrites via process() when file exists and onDuplicate is overwrite', async () => {
		const vault = makeFakeVault();
		vault.files.set('Plaud/Morning standup.md', 'existing content');
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'overwrite' });

		const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		expect(outcome.status).toBe('overwritten');
		expect(vault.overwrittenPaths).toContain('Plaud/Morning standup.md');
		expect(vault.files.get('Plaud/Morning standup.md')).toContain('# Morning standup');
		expect(vault.files.get('Plaud/Morning standup.md')).not.toBe('existing content');
	});

	describe('prompt policy', () => {
		it('invokes the callback with the target context when a same-id duplicate exists', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/Morning standup.md', '---\nplaud-id: abc123\n---\n');
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
					targetPath: 'Plaud/Morning standup.md',
				},
			]);
		});

		it('skips the write when the callback returns skip', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/Morning standup.md', '---\nplaud-id: abc123\n---\noriginal');
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'prompt',
				promptOnDuplicate: async () => 'skip',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('skipped');
			expect(vault.overwrittenPaths).toEqual([]);
			expect(vault.files.get('Plaud/Morning standup.md')).toBe(
				'---\nplaud-id: abc123\n---\noriginal',
			);
		});

		it('throws NoteWriterCancelledError when the callback returns cancel', async () => {
			const vault = makeFakeVault();
			vault.files.set('Plaud/Morning standup.md', '---\nplaud-id: abc123\n---\n');
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
		expect(vault.createdPaths).toEqual(['Plaud/Morning standup.md']);
	});

	it('writes the full markdown body including frontmatter, title, summary, and callout', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

		await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

		const body = vault.files.get('Plaud/Morning standup.md') ?? '';
		expect(body).toContain('plaud-id: abc123');
		expect(body).toContain('# Morning standup');
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
				'Plaud/Morning standup.md',
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
				'Plaud/Morning standup.md',
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
				'Plaud/Morning standup.md',
				'---\nplaud-id: abc123\n---\n\n# Old version\n',
			);
			const writer = new NoteWriter(vault, {
				outputFolder: 'Plaud',
				onDuplicate: 'overwrite',
			});

			const outcome = await writer.writeNote(makeRecording(), makeTranscript(), makeSummary());

			expect(outcome.status).toBe('overwritten');
			expect(vault.files.get('Plaud/Morning standup.md')).toContain('# Morning standup');
		});

		it('allows skip when existing note has the SAME plaud-id (idempotent re-import)', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/Morning standup.md',
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
			vault.files.set('Plaud/Morning standup.md', 'Just some text, no frontmatter.');
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

		it('throws when summaryAvailable is true but summary is null', async () => {
			const vault = makeFakeVault();
			const writer = new NoteWriter(vault, { outputFolder: 'Plaud', onDuplicate: 'skip' });

			await expect(
				writer.writeNote(
					makeRecording({ summaryAvailable: true }),
					makeTranscript(),
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
			const body = vault.files.get('Plaud/Morning standup.md') ?? '';
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
			).rejects.toThrow(/Plaud\/Morning standup\.md.*abc123.*EACCES/);
		});

		it('wraps vault.process errors with recording id and target path', async () => {
			const vault = makeFakeVault();
			vault.files.set(
				'Plaud/Morning standup.md',
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
			vault.files.set('Plaud/Morning standup.md', 'existing');
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
