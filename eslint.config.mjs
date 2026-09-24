import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import sonarjs from "eslint-plugin-sonarjs";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	eslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
	},
	// Type-aware baseline: recommended + the type-checked family (no-unsafe-*,
	// no-floating-promises, no-misused-promises, await-thenable, no-base-to-string,
	// etc.). The plugin is heavily async and parses untyped Plaud responses;
	// these catch unsafe-any and unhandled-promise bugs.
	...tseslint.configs.recommendedTypeChecked.map((config) => ({
		...config,
		files: ["**/*.ts"],
	})),
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		plugins: { sonarjs },
		rules: {
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			// The marketplace scan runs these type-aware rules. They are errors here
			// so a finding fails local lint instead of lowering the scorecard after
			// release. `npm run typecheck:marketplace` covers the other half: a
			// method missing from the tsconfig lib (the scan installs no @types)
			// turns values into `error`/`any` only in the scan's environment.
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/require-await": "error",
			// eslint-plugin-sonarjs: a curated BUG-detection allowlist, not the
			// full recommended preset (whose style/metric rules are noise at
			// scale). Every rule here flags a genuine logic defect. Two rules are
			// intentionally excluded: no-async-constructor (false-positives on the
			// Obsidian fluent-component pattern) and no-duplicated-branches (a
			// duplication smell that floods on exhaustive dispatch switches).
			"sonarjs/no-all-duplicated-branches": "error",
			"sonarjs/no-identical-conditions": "error",
			"sonarjs/no-identical-expressions": "error",
			"sonarjs/no-identical-functions": "error",
			"sonarjs/no-gratuitous-expressions": "error",
			"sonarjs/no-redundant-assignments": "error",
			"sonarjs/no-redundant-boolean": "error",
			"sonarjs/no-element-overwrite": "error",
			"sonarjs/no-collection-size-mischeck": "error",
			"sonarjs/no-empty-collection": "error",
			"sonarjs/no-unused-collection": "error",
			"sonarjs/no-use-of-empty-return-value": "error",
			"sonarjs/no-ignored-return": "error",
			"sonarjs/different-types-comparison": "error",
			"sonarjs/super-linear-regex": "error",
			"sonarjs/no-inverted-boolean-check": "error",
			"sonarjs/for-loop-increment-sign": "error",
			"sonarjs/duplicates-in-character-class": "error",
			"sonarjs/no-duplicate-in-composite": "error",
		},
	},
	{
		files: ["__tests__/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.jest,
			},
		},
	},
	{
		// __tests__/__mocks__/obsidian.ts IS the stub that stands in for the
		// `obsidian` module under jest, so the restricted-import rule's remedy
		// ("import moment from 'obsidian'") would make it import itself. Scoped
		// off here for the mocks directory only, because the config forbids
		// disabling this rule inline and real test files should keep it.
		files: ["__tests__/__mocks__/**/*.ts"],
		rules: {
			"@typescript-eslint/no-restricted-imports": "off",
		},
	},
	globalIgnores([
		"main.js",
		"node_modules/**",
		".stryker-tmp",
		"reports",
		"scripts/**",
		"*.mjs",
		"*.js",
		"*.json",
		"*.md",
		"LICENSE",
		"styles.css",
	]),
	// Last, so it wins: disables every stylistic rule Prettier now owns.
	prettierConfig,
);
