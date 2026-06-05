# Changelog

All notable changes to Plaud Importer will be documented in this file.

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
