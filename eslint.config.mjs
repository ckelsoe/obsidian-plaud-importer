import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default [
	eslint.configs.recommended,
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				sourceType: "module",
				project: "./tsconfig.json",
			},
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			// The Obsidian `moment` re-export resolves as a real type locally but as
			// `error`/`any` in the marketplace's type-check. note-writer.ts casts it to
			// moment's module type so the marketplace's no-unsafe-* rules pass; that cast
			// is redundant locally, so this rule would otherwise fail our own lint. The
			// cast stays necessary where moment is untyped, so disabling the redundancy
			// check (not the safety checks) is the correct reconciliation.
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
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
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"scripts/**",
			"*.mjs",
			"*.js",
			"*.json",
			"*.md",
			"LICENSE",
			"styles.css",
		],
	},
];
