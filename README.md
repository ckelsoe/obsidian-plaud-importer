# Plaud Importer

> ## ⚠️ Early Alpha — Use at Your Own Risk
>
> **This plugin is in early alpha and under active development.** Expect bugs, breaking changes between releases, incomplete features, and rough edges. It talks to an **undocumented, reverse-engineered Plaud web API** that Plaud can change or break at any time without notice.
>
> **Before you install:**
> - **Back up your vault.** The plugin writes notes and downloads attachments; a bug could overwrite or duplicate files. Don't point it at a production vault until you've tested in a throwaway one.
> - **Treat imported data as untrusted** until you've spot-checked it against the Plaud web app.
> - **Your Plaud token is stored via Obsidian's `SecretStorage`** (per-vault, not synced). Revoke and re-issue it if anything looks off.
> - Features described below may regress or change shape release to release while the API is still being characterized.
>
> **No warranty. No guarantees. You accept all risk by installing this plugin.**
>
> ### Please report issues
>
> Bug reports are the single biggest help right now — every reproducible issue tightens the plugin. If something breaks, behaves oddly, or doesn't match what Plaud shows on the web:
>
> 1. **File a GitHub issue** at [ckelsoe/obsidian-plaud-importer/issues](https://github.com/ckelsoe/obsidian-plaud-importer/issues).
> 2. Include your **Obsidian version**, **plugin version**, **OS**, and **steps to reproduce**.
> 3. Enable **Debug log** in plugin settings, reproduce the issue, and paste the captured request/response trace (auth headers are redacted automatically).
> 4. Attach a screenshot or the generated note if the output looks wrong.
>
> Feature requests and API-shape observations are welcome too — open an issue or discussion.

Import meeting recordings, AI summaries, transcripts, and attachments from [Plaud.AI](https://www.plaud.ai/) into your Obsidian vault as markdown notes.

Each recording becomes a single note with frontmatter metadata, a Plaud-generated summary, and a heading-based transcript section with chapter navigation. Images, mind-maps, and other Plaud artifacts land in a matching `-assets` folder next to the note.

## What it does

- **Lists your recent Plaud recordings** in a modal with scroll-to-load pagination.
- **Lets you pick which to import** via checkboxes — single or multi-select.
- **Per-recording artifact selection** — before a multi-import you can tick/untick transcript, summary, attachments, mindmap, and card independently.
- **Writes one markdown note per recording** with:
  - YAML frontmatter (Plaud ID, date, duration, speakers, tags, Plaud web URL)
  - Plaud's AI summary
  - An inline chapter index with jump-links into the transcript
  - A heading-based transcript section with per-chapter `Back to Chapters` links
  - An `Open in Plaud` link under the H1 for quick round-tripping
- **Downloads attachments** (images, mind-map PNGs, card PNGs, other files) into a `<note-name>-assets/` folder and references them from the note.
- **Duplicate handling** is configurable — Skip, Overwrite, or Ask each time. "Ask each time" prompts per file with an explicit warning that the existing note body AND its `-assets` folder will be replaced; in a multi-select import you can escalate to "Overwrite all remaining" / "Skip all remaining" or cancel the batch.
- **Transcript folding** — imported notes open with the transcript section collapsed by default so the summary is what you see first. Toggleable in settings.
- **Debug log** — opt-in in-memory buffer of API requests/responses for troubleshooting; auth headers are never captured.

## Requirements

- **Obsidian 1.11.4 or newer** — required for the `SecretStorage` / `SecretComponent` APIs used to handle the Plaud token.
- **Desktop only** (`isDesktopOnly: true`). The current authentication path depends on Electron and `localStorage` APIs that are not available on Obsidian Mobile. This restriction will be lifted when Plaud ships a public OAuth API (see [Plaud API status](#plaud-api-status) below).
- **A Plaud.AI account** with access to the recordings you want to import.

## Installation

### Via BRAT (recommended while in beta)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is the standard way to install community plugins that are not yet in the official Obsidian marketplace.

1. Install **Obsidian42 - BRAT** from the Obsidian community plugins catalog and enable it.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Paste the repository URL: `https://github.com/ckelsoe/obsidian-plaud-importer`.
4. BRAT downloads the latest release (`main.js`, `manifest.json`, `styles.css`) and installs Plaud Importer.
5. Enable **Plaud Importer** in **Settings → Community plugins**.
6. To update later: **BRAT: Check for updates to all beta plugins**, or set BRAT to auto-check on Obsidian start.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ckelsoe/obsidian-plaud-importer/releases/latest).
2. Copy all three files into `<your vault>/.obsidian/plugins/plaud-importer/`.
3. Reload Obsidian (or disable/re-enable the plugin) and enable **Plaud Importer** in Community plugins.

## Configuration

Open **Settings → Community plugins → Plaud Importer** and configure:

### Plaud token

The plugin authenticates against Plaud using your web session token. Capture it once:

1. Sign in to [web.plaud.ai](https://web.plaud.ai) in your browser.
2. Press **F12** to open DevTools and click the **Console** tab.
3. Paste this and press Enter (Edge/Chrome may make you type `allow pasting` once before it accepts pasted code):
   ```js
   copy(localStorage.getItem('tokenstr'))
   ```
   Your token is now on the clipboard. The value looks like `bearer eyJhbGci…` — the plugin normalizes the `bearer ` prefix internally, so paste exactly what you copied without editing it.
4. In Obsidian: **Settings → Community plugins → Plaud Importer**. Click the Plaud token field, choose **Create new secret**, paste, and save.

The token is stored in Obsidian's per-vault secret storage. It is **never written to `data.json`** and does not travel through Obsidian Sync. Switching vaults requires re-entering the token.

### Output folder

Folder inside your vault where imported notes are written. Defaults to `Plaud`. Nested paths work (`Archive/Plaud/2026`).

### Duplicate handling

What the importer does when a note for a recording already exists in the output folder:

- **Skip** — leave the existing note untouched. The importer reports it as `skipped` in the summary.
- **Overwrite** — replace the existing note body and clear its matching `-assets` folder before re-downloading. A confirmation modal fires once per import batch before any overwrite happens.
- **Ask each time** (default) — prompt per duplicate at write time. The modal shows the recording title and the exact target path, warns that the existing note AND its `-assets` folder will be replaced, and offers Overwrite, Skip, or (in multi-item batches) Overwrite all remaining, Skip all remaining, and Cancel import.

### Default artifact selection

What the "Review artifacts first" checklist starts with when you begin a multi-import: transcript, summary, attachments, mindmap, card. Uncheck artifacts you never want to pull by default; you can always override per-batch.

### Transcript rendering

- **Fold transcript by default** — imported notes open with the transcript heading collapsed so the summary is what you see first.
- **Transcript heading level** — which H-level the wrapping `Transcript` heading uses (chapters render one level deeper). Pick what fits your note style.

### Debug logging

Off by default. When on, captures API request/response metadata and parsed results into an in-memory buffer for troubleshooting. Auth headers are stripped. Payloads may contain transcript text, speaker names, and recording metadata, so only enable when you are preparing a bug report. Use the command **Plaud Importer: Debug: copy debug log to clipboard** to export the session.

## Using it

1. Click the **audio-lines** ribbon icon on the left rail, or run the command **Plaud Importer: Import recent recordings**.
2. Scroll the recording list to load older pages (handled automatically as you scroll).
3. Tick the recordings you want.
4. Click **Import N recordings** (or **Review artifacts first** to uncheck specific artifacts for this batch).
5. Watch the per-file progress counter. A final Notice summarizes how many were imported, skipped, or failed; failures are listed in the modal with a Copy button for bug reports.

## Plaud API status

⚠️ **This plugin currently uses Plaud's undocumented web API** — specifically the endpoints `/file/simple/web`, `/file/detail/`, `/ai/transsumm/`, and related asset URLs under `api.plaud.ai`. These endpoints are not officially published or supported by Plaud, and were discovered via open-source reverse-engineering projects ([`rsteckler/applaud`](https://github.com/rsteckler/applaud), [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API)).

What this means for you:

- **The plugin may break without warning** if Plaud changes URL shapes, response schemas, or authentication. When it breaks, the import modal will surface a clear error (auth failure, parse error, HTTP 4xx/5xx) rather than silently corrupt notes — but some releases may need to wait for a plugin update.
- **Your Plaud token is a full web-session JWT**, not a scoped API key. Treat it with the same care as your Plaud password. The plugin stores it in Obsidian's `SecretStorage`, never in `data.json`, and never logs it.
- **When Plaud ships a public OAuth API**, this plugin will switch to that surface and deprecate the reverse-engineered path. A separate `OAuthPlaudClient` stub is already stubbed in the codebase for the migration. The mobile-only restriction (`isDesktopOnly`) exists because of the current auth path and will be re-evaluated at that point.

I am actively monitoring Plaud's developer announcements and [waitlist](https://www.plaud.ai/) for the official API. If you hear anything, please open an issue.

## Privacy and network use

Per Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies):

- **Network use** — the plugin communicates exclusively with Plaud.AI's servers (`api.plaud.ai` for JSON, various CDN hosts for attachment downloads that Plaud's API points at). No data is sent to any other third party. Network requests happen only when you explicitly trigger an import, scroll to load more recordings, or download attachments.
- **No telemetry** — no usage data, crash reports, or analytics are collected or transmitted.
- **Secret handling** — the Plaud token is stored via Obsidian's `SecretStorage` API (per-vault, not synced), referenced by a secret ID in `data.json` rather than the token itself.
- **Vault writes** — all file writes go through the Obsidian `Vault` API (`Vault.create`, `Vault.process`). No direct filesystem access.

## Troubleshooting

- **"No Plaud token configured"** — re-check the Plaud token dropdown in settings. If your token expired, follow the [Plaud token](#plaud-token) steps again.
- **"Plaud rejected your token"** — your web session likely expired or you signed out of Plaud. Re-copy the JWT from DevTools and update the secret.
- **"Could not reach Plaud.AI"** — network or DNS issue on your side, or Plaud is down. Retry from the modal's **Retry** button.
- **"Plaud returned data in an unexpected shape"** — Plaud changed their API. File an issue with the debug log attached (see [Debug logging](#debug-logging)).
- **Import silently "skipped"** — your duplicate handling was set to Skip and the note already existed. Switch to **Ask each time** (default since 0.2.0) or **Overwrite**.

## Support and issues

Please report bugs and feature requests at [github.com/ckelsoe/obsidian-plaud-importer/issues](https://github.com/ckelsoe/obsidian-plaud-importer/issues). Include:

- Your Obsidian version
- Your plugin version (shown in Community plugins)
- The debug log if reproducible (strip anything sensitive)

## Development

This plugin is part of the [`obsidian-development`](https://github.com/ckelsoe/obsidian-development) workspace.

```bash
npm install              # install deps
npm run dev              # start watch-mode build
npm run build            # type-check + production build
npm run lint             # eslint (zero warnings allowed)
npm test                 # jest
npm run version          # bump version in manifest.json + versions.json
```

Releases are cut by pushing a semver tag — a GitHub Actions workflow builds and uploads `main.js`, `manifest.json`, and `styles.css` to the release.

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgments

Inspired by [`rsteckler/applaud`](https://github.com/rsteckler/applaud) and [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API), which demonstrated that the required data can be pulled from Plaud's web API today. Thanks to [Obsidian](https://obsidian.md/) for the `SecretStorage` and `SecretComponent` APIs that make storing the Plaud token securely a non-issue.
