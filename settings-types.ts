/**
 * The plugin's settings shape, its defaults, and the small helpers that coerce
 * a stored value back into range. Extracted from main.ts, which held them
 * beside both the settings UI that renders them and the plugin that consumes
 * them.
 *
 * Its own file because three places need it and none should have to import the
 * plugin to get it: the plugin itself, the settings tab, and the capture
 * store's generic parameter.
 */
import { DEFAULT_NOTE_NAME_TEMPLATE } from './note-writer';
import type { CustomFrontmatterRow, TagMode } from './note-writer';
import type { SignInMethod } from './reconnect-routing';

// Curated list of Lucide icon IDs offered in the "Ribbon icon" setting.
// Each entry is a valid Lucide ID bundled with Obsidian's icon set. This
// list is intentionally short for now — a future upgrade can swap the
// dropdown for a full searchable picker without changing the settings
// schema (the stored value is a plain Lucide ID either way).
export const RIBBON_ICON_CHOICES: ReadonlyArray<{ id: string; label: string }> =
	[
		{ id: 'audio-lines', label: 'Audio waveform (default)' },
		{ id: 'mic', label: 'Microphone' },
		{ id: 'mic-vocal', label: 'Vocal mic' },
		{ id: 'headphones', label: 'Headphones' },
		{ id: 'file-audio-2', label: 'Audio file' },
		{ id: 'podcast', label: 'Podcast' },
		{ id: 'radio', label: 'Radio' },
		{ id: 'cassette-tape', label: 'Cassette tape' },
		{ id: 'volume-2', label: 'Speaker' },
		{ id: 'notebook-pen', label: 'Notebook' },
		{ id: 'captions', label: 'Captions' },
		{ id: 'users-round', label: 'Meeting participants' },
	];
export const DEFAULT_RIBBON_ICON = 'audio-lines';

/**
 * Coerce a stored ribbon icon ID to a known-good value. Protects against
 * a hand-edited `data.json` or a setting left over from a future build
 * that drops an icon from the curated list — either would render an
 * empty ribbon slot otherwise.
 */
export function resolveRibbonIconId(stored: string | undefined): string {
	if (typeof stored !== 'string' || stored.length === 0) {
		return DEFAULT_RIBBON_ICON;
	}
	return RIBBON_ICON_CHOICES.some((choice) => choice.id === stored)
		? stored
		: DEFAULT_RIBBON_ICON;
}

export interface PlaudImporterSettings {
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
	// IANA time-zone name (e.g. "America/New_York") used to render a recording's
	// times ONLY when Plaud's payload carried no capture offset for it (older
	// recordings; not seen on current accounts). Empty (the default) falls back to
	// the importing device's own zone. Normal recordings always render in their
	// own capture zone regardless of this.
	fallbackTimezone: string;
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
	onDuplicate: 'skip' | 'overwrite' | 'prompt';
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

// Current settings schema version. A fresh install is born at this version and
// runs no migrations; loadSettings compares the STORED version against it.
//   1 (issue #30): date templates moved to Moment tokens.
//   2 (issue #87): the sign-in partition became per-vault, so an existing window
//      session no longer lives where this vault looks for it. Nothing in
//      data.json changes; the bump exists to fire the one-time heads-up exactly
//      once per vault rather than on every load.
export const CURRENT_SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: '',
	apiBaseUrl: 'https://api.plaud.ai',
	outputFolder: 'Plaud',
	subfolderTemplate: '{{YYYY}}/{{MM}}',
	noteNameTemplate: DEFAULT_NOTE_NAME_TEMPLATE,
	datetimeTemplate: '',
	fallbackTimezone: '',
	// A real, editable example so the setting is self-documenting on a fresh
	// install. Writes "Recording Source: Plaud Importer" to new imports until the
	// user edits or removes it. Existing configs (which already stored a value)
	// are unaffected.
	customFrontmatter: [
		{ key: 'Recording Source', value: 'Plaud Importer', preserve: true },
	],
	preserveUnknownFrontmatter: true,
	forbiddenCharReplacement: '-',
	onDuplicate: 'prompt',
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
	tagMode: 'plaud',
	customTags: 'plaud-meeting',
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
	signInMethod: '',
	sessionWarnedForExpMs: 0,
	settingsVersion: CURRENT_SETTINGS_VERSION,
};
