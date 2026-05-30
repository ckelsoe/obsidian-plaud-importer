// Pre-submission guard for Obsidian's automated marketplace review.
//
// Checks a small set of review rules that the local eslint plugin
// (eslint-plugin-obsidianmd) does NOT cover and that are not in the prose
// developer docs, but ARE enforced by Obsidian's online developer-dashboard
// preview scan. This is a PRE-FILTER, not the authoritative gate: the preview
// scan is the real gate and must be run on the release commit before publishing.
//
// Exits non-zero on any finding so it can chain into `npm run lint` and CI.

import { readFileSync } from "node:fs";

const findings = [];

// The manifest description must not contain the word "Obsidian" (the online
// review rejects it as redundant with the plugin-directory context), must be at
// most 250 characters, and must end with sentence punctuation.
try {
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	const description = typeof manifest.description === "string" ? manifest.description : "";
	if (/\bobsidian\b/i.test(description)) {
		findings.push('manifest.json: the description must not contain the word "Obsidian".');
	}
	if (description.length > 250) {
		findings.push(`manifest.json: the description is ${description.length} characters; the maximum is 250.`);
	}
	if (description && !/[.!?]$/.test(description.trim())) {
		findings.push("manifest.json: the description must end with '.', '!' or '?'.");
	}
} catch (error) {
	findings.push(`manifest.json: could not read or parse (${error.message}).`);
}

// styles.css must not use !important (raise selector specificity instead). Block
// comments are blanked first so a comment that mentions the token is not flagged,
// while line numbers are preserved.
try {
	const css = readFileSync("styles.css", "utf8");
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
	withoutComments.split(/\r?\n/).forEach((line, index) => {
		if (/!important/i.test(line)) {
			findings.push(`styles.css:${index + 1}: avoid !important; raise selector specificity instead.`);
		}
	});
} catch {
	// styles.css is optional; skip if absent.
}

if (findings.length > 0) {
	console.error("Submission pre-check failed:");
	for (const finding of findings) console.error(`  - ${finding}`);
	console.error("");
	console.error("This is a pre-filter only. Run the Obsidian developer-dashboard preview scan");
	console.error("on the release commit for the authoritative result.");
	process.exit(1);
}

console.log("Submission pre-check passed (pre-filter only; the developer-dashboard preview scan is the authoritative gate).");
