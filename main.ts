import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	requestUrl,
	type RequestUrlResponse,
} from "obsidian";
import {
	ReverseEngineeredPlaudClient,
	type PlaudHttpFetcher,
} from "./plaud-client-re";
import { ImportModal } from "./import-modal";
import { BufferedDebugLogger } from "./debug-logger";

interface PlaudImporterSettings {
	secretId: string;
	outputFolder: string;
	onDuplicate: "skip" | "overwrite" | "prompt";
	showRibbonIcon: boolean;
	debug: boolean;
	includeTranscript: boolean;
	defaultIncludeSummary: boolean;
	defaultIncludeAttachments: boolean;
	defaultIncludeMindmap: boolean;
	defaultIncludeCard: boolean;
	foldTranscript: boolean;
	transcriptHeaderLevel: 1 | 2 | 3 | 4 | 5 | 6;
}

const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: "",
	outputFolder: "Plaud",
	onDuplicate: "prompt",
	showRibbonIcon: true,
	debug: false,
	includeTranscript: true,
	defaultIncludeSummary: true,
	defaultIncludeAttachments: true,
	defaultIncludeMindmap: true,
	defaultIncludeCard: true,
	foldTranscript: true,
	transcriptHeaderLevel: 4,
};

// Adapt Obsidian's requestUrl to the PlaudHttpFetcher shape the client
// depends on. Using requestUrl (not fetch) is required to avoid CORS and
// certificate issues on Electron. `throw: false` lets us map status codes
// in the client rather than Obsidian's implicit throw.
const obsidianFetcher: PlaudHttpFetcher = async ({ url, method, headers, body }) => {
	const response = await requestUrl({
		url,
		method,
		headers: { ...headers },
		body,
		throw: false,
	});
	return {
		status: response.status,
		json: safeJson(response),
		text: response.text ?? "",
	};
};

// requestUrl's `json` is a getter that parses `text` lazily and throws a
// SyntaxError on invalid JSON. Catch ONLY SyntaxError and return null — the
// client will then produce a PlaudParseError with the raw body snippet.
// Any other exception type is a genuine bug (e.g. an internal Obsidian API
// change) and should propagate so it can be surfaced loudly instead of
// silently misclassified as "unexpected shape from Plaud."
function safeJson(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch (err) {
		if (err instanceof SyntaxError) {
			return null;
		}
		throw err;
	}
}

// Clipboard write with a user-visible fallback Notice if the platform
// blocks the clipboard API. Kept here rather than in a shared util because
// main.ts is the only caller — import-modal.ts has its own copy for the
// error-details flow.
async function copyToClipboard(
	text: string,
	onSuccess: () => void,
): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		onSuccess();
	} catch (err) {
		console.error("Plaud Importer: clipboard write failed", err);
		new Notice(
			"Plaud Importer: could not copy to clipboard — see the developer console (Ctrl+Shift+I) for the full error.",
		);
	}
}

export default class PlaudImporterPlugin extends Plugin {
	settings!: PlaudImporterSettings;
	private client?: ReverseEngineeredPlaudClient;
	// Single logger instance shared by the client and the settings tab.
	// The `enabled` flag is toggled in place by the settings toggle so
	// changes take effect immediately without reinstantiating the client.
	debugLogger!: BufferedDebugLogger;
	// Live reference to the ribbon icon element so the settings toggle
	// can add or remove it without reloading the plugin. Null when the
	// icon is currently hidden per the user's preference.
	private ribbonIconEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		this.debugLogger = new BufferedDebugLogger(this.settings.debug, {
			headerLines: [`Plugin version: ${this.manifest.version}`],
		});

		this.addSettingTab(new PlaudImporterSettingsTab(this.app, this));

		this.addCommand({
			id: "import-recent",
			name: "Import recent recordings",
			callback: () => this.launchImportModal("command"),
		});

		// Render the left-rail ribbon icon only when the user has opted
		// in via settings. updateRibbonIcon() is idempotent and is also
		// called from the settings toggle so enabling/disabling takes
		// effect without reloading the plugin.
		this.updateRibbonIcon();

		this.addCommand({
			id: "debug-copy-log",
			name: "Debug: copy debug log to clipboard",
			callback: () => {
				const formatted = this.debugLogger.format();
				void copyToClipboard(formatted, () => {
					const count = this.debugLogger.snapshot().length;
					new Notice(
						`Plaud Importer: copied ${count} debug event${
							count === 1 ? "" : "s"
						} to clipboard.`,
					);
				});
			},
		});

		this.addCommand({
			id: "debug-clear-log",
			name: "Debug: clear debug log",
			callback: () => {
				const count = this.debugLogger.snapshot().length;
				this.debugLogger.clear();
				new Notice(
					`Plaud Importer: cleared ${count} debug event${
						count === 1 ? "" : "s"
					}.`,
				);
			},
		});

		this.app.workspace.onLayoutReady(() => {
			// Construct the client once. It reads the token fresh on every
			// API call via the provider, so settings changes take effect
			// immediately with no reinstantiation.
			this.client = new ReverseEngineeredPlaudClient(
				() => this.app.secretStorage.getSecret(this.settings.secretId),
				obsidianFetcher,
				{ debugLogger: this.debugLogger },
			);
		});
	}

	onunload() {
		this.client = undefined;
		// Obsidian auto-detaches ribbon icons on unload; clear our
		// reference so a subsequent onload starts from a known state.
		this.ribbonIconEl = null;
	}

	/**
	 * Add or remove the left-rail ribbon icon based on the current
	 * setting. Safe to call repeatedly — no-ops when the DOM state
	 * already matches the setting. `audio-lines` is a Lucide icon that
	 * visually matches "audio recording" without suggesting user-facing
	 * recording (`mic`) or being generic (`download`).
	 */
	updateRibbonIcon(): void {
		if (this.settings.showRibbonIcon) {
			if (this.ribbonIconEl !== null) {
				return;
			}
			this.ribbonIconEl = this.addRibbonIcon(
				"audio-lines",
				"Plaud Importer: Import recordings",
				() => this.launchImportModal("ribbon"),
			);
			return;
		}
		if (this.ribbonIconEl !== null) {
			this.ribbonIconEl.detach();
			this.ribbonIconEl = null;
		}
	}

	/**
	 * Common entry point for launching the Plaud import modal. Called
	 * from both the command palette and the left-rail ribbon icon so
	 * that initialization guards and debug-log breadcrumbs only live in
	 * one place. The `source` tag differentiates the two trigger paths
	 * in the debug log when it's enabled.
	 */
	private launchImportModal(source: "command" | "ribbon"): void {
		if (!this.client) {
			new Notice(
				"Plaud Importer: still initializing. Try again in a moment.",
			);
			return;
		}
		if (this.debugLogger.enabled) {
			this.debugLogger.log({
				kind: "note",
				message: `user invoked 'Import recent recordings' via ${source}`,
			});
		}
		// Snapshot settings at invocation time so changes in the settings
		// tab take effect on the next click without reinstantiation.
		new ImportModal(this.app, this.client, {
			outputFolder: this.settings.outputFolder,
			onDuplicate: this.settings.onDuplicate,
			includeTranscript: this.settings.includeTranscript,
			includeSummary: this.settings.defaultIncludeSummary,
			foldTranscript: this.settings.foldTranscript,
			transcriptHeaderLevel: this.settings.transcriptHeaderLevel,
			defaultIncludeSummary: this.settings.defaultIncludeSummary,
			defaultIncludeAttachments: this.settings.defaultIncludeAttachments,
			defaultIncludeMindmap: this.settings.defaultIncludeMindmap,
			defaultIncludeCard: this.settings.defaultIncludeCard,
			debugLogger: this.debugLogger,
			getAuthToken: () =>
				this.settings.secretId.length > 0
					? this.app.secretStorage.getSecret(this.settings.secretId)
					: null,
		}).open();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PlaudImporterSettingsTab extends PluginSettingTab {
	plugin: PlaudImporterPlugin;

	constructor(app: App, plugin: PlaudImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Plaud token")
			.setDesc(
				"Select or create a stored secret holding your Plaud.AI session token. The secret value is stored in Obsidian's per-vault secret storage, never in data.json.",
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.secretId)
					.onChange(async (id) => {
						this.plugin.settings.secretId = id;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc(
				"Folder inside your vault where imported notes are written.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Plaud")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder =
							value.trim() || "Plaud";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Duplicate handling")
			.setDesc(
				"What to do when a note for the recording already exists in the output folder.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("skip", "Skip")
					.addOption("overwrite", "Overwrite")
					.addOption("prompt", "Ask each time")
					.setValue(this.plugin.settings.onDuplicate)
					.onChange(async (value) => {
						this.plugin.settings.onDuplicate =
							value as "skip" | "overwrite" | "prompt";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show ribbon icon")
			.setDesc(
				"Display the Plaud Importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						this.plugin.updateRibbonIcon();
					}),
			);

		containerEl.createEl("h3", { text: "Default artifact selection" });

		new Setting(containerEl)
			.setName("Transcript")
			.setDesc(
				"Checked by default in import actions. You can override in 'Review artifacts first'.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeTranscript)
					.onChange(async (value) => {
						this.plugin.settings.includeTranscript = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Summary")
			.setDesc(
				"Checked by default in import actions. You can override in 'Review artifacts first'.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultIncludeSummary)
					.onChange(async (value) => {
						this.plugin.settings.defaultIncludeSummary = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Attachments")
			.setDesc(
				"Checked by default in import actions when attachments are available.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultIncludeAttachments)
					.onChange(async (value) => {
						this.plugin.settings.defaultIncludeAttachments = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Mindmap")
			.setDesc(
				"Checked by default in import actions when a mindmap artifact is available.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultIncludeMindmap)
					.onChange(async (value) => {
						this.plugin.settings.defaultIncludeMindmap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Card")
			.setDesc(
				"Checked by default in import actions when a card artifact is available.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultIncludeCard)
					.onChange(async (value) => {
						this.plugin.settings.defaultIncludeCard = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Transcript rendering" });

		new Setting(containerEl)
			.setName("Fold transcript by default")
			.setDesc(
				"Collapse the transcript section when the note is created so it doesn't dominate the view on open. Uses Obsidian's heading fold state — clicking the chevron next to the heading expands it. Turn off if you prefer the transcript always expanded.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.foldTranscript)
					.onChange(async (value) => {
						this.plugin.settings.foldTranscript = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Transcript heading level")
			.setDesc(
				"Markdown heading level for the wrapping 'Transcript' heading. Chapter sub-headings render at one level below (e.g. level 4 → transcript is H4, chapters are H5). This is the heading whose fold state the 'Fold transcript by default' toggle controls.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "H1")
					.addOption("2", "H2")
					.addOption("3", "H3")
					.addOption("4", "H4")
					.addOption("5", "H5")
					.addOption("6", "H6")
					.setValue(String(this.plugin.settings.transcriptHeaderLevel))
					.onChange(async (value) => {
						const level = Number(value);
						if (level >= 1 && level <= 6) {
							this.plugin.settings.transcriptHeaderLevel =
								level as 1 | 2 | 3 | 4 | 5 | 6;
							await this.plugin.saveSettings();
						}
					}),
			);

		containerEl.createEl("h3", { text: "Debug" });

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc(
				"Capture raw API requests, responses, and parsed results into an in-memory buffer and mirror them to the developer console (Ctrl+Shift+I). Authentication headers are NEVER captured. Payloads may contain transcript text, speaker names, and recording metadata — only enable when troubleshooting. Use the 'Plaud Importer: Debug: copy debug log to clipboard' command to export the session.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						// Update the live logger's enabled flag in place so
						// the change takes effect on the next API call
						// without having to reinstantiate the client.
						this.plugin.debugLogger.setEnabled(value);
						await this.plugin.saveSettings();
						if (value) {
							new Notice(
								"Plaud Importer: debug logging enabled. Run a command to capture events.",
							);
						} else {
							new Notice(
								"Plaud Importer: debug logging disabled. The buffer is preserved — use the clear command to wipe it.",
							);
						}
					}),
			);
	}
}
