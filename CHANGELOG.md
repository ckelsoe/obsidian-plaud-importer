# Changelog

All notable changes to Plaud Importer will be documented in this file.

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
