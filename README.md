# Plaud Importer

Import meeting summaries, transcripts, and attachments from [Plaud.AI](https://www.plaud.ai/) into your Obsidian vault.

## Status

**v0.1.x - active development build.** The reverse-engineered Plaud client, import modal, transcript/summary note generation, and test-vault deployment workflow are in place. Remaining deferred items are tracked in `dev-docs/deferred-decisions.md` (mainly pagination strategy and optional fetch optimizations).

See [`dev-docs/00-viability-findings.md`](https://github.com/ckelsoe/obsidian-development/blob/main/dev-docs/00-viability-findings.md) in the parent workspace for the design decisions driving this plugin.

## Current behavior (2026-04-15)

Transcript/chapter rendering is now considered complete for this phase: generated notes use a heading-based `Transcript` section (level configurable in settings), include an inline chapter index with jump links into the transcript, render per-chapter `Back to Chapters` links, and place a horizontal rule directly above the transcript area.

## What it does today

- List recent recordings from your Plaud.AI account
- Let you choose which to pull via a modal
- Create one markdown note per recording in a configurable output folder, with frontmatter metadata, Plaud AI-generated summary, and heading-based transcript/chapter navigation
- Handle duplicate recordings per your selected strategy (`skip` or `overwrite`)
- Downstream AI processing (Claude Code, Codex, etc.) can then operate on the imported notes to extract details, link related meetings, and enrich context

## Disclosures

Per Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies):

- **Network use:** This plugin communicates exclusively with Plaud.AI's servers (`web.plaud.ai`) to retrieve your recordings, transcripts, and AI summaries. No data is sent to any other third-party service. Network requests are made only when you explicitly trigger an import action.
- **Account required:** A Plaud.AI account with an active subscription is required for full functionality.
- **Desktop only:** `isDesktopOnly: true`. The current authentication path requires Electron/local-storage APIs that are not available on Obsidian's mobile runtime. This restriction may be lifted if and when Plaud ships its official OAuth API.
- **No telemetry:** This plugin does not collect or transmit usage data, crash reports, or any other telemetry.
- **Minimum Obsidian version:** 1.11.4, required for the `SecretStorage` and `SecretComponent` APIs used to handle your Plaud token securely.

## Configuration

Open **Settings → Community Plugins → Plaud Importer** to configure:

- **Plaud token** — stored via Obsidian's built-in `SecretStorage`, keyed to the current vault. The value is never written to `data.json` and does not travel through Obsidian Sync. If you switch vaults, you will be prompted to re-enter the token.
- **Output folder** — which folder in your vault the imported notes are written to. Defaults to `Plaud`.
- **Duplicate handling** — `Skip` (leave existing notes alone) or `Overwrite` (replace them with fresh content).

## Development

This plugin is part of the [`obsidian-development`](https://github.com/ckelsoe/obsidian-development) workspace and follows Charles's standard Obsidian plugin conventions (strict TypeScript, esbuild, eslint, jest, scripted release process).

```bash
npm install              # install deps
npm run dev              # start watch-mode build
npm run build            # type-check + production build
npm run lint             # eslint
npm test                 # jest
```

### Release

```bash
npm run version          # bump version in manifest.json + versions.json
npm run build            # produce main.js for the release
git add manifest.json versions.json
git commit -m "Bump version to X.Y.Z"
git push
gh release create X.Y.Z main.js manifest.json styles.css
```

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgments

Inspired by the reverse-engineered Plaud clients by [`rsteckler/applaud`](https://github.com/rsteckler/applaud) and [`JamesStuder/Plaud_API`](https://github.com/JamesStuder/Plaud_API), which demonstrated that the required data can be pulled from the Plaud web API today.
