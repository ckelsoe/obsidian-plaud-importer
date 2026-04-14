/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.ts'],
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
