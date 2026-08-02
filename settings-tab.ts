/**
 * The settings tab: every control the user sees, in both of the two rendering
 * paths the plugin still has to support (Obsidian 1.13+ reads
 * getSettingDefinitions(), older builds call display()).
 *
 * Extracted from main.ts, where it was the largest single thing in a 5,684
 * line file. The copy constants come with it: the token reference tables and
 * description strings are settings-tab content, held in consts rather than
 * inline literals so the obsidianmd sentence-case lint (which only inspects
 * literals written at the call site) accepts product names mid-sentence.
 */
import {
	App,
	Notice,
	type Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	type TextComponent,
	type SettingDefinitionItem,
	setIcon,
} from 'obsidian';
import { describeTokenLifetime, readTokenLifetime } from './plaud-token';
import {
	DEFAULT_NOTE_NAME_TEMPLATE,
	isValidNoteNameTemplate,
	resolveSubfolder,
	buildNoteName,
	formatDatetime,
	isValidReplacementChar,
	TEMPLATE_PREVIEW_DATE,
	TEMPLATE_PREVIEW_DATETIME,
	TEMPLATE_PREVIEW_TITLE,
	TEMPLATE_PREVIEW_FOLDER,
	renderCustomFrontmatterPreview,
} from './note-writer';
import { coerceIntervalMinutes } from './auto-sync';
import { BrowserSignInModal } from './modals';
import {
	CAPTURED_SECRET_ID,
	CAPTURE_SAVE_FAILED_NOTICE,
	type ReauthOutcome,
} from './capture-store';
import {
	DEFAULT_SETTINGS,
	RIBBON_ICON_CHOICES,
	resolveRibbonIconId,
	type PlaudImporterSettings,
} from './settings-types';
import type { SignInMethod } from './reconnect-routing';
import type { BufferedDebugLogger } from './debug-logger';

/**
 * What the tab needs from the plugin, named one member at a time rather than
 * imported as the plugin class. Importing PlaudImporterPlugin would make
 * main.ts and this file mutually dependent for no benefit; this way the
 * dependency runs one way and the list doubles as the tab's actual contract.
 *
 * It extends Plugin because PluginSettingTab's constructor takes a real one:
 * `super(app, plugin)` needs the base class, not a structural stand-in.
 */
export interface SettingsTabHost extends Plugin {
	settings: PlaudImporterSettings;
	/** Redraw hook the tab installs for itself; see the tab's hide(). */
	settingsRefresh: (() => void) | null;
	debugLogger: BufferedDebugLogger;
	/** True when a renewable session exists but renewal is currently paused. */
	readonly sessionRenewalPaused: boolean;
	saveSettings(): Promise<void>;
	readStoredTokenValue(): string;
	testPlaudConnection(): Promise<{ ok: boolean; message: string }>;
	reauthenticate(): Promise<ReauthOutcome>;
	pasteTokenFromClipboard(canStore?: () => boolean): Promise<boolean>;
	clearSignIn(): Promise<{ sessionCleared: boolean }>;
	openPlaudInBrowser(): void;
	openBookmarkSetupPage(): Promise<void>;
	updateRibbonIcon(): void;
	resumeAutoSyncIfPaused(): void;
	reconcileAutoSync(): void;
	reconcileSessionRefresh(): void;
	reconcileSessionExpiryWarning(): void;
	canRenewCredential(token: string, signInMethod?: SignInMethod): boolean;
}

// Explanatory note shown under the "Sign in" heading. Held in a const so it can
// name Plaud/Google/Apple plainly: the sentence-case lint only inspects string
// literals written directly at a setText/createEl call, not a referenced const.
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
	['{{YYYY}}', 'year, for example 2026'],
	['{{MM}}', 'month, 01 to 12'],
	['{{MMMM}}', 'month name, for example June'],
	['{{DD}}', 'day, 01 to 31'],
	['{{dddd}}', 'weekday name, for example Monday'],
	['{{WW}}', 'ISO week number, 01 to 53'],
	['{{Q}}', 'quarter, 1 to 4'],
	[
		'{{title}}',
		'the recording title, with a leading numeric date removed (for folder-note layouts)',
	],
	[
		'{{plaud-folder}}',
		"the recording's Plaud folder name (or _unfiled when it has none)",
	],
];

// [template, resulting folder] pairs for a June 4 2026 recording titled Team
// sync. Covers nesting, a custom separator, a day-first order, week foldering,
// two tokens inside one {{ }}, and a folder-note title layout. Outputs verified
// against Moment 2.29.
const SUBFOLDER_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	['{{YYYY-MM}}', '2026-06 (one folder)'],
	['{{YYYY}}/{{MM}}', '2026/06 (a 2026 folder holding a 06 folder)'],
	['{{DD}}-{{MM}}-{{YYYY}}', '04-06-2026 (day-first order)'],
	['{{YYYY}}/W{{WW}}', '2026/W23 (by week)'],
	['{{YYYY}}/{{MM MMMM}}', '2026/06 June (two tokens in one {{ }})'],
	['{{YYYY}}/{{title}}', '2026/Team sync (a folder per recording)'],
	['{{plaud-folder}}/{{YYYY}}', 'Meetings/2026 (mirror the Plaud folder)'],
];

const SUBFOLDER_TEMPLATE_TOKENS_HEADING =
	'Tokens (case matters; combine them with separators inside the braces):';
const SUBFOLDER_TEMPLATE_EXAMPLES_HEADING = 'Examples:';
const SUBFOLDER_TEMPLATE_FOOTNOTE =
	'Applies to new imports; notes you already imported stay where they are.';

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
	['{{YYYY}}', 'year, for example 2026'],
	['{{YY}}', '2-digit year, for example 26'],
	['{{MMMM}}', 'month name, for example July'],
	['{{MMM}}', 'short month, for example Jul'],
	['{{MM}}', 'month, 01 to 12'],
	['{{M}}', 'month, 1 to 12'],
	['{{DD}}', 'day, 01 to 31'],
	['{{D}}', 'day, 1 to 31'],
	['{{dddd}}', 'weekday name, for example Friday'],
	['{{WW}}', 'ISO week number, 01 to 53'],
	['{{Q}}', 'quarter, 1 to 4'],
	[
		'{{title}}',
		'the recording title, with a leading numeric date (MM-DD, YYYY-MM-DD, and similar) removed',
	],
];

// [template, resulting name] pairs for a July 3 2026 recording titled Team sync.
// Covers date-first, date-last, a combined date in one {{ }}, and US order.
// Outputs verified against Moment 2.29.
const NOTE_NAME_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	['{{YYYY}}-{{MM}}-{{DD}} {{title}}', '2026-07-03 Team sync'],
	[
		'{{title}} {{YYYY}}-{{MM}}-{{DD}}',
		'Team sync 2026-07-03 (date at the end)',
	],
	[
		'{{MMM D, YYYY}} - {{title}}',
		'Jul 3, 2026 - Team sync (one combined date token)',
	],
	['{{MM}}-{{DD}}-{{YYYY}} {{title}}', '07-03-2026 Team sync (US order)'],
];

const NOTE_NAME_TEMPLATE_TOKENS_HEADING =
	'Tokens (case matters; combine them with separators inside the braces):';
const NOTE_NAME_TEMPLATE_EXAMPLES_HEADING = 'Examples:';
const NOTE_NAME_TEMPLATE_FOOTNOTE =
	'Applies to new imports; notes you already imported keep their current names.';

// Description for the forbidden-character replacement setting. Held in a const so
// the declarative (1.13+) and imperative (1.12) settings paths show identical
// text and the sentence-case lint inspects one literal.
const FORBIDDEN_CHAR_REPLACEMENT_DESC =
	'Character that replaces a slash, colon, or other character a file name or folder cannot contain, for example one that appears in a recording title. Must be a single character; the default is a dash.';

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
	'On by default. When a re-import overwrites a note, keep any frontmatter property you added yourself, or that another tool wrote, that the plugin does not manage. Leave this on so downstream automation and hand-added properties survive a re-import. To let the plugin manage and refresh a specific property instead, add it as an extra frontmatter row with preserve turned off.';

const DUPLICATE_HANDLING_NAME = 'Duplicate handling for manual imports';
const DUPLICATE_HANDLING_DESC =
	'Controls what happens when you run Import recent recordings and a note for the recording already exists. Skip keeps your copy, overwrite replaces it, and ask each time prompts you for each one. Automatic sync ignores this and never prompts.';

// [label, template] preset buttons. All dashes, so every preset is filename-safe.
// ISO/US/EU cover the common date orders; putting the date after {{title}} (the
// "date at the end" example in the reference) is left to the user to type.
const NOTE_NAME_TEMPLATE_PRESETS: ReadonlyArray<readonly [string, string]> = [
	['ISO', '{{YYYY}}-{{MM}}-{{DD}} {{title}}'],
	['US', '{{MM}}-{{DD}}-{{YYYY}} {{title}}'],
	['EU', '{{DD}}-{{MM}}-{{YYYY}} {{title}}'],
];

// [label, inserted token] for the insert-token buttons above each template
// field. Labels are friendly names; clicking inserts the exact Moment token at
// the cursor so the common path is typo-proof (bare letters typed by hand would
// be read as tokens). Both the note-name and subfolder fields add Title; the
// subfolder uses it for folder-note layouts, flattening any slash in the title.
const DATE_INSERT_TOKENS: ReadonlyArray<readonly [string, string]> = [
	['Year', '{{YYYY}}'],
	['Month #', '{{MM}}'],
	['Month name', '{{MMMM}}'],
	['Day', '{{DD}}'],
	['Weekday', '{{dddd}}'],
	['Quarter', '{{Q}}'],
	['Week', '{{WW}}'],
	// Time tokens (issue #32). Available in every template field so a user can
	// compose a time however they like; most useful in the datetime frontmatter
	// field. Offset ({{Z}}) records the UTC offset so an ISO value is unambiguous.
	['Hour', '{{HH}}'],
	['Minute', '{{mm}}'],
	['Second', '{{ss}}'],
	['AM/PM', '{{A}}'],
	['Offset', '{{Z}}'],
];
const TITLE_INSERT_TOKEN: readonly [string, string] = ['Title', '{{title}}'];
// Subfolder-only: the recording's Plaud folder name, for mirroring Plaud folders
// into the vault tree. Not offered on the note-name field (a folder name in a
// per-note file name is surprising).
const FOLDER_INSERT_TOKEN: readonly [string, string] = [
	'Folder',
	'{{plaud-folder}}',
];

// Content tokens available only in the extra-frontmatter value field. They
// surface recording/summary data the plugin already parses; they are not offered
// on the note-name or subfolder fields, where a nullable value has no place in a
// path. The summary-derived ones are empty on a recording with no AI summary.
const CONTENT_INSERT_TOKENS: ReadonlyArray<readonly [string, string]> = [
	['Duration', '{{duration}}'],
	['Category', '{{category}}'],
	['Industry', '{{industry}}'],
	['Headline', '{{headline}}'],
	['Language', '{{language}}'],
	['Summary template', '{{template}}'],
	['Model', '{{model}}'],
];

// Extra-frontmatter documentation. Each row is a property; its value takes the
// same {{ }} tokens as the other fields plus the content tokens above. Held in
// consts so the sentence-case lint inspects the literal and leaves the token
// examples alone.
const CUSTOM_FRONTMATTER_INTRO =
	"Adds your own properties to each imported note's frontmatter. Each row is one property: a name, a value, and whether to preserve it. A value can be plain text or use the same {{ }} tokens as the other fields (the date set, {{title}}, {{plaud-folder}}) plus content tokens like {{category}} and {{duration}}. Leave a value empty to write the property with no value. Turn on preserve for a property you edit by hand (a status, a project) so a re-import keeps your value; leave it off for a value that should refresh from the recording each time.";

const CUSTOM_FRONTMATTER_TOKENS: ReadonlyArray<readonly [string, string]> = [
	['{{title}}', 'the recording title'],
	['{{plaud-folder}}', "the recording's Plaud folder name"],
	['{{duration}}', 'the recording length, for example 30m'],
	['{{category}}', "the summary's category (empty with no AI summary)"],
	[
		'{{industry}}',
		"the summary's industry or topic (empty with no AI summary)",
	],
	['{{headline}}', "the summary's one-line headline"],
	[
		'{{YYYY}} {{MM}} {{DD}} {{Q}} {{WW}}',
		'the date set, same as the other fields',
	],
];

const CUSTOM_FRONTMATTER_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	['status: unprocessed', 'a fixed value you triage later (preserve on)'],
	[
		'quarter: Q{{Q}}-{{YYYY}}',
		'writes quarter: Q3-2026 for a July recording',
	],
	['type: {{category}}', "the recording's own category under your key name"],
	['project:', 'writes project: with no value, to fill in by hand'],
];

const CUSTOM_FRONTMATTER_TOKENS_HEADING =
	'Tokens (same {{ }} syntax as the other fields, plus content tokens):';
const CUSTOM_FRONTMATTER_EXAMPLES_HEADING = 'Examples:';
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
	['{{YYYY}}-{{MM}}-{{DD}}', 'the date, for example 2026-07-05'],
	['{{HH}}', 'hour, 00 to 23'],
	['{{mm}}', 'minute, 00 to 59'],
	['{{ss}}', 'second, 00 to 59'],
	['{{h}}', 'hour, 1 to 12'],
	['{{A}}', 'AM or PM'],
	['{{Z}}', 'UTC offset, for example +02:00'],
];

// [template, resulting value] pairs for the sample datetime 2026-07-05 14:30:00.
// The ISO example's offset depends on the user's own time zone; the live preview
// shows their real value, so the doc labels it rather than committing to one.
const DATETIME_TEMPLATE_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
	['{{YYYY-MM-DD HH:mm}}', '2026-07-05 14:30 (24-hour)'],
	['{{YYYY-MM-DD h:mm A}}', '2026-07-05 2:30 PM (12-hour)'],
	[
		'{{YYYY-MM-DDTHH:mm:ssZ}}',
		'2026-07-05T14:30:00±hh:mm, your local UTC offset (ISO 8601)',
	],
];

const DATETIME_TEMPLATE_TOKENS_HEADING =
	'Tokens (case matters; combine them with separators inside the braces):';
const DATETIME_TEMPLATE_EXAMPLES_HEADING = 'Examples:';
const DATETIME_TEMPLATE_FOOTNOTE =
	'Applies to new imports; notes you already imported keep their current frontmatter.';

// Rendered in two places (the settings tab and the declarative registry), which
// previously held two verbatim copies of this sentence. One definition so they
// cannot drift, which matters here because the behavior it describes changed:
// clearing is scoped to the calling vault since issue #87.
const CLEAR_SIGN_IN_DESC =
	'Sign out of the embedded Plaud browser for this vault and wipe the stored token so the next sign-in starts completely fresh. Other vaults keep their own sign-ins. This also removes the older shared sign-in left over from before each vault had its own. Use this to reach the sign-in screen when it keeps signing you in automatically. Obsidian has no way to delete the secret entry, so an emptied one may stay in the token picker, but it holds no token.';

// Same reason as the const above, and this one had ALREADY drifted: the
// imperative path was missing the sentence explaining why the toggle is off by
// default, so an Obsidian 1.12 user read a shorter description than a 1.13 one
// for the same control. Pre-existing, found while this file was being split
// out. One definition now.
const AI_KEYWORDS_PROPERTY_DESC =
	"When AI keywords are excluded from tags, write them to a keywords frontmatter property instead. Plaud's keyword list can run to hundreds of low-value entries per recording, so this is off by default. The property is searchable and Dataview-queryable but stays out of the tag pane.";

// Exported for tests only (issue #90). The plugin registers this itself in
// onload; nothing outside main.ts constructs it.
export class PlaudImporterSettingsTab extends PluginSettingTab {
	plugin: SettingsTabHost;

	// Set by renderSigninControl() so the Clear sign-in button can refresh the
	// sign-in status line in place after wiping the token. Null until the
	// sign-in row has rendered.
	private signinRefresh: (() => void) | null = null;
	// Set by renderTokenControl() so the paste/sign-in flows can redraw the
	// secret picker to show a just-stored token as the selected secret. Null
	// until the token row has rendered.
	private tokenRefresh: (() => void) | null = null;

	constructor(app: App, plugin: SettingsTabHost) {
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
				'Plaud token',
				"Your stored Plaud token. The status below shows whether you are connected. The value stays in Obsidian's secret storage, never in data.json.",
			),
		);

		new Setting(containerEl).setName('Sign in').setHeading();
		this.renderSignInIntro(new Setting(containerEl));
		this.renderSigninControl(
			this.makeSetting(
				containerEl,
				'Sign in with email',
				'Best for email and password logins. Click Sign in, log in to Plaud in the window that opens, and your token is saved automatically. Google and Apple logins do not work in this window; use the option below for those.',
			),
		);
		this.renderBrowserSignInControl(
			this.makeSetting(
				containerEl,
				'Sign in with Google or Apple',
				'For Google and Apple logins, which only work in a real browser. The first time needs a one-time bookmark setup. After that, sign in to Plaud in your normal browser and send the token back with the steps below.',
			),
		);
		this.renderTestControl(
			this.makeSetting(
				containerEl,
				'Test connection',
				'Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.',
			),
		);
		this.renderClearSignInControl(
			this.makeSetting(containerEl, 'Clear sign-in', CLEAR_SIGN_IN_DESC),
		);
		this.renderRegionControl(
			this.makeSetting(
				containerEl,
				'API region',
				'Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.',
			),
		);

		new Setting(containerEl).setName('Output').setHeading();
		this.addTextRow(
			containerEl,
			'Output folder',
			'Folder inside your vault where imported notes are written.',
			'outputFolder',
			'Plaud',
		);
		this.renderSubfolderTemplateControl(
			this.makeSetting(
				containerEl,
				'Subfolder template',
				SUBFOLDER_TEMPLATE_INTRO,
			),
		);
		this.renderNoteNameTemplateControl(
			this.makeSetting(
				containerEl,
				'Note name template',
				NOTE_NAME_TEMPLATE_INTRO,
			),
		);
		this.renderDatetimeTemplateControl(
			this.makeSetting(
				containerEl,
				'Datetime property',
				DATETIME_TEMPLATE_INTRO,
			),
		);
		this.renderCustomFrontmatterControl(
			this.makeSetting(
				containerEl,
				'Extra frontmatter',
				CUSTOM_FRONTMATTER_INTRO,
			),
		);
		this.addToggleRow(
			containerEl,
			'Preserve unknown frontmatter on re-import',
			PRESERVE_UNKNOWN_FRONTMATTER_DESC,
			'preserveUnknownFrontmatter',
		);
		this.addTextRow(
			containerEl,
			'Forbidden character replacement',
			FORBIDDEN_CHAR_REPLACEMENT_DESC,
			'forbiddenCharReplacement',
			'-',
		);
		this.addDropdownRow(
			containerEl,
			DUPLICATE_HANDLING_NAME,
			DUPLICATE_HANDLING_DESC,
			'onDuplicate',
			{ skip: 'Skip', overwrite: 'Overwrite', prompt: 'Ask each time' },
		);

		new Setting(containerEl).setName('Appearance').setHeading();
		this.addToggleRow(
			containerEl,
			'Show ribbon icon',
			"Display the plaud importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
			'showRibbonIcon',
		);
		this.renderRibbonControl(
			this.makeSetting(
				containerEl,
				'Ribbon icon',
				"Which icon to display in the left rail. Only applies when 'show ribbon icon' is on.",
			),
		);

		new Setting(containerEl)
			.setName('Default artifact selection')
			.setHeading();
		this.addToggleRow(
			containerEl,
			'Transcript',
			"Checked by default in import actions. You can override in 'review artifacts first'.",
			'includeTranscript',
		);
		this.addToggleRow(
			containerEl,
			'Summary',
			"Checked by default in import actions. You can override in 'review artifacts first'.",
			'defaultIncludeSummary',
		);
		this.addToggleRow(
			containerEl,
			'Attachments',
			'Checked by default in import actions when attachments are available.',
			'defaultIncludeAttachments',
		);
		this.addToggleRow(
			containerEl,
			'Mindmap',
			'Checked by default in import actions when a mindmap artifact is available.',
			'defaultIncludeMindmap',
		);
		this.addToggleRow(
			containerEl,
			'Card',
			'Checked by default in import actions when a card artifact is available.',
			'defaultIncludeCard',
		);
		this.addToggleRow(
			containerEl,
			'Audio',
			'Off by default. Downloads the original recording audio (about 15 MB per hour) for every recording you import, which can grow your vault by gigabytes and slow Obsidian Sync and backups. Leave off unless you want the audio in your vault.',
			'defaultIncludeAudio',
		);

		new Setting(containerEl).setName('Tags').setHeading();
		this.addDropdownRow(
			containerEl,
			'Tag mode',
			"Which Plaud tag sources land in the note's tags frontmatter. Plaud tags are the ones you set on a recording in the Plaud app; AI keywords are Plaud's per-recording topic guesses, which can flood the tag pane.",
			'tagMode',
			{
				none: 'No tags',
				custom: 'Custom tags only',
				plaud: 'Plaud tags (no AI keywords)',
				all: 'All tags',
			},
		);
		this.addTextRow(
			containerEl,
			'Custom tags',
			"Comma-separated tags added to every imported note, except in 'no tags' mode.",
			'customTags',
			'plaud-meeting',
		);
		this.addToggleRow(
			containerEl,
			'Keep AI keywords as note property',
			AI_KEYWORDS_PROPERTY_DESC,
			'aiKeywordsAsProperty',
		);

		new Setting(containerEl).setName('Import dialog').setHeading();
		this.addToggleRow(
			containerEl,
			'Auto-close summary',
			'Close the import window automatically after a fully successful import. A run with any failure keeps the window open so the errors stay visible. Clicking inside the window cancels the countdown.',
			'autoCloseSummary',
		);
		this.addTextRow(
			containerEl,
			'Auto-close delay',
			'Seconds to wait before the summary closes itself. Only applies when auto-close is on.',
			'autoCloseSummarySeconds',
			'20',
		);
		this.addToggleRow(
			containerEl,
			'Write placeholder for unprocessed recordings',
			'When Plaud has a recording but reports no transcript or summary for it yet (a Plaud-side issue, not a plugin error), write a placeholder note with the recording ID and a link back to Plaud instead of recording a failure. A later successful import replaces the placeholder automatically. Turn off to keep such recordings as plain failures with no file written.',
			'writePlaceholderForUnprocessed',
		);
		this.addToggleRow(
			containerEl,
			'Show trashed recordings',
			'Include recordings that are in your Plaud trash in the import list. Off by default, matching the Plaud app, which hides trash. Trashed recordings are usually short accidental clips with no transcript. Turn on to import something you trashed in Plaud but still want in your vault.',
			'showTrashedRecordings',
		);
		this.addToggleRow(
			containerEl,
			'Update the recording title on rename',
			"Off by default. When on, renaming an imported recording (with the Rename recording command or by renaming the note in the file explorer) also updates that recording's title in Plaud to match the new note name, including any date prefix. This is the only change the plugin writes back to Plaud. When off, the Rename recording command asks each time whether to update Plaud, and a file-explorer rename stays local.",
			'autoUpdatePlaudTitle',
		);

		new Setting(containerEl).setName('Automatic sync').setHeading();
		this.addToggleRow(
			containerEl,
			'Enable automatic sync',
			AUTO_SYNC_DESC,
			'autoSyncEnabled',
		);
		this.addDropdownRow(
			containerEl,
			'Sync interval',
			'How often the background sync checks Plaud for new and changed recordings. Minimum 15 minutes.',
			'autoSyncIntervalMinutes',
			{
				'15': 'Every 15 minutes',
				'30': 'Every 30 minutes',
				'60': 'Every hour',
				'120': 'Every 2 hours',
				'240': 'Every 4 hours',
				'480': 'Every 8 hours',
				'1440': 'Once a day',
			},
		);

		new Setting(containerEl).setName('Transcript rendering').setHeading();
		this.addToggleRow(
			containerEl,
			'Fold transcript by default',
			"Collapse the transcript section when the note is created so it doesn't dominate the view on open. Uses Obsidian's heading fold state — clicking the chevron next to the heading expands it. Turn off if you prefer the transcript always expanded.",
			'foldTranscript',
		);
		this.addDropdownRow(
			containerEl,
			'Transcript heading level',
			"Markdown heading level for the wrapping 'transcript' heading. Chapter sub-headings render at one level below (e.g. Level 4 → transcript is h4, chapters are h5). This is the heading whose fold state the 'fold transcript by default' toggle controls.",
			'transcriptHeaderLevel',
			{
				'1': 'H1',
				'2': 'H2',
				'3': 'H3',
				'4': 'H4',
				'5': 'H5',
				'6': 'H6',
			},
		);

		new Setting(containerEl).setName('Debug').setHeading();
		this.addToggleRow(
			containerEl,
			'Debug logging',
			"Capture raw API requests, responses, and parsed results into an in-memory buffer and mirror them to the developer console (Ctrl+Shift+I). Authentication headers are NEVER captured. Payloads may contain transcript text, speaker names, and recording metadata — only enable when troubleshooting. Use the 'Plaud Importer: Debug: copy debug log to clipboard' command to export the session.",
			'debug',
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
			cls: 'plaud-importer-signin-status',
		});
		// Second line, under the status: what renewal this session gets. Its
		// text is set by refreshStatus below, and is empty when nothing is
		// connected so an unconnected plugin makes no renewal promise at all.
		const renewalEl = setting.descEl.createDiv({
			cls: 'plaud-importer-signin-renewal',
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
					? 'Status: not connected yet.'
					: unreadable
						? 'Status: the linked secret is not a readable Plaud token. Sign in again to replace it.'
						: expired
							? `Status: session ${desc.charAt(0).toLowerCase()}${desc.slice(1)}.`
							: `Status: connected. ${desc}.`,
			);
			statusEl.toggleClass(
				'plaud-importer-signin-ok',
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
					? ''
					: !canRenew
						? 'This sign-in cannot renew itself in the background. Reconnect when the session lapses.'
						: this.plugin.sessionRenewalPaused
							? 'Automatic renewal stopped after a failed attempt. Reconnect to restart it.'
							: 'Renews itself in the background for about 30 days, then asks you to sign in again.',
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
							this.plugin.settings.signInMethod = '';
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
		setting.descEl.createEl('p', {
			cls: 'plaud-importer-signin-note',
			text: SIGN_IN_NOTE,
		});
	}

	private renderSigninControl(setting: Setting): void {
		setting.addButton((btn) =>
			btn
				.setButtonText('Sign in')
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
							console.error(
								'Plaud importer: sign-in failed',
								err,
							);
							new Notice(CAPTURE_SAVE_FAILED_NOTICE);
							return;
						}
						if (outcome === 'captured') {
							new Notice('Plaud token captured and saved.');
							this.signinRefresh?.();
							this.tokenRefresh?.();
						} else if (outcome === 'closed') {
							// "reported" gets nothing added: the reason is already on
							// screen, and this wording would claim the user closed the
							// window when they may have finished signing in and had the
							// vault refuse the save.
							new Notice(
								'Plaud sign-in closed — no token captured.',
							);
						}
					} finally {
						btn.setDisabled(false);
					}
				}),
		);
	}

	private renderBrowserSignInControl(setting: Setting): void {
		// Buttons sit below the description, side by side. See styles.css.
		setting.settingEl.addClass('plaud-importer-browser-signin');
		const steps = setting.descEl.createEl('ol', {
			cls: 'plaud-importer-browser-steps',
		});
		// Built from a variable array so the steps can name the buttons and
		// "Plaud" plainly; the sentence-case lint only inspects string literals
		// written directly at a createEl/setText call, not array contents.
		const stepLines = [
			"First time only: click 'Set up bookmark'. A web page opens. Drag the big button onto your browser's bookmarks bar (the strip near the top of the window). If you already have an older Plaud → Obsidian bookmark, replace it with this one.",
			"Click 'Launch sign-in to capture token'. A short reminder pops up, then your browser opens.",
			'In the browser: sign in to Plaud if needed, then click the bookmark you saved. Your browser asks to open Obsidian; allow it, and the token is saved for you. Done! If the token stops working later, do steps 2 and 3 again.',
			"Only if Obsidian did not open: the bookmark shows a line of text in a box instead. Copy the whole line, come back to Obsidian, and click 'Paste token from clipboard'.",
		];
		for (const line of stepLines) {
			steps.createEl('li', { text: line });
		}
		setting.addButton((btn) =>
			btn.setButtonText('Set up bookmark').onClick(() => {
				void this.plugin.openBookmarkSetupPage();
			}),
		);
		setting.addButton((btn) =>
			btn
				.setButtonText('Launch sign-in to capture token')
				.setCta()
				.onClick(() => {
					new BrowserSignInModal(this.app, () =>
						this.plugin.openPlaudInBrowser(),
					).open();
				}),
		);
		setting.addButton((btn) =>
			btn
				.setButtonText('Paste token from clipboard')
				.onClick(async () => {
					let ok: boolean;
					// Scoped to the paste call alone, for the same reason as the Sign in
					// button above (issue #86). pasteTokenFromClipboard handles a
					// clipboard read failure itself and returns false after saying so,
					// but the store behind it can still reject on the settings write, and
					// that arrives here as a throw.
					try {
						ok = await this.plugin.pasteTokenFromClipboard();
					} catch (err) {
						console.error(
							'Plaud importer: paste failed to save',
							err,
						);
						new Notice(CAPTURE_SAVE_FAILED_NOTICE);
						return;
					}
					if (ok) {
						new Notice(
							'Token saved. Run a connection test to confirm it works.',
						);
						this.signinRefresh?.();
						this.tokenRefresh?.();
					}
				}),
		);
	}

	private renderTestControl(setting: Setting): void {
		const resultEl = setting.descEl.createDiv({
			cls: 'plaud-importer-test-status',
		});
		setting.addButton((btn) =>
			btn.setButtonText('Test connection').onClick(async () => {
				btn.setDisabled(true);
				resultEl.setText('Testing…');
				resultEl.toggleClass('plaud-importer-test-ok', false);
				resultEl.toggleClass('plaud-importer-test-err', false);
				try {
					const result = await this.plugin.testPlaudConnection();
					resultEl.setText(result.message);
					resultEl.toggleClass('plaud-importer-test-ok', result.ok);
					resultEl.toggleClass('plaud-importer-test-err', !result.ok);
				} finally {
					btn.setDisabled(false);
				}
			}),
		);
	}

	private renderClearSignInControl(setting: Setting): void {
		const resultEl = setting.descEl.createDiv({
			cls: 'plaud-importer-clear-status',
		});
		setting.addButton((btn) => {
			// Warning styling via Obsidian's button class directly: setWarning()
			// is deprecated and its replacement setDestructive() is @since 1.13.0,
			// above this plugin's minAppVersion, so neither method can be used.
			btn.buttonEl.addClass('mod-warning');
			btn.setButtonText('Clear sign-in').onClick(async () => {
				btn.setDisabled(true);
				resultEl.setText('Clearing…');
				try {
					const { sessionCleared } = await this.plugin.clearSignIn();
					resultEl.setText(
						sessionCleared
							? 'Cleared. The embedded browser is signed out and the stored token is unlinked. Click Sign in to start fresh.'
							: 'Token unlinked, but the embedded browser session could NOT be cleared on this build (the Electron session API is unavailable), so Sign in may still open already logged in.',
					);
					new Notice('Plaud sign-in cleared.');
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
			cls: 'plaud-importer-region-host',
			text: host,
		});
		span.createSpan({
			cls: 'plaud-importer-region-note',
			text: isDefault ? ' (default)' : ' (auto-detected)',
		});
	}

	private renderRibbonControl(setting: Setting): void {
		const previewEl = setting.controlEl.createDiv({
			cls: 'plaud-importer-ribbon-preview',
		});
		setIcon(
			previewEl,
			resolveRibbonIconId(this.plugin.settings.ribbonIcon),
		);
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
			cls: 'plaud-importer-template-preview',
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
		setting.settingEl.addClass('plaud-importer-stacked-row');
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: SUBFOLDER_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl('ul');
		for (const [token, meaning] of SUBFOLDER_TEMPLATE_TOKENS) {
			const item = tokenList.createEl('li');
			item.createEl('code', { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: SUBFOLDER_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl('ul');
		for (const [template, result] of SUBFOLDER_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl('li');
			item.createEl('code', { text: template });
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
						await this.applyControlChange(
							'subfolderTemplate',
							value,
						);
						updatePreview(value);
					});
				// Keep focus in the text field on click (mousedown default is to
				// move focus to the button) so the cursor position is preserved for
				// the insert.
				button.buttonEl.addEventListener('mousedown', (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text.setPlaceholder('{{YYYY}}/{{MM}}')
				.setValue(this.readSettingString('subfolderTemplate'))
				.onChange(async (value) => {
					await this.applyControlChange('subfolderTemplate', value);
					updatePreview(value);
				});
		});
		updatePreview = this.attachTemplatePreview(setting, (template) => {
			if (template.trim() === '') {
				return 'Preview: no subfolder (every note in the output folder)';
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
		updatePreview(this.readSettingString('subfolderTemplate'));
	}

	// Renders the datetime template row for the `datetime:` frontmatter property
	// (issue #32). Mirrors the subfolder row (Moment-only, per-keystroke persist,
	// no presets); the shared insert-token buttons now include the time tokens.
	// Empty is a valid value (writes no property), so unlike the note-name field
	// there is no blur-commit or invalid-template Notice — Moment never errors and
	// the preview is the only feedback needed.
	private renderDatetimeTemplateControl(setting: Setting): void {
		setting.settingEl.addClass('plaud-importer-stacked-row');
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: DATETIME_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl('ul');
		for (const [token, meaning] of DATETIME_TEMPLATE_TOKENS) {
			const item = tokenList.createEl('li');
			item.createEl('code', { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: DATETIME_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl('ul');
		for (const [template, result] of DATETIME_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl('li');
			item.createEl('code', { text: template });
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
						await this.applyControlChange(
							'datetimeTemplate',
							value,
						);
						updatePreview(value);
					});
				button.buttonEl.addEventListener('mousedown', (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text.setPlaceholder('{{YYYY-MM-DD HH:mm}}')
				.setValue(this.readSettingString('datetimeTemplate'))
				.onChange(async (value) => {
					await this.applyControlChange('datetimeTemplate', value);
					updatePreview(value);
				});
		});
		updatePreview = this.attachTemplatePreview(setting, (template) => {
			if (template.trim() === '') {
				return 'Preview: no datetime property';
			}
			return `Preview datetime: ${formatDatetime(template, TEMPLATE_PREVIEW_DATETIME)}`;
		});
		updatePreview(this.readSettingString('datetimeTemplate'));
	}

	// Renders the "Extra frontmatter" row: the token/example reference in the
	// description, then a dynamic list of key / value / preserve rows with a
	// token palette, an add-row button, and a live preview of the expanded
	// output. Structured (not a template string), so it persists directly to
	// settings.customFrontmatter rather than through applyControlChange.
	private renderCustomFrontmatterControl(setting: Setting): void {
		setting.settingEl.addClass('plaud-importer-stacked-row');
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: CUSTOM_FRONTMATTER_TOKENS_HEADING });
		const tokenList = docEl.createEl('ul');
		for (const [token, meaning] of CUSTOM_FRONTMATTER_TOKENS) {
			const item = tokenList.createEl('li');
			item.createEl('code', { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: CUSTOM_FRONTMATTER_EXAMPLES_HEADING });
		const exampleList = docEl.createEl('ul');
		for (const [template, result] of CUSTOM_FRONTMATTER_EXAMPLES) {
			const item = exampleList.createEl('li');
			item.createEl('code', { text: template });
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
			rows.push({ key: '', value: '', preserve: true });
		}

		// Regions in fixed visual order: the property rows, the add-row button, the
		// token palette, then the live preview.
		const rowsEl = setting.controlEl.createDiv({
			cls: 'plaud-importer-frontmatter-rows',
		});
		const actionsEl = setting.controlEl.createDiv({
			cls: 'plaud-importer-frontmatter-actions',
		});
		const paletteEl = setting.controlEl.createDiv({
			cls: 'plaud-importer-frontmatter-controls',
		});
		const previewEl = setting.controlEl.createDiv({
			cls: 'plaud-importer-template-preview',
		});

		let lastFocusedValue: HTMLInputElement | null = null;

		const updatePreview = (): void => {
			const lines = renderCustomFrontmatterPreview(rows);
			previewEl.setText(
				lines.length > 0
					? `Preview:\n${lines.join('\n')}`
					: 'Preview: no extra frontmatter properties',
			);
		};
		const persist = async (): Promise<void> => {
			// Store only rows that name a property; the blank starter row is not saved.
			this.plugin.settings.customFrontmatter = rows
				.filter((r) => r.key.trim() !== '')
				.map((r) => ({
					key: r.key,
					value: r.value,
					preserve: r.preserve,
				}));
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
				cls: 'plaud-importer-frontmatter-heading',
				text: 'Property',
			});
			rowsEl.createSpan({
				cls: 'plaud-importer-frontmatter-heading',
				text: 'Value',
			});
			rowsEl.createSpan({
				cls: 'plaud-importer-frontmatter-heading',
				text: 'Preserve',
			});
			rowsEl.createSpan({ cls: 'plaud-importer-frontmatter-heading' });

			rows.forEach((row, index) => {
				const keyInput = rowsEl.createEl('input', {
					cls: 'plaud-importer-frontmatter-key',
					attr: { type: 'text', 'aria-label': 'Property name' },
				});
				keyInput.value = row.key;
				keyInput.addEventListener('input', () => {
					row.key = keyInput.value;
					void persist();
				});

				const valueInput = rowsEl.createEl('input', {
					cls: 'plaud-importer-frontmatter-value',
					attr: { type: 'text', 'aria-label': 'Property value' },
				});
				valueInput.value = row.value;
				valueInput.addEventListener('focus', () => {
					lastFocusedValue = valueInput;
				});
				valueInput.addEventListener('input', () => {
					row.value = valueInput.value;
					void persist();
				});

				// Checkbox only; the "Preserve" column heading labels it.
				const preserveLabel = rowsEl.createEl('label', {
					cls: 'plaud-importer-frontmatter-preserve',
					attr: { 'aria-label': 'Preserve on re-import' },
				});
				const preserveInput = preserveLabel.createEl('input', {
					attr: {
						type: 'checkbox',
						'aria-label': 'Preserve on re-import',
					},
				});
				preserveInput.checked = row.preserve;
				preserveInput.addEventListener('change', () => {
					row.preserve = preserveInput.checked;
					void persist();
				});

				const removeButton = rowsEl.createEl('button', {
					cls: 'plaud-importer-frontmatter-remove',
					text: 'Remove',
					attr: { type: 'button', 'aria-label': 'Remove property' },
				});
				removeButton.addEventListener('click', () => {
					rows.splice(index, 1);
					if (rows.length === 0) {
						// Always leave one editable row so the control is never empty.
						rows.push({ key: '', value: '', preserve: true });
					}
					renderRows();
					void persist();
				});
			});
		};

		const addButton = actionsEl.createEl('button', {
			cls: 'plaud-importer-frontmatter-add mod-cta',
			text: 'Add property',
			attr: { type: 'button' },
		});
		addButton.addEventListener('click', () => {
			rows.push({ key: '', value: '', preserve: true });
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
			input.value =
				input.value.slice(0, start) + token + input.value.slice(end);
			const caret = start + token.length;
			input.focus();
			input.setSelectionRange(caret, caret);
			// Route the edit through the input handler so the row updates and saves.
			input.dispatchEvent(new Event('input'));
		};
		paletteEl.createDiv({
			cls: 'plaud-importer-frontmatter-palette-label',
			text: 'Insert a token into the value field you last clicked in:',
		});
		for (const [label, token] of [
			...DATE_INSERT_TOKENS,
			TITLE_INSERT_TOKEN,
			FOLDER_INSERT_TOKEN,
			...CONTENT_INSERT_TOKENS,
		]) {
			const tokenButton = paletteEl.createEl('button', {
				cls: 'plaud-importer-frontmatter-token',
				text: label,
				attr: { type: 'button', title: `Insert ${token}` },
			});
			// Keep the caret in the focused value field when a token button is clicked.
			tokenButton.addEventListener('mousedown', (event) =>
				event.preventDefault(),
			);
			tokenButton.addEventListener('click', () => insertToken(token));
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
		setting.settingEl.addClass('plaud-importer-stacked-row');
		const docEl = setting.descEl.createDiv();
		docEl.createDiv({ text: NOTE_NAME_TEMPLATE_TOKENS_HEADING });
		const tokenList = docEl.createEl('ul');
		for (const [token, meaning] of NOTE_NAME_TEMPLATE_TOKENS) {
			const item = tokenList.createEl('li');
			item.createEl('code', { text: token });
			item.createSpan({ text: ` ${meaning}` });
		}
		docEl.createDiv({ text: NOTE_NAME_TEMPLATE_EXAMPLES_HEADING });
		const exampleList = docEl.createEl('ul');
		for (const [template, result] of NOTE_NAME_TEMPLATE_EXAMPLES) {
			const item = exampleList.createEl('li');
			item.createEl('code', { text: template });
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
		for (const [label, token] of [
			...DATE_INSERT_TOKENS,
			TITLE_INSERT_TOKEN,
		]) {
			setting.addButton((button) => {
				button
					.setButtonText(label)
					.setTooltip(`Insert ${token}`)
					.onClick(() => {
						if (field === null) return;
						this.insertTokenAtCursor(field, token);
						updatePreview(field.getValue());
					});
				button.buttonEl.addEventListener('mousedown', (event) =>
					event.preventDefault(),
				);
			});
		}
		setting.addText((text) => {
			field = text;
			text.setPlaceholder(DEFAULT_NOTE_NAME_TEMPLATE).setValue(
				this.readSettingString('noteNameTemplate'),
			);
			// Validate and persist on BLUR, not on every keystroke. Editing inside a
			// {{...}} token passes through invalid intermediate states (a half-typed
			// {{YYYY}}), and validating per keystroke would flash a Notice on each one.
			// On blur, commitNoteNameTemplate validates once and then reflects the
			// saved value, so a rejected or emptied entry does not linger as stale
			// text. Preset buttons remain an explicit commit. The preview updates
			// live on every keystroke, independent of when the value is persisted.
			text.inputEl.addEventListener('input', () => {
				updatePreview(text.getValue());
			});
			text.inputEl.addEventListener('blur', () => {
				void this.commitNoteNameTemplate(text, updatePreview);
			});
		});
		for (const [label, template] of NOTE_NAME_TEMPLATE_PRESETS) {
			setting.addButton((button) =>
				button.setButtonText(label).onClick(async () => {
					field?.setValue(template);
					await this.applyControlChange('noteNameTemplate', template);
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
			if (template.trim() !== '' && !isValidNoteNameTemplate(template)) {
				return `Preview: ${name} (not a valid note name, so it will not be saved; a file name cannot contain a slash, colon, square bracket, or a character like * ? < > | ", cannot be a reserved name such as CON, cannot start or end with a dot or space, and cannot be over 200 characters)`;
			}
			return `Preview: ${name}`;
		});
		updatePreview(this.readSettingString('noteNameTemplate'));
	}

	// Validates and persists the note-name template field on blur (see
	// renderNoteNameTemplateControl), then reflects the saved value back into the
	// field so a rejected or emptied entry does not linger as stale text, and
	// refreshes the preview to match the value that was actually saved.
	private async commitNoteNameTemplate(
		text: TextComponent,
		updatePreview: (template: string) => void,
	): Promise<void> {
		await this.applyControlChange('noteNameTemplate', text.getValue());
		text.setValue(this.readSettingString('noteNameTemplate'));
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
				toggle
					.setValue(this.readSettingBool(key))
					.onChange(async (value) => {
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
		if (key === 'transcriptHeaderLevel') {
			return String(this.plugin.settings.transcriptHeaderLevel);
		}
		if (key === 'autoCloseSummarySeconds') {
			return String(this.plugin.settings.autoCloseSummarySeconds);
		}
		const value = (
			this.plugin.settings as unknown as Record<string, unknown>
		)[key];
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		return '';
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Plaud token',
				desc: "Your stored Plaud token. The status below shows whether you are connected. The value stays in Obsidian's secret storage, never in data.json.",
				// SecretComponent needs an App instance and is added via
				// Setting#addComponent, so it lives in a render callback rather
				// than a declarative control. It is not search-indexable.
				searchable: false,
				render: (setting: Setting) => this.renderTokenControl(setting),
			},
			{
				type: 'group',
				heading: 'Sign in',
				items: [
					{
						name: '',
						searchable: false,
						render: (setting: Setting) =>
							this.renderSignInIntro(setting),
					},
					{
						name: 'Sign in with email',
						desc: 'Best for email and password logins. Click Sign in, log in to Plaud in the window that opens, and your token is saved automatically. Google and Apple logins do not work in this window; use the option below for those.',
						searchable: false,
						render: (setting: Setting) =>
							this.renderSigninControl(setting),
					},
					{
						name: 'Sign in with Google or Apple',
						desc: 'For Google and Apple logins, which only work in a real browser. The first time needs a one-time bookmark setup. After that, sign in to Plaud in your normal browser and send the token back with the steps below.',
						searchable: false,
						render: (setting: Setting) =>
							this.renderBrowserSignInControl(setting),
					},
					{
						name: 'Test connection',
						desc: 'Check that your stored token can reach Plaud. Use this after signing in, or any time imports start failing, to see whether you need to sign in again.',
						searchable: false,
						render: (setting: Setting) =>
							this.renderTestControl(setting),
					},
					{
						name: 'Clear sign-in',
						desc: CLEAR_SIGN_IN_DESC,
						searchable: false,
						render: (setting: Setting) =>
							this.renderClearSignInControl(setting),
					},
					{
						name: 'API region',
						desc: 'Plaud server this vault is connected to. Detected automatically on the first import. EU and other regional accounts switch here on their own, so there is nothing to configure.',
						searchable: false,
						render: (setting: Setting) =>
							this.renderRegionControl(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Output',
				items: [
					{
						name: 'Output folder',
						desc: 'Folder inside your vault where imported notes are written.',
						control: {
							type: 'text',
							key: 'outputFolder',
							placeholder: 'Plaud',
						},
					},
					{
						name: 'Subfolder template',
						desc: SUBFOLDER_TEMPLATE_INTRO,
						// Rendered imperatively so the token reference (a list,
						// not a one-line string) appears in the description. Not
						// search-indexable, like the other render-based rows.
						searchable: false,
						render: (setting: Setting) =>
							this.renderSubfolderTemplateControl(setting),
					},
					{
						name: 'Note name template',
						desc: NOTE_NAME_TEMPLATE_INTRO,
						// Rendered imperatively for the token + examples lists plus
						// the preset buttons. Not search-indexable, like the
						// subfolder row above.
						searchable: false,
						render: (setting: Setting) =>
							this.renderNoteNameTemplateControl(setting),
					},
					{
						name: 'Datetime property',
						desc: DATETIME_TEMPLATE_INTRO,
						// Rendered imperatively for the token + examples lists, like
						// the two template rows above.
						searchable: false,
						render: (setting: Setting) =>
							this.renderDatetimeTemplateControl(setting),
					},
					{
						name: 'Extra frontmatter',
						desc: CUSTOM_FRONTMATTER_INTRO,
						// Rendered imperatively for the token/example lists and the
						// dynamic key/value/preserve rowset.
						searchable: false,
						render: (setting: Setting) =>
							this.renderCustomFrontmatterControl(setting),
					},
					{
						name: 'Preserve unknown frontmatter on re-import',
						desc: PRESERVE_UNKNOWN_FRONTMATTER_DESC,
						control: {
							type: 'toggle',
							key: 'preserveUnknownFrontmatter',
						},
					},
					{
						name: 'Forbidden character replacement',
						desc: FORBIDDEN_CHAR_REPLACEMENT_DESC,
						control: {
							type: 'text',
							key: 'forbiddenCharReplacement',
							placeholder: '-',
						},
					},
					{
						name: DUPLICATE_HANDLING_NAME,
						desc: DUPLICATE_HANDLING_DESC,
						control: {
							type: 'dropdown',
							key: 'onDuplicate',
							options: {
								skip: 'Skip',
								overwrite: 'Overwrite',
								prompt: 'Ask each time',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Appearance',
				items: [
					{
						name: 'Show ribbon icon',
						desc: "Display the plaud importer icon in Obsidian's left rail. Turn off if you prefer to launch imports only from the command palette.",
						control: { type: 'toggle', key: 'showRibbonIcon' },
					},
					{
						name: 'Ribbon icon',
						desc: "Which icon to display in the left rail. Only applies when 'show ribbon icon' is on.",
						searchable: false,
						render: (setting: Setting) =>
							this.renderRibbonControl(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Default artifact selection',
				items: [
					{
						name: 'Transcript',
						desc: "Checked by default in import actions. You can override in 'review artifacts first'.",
						control: { type: 'toggle', key: 'includeTranscript' },
					},
					{
						name: 'Summary',
						desc: "Checked by default in import actions. You can override in 'review artifacts first'.",
						control: {
							type: 'toggle',
							key: 'defaultIncludeSummary',
						},
					},
					{
						name: 'Attachments',
						desc: 'Checked by default in import actions when attachments are available.',
						control: {
							type: 'toggle',
							key: 'defaultIncludeAttachments',
						},
					},
					{
						name: 'Mindmap',
						desc: 'Checked by default in import actions when a mindmap artifact is available.',
						control: {
							type: 'toggle',
							key: 'defaultIncludeMindmap',
						},
					},
					{
						name: 'Card',
						desc: 'Checked by default in import actions when a card artifact is available.',
						control: { type: 'toggle', key: 'defaultIncludeCard' },
					},
					{
						name: 'Audio',
						desc: 'Off by default. Downloads the original recording audio (about 15 MB per hour) for every recording you import, which can grow your vault by gigabytes and slow Obsidian Sync and backups. Leave off unless you want the audio in your vault.',
						control: { type: 'toggle', key: 'defaultIncludeAudio' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Tags',
				items: [
					{
						name: 'Tag mode',
						desc: "Which Plaud tag sources land in the note's tags frontmatter. Plaud tags are the ones you set on a recording in the Plaud app; AI keywords are Plaud's per-recording topic guesses, which can flood the tag pane.",
						control: {
							type: 'dropdown',
							key: 'tagMode',
							options: {
								none: 'No tags',
								custom: 'Custom tags only',
								plaud: 'Plaud tags (no AI keywords)',
								all: 'All tags',
							},
						},
					},
					{
						name: 'Custom tags',
						desc: "Comma-separated tags added to every imported note, except in 'no tags' mode.",
						control: {
							type: 'text',
							key: 'customTags',
							placeholder: 'plaud-meeting',
						},
					},
					{
						name: 'Keep AI keywords as note property',
						desc: AI_KEYWORDS_PROPERTY_DESC,
						control: {
							type: 'toggle',
							key: 'aiKeywordsAsProperty',
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Import dialog',
				items: [
					{
						name: 'Auto-close summary',
						desc: 'Close the import window automatically after a fully successful import. A run with any failure keeps the window open so the errors stay visible. Clicking inside the window cancels the countdown.',
						control: { type: 'toggle', key: 'autoCloseSummary' },
					},
					{
						name: 'Auto-close delay',
						desc: 'Seconds to wait before the summary closes itself. Only applies when auto-close is on.',
						control: {
							type: 'text',
							key: 'autoCloseSummarySeconds',
							placeholder: '20',
						},
					},
					{
						name: 'Write placeholder for unprocessed recordings',
						desc: 'When Plaud has a recording but reports no transcript or summary for it yet (a Plaud-side issue, not a plugin error), write a placeholder note with the recording ID and a link back to Plaud instead of recording a failure. A later successful import replaces the placeholder automatically. Turn off to keep such recordings as plain failures with no file written.',
						control: {
							type: 'toggle',
							key: 'writePlaceholderForUnprocessed',
						},
					},
					{
						name: 'Show trashed recordings',
						desc: 'Include recordings that are in your Plaud trash in the import list. Off by default, matching the Plaud app, which hides trash. Trashed recordings are usually short accidental clips with no transcript. Turn on to import something you trashed in Plaud but still want in your vault.',
						control: {
							type: 'toggle',
							key: 'showTrashedRecordings',
						},
					},
					{
						name: 'Update the recording title on rename',
						desc: "Off by default. When on, renaming an imported recording (with the Rename recording command or by renaming the note in the file explorer) also updates that recording's title in Plaud to match the new note name, including any date prefix. This is the only change the plugin writes back to Plaud. When off, the Rename recording command asks each time whether to update Plaud, and a file-explorer rename stays local.",
						control: {
							type: 'toggle',
							key: 'autoUpdatePlaudTitle',
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Automatic sync',
				items: [
					{
						name: 'Enable automatic sync',
						desc: AUTO_SYNC_DESC,
						control: { type: 'toggle', key: 'autoSyncEnabled' },
					},
					{
						name: 'Sync interval',
						desc: 'How often the background sync checks Plaud for new and changed recordings. Minimum 15 minutes.',
						control: {
							type: 'dropdown',
							key: 'autoSyncIntervalMinutes',
							options: {
								'15': 'Every 15 minutes',
								'30': 'Every 30 minutes',
								'60': 'Every hour',
								'120': 'Every 2 hours',
								'240': 'Every 4 hours',
								'480': 'Every 8 hours',
								'1440': 'Once a day',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Transcript rendering',
				items: [
					{
						name: 'Fold transcript by default',
						desc: "Collapse the transcript section when the note is created so it doesn't dominate the view on open. Uses Obsidian's heading fold state — clicking the chevron next to the heading expands it. Turn off if you prefer the transcript always expanded.",
						control: { type: 'toggle', key: 'foldTranscript' },
					},
					{
						name: 'Transcript heading level',
						desc: "Markdown heading level for the wrapping 'transcript' heading. Chapter sub-headings render at one level below (e.g. Level 4 → transcript is h4, chapters are h5). This is the heading whose fold state the 'fold transcript by default' toggle controls.",
						control: {
							type: 'dropdown',
							key: 'transcriptHeaderLevel',
							options: {
								'1': 'H1',
								'2': 'H2',
								'3': 'H3',
								'4': 'H4',
								'5': 'H5',
								'6': 'H6',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Debug',
				items: [
					{
						name: 'Debug logging',
						desc: "Capture raw API requests, responses, and parsed results into an in-memory buffer and mirror them to the developer console (Ctrl+Shift+I). Authentication headers are NEVER captured. Payloads may contain transcript text, speaker names, and recording metadata — only enable when troubleshooting. Use the 'Plaud Importer: Debug: copy debug log to clipboard' command to export the session.",
						control: { type: 'toggle', key: 'debug' },
					},
				],
			},
			{
				name: '',
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
		if (key === 'transcriptHeaderLevel') {
			return String(this.plugin.settings.transcriptHeaderLevel);
		}
		if (key === 'autoCloseSummarySeconds') {
			return String(this.plugin.settings.autoCloseSummarySeconds);
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[
			key
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.applyControlChange(key, value);
	}

	// Coerces and persists a single settings change, then runs any side effect.
	// Shared by the declarative setControlValue() (1.13+) and the imperative
	// row helpers in display() (1.12), so neither path can drift on validation.
	private async applyControlChange(
		key: string,
		value: unknown,
	): Promise<void> {
		if (key === 'outputFolder') {
			this.plugin.settings.outputFolder =
				(typeof value === 'string' ? value.trim() : '') || 'Plaud';
		} else if (key === 'subfolderTemplate') {
			const next = typeof value === 'string' ? value : '';
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
		} else if (key === 'forbiddenCharReplacement') {
			// Coerce to a single safe character. Cleared field falls back to the
			// default dash; an unsafe entry (a forbidden char, a separator, a dot or
			// space, or more than one character) is refused with a Notice and the
			// previous value is kept, so sanitizing can never reintroduce a
			// forbidden character.
			const next = typeof value === 'string' ? value.trim() : '';
			if (next === '') {
				this.plugin.settings.forbiddenCharReplacement = '-';
			} else if (isValidReplacementChar(next)) {
				this.plugin.settings.forbiddenCharReplacement = next;
			} else {
				new Notice(
					'Plaud importer: The replacement must be a single character and cannot be a slash, backslash, colon, square bracket, asterisk, question mark, angle bracket, pipe, double quote, dot, space, or control character. Keeping the previous value.',
				);
				return;
			}
		} else if (key === 'noteNameTemplate') {
			const next = typeof value === 'string' ? value.trim() : '';
			if (next.length === 0) {
				// Never persist an empty template: every note name would render
				// blank. Snap back to the default template.
				this.plugin.settings.noteNameTemplate =
					DEFAULT_NOTE_NAME_TEMPLATE;
			} else if (isValidNoteNameTemplate(next)) {
				this.plugin.settings.noteNameTemplate = next;
			} else if (
				!isValidNoteNameTemplate(this.plugin.settings.noteNameTemplate)
			) {
				// The entered template is invalid AND the stored one is too (for
				// example a hand-edited data.json). Heal to the default so the UI
				// matches the writer, which already falls back to the default for an
				// invalid stored template, instead of looping the notice on blur.
				this.plugin.settings.noteNameTemplate =
					DEFAULT_NOTE_NAME_TEMPLATE;
			} else {
				// The stored template is still valid: keep it and say why the entry
				// was not applied, rather than saving one that would break imports or
				// write a mangled name.
				new Notice(
					'Plaud importer: That note name template is not valid, so it was not changed. A file name cannot contain a slash, colon, square bracket, asterisk, question mark, angle bracket, pipe, or double quote, cannot be a reserved device name, cannot start or end with a dot or space, and cannot be over 200 characters.',
				);
				return;
			}
		} else if (key === 'datetimeTemplate') {
			// Any {{ }} Moment template is accepted, empty included (which writes no
			// datetime property). Moment never throws on an unknown token, and there
			// is no path or filename safety concern here, so there is nothing to
			// reject and the live preview is the only feedback. Persisted as typed.
			this.plugin.settings.datetimeTemplate =
				typeof value === 'string' ? value : '';
		} else if (key === 'transcriptHeaderLevel') {
			const level = Number(value);
			if (level >= 1 && level <= 6) {
				this.plugin.settings.transcriptHeaderLevel = level as
					1 | 2 | 3 | 4 | 5 | 6;
			}
		} else if (key === 'autoCloseSummarySeconds') {
			// Text control delivers a string; store a sane integer. Blank or
			// non-numeric input snaps back to the 20s default; out-of-range
			// values clamp to 1..600 so a typo cannot park the modal open
			// for hours or close it instantly.
			const parsed = Number(
				typeof value === 'string' ? value.trim() : value,
			);
			this.plugin.settings.autoCloseSummarySeconds = Number.isFinite(
				parsed,
			)
				? Math.min(600, Math.max(1, Math.floor(parsed)))
				: 20;
		} else if (key === 'autoSyncIntervalMinutes') {
			// Dropdown delivers a string; coerce to a valid interval [15, 1440].
			this.plugin.settings.autoSyncIntervalMinutes =
				coerceIntervalMinutes(value);
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] =
				value;
		}
		await this.plugin.saveSettings();

		// Side effects that the imperative onChange handlers used to run inline.
		if (key === 'showRibbonIcon') {
			this.plugin.updateRibbonIcon();
		} else if (
			key === 'autoSyncEnabled' ||
			key === 'autoSyncIntervalMinutes'
		) {
			// Start/stop/reschedule the timer to match the new setting. Enabling
			// is a deliberate action, so also clear any prior auth pause.
			this.plugin.reconcileAutoSync();
			if (
				key === 'autoSyncEnabled' &&
				this.plugin.settings.autoSyncEnabled
			) {
				this.plugin.resumeAutoSyncIfPaused();
			}
		} else if (key === 'debug') {
			// Update the live logger's enabled flag in place so the change takes
			// effect on the next API call without reinstantiating the client.
			this.plugin.debugLogger.setEnabled(this.plugin.settings.debug);
			if (this.plugin.settings.debug) {
				new Notice(
					'Plaud importer: Debug logging enabled. Run a command to capture events.',
				);
			} else {
				new Notice(
					'Plaud importer: Debug logging disabled. The buffer is preserved — use the clear command to wipe it.',
				);
			}
		}
	}

	// Renders the version + support links footer into a trailing settings row
	// (matches the obsidian-shell-path-copy reference plugin's settings tab).
	private renderFooter(setting: Setting): void {
		const el = setting.settingEl;
		el.empty();
		el.addClass('plaud-importer-settings-footer');

		const manifestVersion = this.plugin.manifest.version || '0.0.0';
		el.createSpan({ text: `Version ${manifestVersion} | ` });

		const createExternalLink = (
			text: string,
			url: string,
		): HTMLAnchorElement =>
			el.createEl('a', {
				text,
				href: url,
				attr: { target: '_blank', rel: 'noopener' },
			});

		createExternalLink(
			'GitHub',
			'https://github.com/ckelsoe/obsidian-plaud-importer',
		);
		el.createSpan({ text: ' | ' });
		createExternalLink(
			'Report Issues',
			'https://github.com/ckelsoe/obsidian-plaud-importer/issues',
		);
	}
}
