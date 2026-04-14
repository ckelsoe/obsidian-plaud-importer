import {
	NoteWriter,
	NoteWriterError,
	expandTitleWithYear,
	extractPlaudIdFromFrontmatter,
	extractSpeakers,
	formatDurationHoursMinutes,
	formatFrontmatter,
	formatMarkdown,
	formatPlaudWebUrl,
	formatTimestamp,
	sanitizeFilename,
	type FileLike,
	type FolderLike,
	type VaultLike,
} from '../note-writer';
import type {
	PlaudRecordingId,
	Recording,
	Summary,
	Transcript,
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
