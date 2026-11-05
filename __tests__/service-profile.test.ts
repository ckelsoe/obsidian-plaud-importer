/**
 * The service-neutral modules take every stored name from a ServiceProfile. A
 * fake second service proves no Plaud name leaks into its notes and that its
 * markers and keys are the only ones it recognizes.
 */
import type { App } from 'obsidian';
import type { ServiceErrorPolicy } from '../import-core';
import { runImport } from '../import-runner';
import { locateManagedBlock, managedMarkers } from '../managed-block';
import {
	NoteWriter,
	buildNoteTags,
	customFrontmatterContext,
	expandCustomFrontmatterValue,
	resolveSubfolder,
	transcriptFileMarker,
} from '../note-writer';
import { PLAUD_PROFILE } from '../plaud-profile';
import type {
	AttachmentAsset,
	Chapter,
	RecordingId,
	Recording,
	Transcript,
} from '../recording-model';
import { folderToken, type ServiceProfile } from '../service-profile';
import { buildImportedIndex } from '../vault-index';
import { asyncResult } from './helpers/async-result';
import { makeFakeVault } from './helpers/fake-vault';

const COMU: ServiceProfile = {
	keyPrefix: 'comu',
	pluginId: 'comu-importer',
	canonicalId: (id) => id.toLowerCase(),
	serviceName: 'Comu',
	pluginName: 'Comu Importer',
	recordingUrl: (id, base = 'https://comu.example') => `${base}/r/${id}`,
	placeholderCallout: [
		'> [!warning] Not imported: Comu has nothing yet',
		'>',
	],
	markDataType: 'comu_mark',
};

const RECORDING: Recording = {
	id: 'abc123' as RecordingId,
	title: 'Standup',
	createdAt: new Date(2026, 3, 14, 9, 30),
	endsAt: new Date(2026, 3, 14, 9, 40),
	durationSeconds: 600,
	captureOffsetMinutes: null,
	transcriptAvailable: true,
	summaryAvailable: true,
	isTrashed: false,
	versionMs: 42,
};

const TRANSCRIPT: Transcript = {
	id: RECORDING.id,
	segments: [{ startSeconds: 0, endSeconds: 5, speaker: 'A', text: 'Hi.' }],
	rawText: 'Hi.',
};
const CHAPTERS: readonly Chapter[] = [{ title: 'Intro', startSeconds: 0 }];

describe('a non-Plaud service profile', () => {
	it('writes its own keys, source and markers, and re-imports inside them', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, {
			profile: COMU,
			outputFolder: 'Comu',
			onDuplicate: 'overwrite',
		});
		const first = await writer.writeNote(
			RECORDING,
			TRANSCRIPT,
			{ id: RECORDING.id, text: 'Summary', summaryId: 's1' },
			CHAPTERS,
		);
		const path = first.path;
		const written = vault.files.get(path) ?? '';
		expect(written).toMatch(/^comu-id: abc123$/m);
		expect(written).toMatch(/^comu-version-ms: 42$/m);
		expect(written).toMatch(/^comu-summary-id: s1$/m);
		expect(written).toMatch(/^source: comu$/m);
		expect(written).toContain('<!-- comu:managed:start -->');
		expect(written).toContain('<!-- comu:managed:end -->');
		expect(written).toContain('^comu-chapters');
		expect(written).toContain('[[#^comu-chapters|Back to Chapters]]');
		expect(written).not.toMatch(/^plaud-/m);
		expect(written).not.toContain('plaud:managed');

		// The user's text below the comu block survives a re-import.
		vault.files.set(path, `${written}\nmine\n`);
		await writer.writeNote(RECORDING, TRANSCRIPT, {
			id: RECORDING.id,
			text: 'New',
		});
		expect(vault.files.get(path)).toMatch(
			/New[\s\S]*comu:managed:end[\s\S]*mine/,
		);
	});

	it('finds its own markers and ignores another service’s', () => {
		const comu = managedMarkers(COMU);
		const plaud = managedMarkers(PLAUD_PROFILE);
		const note = `${comu.start}\n\nbody\n\n${comu.end}\n`;
		expect(locateManagedBlock(comu, note).kind).toBe('ok');
		expect(locateManagedBlock(plaud, note).kind).toBe('none');
	});

	it('names its transcript-file marker and AI-keyword tags', () => {
		expect(transcriptFileMarker(COMU)).toBe(
			'%% comu-importer: managed transcript %%',
		);
		const { tags } = buildNoteTags(COMU, [], ['AI Agent'], {
			tagMode: 'all',
			customTags: '',
			aiKeywordsAsProperty: false,
		});
		expect(tags).toEqual(['comu/ai-agent']);
	});

	it('fills its own folder token and leaves the Plaud one alone', () => {
		const folder = { token: folderToken(COMU), name: 'Work' };
		expect(folder.token).toBe('comu-folder');
		expect(
			resolveSubfolder(
				'{{comu-folder}}',
				RECORDING.createdAt,
				undefined,
				'-',
				folder,
			),
		).toBe('Work');
		const ctx = customFrontmatterContext(COMU, RECORDING, null, 'Work');
		expect(expandCustomFrontmatterValue('{{comu-folder}}', ctx)).toBe(
			'Work',
		);
		// Not this service's token, so Moment renders it as a date format.
		expect(expandCustomFrontmatterValue('{{plaud-folder}}', ctx)).not.toBe(
			'Work',
		);
	});

	it('indexes notes by its own id key and canonical id', () => {
		const app = {
			vault: { getMarkdownFiles: () => [{ path: 'Comu/a.md' }] },
			metadataCache: {
				getFileCache: () => ({
					frontmatter: { 'comu-id': 'ABC123', 'plaud-id': 'other' },
				}),
			},
		} as unknown as App;
		const index = buildImportedIndex(COMU, app, 'Comu');
		expect([...index.byId.keys()]).toEqual(['abc123']);
		expect(index.byId.get('abc123' as RecordingId)?.recordingId).toBe(
			'ABC123',
		);
	});

	it('writes no Plaud branding into a note or a placeholder', async () => {
		const vault = makeFakeVault();
		const writer = new NoteWriter(vault, {
			profile: COMU,
			outputFolder: 'Comu',
			onDuplicate: 'overwrite',
		});
		const note = await writer.writeNote(
			RECORDING,
			TRANSCRIPT,
			{ id: RECORDING.id, text: 'Summary', summaryId: 's1' },
			CHAPTERS,
		);
		const placeholder = await writer.writePlaceholderNote(
			{ ...RECORDING, id: 'zzz999' as RecordingId, title: 'Empty' },
			'no speech',
		);
		const written = vault.files.get(note.path) ?? '';
		const stub = vault.files.get(placeholder.path) ?? '';
		expect(written).toContain(
			'[Open in Comu →](https://comu.example/r/abc123)',
		);
		expect(written).toMatch(
			/^comu-url: "https:\/\/comu\.example\/r\/abc123"$/m,
		);
		expect(stub).toContain(
			'[Open in Comu →](https://comu.example/r/zzz999)',
		);
		expect(stub).toContain(
			'> [!warning] Not imported: Comu has nothing yet',
		);
		expect(stub).toContain('> Comu reported: no speech');
		for (const text of [written, stub]) {
			expect(text).not.toMatch(/plaud/i);
		}
	});
});

describe('runImport with a non-Plaud service', () => {
	const policy: ServiceErrorPolicy = {
		pluginName: 'Comu Importer',
		classify: () => null,
		isUnprocessed: () => false,
	};

	it('writes the note with no folder hook and stamps marks with its own data type', async () => {
		const vault = makeFakeVault();
		const options = {
			profile: COMU,
			outputFolder: 'Comu',
			onDuplicate: 'overwrite' as const,
			errorPolicy: policy,
		};
		const queued: AttachmentAsset[] = [];
		const outcome = await runImport({
			recordings: [{ ...RECORDING, tags: ['raw-folder-id'] }],
			selection: {
				includeSummary: true,
				includeTranscript: true,
				includeAttachments: false,
				includeMindmap: false,
				includeCard: false,
				includeScreenshots: true,
				includeAudio: false,
			},
			writer: new NoteWriter(vault, options),
			attachments: {
				extractAttachmentAssetsFromSummaryMarkdown: () => [],
				mergeAttachmentAssets: (base, extra) => [...base, ...extra],
				importAttachmentsForNote: (_path, attachments) =>
					asyncResult(() => {
						queued.push(...attachments);
					}),
				importAudioForNote: () => asyncResult(() => null),
			},
			options,
			fetchArtifacts: () =>
				asyncResult(() => ({
					transcript: TRANSCRIPT,
					summary: { id: RECORDING.id, text: 'Summary' },
					marks: [
						{ offsetSeconds: 1, url: 'https://comu.example/m.png' },
					],
				})),
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.results[0]).toMatchObject({ kind: 'written' });
		const note = [...vault.files.values()][0] ?? '';
		expect(note).toMatch(/^comu-id: abc123$/m);
		expect(note).not.toMatch(/^comu-(folder|location):/m);
		expect(note).not.toContain('raw-folder-id');
		expect(note).not.toMatch(/plaud/i);
		expect(queued).toEqual([
			{ dataType: 'comu_mark', url: 'https://comu.example/m.png' },
		]);
	});

	it('still imports when the folder hook throws', async () => {
		const vault = makeFakeVault();
		const options = {
			profile: COMU,
			outputFolder: 'Comu',
			onDuplicate: 'overwrite' as const,
			errorPolicy: policy,
		};
		const outcome = await runImport({
			recordings: [RECORDING],
			selection: {
				includeSummary: true,
				includeTranscript: true,
				includeAttachments: false,
				includeMindmap: false,
				includeCard: false,
				includeScreenshots: false,
				includeAudio: false,
			},
			writer: new NoteWriter(vault, options),
			attachments: {
				extractAttachmentAssetsFromSummaryMarkdown: () => [],
				mergeAttachmentAssets: (base, extra) => [...base, ...extra],
				importAttachmentsForNote: () => asyncResult(() => undefined),
				importAudioForNote: () => asyncResult(() => null),
			},
			options,
			loadFolders: () =>
				asyncResult(() => {
					throw new Error('catalog down');
				}),
			fetchArtifacts: () =>
				asyncResult(() => ({
					transcript: TRANSCRIPT,
					summary: { id: RECORDING.id, text: 'Summary' },
				})),
		});
		expect(outcome.stop).toBe('completed');
		expect(outcome.results[0]).toMatchObject({ kind: 'written' });
	});
});
