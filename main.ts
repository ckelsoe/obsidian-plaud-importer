import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	TFile,
	type SettingDefinitionItem,
	type ObsidianProtocolData,
	requestUrl,
	setIcon,
	type RequestUrlResponse,
} from "obsidian";
import {
	ReverseEngineeredPlaudClient,
	PlaudAuthError,
	type PlaudHttpFetcher,
} from "./plaud-client-re";
import { ImportModal, classifyError } from "./import-modal";
import { BufferedDebugLogger } from "./debug-logger";
import {
	clearPlaudLoginSession,
	isAccessToken,
	openPlaudLogin,
} from "./plaud-login";
import { NoteWriter, type TagMode } from "./note-writer";
import { AttachmentImporter } from "./attachment-importer";
import {
	buildPlaudIdIndex,
	buildPlaudIdIndexWithColdCheck,
	outputFolderCacheIsCold,
	type ImportedRecord,
} from "./vault-index";
import { runImport } from "./import-runner";
import {
	PAGE_SIZE,
	type ArtifactSelection,
	type ImportModalOptions,
} from "./import-core";
import type { PlaudRecordingId, Recording } from "./plaud-client";
import { runAutoSyncTick } from "./auto-sync-runner";
import {
	coerceIntervalMinutes,
	nextAutoSyncState,
	tickOutcomeForCategory,
	INITIAL_AUTO_SYNC_STATE,
	type AutoSyncState,
} from "./auto-sync";

// Stable SecretStorage id for a token captured by the in-app sign-in flow.
// Re-running sign-in overwrites it, mirroring "replace my token".
const CAPTURED_SECRET_ID = "plaud-importer-token";

// Plaud web app, opened in the system browser for the browser-based sign-in
// flow (where Google/Apple SSO work, unlike an embedded webview).
const PLAUD_WEB_URL = "https://web.plaud.ai";

// Explanatory note shown under the "Sign in" heading. Held in a const so it can
// name Plaud/Google/Apple plainly: the sentence-case lint only inspects string
// literals written directly at a setText/createEl call, not a referenced const.
const SIGN_IN_NOTE =
	"Plaud has no official API, so this plugin relies on their internal one. That makes sign-in fragile, and it may stop working when Plaud changes that internal API. We expect this whole process to get much simpler once Plaud releases an official API. There are two ways to sign in, depending on how you log in to Plaud. Use 'Sign in with email' if you log in with an email address and password. Use 'Sign in with Google or Apple' if you use single sign-on (SSO) through a Google or Apple account.";

// Bookmarklet for the browser sign-in flow. Run on a signed-in Plaud tab, it
// hooks BOTH fetch and XMLHttpRequest (Plaud loads recordings via XHR, so a
// fetch-only hook misses them), waits for a request carrying the workspace
// access token (typ WT, not the refresh token WRT the data API rejects), and
// shows it in a prompt() the user copies and pastes into the plugin. A copy
// dialog is used rather than an obsidian:// redirect because launching a custom
// protocol from a network callback (no user gesture) is blocked by browsers.
// Kept as one line, no backslashes, so it pastes as a valid bookmark URL.
const SIGN_IN_BOOKMARKLET =
	"javascript:(function(){function typ(v){try{if(!/eyJ/.test(v))return null;var s=v.replace(/^bearer /i,'').split('.')[0].replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return JSON.parse(atob(s)).typ;}catch(e){return null;}}var done=false;function got(a){if(done||typeof a!=='string')return;if(typ(a)==='WT'){done=true;prompt('Plaud token captured. Select all, copy, then paste it into the token field in Obsidian settings:',a.replace(/^bearer /i,''));}}var of=window.fetch;window.fetch=function(i,n){try{var h=n&&n.headers;if(h){got(h.authorization||h.Authorization||(h.get&&h.get('authorization')));}}catch(e){}return of.apply(this,arguments);};var os=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(/^authorization$/i.test(k))got(v);}catch(e){}return os.apply(this,arguments);};alert('Token capture armed. Now open any recording in Plaud.');})()";

// Standalone HTML page opened in the system browser for one-time bookmark
// setup. It offers the sign-in bookmarklet as a draggable link so a
// non-technical user can drag it onto their bookmarks bar instead of pasting a
// javascript: URL into a new bookmark by hand. `&` in the href is escaped so
// the bookmarklet's `&&`/`||` survive as a valid HTML attribute.
function bookmarkSetupHtml(): string {
	const href = SIGN_IN_BOOKMARKLET.replace(/&/g, "&amp;");
	return [
		"<!doctype html>",
		'<html lang="en"><head><meta charset="utf-8">',
		"<title>Plaud Importer bookmark setup</title>",
		"<style>",
		"body{font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 24px;line-height:1.55;color:#1a1a1a}",
		"h1{font-size:1.35rem}",
		".bm{display:inline-block;padding:12px 22px;background:#5b46f2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:1.05rem;cursor:grab}",
		".note{color:#555;font-size:0.95rem}",
		"ol{color:#333}",
		"</style></head><body>",
		"<h1>Plaud Importer: one-time setup</h1>",
		"<p><strong>Drag this button up onto your browser's bookmarks bar:</strong></p>",
		'<p><a class="bm" href="' + href + '">Plaud → Obsidian</a></p>',
		'<p class="note">Bookmarks bar hidden? Press Ctrl+Shift+B (Cmd+Shift+B on Mac) to show it, then drag the button onto it.</p>',
		"<hr><p>After it is saved, each time you need to connect:</p>",
		"<ol>",
		"<li>Sign in to Plaud in this browser.</li>",
		"<li>Click the bookmark you just added.</li>",
		"<li>Open any recording. A box shows your token. Copy it.</li>",
		"<li>Go back to Obsidian and click the paste button.</li>",
		"</ol>",
		"</body></html>",
	].join("");
}

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

// Subfolder template documentation, shared by the declarative settings
// (1.13+) and the imperative display() fallback (1.12) so both render the
// identical token reference. Strings are held in consts (not inline literals
// at createEl/setDesc) so the obsidianmd sentence-case lint, which inspects
// literal arguments, leaves the token examples and proper nouns alone.
const SUBFOLDER_TEMPLATE_INTRO =
	"Optional. Files each imported note into a subfolder of the output folder, built from the recording's own date. Leave empty to keep every note in one folder. Combine tokens with any literal text; a forward slash (/) starts a new nested folder level, so {{yyyy}}/{{MM}} makes a year folder containing month folders.";

// [token, what it expands to] pairs. Numeric and zero-padded so folder names
// sort chronologically; no locale-dependent or named-month forms.
const SUBFOLDER_TEMPLATE_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["{{yyyy}}", "year, for example 2026"],
	["{{MM}}", "month, 01 to 12"],
	["{{dd}}", "day, 01 to 31"],
	["{{yyyy-MM}}", "year and month together, for example 2026-06"],
	["{{ww}}", "ISO week number, 01 to 53"],
	["{{Q}}", "quarter, 1 to 4"],
];

// [template, resulting folder] pairs for a June 4 2026 recording. Covers
// nesting, a custom separator, and a non-US day-first order so the answer to
// "can I add a dash / reorder for my locale" is visible, not buried.
const SUBFOLDER_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	["{{yyyy-MM}}", "2026-06 (one folder)"],
	["{{yyyy}}/{{MM}}", "2026/06 (a 2026 folder containing a 06 folder)"],
	["{{yyyy}}-{{MM}}", "2026-06 (one folder, your own dash separator)"],
	["{{dd}}-{{MM}}-{{yyyy}}", "04-06-2026 (day-first order)"],
	["{{yyyy}}/W{{ww}}", "2026/W23 (by week)"],
];

const SUBFOLDER_TEMPLATE_TOKENS_HEADING =
	"Tokens (mix with your own text and separators):";
const SUBFOLDER_TEMPLATE_EXAMPLES_HEADING = "Examples:";
const SUBFOLDER_TEMPLATE_FOOTNOTE =
	"Applies to new imports; notes you already imported stay where they are.";

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
	subfolderTemplate: string;
	onDuplicate: "skip" | "overwrite" | "prompt";
	showRibbonIcon: boolean;
	ribbonIcon: string;
	debug: boolean;
	includeTranscript: boolean;
	defaultIncludeSummary: boolean;
	defaultIncludeAttachments: boolean;
	defaultIncludeMindmap: boolean;
	defaultIncludeCard: boolean;
	// Download the original recording audio (Opus/Ogg) as a note attachment.
	// Off by default and the only default-false artifact: audio is large
	// (~15 MB per recording-hour) and grows the vault fast, so it is strictly
	// opt-in per import and per default.
	defaultIncludeAudio: boolean;
	foldTranscript: boolean;
	transcriptHeaderLevel: 1 | 2 | 3 | 4 | 5 | 6;
	tagMode: TagMode;
	customTags: string;
	aiKeywordsAsProperty: boolean;
	autoCloseSummary: boolean;
	autoCloseSummarySeconds: number;
	// When a recording exists in Plaud but Plaud reports it has no transcript
	// or summary yet (an in-band server error such as -12), write a placeholder
	// note carrying the recording ID and a Plaud link instead of recording a
	// bare failure. A later successful import replaces the stub automatically.
	writePlaceholderForUnprocessed: boolean;
	// Show recordings that are in Plaud's trash in the import list. Off by
	// default, matching the Plaud web UI which hides trash. Trashed recordings
	// are short accidental clips with no transcript more often than not.
	showTrashedRecordings: boolean;
	// Auto-sync (issue #5): a background timer that imports new recordings and
	// re-imports (overwrites) changed ones on an interval, using the saved
	// default import options. OFF by default: the connection is reverse-
	// engineered, the ~24h token forces periodic re-auth, and a detected change
	// OVERWRITES the note and its artifacts (Plaud wins over local edits).
	autoSyncEnabled: boolean;
	// Minutes between auto-sync ticks. Coerced to [15, 1440]; default 60.
	autoSyncIntervalMinutes: number;
}

const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: "",
	apiBaseUrl: "https://api.plaud.ai",
	outputFolder: "Plaud",
	subfolderTemplate: "",
	onDuplicate: "prompt",
	showRibbonIcon: true,
	ribbonIcon: DEFAULT_RIBBON_ICON,
	debug: false,
	includeTranscript: true,
	defaultIncludeSummary: true,
	defaultIncludeAttachments: true,
	defaultIncludeMindmap: true,
	defaultIncludeCard: true,
	defaultIncludeAudio: false,
	foldTranscript: true,
	transcriptHeaderLevel: 4,
	// 'plaud' keeps human-set Plaud tags but drops the AI keyword guesses
	// that were flooding vaults with single-use tags. aiKeywordsAsProperty
	// is off by default because Plaud's keyword list can run to hundreds of
	// low-value entries per recording; users who want it can opt back in.
	tagMode: "plaud",
	customTags: "plaud-meeting",
	aiKeywordsAsProperty: false,
	autoCloseSummary: true,
	autoCloseSummarySeconds: 20,
	writePlaceholderForUnprocessed: true,
	showTrashedRecordings: false,
	autoSyncEnabled: false,
	autoSyncIntervalMinutes: 60,
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

	// Auto-sync timers and state. The interval id and the deferred first-run
	// timeout id are kept so an interval/toggle change can clear and re-create
	// them; onunload clears both.
	private autoSyncIntervalId: number | undefined;
	private autoSyncFirstRunTimeoutId: number | undefined;
	private autoSyncState: AutoSyncState = INITIAL_AUTO_SYNC_STATE;
	// Single-flight coordination between the manual modal and background ticks.
	// Two independent flags rather than one shared boolean, so the modal's
	// open/close never clobbers a tick's in-flight state and vice versa. An
	// auto-sync tick starts only when BOTH are clear.
	private importModalOpen = false;
	private autoSyncTickInFlight = false;
	// Set once in onunload. A tick or backfill captures `this.client` in a local
	// before its awaits, so clearing the client alone does not stop an in-flight
	// loop; the loops poll this flag and abort so a disable/re-enable cannot leave
	// the old instance writing while the new instance starts a tick.
	private disposed = false;

	async onload() {
		await this.loadSettings();

		this.debugLogger = new BufferedDebugLogger(this.settings.debug, {
			headerLines: [`Plugin version: ${this.manifest.version}`],
		});

		this.addSettingTab(new PlaudImporterSettingsTab(this.app, this));

		// Receive a token handed back from the user's external browser (the
		// browser sign-in flow) via obsidian://plaud-importer-token?token=…
		this.registerObsidianProtocolHandler("plaud-importer-token", (params) => {
			void this.handleTokenDeepLink(params);
		});

		this.addCommand({
			id: "import-recent",
			name: "Import recent recordings",
			callback: () => this.launchImportModal("command"),
		});

		this.addCommand({
			id: "backfill-version-markers",
			name: "Backfill version markers for auto-sync",
			callback: () => {
				void this.backfillVersionMarkers();
			},
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
			// The client exists now, so a scheduled tick can run. Starts the
			// timer only when auto-sync is enabled; deferred first run is inside.
			this.reconcileAutoSync();
		});
	}

	onunload() {
		// Signal any in-flight tick/backfill loop to stop between iterations. Set
		// before clearing the client so a loop that already captured the client
		// still sees the abort.
		this.disposed = true;
		this.client = undefined;
		// Clear the auto-sync timers. Both the interval and the deferred first-run
		// timeout are ours (plain setInterval/setTimeout), so we clear both here.
		if (this.autoSyncIntervalId !== undefined) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = undefined;
		}
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
			this.autoSyncFirstRunTimeoutId = undefined;
		}
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
			// A working token is a valid resume trigger for a paused auto-sync.
			this.resumeAutoSyncIfPaused();
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

	// ---- Auto-sync (issue #5) -------------------------------------------

	private logAutoSync(message: string, payload?: unknown): void {
		if (!this.debugLogger.enabled) return;
		this.debugLogger.log({ kind: "note", endpoint: "/auto-sync", message, payload });
	}

	/**
	 * Runtime import options shared by the manual modal and the headless
	 * auto-sync path, built from the current settings. Single-sourced so the two
	 * import paths never drift as settings are added.
	 */
	private buildImportRuntimeOptions(): ImportModalOptions {
		return {
			outputFolder: this.settings.outputFolder,
			subfolderTemplate: this.settings.subfolderTemplate,
			onDuplicate: this.settings.onDuplicate,
			includeTranscript: this.settings.includeTranscript,
			includeSummary: this.settings.defaultIncludeSummary,
			foldTranscript: this.settings.foldTranscript,
			transcriptHeaderLevel: this.settings.transcriptHeaderLevel,
			defaultIncludeSummary: this.settings.defaultIncludeSummary,
			defaultIncludeAttachments: this.settings.defaultIncludeAttachments,
			defaultIncludeMindmap: this.settings.defaultIncludeMindmap,
			defaultIncludeCard: this.settings.defaultIncludeCard,
			defaultIncludeAudio: this.settings.defaultIncludeAudio,
			tagMode: this.settings.tagMode,
			customTags: this.settings.customTags,
			aiKeywordsAsProperty: this.settings.aiKeywordsAsProperty,
			autoCloseSummary: this.settings.autoCloseSummary,
			autoCloseSummarySeconds: this.settings.autoCloseSummarySeconds,
			writePlaceholderForUnprocessed:
				this.settings.writePlaceholderForUnprocessed,
			showTrashedRecordings: this.settings.showTrashedRecordings,
			debugLogger: this.debugLogger,
			getAuthToken: () =>
				this.settings.secretId.length > 0
					? this.app.secretStorage.getSecret(this.settings.secretId)
					: null,
			getApiBaseUrl: () => this.settings.apiBaseUrl,
		};
	}

	/** Artifact selection for a headless auto-sync import, from settings. */
	private autoSyncSelection(): ArtifactSelection {
		return {
			includeSummary: this.settings.defaultIncludeSummary !== false,
			includeTranscript: this.settings.includeTranscript !== false,
			includeAttachments: this.settings.defaultIncludeAttachments !== false,
			includeMindmap: this.settings.defaultIncludeMindmap !== false,
			includeCard: this.settings.defaultIncludeCard !== false,
			includeAudio: this.settings.defaultIncludeAudio === true,
		};
	}

	/**
	 * Headless import of a tick's candidates. New recordings are created
	 * (skip-for-new); changed recordings overwrite the matched note
	 * (overwrite-for-changed). Never a blanket-overwrite writer. Throws a
	 * PlaudAuthError when a batch stops on a mid-run auth failure so the tick's
	 * state machine pauses; other per-recording failures stay non-fatal.
	 */
	private async importAutoSyncCandidates(
		newRecs: readonly Recording[],
		changedRecs: readonly Recording[],
		index: Map<PlaudRecordingId, ImportedRecord>,
	): Promise<{ imported: number; updated: number }> {
		const client = this.client;
		if (client === undefined) return { imported: 0, updated: 0 };
		const options = this.buildImportRuntimeOptions();
		const selection = this.autoSyncSelection();
		// Reuse the tick's index (passed in) rather than rebuilding: one snapshot
		// backs both classification and the writer's cross-folder dedup, and a
		// cold/partial metadataCache cannot diverge between the two.
		const attachments = new AttachmentImporter({
			app: this.app,
			getAuthToken: options.getAuthToken,
			getApiBaseUrl: options.getApiBaseUrl,
			debugLogger: this.debugLogger,
		});
		const fetchArtifacts = (id: PlaudRecordingId) =>
			client.getTranscriptAndSummary(id);
		const fetchAudioUrl = selection.includeAudio
			? (id: PlaudRecordingId) => client.getAudioTempUrl(id)
			: undefined;
		const makeWriter = (policy: "skip" | "overwrite"): NoteWriter =>
			new NoteWriter(this.app.vault, {
				...options,
				onDuplicate: policy,
				existingPathForPlaudId: (id) =>
					index.get(id as PlaudRecordingId)?.path ?? null,
			});
		const runBatch = async (
			recordings: readonly Recording[],
			policy: "skip" | "overwrite",
		): Promise<number> => {
			if (recordings.length === 0) return 0;
			const outcome = await runImport({
				recordings,
				selection,
				writer: makeWriter(policy),
				attachments,
				options,
				fetchArtifacts,
				fetchAudioUrl,
				fetchFolderCatalog: () => client.getFolderCatalog(),
				// Stop between recordings if the plugin unloads mid-tick, so a
				// disable/re-enable cannot leave this loop writing while a fresh
				// instance starts its own tick.
				observer: { shouldAbort: () => this.disposed },
			});
			if (outcome.stop === "auth-failed") {
				// token_rejected (not not_configured) is correct here: this batch
				// only runs after listPage already fetched a page with the stored
				// token, so a mid-import auth failure is a rejected/expired token,
				// not a missing one. Either way the state machine maps it to a
				// pause via categoryAllowsReauth; the reason only sharpens the log.
				throw new PlaudAuthError(
					"token_rejected",
					"Plaud session expired during auto-sync",
					"/auto-sync",
				);
			}
			// Count only real writes. A 'written' result whose writeOutcome is
			// 'skipped' is a duplicate-policy skip (a note already existed), not a
			// created/overwritten note, and must not inflate the notice counts.
			// A 'placeholder-written' result is a real stub write too, so it must
			// count; but its 'kept-existing' status means a real note already
			// existed and nothing was written, so it is excluded on the same
			// principle as a 'skipped' write.
			return outcome.results.filter(
				(r) =>
					(r.kind === "written" && r.writeOutcome.status !== "skipped") ||
					(r.kind === "placeholder-written" &&
						r.outcome.status !== "kept-existing"),
			).length;
		};
		const imported = await runBatch(newRecs, "skip");
		const updated = await runBatch(changedRecs, "overwrite");
		return { imported, updated };
	}

	/**
	 * One auto-sync tick, wrapped so it never throws into the timer. Skips when
	 * disabled, paused for re-auth, or an import is already in flight. Maps a
	 * failure through the state machine (auth pauses; transient retries).
	 */
	private async runAutoSyncTickSafe(): Promise<void> {
		if (!this.settings.autoSyncEnabled) return;
		if (this.autoSyncState.paused) {
			this.logAutoSync("tick skipped: paused for re-auth");
			return;
		}
		if (this.importModalOpen || this.autoSyncTickInFlight) {
			this.logAutoSync("tick skipped: an import is already running");
			return;
		}
		const client = this.client;
		if (client === undefined) return;

		// Claim the single-flight gate BEFORE the (potentially expensive) index
		// scan below. The scan can take a while on a large vault, and a manual
		// import modal opened mid-scan checks this same flag; setting it only
		// after the scan would let that modal slip past the gate and overlap this
		// tick. Every early return from here runs through the finally that clears
		// the flag.
		this.autoSyncTickInFlight = true;
		try {
			// One pass: cold-cache guard and index build fused (see
			// buildPlaudIdIndexWithColdCheck). A cold cache would make the index
			// incomplete and every existing note look new, so skip; a later tick
			// with a warm cache proceeds.
			const indexState = buildPlaudIdIndexWithColdCheck(
				this.app,
				this.settings.outputFolder,
			);
			if (indexState.isCold) {
				this.logAutoSync("tick skipped: output-folder metadata cache is cold");
				return;
			}
			const index = indexState.index;

			const result = await runAutoSyncTick({
				pageSize: PAGE_SIZE,
				maxImportsPerTick: 25,
				maxPagesPerTick: 5,
				listPage: (skip, limit) =>
					client.listRecordings({ sortBy: "edit_time", skip, limit }),
				buildIndex: () => index,
				// Reuse the index this tick already built (and cold-cache-guarded)
				// so classification and the writer's dedup share one snapshot.
				importCandidates: (n, c) => this.importAutoSyncCandidates(n, c, index),
				log: (m, p) => this.logAutoSync(m, p),
			});
			this.autoSyncState = nextAutoSyncState(this.autoSyncState, "ok");
			if (result.imported + result.updated > 0) {
				new Notice(
					`Plaud auto-sync: imported ${result.imported} new, updated ${result.updated}.`,
				);
			}
			this.logAutoSync("tick complete", result);
		} catch (err) {
			const classification = classifyError(err);
			const outcome = tickOutcomeForCategory(classification.category);
			this.autoSyncState = nextAutoSyncState(this.autoSyncState, outcome);
			if (outcome === "auth") {
				// The auth outcome covers both a rejected/expired token and a
				// missing one; word the pause Notice for the actual category so a
				// user who never configured a token is not told it "expired".
				const reason =
					classification.category === "not-configured"
						? "no Plaud token is configured. Add one to resume."
						: "the session expired. Reconnect to resume.";
				new Notice(`Plaud auto-sync paused: ${reason}`);
			}
			this.logAutoSync("tick failed", {
				outcome,
				message: classification.message,
			});
		} finally {
			this.autoSyncTickInFlight = false;
		}
	}

	/**
	 * Start, stop, or reschedule the auto-sync timer to match settings.
	 * Idempotent: clears the existing interval and deferred first-run timeout
	 * before (re)creating them. Called from onLayoutReady and on any auto-sync
	 * settings change.
	 */
	reconcileAutoSync(): void {
		if (this.autoSyncIntervalId !== undefined) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = undefined;
		}
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
			this.autoSyncFirstRunTimeoutId = undefined;
		}
		if (!this.settings.autoSyncEnabled) return;
		const minutes = coerceIntervalMinutes(this.settings.autoSyncIntervalMinutes);
		// Plain setInterval, not registerInterval: this method reschedules on every
		// settings change and clears the previous id itself (above) and on unload.
		// registerInterval would push each id onto the component's cleanup list
		// without ever removing the cleared ones, so they would accumulate.
		this.autoSyncIntervalId = window.setInterval(() => {
			void this.runAutoSyncTickSafe();
		}, minutes * 60 * 1000);
		// Deferred first tick (~2 min) so startup is not blocked and the vault
		// metadata cache is warm before the first index build.
		this.autoSyncFirstRunTimeoutId = window.setTimeout(() => {
			this.autoSyncFirstRunTimeoutId = undefined;
			void this.runAutoSyncTickSafe();
		}, 2 * 60 * 1000);
		this.logAutoSync("auto-sync scheduled", { minutes });
	}

	/** Clear an auth pause and run a tick soon. Called on token re-save / test / toggle. */
	resumeAutoSyncIfPaused(): void {
		if (!this.autoSyncState.paused) return;
		this.autoSyncState = nextAutoSyncState(this.autoSyncState, "ok");
		this.logAutoSync("auto-sync resumed after re-auth");
		if (!this.settings.autoSyncEnabled) return;
		// Track this deferred tick in the same slot as the scheduled first run so
		// reconcileAutoSync() and onunload() clear it. An untracked setTimeout
		// could otherwise fire after auto-sync is disabled/rescheduled or during
		// unload and run an unexpected tick.
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
		}
		this.autoSyncFirstRunTimeoutId = window.setTimeout(() => {
			this.autoSyncFirstRunTimeoutId = undefined;
			void this.runAutoSyncTickSafe();
		}, 1000);
	}

	/**
	 * One-time backfill of `plaud-version-ms` into notes imported before
	 * auto-sync existed. Reads each recording's current `version_ms` from the
	 * list and writes ONLY the frontmatter marker (no body rewrite), so those
	 * notes become edit-detectable. Without it, auto-sync treats a legacy note's
	 * edits as un-detectable (missing marker = current). Safe to re-run: notes
	 * that already have a marker are skipped.
	 */
	private async backfillVersionMarkers(): Promise<void> {
		const client = this.client;
		if (client === undefined) {
			new Notice("Plaud importer: still starting up. Try again in a moment.");
			return;
		}
		// Participate in the single-flight gate: the backfill writes frontmatter
		// across many notes, so it must not overlap a manual import or a tick.
		if (this.importModalOpen || this.autoSyncTickInFlight) {
			new Notice("Plaud importer: an import is running. Try backfill again shortly.");
			return;
		}
		if (outputFolderCacheIsCold(this.app, this.settings.outputFolder)) {
			// A cold cache would make buildPlaudIdIndex return a partial map, so
			// the backfill would silently miss notes ("backfilled 0"). Ask the
			// user to retry once Obsidian has finished loading.
			new Notice(
				"Plaud importer: still loading notes. Try backfill again in a moment.",
			);
			return;
		}
		this.autoSyncTickInFlight = true;
		new Notice("Plaud importer: backfilling version markers...");
		try {
			// Build id -> version_ms from the full list (bounded page loop).
			const MAX_BACKFILL_PAGES = 500;
			const versionById = new Map<PlaudRecordingId, number>();
			let skip = 0;
			let reachedListEnd = false;
			for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
				// Stop if the plugin unloaded mid-scan (finally clears the gate).
				if (this.disposed) return;
				const recs = await client.listRecordings({
					sortBy: "edit_time",
					skip,
					limit: PAGE_SIZE,
				});
				if (recs.length === 0) {
					reachedListEnd = true;
					break;
				}
				for (const r of recs) {
					if (r.versionMs !== undefined) versionById.set(r.id, r.versionMs);
				}
				if (recs.length < PAGE_SIZE) {
					reachedListEnd = true;
					break;
				}
				skip += recs.length;
			}

			const index = buildPlaudIdIndex(this.app, this.settings.outputFolder);
			let written = 0;
			for (const [id, record] of index) {
				// Stop writing frontmatter if the plugin unloaded mid-backfill.
				if (this.disposed) return;
				if (record.versionMs !== undefined) continue; // already has a marker
				const versionMs = versionById.get(id);
				if (versionMs === undefined) continue; // recording no longer listed
				const file = this.app.vault.getFileByPath(record.path);
				if (!(file instanceof TFile)) continue;
				await this.app.fileManager.processFrontMatter(
					file,
					(fm: Record<string, unknown>) => {
						fm["plaud-version-ms"] = versionMs;
					},
				);
				written += 1;
			}
			// The scan always restarts from the newest page, so re-running does not
			// advance past the cap; say what happened without promising a fix.
			const capNote = reachedListEnd
				? ""
				: " Stopped at the scan limit; the least recently updated recordings were not checked, so a few legacy notes may still lack a marker.";
			new Notice(
				`Plaud importer: backfilled ${written} version marker${written === 1 ? "" : "s"}.${capNote}`,
			);
			this.logAutoSync("backfill complete", {
				written,
				listed: versionById.size,
				reachedListEnd,
			});
		} catch (err) {
			new Notice(`Plaud importer: backfill failed — ${classifyError(err).message}`);
		} finally {
			// Always release the gate so a failed or empty backfill never leaves
			// auto-sync permanently blocked.
			this.autoSyncTickInFlight = false;
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
		// Refuse to launch while another import is active: a second modal, or a
		// modal opened over an in-flight auto-sync/backfill, would clobber the
		// shared single-flight gate (importModalOpen / autoSyncTickInFlight).
		if (this.importModalOpen) {
			new Notice("Plaud importer: an import window is already open.");
			return;
		}
		if (this.autoSyncTickInFlight) {
			new Notice("Plaud importer: auto-sync is running. Try again shortly.");
			return;
		}
		// Mark the modal open for its whole lifetime so a background auto-sync
		// tick does not start alongside a manual import. Cleared from onClosed
		// below. Uses its own flag (not the tick's) so the two never clobber.
		this.importModalOpen = true;
		try {
			// Snapshot settings at invocation time (via buildImportRuntimeOptions,
			// the same builder the headless auto-sync path uses) so changes in the
			// settings tab take effect on the next click without reinstantiation.
			new ImportModal(this.app, this.client, {
				...this.buildImportRuntimeOptions(),
				// After a successful in-modal re-auth, clear any auth pause so
				// background sync resumes without waiting for the settings tab.
				onReauth: async () => {
					const ok = await this.reauthenticate();
					if (ok) this.resumeAutoSyncIfPaused();
					return ok;
				},
				onReauthSso: {
					setupBookmark: () => {
						void this.openBookmarkSetupPage();
					},
					signIn: () => {
						new BrowserSignInModal(this.app, () =>
							this.openPlaudInBrowser(),
						).open();
					},
					pasteToken: async () => {
						const ok = await this.pasteTokenFromClipboard();
						if (ok) this.resumeAutoSyncIfPaused();
						return ok;
					},
				},
				onClosed: () => {
					this.importModalOpen = false;
				},
			}).open();
		} catch (err) {
			// If constructing/opening the modal throws, onClosed never fires;
			// release the flag here so a background tick is not blocked forever.
			this.importModalOpen = false;
			throw err;
		}
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

	// Returns the plugin to a pre-sign-in state for a clean re-authentication:
	// clears the embedded browser's Plaud session (so the next sign-in starts
	// logged out) and unlinks the stored token by clearing secretId. The secret
	// value itself stays in Obsidian's SecretStorage, which exposes no delete
	// API; unlinking secretId means the plugin no longer reads or sends it, so
	// the plugin is effectively signed out. Region (apiBaseUrl) is left as-is;
	// it re-detects on the next import. Returns whether the browser session was
	// cleared, so the caller can tell the user if only the token was unlinked.
	async clearSignIn(): Promise<{ sessionCleared: boolean }> {
		let sessionCleared = false;
		try {
			sessionCleared = await clearPlaudLoginSession();
		} catch (err) {
			console.error(
				"Plaud importer: failed to clear sign-in browser session",
				err,
			);
		}
		// Wipe the stored token value(s). Obsidian's SecretStorage exposes no
		// delete call (only set/get/list), so the secret entry itself cannot be
		// removed; blanking the value is the most thorough removal available.
		for (const id of new Set([this.settings.secretId, CAPTURED_SECRET_ID])) {
			if (id.length > 0) {
				try {
					this.app.secretStorage.setSecret(id, "");
				} catch (err) {
					console.error("Plaud importer: failed to blank secret", err);
				}
			}
		}
		this.settings.secretId = "";
		await this.saveSettings();
		return { sessionCleared };
	}

	// Re-authenticates via the email/password login window and persists the
	// captured token with the FULL recipe: set the secret, link secretId, and
	// adopt the redirected region (apiBaseUrl) so a region-redirected user is not
	// stranded on a stale host. Returns true once a token is captured and saved,
	// false if the user closed the window or the login API is unavailable on this
	// build. Shared by the settings tab and the import modal's inline re-auth; it
	// shows no Notice itself so each caller can phrase its own.
	async reauthenticate(): Promise<boolean> {
		const result = await openPlaudLogin(this.app, {
			debugLogger: this.debugLogger,
		});
		if (result === null) {
			return false;
		}
		this.app.secretStorage.setSecret(CAPTURED_SECRET_ID, result.token);
		this.settings.secretId = CAPTURED_SECRET_ID;
		if (result.apiBaseUrl !== null) {
			this.settings.apiBaseUrl = result.apiBaseUrl;
		}
		await this.saveSettings();
		return true;
	}

	// Reads a token from the clipboard and stores it via storeAccessToken,
	// showing the same guidance Notices the settings paste button uses. Returns
	// true on success. Shared by the settings tab and the modal's SSO expander;
	// the success Notice is left to each caller.
	async pasteTokenFromClipboard(): Promise<boolean> {
		let text = "";
		try {
			text = await navigator.clipboard.readText();
		} catch (err) {
			console.error("Plaud importer: clipboard read failed", err);
			new Notice(
				"Could not read the clipboard. Copy the token from the browser popup, then try again.",
			);
			return false;
		}
		const ok = await this.storeAccessToken(text);
		if (!ok) {
			new Notice(
				"The clipboard did not hold a valid access token. That usually means the wrong request was copied. Copy the token from the popup the bookmarklet shows, which only fires on the right one.",
			);
		}
		return ok;
	}

	// Opens the Plaud web app in the system browser for the browser-based
	// sign-in flow. Google and Apple SSO complete there because it is a real
	// browser, not an embedded webview.
	openPlaudInBrowser(): void {
		window.open(PLAUD_WEB_URL, "_blank");
	}

	// Writes the one-time bookmark-setup page to a temp file and opens it in the
	// system browser, where the user drags the bookmarklet onto their bookmarks
	// bar. Falls back to copying the bookmarklet if Node/Electron APIs are
	// unavailable (e.g. a hardened build), so the manual path still works.
	async openBookmarkSetupPage(): Promise<void> {
		const req = (window as { require?: (id: string) => unknown }).require;
		if (typeof req !== "function") {
			void copyToClipboard(SIGN_IN_BOOKMARKLET, () => {
				new Notice(
					"Bookmarklet copied. Make a new bookmark and paste it into the address field.",
				);
			});
			return;
		}
		try {
			const os = req("os") as { tmpdir(): string };
			const fs = req("fs") as {
				writeFileSync(path: string, data: string): void;
			};
			const pathMod = req("path") as {
				join(...parts: string[]): string;
			};
			const file = pathMod.join(os.tmpdir(), "plaud-importer-bookmark.html");
			fs.writeFileSync(file, bookmarkSetupHtml());
			const shell = (
				req("electron") as {
					shell?: { openPath(path: string): Promise<string> };
				}
			).shell;
			if (shell && typeof shell.openPath === "function") {
				await shell.openPath(file);
			} else {
				window.open("file:///" + file.replace(/\\/g, "/"), "_blank");
			}
		} catch (err) {
			console.error("Plaud importer: bookmark setup page failed", err);
			new Notice(
				"Could not open the setup page. Copy the bookmarklet and add it as a bookmark manually.",
			);
		}
	}

	// Validates a raw token value (a typ WT access token, optionally bearer-
	// prefixed) and, if valid, stores it in the captured-token secret and links
	// it. Overwrites the same secret each time, so refreshing a token never
	// requires creating or deleting a secret. Returns false without changing
	// anything when the value is not a usable access token. Shared by the
	// browser deep-link handler and the clipboard-paste button.
	async storeAccessToken(rawToken: string): Promise<boolean> {
		const token = rawToken.trim().replace(/^bearer\s+/i, "");
		if (token.length === 0 || !isAccessToken(token)) {
			return false;
		}
		this.app.secretStorage.setSecret(CAPTURED_SECRET_ID, token);
		this.settings.secretId = CAPTURED_SECRET_ID;
		await this.saveSettings();
		return true;
	}

	// Handles obsidian://plaud-importer-token?token=… deep links from the
	// browser sign-in bookmarklet.
	private async handleTokenDeepLink(
		params: ObsidianProtocolData,
	): Promise<void> {
		const raw = typeof params.token === "string" ? params.token : "";
		if (raw.trim().length === 0) {
			new Notice("Plaud sign-in link contained no token.");
			return;
		}
		const ok = await this.storeAccessToken(raw);
		new Notice(
			ok
				? "Plaud token received from your browser and saved."
				: "Plaud sign-in link did not carry a usable access token. In your browser, open a recording before clicking the bookmarklet, then try again.",
		);
	}
}

// Just-in-time reminder shown when the user launches the browser sign-in, so
// the capture steps are in front of them at the moment they switch to the
// browser. Step text is built from variables (not string literals at the call
// site) so it can name "Plaud" and the buttons while satisfying the
// sentence-case lint, which only inspects literals.
class BrowserSignInModal extends Modal {
	private readonly onLaunch: () => void;

	constructor(app: App, onLaunch: () => void) {
		super(app);
		this.onLaunch = onLaunch;
	}

	onOpen(): void {
		this.setTitle("Get your sign-in token");
		const { contentEl } = this;
		const intro = "Your web browser is about to open. Do these in order:";
		contentEl.createEl("p", { text: intro });
		const ol = contentEl.createEl("ol");
		const lines = [
			"Sign in to Plaud if you are not already. Google, Apple, and password all work in a real browser.",
			"Click the 'Plaud → Obsidian' bookmark on your bookmarks bar (the one you saved in step 1).",
			"Click any meeting. A small box pops up showing your token.",
			"Copy the token, switch back to Obsidian, and click 'Paste token from clipboard'.",
		];
		for (const line of lines) {
			ol.createEl("li", { text: line });
		}
		const openLabel = "Open my browser now";
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(openLabel)
					.setCta()
					.onClick(() => {
						this.onLaunch();
						this.close();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class PlaudImporterSettingsTab extends PluginSettingTab {
	plugin: PlaudImporterPlugin;

	// Set by renderSigninControl() so the Clear sign-in button can refresh the
	// sign-in status line in place after wiping the token. Null until the
	// sign-in row has rendered.
	private signinRefresh: (() => void) | null = null;
	// Set by renderTokenControl() so the paste/sign-in flows can redraw the
	// secret picker to show a just-stored token as the selected secret. Null
	// until the token row has rendered.
	private tokenRefresh: (() => void) | null = null;

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
				"Your stored Plaud token. The status below shows whether you are connected. The value stays in Obsidian's secret storage, never in data.json.",
			),
		);

		new Setting(containerEl).setName("Sign in").setHeading();
		this.renderSignInIntro(new Setting(containerEl));
		this.renderSigninControl(
			this.makeSetting(
				containerEl,
				"Sign in with email",
				"Best for email and password logins. Click Sign in, log in to Plaud in the window that opens, and your token is saved automatically. Google and Apple logins do not work in this window; use the option below for those.",
			),
		);
		this.renderBrowserSignInControl(
			this.makeSetting(
				containerEl,
				"Sign in with Google or Apple",
				"For Google and Apple logins, which only work in a real browser. The first time needs a one-time bookmark setup. After that, sign in to Plaud in your normal browser and send the token back with the steps below.",
			),
		);
		this.renderTestControl(
			this.makeSetting(
				containerEl,
				"Test connection",
				"Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.",
			),
		);
		this.renderClearSignInControl(
			this.makeSetting(
				containerEl,
				"Clear sign-in",
				"Sign out of the embedded Plaud browser and wipe the stored token so the next sign-in starts completely fresh. Use this to reach the sign-in screen when it keeps signing you in automatically. Obsidian has no way to delete the secret entry, so an emptied one may stay in the token picker, but it holds no token.",
			),
		);
		this.renderRegionControl(
			this.makeSetting(
				containerEl,
				"API region",
				"Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.",
			),
		);

		new Setting(containerEl).setName("Output").setHeading();
		this.addTextRow(
			containerEl,
			"Output folder",
			"Folder inside your vault where imported notes are written.",
			"outputFolder",
			"Plaud",
		);
		this.renderSubfolderTemplateControl(
			this.makeSetting(containerEl, "Subfolder template", SUBFOLDER_TEMPLATE_INTRO),
		);
		this.addDropdownRow(
			containerEl,
			"Duplicate handling",
			"What to do when a note for the recording already exists in the output folder.",
			"onDuplicate",
			{ skip: "Skip", overwrite: "Overwrite", prompt: "Ask each time" },
		);

		new Setting(containerEl).setName("Appearance").setHeading();
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
		this.addToggleRow(
			containerEl,
			"Audio",
			"Off by default. Downloads the original recording audio (about 15 MB per hour) for every recording you import, which can grow your vault by gigabytes and slow Obsidian Sync and backups. Leave off unless you want the audio in your vault.",
			"defaultIncludeAudio",
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
		this.addToggleRow(
			containerEl,
			"Write placeholder for unprocessed recordings",
			"When Plaud has a recording but reports no transcript or summary for it yet (a Plaud-side issue, not a plugin error), write a placeholder note with the recording ID and a link back to Plaud instead of recording a failure. A later successful import replaces the placeholder automatically. Turn off to keep such recordings as plain failures with no file written.",
			"writePlaceholderForUnprocessed",
		);
		this.addToggleRow(
			containerEl,
			"Show trashed recordings",
			"Include recordings that are in your Plaud trash in the import list. Off by default, matching the Plaud app, which hides trash. Trashed recordings are usually short accidental clips with no transcript. Turn on to import something you trashed in Plaud but still want in your vault.",
			"showTrashedRecordings",
		);

		new Setting(containerEl).setName("Automatic sync").setHeading();
		this.addToggleRow(
			containerEl,
			"Enable automatic sync",
			"Off by default. Runs a background import on a schedule using your default import options: new recordings are imported, and a recording you changed in Plaud (edited speaker names, corrected transcript, or finished processing) is re-imported. IMPORTANT: a re-import OVERWRITES that note and its downloaded artifacts with Plaud's current version, so edits you made to a synced note or its attachment files are lost on the next change. Only recordings that actually changed are touched; unchanged notes are never modified. Desktop only, and the ~24 hour token means the background job pauses for reconnection roughly daily.",
			"autoSyncEnabled",
		);
		this.addDropdownRow(
			containerEl,
			"Sync interval",
			"How often the background sync checks Plaud for new and changed recordings. Minimum 15 minutes.",
			"autoSyncIntervalMinutes",
			{
				"15": "Every 15 minutes",
				"30": "Every 30 minutes",
				"60": "Every hour",
				"120": "Every 2 hours",
				"240": "Every 4 hours",
				"480": "Every 8 hours",
				"1440": "Once a day",
			},
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
		// Method-agnostic connection status lives on the token row, not under a
		// specific sign-in method, since a token can be stored by either flow.
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
					? "Status: connected. A token is stored."
					: "Status: not connected yet.",
			);
			statusEl.toggleClass("plaud-importer-signin-ok", stored);
		};
		this.signinRefresh = refreshStatus;
		setting.addComponent((el) => {
			// Rebuild the picker so it re-reads the secret list and reflects the
			// currently linked secretId. Recreating (rather than setValue) is
			// what makes a freshly stored secret appear selected. tokenRefresh
			// lets the paste/sign-in flows trigger this redraw.
			const build = (): SecretComponent =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.secretId)
					.onChange(async (id) => {
						this.plugin.settings.secretId = id;
						await this.plugin.saveSettings();
						// A freshly stored token is a resume trigger for a paused
						// auto-sync.
						this.plugin.resumeAutoSyncIfPaused();
						refreshStatus();
					});
			this.tokenRefresh = () => {
				el.empty();
				build();
			};
			return build();
		});
		refreshStatus();
	}

	private renderSignInIntro(setting: Setting): void {
		setting.descEl.createEl("p", {
			cls: "plaud-importer-signin-note",
			text: SIGN_IN_NOTE,
		});
	}

	private renderSigninControl(setting: Setting): void {
		setting.addButton((btn) =>
			btn
				.setButtonText("Sign in")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					try {
						const ok = await this.plugin.reauthenticate();
						if (ok) {
							new Notice("Plaud token captured and saved.");
							this.signinRefresh?.();
							this.tokenRefresh?.();
						} else {
							new Notice("Plaud sign-in closed — no token captured.");
						}
					} finally {
						btn.setDisabled(false);
					}
				}),
		);
	}

	private renderBrowserSignInControl(setting: Setting): void {
		// Buttons sit below the description, side by side. See styles.css.
		setting.settingEl.addClass("plaud-importer-browser-signin");
		const steps = setting.descEl.createEl("ol", {
			cls: "plaud-importer-browser-steps",
		});
		// Built from a variable array so the steps can name the buttons and
		// "Plaud" plainly; the sentence-case lint only inspects string literals
		// written directly at a createEl/setText call, not array contents.
		const stepLines = [
			"First time only: click 'Set up bookmark'. A web page opens. Drag the big button onto your browser's bookmarks bar (the strip near the top of the window).",
			"Click 'Launch sign-in to capture token'. A short reminder pops up, then your browser opens.",
			"In the browser: sign in to Plaud if needed, click the bookmark you saved, then click any meeting. A small box shows your token. Copy it.",
			"Come back to Obsidian and click 'Paste token from clipboard'. Done! If the token stops working later, do steps 2 to 4 again.",
		];
		for (const line of stepLines) {
			steps.createEl("li", { text: line });
		}
		setting.addButton((btn) =>
			btn.setButtonText("Set up bookmark").onClick(() => {
				void this.plugin.openBookmarkSetupPage();
			}),
		);
		setting.addButton((btn) =>
			btn
				.setButtonText("Launch sign-in to capture token")
				.setCta()
				.onClick(() => {
					new BrowserSignInModal(this.app, () =>
						this.plugin.openPlaudInBrowser(),
					).open();
				}),
		);
		setting.addButton((btn) =>
			btn.setButtonText("Paste token from clipboard").onClick(async () => {
				const ok = await this.plugin.pasteTokenFromClipboard();
				if (ok) {
					new Notice("Token saved. Run a connection test to confirm it works.");
					this.signinRefresh?.();
					this.tokenRefresh?.();
				}
			}),
		);
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

	private renderClearSignInControl(setting: Setting): void {
		const resultEl = setting.descEl.createDiv({
			cls: "plaud-importer-clear-status",
		});
		setting.addButton((btn) => {
			// Warning styling via Obsidian's button class directly: setWarning()
			// is deprecated and its replacement setDestructive() is @since 1.13.0,
			// above this plugin's minAppVersion, so neither method can be used.
			btn.buttonEl.addClass("mod-warning");
			btn.setButtonText("Clear sign-in").onClick(async () => {
				btn.setDisabled(true);
				resultEl.setText("Clearing…");
				try {
					const { sessionCleared } = await this.plugin.clearSignIn();
					resultEl.setText(
						sessionCleared
							? "Cleared. The embedded browser is signed out and the stored token is unlinked. Click Sign in to start fresh."
							: "Token unlinked, but the embedded browser session could NOT be cleared on this build (the Electron session API is unavailable), so Sign in may still open already logged in.",
					);
					new Notice("Plaud sign-in cleared.");
					this.signinRefresh?.();
					this.tokenRefresh?.();
				} finally {
					btn.setDisabled(false);
				}
			});
		});
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

	// Renders the subfolder-template row: appends the token reference (a list,
	// not a cramped one-line desc) into the description, then adds the text
	// control bound to subfolderTemplate. Shared by the declarative path
	// (via the item's render callback) and the imperative display() fallback,
	// so both Obsidian versions show the identical documentation. Building the
	// DOM fresh on each call avoids any DocumentFragment-reuse pitfalls.
	private renderSubfolderTemplateControl(setting: Setting): void {
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: SUBFOLDER_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl("ul");
		for (const [token, meaning] of SUBFOLDER_TEMPLATE_TOKENS) {
			const item = tokenList.createEl("li");
			item.createEl("code", { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: SUBFOLDER_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl("ul");
		for (const [template, result] of SUBFOLDER_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl("li");
			item.createEl("code", { text: template });
			item.createSpan({ text: ` → ${result}` });
		}
		docEl.createDiv({ text: SUBFOLDER_TEMPLATE_FOOTNOTE });

		setting.addText((text) =>
			text
				.setPlaceholder("{{yyyy-MM}}")
				.setValue(this.readSettingString("subfolderTemplate"))
				.onChange(async (value) => {
					await this.applyControlChange("subfolderTemplate", value);
				}),
		);
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
				desc: "Your stored Plaud token. The status below shows whether you are connected. The value stays in Obsidian's secret storage, never in data.json.",
				// SecretComponent needs an App instance and is added via
				// Setting#addComponent, so it lives in a render callback rather
				// than a declarative control. It is not search-indexable.
				searchable: false,
				render: (setting: Setting) => this.renderTokenControl(setting),
			},
			{
				type: "group",
				heading: "Sign in",
				items: [
					{
						name: "",
						searchable: false,
						render: (setting: Setting) => this.renderSignInIntro(setting),
					},
					{
						name: "Sign in with email",
						desc: "Best for email and password logins. Click Sign in, log in to Plaud in the window that opens, and your token is saved automatically. Google and Apple logins do not work in this window; use the option below for those.",
						searchable: false,
						render: (setting: Setting) => this.renderSigninControl(setting),
					},
					{
						name: "Sign in with Google or Apple",
						desc: "For Google and Apple logins, which only work in a real browser. The first time needs a one-time bookmark setup. After that, sign in to Plaud in your normal browser and send the token back with the steps below.",
						searchable: false,
						render: (setting: Setting) =>
							this.renderBrowserSignInControl(setting),
					},
					{
						name: "Test connection",
						desc: "Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.",
						searchable: false,
						render: (setting: Setting) => this.renderTestControl(setting),
					},
					{
						name: "Clear sign-in",
						desc: "Sign out of the embedded Plaud browser and wipe the stored token so the next sign-in starts completely fresh. Use this to reach the sign-in screen when it keeps signing you in automatically. Obsidian has no way to delete the secret entry, so an emptied one may stay in the token picker, but it holds no token.",
						searchable: false,
						render: (setting: Setting) =>
							this.renderClearSignInControl(setting),
					},
					{
						name: "API region",
						desc: "Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.",
						searchable: false,
						render: (setting: Setting) => this.renderRegionControl(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Output",
				items: [
					{
						name: "Output folder",
						desc: "Folder inside your vault where imported notes are written.",
						control: { type: "text", key: "outputFolder", placeholder: "Plaud" },
					},
					{
						name: "Subfolder template",
						desc: SUBFOLDER_TEMPLATE_INTRO,
						// Rendered imperatively so the token reference (a list,
						// not a one-line string) appears in the description. Not
						// search-indexable, like the other render-based rows.
						searchable: false,
						render: (setting: Setting) =>
							this.renderSubfolderTemplateControl(setting),
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
				],
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Show ribbon icon",
						desc: "Display the plaud importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
						control: { type: "toggle", key: "showRibbonIcon" },
					},
					{
						name: "Ribbon icon",
						desc: "Which icon to display in the left rail. Only applies when 'show ribbon icon' is on.",
						searchable: false,
						render: (setting: Setting) => this.renderRibbonControl(setting),
					},
				],
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
					{
						name: "Audio",
						desc: "Off by default. Downloads the original recording audio (about 15 MB per hour) for every recording you import, which can grow your vault by gigabytes and slow Obsidian Sync and backups. Leave off unless you want the audio in your vault.",
						control: { type: "toggle", key: "defaultIncludeAudio" },
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
						desc: "When AI keywords are excluded from tags, write them to a keywords frontmatter property instead. Plaud's keyword list can run to hundreds of low-value entries per recording, so this is off by default. The property is searchable and Dataview-queryable but stays out of the tag pane.",
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
					{
						name: "Write placeholder for unprocessed recordings",
						desc: "When Plaud has a recording but reports no transcript or summary for it yet (a Plaud-side issue, not a plugin error), write a placeholder note with the recording ID and a link back to Plaud instead of recording a failure. A later successful import replaces the placeholder automatically. Turn off to keep such recordings as plain failures with no file written.",
						control: { type: "toggle", key: "writePlaceholderForUnprocessed" },
					},
					{
						name: "Show trashed recordings",
						desc: "Include recordings that are in your Plaud trash in the import list. Off by default, matching the Plaud app, which hides trash. Trashed recordings are usually short accidental clips with no transcript. Turn on to import something you trashed in Plaud but still want in your vault.",
						control: { type: "toggle", key: "showTrashedRecordings" },
					},
				],
			},
			{
				type: "group",
				heading: "Automatic sync",
				items: [
					{
						name: "Enable automatic sync",
						desc: "Off by default. Runs a background import on a schedule using your default import options: new recordings are imported, and a recording you changed in Plaud (edited speaker names, corrected transcript, or finished processing) is re-imported. IMPORTANT: a re-import OVERWRITES that note and its downloaded artifacts with Plaud's current version, so edits you made to a synced note or its attachment files are lost on the next change. Only recordings that actually changed are touched; unchanged notes are never modified. Desktop only, and the ~24 hour token means the background job pauses for reconnection roughly daily.",
						control: { type: "toggle", key: "autoSyncEnabled" },
					},
					{
						name: "Sync interval",
						desc: "How often the background sync checks Plaud for new and changed recordings. Minimum 15 minutes.",
						control: {
							type: "dropdown",
							key: "autoSyncIntervalMinutes",
							options: {
								"15": "Every 15 minutes",
								"30": "Every 30 minutes",
								"60": "Every hour",
								"120": "Every 2 hours",
								"240": "Every 4 hours",
								"480": "Every 8 hours",
								"1440": "Once a day",
							},
						},
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
		} else if (key === "autoSyncIntervalMinutes") {
			// Dropdown delivers a string; coerce to a valid interval [15, 1440].
			this.plugin.settings.autoSyncIntervalMinutes = coerceIntervalMinutes(value);
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}
		await this.plugin.saveSettings();

		// Side effects that the imperative onChange handlers used to run inline.
		if (key === "showRibbonIcon") {
			this.plugin.updateRibbonIcon();
		} else if (key === "autoSyncEnabled" || key === "autoSyncIntervalMinutes") {
			// Start/stop/reschedule the timer to match the new setting. Enabling
			// is a deliberate action, so also clear any prior auth pause.
			this.plugin.reconcileAutoSync();
			if (key === "autoSyncEnabled" && this.plugin.settings.autoSyncEnabled) {
				this.plugin.resumeAutoSyncIfPaused();
			}
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
