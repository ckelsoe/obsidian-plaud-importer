import type {
	Recording,
	RecordingId,
	Transcript,
} from 'obsidian-recording-importer-core';
import { recordingSourceLabel } from '../plaud-client';
import {
	formatPlaudWebUrl,
	substitutePlaudPlaceholders,
} from '../plaud-profile';

function makeRecording(overrides: Partial<Recording> = {}): Recording {
	const createdAt = overrides.createdAt ?? new Date(2026, 3, 14, 9, 30); // 2026-04-14 09:30 local
	const durationSeconds = overrides.durationSeconds ?? 600;
	return {
		id: 'abc123' as RecordingId,
		title: 'Morning standup',
		createdAt,
		endsAt: new Date(createdAt.getTime() + durationSeconds * 1000),
		durationSeconds,
		captureOffsetMinutes: null,
		transcriptAvailable: true,
		summaryAvailable: true,
		isTrashed: false,
		...overrides,
	};
}

describe('formatPlaudWebUrl', () => {
	it('defaults to the prod (v3) web portal for a real hex ID', () => {
		expect(formatPlaudWebUrl('4cba85e559d7f7c9058bf71c23d86d2d')).toBe(
			'https://web.plaud.ai/file/4cba85e559d7f7c9058bf71c23d86d2d',
		);
	});

	it('uses the supplied portal base for a v4 account', () => {
		expect(formatPlaudWebUrl('4cba85e5', 'https://beta.plaud.ai')).toBe(
			'https://beta.plaud.ai/file/4cba85e5',
		);
	});

	it('strips a trailing slash from the supplied base', () => {
		expect(formatPlaudWebUrl('abc123', 'https://beta.plaud.ai/')).toBe(
			'https://beta.plaud.ai/file/abc123',
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
		expect(formatPlaudWebUrl('abc123')).toBe(
			'https://web.plaud.ai/file/abc123',
		);
	});
});

describe('recordingSourceLabel', () => {
	const names = new Map([['NP', 'CK PLAUD NotePin']]);

	it('returns the device name when the serial is known', () => {
		expect(
			recordingSourceLabel({ kind: 'device', serial: 'NP' }, names),
		).toBe('CK PLAUD NotePin');
	});

	it('falls back to a generic label for an unknown device serial', () => {
		expect(
			recordingSourceLabel({ kind: 'device', serial: 'X' }, names),
		).toBe('Plaud device');
	});

	it('labels a non-device recording App', () => {
		expect(recordingSourceLabel({ kind: 'app' }, names)).toBe('App');
	});

	it('returns an empty label for a recording with no source', () => {
		expect(recordingSourceLabel(undefined, names)).toBe('');
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

	it('formats $[audio_start_time] in the capture zone when an offset is given', () => {
		const capturedRec = makeRecording({
			title: 'Q2 Planning',
			createdAt: new Date('2026-05-13T18:04:22Z'), // 14:04:22 at UTC-4
			durationSeconds: 600,
		});
		const out = substitutePlaudPlaceholders(
			'Date & Time:  $[audio_start_time]',
			capturedRec,
			transcript,
			-240,
		);
		expect(out).toBe('Date & Time:  2026-05-13 14:04:22');
	});

	it('substitutes $[audio_title] with the recording title', () => {
		const out = substitutePlaudPlaceholders(
			'Title: $[audio_title]',
			rec,
			transcript,
		);
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
		const out = substitutePlaudPlaceholders(
			'Speakers: $[speakers]',
			rec,
			transcript,
		);
		expect(out).toBe('Speakers: Charles, Mary');
	});

	it('leaves $[speakers] untouched when the transcript has no speakers', () => {
		const noSpeakers: Transcript = {
			id: rec.id,
			rawText: '',
			segments: [{ startSeconds: 0, endSeconds: 5, text: 'hi' }],
		};
		const out = substitutePlaudPlaceholders(
			'Speakers: $[speakers]',
			rec,
			noSpeakers,
		);
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
		expect(
			substitutePlaudPlaceholders('No tokens here', rec, transcript),
		).toBe('No tokens here');
	});

	it('returns an empty string unchanged without recursing into the regex', () => {
		expect(substitutePlaudPlaceholders('', rec, transcript)).toBe('');
	});
});
