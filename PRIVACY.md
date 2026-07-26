# Privacy Policy

_Last updated: 2026-05-15_

This policy explains what the **Plaud Importer** Obsidian plugin ("the plugin") does and does not do with your data. It applies to the plugin as distributed through GitHub releases and BRAT.

## Summary

The plugin runs entirely on your own device. It moves your own Plaud.AI content into your own Obsidian vault. The maintainer operates no server, receives no data, and collects no information about you or your use of the plugin.

## What the plugin does

When you explicitly trigger an import, the plugin:

1. Authenticates to Plaud.AI using a session token that **you** provide.
2. Requests your recordings, transcripts, summaries, and attachments from Plaud's servers.
3. Writes that content as markdown notes and attachment files into the output folder you configure inside your vault.

All processing happens locally, in the Obsidian (Electron) process on your device.

## Data collection

- **No personal data is collected by the maintainer.** There is no maintainer-operated server, account system, or database.
- **No telemetry or analytics.** No usage data, crash reports, or analytics are collected or transmitted.
- **No automatic background activity.** The plugin acts only when you explicitly start an import, scroll the recording list to load more, or download attachments.

## Data storage

- **Imported content** is stored as files inside your vault, on your device, under the output folder you choose. You own and control these files.
- **Plugin settings** are stored by Obsidian in your vault's local `data.json` file.
- **Your Plaud token** is stored via Obsidian's `SecretStorage` API (per-vault, held by your operating system's secret store, not carried by Obsidian Sync). It is never written to `data.json`, never logged, and never transmitted anywhere except to Plaud.AI as an authentication header.
- **Choosing which token to store.** When you sign in through the browser bookmark, it reads the candidate sign-in tokens the Plaud web app has stored in your own browser and hands them to the plugin. The plugin tests each one against Plaud's API and keeps only the first that works; the rest are discarded and never stored. Candidates come from the Plaud web app's own storage on your device and go nowhere except to Plaud.AI.

## Network use

The plugin communicates **only** with:

- **Plaud.AI** (`api.plaud.ai`), to list and fetch your recordings using your token.
- **The content-delivery hosts that Plaud's API points at**, to download attachment files (images, mind-maps, cards) that Plaud hosts.

It contacts no other servers. It does not contact the maintainer. Network requests happen only in response to your explicit actions.

## Your relationship with Plaud.AI

Plaud.AI is an independent third party. This plugin is **not affiliated with, endorsed by, or supported by Plaud.AI**. Your recordings, transcripts, and summaries are your data, held by Plaud under Plaud's own terms and privacy policy. This plugin only retrieves that data on your behalf, using credentials you supply. Your use of Plaud.AI, and your responsibility for that account, are governed by [Plaud's own terms and privacy policy](https://www.plaud.ai/), not by this plugin or its maintainer.

The plugin uses an **undocumented, reverse-engineered** Plaud web API. It may stop working without notice if Plaud changes their service. Using it is your decision and your risk.

## Disclaimer of liability

The plugin is provided free of charge, "AS IS", without warranty of any kind, as set out in the [MIT License](./LICENSE). To the maximum extent permitted by law, the maintainer is not liable for any loss, damage, account issue, data loss, or claim arising from use of the plugin. This includes, without limitation, consequences of changes to Plaud's API, misuse or exposure of your token, and the contents or accuracy of imported notes. This plugin is in early alpha. Test in a non-critical vault first.

## Information you choose to share

If you open a GitHub issue, discussion, or pull request, anything you paste there becomes **public**. The opt-in debug log may contain transcript text, speaker names, and recording metadata (auth headers are redacted automatically, but other content is not). The maintainer does not request sensitive content and is not responsible for information you choose to post. Review and redact your debug logs, screenshots, and generated notes before submitting them. **Never paste your Plaud token into a public issue.** If a maintainer asks for session details, use the **Debug: copy session status to clipboard** command instead: its output contains no token value and no identity claims, and is designed to be safe to paste into a public issue. To report a security vulnerability privately instead, see [SECURITY.md](./SECURITY.md).

## Changes to this policy

This policy may be updated as the plugin evolves. Material changes will be noted in [CHANGELOG.md](./CHANGELOG.md). The "last updated" date above reflects the current version.

## Contact

Questions about this policy: open an issue at [github.com/ckelsoe/obsidian-plaud-importer/issues](https://github.com/ckelsoe/obsidian-plaud-importer/issues). Do not use a public issue for security vulnerabilities; see [SECURITY.md](./SECURITY.md) for the private reporting channel.
