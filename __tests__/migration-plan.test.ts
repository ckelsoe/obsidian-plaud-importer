import type { App, TFile } from 'obsidian';
import { buildImportedIndex } from '../vault-index';
import { planMigration, type PlannableRecording } from '../migration-plan';

interface FM {
	readonly [key: string]: unknown;
}

function makeApp(entries: ReadonlyArray<readonly [string, FM]>): App {
	const files = entries.map(([path]) => ({ path }));
	const fmByPath = new Map<string, FM>(entries);
	return {
		vault: {
			getMarkdownFiles: (): readonly TFile[] =>
				files as unknown as TFile[],
		},
		metadataCache: {
			getFileCache: (file: TFile): { frontmatter?: FM } | null => {
				const fm = fmByPath.get(file.path);
				return fm ? { frontmatter: fm } : null;
			},
		},
	} as unknown as App;
}

function r(
	id: string,
	iso: string,
	durationSeconds: number,
): PlannableRecording {
	return {
		id,
		title: `title-${id}`,
		createdAt: new Date(iso),
		durationSeconds,
	};
}

// A precise-start note and a date-only note, both imported under old ids.
const START_NOTE: [string, FM] = [
	'Plaud/precise.md',
	{
		'plaud-id': 'old-precise',
		'start-time': '2026-08-07T18:52:11Z',
		date: '2026-08-07',
		'duration-seconds': 600,
	},
];

describe('planMigration', () => {
	it('plans a start-time heal for a changed-id recording', () => {
		const index = buildImportedIndex(makeApp([START_NOTE]), 'Plaud');
		const plan = planMigration(
			[r('v4-new', '2026-08-07T18:52:41Z', 600)],
			index,
		);
		expect(plan.heals).toHaveLength(1);
		expect(plan.heals[0]).toMatchObject({
			notePath: 'Plaud/precise.md',
			fromId: 'old-precise',
			toId: 'v4-new',
			via: 'start-time',
			recordingTitle: 'title-v4-new',
			versionMs: undefined,
		});
		expect(plan.heals[0]!.recordingWhen).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
		expect(plan.alreadyCurrent).toBe(0);
		expect(plan.unmatchedRecordings).toBe(0);
		expect(plan.noteCount).toBe(1);
	});

	it('plans an EXACT id heal for a bare-id note whose recording is of_-prefixed', () => {
		// The real-vault case: the note stored the bare v3 id; the v4 recording is
		// of_<same-id>. Healed by exact identity (via 'id'), not by time guessing.
		const bareNote: [string, FM] = [
			'Plaud/bare.md',
			{
				'plaud-id': '340aec0e020aaee63768f043b7841393',
				date: '2026-04-23',
				'duration-seconds': 42,
			},
		];
		const index = buildImportedIndex(makeApp([bareNote]), 'Plaud');
		const plan = planMigration(
			[
				r(
					'of_340aec0e020aaee63768f043b7841393',
					'2026-04-23T15:00:00Z',
					42,
				),
			],
			index,
		);
		expect(plan.heals).toHaveLength(1);
		expect(plan.heals[0]).toMatchObject({
			notePath: 'Plaud/bare.md',
			fromId: '340aec0e020aaee63768f043b7841393',
			toId: 'of_340aec0e020aaee63768f043b7841393',
			via: 'id',
		});
		expect(plan.alreadyCurrent).toBe(0);
	});

	it('counts an of_ note already on the current id as alreadyCurrent (no heal)', () => {
		const ofNote: [string, FM] = [
			'Plaud/prefixed.md',
			{ 'plaud-id': 'of_ab4db03305b77f8e67f345ab89b163ab' },
		];
		const index = buildImportedIndex(makeApp([ofNote]), 'Plaud');
		const plan = planMigration(
			[
				r(
					'of_ab4db03305b77f8e67f345ab89b163ab',
					'2026-06-25T12:00:00Z',
					226,
				),
			],
			index,
		);
		expect(plan.heals).toEqual([]);
		expect(plan.alreadyCurrent).toBe(1);
	});

	it('counts a recording already on the current id as alreadyCurrent (no heal)', () => {
		const index = buildImportedIndex(makeApp([START_NOTE]), 'Plaud');
		const plan = planMigration(
			[r('old-precise', '2026-08-07T18:52:11Z', 600)],
			index,
		);
		expect(plan.heals).toEqual([]);
		expect(plan.alreadyCurrent).toBe(1);
	});

	it('plans a date heal for a date-only note when the day-key is unique', () => {
		const dateNote: [string, FM] = [
			'Plaud/dateonly.md',
			{
				'plaud-id': 'old-date',
				date: '2026-06-25',
				'duration-seconds': 226,
			},
		];
		const index = buildImportedIndex(makeApp([dateNote]), 'Plaud');
		// Build a recording whose LOCAL day is 2026-06-25 (noon avoids TZ edges).
		const iso = new Date(2026, 5, 25, 12, 0, 0).toISOString();
		const plan = planMigration([r('v4-date', iso, 226)], index);
		expect(plan.heals.map((h) => h.via)).toEqual(['date']);
		expect(plan.heals[0]!.notePath).toBe('Plaud/dateonly.md');
		expect(plan.heals[0]!.toId).toBe('v4-date');
	});

	it('does NOT heal a date match when two recordings share the day-key', () => {
		const dateNote: [string, FM] = [
			'Plaud/dateonly.md',
			{
				'plaud-id': 'old-date',
				date: '2026-06-25',
				'duration-seconds': 226,
			},
		];
		const index = buildImportedIndex(makeApp([dateNote]), 'Plaud');
		const isoA = new Date(2026, 5, 25, 9, 0, 0).toISOString();
		const isoB = new Date(2026, 5, 25, 17, 0, 0).toISOString();
		const plan = planMigration(
			[r('v4-a', isoA, 226), r('v4-b', isoB, 226)],
			index,
		);
		expect(plan.heals).toEqual([]);
	});

	it('counts a recording matching no note as unmatched', () => {
		const index = buildImportedIndex(makeApp([START_NOTE]), 'Plaud');
		const plan = planMigration(
			[r('brand-new', '2026-09-01T10:00:00Z', 99)],
			index,
		);
		expect(plan.heals).toEqual([]);
		expect(plan.unmatchedRecordings).toBe(1);
		expect(plan.recordingCount).toBe(1);
	});

	it('carries version_ms via the versionOf resolver', () => {
		const index = buildImportedIndex(makeApp([START_NOTE]), 'Plaud');
		const plan = planMigration(
			[r('v4-new', '2026-08-07T18:52:11Z', 600)],
			index,
			() => 12345,
		);
		expect(plan.heals[0]!.versionMs).toBe(12345);
	});
});
