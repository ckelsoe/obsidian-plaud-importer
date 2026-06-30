import { runImport, type ImportRunDeps, type ImportRunObserver, type AttachmentPipeline } from '../import-runner';
import {
	NoteWriter,
	type FileLike,
	type FolderLike,
	type VaultLike,
	type DuplicatePromptDecision,
} from '../note-writer';
import { PlaudApiError, PlaudAuthError } from '../plaud-client-re';
import type { ArtifactSelection, ImportModalOptions } from '../import-core';
import type {
	PlaudRecordingId,
	Recording,
	Summary,
	Transcript,
	TranscriptAndSummary,
} from '../plaud-client';

// -----------------------------------------------------------------------------
// Test doubles
//
// The runner is headless: a REAL NoteWriter writes into an in-memory fake vault
// (the same shape note-writer.test.ts uses), the attachment pipeline is a stub
// that records its calls, and the observer/fetchArtifacts are spies so we can
// assert ordering and call counts. No `obsidian` import is needed because the
// runner has none.
// -----------------------------------------------------------------------------

type FakeVault = VaultLike & {
	files: Map<string, string>;
	folders: Set<string>;
};

function makeFakeVault(): FakeVault {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const vault: FakeVault = {
		files,
		folders,
		getFileByPath(path: string): FileLike | null {
			return files.has(path) ? { path } : null;
		},
		getFolderByPath(path: string): FolderLike | null {
			return folders.has(path) ? { path } : null;
		},
		async createFolder(path: string): Promise<FolderLike> {
			folders.add(path);
			return { path };
		},
		async create(path: string, data: string): Promise<FileLike> {
			files.set(path, data);
			return { path };
		},
		async read(file: FileLike): Promise<string> {
			return files.get(file.path) ?? '';
		},
		async process(file: FileLike, fn: (data: string) => string): Promise<string> {
			const next = fn(files.get(file.path) ?? '');
			files.set(file.path, next);
			return next;
		},
	};
	return vault;
}

function makeWriter(
	vault: VaultLike,
	options: Partial<ConstructorParameters<typeof NoteWriter>[1]> = {},
): NoteWriter {
	return new NoteWriter(vault, {
		outputFolder: 'Plaud',
		onDuplicate: 'skip',
		...options,
	});
}

let nextId = 0;
function makeRecording(overrides: Partial<Recording> = {}): Recording {
	nextId += 1;
	return {
		id: `rec-${nextId}` as PlaudRecordingId,
		title: `Recording ${nextId}`,
		createdAt: new Date(2026, 5, 28, 9, 0),
		durationSeconds: 600,
		transcriptAvailable: true,
		summaryAvailable: true,
		isTrashed: false,
		...overrides,
	};
}

function makeTranscript(id: PlaudRecordingId): Transcript {
	return {
		id,
		segments: [
			{ startSeconds: 0, endSeconds: 10, speaker: 'Charles', text: 'Hello.' },
		],
		rawText: 'Hello.',
	};
}

function makeSummary(id: PlaudRecordingId): Summary {
	return { id, text: '- A point' };
}

function makeArtifacts(
	recording: Recording,
	overrides: Partial<TranscriptAndSummary> = {},
): TranscriptAndSummary {
	return {
		transcript: makeTranscript(recording.id),
		summary: makeSummary(recording.id),
		...overrides,
	};
}

const SELECTION: ArtifactSelection = {
	includeSummary: true,
	includeTranscript: true,
	includeAttachments: true,
	includeMindmap: true,
	includeCard: true,
};

const OPTIONS: ImportModalOptions = {
	outputFolder: 'Plaud',
	onDuplicate: 'skip',
};

function makeAttachmentStub(): {
	pipeline: AttachmentPipeline;
	importCalls: Array<{ notePath: string; replaceExisting: boolean; recordingId: string }>;
} {
	const importCalls: Array<{
		notePath: string;
		replaceExisting: boolean;
		recordingId: string;
	}> = [];
	const pipeline: AttachmentPipeline = {
		extractAttachmentAssetsFromSummaryMarkdown: () => [],
		mergeAttachmentAssets: (base, extra) => [...base, ...extra],
		importAttachmentsForNote: async (notePath, _attachments, _selection, replaceExisting, recordingId) => {
			importCalls.push({ notePath, replaceExisting, recordingId });
		},
	};
	return { pipeline, importCalls };
}

function makeFetch(
	artifactsById: Map<PlaudRecordingId, TranscriptAndSummary | (() => never)>,
): { fetchArtifacts: ImportRunDeps['fetchArtifacts']; calls: PlaudRecordingId[] } {
	const calls: PlaudRecordingId[] = [];
	const fetchArtifacts = async (id: PlaudRecordingId): Promise<TranscriptAndSummary> => {
		calls.push(id);
		const entry = artifactsById.get(id);
		if (typeof entry === 'function') {
			// A thrower: model a fetch that rejects for this recording.
			return entry();
		}
		if (entry === undefined) {
			throw new Error(`no artifacts registered for ${id}`);
		}
		return entry;
	};
	return { fetchArtifacts, calls };
}

function makeObserver(shouldAbort?: () => boolean): {
	observer: ImportRunObserver;
	starts: Array<[number, number]>;
	written: string[];
	events: string[];
} {
	const starts: Array<[number, number]> = [];
	const written: string[] = [];
	const events: string[] = [];
	const observer: ImportRunObserver = {
		onRecordingStart: (index, total, recording) => {
			starts.push([index, total]);
			events.push(`start:${recording.id}:${index}/${total}`);
		},
		onRecordingWritten: (recording) => {
			written.push(recording.id);
			events.push(`written:${recording.id}`);
		},
		shouldAbort,
	};
	return { observer, starts, written, events };
}

function unprocessedError(): PlaudApiError {
	// Mirrors the -12 "start trans task error" envelope: a PlaudApiError (not an
	// auth/parse subclass) whose message includes the in-band marker that
	// isPlaudUnprocessedError keys on.
	return new PlaudApiError(
		'in-band error from /ai/transsumm: status=-12 msg=start trans task error',
		200,
		'/ai/transsumm',
		-12,
	);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('runImport', () => {
	it('creates a note for a recording with content', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording)]]),
		);
		const { observer, starts, written } = makeObserver();
		const { pipeline } = makeAttachmentStub();

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.processed).toBe(1);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]).toMatchObject({
			kind: 'written',
			writeOutcome: { status: 'created' },
		});
		expect(calls).toEqual([recording.id]);
		expect(starts).toEqual([[1, 1]]);
		expect(written).toEqual([recording.id]);
	});

	it('overwrites an existing note on a second run with onDuplicate overwrite', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const writer = makeWriter(vault, { onDuplicate: 'overwrite' });
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording)]]),
		);
		const deps: ImportRunDeps = {
			recordings: [recording],
			selection: SELECTION,
			writer,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
		};

		const first = await runImport(deps);
		expect(first.results[0]).toMatchObject({ writeOutcome: { status: 'created' } });

		const second = await runImport(deps);
		expect(second.stop).toBe('completed');
		expect(second.results[0]).toMatchObject({
			kind: 'written',
			writeOutcome: { status: 'overwritten' },
		});
	});

	it('skips a duplicate on a second run with onDuplicate skip', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const writer = makeWriter(vault, { onDuplicate: 'skip' });
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording)]]),
		);
		const { observer, written } = makeObserver();
		const deps: ImportRunDeps = {
			recordings: [recording],
			selection: SELECTION,
			writer,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		};

		await runImport(deps);
		const second = await runImport(deps);

		expect(second.results[0]).toMatchObject({
			kind: 'written',
			writeOutcome: { status: 'skipped' },
		});
		// A skip does not refresh a row badge — onRecordingWritten fires only on
		// the create in the first run.
		expect(written).toEqual([recording.id]);
	});

	it('skips a no-content recording without fetching artifacts', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording({
			transcriptAvailable: false,
			summaryAvailable: false,
		});
		const { fetchArtifacts, calls } = makeFetch(new Map());
		const { observer, starts, written } = makeObserver();

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.results[0]).toEqual({ kind: 'skipped-no-content', recording });
		// onRecordingStart still fires (the button text advances), but no fetch
		// and no badge refresh.
		expect(starts).toEqual([[1, 1]]);
		expect(calls).toEqual([]);
		expect(written).toEqual([]);
	});

	it('writes a placeholder when Plaud reports the recording unprocessed', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, () => { throw unprocessedError(); }]]),
		);
		const { observer, written } = makeObserver();

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.results[0]).toMatchObject({
			kind: 'placeholder-written',
			outcome: { status: 'created' },
		});
		expect(written).toEqual([recording.id]);
	});

	it('keeps an existing real note instead of downgrading to a placeholder', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const writer = makeWriter(vault);

		// First, a successful import writes the real note.
		const good = makeFetch(new Map([[recording.id, makeArtifacts(recording)]]));
		await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts: good.fetchArtifacts,
		});

		// Then a later run fails to fetch with an unprocessed error; the existing
		// real note must win over a downgrade to a stub.
		const bad = makeFetch(
			new Map([[recording.id, () => { throw unprocessedError(); }]]),
		);
		const { observer, written } = makeObserver();
		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts: bad.fetchArtifacts,
			observer,
		});

		expect(outcome.results[0]).toMatchObject({
			kind: 'written',
			writeOutcome: { status: 'skipped' },
		});
		// kept-existing is reported as a skip and does NOT refresh the badge.
		expect(written).toEqual([]);
	});

	it('records a failure for a generic fetch error', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const boom = new Error('network down');
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, () => { throw boom; }]]),
		);

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.results[0]).toMatchObject({ kind: 'failed', cause: boom });
	});

	it('records a failure for an unprocessed error when placeholders are disabled', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, () => { throw unprocessedError(); }]]),
		);

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: { ...OPTIONS, writePlaceholderForUnprocessed: false },
			fetchArtifacts,
		});

		expect(outcome.results[0]).toMatchObject({ kind: 'failed' });
		// No placeholder note was written.
		expect(vault.files.size).toBe(0);
	});

	it('stops with cancelled when a per-file duplicate prompt is dismissed', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const artifacts = new Map<PlaudRecordingId, TranscriptAndSummary>([
			[recA.id, makeArtifacts(recA)],
			[recB.id, makeArtifacts(recB)],
		]);

		// Seed both notes so the second run hits the duplicate prompt for each.
		await runImport({
			recordings: [recA, recB],
			selection: SELECTION,
			writer: makeWriter(vault, { onDuplicate: 'skip' }),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts: makeFetch(artifacts).fetchArtifacts,
		});

		// Prompt overwrites the first duplicate, cancels the second.
		const promptWriter = makeWriter(vault, {
			onDuplicate: 'prompt',
			promptOnDuplicate: async ({ recordingId }): Promise<DuplicatePromptDecision> =>
				recordingId === recB.id ? 'cancel' : 'overwrite',
		});
		const outcome = await runImport({
			recordings: [recA, recB],
			selection: SELECTION,
			writer: promptWriter,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts: makeFetch(artifacts).fetchArtifacts,
		});

		expect(outcome.stop).toBe('cancelled');
		// recA completed (overwritten) before recB cancelled — processed counts
		// the finished recordings, the x in "x/y".
		expect(outcome.processed).toBe(1);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]).toMatchObject({ writeOutcome: { status: 'overwritten' } });
	});

	it('stops with aborted before processing the next recording', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map([
				[recA.id, makeArtifacts(recA)],
				[recB.id, makeArtifacts(recB)],
			]),
		);
		// shouldAbort is false for the first iteration's top check, true for the
		// second, so recB is never started.
		let topChecks = 0;
		const { observer, starts } = makeObserver(() => {
			topChecks += 1;
			return topChecks >= 2;
		});

		const outcome = await runImport({
			recordings: [recA, recB],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('aborted');
		expect(outcome.processed).toBe(1);
		expect(outcome.results).toHaveLength(1);
		// recB never started: one onRecordingStart, one fetch.
		expect(starts).toEqual([[1, 2]]);
		expect(calls).toEqual([recA.id]);
	});

	it('stops with aborted on the final check after the last write', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording)]]),
		);
		// Abort only on the second shouldAbort call: the iteration top check
		// passes, the recording is written, then the post-loop check aborts.
		let checks = 0;
		const { observer } = makeObserver(() => {
			checks += 1;
			return checks >= 2;
		});

		const outcome = await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('aborted');
		expect(outcome.processed).toBe(1);
		// The recording WAS written before the final abort fired.
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]).toMatchObject({ writeOutcome: { status: 'created' } });
	});

	it('fetches once per processed recording and reports 1-based progress in order', async () => {
		const vault = makeFakeVault();
		const withContent1 = makeRecording();
		const noContent = makeRecording({
			transcriptAvailable: false,
			summaryAvailable: false,
		});
		const withContent2 = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map([
				[withContent1.id, makeArtifacts(withContent1)],
				[withContent2.id, makeArtifacts(withContent2)],
			]),
		);
		const { observer, starts, written, events } = makeObserver();

		const outcome = await runImport({
			recordings: [withContent1, noContent, withContent2],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('completed');
		expect(outcome.processed).toBe(3);
		expect(outcome.results.map((r) => r.kind)).toEqual([
			'written',
			'skipped-no-content',
			'written',
		]);
		// Fetch skips the no-content recording entirely.
		expect(calls).toEqual([withContent1.id, withContent2.id]);
		// Progress is 1-based and fires for every recording, including the skip.
		expect(starts).toEqual([[1, 3], [2, 3], [3, 3]]);
		expect(written).toEqual([withContent1.id, withContent2.id]);
		// Ordering: start precedes the corresponding written, and the skip's
		// start fires between the two writes.
		expect(events).toEqual([
			`start:${withContent1.id}:1/3`,
			`written:${withContent1.id}`,
			`start:${noContent.id}:2/3`,
			`start:${withContent2.id}:3/3`,
			`written:${withContent2.id}`,
		]);
	});

	it('imports attachments only when the bundle has assets and the note was written', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const asset = { dataType: 'image', url: 'https://example.com/a.png', name: 'a.png' };
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording, { attachments: [asset] })]]),
		);
		const { pipeline, importCalls } = makeAttachmentStub();

		await runImport({
			recordings: [recording],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: pipeline,
			options: OPTIONS,
			fetchArtifacts,
		});

		expect(importCalls).toHaveLength(1);
		expect(importCalls[0]).toMatchObject({
			recordingId: recording.id,
			replaceExisting: false,
		});
	});

	it('runs the fold hook for a written note and skips it for a duplicate skip', async () => {
		const vault = makeFakeVault();
		const recording = makeRecording();
		const writer = makeWriter(vault, { onDuplicate: 'skip' });
		const { fetchArtifacts } = makeFetch(
			new Map([[recording.id, makeArtifacts(recording)]]),
		);
		const foldPaths: string[] = [];
		const deps: ImportRunDeps = {
			recordings: [recording],
			selection: SELECTION,
			writer,
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			applyFold: async (path) => { foldPaths.push(path); },
		};

		await runImport(deps);
		expect(foldPaths).toHaveLength(1);

		// Second run skips the duplicate; fold must NOT run on a skip.
		await runImport(deps);
		expect(foldPaths).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// A2: mid-batch token-expiry abort (issue #14). A rejected token part-way
	// through a multi-select import is a batch-terminal condition: the loop must
	// stop on the FIRST auth failure (stop:'auth-failed') instead of failing
	// every remaining recording, and the pre-expiry results must survive so the
	// modal can resume the unprocessed tail.
	// -------------------------------------------------------------------------

	it('stops with auth-failed on the first token rejection and does not touch later recordings', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const recC = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map<PlaudRecordingId, TranscriptAndSummary | (() => never)>([
				[recA.id, makeArtifacts(recA)],
				[recB.id, (): never => {
					throw new PlaudAuthError('token_rejected', 'rejected', '/ai/transsumm');
				}],
				[recC.id, makeArtifacts(recC)],
			]),
		);
		const { observer, starts, written } = makeObserver();

		const outcome = await runImport({
			recordings: [recA, recB, recC],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('auth-failed');
		// recA finished; recB is the failing index, never written. processed = 1.
		expect(outcome.processed).toBe(1);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]).toMatchObject({
			kind: 'written',
			recording: { id: recA.id },
		});
		// The runner did NOT classify recB or recC as a per-recording 'failed'.
		expect(outcome.results.some((r) => r.kind === 'failed')).toBe(false);
		// recC was never fetched: the loop returned at recB.
		expect(calls).toEqual([recA.id, recB.id]);
		// recB's progress started (fires before the fetch); recC's never did.
		expect(starts).toEqual([[1, 3], [2, 3]]);
		expect(written).toEqual([recA.id]);
	});

	it('reports processed 0 and retains no results when the first recording is rejected', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map<PlaudRecordingId, TranscriptAndSummary | (() => never)>([
				[recA.id, (): never => {
					throw new PlaudAuthError('token_rejected', 'rejected', '/ai/transsumm');
				}],
				[recB.id, makeArtifacts(recB)],
			]),
		);
		const { observer, starts } = makeObserver();

		const outcome = await runImport({
			recordings: [recA, recB],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
			observer,
		});

		expect(outcome.stop).toBe('auth-failed');
		expect(outcome.processed).toBe(0);
		expect(outcome.results).toHaveLength(0);
		// recB was never touched.
		expect(calls).toEqual([recA.id]);
		expect(starts).toEqual([[1, 2]]);
	});

	it('aborts on a not-configured auth error too (categoryAllowsReauth, not just token_rejected)', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const { fetchArtifacts } = makeFetch(
			new Map<PlaudRecordingId, TranscriptAndSummary | (() => never)>([
				[recA.id, makeArtifacts(recA)],
				[recB.id, (): never => {
					throw new PlaudAuthError('not_configured', 'no token', '/ai/transsumm');
				}],
			]),
		);

		const outcome = await runImport({
			recordings: [recA, recB],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: OPTIONS,
			fetchArtifacts,
		});

		expect(outcome.stop).toBe('auth-failed');
		expect(outcome.processed).toBe(1);
		expect(outcome.results).toHaveLength(1);
	});

	it('keeps the partial-success semantic for a non-auth failure (continues the batch)', async () => {
		const vault = makeFakeVault();
		const recA = makeRecording();
		const recB = makeRecording();
		const recC = makeRecording();
		const { fetchArtifacts, calls } = makeFetch(
			new Map<PlaudRecordingId, TranscriptAndSummary | (() => never)>([
				[recA.id, makeArtifacts(recA)],
				[recB.id, (): never => {
					throw new Error('transient network blip');
				}],
				[recC.id, makeArtifacts(recC)],
			]),
		);

		const outcome = await runImport({
			recordings: [recA, recB, recC],
			selection: SELECTION,
			writer: makeWriter(vault),
			attachments: makeAttachmentStub().pipeline,
			options: { ...OPTIONS, writePlaceholderForUnprocessed: false },
			fetchArtifacts,
		});

		// A generic failure stays per-recording: the loop runs to completion.
		expect(outcome.stop).toBe('completed');
		expect(outcome.processed).toBe(3);
		expect(outcome.results.map((r) => r.kind)).toEqual([
			'written',
			'failed',
			'written',
		]);
		// All three were fetched: the batch did not abort at recB.
		expect(calls).toEqual([recA.id, recB.id, recC.id]);
	});
});
