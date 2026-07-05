# Plaud Importer

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-plaud-importer/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-plaud-importer/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-plaud-importer/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-plaud-importer/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-plaud-importer/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-plaud-importer/releases) [![GitHub Stars](https://img.shields.io/github/stars/ckelsoe/obsidian-plaud-importer?style=flat&logo=github&label=Stars)](https://github.com/ckelsoe/obsidian-plaud-importer) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.11.4%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/github/license/ckelsoe/obsidian-plaud-importer)](https://github.com/ckelsoe/obsidian-plaud-importer/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-plaud-importer?label=Latest)](https://github.com/ckelsoe/obsidian-plaud-importer/releases/latest)

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
- **You sign in through Plaud's own website.** Clicking **Sign in** opens Plaud's real site in a separate window so you can log in normally; Google and Apple logins use your normal browser instead (see [Connect your Plaud account](#connect-your-plaud-account)). *Why:* you never hand your password to the plugin. *What protects you:* the plugin reads only the token your logged-in session already uses; your password is typed into Plaud's own page, not the plugin.
- **It is an unofficial tool, not affiliated with Plaud.** *What protects you:* it reads only your own data, and only when you ask it to. Following Plaud's terms of service is your responsibility.
- **Desktop only.** Sign-in and import rely on desktop features that Obsidian Mobile does not provide.

### What it will not do

- It only **adds** notes and attachments inside the output folder you choose, and never edits or deletes anything outside that folder. (To spot already-imported recordings it does read the frontmatter of notes inside your output folder — see [Permissions and access](#permissions-and-access).)
- It replaces an already-imported note only when **you** choose Overwrite (or confirm it under "Ask each time").
- It does not rewrite Plaud's transcript or summary text — it renders Plaud's own data into a note.
- The only change it can make in your **Plaud account** is a recording's **title**, and only if you turn on the optional title write-back and either confirm the prompt or opt into automatic updates (see [Renaming recordings](#renaming-recordings)). It never edits or deletes anything else in Plaud. With that setting off, the plugin is read-only against Plaud.

## What it does

- **One-click sign-in** — connect your Plaud account from settings without copying a token from the browser console. A sign-in window opens, you log in to Plaud normally, and your session token is captured automatically. Your password is never seen by the plugin. (Manual token paste is still available as a fallback.)
- **Test connection** — a button in settings makes one lightweight call to Plaud and tells you whether your token works, so you can confirm you are signed in (or learn you need to sign in again) without running a full import.
- **Lists your recent Plaud recordings** in a modal with scroll-to-load pagination.
- **Lets you pick which to import** via checkboxes — single or multi-select.
- **Per-recording artifact selection** — before a multi-import you can tick/untick transcript, summary, attachments, mindmap, and card independently.
- **Writes one markdown note per recording** with:
  - YAML frontmatter (Plaud ID, date, duration, speakers, tags, Plaud web URL) plus a layered set of optional fields surfaced from Plaud's flat GPT-5 schema (`plaud-headline`, `plaud-category`, `plaud-language`, `plaud-template`, `plaud-model`, `plaud-note-id`, `plaud-summary-id`, `plaud-summary-version`) — emitted only when present, never load-bearing.
  - Plaud's AI summary
  - An `AI Suggestions` section pulled from Plaud's `ai_suggestion` field when the response includes one (separate from the main summary)
  - A `Template outputs` section that renders any extra AI templates you generated in Plaud (Key Points, Daily Journal, Meeting Summary, and so on), one foldable subsection per template, instead of dropping them as unreadable `.bin` attachments
  - An inline chapter index with jump-links into the transcript
  - A heading-based transcript section with per-chapter `Back to Chapters` links
  - An `Open in Plaud` link under the H1 for quick round-tripping
- **Downloads attachments** (images, mind-map PNGs, card PNGs, other files) into a `<note-name>-assets/` folder and references them from the note.
- **Optional audio download.** Turn on **Audio** to save each recording's original audio next to the note and embed it as a playable clip under an `Audio` heading. Off by default because audio is large (roughly 15 MB per hour). Missing or expired audio never fails an import.
- **Background auto-sync (optional, off by default).** Checks Plaud on a schedule and imports new recordings automatically, and re-imports recordings you changed in Plaud (edited transcript, corrected speaker names). A re-import overwrites that note and its artifacts with Plaud's current version; unchanged notes are never touched. See [Auto-sync](#auto-sync).
- **Placeholder notes for unprocessed recordings.** When Plaud has a recording but no transcript or summary yet, the importer writes a small placeholder note (recording ID plus a link back to Plaud) instead of a bare failure, and a later import replaces it automatically. Optional, on by default.
- **Organize into dated subfolders** — an optional path template (for example `{{YYYY-MM}}`) files notes into per-month, per-week, or per-quarter folders built from the recording date, instead of one flat folder. Attachments follow their note.
- **Configurable note names.** A note-name template (the same Moment date formats as the subfolder setting, plus a `{{title}}` token) puts the recording date wherever you want it and formats every note name the same way. A Plaud title with no date gets a `YYYY-MM-DD` prefix so notes sort chronologically. The default reproduces the previous `YYYY-MM-DD <title>` naming, so nothing changes unless you set it.
- **Rename a recording from Obsidian.** A **Rename recording** command and a **Rename imported recording** right-click item rename a note and its `-assets` folder together, keeping embedded images valid. Renaming a Plaud note in the file explorer also moves its assets folder to match. And when you rename a recording in Plaud, the note and its assets folder are renamed on the next sync instead of leaving a stale-named note behind.
- **Optionally sync a rename back to Plaud (off by default).** When you rename a recording in Obsidian, the plugin can update that recording's title in Plaud so the two stay in sync. This is opt-in and the only thing the plugin ever writes back to Plaud; with it off, renames stay entirely local. See [Renaming recordings](#renaming-recordings).
- **"Imported" and "Update available" badges in the recording list.** Each row whose `plaud-id` already exists in your output folder shows an Imported pill; click it to open the existing note. If that recording changed in Plaud since you imported it, the row shows an Update available badge instead, so you can spot and re-import a stale note by hand. Re-importing is still possible and honors your duplicate-handling setting.
- **Resume an interrupted import.** If your Plaud session expires partway through a multi-select import, the run stops at the first recording that fails to authenticate, keeps what it already imported, and lets you sign in again right there; a **Resume remaining** button then finishes the recordings that were left.
- **Duplicate handling** is configurable — Skip, Overwrite, or Ask each time. "Ask each time" prompts per file with an explicit warning that the existing note body AND its `-assets` folder will be replaced; in a multi-select import you can escalate to "Overwrite all remaining" / "Skip all remaining" or cancel the batch.
- **Transcript folding** — imported notes open with the transcript section collapsed by default so the summary is what you see first. Toggleable in settings.
- **Debug log** — opt-in in-memory buffer of API requests/responses for troubleshooting; auth headers are never captured.

## Requirements

- **Obsidian 1.11.4 or newer** — required for the `SecretStorage` / `SecretComponent` APIs used to handle the Plaud token securely.
- **Desktop only** (`isDesktopOnly: true`). The authentication path depends on Electron APIs (including the separate sign-in window) that are not available on Obsidian Mobile. This restriction will be lifted when Plaud ships a public OAuth API (see [Plaud API status](#plaud-api-status) below).
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

Because Plaud has no official API, which method works depends on **how you log in to Plaud**. Pick the one that matches your account. Both store your token the same way; the difference is only how the token is captured.

#### Sign in with email

Use this if you log in to Plaud with an **email address and password**.

1. In **Settings → Community plugins → Plaud Importer**, under **Sign in**, click **Sign in** next to **Sign in with email**.
2. A separate sign-in window opens with Plaud's website. Log in with your email and password.
3. Once you reach your library, the plugin captures your token automatically and the window closes. The **Plaud token** status changes to **"connected."**

Google and Apple logins do **not** complete in this window. For those, use the next method.

#### Sign in with Google or Apple

Use this if you log in to Plaud with **single sign-on (SSO) through a Google or Apple account**. Those logins only work in a real web browser, so this method signs you in there and hands the token back to Obsidian. There is a quick one-time setup (saving a bookmark), then a few clicks each time.

**One-time setup (do this once):**

1. In the plugin settings under **Sign in**, find **Sign in with Google or Apple** and click **Set up bookmark**. A small page opens in your default web browser.
2. That page shows a button labeled **Plaud → Obsidian**. **Drag that button up onto your browser's bookmarks bar.** If you do not see a bookmarks bar, press **Ctrl+Shift+B** (Windows/Linux) or **Cmd+Shift+B** (Mac) to show it, then drag the button onto it.
3. The bookmark is now saved. You will not need to repeat this step.

**Each time you connect (about once a day, when the token expires):**

1. Back in the plugin settings, click **Launch sign-in to capture token**. A short reminder pops up; read it and click **Open my browser now**. Plaud opens in your browser.
2. Sign in to Plaud with Google or Apple if you are not already signed in.
3. When your recordings are showing, **click the Plaud → Obsidian bookmark** you saved, then **open any meeting**. A small pop-up box appears with your token in it. Select the token and copy it (Ctrl+C or Cmd+C).
4. Switch back to Obsidian and click **Paste token from clipboard**. The **Plaud token** status changes to **"connected."**

Why open a meeting in step 3: the bookmark watches for the request your token rides on, and opening a meeting is what triggers that request. If no pop-up appears, make sure you clicked the bookmark first, then open a meeting.

**Starting over:** the **Clear sign-in** button signs you out and clears the stored token, so you can connect a different account or recover from a stuck state.

Your sign-in token lasts about a day. When imports stop working, repeat the "each time you connect" steps to get a fresh one.

The token is stored in Obsidian's per-vault secret storage either way. It is **never written to `data.json`** and does not travel through Obsidian Sync. Switching vaults requires re-connecting.

Regional accounts (EU and others) need no extra setup. If Plaud routes your account to a regional server, the plugin detects it on the first import and remembers it.

### Test connection

After signing in, click **Test connection** to confirm your token reaches Plaud. It makes one lightweight call and reports either that your token works or the specific problem (for example, an expired token that needs a fresh sign-in). Use it any time imports start failing to tell quickly whether you need to sign in again.

### Output folder

Folder inside your vault where imported notes are written. Defaults to `Plaud`. Nested paths work (`Archive/Plaud/2026`).

### Subfolder template

By default every note lands directly in the output folder. To keep a growing library organized, set a **Subfolder template** that files each note into a subfolder built from the recording's date. Leave it empty to keep the flat layout.

Text inside `{{ }}` is a date format written in [Moment](https://momentjs.com/docs/#/displaying/format/) style, the same syntax the core Daily Notes plugin uses. Text outside the braces is kept as-is, and a forward slash (`/`) starts a new nested folder level, so `{{YYYY}}/{{MM}}` makes a year folder with month folders inside it. Keep your own words and separators outside the braces, because bare letters inside are read as date tokens.

Common tokens (case matters; the same set works in the note-name field):

| Token | Expands to |
| --- | --- |
| `{{YYYY}}` | Year, for example `2026` |
| `{{MM}}` | Month, `01` to `12` |
| `{{MMMM}}` | Month name, for example `June` |
| `{{DD}}` | Day, `01` to `31` |
| `{{dddd}}` | Weekday name, for example `Monday` |
| `{{WW}}` | ISO week number, `01` to `53` |
| `{{Q}}` | Quarter, `1` to `4` |

Examples (folder for a June 4 2026 recording):

| Template | Resulting folder |
| --- | --- |
| `{{YYYY-MM}}` | `2026-06` (one folder) |
| `{{YYYY}}/{{MM}}` | `2026/06` (a `2026` folder containing a `06` folder) |
| `{{DD}}-{{MM}}-{{YYYY}}` | `04-06-2026` (one folder, day-first order) |
| `{{YYYY}}/W{{WW}}` | `2026/W23` (a `2026` folder containing a `W23` folder) |
| `{{YYYY}}/{{MM MMMM}}` | `2026/06 June` (two tokens in one `{{ }}`) |

You choose the order and the separators, so any date layout works, and a whole layout can live in one `{{ }}`. A live preview under the field shows the resulting folder as you type, and insert-token buttons add the correct token at the cursor. The folder is built from the recording's own date, so re-importing always resolves to the same place. A recording with no usable date goes to an `_undated` subfolder.

The template applies to **new imports**; notes you already imported stay where they are. Each note's `-assets` folder follows it into the same subfolder. If you change the template later, re-importing an existing recording updates the note in place instead of creating a duplicate.

### Note name

By default each note is named `YYYY-MM-DD <title>`, using the recording's own date. To control the format, set a **Note name template** that builds the name from the same `{{ }}` Moment date formats as the subfolder setting, plus a `{{title}}` token for the recording title. Put the date before or after the title, in any order and with your own separators:

| Template | Resulting note name |
| --- | --- |
| `{{YYYY}}-{{MM}}-{{DD}} {{title}}` | `2026-07-03 Team sync` |
| `{{title}} {{YYYY}}-{{MM}}-{{DD}}` | `Team sync 2026-07-03` |
| `{{MMM D, YYYY}} - {{title}}` | `Jul 3, 2026 - Team sync` (one combined date token) |
| `{{title}}` | `Team sync` (no date in the name) |

Preset buttons fill in ISO, US, and EU orders, insert-token buttons add a token at the cursor, and a live preview shows the resulting name as you type, or type your own. Keep your own words outside the braces, since bare letters inside are read as date tokens. The recording's own date replaces any date already in the Plaud title, so a title like `04/13 Meeting` becomes the recording's date, and a title with no date gets one. A note name has to be a valid filename, so a template whose result would contain a slash, colon, or square bracket is rejected. The `date` property inside each note stays `YYYY-MM-DD` regardless, for Dataview and sorting.

Like the subfolder setting, this applies to **new imports**; existing notes are renamed only when you rename them yourself or when the recording changes in Plaud (see [Renaming recordings](#renaming-recordings)).

### Renaming recordings

You can rename an imported recording from Obsidian and keep everything in sync:

- Run the command **Plaud Importer: Rename recording** on the note, or right-click the note and choose **Rename imported recording**. Enter a new name, and the plugin renames both the note and its `-assets` folder so embedded images keep working.
- If you rename a Plaud note directly in the file explorer, the plugin moves its `-assets` folder to match automatically.
- When you rename a recording in Plaud itself, its note and assets folder are renamed on the next sync (or manual re-import), instead of leaving a stale-named note.

**Update the recording title on rename** (off by default) controls whether a rename is also pushed back to Plaud:

- **Off:** the Rename recording command asks each time whether to also update the title in Plaud, and a file-explorer rename stays entirely local.
- **On:** both the command and a file-explorer rename update the title in Plaud automatically, with no prompt.

The title sent to Plaud is your new note name exactly, so Plaud matches what you see in Obsidian. If your Plaud session has expired, the plugin offers to sign you in and then finishes the update, so a rename is not lost. This is the only change the plugin writes back to Plaud.

### Duplicate handling

What the importer does when a note for a recording already exists in the output folder:

- **Skip** — leave the existing note untouched. The importer reports it as `skipped` in the summary.
- **Overwrite** — replace the existing note body and clear its matching `-assets` folder before re-downloading. A confirmation modal fires once per import batch before any overwrite happens.
- **Ask each time** (default) — prompt per duplicate at write time. The modal shows the recording title and the exact target path, warns that the existing note AND its `-assets` folder will be replaced, and offers Overwrite, Skip, or (in multi-item batches) Overwrite all remaining, Skip all remaining, and Cancel import.

### Default artifact selection

What the "Review artifacts first" checklist starts with when you begin a multi-import: transcript, summary, attachments, mindmap, card, and audio. Uncheck artifacts you never want to pull by default; you can always override per-batch. **Audio is off by default** because the files are large (roughly 15 MB per hour of recording); turn it on only if you want the original audio saved and embedded in each note.

### Auto-sync

Optional background sync, **off by default**. When enabled, the plugin checks Plaud on a schedule and imports new recordings on its own using your default import options, with no import window open.

- **Enable auto-sync.** Turns the background job on or off.
- **Sync interval.** How often it checks, from every 15 minutes to once a day.

It also re-imports recordings you changed in Plaud since importing them (an edited transcript, corrected speaker names, a regenerated summary), including older recordings you edited today. **A re-import overwrites that note and its downloaded artifacts with Plaud's current version, so any edits you made to a synced note are replaced.** Only recordings that actually changed are touched; unchanged notes are never modified. This tradeoff is called out in the settings.

If your Plaud session expires, auto-sync pauses with a single notice and resumes automatically when you reconnect (Test connection, a manual import, re-entering your token, or toggling auto-sync off and on).

**Backfill for existing notes:** notes imported before this feature shipped do not carry the version marker auto-sync compares against, so their Plaud-side edits are not detected until the marker exists. Run the command **Plaud Importer: Backfill version markers for auto-sync** once after enabling auto-sync to make your existing library edit-detectable. It only adds a frontmatter marker and never rewrites note content.

### Tags and keywords

- **Tag mode** — which sources land in each note's `tags:` frontmatter: no tags, your custom tags only, Plaud tags (the default), or all (which also adds Plaud's AI keywords as `plaud/...` tags).
- **Custom tags** — comma-separated tags added to every imported note. Defaults to `plaud-meeting`.
- **Keep AI keywords as note property** — when AI keywords are kept out of `tags:`, optionally write them to a `keywords:` property instead. **Off by default**: Plaud's keyword list can run to hundreds of low-value entries per recording, which buries the tags that matter and adds noise to every note. Turn it on if you want the full list.

### Transcript rendering

- **Fold transcript by default** — imported notes open with the transcript heading collapsed so the summary is what you see first.
- **Transcript heading level** — which H-level the wrapping `Transcript` heading uses (chapters render one level deeper). Pick what fits your note style.

### Unprocessed and trashed recordings

- **Write placeholder for unprocessed recordings** (on by default). When Plaud has a recording but no transcript or summary yet, write a small placeholder note (recording ID plus a link back to Plaud) instead of recording a bare failure. A later successful import replaces the placeholder automatically, even under Skip or Ask each time. Turn it off to leave such recordings as plain failures with no file written.
- **Show trashed recordings** (off by default). The import list hides recordings that are in your Plaud trash, matching the Plaud app. Turn this on to bring them back when you want to import something you trashed in Plaud but still want in your vault.

### Import dialog

- **Auto-close summary** (on by default). The post-import summary closes itself after a short countdown. Only a fully successful run auto-closes; any failure keeps the window open so the error list stays visible, and clicking inside the window cancels the countdown.
- **Auto-close delay.** Seconds to wait before the summary closes (default 20).

### Appearance

- **Show ribbon icon** (on by default). Toggle the left-rail icon that opens the import window. Turn it off to launch imports only from the command palette. The change takes effect immediately.
- **Ribbon icon.** Pick the icon from a curated set (audio-lines, mic, headphones, podcast, and others). A live preview sits next to the dropdown and the ribbon updates immediately.

### Debug logging

Off by default. When on, captures API request/response metadata and parsed results into an in-memory buffer for troubleshooting. Auth headers are stripped. Payloads may contain transcript text, speaker names, and recording metadata, so only enable when you are preparing a bug report. Use the command **Plaud Importer: Debug: copy debug log to clipboard** to export the session.

## Using it

1. Click the **audio-lines** ribbon icon on the left rail, or run the command **Plaud Importer: Import recent recordings**.
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

⚠️ **This plugin currently uses Plaud's undocumented web API** under `api.plaud.ai`. The endpoints in use are `GET /file/simple/web` for listing recordings, `POST /ai/transsumm/{id}` for transcript and legacy summary retrieval, and `GET /file/detail/{id}` for the richer detail bundle (polish-revision summaries, AI keywords, mindmap and card attachments, and AI suggestions). The only write endpoint is `PATCH /file/{id}` to update a recording's title, used solely by the optional title write-back described in [Renaming recordings](#renaming-recordings). None of these are officially published or supported by Plaud.

The listing and `/ai/transsumm/{id}` endpoints were informed by prior community work, most directly [`rsteckler/applaud`](https://github.com/rsteckler/applaud), with cross-validation against [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API). Those projects established that the data was reachable from a logged-in web session and gave a useful starting point for the auth and listing flow. The richer `/file/detail/{id}` surface used by this plugin (the `transaction_polish` polish-revision summary, `auto_sum_note`, `ai_suggestion`, the GPT-5 frontmatter schema fields, and the pre-signed S3 URLs for mindmap, card, and attachment assets), along with the encoding quirks (millisecond timestamps on the listing endpoint, the empty-JSON `POST` body shape on `/ai/transsumm/{id}`), were verified and extended through direct inspection of live Plaud responses during this plugin's development.

What this means for you:

- **The plugin may break without warning** if Plaud changes URL shapes, response schemas, or authentication. When it breaks, the import modal will surface a clear error (auth failure, parse error, HTTP 4xx/5xx) rather than silently corrupt notes — but some releases may need to wait for a plugin update.
- **Your Plaud token is a full web-session JWT**, not a scoped API key. Treat it with the same care as your Plaud password. The plugin stores it in Obsidian's `SecretStorage`, never in `data.json`, and never logs it.
- **When Plaud ships a public OAuth API**, this plugin will switch to that surface and deprecate the reverse-engineered path. A separate `OAuthPlaudClient` stub is already stubbed in the codebase for the migration. The mobile-only restriction (`isDesktopOnly`) exists because of the current auth path and will be re-evaluated at that point.

I am actively monitoring Plaud's developer announcements and [waitlist](https://www.plaud.ai/) for the official API. If you hear anything, please open an issue.

## Permissions and access

Plaud Importer is desktop-only, runs on your device, and has no telemetry or maintainer server — it talks only to Plaud, and only when you ask it to. Obsidian's plugin scan discloses a few capabilities. Here is exactly what each is and why it exists:

- **Network access to Plaud.** The plugin calls Plaud's web API (`api.plaud.ai`, or your regional host) to list and fetch your recordings, summaries, transcripts, and attachments, and downloads attachment files from the CDN hosts Plaud's responses point at. It contacts no other third party, and only when you trigger an import, scroll to load more recordings, or download attachments. The one write it can make to Plaud is updating a recording's **title**, and only when you enable the optional title write-back and confirm or opt into automatic updates (see [Renaming recordings](#renaming-recordings)); with that setting off, every call to Plaud is read-only.
- **Sign-in window.** When you click **Sign in**, the plugin opens Plaud's own website (`web.plaud.ai`) in a separate window so you can log in normally. For Google or Apple logins, you sign in through your normal web browser instead and hand the token back with a bookmarklet. Either way, your password is entered into Plaud's page and is never seen by the plugin; it reads only the session token your logged-in session already sends to Plaud, and stores it via `SecretStorage`. The sign-in runs in a private session isolated from Obsidian's other web views.
- **Vault file enumeration.** To show the "Imported" badge and avoid duplicate imports, the plugin lists your vault's note paths and reads the frontmatter of notes **inside your output folder** to find ones it previously created (tagged with a `plaud-id`). It does not read the contents of unrelated notes.
- **Clipboard, write only.** The only clipboard use is the Copy buttons (copy debug log, copy an error or failure list for a bug report). It writes to your clipboard and never reads it, so it cannot see anything you copied elsewhere.
- **Secret storage.** Your Plaud token is stored via Obsidian's `SecretStorage` (per-vault, not synced); `data.json` holds only a reference id, never the token.

All vault writes go through Obsidian's `Vault` API (`Vault.create`, `Vault.process`) with no direct filesystem access, and nothing here sends your data anywhere except Plaud.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy and liability disclaimer, and [SECURITY.md](./SECURITY.md) for the security policy. The plugin is provided "AS IS" with no warranty (see [LICENSE](./LICENSE)); it is not affiliated with or endorsed by Plaud.AI, and you use it at your own risk.

## Troubleshooting

- **"No Plaud token configured"** — re-check the Plaud token field in settings. If your token expired, [connect your Plaud account](#connect-your-plaud-account) again (click **Sign in**).
- **"Plaud rejected your token"** — your web session likely expired or you signed out of Plaud. Click **Sign in** again to refresh the token (or re-paste it manually), then use **Test connection** to confirm it works.
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
