import {
	classifyError,
	formatDate,
	formatDuration,
	formatImportNotice,
	tallyImportResults,
	type ImportResult,
	type ErrorClassification,
} from '../import-modal';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from '../plaud-client-re';
import type { PlaudRecordingId, Recording } from '../plaud-client';
import type { WriteOutcome } from '../note-writer';
import { NoteWriterError } from '../note-writer';

// classifyError --------------------------------------------------------------

describe('classifyError', () => {
	describe('PlaudAuthError branches (discriminated by reason field)', () => {
		it('maps reason="not_configured" to the not-configured category', () => {
			const err = new PlaudAuthError(
				'not_configured',
				'No Plaud token configured — open Settings → Community Plugins → Plaud Importer to set one',
				'/file/simple/web',
			);
			const result = classifyError(err);
			expect(result.category).toBe('not-configured');
			expect(result.canRetry).toBe(false);
			expect(result.message).toMatch(/settings/i);
			expect(result.message).toMatch(/plaud importer/i);
		});

		it('maps reason="token_rejected" to the token-rejected category', () => {
			const err = new PlaudAuthError(
				'token_rejected',
				'Plaud token rejected by /file/simple/web (401) — token is expired or revoked',
				'/file/simple/web',
			);
			const result = classifyError(err);
			expect(result.category).toBe('token-rejected');
			expect(result.canRetry).toBe(false);
			expect(result.message).toMatch(/expired|revoked/i);
		});

		it('discriminates by reason field, not by message text (message drift is safe)', () => {
			// Construct a not-configured error with a completely different
			// message from the one the client actually uses today. If the
			// classifier were matching on message substring, this would
			// silently fall through to token-rejected.
			const err = new PlaudAuthError(
				'not_configured',
				'surprise! totally different wording from what the client writes',
				'/file/simple/web',
			);
			expect(classifyError(err).category).toBe('not-configured');
		});
	});

	describe('PlaudParseError branch', () => {
		it('maps PlaudParseError to the parse-error category (before PlaudApiError)', () => {
			const err = new PlaudParseError(
				'data_file_list[3] is missing required fields',
				'/file/simple/web',
			);
			const result = classifyError(err);
			expect(result.category).toBe('parse-error');
			expect(result.canRetry).toBe(false);
			expect(result.message).toMatch(/unexpected shape/i);
		});
	});

	describe('PlaudApiError branches', () => {
		it('maps 429 to rate-limited with retry enabled', () => {
			const err = new PlaudApiError('rate limited', 429, '/file/simple/web');
			const result = classifyError(err);
			expect(result.category).toBe('rate-limited');
			expect(result.canRetry).toBe(true);
			expect(result.message).toMatch(/rate.?limit/i);
		});

		it('maps 500 to server-error with retry enabled', () => {
			const err = new PlaudApiError('boom', 500, '/file/simple/web');
			const result = classifyError(err);
			expect(result.category).toBe('server-error');
			expect(result.canRetry).toBe(true);
			expect(result.message).toContain('500');
		});

		it('maps 503 to server-error', () => {
			const err = new PlaudApiError('service unavailable', 503, '/file/simple/web');
			expect(classifyError(err).category).toBe('server-error');
		});

		it('maps wrapped network errors (no status) to network-error with retry', () => {
			const err = new PlaudApiError(
				'Plaud API /file/simple/web network error: ECONNRESET',
				undefined,
				'/file/simple/web',
			);
			const result = classifyError(err);
			expect(result.category).toBe('network-error');
			expect(result.canRetry).toBe(true);
			expect(result.message).toMatch(/plaud/i);
		});

		it.each([
			['400 bad request', 400],
			['403 forbidden', 403],
			['404 not found', 404],
			['418 teapot', 418],
			['451 unavailable for legal reasons', 451],
		])('maps non-auth/non-rate-limit 4xx (%s) to api-error with retry disabled', (_label, status) => {
			const err = new PlaudApiError('plaud said no', status, '/file/simple/web');
			const result = classifyError(err);
			expect(result.category).toBe('api-error');
			expect(result.canRetry).toBe(false);
			expect(result.message).toContain(String(status));
			// Must NOT say "Could not reach Plaud.AI" — that would be a lie
			// (the network reached Plaud just fine, Plaud returned an error).
			expect(result.message).not.toMatch(/could not reach/i);
		});
	});

	describe('non-Plaud errors', () => {
		it('maps arbitrary Error instances to unknown with retry DISABLED (unknown does not retry-recover)', () => {
			const result = classifyError(new Error('something bizarre'));
			expect(result.category).toBe('unknown');
			expect(result.canRetry).toBe(false);
			expect(result.message).toContain('something bizarre');
			expect(result.message).toMatch(/report this/i);
		});

		it('maps non-Error values to unknown with retry disabled', () => {
			const result = classifyError('string thrown as error');
			expect(result.category).toBe('unknown');
			expect(result.canRetry).toBe(false);
			expect(result.message).toContain('string thrown');
		});
	});

	describe('NoteWriterError branches', () => {
		it('maps a filename collision error to the write-collision category', () => {
			const err = new NoteWriterError(
				'Filename collision at Plaud/Morning standup.md: this note belongs to recording abc, not xyz.',
			);
			const result = classifyError(err);
			expect(result.category).toBe('write-collision');
			expect(result.canRetry).toBe(false);
		});

		it('maps an outputFolder traversal error to the config-error category', () => {
			const err = new NoteWriterError(
				'Output folder "../escape" contains ".." which would escape the vault — use a vault-relative path',
			);
			const result = classifyError(err);
			expect(result.category).toBe('config-error');
			expect(result.canRetry).toBe(false);
			expect(result.message).toMatch(/settings/i);
		});

		it('maps an invalid-onDuplicate error to the config-error category', () => {
			const err = new NoteWriterError(
				"Invalid onDuplicate policy \"bogus\" — expected 'skip' or 'overwrite'",
			);
			const result = classifyError(err);
			expect(result.category).toBe('config-error');
		});

		it('maps a generic vault-write failure to the write-failed category with retry', () => {
			const err = new NoteWriterError(
				'Failed to create Plaud/Meeting.md for recording abc: EACCES permission denied',
			);
			const result = classifyError(err);
			expect(result.category).toBe('write-failed');
			expect(result.canRetry).toBe(true);
		});
	});

	describe('class-hierarchy precedence', () => {
		it('classifies PlaudAuthError as auth, not the generic api branch (it extends PlaudApiError)', () => {
			// PlaudAuthError is a subclass of PlaudApiError with status 401.
			// Without correct ordering in classifyError, a 401 could fall into
			// the "4xx api-error" branch. Pin the precedence.
			const err = new PlaudAuthError(
				'token_rejected',
				'Plaud token rejected',
				'/file/simple/web',
			);
			const result = classifyError(err);
			expect(result.category).not.toBe('api-error');
			expect(result.category).not.toBe('network-error');
			expect(result.category).toBe('token-rejected');
		});

		it('classifies PlaudParseError as parse-error, not network-error', () => {
			// Same concern — PlaudParseError extends PlaudApiError with no status.
			const err = new PlaudParseError('shape mismatch', '/file/simple/web');
			const result = classifyError(err);
			expect(result.category).toBe('parse-error');
		});
	});
});

// formatDate ---------------------------------------------------------------

describe('formatDate', () => {
	it('zero-pads months, days, hours, and minutes', () => {
		// Use a date where each component needs padding.
		const d = new Date(2026, 0, 5, 9, 7); // 2026-01-05 09:07 local
		expect(formatDate(d)).toBe('2026-01-05 09:07');
	});

	it('handles two-digit months and days without padding', () => {
		const d = new Date(2026, 10, 25, 14, 30); // 2026-11-25 14:30
		expect(formatDate(d)).toBe('2026-11-25 14:30');
	});

	it('handles midnight correctly', () => {
		const d = new Date(2026, 0, 1, 0, 0);
		expect(formatDate(d)).toBe('2026-01-01 00:00');
	});
});

// formatDuration ------------------------------------------------------------

describe('formatDuration', () => {
	it('omits the hours field when duration is under one hour', () => {
		expect(formatDuration(0)).toBe('0m 0s');
		expect(formatDuration(45)).toBe('0m 45s');
		expect(formatDuration(600)).toBe('10m 0s');
		expect(formatDuration(3599)).toBe('59m 59s');
	});

	it('includes the hours field for durations of one hour or more', () => {
		expect(formatDuration(3600)).toBe('1h 0m 0s');
		expect(formatDuration(3661)).toBe('1h 1m 1s');
		expect(formatDuration(7325)).toBe('2h 2m 5s');
	});

	it('floors fractional seconds', () => {
		expect(formatDuration(45.9)).toBe('0m 45s');
		expect(formatDuration(3661.4)).toBe('1h 1m 1s');
	});

	it('clamps negative durations to zero', () => {
		expect(formatDuration(-5)).toBe('0m 0s');
	});

	it.each([
		['NaN', Number.NaN],
		['positive Infinity', Number.POSITIVE_INFINITY],
		['negative Infinity', Number.NEGATIVE_INFINITY],
	])('returns "0m 0s" for non-finite input (%s) instead of rendering garbage', (_label, value) => {
		// The parser rejects non-finite durations upstream, but formatDuration
		// is exported as a standalone helper — a future caller could pass a
		// hand-constructed Recording and trigger "NaNh NaNm NaNs" in the UI.
		// Guard here.
		expect(formatDuration(value)).toBe('0m 0s');
	});
});

// tallyImportResults --------------------------------------------------------

function rec(id: string, title = `rec ${id}`): Recording {
	return {
		id: id as PlaudRecordingId,
		title,
		createdAt: new Date(2026, 3, 14),
		durationSeconds: 60,
		transcriptAvailable: true,
		summaryAvailable: true,
	};
}

function written(id: string, status: WriteOutcome['status']): ImportResult {
	return {
		kind: 'written',
		recording: rec(id),
		writeOutcome: { status, path: `Plaud/${id}.md` },
	};
}

function failed(id: string, reason: string, title?: string): ImportResult {
	const classification: ErrorClassification = {
		category: 'unknown',
		message: reason,
		canRetry: false,
	};
	return {
		kind: 'failed',
		recording: rec(id, title),
		reason,
		classification,
		cause: new Error(reason),
	};
}

describe('tallyImportResults', () => {
	it('returns a zeroed tally for an empty list', () => {
		const tally = tallyImportResults([]);
		expect(tally.total).toBe(0);
		expect(tally.created).toBe(0);
		expect(tally.overwritten).toBe(0);
		expect(tally.skipped).toBe(0);
		expect(tally.failed).toBe(0);
		expect(tally.failures).toEqual([]);
	});

	it('counts each write status into the correct bucket', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			written('b', 'created'),
			written('c', 'overwritten'),
			written('d', 'skipped'),
			written('e', 'skipped'),
			written('f', 'skipped'),
		]);
		expect(tally.total).toBe(6);
		expect(tally.created).toBe(2);
		expect(tally.overwritten).toBe(1);
		expect(tally.skipped).toBe(3);
		expect(tally.failed).toBe(0);
	});

	it('collects failures in a separate list while counting them', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			failed('b', 'network error'),
			failed('c', 'parse error'),
		]);
		expect(tally.total).toBe(3);
		expect(tally.created).toBe(1);
		expect(tally.failed).toBe(2);
		expect(tally.failures).toHaveLength(2);
		expect(tally.failures[0].recording.id).toBe('b');
		expect(tally.failures[1].recording.id).toBe('c');
	});

	it('preserves input order when multiple failures are interleaved with successes', () => {
		const tally = tallyImportResults([
			failed('1', 'first'),
			written('2', 'created'),
			failed('3', 'second'),
			written('4', 'skipped'),
			failed('5', 'third'),
		]);
		expect(tally.failures.map((f) => f.recording.id)).toEqual(['1', '3', '5']);
	});
});

// formatImportNotice --------------------------------------------------------

describe('formatImportNotice', () => {
	it('reports all-success counts with only the imported number', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			written('b', 'overwritten'),
		]);
		expect(formatImportNotice(tally)).toBe('Plaud Importer: 2 imported.');
	});

	it('includes a skipped count when any were skipped', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			written('b', 'skipped'),
			written('c', 'skipped'),
		]);
		expect(formatImportNotice(tally)).toBe(
			'Plaud Importer: 1 imported, 2 skipped.',
		);
	});

	it('includes a failed count when any failed', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			failed('b', 'oops'),
		]);
		expect(formatImportNotice(tally)).toBe(
			'Plaud Importer: 1 imported, 1 failed.',
		);
	});

	it('includes all three count categories when all three are non-zero', () => {
		const tally = tallyImportResults([
			written('a', 'created'),
			written('b', 'overwritten'),
			written('c', 'skipped'),
			failed('d', 'x'),
		]);
		expect(formatImportNotice(tally)).toBe(
			'Plaud Importer: 2 imported, 1 skipped, 1 failed.',
		);
	});

	it('returns a distinct message for an empty tally', () => {
		expect(formatImportNotice(tallyImportResults([]))).toBe(
			'Plaud Importer: nothing to import.',
		);
	});

	it('counts "imported" as created + overwritten together', () => {
		// The Notice doesn't distinguish "freshly created" from
		// "overwritten on re-import" — both mean "the user got a note
		// at the end." The expanded summary in the modal body shows
		// the breakdown.
		const tally = tallyImportResults([
			written('a', 'overwritten'),
			written('b', 'overwritten'),
			written('c', 'created'),
		]);
		expect(formatImportNotice(tally)).toContain('3 imported');
	});

	it('pluralizes by count but not with irregular grammar', () => {
		// The helper is terse by design — it says "1 imported" not
		// "1 recording imported" so pluralization isn't required.
		const tally = tallyImportResults([written('a', 'created')]);
		expect(formatImportNotice(tally)).toBe('Plaud Importer: 1 imported.');
	});
});
