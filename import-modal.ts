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
	NoteWriter,
	NoteWriterError,
	type DuplicatePolicy,
	type DuplicatePromptCallback,
	findTranscriptHeadingLine,
} from './note-writer';
import { runImport } from './import-runner';
import { buildPlaudIdIndex, type ImportedRecord } from './vault-index';
import { AttachmentImporter } from './attachment-importer';
import {
	classifyError,
	isPlaudUnprocessedError,
	formatDate,
	formatDuration,
	tallyImportResults,
	formatImportNotice,
	formatErrorForClipboard,
	mergeRecordings,
	filterVisibleRecordings,
	PAGE_SIZE,
	type ImportModalOptions,
	type ErrorCategory,
	type ErrorClassification,
	type ImportResult,
	type ImportTally,
	type ArtifactSelection,
	type DuplicateDecisionChoice,
} from './import-core';

// The pure helpers and shared types now live in import-core.ts (no `obsidian`
// dependency, which breaks the former import-modal <-> attachment-importer
// import cycle). Re-export them here so existing import paths (main.ts, the
// test suite) keep resolving from import-modal.ts unchanged.
export {
	classifyError,
	isPlaudUnprocessedError,
	formatDate,
	formatDuration,
	tallyImportResults,
	formatImportNotice,
	formatErrorForClipboard,
	mergeRecordings,
	filterVisibleRecordings,
	PAGE_SIZE,
};
export type {
	ImportModalOptions,
	ErrorCategory,
	ErrorClassification,
	ImportResult,
	ImportTally,
	ArtifactSelection,
	DuplicateDecisionChoice,
};

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

const AUTO_LOAD_ROOT_MARGIN_PX = 240;
const AUTO_LOAD_THROTTLE_MS = 300;
const AUTO_LOAD_SILENT_RETRY_DELAY_MS = 350;

type LoadMoreTrigger = 'auto' | 'manual' | 'retry';

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
	// Footer container that sits BELOW the scroll list (a sibling of it),
	// holding the load-more status/spinner so they stay pinned in view
	// instead of scrolling away with the rows.
	private progressFooterEl: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;
	private progressTextEl: HTMLElement | null = null;
	private progressSpinnerEl: HTMLElement | null = null;
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
	// Last non-throttle reason maybeAutoLoad refused to page, used to
	// deduplicate the scroll debug log (scroll fires many events per second).
	private lastAutoLoadBlockReason: string | null = null;
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
		this.progressFooterEl = null;
		this.progressEl = null;
		this.progressTextEl = null;
		this.progressSpinnerEl = null;
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
		this.progressFooterEl = null;
		this.progressEl = null;
		this.progressTextEl = null;
		this.progressSpinnerEl = null;
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
			const fromPrefetch = this.prefetchedRecordings !== null;
			this.logScrollDebug('loadMore start', {
				trigger,
				skip,
				source: fromPrefetch ? 'prefetch-cache' : 'live-fetch',
			});
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
				// Render only the newly-arrived rows that are visible; trashed
				// rows stay in currentRecordings (for paging) but are not shown.
				const showTrashed = this.noteWriterOptions.showTrashedRecordings === true;
				for (const rec of newRows) {
					if (showTrashed || !rec.isTrashed) {
						this.renderRow(this.listEl, rec);
					}
				}
			}
			this.updateIntroCount();
			this.updateProgressUi();
			this.logScrollDebug('loadMore done', {
				trigger,
				skip,
				newRows: newRows.length,
				received: incoming.length,
				totalLoaded: this.currentRecordings.length,
				hasMore: this.hasMore,
			});
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
			this.logScrollDebug('loadMore error', {
				trigger,
				skip,
				error: classification.message,
				category: classification.category,
			});
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

	/**
	 * Recordings to display: all fetched recordings minus trash (unless the
	 * user opted in). Trash stays in `currentRecordings` for pagination; this
	 * is the view over it.
	 */
	private visibleRecordings(): readonly Recording[] {
		return filterVisibleRecordings(
			this.currentRecordings,
			this.noteWriterOptions.showTrashedRecordings === true,
		);
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
		for (const rec of this.visibleRecordings()) {
			this.renderRow(listEl, rec);
		}
		// Footer sits BELOW the scroll list (a sibling, not a child) so the
		// load-more status and spinner stay pinned in view rather than
		// scrolling out of sight with the rows.
		this.progressFooterEl = contentEl.createDiv({
			cls: 'plaud-importer-list-footer',
		});
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
		// Keep newly appended rows above the auto-load sentinel so the
		// sentinel stays the last child of the scroll list — its
		// intersection with the bottom is what drives paging.
		const row = listEl.createDiv({ cls: 'plaud-importer-row' });
		// Stamp the recording id so updateRowBadge can find this row by id
		// rather than by positional index. Index-matching breaks once trashed
		// recordings live in currentRecordings but are not rendered.
		row.dataset.recordingId = rec.id;
		if (
			this.autoLoadSentinelEl !== null &&
			this.autoLoadSentinelEl.parentElement === listEl
		) {
			listEl.insertBefore(row, this.autoLoadSentinelEl);
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
		const existing = this.importedIndex.get(recId);
		if (existing === undefined) return;
		// Find the row by its stamped recording id. Robust to trashed
		// recordings that sit in currentRecordings but are not rendered, which
		// would otherwise desync a positional index from the DOM row order.
		const row = this.listEl.querySelector(
			`.plaud-importer-row[data-recording-id="${CSS.escape(recId)}"]`,
		);
		if (row === null) return;
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
		const n = this.visibleRecordings().length;
		const suffix = this.hasMore ? ' (scroll for more)' : '';
		this.introEl.setText(
			`${n} recording${n === 1 ? '' : 's'} loaded${suffix}. Select which to import.`,
		);
	}

	private ensureProgressElements(): void {
		if (
			this.listEl === null ||
			this.progressFooterEl === null ||
			this.progressEl !== null
		) {
			return;
		}
		// Progress UI lives in the footer (below the scroll list); the
		// sentinel stays inside the scroll list because the auto-load
		// IntersectionObserver uses listEl as its root.
		const progressEl = this.progressFooterEl.createDiv({
			cls: 'plaud-importer-progress',
		});
		this.progressEl = progressEl;
		// Status group holds an (animated) spinner next to the text so the
		// "loading more" state reads as active work, not a frozen list, while
		// a page is fetched mid-scroll. The spinner stays hidden until a fetch
		// is in flight.
		const statusEl = progressEl.createDiv({ cls: 'plaud-importer-progress-status' });
		this.progressSpinnerEl = statusEl.createDiv({
			cls: 'plaud-importer-spinner plaud-importer-hidden',
		});
		this.progressTextEl = statusEl.createDiv({ cls: 'plaud-importer-progress-text' });
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
		// Spinner shows the moment a page fetch starts — including the
		// background prefetch, which is where the real network wait happens.
		// Gating it on loadingMore alone made it flash only when the cached
		// page was consumed (after the wait), reading as a frozen list.
		const fetching = this.loadingMore || this.prefetchInFlight;
		this.progressSpinnerEl?.toggleClass('plaud-importer-hidden', !fetching);
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
		const firstInteraction = !this.userStartedScrolling;
		if (firstInteraction) {
			this.userStartedScrolling = true;
			this.startPrefetchIfNeeded();
			this.updateProgressUi();
			this.logScrollDebug('first list interaction', this.scrollStateSnapshot());
		}
		// Re-check near-bottom on every interaction, not just the first. The
		// IntersectionObserver fires only on transitions, and once we page
		// before the sentinel scrolls out of view it can stay continuously
		// intersecting and never fire again — which froze paging with the
		// footer stuck on "Scroll to load more". A direct scroll-driven check
		// keeps paging alive regardless of the observer. maybeAutoLoad's own
		// throttle prevents this from firing on every scroll event.
		if (this.isListNearBottom()) {
			this.maybeAutoLoad('interaction');
		}
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
		this.logScrollDebug('prefetch start', { skip, ...this.scrollStateSnapshot() });
		void this.client
			.listRecordings({
				skip,
				limit: PAGE_SIZE,
			})
			.then((incoming) => {
				if (generation !== this.fetchGeneration) {
					this.logScrollDebug('prefetch resolved (stale, dropped)', { skip });
					return;
				}
				this.prefetchedRecordings = incoming;
				this.logScrollDebug('prefetch resolved', {
					skip,
					received: incoming.length,
				});
			})
			.catch((err) => {
				if (generation !== this.fetchGeneration) {
					return;
				}
				console.warn('Plaud importer: next-page prefetch failed', err);
				this.logScrollDebug('prefetch failed', {
					skip,
					error: err instanceof Error ? err.message : String(err),
				});
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
					this.maybeAutoLoad('prefetch-finally');
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
					const intersecting = entries.some((entry) => entry.isIntersecting);
					this.logScrollDebug('sentinel observer fired', {
						intersecting,
						...this.scrollStateSnapshot(),
					});
					if (!intersecting) {
						return;
					}
					this.maybeAutoLoad('observer');
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
				this.maybeAutoLoad('scroll-fallback');
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

	private maybeAutoLoad(source: string): void {
		const reason = this.autoLoadBlockReason();
		if (reason !== null) {
			// Throttle blocks are the common case on a fast scroll — logging
			// them would bury the signal. Log every other block reason, but
			// only once per distinct reason so a held state (e.g. a stuck
			// prefetch) doesn't spam a line per scroll event.
			if (reason !== 'throttle' && reason !== this.lastAutoLoadBlockReason) {
				this.lastAutoLoadBlockReason = reason;
				this.logScrollDebug('auto-load blocked', {
					source,
					reason,
					...this.scrollStateSnapshot(),
				});
			}
			return;
		}
		this.lastAutoLoadBlockReason = null;
		this.lastAutoLoadAt = Date.now();
		this.logScrollDebug('auto-load firing', {
			source,
			...this.scrollStateSnapshot(),
		});
		void this.loadMore('auto').catch((err) => {
			console.error('Plaud importer: unexpected auto-load error', err);
		});
	}

	/**
	 * First gate that currently prevents an auto-load, or null if a load may
	 * proceed. Centralized (and named) so the scroll debug log can report
	 * exactly why paging is or is not advancing.
	 */
	private autoLoadBlockReason(): string | null {
		if (!this.hasMore) {
			return 'no-more';
		}
		if (this.loadingMore) {
			return 'already-loading';
		}
		if (!this.userStartedScrolling) {
			return 'not-scrolled-yet';
		}
		if (this.prefetchInFlight && this.prefetchedRecordings === null) {
			return 'prefetch-in-flight';
		}
		if (this.loadMoreErrorMessage !== null) {
			return 'previous-error';
		}
		if (Date.now() - this.lastAutoLoadAt < AUTO_LOAD_THROTTLE_MS) {
			return 'throttle';
		}
		return null;
	}

	private isListNearBottom(): boolean {
		if (this.listEl === null) {
			return false;
		}
		const remaining =
			this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight;
		return remaining <= AUTO_LOAD_ROOT_MARGIN_PX;
	}

	/**
	 * Snapshot of the scroll/paging state machine for the debug log. Captures
	 * every gate maybeAutoLoad consults plus the raw scroll geometry, so a
	 * frozen-list report can be diagnosed from the log alone.
	 */
	private scrollStateSnapshot(): Record<string, unknown> {
		const remainingPx =
			this.listEl !== null
				? this.listEl.scrollHeight -
				  this.listEl.scrollTop -
				  this.listEl.clientHeight
				: null;
		return {
			loaded: this.currentRecordings.length,
			hasMore: this.hasMore,
			loadingMore: this.loadingMore,
			prefetchInFlight: this.prefetchInFlight,
			hasPrefetchedPage: this.prefetchedRecordings !== null,
			userStartedScrolling: this.userStartedScrolling,
			loadMoreError: this.loadMoreErrorMessage,
			nearBottom: this.isListNearBottom(),
			remainingPx,
			rootMarginPx: AUTO_LOAD_ROOT_MARGIN_PX,
			msSinceLastAutoLoad: Date.now() - this.lastAutoLoadAt,
			throttleMs: AUTO_LOAD_THROTTLE_MS,
			observerActive: this.autoLoadObserver !== null,
		};
	}

	private logScrollDebug(message: string, payload?: unknown): void {
		const logger = this.noteWriterOptions.debugLogger;
		if (!logger || !logger.enabled) {
			return;
		}
		logger.log({
			kind: 'note',
			endpoint: '/scroll',
			message,
			payload,
		});
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
				// Cross-folder dedup: let the writer find a prior import of the
				// same recording that lives in a different subfolder (for
				// example after the subfolder template changed) so it never
				// writes a second copy. Backed by the vault index, read live so
				// it reflects notes written earlier in this same run.
				existingPathForPlaudId: (id) =>
					this.importedIndex.get(id as PlaudRecordingId)?.path ?? null,
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

		// Delegate the per-recording loop to the headless runner. The modal
		// keeps every UI concern: the observer updates the button text and
		// refreshes row badges, and the outcome drives the summary or the
		// partial-cancel Notice. fetchArtifacts reuses the warm artifact
		// cache so a prior "review artifacts" preflight is not re-fetched;
		// applyFold persists the post-write transcript fold.
		const outcome = await runImport({
			recordings: selected,
			selection,
			writer,
			attachments: this.attachments,
			options: this.noteWriterOptions,
			fetchArtifacts: (id) => this.ensureArtifactsForRecording(id),
			applyFold: (filePath) => this.applyNoteFolds(filePath),
			observer: {
				onRecordingStart: (index, total) => {
					if (this.importButton) {
						this.importButton.textContent = `Importing ${index} of ${total}…`;
					}
				},
				onRecordingWritten: (recording) => {
					this.updateRowBadge(recording.id);
				},
				shouldAbort: () => this.aborted,
			},
		});

		if (outcome.stop !== 'completed') {
			// 'aborted' (modal closed mid-run) and 'cancelled' (per-file
			// duplicate prompt dismissed) both surface the same partial
			// Notice the inline loop used to fire at each stop site.
			new Notice(
				`${formatImportNotice(tallyImportResults(outcome.results))} (cancelled at ${outcome.processed}/${selected.length})`,
			);
			return;
		}

		this.renderSummary(tallyImportResults(outcome.results));
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
	 * freshly-written note so the chaptered transcript renders collapsed by
	 * default while the summary, template outputs, and chapters callout above
	 * it stay visible. The `## Template outputs` block is deliberately NOT
	 * folded: it is an H2 and the transcript heading is deeper, so folding it
	 * would subsume the transcript. Uses Obsidian's undocumented but stable
	 * internal `app.foldManager.save` API (type-augmented in `types.d.ts`) plus
	 * a best-effort same-session apply via the active MarkdownView's
	 * `applyFoldInfo` when the file happens to already be open in a leaf.
	 *
	 * Failure is swallowed with a console warning: a missing
	 * foldManager (older Obsidian) or an applyFoldInfo rejection
	 * degrades to expanded-by-default, which is unfortunate but never
	 * breaks the import. This method must never throw into the
	 * import loop.
	 */
	private async applyNoteFolds(path: string): Promise<void> {
		try {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) {
				return;
			}
			const body = await this.app.vault.read(file);
			const headerLevel = this.noteWriterOptions.transcriptHeaderLevel ?? 4;
			// Fold the wrapping transcript heading so the chaptered transcript
			// opens collapsed. The transcript is the final section, so this
			// single heading-fold collapses it to end-of-note. Template outputs
			// stay expanded (folding their shallower H2 would subsume the
			// deeper transcript heading).
			const transcriptHeadingLine = findTranscriptHeadingLine(body, headerLevel);
			if (transcriptHeadingLine === null) {
				return;
			}
			const foldLines = [transcriptHeadingLine];
			const totalLines = body.split('\n').length;
			const foldInfo = {
				folds: foldLines.map((line) => ({ from: line, to: line })),
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
				`Plaud importer: failed to apply fold state for ${path}`,
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
		const noContentClause =
			tally.noContent > 0 ? `${tally.noContent} no content, ` : '';
		const placeholderClause =
			tally.placeholdersWritten > 0
				? `${tally.placeholdersWritten} placeholder, `
				: '';
		const summaryLine =
			`${imported} imported (${tally.created} new, ${tally.overwritten} overwritten), ` +
			`${tally.skipped} skipped, ${noContentClause}${placeholderClause}${tally.failed} failed.`;

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

		// Informational (non-error) list of recordings Plaud had no content
		// for. Collapsed by default since these are expected, not problems —
		// the user selected them but Plaud never transcribed or summarized
		// them, so there was nothing to write.
		if (tally.noContentResults.length > 0) {
			const noContent = contentEl.createEl('details', {
				cls: 'plaud-importer-nocontent',
			});
			noContent.createEl('summary', {
				text: `${tally.noContentResults.length} skipped — no content in Plaud`,
			});
			const list = noContent.createEl('ul');
			for (const r of tally.noContentResults) {
				if (r.kind !== 'skipped-no-content') {
					continue;
				}
				const li = list.createEl('li');
				li.createEl('strong', { text: r.recording.title });
				li.createEl('span', {
					text: ` (${r.recording.id})`,
					cls: 'plaud-importer-failure-id',
				});
			}
		}

		// Informational list of recordings Plaud has not processed yet, for
		// which a placeholder note was written. Pre-expanded so the user notices
		// the stubs and knows to re-import once Plaud finishes processing. These
		// are not failures: the recording exists, Plaud just has no transcript
		// or summary for it yet, and the placeholder keeps the link.
		if (tally.placeholderResults.length > 0) {
			const placeholders = contentEl.createEl('details', {
				cls: 'plaud-importer-placeholders',
			});
			placeholders.setAttribute('open', '');
			placeholders.createEl('summary', {
				text: `${tally.placeholderResults.length} placeholder note${
					tally.placeholderResults.length === 1 ? '' : 's'
				} written, Plaud has not processed these yet`,
			});
			placeholders.createEl('p', {
				text: 'These recordings have no transcript or summary available. A common cause is audio with no detectable speech; another is that processing has not finished. A placeholder note with a link was written for each, so you can re-run the import later if content becomes available.',
				cls: 'plaud-importer-placeholders-note',
			});
			const list = placeholders.createEl('ul');
			for (const r of tally.placeholderResults) {
				if (r.kind !== 'placeholder-written') {
					continue;
				}
				const li = list.createEl('li');
				li.createEl('strong', { text: r.recording.title });
				li.createEl('span', {
					text: ` (${r.recording.id})`,
					cls: 'plaud-importer-failure-id',
				});
				li.createEl('br');
				li.createSpan({ text: r.reason });
			}
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
		// Keep the summary open on any failure OR when placeholders were written.
		// Both are things the user should see and act on (re-import later),
		// not auto-dismiss.
		if (!enabled || tally.failed > 0 || tally.placeholdersWritten > 0) {
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
