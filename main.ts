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
	isWorkspaceToken,
	readTokenLifetime,
	SHORT_LIFETIME_HOURS,
} from "./plaud-token";
import { isLegacyPartition, plaudPartition } from "./plaud-partition";
import { sessionExpiryDecision } from "./session-expiry";
import { computeRefreshDelayMs, isRefreshDue } from "./refresh-schedule";
import {
	buildPartitionPost,
	extractWorkspaceId,
	performNetRefresh,
} from "./plaud-refresh-net";
import {
	escapeHtmlAttribute,
	parseClipboardTokens,
	parseTokenCandidates,
	selectWorkingCandidate,
	buildSignInBookmarklet,
} from "./token-candidates";
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
// Every candidate the browser sent was rejected by Plaud itself, so the
// browser session is signed out or revoked rather than the link being wrong
// (issue #78: rogerfsh's 300-day token still decodes cleanly but is revoked).
const DEEP_LINK_ALL_REJECTED_NOTICE =
	"Plaud rejected every sign-in token from your browser, so that session looks signed out or revoked. Sign in to Plaud in your browser again, then click the bookmark.";
// One candidate, and Plaud could not be reached to check it. Storing it
// unverified matches the pre-0.35.0 behavior and keeps an offline reconnect
// working; the user finds out from the next import if it was already dead.
const DEEP_LINK_UNVERIFIED_NOTICE =
	"Plaud token received from your browser and saved, but Plaud could not be reached to check it. Run Test connection once you are back online.";
// Shown while several candidates are probed. A const like its siblings so the
// sentence-case lint, which only inspects literals at the call site, accepts
// the product name mid-sentence.
const DEEP_LINK_PROBING_NOTICE = "Checking which Plaud sign-in still works…";
// A capture that failed while being SAVED, rather than one the token was wrong
// for. Every notice above means the credential was the problem; this one means
// it may well have been fine, so repeating the sign-in is not the fix. The
// wording names the likely cause as something to check rather than as a
// diagnosis: the capture path throws opaquely (a settings write is the common
// source, but not the only one), so asserting "the vault is not writable" would
// be the same over-claiming this notice exists to stop. Telling the two apart
// properly needs the result union tracked in issue #86.
const CAPTURE_SAVE_FAILED_NOTICE =
	"Plaud: could not save the token. If this keeps happening, check that this vault is writable and has free space.";
// The one failure that cannot promise "nothing changed": the settings commit
// landed, the credential write then threw, and writing the old settings back
// failed too. Signing in again rewrites both halves, so that is the instruction.
const CAPTURE_TORN_NOTICE =
	"Plaud: the sign-in was recorded but its credential could not be stored, so the previous session is still in use. Sign in again to finish reconnecting.";
// Several candidates and no way to ask which one works. Picking blind would
// store the wrong credential (a revoked long-lived token outranks a live short
// one on every claim we can read), so store nothing and let the user retry.
const DEEP_LINK_UNREACHABLE_NOTICE =
	"Could not reach Plaud to check which sign-in token to use, so nothing was saved. Check your connection, then click the bookmark again.";

/**
 * What storing a captured credential did (issue #86). A boolean could not carry
 * the distinction the issue asks for: a credential the plugin REJECTED is fixed
 * by signing in again, and one it never got to WRITE is not. The second used to
 * arrive only as an opaque throw, so no surface could tell them apart.
 *
 * No outcome here means "partly applied and unreported". "torn" exists for the
 * one sequence that can still half-apply (commit landed, credential write
 * threw, restore write failed too), so even that arrives as a value a surface
 * can explain rather than as an opaque rejection.
 */
type CaptureStoreResult =
	/** Failed the pre-write capture guard. Nothing was written. */
	| { outcome: "unusable" }
	/**
	 * Something took over the credential while this store waited its turn.
	 * Nothing was written, and nothing should be said: whatever superseded this
	 * is what the user is holding.
	 */
	| { outcome: "superseded" }
	/**
	 * The settings write rejected (read-only vault, full disk, a sync client
	 * holding the file), or the credential write threw and the settings were
	 * rolled back. Either way nothing is changed. Carries the cause for
	 * logging; surfaces show CAPTURE_SAVE_FAILED_NOTICE rather than the raw
	 * error.
	 */
	| { outcome: "save-failed"; error: unknown }
	/**
	 * The settings commit landed, the credential write then threw, and writing
	 * the previous settings back failed too. data.json names this capture
	 * while the secret still holds the previous credential; the previous
	 * session keeps working in memory. Signing in again rewrites both sides,
	 * so surfaces show CAPTURE_TORN_NOTICE, which says exactly that. Carries
	 * the credential write's cause.
	 */
	| { outcome: "torn"; error: unknown }
	| { outcome: "stored" };

/**
 * What a re-authentication attempt did. Needed because turning a save failure
 * from a throw into a value changed which handler runs: the failure used to
 * reach the settings tab's catch, and now it comes back as an ordinary "did not
 * store", which those callers read as a cancelled sign-in and answer with a
 * second, contradicting notice. "reported" says the reason is already on screen.
 */
type ReauthOutcome =
	/** A credential was captured and stored. */
	| "captured"
	/** The user closed the window, or the login API is unavailable on this build. */
	| "closed"
	/** Failed, and the reason is already on screen. Say nothing more about it. */
	| "reported";

const SIGN_IN_NOTE =
	"Plaud has no official API, so this plugin relies on their internal one. That makes sign-in fragile, and it may stop working when Plaud changes that internal API. We expect this whole process to get much simpler once Plaud releases an official API. There are two ways to sign in, depending on how you log in to Plaud. Use 'Sign in with email' if you log in with an email address and password. Use 'Sign in with Google or Apple' if you use single sign-on (SSO) through a Google or Apple account. How long you stay signed in depends on the method: a session from the email sign-in window normally renews itself in the background for about 30 days before asking you to sign in again, while a session captured from a Google or Apple login cannot be renewed by the plugin and usually lasts about 24 hours. If you use Google or Apple, you can add a password to your Plaud account and use the email sign-in instead. The status line under Plaud token shows your session's actual expiry and whether background renewal is active for it. When the session lapses the plugin shows a one-click Reconnect that reopens the sign-in matching your account.";

// Automatic-sync toggle description. ONE constant consumed by both settings
// paths (the 1.13+ declarative definitions and the 1.12 imperative display()
// fallback) so the two can never drift; before this hoist they shipped as two
// byte-identical 731-character literals. Wording (issue #78): session length
// is set by Plaud and varies by account, so this promises no specific
// lifetime.
const AUTO_SYNC_DESC =
	"Off by default. Runs a background import on a schedule, unattended and never prompting. It uses your default import options: new recordings are imported, and a recording you changed in Plaud (edited speaker names, corrected transcript, or finished processing) is re-imported. IMPORTANT: a re-import OVERWRITES that note and its downloaded artifacts with Plaud's current version, so edits you made to a synced note or its attachment files are lost on the next change. Only recordings that actually changed are touched; unchanged notes are never modified. Desktop only. The background sync runs between sign-ins for as long as your Plaud session lasts (set by Plaud and shown in the status line under Plaud token), pausing for a one-click reconnection when the session expires.";

// Standalone HTML page opened in the system browser for one-time bookmark
// setup. It offers the sign-in bookmarklet (token-candidates.ts) as a
// draggable link so a non-technical user can drag it onto their bookmarks bar
// instead of pasting a javascript: URL into a new bookmark by hand.
//
// The href is escaped as a full HTML attribute value (escapeHtmlAttribute,
// where the ordering rule and the round-trip are pinned by tests), not just
// for `&`: the bookmarklet carries `&&`, comparison operators, and quotes, and
// escaping the quote characters is what keeps the value from being able to
// close the attribute at all.
function bookmarkSetupHtml(vaultName: string): string {
	const href = escapeHtmlAttribute(buildSignInBookmarklet(vaultName));
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
		'<p><a class="bm" href="' + href + '">Plaud → Obsidian (v2)</a></p>',
		'<p class="note">Bookmarks bar hidden? Press Ctrl+Shift+B (Cmd+Shift+B on Mac) to show it, then drag the button onto it.</p>',
		'<p class="note">Already have an older Plaud → Obsidian bookmark? Replace it with this one. The new bookmark sends the token to Obsidian for you instead of asking you to copy and paste it.</p>',
		// Names the target vault: the bookmark is built for ONE vault, and a
		// user with several open would otherwise have no way to tell which
		// bookmark belongs to which.
		'<p class="note">This bookmark delivers to your <strong>' +
			vaultName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
			"</strong> vault, so it works even when another vault has focus. Set it up again from a different vault to make a bookmark for that one.</p>",
		"<hr><p>After it is saved, each time you need to connect:</p>",
		"<ol>",
		"<li>Sign in to Plaud in this browser.</li>",
		"<li>Click the bookmark you just added. Obsidian opens and saves your token.</li>",
		"</ol>",
		'<p class="note">If Obsidian does not open, the bookmark falls back to showing a line of text in a box. Copy the whole line, switch to Obsidian, and click the paste button in the plugin settings.</p>',
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
	// One-shot stamp for the pre-expiry session warning (issue #78): the exact
	// exp (epoch ms) the user was already warned about, so a restart inside
	// the warn window does not re-nag. 0 = never warned. Additive key:
	// pre-0.34.0 settings read the default via the load-time spread, no
	// migration needed.
	sessionWarnedForExpMs: number;
	// Schema version for one-time settings migrations. Absent (pre-0.21.0) reads
	// as 0. Version 1 rewrote the subfolder/note-name date templates from the old
	// bespoke lowercase tokens to real Moment tokens (issue #30). Bumped only when
	// a stored-settings shape needs an output-preserving rewrite on load.
	settingsVersion: number;
}

// Rendered in two places (the settings tab and the declarative registry), which
// previously held two verbatim copies of this sentence. One definition so they
// cannot drift, which matters here because the behavior it describes changed:
// clearing is scoped to the calling vault since issue #87.
const CLEAR_SIGN_IN_DESC =
	"Sign out of the embedded Plaud browser for this vault and wipe the stored token so the next sign-in starts completely fresh. Other vaults keep their own sign-ins. This also removes the older shared sign-in left over from before each vault had its own. Use this to reach the sign-in screen when it keeps signing you in automatically. Obsidian has no way to delete the secret entry, so an emptied one may stay in the token picker, but it holds no token.";

// Current settings schema version. A fresh install is born at this version and
// runs no migrations; loadSettings compares the STORED version against it.
//   1 (issue #30): date templates moved to Moment tokens.
//   2 (issue #87): the sign-in partition became per-vault, so an existing window
//      session no longer lives where this vault looks for it. Nothing in
//      data.json changes; the bump exists to fire the one-time heads-up exactly
//      once per vault rather than on every load.
const CURRENT_SETTINGS_VERSION = 2;

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
	sessionWarnedForExpMs: 0,
	settingsVersion: CURRENT_SETTINGS_VERSION,
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
	// Pre-expiry session warning timer (issue #78). A real scheduled timeout,
	// deliberately NOT an auto-sync tick hook: auto-sync defaults off and its
	// cadence misses short warn windows. Armed by
	// reconcileSessionExpiryWarning(); cleared there and in onunload.
	private sessionExpiryTimeoutId: number | undefined;
	// The currently visible pre-expiry notice, if any, so a credential change
	// can dismiss it instead of leaving a sticky warning that describes the
	// OLD session. Also lives in actionNotices for the onunload sweep.
	private sessionExpiryNotice: Notice | null = null;
	// Silent session-refresh timer. Armed by reconcileSessionRefresh(); cleared
	// there and in onunload, same discipline as the two timers above.
	private sessionRefreshTimeoutId: number | undefined;
	// One refresh at a time. The timer, a credential change, and the manual
	// debug command can all reach the refresh; without this they could run
	// concurrent mints and spend the account's hourly refresh budget twice over
	// for one renewal.
	private sessionRefreshInFlight = false;
	// Set when a refresh attempt fails. Suppresses re-arming so a dead session
	// cannot loop against Plaud's ~10-per-hour refresh ceiling; cleared by any
	// successful capture or refresh. Recovery is the Reconnect prompt, not a
	// retry ladder.
	private sessionRefreshFailed = false;
	// The "could not renew" prompt, held so it can be dismissed rather than
	// left sticky. It has no duration (an auth prompt should not time out), so
	// without a handle a healed session would keep telling the user to
	// reconnect, and the later expiry warning would stack a second prompt on
	// top of it. Cleared wherever sessionExpiryNotice is.
	private sessionRefreshFailureNotice: Notice | null = null;
	// The auto-sync auth-pause "Reconnect" prompt, held for the same reason as
	// the two notices above (issue #88). It also has no duration, and a paused
	// session can now heal with NO user action: a background refresh finishing
	// after a tick already paused. Without a handle nothing can take the prompt
	// down, so it outlives the pause it describes and invites a reconnect the
	// plugin no longer needs. Cleared by clearAutoSyncPauseNotice().
	private autoSyncPauseNotice: Notice | null = null;
	/**
	 * True when unattended renewal has stopped for the current credential and
	 * will not resume without a reconnect. Read by the settings tab so its
	 * renewal line cannot keep promising a renewal that is no longer running.
	 */
	get sessionRenewalPaused(): boolean {
		return this.sessionRefreshFailed;
	}
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
	// Tail of the capture-store queue. Scoped to captures only: it exists to
	// restore the call ordering that committing settings before the credential
	// would otherwise break, not to serialize settings writes generally (#86).
	private captureStoreChain: Promise<unknown> = Promise.resolve();
	// Redraws the open settings tab's sign-in status and secret picker. Set by
	// the tab's display() (the pre-1.13 imperative path; 1.13+ renders
	// declaratively and re-reads on its own) and cleared by its hide(), so it
	// is null whenever no tab is mounted. Lets a credential stored from OUTSIDE
	// the tab — a bookmarklet deep link arriving while settings sits open —
	// update what the user is looking at.
	settingsRefresh: (() => void) | null = null;
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

		// Receive tokens handed back from the user's external browser (the
		// browser sign-in flow) via obsidian://plaud-importer-token?tokens=…
		// The handler now makes network calls to pick the working candidate, so
		// its rejection is caught here: an unhandled one would leave the user
		// with a clicked bookmark and no feedback at all.
		this.registerObsidianProtocolHandler("plaud-importer-token", (params) => {
			void this.handleTokenDeepLink(params).catch((err: unknown) => {
				console.error("Plaud importer: token deep link failed", err);
				new Notice(
					"Plaud: could not save the token from your browser. Try again, or paste it in settings.",
				);
			});
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

		// Forces the silent refresh instead of waiting out the ~22 hour cadence.
		// Kept rather than removed after the release verification, because the
		// refresh is a background path whose failures are otherwise invisible:
		// this is the only way a user on a support thread can produce a debug
		// log showing what it actually did. checkCallback hides it entirely
		// unless debug logging is on AND this session is one the refresh can
		// serve, so it never advertises a renewal SSO and bookmarklet users
		// cannot receive.
		this.addCommand({
			id: "debug-refresh-session",
			name: "Debug: refresh the session now",
			checkCallback: (checking) => {
				if (
					!this.settings.debug ||
					this.settings.signInMethod !== "window"
				) {
					return false;
				}
				if (!checking) {
					void this.refreshSessionNow()
						.then((outcome) => {
							new Notice(
								outcome === "refreshed"
									? "Plaud session refreshed. A fresh token is stored."
									: outcome === "busy"
										? "A session refresh is already running."
										: outcome === "superseded"
											? "Session refresh skipped: the stored sign-in changed while it ran."
											: outcome === "unsupported"
												? "This session cannot be refreshed in the background. Reconnect to sign in again."
												: "Session refresh failed. See the debug log, then reconnect.",
							);
						})
						.catch((err: unknown) => {
							// A command the user pressed must always answer. The
							// scheduled path has its own catch; without one here a
							// rejection would be swallowed as an unhandled promise
							// and the palette entry would look like it did nothing.
							console.error(
								"Plaud importer: manual session refresh failed",
								err,
							);
							new Notice(
								"Session refresh failed. See the debug log, then reconnect.",
							);
						});
				}
				return true;
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
			// Arm the pre-expiry session warning for the stored credential
			// (issue #78). Runs regardless of auto-sync state.
			this.reconcileSessionExpiryWarning();
			// And the silent refresh, for window sessions that can use it.
			this.reconcileSessionRefresh();
			// One-time heads-up when this vault's sign-in moved partitions (#87).
			this.notePerVaultSignInChange();
			// A vault whose id the host did not supply falls back to the old
			// shared partition. Behavior is the pre-#87 one, which is survivable,
			// but it means this vault can still race another, so say so where a
			// debug log will show it rather than failing silently.
			if (isLegacyPartition(this.signInPartition())) {
				this.debugLogger.log({
					kind: "error",
					message:
						"per-vault sign-in unavailable: no usable vault id, using the shared partition",
				});
			}
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
		// Clear the pre-expiry session warning timer for the same reason.
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		// And the silent session-refresh timer.
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
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
		this.sessionExpiryNotice = null;
		this.autoSyncPauseNotice = null;
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

	// ---- Pre-expiry session warning (issue #78, 0.34.0) ------------------

	// Re-evaluates the session-expiry warning: clears any armed timer, then
	// either warns now (once per credential, keyed on the exact expMs) or
	// arms a clamped timeout to re-evaluate at expiry-minus-lead. Called from
	// onLayoutReady and EVERY credential mutation (storeAccessToken,
	// reauthenticate, clearSignIn, the settings secret picker), so the timer
	// can never describe a stale credential. Mirrors the timer-id clearing
	// discipline of reconcileAutoSync.
	reconcileSessionExpiryWarning(): void {
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		// A still-visible warning describes the credential as it was when it
		// fired; every reconcile is a potential credential change, so dismiss
		// it and let the decision below re-derive. Hiding an already-hidden
		// notice is a no-op.
		if (this.sessionExpiryNotice !== null) {
			this.sessionExpiryNotice.hide();
			this.actionNotices.delete(this.sessionExpiryNotice);
			this.sessionExpiryNotice = null;
		}
		// The renewal-failure prompt goes with it, and for the same reason.
		// This reconcile runs on every credential mutation and when the warning
		// timer fires, so clearing it here is what stops a stale "could not
		// renew" notice outliving the credential it described or stacking under
		// the warning that replaces it.
		if (this.sessionRefreshFailureNotice !== null) {
			this.sessionRefreshFailureNotice.hide();
			this.actionNotices.delete(this.sessionRefreshFailureNotice);
			this.sessionRefreshFailureNotice = null;
		}
		if (this.disposed) return;
		const value = this.readStoredTokenValue();
		const life = value.length > 0 ? readTokenLifetime(value) : null;
		const decision = sessionExpiryDecision(
			Date.now(),
			life,
			this.settings.sessionWarnedForExpMs,
		);
		if (decision.action === "scheduled" && decision.armDelayMs !== null) {
			this.sessionExpiryTimeoutId = window.setTimeout(() => {
				this.sessionExpiryTimeoutId = undefined;
				this.reconcileSessionExpiryWarning();
			}, decision.armDelayMs);
			return;
		}
		if (decision.action !== "warn" || decision.expMs === null) {
			return;
		}
		// Stamp BEFORE showing, so a notice path that throws cannot re-nag on
		// every reconcile. The stamp is keyed to this exact expMs; a fresh
		// credential carries a different exp and warns again.
		this.settings.sessionWarnedForExpMs = decision.expMs;
		this.saveSettingsDetached("saving the session warning stamp failed");
		// Above ~2 days speak in days ("about 7 days"), below in hours: the
		// long (7-day) lead would otherwise read as "about 168 hours".
		const hoursLeft = Math.max(
			1,
			Math.round((decision.expMs - Date.now()) / 3_600_000),
		);
		const timeLeft =
			hoursLeft > 48
				? `${Math.round(hoursLeft / 24)} days`
				: `${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`;
		this.sessionExpiryNotice = this.showActionNotice(
			decision.expired
				? "Your Plaud session has expired. Reconnect to keep imports and auto-sync running."
				: `Your Plaud session expires in about ${timeLeft}. Reconnect now to avoid an interruption.`,
			"Reconnect",
			() => this.reconnectFreshFromExpiryNotice(),
		);
	}

	// Re-evaluates the silent session refresh: clears any armed timer, then arms
	// a new one when this session is one the refresh can actually serve. Called
	// from onLayoutReady and every credential mutation, exactly like
	// reconcileSessionExpiryWarning, so the timer can never describe a stale
	// credential.
	//
	// This vault's Plaud sign-in partition (issue #87).
	//
	// Derived on every use rather than cached in a field, because the value is
	// only ever a pure function of the host's vault id and re-deriving costs a
	// regex test. Caching it would add a second place for sign-in and refresh to
	// disagree about which cookie jar is current, which is precisely the class of
	// bug this change exists to remove.
	private signInPartition(): string {
		return plaudPartition(this.app.appId);
	}

	// Gated on the RECORDED sign-in method. The refresh authenticates with the
	// embedded sign-in window's partition cookies, and only that window ever
	// populates that partition: SSO completes in the external browser and the
	// bookmarklet runs in the user's own browser, so neither leaves anything to
	// authenticate with. Attempting it for them would fail every cycle and
	// nag; they reconnect manually, by design.
	reconcileSessionRefresh(): void {
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		if (this.disposed || this.sessionRefreshFailed) return;
		if (this.settings.signInMethod !== "window") return;
		const token = this.readStoredTokenValue();
		if (token.length === 0) return;
		// Only a workspace token wants this. Minting against a long-lived
		// credential would trade months of life for 24 hours; see
		// isWorkspaceToken.
		if (!isWorkspaceToken(token)) return;
		// No transport, no renewal. Arming a timer that can only ever return
		// "unsupported" wastes a wake-up and, worse, lets the settings copy go
		// on promising a renewal this build cannot perform.
		if (buildPartitionPost(this.signInPartition()) === null) return;
		const delay = computeRefreshDelayMs(token, Date.now());
		if (delay === null) return;
		this.sessionRefreshTimeoutId = window.setTimeout(() => {
			this.sessionRefreshTimeoutId = undefined;
			// Belt and braces on top of the store's own catch: nothing on a
			// background timer may reject into the console unhandled.
			void this.runScheduledSessionRefresh().catch((err: unknown) => {
				console.error(
					"Plaud importer: scheduled session refresh failed",
					err,
				);
			});
		}, delay);
	}

	// The timer callback. Re-reads the credential rather than closing over it:
	// the wake-up can be up to 20 days after arming (the clamp), and the
	// credential may have been replaced by a reconnect in between.
	private async runScheduledSessionRefresh(): Promise<void> {
		if (this.disposed || this.sessionRefreshInFlight) return;
		const token = this.readStoredTokenValue();
		// Not actually due yet: the 20 day clamp means an early wake is normal.
		// Re-arm rather than spend a mint call against the hourly ceiling.
		if (token.length > 0 && !isRefreshDue(token, Date.now())) {
			this.reconcileSessionRefresh();
			return;
		}
		const outcome = await this.refreshSessionNow();
		// A deferral is not a failure and must not silently end renewal. "busy"
		// means a sign-in window was open (or another refresh was running), and
		// the timer that brought us here is already spent: if the user then
		// CANCELS that sign-in nothing else reconciles the schedule, so this
		// token would run to expiry with no further attempt. Re-arm instead.
		// "superseded" re-arms through the newer credential's own store, but
		// reconciling again is idempotent and keeps the rule simple. "failed"
		// deliberately does not re-arm; "unsupported" has nothing to arm.
		if (outcome === "busy" || outcome === "superseded") {
			this.reconcileSessionRefresh();
		}
	}

	// Runs the two-step cookie refresh once and stores the result. Returns what
	// happened so the debug command can report it; the scheduled path reacts to
	// deferrals and otherwise goes through the state this sets.
	//
	// No retry, by measurement: step 1 reports `login_total_per_hour: 10`, so a
	// backoff ladder against a dead session spends the account's whole refresh
	// budget and can lock it out of renewing at all. One attempt; on failure
	// pause and prompt Reconnect.
	async refreshSessionNow(): Promise<
		"refreshed" | "unsupported" | "failed" | "busy" | "superseded"
	> {
		if (this.sessionRefreshInFlight) return "busy";
		// Never run underneath an open sign-in window. Reconnect CLEARS the
		// sign-in partition before reopening it, and that partition's cookies
		// are the only thing this refresh authenticates with, so the two would
		// be fighting over the same session. reauthenticate() holds the mirror
		// of this lock; both are needed, because in the other order the sign-in
		// window can re-capture the stale pre-refresh token and store it over a
		// refresh that had already succeeded.
		if (this.reauthInFlight) return "busy";
		if (this.settings.signInMethod !== "window") return "unsupported";
		const current = this.readStoredTokenValue();
		if (current.length === 0) return "unsupported";
		// A long-lived credential must not be traded for a 24 hour one.
		if (!isWorkspaceToken(current)) return "unsupported";
		// Which secret that value came from, not just the value. The picker can
		// be pointed at a DIFFERENT secret holding the same token, and a value
		// comparison alone would call that unchanged and then re-link
		// CAPTURED_SECRET_ID underneath the user's choice.
		const currentSecretId = this.settings.secretId;
		const post = buildPartitionPost(this.signInPartition());
		if (post === null) {
			this.debugLogger.log({
				kind: "error",
				endpoint: "/session-refresh",
				message:
					"session refresh unavailable: no Electron session.fetch on this build",
			});
			return "unsupported";
		}
		// Held until the fresh token is STORED, not merely fetched. Clearing it
		// when the network settled would reopen the gap it exists to close: the
		// user could start a sign-in during validation and storage, and that
		// window can capture the partition's stale token and write it over the
		// one this call just minted.
		this.sessionRefreshInFlight = true;
		try {
			const result = await performNetRefresh({
				currentToken: current,
				baseUrl: this.settings.apiBaseUrl,
				post,
				log: (message, payload) => {
					this.debugLogger.log({
						kind: "note",
						endpoint: "/session-refresh",
						message,
						payload,
					});
				},
			});
			// A plugin unloaded mid-refresh must not write storage.
			if (this.disposed) return "failed";
			// Supersede check FIRST, ahead of both the success and the failure
			// branch. The two calls above take seconds and nothing serializes them
			// against the user: a reconnect, a paste, a different linked secret or a
			// sign out can all land while they are in flight. Writing a success
			// afterwards would clobber the credential the user just chose, or
			// re-link one they just cleared. Recording a FAILURE afterwards is just
			// as wrong and less obvious: it would mark the user's brand new session
			// as failed and clear the refresh timer that session had just armed,
			// leaving it with no unattended renewal at all. This result belongs to a
			// credential nobody is using any more, so it is simply dropped.
			if (
				this.readStoredTokenValue() !== current ||
				this.settings.secretId !== currentSecretId
			) {
				this.debugLogger.log({
					kind: "note",
					endpoint: "/session-refresh",
					message:
						"session refresh discarded: the stored credential changed while it ran",
				});
				return "superseded";
			}
			// Validate before storing, the same guard every other capture path
			// applies. A mint that answered 200 with something that is not a usable
			// token must never replace a working credential.
			//
			// Plus one requirement specific to this path: the value has to carry a
			// `wid`. isUsableUserToken deliberately accepts anything future-dated
			// with a client_id that is not a WRT, which includes a user token with
			// no workspace id. Storing one of those looks like a success and then
			// silently ends unattended renewal, because the NEXT refresh reads its
			// workspace id off the stored token and aborts without one. Checked
			// here rather than by tightening the shared guard, which must keep
			// accepting WT.
			//
			// And it has to be a token that actually MOVED the expiry. A mint
			// that hands back the current credential, or any WT already inside
			// the refresh window, would be stored as a success, clear the
			// failure state, and then schedule its own next attempt at the 30
			// second floor, looping against a ceiling of about 10 refreshes an
			// hour. Refusing it leaves the old token in place to expire
			// normally, which surfaces as the ordinary reconnect prompt
			// instead of a retry storm.
			if (
				result === null ||
				!isUsableUserToken(result.token) ||
				!isWorkspaceToken(result.token) ||
				extractWorkspaceId(result.token) === null ||
				isRefreshDue(result.token, Date.now())
			) {
				this.debugLogger.log({
					kind: "error",
					endpoint: "/session-refresh",
					message:
						result === null
							? "session refresh failed: the two-step refresh did not return a token"
							: !isUsableUserToken(result.token)
								? "session refresh failed: the minted value did not pass the capture guard"
								: !isWorkspaceToken(result.token)
									? "session refresh failed: the minted value is not a workspace token"
									: extractWorkspaceId(result.token) === null
										? "session refresh failed: the minted value carries no workspace id to refresh against"
										: "session refresh failed: the minted token is already inside the refresh window",
				});
				this.onSessionRefreshFailed();
				return "failed";
			}
			// A vault that will not take the settings write comes back as a
			// `save-failed` outcome now rather than a throw, so it can be named in
			// the log. The try/catch stays for everything else the store touches
			// after its commit: this runs from a timer whose caller only voids the
			// promise, so an escaping rejection would be an unhandled one AND would
			// skip both the failure prompt and the re-arm, quietly ending
			// unattended renewal until the next reload.
			//
			// The supersede check above is re-run inside the store, and has to be.
			// Since the store commits settings before writing the secret, a user
			// capture that is mid-commit has not reached `setSecret` yet, so
			// `readStoredTokenValue()` still returns the old value and that check
			// passes when it should not. It stays where it is because discarding
			// there is cheaper than queueing and then discarding.
			let stored: CaptureStoreResult;
			try {
				stored = await this.storeAccessToken(
					result.token,
					"window",
					result.apiBaseUrl ?? undefined,
					true,
					() =>
						!this.disposed &&
						this.readStoredTokenValue() === current &&
						this.settings.secretId === currentSecretId,
				);
			} catch (err) {
				this.debugLogger.log({
					kind: "error",
					endpoint: "/session-refresh",
					message:
						"session refresh failed: storing the fresh token threw",
					payload: {
						error: err instanceof Error ? err.message : String(err),
					},
				});
				this.onSessionRefreshFailed();
				return "failed";
			}
			if (stored.outcome === "superseded") {
				// Same meaning as the early supersede check, so the same result:
				// drop it, and do NOT record a failure. Marking the user's brand new
				// session as failed would clear the timer it had just armed.
				this.debugLogger.log({
					kind: "note",
					endpoint: "/session-refresh",
					message:
						"session refresh discarded: the stored credential changed while the store was queued",
				});
				return "superseded";
			}
			if (stored.outcome !== "stored") {
				this.debugLogger.log({
					kind: "error",
					endpoint: "/session-refresh",
					message:
						stored.outcome === "save-failed"
							? "session refresh failed: the vault would not accept the settings write, so the fresh token was not stored and the previous session is unchanged"
							: stored.outcome === "torn"
								? "session refresh failed: the settings write landed but the credential write did not, so data.json names a session whose token was never stored"
								: "session refresh failed: the minted token did not pass the capture guard at store time",
				});
				this.onSessionRefreshFailed();
				return "failed";
			}
			this.sessionRefreshFailed = false;
			this.debugLogger.log({
				kind: "note",
				endpoint: "/session-refresh",
				message: "session refresh succeeded; a fresh token is stored",
			});
			// A tick that ran while the token was expired (Obsidian waking from
			// sleep, say) will have paused auto-sync before this refresh
			// finished. The credential is good again, so lift that pause;
			// otherwise every later tick stays skipped until the user resumes by
			// hand, which is exactly the unattended operation this exists for.
			this.resumeAutoSyncIfPaused();
			// storeAccessToken already reconciled the warning and this schedule.
			return "refreshed";
		} finally {
			this.sessionRefreshInFlight = false;
		}
	}

	// Fire-and-forget settings write, for the paths that are synchronous by
	// design (timer callbacks, notice handlers) and have no caller to await it.
	// The catch is not optional here. This exact feature reaches these lines
	// BECAUSE a vault write failed, so a bare `void saveSettings()` would very
	// likely reject for the same reason and, being detached, would escape every
	// caller's catch as the unhandled rejection the refresh path exists to
	// avoid.
	private saveSettingsDetached(context: string): void {
		void this.saveSettings().catch((err: unknown) => {
			console.error(`Plaud importer: ${context}`, err);
		});
	}

	// A failed refresh pauses unattended renewal and asks for a reconnect. It
	// deliberately does NOT re-arm: see the no-retry note above.
	private onSessionRefreshFailed(): void {
		this.sessionRefreshFailed = true;
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		// Let the existing pre-expiry machinery own the user-facing prompt. The
		// credential is still live (the refresh runs a lead time before expiry),
		// so this surfaces as the normal Reconnect notice rather than a second,
		// competing one.
		//
		// Clearing the warn stamp first is what makes that actually appear. On a
		// 24 hour token both timers come due at the same two-hour lead, so the
		// warning has usually already fired and stamped this exact expiry while
		// the refresh was still on the network. reconcileSessionExpiryWarning
		// hides the visible notice before re-deriving, and a stamped expiry
		// re-derives as 'quiet', so without this the failure would take the
		// user's only Reconnect prompt away and put nothing back. The stamp
		// exists to stop repeat nagging for one expiry; a refresh that just
		// failed is new information and earns the one re-warn.
		// Persisted, not just assigned. reconcileSessionExpiryWarning only saves
		// when it actually warns, so without this the cleared stamp lives in
		// memory alone: a reload would restore the OLD stamp from disk and
		// suppress the reconnect warning for the very credential whose renewal
		// just failed.
		this.settings.sessionWarnedForExpMs = 0;
		this.saveSettingsDetached("clearing the session warning stamp failed");
		this.reconcileSessionExpiryWarning();
		// Renewal now runs a clear margin BEFORE the warning's own lead, so at
		// the moment a refresh fails the credential is usually still OUTSIDE
		// the warn window and the reconcile above only arms a timer. Waiting
		// that out would leave the user with no sign that unattended renewal
		// had stopped, for hours. Prompt directly instead, and stamp this
		// expiry so the scheduled warning does not later post a second,
		// near-identical notice for the same credential.
		// Deliberately does NOT stamp sessionWarnedForExpMs and does NOT take
		// over this.sessionExpiryNotice. Stamping would silence the scheduled
		// warning when it comes due, and that warning is the prompt covering
		// the final hours before expiry: the user would be told once, four
		// hours out, and then left with nothing at the point it matters most.
		// Leaving the stamp at zero lets the warning fire normally as an
		// escalation, and because reconcile hides the tracked notice before
		// showing its own, only one is ever on screen. Skipped when a warning
		// notice is already up, so the two never stack.
		if (this.sessionExpiryNotice === null) {
			this.sessionRefreshFailureNotice = this.showActionNotice(
				"Could not renew your Plaud session automatically. Reconnect to keep imports and auto-sync running.",
				"Reconnect",
				() => this.reconnectFreshFromExpiryNotice(),
			);
		}
		// Renewal has stopped for this credential, so an open settings tab is
		// now showing a renewal promise that is no longer true. Redraw it.
		try {
			this.settingsRefresh?.();
		} catch (err) {
			console.error("Plaud importer: settings refresh failed", err);
		}
	}
	// Reconnect action for the pre-expiry notice specifically. For a
	// window-flow account the embedded window's persistent session can still
	// hold the SAME near-expiry token, and openPlaudLogin captures any usable
	// token instantly: without clearing the login session first, "Reconnect"
	// would close immediately, report success, and change nothing. Clearing
	// only the login partition is non-destructive: the stored secret is
	// untouched, so closing the window without signing in loses nothing.
	// Skipped while a sign-in window is already open (the single-flight guard
	// in reauthenticate would refuse anyway; clearing under a live window
	// would break it).
	private async reconnectFreshFromExpiryNotice(): Promise<void> {
		// Checked HERE, ahead of the clear, not just inside reauthenticate. The
		// clear destroys the very cookies an in-flight refresh authenticates
		// with, so reaching reauthenticate's guard first would be too late: the
		// refresh would fail AND the sign-in would then be refused, which is
		// the worst of both. This is a reachable ordering, not a corner case:
		// on a 24 hour token the refresh timer and the warning that shows this
		// button both come due at the same two-hour lead. A refresh takes
		// seconds and, if it succeeds, removes the reason to reconnect at all.
		if (this.sessionRefreshInFlight) {
			new Notice(
				"Renewing your session now. Try reconnecting in a moment if it does not clear.",
			);
			return;
		}
		// Disarm the scheduled refresh BEFORE yielding to the clear. The check
		// above only proves no refresh is running right now; clearing is an
		// await, and the timer could come due during it and start one against a
		// partition being destroyed. Cancelling the timer closes that window,
		// because the timer is the only thing that starts a refresh on its own
		// (the other entry point is the manual debug command).
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		try {
			if (this.reconnectPrefersWindow() && !this.reauthInFlight) {
				try {
					await clearPlaudLoginSession(this.app);
				} catch (err) {
					console.error(
						"Plaud importer: failed to clear login session before reconnect",
						err,
					);
				}
			}
			await this.reconnectFromNotice();
		} finally {
			// Put the schedule back however this ended. A reconnect that stored
			// a credential has already re-armed through storeAccessToken and
			// this is a no-op; one the user CANCELLED would otherwise be left
			// with the timer cancelled above and no renewal at all.
			this.reconcileSessionRefresh();
		}
	}

	// True when reconcileSessionRefresh would arm background renewal for this
	// credential: the right sign-in method, a workspace token (a long-lived
	// pre-v2 token is deliberately skipped, since refreshing would trade
	// months of life for 24 hours), a build that can reach the partition, and
	// an expiry the scheduler can compute a wake-up from. Runtime state
	// (disposed, a failed attempt, a pause) is deliberately NOT in here;
	// callers report those separately. Every user-facing claim about renewal
	// routes through here so the copy cannot disagree with what the scheduler
	// actually does. signInMethod is a parameter because capture surfaces are
	// not serialized (issue #86): a capture notice must describe the capture
	// it belongs to even if a concurrent capture rewrites settings meanwhile.
	canRenewCredential(
		token: string,
		signInMethod: SignInMethod = this.settings.signInMethod,
	): boolean {
		return (
			signInMethod === "window" &&
			isWorkspaceToken(token) &&
			buildPartitionPost(this.signInPartition()) !== null &&
			computeRefreshDelayMs(token, Date.now()) !== null
		);
	}

	// One-time capture heads-up (issue #78): a short (24h) session is normal
	// now, so the message's job is to say what happens when it runs out.
	// Advisory only: lifetime never gates a capture, and an unreadable or
	// iat-less token stays silent rather than guessing.
	private noteShortLifetimeOnCapture(
		token: string,
		signInMethod: SignInMethod,
	): void {
		const life = readTokenLifetime(token);
		if (life === null || life.lifetimeHours === null) {
			return;
		}
		if (life.lifetimeHours > SHORT_LIFETIME_HOURS) {
			return;
		}
		const hours = Math.max(1, Math.round(life.lifetimeHours));
		// The method is passed in rather than read back from settings: a
		// concurrent capture could rewrite settings.signInMethod between this
		// capture's save and its notice.
		const canRenew = this.canRenewCredential(token, signInMethod);
		const issued = `Plaud issued this sign-in a session of about ${hours} hour${
			hours === 1 ? "" : "s"
		}.`;
		new Notice(
			canRenew
				? `${issued} The plugin renews it in the background for about 30 days, then asks you to sign in again.`
				: `${issued} The plugin will ask you to sign in again when it expires.`,
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
			const outcome = await this.reauthenticate();
			if (outcome !== "captured") {
				// Shown for "reported" too: it adds the consequence rather than
				// restating the cause, so it reads as a follow-on, not a contradiction.
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
				// Lifecycle re-check AFTER this method's awaits, not just at its
				// top: onunload hides every sticky action notice and clears the
				// set, so a duration-0 prompt created after that sweep is
				// untracked, outlives the plugin, and sits on screen until the
				// user clicks it away. The log below still runs either way, so an
				// unload race stays visible in a debug capture.
				if (!this.disposed) {
					// Held so a session that heals itself can take this down
					// (issue #88). Clearing first keeps the field the single
					// owner of whatever is on screen: a tick short-circuits
					// while paused, so today there is nothing to replace, but
					// that is the tick guard's property rather than this call
					// site's.
					this.clearAutoSyncPauseNotice();
					this.autoSyncPauseNotice = this.showActionNotice(
						lead,
						"Reconnect",
						() => this.reconnectFromNotice(),
					);
				}
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

	/**
	 * Take down the auth-pause "Reconnect" prompt if one is on screen (issue
	 * #88). Same three steps reconcileSessionExpiryWarning() uses for the expiry
	 * and renewal-failure notices: hide it, drop it from the onunload sweep set
	 * so dismissed notices do not accumulate there, and null the handle.
	 */
	private clearAutoSyncPauseNotice(): void {
		if (this.autoSyncPauseNotice === null) return;
		this.autoSyncPauseNotice.hide();
		this.actionNotices.delete(this.autoSyncPauseNotice);
		this.autoSyncPauseNotice = null;
	}

	/** Clear an auth pause and run a tick soon. Called on token re-save / test / toggle. */
	resumeAutoSyncIfPaused(): void {
		// Above the paused check on purpose. The prompt and the pause state can
		// come apart: a resume that already ran, or a path that cleared the pause
		// without coming through here, leaves state un-paused with the prompt
		// still up. Behind the early return that prompt would be stranded on
		// screen for the rest of the session.
		this.clearAutoSyncPauseNotice();
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
	): Notice {
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
		// Returned so a caller can dismiss its own notice when it goes stale
		// (the pre-expiry warning does, on credential change). Most callers
		// ignore it.
		return notice;
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
			const outcome = await this.reauthenticate();
			const captured = outcome === "captured";
			// Plugin unloaded mid sign-in: skip side effects and messaging.
			if (this.disposed) return captured;
			if (captured) {
				new Notice("Plaud reconnected.");
				this.resumeAutoSyncIfPaused();
				if (onReconnected) await onReconnected();
			} else if (outcome === "closed") {
				// Only when nothing else is on screen. This used to test
				// `!this.reauthInFlight`, which caught exactly one of the reasons
				// reauthenticate speaks for itself and let "sign-in closed"
				// contradict every other one, now including a failed save.
				new Notice("Plaud sign-in closed. Still disconnected.");
			}
			return captured;
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
				if (flow === null || flow.modal !== modal) {
					return false;
				}
				if (flow.deliveryInFlight) {
					// Since 0.35.0 a deep-link delivery probes candidates against
					// Plaud, so this window is seconds rather than milliseconds.
					// Say so: a silent no-op reads as a broken button.
					new Notice(
						"Plaud sign-in from your browser is already being saved. Give it a moment.",
					);
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
				// Single-source the routing decision with reconnectFromNotice
				// (issue #78): a browser/bookmarklet (SSO) session must not be
				// pushed at the embedded email window on auth-error screens.
				prefersSsoReauth: !this.reconnectPrefersWindow(),
				// After a successful in-modal re-auth, clear any auth pause so
				// background sync resumes without waiting for the settings tab.
				onReauth: async () => {
					// The modal only needs to know whether to carry on, and
					// reauthenticate has already explained any failure it can.
					const captured = (await this.reauthenticate()) === "captured";
					if (captured) this.resumeAutoSyncIfPaused();
					return captured;
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
		}
		// v2 (issue #87): the sign-in partition is now derived from the vault's
		// own id, so a session captured before this upgrade sits in the old
		// installation-wide partition and this vault's renewal cannot see it.
		// Nothing is migrated between partitions, deliberately: two vaults holding
		// copies of one refresh token is one session in two jars, not two, and the
		// first to rotate would invalidate the other, reproducing the very bug
		// this change fixes. So the user signs in once more, per vault.
		//
		// Only vaults that HAD a window session are affected. SSO and bookmarklet
		// captures never populated a partition, and a vault with no stored
		// credential has nothing to lose, so neither gets a notice about a change
		// they cannot perceive. The flag is consumed at layout-ready rather than
		// shown here: loadSettings runs during onload, before the workspace can
		// render a Notice.
		if (stored !== null && storedVersion < 2) {
			this.perVaultSignInNoticePending =
				this.settings.signInMethod === "window" &&
				this.settings.secretId.length > 0;
		}
		// One write covers every migration above, so an install arriving from
		// version 0 does not pay two saves.
		if (stored !== null && storedVersion < CURRENT_SETTINGS_VERSION) {
			this.settings.settingsVersion = CURRENT_SETTINGS_VERSION;
			await this.saveSettings();
		}
	}

	// Shown once per vault, at layout-ready, after the #87 partition change moved
	// where this vault's sign-in lives. Set by loadSettings' v2 migration.
	private perVaultSignInNoticePending = false;

	private notePerVaultSignInChange(): void {
		// Layout-ready can fire after the plugin was disabled (loadSettings runs
		// during onload and the callback is queued), and a notice from a
		// tearing-down plugin would outlive it on screen. Its neighbours in the
		// same callback guard on `disposed` for the same reason.
		//
		// Losing the notice here is accepted, not recovered: settingsVersion was
		// already written as 2, so a later enable reads a migrated install and
		// never re-arms this. The window is "disabled within a moment of the first
		// load after upgrading", and the cost is a heads-up the user does not see;
		// the behavior it describes is unaffected, and they still learn they need
		// to sign in from the reconnect prompt. Persisting a second flag purely to
		// survive that window would put a settings key on disk forever to protect
		// one cosmetic message.
		if (this.disposed) return;
		if (!this.perVaultSignInNoticePending) return;
		this.perVaultSignInNoticePending = false;
		new Notice(
			"Plaud sign-ins are now separate for each vault, so vaults no longer interrupt each other's sessions. Sign in again in this vault when convenient.",
			15000,
		);
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
			// Explicit sign-out, so it also removes the pre-#87 shared leftover.
			// The reconnect path deliberately does not: see the note in
			// clearPlaudLoginSession about not signing out a sibling vault as a
			// side effect of one vault recovering.
			sessionCleared = await clearPlaudLoginSession(this.app, {
				includeLegacyShared: true,
			});
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
		// a Reconnect from until the next capture records one. The warn stamp
		// resets too: the next credential deserves its own warning.
		this.settings.signInMethod = "";
		this.settings.sessionWarnedForExpMs = 0;
		// A cleared session has nothing to refresh, and the next capture gets a
		// clean slate rather than inheriting this one's failure state.
		this.sessionRefreshFailed = false;
		await this.saveSettings();
		this.reconcileSessionExpiryWarning();
		this.reconcileSessionRefresh();
		return { sessionCleared };
	}

	// Re-authenticates via the email/password login window and persists the
	// captured token with the FULL recipe: set the secret, link secretId, and
	// adopt the redirected region (apiBaseUrl) so a region-redirected user is not
	// stranded on a stale host. Shared by the settings tab and the import modal's
	// inline re-auth. Resolves "captured" once a token is stored, "closed" when
	// the user closed the window (or the login API is unavailable on this build)
	// and nothing is on screen, and "reported" when the failure has already been
	// named in a Notice here, so callers add consequences, never causes. On the
	// captured and closed paths it shows no Notice; each caller phrases its own.
	async reauthenticate(): Promise<ReauthOutcome> {
		// One sign-in window at a time. Concurrent windows share the same
		// Electron capture partition and would clobber each other's token
		// capture, so a second caller (a stacked notice, a repeated command)
		// no-ops with a hint instead of opening a rival window.
		if (this.reauthInFlight) {
			new Notice("Plaud sign-in is already open.");
			return "reported";
		}
		// Both directions of this pairing have to be locked, not just one. The
		// refresh refuses to start under an open sign-in; this is the mirror.
		// Without it the sign-in window can capture the partition's CURRENT
		// localStorage, which still holds the near-expiry token, and store that
		// AFTER the refresh stored the fresh one, quietly putting the session
		// back where it was. The refresh's own supersede check cannot catch
		// this ordering, because at the moment it stores nothing has changed
		// yet. Seconds at most: the refresh POSTs are bounded by a 30s timeout.
		if (this.sessionRefreshInFlight) {
			new Notice(
				"Finishing a background session refresh. Try signing in again in a moment.",
			);
			return "reported";
		}
		this.reauthInFlight = true;
		try {
			const result = await openPlaudLogin(this.app, {
				debugLogger: this.debugLogger,
			});
			if (result === null) {
				return "closed";
			}
			// Do not persist a token onto a plugin that unloaded mid sign-in. A
			// torn-down plugin has no surface left to explain itself on, so this is
			// "closed" (say nothing) rather than "reported".
			if (this.disposed) {
				return "closed";
			}
			// The window now hands back CANDIDATES, because Plaud's web app stopped
			// writing a single plain token: the live credential is nested beside a
			// refresh token the API answers -3901 to. Route them through the same
			// probe-and-select the deep link uses, so exactly one place decides
			// which credential is real. "window" is preserved as the recorded
			// sign-in method so Reconnect still reopens this surface.
			// The region the window discovered is HANDED DOWN, never written to
			// settings first. Writing it up front is what created the defect
			// this closes: a sign-in that then failed to store left the new host
			// in memory beside the OLD linked credential, and the next unrelated
			// settings save would persist that pairing and send the old token to
			// the wrong region. Unwinding it afterwards is worse, not better -
			// capture paths are not serialized, so a rollback here can undo a
			// deep-link or paste capture that completed while this one was
			// probing. Passing it down means the host lands in settings only
			// alongside a credential that actually stored, so there is no window
			// to unwind and nothing to race.
			const outcome = await this.storeFirstWorkingCandidate(
				result.tokens,
				() => !this.disposed,
				"window",
				result.apiBaseUrl ?? undefined,
			);
			if (!outcome.stored) {
				// An empty message means the plugin unloaded or a newer sign-in owns
				// the credential; nothing is on screen, so the caller's own wording is
				// all the user would see. Otherwise the reason has just been named and
				// the caller must not talk over it.
				if (outcome.message.length > 0) {
					new Notice(outcome.message);
					return "reported";
				}
				return "closed";
			}
			return "captured";
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
				"Could not read the clipboard. Copy the line the bookmark showed in your browser, then try again.",
			);
			return false;
		}
		if (!canStore()) {
			return false;
		}
		// The bookmarklet's fallback offers the whole deep link, so a paste can
		// carry several candidates and gets the same probe-and-select treatment
		// the deep link does. A bare token still works and, when it is the only
		// candidate, still stores even if Plaud cannot be reached, so this path
		// keeps the behavior it had before 0.35.0.
		const candidates = parseClipboardTokens(text);
		if (candidates.length === 0) {
			new Notice(
				"The clipboard did not hold a valid token. Make sure you are signed in, then click the bookmarklet and copy what it shows.",
			);
			return false;
		}
		// The same guard again, because the probe between here and the store is
		// a second, longer chance for this paste to go stale.
		const result = await this.storeFirstWorkingCandidate(candidates, canStore);
		if (!result.stored && result.message.length > 0) {
			new Notice(result.message);
		}
		return result.stored;
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
			void copyToClipboard(buildSignInBookmarklet(this.app.vault.getName()), () => {
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
			fs.writeFileSync(file, bookmarkSetupHtml(this.app.vault.getName()));
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
	async storeAccessToken(
		rawToken: string,
		// Which surface captured this credential. Reconnect reopens the same one,
		// so the embedded window must record "window" even though it now shares
		// the browser path's probe-and-select machinery.
		signInMethod: SignInMethod = "browser",
		// The API origin this credential belongs to, when the capture surface
		// discovered one. Applied HERE, in the same mutation batch as the token,
		// rather than by the caller beforehand: a host written ahead of the
		// store outlives a store that then fails, leaving the new region paired
		// with the old credential. A token and the region it is valid for move
		// together or not at all.
		apiBaseUrl?: string,
		// True when this store came from the unattended refresh rather than a
		// user action. Suppresses the capture-time notices: the short-lifetime
		// heads-up is written for someone who just finished signing in, and on
		// the ~22 hour refresh cycle it would pop a 12 second notice saying the
		// plugin will ask them to sign in again, which is both noisy and, for a
		// refresh that just succeeded, wrong. A silent path that announces
		// itself every cycle is not silent.
		background = false,
		// Re-checked immediately before the commit, for callers whose right to
		// store can lapse while they wait: a cancelled reconnect flow, or a
		// background refresh whose credential the user has since replaced. Their
		// own checks run BEFORE this call, and this method now has an await ahead
		// of the credential write, so a check made out there is not binding by the
		// time the write happens. Callers with nothing to go stale keep the
		// default.
		stillOwns: () => boolean = () => true,
	): Promise<CaptureStoreResult> {
		const token = rawToken.trim().replace(/^bearer\s+/i, "");
		if (token.length === 0 || !isUsableUserToken(token)) {
			return { outcome: "unusable" };
		}
		// Serialized, and ONLY this method is. The old store wrote the secret with
		// a synchronous setSecret before its await, so credentials landed in CALL
		// order however the saves interleaved. Committing settings first puts an
		// await between a caller's decision and its credential write, so without
		// this a store that STARTED earlier could FINISH later and overwrite a
		// newer one: a background refresh mid-save when the user pastes a token.
		// The queue exists to restore the ordering this reorder breaks, nothing
		// more, so it is scoped to captures rather than to settings writes at
		// large.
		return this.serializeCaptureStore(() =>
			this.commitCapturedToken(
				token,
				signInMethod,
				apiBaseUrl,
				background,
				stillOwns,
			),
		);
	}

	/** Runs capture stores one at a time, in the order they were called. */
	private serializeCaptureStore(
		work: () => Promise<CaptureStoreResult>,
	): Promise<CaptureStoreResult> {
		// Both handlers run `work`: a predecessor that failed still had its turn,
		// and a queue that stopped on the first failure would strand every later
		// capture behind it.
		const run = this.captureStoreChain.then(work, work);
		// The chain must never carry a rejection forward, or one throwing store
		// would reject every store queued after it. Successors wait for this one to
		// FINISH, not to succeed; the result still reaches its own caller.
		this.captureStoreChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * The store itself, always run through the queue above. `token` has already
	 * passed the capture guard and been trimmed.
	 */
	private async commitCapturedToken(
		token: string,
		signInMethod: SignInMethod,
		apiBaseUrl: string | undefined,
		background: boolean,
		stillOwns: () => boolean,
	): Promise<CaptureStoreResult> {
		// The queue guarantees order, not relevance. This caller may have waited
		// while a newer capture took over, and its own guard was evaluated before
		// it joined. Re-ask now, with nothing yet written.
		if (!stillOwns()) {
			return { outcome: "superseded" };
		}
		// THE SETTINGS WRITE IS THE COMMIT POINT, AND IT RUNS FIRST (issue #86).
		//
		// It used to run last, after `setSecret` had already put the credential on
		// disk. `setSecret` is a synchronous void call (obsidian.d.ts: `setSecret(
		// id: string, secret: string): void`), so it persists the moment it is
		// called and there is no promise to fail. The awaited settings save right
		// after it CAN fail, for ordinary reasons: a vault on read-only storage, a
		// full disk, a sync client holding data.json. When it did, the new
		// credential was already durably stored under the same id the old one used
		// while data.json still named the old region and sign-in method, and that
		// mismatch survived a restart.
		//
		// Unwinding the secret afterwards is the obvious fix and it is the wrong
		// one. Three attempts were each faulted correctly, the last because the
		// capture surfaces are not serialized against each other, so an unwind can
		// undo whichever capture finished last: the one the user is holding.
		//
		// Doing the failable write first removes the unwind instead of trying to
		// make one safe. Until `saveData` resolves nothing is mutated: not the
		// secret, not `this.settings`, not the file. A rejection is a clean no-op,
		// which is what lets CAPTURE_SAVE_FAILED_NOTICE promise nothing changed.
		//
		// KNOWN, ACCEPTED RESIDUAL, and the one thing this reorder makes worse
		// rather than better. Everything below hangs on one fact: `this.settings`
		// still holds the OLD auth fields until the commit resolves, because they
		// are applied only after it. So during that window:
		//
		// - Clear sign-in or the token picker can run. This method then resumes
		//   and re-links its own credential, undoing a sign-out the user asked
		//   for. The old synchronous store had already written by then, so the
		//   sign-out won.
		// - An ordinary saveSettings() from any settings control writes the stale
		//   auth fields. If it lands after this commit, disk names the old sign-in
		//   while the secret holds the new token, which is this bug's own shape
		//   arriving from the other side.
		//
		// The queue above covers captures against each other and nothing else, on
		// purpose. Closing these two needs every settings write and credential
		// mutation to share one ordering protocol, which is a change to the whole
		// plugin rather than to this method, with a much wider blast radius than
		// the defect being fixed. It belongs in its own issue and its own review.
		//
		// The trade, stated so it can be argued with: both windows are the
		// duration of one file write, both need a competing action inside those
		// few milliseconds, and both are recoverable by repeating the action. What
		// they buy is the removal of a failure that anyone on a read-only or full
		// vault hit every single time, silently, and permanently.
		//
		// Residual, stated plainly: a crash between the commit and `setSecret`
		// leaves data.json naming the new region and method with the previous
		// token. Closing that needs a fresh secret id per capture and a pointer
		// swap; rejected because SecretStorage has no delete (see clearSignIn) and
		// the settings token picker lists every id, so each orphan is permanent
		// and user-visible. A crash window one synchronous step wide, worst case a
		// one-generation-stale credential and a reconnect prompt, against a
		// failure reproducible on any read-only vault whose worst case was silent,
		// restart-surviving corruption. A THROWN credential write is not part of
		// this residual: it is caught below, the settings are written back, and
		// only when even that restore fails does it surface, as a reported
		// `torn` outcome rather than silence. What remains is the hard crash.
		const next: PlaudImporterSettings = {
			...this.settings,
			secretId: CAPTURED_SECRET_ID,
			// A pasted/deep-linked token came through the browser flow. Record that
			// so Reconnect routes there.
			signInMethod,
		};
		if (apiBaseUrl !== undefined) {
			next.apiBaseUrl = apiBaseUrl;
		}
		try {
			await this.saveData(next);
		} catch (err) {
			console.error("Plaud importer: could not save the captured sign-in", err);
			return { outcome: "save-failed", error: err };
		}
		// The credential write CAN THROW: this file treats setSecret as throwable
		// everywhere else it writes one (clearSignIn, clearStoredRefreshToken).
		// Left bare here, a backing store that refused the write would recreate
		// the tear this method exists to prevent, from the other side: data.json
		// naming a sign-in whose credential never landed. It runs BEFORE the
		// in-memory fields are applied, so on failure memory still describes the
		// credential that survives.
		try {
			this.app.secretStorage.setSecret(CAPTURED_SECRET_ID, token);
		} catch (err) {
			console.error(
				"Plaud importer: could not store the captured credential",
				err,
			);
			// The commit above already landed, so write the previous settings
			// back. A rollback is safe HERE and nowhere else: this store holds
			// the capture queue, so no other capture can interleave with it,
			// which is exactly what faulted the three pre-#97 rollback attempts.
			// `this.settings` is untouched at this point and still describes the
			// surviving credential, concurrent non-capture edits included.
			try {
				await this.saveData({ ...this.settings });
			} catch (restoreErr) {
				console.error(
					"Plaud importer: could not restore settings after the credential write failed",
					restoreErr,
				);
				return { outcome: "torn", error: err };
			}
			return { outcome: "save-failed", error: err };
		}
		// Committed. Apply the fields this capture owns to the live settings object
		// rather than swapping in `next` wholesale: `next` was snapshotted before
		// the await, so adopting it would silently revert an unrelated setting the
		// user changed while the write was in flight.
		this.settings.secretId = next.secretId;
		this.settings.signInMethod = next.signInMethod;
		if (apiBaseUrl !== undefined) {
			this.settings.apiBaseUrl = apiBaseUrl;
		}
		// Blank any legacy WRT from a previous session so it cannot shadow the
		// recorded method. After the commit, like the credential: a capture that
		// never stored must not clear the session it failed to replace.
		this.clearStoredRefreshToken();
		// A newly stored credential clears any prior refresh failure: whatever
		// was wrong, the user just replaced the thing that was failing.
		this.sessionRefreshFailed = false;
		// Everything below is bookkeeping about a store that has already
		// succeeded. A throw in it must not escape, or the caller reports a
		// save failure for a credential that is durably linked; the redraw
		// guard this generalizes existed for exactly that reason. Each call is
		// guarded ALONE, because they are independent: one failing must not
		// skip the rest, or a stored credential is left without its renewal
		// timer or with a stale settings tab.
		const guarded = (what: string, run: () => void): void => {
			try {
				run();
			} catch (err) {
				console.error(
					`Plaud importer: ${what} after a stored capture failed`,
					err,
				);
			}
		};
		if (!background) {
			guarded("short-lifetime notice", () =>
				this.noteShortLifetimeOnCapture(token, signInMethod),
			);
		}
		guarded("expiry-warning reconcile", () =>
			this.reconcileSessionExpiryWarning(),
		);
		guarded("session-refresh reconcile", () => this.reconcileSessionRefresh());
		// A deep link can land while the settings tab is open, which is exactly
		// what the one-click bookmark encourages: launch sign-in from settings,
		// click the bookmark, come back. Redraw the status line and secret
		// picker so the tab does not keep saying "not connected yet". Read at
		// call time, so a tab closed during the await above is simply null.
		guarded("settings redraw", () => this.settingsRefresh?.());
		return { outcome: "stored" };
	}

	/**
	 * Renders a store outcome as the {stored, message} pair the capture surfaces
	 * show, so a save failure cannot be reported as a bad token on one path and
	 * correctly on another. `savedNotice` differs per path (a probed capture and
	 * an unverified one say different things), so it is passed in.
	 */
	private describeCaptureOutcome(
		result: CaptureStoreResult,
		savedNotice: string,
	): { stored: boolean; message: string } {
		switch (result.outcome) {
			case "stored":
				return { stored: true, message: savedNotice };
			case "save-failed":
				return { stored: false, message: CAPTURE_SAVE_FAILED_NOTICE };
			case "torn":
				// NOT the save-failed notice: that one promises nothing changed,
				// which is untrue on this path. This one says what did.
				return { stored: false, message: CAPTURE_TORN_NOTICE };
			case "superseded":
				// The established "say nothing" signal on this path, already used
				// when the plugin unloads or a newer sign-in owns the credential.
				return { stored: false, message: "" };
			case "unusable":
				return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
	}

	// Probes candidate tokens against Plaud and stores the first one Plaud
	// accepts (issue #78, 0.35.0). Each probe runs on a THROWAWAY client built
	// around a closure returning that one candidate: the real client reads
	// secretStorage, and nothing may be written to storage before it is
	// validated. The probe is a real API call because Plaud answers auth
	// failures with HTTP 200 and a negative in-band status, so only the
	// client's in-band handling can tell acceptance from rejection.
	//
	// Returns the Notice text to show, plus whether a token was stored.
	private async storeFirstWorkingCandidate(
		candidates: readonly string[],
		// Re-checked immediately before the store, never only before the probe.
		// Probing is several round-trips, so it reopens the exact window PR #76
		// closed: a delivery whose flow was cancelled while it ran must not
		// overwrite a newer sign-in's token. Callers with no such window keep
		// the default.
		canStore: () => boolean = () => true,
		signInMethod: SignInMethod = "browser",
		// Region the capture surface already discovered, when it found one. Used
		// to aim the probes and handed on to the store; deliberately NOT written
		// to settings on the way in, so a capture that never stores leaves the
		// configured host untouched.
		discoveredBaseUrl?: string,
	): Promise<{ stored: boolean; message: string }> {
		const probeBaseUrl = discoveredBaseUrl ?? this.settings.apiBaseUrl;
		// The region redirect a probe may follow is captured locally instead of
		// being persisted by the client's own callback: an unvalidated
		// candidate must not rewrite the configured API host. It is handed to
		// the store below only for the candidate that is actually stored. Held
		// on an object so the value written inside the probe closure is read
		// back correctly after the await.
		const detected: { baseUrl: string | null } = { baseUrl: null };
		// Probing several candidates is several round-trips, and the user has
		// just switched from the browser to Obsidian expecting something to
		// happen. Say what is happening rather than sitting silent. Given a
		// finite duration as well as an explicit hide, so an unload mid-probe
		// cannot strand it.
		const progress =
			candidates.length > 1
				? new Notice(DEEP_LINK_PROBING_NOTICE, 15000)
				: null;
		let selection;
		try {
			selection = await selectWorkingCandidate(
				candidates,
				async (candidate) => {
					detected.baseUrl = null;
					const probe = new ReverseEngineeredPlaudClient(
						() => candidate,
						obsidianFetcher,
						{
							debugLogger: this.debugLogger,
							baseUrl: probeBaseUrl,
							onBaseUrlChanged: (url) => {
								detected.baseUrl = url;
							},
						},
					);
					await probe.listRecordings({ limit: 1 });
				},
			);
		} finally {
			progress?.hide();
		}
		// An empty message means "say nothing": the plugin unloaded, or a newer
		// sign-in owns the credential and this delivery is stale.
		// Checked here to skip the store entirely, and handed to the store as well,
		// which re-asks immediately before its commit. This check alone stopped
		// being binding once the store had an await ahead of its credential write.
		const stillOwns = (): boolean => !this.disposed && canStore();
		if (!stillOwns()) {
			return { stored: false, message: "" };
		}
		if (selection.outcome === "none-usable") {
			return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
		if (selection.outcome === "all-rejected") {
			return { stored: false, message: DEEP_LINK_ALL_REJECTED_NOTICE };
		}
		if (selection.outcome === "unreachable") {
			// With several candidates the whole point is choosing between them,
			// and no claim distinguishes a revoked token from a live one, so a
			// blind pick would store the wrong credential. With exactly one
			// there is nothing to choose: store it unverified, which is what
			// every release before 0.35.0 did, so an offline reconnect still
			// works.
			if (selection.usable.length !== 1) {
				return { stored: false, message: DEEP_LINK_UNREACHABLE_NOTICE };
			}
			// Unreachable means nothing was proven, so no redirect was observed
			// either; the surface's own discovered region is the best available.
			return this.describeCaptureOutcome(
				await this.storeAccessToken(
					selection.usable[0],
					signInMethod,
					discoveredBaseUrl,
					false,
					stillOwns,
				),
				DEEP_LINK_UNVERIFIED_NOTICE,
			);
		}
		// Selected. A 'selected' outcome always carries a token; fail closed
		// rather than assert it.
		const token = selection.token;
		if (token === null) {
			return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
		// Hand the store the regional host this candidate was actually proven
		// against, so the token and its region are written in one batch. A
		// redirect followed during probing outranks the surface's own guess.
		return this.describeCaptureOutcome(
			await this.storeAccessToken(
				token,
				signInMethod,
				detected.baseUrl ?? discoveredBaseUrl,
				false,
				stillOwns,
			),
			DEEP_LINK_SAVED_NOTICE,
		);
	}

	// Handles obsidian://plaud-importer-token deep links from the browser
	// sign-in bookmarklet. Reads the 0.35.0 `tokens` candidate list and the
	// legacy single `token` parameter, so a bookmark the user has not re-added
	// keeps working.
	private async handleTokenDeepLink(
		params: ObsidianProtocolData,
	): Promise<void> {
		const candidates = parseTokenCandidates(params);
		if (candidates.length === 0) {
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
			let result = { stored: false, message: "" };
			try {
				// Probing is several round-trips, so this delivery can outlive
				// its own flow. Refuse the store only when a DIFFERENT flow has
				// taken ownership meanwhile: that is the ABA case where a stale
				// delivery would clobber a newer sign-in's token. A flow that
				// was merely cancelled (nothing owns sign-in now) still stores,
				// which is the behavior every release before 0.35.0 had: the
				// user did just sign in, and the fall-through below reports it.
				result = await this.storeFirstWorkingCandidate(
					candidates,
					() =>
						this.browserReconnect === null ||
						this.browserReconnect === flow,
				);
				if (result.stored) {
					const done = await this.completeBrowserReconnect(flow);
					if (done) {
						return;
					}
					// The flow was cancelled while the store ran; the token is
					// saved anyway, so fall through to the plain-path handling.
				} else {
					if (result.message.length > 0) {
						new Notice(result.message);
					}
					return;
				}
			} finally {
				flow.deliveryInFlight = false;
			}
			if (this.disposed) {
				return;
			}
			this.resumeAutoSyncIfPaused();
			new Notice(result.message);
			return;
		}
		const result = await this.storeFirstWorkingCandidate(candidates);
		if (result.stored) {
			// Outside the reconnect flow a fresh token still means the session
			// is back; a paused auto-sync should not wait for its next trigger.
			this.resumeAutoSyncIfPaused();
		}
		// An empty message means the plugin unloaded mid-probe; say nothing.
		if (result.message.length > 0) {
			new Notice(result.message);
		}
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
			"Click the 'Plaud → Obsidian' bookmark on your bookmarks bar (the one you saved during setup). Your browser asks to open Obsidian; allow it, and the token is saved for you.",
			"If Obsidian does not open, the bookmark shows a line of text in a box instead. Copy the whole line, come back here, and click 'Paste token from clipboard'.",
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

// Exported for tests only (issue #90). The plugin registers this itself in
// onload; nothing outside main.ts constructs it.
export class PlaudImporterSettingsTab extends PluginSettingTab {
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

	// Obsidian calls this when the settings pane closes. Drop the redraw hook
	// and the row closures with it: they capture DOM that is about to be
	// discarded, so a later capture must not try to paint through them.
	hide(): void {
		if (this.plugin.settingsRefresh !== null) {
			this.plugin.settingsRefresh = null;
		}
		this.signinRefresh = null;
		this.tokenRefresh = null;
		super.hide();
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
				CLEAR_SIGN_IN_DESC,
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
		// Second line, under the status: what renewal this session gets. Its
		// text is set by refreshStatus below, and is empty when nothing is
		// connected so an unconnected plugin makes no renewal promise at all.
		const renewalEl = setting.descEl.createDiv({
			cls: "plaud-importer-signin-renewal",
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
			const connected = stored && !expired && !unreadable;
			const canRenew = this.plugin.canRenewCredential(value);
			// Three states, not two. Folding "renewal stopped after a failure"
			// into "this sign-in cannot renew" describes the wrong cause and
			// sends the user to the wrong remedy: the first is fixed by
			// reconnecting, the second is simply how that sign-in method works.
			renewalEl.setText(
				!connected
					? ""
					: !canRenew
						? "This sign-in cannot renew itself in the background. Reconnect when the session lapses."
						: this.plugin.sessionRenewalPaused
							? "Automatic renewal stopped after a failed attempt. Reconnect to restart it."
							: "Renews itself in the background for about 30 days, then asks you to sign in again.",
			);
		};
		this.signinRefresh = refreshStatus;
		// Publish the pair to the plugin so a capture that happens outside this
		// tab (a deep link landing while settings is open) can redraw it. Both
		// halves are optional-called, so this is safe before the token row has
		// rendered. Cleared in hide().
		this.plugin.settingsRefresh = () => {
			this.signinRefresh?.();
			this.tokenRefresh?.();
		};
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
						// The linked credential changed, so the expiry warning
						// must re-derive (fifth mutation channel, issue #78),
						// and so must the refresh schedule.
						this.plugin.reconcileSessionExpiryWarning();
						this.plugin.reconcileSessionRefresh();
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
						let outcome: ReauthOutcome;
						// Scoped to the capture call ALONE, deliberately. A settings
						// write the vault refuses no longer arrives here as a throw:
						// it comes back as "reported", with the specific reason
						// already on screen. The capture path can still throw for
						// other reasons, though, and without a catch here the async
						// click rejected unhandled: the button re-enabled and the user
						// was told nothing, which is the hardest version of this
						// failure to diagnose (issue #86). Widening it to cover the
						// success branch below would be worse than the bug: a redraw
						// that threw after a token was safely stored would show the
						// success notice AND a failure notice contradicting it.
						try {
							outcome = await this.plugin.reauthenticate();
						} catch (err) {
							console.error("Plaud importer: sign-in failed", err);
							new Notice(CAPTURE_SAVE_FAILED_NOTICE);
							return;
						}
						if (outcome === "captured") {
							new Notice("Plaud token captured and saved.");
							this.signinRefresh?.();
							this.tokenRefresh?.();
						} else if (outcome === "closed") {
							// "reported" gets nothing added: the reason is already on
							// screen, and this wording would claim the user closed the
							// window when they may have finished signing in and had the
							// vault refuse the save.
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
			"First time only: click 'Set up bookmark'. A web page opens. Drag the big button onto your browser's bookmarks bar (the strip near the top of the window). If you already have an older Plaud → Obsidian bookmark, replace it with this one.",
			"Click 'Launch sign-in to capture token'. A short reminder pops up, then your browser opens.",
			"In the browser: sign in to Plaud if needed, then click the bookmark you saved. Your browser asks to open Obsidian; allow it, and the token is saved for you. Done! If the token stops working later, do steps 2 and 3 again.",
			"Only if Obsidian did not open: the bookmark shows a line of text in a box instead. Copy the whole line, come back to Obsidian, and click 'Paste token from clipboard'.",
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
				let ok: boolean;
				// Scoped to the paste call alone, for the same reason as the Sign in
				// button above (issue #86). pasteTokenFromClipboard handles a
				// clipboard read failure itself and returns false after saying so,
				// but the store behind it can still reject on the settings write, and
				// that arrives here as a throw.
				try {
					ok = await this.plugin.pasteTokenFromClipboard();
				} catch (err) {
					console.error("Plaud importer: paste failed to save", err);
					new Notice(CAPTURE_SAVE_FAILED_NOTICE);
					return;
				}
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
						desc: CLEAR_SIGN_IN_DESC,
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
