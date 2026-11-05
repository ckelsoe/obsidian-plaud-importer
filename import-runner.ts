// -----------------------------------------------------------------------------
// import-runner.ts
//
// Headless orchestration of a multi-select import. `runImport` owns the
// sequential per-recording loop that was previously buried inside
// `ImportModal.onImportClick`: fetch artifacts, merge attachments, build tags,
// write the note, import attachments, fold the transcript, and classify
// failures into placeholders or partial-success skips.
//
// It imports NO `obsidian` API. Every UI concern (button text, row badges,
// abort detection, the final Notice/summary) is delegated to the caller via an
// optional observer and the returned `ImportRunOutcome`, so the same loop runs
// under the modal UI today and under the planned background auto-sync with a
// no-op observer. Types come from `import-core.ts`, keeping the runner on the
// acyclic side of the former import-modal <-> attachment-importer cycle.
// -----------------------------------------------------------------------------

import type {
	RecordingId,
	Recording,
	AttachmentAsset,
	RecordingArtifacts,
} from './recording-model';
import {
	NoteWriterCancelledError,
	buildNoteTags,
	type NoteWriter,
	type FormatMarkdownOptions,
} from './note-writer';
import {
	classifyError,
	categoryAllowsReauth,
	type ImportResult,
	type ArtifactSelection,
	type ImportModalOptions,
} from './import-core';

/**
 * The slice of `AttachmentImporter` the runner uses. Declared structurally so
 * the runner depends only on these three methods (the real `AttachmentImporter`
 * satisfies it) and tests can pass a lightweight stub.
 */
export interface AttachmentPipeline {
	extractAttachmentAssetsFromSummaryMarkdown(
		summaryMarkdown: string | null,
	): readonly AttachmentAsset[];
	mergeAttachmentAssets(
		base: readonly AttachmentAsset[],
		extra: readonly AttachmentAsset[],
	): readonly AttachmentAsset[];
	importAttachmentsForNote(
		notePath: string,
		attachments: readonly AttachmentAsset[],
		selection: ArtifactSelection,
		replaceExisting: boolean,
		recordingId: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): Promise<void>;
	importAudioForNote(
		notePath: string,
		audioUrl: string,
		recordingId: string,
	): Promise<number | null>;
}

/**
 * Hooks the caller supplies to observe and steer the run. Every callback is
 * optional; a fully headless caller (auto-sync) passes none. The runner never
 * shows UI itself — these are how the modal updates the button text, refreshes
 * row badges, and signals a mid-run abort.
 */
export interface ImportRunObserver {
	/**
	 * Fired before each recording is processed (including no-content skips).
	 * `index` is 1-based to match the modal's "Importing i of n" button text.
	 */
	onRecordingStart?(index: number, total: number, recording: Recording): void;
	/**
	 * Fired exactly when a note was created/overwritten or a placeholder was
	 * written. The modal calls `updateRowBadge` here, which also rebuilds the
	 * imported index backing cross-folder dedup, so the call sites are
	 * load-bearing, not cosmetic.
	 */
	onRecordingWritten?(recording: Recording): void;
	/** Polled at the top of every iteration; truthy ends the run as 'aborted'. */
	shouldAbort?(): boolean;
}

/** Writes one granular event to the run's debug log, when one is enabled. */
export type ImportDebugLog = (message: string, payload?: unknown) => void;

/** Where a recording sits in the service's folders, as its note records it. */
interface RecordingFolders {
	/** Folder names for the `<prefix>-folder:` key; empty or omitted writes none. */
	readonly names?: readonly string[];
	/**
	 * Location for the `<prefix>-location:` key, for a recording that is not in
	 * a real folder. Omitted writes none.
	 */
	readonly location?: string;
	/** Folder-derived tags, the base `buildNoteTags` adds keywords and custom tags to. */
	readonly tags: readonly string[];
}

/** Resolves one recording's folders; built once per run by `loadFolders`. */
export type FolderResolver = (recording: Recording) => RecordingFolders;

const NO_FOLDERS: FolderResolver = () => ({ tags: [] });

async function loadFolderResolver(
	deps: ImportRunDeps,
	log: ImportDebugLog,
): Promise<FolderResolver> {
	if (!deps.loadFolders) return NO_FOLDERS;
	try {
		return await deps.loadFolders(log);
	} catch (err) {
		log('folder catalog failed; importing without folders', {
			error: err instanceof Error ? err.message : String(err),
		});
		return NO_FOLDERS;
	}
}

export interface ImportRunDeps {
	/** Already filtered to the user's selection, in display order. */
	readonly recordings: readonly Recording[];
	readonly selection: ArtifactSelection;
	/** Pre-built by the caller (duplicate policy + prompt callback already bound). */
	readonly writer: NoteWriter;
	readonly attachments: AttachmentPipeline;
	readonly options: ImportModalOptions;
	/**
	 * Resolves the transcript/summary bundle for one recording. The modal
	 * injects its warm `ensureArtifactsForRecording` so a prior "review
	 * artifacts" preflight is not re-fetched.
	 */
	fetchArtifacts(recordingId: RecordingId): Promise<RecordingArtifacts>;
	/**
	 * Prepares the service's folder lookup, called ONCE per run. Optional: a
	 * service without folders omits it and its notes carry no folder keys and
	 * no folder-derived tags. A hook may handle its own failures (what a failed
	 * catalog fetch still resolves is service-specific); one that throws costs
	 * the run its folders, never the import.
	 */
	loadFolders?(log: ImportDebugLog): Promise<FolderResolver>;
	/**
	 * Resolves one recording's original-audio download URL, or null when Plaud
	 * exposes none. Only invoked when `selection.includeAudio` is set, so a
	 * caller that never imports audio (or a headless auto-sync) may omit it.
	 */
	fetchAudioUrl?(recordingId: RecordingId): Promise<string | null>;
	/** Optional post-write transcript fold. Omitted by headless callers. */
	applyFold?(path: string): Promise<void>;
	readonly observer?: ImportRunObserver;
}

/**
 * Why the run ended:
 *   - 'completed': every selected recording was processed.
 *   - 'aborted': `observer.shouldAbort()` was truthy (modal closed mid-run).
 *   - 'cancelled': the user cancelled a per-file duplicate prompt.
 *   - 'auth-failed': a re-authable auth failure happened mid-batch, i.e. one
 *     where `categoryAllowsReauth` is true (a rejected/expired session token, or
 *     a token that went missing). The loop stops on the FIRST such failure
 *     instead of failing every remaining recording with the same error; the
 *     modal offers inline re-auth + resume on this stop.
 * 'aborted' and 'cancelled' both produce the modal's "(cancelled at x/y)"
 * partial Notice; they are distinguished so headless callers can tell a
 * user-driven stop from an interrupted one. 'auth-failed' is a batch-terminal
 * condition a headless caller (auto-sync, Phase 2) can use to drive an
 * auth-pause state machine.
 */
type ImportRunStop = 'completed' | 'aborted' | 'cancelled' | 'auth-failed';

export interface ImportRunOutcome {
	readonly results: ImportResult[];
	readonly stop: ImportRunStop;
	/** Count of recordings finished before the stop; the x in "x/y". */
	readonly processed: number;
}

/**
 * Emit a granular debug event when a logger is wired and enabled. Mirrors the
 * modal's private `logImportDebug` so the lifted loop logs identically.
 */
function emitImportDebug(
	options: ImportModalOptions,
	message: string,
	payload?: unknown,
): void {
	const logger = options.debugLogger;
	if (!logger || !logger.enabled) {
		return;
	}
	logger.log({
		kind: 'note',
		endpoint: '/import',
		message,
		payload,
	});
}

/**
 * Run the import loop over `deps.recordings`. Sequential rather than parallel:
 * Plaud documents no rate limit, and sequential ordering is cheap insurance
 * against throttling. A per-recording failure is caught and recorded but does
 * not stop the batch — the "partial success" semantic a multi-select import
 * users expect.
 */
export async function runImport(
	deps: ImportRunDeps,
): Promise<ImportRunOutcome> {
	const { recordings, selection, writer, options } = deps;
	const observer = deps.observer;
	const total = recordings.length;
	const shouldAbort = (): boolean => observer?.shouldAbort?.() ?? false;

	const debugLog: ImportDebugLog = (message, payload) =>
		emitImportDebug(options, message, payload);
	const resolveFolders = await loadFolderResolver(deps, debugLog);

	// Serial -> device name map for the {{device}} frontmatter token (issue #110
	// follow-up). Resolved once from the host's live getter; a batch shares one
	// snapshot. Empty when no devices are remembered, which leaves {{device}} as a
	// generic label rather than failing.
	const deviceNames: ReadonlyMap<string, string> =
		options.getDeviceNames?.() ?? new Map();

	const results: ImportResult[] = [];
	for (const [i, recording] of recordings.entries()) {
		// Bail on mid-import modal close. The caller renders the partial
		// Notice so the user sees what was completed before they hit Esc.
		if (shouldAbort()) {
			return { results, stop: 'aborted', processed: i };
		}

		observer?.onRecordingStart?.(i + 1, total, recording);
		// Plaud never produced a transcript OR a summary for this
		// recording — the list metadata already told us so, before the
		// doomed /ai/transsumm + /file/detail round-trip that would
		// otherwise return a -12 "start trans task error". There is
		// nothing to write, so record a benign "no content" skip rather
		// than letting the error path classify it as a failure.
		//
		// Only when the list actually REPORTS availability. On the v4 portal the
		// list omits per-recording presence, so both flags are false as "unknown"
		// (contentAvailabilityUnknown), and skipping here would drop every
		// recording. In that case fetch and let the detail response be
		// authoritative; the note writer writes whatever content exists.
		if (
			!recording.contentAvailabilityUnknown &&
			!recording.transcriptAvailable &&
			!recording.summaryAvailable
		) {
			emitImportDebug(
				options,
				`skipped recording with no content in ${options.profile.serviceName}`,
				{
					recordingId: recording.id,
					recordingTitle: recording.title,
				},
			);
			results.push({ kind: 'skipped-no-content', recording });
			continue;
		}
		try {
			const {
				transcript,
				summary,
				aiKeywords,
				chapters,
				attachments,
				nestedAssetLinks,
				consumerNotes,
				marks,
				additionalSummaries,
			} = await deps.fetchArtifacts(recording.id);
			// Extract embedded image markers from EVERY summary body (the primary
			// plus each additional summary such as SUMMARY_BETA), so a second
			// summary's images download and get repointed like the primary's.
			const summaryLinkedAttachments = [
				summary?.text ?? null,
				...(additionalSummaries ?? []).map((s) => s.text),
			].flatMap((text) =>
				deps.attachments.extractAttachmentAssetsFromSummaryMarkdown(
					text,
				),
			);
			// Marks (screenshots) become attachments so the same download +
			// inline-embed repoint pipeline localizes them; the dedicated `mark`
			// dataType routes them past the managed attachments section (note-writer
			// renders them in `## Screenshots`). Only when the screenshots artifact
			// is selected.
			const markAttachments: readonly AttachmentAsset[] =
				selection.includeScreenshots && marks !== undefined
					? marks.map((mark) => ({
							dataType: options.profile.markDataType,
							url: mark.url,
						}))
					: [];
			// Marks are the merge BASE so they win the URL dedup. A screenshot the
			// user also embedded in the summary would otherwise survive as a generic
			// `summary_link` asset and get skipped when Other attachments is off,
			// stranding the note with an expiring remote URL. mergeAttachmentAssets
			// keeps the base on a URL collision, and markAttachments is non-empty
			// only when Screenshots is selected, so mark-wins never routes an asset
			// through a disabled gate.
			const mergedAttachments = deps.attachments.mergeAttachmentAssets(
				markAttachments,
				deps.attachments.mergeAttachmentAssets(
					attachments ?? [],
					summaryLinkedAttachments,
				),
			);
			const folders = resolveFolders(recording);
			// DD-004: combine Plaud's AI-generated keyword list (from
			// /file/detail/), the recording's folder-derived tags, and the
			// user's custom tags before the note is rendered. buildNoteTags
			// owns the mode filtering, namespacing, slug, and dedup
			// rules; this site just feeds it the sources and settings.
			// The recording's tags are ALWAYS overwritten with the
			// built list (even when empty) so a restrictive tag mode
			// cannot leak the raw Plaud tags into the frontmatter.
			// formatFrontmatter omits empty tags:/keywords: keys.
			const tagResult = buildNoteTags(
				options.profile,
				folders.tags,
				aiKeywords,
				{
					tagMode: options.tagMode ?? 'plaud',
					customTags: options.customTags ?? '',
					aiKeywordsAsProperty: options.aiKeywordsAsProperty ?? true,
				},
			);
			const enrichedRecording = { ...recording, tags: tagResult.tags };
			const formatOptions: FormatMarkdownOptions = {
				includeTranscript: selection.includeTranscript,
				includeSummary: selection.includeSummary,
				keywords: tagResult.keywords,
				folders: folders.names,
				location: folders.location,
				consumerNotes,
				marks: selection.includeScreenshots ? marks : undefined,
				additionalSummaries: selection.includeSummary
					? additionalSummaries
					: undefined,
				deviceNames,
			};
			const selectedChapters = selection.includeTranscript
				? chapters
				: undefined;
			const writeOutcome = await writer.writeNote(
				enrichedRecording,
				transcript,
				summary,
				selectedChapters,
				formatOptions,
			);
			emitImportDebug(options, 'note write outcome', {
				recordingId: recording.id,
				recordingTitle: recording.title,
				status: writeOutcome.status,
				path: writeOutcome.path,
				attachmentCount: mergedAttachments.length,
				summaryLinkedAttachmentCount: summaryLinkedAttachments.length,
			});
			// Refresh the badge for this row when the write produced a
			// note (created or overwritten). 'skipped' means the file
			// already existed and we honored the duplicate policy —
			// the badge is already there, no work to do.
			if (
				writeOutcome.status === 'created' ||
				writeOutcome.status === 'overwritten'
			) {
				observer?.onRecordingWritten?.(recording);
			}
			if (
				(selection.includeAttachments ||
					selection.includeMindmap ||
					selection.includeCard ||
					selection.includeScreenshots) &&
				writeOutcome.status !== 'skipped' &&
				mergedAttachments.length > 0
			) {
				await deps.attachments.importAttachmentsForNote(
					writeOutcome.path,
					mergedAttachments,
					selection,
					writeOutcome.status === 'overwritten',
					recording.id,
					nestedAssetLinks,
				);
			} else {
				emitImportDebug(options, 'attachment import not started', {
					recordingId: recording.id,
					noteStatus: writeOutcome.status,
					attachmentCount: mergedAttachments.length,
					summaryLinkedAttachmentCount:
						summaryLinkedAttachments.length,
					reason: !(
						selection.includeAttachments ||
						selection.includeMindmap ||
						selection.includeCard ||
						selection.includeScreenshots
					)
						? 'attachments disabled by artifact selection'
						: writeOutcome.status === 'skipped'
							? 'note skipped by duplicate policy'
							: 'no attachments in transcript bundle',
				});
			}
			// Audio download is a separate, opt-in artifact: it is not a
			// file-detail attachment (dedicated temp-url), embeds as an
			// inline player, and is off by default. Runs after attachments
			// so the assets folder already exists, and before the fold so
			// the managed section is in place when heading lines are saved.
			if (
				selection.includeAudio &&
				writeOutcome.status !== 'skipped' &&
				deps.fetchAudioUrl !== undefined
			) {
				try {
					const audioUrl = await deps.fetchAudioUrl(recording.id);
					if (audioUrl !== null) {
						const audioBytes =
							await deps.attachments.importAudioForNote(
								writeOutcome.path,
								audioUrl,
								recording.id,
							);
						emitImportDebug(options, 'audio import outcome', {
							recordingId: recording.id,
							bytesWritten: audioBytes,
						});
					} else {
						emitImportDebug(
							options,
							'audio import skipped: no temp-url',
							{
								recordingId: recording.id,
							},
						);
					}
				} catch (audioErr) {
					// Audio is best-effort: the note and transcript already
					// landed, so a download/write failure must not fail the
					// recording. But a mid-batch auth expiry is batch-terminal
					// (every later recording fails the same way), so rethrow
					// those to the outer handler that stops the batch and
					// offers inline re-auth.
					if (
						categoryAllowsReauth(
							classifyError(audioErr, options.errorPolicy)
								.category,
						)
					) {
						throw audioErr;
					}
					// Log into the debug session (not just the DevTools console)
					// so an exported session shows why audio was skipped.
					emitImportDebug(options, 'audio import failed', {
						recordingId: recording.id,
						recordingTitle: recording.title,
						error:
							audioErr instanceof Error
								? audioErr.message
								: String(audioErr),
					});
				}
			}
			// Apply transcript folding AFTER all post-write mutations
			// (including attachment section insertion) so the saved
			// heading line always matches the final file layout.
			// The callout placement has no heading to fold; the callout collapses
			// itself.
			if (
				writeOutcome.status !== 'skipped' &&
				options.foldTranscript !== false &&
				options.transcriptPlacement !== 'callout'
			) {
				await deps.applyFold?.(writeOutcome.path);
			}
			// Report the original recording in the result so any
			// downstream UI that renders the import summary sees the
			// same object the modal already knows about. The merged
			// tags only need to exist long enough to land in the
			// written note's frontmatter.
			results.push({ kind: 'written', recording, writeOutcome });
		} catch (err) {
			// User cancelled the per-file duplicate prompt. Stop the
			// loop without recording a failure — the current recording
			// was not written, but the cancellation is user-intent,
			// not an error condition worth classifying.
			if (err instanceof NoteWriterCancelledError) {
				return { results, stop: 'cancelled', processed: i };
			}
			// Log the full error object (including stack and any wrapped
			// `cause`) so it's visible in DevTools. TODO: also plumb a
			// logError(errorIds.IMPORT_RECORDING_FAILED, ...) telemetry
			// call once the plugin has telemetry infrastructure.
			console.error(
				`${options.profile.serviceName} importer: import failed for recording ${recording.id} "${recording.title}"`,
				err,
			);
			const classification = classifyError(err, options.errorPolicy);

			// A rejected token mid-batch (an expired or revoked session) is
			// a batch-level terminal condition, not a per-recording failure:
			// continuing the loop would fail every remaining recording with the
			// same auth error and still report stop:'completed'. Stop on the
			// FIRST one so the modal can offer inline re-auth + resume.
			// recordings[i] was not written, so processed = i and the unprocessed
			// tail (this recording included) is recordings.slice(i). The pre-auth
			// results stay in `results` for the caller's partial summary.
			// categoryAllowsReauth is the same predicate the modal's A1 Sign-in
			// gate uses, kept single-sourced so the runner-abort and the
			// modal-reauth conditions cannot drift apart.
			if (categoryAllowsReauth(classification.category)) {
				return { results, stop: 'auth-failed', processed: i };
			}

			// Plaud confirmed (in-band) it has no transcript/summary for this
			// recording yet. Rather than a bare failure, write a placeholder
			// note carrying the recording ID and a Plaud link so the user
			// keeps a breadcrumb; a later successful import replaces it
			// automatically. Gated by the writePlaceholderForUnprocessed
			// setting (default on). A failure of the placeholder write itself
			// falls through to the normal failure path below.
			if (
				options.writePlaceholderForUnprocessed !== false &&
				options.errorPolicy.isUnprocessed(err)
			) {
				try {
					// Pass Plaud's own concise error line as the stub's reason
					// (e.g. "...: status=-12 msg=start trans task error"), not
					// the full classified paragraph, since the placeholder body
					// already carries the plain-English explanation.
					const outcome = await writer.writePlaceholderNote(
						recording,
						err instanceof Error
							? err.message
							: classification.message,
					);
					emitImportDebug(options, 'placeholder note outcome', {
						recordingId: recording.id,
						recordingTitle: recording.title,
						status: outcome.status,
						path: outcome.path,
					});
					if (outcome.status === 'kept-existing') {
						// A real note already exists; nothing to write. Report
						// as a benign skip rather than a placeholder.
						results.push({
							kind: 'written',
							recording,
							writeOutcome: {
								status: 'skipped',
								path: outcome.path,
							},
						});
					} else {
						observer?.onRecordingWritten?.(recording);
						results.push({
							kind: 'placeholder-written',
							recording,
							outcome,
							reason: classification.message,
							classification,
						});
					}
					continue;
				} catch (placeholderErr) {
					// The stub write failed (vault error, collision with a
					// different recording, etc.). Fall through and report the
					// original Plaud failure so the user still sees something.
					console.error(
						`${options.profile.serviceName} importer: placeholder write failed for recording ${recording.id}`,
						placeholderErr,
					);
				}
			}

			results.push({
				kind: 'failed',
				recording,
				reason: classification.message,
				classification,
				cause: err,
			});
		}
	}

	// Reached only when every recording was processed. A late abort (modal
	// closed right after the last write) is reported as 'aborted' so the
	// caller still fires the partial Notice instead of the success summary.
	if (shouldAbort()) {
		return { results, stop: 'aborted', processed: total };
	}

	return { results, stop: 'completed', processed: total };
}
