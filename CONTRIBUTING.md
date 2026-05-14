# Contributing

Thanks for the interest in Plaud Importer. This document covers local setup, conventions, and how to submit changes.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- An Obsidian test vault (1.11.4+) for hands-on verification
- A Plaud.AI account if you intend to exercise live import paths

## Local setup

```bash
git clone https://github.com/ckelsoe/obsidian-plaud-importer.git
cd obsidian-plaud-importer
npm install
```

## Development commands

```bash
npm run dev              # watch-mode esbuild
npm run build            # tsc type check + production esbuild
npm run lint             # eslint, zero warnings tolerated
npm test                 # jest
```

## Testing the plugin in Obsidian

1. Run `npm run dev` to start the watch build.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `<your test vault>/.obsidian/plugins/plaud-importer/`.
3. Reload Obsidian, then enable Plaud Importer under Community plugins.

Use a throwaway vault. Do not point the importer at vaults that hold load-bearing notes while iterating.

## Conventions

- **TypeScript strict mode.** No `as any` casts. If types are missing, add them to `types.d.ts`.
- **No `innerHTML`, `outerHTML`, `insertAdjacentHTML`.** Build DOM via `createEl`, `createDiv`, or the explicit DOM API.
- **No hardcoded styles.** Use CSS classes in `styles.css`.
- **No `Vault.modify` on active notes.** Use `Vault.process` for background writes.
- **`onload` stays light.** Only register commands and settings synchronously. Defer network and settings-dependent work via `this.app.workspace.onLayoutReady(...)`.
- **Lint must be clean before push.** CI fails on any warning.

## Pull requests

1. Fork, branch from `main`.
2. Run `npm run lint && npm run build && npm test` locally before pushing.
3. Open a PR with a clear description and reproduction or test notes.
4. CI will run lint, type check, build, tests, and vulnerability scans on push.

Bug fixes that change user-visible behavior need a `CHANGELOG.md` entry under `[Unreleased]`.

## Releases

Releases are maintainer-driven and tag-triggered through GitHub Actions. Contributors do not need to publish releases or attach artifacts manually.

## Reporting issues

Use the GitHub issue tracker at <https://github.com/ckelsoe/obsidian-plaud-importer/issues>. Include Obsidian version, plugin version, OS, repro steps, and a debug log if applicable.
