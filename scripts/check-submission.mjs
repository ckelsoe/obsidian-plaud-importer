// Pre-submission guard for Obsidian's automated marketplace review.
//
// Checks a small set of review rules that the local eslint plugin
// (eslint-plugin-obsidianmd) does NOT cover and that are not in the prose
// developer docs, but ARE enforced by Obsidian's online developer-dashboard
// preview scan. This is a PRE-FILTER, not the authoritative gate: the preview
// scan is the real gate and must be run on the release commit before publishing.
//
// Exits non-zero on any finding so it can chain into `npm run lint` and CI.

import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const findings = [];

// Forbid suppressing any obsidianmd/* lint rule. Obsidian's developer-dashboard
// scan rejects disabling its rules, and local eslint cannot report its own
// suppressions (an `// eslint-disable obsidianmd/...` reads as zero local errors
// but fails the dashboard), so this guard scans source for them and fails the
// build. Comply with the rule (rename, restructure) instead of disabling it.
const CODE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "scripts"]);
// Anchored to a comment opener (// or /*) so prose that merely mentions
// "eslint-disable" is not flagged; eslint only honors directives at a comment's start.
const DISABLE_OBSIDIANMD = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?[^\n]*\bobsidianmd\//;
// Every eslint directive comment must carry a `-- description` (the dashboard
// enforces eslint-comments/require-description, which local eslint does not). A
// directive line is compliant only if it also contains a `--` separator.
const ESLINT_DIRECTIVE = /(?:\/\/|\/\*)\s*eslint-(?:disable|enable)(?:-next-line|-line)?\b/;

function* walkCode(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* walkCode(path);
		} else if (CODE_EXT.test(entry.name) && entry.name !== "main.js") {
			yield path;
		}
	}
}

for (const file of walkCode(".")) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	lines.forEach((line, index) => {
		const where = `${file.replace(/^\.\//, "")}:${index + 1}`;
		if (DISABLE_OBSIDIANMD.test(line)) {
			findings.push(`${where}: do not eslint-disable an obsidianmd/* rule; comply with it (rename or restructure) instead.`);
		}
		if (ESLINT_DIRECTIVE.test(line) && !line.includes("--")) {
			findings.push(`${where}: eslint directive comment needs a "-- description" explaining why it is necessary.`);
		}
	});
}

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

// Obsidian's re-exported `moment`, used without a cast. obsidian.d.ts takes its
// types from the `moment` package, which the developer-dashboard scan does not
// install (it installs production dependencies only), so moment is `any` there
// and the scan reports no-unsafe-call, no-unsafe-member-access and
// no-unsafe-return. Local lint resolves the package, so neither eslint nor
// typecheck:marketplace can see it; this scan does. Either use the built-in
// Date and Intl APIs (toLocaleTimeString or Intl.DateTimeFormat, with
// getLanguage() from obsidian for the app's locale), or go through the cast
// `(moment as typeof import('moment'))`, which pins moment's own type at that
// boundary. Type positions such as `moment.Moment` or `typeof moment` are fine.
// Shipped source only: tests never reach the scan. Caught by the plumbline 0.8.0
// scan.
//
// Parsed and name-resolved with the TypeScript compiler rather than matched
// with patterns, so an aliased or namespace import is followed, strings and
// comments are never mistaken for code, and a local `moment` (a parameter, a
// method) that shadows the import is not reported.
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__)\/|\.test\.[cm]?[jt]sx?$/;
const MOMENT_WHY =
	"moment from obsidian is `any` in the marketplace scan. Use Date and Intl (with getLanguage()), or go through `(moment as typeof import('moment'))`.";

// `... as typeof import('moment')`. Sanctioned only when what it casts is moment
// itself (checked by the caller): casting a call's RESULT leaves the call unsafe.
function isMomentCastType(node) {
	return (
		ts.isAsExpression(node) &&
		ts.isImportTypeNode(node.type) &&
		node.type.isTypeOf === true &&
		ts.isLiteralTypeNode(node.type.argument) &&
		ts.isStringLiteral(node.type.argument.literal) &&
		node.type.argument.literal.text === "moment"
	);
}

for (const file of walkCode(".")) {
	if (TEST_PATH.test(file)) continue;
	const text = readFileSync(file, "utf8");
	if (!text.includes("moment")) continue;
	// One file, nothing resolved: enough for the checker to bind each name to
	// its declaration in this file, which is all the shadowing test needs.
	const program = ts.createProgram([file], {
		allowJs: true,
		noResolve: true,
		noLib: true,
		types: [],
	});
	const source = program.getSourceFile(file);
	if (!source) continue;
	const checker = program.getTypeChecker();
	// The import declarations that bind moment, or bind an `import * as obs`.
	const momentImports = new Set();
	const namespaceImports = new Set();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "obsidian" ||
			!statement.importClause ||
			statement.importClause.isTypeOnly
		) {
			continue;
		}
		const bindings = statement.importClause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			namespaceImports.add(bindings);
		} else if (bindings) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "moment") {
					momentImports.add(element);
				}
			}
		}
	}
	if (momentImports.size === 0 && namespaceImports.size === 0) continue;
	// Whether an identifier refers to one of `declarations`, not to a local
	// that happens to share its name.
	const refersTo = (identifier, declarations) => {
		// `{ moment }` is a property whose VALUE is the variable of that name.
		const symbol =
			ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
				? checker.getShorthandAssignmentValueSymbol(identifier.parent)
				: checker.getSymbolAtLocation(identifier);
		return (symbol?.declarations ?? []).some((declaration) => declarations.has(declaration));
	};
	const isNamespace = (expression) => {
		const inner = ts.skipParentheses(expression);
		return ts.isIdentifier(inner) && refersTo(inner, namespaceImports);
	};
	// An expression that IS Obsidian's moment: the imported name, or `obs.moment`
	// / `obs["moment"]` / `(obs).moment` on a namespace import.
	const isMoment = (node) =>
		(ts.isIdentifier(node) && refersTo(node, momentImports)) ||
		(ts.isPropertyAccessExpression(node) && node.name.text === "moment" && isNamespace(node.expression)) ||
		(ts.isElementAccessExpression(node) &&
			ts.isStringLiteralLike(node.argumentExpression) &&
			node.argumentExpression.text === "moment" &&
			isNamespace(node.expression));
	// `extends moment()` is a runtime expression even though the compiler
	// classes its node as a type; `implements` and interface `extends` are not.
	const isTypeOnly = (node) =>
		ts.isTypeNode(node) &&
		!(
			ts.isExpressionWithTypeArguments(node) &&
			ts.isHeritageClause(node.parent) &&
			node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
			ts.isClassLike(node.parent.parent)
		);
	const report = (node) => {
		const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		findings.push(`${file.replace(/^\.\//, "")}:${line}: ${MOMENT_WHY}`);
	};
	const visit = (node) => {
		// Imports declare the name, casts are the sanctioned use, and a type
		// position is erased before the scan's type checks run.
		if (
			ts.isImportDeclaration(node) ||
			isTypeOnly(node) ||
			(isMomentCastType(node) && isMoment(ts.skipParentheses(node.expression)))
		) {
			return;
		}
		if (isMoment(node)) {
			report(node);
			return;
		}
		// `const { moment } = obs` pulls it out of a namespace import.
		if (
			ts.isBindingElement(node) &&
			ts.isObjectBindingPattern(node.parent) &&
			ts.isVariableDeclaration(node.parent.parent) &&
			node.parent.parent.initializer &&
			isNamespace(node.parent.parent.initializer) &&
			(node.propertyName ?? node.name).getText(source) === "moment"
		) {
			report(node);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
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
