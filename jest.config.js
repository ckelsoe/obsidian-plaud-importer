/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.ts'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				// Override ESNext module to CommonJS for Jest compatibility
				module: 'CommonJS',
			},
		}],
	},
};
