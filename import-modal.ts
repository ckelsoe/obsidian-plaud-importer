import {
	App,
	MarkdownView,
	Modal,
	Notice,
	type RequestUrlResponse,
	TFile,
	TFolder,
	requestUrl,
} from 'obsidian';
import type {
	AttachmentAsset,
	PlaudRecordingId,
	PlaudClient,
	Recording,
	TranscriptAndSummary,
} from './plaud-client';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from './plaud-client-re';
import {
	NoteWriter,
	NoteWriterError,
	NoteWriterCancelledError,
	type DuplicatePolicy,
	type DuplicatePromptCallback,
	mergeTagSources,
	findTranscriptHeadingLine,
	type NoteWriterOptions,
	type FormatMarkdownOptions,
	type WriteOutcome,
} from './note-writer';
import type { DebugLogger } from './debug-logger';

/**
 * Modal-level options passed to `ImportModal`. Extends
 * `NoteWriterOptions` with concerns that belong to the post-write
 * pipeline — specifically whether to auto-fold the transcript wrapping
 * heading via `app.foldManager.save` after each created/overwritten
 * note. `foldTranscript` is not a NoteWriter concern (the writer
 * doesn't touch fold state) so it lives on the modal's options
 * surface, not inside `NoteWriterOptions`.
 */
export interface ImportModalOptions extends NoteWriterOptions {
	readonly foldTranscript?: boolean;
	readonly defaultIncludeSummary?: boolean;
	readonly defaultIncludeAttachments?: boolean;
	readonly defaultIncludeMindmap?: boolean;
	readonly defaultIncludeCard?: boolean;
	/**
	 * Optional token provider used for follow-up attachment fetches that
	 * may require authenticated Plaud API calls (for example, image paths
	 * nested inside attachment JSON blobs).
	 */
	readonly getAuthToken?: () => string | null;
	/**
	 * Optional debug logger shared with the Plaud client. When provided and
	 * enabled, attachment import emits granular events (JSON parsing, nested
	 * picture-link extraction, and per-candidate fetch attempts) so users can
	 * copy one coherent troubleshooting log.
	 */
	readonly debugLogger?: DebugLogger;
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for unit testing). Keeping them outside the Modal
// class means the test suite can exercise classification and formatting
// without mocking the Modal base class or the DOM.
// -----------------------------------------------------------------------------

export type ErrorCategory =
	| 'not-configured'
	| 'token-rejected'
	| 'rate-limited'
	| 'server-error'
	| 'parse-error'
	| 'api-error'
	| 'network-error'
	| 'config-error'
	| 'write-collision'
	| 'write-failed'
	| 'unknown';

export interface ErrorClassification {
	readonly category: ErrorCategory;
	readonly message: string;
	readonly canRetry: boolean;
}

const NOT_CONFIGURED_MESSAGE =
	'No Plaud token configured. Open Settings → Community Plugins → Plaud Importer to paste your token, then run this command again.';
const TOKEN_REJECTED_MESSAGE =
	'Plaud rejected your token. It may be expired or revoked. Open Settings → Community Plugins → Plaud Importer and re-enter it.';
const PLAUD_API_BASE = 'https://api.plaud.ai';
const PLAUD_WEB_BASE = 'https://web.plaud.ai';

export function classifyError(err: unknown): ErrorClassification {
	// NoteWriterError classification must come first — it is not a
	// PlaudApiError subclass, and different messages map to different
	// categories (collision vs config vs vault-level write failure).
	if (err instanceof NoteWriterError) {
		const msg = err.message;
		if (msg.toLowerCase().includes('filename collision')) {
			return {
				category: 'write-collision',
				message: msg,
				canRetry: false,
			};
		}
		if (
			msg.toLowerCase().includes('invalid ondup') ||
			msg.toLowerCase().includes('escape the vault') ||
			msg.toLowerCase().includes('output folder')
		) {
			return {
				category: 'config-error',
				message: `${msg}. Open Settings → Community Plugins → Plaud Importer to fix it.`,
				canRetry: false,
			};
		}
		return {
			category: 'write-failed',
			message: msg,
			canRetry: true,
		};
	}
	// PlaudAuthError discriminates via its `reason` field so the UI never has
	// to match on message text. Both cases are non-retryable at this layer
	// because Obsidian modals are blocking — the user has to close and fix
	// settings before retrying makes sense.
	if (err instanceof PlaudAuthError) {
		if (err.reason === 'not_configured') {
			return {
				category: 'not-configured',
				message: NOT_CONFIGURED_MESSAGE,
				canRetry: false,
			};
		}
		return {
			category: 'token-rejected',
			message: TOKEN_REJECTED_MESSAGE,
			canRetry: false,
		};
	}
	// PlaudParseError must come before the generic PlaudApiError branch
	// because it extends PlaudApiError — ordering by specificity.
	if (err instanceof PlaudParseError) {
		return {
			category: 'parse-error',
			message: `Plaud returned data in an unexpected shape. The plugin may need an update. (${err.message})`,
			canRetry: false,
		};
	}
	if (err instanceof PlaudApiError) {
		if (err.status === 429) {
			return {
				category: 'rate-limited',
				message: 'Plaud is rate-limiting requests. Try again in a minute.',
				canRetry: true,
			};
		}
		if (err.status !== undefined && err.status >= 500) {
			return {
				category: 'server-error',
				message: `Plaud.AI returned a server error (${err.status}). This is usually temporary — try again in a moment.`,
				canRetry: true,
			};
		}
		if (err.status !== undefined && err.status >= 400 && err.status < 500) {
			// 4xx that isn't 401 (handled above) or 429 (handled above) —
			// things like 403 (revoked), 404 (endpoint moved), 400 (bad
			// request). These are almost always "the plugin is out of
			// date" or "Plaud changed something," not "your network is
			// broken," so saying "Could not reach Plaud.AI" would be a lie.
			return {
				category: 'api-error',
				message: `Plaud.AI returned HTTP ${err.status}. The plugin may need an update — check the plugin repository for a newer version.`,
				canRetry: false,
			};
		}
		// No status. Two sub-cases distinguished by message text:
		//   1. In-band error (Plaud returned a failure envelope on HTTP
		//      200) → api-error, message says Plaud-side failure.
		//   2. Fetcher threw (DNS, TLS, offline) → network-error with a
		//      "could not reach" prefix.
		if (err.message.includes('in-band error from')) {
			return {
				category: 'api-error',
				message: err.message,
				canRetry: true,
			};
		}
		return {
			category: 'network-error',
			message: `Could not reach Plaud.AI: ${err.message}`,
			canRetry: true,
		};
	}
	// Defense in depth — should never hit this. Retrying an unknown error
	// almost never helps (the cause is a code bug, not a transient failure),
	// so we tell the user to report it instead of offering a retry that
	// will keep producing the same error.
	return {
		category: 'unknown',
		message: `Unexpected error in Plaud Importer. Please report this at the plugin's GitHub repository. (${
			err instanceof Error ? err.message : String(err)
		})`,
		canRetry: false,
	};
}

export function formatDate(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
		d.getHours(),
	)}:${pad(d.getMinutes())}`;
}

export function formatDuration(seconds: number): string {
	// Guard against non-finite input before any arithmetic — Math.floor(NaN)
	// returns NaN and downstream template interpolation produces garbage
	// like "NaNh NaNm NaNs" in the UI. The parser already rejects non-finite
	// durations upstream, but formatDuration is exported as a standalone
	// pure helper so this is defense-in-depth for future callers.
	if (!Number.isFinite(seconds)) {
		return '0m 0s';
	}
	const safe = Math.max(0, Math.floor(seconds));
	const h = Math.floor(safe / 3600);
	const m = Math.floor((safe % 3600) / 60);
	const s = safe % 60;
	if (h > 0) {
		return `${h}h ${m}m ${s}s`;
	}
	return `${m}m ${s}s`;
}

// -----------------------------------------------------------------------------
// Import result tallying — pure helpers, exported for unit testing.
// -----------------------------------------------------------------------------

export type ImportResult =
	| {
			readonly kind: 'written';
			readonly recording: Recording;
			readonly writeOutcome: WriteOutcome;
	  }
	| {
			readonly kind: 'failed';
			readonly recording: Recording;
			// Short human-readable reason for the failures list. Derived
			// from the classification so the UI doesn't have to re-run it.
			readonly reason: string;
			// Typed classification (category + retryability) so future
			// consumers can group failures by category, decide whether
			// to retry, or render category-specific help text.
			readonly classification: ErrorClassification;
			// Preserved original value so a future logError pass can
			// surface the full stack / error class / status in telemetry.
			readonly cause: unknown;
	  };

export interface ImportTally {
	readonly total: number;
	readonly created: number;
	readonly overwritten: number;
	readonly skipped: number;
	readonly failed: number;
	readonly failures: readonly ImportResult[];
}

export function tallyImportResults(results: readonly ImportResult[]): ImportTally {
	let created = 0;
	let overwritten = 0;
	let skipped = 0;
	let failed = 0;
	const failures: ImportResult[] = [];
	for (const r of results) {
		if (r.kind === 'failed') {
			failed++;
			failures.push(r);
			continue;
		}
		switch (r.writeOutcome.status) {
			case 'created':
				created++;
				break;
			case 'overwritten':
				overwritten++;
				break;
			case 'skipped':
				skipped++;
				break;
		}
	}
	return {
		total: results.length,
		created,
		overwritten,
		skipped,
		failed,
		failures,
	};
}

/**
 * Build the one-line Notice text shown after an import batch completes.
 * The Notice is the only feedback the user sees outside the modal itself,
 * so it needs to report counts compactly.
 */
export function formatImportNotice(tally: ImportTally): string {
	if (tally.total === 0) {
		return 'Plaud Importer: nothing to import.';
	}
	const imported = tally.created + tally.overwritten;
	const parts: string[] = [];
	parts.push(`${imported} imported`);
	if (tally.skipped > 0) {
		parts.push(`${tally.skipped} skipped`);
	}
	if (tally.failed > 0) {
		parts.push(`${tally.failed} failed`);
	}
	return `Plaud Importer: ${parts.join(', ')}.`;
}

/**
 * Format an error classification as a structured block suitable for
 * pasting into a bug report. Exported so the renderError path and any
 * future "copy failure details" button in the summary view can share
 * the same format.
 */
export function formatErrorForClipboard(classification: ErrorClassification): string {
	return [
		'Plaud Importer error',
		`Category: ${classification.category}`,
		`Retryable: ${classification.canRetry}`,
		'Message:',
		classification.message,
	].join('\n');
}

/**
 * Copy text to the clipboard and show a brief Notice confirming success.
 * Falls back gracefully on platforms where the clipboard API is blocked.
 */
async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice('Plaud Importer: error details copied to clipboard.');
	} catch (err) {
		console.error('Plaud Importer: clipboard write failed', err);
		new Notice(
			'Plaud Importer: could not copy to clipboard — see the developer console (Ctrl+Shift+I) for the full error.',
		);
	}
}

// -----------------------------------------------------------------------------
// Progressive paging helpers
// -----------------------------------------------------------------------------

/**
 * Number of recordings fetched per "Load more" click. Kept small so the
 * first render is cheap and the user can stop scrolling early if they
 * already see the meeting they want. Tune by feel — there is no hard cap
 * from Plaud's side.
 */
export const PAGE_SIZE = 10;
const AUTO_LOAD_ROOT_MARGIN_PX = 240;
const AUTO_LOAD_THROTTLE_MS = 300;
const AUTO_LOAD_SILENT_RETRY_DELAY_MS = 350;

/**
 * Merge a freshly-fetched page into the accumulator that backs the modal
 * list, and decide whether more pages probably exist.
 *
 * Background:
 * - Plaud's `/file/simple/web` endpoint supports offset pagination via the
 *   `skip` and `limit` query params, but it does NOT report the total
 *   count of recordings, nor does it return an explicit "end of stream"
 *   marker. So we can only *infer* "no more recordings" from the batch
 *   size that came back.
 * - Recordings can be uploaded to Plaud while the modal is open. That
 *   means a naive `[...existing, ...incoming]` can produce duplicates: if
 *   a new recording is uploaded between page 1 and page 2, Plaud's newest-
 *   first sort will shift page 2 down by one, and the first row of the new
 *   page will be a repeat of the last row of the previous page.
 *
 * Strategy:
 * - Deduplicate by recording ID so mid-session uploads that shift Plaud's
 *   offset windows do not produce duplicate rows in the modal.
 * - Preserve first-seen ordering by appending only unseen incoming rows.
 * - Infer "has more" from page fullness (`incoming.length >= pageSize`).
 *   This avoids an extra empty trailing fetch on normal pagination.
 */
export function mergeRecordings(
	existing: readonly Recording[],
	incoming: readonly Recording[],
	pageSize: number,
): { readonly merged: readonly Recording[]; readonly hasMore: boolean } {
	const merged: Recording[] = [...existing];
	const seen = new Set(existing.map((r) => r.id));
	for (const recording of incoming) {
		if (seen.has(recording.id)) {
			continue;
		}
		seen.add(recording.id);
		merged.push(recording);
	}
	const hasMore = incoming.length >= pageSize;
	return { merged, hasMore };
}

type LoadMoreTrigger = 'auto' | 'manual' | 'retry';

interface ArtifactSelection {
	readonly includeSummary: boolean;
	readonly includeTranscript: boolean;
	readonly includeAttachments: boolean;
	readonly includeMindmap: boolean;
	readonly includeCard: boolean;
}

interface ArtifactAvailability {
	readonly selectedCount: number;
	readonly summaryCount: number;
	readonly transcriptCount: number;
	readonly attachmentsCount: number;
	readonly mindmapCount: number;
	readonly cardCount: number;
}

type AttachmentKind = 'generic' | 'mindmap' | 'card';
type RenderedAsset = {
	readonly path: string;
	readonly isImage: boolean;
};
type AttachmentNamingCounters = {
	mindmapImage: number;
	mindmapFile: number;
	cardImage: number;
	cardFile: number;
	genericImage: number;
	genericFile: number;
};

class ArtifactSelectionModal extends Modal {
	private readonly availability: ArtifactAvailability;
	private selection: ArtifactSelection;
	private readonly onDone: (selection: ArtifactSelection | null) => void;
	private resolved = false;

	constructor(
		app: App,
		availability: ArtifactAvailability,
		initialSelection: ArtifactSelection,
		onDone: (selection: ArtifactSelection | null) => void,
	) {
		super(app);
		this.availability = availability;
		this.selection = { ...initialSelection };
		this.onDone = onDone;
	}

	onOpen(): void {
		this.setTitle('Choose artifacts to import');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `Availability across ${this.availability.selectedCount} selected recording${
				this.availability.selectedCount === 1 ? '' : 's'
			}:`,
			cls: 'plaud-importer-intro',
		});
		contentEl.createEl('p', {
			text: 'Transcript includes chapters automatically when available.',
			cls: 'plaud-importer-intro',
		});
		this.renderOption(contentEl, 'Summary', 'includeSummary', this.availability.summaryCount);
		this.renderOption(contentEl, 'Transcript', 'includeTranscript', this.availability.transcriptCount);
		this.renderOption(contentEl, 'Mindmap', 'includeMindmap', this.availability.mindmapCount);
		this.renderOption(contentEl, 'Card', 'includeCard', this.availability.cardCount);
		this.renderOption(
			contentEl,
			'Other attachments',
			'includeAttachments',
			this.availability.attachmentsCount,
		);

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const importButton = buttonRow.createEl('button', {
			text: 'Import selected',
			cls: 'mod-cta',
		});
		importButton.addEventListener('click', () => {
			this.resolved = true;
			this.onDone({ ...this.selection });
			this.close();
		});
		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.resolved = true;
			this.onDone(null);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.onDone(null);
		}
	}

	private renderOption(
		contentEl: HTMLElement,
		label: string,
		key: keyof ArtifactSelection,
		availableCount: number,
	): void {
		const row = contentEl.createDiv({ cls: 'plaud-importer-row' });
		const checkbox = row.createEl('input', {
			type: 'checkbox',
			cls: 'plaud-importer-checkbox',
		});
		checkbox.checked = this.selection[key];
		checkbox.disabled = availableCount === 0;
		const labelWrap = row.createDiv({ cls: 'plaud-importer-label' });
		const detail =
			this.availability.selectedCount <= 1
				? availableCount > 0
					? 'Available'
					: 'Not available'
				: `${availableCount} of ${this.availability.selectedCount} available`;
		labelWrap.createDiv({
			text: `${label}: ${detail}`,
			cls: 'plaud-importer-title',
		});
		checkbox.addEventListener('change', () => {
			this.selection = {
				...this.selection,
				[key]: checkbox.checked,
			};
		});
	}
}

class OverwriteConfirmationModal extends Modal {
	private readonly selectedCount: number;
	private readonly onDone: (choice: 'overwrite' | 'skip' | 'cancel') => void;
	private resolved = false;

	constructor(
		app: App,
		selectedCount: number,
		onDone: (choice: 'overwrite' | 'skip' | 'cancel') => void,
	) {
		super(app);
		this.selectedCount = selectedCount;
		this.onDone = onDone;
	}

	onOpen(): void {
		this.setTitle('Overwrite existing notes and assets?');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `You are importing ${this.selectedCount} recording${
				this.selectedCount === 1 ? '' : 's'
			} with duplicate handling set to overwrite.`,
		});
		contentEl.createEl('p', {
			text: 'If a note already exists, the note content and its imported files/images in the matching -assets folder will be replaced. Any manual edits to that note or those imported attachments can be lost.',
		});
		contentEl.createEl('p', {
			text: 'Choose how to continue:',
		});
		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const overwriteButton = buttonRow.createEl('button', {
			text: 'Continue with overwrite',
			cls: 'mod-warning',
		});
		overwriteButton.addEventListener('click', () => {
			this.resolved = true;
			this.onDone('overwrite');
			this.close();
		});
		const skipButton = buttonRow.createEl('button', {
			text: 'Do not overwrite existing notes',
			cls: 'mod-cta',
		});
		skipButton.addEventListener('click', () => {
			this.resolved = true;
			this.onDone('skip');
			this.close();
		});
		const cancelButton = buttonRow.createEl('button', { text: 'Cancel import' });
		cancelButton.addEventListener('click', () => {
			this.resolved = true;
			this.onDone('cancel');
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.onDone('cancel');
		}
	}
}

/**
 * Five-button per-duplicate prompt used when the user has chosen "Ask
 * each time" duplicate handling. The last three buttons (overwrite-all,
 * skip-all, cancel) escalate the decision: the caller uses them to
 * short-circuit subsequent duplicates in the same batch.
 */
export type DuplicateDecisionChoice =
	| 'overwrite'
	| 'skip'
	| 'overwrite-all'
	| 'skip-all'
	| 'cancel';

class DuplicateDecisionModal extends Modal {
	private readonly recordingTitle: string;
	private readonly targetPath: string;
	private readonly showBatchOptions: boolean;
	private readonly onDone: (choice: DuplicateDecisionChoice) => void;
	private resolved = false;

	constructor(
		app: App,
		recordingTitle: string,
		targetPath: string,
		showBatchOptions: boolean,
		onDone: (choice: DuplicateDecisionChoice) => void,
	) {
		super(app);
		this.recordingTitle = recordingTitle;
		this.targetPath = targetPath;
		this.showBatchOptions = showBatchOptions;
		this.onDone = onDone;
	}

	onOpen(): void {
		this.setTitle('Existing note found — overwrite?');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `A note for "${this.recordingTitle}" already exists at:`,
		});
		contentEl.createEl('p', { text: this.targetPath, cls: 'plaud-importer-mono' });
		const warning = contentEl.createEl('p', { cls: 'mod-warning' });
		warning.createEl('strong', { text: 'Warning: ' });
		warning.appendText(
			'Continuing with overwrite will replace the existing note content and clear its matching -assets folder. Any manual edits to that note or its imported attachments will be lost.',
		);
		contentEl.createEl('p', { text: 'Choose how to handle this note:' });

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const addButton = (text: string, cls: string, choice: DuplicateDecisionChoice): void => {
			const btn = buttonRow.createEl('button', { text, cls });
			btn.addEventListener('click', () => {
				this.resolved = true;
				this.onDone(choice);
				this.close();
			});
		};
		addButton('Overwrite', 'mod-warning', 'overwrite');
		addButton('Skip', 'mod-cta', 'skip');
		// "All remaining" and "Cancel import" only make sense when more
		// than one duplicate could still arrive in this batch. For a
		// single-item import Skip and Cancel are functionally identical
		// (both leave the existing note untouched), so rendering both
		// is user-hostile — hide the escalation set entirely.
		if (this.showBatchOptions) {
			addButton('Overwrite all remaining', 'mod-warning', 'overwrite-all');
			addButton('Skip all remaining', '', 'skip-all');
			addButton('Cancel import', '', 'cancel');
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.onDone('cancel');
		}
	}
}

// -----------------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------------

export class ImportModal extends Modal {
	private readonly client: PlaudClient;
	private readonly noteWriterOptions: ImportModalOptions;
	private readonly selectedIds = new Set<string>();
	private importButton: HTMLButtonElement | null = null;
	private reviewArtifactsButton: HTMLButtonElement | null = null;
	// Mutable accumulator across Load More clicks. Starts empty on each
	// refresh() (first open or Retry), then grows as loadMore() appends
	// new pages via mergeRecordings().
	private currentRecordings: Recording[] = [];
	// Live reference to the list container DOM node so loadMore() can
	// append new rows incrementally without re-rendering the whole list
	// (which would flash, reset scroll position, and throw away the
	// checkbox DOM state for rows the user is still looking at).
	private listEl: HTMLElement | null = null;
	// Tail status area inside the scrollable list. Shows loading/error/end
	// hints and a manual action button when auto-loading is paused or fails.
	private progressEl: HTMLElement | null = null;
	private progressTextEl: HTMLElement | null = null;
	private progressActionButton: HTMLButtonElement | null = null;
	// Invisible sentinel watched by IntersectionObserver. When it enters view
	// (near list bottom), we auto-fetch another page.
	private autoLoadSentinelEl: HTMLElement | null = null;
	private autoLoadObserver: IntersectionObserver | null = null;
	private scrollFallbackHandler: ((event: Event) => void) | null = null;
	// Intro line ("N recordings available…") — updated in place after
	// each successful loadMore() so the count stays accurate.
	private introEl: HTMLElement | null = null;
	// Whether Plaud probably has more recordings beyond what we've fetched.
	// Set from mergeRecordings() on every page. When false, the Load More
	// button is removed.
	private hasMore = false;
	// Guard against re-entry from rapid Load More clicks — the button is
	// also disabled while this is true, but this belt-and-suspenders guard
	// also prevents an in-flight fetch from being duplicated by keyboard
	// activation.
	private loadingMore = false;
	private loadMoreErrorMessage: string | null = null;
	private lastAutoLoadAt = 0;
	// First-scroll gate: we do not auto-load on initial modal open. Once the
	// user starts interacting with the list, auto-loading and background
	// prefetch are enabled.
	private userStartedScrolling = false;
	// Background next-page cache populated after first scroll so the next
	// bottom-reach can use already-fetched rows.
	private prefetchedRecordings: readonly Recording[] | null = null;
	private prefetchInFlight = false;
	private listInteractionHandler: (() => void) | null = null;
	private preparingCustomization = false;
	private readonly artifactCache = new Map<string, TranscriptAndSummary>();
	// Monotonic counter that increments on every refresh() call. Each
	// in-flight fetch captures the current value and bails before rendering
	// if it has changed — prevents the "click Retry while slow fetch is
	// still running" race from overwriting newer state with stale results.
	// loadMore() reads this value without incrementing so a fresh refresh()
	// during a Load More fetch invalidates the in-flight page.
	private fetchGeneration = 0;
	// Set by onClose so a running import loop can detect cancellation and
	// stop writing to the vault without continuing through the rest of the
	// selected recordings. Checked between iterations in onImportClick.
	private aborted = false;
	// Sticky choice for the "Ask each time" duplicate policy. Set when
	// the user picks "Overwrite all remaining" or "Skip all remaining"
	// from the per-file prompt, so subsequent duplicates in the same
	// batch resolve without re-prompting. Reset to null at the start of
	// every onImportClick invocation so decisions do not leak between
	// import runs.
	private stickyDuplicateDecision: 'overwrite' | 'skip' | null = null;
	// Number of recordings in the current import batch. Consulted by the
	// per-file duplicate prompt to decide whether to render the
	// "all remaining" escalation buttons — they are hidden for
	// single-item imports where the option is meaningless.
	private currentBatchSize = 0;

	constructor(app: App, client: PlaudClient, noteWriterOptions: ImportModalOptions) {
		super(app);
		this.client = client;
		this.noteWriterOptions = noteWriterOptions;
	}

	onOpen(): void {
		this.modalEl.addClass('plaud-importer-modal');
		this.setTitle('Import Plaud recordings');
		this.refresh().catch((err) => {
			// refresh() has its own try/catch around the fetch and always
			// calls renderError internally. This outer catch is purely
			// defense-in-depth against a future bug that throws outside the
			// fetch try/catch (e.g., a render function throwing).
			console.error('Plaud Importer: unexpected error in onOpen/refresh', err);
			this.renderError(classifyError(err));
		});
	}

	onClose(): void {
		// Signal any in-flight import loop to stop writing. The loop
		// checks `this.aborted` between iterations and fires a partial
		// Notice if it was interrupted.
		this.aborted = true;
		this.contentEl.empty();
		this.selectedIds.clear();
		this.teardownAutoLoadObserver();
		this.importButton = null;
		this.reviewArtifactsButton = null;
		this.currentRecordings = [];
		this.listEl = null;
		this.progressEl = null;
		this.progressTextEl = null;
		this.progressActionButton = null;
		this.autoLoadSentinelEl = null;
		this.introEl = null;
		this.hasMore = false;
		this.loadingMore = false;
		this.loadMoreErrorMessage = null;
		this.lastAutoLoadAt = 0;
		this.userStartedScrolling = false;
		this.prefetchedRecordings = null;
		this.prefetchInFlight = false;
		this.listInteractionHandler = null;
		this.preparingCustomization = false;
		this.artifactCache.clear();
	}

	private async refresh(): Promise<void> {
		// Full reset on every refresh — this covers both the initial open
		// and the error-state Retry click. Any pending Load More from a
		// previous render is invalidated via the generation bump below.
		this.selectedIds.clear();
		this.teardownAutoLoadObserver();
		this.importButton = null;
		this.reviewArtifactsButton = null;
		this.listEl = null;
		this.progressEl = null;
		this.progressTextEl = null;
		this.progressActionButton = null;
		this.autoLoadSentinelEl = null;
		this.introEl = null;
		this.currentRecordings = [];
		this.hasMore = false;
		this.loadingMore = false;
		this.loadMoreErrorMessage = null;
		this.lastAutoLoadAt = 0;
		this.userStartedScrolling = false;
		this.prefetchedRecordings = null;
		this.prefetchInFlight = false;
		this.listInteractionHandler = null;
		this.preparingCustomization = false;
		this.artifactCache.clear();
		const generation = ++this.fetchGeneration;
		this.renderLoading();
		try {
			const recordings = await this.client.listRecordings({
				skip: 0,
				limit: PAGE_SIZE,
			});
			if (generation !== this.fetchGeneration) {
				// A newer refresh() started while we were waiting. Drop the
				// stale result on the floor.
				return;
			}
			const { merged, hasMore } = mergeRecordings([], recordings, PAGE_SIZE);
			this.currentRecordings = [...merged];
			this.hasMore = hasMore;
			if (this.currentRecordings.length === 0) {
				this.renderEmpty();
			} else {
				this.renderList();
			}
		} catch (err) {
			if (generation !== this.fetchGeneration) {
				return;
			}
			console.error('Plaud Importer: listRecordings failed', err);
			this.renderError(classifyError(err));
		}
	}

	private async loadMore(trigger: LoadMoreTrigger): Promise<void> {
		// Re-entry guard: fast double-clicks or keyboard activations can
		// fire the click handler twice before the button is visually
		// disabled. The flag is the source of truth; the disabled state
		// is just visual feedback.
		if (this.loadingMore || !this.hasMore) {
			return;
		}
		if (trigger === 'auto' && this.prefetchInFlight && this.prefetchedRecordings === null) {
			return;
		}
		if (trigger === 'auto' && this.loadMoreErrorMessage !== null) {
			return;
		}
		this.loadingMore = true;
		this.loadMoreErrorMessage = null;
		const generation = this.fetchGeneration;
		const skip = this.currentRecordings.length;
		this.updateProgressUi();

		try {
			let incoming: readonly Recording[];
			if (this.prefetchedRecordings !== null) {
				incoming = this.prefetchedRecordings;
				this.prefetchedRecordings = null;
			} else {
				incoming = await this.fetchPageWithSilentRetry(skip, trigger);
			}
			if (generation !== this.fetchGeneration) {
				// A refresh() fired while we were waiting — the list has
				// been torn down. Drop the stale page.
				return;
			}
			const { merged, hasMore } = mergeRecordings(
				this.currentRecordings,
				incoming,
				PAGE_SIZE,
			);
			// Figure out which rows are actually new so we can append only
			// those instead of re-rendering the whole list. Uses ID equality
			// against the pre-merge accumulator — this is correct regardless
			// of how mergeRecordings handles dedupe, because we're comparing
			// the post-merge list to what was on screen before.
			const existingIds = new Set(this.currentRecordings.map((r) => r.id));
			const newRows = merged.filter((r) => !existingIds.has(r.id));
			this.currentRecordings = [...merged];
			this.hasMore = hasMore;

			if (this.listEl !== null) {
				for (const rec of newRows) {
					this.renderRow(this.listEl, rec);
				}
			}
			this.updateIntroCount();
			this.updateProgressUi();
			this.startPrefetchIfNeeded();
		} catch (err) {
			if (generation !== this.fetchGeneration) {
				return;
			}
			console.error('Plaud Importer: loadMore failed', err);
			// Show a Notice rather than tearing down the list — the user
			// still has their selections and their already-loaded pages,
			// and losing them on a transient network blip would be rude.
			const classification = classifyError(err);
			new Notice(`Plaud Importer: could not load more — ${classification.message}`);
			this.loadMoreErrorMessage = classification.message;
			this.updateProgressUi();
		} finally {
			this.loadingMore = false;
			this.updateProgressUi();
		}
	}

	private renderLoading(): void {
		const { contentEl } = this;
		contentEl.empty();
		const box = contentEl.createDiv({ cls: 'plaud-importer-state' });
		box.createEl('p', {
			text: 'Loading recordings from Plaud.AI…',
			cls: 'plaud-importer-loading',
		});
	}

	private renderEmpty(): void {
		const { contentEl } = this;
		contentEl.empty();
		const box = contentEl.createDiv({ cls: 'plaud-importer-state' });
		box.createEl('p', {
			text: 'No recordings found in your Plaud.AI account.',
			cls: 'plaud-importer-empty',
		});
		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const closeButton = buttonRow.createEl('button', { text: 'Close' });
		closeButton.addEventListener('click', () => this.close());
	}

	private renderError(classification: ErrorClassification): void {
		const { contentEl } = this;
		contentEl.empty();
		const box = contentEl.createDiv({ cls: 'plaud-importer-state' });
		box.createEl('p', {
			text: classification.message,
			cls: 'plaud-importer-error-message',
		});
		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });

		const copyButton = buttonRow.createEl('button', { text: 'Copy error' });
		copyButton.addEventListener('click', () => {
			const payload = formatErrorForClipboard(classification);
			void copyToClipboard(payload);
		});

		if (classification.canRetry) {
			const retryButton = buttonRow.createEl('button', {
				text: 'Retry',
				cls: 'mod-cta',
			});
			retryButton.addEventListener('click', () => {
				this.refresh().catch((err) => {
					console.error('Plaud Importer: retry failed', err);
					this.renderError(classifyError(err));
				});
			});
		}
		const closeButton = buttonRow.createEl('button', { text: 'Close' });
		closeButton.addEventListener('click', () => this.close());
	}

	private renderList(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.introEl = contentEl.createEl('p', {
			cls: 'plaud-importer-intro',
		});
		this.updateIntroCount();

		const listEl = contentEl.createDiv({ cls: 'plaud-importer-list' });
		this.listEl = listEl;
		for (const rec of this.currentRecordings) {
			this.renderRow(listEl, rec);
		}
		this.ensureProgressElements();
		this.updateProgressUi();
		this.setupAutoLoadObserver();

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		this.importButton = buttonRow.createEl('button', {
			text: 'Import selected (defaults)',
			cls: 'mod-cta',
		});
		this.importButton.disabled = true;
		this.importButton.addEventListener('click', () => {
			const selection = this.getDefaultArtifactSelection();
			this.onImportClick(selection).catch((err) => {
				// onImportClick has internal error handling around every
				// write and the writer construction — this outer catch is
				// defense-in-depth against a future bug that throws outside
				// those try/catch blocks.
				console.error('Plaud Importer: unexpected error in onImportClick', err);
				this.renderError(classifyError(err));
			});
		});
		const customizeButton = buttonRow.createEl('button', {
			text: 'Review artifacts first',
		});
		this.reviewArtifactsButton = customizeButton;
		customizeButton.disabled = this.selectedIds.size === 0 || this.preparingCustomization;
		customizeButton.addEventListener('click', () => {
			this.beginCustomizationFlow().catch((err) => {
				console.error('Plaud Importer: customization preflight failed', err);
				new Notice('Plaud Importer: could not inspect artifacts.');
			});
		});

		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => this.close());
		this.updateImportButtonState();
	}

	private renderRow(listEl: HTMLElement, rec: Recording): void {
		// Keep rows ahead of footer/sentinel tail elements.
		const row = listEl.createDiv({ cls: 'plaud-importer-row' });
		if (this.progressEl !== null && this.progressEl.parentElement === listEl) {
			listEl.insertBefore(row, this.progressEl);
		}

		const checkbox = row.createEl('input', {
			type: 'checkbox',
			cls: 'plaud-importer-checkbox',
		});
		// Initialize from selectedIds so a mid-stream re-render (or a
		// future incremental render that reuses rows) reflects the
		// user's current selection instead of always starting unchecked.
		checkbox.checked = this.selectedIds.has(rec.id);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) {
				this.selectedIds.add(rec.id);
			} else {
				this.selectedIds.delete(rec.id);
			}
			this.updateImportButtonState();
		});

		const labelWrap = row.createDiv({ cls: 'plaud-importer-label' });
		labelWrap.createDiv({ text: rec.title, cls: 'plaud-importer-title' });

		const meta = labelWrap.createDiv({ cls: 'plaud-importer-meta' });
		meta.createSpan({ text: formatDate(rec.createdAt) });
		meta.createSpan({ text: '  ·  ', cls: 'plaud-importer-sep' });
		meta.createSpan({ text: formatDuration(rec.durationSeconds) });
	}

	private updateImportButtonState(): void {
		if (this.importButton) {
			this.importButton.disabled = this.selectedIds.size === 0 || this.preparingCustomization;
		}
		if (this.reviewArtifactsButton) {
			this.reviewArtifactsButton.disabled =
				this.selectedIds.size === 0 || this.preparingCustomization;
		}
	}

	private getDefaultArtifactSelection(): ArtifactSelection {
		return {
			includeSummary: this.noteWriterOptions.defaultIncludeSummary !== false,
			includeTranscript: this.noteWriterOptions.includeTranscript !== false,
			includeAttachments: this.noteWriterOptions.defaultIncludeAttachments !== false,
			includeMindmap: this.noteWriterOptions.defaultIncludeMindmap !== false,
			includeCard: this.noteWriterOptions.defaultIncludeCard !== false,
		};
	}

	private async beginCustomizationFlow(): Promise<void> {
		if (this.selectedIds.size === 0 || this.preparingCustomization) {
			return;
		}
		this.preparingCustomization = true;
		this.updateImportButtonState();
		new Notice('Plaud Importer: checking available artifacts...');
		try {
			const selected = this.currentRecordings.filter((r) => this.selectedIds.has(r.id));
			for (const recording of selected) {
				await this.ensureArtifactsForRecording(recording.id);
			}
			const availability = this.computeArtifactAvailability(selected);
			const defaults = this.getDefaultArtifactSelection();
			const initialSelection: ArtifactSelection = {
				includeSummary: defaults.includeSummary && availability.summaryCount > 0,
				includeTranscript: defaults.includeTranscript && availability.transcriptCount > 0,
				includeAttachments:
					defaults.includeAttachments && availability.attachmentsCount > 0,
				includeMindmap: defaults.includeMindmap && availability.mindmapCount > 0,
				includeCard: defaults.includeCard && availability.cardCount > 0,
			};
			const selection = await this.promptArtifactSelection(availability, initialSelection);
			if (selection === null) {
				return;
			}
			await this.onImportClick(selection);
		} catch (err) {
			const classification = classifyError(err);
			new Notice(`Plaud Importer: could not inspect artifacts — ${classification.message}`);
		} finally {
			this.preparingCustomization = false;
			this.updateImportButtonState();
		}
	}

	private async ensureArtifactsForRecording(
		recordingId: PlaudRecordingId,
	): Promise<TranscriptAndSummary> {
		const cached = this.artifactCache.get(recordingId);
		if (cached !== undefined) {
			return cached;
		}
		const bundle = await this.client.getTranscriptAndSummary(recordingId);
		this.artifactCache.set(recordingId, bundle);
		return bundle;
	}

	private computeArtifactAvailability(selected: readonly Recording[]): ArtifactAvailability {
		let summaryCount = 0;
		let transcriptCount = 0;
		let attachmentsCount = 0;
		let mindmapCount = 0;
		let cardCount = 0;
		const diagnostics: Array<Record<string, unknown>> = [];
		for (const recording of selected) {
			const bundle = this.artifactCache.get(recording.id);
			if (bundle === undefined) {
				continue;
			}
			if (bundle.summary !== null) summaryCount += 1;
			if (bundle.transcript !== null) transcriptCount += 1;
			const assets = bundle.attachments ?? [];
			if (assets.some((a) => this.classifyAttachmentKind(a) === 'generic')) {
				attachmentsCount += 1;
			}
			if (assets.some((a) => this.classifyAttachmentKind(a) === 'mindmap')) {
				mindmapCount += 1;
			}
			if (assets.some((a) => this.classifyAttachmentKind(a) === 'card')) {
				cardCount += 1;
			}
			if (this.noteWriterOptions.debugLogger?.enabled === true) {
				const kindCounts = { generic: 0, mindmap: 0, card: 0 };
				for (const asset of assets) {
					const kind = this.classifyAttachmentKind(asset);
					kindCounts[kind] += 1;
				}
				diagnostics.push({
					recordingId: recording.id,
					recordingTitle: recording.title,
					attachmentCount: assets.length,
					kindCounts,
					attachmentTypes: assets.map((a) => a.dataType),
				});
			}
		}
		if (diagnostics.length > 0) {
			this.logImportDebug('artifact availability diagnostics', diagnostics);
		}
		return {
			selectedCount: selected.length,
			summaryCount,
			transcriptCount,
			attachmentsCount,
			mindmapCount,
			cardCount,
		};
	}

	private promptArtifactSelection(
		availability: ArtifactAvailability,
		initialSelection: ArtifactSelection,
	): Promise<ArtifactSelection | null> {
		return new Promise((resolve) => {
			const modal = new ArtifactSelectionModal(
				this.app,
				availability,
				initialSelection,
				(selection) => resolve(selection),
			);
			modal.open();
		});
	}

	private updateIntroCount(): void {
		if (this.introEl === null) {
			return;
		}
		const n = this.currentRecordings.length;
		const suffix = this.hasMore ? ' (scroll for more)' : '';
		this.introEl.setText(
			`${n} recording${n === 1 ? '' : 's'} loaded${suffix}. Select which to import.`,
		);
	}

	private ensureProgressElements(): void {
		if (this.listEl === null || this.progressEl !== null) {
			return;
		}
		const progressEl = this.listEl.createDiv({ cls: 'plaud-importer-progress' });
		this.progressEl = progressEl;
		this.progressTextEl = progressEl.createDiv({ cls: 'plaud-importer-progress-text' });
		this.progressActionButton = progressEl.createEl('button', {
			cls: 'plaud-importer-progress-action',
		});
		this.progressActionButton.textContent = 'Load more recordings';
		this.progressActionButton.style.display = 'none';
		this.progressActionButton.addEventListener('click', () => {
			this.onProgressActionClick();
		});
		this.autoLoadSentinelEl = this.listEl.createDiv({ cls: 'plaud-importer-sentinel' });
	}

	private onProgressActionClick(): void {
		const trigger: LoadMoreTrigger =
			this.loadMoreErrorMessage !== null ? 'retry' : 'manual';
		this.userStartedScrolling = true;
		this.startPrefetchIfNeeded();
		void this.loadMore(trigger).catch((err) => {
			console.error('Plaud Importer: unexpected error in loadMore', err);
			new Notice('Plaud Importer: could not load more — see the developer console.');
		});
	}

	private updateProgressUi(): void {
		this.ensureProgressElements();
		if (
			this.progressEl === null ||
			this.progressTextEl === null ||
			this.progressActionButton === null
		) {
			return;
		}
		this.progressEl.hidden = false;
		this.setProgressActionButton(null);
		if (this.loadingMore) {
			this.progressTextEl.setText('Loading more recordings...');
			return;
		}
		if (!this.hasMore) {
			this.progressTextEl.setText('You are all caught up.');
			return;
		}
		if (this.loadMoreErrorMessage !== null) {
			this.progressTextEl.setText(`Could not load more: ${this.loadMoreErrorMessage}`);
			this.setProgressActionButton('Retry loading');
			return;
		}
		if (this.prefetchInFlight) {
			this.progressTextEl.setText('Caching next recordings...');
			return;
		}
		if (!this.userStartedScrolling) {
			this.progressTextEl.setText('Scroll to browse older recordings.');
			return;
		}
		if (this.prefetchedRecordings !== null) {
			this.progressTextEl.setText('Next recordings cached. Keep scrolling.');
			return;
		}
		this.progressTextEl.setText('Scroll to load more recordings.');
	}

	private setProgressActionButton(label: string | null): void {
		if (this.progressActionButton === null) {
			return;
		}
		if (label === null) {
			this.progressActionButton.style.display = 'none';
			this.progressActionButton.disabled = false;
			return;
		}
		this.progressActionButton.style.display = '';
		this.progressActionButton.textContent = label;
		this.progressActionButton.disabled = false;
	}

	private handleListInteraction(): void {
		if (this.userStartedScrolling) {
			return;
		}
		this.userStartedScrolling = true;
		this.startPrefetchIfNeeded();
		this.updateProgressUi();
	}

	private startPrefetchIfNeeded(): void {
		if (!this.userStartedScrolling || !this.hasMore) {
			return;
		}
		if (this.loadingMore || this.prefetchInFlight || this.prefetchedRecordings !== null) {
			return;
		}
		const generation = this.fetchGeneration;
		const skip = this.currentRecordings.length;
		this.prefetchInFlight = true;
		this.updateProgressUi();
		void this.client
			.listRecordings({
				skip,
				limit: PAGE_SIZE,
			})
			.then((incoming) => {
				if (generation !== this.fetchGeneration) {
					return;
				}
				this.prefetchedRecordings = incoming;
			})
			.catch((err) => {
				if (generation !== this.fetchGeneration) {
					return;
				}
				console.warn('Plaud Importer: next-page prefetch failed', err);
				// Prefetch failures are intentionally silent; regular loadMore
				// still handles user-visible error messages.
			})
			.finally(() => {
				if (generation !== this.fetchGeneration) {
					return;
				}
				this.prefetchInFlight = false;
				this.updateProgressUi();
				if (this.isListNearBottom()) {
					this.maybeAutoLoad();
				}
			});
	}

	private setupAutoLoadObserver(): void {
		this.teardownAutoLoadObserver();
		if (this.listEl === null || this.autoLoadSentinelEl === null) {
			return;
		}
		this.listInteractionHandler = () => this.handleListInteraction();
		this.listEl.addEventListener('wheel', this.listInteractionHandler, { passive: true });
		this.listEl.addEventListener('touchmove', this.listInteractionHandler, {
			passive: true,
		});
		this.listEl.addEventListener('scroll', this.listInteractionHandler, {
			passive: true,
		});
		if (typeof IntersectionObserver !== 'undefined') {
			this.autoLoadObserver = new IntersectionObserver(
				(entries) => {
					if (!entries.some((entry) => entry.isIntersecting)) {
						return;
					}
					this.maybeAutoLoad();
				},
				{
					root: this.listEl,
					rootMargin: `0px 0px ${AUTO_LOAD_ROOT_MARGIN_PX}px 0px`,
				},
			);
			this.autoLoadObserver.observe(this.autoLoadSentinelEl);
			return;
		}
		this.scrollFallbackHandler = () => {
			if (this.listEl === null) {
				return;
			}
			if (this.isListNearBottom()) {
				this.maybeAutoLoad();
			}
		};
		this.listEl.addEventListener('scroll', this.scrollFallbackHandler);
	}

	private teardownAutoLoadObserver(): void {
		if (this.autoLoadObserver !== null) {
			this.autoLoadObserver.disconnect();
			this.autoLoadObserver = null;
		}
		if (this.listEl !== null && this.listInteractionHandler !== null) {
			this.listEl.removeEventListener('wheel', this.listInteractionHandler);
			this.listEl.removeEventListener('touchmove', this.listInteractionHandler);
			this.listEl.removeEventListener('scroll', this.listInteractionHandler);
		}
		this.listInteractionHandler = null;
		if (this.listEl !== null && this.scrollFallbackHandler !== null) {
			this.listEl.removeEventListener('scroll', this.scrollFallbackHandler);
		}
		this.scrollFallbackHandler = null;
	}

	private maybeAutoLoad(): void {
		if (!this.hasMore || this.loadingMore) {
			return;
		}
		if (!this.userStartedScrolling) {
			return;
		}
		if (this.prefetchInFlight && this.prefetchedRecordings === null) {
			return;
		}
		if (this.loadMoreErrorMessage !== null) {
			return;
		}
		const now = Date.now();
		if (now - this.lastAutoLoadAt < AUTO_LOAD_THROTTLE_MS) {
			return;
		}
		this.lastAutoLoadAt = now;
		void this.loadMore('auto').catch((err) => {
			console.error('Plaud Importer: unexpected auto-load error', err);
		});
	}

	private isListNearBottom(): boolean {
		if (this.listEl === null) {
			return false;
		}
		const remaining =
			this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight;
		return remaining <= AUTO_LOAD_ROOT_MARGIN_PX;
	}

	private async fetchPageWithSilentRetry(
		skip: number,
		trigger: LoadMoreTrigger,
	): Promise<readonly Recording[]> {
		const fetchOnce = async (): Promise<readonly Recording[]> => {
			return this.client.listRecordings({
				skip,
				limit: PAGE_SIZE,
			});
		};
		try {
			return await fetchOnce();
		} catch (firstErr) {
			const classification = classifyError(firstErr);
			const shouldRetry = trigger === 'auto' && classification.canRetry;
			if (!shouldRetry) {
				throw firstErr;
			}
			await this.sleep(AUTO_LOAD_SILENT_RETRY_DELAY_MS);
			return fetchOnce();
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			window.setTimeout(resolve, ms);
		});
	}

	private async onImportClick(selection: ArtifactSelection): Promise<void> {
		const selected = this.currentRecordings.filter((r) =>
			this.selectedIds.has(r.id),
		);
		if (selected.length === 0) {
			return;
		}
		const duplicatePolicy = await this.resolveDuplicatePolicyForImport(selected.length);
		if (duplicatePolicy === null) {
			return;
		}

		// Reset sticky state so choices from a prior run do not leak into
		// this batch. Only 'prompt' mode consumes this field, but
		// resetting unconditionally keeps the invariant simple.
		this.stickyDuplicateDecision = null;
		this.currentBatchSize = selected.length;

		// Construct the writer lazily. A NoteWriterError here means the
		// user's config is bad ("..", invalid onDuplicate) — surface via
		// the error state with the config-error classification so the UI
		// points at Settings rather than saying "unknown error please
		// report this." Anything else is a real code bug; re-throw so the
		// outer click handler's .catch picks it up honestly.
		let writer: NoteWriter;
		try {
			writer = new NoteWriter(this.app.vault, {
				...this.noteWriterOptions,
				onDuplicate: duplicatePolicy,
				promptOnDuplicate:
					duplicatePolicy === 'prompt' ? this.handleDuplicatePrompt : undefined,
			});
		} catch (err) {
			if (err instanceof NoteWriterError) {
				console.error('Plaud Importer: NoteWriter construction failed', err);
				this.renderError(classifyError(err));
				return;
			}
			throw err;
		}

		// Disable the Import button so rapid double-clicks don't queue a
		// second run against the same selection.
		if (this.importButton) {
			this.importButton.disabled = true;
			this.importButton.textContent = `Importing 0 of ${selected.length}…`;
		}

		// Sequential rather than parallel: Plaud does not document a rate
		// limit, and sequential ordering is cheap insurance against
		// throttling. A per-recording failure is caught and recorded but
		// does not stop the batch — this is the "partial success" semantic
		// users expect for a multi-select import.
		const results: ImportResult[] = [];
		for (let i = 0; i < selected.length; i++) {
			// Bail on mid-import modal close. Fire a partial Notice so
			// the user sees what was completed before they hit Esc.
			if (this.aborted) {
				new Notice(
					`${formatImportNotice(tallyImportResults(results))} (cancelled at ${i}/${selected.length})`,
				);
				return;
			}

			const recording = selected[i];
			if (this.importButton) {
				this.importButton.textContent = `Importing ${i + 1} of ${selected.length}…`;
			}
			try {
				const {
					transcript,
					summary,
					aiKeywords,
					chapters,
					attachments,
					nestedAssetLinks,
				} = await this.ensureArtifactsForRecording(recording.id);
				const summaryLinkedAttachments = this.extractAttachmentAssetsFromSummaryMarkdown(
					summary?.text ?? null,
				);
				const mergedAttachments = this.mergeAttachmentAssets(
					attachments ?? [],
					summaryLinkedAttachments,
				);
				// DD-004: merge Plaud's AI-generated keyword list (from
				// /file/detail/) into the recording's tags before the note
				// is rendered. mergeTagSources owns the namespacing, slug,
				// and dedup rules; this site just feeds it the two
				// sources. When both inputs are empty the result is [],
				// and formatFrontmatter already handles that path by
				// omitting the tags: key entirely.
				const mergedTags = mergeTagSources(recording.tags, aiKeywords);
				const enrichedRecording =
					mergedTags.length > 0
						? { ...recording, tags: mergedTags }
						: recording;
				const formatOptions: FormatMarkdownOptions = {
					includeTranscript: selection.includeTranscript,
					includeSummary: selection.includeSummary,
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
				this.logImportDebug('note write outcome', {
					recordingId: recording.id,
					recordingTitle: recording.title,
					status: writeOutcome.status,
					path: writeOutcome.path,
					attachmentCount: mergedAttachments.length,
					summaryLinkedAttachmentCount: summaryLinkedAttachments.length,
				});
				if (
					(
						selection.includeAttachments ||
						selection.includeMindmap ||
						selection.includeCard
					) &&
					writeOutcome.status !== 'skipped' &&
					mergedAttachments.length > 0
				) {
					await this.importAttachmentsForNote(
						writeOutcome.path,
						mergedAttachments,
						selection,
						writeOutcome.status === 'overwritten',
						recording.id,
						nestedAssetLinks,
					);
				} else {
					this.logImportDebug('attachment import not started', {
						recordingId: recording.id,
						noteStatus: writeOutcome.status,
						attachmentCount: mergedAttachments.length,
						summaryLinkedAttachmentCount: summaryLinkedAttachments.length,
						reason:
							!(
								selection.includeAttachments ||
								selection.includeMindmap ||
								selection.includeCard
							)
								? 'attachments disabled by artifact selection'
								: writeOutcome.status === 'skipped'
								? 'note skipped by duplicate policy'
								: 'no attachments in transcript bundle',
					});
				}
				// Apply transcript folding AFTER all post-write mutations
				// (including attachment section insertion) so the saved
				// heading line always matches the final file layout.
				if (
					writeOutcome.status !== 'skipped' &&
					this.noteWriterOptions.foldTranscript !== false
				) {
					await this.applyTranscriptFold(writeOutcome.path);
				}
				// Report the original recording in the result so any
				// downstream UI that renders the import summary sees the
				// same object the modal already knows about. The merged
				// tags only need to exist long enough to land in the
				// written note's frontmatter.
				results.push({ kind: 'written', recording, writeOutcome });
			} catch (err) {
				// User cancelled the per-file duplicate prompt. Break the
				// loop without recording a failure — the current recording
				// was not written, but the cancellation is user-intent,
				// not an error condition worth classifying.
				if (err instanceof NoteWriterCancelledError) {
					new Notice(
						`${formatImportNotice(tallyImportResults(results))} (cancelled at ${i}/${selected.length})`,
					);
					return;
				}
				// Log the full error object (including stack and any wrapped
				// `cause`) so it's visible in DevTools. TODO: also plumb a
				// logError(errorIds.IMPORT_RECORDING_FAILED, ...) telemetry
				// call once the plugin has telemetry infrastructure.
				console.error(
					`Plaud Importer: import failed for recording ${recording.id} "${recording.title}"`,
					err,
				);
				const classification = classifyError(err);
				results.push({
					kind: 'failed',
					recording,
					reason: classification.message,
					classification,
					cause: err,
				});
			}
		}

		// Final abort check — if the user closed the modal right after
		// the last write, we still want the partial Notice to fire.
		if (this.aborted) {
			new Notice(
				`${formatImportNotice(tallyImportResults(results))} (cancelled at ${selected.length}/${selected.length})`,
			);
			return;
		}

		this.renderSummary(tallyImportResults(results));
	}

	private async resolveDuplicatePolicyForImport(
		selectedCount: number,
	): Promise<DuplicatePolicy | null> {
		// 'skip' and 'prompt' do not require a batch-level confirmation.
		// 'prompt' defers the decision to each duplicate at write time.
		if (this.noteWriterOptions.onDuplicate !== 'overwrite') {
			return this.noteWriterOptions.onDuplicate;
		}
		const choice = await this.promptOverwriteConfirmation(selectedCount);
		if (choice === 'cancel') {
			return null;
		}
		if (choice === 'skip') {
			new Notice('Plaud Importer: using "skip existing" for this import run.');
			return 'skip';
		}
		return 'overwrite';
	}

	/**
	 * Callback handed to NoteWriter when the duplicate policy is
	 * 'prompt'. Honors the sticky decision first so "Overwrite all
	 * remaining" / "Skip all remaining" short-circuits subsequent
	 * prompts in the same batch. Cancel bubbles back as 'cancel' which
	 * the writer translates into NoteWriterCancelledError.
	 */
	private readonly handleDuplicatePrompt: DuplicatePromptCallback = async (ctx) => {
		if (this.aborted) {
			return 'cancel';
		}
		if (this.stickyDuplicateDecision !== null) {
			return this.stickyDuplicateDecision;
		}
		const choice = await this.askDuplicateDecision(
			ctx.recordingTitle,
			ctx.targetPath,
			this.currentBatchSize > 1,
		);
		switch (choice) {
			case 'overwrite':
				return 'overwrite';
			case 'skip':
				return 'skip';
			case 'overwrite-all':
				this.stickyDuplicateDecision = 'overwrite';
				new Notice('Plaud Importer: overwriting all remaining duplicates in this run.');
				return 'overwrite';
			case 'skip-all':
				this.stickyDuplicateDecision = 'skip';
				new Notice('Plaud Importer: skipping all remaining duplicates in this run.');
				return 'skip';
			case 'cancel':
				return 'cancel';
		}
	};

	private askDuplicateDecision(
		recordingTitle: string,
		targetPath: string,
		showBatchOptions: boolean,
	): Promise<DuplicateDecisionChoice> {
		return new Promise((resolve) => {
			const modal = new DuplicateDecisionModal(
				this.app,
				recordingTitle,
				targetPath,
				showBatchOptions,
				resolve,
			);
			modal.open();
		});
	}

	private promptOverwriteConfirmation(
		selectedCount: number,
	): Promise<'overwrite' | 'skip' | 'cancel'> {
		return new Promise((resolve) => {
			const modal = new OverwriteConfirmationModal(this.app, selectedCount, resolve);
			modal.open();
		});
	}

	/**
	 * Persist fold state for the wrapping transcript heading in a
	 * freshly-written note so the chaptered transcript renders
	 * collapsed by default while the external chapters callout stays
	 * visible above it. Uses Obsidian's undocumented but stable
	 * internal `app.foldManager.save` API (type-augmented in
	 * `types.d.ts`) plus a best-effort same-session apply via the
	 * active MarkdownView's `applyFoldInfo` when the file happens to
	 * already be open in a leaf.
	 *
	 * Failure is swallowed with a console warning: a missing
	 * foldManager (older Obsidian) or an applyFoldInfo rejection
	 * degrades to expanded-by-default, which is unfortunate but never
	 * breaks the import. This method must never throw into the
	 * import loop.
	 */
	private async applyTranscriptFold(path: string): Promise<void> {
		try {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) {
				return;
			}
			const body = await this.app.vault.read(file);
			const headerLevel = this.noteWriterOptions.transcriptHeaderLevel ?? 4;
			const transcriptHeadingLine = findTranscriptHeadingLine(body, headerLevel);
			if (transcriptHeadingLine === null) {
				return;
			}
			const totalLines = body.split('\n').length;
			const foldInfo = {
				folds: [
					{
						from: transcriptHeadingLine,
						to: transcriptHeadingLine,
					},
				],
				lines: totalLines,
			};
			// Persist the fold state so the next file-open applies it.
			// The foldManager API is not part of the documented
			// Obsidian surface — guard its presence at runtime to stay
			// compatible with future Obsidian versions that might move
			// or rename it.
			if (this.app.foldManager && typeof this.app.foldManager.save === 'function') {
				await this.app.foldManager.save(file, foldInfo);
			}
			// Best-effort in-session apply: if the note is already open
			// in an active MarkdownView, push the fold state into its
			// current mode right now so the user sees the folds without
			// having to close and reopen the tab.
			const leaves = this.app.workspace.getLeavesOfType('markdown');
			for (const leaf of leaves) {
				if (
					leaf.view instanceof MarkdownView &&
					leaf.view.file?.path === path &&
					leaf.view.currentMode &&
					typeof leaf.view.currentMode.applyFoldInfo === 'function'
				) {
					leaf.view.currentMode.applyFoldInfo(foldInfo);
				}
			}
		} catch (err) {
			console.warn(
				`Plaud Importer: failed to apply transcript fold state for ${path}`,
				err,
			);
		}
	}

	private async importAttachmentsForNote(
		notePath: string,
		attachments: readonly AttachmentAsset[],
		selection: ArtifactSelection,
		replaceExisting: boolean,
		recordingId: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): Promise<void> {
		if (attachments.length === 0) {
			return;
		}
		this.logAttachmentDebug('starting attachment import', {
			notePath,
			attachmentCount: attachments.length,
		});
		const noteFile = this.app.vault.getFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			this.logAttachmentDebug('attachment import aborted: note file not found', {
				notePath,
			});
			return;
		}
		const folderPath = notePath.replace(/\.md$/i, '-assets');
		const folder = this.app.vault.getFolderByPath(folderPath);
		if (folder === null) {
			await this.app.vault.createFolder(folderPath);
			this.logAttachmentDebug('created attachment folder', { folderPath });
		} else if (replaceExisting && folder instanceof TFolder) {
			await this.clearAttachmentFolder(folder);
			this.logAttachmentDebug('cleared existing attachment folder for overwrite', {
				folderPath,
			});
		}

		const genericLinks: string[] = [];
		const mindmapAssets: RenderedAsset[] = [];
		const cardAssets: RenderedAsset[] = [];
		const genericAssets: RenderedAsset[] = [];
		const mindmapLinks: string[] = [];
		const cardLinks: string[] = [];
		const payloadToPath = new Map<string, string>();
		const renderedLinks = new Set<string>();
		const namingCounters: AttachmentNamingCounters = {
			mindmapImage: 0,
			mindmapFile: 0,
			cardImage: 0,
			cardFile: 0,
			genericImage: 0,
			genericFile: 0,
		};
		const idPrefix = this.getAttachmentIdPrefix(recordingId);
		let htmlMindmapCandidates = 0;
		const pushRenderedAsset = (
			kind: AttachmentKind,
			path: string,
			isImage: boolean,
		): void => {
			const dedupeKey = `${kind}:${path}`;
			if (renderedLinks.has(dedupeKey)) {
				return;
			}
			renderedLinks.add(dedupeKey);
			switch (kind) {
				case 'mindmap':
					mindmapAssets.push({ path, isImage });
					break;
				case 'card':
					cardAssets.push({ path, isImage });
					break;
				default:
					genericAssets.push({ path, isImage });
			}
		};
		for (let i = 0; i < attachments.length; i++) {
			const asset = attachments[i];
			const assetLabel = `${asset.dataType}#${i + 1}`;
			const kind = this.classifyAttachmentKind(asset);
			if (!this.shouldIncludeAttachmentKind(kind, selection)) {
				this.logAttachmentDebug('skipping attachment due to artifact selection', {
					assetLabel,
					dataType: asset.dataType,
					kind,
				});
				continue;
			}
			this.logAttachmentDebug('downloading primary attachment', {
				assetLabel,
				dataType: asset.dataType,
				name: asset.name ?? null,
				mimeType: asset.mimeType ?? null,
				url: this.sanitizeUrlForDebug(asset.url),
			});
			const candidates = this.buildPrimaryAttachmentCandidates(
				asset.url,
				nestedAssetLinks,
			);
			this.logAttachmentDebug('primary attachment candidates resolved', {
				assetLabel,
				candidates: candidates.map((candidate) => this.sanitizeUrlForDebug(candidate)),
			});
			let imported = false;
			for (const candidate of candidates) {
				try {
					const headers: Record<string, string> = { Accept: '*/*' };
					const token = this.noteWriterOptions.getAuthToken?.()?.trim();
					if (
						token &&
						token.length > 0 &&
						this.shouldSendAuthHeader(candidate)
					) {
						headers.Authorization = `Bearer ${token}`;
					}
				const blob = await requestUrl({
						url: candidate,
					method: 'GET',
					throw: false,
						headers,
				});
				const contentType = this.getResponseHeader(blob, 'content-type') ?? null;
				this.logAttachmentDebug('primary attachment response', {
					assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					status: blob.status,
					contentType,
				});
				if (blob.status < 200 || blob.status >= 300) {
					this.logAttachmentDebug('skipping primary attachment due to non-2xx status', {
						assetLabel,
							candidate: this.sanitizeUrlForDebug(candidate),
						status: blob.status,
					});
						continue;
				}
				const bytes = this.responseToArrayBuffer(blob);
				if (bytes === null) {
					this.logAttachmentDebug('skipping primary attachment: empty body', {
						assetLabel,
							candidate: this.sanitizeUrlForDebug(candidate),
					});
						continue;
				}
				const bodyText = blob.text ?? '';
				const ext = this.inferAssetExtension(asset, bodyText, contentType ?? '');
				this.logAttachmentDebug('resolved primary attachment extension', {
					assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					extension: ext,
					byteLength: bytes.byteLength,
				});
				if ((contentType ?? '').toLowerCase().includes('text/html')) {
					this.logAttachmentDebug('parsing html attachment for image references', {
						assetLabel,
						bodyPreview: this.makeBodyPreview(bodyText),
					});
					const imageLinks = this.extractImageLinksFromHtml(bodyText);
					const htmlKind = this.classifyHtmlArtifactKind(bodyText, kind);
					if (htmlKind === 'mindmap') {
						htmlMindmapCandidates += 1;
					}
					this.logAttachmentDebug('html attachment image extraction result', {
						assetLabel,
						htmlKind,
						imageLinkCount: imageLinks.length,
						imageLinks: imageLinks.map((link) => this.sanitizeUrlForDebug(link)),
					});
					if (imageLinks.length > 0) {
						for (let j = 0; j < imageLinks.length; j++) {
							const nestedLabel = `${assetLabel}/html#${j + 1}`;
							const nestedKind =
								htmlKind !== 'generic'
									? htmlKind
									: this.classifyAttachmentKindFromValues(
											asset.dataType,
											asset.name,
											imageLinks[j],
										);
							const nested = await this.downloadNestedPictureAsset(
								imageLinks[j],
								folderPath,
								nestedKind,
								nestedLabel,
								payloadToPath,
								namingCounters,
								idPrefix,
								nestedAssetLinks,
							);
							if (nested !== null) {
								pushRenderedAsset(nestedKind, nested, true);
							}
						}
					}
					if (imageLinks.length === 0 && htmlKind === 'mindmap') {
						const fp = this.computeAttachmentFingerprint(bytes);
						const existingPath = payloadToPath.get(fp);
						if (existingPath !== undefined) {
							pushRenderedAsset('mindmap', existingPath, false);
						} else {
							const baseName = this.nextAttachmentBaseName(
								'mindmap',
								false,
								namingCounters,
							);
							const prefixed = idPrefix.length > 0 ? `${idPrefix}-${baseName}` : baseName;
							const htmlPath = await this.resolveUniqueAttachmentPath(
								`${folderPath}/${prefixed}.html`,
							);
							await this.app.vault.createBinary(htmlPath, bytes);
							payloadToPath.set(fp, htmlPath);
							pushRenderedAsset('mindmap', htmlPath, false);
						}
					}
					// Never persist raw HTML wrappers as attachment files.
						imported = true;
						break;
				}
				// JSON blobs are only used as metadata envelopes (mainly to
				// discover nested picture_link images). We no longer persist
				// the raw JSON file to keep the imported asset folder clean.
				if (ext === 'json') {
					this.logAttachmentDebug('parsing json attachment for picture_link entries', {
						assetLabel,
						bodyPreview: this.makeBodyPreview(bodyText),
					});
					const extraction = this.extractPictureLinksFromJson(bodyText);
					this.logAttachmentDebug('json attachment picture_link extraction result', {
						assetLabel,
						pictureLinkCount: extraction.links.length,
						parseError: extraction.parseError ?? null,
						pictureLinks: extraction.links.map((link) =>
							this.sanitizeUrlForDebug(link),
						),
					});
					if (extraction.links.length > 0) {
						for (let j = 0; j < extraction.links.length; j++) {
							const nestedLabel = `${assetLabel}/nested#${j + 1}`;
							const nestedKind = this.classifyAttachmentKindFromValues(
								asset.dataType,
								asset.name,
								extraction.links[j],
							);
							const nested = await this.downloadNestedPictureAsset(
								extraction.links[j],
								folderPath,
								nestedKind,
								nestedLabel,
								payloadToPath,
								namingCounters,
								idPrefix,
								nestedAssetLinks,
							);
							if (nested !== null) {
								this.logAttachmentDebug('saved nested picture asset', {
									nestedLabel,
									path: nested,
								});
								pushRenderedAsset(nestedKind, nested, true);
							} else {
								this.logAttachmentDebug('nested picture asset download failed', {
									nestedLabel,
								});
							}
						}
					}
						imported = true;
						break;
				}
				const fp = this.computeAttachmentFingerprint(bytes);
				const existingPath = payloadToPath.get(fp);
				if (existingPath !== undefined) {
					this.logAttachmentDebug('reused existing attachment due to duplicate payload', {
						assetLabel,
						existingPath,
					});
					if (this.isImageExtension(ext)) {
						pushRenderedAsset(kind, existingPath, true);
					} else {
						pushRenderedAsset(kind, existingPath, false);
					}
					imported = true;
					break;
				}
				const base = this.nextAttachmentBaseName(
					kind,
					this.isImageExtension(ext),
					namingCounters,
				);
				const prefixed = idPrefix.length > 0 ? `${idPrefix}-${base}` : base;
				const attachmentPath = await this.resolveUniqueAttachmentPath(
					`${folderPath}/${prefixed}.${ext}`,
				);
				await this.app.vault.createBinary(attachmentPath, bytes);
				payloadToPath.set(fp, attachmentPath);
				this.logAttachmentDebug('saved primary attachment', {
					assetLabel,
					attachmentPath,
					byteLength: bytes.byteLength,
				});
				if (this.isImageExtension(ext)) {
					pushRenderedAsset(kind, attachmentPath, true);
				} else {
					pushRenderedAsset(kind, attachmentPath, false);
				}
					imported = true;
					break;
				} catch (err) {
					this.logAttachmentDebug('primary attachment import failed with exception', {
						assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			if (!imported) {
				console.warn(
					`Plaud Importer: failed to import attachment for ${notePath}`,
					asset,
				);
			}
		}

		const renderSection = (
			title: string,
			assets: readonly RenderedAsset[],
			imageLabel: string,
			fileLabel: string,
		): readonly string[] => {
			if (assets.length === 0) {
				return [];
			}
			const lines: string[] = [title, ''];
			const images = assets.filter((asset) => asset.isImage);
			const files = assets.filter((asset) => !asset.isImage);
			if (images.length > 0) {
				for (let i = 0; i < images.length; i++) {
					lines.push(`#### ${imageLabel} ${i + 1}`, `![[${images[i].path}]]`, '');
				}
			}
			if (files.length > 0) {
				for (let i = 0; i < files.length; i++) {
					lines.push(`#### ${fileLabel} ${i + 1}`, `- [[${files[i].path}]]`, '');
				}
			}
			return lines;
		};
		const renderCardSection = (assets: readonly RenderedAsset[]): readonly string[] => {
			if (assets.length === 0) {
				return [];
			}
			const lines: string[] = ['### Card', ''];
			const images = assets.filter((asset) => asset.isImage);
			const files = assets.filter((asset) => !asset.isImage);
			for (const image of images) {
				lines.push(`![[${image.path}]]`, '');
			}
			for (const file of files) {
				lines.push(`- [[${file.path}]]`, '');
			}
			return lines;
		};
		mindmapLinks.push(
			...renderSection('### Mindmap', mindmapAssets, 'Mindmap image', 'Mindmap file'),
		);
		cardLinks.push(...renderCardSection(cardAssets));
		genericLinks.push(...renderSection('### Other attachments', genericAssets, 'Image', 'File'));
		if (selection.includeMindmap && mindmapAssets.length === 0) {
			const kindCounts = { generic: 0, mindmap: 0, card: 0 };
			for (const asset of attachments) {
				const k = this.classifyAttachmentKind(asset);
				kindCounts[k] += 1;
			}
			const keywordHintAssets = attachments
				.filter((asset) =>
					/(?:mindmap|mind-map|mind_map|mind map)/i.test(
						`${asset.dataType} ${asset.name ?? ''} ${asset.url}`,
					),
				)
				.map((asset) => ({
					dataType: asset.dataType,
					name: asset.name ?? null,
					url: this.sanitizeUrlForDebug(asset.url),
				}));
			const htmlLikeAssets = attachments
				.filter(
					(asset) =>
						/\.html?(?:$|\?)/i.test(asset.url) ||
						/\.html?(?:$|\?)/i.test(asset.name ?? ''),
				)
				.map((asset) => ({
					dataType: asset.dataType,
					name: asset.name ?? null,
					url: this.sanitizeUrlForDebug(asset.url),
				}));
			this.logAttachmentDebug('mindmap import produced no rendered assets', {
				notePath,
				attachmentCount: attachments.length,
				kindCounts,
				htmlMindmapCandidates,
				keywordHintAssetCount: keywordHintAssets.length,
				keywordHintAssets,
				htmlLikeAssetCount: htmlLikeAssets.length,
				htmlLikeAssets,
				likelyCause:
					keywordHintAssets.length === 0 && htmlMindmapCandidates === 0
						? 'no mindmap-like attachment references found in /file/detail bundle for this recording'
						: 'mindmap-like references were present but none rendered',
				attachmentDataTypes: attachments.map((a) => a.dataType),
				attachmentUrls: attachments.map((a) => this.sanitizeUrlForDebug(a.url)),
			});
		}
		if (genericLinks.length + mindmapLinks.length + cardLinks.length === 0) {
			this.logAttachmentDebug('attachment import completed with no rendered links', {
				notePath,
			});
			return;
		}

		await this.app.vault.process(noteFile, (content) => {
			const withoutManagedSection = this.stripManagedAttachmentsSection(content);
			const trimmed = withoutManagedSection.replace(/\s+$/, '');
			const section: string[] = [
				'## Images and Attachments',
				'',
				'_Imported from Plaud file-detail assets at import time._',
				'',
			];
			if (mindmapLinks.length > 0) section.push(...mindmapLinks);
			if (cardLinks.length > 0) section.push(...cardLinks);
			if (genericLinks.length > 0) section.push(...genericLinks);
			const renderedSection = section.join('\n');
			return this.insertManagedAttachmentsSection(trimmed, renderedSection);
		});
		this.logAttachmentDebug('attachments section appended to note', {
			notePath,
			renderedLinkCount: genericLinks.length + mindmapLinks.length + cardLinks.length,
			mindmapCount: mindmapLinks.length,
			cardCount: cardLinks.length,
		});
	}

	private async clearAttachmentFolder(folder: TFolder): Promise<void> {
		const children = [...folder.children];
		for (const child of children) {
			if (child instanceof TFile) {
				await this.app.vault.delete(child);
				continue;
			}
			if (child instanceof TFolder) {
				await this.clearAttachmentFolder(child);
				await this.app.vault.delete(child, true);
			}
		}
	}

	private responseToArrayBuffer(response: RequestUrlResponse): ArrayBuffer | null {
		const candidate = (response as unknown as { arrayBuffer?: unknown }).arrayBuffer;
		if (candidate instanceof ArrayBuffer) {
			return candidate;
		}
		if (typeof response.text === 'string') {
			return new TextEncoder().encode(response.text).buffer;
		}
		return null;
	}

	private inferAssetExtension(
		asset: AttachmentAsset,
		bodyText: string,
		responseContentType: string,
	): string {
		const fromMime = `${asset.mimeType ?? ''};${responseContentType}`.toLowerCase();
		if (fromMime.includes('text/html') || fromMime.includes('application/xhtml+xml')) {
			return 'html';
		}
		if (fromMime.includes('png')) return 'png';
		if (fromMime.includes('jpeg') || fromMime.includes('jpg')) return 'jpg';
		if (fromMime.includes('webp')) return 'webp';
		if (fromMime.includes('gif')) return 'gif';
		if (fromMime.includes('svg')) return 'svg';
		if (fromMime.includes('pdf')) return 'pdf';

		try {
			const pathname = new URL(asset.url).pathname.toLowerCase();
			const m = pathname.match(/\.([a-z0-9]{2,6})$/);
			if (m) {
				return m[1];
			}
		} catch {
			// ignore parse failures and use fallbacks below
		}

		if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
			return 'json';
		}
		return 'bin';
	}

	private isImageExtension(ext: string): boolean {
		const normalized = ext.toLowerCase();
		return (
			normalized === 'png' ||
			normalized === 'jpg' ||
			normalized === 'jpeg' ||
			normalized === 'gif' ||
			normalized === 'webp' ||
			normalized === 'svg' ||
			normalized === 'bmp'
		);
	}

	private classifyAttachmentKind(asset: AttachmentAsset): AttachmentKind {
		return this.classifyAttachmentKindFromValues(
			asset.dataType,
			asset.name,
			asset.url,
		);
	}

	private classifyAttachmentKindFromValues(
		dataType: string,
		name: string | undefined,
		url: string,
	): AttachmentKind {
		const haystack = `${dataType} ${name ?? ''} ${url}`.toLowerCase();
		if (
			haystack.includes('mindmap') ||
			haystack.includes('mind-map') ||
			haystack.includes('mind_map')
		) {
			return 'mindmap';
		}
		if (haystack.includes('card')) {
			return 'card';
		}
		return 'generic';
	}

	private classifyHtmlArtifactKind(
		html: string,
		baseKind: AttachmentKind,
	): AttachmentKind {
		if (baseKind !== 'generic') {
			return baseKind;
		}
		const lower = html.toLowerCase();
		if (
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map') ||
			lower.includes('mind map')
		) {
			return 'mindmap';
		}
		if (lower.includes('card')) {
			return 'card';
		}
		return 'generic';
	}

	private shouldIncludeAttachmentKind(
		kind: AttachmentKind,
		selection: ArtifactSelection,
	): boolean {
		switch (kind) {
			case 'mindmap':
				return selection.includeMindmap;
			case 'card':
				return selection.includeCard;
			default:
				return selection.includeAttachments;
		}
	}

	private getAttachmentIdPrefix(recordingId: string): string {
		const compact = recordingId.replace(/[^a-zA-Z0-9]/g, '');
		if (compact.length === 0) {
			return '';
		}
		return compact.slice(0, 8).toLowerCase();
	}

	private nextAttachmentBaseName(
		kind: AttachmentKind,
		isImage: boolean,
		counters: AttachmentNamingCounters,
	): string {
		if (kind === 'card' && isImage) {
			counters.cardImage += 1;
			return counters.cardImage === 1 ? 'card' : `card${counters.cardImage}`;
		}
		if (kind === 'mindmap' && isImage) {
			counters.mindmapImage += 1;
			return counters.mindmapImage === 1 ? 'mindmap' : `mindmap${counters.mindmapImage}`;
		}
		if (kind === 'mindmap' && !isImage) {
			counters.mindmapFile += 1;
			return counters.mindmapFile === 1 ? 'mindmap' : `mindmap-file${counters.mindmapFile}`;
		}
		if (kind === 'card' && !isImage) {
			counters.cardFile += 1;
			return counters.cardFile === 1 ? 'card-file' : `card-file${counters.cardFile}`;
		}
		if (isImage) {
			counters.genericImage += 1;
			return `image${counters.genericImage}`;
		}
		counters.genericFile += 1;
		return `file${counters.genericFile}`;
	}

	private async resolveUniqueAttachmentPath(basePath: string): Promise<string> {
		const dot = basePath.lastIndexOf('.');
		const stem = dot >= 0 ? basePath.slice(0, dot) : basePath;
		const ext = dot >= 0 ? basePath.slice(dot) : '';
		let candidate = basePath;
		let n = 2;
		while (this.app.vault.getFileByPath(candidate) !== null) {
			candidate = `${stem}-${n}${ext}`;
			n += 1;
		}
		return candidate;
	}

	private extractPictureLinksFromJson(text: string): {
		readonly links: readonly string[];
		readonly parseError?: string;
	} {
		const out: string[] = [];
		try {
			const parsed: unknown = JSON.parse(text);
			const walk = (value: unknown): void => {
				if (Array.isArray(value)) {
					for (const item of value) {
						walk(item);
					}
					return;
				}
				if (value !== null && typeof value === 'object') {
					const obj = value as Record<string, unknown>;
					const link = obj.picture_link;
					if (typeof link === 'string' && link.trim().length > 0) {
						out.push(link.trim());
					}
					for (const v of Object.values(obj)) {
						walk(v);
					}
				}
			};
			walk(parsed);
		} catch (err) {
			return {
				links: [],
				parseError: err instanceof Error ? err.message : String(err),
			};
		}
		return { links: [...new Set(out)] };
	}

	private extractImageLinksFromHtml(text: string): readonly string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const srcRegex = /<(?:img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
		const srcsetRegex = /<(?:img|source)\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["']/gi;
		const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/gi;
		const addCandidate = (raw: string): void => {
			const link = raw.trim();
			if (link.length === 0 || link.startsWith('data:')) {
				return;
			}
			const normalized = link.toLowerCase();
			if (
				normalized.includes('close.svg') ||
				normalized.includes('/close.svg')
			) {
				return;
			}
			if (
				!/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(normalized) &&
				!normalized.includes('mindmap') &&
				!normalized.includes('mind-map') &&
				!normalized.includes('mind_map') &&
				!normalized.includes('mind map') &&
				!normalized.includes('card')
			) {
				return;
			}
			if (!seen.has(link)) {
				seen.add(link);
				out.push(link);
			}
		};
		let match: RegExpExecArray | null;
		while ((match = srcRegex.exec(text)) !== null) {
			addCandidate(match[1]);
		}
		while ((match = srcsetRegex.exec(text)) !== null) {
			const candidates = match[1]
				.split(',')
				.map((entry) => entry.trim().split(/\s+/)[0])
				.filter((entry) => entry.length > 0);
			for (const candidate of candidates) {
				addCandidate(candidate);
			}
		}
		while ((match = cssUrlRegex.exec(text)) !== null) {
			addCandidate(match[2]);
		}
		return out;
	}

	private async downloadNestedPictureAsset(
		pictureLink: string,
		folderPath: string,
		kind: AttachmentKind,
		nestedLabel: string,
		payloadToPath: Map<string, string>,
		namingCounters: AttachmentNamingCounters,
		idPrefix: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): Promise<string | null> {
		const token = this.noteWriterOptions.getAuthToken?.()?.trim();
		const candidates = this.buildPictureLinkCandidates(pictureLink, nestedAssetLinks);
		this.logAttachmentDebug('attempting nested picture download', {
			nestedLabel,
			pictureLink: this.sanitizeUrlForDebug(pictureLink),
			candidates: candidates.map((candidate) => this.sanitizeUrlForDebug(candidate)),
			hasAuthToken: Boolean(token && token.length > 0),
		});
		for (const candidate of candidates) {
			try {
				const headers: Record<string, string> = { Accept: '*/*' };
				if (token && token.length > 0 && this.shouldSendAuthHeader(candidate)) {
					headers.Authorization = `Bearer ${token}`;
				}
				const response = await requestUrl({
					url: candidate,
					method: 'GET',
					throw: false,
					headers,
				});
				this.logAttachmentDebug('nested picture response received', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					status: response.status,
					contentType: this.getResponseHeader(response, 'content-type') ?? null,
				});
				if (response.status < 200 || response.status >= 300) {
					this.logAttachmentDebug('nested candidate rejected by status', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						status: response.status,
					});
					continue;
				}
				const contentType = (this.getResponseHeader(response, 'content-type') ?? '').toLowerCase();
				if (contentType.includes('text/html')) {
					this.logAttachmentDebug('nested candidate rejected due to html content', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						contentType,
					});
					continue;
				}
				const bytes = this.responseToArrayBuffer(response);
				if (bytes === null) {
					this.logAttachmentDebug('nested candidate returned empty body', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					});
					continue;
				}
				const ext = this.inferPictureExtension(
					candidate,
					response.text ?? '',
					this.getResponseHeader(response, 'content-type') ?? '',
				);
				const fp = this.computeAttachmentFingerprint(bytes);
				const existingPath = payloadToPath.get(fp);
				if (existingPath !== undefined) {
					this.logAttachmentDebug('nested picture reused existing payload', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						existingPath,
					});
					return existingPath;
				}
				const baseName = this.nextAttachmentBaseName(kind, true, namingCounters);
				const prefixed = idPrefix.length > 0 ? `${idPrefix}-${baseName}` : baseName;
				const path = await this.resolveUniqueAttachmentPath(
					`${folderPath}/${prefixed}.${ext}`,
				);
				await this.app.vault.createBinary(path, bytes);
				payloadToPath.set(fp, path);
				this.logAttachmentDebug('nested picture asset saved', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					path,
					byteLength: bytes.byteLength,
				});
				return path;
			} catch (err) {
				this.logAttachmentDebug('nested candidate threw exception', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					error: err instanceof Error ? err.message : String(err),
				});
				// Try next candidate host.
			}
		}
		this.logAttachmentDebug('all nested picture candidates exhausted', {
			nestedLabel,
			pictureLink: this.sanitizeUrlForDebug(pictureLink),
		});
		return null;
	}

	private buildPrimaryAttachmentCandidates(
		url: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): readonly string[] {
		if (/^https?:\/\//i.test(url)) {
			return [url];
		}
		const normalized = url.replace(/^\/+/, '');
		const fromMap = nestedAssetLinks?.[normalized];
		return [
			...(typeof fromMap === 'string' && fromMap.length > 0 ? [fromMap] : []),
			`${PLAUD_API_BASE}/${normalized}`,
			`${PLAUD_WEB_BASE}/${normalized}`,
		];
	}

	private buildPictureLinkCandidates(
		link: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): readonly string[] {
		if (/^https?:\/\//i.test(link)) {
			return [link];
		}
		const normalized = link.replace(/^\/+/, '');
		const fromMap = nestedAssetLinks?.[normalized];
		return [
			...(typeof fromMap === 'string' && fromMap.length > 0 ? [fromMap] : []),
			`${PLAUD_API_BASE}/${normalized}`,
			`${PLAUD_WEB_BASE}/${normalized}`,
		];
	}

	private shouldSendAuthHeader(url: string): boolean {
		try {
			const parsed = new URL(url);
			// Presigned S3 URLs include their own signature. Sending bearer auth can
			// invalidate the request and produce 400 signature errors.
			if (parsed.searchParams.has('X-Amz-Signature')) {
				return false;
			}
			if (parsed.hostname.endsWith('.amazonaws.com')) {
				return false;
			}
			return true;
		} catch {
			return true;
		}
	}

	private inferPictureExtension(
		url: string,
		bodyText: string,
		responseContentType: string,
	): string {
		const fromMime = responseContentType.toLowerCase();
		if (fromMime.includes('png')) return 'png';
		if (fromMime.includes('jpeg') || fromMime.includes('jpg')) return 'jpg';
		if (fromMime.includes('webp')) return 'webp';
		if (fromMime.includes('gif')) return 'gif';
		if (fromMime.includes('svg')) return 'svg';
		if (fromMime.includes('bmp')) return 'bmp';

		try {
			const pathname = new URL(url).pathname.toLowerCase();
			const m = pathname.match(/\.([a-z0-9]{2,6})$/);
			if (m) {
				return m[1];
			}
		} catch {
			// fallback below
		}
		const trimmed = bodyText.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
		return 'bin';
	}

	private extractAttachmentAssetsFromSummaryMarkdown(
		summaryMarkdown: string | null,
	): readonly AttachmentAsset[] {
		if (summaryMarkdown === null || summaryMarkdown.trim().length === 0) {
			return [];
		}
		const out: AttachmentAsset[] = [];
		const seen = new Set<string>();
		const addCandidate = (raw: string): void => {
			const normalized = this.normalizeSummaryLink(raw);
			if (
				normalized.length === 0 ||
				!this.looksLikeSummaryAttachmentLink(normalized) ||
				seen.has(normalized)
			) {
				return;
			}
			seen.add(normalized);
			out.push({
				dataType: this.inferSummaryAttachmentDataType(normalized),
				url: normalized,
				name: this.extractSummaryAttachmentName(normalized),
			});
		};

		const markdownLinkRegex = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		let match: RegExpExecArray | null;
		while ((match = markdownLinkRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}

		const htmlAttributeRegex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
		while ((match = htmlAttributeRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}

		const bareUrlRegex =
			/(https?:\/\/[^\s<>"')\]]+|(?:\/)?permanent\/[^\s<>"')\]]+|\b[^/\s<>"')\]]*mindmap[^/\s<>"')\]]*\.html?\b)/gi;
		while ((match = bareUrlRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}
		return out;
	}

	private mergeAttachmentAssets(
		base: readonly AttachmentAsset[],
		extra: readonly AttachmentAsset[],
	): readonly AttachmentAsset[] {
		if (extra.length === 0) {
			return [...base];
		}
		const out: AttachmentAsset[] = [...base];
		const seen = new Set(base.map((asset) => asset.url));
		for (const asset of extra) {
			if (seen.has(asset.url)) {
				continue;
			}
			seen.add(asset.url);
			out.push(asset);
		}
		return out;
	}

	private normalizeSummaryLink(raw: string): string {
		const cleaned = raw.trim().replace(/^<|>$/g, '');
		return cleaned.replace(/^['"]|['"]$/g, '');
	}

	private looksLikeSummaryAttachmentLink(link: string): boolean {
		const lower = link.toLowerCase();
		return (
			lower.startsWith('http://') ||
			lower.startsWith('https://') ||
			lower.startsWith('permanent/') ||
			lower.startsWith('/permanent/') ||
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map') ||
			lower.includes('card') ||
			/\.(png|jpe?g|gif|webp|svg|bmp|html?|pdf|json)(\?|$)/i.test(link)
		);
	}

	private inferSummaryAttachmentDataType(link: string): string {
		const lower = link.toLowerCase();
		if (
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map')
		) {
			return 'mindmap';
		}
		if (lower.includes('card')) {
			return 'card';
		}
		return 'summary_link';
	}

	private extractSummaryAttachmentName(link: string): string | undefined {
		const trimmed = link.trim();
		const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
		const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
		const withoutQuery = base.split('?')[0].split('#')[0].trim();
		return withoutQuery.length > 0 ? withoutQuery : undefined;
	}

	private computeAttachmentFingerprint(bytes: ArrayBuffer): string {
		const view = new Uint8Array(bytes);
		let hash = 2166136261;
		for (let i = 0; i < view.length; i++) {
			hash ^= view[i];
			hash = Math.imul(hash, 16777619);
		}
		return `${view.length}:${hash >>> 0}`;
	}

	private logImportDebug(message: string, payload?: unknown): void {
		const logger = this.noteWriterOptions.debugLogger;
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

	private logAttachmentDebug(message: string, payload?: unknown): void {
		const logger = this.noteWriterOptions.debugLogger;
		if (!logger || !logger.enabled) {
			return;
		}
		logger.log({
			kind: 'note',
			endpoint: '/attachments',
			message,
			payload,
		});
	}

	private sanitizeUrlForDebug(url: string): string {
		try {
			const parsed = new URL(url);
			return `${parsed.origin}${parsed.pathname}`;
		} catch {
			return url.slice(0, 200);
		}
	}

	private getResponseHeader(
		response: RequestUrlResponse,
		name: string,
	): string | undefined {
		const raw = (response as unknown as { headers?: Record<string, string> }).headers;
		if (!raw) {
			return undefined;
		}
		const wanted = name.toLowerCase();
		for (const [key, value] of Object.entries(raw)) {
			if (key.toLowerCase() === wanted) {
				return value;
			}
		}
		return undefined;
	}

	private makeBodyPreview(text: string, maxLength = 400): string {
		const compact = text.replace(/\s+/g, ' ').trim();
		if (compact.length <= maxLength) {
			return compact;
		}
		return `${compact.slice(0, maxLength)}...`;
	}

	private stripManagedAttachmentsSection(content: string): string {
		return content.replace(
			/\n## (?:Attachments|Images and Attachments)\s*\n\s*_Imported from Plaud file-detail assets at import time\._[\s\S]*$/m,
			'',
		);
	}

	private insertManagedAttachmentsSection(content: string, section: string): string {
		const transcriptMatch = content.match(/\n#{1,6} Transcript\s*\n/);
		if (transcriptMatch && transcriptMatch.index !== undefined) {
			const insertAt = transcriptMatch.index;
			const before = content.slice(0, insertAt).replace(/\s+$/, '');
			const after = content.slice(insertAt).replace(/^\s*/, '');
			return `${before}\n\n${section}\n\n${after}\n`;
		}
		return `${content}\n\n${section}\n`;
	}

	private renderSummary(tally: ImportTally): void {
		// Fire the Notice FIRST so a DOM-render failure cannot eat the
		// batch result. The modal body render below can throw; the
		// top-level toast is the last-line-of-defense feedback.
		new Notice(formatImportNotice(tally));

		const { contentEl } = this;
		contentEl.empty();

		const imported = tally.created + tally.overwritten;
		const summaryLine =
			`${imported} imported (${tally.created} new, ${tally.overwritten} overwritten), ` +
			`${tally.skipped} skipped, ${tally.failed} failed.`;

		contentEl.createEl('p', {
			text: summaryLine,
			cls: 'plaud-importer-summary',
		});

		if (tally.failures.length > 0) {
			const details = contentEl.createEl('details', {
				cls: 'plaud-importer-failures',
			});
			// Pre-expand so the user sees the failures without having to
			// click. The <details> element still provides the collapse
			// affordance if they want to hide them.
			details.setAttribute('open', '');
			details.createEl('summary', {
				text: `${tally.failures.length} failure${
					tally.failures.length === 1 ? '' : 's'
				}`,
			});
			const list = details.createEl('ul');
			for (const f of tally.failures) {
				if (f.kind !== 'failed') {
					continue;
				}
				const li = list.createEl('li');
				li.createEl('strong', { text: f.recording.title });
				li.createEl('span', {
					text: ` (${f.recording.id})`,
					cls: 'plaud-importer-failure-id',
				});
				li.createEl('br');
				li.createSpan({ text: f.reason });
			}

			// Also offer a one-click Copy-all-failures button for bug
			// reporting.
			const copyAllFailures = contentEl.createEl('button', {
				text: 'Copy all failure details',
				cls: 'plaud-importer-copy-failures',
			});
			copyAllFailures.addEventListener('click', () => {
				const payload = tally.failures
					.filter((f): f is ImportResult & { kind: 'failed' } => f.kind === 'failed')
					.map((f) => {
						return [
							`Recording: ${f.recording.title} (${f.recording.id})`,
							`Category: ${f.classification.category}`,
							`Retryable: ${f.classification.canRetry}`,
							`Message: ${f.reason}`,
						].join('\n');
					})
					.join('\n\n---\n\n');
				void copyToClipboard(
					`Plaud Importer: ${tally.failures.length} failure${
						tally.failures.length === 1 ? '' : 's'
					}\n\n${payload}`,
				);
			});
		}

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const closeButton = buttonRow.createEl('button', {
			text: 'Done',
			cls: 'mod-cta',
		});
		closeButton.addEventListener('click', () => this.close());
	}
}
