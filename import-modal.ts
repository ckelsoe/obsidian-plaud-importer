import { App, Modal, Notice } from 'obsidian';
import type { PlaudClient, Recording } from './plaud-client';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from './plaud-client-re';

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
// Modal
// -----------------------------------------------------------------------------

export class ImportModal extends Modal {
	private readonly client: PlaudClient;
	private readonly selectedIds = new Set<string>();
	private importButton: HTMLButtonElement | null = null;
	private currentRecordings: readonly Recording[] = [];
	// Monotonic counter that increments on every refresh() call. Each
	// in-flight fetch captures the current value and bails before rendering
	// if it has changed — prevents the "click Retry while slow fetch is
	// still running" race from overwriting newer state with stale results.
	private fetchGeneration = 0;

	constructor(app: App, client: PlaudClient) {
		super(app);
		this.client = client;
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
		this.importButton.addEventListener('click', () => this.onImportClick());

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

	private onImportClick(): void {
		// TODO(commit-4): wire up NoteWriter. This stub exists only so the
		// modal's checkbox-and-button plumbing can be smoke-tested in a
		// real vault before the write path is implemented. The Notice text
		// says "NOT IMPLEMENTED" so that a future refactor (or accidental
		// revert) can't ship a version where Import appears to succeed but
		// silently writes nothing.
		const count = this.selectedIds.size;
		new Notice(
			`Plaud Importer: selected ${count} recording${
				count === 1 ? '' : 's'
			} — Import is NOT IMPLEMENTED yet (write path lands in the next milestone).`,
		);
		this.close();
	}
}
