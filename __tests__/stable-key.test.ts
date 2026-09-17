import {
	stableKeysFromRecording,
	stableKeysFromFrontmatter,
} from '../stable-key';

// 2026-08-07T18:52:11Z. Written two ways below to prove the offset does not
// change the instant key.
const INSTANT_MS = Date.parse('2026-08-07T18:52:11Z');
const DURATION = 600;

describe('stableKeysFromRecording', () => {
	it('builds an instant and a day key from a valid start + duration', () => {
		const k = stableKeysFromRecording(INSTANT_MS, DURATION);
		expect(k.instant).toBe(`i:${Math.floor(INSTANT_MS / 60000)}:600`);
		expect(k.day).toMatch(/^d:\d{4}-\d{2}-\d{2}:600$/);
	});

	it('rounds a non-integer duration and rejects a negative one', () => {
		expect(stableKeysFromRecording(INSTANT_MS, 600.4).instant).toBe(
			`i:${Math.floor(INSTANT_MS / 60000)}:600`,
		);
		expect(stableKeysFromRecording(INSTANT_MS, -1)).toEqual({
			instant: null,
			day: null,
		});
	});

	it('rejects a non-finite start', () => {
		expect(stableKeysFromRecording(Number.NaN, DURATION)).toEqual({
			instant: null,
			day: null,
		});
	});
});

describe('stableKeysFromFrontmatter', () => {
	it('reads a precise start-time into the same instant key as the recording', () => {
		const rec = stableKeysFromRecording(INSTANT_MS, DURATION);
		const note = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T18:52:11Z',
			'duration-seconds': DURATION,
		});
		expect(note.instant).toBe(rec.instant);
	});

	it('treats the same instant in a different offset as the same key', () => {
		const utc = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T18:52:11Z',
			'duration-seconds': DURATION,
		});
		const eastern = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T14:52:11-04:00',
			'duration-seconds': DURATION,
		});
		expect(eastern.instant).toBe(utc.instant);
	});

	it('rounds sub-minute differences to the same instant key', () => {
		const a = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T18:52:03Z',
			'duration-seconds': DURATION,
		});
		const b = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T18:52:59Z',
			'duration-seconds': DURATION,
		});
		expect(a.instant).toBe(b.instant);
		const nextMinute = stableKeysFromFrontmatter({
			'start-time': '2026-08-07T18:53:00Z',
			'duration-seconds': DURATION,
		});
		expect(nextMinute.instant).not.toBe(a.instant);
	});

	it('agrees with the recording on the day key for the same instant', () => {
		// Derive the note date from the recording so the assertion is independent
		// of the runner timezone; both go through the same local-day formatting.
		const rec = stableKeysFromRecording(INSTANT_MS, DURATION);
		const dayYmd = rec.day!.slice(2, 12); // strip the "d:" prefix, keep YYYY-MM-DD
		const note = stableKeysFromFrontmatter({
			date: dayYmd,
			'duration-seconds': DURATION,
		});
		expect(note.day).toBe(rec.day);
	});

	it('gives a day key but no instant key for a date-only legacy note', () => {
		const note = stableKeysFromFrontmatter({
			date: '2026-06-25',
			'duration-seconds': 226,
		});
		expect(note.instant).toBeNull();
		expect(note.day).toBe('d:2026-06-25:226');
	});

	it('returns nulls when duration is missing or unusable', () => {
		expect(stableKeysFromFrontmatter({ date: '2026-06-25' })).toEqual({
			instant: null,
			day: null,
		});
		expect(
			stableKeysFromFrontmatter({
				date: '2026-06-25',
				'duration-seconds': 'nope',
			}),
		).toEqual({ instant: null, day: null });
	});

	it('rejects a malformed date and a malformed start-time independently', () => {
		const note = stableKeysFromFrontmatter({
			date: 'not-a-date',
			'start-time': 'also-not',
			'duration-seconds': 100,
		});
		expect(note.day).toBeNull();
		expect(note.instant).toBeNull();
	});

	it('accepts a quoted numeric duration', () => {
		expect(
			stableKeysFromFrontmatter({
				date: '2026-06-25',
				'duration-seconds': '226',
			}).day,
		).toBe('d:2026-06-25:226');
	});
});
