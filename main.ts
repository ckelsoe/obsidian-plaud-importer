import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	type SettingDefinitionItem,
	requestUrl,
	setIcon,
	type RequestUrlResponse,
} from "obsidian";
import {
	ReverseEngineeredPlaudClient,
	type PlaudHttpFetcher,
} from "./plaud-client-re";
import { ImportModal } from "./import-modal";
import { BufferedDebugLogger } from "./debug-logger";

// Curated list of Lucide icon IDs offered in the "Ribbon icon" setting.
// Each entry is a valid Lucide ID bundled with Obsidian's icon set. This
// list is intentionally short for now — a future upgrade can swap the
// dropdown for a full searchable picker without changing the settings
// schema (the stored value is a plain Lucide ID either way).
const RIBBON_ICON_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "audio-lines", label: "Audio waveform (default)" },
	{ id: "mic", label: "Microphone" },
	{ id: "mic-vocal", label: "Vocal mic" },
	{ id: "headphones", label: "Headphones" },
	{ id: "file-audio-2", label: "Audio file" },
	{ id: "podcast", label: "Podcast" },
	{ id: "radio", label: "Radio" },
	{ id: "tape", label: "Cassette tape" },
	{ id: "volume-2", label: "Speaker" },
	{ id: "notebook-pen", label: "Notebook" },
	{ id: "captions", label: "Captions" },
	{ id: "users-round", label: "Meeting participants" },
];
const DEFAULT_RIBBON_ICON = "audio-lines";

/**
 * Coerce a stored ribbon icon ID to a known-good value. Protects against
 * a hand-edited `data.json` or a setting left over from a future build
 * that drops an icon from the curated list — either would render an
 * empty ribbon slot otherwise.
 */
function resolveRibbonIconId(stored: string | undefined): string {
	if (typeof stored !== "string" || stored.length === 0) {
		return DEFAULT_RIBBON_ICON;
	}
	return RIBBON_ICON_CHOICES.some((choice) => choice.id === stored)
		? stored
		: DEFAULT_RIBBON_ICON;
}

interface PlaudImporterSettings {
	secretId: string;
	outputFolder: string;
	onDuplicate: "skip" | "overwrite" | "prompt";
	showRibbonIcon: boolean;
	ribbonIcon: string;
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
	ribbonIcon: DEFAULT_RIBBON_ICON,
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
	// The Lucide icon ID currently rendered on `ribbonIconEl`. Tracked
	// separately from the setting so updateRibbonIcon() knows when a
	// pure icon swap requires detach + re-add vs. a no-op.
	private ribbonIconId: string | null = null;

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
		// state so a subsequent onload starts from a known baseline.
		this.ribbonIconEl = null;
		this.ribbonIconId = null;
	}

	/**
	 * Add, remove, or swap the left-rail ribbon icon based on the
	 * current settings. Safe to call repeatedly — no-ops when the DOM
	 * state already matches the setting. An icon ID change triggers a
	 * detach + re-add cycle since Obsidian has no "change icon in
	 * place" API on the ribbon element.
	 */
	updateRibbonIcon(): void {
		if (!this.settings.showRibbonIcon) {
			if (this.ribbonIconEl !== null) {
				this.ribbonIconEl.detach();
				this.ribbonIconEl = null;
				this.ribbonIconId = null;
			}
			return;
		}
		const desiredId = resolveRibbonIconId(this.settings.ribbonIcon);
		if (this.ribbonIconEl !== null && this.ribbonIconId === desiredId) {
			return;
		}
		if (this.ribbonIconEl !== null) {
			this.ribbonIconEl.detach();
		}
		this.ribbonIconEl = this.addRibbonIcon(
			desiredId,
			"Plaud importer: Import recordings",
			() => this.launchImportModal("ribbon"),
		);
		this.ribbonIconId = desiredId;
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
				"Plaud importer: Still initializing. Try again in a moment.",
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
		const stored = (await this.loadData()) as Partial<PlaudImporterSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
		// Repair a blank stored output folder back to the default. The
		// declarative control can persist an empty string; consumers expect a
		// non-empty folder name.
		if (
			typeof this.settings.outputFolder !== "string" ||
			this.settings.outputFolder.trim().length === 0
		) {
			this.settings.outputFolder = "Plaud";
		}
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Plaud token",
				desc: "Select or create a stored secret holding your Plaud.AI session token. The secret value is stored in Obsidian's per-vault secret storage, never in data.json.",
				// SecretComponent needs an App instance and is added via
				// Setting#addComponent, so it lives in a render callback rather
				// than a declarative control. It is not search-indexable.
				searchable: false,
				render: (setting: Setting) => {
					setting.addComponent((el) =>
						new SecretComponent(this.app, el)
							.setValue(this.plugin.settings.secretId)
							.onChange(async (id) => {
								this.plugin.settings.secretId = id;
								await this.plugin.saveSettings();
							}),
					);
				},
			},
			{
				name: "Output folder",
				desc: "Folder inside your vault where imported notes are written.",
				control: { type: "text", key: "outputFolder", placeholder: "Plaud" },
			},
			{
				name: "Duplicate handling",
				desc: "What to do when a note for the recording already exists in the output folder.",
				control: {
					type: "dropdown",
					key: "onDuplicate",
					options: { skip: "Skip", overwrite: "Overwrite", prompt: "Ask each time" },
				},
			},
			{
				name: "Show ribbon icon",
				desc: "Display the plaud importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
				control: { type: "toggle", key: "showRibbonIcon" },
			},
			{
				name: "Ribbon icon",
				desc: "Which icon to display in the left rail. Only applies when 'show ribbon icon' is on.",
				// The live preview swaps the SVG in place via setIcon() as the
				// dropdown changes, so this stays a render callback rather than
				// a plain dropdown control.
				searchable: false,
				render: (setting: Setting) => {
					const previewEl = setting.controlEl.createDiv({
						cls: "plaud-importer-ribbon-preview",
					});
					setIcon(previewEl, resolveRibbonIconId(this.plugin.settings.ribbonIcon));
					setting.addDropdown((dropdown) => {
						for (const choice of RIBBON_ICON_CHOICES) {
							dropdown.addOption(choice.id, choice.label);
						}
						dropdown
							.setValue(resolveRibbonIconId(this.plugin.settings.ribbonIcon))
							.onChange(async (value) => {
								this.plugin.settings.ribbonIcon = value;
								await this.plugin.saveSettings();
								setIcon(previewEl, resolveRibbonIconId(value));
								this.plugin.updateRibbonIcon();
							});
					});
				},
			},
			{
				type: "group",
				heading: "Default artifact selection",
				items: [
					{
						name: "Transcript",
						desc: "Checked by default in import actions. You can override in 'review artifacts first'.",
						control: { type: "toggle", key: "includeTranscript" },
					},
					{
						name: "Summary",
						desc: "Checked by default in import actions. You can override in 'review artifacts first'.",
						control: { type: "toggle", key: "defaultIncludeSummary" },
					},
					{
						name: "Attachments",
						desc: "Checked by default in import actions when attachments are available.",
						control: { type: "toggle", key: "defaultIncludeAttachments" },
					},
					{
						name: "Mindmap",
						desc: "Checked by default in import actions when a mindmap artifact is available.",
						control: { type: "toggle", key: "defaultIncludeMindmap" },
					},
					{
						name: "Card",
						desc: "Checked by default in import actions when a card artifact is available.",
						control: { type: "toggle", key: "defaultIncludeCard" },
					},
				],
			},
			{
				type: "group",
				heading: "Transcript rendering",
				items: [
					{
						name: "Fold transcript by default",
						desc: "Collapse the transcript section when the note is created so it doesn't dominate the view on open. Uses Obsidian's heading fold state — clicking the chevron next to the heading expands it. Turn off if you prefer the transcript always expanded.",
						control: { type: "toggle", key: "foldTranscript" },
					},
					{
						name: "Transcript heading level",
						desc: "Markdown heading level for the wrapping 'transcript' heading. Chapter sub-headings render at one level below (e.g. Level 4 → transcript is h4, chapters are h5). This is the heading whose fold state the 'fold transcript by default' toggle controls.",
						control: {
							type: "dropdown",
							key: "transcriptHeaderLevel",
							options: { "1": "H1", "2": "H2", "3": "H3", "4": "H4", "5": "H5", "6": "H6" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Debug",
				items: [
					{
						name: "Debug logging",
						desc: "Capture raw API requests, responses, and parsed results into an in-memory buffer and mirror them to the developer console (Ctrl+Shift+I). Authentication headers are NEVER captured. Payloads may contain transcript text, speaker names, and recording metadata — only enable when troubleshooting. Use the 'Plaud Importer: Debug: copy debug log to clipboard' command to export the session.",
						control: { type: "toggle", key: "debug" },
					},
				],
			},
			{
				name: "",
				searchable: false,
				render: (setting: Setting) => {
					this.renderFooter(setting);
				},
			},
		];
	}

	// Binds declarative control definitions to the plugin's own settings store so
	// changes persist via saveSettings(). transcriptHeaderLevel is stored as a
	// number but the dropdown deals in string option keys, so it is converted at
	// the boundary. outputFolder snaps an empty value back to the "Plaud" default,
	// matching the previous imperative onChange behavior.
	getControlValue(key: string): unknown {
		if (key === "transcriptHeaderLevel") {
			return String(this.plugin.settings.transcriptHeaderLevel);
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "outputFolder") {
			this.plugin.settings.outputFolder =
				(typeof value === "string" ? value.trim() : "") || "Plaud";
		} else if (key === "transcriptHeaderLevel") {
			const level = Number(value);
			if (level >= 1 && level <= 6) {
				this.plugin.settings.transcriptHeaderLevel = level as 1 | 2 | 3 | 4 | 5 | 6;
			}
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}
		await this.plugin.saveSettings();

		// Side effects that the imperative onChange handlers used to run inline.
		if (key === "showRibbonIcon") {
			this.plugin.updateRibbonIcon();
		} else if (key === "debug") {
			// Update the live logger's enabled flag in place so the change takes
			// effect on the next API call without reinstantiating the client.
			this.plugin.debugLogger.setEnabled(this.plugin.settings.debug);
			if (this.plugin.settings.debug) {
				new Notice(
					"Plaud importer: Debug logging enabled. Run a command to capture events.",
				);
			} else {
				new Notice(
					"Plaud importer: Debug logging disabled. The buffer is preserved — use the clear command to wipe it.",
				);
			}
		}
	}

	// Renders the version + support links footer into a trailing settings row
	// (matches the obsidian-shell-path-copy reference plugin's settings tab).
	private renderFooter(setting: Setting): void {
		const el = setting.settingEl;
		el.empty();
		el.addClass("plaud-importer-footer");

		const manifestVersion = this.plugin.manifest.version || "0.0.0";
		el.createSpan({ text: `Version ${manifestVersion} | ` });

		const createExternalLink = (text: string, url: string): HTMLAnchorElement =>
			el.createEl("a", {
				text,
				href: url,
				attr: { target: "_blank", rel: "noopener" },
			});

		createExternalLink("GitHub", "https://github.com/ckelsoe/obsidian-plaud-importer");
		el.createSpan({ text: " | " });
		createExternalLink(
			"Report Issues",
			"https://github.com/ckelsoe/obsidian-plaud-importer/issues",
		);
	}
}
