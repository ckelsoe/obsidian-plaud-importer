/**
 * Golden-output tests: lock the exact bytes the importer writes into a vault.
 *
 * These exist for the recording-importer core extraction. Every note, frontmatter
 * key, marker string and asset path below is a stored format that existing vaults
 * depend on (an imported note is recognized by its `plaud-id`, a re-import finds
 * its managed block by the marker lines). The extraction moves this code into a
 * shared library and parameterizes the `plaud` names, so these snapshots must stay
 * byte-identical through every step of it. A snapshot diff here is a breaking
 * change for users, not a cosmetic one: never update them with `-u` as part of a
 * refactor.
 *
 * The run goes through the real `runImport` loop and a real `NoteWriter` into an
 * in-memory vault. The attachment pipeline is a stub that records its calls,
 * because the real one needs the Obsidian app and network; its call log is part
 * of the snapshot so the asset routing is locked too.
 *
 * Every recording carries an explicit capture offset, so the output does not
 * depend on the machine's time zone.
 */
import {
	runImport,
	type AttachmentPipeline,
	type ImportRunDeps,
} from '../import-runner';
import { NoteWriter, type NoteWriterOptions } from '../note-writer';
import { PlaudApiError } from '../plaud-client-re';
import type { ArtifactSelection, ImportModalOptions } from '../import-core';
import type { PlaudFolder, TranscriptAndSummary } from '../plaud-client';
import type {
	AttachmentAsset,
	RecordingId,
	Recording,
} from '../recording-model';
import { asyncResult } from './helpers/async-result';
import { makeFakeVault } from './helpers/fake-vault';

/** Records every pipeline call; extraction delegates to simple pure rules. */
function makePipeline(calls: unknown[]): AttachmentPipeline {
	return {
		extractAttachmentAssetsFromSummaryMarkdown(summaryMarkdown) {
			calls.push(['extractFromSummary', summaryMarkdown]);
			return [];
		},
		mergeAttachmentAssets(base, extra) {
			calls.push(['merge', base, extra]);
			return [...base, ...extra];
		},
		importAttachmentsForNote(
			notePath,
			attachments,
			selection,
			replaceExisting,
			recordingId,
			nestedAssetLinks,
		) {
			return asyncResult(() => {
				calls.push([
					'importAttachments',
					notePath,
					attachments,
					selection,
					replaceExisting,
					recordingId,
					nestedAssetLinks,
				]);
			});
		},
		importAudioForNote(notePath, audioUrl, recordingId) {
			return asyncResult(() => {
				calls.push(['importAudio', notePath, audioUrl, recordingId]);
				return 1234;
			});
		},
	};
}

const ALL: ArtifactSelection = {
	includeSummary: true,
	includeTranscript: true,
	includeAttachments: true,
	includeMindmap: true,
	includeCard: true,
	includeScreenshots: true,
	includeAudio: true,
};

const id = (value: string): RecordingId => value as RecordingId;

// 2026-04-14 14:30 UTC, captured at UTC-4 (10:30 local).
const CREATED = new Date(Date.UTC(2026, 3, 14, 14, 30));

function recording(overrides: Partial<Recording> = {}): Recording {
	const createdAt = overrides.createdAt ?? CREATED;
	const durationSeconds = overrides.durationSeconds ?? 3725;
	return {
		id: id('a1b2c3d4'),
		title: 'Quarterly planning',
		createdAt,
		endsAt: new Date(createdAt.getTime() + durationSeconds * 1000),
		durationSeconds,
		captureOffsetMinutes: -240,
		transcriptAvailable: true,
		summaryAvailable: true,
		isTrashed: false,
		...overrides,
	};
}

function richArtifacts(rec: Recording): TranscriptAndSummary {
	return {
		transcript: {
			id: rec.id,
			segments: [
				{
					startSeconds: 0,
					endSeconds: 12,
					speaker: 'Charles',
					text: 'Let us start with the roadmap.',
				},
				{
					startSeconds: 12,
					endSeconds: 95,
					speaker: 'Mary',
					text: 'Pricing comes first.',
				},
				{
					startSeconds: 95,
					endSeconds: 610,
					speaker: 'Charles',
					text: 'Agreed. Three options by Friday.',
				},
				{
					startSeconds: 610,
					endSeconds: 3725,
					text: 'Unattributed closing remarks.',
				},
			],
			rawText:
				'Let us start with the roadmap. Pricing comes first. Agreed. Three options by Friday. Unattributed closing remarks.',
		},
		summary: {
			id: rec.id,
			text: '## Key points\n\n- Pricing first\n- Three options by Friday\n\n![[mindmap.png]]',
			headline: 'Pricing leads the quarter',
			category: 'Meeting',
			industry: 'Software',
			language: 'en',
			template: 'Meeting notes',
			model: 'gpt-5',
			aiSuggestion: 'Send the options to finance early.',
			noteId: 'note-77',
			summaryId: 'sum-88',
			version: '3',
		},
		aiKeywords: ['pricing', 'Roadmap Review', 'q2'],
		chapters: [
			{ title: 'Roadmap', startSeconds: 0, endSeconds: 95 },
			{
				title: 'Pricing #1 / options',
				startSeconds: 95,
				endSeconds: 610,
			},
			{ title: 'Wrap-up', startSeconds: 610 },
		],
		attachments: [
			{
				dataType: 'mindmap',
				url: 'https://cdn.example/mindmap.png',
				name: 'mindmap.png',
				mimeType: 'image/png',
			},
			{
				dataType: 'card',
				url: 'https://cdn.example/card.png',
				name: 'card.png',
			},
			{ dataType: 'image', url: 'https://cdn.example/photo.jpg' },
		] satisfies AttachmentAsset[],
		nestedAssetLinks: { 'pic/1.png': 'https://cdn.example/signed/1.png' },
		consumerNotes: [
			{ heading: 'My note', markdown: 'Remember the **budget** cap.' },
		],
		marks: [
			{
				offsetSeconds: 42,
				url: 'https://cdn.example/mark-42.jpg',
				markType: 1,
			},
			{ offsetSeconds: 700, url: 'https://cdn.example/mark-700.jpg' },
		],
		additionalSummaries: [
			{ heading: 'Key Points', text: '- Pricing\n- Timeline' },
			{ heading: 'Daily Journal', text: 'A productive planning day.' },
		],
	};
}

const FOLDERS: readonly PlaudFolder[] = [
	{ id: 'f-work', name: 'Work' },
	{ id: 'f-plan', name: 'Planning/Q2' },
];

interface Scenario {
	readonly name: string;
	readonly recordings: readonly Recording[];
	readonly artifacts: (rec: Recording) => TranscriptAndSummary;
	readonly options?: Partial<ImportModalOptions>;
	readonly selection?: Partial<ArtifactSelection>;
	readonly seed?: Readonly<Record<string, string>>;
	readonly withAudio?: boolean;
	readonly withFolders?: boolean;
}

async function run(scenario: Scenario): Promise<Record<string, unknown>> {
	const vault = makeFakeVault();
	for (const [path, data] of Object.entries(scenario.seed ?? {})) {
		vault.files.set(path, data);
		const parent = path.slice(0, path.lastIndexOf('/'));
		if (parent) vault.folders.add(parent);
	}
	const calls: unknown[] = [];
	const options: ImportModalOptions = {
		outputFolder: 'Plaud',
		onDuplicate: 'overwrite',
		...scenario.options,
	};
	const writer = new NoteWriter(vault, options satisfies NoteWriterOptions);
	const deps: ImportRunDeps = {
		recordings: scenario.recordings,
		selection: { ...ALL, ...scenario.selection },
		writer,
		attachments: makePipeline(calls),
		options,
		fetchArtifacts: (recordingId) =>
			asyncResult(() => {
				const rec = scenario.recordings.find(
					(r) => r.id === recordingId,
				);
				if (!rec) throw new Error(`unknown ${recordingId}`);
				return scenario.artifacts(rec);
			}),
		applyFold: (path) =>
			asyncResult(() => {
				calls.push(['applyFold', path]);
			}),
		...(scenario.withFolders
			? { fetchFolderCatalog: () => asyncResult(() => FOLDERS) }
			: {}),
		...(scenario.withAudio
			? {
					fetchAudioUrl: (recordingId: RecordingId) =>
						asyncResult(
							() =>
								`https://cdn.example/audio/${recordingId}.mp3`,
						),
				}
			: {}),
	};
	const outcome = await runImport(deps);
	const files = Object.fromEntries(
		[...vault.files.entries()].sort(([a], [b]) => a.localeCompare(b)),
	);
	return {
		stop: outcome.stop,
		results: outcome.results.map((r) => ({ ...r })),
		folders: [...vault.folders].sort(),
		files,
		pipeline: calls,
	};
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: 'rich recording, default options, heading layout',
		recordings: [
			recording({ tags: ['f-work', 'f-plan'], versionMs: 1782918853105 }),
		],
		artifacts: richArtifacts,
		withAudio: true,
		withFolders: true,
	},
	{
		name: 'all tag mode with keywords, v4 portal URL',
		recordings: [recording({ tags: ['f-work'], versionMs: 1 })],
		artifacts: richArtifacts,
		withFolders: true,
		options: {
			tagMode: 'all',
			customTags: 'plaud-meeting, team/planning',
			aiKeywordsAsProperty: true,
			webBaseUrl: 'https://app.plaud.ai',
		},
	},
	{
		name: 'callout layout',
		recordings: [recording()],
		artifacts: richArtifacts,
		options: { transcriptPlacement: 'callout' },
	},
	{
		name: 'heading layout, H3 transcript, not folded',
		recordings: [recording()],
		artifacts: richArtifacts,
		options: { transcriptHeaderLevel: 3, foldTranscript: false },
	},
	{
		name: 'separate transcript file, embedded',
		recordings: [recording()],
		artifacts: richArtifacts,
		options: { transcriptPlacement: 'file-embed' },
	},
	{
		name: 'separate transcript file, linked',
		recordings: [recording()],
		artifacts: richArtifacts,
		options: { transcriptPlacement: 'file-link' },
	},
	{
		name: 'templates: subfolder, note name, datetime, custom frontmatter, replacement char',
		recordings: [
			recording({
				title: 'Plan: Q2 * review',
				source: { kind: 'device', serial: 'SN-1' },
			}),
		],
		artifacts: richArtifacts,
		options: {
			subfolderTemplate: '{{YYYY}}/{{MM MMMM}}',
			noteNameTemplate: '{{title}} {{YYYY-MM-DD}}',
			datetimeTemplate: '{{YYYY-MM-DDTHH:mm}}',
			forbiddenCharReplacement: '_',
			customFrontmatter: [
				{ key: 'project', value: 'atlas', preserve: false },
				{ key: 'device', value: '{{device}}', preserve: false },
				{ key: 'status', value: 'new', preserve: true },
			],
		},
	},
	{
		name: 'summary and transcript excluded, no attachments',
		recordings: [recording()],
		artifacts: richArtifacts,
		selection: {
			includeSummary: false,
			includeTranscript: false,
			includeAttachments: false,
			includeMindmap: false,
			includeCard: false,
			includeScreenshots: false,
			includeAudio: false,
		},
	},
	{
		name: 'transcript only, no summary available',
		recordings: [recording({ summaryAvailable: false })],
		artifacts: (rec) => {
			const full = richArtifacts(rec);
			return {
				transcript: full.transcript,
				summary: null,
				chapters: full.chapters,
			};
		},
	},
	{
		name: 'system folder recording records plaud-location',
		recordings: [recording({ id: id('unfiled1'), systemFolderType: 1 })],
		artifacts: richArtifacts,
		withFolders: true,
	},
	{
		name: 'unprocessed recording writes a placeholder',
		recordings: [
			recording({ id: id('pending1'), title: 'Still processing' }),
		],
		artifacts: () => {
			throw new PlaudApiError(
				'in-band error from /ai/transsumm: -12 start trans task error',
				200,
				'/ai/transsumm',
				-12,
			);
		},
		options: { writePlaceholderForUnprocessed: true },
	},
	{
		name: 're-import keeps user text and preserved frontmatter outside the managed block',
		recordings: [recording({ versionMs: 2 })],
		artifacts: richArtifacts,
		options: {
			customFrontmatter: [
				{ key: 'status', value: 'new', preserve: true },
			],
			preserveUnknownFrontmatter: true,
		},
		seed: {
			'Plaud/2026-04-14 Quarterly planning.md': [
				'---',
				'plaud-id: a1b2c3d4',
				'status: reviewed',
				'my-own-key: keep me',
				'plaud-version-ms: 1',
				'---',
				'My notes above the import.',
				'',
				'<!-- plaud:managed:start -->',
				'# Old imported content',
				'<!-- plaud:managed:end -->',
				'',
				'My notes below the import.',
				'',
			].join('\n'),
		},
	},
	{
		name: 'title collision between two recordings on the same day',
		recordings: [
			recording({ id: id('dup-1'), title: 'Standup' }),
			recording({
				id: id('dup-2'),
				title: 'Standup',
				createdAt: new Date(Date.UTC(2026, 3, 14, 18, 0)),
			}),
		],
		artifacts: richArtifacts,
	},
];

describe('golden output (stored format must not change)', () => {
	it.each(SCENARIOS.map((s) => [s.name, s] as const))(
		'%s',
		async (_name, scenario) => {
			expect(await run(scenario)).toMatchSnapshot();
		},
	);
});
