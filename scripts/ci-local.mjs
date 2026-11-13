// Local CI: the full gate, run on this machine before every push (husky
// pre-push, or `npm run ci`). GitHub runs only a short `check` job per PR, the
// release workflow per tag, and a weekly security sweep; everything else runs
// here, so a push reaches GitHub already green.
//
// Each step runs only when this repo has it (a library has no build). The
// security scanners are external tools; if one is missing the run fails with
// the install command rather than skipping silently.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {};
const has = (name) => typeof scripts[name] === "string";
// npm and npx are .cmd launchers on Windows, which Node starts only through a shell.
const win = process.platform === "win32";
const onPath = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore", shell: win }).status === 0;

// zizmor's advisory audit (known-vulnerable-actions) needs a GitHub token; use
// the gh CLI login when there is one, else run offline and say so.
const ghBin = "gh";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (spawnSync(ghBin, ["auth", "token"], { encoding: "utf8", shell: win }).stdout ?? "").trim();
if (token) process.env.GH_TOKEN = token;
else console.warn("No GitHub token (gh auth login): zizmor runs offline and skips the action advisory audit.");

const steps = [
	["Type check", "npx", ["tsc", "--noEmit"]],
	["Lint", "npm", ["run", "lint"], has("lint")],
	["Test", "npm", ["test"], has("test")],
	["Unused files, exports and dependencies", "npm", ["run", "knip"], has("knip")],
	["Type coverage", "npm", ["run", "type-coverage"], has("type-coverage")],
	["Build", "npm", ["run", "build"], has("build")],
	["Marketplace scan rules", "npm", ["run", "scan-rules"], has("scan-rules")],
	["OSV-Scanner", "osv-scanner", ["scan", "source", "--lockfile=package-lock.json"], true, "brew install osv-scanner"],
	["Workflow audit (zizmor)", "uvx", ["zizmor@1.31.1", ...(token ? [] : ["--offline"]), "--quiet", ".github"], existsSync(".github"), "brew install uv"],
];

for (const [name, bin, args, enabled = true, install] of steps) {
	if (!enabled) continue;
	if (install && !onPath(bin)) {
		console.error(`\n✗ ${name}: \`${bin}\` is not installed. Run: ${install}`);
		process.exit(1);
	}
	console.log(`\n▶ ${name}`);
	try {
		execFileSync(bin, args, { stdio: "inherit", shell: win });
	} catch {
		console.error(`\n✗ ${name} failed. Fix it before pushing.`);
		process.exit(1);
	}
}
console.log("\n✓ Local CI passed.");
