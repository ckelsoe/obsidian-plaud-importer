// Mutation testing. Not a commit/CI gate (a full run takes minutes); run on
// demand with `npm run test:mutation` to find tests that pass without actually
// asserting behaviour. A high mutation score means the tests would catch a
// regression, not merely that they are green.
export default {
	packageManager: "npm",
	testRunner: "jest",
	jest: {
		projectType: "custom",
		configFile: "jest.config.js",
	},
	mutate: ["**/*.ts", "!**/*.d.ts", "!**/*.test.ts", "!__tests__/**"],
	reporters: ["clear-text", "progress"],
	coverageAnalysis: "perTest",
	ignorePatterns: ["main.js", "dist"],
};
