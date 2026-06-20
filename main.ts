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
import { ImportModal, classifyError } from "./import-modal";
import { BufferedDebugLogger } from "./debug-logger";
import { openPlaudLogin } from "./plaud-login";
import type { TagMode } from "./note-writer";

// Stable SecretStorage id for a token captured by the in-app sign-in flow.
// Re-running sign-in overwrites it, mirroring "replace my token".
const CAPTURED_SECRET_ID = "plaud-importer-token";

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
	// Base host for the Plaud API. Defaults to the US host. The plugin
	// auto-detects the correct regional host (EU, etc.) on the first API
	// call that hits a region mismatch, then caches it here so later calls
	// skip the redirect. Not surfaced in the settings UI; managed
	// automatically.
	apiBaseUrl: string;
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
	tagMode: TagMode;
	customTags: string;
	aiKeywordsAsProperty: boolean;
	autoCloseSummary: boolean;
	autoCloseSummarySeconds: number;
}

const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: "",
	apiBaseUrl: "https://api.plaud.ai",
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
	// 'plaud' keeps human-set Plaud tags but drops the AI keyword guesses
	// that were flooding vaults with 20-30 single-use tags. The keywords
	// stay available as a frontmatter property via aiKeywordsAsProperty.
	tagMode: "plaud",
	customTags: "plaud-meeting",
	aiKeywordsAsProperty: true,
	autoCloseSummary: true,
	autoCloseSummarySeconds: 20,
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
				{
					debugLogger: this.debugLogger,
					baseUrl: this.settings.apiBaseUrl,
					// Persist the regional host the first time Plaud redirects
					// us, so later sessions skip the round-trip.
					onBaseUrlChanged: (url) => {
						this.settings.apiBaseUrl = url;
						void this.saveSettings();
					},
				},
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
	 * Make one lightweight authenticated call so the user can confirm their
	 * stored token actually reaches Plaud, without running a full import. Maps
	 * any failure through the same classifier the import modal uses, so an
	 * expired or wrong-type token reports the exact remediation (e.g. sign in
	 * again) instead of a generic failure.
	 */
	async testPlaudConnection(): Promise<{ ok: boolean; message: string }> {
		const client = this.client;
		if (client === undefined) {
			return {
				ok: false,
				message:
					"Plaud Importer is still starting up. Wait a moment and try again.",
			};
		}
		try {
			const recordings = await client.listRecordings({ limit: 1 });
			return {
				ok: true,
				message:
					recordings.length > 0
						? "Connected to Plaud. Your token works and recordings are reachable."
						: "Connected to Plaud. Your token works (no recordings found yet).",
			};
		} catch (err) {
			return { ok: false, message: classifyError(err).message };
		}
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
			tagMode: this.settings.tagMode,
			customTags: this.settings.customTags,
			aiKeywordsAsProperty: this.settings.aiKeywordsAsProperty,
			autoCloseSummary: this.settings.autoCloseSummary,
			autoCloseSummarySeconds: this.settings.autoCloseSummarySeconds,
			debugLogger: this.debugLogger,
			getAuthToken: () =>
				this.settings.secretId.length > 0
					? this.app.secretStorage.getSecret(this.settings.secretId)
					: null,
			getApiBaseUrl: () => this.settings.apiBaseUrl,
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

	// Imperative settings tab for Obsidian < 1.13.0. Obsidian 1.13.0+ renders
	// from getSettingDefinitions() and skips display() entirely; older builds
	// have no knowledge of getSettingDefinitions() and call display() instead.
	//
	// This method and the render/row helpers it calls use ONLY pre-1.12 Obsidian
	// APIs and never touch the 1.13.0 declarative SettingDefinition* types: the
	// marketplace no-unsupported-api scan rejects any reference to a 1.13.0 API
	// (the types included) while minAppVersion is below 1.13.0. The two paths
	// describe the same settings, so any change here must be mirrored in
	// getSettingDefinitions() below, and vice versa.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderTokenControl(
			this.makeSetting(
				containerEl,
				"Plaud token",
				"Select or create a stored secret holding your Plaud.AI session token. The secret value is stored in Obsidian's per-vault secret storage, never in data.json.",
			),
		);
		this.renderSigninControl(
			this.makeSetting(
				containerEl,
				"Automatic sign-in (beta)",
				"Open Plaud in a window and sign in normally. The plugin captures your session token automatically, so there is no need to copy it from the browser console. Your password is never seen by the plugin. Falls back to manual entry above if your Obsidian build cannot embed a browser.",
			),
		);
		this.renderTestControl(
			this.makeSetting(
				containerEl,
				"Test connection",
				"Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.",
			),
		);
		this.renderRegionControl(
			this.makeSetting(
				containerEl,
				"API region",
				"Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.",
			),
		);

		this.addTextRow(
			containerEl,
			"Output folder",
			"Folder inside your vault where imported notes are written.",
			"outputFolder",
			"Plaud",
		);
		this.addDropdownRow(
			containerEl,
			"Duplicate handling",
			"What to do when a note for the recording already exists in the output folder.",
			"onDuplicate",
			{ skip: "Skip", overwrite: "Overwrite", prompt: "Ask each time" },
		);
		this.addToggleRow(
			containerEl,
			"Show ribbon icon",
			"Display the plaud importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
			"showRibbonIcon",
		);
		this.renderRibbonControl(
			this.makeSetting(
				containerEl,
				"Ribbon icon",
				"Which icon to display in the left rail. Only applies when 'show ribbon icon' is on.",
			),
		);

		new Setting(containerEl).setName("Default artifact selection").setHeading();
		this.addToggleRow(
			containerEl,
			"Transcript",
			"Checked by default in import actions. You can override in 'review artifacts first'.",
			"includeTranscript",
		);
		this.addToggleRow(
			containerEl,
			"Summary",
			"Checked by default in import actions. You can override in 'review artifacts first'.",
			"defaultIncludeSummary",
		);
		this.addToggleRow(
			containerEl,
			"Attachments",
			"Checked by default in import actions when attachments are available.",
			"defaultIncludeAttachments",
		);
		this.addToggleRow(
			containerEl,
			"Mindmap",
			"Checked by default in import actions when a mindmap artifact is available.",
			"defaultIncludeMindmap",
		);
		this.addToggleRow(
			containerEl,
			"Card",
			"Checked by default in import actions when a card artifact is available.",
			"defaultIncludeCard",
		);

		new Setting(containerEl).setName("Tags").setHeading();
		this.addDropdownRow(
			containerEl,
			"Tag mode",
			"Which Plaud tag sources land in the note's tags frontmatter. Plaud tags are the ones you set on a recording in the Plaud app; AI keywords are Plaud's per-recording topic guesses, which can flood the tag pane.",
			"tagMode",
			{
				none: "No tags",
				custom: "Custom tags only",
				plaud: "Plaud tags (no AI keywords)",
				all: "All tags",
			},
		);
		this.addTextRow(
			containerEl,
			"Custom tags",
			"Comma-separated tags added to every imported note, except in 'no tags' mode.",
			"customTags",
			"plaud-meeting",
		);
		this.addToggleRow(
			containerEl,
			"Keep AI keywords as note property",
			"When AI keywords are excluded from tags, write them to a keywords frontmatter property instead. The property is searchable and Dataview-queryable but stays out of the tag pane.",
			"aiKeywordsAsProperty",
		);

		new Setting(containerEl).setName("Import dialog").setHeading();
		this.addToggleRow(
			containerEl,
			"Auto-close summary",
			"Close the import window automatically after a fully successful import. A run with any failure keeps the window open so the errors stay visible. Clicking inside the window cancels the countdown.",
			"autoCloseSummary",
		);
		this.addTextRow(
			containerEl,
			"Auto-close delay",
			"Seconds to wait before the summary closes itself. Only applies when auto-close is on.",
			"autoCloseSummarySeconds",
			"20",
		);

		new Setting(containerEl).setName("Transcript rendering").setHeading();
		this.addToggleRow(
			containerEl,
			"Fold transcript by default",
			"Collapse the transcript section when the note is created so it doesn't dominate the view on open. Uses Obsidian's heading fold state — clicking the chevron next to the heading expands it. Turn off if you prefer the transcript always expanded.",
			"foldTranscript",
		);
		this.addDropdownRow(
			containerEl,
			"Transcript heading level",
			"Markdown heading level for the wrapping 'transcript' heading. Chapter sub-headings render at one level below (e.g. Level 4 → transcript is h4, chapters are h5). This is the heading whose fold state the 'fold transcript by default' toggle controls.",
			"transcriptHeaderLevel",
			{ "1": "H1", "2": "H2", "3": "H3", "4": "H4", "5": "H5", "6": "H6" },
		);

		new Setting(containerEl).setName("Debug").setHeading();
		this.addToggleRow(
			containerEl,
			"Debug logging",
			"Capture raw API requests, responses, and parsed results into an in-memory buffer and mirror them to the developer console (Ctrl+Shift+I). Authentication headers are NEVER captured. Payloads may contain transcript text, speaker names, and recording metadata — only enable when troubleshooting. Use the 'Plaud Importer: Debug: copy debug log to clipboard' command to export the session.",
			"debug",
		);

		this.renderFooter(new Setting(containerEl));
	}

	// Shared control bodies. Each adds the row's control(s) to a Setting whose
	// name/desc the caller has already set, so the declarative render callbacks
	// (1.13+) and the imperative display() fallback (1.12) produce identical UI.
	// These touch only pre-1.12 Obsidian APIs.
	private renderTokenControl(setting: Setting): void {
		setting.addComponent((el) =>
			new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.secretId)
				.onChange(async (id) => {
					this.plugin.settings.secretId = id;
					await this.plugin.saveSettings();
				}),
		);
	}

	private renderSigninControl(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({
			cls: "plaud-importer-signin-status",
		});
		const refreshStatus = (): void => {
			const id = this.plugin.settings.secretId;
			const stored =
				id.length > 0 &&
				(this.app.secretStorage.getSecret(id) ?? "").length > 0;
			statusEl.setText(
				stored
					? "Status: signed in — a token is stored."
					: "Status: not signed in yet.",
			);
			statusEl.toggleClass("plaud-importer-signin-ok", stored);
		};
		setting.addButton((btn) =>
			btn
				.setButtonText("Sign in")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					try {
						const result = await openPlaudLogin(this.app, {
							debugLogger: this.plugin.debugLogger,
						});
						if (result === null) {
							new Notice("Plaud sign-in closed — no token captured.");
							return;
						}
						this.app.secretStorage.setSecret(
							CAPTURED_SECRET_ID,
							result.token,
						);
						this.plugin.settings.secretId = CAPTURED_SECRET_ID;
						if (result.apiBaseUrl !== null) {
							this.plugin.settings.apiBaseUrl = result.apiBaseUrl;
						}
						await this.plugin.saveSettings();
						new Notice("Plaud token captured and saved.");
						refreshStatus();
					} finally {
						btn.setDisabled(false);
					}
				}),
		);
		refreshStatus();
	}

	private renderTestControl(setting: Setting): void {
		const resultEl = setting.descEl.createDiv({
			cls: "plaud-importer-test-status",
		});
		setting.addButton((btn) =>
			btn.setButtonText("Test connection").onClick(async () => {
				btn.setDisabled(true);
				resultEl.setText("Testing…");
				resultEl.toggleClass("plaud-importer-test-ok", false);
				resultEl.toggleClass("plaud-importer-test-err", false);
				try {
					const result = await this.plugin.testPlaudConnection();
					resultEl.setText(result.message);
					resultEl.toggleClass("plaud-importer-test-ok", result.ok);
					resultEl.toggleClass("plaud-importer-test-err", !result.ok);
				} finally {
					btn.setDisabled(false);
				}
			}),
		);
	}

	private renderRegionControl(setting: Setting): void {
		const host = this.plugin.settings.apiBaseUrl;
		const isDefault = host === DEFAULT_SETTINGS.apiBaseUrl;
		const span = setting.controlEl.createSpan({
			cls: "plaud-importer-region-host",
			text: host,
		});
		span.createSpan({
			cls: "plaud-importer-region-note",
			text: isDefault ? " (default)" : " (auto-detected)",
		});
	}

	private renderRibbonControl(setting: Setting): void {
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
	}

	// Builds a Setting with name/desc set. Desc passes as an argument rather
	// than a setDesc() string literal so the sentence-case lint (which would
	// otherwise mangle proper nouns like "Plaud" and "EU") sees the same
	// param-bound form the declarative desc fields already use.
	private makeSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
	): Setting {
		return new Setting(containerEl).setName(name).setDesc(desc);
	}

	// Imperative row helpers used only by display(). Each binds to the plugin's
	// settings through the same applyControlChange() the declarative path uses,
	// so coercion and side effects stay in one place.
	private addToggleRow(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: string,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle.setValue(this.readSettingBool(key)).onChange(async (value) => {
					await this.applyControlChange(key, value);
				}),
			);
	}

	private addTextRow(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: string,
		placeholder: string,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(this.readSettingString(key))
					.onChange(async (value) => {
						await this.applyControlChange(key, value);
					}),
			);
	}

	private addDropdownRow(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: string,
		options: Record<string, string>,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(options)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.readSettingString(key))
					.onChange(async (value) => {
						await this.applyControlChange(key, value);
					});
			});
	}

	// Reads a settings value as a boolean for toggle rows.
	private readSettingBool(key: string): boolean {
		return Boolean(
			(this.plugin.settings as unknown as Record<string, unknown>)[key],
		);
	}

	// Reads a settings value as a display string for text/dropdown rows. Mirrors
	// getControlValue()'s number-to-string handling for the two numeric keys.
	private readSettingString(key: string): string {
		if (key === "transcriptHeaderLevel") {
			return String(this.plugin.settings.transcriptHeaderLevel);
		}
		if (key === "autoCloseSummarySeconds") {
			return String(this.plugin.settings.autoCloseSummarySeconds);
		}
		const value = (this.plugin.settings as unknown as Record<string, unknown>)[
			key
		];
		if (typeof value === "string") {
			return value;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		return "";
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
				render: (setting: Setting) => this.renderTokenControl(setting),
			},
			{
				name: "Automatic sign-in (beta)",
				desc: "Open Plaud in a window and sign in normally. The plugin captures your session token automatically, so there is no need to copy it from the browser console. Your password is never seen by the plugin. Falls back to manual entry above if your Obsidian build cannot embed a browser.",
				searchable: false,
				render: (setting: Setting) => this.renderSigninControl(setting),
			},
			{
				name: "Test connection",
				desc: "Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.",
				searchable: false,
				render: (setting: Setting) => this.renderTestControl(setting),
			},
			{
				name: "API region",
				desc: "Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.",
				// Read-only status, not an input: the value is owned by the
				// client's region auto-detection and persisted via
				// onBaseUrlChanged. Rendered fresh on each settings open, so it
				// always reflects the latest detected host.
				searchable: false,
				render: (setting: Setting) => this.renderRegionControl(setting),
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
				render: (setting: Setting) => this.renderRibbonControl(setting),
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
				heading: "Tags",
				items: [
					{
						name: "Tag mode",
						desc: "Which Plaud tag sources land in the note's tags frontmatter. Plaud tags are the ones you set on a recording in the Plaud app; AI keywords are Plaud's per-recording topic guesses, which can flood the tag pane.",
						control: {
							type: "dropdown",
							key: "tagMode",
							options: {
								none: "No tags",
								custom: "Custom tags only",
								plaud: "Plaud tags (no AI keywords)",
								all: "All tags",
							},
						},
					},
					{
						name: "Custom tags",
						desc: "Comma-separated tags added to every imported note, except in 'no tags' mode.",
						control: { type: "text", key: "customTags", placeholder: "plaud-meeting" },
					},
					{
						name: "Keep AI keywords as note property",
						desc: "When AI keywords are excluded from tags, write them to a keywords frontmatter property instead. The property is searchable and Dataview-queryable but stays out of the tag pane.",
						control: { type: "toggle", key: "aiKeywordsAsProperty" },
					},
				],
			},
			{
				type: "group",
				heading: "Import dialog",
				items: [
					{
						name: "Auto-close summary",
						desc: "Close the import window automatically after a fully successful import. A run with any failure keeps the window open so the errors stay visible. Clicking inside the window cancels the countdown.",
						control: { type: "toggle", key: "autoCloseSummary" },
					},
					{
						name: "Auto-close delay",
						desc: "Seconds to wait before the summary closes itself. Only applies when auto-close is on.",
						control: { type: "text", key: "autoCloseSummarySeconds", placeholder: "20" },
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
		if (key === "autoCloseSummarySeconds") {
			return String(this.plugin.settings.autoCloseSummarySeconds);
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.applyControlChange(key, value);
	}

	// Coerces and persists a single settings change, then runs any side effect.
	// Shared by the declarative setControlValue() (1.13+) and the imperative
	// row helpers in display() (1.12), so neither path can drift on validation.
	private async applyControlChange(key: string, value: unknown): Promise<void> {
		if (key === "outputFolder") {
			this.plugin.settings.outputFolder =
				(typeof value === "string" ? value.trim() : "") || "Plaud";
		} else if (key === "transcriptHeaderLevel") {
			const level = Number(value);
			if (level >= 1 && level <= 6) {
				this.plugin.settings.transcriptHeaderLevel = level as 1 | 2 | 3 | 4 | 5 | 6;
			}
		} else if (key === "autoCloseSummarySeconds") {
			// Text control delivers a string; store a sane integer. Blank or
			// non-numeric input snaps back to the 20s default; out-of-range
			// values clamp to 1..600 so a typo cannot park the modal open
			// for hours or close it instantly.
			const parsed = Number(typeof value === "string" ? value.trim() : value);
			this.plugin.settings.autoCloseSummarySeconds = Number.isFinite(parsed)
				? Math.min(600, Math.max(1, Math.floor(parsed)))
				: 20;
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
