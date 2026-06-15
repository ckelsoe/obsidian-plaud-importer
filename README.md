# Plaud Importer

> ## ⚠️ Early Alpha
>
> **This plugin is in early alpha and under active development.** Expect bugs, UI changes between releases, and occasional rough edges. It talks to an **undocumented, reverse-engineered Plaud web API** that Plaud can change at any time.
>
> Before installing, please read **[What to know before you install](#what-to-know-before-you-install)** — it explains the main tradeoffs in plain language, and exactly what the plugin will and will not touch in your vault.
>
> No warranty — use at your own risk, and you may want to test in a non-critical vault first.
>
> ### Please report issues
>
> I use this plugin myself every day, so I often catch breakage quickly — but I am one person on one account, and Plaud can change their API for some accounts or regions before it affects mine. **If something breaks for you, an issue report is the single biggest help**, and may be the first signal I get.
>
> 1. **File a GitHub issue** at [ckelsoe/obsidian-plaud-importer/issues](https://github.com/ckelsoe/obsidian-plaud-importer/issues).
> 2. Include your **Obsidian version**, **plugin version**, **OS**, and **steps to reproduce**.
> 3. Attach a **debug log** — see [Capturing a debug log](#capturing-a-debug-log) below. Auth headers are redacted automatically.
> 4. Attach a screenshot or the generated note if the output looks wrong.
>
> Feature requests and API-shape observations are welcome too — open an issue or discussion.

Import meeting recordings, AI summaries, transcripts, and attachments from [Plaud.AI](https://www.plaud.ai/) into your Obsidian vault as markdown notes.

Each recording becomes a single note with frontmatter metadata, a Plaud-generated summary, and a heading-based transcript section with chapter navigation. Images, mind-maps, and other Plaud artifacts land in a matching `-assets` folder next to the note.

## What to know before you install

Plaud does not offer an official API yet, so this plugin works by using Plaud's own (undocumented) web service the same way the Plaud website does. That is what makes it possible at all, and it brings a few tradeoffs worth understanding up front. **None of them put your existing notes at risk.**

### The tradeoffs

- **It can break when Plaud changes their website or API.** There is no official, supported API, so Plaud can change how their service works at any time and an import may suddenly stop working. *Why it works this way:* it is the only way to get your recordings into Obsidian today. *What protects you:* the plugin shows a clear error instead of writing broken notes, and when Plaud ships an official API the plugin will move to it.
- **Your sign-in token is like a key to your whole Plaud account.** The plugin stores the session token your login uses — it is not a limited, read-only key. *Why:* that is the only credential Plaud's web service provides. *What protects you:* it is kept in Obsidian's secure secret storage, never written to your settings file, never logged, and never sent anywhere except Plaud.
- **You sign in through an embedded Plaud window.** Clicking **Sign in** opens Plaud's real website so you can log in normally. *Why:* you never hand your password to the plugin, and any login method works (including Google). *What protects you:* the plugin reads only the token your logged-in session already uses; your password is typed into Plaud's own page, not the plugin.
- **It is an unofficial tool, not affiliated with Plaud.** *What protects you:* it reads only your own data, and only when you ask it to. Following Plaud's terms of service is your responsibility.
- **Desktop only.** Sign-in and import rely on desktop features that Obsidian Mobile does not provide.

### What it will not do

- It only **adds** notes and attachments inside the output folder you choose. It never scans, edits, or deletes anything else in your vault.
- It replaces an already-imported note only when **you** choose Overwrite (or confirm it under "Ask each time").
- It does not rewrite Plaud's transcript or summary text — it renders Plaud's own data into a note.

## What it does

- **One-click sign-in** — connect your Plaud account from settings without copying a token from the browser console. A sign-in window opens, you log in to Plaud normally, and your session token is captured automatically. Your password is never seen by the plugin. (Manual token paste is still available as a fallback.)
- **Lists your recent Plaud recordings** in a modal with scroll-to-load pagination.
- **Lets you pick which to import** via checkboxes — single or multi-select.
- **Per-recording artifact selection** — before a multi-import you can tick/untick transcript, summary, attachments, mindmap, and card independently.
- **Writes one markdown note per recording** with:
  - YAML frontmatter (Plaud ID, date, duration, speakers, tags, Plaud web URL) plus a layered set of optional fields surfaced from Plaud's flat GPT-5 schema (`plaud-headline`, `plaud-category`, `plaud-language`, `plaud-template`, `plaud-model`, `plaud-note-id`, `plaud-summary-id`, `plaud-summary-version`) — emitted only when present, never load-bearing.
  - Plaud's AI summary
  - An `AI Suggestions` section pulled from Plaud's `ai_suggestion` field when the response includes one (separate from the main summary)
  - An inline chapter index with jump-links into the transcript
  - A heading-based transcript section with per-chapter `Back to Chapters` links
  - An `Open in Plaud` link under the H1 for quick round-tripping
- **Downloads attachments** (images, mind-map PNGs, card PNGs, other files) into a `<note-name>-assets/` folder and references them from the note.
- **"Imported" badge in the recording list** — each row whose `plaud-id` already exists in your output folder shows an Imported pill. Click it to open the existing note. Re-importing is still possible and honors your duplicate-handling setting.
- **Duplicate handling** is configurable — Skip, Overwrite, or Ask each time. "Ask each time" prompts per file with an explicit warning that the existing note body AND its `-assets` folder will be replaced; in a multi-select import you can escalate to "Overwrite all remaining" / "Skip all remaining" or cancel the batch.
- **Transcript folding** — imported notes open with the transcript section collapsed by default so the summary is what you see first. Toggleable in settings.
- **Debug log** — opt-in in-memory buffer of API requests/responses for troubleshooting; auth headers are never captured.

## Requirements

- **Obsidian 1.13.0 or newer** — required for the settings and `SecretStorage` / `SecretComponent` APIs used to handle the Plaud token.
- **Desktop only** (`isDesktopOnly: true`). The authentication path depends on Electron APIs (including the embedded sign-in browser window) that are not available on Obsidian Mobile. This restriction will be lifted when Plaud ships a public OAuth API (see [Plaud API status](#plaud-api-status) below).
- **A Plaud.AI account** with access to the recordings you want to import.

## Installation

### From Community plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Plaud Importer** and click **Install**.
3. Click **Enable**.

> If you don't find it in Browse yet, it may still be in review for the community catalog. Use BRAT (below) to install it in the meantime.

### Via BRAT (beta and pre-release versions)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs and auto-updates plugins straight from GitHub — useful before this plugin lands in the catalog, or to track pre-release builds.

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

### Connect your Plaud account

The plugin reads your recordings using your Plaud web-session token. **You never give the plugin your Plaud password** — you sign in to Plaud directly, and the plugin captures only the session token your logged-in session already uses.

#### Sign in (recommended)

1. In **Settings → Community plugins → Plaud Importer**, find **Automatic sign-in** and click **Sign in**.
2. A window opens with Plaud's own website. Sign in the way you normally do (email and password, Google, etc.).
3. Once you reach your library, the plugin captures your session token automatically and the window closes. The sign-in row then shows **"signed in — a token is stored."**

This is desktop only, because it relies on an embedded browser window. Your password never passes through the plugin.

#### Paste a token manually (fallback)

If the embedded sign-in window does not work on your setup, capture the token yourself from your browser:

1. Sign in to [web.plaud.ai](https://web.plaud.ai) in your browser.
2. Press **F12** to open DevTools and click the **Network** tab.
3. Open a recording in Plaud so it makes some requests, then click any request to `api.plaud.ai`.
4. Under **Request Headers**, find **Authorization** and copy its full value (it looks like `bearer eyJhbGci…`). The plugin normalizes the `bearer ` prefix internally, so paste it exactly as copied.
5. In Obsidian, click the **Plaud token** field, choose **Create new secret**, paste, and save.

The token is stored in Obsidian's per-vault secret storage either way. It is **never written to `data.json`** and does not travel through Obsidian Sync. Switching vaults requires re-connecting.

Regional accounts (EU and others) need no extra setup. If Plaud routes your account to a regional server, the plugin detects it on the first import and remembers it.

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

Off by default. When on, captures API request/response metadata and parsed results into an in-memory buffer for troubleshooting. Auth headers are stripped. Payloads may contain transcript text, speaker names, and recording metadata, so only enable when you are preparing a bug report. Use the command **Plaud importer: Debug: copy debug log to clipboard** to export the session.

## Using it

1. Click the **audio-lines** ribbon icon on the left rail, or run the command **Plaud importer: Import recordings**.
2. Scroll the recording list to load older pages (handled automatically as you scroll).
3. Tick the recordings you want.
4. Click **Import N recordings** (or **Review artifacts first** to uncheck specific artifacts for this batch).
5. Watch the per-file progress counter. A final Notice summarizes how many were imported, skipped, or failed; failures are listed in the modal with a Copy button for bug reports.

## Capturing a debug log

When something breaks, a debug log is the most useful thing to attach to an issue. It records the API requests and responses the plugin made (auth headers are stripped automatically; payloads may contain transcript text and recording metadata, so review before posting).

1. **Settings → Community plugins → Plaud Importer**, turn on **Debug logging**.
2. Reproduce the problem (run the import that failed, etc.).
3. Open the command palette and run **Plaud Importer: Debug: copy debug log to clipboard**.
4. Paste it into your GitHub issue. Turn Debug logging back off when you are done.

## Plaud API status

⚠️ **This plugin currently uses Plaud's undocumented web API** under `api.plaud.ai`. The endpoints in use are `GET /file/simple/web` for listing recordings, `POST /ai/transsumm/{id}` for transcript and legacy summary retrieval, and `GET /file/detail/{id}` for the richer detail bundle (polish-revision summaries, AI keywords, mindmap and card attachments, and AI suggestions). None of these are officially published or supported by Plaud.

The listing and `/ai/transsumm/{id}` endpoints were informed by prior community work, most directly [`rsteckler/applaud`](https://github.com/rsteckler/applaud), with cross-validation against [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API). Those projects established that the data was reachable from a logged-in web session and gave a useful starting point for the auth and listing flow. The richer `/file/detail/{id}` surface used by this plugin (the `transaction_polish` polish-revision summary, `auto_sum_note`, `ai_suggestion`, the GPT-5 frontmatter schema fields, and the pre-signed S3 URLs for mindmap, card, and attachment assets), along with the encoding quirks (millisecond timestamps on the listing endpoint, the empty-JSON `POST` body shape on `/ai/transsumm/{id}`), were verified and extended through direct inspection of live Plaud responses during this plugin's development.

What this means for you:

- **The plugin may break without warning** if Plaud changes URL shapes, response schemas, or authentication. When it breaks, the import modal will surface a clear error (auth failure, parse error, HTTP 4xx/5xx) rather than silently corrupt notes — but some releases may need to wait for a plugin update.
- **Your Plaud token is a full web-session JWT**, not a scoped API key. Treat it with the same care as your Plaud password. The plugin stores it in Obsidian's `SecretStorage`, never in `data.json`, and never logs it.
- **When Plaud ships a public OAuth API**, this plugin will switch to that surface and deprecate the reverse-engineered path. A separate `OAuthPlaudClient` stub is already stubbed in the codebase for the migration. The mobile-only restriction (`isDesktopOnly`) exists because of the current auth path and will be re-evaluated at that point.

I am actively monitoring Plaud's developer announcements and [waitlist](https://www.plaud.ai/) for the official API. If you hear anything, please open an issue.

## Privacy and network use

Per Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies):

- **Network use** — the plugin communicates exclusively with Plaud.AI's servers (`api.plaud.ai` for JSON, various CDN hosts for attachment downloads that Plaud's API points at). No data is sent to any other third party. Network requests happen only when you explicitly trigger an import, scroll to load more recordings, or download attachments.
- **In-app sign-in** — when you click **Sign in**, the plugin opens Plaud's own website (`app.plaud.ai` / `web.plaud.ai`) in an embedded browser window so you can log in. Your password is entered into Plaud's page and is never read by the plugin; the plugin reads only the session token your logged-in session sends to Plaud's API, and stores it via `SecretStorage`. The sign-in session is kept in a private partition isolated from Obsidian's other web sessions.
- **No telemetry** — no usage data, crash reports, or analytics are collected or transmitted.
- **Secret handling** — the Plaud token is stored via Obsidian's `SecretStorage` API (per-vault, not synced), referenced by a secret ID in `data.json` rather than the token itself.
- **Vault writes** — all file writes go through the Obsidian `Vault` API (`Vault.create`, `Vault.process`). No direct filesystem access.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy and liability disclaimer, and [SECURITY.md](./SECURITY.md) for the security policy. The plugin is provided "AS IS" with no warranty (see [LICENSE](./LICENSE)); it is not affiliated with or endorsed by Plaud.AI, and you use it at your own risk.

## Troubleshooting

- **"No Plaud token configured"** — re-check the Plaud token field in settings. If your token expired, [connect your Plaud account](#connect-your-plaud-account) again (click **Sign in**).
- **"Plaud rejected your token"** — your web session likely expired or you signed out of Plaud. Click **Sign in** again to refresh the token (or re-paste it manually).
- **"Could not reach Plaud.AI"** — network or DNS issue on your side, or Plaud is down. Retry from the modal's **Retry** button.
- **"Plaud returned data in an unexpected shape"** — Plaud changed their API. File an issue with the debug log attached (see [Debug logging](#debug-logging)).
- **Import silently "skipped"** — your duplicate handling was set to Skip and the note already existed. Switch to **Ask each time** (default since 0.2.0) or **Overwrite**.

## Support and issues

Please report bugs and feature requests at [github.com/ckelsoe/obsidian-plaud-importer/issues](https://github.com/ckelsoe/obsidian-plaud-importer/issues). Include:

- Your Obsidian version
- Your plugin version (shown in Community plugins)
- The debug log if reproducible (strip anything sensitive)

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local build and test instructions.

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgments

Inspired by prior community work on Plaud's web API. [`rsteckler/applaud`](https://github.com/rsteckler/applaud) and [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API) demonstrated that recordings, transcripts, and summaries are reachable from a logged-in web session, and gave this plugin a head start on the listing and transcript-retrieval flow. The richer detail-bundle surface (polish-revision summaries, AI keywords, mindmap and attachment asset URLs, AI suggestions, GPT-5 schema fields) and the response-shape and timing quirks were worked out by inspecting live Plaud responses during this plugin's development.

Thanks to [Obsidian](https://obsidian.md/) for the `SecretStorage` and `SecretComponent` APIs that make storing the Plaud token securely a non-issue.
