// The migration preview modal. Runs the SAME planMigration the apply uses,
// shows exactly which notes would be rewritten (old id -> new id, matched by
// exact id, start-time, or date) BEFORE anything changes, and applies only on
// the button.
// Built so a user can see what the migration is doing rather than trust a notice.

import { App, Modal, Notice } from 'obsidian';
import type { MigrationHeal, MigrationPlan } from './migration-plan';

export interface MigrationModalDeps {
	/** Fetch the current recordings and compute the plan against the vault. */
	computePlan(): Promise<MigrationPlan>;
	/** Apply the plan's heals, returning how many notes were rewritten. */
	applyPlan(plan: MigrationPlan): Promise<number>;
	/** Write the full plan to a markdown note for review; returns its path. */
	savePlan(plan: MigrationPlan): Promise<string>;
}

// Show at most this many heal rows; the rest are summarized as a count so a
// large library does not build thousands of DOM nodes.
const MAX_ROWS = 200;

function shortId(id: string): string {
	return id.length > 22 ? `${id.slice(0, 19)}...` : id;
}

// How the note was matched, shown per row so an exact match reads differently
// from a time-based guess.
function viaLabel(via: MigrationHeal['via']): string {
	if (via === 'id') return 'exact id';
	if (via === 'start-time') return 'start-time';
	return 'date';
}

export class MigrationPreviewModal extends Modal {
	private plan: MigrationPlan | null = null;
	private applying = false;

	constructor(
		app: App,
		private readonly deps: MigrationModalDeps,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Migrate recording ids');
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: 'Reading your current recordings and notes...',
		});
		try {
			this.plan = await this.deps.computePlan();
		} catch (err) {
			contentEl.empty();
			contentEl.createEl('p', {
				cls: 'plaud-importer-migration-error',
				text: `Could not build the plan: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
			return;
		}
		this.render();
	}

	private render(): void {
		const plan = this.plan;
		if (plan === null) return;
		const { contentEl } = this;
		contentEl.empty();

		const summary = contentEl.createDiv({
			cls: 'plaud-importer-migration-summary',
		});
		summary.createEl('p', {
			text: `${plan.recordingCount} recordings in the signed-in account, ${plan.noteCount} imported notes in your output folder.`,
		});
		const line = summary.createEl('ul');
		line.createEl('li', {
			text: `${plan.heals.length} note${plan.heals.length === 1 ? '' : 's'} would be updated to the current id.`,
		});
		line.createEl('li', {
			text: `${plan.alreadyCurrent} already on the current id (nothing to do).`,
		});
		line.createEl('li', {
			text: `${plan.unmatchedRecordings} recording${plan.unmatchedRecordings === 1 ? '' : 's'} match no note here (new, or a different account).`,
		});

		if (plan.heals.length === 0) {
			// Distinguish "matched, but every note is already current" from
			// "nothing matched at all": only the latter points at a wrong account.
			const text =
				plan.alreadyCurrent > 0
					? 'Nothing to migrate. Every note that matches a recording in this account is already on the current id.'
					: 'Nothing to migrate. No note in your output folder matches a recording in this account. If you expected matches, make sure the plugin is signed into the account that holds these meetings.';
			contentEl.createEl('p', {
				cls: 'plaud-importer-migration-empty',
				text,
			});
		} else {
			const list = contentEl.createDiv({
				cls: 'plaud-importer-migration-list',
			});
			for (const heal of plan.heals.slice(0, MAX_ROWS)) {
				this.renderHealRow(list, heal);
			}
			if (plan.heals.length > MAX_ROWS) {
				list.createDiv({
					cls: 'plaud-importer-migration-more',
					text: `...and ${plan.heals.length - MAX_ROWS} more.`,
				});
			}
		}

		const buttons = contentEl.createDiv({
			cls: 'plaud-importer-migration-buttons',
		});
		const save = buttons.createEl('button', {
			text: 'Save plan to a note',
		});
		save.disabled = plan.heals.length === 0;
		save.addEventListener('click', () => {
			void this.save();
		});
		const apply = buttons.createEl('button', {
			cls: 'mod-cta',
			text:
				plan.heals.length === 0
					? 'Nothing to apply'
					: `Apply to ${plan.heals.length} note${plan.heals.length === 1 ? '' : 's'}`,
		});
		apply.disabled = plan.heals.length === 0 || this.applying;
		apply.addEventListener('click', () => {
			void this.apply();
		});
		const close = buttons.createEl('button', { text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	private renderHealRow(parent: HTMLElement, heal: MigrationHeal): void {
		const row = parent.createDiv({ cls: 'plaud-importer-migration-row' });
		const name = heal.notePath.split('/').pop() ?? heal.notePath;
		// Your note on the left, the recording it matched on the right, so you can
		// see they are the same meeting.
		row.createDiv({ cls: 'plaud-importer-migration-note', text: name });
		row.createSpan({
			cls: 'plaud-importer-migration-arrow',
			text: 'matches',
		});
		row.createDiv({
			cls: 'plaud-importer-migration-rec',
			text: `${heal.recordingTitle}  (${heal.recordingWhen})`,
		});
		row.createSpan({
			cls: 'plaud-importer-migration-via',
			text: viaLabel(heal.via),
			attr: {
				'aria-label': `${shortId(heal.fromId)} to ${shortId(heal.toId)}`,
				title: `${heal.fromId}  ->  ${heal.toId}`,
			},
		});
	}

	private async apply(): Promise<void> {
		const plan = this.plan;
		if (plan === null || this.applying) return;
		this.applying = true;
		this.render();
		let written: number;
		try {
			written = await this.deps.applyPlan(plan);
		} catch (err) {
			// The apply itself failed. Re-enable the Apply button so the user can
			// retry, and show why.
			new Notice(
				`Plaud importer: migration failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			this.applying = false;
			this.render();
			return;
		}
		new Notice(
			`Plaud importer: updated ${written} note${written === 1 ? '' : 's'}.`,
		);
		// The apply succeeded. Rebuild the plan so the modal reflects the healed
		// state (now a no-op). load() renders the fresh plan, or its own error UI
		// if the rebuild fails; either way it owns the render from here, so we do
		// NOT re-render over it and hide a refresh failure.
		this.applying = false;
		await this.load();
	}

	private async save(): Promise<void> {
		const plan = this.plan;
		if (plan === null) return;
		try {
			const path = await this.deps.savePlan(plan);
			new Notice(`Plaud importer: saved the plan to ${path}.`);
		} catch (err) {
			new Notice(
				`Plaud importer: could not save the plan: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}
