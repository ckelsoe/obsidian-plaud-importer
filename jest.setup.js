// Harness bootstrap for globals that Obsidian injects at runtime but jest's
// `node` testEnvironment does not provide. Obsidian's typings already declare
// `createFragment` globally, so source files call it without importing it; under
// jest it simply would not exist.
//
// This lives in a `.js` harness file beside jest.config.js on purpose. Test
// files themselves must not poke at `globalThis` (obsidianmd/no-global-this,
// which is never disabled), and harness bootstrapping is the same category of
// file as the jest config it sits next to.

/** Minimal stand-in for an Obsidian DOM element. Chainable, inert. */
function makeElementStub() {
	return {
		empty() {},
		addClass() {},
		removeClass() {},
		setText() {},
		createEl: () => makeElementStub(),
		createDiv: () => makeElementStub(),
		createSpan: () => makeElementStub(),
		addEventListener() {},
		removeEventListener() {},
	};
}

global.createFragment = () => makeElementStub();
