import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	type TextComponent,
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
	openPlaudLogin,
} from "./plaud-login";
import {
	describeTokenLifetime,
	formatSessionStatus,
	isUsableUserToken,
	readTokenLifetime,
	SHORT_LIFETIME_HOURS,
} from "./plaud-token";
import {
	NoteWriter,
	DEFAULT_NOTE_NAME_TEMPLATE,
	isValidNoteNameTemplate,
	migrateLegacyDateTemplate,
	renameRecordingNote,
	resolveSubfolder,
	buildNoteName,
	formatDatetime,
	isValidReplacementChar,
	TEMPLATE_PREVIEW_DATE,
	TEMPLATE_PREVIEW_DATETIME,
	TEMPLATE_PREVIEW_TITLE,
	TEMPLATE_PREVIEW_FOLDER,
	renderCustomFrontmatterPreview,
	sanitizeFilename,
	type RenameFileFn,
	type TagMode,
	type CustomFrontmatterRow,
} from "./note-writer";
import {
	AttachmentImporter,
	// DEPRECATED one-time #52 migration; remove with the repair command below.
	isLocalCardImage,
	repairLegacyCardEmbeds,
} from "./attachment-importer";
import {
	buildPlaudIdIndex,
	buildPlaudIdIndexWithColdCheck,
	outputFolderCacheIsCold,
	type ImportedRecord,
} from "./vault-index";
import { runImport } from "./import-runner";
import {
	PAGE_SIZE,
	categoryAllowsReauth,
	type ArtifactSelection,
	type ImportModalOptions,
	type ImportViewStatePatch,
} from "./import-core";
import type { PlaudClient, PlaudRecordingId, Recording } from "./plaud-client";
import { runAutoSyncTick } from "./auto-sync-runner";
import {
	coerceIntervalMinutes,
	nextAutoSyncState,
	tickOutcomeForCategory,
	INITIAL_AUTO_SYNC_STATE,
	type AutoSyncState,
} from "./auto-sync";
import {
	preferWindowForReconnect,
	type SignInMethod,
} from "./reconnect-routing";

// Stable SecretStorage id for a token captured by the in-app sign-in flow.
// Re-running sign-in overwrites it, mirroring "replace my token".
const CAPTURED_SECRET_ID = "plaud-importer-token";

// Legacy secret id for the paired refresh token (typ WRT) that pre-0.32.0
// email sign-ins stored. The refresh subsystem is gone; the secret is only
// ever blanked (sign-out, fresh captures) and read once as the migration
// signal for routing Reconnect (a stored WRT means an email-window session).
const LEGACY_REFRESH_SECRET_ID = "plaud-importer-refresh-token";

// Plaud web app, opened in the system browser for the browser-based sign-in
// flow (where Google/Apple SSO work, unlike an embedded webview).
const PLAUD_WEB_URL = "https://web.plaud.ai";

// Explanatory note shown under the "Sign in" heading. Held in a const so it can
// name Plaud/Google/Apple plainly: the sentence-case lint only inspects string
// literals written directly at a setText/createEl call, not a referenced const.
// Deep-link result notices. Held in consts because the strings are shown from
// two code paths (during a browser reconnect and standalone) and must stay
// identical; built as variables so the sentence-case lint, which only inspects
// literals at the call site, accepts the product name mid-sentence.
const DEEP_LINK_SAVED_NOTICE =
	"Plaud token received from your browser and saved.";
const DEEP_LINK_BAD_TOKEN_NOTICE =
	"Plaud sign-in link did not carry a usable token. In your browser, sign in to Plaud before clicking the bookmarklet, then try again.";

const SIGN_IN_NOTE =
	"Plaud has no official API, so this plugin relies on their internal one. That makes sign-in fragile, and it may stop working when Plaud changes that internal API. We expect this whole process to get much simpler once Plaud releases an official API. There are two ways to sign in, depending on how you log in to Plaud. Use 'Sign in with email' if you log in with an email address and password. Use 'Sign in with Google or Apple' if you use single sign-on (SSO) through a Google or Apple account. How long a session lasts is set by Plaud and varies by account: most accounts get a long session (months to about a year), but some get as little as 24 hours. The status line under Plaud token shows yours. When the session lapses the plugin shows a one-click Reconnect that reopens the sign-in matching your account.";

// Automatic-sync toggle description. ONE constant consumed by both settings
// paths (the 1.13+ declarative definitions and the 1.12 imperative display()
// fallback) so the two can never drift; before this hoist they shipped as two
// byte-identical 731-character literals. Wording (issue #78): session length
// is set by Plaud and varies by account, so this promises no specific
// lifetime.
const AUTO_SYNC_DESC =
	"Off by default. Runs a background import on a schedule, unattended and never prompting. It uses your default import options: new recordings are imported, and a recording you changed in Plaud (edited speaker names, corrected transcript, or finished processing) is re-imported. IMPORTANT: a re-import OVERWRITES that note and its downloaded artifacts with Plaud's current version, so edits you made to a synced note or its attachment files are lost on the next change. Only recordings that actually changed are touched; unchanged notes are never modified. Desktop only. The background sync runs between sign-ins for as long as your Plaud session lasts (set by Plaud and shown in the status line under Plaud token), pausing for a one-click reconnection when the session expires.";

// Bookmarklet for the browser sign-in flow. Run on a signed-in Plaud tab, it
// reads the long-lived user token straight out of the web app's localStorage
// (`token` key) and shows it in a prompt() the user copies and pastes into the
// plugin. No request sniffing: the token is already in localStorage once the
// user is signed in, so there is nothing to arm or wait for. The plugin
// validates the pasted value (capture guard: payload must carry exp and
// client_id), so this only needs to surface the raw stored string with any
// leading `bearer ` prefix stripped. A copy dialog is used rather than an
// obsidian:// redirect because launching a custom protocol without a user
// gesture is blocked by browsers. Kept as one line, no backslashes, so it
// pastes as a valid bookmark URL.
const SIGN_IN_BOOKMARKLET =
	"javascript:(function(){try{var h=location.hostname.toLowerCase();if(h!=='plaud.ai'&&h.slice(-9)!=='.plaud.ai'){alert('Open this on a Plaud tab (web.plaud.ai) after signing in, then click the bookmark.');return;}var t=localStorage.getItem('token');if(!t){alert('No Plaud token found on this page. Make sure you are signed in to Plaud in this tab, then click the bookmark again.');return;}t=t.replace(/^bearer /i,'');prompt('Plaud token captured. Select all, copy, then paste it into the token field in Obsidian settings:',t);}catch(e){alert('Could not read the Plaud token: '+e);}})()";

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
		"<li>Click the bookmark you just added. A box shows your token. Copy it.</li>",
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
	{ id: "cassette-tape", label: "Cassette tape" },
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
	"Optional. Files each imported note into a subfolder of the output folder, built from the recording's own date. Leave empty to keep every note in one folder. Text inside {{ }} is a date format written in Moment style (the same syntax core Daily Notes uses); text outside the braces is kept as-is, and a forward slash (/) starts a new nested folder level, so {{YYYY}}/{{MM}} makes a year folder holding month folders. Separators like dashes and spaces are fine inside the braces; keep your own words (plain letters) outside them, since letters inside are read as date tokens. You can also use {{title}}, the recording title (with a leading date removed, the same as in the note name), to build folder-note layouts like {{YYYY}}/{{title}}. A slash inside a title is turned into your forbidden-character replacement so the title stays a single folder. {{plaud-folder}} is the recording's Plaud folder name, so {{plaud-folder}}/{{YYYY}} mirrors your Plaud folders into the vault; a recording with no Plaud folder files under _unfiled.";

// [token, what it expands to] pairs. Real Moment format tokens (case matters).
// The date and {{title}} tokens also work in the note-name field, so a user
// learns them once; {{plaud-folder}} is subfolder-only (a folder name in a
// per-note file name is surprising).
const SUBFOLDER_TEMPLATE_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY}}", "year, for example 2026"],
	["{{MM}}", "month, 01 to 12"],
	["{{MMMM}}", "month name, for example June"],
	["{{DD}}", "day, 01 to 31"],
	["{{dddd}}", "weekday name, for example Monday"],
	["{{WW}}", "ISO week number, 01 to 53"],
	["{{Q}}", "quarter, 1 to 4"],
	["{{title}}", "the recording title, with a leading numeric date removed (for folder-note layouts)"],
	["{{plaud-folder}}", "the recording's Plaud folder name (or _unfiled when it has none)"],
];

// [template, resulting folder] pairs for a June 4 2026 recording titled Team
// sync. Covers nesting, a custom separator, a day-first order, week foldering,
// two tokens inside one {{ }}, and a folder-note title layout. Outputs verified
// against Moment 2.29.
const SUBFOLDER_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY-MM}}", "2026-06 (one folder)"],
	["{{YYYY}}/{{MM}}", "2026/06 (a 2026 folder holding a 06 folder)"],
	["{{DD}}-{{MM}}-{{YYYY}}", "04-06-2026 (day-first order)"],
	["{{YYYY}}/W{{WW}}", "2026/W23 (by week)"],
	["{{YYYY}}/{{MM MMMM}}", "2026/06 June (two tokens in one {{ }})"],
	["{{YYYY}}/{{title}}", "2026/Team sync (a folder per recording)"],
	["{{plaud-folder}}/{{YYYY}}", "Meetings/2026 (mirror the Plaud folder)"],
];

const SUBFOLDER_TEMPLATE_TOKENS_HEADING =
	"Tokens (case matters; combine them with separators inside the braces):";
const SUBFOLDER_TEMPLATE_EXAMPLES_HEADING = "Examples:";
const SUBFOLDER_TEMPLATE_FOOTNOTE =
	"Applies to new imports; notes you already imported stay where they are.";

// Note-name template documentation, shared by the declarative settings (1.13+)
// and the imperative display() fallback (1.12). Held in consts (not inline
// literals at createEl/setDesc) for the same reason as the subfolder strings
// above: the sentence-case lint inspects literal arguments, so the token
// examples and proper nouns stay untouched.
const NOTE_NAME_TEMPLATE_INTRO =
	"Sets each note's name from a template, using the same {{ }} Moment date formats as the subfolder setting plus a {{title}} token. The recording's date fills the date tokens, and {{title}} is the recording title with a leading numeric date removed (the MM-DD and YYYY-MM-DD style forms Plaud uses), so the recording's date takes the place of the one Plaud put in the title. Put the date wherever you like, before or after {{title}}, and keep your own words outside the braces. The date property inside the note stays YYYY-MM-DD for Dataview. The whole name has to work as a note file name, so a template that would put a character a file name cannot contain (a slash, colon, square bracket, asterisk, question mark, angle bracket, pipe, or double quote) into it is rejected.";

// [token, what it expands to] pairs for a July 3 2026 recording. Real Moment
// tokens (case matters), the same set the subfolder field uses plus {{title}}.
const NOTE_NAME_TEMPLATE_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY}}", "year, for example 2026"],
	["{{YY}}", "2-digit year, for example 26"],
	["{{MMMM}}", "month name, for example July"],
	["{{MMM}}", "short month, for example Jul"],
	["{{MM}}", "month, 01 to 12"],
	["{{M}}", "month, 1 to 12"],
	["{{DD}}", "day, 01 to 31"],
	["{{D}}", "day, 1 to 31"],
	["{{dddd}}", "weekday name, for example Friday"],
	["{{WW}}", "ISO week number, 01 to 53"],
	["{{Q}}", "quarter, 1 to 4"],
	["{{title}}", "the recording title, with a leading numeric date (MM-DD, YYYY-MM-DD, and similar) removed"],
];

// [template, resulting name] pairs for a July 3 2026 recording titled Team sync.
// Covers date-first, date-last, a combined date in one {{ }}, and US order.
// Outputs verified against Moment 2.29.
const NOTE_NAME_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY}}-{{MM}}-{{DD}} {{title}}", "2026-07-03 Team sync"],
	["{{title}} {{YYYY}}-{{MM}}-{{DD}}", "Team sync 2026-07-03 (date at the end)"],
	["{{MMM D, YYYY}} - {{title}}", "Jul 3, 2026 - Team sync (one combined date token)"],
	["{{MM}}-{{DD}}-{{YYYY}} {{title}}", "07-03-2026 Team sync (US order)"],
];

const NOTE_NAME_TEMPLATE_TOKENS_HEADING =
	"Tokens (case matters; combine them with separators inside the braces):";
const NOTE_NAME_TEMPLATE_EXAMPLES_HEADING = "Examples:";
const NOTE_NAME_TEMPLATE_FOOTNOTE =
	"Applies to new imports; notes you already imported keep their current names.";

// Description for the forbidden-character replacement setting. Held in a const so
// the declarative (1.13+) and imperative (1.12) settings paths show identical
// text and the sentence-case lint inspects one literal.
const FORBIDDEN_CHAR_REPLACEMENT_DESC =
	"Character that replaces a slash, colon, or other character a file name or folder cannot contain, for example one that appears in a recording title. Must be a single character; the default is a dash.";

// Name and description for the duplicate-handling dropdown. Held in consts so
// the declarative (1.13+) and imperative (1.12) settings paths show identical
// text and cannot drift, and the sentence-case lint inspects one literal. The
// wording scopes the setting to manual imports: background auto-sync runs
// headless with skip-for-new / overwrite-for-changed and never prompts, so
// 'Ask each time' has no dialog to answer during a sync tick (issue #43).
// Description for the preserve-unknown-frontmatter toggle (#58). Held in a const
// so the declarative (1.13+) and imperative (1.12) settings paths show identical
// text and the sentence-case lint inspects one literal.
const PRESERVE_UNKNOWN_FRONTMATTER_DESC =
	"On by default. When a re-import overwrites a note, keep any frontmatter property you added yourself, or that another tool wrote, that the plugin does not manage. Leave this on so downstream automation and hand-added properties survive a re-import. To let the plugin manage and refresh a specific property instead, add it as an extra frontmatter row with preserve turned off.";

const DUPLICATE_HANDLING_NAME = "Duplicate handling for manual imports";
const DUPLICATE_HANDLING_DESC =
	"Controls what happens when you run Import recent recordings and a note for the recording already exists. Skip keeps your copy, overwrite replaces it, and ask each time prompts you for each one. Automatic sync ignores this and never prompts.";

// [label, template] preset buttons. All dashes, so every preset is filename-safe.
// ISO/US/EU cover the common date orders; putting the date after {{title}} (the
// "date at the end" example in the reference) is left to the user to type.
const NOTE_NAME_TEMPLATE_PRESETS: ReadonlyArray<readonly [string, string]> = [
	["ISO", "{{YYYY}}-{{MM}}-{{DD}} {{title}}"],
	["US", "{{MM}}-{{DD}}-{{YYYY}} {{title}}"],
	["EU", "{{DD}}-{{MM}}-{{YYYY}} {{title}}"],
];

// [label, inserted token] for the insert-token buttons above each template
// field. Labels are friendly names; clicking inserts the exact Moment token at
// the cursor so the common path is typo-proof (bare letters typed by hand would
// be read as tokens). Both the note-name and subfolder fields add Title; the
// subfolder uses it for folder-note layouts, flattening any slash in the title.
const DATE_INSERT_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["Year", "{{YYYY}}"],
	["Month #", "{{MM}}"],
	["Month name", "{{MMMM}}"],
	["Day", "{{DD}}"],
	["Weekday", "{{dddd}}"],
	["Quarter", "{{Q}}"],
	["Week", "{{WW}}"],
	// Time tokens (issue #32). Available in every template field so a user can
	// compose a time however they like; most useful in the datetime frontmatter
	// field. Offset ({{Z}}) records the UTC offset so an ISO value is unambiguous.
	["Hour", "{{HH}}"],
	["Minute", "{{mm}}"],
	["Second", "{{ss}}"],
	["AM/PM", "{{A}}"],
	["Offset", "{{Z}}"],
];
const TITLE_INSERT_TOKEN: readonly [string, string] = ["Title", "{{title}}"];
// Subfolder-only: the recording's Plaud folder name, for mirroring Plaud folders
// into the vault tree. Not offered on the note-name field (a folder name in a
// per-note file name is surprising).
const FOLDER_INSERT_TOKEN: readonly [string, string] = ["Folder", "{{plaud-folder}}"];

// Content tokens available only in the extra-frontmatter value field. They
// surface recording/summary data the plugin already parses; they are not offered
// on the note-name or subfolder fields, where a nullable value has no place in a
// path. The summary-derived ones are empty on a recording with no AI summary.
const CONTENT_INSERT_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["Duration", "{{duration}}"],
	["Category", "{{category}}"],
	["Industry", "{{industry}}"],
	["Headline", "{{headline}}"],
	["Language", "{{language}}"],
	["Summary template", "{{template}}"],
	["Model", "{{model}}"],
];

// Extra-frontmatter documentation. Each row is a property; its value takes the
// same {{ }} tokens as the other fields plus the content tokens above. Held in
// consts so the sentence-case lint inspects the literal and leaves the token
// examples alone.
const CUSTOM_FRONTMATTER_INTRO =
	"Adds your own properties to each imported note's frontmatter. Each row is one property: a name, a value, and whether to preserve it. A value can be plain text or use the same {{ }} tokens as the other fields (the date set, {{title}}, {{plaud-folder}}) plus content tokens like {{category}} and {{duration}}. Leave a value empty to write the property with no value. Turn on preserve for a property you edit by hand (a status, a project) so a re-import keeps your value; leave it off for a value that should refresh from the recording each time.";

const CUSTOM_FRONTMATTER_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["{{title}}", "the recording title"],
	["{{plaud-folder}}", "the recording's Plaud folder name"],
	["{{duration}}", "the recording length, for example 30m"],
	["{{category}}", "the summary's category (empty with no AI summary)"],
	["{{industry}}", "the summary's industry or topic (empty with no AI summary)"],
	["{{headline}}", "the summary's one-line headline"],
	["{{YYYY}} {{MM}} {{DD}} {{Q}} {{WW}}", "the date set, same as the other fields"],
];

const CUSTOM_FRONTMATTER_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	["status: unprocessed", "a fixed value you triage later (preserve on)"],
	["quarter: Q{{Q}}-{{YYYY}}", "writes quarter: Q3-2026 for a July recording"],
	["type: {{category}}", "the recording's own category under your key name"],
	["project:", "writes project: with no value, to fill in by hand"],
];

const CUSTOM_FRONTMATTER_TOKENS_HEADING =
	"Tokens (same {{ }} syntax as the other fields, plus content tokens):";
const CUSTOM_FRONTMATTER_EXAMPLES_HEADING = "Examples:";
const CUSTOM_FRONTMATTER_FOOTNOTE =
	"Applies to new imports. On a re-import, a preserved property keeps the note's current value; an unpreserved one is rewritten. A name that matches one of the plugin's own fields (like date, source, or plaud-id) is reserved and left to the plugin, so an extra property can only add a field, never override one.";

// Datetime-template documentation for the `datetime:` frontmatter field (issue
// #32). Mirrors the subfolder field's Moment-only shape (no {{title}}, no
// presets) but leads with the time tokens, which are the reason this field
// exists. Held in consts, like the other template strings, so the sentence-case
// lint inspects the literal arguments and leaves the token examples untouched.
const DATETIME_TEMPLATE_INTRO =
	"Adds a datetime property to each note's frontmatter, formatted with the same {{ }} Moment tokens as the other fields. Leave it empty to write no datetime property. The date property stays YYYY-MM-DD for Dataview; this separate field lets you record the recording time in any format. The value is your computer's local time, so include {{Z}} to capture the UTC offset if you want the instant to stay unambiguous across devices and time zones.";

const DATETIME_TEMPLATE_TOKENS: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY}}-{{MM}}-{{DD}}", "the date, for example 2026-07-05"],
	["{{HH}}", "hour, 00 to 23"],
	["{{mm}}", "minute, 00 to 59"],
	["{{ss}}", "second, 00 to 59"],
	["{{h}}", "hour, 1 to 12"],
	["{{A}}", "AM or PM"],
	["{{Z}}", "UTC offset, for example +02:00"],
];

// [template, resulting value] pairs for the sample datetime 2026-07-05 14:30:00.
// The ISO example's offset depends on the user's own time zone; the live preview
// shows their real value, so the doc labels it rather than committing to one.
const DATETIME_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	["{{YYYY-MM-DD HH:mm}}", "2026-07-05 14:30 (24-hour)"],
	["{{YYYY-MM-DD h:mm A}}", "2026-07-05 2:30 PM (12-hour)"],
	["{{YYYY-MM-DDTHH:mm:ssZ}}", "2026-07-05T14:30:00±hh:mm, your local UTC offset (ISO 8601)"],
];

const DATETIME_TEMPLATE_TOKENS_HEADING =
	"Tokens (case matters; combine them with separators inside the braces):";
const DATETIME_TEMPLATE_EXAMPLES_HEADING = "Examples:";
const DATETIME_TEMPLATE_FOOTNOTE =
	"Applies to new imports; notes you already imported keep their current frontmatter.";

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
	// {{...}} Moment template for each note's name (same syntax as
	// subfolderTemplate, plus {{title}}). Default "{{YYYY}}-{{MM}}-{{DD}} {{title}}"
	// reproduces the historical naming. Validated filename-safe before it is saved.
	noteNameTemplate: string;
	// {{...}} Moment template for a `datetime:` frontmatter property (issue #32).
	// Empty (the default) emits no property. Separate from the `date:` field, which
	// stays YYYY-MM-DD for Dataview, so the user can add the recording time in any
	// format (24h, 12h, ISO 8601) without disturbing existing date queries.
	datetimeTemplate: string;
	// User-defined extra frontmatter properties (see CustomFrontmatterRow). Each
	// row's value may use {{ }} tokens; preserve keeps the note's existing value on
	// re-import. Empty (the default) writes no extra properties.
	customFrontmatter: CustomFrontmatterRow[];
	// When on, a re-import keeps any frontmatter property the user (or their
	// downstream automation) added that the plugin does not manage and that is not
	// a declared Extra frontmatter row, instead of dropping it on overwrite (#58).
	// Default on: silently losing user-written properties is the worse failure. To
	// let the plugin manage a specific property instead, declare it as an Extra
	// frontmatter row with preserve off.
	preserveUnknownFrontmatter: boolean;
	// Single character that replaces a forbidden filename/folder character (the
	// Windows-forbidden set, control codes, and brackets in a note name), and the
	// path separators inside a {{title}} folder token. Default "-". Validated to a
	// safe single char before saving (see isValidReplacementChar).
	forbiddenCharReplacement: string;
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
	// Import-dialog view preference: hide recordings already imported AND
	// unchanged since import. New and changed (update-available) recordings
	// always show. Defaults on (issue #54: a "Skip" duplicate policy led users
	// to expect processed recordings to drop out of the list). Toggled from the
	// dialog filter bar, NOT the settings tab, so it stays out of the
	// imperative/declarative settings twin edit.
	hideProcessedRecordings: boolean;
	// Import-dialog view preference: hide imported recordings that CHANGED in
	// Plaud since import (an update is available). Defaults OFF: an update is
	// actionable (re-import overwrites the note), so those rows show unless the
	// user opts to collapse them too. Dialog-only.
	hideUpdatesRecordings: boolean;
	// Import-dialog view preference: hide recordings the user has ignored. Also
	// dialog-only, defaults on.
	hideIgnoredRecordings: boolean;
	// Plaud recording ids the user has permanently ignored (junk/personal
	// clips). Ignored recordings are dropped from the dialog list (when
	// hideIgnoredRecordings) and never pulled by auto-sync. Plugin state, not a
	// note tag: it must cover recordings that were never imported, so no note
	// exists to carry a marker. Keyed by the stable plaud-id.
	ignoredRecordingIds: string[];
	// Title write-back: when on, renaming an imported recording (via the Rename
	// recording command or a file-explorer rename) also updates that recording's
	// title in Plaud to match the new note name. OFF by default because it is the
	// only change the plugin writes back to Plaud. When off, the Rename command
	// asks each time whether to push, and a file-explorer rename stays local.
	autoUpdatePlaudTitle: boolean;
	// Auto-sync (issue #5): a background timer that imports new recordings and
	// re-imports (overwrites) changed ones on an interval, using the saved
	// default import options. OFF by default: the connection is reverse-
	// engineered, an expired session pauses it until a re-auth, and a detected
	// change OVERWRITES the note and its artifacts (Plaud wins over local
	// edits).
	autoSyncEnabled: boolean;
	// Minutes between auto-sync ticks. Coerced to [15, 1440]; default 60.
	autoSyncIntervalMinutes: number;
	// How the current session was captured: the embedded email window or the
	// browser/bookmarklet flow. Routes Reconnect to the sign-in method that can
	// work for the account (Google/Apple cannot complete in the embedded
	// window). Empty for sessions from before 0.32.0; those fall back to the
	// legacy stored-WRT heuristic in reconnectPrefersWindow.
	signInMethod: SignInMethod;
	// Schema version for one-time settings migrations. Absent (pre-0.21.0) reads
	// as 0. Version 1 rewrote the subfolder/note-name date templates from the old
	// bespoke lowercase tokens to real Moment tokens (issue #30). Bumped only when
	// a stored-settings shape needs an output-preserving rewrite on load.
	settingsVersion: number;
}

const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: "",
	apiBaseUrl: "https://api.plaud.ai",
	outputFolder: "Plaud",
	subfolderTemplate: "{{YYYY}}/{{MM}}",
	noteNameTemplate: DEFAULT_NOTE_NAME_TEMPLATE,
	datetimeTemplate: "",
	// A real, editable example so the setting is self-documenting on a fresh
	// install. Writes "Recording Source: Plaud Importer" to new imports until the
	// user edits or removes it. Existing configs (which already stored a value)
	// are unaffected.
	customFrontmatter: [
		{ key: "Recording Source", value: "Plaud Importer", preserve: true },
	],
	preserveUnknownFrontmatter: true,
	forbiddenCharReplacement: "-",
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
	hideProcessedRecordings: true,
	hideUpdatesRecordings: false,
	hideIgnoredRecordings: true,
	ignoredRecordingIds: [],
	autoUpdatePlaudTitle: false,
	autoSyncEnabled: false,
	autoSyncIntervalMinutes: 60,
	signInMethod: "",
	settingsVersion: 1,
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
	// A sign-in window is open. Blocks a second concurrent sign-in from any
	// entry point (settings, the auth-pause notice, the backfill retry), so
	// stacked stale notices cannot launch clobbering capture sessions.
	private reauthInFlight = false;
	// The browser-reconnect flow currently awaiting a token, if any. A token can
	// come back through the modal's paste button OR the obsidian:// deep link;
	// deliveryInFlight serializes those channels per flow (the second one
	// no-ops instead of starting a concurrent token store), and completion is
	// keyed to this exact object so a delivery that outlives a cancelled flow
	// can never complete a newer one. Null when no browser reconnect is open;
	// cleared by the modal's onClose on every path (completion, cancel,
	// dismiss) and by onunload.
	private browserReconnect: {
		modal: Modal;
		onReconnected?: () => unknown;
		deliveryInFlight: boolean;
		// Idempotent gate release, shared with the modal's onClose. Exposed on
		// the flow so completion and onunload can restore the single-flight
		// state even when Modal.close() itself throws.
		release: () => void;
	} | null = null;
	// DEPRECATED one-time #52 repair: guards against a double-invoke running two
	// bulk vault scans at once. REMOVE with the repair command.
	private repairInFlight = false;
	// Sticky action notices (e.g. the auth-pause "Reconnect") tracked so
	// onunload can hide any still on screen before their click handlers can run
	// plugin work after the plugin is gone.
	private readonly actionNotices = new Set<Notice>();
	// Loop guard for the rename cascade. Nonzero while WE rename a note or its
	// assets folder (auto-migration or the local rename command). Suppresses the
	// vault.on('rename') listener so our own rename is not treated as a
	// user-initiated one and cascaded a second time, and disables the rename
	// command and menu item so a user rename cannot start while our cascade is
	// running. A depth counter, not a boolean: if two self-renames overlap, the
	// guard stays set until the LAST one finishes, so an outer rename's later
	// events cannot leak when an inner rename's finally runs first.
	private selfRenameDepth = 0;

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

		this.addCommand({
			id: "debug-copy-session-status",
			name: "Debug: copy session status to clipboard",
			callback: () => {
				void copyToClipboard(this.formatSessionStatus(), () => {
					new Notice(
						"Session status copied. It contains no token value and is safe to paste into a public issue.",
					);
				});
			},
		});

		// DEPRECATED ONE-TIME MIGRATION (issue #52) — REMOVE IN A FUTURE VERSION.
		// The import-time fix only repoints card embeds on (re)import; notes
		// imported before it keep the broken inline embed. This user-invoked
		// (never automatic) command repairs those existing notes in place.
		this.addCommand({
			id: "repair-legacy-card-links",
			name: "Repair card image links from older imports (one-time)",
			callback: () => {
				void this.repairLegacyCardLinks();
			},
		});

		// Issue B: let the user rename an imported recording from Obsidian and
		// keep its `<base>-assets` folder in sync. A palette command and a note
		// context-menu item both open the rename prompt; a vault rename listener
		// cascades a user rename (from Obsidian's own rename UI) to the assets
		// folder. All local: no write back to Plaud (that is a later feature).
		this.addCommand({
			id: "rename-recording",
			name: "Rename recording",
			checkCallback: (checking) => {
				// Disable while a plugin-owned rename is in flight so a user
				// rename cannot race our own cascade (the listener is already
				// suppressed the same way).
				const file = this.app.workspace.getActiveFile();
				if (this.selfRenameDepth > 0 || !this.isPlaudNote(file)) {
					return false;
				}
				if (!checking) {
					this.promptRenameRecording(file);
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				// Same suppression as the command: no user rename entry point
				// while our own rename cascade is running.
				if (this.selfRenameDepth > 0 || !this.isPlaudNote(file)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle("Rename imported recording")
						.setIcon("pencil")
						.onClick(() => this.promptRenameRecording(file)),
				);
			}),
		);

		// Cascade a user's rename of a Plaud note to its assets folder. Obsidian
		// has already renamed the note by the time this fires, so the note step
		// is a no-op inside renameRecordingNote and only the folder moves. The
		// self-rename guard skips our OWN renames (auto-migration and the command
		// above) so they do not double-cascade.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.selfRenameDepth > 0) {
					return;
				}
				if (!this.isPlaudNote(file)) {
					return;
				}
				void this.cascadeUserRename(oldPath, file.path);
			}),
		);

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
		// Close any waiting browser-reconnect modal. Plain Modal instances are
		// not plugin-owned components, so Obsidian does not close them on
		// unload; a stale one would stay interactive and write tokens and
		// settings through this dead instance. Clear the state first so the
		// modal's onClose callback (and any in-flight delivery) sees the flow
		// as gone.
		if (this.browserReconnect !== null) {
			const staleFlow = this.browserReconnect;
			this.browserReconnect = null;
			try {
				staleFlow.modal.close();
			} catch (err) {
				console.error("Plaud importer: failed to close reconnect modal", err);
			}
			staleFlow.release();
		}
		// Hide any sticky action notice (e.g. an auth-pause "Reconnect") so its
		// click handler cannot open sign-in or save settings after unload.
		for (const notice of this.actionNotices) {
			notice.hide();
		}
		this.actionNotices.clear();
		// Obsidian auto-detaches ribbon icons on unload; clear our
		// state so a subsequent onload starts from a known baseline.
		this.ribbonIconEl = null;
		this.ribbonIconId = null;
	}

	// Reads the linked secret's raw stored value, or "" when none is linked.
	// Shared by the settings status line, Test connection, and the
	// session-status command, so they always describe the same credential.
	readStoredTokenValue(): string {
		const id = this.settings.secretId;
		return id.length > 0 ? (this.app.secretStorage.getSecret(id) ?? "") : "";
	}

	// Thin wrapper over the pure formatSessionStatus in plaud-token.ts (where
	// its never-leak contract is pinned by tests): supplies the live plugin
	// version, settings, and stored secret value.
	private formatSessionStatus(): string {
		return formatSessionStatus({
			pluginVersion: this.manifest.version,
			apiBaseUrl: this.settings.apiBaseUrl,
			signInMethod: this.settings.signInMethod,
			tokenValue: this.readStoredTokenValue(),
		});
	}

	// One-time capture heads-up (issue #78): some accounts get a short (24h)
	// session under the same localStorage key the long-lived token uses.
	// Saying so at capture time makes the rejection ~24h later a predictable
	// event instead of a surprise. Advisory only: lifetime never gates a
	// capture, and an unreadable or iat-less token stays silent rather than
	// guessing.
	private noteShortLifetimeOnCapture(token: string): void {
		const life = readTokenLifetime(token);
		if (life === null || life.lifetimeHours === null) {
			return;
		}
		if (life.lifetimeHours > SHORT_LIFETIME_HOURS) {
			return;
		}
		const hours = Math.max(1, Math.round(life.lifetimeHours));
		new Notice(
			`Plaud issued this sign-in a session of about ${hours} hour${
				hours === 1 ? "" : "s"
			}, not the long session most accounts get. The plugin will ask you to sign in again when it expires.`,
			12000,
		);
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
			// Append the measured session status (issue #78): this button is
			// what users press when imports start failing, so it should say
			// how long the session was issued for and when it runs out.
			const value = this.readStoredTokenValue();
			const lifeSentence =
				value.length > 0
					? ` ${describeTokenLifetime(readTokenLifetime(value))}.`
					: "";
			return {
				ok: true,
				message:
					(recordings.length > 0
						? "Connected to Plaud. Your token works and recordings are reachable."
						: "Connected to Plaud. Your token works (no recordings found yet).") +
					lifeSentence,
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
			noteNameTemplate: this.settings.noteNameTemplate,
			datetimeTemplate: this.settings.datetimeTemplate,
			customFrontmatter: this.settings.customFrontmatter,
			preserveUnknownFrontmatter: this.settings.preserveUnknownFrontmatter,
			forbiddenCharReplacement: this.settings.forbiddenCharReplacement,
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
			hideProcessedRecordings: this.settings.hideProcessedRecordings,
			hideUpdatesRecordings: this.settings.hideUpdatesRecordings,
			hideIgnoredRecordings: this.settings.hideIgnoredRecordings,
			// data.json stores plain strings; PlaudRecordingId is a compile-time
			// brand over string. Re-tag each id at this boundary (a per-element
			// cast is legal where an array cast is not).
			ignoredRecordingIds: this.settings.ignoredRecordingIds.map(
				(id) => id as PlaudRecordingId,
			),
			debugLogger: this.debugLogger,
			getAuthToken: () =>
				this.settings.secretId.length > 0
					? this.app.secretStorage.getSecret(this.settings.secretId)
					: null,
			getApiBaseUrl: () => this.settings.apiBaseUrl,
			// Issue A: when a re-import lands a recording whose target name/path
			// differs from its existing note (a title or subfolder change), move
			// the note + its assets folder instead of overwriting stale-named
			// content in place. Wrapped with the self-rename loop guard so the
			// cascade does not re-fire the vault rename listener.
			migrateExistingNote: (oldPath, newPath) =>
				this.migrateRecordingNote(oldPath, newPath),
		};
	}

	/**
	 * Rename an existing note and its `<base>-assets` folder to `newNotePath` as
	 * a unit, guarding the whole cascade with the self-rename flag so our own
	 * rename does not trigger the vault rename listener. Backs both the
	 * auto-migration (Issue A) and the local rename command (Issue B).
	 */
	private async migrateRecordingNote(
		oldNotePath: string,
		newNotePath: string,
	): Promise<void> {
		const renameFile: RenameFileFn = async (from, to) => {
			const item = this.app.vault.getAbstractFileByPath(from);
			if (item === null) {
				throw new Error(`Nothing to rename at ${from}`);
			}
			await this.app.fileManager.renameFile(item, to);
		};
		this.selfRenameDepth += 1;
		try {
			await renameRecordingNote(
				this.app.vault,
				renameFile,
				oldNotePath,
				newNotePath,
			);
		} finally {
			this.selfRenameDepth -= 1;
		}
	}

	/**
	 * True when `file` is a markdown note this plugin imported, identified by a
	 * non-empty `plaud-id` in its frontmatter (read from the metadata cache).
	 * The rename command, context-menu item, and rename listener all gate on
	 * this so they never act on an unrelated note.
	 */
	private isPlaudNote(file: unknown): file is TFile {
		return (
			file instanceof TFile &&
			file.extension === "md" &&
			this.plaudIdOf(file) !== null
		);
	}

	// DEPRECATED ONE-TIME MIGRATION (issue #52) — REMOVE IN A FUTURE VERSION.
	// Scans this plugin's imported notes for Plaud's broken inline card-poster
	// embed and repoints each at the card image already in the note's `-assets`
	// folder. User-invoked only, idempotent (a repointed wikilink is not matched
	// again), and never touches non-Plaud notes. Notes whose card was never
	// downloaded are left for a re-import and counted in the report.
	private async repairLegacyCardLinks(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.repairInFlight) {
			new Notice("Plaud importer: card link repair is already running.");
			return;
		}
		this.repairInFlight = true;
		let notesRepaired = 0;
		let linksRepointed = 0;
		let notesNeedingReimport = 0;
		try {
			for (const file of this.app.vault.getMarkdownFiles()) {
				// Stop cleanly if the plugin unloads mid-scan.
				if (this.disposed) {
					return;
				}
				if (!this.isPlaudNote(file)) {
					continue;
				}
				let content: string;
				try {
					content = await this.app.vault.read(file);
				} catch {
					continue;
				}
				if (this.disposed) {
					return;
				}
				// Cheap prefilter: Plaud's card poster path always carries this marker.
				if (!content.includes("summary_poster")) {
					continue;
				}
				const assetsPath = file.path.replace(/\.md$/i, "-assets");
				const folder = this.app.vault.getFolderByPath(assetsPath);
				const cardPaths: string[] = [];
				if (folder !== null) {
					for (const child of folder.children) {
						if (child instanceof TFile && isLocalCardImage(child.name)) {
							cardPaths.push(child.path);
						}
					}
				}
				// Gate the write on the read content, but recompute inside process on
				// the FRESH content so a concurrent edit is never clobbered.
				const preview = repairLegacyCardEmbeds(content, cardPaths);
				if (preview.repointed === 0) {
					if (preview.unrepairable > 0) {
						notesNeedingReimport += 1;
					}
					continue;
				}
				let written = { repointed: 0, unrepairable: 0 };
				try {
					await this.app.vault.process(file, (fresh) => {
						const r = repairLegacyCardEmbeds(fresh, cardPaths);
						written = { repointed: r.repointed, unrepairable: r.unrepairable };
						return r.content;
					});
				} catch {
					// A single-note write failure must not abort the whole batch.
					continue;
				}
				if (written.repointed > 0) {
					notesRepaired += 1;
					linksRepointed += written.repointed;
				}
				if (written.unrepairable > 0) {
					notesNeedingReimport += 1;
				}
			}
		} finally {
			this.repairInFlight = false;
		}
		const tail =
			notesNeedingReimport > 0
				? ` ${notesNeedingReimport} note${notesNeedingReimport === 1 ? "" : "s"} had a broken card with no local copy; re-import those.`
				: "";
		new Notice(
			`Plaud Importer: repaired ${linksRepointed} card link${linksRepointed === 1 ? "" : "s"} in ${notesRepaired} note${notesRepaired === 1 ? "" : "s"}.${tail}`,
		);
	}

	/**
	 * Ask for a new name for `file`, then rename the note and its assets folder
	 * together (same folder, new base name). Local only; no write back to Plaud.
	 */
	private promptRenameRecording(file: TFile): void {
		new RenameRecordingModal(this.app, file.basename, (rawName) => {
			// sanitizeFilename never returns empty (it falls back to "Untitled"),
			// and the modal already rejects an empty entry, so there is no
			// unusable-name case to handle here. Uses the configured replacement
			// character so a manual rename matches how imports sanitize names.
			const sanitized = sanitizeFilename(
				rawName,
				this.settings.forbiddenCharReplacement,
			);
			// Obsidian represents the vault root as either "" or "/" depending on
			// the call site; treat both as no-dir so a root note does not produce
			// a leading-slash path like "/New name.md".
			const parentPath = file.parent?.path ?? "";
			const dir =
				parentPath === "" || parentPath === "/" ? "" : `${parentPath}/`;
			const newPath = `${dir}${sanitized}.md`;
			if (newPath === file.path) {
				return;
			}
			void this.runLocalRename(file.path, newPath, sanitized);
		}).open();
	}

	/** Perform the command-driven rename and report success/failure to the user. */
	private async runLocalRename(
		oldPath: string,
		newPath: string,
		displayName: string,
	): Promise<void> {
		try {
			await this.migrateRecordingNote(oldPath, newPath);
			new Notice(`Plaud importer: renamed to "${displayName}".`);
		} catch (err) {
			console.error("Plaud importer: rename failed", err);
			new Notice(
				`Plaud importer: rename failed. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return;
		}
		// Offer/do the Plaud title write-back only after a successful local rename.
		await this.maybeUpdatePlaudTitle(newPath, true);
	}

	/**
	 * Cascade a user's note rename (from Obsidian's own UI) to the note's assets
	 * folder. The note is already at `newPath`; renameRecordingNote moves only
	 * the folder. Silent when there is no assets folder; surfaces a Notice only
	 * when the folder move fails (which would otherwise leave embeds broken).
	 */
	private async cascadeUserRename(
		oldPath: string,
		newPath: string,
	): Promise<void> {
		try {
			await this.migrateRecordingNote(oldPath, newPath);
		} catch (err) {
			console.error(
				"Plaud importer: attachments-folder rename cascade failed",
				err,
			);
			new Notice(
				`Plaud importer: could not rename the attachments folder. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return;
		}
		// A file-explorer rename pushes to Plaud only when auto-update is on
		// (fromCommand = false means no prompt; the setting is the sole gate).
		await this.maybeUpdatePlaudTitle(newPath, false);
	}

	/**
	 * Read a note's `plaud-id` from the metadata cache, or null when the note is
	 * not a Plaud import. Widened through unknown to avoid an unsafe any.
	 */
	private plaudIdOf(file: TFile): string | null {
		const fm: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm === null || typeof fm !== "object") {
			return null;
		}
		const id = (fm as Record<string, unknown>)["plaud-id"];
		return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
	}

	/**
	 * After a local rename, optionally update the recording's title in Plaud.
	 * With autoUpdatePlaudTitle ON, pushes automatically. With it OFF, asks first,
	 * but only for a rename started from the plugin command (`fromCommand`); a
	 * file-explorer rename with the setting OFF stays local. No-op for a note
	 * without a plaud-id or when the client is not ready. The pushed title is the
	 * new note base name exactly (including any date prefix), so Plaud matches
	 * what the user set in Obsidian.
	 */
	private async maybeUpdatePlaudTitle(
		newNotePath: string,
		fromCommand: boolean,
	): Promise<void> {
		const file = this.app.vault.getFileByPath(newNotePath);
		if (!(file instanceof TFile)) {
			return;
		}
		const plaudId = this.plaudIdOf(file);
		if (plaudId === null) {
			return;
		}
		const title = file.basename;
		if (title.length === 0) {
			return;
		}
		const client = this.client;
		if (client === undefined) {
			if (fromCommand && this.settings.autoUpdatePlaudTitle) {
				new Notice(
					"Plaud importer: not connected, so the recording title was not updated.",
				);
			}
			return;
		}

		if (this.settings.autoUpdatePlaudTitle) {
			await this.pushPlaudTitle(client, file, plaudId, title);
			return;
		}
		if (!fromCommand) {
			return;
		}
		// Setting off and the user renamed via the command: confirm before any
		// cloud write.
		new ConfirmModal(this.app, {
			title: "Update the recording title?",
			body: `Also update this recording's title in Plaud to "${title}"? This changes your Plaud account.`,
			confirmText: "Update",
			cancelText: "Keep local",
			onConfirm: () => {
				// Re-read at confirm time: the note may have been renamed again, or
				// removed, while the prompt was open. Push the note's current name,
				// and skip entirely if it is gone.
				const current = this.app.vault.getFileByPath(file.path);
				if (current instanceof TFile) {
					void this.pushPlaudTitle(client, current, plaudId, current.basename);
				}
			},
		}).open();
	}

	/**
	 * Push the title to Plaud and, on success, refresh the note's stored version
	 * marker so auto-sync does not treat our own write as a changed recording.
	 * A failure surfaces a Notice but never throws to the caller.
	 */
	private async pushPlaudTitle(
		client: PlaudClient,
		file: TFile,
		plaudId: string,
		title: string,
		alreadyReauthed = false,
	): Promise<void> {
		// The confirm-modal path defers this call, so the plugin may have unloaded
		// between the prompt and the click; do not start a cloud write if so.
		if (this.disposed) {
			return;
		}
		try {
			await client.updateTitle(plaudId as PlaudRecordingId, title);
			// The plugin can unload during the network await; do not run the
			// follow-up re-list and frontmatter write against a torn-down state.
			// The title was already updated in Plaud, so skipping the marker
			// refresh only risks one benign re-import on the next sync.
			if (this.disposed) {
				return;
			}
			new Notice(`Plaud importer: recording title updated to "${title}".`);
			await this.refreshPlaudVersionMarker(client, file, plaudId);
		} catch (err) {
			// An expired or rejected session must not silently drop the write-back.
			// The local rename already succeeded; offer to sign in and retry the
			// push once (not a loop) so the title update is not lost. Guard on
			// alreadyReauthed so a still-failing token after sign-in falls through
			// to the plain error rather than re-prompting forever.
			if (err instanceof PlaudAuthError && !alreadyReauthed) {
				this.promptReauthAndRetryTitle(file, plaudId, title);
				return;
			}
			console.error("Plaud importer: Plaud title update failed", err);
			new Notice(
				`Plaud importer: could not update the recording title. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/**
	 * After an expired-session failure on the title push, ask the user to sign in
	 * and, on success, retry the push once with the note's current name. Keeps
	 * the rename's Plaud sync from being lost to a stale token.
	 */
	private promptReauthAndRetryTitle(
		file: TFile,
		plaudId: string,
		title: string,
	): void {
		new ConfirmModal(this.app, {
			title: "Sign in to update the title?",
			body: `Your Plaud session expired, so the title was not updated to "${title}". Your note is already renamed. Sign in to Plaud and finish updating the title there?`,
			confirmText: "Sign in",
			cancelText: "Not now",
			onConfirm: () => {
				void this.reauthAndRetryTitle(file, plaudId);
			},
		}).open();
	}

	private async reauthAndRetryTitle(file: TFile, plaudId: string): Promise<void> {
		try {
			const ok = await this.reauthenticate();
			if (!ok) {
				new Notice(
					"Plaud importer: sign-in was not completed, so the recording title was not updated.",
				);
				return;
			}
			// The browser sign-in can take a while; re-validate everything after it.
			if (this.disposed) {
				return;
			}
			const client = this.client;
			if (client === undefined) {
				return;
			}
			// Re-read the note at its path and confirm it is STILL the same
			// recording (same plaud-id). During sign-in the file could have been
			// moved, deleted, or replaced, and we must not push an unrelated file's
			// name to this recording. alreadyReauthed = true so a second auth
			// failure does not loop back into another sign-in prompt.
			const current = this.app.vault.getFileByPath(file.path);
			if (!(current instanceof TFile) || this.plaudIdOf(current) !== plaudId) {
				return;
			}
			await this.pushPlaudTitle(client, current, plaudId, current.basename, true);
		} catch (err) {
			// reauthenticate() and its token persistence can throw; keep this
			// fire-and-forget path from becoming an unhandled rejection.
			console.error(
				"Plaud importer: sign-in retry for the title update failed",
				err,
			);
			new Notice(
				"Plaud importer: sign-in failed, so the recording title was not updated.",
			);
		}
	}

	/**
	 * Best-effort: after a title push, re-read the recording's new version_ms
	 * (the title edit bumps its edit_time, so it sorts to the top of an
	 * edit-time list) and store it in the note's `plaud-version-ms` frontmatter.
	 * Without this, the next auto-sync would see our own write as a changed
	 * recording and re-import it. A failure here is benign (one redundant
	 * re-import at worst, with the title already matching so no rename), so it is
	 * logged and swallowed.
	 */
	private async refreshPlaudVersionMarker(
		client: PlaudClient,
		file: TFile,
		plaudId: string,
	): Promise<void> {
		try {
			const recent = await client.listRecordings({
				sortBy: "edit_time",
				limit: 10,
			});
			const updated = recent.find((r) => r.id === plaudId);
			if (updated?.versionMs === undefined) {
				return;
			}
			const versionMs = updated.versionMs;
			await this.app.fileManager.processFrontMatter(
				file,
				(fm: Record<string, unknown>) => {
					fm["plaud-version-ms"] = versionMs;
				},
			);
		} catch (err) {
			console.error(
				"Plaud importer: version marker refresh after title update failed",
				err,
			);
		}
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
		// policy is constrained to skip | overwrite (never 'prompt'): a background
		// tick has no dialog, so 'Ask each time' would have nothing to answer it.
		// options.onDuplicate (which may be 'prompt' from settings) is spread in but
		// overridden here, so the user's manual-import setting can never reach the
		// headless writer. This is the #43 safe fallback; keep the override even
		// when refactoring, or a background run could stall. NoteWriter's
		// constructor also throws on 'prompt' without a callback, so a regression
		// fails loud rather than hanging (see __tests__/note-writer.test.ts).
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
				// Honor the ignore set: an ignored recording is never pulled in the
				// background. Rebuilt each tick so an ignore/unignore mid-session
				// takes effect on the next run. Per-element re-tag (branded id).
				ignoredIds: new Set(
					this.settings.ignoredRecordingIds.map(
						(id) => id as PlaudRecordingId,
					),
				),
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
				// user who never configured a token is not told it "expired". A
				// one-click Reconnect action runs the sign-in flow and resumes,
				// so the user does not have to hunt through settings. Signing in
				// sets the token in the not-configured case too.
				const lead =
					classification.category === "not-configured"
						? "Plaud auto-sync paused: no Plaud token is configured."
						: "Plaud auto-sync paused: your session expired.";
				this.showActionNotice(lead, "Reconnect", () =>
					this.reconnectFromNotice(),
				);
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
		this.scheduleFollowUpTick();
	}

	/**
	 * Schedule one soon-ish auto-sync tick (~1s), reusing the first-run timeout
	 * slot so reconcileAutoSync() and onunload() clear it. No-op when auto-sync is
	 * disabled. Routed through one place so an untracked setTimeout can never
	 * fire after disable/reschedule/unload.
	 */
	private scheduleFollowUpTick(): void {
		if (!this.settings.autoSyncEnabled) return;
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
		}
		this.autoSyncFirstRunTimeoutId = window.setTimeout(() => {
			this.autoSyncFirstRunTimeoutId = undefined;
			void this.runAutoSyncTickSafe();
		}, 1000);
	}

	// ---- Reconnect routing and legacy credential cleanup ----------------

	/**
	 * Blank the legacy stored refresh token (pre-0.32.0 sessions). Called on
	 * every fresh capture and on sign-out so the legacy WRT can never masquerade
	 * as the routing signal for a newer session.
	 */
	private clearStoredRefreshToken(): void {
		try {
			this.app.secretStorage.setSecret(LEGACY_REFRESH_SECRET_ID, "");
		} catch (err) {
			console.error("Plaud importer: failed to blank refresh token", err);
		}
	}

	/**
	 * Routes Reconnect to the sign-in surface that can re-auth this account.
	 * The decision logic lives in reconnect-routing.ts (pure, unit-tested);
	 * this wrapper only supplies the settings value and the legacy-secret
	 * reader.
	 */
	private reconnectPrefersWindow(): boolean {
		return preferWindowForReconnect(this.settings.signInMethod, () =>
			this.app.secretStorage.getSecret(LEGACY_REFRESH_SECRET_ID),
		);
	}

	/**
	 * Show a sticky notice carrying one inline action link. Used by the
	 * auth-pause path and the manual commands so a disconnected session offers
	 * a one-click fix instead of a dead-end error. The notice hides as soon as
	 * the action starts, so a slow sign-in window does not sit under a stale
	 * message; action errors are swallowed (each action shows its own result).
	 */
	private showActionNotice(
		message: string,
		actionLabel: string,
		onAction: () => unknown,
	): void {
		const frag = createFragment();
		frag.createSpan({ text: `${message} ` });
		// role/tabindex + key handling so keyboard and screen-reader users can
		// activate the action, not just a mouse click.
		const actionEl = frag.createSpan({
			text: actionLabel,
			cls: "plaud-importer-notice-action",
			attr: { role: "button", tabindex: "0" },
		});
		// 0 = stay until the user acts (or dismisses); an auth pause is not a
		// message to blink past.
		const notice = new Notice(frag, 0);
		this.actionNotices.add(notice);
		// Drop the reference whenever the notice is clicked away (manual dismiss
		// or the action itself), so dismissed notices do not accumulate in the
		// Set for the plugin's lifetime.
		notice.messageEl.addEventListener("click", () => {
			this.actionNotices.delete(notice);
		});
		const activate = (): void => {
			this.actionNotices.delete(notice);
			notice.hide();
			// If the plugin unloaded while the notice was on screen, do nothing.
			if (this.disposed) return;
			void (async () => {
				try {
					await onAction();
				} catch (err) {
					console.error("Plaud importer: notice action failed", err);
					new Notice(
						"Plaud: that action could not be completed. Try again from settings.",
					);
				}
			})();
		};
		actionEl.addEventListener("click", activate);
		actionEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				activate();
			}
		});
	}

	/**
	 * Reconnect from an auth-pause surface: run the sign-in flow, and on success
	 * clear any auto-sync pause so the next tick runs. Owns its own result
	 * notice for every outcome (success, closed, error) so the user is never
	 * left with a hidden notice and no feedback. Returns whether a token was
	 * captured, so a caller (e.g. a failed command) can retry itself on success.
	 */
	async reconnectFromNotice(onReconnected?: () => unknown): Promise<boolean> {
		// A browser/bookmarklet (SSO) session cannot re-auth in the embedded
		// window (Google and Apple do not complete there), so routing it there
		// dead-ends. Open the browser + bookmarklet + paste flow instead. That
		// flow finishes asynchronously when the user pastes, so this returns
		// false now; the paste handler resumes any paused sync and runs
		// onReconnected (e.g. a backfill retry) itself.
		if (!this.reconnectPrefersWindow()) {
			this.openBrowserReconnect(onReconnected);
			return false;
		}
		try {
			const ok = await this.reauthenticate();
			// Plugin unloaded mid sign-in: skip side effects and messaging.
			if (this.disposed) return ok;
			if (ok) {
				new Notice("Plaud reconnected.");
				this.resumeAutoSyncIfPaused();
				if (onReconnected) await onReconnected();
			} else if (!this.reauthInFlight) {
				// A false with reauthInFlight still set means another sign-in
				// window is already open (reauthenticate short-circuited and
				// already said so); don't contradict it with "sign-in closed".
				new Notice("Plaud sign-in closed. Still disconnected.");
			}
			return ok;
		} catch (err) {
			console.error("Plaud importer: reconnect failed", err);
			if (!this.disposed) {
				new Notice("Plaud reconnect failed. Still disconnected.");
			}
			return false;
		}
	}

	/**
	 * Guided browser sign-in for SSO (Google/Apple) reconnect. Opens the same
	 * BrowserSignInModal the settings tab uses, but with an inline "Paste token"
	 * action so the whole reconnect completes from the modal: it opens Plaud in
	 * the system browser, the user runs the bookmarklet, and the token comes
	 * back through the paste button OR the bookmarklet's obsidian:// deep link;
	 * either channel stores it and runs completeBrowserReconnect (resume paused
	 * sync, close the modal, the optional onReconnected continuation such as a
	 * backfill retry), so a browser reconnect finishes the same follow-up the
	 * embedded flow does. Reuses openPlaudInBrowser and pasteTokenFromClipboard
	 * so there is one capture path.
	 */
	private openBrowserReconnect(onReconnected?: () => unknown): void {
		// One sign-in surface at a time, sharing the same gate as the embedded
		// window: two captures racing on the partition would clobber each
		// other's token write. Held for the modal's whole lifetime and
		// cleared when it closes; paste-success, deep-link success, cancel, and
		// dismiss all route through the modal's onClose.
		if (this.reauthInFlight) {
			new Notice("Plaud sign-in is already open.");
			return;
		}
		this.reauthInFlight = true;
		// Obsidian's Modal.close() runs onClose on EVERY call, and this modal
		// can legitimately be closed twice (completion closes it, then the
		// paste click handler's own close-on-success backstop fires after the
		// awaited continuation returns). Only the FIRST close may release the
		// single-flight gate: by the time a stale second close fires, a newer
		// sign-in may own it.
		let closeHandled = false;
		const releaseGate = (): void => {
			if (closeHandled) {
				return;
			}
			closeHandled = true;
			this.reauthInFlight = false;
			if (this.browserReconnect?.modal === modal) {
				this.browserReconnect = null;
			}
		};
		const modal = new BrowserSignInModal(
			this.app,
			() => this.openPlaudInBrowser(),
			async () => {
				// Deliver only for the flow this modal belongs to, one delivery
				// at a time: if the deep link is mid-store for the same flow,
				// this paste no-ops and lets that delivery finish.
				const flow = this.browserReconnect;
				if (flow === null || flow.modal !== modal || flow.deliveryInFlight) {
					return false;
				}
				flow.deliveryInFlight = true;
				try {
					// The guard re-checks after the (possibly slow) clipboard
					// read: if this flow was cancelled meanwhile and a newer
					// sign-in stored its own token, the stale paste must not
					// overwrite it.
					const ok = await this.pasteTokenFromClipboard(
						() => !this.disposed && this.browserReconnect === flow,
					);
					if (ok) {
						const done = await this.completeBrowserReconnect(flow);
						// The flow was cancelled while the store ran; the token
						// is saved anyway, so a paused sync should still resume.
						if (!done && !this.disposed) {
							this.resumeAutoSyncIfPaused();
						}
					}
					return ok;
				} finally {
					flow.deliveryInFlight = false;
				}
			},
			releaseGate,
		);
		this.browserReconnect = {
			modal,
			onReconnected,
			deliveryInFlight: false,
			release: releaseGate,
		};
		try {
			modal.open();
		} catch (err) {
			// A modal that failed to open can never fire onClose; restore the
			// single-flight state here or every later sign-in would be refused.
			console.error("Plaud importer: reconnect modal failed to open", err);
			releaseGate();
		}
	}

	/**
	 * Follow-through for a browser reconnect whose token has just been stored,
	 * regardless of which channel delivered it (the modal's paste button or the
	 * obsidian:// deep link the bookmarklet fires): announce, resume any paused
	 * sync, close the modal (which releases the single-flight gate via its
	 * onClose), and run the optional onReconnected continuation. Runs at most
	 * once per flow: it claims the pending state first, and only for the exact
	 * flow the delivery started against, so a paste and a deep link landing
	 * together follow through once and a delivery that outlives a cancelled
	 * flow can never complete a newer one. Returns whether it ran.
	 */
	private async completeBrowserReconnect(
		flow: NonNullable<PlaudImporterPlugin["browserReconnect"]>,
	): Promise<boolean> {
		if (this.disposed || this.browserReconnect !== flow) {
			return false;
		}
		this.browserReconnect = null;
		new Notice("Plaud reconnected.");
		this.resumeAutoSyncIfPaused();
		try {
			flow.modal.close();
		} catch (err) {
			console.error("Plaud importer: failed to close reconnect modal", err);
		}
		// close() normally releases the gate via the modal's onClose; if close
		// threw before onClose ran, release explicitly (idempotent) so the
		// continuation below never runs with the gate wedged.
		flow.release();
		if (flow.onReconnected) {
			try {
				await flow.onReconnected();
			} catch (err) {
				// The reconnect itself succeeded; only the follow-up (e.g. a
				// backfill retry) failed. Say so instead of letting the rejection
				// surface as an unhandled error with no context.
				console.error("Plaud importer: post-reconnect follow-up failed", err);
				new Notice(
					"Plaud reconnected, but the retried action failed. Run it again manually.",
				);
			}
		}
		return true;
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
			const classification = classifyError(err);
			// An expired/missing token used to dead-end here with a bare error.
			// Offer a one-click reconnect that retries the backfill on success,
			// matching the auth-pause notice, so a stale session is a single
			// click to fix rather than a trip to settings and back.
			if (categoryAllowsReauth(classification.category)) {
				this.showActionNotice(
					"Plaud importer: backfill needs a Plaud session.",
					"Reconnect and retry",
					// Pass the retry as the post-reconnect continuation so it runs on
					// BOTH the embedded (email) path and the async browser (SSO) path;
					// the SSO path returns false immediately (paste completes later), so
					// a caller that keyed the retry off the return value would skip it.
					() =>
						this.reconnectFromNotice(() => this.backfillVersionMarkers()),
				);
			} else {
				new Notice(`Plaud importer: backfill failed: ${classification.message}`);
			}
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
				// Persist dialog filter toggles and ignore-set changes back to
				// settings so they survive reopen and auto-sync sees the updated
				// ignore set on its next tick. The modal owns its own in-memory
				// copy and calls this after each change.
				onViewStateChange: (patch) => {
					void this.applyImportViewState(patch);
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
		// Read the stored version BEFORE the merge: an existing pre-0.21.0
		// data.json has no settingsVersion field, and Object.assign would fill it
		// from DEFAULT_SETTINGS (1), hiding that a migration is due. An absent
		// field is version 0.
		const rawVersion = stored?.settingsVersion;
		// Treat a non-finite or non-numeric stored version as 0 (needs migration),
		// so a corrupted value cannot skip the migration and leave legacy tokens to
		// misrender under Moment. JSON parsing cannot itself produce NaN, but a
		// hand-edited file could carry a bad type; this is defense-in-depth.
		const storedVersion =
			typeof rawVersion === "number" && Number.isFinite(rawVersion)
				? rawVersion
				: 0;
		// 0.32.0 removed the keepSessionAlive setting with the refresh
		// subsystem. Object.assign copies unknown stored keys through, so drop
		// the stale key here or it rides along in data.json forever.
		const merged: PlaudImporterSettings & { keepSessionAlive?: unknown } =
			Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
		delete merged.keepSessionAlive;
		this.settings = merged;
		// Repair a blank stored output folder back to the default. The
		// declarative control can persist an empty string; consumers expect a
		// non-empty folder name.
		if (
			typeof this.settings.outputFolder !== "string" ||
			this.settings.outputFolder.trim().length === 0
		) {
			this.settings.outputFolder = "Plaud";
		}
		// Repair a hand-edited or malformed replacement character back to the
		// default dash, so every consumer (imports and the rename command) gets a
		// safe single character. The settings UI validates on entry, but data.json
		// could carry anything; an unsafe value (e.g. "/") would otherwise let
		// sanitizing produce a path separator. NoteWriter also guards defensively.
		if (
			typeof this.settings.forbiddenCharReplacement !== "string" ||
			!isValidReplacementChar(this.settings.forbiddenCharReplacement)
		) {
			this.settings.forbiddenCharReplacement = "-";
		}
		// v1 (issue #30): the date-template engine moved from bespoke lowercase
		// tokens to real Moment. Rewrite the two stored templates once, output-
		// preserving (see migrateLegacyDateTemplate), so an existing install's
		// filenames and folders do not change. Gated on an EXISTING install
		// (stored data present) so a fresh install writes nothing at startup: its
		// templates are already the Moment defaults, and skipping the save avoids
		// an unnecessary write and a load-time failure if saveData throws.
		if (stored !== null && storedVersion < 1) {
			this.settings.noteNameTemplate = migrateLegacyDateTemplate(
				this.settings.noteNameTemplate,
			);
			this.settings.subfolderTemplate = migrateLegacyDateTemplate(
				this.settings.subfolderTemplate,
			);
			this.settings.settingsVersion = 1;
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Persist a change to the import dialog's view state (the filter-bar toggles
	 * and the ignore set). Called by the modal after every toggle so the choice
	 * survives reopen and a background auto-sync tick, which reads
	 * `settings.ignoredRecordingIds` fresh each run, honors the updated ignore
	 * set. Stores a fresh plain-string array for the ignore set so the module-
	 * level DEFAULT_SETTINGS array is never mutated by reference.
	 */
	private async applyImportViewState(patch: ImportViewStatePatch): Promise<void> {
		if (patch.showTrashedRecordings !== undefined) {
			this.settings.showTrashedRecordings = patch.showTrashedRecordings;
		}
		if (patch.hideProcessedRecordings !== undefined) {
			this.settings.hideProcessedRecordings = patch.hideProcessedRecordings;
		}
		if (patch.hideUpdatesRecordings !== undefined) {
			this.settings.hideUpdatesRecordings = patch.hideUpdatesRecordings;
		}
		if (patch.hideIgnoredRecordings !== undefined) {
			this.settings.hideIgnoredRecordings = patch.hideIgnoredRecordings;
		}
		if (patch.ignoredRecordingIds !== undefined) {
			this.settings.ignoredRecordingIds = [...patch.ignoredRecordingIds];
		}
		await this.saveSettings();
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
		// removed; blanking the value is the most thorough removal available. The
		// legacy refresh token is blanked too so no credential outlives sign-out.
		for (const id of new Set([
			this.settings.secretId,
			CAPTURED_SECRET_ID,
			LEGACY_REFRESH_SECRET_ID,
		])) {
			if (id.length > 0) {
				try {
					this.app.secretStorage.setSecret(id, "");
				} catch (err) {
					console.error("Plaud importer: failed to blank secret", err);
				}
			}
		}
		this.settings.secretId = "";
		// A cleared plugin has no session, so there is no sign-in method to route
		// a Reconnect from until the next capture records one.
		this.settings.signInMethod = "";
		await this.saveSettings();
		return { sessionCleared };
	}

	// Re-authenticates via the email/password login window and persists the
	// captured token with the FULL recipe: set the secret, link secretId, and
	// adopt the redirected region (apiBaseUrl) so a region-redirected user is not
	// stranded on a stale host. Returns true once a token is captured and saved,
	// false if the user closed the window or the login API is unavailable on this
	// build. Shared by the settings tab and the import modal's inline re-auth.
	// On the happy and closed paths it shows no Notice, so each caller phrases
	// its own; the one exception is the single-flight guard, which shows a
	// "sign-in is already open" Notice and returns false when a window is open.
	async reauthenticate(): Promise<boolean> {
		// One sign-in window at a time. Concurrent windows share the same
		// Electron capture partition and would clobber each other's token
		// capture, so a second caller (a stacked notice, a repeated command)
		// no-ops with a hint instead of opening a rival window.
		if (this.reauthInFlight) {
			new Notice("Plaud sign-in is already open.");
			return false;
		}
		this.reauthInFlight = true;
		try {
			const result = await openPlaudLogin(this.app, {
				debugLogger: this.debugLogger,
			});
			if (result === null) {
				return false;
			}
			// Do not persist a token onto a plugin that unloaded mid sign-in.
			if (this.disposed) {
				return false;
			}
			this.app.secretStorage.setSecret(CAPTURED_SECRET_ID, result.token);
			this.settings.secretId = CAPTURED_SECRET_ID;
			// Record how this session was captured so Reconnect reopens the same
			// surface, and blank any legacy WRT so it cannot shadow that signal.
			this.settings.signInMethod = "window";
			this.clearStoredRefreshToken();
			if (result.apiBaseUrl !== null) {
				this.settings.apiBaseUrl = result.apiBaseUrl;
			}
			await this.saveSettings();
			this.noteShortLifetimeOnCapture(result.token);
			return true;
		} finally {
			this.reauthInFlight = false;
		}
	}

	// Reads a token from the clipboard and stores it via storeAccessToken,
	// showing the same guidance Notices the settings paste button uses. Returns
	// true on success. Shared by the settings tab and the modal's SSO expander;
	// the success Notice is left to each caller.
	async pasteTokenFromClipboard(
		// Re-checked AFTER the (possibly slow) clipboard read, right before the
		// store: a caller whose context can go stale mid-read (the reconnect
		// modal, which may be cancelled while a newer sign-in stores its own
		// token) passes a guard so a stale paste can never overwrite the newer
		// credential. Callers with no such window keep the default.
		canStore: () => boolean = () => true,
	): Promise<boolean> {
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
		if (!canStore()) {
			return false;
		}
		const ok = await this.storeAccessToken(text);
		if (!ok) {
			new Notice(
				"The clipboard did not hold a valid token. Make sure you are signed in, then click the bookmarklet and copy the token it shows.",
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

	// Validates a raw token value (the long-lived user token, optionally bearer-
	// prefixed) and, if valid, stores it in the captured-token secret and links
	// it. Overwrites the same secret each time, so replacing a token never
	// requires creating or deleting a secret. Returns false without changing
	// anything when the value fails the capture guard (payload must carry a
	// client_id and a still-future exp). Shared by the browser deep-link handler
	// and the clipboard-paste button.
	async storeAccessToken(rawToken: string): Promise<boolean> {
		const token = rawToken.trim().replace(/^bearer\s+/i, "");
		if (token.length === 0 || !isUsableUserToken(token)) {
			return false;
		}
		this.app.secretStorage.setSecret(CAPTURED_SECRET_ID, token);
		this.settings.secretId = CAPTURED_SECRET_ID;
		// A pasted/deep-linked token came through the browser flow. Record that
		// so Reconnect routes there, and blank any legacy WRT from a previous
		// session so it cannot shadow the recorded method.
		this.settings.signInMethod = "browser";
		this.clearStoredRefreshToken();
		await this.saveSettings();
		this.noteShortLifetimeOnCapture(token);
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
		// A deep link is one of the browser-reconnect return channels: when that
		// flow is waiting, deliver against it (serialized with the paste button
		// via deliveryInFlight) and run its full follow-through: resume, close
		// the modal, continuation, with its "Plaud reconnected." notice
		// (issue #75). The flow is snapshotted BEFORE the async store so a slow
		// store can never complete a different, newer flow.
		const flow = this.browserReconnect;
		if (flow !== null) {
			if (flow.deliveryInFlight) {
				// The paste button is mid-store for this flow; let it finish.
				return;
			}
			flow.deliveryInFlight = true;
			try {
				const ok = await this.storeAccessToken(raw);
				if (ok) {
					const done = await this.completeBrowserReconnect(flow);
					if (done) {
						return;
					}
					// The flow was cancelled while the store ran; the token is
					// saved anyway, so fall through to the plain-path handling.
				} else {
					new Notice(DEEP_LINK_BAD_TOKEN_NOTICE);
					return;
				}
			} finally {
				flow.deliveryInFlight = false;
			}
			if (this.disposed) {
				return;
			}
			this.resumeAutoSyncIfPaused();
			new Notice(DEEP_LINK_SAVED_NOTICE);
			return;
		}
		const ok = await this.storeAccessToken(raw);
		if (ok) {
			// Outside the reconnect flow a fresh token still means the session
			// is back; a paused auto-sync should not wait for its next trigger.
			this.resumeAutoSyncIfPaused();
		}
		new Notice(ok ? DEEP_LINK_SAVED_NOTICE : DEEP_LINK_BAD_TOKEN_NOTICE);
	}
}

// Just-in-time reminder shown when the user launches the browser sign-in, so
// the capture steps are in front of them at the moment they switch to the
// browser. Step text is built from variables (not string literals at the call
// site) so it can name "Plaud" and the buttons while satisfying the
// sentence-case lint, which only inspects literals.
class BrowserSignInModal extends Modal {
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
		this.setTitle("Get your sign-in token");
		const { contentEl } = this;
		const intro = "Your web browser is about to open. Do these in order:";
		contentEl.createEl("p", { text: intro });
		const ol = contentEl.createEl("ol");
		const lines = [
			"Sign in to Plaud if you are not already. Google, Apple, and password all work in a real browser.",
			"Click the 'Plaud → Obsidian' bookmark on your bookmarks bar (the one you saved in step 1). A small box pops up showing your token.",
			"Copy the token, switch back to Obsidian, and click 'Paste token from clipboard'.",
		];
		for (const line of lines) {
			ol.createEl("li", { text: line });
		}
		const openLabel = "Open my browser now";
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
				btn.setButtonText("Paste token from clipboard").onClick(async () => {
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
						console.error("Plaud importer: paste reconnect failed", err);
						new Notice(
							"Plaud: could not save that token. Try again, or use settings.",
						);
					}
				}),
			);
		}
		row.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => this.close()),
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
class RenameRecordingModal extends Modal {
	private value: string;
	private readonly onSubmit: (newName: string) => void;

	constructor(app: App, initial: string, onSubmit: (newName: string) => void) {
		super(app);
		this.value = initial;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle("Rename recording");
		const { contentEl } = this;
		let input: TextComponent | undefined;
		new Setting(contentEl)
			.setName("New name")
			.setDesc("The note and its attachments folder are renamed together.")
			.addText((text) => {
				input = text;
				text.setValue(this.value).onChange((v) => {
					this.value = v;
				});
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						evt.preventDefault();
						this.submit();
					}
				});
			});
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Rename")
					.setCta()
					.onClick(() => this.submit()),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			);
		if (input) {
			input.inputEl.focus();
			input.inputEl.select();
		}
	}

	private submit(): void {
		const trimmed = this.value.trim();
		if (trimmed.length === 0) {
			new Notice("Plaud importer: enter a name.");
			return;
		}
		this.close();
		this.onSubmit(trimmed);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

interface ConfirmModalOptions {
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
class ConfirmModal extends Modal {
	private readonly opts: ConfirmModalOptions;

	constructor(app: App, opts: ConfirmModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.body });
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
				btn.setButtonText(this.opts.cancelText).onClick(() => this.close()),
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
		this.renderNoteNameTemplateControl(
			this.makeSetting(
				containerEl,
				"Note name template",
				NOTE_NAME_TEMPLATE_INTRO,
			),
		);
		this.renderDatetimeTemplateControl(
			this.makeSetting(
				containerEl,
				"Datetime property",
				DATETIME_TEMPLATE_INTRO,
			),
		);
		this.renderCustomFrontmatterControl(
			this.makeSetting(
				containerEl,
				"Extra frontmatter",
				CUSTOM_FRONTMATTER_INTRO,
			),
		);
		this.addToggleRow(
			containerEl,
			"Preserve unknown frontmatter on re-import",
			PRESERVE_UNKNOWN_FRONTMATTER_DESC,
			"preserveUnknownFrontmatter",
		);
		this.addTextRow(
			containerEl,
			"Forbidden character replacement",
			FORBIDDEN_CHAR_REPLACEMENT_DESC,
			"forbiddenCharReplacement",
			"-",
		);
		this.addDropdownRow(
			containerEl,
			DUPLICATE_HANDLING_NAME,
			DUPLICATE_HANDLING_DESC,
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
		this.addToggleRow(
			containerEl,
			"Update the recording title on rename",
			"Off by default. When on, renaming an imported recording (with the Rename recording command or by renaming the note in the file explorer) also updates that recording's title in Plaud to match the new note name, including any date prefix. This is the only change the plugin writes back to Plaud. When off, the Rename recording command asks each time whether to update Plaud, and a file-explorer rename stays local.",
			"autoUpdatePlaudTitle",
		);

		new Setting(containerEl).setName("Automatic sync").setHeading();
		this.addToggleRow(
			containerEl,
			"Enable automatic sync",
			AUTO_SYNC_DESC,
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
			// Decode on demand from the currently linked secret rather than
			// caching a measurement: the picker below links arbitrary secret
			// ids with zero validation, so a cached number could describe the
			// wrong credential. Reports the measured lifetime (issue #78)
			// instead of just "a token is stored". A stored-but-expired token
			// must not read as "connected" or keep the ok styling.
			const value = this.plugin.readStoredTokenValue();
			const stored = value.length > 0;
			const life = stored ? readTokenLifetime(value) : null;
			// A linked secret that does not decode to a JWT with a numeric exp
			// (garbage, or the neighboring profile JWT) must not read as
			// connected either: the picker links arbitrary ids, so this state
			// is reachable.
			const unreadable = stored && life === null;
			const expired = life !== null && life.remainingMs <= 0;
			const desc = describeTokenLifetime(life);
			statusEl.setText(
				!stored
					? "Status: not connected yet."
					: unreadable
						? "Status: the linked secret is not a readable Plaud token. Sign in again to replace it."
						: expired
							? `Status: session ${desc.charAt(0).toLowerCase()}${desc.slice(1)}.`
							: `Status: connected. ${desc}.`,
			);
			statusEl.toggleClass(
				"plaud-importer-signin-ok",
				stored && !expired && !unreadable,
			);
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
						// A manually linked secret has unknown provenance, so the
						// recorded sign-in method no longer describes the active
						// credential; clear it and let Reconnect fall back to the
						// legacy heuristic. Re-linking the plugin-captured secret
						// keeps its recorded method, which still describes that
						// token.
						if (id !== CAPTURED_SECRET_ID) {
							this.plugin.settings.signInMethod = "";
						}
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
			"In the browser: sign in to Plaud if needed, then click the bookmark you saved. A small box shows your token. Copy it.",
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

	// Inserts a token at the text field's cursor (replacing any selection) and
	// keeps focus, so the insert-token buttons build a template without the user
	// hand-typing braces (bare letters typed inside braces would be read as Moment
	// tokens). TextComponent.setValue is programmatic and does not fire onChange,
	// so callers persist and refresh the preview explicitly after calling this.
	private insertTokenAtCursor(field: TextComponent, token: string): void {
		const input = field.inputEl;
		const value = input.value;
		const start = input.selectionStart ?? value.length;
		const end = input.selectionEnd ?? value.length;
		field.setValue(value.slice(0, start) + token + value.slice(end));
		const caret = start + token.length;
		input.focus();
		input.setSelectionRange(caret, caret);
	}

	// Adds a full-width live-preview line to a stacked template row and returns an
	// updater. The updater renders the given template against the shared sample
	// recording (TEMPLATE_PREVIEW_DATE) so a wrong token or an illegal character is
	// visible before any file is written. This is the real safety net now that
	// Moment does not throw on unknown tokens.
	private attachTemplatePreview(
		setting: Setting,
		render: (template: string) => string,
	): (template: string) => void {
		const previewEl = setting.controlEl.createDiv({
			cls: "plaud-importer-template-preview",
		});
		return (template: string) => {
			previewEl.setText(render(template));
		};
	}

	// Renders the subfolder-template row: appends the token reference (a list,
	// not a cramped one-line desc) into the description, then adds insert-token
	// buttons, the text control bound to subfolderTemplate, and a live preview.
	// Shared by the declarative path (via the item's render callback) and the
	// imperative display() fallback, so both Obsidian versions show the identical
	// documentation. Building the DOM fresh on each call avoids any
	// DocumentFragment-reuse pitfalls.
	private renderSubfolderTemplateControl(setting: Setting): void {
		// Stack the row: the token/example lists read full-width on top, the text
		// field full-width below, rather than crammed into a narrow left column.
		setting.settingEl.addClass("plaud-importer-stacked-row");
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

		// field is captured so an insert-token button can edit the visible field,
		// not just the saved value; updatePreview is assigned after the preview DOM
		// exists (created last so it sits below the field) but referenced earlier by
		// the button/field closures, which only run on later user interaction.
		let field: TextComponent | null = null;
		let updatePreview: (template: string) => void = () => {};
		// Date tokens plus Title and Folder: the subfolder supports {{title}} for
		// folder-note layouts (issue #30 follow-up) and {{plaud-folder}} for
		// mirroring Plaud folders (issue #16 follow-up), so it gets the date button
		// set plus both.
		for (const [label, token] of [
			...DATE_INSERT_TOKENS,
			TITLE_INSERT_TOKEN,
			FOLDER_INSERT_TOKEN,
		]) {
			setting.addButton((button) => {
				button
					.setButtonText(label)
					.setTooltip(`Insert ${token}`)
					.onClick(async () => {
						if (field === null) return;
						this.insertTokenAtCursor(field, token);
						const value = field.getValue();
						await this.applyControlChange("subfolderTemplate", value);
						updatePreview(value);
					});
				// Keep focus in the text field on click (mousedown default is to
				// move focus to the button) so the cursor position is preserved for
				// the insert.
				button.buttonEl.addEventListener("mousedown", (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text
				.setPlaceholder("{{YYYY}}/{{MM}}")
				.setValue(this.readSettingString("subfolderTemplate"))
				.onChange(async (value) => {
					await this.applyControlChange("subfolderTemplate", value);
					updatePreview(value);
				});
		});
		updatePreview = this.attachTemplatePreview(setting, (template) => {
			if (template.trim() === "") {
				return "Preview: no subfolder (every note in the output folder)";
			}
			try {
				// Pass the sample title and folder so {{title}} and {{plaud-folder}}
				// templates preview with real names, and the configured replacement
				// char so the preview matches what an import would actually write.
				return `Preview folder: ${resolveSubfolder(
					template,
					TEMPLATE_PREVIEW_DATE,
					TEMPLATE_PREVIEW_TITLE,
					this.plugin.settings.forbiddenCharReplacement,
					TEMPLATE_PREVIEW_FOLDER,
				)}`;
			} catch (err) {
				return `Preview (not usable): ${
					err instanceof Error ? err.message : String(err)
				}`;
			}
		});
		updatePreview(this.readSettingString("subfolderTemplate"));
	}

	// Renders the datetime template row for the `datetime:` frontmatter property
	// (issue #32). Mirrors the subfolder row (Moment-only, per-keystroke persist,
	// no presets); the shared insert-token buttons now include the time tokens.
	// Empty is a valid value (writes no property), so unlike the note-name field
	// there is no blur-commit or invalid-template Notice — Moment never errors and
	// the preview is the only feedback needed.
	private renderDatetimeTemplateControl(setting: Setting): void {
		setting.settingEl.addClass("plaud-importer-stacked-row");
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: DATETIME_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl("ul");
		for (const [token, meaning] of DATETIME_TEMPLATE_TOKENS) {
			const item = tokenList.createEl("li");
			item.createEl("code", { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: DATETIME_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl("ul");
		for (const [template, result] of DATETIME_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl("li");
			item.createEl("code", { text: template });
			item.createSpan({ text: ` → ${result}` });
		}
		docEl.createDiv({ text: DATETIME_TEMPLATE_FOOTNOTE });

		let field: TextComponent | null = null;
		let updatePreview: (template: string) => void = () => {};
		for (const [label, token] of DATE_INSERT_TOKENS) {
			setting.addButton((button) => {
				button
					.setButtonText(label)
					.setTooltip(`Insert ${token}`)
					.onClick(async () => {
						if (field === null) return;
						this.insertTokenAtCursor(field, token);
						const value = field.getValue();
						await this.applyControlChange("datetimeTemplate", value);
						updatePreview(value);
					});
				button.buttonEl.addEventListener("mousedown", (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text
				.setPlaceholder("{{YYYY-MM-DD HH:mm}}")
				.setValue(this.readSettingString("datetimeTemplate"))
				.onChange(async (value) => {
					await this.applyControlChange("datetimeTemplate", value);
					updatePreview(value);
				});
		});
		updatePreview = this.attachTemplatePreview(setting, (template) => {
			if (template.trim() === "") {
				return "Preview: no datetime property";
			}
			return `Preview datetime: ${formatDatetime(template, TEMPLATE_PREVIEW_DATETIME)}`;
		});
		updatePreview(this.readSettingString("datetimeTemplate"));
	}

	// Renders the "Extra frontmatter" row: the token/example reference in the
	// description, then a dynamic list of key / value / preserve rows with a
	// token palette, an add-row button, and a live preview of the expanded
	// output. Structured (not a template string), so it persists directly to
	// settings.customFrontmatter rather than through applyControlChange.
	private renderCustomFrontmatterControl(setting: Setting): void {
		setting.settingEl.addClass("plaud-importer-stacked-row");
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: CUSTOM_FRONTMATTER_TOKENS_HEADING });
		const tokenList = docEl.createEl("ul");
		for (const [token, meaning] of CUSTOM_FRONTMATTER_TOKENS) {
			const item = tokenList.createEl("li");
			item.createEl("code", { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: CUSTOM_FRONTMATTER_EXAMPLES_HEADING });
		const exampleList = docEl.createEl("ul");
		for (const [template, result] of CUSTOM_FRONTMATTER_EXAMPLES) {
			const item = exampleList.createEl("li");
			item.createEl("code", { text: template });
			item.createSpan({ text: ` → ${result}` });
		}
		docEl.createDiv({ text: CUSTOM_FRONTMATTER_FOOTNOTE });

		// Working copy of the rows, persisted to settings on every edit. A mutable
		// shape (the stored CustomFrontmatterRow is readonly) so an in-place field
		// edit is allowed. Blank rows are dropped on persist, and one blank row is
		// always shown so there is somewhere to start typing.
		type EditableRow = { key: string; value: string; preserve: boolean };
		const rows: EditableRow[] = this.plugin.settings.customFrontmatter.map(
			(r) => ({ key: r.key, value: r.value, preserve: r.preserve }),
		);
		if (rows.length === 0) {
			rows.push({ key: "", value: "", preserve: true });
		}

		// Regions in fixed visual order: the property rows, the add-row button, the
		// token palette, then the live preview.
		const rowsEl = setting.controlEl.createDiv({
			cls: "plaud-importer-frontmatter-rows",
		});
		const actionsEl = setting.controlEl.createDiv({
			cls: "plaud-importer-frontmatter-actions",
		});
		const paletteEl = setting.controlEl.createDiv({
			cls: "plaud-importer-frontmatter-controls",
		});
		const previewEl = setting.controlEl.createDiv({
			cls: "plaud-importer-template-preview",
		});

		let lastFocusedValue: HTMLInputElement | null = null;

		const updatePreview = (): void => {
			const lines = renderCustomFrontmatterPreview(rows);
			previewEl.setText(
				lines.length > 0
					? `Preview:\n${lines.join("\n")}`
					: "Preview: no extra frontmatter properties",
			);
		};
		const persist = async (): Promise<void> => {
			// Store only rows that name a property; the blank starter row is not saved.
			this.plugin.settings.customFrontmatter = rows
				.filter((r) => r.key.trim() !== "")
				.map((r) => ({ key: r.key, value: r.value, preserve: r.preserve }));
			await this.plugin.saveSettings();
			updatePreview();
		};

		const renderRows = (): void => {
			rowsEl.empty();
			// The old value inputs are about to be detached, so drop any reference to
			// one; a token button must target a currently-mounted field or no-op.
			lastFocusedValue = null;

			// Every cell (headings and each row's inputs) is a DIRECT child of the
			// one grid, so the columns are literally the same tracks and each heading
			// sits left-aligned over its column. Four cells per line; the header adds
			// an empty cell over the Remove column so auto-flow stays on the grid.
			rowsEl.createSpan({
				cls: "plaud-importer-frontmatter-heading",
				text: "Property",
			});
			rowsEl.createSpan({
				cls: "plaud-importer-frontmatter-heading",
				text: "Value",
			});
			rowsEl.createSpan({
				cls: "plaud-importer-frontmatter-heading",
				text: "Preserve",
			});
			rowsEl.createSpan({ cls: "plaud-importer-frontmatter-heading" });

			rows.forEach((row, index) => {
				const keyInput = rowsEl.createEl("input", {
					cls: "plaud-importer-frontmatter-key",
					attr: { type: "text", "aria-label": "Property name" },
				});
				keyInput.value = row.key;
				keyInput.addEventListener("input", () => {
					row.key = keyInput.value;
					void persist();
				});

				const valueInput = rowsEl.createEl("input", {
					cls: "plaud-importer-frontmatter-value",
					attr: { type: "text", "aria-label": "Property value" },
				});
				valueInput.value = row.value;
				valueInput.addEventListener("focus", () => {
					lastFocusedValue = valueInput;
				});
				valueInput.addEventListener("input", () => {
					row.value = valueInput.value;
					void persist();
				});

				// Checkbox only; the "Preserve" column heading labels it.
				const preserveLabel = rowsEl.createEl("label", {
					cls: "plaud-importer-frontmatter-preserve",
					attr: { "aria-label": "Preserve on re-import" },
				});
				const preserveInput = preserveLabel.createEl("input", {
					attr: { type: "checkbox", "aria-label": "Preserve on re-import" },
				});
				preserveInput.checked = row.preserve;
				preserveInput.addEventListener("change", () => {
					row.preserve = preserveInput.checked;
					void persist();
				});

				const removeButton = rowsEl.createEl("button", {
					cls: "plaud-importer-frontmatter-remove",
					text: "Remove",
					attr: { type: "button", "aria-label": "Remove property" },
				});
				removeButton.addEventListener("click", () => {
					rows.splice(index, 1);
					if (rows.length === 0) {
						// Always leave one editable row so the control is never empty.
						rows.push({ key: "", value: "", preserve: true });
					}
					renderRows();
					void persist();
				});
			});
		};

		const addButton = actionsEl.createEl("button", {
			cls: "plaud-importer-frontmatter-add mod-cta",
			text: "Add property",
			attr: { type: "button" },
		});
		addButton.addEventListener("click", () => {
			rows.push({ key: "", value: "", preserve: true });
			renderRows();
			void persist();
		});

		const insertToken = (token: string): void => {
			const input = lastFocusedValue;
			if (input === null) {
				return;
			}
			const start = input.selectionStart ?? input.value.length;
			const end = input.selectionEnd ?? input.value.length;
			input.value = input.value.slice(0, start) + token + input.value.slice(end);
			const caret = start + token.length;
			input.focus();
			input.setSelectionRange(caret, caret);
			// Route the edit through the input handler so the row updates and saves.
			input.dispatchEvent(new Event("input"));
		};
		paletteEl.createDiv({
			cls: "plaud-importer-frontmatter-palette-label",
			text: "Insert a token into the value field you last clicked in:",
		});
		for (const [label, token] of [
			...DATE_INSERT_TOKENS,
			TITLE_INSERT_TOKEN,
			FOLDER_INSERT_TOKEN,
			...CONTENT_INSERT_TOKENS,
		]) {
			const tokenButton = paletteEl.createEl("button", {
				cls: "plaud-importer-frontmatter-token",
				text: label,
				attr: { type: "button", title: `Insert ${token}` },
			});
			// Keep the caret in the focused value field when a token button is clicked.
			tokenButton.addEventListener("mousedown", (event) =>
				event.preventDefault(),
			);
			tokenButton.addEventListener("click", () => insertToken(token));
		}

		renderRows();
		updatePreview();
	}

	// Renders the note-name template row: the token reference and examples (lists,
	// so they read clearly) into the description, then a text control bound to
	// noteNameTemplate, then ISO/US/EU preset buttons that fill the field and
	// persist in one click. Stacked full-width (see the CSS class) so the doc block
	// and controls are not squeezed into narrow columns. Shared by the declarative
	// path and the imperative display() fallback so both show identical docs.
	private renderNoteNameTemplateControl(setting: Setting): void {
		setting.settingEl.addClass("plaud-importer-stacked-row");
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: NOTE_NAME_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl("ul");
		for (const [token, meaning] of NOTE_NAME_TEMPLATE_TOKENS) {
			const item = tokenList.createEl("li");
			item.createEl("code", { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: NOTE_NAME_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl("ul");
		for (const [template, result] of NOTE_NAME_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl("li");
			item.createEl("code", { text: template });
			item.createSpan({ text: ` → ${result}` });
		}
		docEl.createDiv({ text: NOTE_NAME_TEMPLATE_FOOTNOTE });

		// field is captured so insert-token and preset buttons can edit the visible
		// field, not just the saved value; updatePreview is assigned after the
		// preview DOM exists (created last, so it sits below the field) but is
		// referenced by the earlier closures, which only run on user interaction.
		let field: TextComponent | null = null;
		let updatePreview: (template: string) => void = () => {};
		// Insert-token buttons (date set + Title). Unlike the subfolder field, the
		// note-name field persists on BLUR, so an insert only edits the field and
		// refreshes the preview; the blur listener commits and validates once. The
		// mousedown preventDefault is essential here, not just nice-to-have: without
		// it, clicking a button blurs the field, and commitNoteNameTemplate resets
		// the field to the saved value AFTER the insert runs, discarding the token.
		// Keeping focus in the field means no blur fires, so the inserted tokens
		// accumulate and the eventual real blur (clicking away) commits them.
		for (const [label, token] of [...DATE_INSERT_TOKENS, TITLE_INSERT_TOKEN]) {
			setting.addButton((button) => {
				button
					.setButtonText(label)
					.setTooltip(`Insert ${token}`)
					.onClick(() => {
						if (field === null) return;
						this.insertTokenAtCursor(field, token);
						updatePreview(field.getValue());
					});
				button.buttonEl.addEventListener("mousedown", (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text
				.setPlaceholder(DEFAULT_NOTE_NAME_TEMPLATE)
				.setValue(this.readSettingString("noteNameTemplate"));
			// Validate and persist on BLUR, not on every keystroke. Editing inside a
			// {{...}} token passes through invalid intermediate states (a half-typed
			// {{YYYY}}), and validating per keystroke would flash a Notice on each one.
			// On blur, commitNoteNameTemplate validates once and then reflects the
			// saved value, so a rejected or emptied entry does not linger as stale
			// text. Preset buttons remain an explicit commit. The preview updates
			// live on every keystroke, independent of when the value is persisted.
			text.inputEl.addEventListener("input", () => {
				updatePreview(text.getValue());
			});
			text.inputEl.addEventListener("blur", () => {
				void this.commitNoteNameTemplate(text, updatePreview);
			});
		});
		for (const [label, template] of NOTE_NAME_TEMPLATE_PRESETS) {
			setting.addButton((button) =>
				button.setButtonText(label).onClick(async () => {
					field?.setValue(template);
					await this.applyControlChange("noteNameTemplate", template);
					updatePreview(template);
				}),
			);
		}
		// Preview shows the rendered note name for a sample recording, plus a plain
		// warning when the template would produce an illegal file name (Moment no
		// longer rejects it, so the save-time guard would refuse it instead).
		updatePreview = this.attachTemplatePreview(setting, (template) => {
			const name = buildNoteName(
				TEMPLATE_PREVIEW_TITLE,
				TEMPLATE_PREVIEW_DATE,
				template,
			);
			if (template.trim() !== "" && !isValidNoteNameTemplate(template)) {
				return `Preview: ${name} (not a valid note name, so it will not be saved; a file name cannot contain a slash, colon, square bracket, or a character like * ? < > | ", cannot be a reserved name such as CON, cannot start or end with a dot or space, and cannot be over 200 characters)`;
			}
			return `Preview: ${name}`;
		});
		updatePreview(this.readSettingString("noteNameTemplate"));
	}

	// Validates and persists the note-name template field on blur (see
	// renderNoteNameTemplateControl), then reflects the saved value back into the
	// field so a rejected or emptied entry does not linger as stale text, and
	// refreshes the preview to match the value that was actually saved.
	private async commitNoteNameTemplate(
		text: TextComponent,
		updatePreview: (template: string) => void,
	): Promise<void> {
		await this.applyControlChange("noteNameTemplate", text.getValue());
		text.setValue(this.readSettingString("noteNameTemplate"));
		updatePreview(text.getValue());
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
						name: "Note name template",
						desc: NOTE_NAME_TEMPLATE_INTRO,
						// Rendered imperatively for the token + examples lists plus
						// the preset buttons. Not search-indexable, like the
						// subfolder row above.
						searchable: false,
						render: (setting: Setting) =>
							this.renderNoteNameTemplateControl(setting),
					},
					{
						name: "Datetime property",
						desc: DATETIME_TEMPLATE_INTRO,
						// Rendered imperatively for the token + examples lists, like
						// the two template rows above.
						searchable: false,
						render: (setting: Setting) =>
							this.renderDatetimeTemplateControl(setting),
					},
					{
						name: "Extra frontmatter",
						desc: CUSTOM_FRONTMATTER_INTRO,
						// Rendered imperatively for the token/example lists and the
						// dynamic key/value/preserve rowset.
						searchable: false,
						render: (setting: Setting) =>
							this.renderCustomFrontmatterControl(setting),
					},
					{
						name: "Preserve unknown frontmatter on re-import",
						desc: PRESERVE_UNKNOWN_FRONTMATTER_DESC,
						control: {
							type: "toggle",
							key: "preserveUnknownFrontmatter",
						},
					},
					{
						name: "Forbidden character replacement",
						desc: FORBIDDEN_CHAR_REPLACEMENT_DESC,
						control: {
							type: "text",
							key: "forbiddenCharReplacement",
							placeholder: "-",
						},
					},
					{
						name: DUPLICATE_HANDLING_NAME,
						desc: DUPLICATE_HANDLING_DESC,
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
					{
						name: "Update the recording title on rename",
						desc: "Off by default. When on, renaming an imported recording (with the Rename recording command or by renaming the note in the file explorer) also updates that recording's title in Plaud to match the new note name, including any date prefix. This is the only change the plugin writes back to Plaud. When off, the Rename recording command asks each time whether to update Plaud, and a file-explorer rename stays local.",
						control: { type: "toggle", key: "autoUpdatePlaudTitle" },
					},
				],
			},
			{
				type: "group",
				heading: "Automatic sync",
				items: [
					{
						name: "Enable automatic sync",
						desc: AUTO_SYNC_DESC,
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
		} else if (key === "subfolderTemplate") {
			const next = typeof value === "string" ? value : "";
			try {
				// Rendering against a sample date surfaces the only case that throws
				// at import time, a ".." vault-escape (normalizeFolderPath's traversal
				// guard), so a value that would break every later import is not
				// persisted. No Notice here: this field persists per keystroke, so a
				// Notice would spam while ".." is mid-typed; the live preview already
				// shows "(not usable)", and the previous good value stays saved.
				resolveSubfolder(
					next,
					TEMPLATE_PREVIEW_DATE,
					TEMPLATE_PREVIEW_TITLE,
					this.plugin.settings.forbiddenCharReplacement,
					TEMPLATE_PREVIEW_FOLDER,
				);
				this.plugin.settings.subfolderTemplate = next;
			} catch {
				return;
			}
		} else if (key === "forbiddenCharReplacement") {
			// Coerce to a single safe character. Cleared field falls back to the
			// default dash; an unsafe entry (a forbidden char, a separator, a dot or
			// space, or more than one character) is refused with a Notice and the
			// previous value is kept, so sanitizing can never reintroduce a
			// forbidden character.
			const next = typeof value === "string" ? value.trim() : "";
			if (next === "") {
				this.plugin.settings.forbiddenCharReplacement = "-";
			} else if (isValidReplacementChar(next)) {
				this.plugin.settings.forbiddenCharReplacement = next;
			} else {
				new Notice(
					"Plaud importer: The replacement must be a single character and cannot be a slash, backslash, colon, square bracket, asterisk, question mark, angle bracket, pipe, double quote, dot, space, or control character. Keeping the previous value.",
				);
				return;
			}
		} else if (key === "noteNameTemplate") {
			const next = typeof value === "string" ? value.trim() : "";
			if (next.length === 0) {
				// Never persist an empty template: every note name would render
				// blank. Snap back to the default template.
				this.plugin.settings.noteNameTemplate = DEFAULT_NOTE_NAME_TEMPLATE;
			} else if (isValidNoteNameTemplate(next)) {
				this.plugin.settings.noteNameTemplate = next;
			} else if (!isValidNoteNameTemplate(this.plugin.settings.noteNameTemplate)) {
				// The entered template is invalid AND the stored one is too (for
				// example a hand-edited data.json). Heal to the default so the UI
				// matches the writer, which already falls back to the default for an
				// invalid stored template, instead of looping the notice on blur.
				this.plugin.settings.noteNameTemplate = DEFAULT_NOTE_NAME_TEMPLATE;
			} else {
				// The stored template is still valid: keep it and say why the entry
				// was not applied, rather than saving one that would break imports or
				// write a mangled name.
				new Notice(
					"Plaud importer: That note name template is not valid, so it was not changed. A file name cannot contain a slash, colon, square bracket, asterisk, question mark, angle bracket, pipe, or double quote, cannot be a reserved device name, cannot start or end with a dot or space, and cannot be over 200 characters.",
				);
				return;
			}
		} else if (key === "datetimeTemplate") {
			// Any {{ }} Moment template is accepted, empty included (which writes no
			// datetime property). Moment never throws on an unknown token, and there
			// is no path or filename safety concern here, so there is nothing to
			// reject and the live preview is the only feedback. Persisted as typed.
			this.plugin.settings.datetimeTemplate =
				typeof value === "string" ? value : "";
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
