// Runs eslint with the eslint-plugin-obsidianmd version the Obsidian
// developer-dashboard scan behaves like, not the one installed for local lint.
//
// Why: on 2026-11-13 the scan failed plaud-importer 0.46.7 on
// obsidianmd/no-unsupported-api. Local obsidianmd 0.5.1 accepts a
// `typeof x.method === "function"` guard; 0.5.0 (the scan's behaviour)
// accepts only `requireApiVersion(...)`. Local lint passed, the scan did not.
// Bump SCAN_VERSION when the scan is seen to follow a newer release.
//
// The scan version is downloaded once into node_modules/.cache and reuses the
// installed plugin's dependencies. Rules the scan version does not have are
// dropped from the config so they do not error as unknown.
//
// Part of `npm run ci` (local CI). Exits non-zero on any finding.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCAN_VERSION = "0.5.0";
const root = process.cwd();
const cache = join(root, "node_modules", ".cache", `obsidianmd-${SCAN_VERSION}`);
const pkg = join(cache, "package");

if (!existsSync(join(pkg, "dist", "lib", "index.js"))) {
	rmSync(cache, { recursive: true, force: true });
	mkdirSync(cache, { recursive: true });
	execFileSync("npm", ["pack", "--silent", `eslint-plugin-obsidianmd@${SCAN_VERSION}`], { cwd: cache, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
	const tgz = readdirSync(cache).find((f) => f.endsWith(".tgz"));
	if (!tgz) throw new Error("npm pack produced no tarball");
	execFileSync("tar", ["-xzf", tgz], { cwd: cache });
	// The installed plugin's own nested dependencies, if it has any.
	const nested = join(root, "node_modules", "eslint-plugin-obsidianmd", "node_modules");
	// "junction" needs no symlink privilege on Windows; other platforms ignore it.
	if (existsSync(nested)) symlinkSync(nested, join(pkg, "node_modules"), "junction");
}

const base = ["eslint.config.mts", "eslint.config.mjs", "eslint.config.js"].find((f) => existsSync(join(root, f)));
if (!base) throw new Error("no eslint.config found");

// Written at the repo root so the base config's file patterns keep their meaning.
const wrapper = join(root, ".eslint-scan.config.mts");
writeFileSync(
	wrapper,
	`import base from "./${base}";
import scan from ${JSON.stringify(resolve(pkg, "dist", "lib", "index.js"))};
const known = new Set(Object.keys(scan.rules).map((r) => "obsidianmd/" + r));
const configs = (await base) as Array<Record<string, any>>;
export default [
	{ ignores: [".eslint-scan.config.mts"] },
	...configs.map((c) => {
		const out = { ...c };
		if (c.plugins?.obsidianmd) out.plugins = { ...c.plugins, obsidianmd: scan };
		if (c.rules) {
			out.rules = Object.fromEntries(
				Object.entries(c.rules).filter(([k]) => !k.startsWith("obsidianmd/") || known.has(k)),
			);
		}
		return out;
	}),
	// The scan also reports require() imports, which obsidianmd's recommended
	// config turns off. Shipped source only; tests may require freely.
	{
		files: ["**/*.ts"],
		ignores: ["__tests__/**", "__mocks__/**", "**/*.test.ts"],
		rules: { "@typescript-eslint/no-require-imports": "warn" },
	},
];
`,
);

try {
	// Relative config path: in Windows shell mode the arguments are joined unquoted.
	execFileSync("npx", ["eslint", "--config", ".eslint-scan.config.mts", "--max-warnings", "0", "."], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
	console.log(`Scan-rule check passed (eslint-plugin-obsidianmd ${SCAN_VERSION}).`);
} catch {
	console.error(`Scan-rule check failed: eslint-plugin-obsidianmd ${SCAN_VERSION}, which the marketplace scan follows, reports the problems above.`);
	process.exitCode = 1;
} finally {
	rmSync(wrapper, { force: true });
}
