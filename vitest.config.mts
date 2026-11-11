import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// TypeScript first. The production build emits a bundled `main.js` beside
		// `main.ts`, and with the default order a test that imports `../main`
		// silently resolves the BUILT BUNDLE instead of the source. That would make
		// the suite assert against whatever was last built rather than the working
		// tree, which is the same class of false-green that let 0.35.0 ship broken.
		// See issue #90.
		extensions: ['.ts', '.mts', '.mjs', '.js', '.json'],
		// `obsidian` is a peer dep provided at runtime by the Obsidian app; no real
		// module exists to resolve. Tests run against the inert stub instead.
		alias: {
			obsidian: fileURLToPath(
				new URL('./__tests__/__mocks__/obsidian.ts', import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['__tests__/**/*.test.ts'],
		// Installs the globals Obsidian injects at runtime (e.g. `createFragment`).
		// Kept out of the test files themselves so they never touch `globalThis`,
		// which obsidianmd/no-global-this forbids and which is never disabled.
		setupFiles: ['./vitest.setup.js'],
		server: {
			deps: {
				// obsidian-recording-importer-core ships TypeScript source, so it must
				// be transformed like the plugin's own files rather than loaded as an
				// external package. The `obsidian` alias above applies to its imports
				// too.
				inline: ['obsidian-recording-importer-core'],
			},
		},
		// Stryker's instrumented code runs some 20 times slower, so a mutation run
		// (stryker.config.mjs sets the flag) gets a far wider limit.
		testTimeout: process.env.PLAUD_MUTATION_RUN ? 600_000 : 30_000,
	},
});
