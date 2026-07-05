# Changelog

All notable changes to Plaud Importer will be documented in this file.

## [Unreleased]

### Changed

- **Date formats in the subfolder and note-name templates now use real Moment syntax** (the same format the core Daily Notes plugin uses), and every token works in both fields. You can now write any date layout, including named months and weekdays, and put a whole layout in one `{{ }}`: `{{YYYY/MM MMMM/YYYY-MM-DD dddd}}` files a recording under `2026/07 July/2026-07-05 Sunday`. Tokens are the standard Moment ones, so `{{YYYY}}` is the year, `{{MM}}` the month, `{{DD}}` the day, `{{dddd}}` the weekday name, `{{WW}}` the ISO week, and `{{Q}}` the quarter. Keep your own words outside the braces, since bare letters inside are read as date tokens. This resolves a report that `{{YYYY}}`, combined tokens like `{{MM MMMM}}`, and a weekday token did not work, and that named months worked only in the note name and not the subfolder.
- Your existing subfolder and note-name templates are migrated automatically the first time this version loads, and the migration is output-preserving: every note lands with exactly the same name and folder as before. Month and weekday names render in English, matching the previous behavior regardless of your Obsidian display language.

### Added

- **Live preview and insert-token buttons on both template fields.** Each template setting now shows the resulting folder or note name for a sample recording as you type, and a row of buttons (Year, Month, Day, Weekday, Quarter, Week, and Title on the note-name field) inserts the correct token at the cursor, so you do not have to remember the exact spelling. The preview also flags a template that would produce an invalid note name before you save it.

## [0.20.0] - 2026-07-04

### Added

- **Configurable note name template.** A new setting builds each note's name from a template, using the same `{{...}}` tokens as the subfolder setting plus a `{{title}}` token. Put the date wherever you like, before or after the title: `{{yyyy}}-{{MM}}-{{dd}} {{title}}` gives `2026-07-03 Team sync`, and `{{title}} {{yyyy}}-{{MM}}-{{dd}}` gives `Team sync 2026-07-03`. Preset buttons fill in ISO, US, and EU orders, or type your own with named-month (`{{MMM}}`), 2-digit-year (`{{yy}}`), week (`{{ww}}`), and quarter (`{{Q}}`) tokens. The default reproduces the previous `YYYY-MM-DD` naming, so nothing changes unless you set it. The name has to be usable as a filename, so a template with a slash, colon, or unknown token is rejected. The `date` property inside each note stays `YYYY-MM-DD` for Dataview and sorting.
- **Rename an imported recording from Obsidian.** A new "Rename recording" command and a "Rename imported recording" item in a note's right-click menu rename a Plaud note and its attachments folder together, so the `-assets` folder and the note's embedded images stay in sync. If you rename a Plaud note yourself (from the file explorer or the built-in rename), the plugin now moves its attachments folder to match automatically. By default the rename is local; see the title write-back setting below to also update the title in Plaud.
- **Optionally update the title in Plaud when you rename.** A new setting, "Update the recording title on rename" (off by default), can push a rename back to Plaud so the recording's title there matches your note name. With it off, the Rename recording command asks each time whether to update Plaud, and a file-explorer rename stays local. With it on, both the command and a file-explorer rename update Plaud automatically. The title sent is your new note name exactly, including any date prefix, so Plaud matches what you see in Obsidian. This is the only change the plugin writes back to Plaud; everything else is read-only. After an update, the note's sync marker is refreshed so background sync does not re-import the recording just because you renamed it.

### Changed

- On import, the recording's own date is placed in each note's name by the template, replacing any date already in the title, so notes sort by day in the file explorer and every name reads the same way. A title with no date gets the recording date. A title that starts with a date, in any common form (including one glued to text such as `04/13-Meeting`), has that date removed and the recording's date used instead. The date always comes from the recording, the same value as the note's `date` property, so a title whose date was edited or written differently ends up with the recording's date. Existing notes are not renamed; this applies to new imports.
- **A changed recording's note is now renamed to match, instead of being left at its old name.** When background auto-sync or a manual re-import picks up a recording whose name changed in Plaud, the plugin renames the existing note and its attachments folder to the current name before updating the content, rather than overwriting the old-named note in place. Combined with the date-prefix and note-name-template changes above, a synced recording whose note does not yet follow your current naming is renamed on its next change, so several notes can move at once as a backlog re-syncs. Only recordings that changed in Plaud, or that you re-import by hand, are affected; notes are moved, not duplicated, and their embedded attachments move with them.

## [0.19.0] - 2026-07-03

### Added

- Imported notes now record which Plaud folder each recording is in. Every note gets a `plaud-folder` frontmatter field holding the folder name(s), so you can find and group recordings by their Plaud folder in Obsidian, for example with Dataview. A recording that is not filed in a folder gets no field.

### Fixed

- Plaud folder tags now appear as readable names. A recording filed in a Plaud folder used to write the folder's internal id (a long code) into the note's `tags`; imported notes now use the folder name instead. Names are converted to valid tag form, so spaces and symbols become dashes.

## [0.18.1] - 2026-07-03

### Changed

- Development tooling: updated the Obsidian marketplace lint plugin to its 0.4 line and adopted the `createSpan`/`createDiv` DOM helpers it now prefers over `createEl('span'/'div')`. No behavior change.

### Fixed

- Background auto-sync now imports a recording as soon as its transcript or summary is ready, instead of waiting for Plaud to finish pulling the original audio off the device. A recording could stay un-imported for a long time (sometimes hours) even though it was fully transcribed, because the plugin was gating on a device-sync flag that clears much later. Transcribed recordings now sync on the next check; if you import audio, a recording whose audio is not ready yet still imports and its audio lands on a later sync.
- Background auto-sync no longer stops scanning at the first already-synced recording. When several recordings piled up while sync was paused (for example after your Plaud session expired), a newer-imported recording could sit above older un-imported ones and cause auto-sync to stop before reaching them, so they were never imported. Auto-sync now scans each check until it reaches a page with nothing new, so a backlog drains fully.

## [0.18.0] - 2026-07-02

### Added

- Optional background auto-sync (off by default). When enabled, the plugin checks Plaud on a schedule (15 minutes to once a day) and imports new recordings automatically using your default import options. It also re-imports a recording you changed in Plaud, such as corrected speaker names or an edited transcript, including old recordings edited today. **A re-import overwrites that note and its downloaded artifacts with Plaud's current version, so edits you made to a synced note are replaced.** Only recordings that actually changed are touched; unchanged notes are never modified. The background job pauses with one notice if your Plaud session expires and resumes when you reconnect (test connection, re-import, re-enter your token, or toggle it off and on). Desktop only.
- **Backfill version markers for auto-sync** command. Notes imported before this release do not carry the marker auto-sync compares against, so their edits are not detected until the marker exists. Run this once after enabling auto-sync to make your existing library edit-detectable. It only adds a frontmatter marker and never rewrites note content.
- The import window now shows an **Update available** badge next to already-imported recordings that changed in Plaud since you imported them, so you can spot and re-import a stale note by hand.

## [0.17.1] - 2026-07-01

### Fixed

- Audio import is now fully best-effort: if the note's attachment folder cannot be created, the audio step logs and skips instead of letting the error escape, so a folder problem never fails the recording's import. Internal, no change to a normal import.

### Changed

- Documentation only: corrected the `parseAudioTempUrl` code comment (the audio URL is at the top level of the response, not inside a `data` envelope) and reattached a comment that had detached from its function. No behavior change.

## [0.17.0] - 2026-07-01

### Added

- Optionally download the original recording audio into your vault. A new **Audio** artifact appears in the import picker and as an **Audio** default in settings, both off by default. When you turn it on, each imported recording's audio file is saved next to the note and embedded as a playable clip under an **Audio** heading, so you can listen inline. Audio is large, roughly 15 MB per hour of recording, and it can grow your vault by gigabytes and slow Obsidian Sync and backups, so it stays off unless you opt in. Missing or expired audio never fails an import; the note and transcript still land.

## [0.16.0] - 2026-06-30

### Fixed

- If your Plaud session expired partway through a multi-select import, every remaining recording failed with the same "Plaud rejected your token" error and the run still reported as completed. The import now stops at the first recording that fails to authenticate, keeps the recordings it already imported, and shows how many were done. You can sign in again right there (email or Google/Apple), then a **Resume remaining** button finishes the recordings that were left, picking up exactly where it stopped.

## [0.15.0] - 2026-06-30

### Added

- Sign in again without leaving the import window. When your Plaud token has expired or was never set, the import error screen now shows a **Sign in** button (plus an **Other sign-in methods** section for Google and Apple sign-in) instead of sending you to Settings. After you sign in, the recording list reloads in place so you can pick up where you left off.

### Fixed

- The **Import selected** button could stay greyed out and stuck reading "Importing..." after you cancelled a per-file duplicate prompt partway through an import. It now resets to its normal label and re-enables, so you can start another import without reopening the window.

## [0.14.1] - 2026-06-30

### Changed

- Internal type-safety cleanup in token (JWT) decoding: dropped an unused Node `Buffer` base64 fallback in favor of the browser `atob` the plugin already uses. Clears `no-unsafe-*` warnings from the marketplace type-check scan. No behavior change.

## [0.14.0] - 2026-06-30

### Fixed

- Extra AI template outputs generated in Plaud (Key Points, Daily Journal, Meeting Summary, and other per-recording templates) were imported as unreadable `.bin` files in the note's attachments folder. They now render in the note as a **Template outputs** section below the summary, one subsection per template titled by its Plaud template name, with the Markdown body inline. Each template heading is foldable, and the transcript below stays collapsed by default. Whatever templates you selected in Plaud are mirrored, including a verbatim-transcript template if you generated one.

## [0.13.1] - 2026-06-29

### Changed

- Internal refactor of the import pipeline for testability. The shared core and the import-run loop were split into separate modules and covered with tests. No user-facing changes.

## [0.13.0] - 2026-06-27

### Added

- Placeholder notes for recordings Plaud has not processed yet. When Plaud has a recording but reports it has no transcript or summary available (an in-band server error such as "start trans task error", status -12), the importer now writes a placeholder note carrying the recording ID and a link back to Plaud instead of recording a bare failure. A later successful import replaces the placeholder automatically, even under the skip or prompt duplicate policy. Controlled by a new **Write placeholder for unprocessed recordings** setting, on by default. Turn it off to keep such recordings as plain failures with no file written.
- The import list now hides recordings that are in your Plaud trash, matching the Plaud app. Trashed recordings are usually short accidental clips with no transcript, and were the most common source of "no content" import failures. A new **Show trashed recordings** setting (off by default) brings them back when you want to import something you trashed in Plaud but still want in your vault.

### Changed

- Import errors that come from Plaud's own server now say so in plain English. When Plaud returns an error for a request (rather than the plugin failing to read the response), the failure message leads with "This is a Plaud-side issue, not a problem with the plugin reading the data". A "start trans task error" (status -12) is explained as Plaud having no transcript or summary for the recording, with the most common cause called out: audio with no detectable speech, which Plaud reports as "No speech detected". Plaud's raw status and message are kept at the end for troubleshooting.

## [0.12.1] - 2026-06-27

### Fixed

- Importing more than one recording into a folder typed with a Windows-style backslash (for example `\Inbox`) no longer fails every import after the first with "Failed to create folder: Folder already exists." The backslash was kept in the stored path, so the folder-exists check never matched the folder Obsidian had actually created and each later import re-attempted the create. Backslash paths are now normalized the same way Obsidian normalizes them, and a folder that already exists is treated as success either way. The same normalization fix also restores the "already imported" badge and duplicate detection for folders configured with a backslash.

## [0.12.0] - 2026-06-27

### Added

- Subfolder template for the output folder. A new **Subfolder template** setting files each imported note into a dated subfolder built from the recording date, so a growing library stops piling into one flat folder. Leave it empty to keep the current single-folder layout. Tokens: `{{yyyy}}`, `{{MM}}`, `{{dd}}`, the `{{yyyy-MM}}` shorthand, `{{ww}}` (ISO week number), and `{{Q}}` (calendar quarter). For example, `{{yyyy-MM}}` files a June 2026 recording under `2026-06`, and `{{yyyy}}/W{{ww}}` files by week. Attachments follow their note into the same subfolder. The setting applies to new imports; notes you already imported stay where they are. Re-importing a recording whose template changed updates the existing note in place instead of creating a duplicate.
- Loading indicator in the recording list while the next page is being fetched as you scroll. It now sits in a footer pinned below the list instead of scrolling away inside it, and the spinner appears the moment the fetch starts (including the background prefetch) rather than flashing only after the data arrives, so a slow load no longer reads as a frozen list.

### Changed

- Plaud's AI keyword list is no longer written to a `keywords:` note property by default. That list can run to hundreds of low-value entries per recording, which buried the few tags that matter and added noise to every note. Turn **Keep AI keywords as note property** back on if you want the list.

### Fixed

- Imported notes were missing their summary on recordings where Plaud's live summary endpoint was unavailable (common on older recordings, where it returns a "start trans task error"). The importer looked for the stored summary under the wrong key in the detail data, so it silently found nothing and wrote the note without a summary even though the summary was present. It now reads the stored summary correctly, including the newer format where the summary text is wrapped in a small metadata envelope. A summary that cannot be read for any reason no longer affects the transcript: the note still imports with its transcript and the summary is left out rather than failing or losing the transcript. Re-import an affected recording to backfill the missing summary.
- Older recordings that failed to import with a Plaud "start trans task error" (status -12) now recover from the stored detail data instead of failing outright. The legacy transcript call is treated as best-effort: when it errors but Plaud's detail bundle still holds the transcript or summary, the note imports. A recording with no usable data from either source still reports the original error.
- A recording whose summary Plaud advertises but cannot deliver (common on older recordings) now imports as long as a transcript exists: the note is written with a "no summary available" placeholder instead of failing the whole recording. Recordings with neither a summary nor a transcript still fail rather than writing an empty note.
- Older recordings that were never "polished" now import using their raw transcript. The detail data carries both a raw transcript and a polished one; the importer used to follow only the polished entry, so recordings that had only the raw transcript (and also failed the legacy transcript endpoint) imported as empty failures. The raw transcript is now used as a fallback.
- Recordings Plaud never transcribed or summarized (for example a raw clip you started but never processed) no longer count as failures. There is nothing to import for them, so they are now reported as a separate "no content" skip in the import summary instead of a "start trans task error". This is detected from the recording list up front, so these recordings are skipped without the failed lookup.
- Plaud's internal transcript, outline, and summary data files (gzipped JSON and markdown) are no longer imported as attachments. On some older recordings these blobs appeared in the download map and leaked into the note as broken `…-assets/<id>-fileN.gz` attachment links. They are now filtered out; real attachments such as summary cards and mindmaps still import. Re-import an affected note to clear the stale `.gz` links.

## [0.11.0] - 2026-06-21

### Added

- Browser sign-in for Google and Apple accounts. Single sign-on through Google or Apple cannot complete in an in-app window, so the new **Sign in with Google or Apple** option signs you in through your normal web browser and brings the token back. A one-time **Set up bookmark** step installs a drag-to-save bookmarklet; after that, connecting is a few clicks. See the README for the full walkthrough.
- **Paste token from clipboard** button that stores a copied token directly, after checking it is a usable access token, with no secret to create or select.
- **Clear sign-in** button that signs you out and clears the stored token so you can start fresh or connect a different account.

### Changed

- Email sign-in now opens a real separate window instead of an embedded browser view. The embedded view could freeze on first open (a known Electron webview limitation); a standalone window is reliable.
- The settings are reorganized into clear sections (Sign in, Output, Appearance, and the import groups). The Sign in section now explains that sign-in is fragile while Plaud has no official API, and which method to use for email versus Google or Apple logins.
- The connection status moved to the stored-token row, so it reflects whichever sign-in method you used.

## [0.10.2] - 2026-06-20

### Changed

- Lowered the minimum required Obsidian version from 1.12.0 to 1.11.4, the oldest version that provides the per-vault secret storage this plugin stores your token in. The plugin now installs and runs on the Obsidian 1.11.4 release line and later.

## [0.10.1] - 2026-06-20

### Fixed

- The Obsidian 1.12 support added in 0.10.0 did not actually work: the settings tab still depended on a settings API that only exists in Obsidian 1.13, so on Obsidian 1.12 the settings tab would have failed to render. The settings tab now includes a fully compatible fallback layout for Obsidian 1.12 that mirrors the 1.13 settings exactly, so every option is available on both.

## [0.10.0] - 2026-06-20

### Changed

- Lowered the minimum required Obsidian version from 1.13.0 to 1.12.0. The plugin now installs and runs on the Obsidian 1.12 release line, not just 1.13 and later. The settings tab renders the same set of options on both: 1.13+ uses Obsidian's built-in declarative settings, and 1.12 falls back to an equivalent layout driven by the same definitions, so there is no difference in what you can configure.

## [0.9.0] - 2026-06-18

### Fixed

- Imports failing with "token type does not match parse mode" (surfaced as "Plaud returned data in an unexpected shape"). Automatic sign-in was capturing Plaud's refresh token instead of the workspace access token the data API requires, and the sign-in window closed the instant it saw that wrong token. Sign-in now captures only the access token and stays open until it appears. **If you hit this, click Sign in again to capture a fresh token.**
- Plaud's in-band errors (an HTTP 200 carrying a negative status, such as an expired token) are now reported with Plaud's own message and routed to the right fix, sign in again, instead of a misleading "unexpected shape" parse error.

### Added

- **Test connection** button in settings. It makes one lightweight call to Plaud and reports whether your token works, so you can confirm you are signed in, or learn you need to sign in again, without running a full import.

### Changed

- The automatic sign-in window now loads `web.plaud.ai`, and data requests are tagged with the platform that matches the token so Plaud parses it in the right mode.

## [0.8.1] - 2026-06-15

### Changed

- Build tooling: replaced the `builtin-modules` dev dependency with Node's native `module.builtinModules`, clearing a marketplace module-replacement recommendation. No runtime change.
- Documentation: added status badges to match the standard plugin README format; documented the plugin's vault file-listing (output-folder only) and write-only clipboard use under privacy; led Installation with Community plugins (BRAT demoted to beta/pre-release); added a plain-language "What to know before you install" risks section.

## [0.8.0] - 2026-06-15

### Added

- **One-click sign-in.** A new "Automatic sign-in" button in settings opens Plaud's website in an embedded window so you can log in normally (email and password, Google, etc.); the plugin then captures your session token automatically. Your password is never seen by the plugin. The sign-in row shows whether a token is stored. Manual token entry remains available as a fallback. Desktop only.

### Changed

- Documentation now leads with the sign-in flow. The manual-token instructions were corrected to copy the `Authorization` header from the browser Network tab (Plaud no longer keeps a usable token in `localStorage`).

## [0.7.0] - 2026-06-15

### Fixed

- EU and other regional Plaud accounts no longer fail with "Plaud returned data in an unexpected shape". Plaud routes non-US accounts to regional API hosts (for example `api-euc1.plaud.ai`) and answers the US host with a region-mismatch redirect. The plugin now detects that redirect, switches to the regional host, retries, and remembers the host so later sessions connect directly. No setup is required; if your account is later moved to a different region the plugin re-detects automatically. (#1)
- The token-capture snippet in the docs now reads `pld_tokenstr` with a fallback to the older `tokenstr`, matching Plaud's current browser storage key.

### Added

- A read-only "API region" row in settings shows which Plaud server the vault is connected to, so you can confirm regional detection at a glance.

### Changed

- Bumped esbuild to 0.28.1 to clear a high-severity advisory (build tooling only, no runtime change).

## [0.6.0] - 2026-06-10

### Changed
- Internal restructuring, no behavior change:
  - The attachment download/classify/persist pipeline (the densest code in the plugin) moved from `ImportModal` into a new `attachment-importer.ts` with an explicit dependency surface (vault access, auth-token provider, debug logger). `import-modal.ts` drops from 3,177 to about 2,100 lines.
  - Two byte-identical asset-URL candidate builders collapsed into one `buildAssetUrlCandidates` helper.
  - Six Plaud response parsers now share one envelope validator (`requireDataEnvelope`), and the outline and transaction-polish link finders delegate to a single parameterized `findContentListLink`.
  - `NoopDebugLogger` is now actually used in production as the attachment importer's default logger instead of being a test-only export.

## [0.5.0] - 2026-06-10

### Added

- Tag creation is now configurable. A new "Tags" settings group controls what lands in the note's `tags:` frontmatter:
  - "Tag mode" dropdown: "No tags", "Custom tags only", "Plaud tags (no AI keywords)", or "All tags" (the previous behavior).
  - "Custom tags" text field: comma-separated tags appended to every imported note, except in "No tags" mode.
  - "Keep AI keywords as note property" toggle (default on): AI keywords excluded from `tags:` are written to a `keywords:` frontmatter property instead, so they stay searchable and Dataview-queryable without flooding the tag pane.
- The post-import summary can close itself. New "Import dialog" settings group: "Auto-close summary" toggle (default on) and "Auto-close delay" in seconds (default 20). Only a fully successful run auto-closes; any failure keeps the window open so the error list stays visible. Clicking inside the window cancels the countdown.

### Changed

- Default tag behavior changed. New default mode is "Plaud tags (no AI keywords)": tags you set on a recording in the Plaud app still become Obsidian tags, but Plaud's AI topic guesses (previously imported as `plaud/...` tags, often 8-10 per note) now land in the `keywords:` property instead. Imports were creating 20-30 low-value vault tags. Select "All tags" to restore the old behavior.
- The "Custom tags" setting defaults to `plaud-meeting` so every imported note carries at least one tag out of the box. Clear the field to opt out.

### Fixed

- A transcript segment whose `end_time` lands before its `start_time` no longer fails the whole import with "Plaud returned data in an unexpected shape". Plaud occasionally emits one mis-ordered segment boundary mid-recording (observed in a real capture on 2026-06-10); the parser now keeps the segment and clamps its end to its start instead of rejecting the transcript.

## [0.4.2] - 2026-06-05

### Fixed
- Added the required `-- description` to the one remaining eslint directive (`no-control-regex` in the filename sanitizer), which the developer-dashboard scan flags when missing. No runtime change.

## [0.4.1] - 2026-06-05

### Fixed
- Cleared developer-dashboard scan findings by removing suppressed lint rules instead of disabling them. The debug logger's console mirror now uses `console.debug` instead of `console.log` (drops two `obsidianmd/no-console` disables); the in-memory buffer remains the primary capture path. The `types.d.ts` fold-manager augmentation references `TFile` via an inline import, dropping two `no-undef` disables. No runtime behavior changed.

## [0.4.0] - 2026-06-05

### Changed

- Requires Obsidian 1.13.0 or later. Obsidian keeps serving 0.3.1 to vaults on older versions, so nothing breaks for them.
- Settings migrated to Obsidian's declarative settings API. The output folder, duplicate handling, artifact-selection toggles, transcript-rendering options, and the debug toggle are now indexed in Obsidian's global settings search, and the artifact, transcript, and debug options are grouped into labeled sections. The Plaud token picker and the ribbon icon picker keep their custom controls. No setting changed its stored value or behavior.

## [0.3.1] - 2026-05-13

Small follow-up to 0.3.0 covering one CI deprecation warning and one UX polish item.

- Settings tab now ends with a footer line showing the installed plugin version and links to the GitHub repo and issue tracker. Matches the format used by the reference plugin obsidian-shell-path-copy
- CI and release workflows opt into Node.js 24 for JavaScript actions via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`. Silences the deprecation warning GitHub emits for `actions/checkout@v4` and `actions/setup-node@v4` ahead of the forced default flip on 2026-06-02 and Node 20 removal on 2026-09-16

## [0.3.0] - 2026-05-13

Plaud GPT-5 schema support, richer note output, vault-aware import UI, and a full Obsidian scorecard compliance pass.

### Plaud API compatibility

- Parse Plaud's new flat GPT-5 `data_result_summ` shape. Plaud rolled out a new summarizer (`endpoint: "azure-sweden-central-gpt-5"`) that returns markdown at the top level instead of nested under `content`. Imports against the new schema were failing with "Plaud returned data in an unexpected shape"; they now succeed. Legacy nested-content shapes 1 through 4 stay supported as fallbacks
- Substitute Plaud's template placeholders before writing the note. Plaud's web UI replaces tokens like `$[audio_start_time]`, `$[audio_title]`, `$[audio_duration]`, and `$[speakers]` client side; their API returns the raw template, so previously a literal `$[audio_start_time]` showed up in the rendered summary. The substitution is forward compatible: unknown future tokens pass through verbatim
- Better diagnostics on shape drift. When Plaud changes the wire format in a way the parser cannot recognize, the surfaced error now includes the actual top-level keys and a redacted JSON sample so a bug report has enough detail to fix forward without enabling debug mode

### Richer note output

- Imported notes now surface Plaud's GPT-5 metadata fields in frontmatter when present: `plaud-headline`, `plaud-category`, `plaud-language`, `plaud-template`, `plaud-model`, `plaud-note-id`, `plaud-summary-id`, `plaud-summary-version`. Every field is optional; missing values produce no line so older recordings stay clean
- New `## AI Suggestions` section appended after `## Summary` when Plaud returns an `ai_suggestion` value. This is a separate field on Plaud's side that holds follow-up recommendations distinct from the main summary

### Import modal: "Imported" badge

- Each row in the recording list whose `plaud-id` already exists in the configured output folder now shows an "Imported" pill next to the title. Click the pill to open the existing note. The badge is purely informational: re-importing remains possible and honors the configured duplicate handling policy (skip / overwrite / ask)
- The scan uses Obsidian's `metadataCache` (no file reads) and is rebuilt after every successful import so the badge appears live without reopening the modal

### Obsidian scorecard compliance

- Wired in `eslint-plugin-obsidianmd@^0.3.0` (recommended ruleset) so marketplace scorecard violations block `npm run lint`. Fixed all 33 findings surfaced on first run: 15 sentence-case fixes across UI strings and notices, three settings tab headings migrated to `Setting.setHeading()`, two `Vault.delete()` calls migrated to `FileManager.trashFile()`, and several type-safety fixes (`no-unsafe-assignment`, `no-unsafe-return`, `no-base-to-string`, `no-floating-promises`)
- CI workflow expanded: Node 20 (was 18), top-level `permissions: contents: read`, weekly OSV-Scanner re-run via cron, OSV-Scanner job over the lockfile, GitHub Dependency Review on PRs (`fail-on-severity: high`)
- Release workflow expanded: SLSA build provenance attestation over `main.js`, `manifest.json`, `styles.css` via `actions/attest-build-provenance@v2`; VirusTotal scan of the three artifacts via `crazy-max/ghaction-virustotal@v4` (requires `VT_API_KEY` secret); `npm ci` instead of `npm install`; CHANGELOG-extracted release notes attached to the GitHub release
- README expanded: documents the scorecard linter integration, the SLSA + VirusTotal release pipeline, the new GPT-5 frontmatter extras, the imported badge, and the AI Suggestions section

### Compatibility

- No breaking changes. Existing notes are not modified by this release. Reimporting a recording produces a richer note (new frontmatter keys, AI Suggestions section, substituted placeholders) without disturbing fields that were already correct

## 0.2.6 — 2026-04-21

- New **Ribbon icon** setting — curated dropdown of 12 Lucide icons (audio-lines, mic, headphones, podcast, radio, tape, notebook-pen, captions, users-round, volume-2, mic-vocal, file-audio-2). Live preview next to the dropdown shows the selected icon; change takes effect on the ribbon immediately with no reload
- Default remains the existing audio-lines waveform. Future versions may replace the curated list with a searchable full-Lucide picker; the stored setting is already a raw Lucide ID so no migration will be needed

## 0.2.5 — 2026-04-21

- New **Show ribbon icon** setting — on by default. Toggle off to hide the left-rail icon and launch imports only from the command palette. The icon appears/disappears live on toggle, no plugin reload needed.

## 0.2.4 — 2026-04-21

Token capture is now a one-liner.

- Client strips any leading `bearer ` prefix from the stored token before prepending its own `Bearer ` scheme, so users can paste the raw `tokenstr` value from `web.plaud.ai` local storage verbatim without editing the `bearer ` prefix out first
- README token-capture section reduced to four steps: open DevTools Console, run one `copy()` line, paste into the Obsidian secret field, save

## 0.2.3 — 2026-04-21

Submission-readiness pass.

- Replace inline `.style.display` toggling on the Load-more button with a `.plaud-importer-hidden` CSS class (Obsidian plugin guidelines require CSS classes, not hardcoded inline styles)
- README rewritten end-to-end: full feature overview, BRAT install steps, token-capture walkthrough, per-setting configuration guide, usage walkthrough, troubleshooting, and an explicit **Plaud API status** disclosure that the plugin uses undocumented Plaud endpoints today and will migrate to Plaud's official OAuth API when it ships

## 0.2.2 — 2026-04-21

- Duplicate prompt hides "Cancel import" for single-item imports — Skip and Cancel are functionally identical for one recording, so showing both was redundant. Multi-item batches still get the full escalation set.

## 0.2.1 — 2026-04-21

Duplicate prompt modal polish.

- Button row wraps (`flex-wrap`) so buttons no longer overflow the modal width on narrow widths
- "Overwrite all remaining" / "Skip all remaining" buttons are hidden when only one recording is selected — the escalation is meaningless for a single-item import

## 0.2.0 — 2026-04-21

Duplicate handling: new "Ask each time" policy.

- Settings dropdown adds third option **Ask each time** (new default for fresh installs; existing users keep whatever they had saved)
- Per-duplicate prompt shows the recording title and target path, explicit warning that existing note content AND the matching `-assets` folder will be overwritten
- Five-button modal: `Overwrite`, `Skip`, `Overwrite all remaining`, `Skip all remaining`, `Cancel import` — the last two set a sticky batch-level decision so 20-file re-imports don't re-prompt
- Cancel stops the batch mid-run and fires a partial-progress notice
- `NoteWriter` grows an optional `promptOnDuplicate` callback; new `NoteWriterCancelledError` bubbles cancel cleanly (not treated as an import failure)

Motivation: retranscribing a recording (e.g. applying speaker names) and re-importing it used to silently no-op when the duplicate policy was "skip", which was the default. The new "Ask each time" default makes overwrite an explicit per-file decision rather than a global toggle the user forgets about.

## 0.1.0 — 2026-04-14

Initial scaffold.

- Plugin class with settings persistence and deferred `onLayoutReady` hook
- Settings tab with three controls: `SecretComponent` for the Plaud token (using Obsidian's per-vault secret storage), output folder text input, and duplicate-handling dropdown (`skip` / `overwrite`)
- Command palette entry `Plaud Importer: Import recent recordings` (currently produces a "not implemented" notice — real client to come)
- `isDesktopOnly: true`, `minAppVersion: 1.11.4` (required for `SecretStorage` and `SecretComponent`)
- Build pipeline (esbuild + tsc typecheck), lint (eslint), test (jest), release automation (version-bump.mjs) carried forward from the `obsidian-shell-path-copy` template
