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
		// No status (fetcher threw) — genuine network-layer failure.
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

// -----------------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------------

export class ImportModal extends Modal {
	private readonly client: PlaudClient;
	private readonly noteWriterOptions: NoteWriterOptions;
	private readonly selectedIds = new Set<string>();
	private importButton: HTMLButtonElement | null = null;
	private currentRecordings: readonly Recording[] = [];
	// Monotonic counter that increments on every refresh() call. Each
	// in-flight fetch captures the current value and bails before rendering
	// if it has changed — prevents the "click Retry while slow fetch is
	// still running" race from overwriting newer state with stale results.
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
	}

	private async refresh(): Promise<void> {
		this.selectedIds.clear();
		this.importButton = null;
		const generation = ++this.fetchGeneration;
		this.renderLoading();
		try {
			const recordings = await this.client.listRecordings({ limit: 10 });
			if (generation !== this.fetchGeneration) {
				// A newer refresh() started while we were waiting. Drop the
				// stale result on the floor.
				return;
			}
			this.currentRecordings = recordings;
			if (recordings.length === 0) {
				this.renderEmpty();
			} else {
				this.renderList(recordings);
			}
		} catch (err) {
			if (generation !== this.fetchGeneration) {
				return;
			}
			this.renderError(classifyError(err));
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
		if (classification.canRetry) {
			const retryButton = buttonRow.createEl('button', {
				text: 'Retry',
				cls: 'mod-cta',
			});
			retryButton.addEventListener('click', () => {
				this.refresh().catch((err) => {
					this.renderError(classifyError(err));
				});
			});
		}
		const closeButton = buttonRow.createEl('button', { text: 'Close' });
		closeButton.addEventListener('click', () => this.close());
	}

	private renderList(records: readonly Recording[]): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `${records.length} recording${
				records.length === 1 ? '' : 's'
			} available. Select which to import.`,
			cls: 'plaud-importer-intro',
		});

		const listEl = contentEl.createDiv({ cls: 'plaud-importer-list' });
		for (const rec of records) {
			this.renderRow(listEl, rec);
		}

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
				this.renderError(classifyError(err));
			});
		});

		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => this.close());
	}

	private renderRow(listEl: HTMLElement, rec: Recording): void {
		const row = listEl.createDiv({ cls: 'plaud-importer-row' });

		const checkbox = row.createEl('input', {
			type: 'checkbox',
			cls: 'plaud-importer-checkbox',
		});
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
				const { transcript, summary } = await this.client.getTranscriptAndSummary(
					recording.id,
				);
				const writeOutcome = await writer.writeNote(recording, transcript, summary);
				results.push({ kind: 'written', recording, writeOutcome });
			} catch (err) {
				// TODO: plumb through a logError(errorIds.IMPORT_RECORDING_FAILED, ...)
				// call once the plugin has telemetry infrastructure.
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
			details.createEl('summary', {
				text: `${tally.failures.length} failure${
					tally.failures.length === 1 ? '' : 's'
				} — click to expand`,
			});
			const list = details.createEl('ul');
			for (const f of tally.failures) {
				if (f.kind !== 'failed') {
					continue;
				}
				const li = list.createEl('li');
				li.createEl('strong', { text: f.recording.title });
				li.createSpan({ text: ` — ${f.reason}` });
			}
		}

		const buttonRow = contentEl.createDiv({ cls: 'plaud-importer-buttons' });
		const closeButton = buttonRow.createEl('button', {
			text: 'Done',
			cls: 'mod-cta',
		});
		closeButton.addEventListener('click', () => this.close());
	}
}
