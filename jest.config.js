/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.ts'],
	// `.ts` MUST outrank `.js`. The production build emits a bundled `main.js`
	// beside `main.ts`, and with jest's default order (`js` first) a test that
	// imports `../main` silently resolves the BUILT BUNDLE instead of the
	// source. That would make the suite assert against whatever was last built
	// rather than the working tree, which is the same class of false-green that
	// let 0.35.0 ship broken. See issue #90.
	moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'node'],
	// Installs the globals Obsidian injects at runtime (e.g. `createFragment`).
	// Kept out of the test files themselves so they never touch `globalThis`,
	// which obsidianmd/no-global-this forbids and which is never disabled.
	setupFiles: ['<rootDir>/jest.setup.js'],
	// `obsidian` is a peer dep provided at runtime by the Obsidian app —
	// no real module exists for jest to resolve. Map it to an inert stub so
	// source files that import from it can be loaded by the test harness.
	moduleNameMapper: {
		'^obsidian$': '<rootDir>/__tests__/__mocks__/obsidian.ts',
	},
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				// Override ESNext module to CommonJS for Jest compatibility
				module: 'CommonJS',
			},
		}],
	},
};
