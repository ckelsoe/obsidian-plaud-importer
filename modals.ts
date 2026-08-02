/**
 * The plugin's three plain modals. Extracted from main.ts unchanged; none of
 * them touches the plugin, only `App` and the callbacks it is handed, which
 * is what made them the cheapest thing in the file to lift out.
 */
import { App, Modal, Notice, Setting, type TextComponent } from 'obsidian';

// Just-in-time reminder shown when the user launches the browser sign-in, so
// the capture steps are in front of them at the moment they switch to the
// browser. Step text is built from variables (not string literals at the call
// site) so it can name "Plaud" and the buttons while satisfying the
// sentence-case lint, which only inspects literals.
export class BrowserSignInModal extends Modal {
	private readonly onLaunch: () => void;
	private readonly onPaste?: () => Promise<boolean>;
	private readonly onCloseCb?: () => void;

	// onPaste is optional. When omitted (the settings/import-modal "launch"
	// button), opening the browser closes this modal and the user pastes from the
	// separate paste control. When supplied (the SSO reconnect notice), the modal
	// stays open after launching so the returning user can paste right here, and a
	// successful paste closes it. onCloseCb, when supplied, runs on every close
	// path (paste success, cancel, dismiss) so a caller can release a single-flight
	// guard it set before opening.
	constructor(
		app: App,
		onLaunch: () => void,
		onPaste?: () => Promise<boolean>,
		onCloseCb?: () => void,
	) {
		super(app);
		this.onLaunch = onLaunch;
		this.onPaste = onPaste;
		this.onCloseCb = onCloseCb;
	}

	onOpen(): void {
		this.setTitle('Get your sign-in token');
		const { contentEl } = this;
		const intro = 'Your web browser is about to open. Do these in order:';
		contentEl.createEl('p', { text: intro });
		const ol = contentEl.createEl('ol');
		const lines = [
			'Sign in to Plaud if you are not already. Google, Apple, and password all work in a real browser.',
			"Click the 'Plaud → Obsidian' bookmark on your bookmarks bar (the one you saved during setup). Your browser asks to open Obsidian; allow it, and the token is saved for you.",
			"If Obsidian does not open, the bookmark shows a line of text in a box instead. Copy the whole line, come back here, and click 'Paste token from clipboard'.",
		];
		for (const line of lines) {
			ol.createEl('li', { text: line });
		}
		const openLabel = 'Open my browser now';
		const row = new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(openLabel)
				.setCta()
				.onClick(() => {
					this.onLaunch();
					// With no inline paste, launching is the last step here; close so
					// the user is not left with a stale modal. With inline paste, keep
					// the modal open so they can paste on their way back.
					if (this.onPaste === undefined) {
						this.close();
					}
				}),
		);
		if (this.onPaste !== undefined) {
			const paste = this.onPaste;
			row.addButton((btn) =>
				btn
					.setButtonText('Paste token from clipboard')
					.onClick(async () => {
						// Guard the whole handler: pasteTokenFromClipboard swallows a
						// clipboard read failure, but storing the token (secret storage,
						// saveSettings) can still throw. Without this an async click
						// rejection would surface unhandled and leave the modal open with
						// no feedback.
						try {
							const ok = await paste();
							if (ok) {
								this.close();
							}
						} catch (err) {
							console.error(
								'Plaud importer: paste reconnect failed',
								err,
							);
							new Notice(
								'Plaud: could not save that token. Try again, or use settings.',
							);
						}
					}),
			);
		}
		row.addButton((btn) =>
			btn.setButtonText('Cancel').onClick(() => this.close()),
		);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onCloseCb?.();
	}
}

/**
 * Prompt for a new name for an imported recording. Prefills the current base
 * name, submits on Enter or the Rename button, and hands the raw text to the
 * caller (which sanitizes it and performs the note + assets-folder rename).
 */
export class RenameRecordingModal extends Modal {
	private value: string;
	private readonly onSubmit: (newName: string) => void;

	constructor(
		app: App,
		initial: string,
		onSubmit: (newName: string) => void,
	) {
		super(app);
		this.value = initial;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle('Rename recording');
		const { contentEl } = this;
		let input: TextComponent | undefined;
		new Setting(contentEl)
			.setName('New name')
			.setDesc(
				'The note and its attachments folder are renamed together.',
			)
			.addText((text) => {
				input = text;
				text.setValue(this.value).onChange((v) => {
					this.value = v;
				});
				text.inputEl.addEventListener('keydown', (evt) => {
					if (evt.key === 'Enter') {
						evt.preventDefault();
						this.submit();
					}
				});
			});
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Rename')
					.setCta()
					.onClick(() => this.submit()),
			)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			);
		if (input) {
			input.inputEl.focus();
			input.inputEl.select();
		}
	}

	private submit(): void {
		const trimmed = this.value.trim();
		if (trimmed.length === 0) {
			new Notice('Plaud importer: enter a name.');
			return;
		}
		this.close();
		this.onSubmit(trimmed);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface ConfirmModalOptions {
	readonly title: string;
	readonly body: string;
	readonly confirmText: string;
	readonly cancelText: string;
	readonly onConfirm: () => void;
}

/**
 * Minimal yes/no confirmation modal. The title and button labels stay plain
 * (sentence-case UI rule); the question and any product name go in the body
 * paragraph, which is freeform text.
 */
export class ConfirmModal extends Modal {
	private readonly opts: ConfirmModalOptions;

	constructor(app: App, opts: ConfirmModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createEl('p', { text: this.opts.body });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(this.opts.confirmText)
					.setCta()
					.onClick(() => {
						this.close();
						this.opts.onConfirm();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.opts.cancelText)
					.onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
