import { App, Modal, Notice } from 'obsidian';
import type { PlaudClient, Recording } from './plaud-client';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from './plaud-client-re';
import {
	NoteWriter,
	NoteWriterError,
	mergeTagSources,
	type NoteWriterOptions,
	type WriteOutcome,
} from './note-writer';

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
 * TODO (Charles): this stub is a minimal "make it compile" implementation.
 * It ignores dedupe, trusts Plaud's ordering, and uses a very forgiving
 * end-of-stream rule. Replace it with your own strategy — three decisions
 * to make, each user-visible:
 *
 *   1. **Dedupe.** Build a `Set<PlaudRecordingId>` of existing IDs and
 *      filter `incoming` against it? Simple and defensive. Skipping this
 *      means a single mid-session upload produces a visible duplicate row.
 *
 *   2. **Ordering.** Append `incoming` after `existing` (trusting Plaud's
 *      newest-first sort), or re-sort the combined list by
 *      `createdAt` desc? Re-sorting is more robust against mid-session
 *      uploads pushing a fresh recording into the middle of the list, but
 *      costs an O(n log n) pass on every Load More click.
 *
 *   3. **hasMore.** Is end-of-stream `incoming.length < pageSize` (ends one
 *      fetch early but never over-fetches), or `incoming.length === 0`
 *      (costs one empty trailing fetch but guarantees we never hide the
 *      button prematurely)? The former is cheaper; the latter is safer if
 *      Plaud ever returns a partial page mid-stream for any reason.
 *
 * Keeping this as a pure, exported function means you can write a focused
 * unit test for it in `__tests__/import-modal.test.ts` — highly recommended
 * once you've picked your strategy, since this is exactly the kind of
 * merging logic where off-by-one bugs love to hide.
 */
export function mergeRecordings(
	existing: readonly Recording[],
	incoming: readonly Recording[],
	pageSize: number,
): { readonly merged: readonly Recording[]; readonly hasMore: boolean } {
	// Placeholder implementation — see the TODO in the JSDoc above.
	const merged = [...existing, ...incoming];
	const hasMore = incoming.length > 0;
	return { merged, hasMore };
}

// -----------------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------------

export class ImportModal extends Modal {
	private readonly client: PlaudClient;
	private readonly noteWriterOptions: NoteWriterOptions;
	private readonly selectedIds = new Set<string>();
	private importButton: HTMLButtonElement | null = null;
	// Mutable accumulator across Load More clicks. Starts empty on each
	// refresh() (first open or Retry), then grows as loadMore() appends
	// new pages via mergeRecordings().
	private currentRecordings: Recording[] = [];
	// Live reference to the list container DOM node so loadMore() can
	// append new rows incrementally without re-rendering the whole list
	// (which would flash, reset scroll position, and throw away the
	// checkbox DOM state for rows the user is still looking at).
	private listEl: HTMLElement | null = null;
	// The "Load more" button, or null when the list has no more pages
	// (hasMore === false) or the list isn't currently rendered.
	private loadMoreButton: HTMLButtonElement | null = null;
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

	constructor(app: App, client: PlaudClient, noteWriterOptions: NoteWriterOptions) {
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
		this.importButton = null;
		this.currentRecordings = [];
		this.listEl = null;
		this.loadMoreButton = null;
		this.introEl = null;
		this.hasMore = false;
		this.loadingMore = false;
	}

	private async refresh(): Promise<void> {
		// Full reset on every refresh — this covers both the initial open
		// and the error-state Retry click. Any pending Load More from a
		// previous render is invalidated via the generation bump below.
		this.selectedIds.clear();
		this.importButton = null;
		this.listEl = null;
		this.loadMoreButton = null;
		this.introEl = null;
		this.currentRecordings = [];
		this.hasMore = false;
		this.loadingMore = false;
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

	private async loadMore(): Promise<void> {
		// Re-entry guard: fast double-clicks or keyboard activations can
		// fire the click handler twice before the button is visually
		// disabled. The flag is the source of truth; the disabled state
		// is just visual feedback.
		if (this.loadingMore || !this.hasMore) {
			return;
		}
		this.loadingMore = true;
		const generation = this.fetchGeneration;
		const skip = this.currentRecordings.length;

		const button = this.loadMoreButton;
		if (button !== null) {
			button.disabled = true;
			button.textContent = 'Loading more…';
		}

		try {
			const incoming = await this.client.listRecordings({
				skip,
				limit: PAGE_SIZE,
			});
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
			this.updateLoadMoreButton();
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
			if (button !== null) {
				button.disabled = false;
				button.textContent = 'Load more recordings';
			}
		} finally {
			this.loadingMore = false;
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
		this.updateLoadMoreButton();

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		this.importButton = buttonRow.createEl('button', {
			text: 'Import',
			cls: 'mod-cta',
		});
		this.importButton.disabled = true;
		this.importButton.addEventListener('click', () => {
			this.onImportClick().catch((err) => {
				// onImportClick has internal error handling around every
				// write and the writer construction — this outer catch is
				// defense-in-depth against a future bug that throws outside
				// those try/catch blocks.
				console.error('Plaud Importer: unexpected error in onImportClick', err);
				this.renderError(classifyError(err));
			});
		});

		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => this.close());
	}

	private renderRow(listEl: HTMLElement, rec: Recording): void {
		// createDiv appends to the end of listEl. If the Load More button
		// is currently the last child (because we already rendered at
		// least one page), we need to move the new row in front of it
		// so the button stays visually anchored to the bottom of the list.
		// insertBefore is a no-op for node position when the node is
		// already in the target location, and otherwise moves it — exactly
		// what we want either way.
		const row = listEl.createDiv({ cls: 'plaud-importer-row' });
		if (this.loadMoreButton !== null && this.loadMoreButton.parentElement === listEl) {
			listEl.insertBefore(row, this.loadMoreButton);
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
		if (rec.transcriptAvailable || rec.summaryAvailable) {
			meta.createSpan({ text: '  ·  ', cls: 'plaud-importer-sep' });
			if (rec.transcriptAvailable) {
				meta.createSpan({ text: '[T]', cls: 'plaud-importer-flag' });
			}
			if (rec.summaryAvailable) {
				meta.createSpan({ text: '[S]', cls: 'plaud-importer-flag' });
			}
		}
	}

	private updateImportButtonState(): void {
		if (this.importButton) {
			this.importButton.disabled = this.selectedIds.size === 0;
		}
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

	private updateLoadMoreButton(): void {
		if (this.listEl === null) {
			return;
		}
		if (!this.hasMore) {
			// No more pages — remove the button if it exists. We don't
			// just hide it so that subsequent renderRow calls don't need
			// to worry about a ghost element still being the last child.
			if (this.loadMoreButton !== null) {
				this.loadMoreButton.remove();
				this.loadMoreButton = null;
			}
			return;
		}
		if (this.loadMoreButton === null) {
			const button = this.listEl.createEl('button', {
				text: 'Load more recordings',
				cls: 'plaud-importer-load-more',
			});
			button.addEventListener('click', () => {
				this.loadMore().catch((err) => {
					// loadMore has its own error handling for the fetch
					// path — this outer catch is defense-in-depth against
					// a future bug that throws synchronously.
					console.error('Plaud Importer: unexpected error in loadMore', err);
					new Notice(
						'Plaud Importer: could not load more — see the developer console for details.',
					);
				});
			});
			this.loadMoreButton = button;
		} else {
			// Re-seat the button as the last child in case new rows were
			// appended after it somehow (e.g., insertBefore was skipped
			// because loadMoreButton was null at the moment of the append).
			this.listEl.appendChild(this.loadMoreButton);
			this.loadMoreButton.disabled = false;
			this.loadMoreButton.textContent = 'Load more recordings';
		}
	}

	private async onImportClick(): Promise<void> {
		const selected = this.currentRecordings.filter((r) =>
			this.selectedIds.has(r.id),
		);
		if (selected.length === 0) {
			return;
		}

		// Construct the writer lazily. A NoteWriterError here means the
		// user's config is bad ("..", invalid onDuplicate) — surface via
		// the error state with the config-error classification so the UI
		// points at Settings rather than saying "unknown error please
		// report this." Anything else is a real code bug; re-throw so the
		// outer click handler's .catch picks it up honestly.
		let writer: NoteWriter;
		try {
			writer = new NoteWriter(this.app.vault, this.noteWriterOptions);
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
				const { transcript, summary, aiKeywords, chapters } =
					await this.client.getTranscriptAndSummary(recording.id);
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
				const writeOutcome = await writer.writeNote(
					enrichedRecording,
					transcript,
					summary,
					chapters,
				);
				// Report the original recording in the result so any
				// downstream UI that renders the import summary sees the
				// same object the modal already knows about. The merged
				// tags only need to exist long enough to land in the
				// written note's frontmatter.
				results.push({ kind: 'written', recording, writeOutcome });
			} catch (err) {
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
