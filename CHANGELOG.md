# Changelog

All notable changes to Plaud Importer will be documented in this file.

## [Unreleased]

### Added

- **Start and end times in frontmatter.** Every imported note now gets `start-time` and `end-time` properties, written as ISO 8601 with the time-zone offset (for example `2026-08-07T14:52:11-04:00`). They are always present, no template needed, so you can query and sort recordings by their exact time in Dataview. The `date` property stays `YYYY-MM-DD` so existing date queries and daily-note links keep working.
- **A "Fallback time zone" setting.** Used only for the rare older recording that arrives without Plaud's own time-zone information. Type an IANA zone name such as `America/New_York`, or leave it empty to use the importing device's zone. Almost every recording carries its own zone and ignores this.

### Changed

- **Times are written in the recording's own capture time zone.** The plugin now reads the time zone each recording was made in and renders every time in it, so a note reads the same wall-clock time Plaud shows and no longer shifts depending on which computer ran the import. This applies to the `date` property, the note name, the subfolder, the optional `datetime` property, and the new start and end times. If you have always imported on a computer set to the same zone you record in, nothing changes. If you sometimes import from a different zone (a second machine, travel, or an automated run), notes now land on the correct day and time instead of the importing machine's. A recording imported before this change is only re-dated if you re-import it.

## [0.38.0] - 2026-08-02

### Added

- **A Discord link in the settings footer and the README.** Questions, ideas, and general discussion now have somewhere to go that is not a GitHub issue. The invite never expires. A GitHub issue is still the better home for anything that needs tracking.
- **A funding link.** Obsidian shows it beside the plugin in Community plugins for anyone who wants to support the work. Entirely optional and it changes nothing about how the plugin behaves.

### Fixed

- **Template names with stray braces no longer misbehave.** A note-name or folder template containing an unmatched `{`, for example `{{{{YYYY}}`, was read starting from the first brace, so the plugin fed the date formatter a nonsense pattern and put garbage in your filename. It now reads the well-formed `{{YYYY}}` and leaves the stray braces as the plain text they are. A template with a long run of `{` characters could also make the plugin hang for seconds while it worked through them; that is now instant.
- **The description of "Keep AI keywords as note property" is the same on every Obsidian version.** The settings tab renders through two different code paths depending on your Obsidian version, and the one used by 1.12 was missing the sentence explaining why the toggle is off by default. Both now show the full description.
- **The links in the settings footer no longer run together.** The separators between them depended on plain whitespace, which the layout dropped, so the row could read `GitHub|Report issues`. They are spaced by the layout now.

## [0.37.0] - 2026-08-02

### Changed

- **Each vault now keeps its own Plaud sign-in.** The sign-in belonged to your Obsidian installation rather than to any one vault, so every vault running the plugin shared a single one. **You will need to sign in once more in each vault after updating**, and that is the whole cost of the fix below. In return, signing in to one vault no longer changes another, **Clear sign-in** only signs out the vault you run it in, and you can point different vaults at different Plaud accounts if you want to. If you use the plugin in a single vault, nothing changes except that one sign-in.
- **Clear sign-in also removes the old shared sign-in left behind by the update.** The previous installation-wide session is not deleted when you update, because a vault still running an older version of the plugin may legitimately still be using it, and Obsidian updates plugins one vault at a time. That leaves a session on disk that nothing signs into any more. **Clear sign-in** now clears it along with this vault's own, so there is a way to remove it rather than waiting out its expiry. It otherwise lapses on its own within about 30 days.

### Fixed

- **A sign-in that cannot be saved no longer half-applies.** Saving a captured sign-in writes two things: the credential itself, and the plugin settings that describe it (which regional server your account is on, and which sign-in method you used). The credential was written first, so if the settings write then failed, the two disagreed: the new credential was stored while the settings still described the previous one, and the mismatch survived a restart. That could send your new sign-in to the wrong regional server, or point **Reconnect** at the wrong sign-in window. The settings write happens first now, and the credential is stored only once that write has landed, so a failure changes nothing at all and the sign-in you already had keeps working. The settings write is the one that can fail for ordinary reasons: a vault on read-only storage, a full disk, or a sync client holding the file. The same guarantee covers the credential store itself: if it refuses its write after the settings save, the plugin puts the settings it had just saved back and reports the failure, and in the rare case where even that restore fails, it says exactly what state you are in and that signing in again fixes it (issue #86).
- **A failed save no longer looks like a bad token.** The message shown when a capture could not be saved described it as a token problem, which sent you to sign in again for something signing in again cannot fix. A vault that will not accept the write is now reported as itself, and separately from a sign-in Plaud actually rejected (issue #86).
- **Two vaults no longer knock each other's sessions offline.** Every vault kept its own renewal schedule but they all renewed the same shared sign-in. When two of them came due around the same time, both rotated the same underlying credential and whichever finished second found the value it was holding already replaced. It reported a renewal failure, stopped renewing, and asked you to reconnect, even though your account was completely fine. It also spent two of the roughly ten renewals an hour Plaud allows where one would have done. Sessions are now separate per vault, so there is nothing left to collide over (issue #87).
- **Two vaults signed in to two different Plaud accounts no longer overwrite each other.** Because the single shared sign-in held whichever account logged in most recently, this was ambiguous before background renewal existed. Separate sign-ins remove the ambiguity rather than working around it.

## [0.36.1] - 2026-07-31

### Fixed

- **The sign-in popup no longer warns about a daily sign-in that is not coming.** Plaud now issues every session for about 24 hours, and since 0.36.0 a session from the email sign-in window renews itself in the background for about 30 days. The popup shown at sign-in still carried older wording written before renewal existed: it called a 24-hour session unusual ("not the long session most accounts get") and promised the plugin would ask you to sign in again when it expires, even when background renewal was about to make that untrue. It now says what actually happens for your sign-in method: renewal for email-window sessions, and a reconnect-on-expiry note for captures that renewal cannot carry. The sign-in help text in settings carried the same outdated claim ("most accounts get a long session, months to about a year") and now matches reality, including the recommendation for Google and Apple accounts to add a Plaud account password and use the email sign-in.
- **Signing in now tells you when the token could not be saved.** Saving a sign-in stores the credential and then writes the plugin's settings, and that second write can fail for ordinary reasons: a vault on read-only storage, a full disk, or a sync client holding the file. From the **Sign in** and **Paste token from clipboard** buttons in settings, that failure showed you nothing at all. The button simply re-enabled and the sign-in looked like it had quietly done nothing. Both buttons now say the token could not be saved, and suggest checking that the vault is writable and has free space if it keeps happening (issue #86).
- **The "session expired" prompt now goes away once your session is working again.** When background sync ran into an expired session it paused itself and showed a reconnect prompt. That prompt deliberately has no timeout, so it cannot disappear before you read it, but nothing ever took it back down. If the session recovered on its own, which is easiest to hit when Obsidian wakes from sleep and a background renewal finishes just after a sync attempt already failed, imports carried on normally while the prompt sat there asking you to reconnect a session that was already fine. Every path that clears the pause now clears the prompt with it, and the prompt is no longer raised at all if the plugin is shutting down while a background check is still finishing (issue #88).

## [0.36.0] - 2026-07-26

### Added

- **Email sign-ins now keep themselves signed in for about 30 days.** Plaud sessions last 24 hours, so the plugin has been asking you to reconnect every day. If you signed in with the **Sign in with email** window, it now renews that session quietly in the background before it lapses, and imports and auto-sync keep running without you doing anything. After about 30 days Plaud requires a real sign-in again, and you get the usual reconnect prompt. This has a limit worth knowing: renewal works only for the email window, because that is the only sign-in the plugin can renew on your behalf. Google and Apple sign-ins finish in your web browser, and the bookmark runs there too, so neither leaves the plugin anything to renew with. Those sessions keep working exactly as before and ask you to reconnect when they lapse. Settings now says which of the two your session is, under the connection status.
- **If a renewal fails, the plugin says so instead of failing quietly.** It stops, shows the reconnect prompt, and does not keep hammering Plaud, which has an hourly limit on sign-in attempts. Turning on debug logging adds a **Debug: refresh the session now** command so a failure can be captured for a bug report.

### Fixed

- **The sign-in window no longer gets stuck when your browser storage holds several old sign-in values.** It gathers a handful of possible credentials and tries each against Plaud, but it was counting anything that merely looked like a credential toward that handful. Expired leftovers and the companion value Plaud stores beside your real session could use up every slot before it reached the one that works, leaving the window open forever after a successful login. It now ignores values it can already tell are unusable, so the slots go to real candidates. This also means one less rejected call to Plaud each time you sign in.
- **A failed sign-in no longer leaves the plugin pointed at the wrong Plaud region.** If the window discovered your account was on a different regional server and the sign-in then failed to save, the plugin kept the new server address next to your old credential, which could send a working token to a server that would reject it. The address is now saved only together with a credential that was actually stored.

## [0.35.3] - 2026-07-26

### Fixed

- **"Sign in with email" captures your session again.** The sign-in window looked for your session in one fixed place, and Plaud's web app stopped putting it there: it now nests the credential inside a larger block of data. The window would open, you would log in successfully, and nothing would happen, because it never found anything to capture. It now looks inside stored data structures the same way the browser bookmark does, and confirms the credential with Plaud before saving it, so the token that gets stored is the one that actually works. This affects both email and Google/Apple accounts, which Plaud moved to the same session model.

### Changed

- **Sessions now last about 24 hours on every account.** This is Plaud's change, not the plugin's: the long-lived session that used to last months is no longer issued to anyone, on any sign-in method. The plugin shows your real expiry in settings and warns before it lapses with a one-click reconnect. Nothing the plugin can do restores the longer session.

## [0.35.2] - 2026-07-26

### Fixed

- **The bookmark now works when you have more than one vault open.** Obsidian hands a link like this one to whichever vault window is focused, so if that was not the vault running Plaud Importer you got "Unrecognized URI action" and nothing else. The bookmark is now built for the vault you set it up in and says so on the setup page, so it reaches that vault whatever else has focus. If you use the plugin in more than one vault, run **Set up bookmark** in each and keep a bookmark per vault.

## [0.35.1] - 2026-07-26

### Fixed

- **The browser bookmark now finds your sign-in on Google and Apple accounts, where 0.35.0 found nothing.** On those accounts Plaud stores no plain sign-in token at all: the live credential sits nested inside a larger block of data, alongside a second token that the server rejects and a profile record holding your name and email. 0.35.0 only looked at whole stored values, so it saw none of them and told you to sign in when you already were. The bookmark now looks inside stored data structures too, and still picks by asking Plaud which credential actually works, so the reject-on-use token and the profile record are never chosen. Verified end to end against a real Apple sign-in.
- **A failed capture is no longer a dead end.** When the bookmark finds nothing it used to stop at a message with no way forward, which was worse than the version before it. It now always hands back something: either your sign-in, or a short diagnostic line you can send on. That line contains no token and no personal details.

## [0.35.0] - 2026-07-26

### Changed

- **Reconnecting through the browser is now one click, and it works on accounts where it used to capture nothing.** The Plaud → Obsidian bookmark sends your token straight to Obsidian over an `obsidian://` link instead of showing a box for you to copy and paste, and it no longer reads a single fixed storage key. It collects every value in the Plaud web app's own storage that decodes as a live session token, and the plugin tries each one against Plaud and keeps the first that actually works. Issue #78 turned up two account shapes this fixes: one where the usual key holds a 24-hour token, and one (reported by rogerfsh) where that key is missing entirely, the only live credential sits under a workspace-specific key, and the long-lived token that does exist has been revoked server-side. Selection is by what Plaud accepts, never by which token claims to live longest, because the revoked one claims the longest life.

  **You must replace your bookmark.** Open the plugin settings, click **Set up bookmark**, and drag the new **Plaud → Obsidian (v2)** button over your old one. The old bookmark keeps working the old way (copy and paste) but cannot do any of the above.

  If Obsidian does not open when you click the bookmark, it falls back to a copy-and-paste box as before, and **Paste token from clipboard** still works. The fallback now hands over the same set of candidates rather than just the first one, so pasting picks the working sign-in exactly like the link does. If Plaud cannot be reached while several candidates are in play, nothing is saved rather than guessing wrong; with a single one it is saved unverified, as before.

## [0.34.0] - 2026-07-25

### Added

- **The plugin now warns you before your session expires.** A sticky notice with a one-click Reconnect action appears ahead of expiry: 2 hours ahead for short sessions (the 24-hour tokens some accounts get, issue #78) and 7 days ahead for long ones. The warning fires once per sign-in, works whether or not automatic sync is enabled, and reschedules itself whenever the stored credential changes.

### Changed

- **Auth-error screens now lead with the sign-in that works for your account.** For browser/bookmarklet (Google and Apple) accounts, the import dialog's sign-in section opens with the browser flow expanded and primary, instead of pushing the embedded email window that those accounts cannot complete. The "Plaud rejected your token" message no longer points at re-entering the token in settings, which was the wrong remedy for browser-flow accounts.

## [0.33.0] - 2026-07-25

### Changed

- **The plugin now measures your session's real lifetime instead of promising a year.** Issue #78 showed that Plaud sets session length per account: the long-lived (~300 day) token is real and confirmed on US accounts, but at least one APSE1 account gets a 24-hour token under the same key. The settings status line now shows your actual expiry and issued lifetime (for example "About 18 hours left (issued for 24 hours)"), Test connection reports the same, and signing in with a short-lived session shows a one-time heads-up so the later expiry is not a surprise. All "about a year" wording in the app and README is corrected: session length is set by Plaud and varies by account.

### Added

- **New command: "Debug: copy session status to clipboard".** Copies a privacy-safe block (plugin version, API region, sign-in method, and a redacted token summary containing no token value and no identity claims) designed to be pasted directly into a GitHub issue. Reporting a session problem like #78 becomes a paste instead of hand-decoding JWTs.

## [0.32.1] - 2026-07-18

### Fixed

- **Sending the token back through the bookmarklet link now finishes the reconnect properly.** During a browser reconnect, returning your token via the bookmarklet's send-to-Obsidian link stored it but left the job half done: paused background sync stayed paused until its next check, any retried action never ran, and the reconnect window stayed open. The link now completes the reconnect exactly like the Paste token button: sync resumes immediately, the retried action runs, and the window closes on its own. A token sent by link outside of a reconnect also resumes paused sync now.

## [0.32.0] - 2026-07-18

### Removed

- **The daily background session renewal machinery is gone.** Since 0.31.0 your sign-in captures Plaud's long-lived account token, which stays valid for months and needs no renewal, so the old 24-hour refresh subsystem (the background timers, the retry backoff, the "Refresh session now" command, and the "Keep the session alive automatically" setting) had nothing left to do and has been removed. When your session eventually lapses, the same one-click Reconnect prompt as before signs you back in. The "Test connection" button in settings remains the way to check session health.

### Changed

- **Reconnect now remembers how you signed in.** The prompt reopens the email sign-in window or the browser flow based on which one captured your current session, instead of inferring it from leftover renewal data. Sessions signed in before this version keep routing correctly via the old signal.

## [0.31.0] - 2026-07-18

### Changed

- **Your Plaud session now lasts about a year instead of pausing every day.** Sign-in captures Plaud's long-lived account token (read directly from Plaud's web app after you sign in) instead of the short-lived 24-hour token the plugin used to grab. Because the long-lived token stays valid for roughly 300 days, automatic sync and imports keep working for months between sign-ins, and this applies to Google and Apple (SSO) accounts too, not just email and password. When the token finally expires (or you sign out of Plaud elsewhere), the plugin shows the same one-click Reconnect prompt as before, now expected about once a year rather than daily.
- **The daily background session renewal no longer runs on these sessions.** The long-lived token does not expire in 24 hours, so there is nothing to renew. Running the old renewal would only replace it with a short-lived token and bring back the daily pause, so it is now switched off whenever a long-lived token is stored. "Refresh session now" simply confirms the session is healthy in that case.

## [0.30.3] - 2026-07-17

### Fixed

- **Email sign-in truly no longer opens plaud.ai in your web browser.** The 0.30.2 fix hardened the popup blocker, but the real leak turned out to be different: Obsidian 1.13 (which auto-installed in late June) began rerouting every page navigation inside plugin windows to your default browser, so when Plaud's site redirected itself to its login page, that redirect landed in your browser as a stray tab. The sign-in window now keeps its navigation to itself. Verified end to end against Obsidian 1.13.2: the login redirect stays inside the in-app window and nothing opens externally. If the plugin ever cannot apply this protection, it refuses to open the sign-in window rather than leak sign-in URLs to your browser.

## [0.30.2] - 2026-07-17

### Fixed

- **Email sign-in no longer also opens plaud.ai in your web browser.** The in-app sign-in window is meant to block the popups Plaud's web page fires while it loads, but the block was silently broken, so those popups escaped to your default browser as stray tabs. The block now actually holds: clicking Sign in with email opens only the in-app window. The Google and Apple sign-in flow still opens your browser, which is intentional.

## [0.30.1] - 2026-07-10

### Fixed

- **Reconnecting a Google or Apple (SSO) account no longer sends you to a dead end.** When a Google or Apple session lapsed during background auto-sync, the pause notice's Reconnect button opened the email sign-in window, where Google and Apple logins do not work. Reconnect now detects an SSO account and reopens the browser bookmarklet sign-in that actually works for it, and pasting the fresh token resumes the paused sync. Email and password accounts keep using the sign-in window as before.
- **A Google or Apple session that cannot be renewed silently stops retrying instead of hammering Plaud hourly.** Those accounts keep their renewable session in your browser, not the plugin, so the silent background refresh can never succeed for them. It used to keep retrying about hourly forever. It now stops after its short backoff and waits for you to reconnect (auto-sync still recovers on its next run and via the Reconnect notice), which also avoids Plaud's per-hour refresh limit. Email and password sessions keep retrying as before, since their failures may be temporary.

### Changed

- **Clearer explanation of why Google and Apple accounts reconnect about daily.** The sign-in help and README now state that Plaud keeps the renewable session in your own browser, out of the plugin's reach, so SSO accounts cannot be refreshed silently the way email and password accounts can.

## [0.30.0] - 2026-07-09

### Added

- **New `plaud-industry` frontmatter property.** Plaud carries a topical/industry classification alongside each summary, separate from the summary category. When present it is now written as its own `plaud-industry` property instead of being folded into `plaud-category`, so the two never mix. It is left off for recordings where Plaud provides no industry value. A matching `{{industry}}` token is available in the extra-frontmatter value field.

### Fixed

- **The `plaud-category` property no longer duplicates `plaud-template`.** Plaud's current summary format stores the template (summary-type) name in the same field the plugin reads for the category, so both properties came out with the identical value, for example both showing "Deep Summary Transcript". The plugin now omits `plaud-category` when its value would only repeat `plaud-template`. If Plaud ever provides a category that genuinely differs from the template, it is written as before.

## [0.29.0] - 2026-07-09

### Fixed

- **The background session refresh no longer opens `web.plaud.ai` tabs in your default browser.** The refresh timer's delay is computed from the stored token's expiry, and for a long-lived token (an expiry 137 days out was observed) that delay overflowed the browser's 32-bit timer limit (about 24.8 days) and fired immediately instead of months later. The needless refresh then failed, retried on a backoff up to hourly, and every retry opened a hidden sign-in window whose login page leaked popup tabs into your default browser. The schedule is now capped safely below the timer limit, and a timer that wakes early re-arms without refreshing while the token still has plenty of life, so a valid token is never refreshed for no reason.

### Changed

- **A background refresh never opens a sign-in window anymore, not even a hidden one.** It uses only the silent, windowless renewal. If that fails, the plugin pauses and shows the one-click Reconnect prompt instead of loading Plaud's site in the background; only clicking Sign in or Reconnect ever opens a window.
- **A hung refresh request can no longer wedge the plugin.** Each renewal call is bounded by a 30-second timeout, so a stalled connection now counts as a failed refresh instead of silently blocking every later refresh and the Sign in button until Obsidian restarts.

## [0.28.0] - 2026-07-09

### Added

- **New setting "Preserve unknown frontmatter on re-import" (on by default).** When a re-import overwrites a note, any frontmatter property you added yourself, or that another tool wrote, is now kept instead of being dropped. Before this, a re-import rebuilt the whole frontmatter block from the plugin's own fields plus your declared extra-frontmatter rows, so a property that downstream automation wrote straight into the note was lost on the next overwrite. Reserved plugin fields still refresh, and you can still let the plugin manage a specific property by adding it as an extra-frontmatter row with preserve turned off. Turn the setting off to restore the old rebuild-from-scratch behavior.

### Fixed

- **The `plaud-model`, `plaud-template`, `plaud-headline`, `plaud-category`, and `plaud-summary-id` frontmatter fields are populated again.** After Plaud moved AI summaries onto a newer generation path, the plugin fetched only the summary text and dropped all of this metadata, so notes (and any MP3 you uploaded) came in with none of those properties. The plugin now reads the metadata from the same recording detail it already downloads, so the fields return. The template value now prefers Plaud's readable template name (for example "Adaptive Summary") over its internal code. If a future Plaud change relocates a field again, the import still succeeds without it and a debug log names the field that could not be found.
- **A placeholder stub's `plaud-placeholder` marker no longer lingers after real content arrives.** The marker was missing from the plugin's reserved-key set; it is now reserved, so a later real import clears it as intended.

## [0.27.2] - 2026-07-08

### Fixed

- **Recordings in Plaud's trash are now recognized correctly.** Plaud's trash flag can arrive as a number or string rather than a strict boolean, so the plugin was treating every recording as not-trashed. That left the new "Trashed" badge and the "Hide trashed" filter with nothing to act on. The flag is now read in all its forms, so trashed recordings show the badge (when "Hide trashed" is off) and the filter works.

## [0.27.1] - 2026-07-08

### Fixed

- **The import dialog no longer gets stuck on an empty list.** When automatic sync had already imported your newest recordings, opening the dialog with "Hide already-processed" on could leave the list blank with nothing to scroll, so older recordings you had not imported yet were unreachable. The dialog now pages past fully-hidden recordings on its own until it finds ones to import. When there is genuinely nothing to import it says so and tells you to turn off a filter to review existing notes, instead of showing a blank panel with a misleading "scroll to browse" hint.

### Changed

- **The filter toggles are now one compact "Hide:" group on a single line** (Processed, Updates, Ignored, Trashed), so they no longer wrap and take up less room. Each keeps its full description in a tooltip.
- **Recordings in Plaud's trash now show a "Trashed" badge** when "Hide trashed" is turned off, so they are no longer indistinguishable from your live recordings.

## [0.27.0] - 2026-07-08

### Added

- **New "Hide updates available" filter in the import dialog.** A recording you already imported but later changed in Plaud shows an "Update available" badge; re-importing it overwrites the note with Plaud's newer version. Those rows stay visible by default, because they are work you may still want to do. The new "Hide updates available" toggle collapses them too, so the list can show only brand-new recordings when you want the shortest possible list.

### Changed

- **The import dialog's filter toggles now read consistently.** All four are phrased as "Hide ...": "Hide already-processed", "Hide updates available", "Hide ignored", and "Hide trashed" (previously "Show trashed"). A checked box now always means "this is hidden", so the whole bar reads the same way instead of mixing hide and show. Behavior is unchanged: trash is still hidden by default.

## [0.26.0] - 2026-07-08

### Added

- **The import list can now hide recordings you have already imported.** The import dialog has a new filter bar. "Hide already-processed", on by default, drops recordings that are already imported and unchanged, so the list shows only new recordings and ones that changed in Plaud since you imported them. This is issue #54: setting "Duplicate handling" to "Skip" made people expect imported recordings to leave the list, but that setting only ever governed whether a note is written, never what the list shows. The filter bar is what controls the list now, and it is independent of duplicate handling. "Show trashed" also moved into the bar so all three list toggles sit together.
- **Ignore recordings you never want imported.** Each row in the import dialog has an eye button. Click it to ignore a recording, for example a junk clip or a personal note: it drops out of the list when "Hide ignored" (on by default) is set, and background automatic sync never pulls it either. Ignoring works even on recordings you never imported, since it does not depend on a note existing. Turn "Hide ignored" off to see ignored recordings again, each with a crossed-eye button you can click to un-ignore. The ignore list is saved with the plugin's settings and keyed by each recording's stable id.

## [0.25.2] - 2026-07-08

### Changed

- **The "Duplicate handling" setting is now labelled "Duplicate handling for manual imports", and its description says automatic sync ignores it.** The old label read as though it governed every import, so choosing "Ask each time" while automatic sync was on looked like it would make a background run stop and wait for a prompt that can never appear unattended. It never did: automatic sync has always run headless, importing new recordings and re-importing only the ones you changed in Plaud, and never prompts. The clearer wording and a matching line on the automatic sync setting spell that out so the two settings no longer look linked (issue #43).

## [0.25.1] - 2026-07-08

### Fixed

- **The card image in an imported note no longer shows "could not be found."** Plaud's AI summary embeds its card poster with an inline link that only resolves inside Plaud's own app. The plugin already downloads that image into the note's attachments folder, but left the summary's original embed pointing at Plaud. It now repoints the inline embed at the local copy, so the card renders in Obsidian (issue #52).
- **A one-time command repairs the card image in notes you imported earlier.** The fix above only applies as notes are imported, so notes imported before it keep the broken card. Run **Repair card image links from older imports (one-time)** from the command palette to repoint those existing notes at the card already in their attachments folder. It only touches this plugin's notes, is safe to run more than once, and reports how many it fixed. Notes whose card was never downloaded are left for a re-import (issue #52).

## [0.25.0] - 2026-07-08

Promotes the background session refresh previewed in 0.25.0-beta.1 to a stable release, with the hourly-window bug fixed, and adds user-defined frontmatter and a dated default subfolder layout.

### Added

- **Add your own properties to every imported note (Extra frontmatter).** A new setting lets you define extra frontmatter properties that are written on each import: give each one a name, a value, and whether to preserve it. The value can be plain text (`status: unprocessed`) or use the same `{{ }}` tokens as the other fields, the date set plus `{{title}}` and `{{plaud-folder}}`, and content tokens like `{{category}}`, `{{headline}}`, and `{{duration}}` that pull from the recording and its AI summary. So `quarter: Q{{Q}}-{{YYYY}}` writes `quarter: Q3-2026`, and `type: {{category}}` files the recording's own category under your key name. Turn on preserve for a property you maintain by hand (a status, a project) so a re-import keeps your value; leave it off for a value that should refresh from the recording each time. This applies identically to manual imports and background auto-sync. Custom properties are added alongside the plugin's own fields; a name that matches a built-in field (like `date` or `plaud-id`) is reserved and left to the plugin. Thanks to @jtsmith2 for proposing the feature (PR #50).
- **Your Plaud session now stays connected on its own.** Plaud's access token expires about every 24 hours, which used to pause background auto-sync roughly once a day until you reconnected. The plugin now renews the session quietly in the background before the token expires, so auto-sync and imports keep working without a daily reconnect. It is on by default and can be turned off under Settings, Automatic sync, "Keep the session alive automatically". A new **Refresh session now** command renews immediately and reports whether it worked, so you can confirm the whole path in seconds. Renewal is fail-safe: your stored token is only ever replaced after a renewal succeeds, so a failed renewal (or turning the feature off) simply falls back to the one-click reconnect prompt (issue #5).
- **One-click reconnect when your Plaud session expires.** When background auto-sync pauses because your session expired (or no token is configured), the pause notice now carries a **Reconnect** link that opens sign-in and resumes auto-sync the moment a token is captured, instead of sending you to settings. The **Backfill version markers** command does the same: if it fails because the session expired, it offers **Reconnect and retry** rather than a dead-end error. Signing in this way sets the token in the not-configured case too.

### Changed

- **New installs now file recordings into dated `{{YYYY}}/{{MM}}` subfolders by default.** The subfolder template previously defaulted to empty, which wrote every note flat into the output folder and surprised users who expected a dated layout. Fresh installs now get a year/month folder tree out of the box. This only affects new installs: if you already set (or deliberately cleared) the subfolder template, your choice is untouched. Set it back to empty under Settings if you prefer a flat layout (issue #45).
- Development tooling: a CI check now validates every hardcoded ribbon-icon id against the Lucide icon set, so an invalid id (which would render a blank icon) fails the build instead of shipping. No behavior change.

### Fixed

- **The background session refresh no longer opens a browser window on its own.** The windowless refresh was authenticating without the sign-in session's cookies, so it failed on every attempt and fell back to a hidden sign-in window that leaked a visible browser window roughly once an hour (10+ overnight for some testers). It now renews the session directly over the session cookies with no window, and reschedules about a day out. A debug run also reports exactly why a refresh fell back, if one ever does (issue #5).

## [0.24.0] - 2026-07-06

### Added

- **`{{plaud-folder}}` in the subfolder template.** The subfolder setting now supports a `{{plaud-folder}}` token that expands to the recording's Plaud folder name, so `{{plaud-folder}}/{{YYYY}}` mirrors your Plaud folders into the vault tree (nice with a folder browser like Notebook Navigator). Plaud folders are flat, so a slash in a folder name is flattened to your replacement character rather than creating a nested level, and a recording with no Plaud folder files under `_unfiled`. A recording in more than one Plaud folder uses the first. Follows up on the `plaud-folder` frontmatter field from 0.19.0 (issue #16).

## [0.23.0] - 2026-07-06

### Added

- **`{{title}}` in the subfolder template.** The subfolder setting now supports the `{{title}}` token, so you can file each recording in its own folder named after it (a "folder note" layout that pairs well with plugins like Notebook Navigator): `{{YYYY}}/{{title}}` files a July recording titled Team sync under `2026/Team sync`. The title has any leading date removed, the same as in the note name, so the folder and note names line up. A slash or backslash in a title is flattened to your replacement character so it stays a single folder instead of creating an accidental nested level, and a recording whose title is only a date files under `_untitled` rather than dropping into the output root. Resolves the follow-up on issue #30.
- **Configurable forbidden-character replacement.** A new setting chooses the character that stands in for a slash, colon, or other character a file name or folder cannot contain (for example one that appears in a recording title). It defaults to a dash and applies to both note names and folder names. Set it to `_` or any other single safe character; the setting refuses a value that would itself be an illegal character.

## [0.22.1] - 2026-07-06

### Fixed

- The "Cassette tape" ribbon icon option now shows an icon instead of disappearing. It referenced a Lucide icon id (`tape`) that does not exist; the correct id is `cassette-tape`. Selecting it left the ribbon with no icon. Resolves issue #34.

## [0.22.0] - 2026-07-06

### Added

- **Datetime frontmatter property.** A new setting adds a `datetime:` property to each imported note, formatted with the same `{{ }}` Moment tokens as the folder and note-name fields. It is empty by default (no property is written); set a template to turn it on. The existing `date:` property stays `YYYY-MM-DD` so Dataview queries and daily-note links keep working, and this separate field records the time in whatever format you want: 24-hour (`{{YYYY-MM-DD HH:mm}}`), 12-hour (`{{YYYY-MM-DD h:mm A}}`), or ISO 8601 with the UTC offset (`{{YYYY-MM-DDTHH:mm:ssZ}}`). The value is your computer's local time; include `{{Z}}` to record the offset so the instant stays unambiguous across devices and time zones. A live preview shows the result as you type. Resolves issue #32.
- **Time tokens on every template field.** The insert-token buttons now include Hour, Minute, Second, AM/PM, and Offset, so you can compose a time in the subfolder and note-name templates too, not just the new datetime field.

## [0.21.1] - 2026-07-05

### Fixed

- Resolve type-checking warnings the marketplace scan reported on the Moment date-format code. Obsidian's `moment` re-export resolves as an untyped value in that stricter environment, so the date formatter now pins it to Moment's own type. No behavior change; date formatting works exactly as in 0.21.0.

## [0.21.0] - 2026-07-05

### Changed

- **Date formats in the subfolder and note-name templates now use real Moment syntax** (the same format the core Daily Notes plugin uses), and every token works in both fields. You can now write any date layout, including named months and weekdays, and put a whole layout in one `{{ }}`: `{{YYYY/MM MMMM/YYYY-MM-DD dddd}}` files a recording under `2026/07 July/2026-07-05 Sunday`. Tokens are the standard Moment ones, so `{{YYYY}}` is the year, `{{MM}}` the month, `{{DD}}` the day, `{{dddd}}` the weekday name, `{{WW}}` the ISO week, and `{{Q}}` the quarter. Keep your own words outside the braces, since bare letters inside are read as date tokens. This resolves a report that `{{YYYY}}`, combined tokens like `{{MM MMMM}}`, and a weekday token did not work, and that named months worked only in the note name and not the subfolder.
- Your existing subfolder and note-name templates are migrated automatically the first time this version loads, and the migration is output-preserving: every note lands with exactly the same name and folder as before. Month and weekday names render in English, matching the previous behavior regardless of your Obsidian display language.

### Added

- **Live preview and insert-token buttons on both template fields.** Each template setting now shows the resulting folder or note name for a sample recording as you type, and a row of buttons (Year, Month, Day, Weekday, Quarter, Week, and Title on the note-name field) inserts the correct token at the cursor, so you do not have to remember the exact spelling. The preview also flags a template that would produce an invalid note name before you save it.

### Fixed

- A subfolder template that would create a folder Windows cannot hold (a reserved device name like `CON`, or a segment ending in a space or dot) is now refused when you save it, with the reason shown in the preview, instead of being accepted and then failing at import time. This only affects literal text you type into the template; date tokens never produce such a name.

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
