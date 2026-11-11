# Copilot instructions for obsidian-plaud-importer

## What this repository is

Plaud Importer is an [Obsidian](https://obsidian.md) community plugin (TypeScript, esbuild bundle) that imports Plaud.AI recordings into a vault. It writes summaries, transcripts, attachments and optional audio as notes. Plaud has no official API, so the plugin calls Plaud's undocumented web service the way the Plaud website does.

Key architecture facts:

- `isDesktopOnly` is `true`. Sign-in uses an Electron window and `session.fetch`, reached at runtime through `window.require('electron')` in `plaud-login.ts`.
- Shared importer logic comes from the `obsidian-recording-importer-core` dependency, pinned to a git tag. It holds the managed block, note writer, import runner, auto-sync and vault index. Fix shared logic there, not in a local copy.
- `plaud-client-re.ts` and `plaud-client-v4.ts` are the two API clients. `plaud-errors.ts` maps their error classes onto the core's shared error categories.
- `plaud-hosts.ts` exports `isTrustedPlaudHost`, the single allowlist of Plaud hosts.
- `capture-store.ts` stores sign-in and refresh tokens in Obsidian's `SecretStorage`. `session-renewal.ts`, `plaud-refresh-net.ts` and `plaud-refresh-v4.ts` renew them.
- `main.ts` wires the plugin. `settings-tab.ts`, `import-modal.ts` and `attachment-importer.ts` hold the large feature areas.

## Build, lint, test

```bash
npm run build           # tsc type-check + esbuild bundle
npm run lint            # eslint (zero warnings), prettier --check, submission pre-check, icon check, marketplace type-check
npm test                # Vitest
npm run knip            # unused files, exports and dependencies
npm run type-coverage   # fails below 99%
```

`npm run lint`, `npx tsc --noEmit`, `npm test` and `npm run build` must all pass. Prettier owns formatting.

## Hard rules

- Never `eslint-disable` an `obsidianmd/*` rule. Comply instead. Any other allowed disable carries a `-- reason`.
- No `as any`, no non-null assertions (`x!`). Missing types go in `types.d.ts`, not a cast to `Window` or another global.
- No regex lookbehind (`(?<=`, `(?<!`). It is a parse error in older JavaScriptCore builds.
- No bare `moment` imported from `obsidian`. Use `Date` and `Intl`, or `(moment as typeof import('moment'))`.
- No `!important` in `styles.css`, no inline `style` attributes, no `innerHTML`, `outerHTML` or `insertAdjacentHTML`, no `document.createElement`.
- Popout-safe DOM: use `activeDocument`, `activeWindow` or an element's own document, not the global `document` or `window`.
- UI strings in sentence case. No "command" in command ids or names. Settings headings never contain "settings", "options", "general" or the plugin name.
- Every value read from `data.json` is validated before use.
- Writes to an existing note use `vault.process(file, fn)`, never `read` then `modify`.
- `onload` stays light. Defer network and settings-dependent work to `workspace.onLayoutReady`.
- No em dashes in new prose, comments or docs. The README is public: no CI or release internals.

## Plugin-specific pitfalls

- Tokens are account keys. Never write a token to `data.json`, a log, a Notice or an error message. Run error text through `redactJwtLike` from `jwt-redact.ts`.
- Send a bearer token only to a host that passes `isTrustedPlaudHost`. Add a new Plaud host there, never as a second allowlist.
- Plaud answers some auth failures with HTTP 200 and a negative in-band status. Check the in-band status, not only the HTTP code.
- Validate a captured token with a real probe before it is stored. Nothing is written to `SecretStorage` before that.
- The plugin only adds notes inside the user's output folder. It must never edit or delete anything outside it.
- On re-import, only text between the `plaud:managed:start` and `plaud:managed:end` markers is replaced. If markers are missing, duplicated or out of order, skip the note and report it.
- The only write to the Plaud account is a recording title, and only when title write-back is on.
- `__tests__/golden-output.test.ts` locks the exact bytes written to a vault. A snapshot diff is a breaking change for users. Never update it with `-u` during a refactor.
- `scripts/check-icons.mjs` validates hardcoded Lucide icon ids. Use real ids, such as `cassette-tape`.
- Tests: Vitest, `vi.*` not `jest.*`. `obsidian` resolves to `__tests__/__mocks__/obsidian.ts`. Non-null checks in tests use the helpers in `__tests__/helpers/checked.ts`.
