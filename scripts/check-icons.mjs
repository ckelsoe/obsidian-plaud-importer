// Guard for the hardcoded Lucide icon ids in main.ts.
//
// Obsidian renders icons from the Lucide set; `setIcon` with an id that is not a
// real Lucide icon renders nothing (a blank ribbon icon). The ribbon-icon picker
// offers a hand-curated list of ids, and a wrong one shipped once (issue #34:
// `tape` instead of `cassette-tape`) and stayed latent for months because a unit
// test cannot reach Obsidian's runtime icon registry. This script validates every
// hardcoded id against the offline `lucide-static` package so a bad id fails CI.
//
// Caveat: lucide-static is Lucide's own release, which may differ from the exact
// version Obsidian bundles, so this catches ids that exist in NO Lucide (the
// issue #34 class), not per-version drift. The developer-dashboard preview and
// hands-on testing remain the authoritative checks. Exits non-zero on any finding
// so it chains into `npm run lint` and CI.

import { existsSync, readFileSync } from "node:fs";

const ICONS_DIR = "node_modules/lucide-static/icons";

// Preflight: a clear message beats a raw stack trace or a misleading "unknown
// icon id" report when the real cause is a missing install or a moved file.
if (!existsSync(ICONS_DIR)) {
	console.error(`check-icons: ${ICONS_DIR} not found. Run \`npm install\` (lucide-static is a devDependency).`);
	process.exit(1);
}
let source;
try {
	source = readFileSync("main.ts", "utf8");
} catch (error) {
	console.error(`check-icons: could not read main.ts (${error.message}).`);
	process.exit(1);
}

// Strip comments before extracting ids, so a `];` or a commented-out setIcon call
// inside a comment cannot truncate the array block or add a phantom id. Block
// comments and whole-line `//` comments cover the styles used in main.ts; a `//`
// inside a string (e.g. a URL) is left alone because only full-line comments are
// removed.
const code = source
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "");

const ids = new Map(); // id -> reason (for the error message)
function add(id, reason) {
	if (!ids.has(id)) ids.set(id, reason);
}

// 1. The curated ribbon-icon list: extract ids only from inside the
// RIBBON_ICON_CHOICES array, so command ids and other `id:` keys are not treated
// as icons. The closing `];` is required at the start of a line (the array's real
// close), a second guard against an in-body `];`.
const listMatch = code.match(/RIBBON_ICON_CHOICES[^=]*=\s*\[([\s\S]*?)\n\s*\];/);
if (!listMatch) {
	console.error("check-icons: could not locate the RIBBON_ICON_CHOICES array in main.ts (did its shape change?).");
	process.exit(1);
}
for (const m of listMatch[1].matchAll(/id:\s*["']([a-z0-9-]+)["']/g)) {
	add(m[1], "RIBBON_ICON_CHOICES");
}

// 2. The default ribbon icon.
const defaultMatch = code.match(/DEFAULT_RIBBON_ICON\s*=\s*["']([a-z0-9-]+)["']/);
if (defaultMatch) add(defaultMatch[1], "DEFAULT_RIBBON_ICON");

// 3. Literal ids passed to setIcon(...) (both `el.setIcon("x")` and
// `setIcon(el, "x")`). Calls that pass a variable, template literal, or helper
// result (e.g. resolveRibbonIconId(...)) are skipped: they resolve to a value
// already covered above or coerced to the default at runtime. The convention this
// guard assumes is "curated list + plain quoted literals".
for (const m of code.matchAll(/setIcon\(\s*(?:[^,"'()]+,\s*)?["']([a-z0-9-]+)["']\s*\)/g)) {
	add(m[1], 'setIcon("...")');
}

const missing = [];
for (const [id, reason] of ids) {
	if (!existsSync(`${ICONS_DIR}/${id}.svg`)) {
		missing.push(`  - "${id}" (${reason}) is not a Lucide icon id.`);
	}
}

if (missing.length > 0) {
	console.error("Icon check failed: unknown Lucide icon id(s) in main.ts:");
	for (const line of missing) console.error(line);
	console.error("");
	console.error("Find the correct id at https://lucide.dev/icons and fix it, or remove the entry.");
	console.error("An unknown id makes setIcon render nothing (a blank ribbon icon).");
	process.exit(1);
}

console.log(`Icon check passed: ${ids.size} hardcoded Lucide icon id(s) all valid.`);
