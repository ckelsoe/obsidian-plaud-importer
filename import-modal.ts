import {
	App,
	MarkdownView,
	Modal,
	Notice,
	TFile,
} from 'obsidian';
import type {
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
	buildNoteTags,
	type TagMode,
	findTranscriptHeadingLine,
	type NoteWriterOptions,
	type FormatMarkdownOptions,
	type WriteOutcome,
} from './note-writer';
import type { DebugLogger } from './debug-logger';
import { buildPlaudIdIndex, type ImportedRecord } from './vault-index';
import { AttachmentImporter } from './attachment-importer';

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
	/** Which tag sources land in `tags:` frontmatter. Defaults to 'plaud'. */
	readonly tagMode?: TagMode;
	/** Comma-separated user tags appended in every mode except 'none'. */
	readonly customTags?: string;
	/**
	 * Write AI keywords excluded from `tags:` to a `keywords:` frontmatter
	 * property. Defaults to true.
	 */
	readonly aiKeywordsAsProperty?: boolean;
	/**
	 * Auto-close the post-import summary view after a fully successful
	 * batch (no failures). Defaults to true. A batch with failures always
	 * keeps the summary open so the errors stay visible.
	 */
	readonly autoCloseSummary?: boolean;
	/** Countdown length for the summary auto-close, in seconds. Defaults to 20. */
	readonly autoCloseSummarySeconds?: number;
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
	 * Optional provider for the current Plaud API host. Threaded to the
	 * attachment importer so relative-asset download candidates resolve
	 * against the region the user was redirected to, not the hardcoded US
	 * host. Defaults to the US host when omitted.
	 */
	readonly getApiBaseUrl?: () => string;
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
		return 'Plaud importer: nothing to import.';
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
	return `Plaud importer: ${parts.join(', ')}.`;
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
		new Notice('Plaud importer: error details copied to clipboard.');
	} catch (err) {
		console.error('Plaud importer: clipboard write failed', err);
		new Notice(
			'Plaud importer: could not copy to clipboard — see the developer console (Ctrl+Shift+I) for the full error.',
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

export interface ArtifactSelection {
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
	// Owns the attachment download/classify/persist pipeline. Created once
	// per modal with the same auth and logging surface the modal received.
	private readonly attachments: AttachmentImporter;
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
	// Interval id for the summary auto-close countdown. Held on the modal
	// so onClose can clear it whether the countdown finished, the user
	// clicked Done, or they dismissed the modal some other way.
	private autoCloseTimer: number | null = null;
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
	// Index of plaud-ids already present in the configured output folder.
	// Built once per refresh() and refreshed after each successful import
	// so the badge state stays accurate without re-scanning the vault on
	// every render. Empty map when no notes match — never null so callers
	// can `.has()` without guarding.
	private importedIndex: Map<PlaudRecordingId, ImportedRecord> = new Map();

	constructor(app: App, client: PlaudClient, noteWriterOptions: ImportModalOptions) {
		super(app);
		this.client = client;
		this.noteWriterOptions = noteWriterOptions;
		this.attachments = new AttachmentImporter({
			app,
			getAuthToken: noteWriterOptions.getAuthToken,
			getApiBaseUrl: noteWriterOptions.getApiBaseUrl,
			debugLogger: noteWriterOptions.debugLogger,
		});
	}

	onOpen(): void {
		this.modalEl.addClass('plaud-importer-modal');
		this.setTitle('Import plaud recordings');
		this.refresh().catch((err) => {
			// refresh() has its own try/catch around the fetch and always
			// calls renderError internally. This outer catch is purely
			// defense-in-depth against a future bug that throws outside the
			// fetch try/catch (e.g., a render function throwing).
			console.error('Plaud importer: unexpected error in onOpen/refresh', err);
			this.renderError(classifyError(err));
		});
	}

	onClose(): void {
		// Signal any in-flight import loop to stop writing. The loop
		// checks `this.aborted` between iterations and fires a partial
		// Notice if it was interrupted.
		this.aborted = true;
		this.cancelAutoClose();
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
		// Snapshot which recordings already have a note in the vault so
		// every row rendered below can render the "imported" badge.
		// Refreshed again after each successful write so re-entering the
		// modal isn't required to see new badges.
		this.refreshImportedIndex();
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
			console.error('Plaud importer: listRecordings failed', err);
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
			console.error('Plaud importer: loadMore failed', err);
			// Show a Notice rather than tearing down the list — the user
			// still has their selections and their already-loaded pages,
			// and losing them on a transient network blip would be rude.
			const classification = classifyError(err);
			new Notice(`Plaud importer: could not load more — ${classification.message}`);
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
			text: 'Loading recordings from plaud.ai…',
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
					console.error('Plaud importer: retry failed', err);
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
				console.error('Plaud importer: unexpected error in onImportClick', err);
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
				console.error('Plaud importer: customization preflight failed', err);
				new Notice('Plaud importer: could not inspect artifacts.');
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
		const titleRow = labelWrap.createDiv({ cls: 'plaud-importer-title-row' });
		titleRow.createDiv({ text: rec.title, cls: 'plaud-importer-title' });

		const existing = this.importedIndex.get(rec.id);
		if (existing !== undefined) {
			this.renderImportedBadge(titleRow, existing);
		}

		const meta = labelWrap.createDiv({ cls: 'plaud-importer-meta' });
		meta.createSpan({ text: formatDate(rec.createdAt) });
		meta.createSpan({ text: '  ·  ', cls: 'plaud-importer-sep' });
		meta.createSpan({ text: formatDuration(rec.durationSeconds) });
	}

	// Refresh the vault index from scratch. Cheap — Obsidian's
	// metadataCache returns parsed frontmatter without re-reading file
	// bytes. Called at modal open (inside refresh()) and after every
	// successful write so badge state stays accurate without forcing
	// the user to close and reopen the modal.
	private refreshImportedIndex(): void {
		this.importedIndex = buildPlaudIdIndex(
			this.app,
			this.noteWriterOptions.outputFolder,
		);
	}

	// Update or insert a single row's badge state after a successful
	// import. Cheaper than a full re-render for the common "user
	// imports one recording then imports another" path. The existing
	// row stays where it is; we just append a badge to its title row.
	private updateRowBadge(recId: PlaudRecordingId): void {
		this.refreshImportedIndex();
		if (this.listEl === null) return;
		const rows = this.listEl.querySelectorAll('.plaud-importer-row');
		const existing = this.importedIndex.get(recId);
		if (existing === undefined) return;
		// Match by checkbox value isn't reliable — checkboxes don't
		// carry the id today. Iterate and find the row whose title
		// matches the recording by reading from currentRecordings.
		const idx = this.currentRecordings.findIndex((r) => r.id === recId);
		if (idx === -1 || idx >= rows.length) return;
		const row = rows[idx] as HTMLElement;
		const titleRow = row.querySelector('.plaud-importer-title-row');
		if (titleRow === null) return;
		const existingBadge = titleRow.querySelector('.plaud-importer-imported-badge');
		if (existingBadge !== null) return;
		this.renderImportedBadge(titleRow as HTMLElement, existing);
	}

	private renderImportedBadge(parent: HTMLElement, record: ImportedRecord): void {
		const badge = parent.createEl('a', {
			cls: 'plaud-importer-imported-badge',
			text: 'Imported',
			href: '#',
			attr: {
				'aria-label': `Open existing note at ${record.path}`,
				title: `Already imported — click to open ${record.path}`,
			},
		});
		badge.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			void this.app.workspace.openLinkText(record.path, '', false);
		});
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
		new Notice('Plaud importer: checking available artifacts...');
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
			new Notice(`Plaud importer: could not inspect artifacts — ${classification.message}`);
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
			if (assets.some((a) => this.attachments.classifyAttachmentKind(a) === 'generic')) {
				attachmentsCount += 1;
			}
			if (assets.some((a) => this.attachments.classifyAttachmentKind(a) === 'mindmap')) {
				mindmapCount += 1;
			}
			if (assets.some((a) => this.attachments.classifyAttachmentKind(a) === 'card')) {
				cardCount += 1;
			}
			if (this.noteWriterOptions.debugLogger?.enabled === true) {
				const kindCounts = { generic: 0, mindmap: 0, card: 0 };
				for (const asset of assets) {
					const kind = this.attachments.classifyAttachmentKind(asset);
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
			cls: 'plaud-importer-progress-action plaud-importer-hidden',
		});
		this.progressActionButton.textContent = 'Load more recordings';
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
			console.error('Plaud importer: unexpected error in loadMore', err);
			new Notice('Plaud importer: could not load more — see the developer console.');
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
			this.progressActionButton.toggleClass('plaud-importer-hidden', true);
			this.progressActionButton.disabled = false;
			return;
		}
		this.progressActionButton.toggleClass('plaud-importer-hidden', false);
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
				console.warn('Plaud importer: next-page prefetch failed', err);
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
			console.error('Plaud importer: unexpected auto-load error', err);
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
				console.error('Plaud importer: NoteWriter construction failed', err);
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
				const summaryLinkedAttachments = this.attachments.extractAttachmentAssetsFromSummaryMarkdown(
					summary?.text ?? null,
				);
				const mergedAttachments = this.attachments.mergeAttachmentAssets(
					attachments ?? [],
					summaryLinkedAttachments,
				);
				// DD-004: combine Plaud's AI-generated keyword list (from
				// /file/detail/), the recording's own tags, and the user's
				// custom tags before the note is rendered. buildNoteTags
				// owns the mode filtering, namespacing, slug, and dedup
				// rules; this site just feeds it the sources and settings.
				// The recording's tags are ALWAYS overwritten with the
				// built list (even when empty) so a restrictive tag mode
				// cannot leak the raw Plaud tags into the frontmatter.
				// formatFrontmatter omits empty tags:/keywords: keys.
				const tagResult = buildNoteTags(recording.tags, aiKeywords, {
					tagMode: this.noteWriterOptions.tagMode ?? 'plaud',
					customTags: this.noteWriterOptions.customTags ?? '',
					aiKeywordsAsProperty:
						this.noteWriterOptions.aiKeywordsAsProperty ?? true,
				});
				const enrichedRecording = { ...recording, tags: tagResult.tags };
				const formatOptions: FormatMarkdownOptions = {
					includeTranscript: selection.includeTranscript,
					includeSummary: selection.includeSummary,
					keywords: tagResult.keywords,
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
				// Refresh the badge for this row when the write produced a
				// note (created or overwritten). 'skipped' means the file
				// already existed and we honored the duplicate policy —
				// the badge is already there, no work to do.
				if (writeOutcome.status === 'created' || writeOutcome.status === 'overwritten') {
					this.updateRowBadge(recording.id);
				}
				if (
					(
						selection.includeAttachments ||
						selection.includeMindmap ||
						selection.includeCard
					) &&
					writeOutcome.status !== 'skipped' &&
					mergedAttachments.length > 0
				) {
					await this.attachments.importAttachmentsForNote(
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
					`Plaud importer: import failed for recording ${recording.id} "${recording.title}"`,
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
			new Notice('Plaud importer: using "skip existing" for this import run.');
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
				new Notice('Plaud importer: overwriting all remaining duplicates in this run.');
				return 'overwrite';
			case 'skip-all':
				this.stickyDuplicateDecision = 'skip';
				new Notice('Plaud importer: skipping all remaining duplicates in this run.');
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
				`Plaud importer: failed to apply transcript fold state for ${path}`,
				err,
			);
		}
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
					`Plaud importer: ${tally.failures.length} failure${
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

		this.maybeStartAutoClose(tally, buttonRow, closeButton);
	}

	/**
	 * Start the summary auto-close countdown when the setting allows it.
	 * Only a fully successful batch auto-closes: any failure keeps the
	 * summary open so the error list stays visible. Any click inside the
	 * modal cancels the countdown, on the assumption the user started
	 * reading or copying something.
	 */
	private maybeStartAutoClose(
		tally: ImportTally,
		buttonRow: HTMLElement,
		closeButton: HTMLElement,
	): void {
		const enabled = this.noteWriterOptions.autoCloseSummary ?? true;
		if (!enabled || tally.failed > 0) {
			return;
		}
		const configured = this.noteWriterOptions.autoCloseSummarySeconds ?? 20;
		let remaining = Number.isFinite(configured)
			? Math.max(1, Math.floor(configured))
			: 20;

		const countdownEl = buttonRow.createSpan({
			cls: 'plaud-importer-autoclose',
			text: `Auto-closes in ${remaining}s`,
		});
		// Capture phase so the cancel fires before any button's own click
		// handler. Clicking Done is not a cancel, it is the close itself:
		// stop the timer silently and let the button's handler close the
		// modal without flashing the cancelled text first.
		this.contentEl.addEventListener(
			'pointerdown',
			(event) => {
				if (this.autoCloseTimer === null) {
					return;
				}
				this.cancelAutoClose();
				if (!(event.target instanceof Node) || !closeButton.contains(event.target)) {
					countdownEl.setText('Auto-close cancelled');
				}
			},
			{ capture: true },
		);
		this.autoCloseTimer = window.setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) {
				this.close();
				return;
			}
			countdownEl.setText(`Auto-closes in ${remaining}s`);
		}, 1000);
	}

	private cancelAutoClose(): void {
		if (this.autoCloseTimer !== null) {
			window.clearInterval(this.autoCloseTimer);
			this.autoCloseTimer = null;
		}
	}
}
