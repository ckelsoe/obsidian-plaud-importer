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

// Plugin code runs in Obsidian's renderer, so it reaches for `window`: timers
// (`window.setTimeout`) and Electron's bridge (`window.require`). jest's `node`
// environment provides neither. Timers delegate to node's own so behavior is
// faithful rather than inert; `require` is deliberately ABSENT, because that is
// what a build without the remote module looks like and several call sites are
// specified to return "unavailable" in exactly that case. A test that wants
// Electron installs its own `window.require` and removes it afterwards.
global.window = global.window || {
	setTimeout: (...args) => setTimeout(...args),
	clearTimeout: (...args) => clearTimeout(...args),
	setInterval: (...args) => setInterval(...args),
	clearInterval: (...args) => clearInterval(...args),
};
