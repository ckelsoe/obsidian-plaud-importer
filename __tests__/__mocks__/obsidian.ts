// Minimal stub of the `obsidian` module for jest. Wired in via
// moduleNameMapper in jest.config.js.
//
// The `obsidian` package is a peer dependency provided at runtime by
// Obsidian itself — at test time there is no real module to resolve, so
// any source file that imports from it would fail in jest without this
// stub. Add more stub classes here as new source modules begin importing
// from obsidian.
//
// Most stubs are inert: they satisfy an import and return empty shapes.
// `Notice` is the deliberate exception. It records its duration and its
// hide() calls so notice lifecycle can be asserted, because that is real
// plugin behavior that used to be checkable only by hand in a live vault.
//
// This header previously said tests "never exercise the stubbed code paths"
// and that behavioral testing of Obsidian runtime code "belongs in manual
// smoke-tests inside a real vault, not in jest." That was wrong, and acting
// on it is how main.ts ended up with no coverage at all while 0.35.0 shipped
// broken with the whole suite green. See issue #90. Prefer making a stub
// observable over declaring the behavior untestable.
//
// Globals Obsidian injects but jest's `node` environment lacks (e.g.
// createFragment) are installed in jest.setup.js, NOT here and not from test
// files, which must not touch globalThis (obsidianmd/no-global-this).

/** Stand-in for an Obsidian DOM element, for the stubs below. */
class ChainableStub {
	empty(): void {}
	addClass(_cls: string): void {}
	removeClass(_cls: string): void {}
	createEl(_tag: string, _opts?: unknown): ChainableStub {
		return new ChainableStub();
	}
	createDiv(_opts?: unknown): ChainableStub {
		return new ChainableStub();
	}
	createSpan(_opts?: unknown): ChainableStub {
		return new ChainableStub();
	}
	addEventListener(_type: string, _listener: unknown): void {}
}

export class Modal {
	app: unknown;
	contentEl: ChainableStub = new ChainableStub();
	modalEl: ChainableStub = new ChainableStub();

	constructor(app: unknown) {
		this.app = app;
	}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

/**
 * Observable Notice stub. The real Notice takes (message, duration) where a
 * duration of 0 means "stay until the user acts", and exposes hide() plus
 * messageEl. Tests assert on `duration` and `hideCount`, so a sticky prompt
 * that never gets taken down is a test failure rather than a live-vault
 * discovery. Call `Notice.reset()` in beforeEach.
 */
export class Notice {
	static instances: Notice[] = [];

	static reset(): void {
		Notice.instances = [];
	}

	/** Notices created and not yet hidden. */
	static get visible(): Notice[] {
		return Notice.instances.filter((n) => !n.hidden);
	}

	message: unknown;
	duration: number | undefined;
	hidden = false;
	hideCount = 0;
	messageEl: ChainableStub = new ChainableStub();

	constructor(message: unknown, duration?: number) {
		this.message = message;
		this.duration = duration;
		Notice.instances.push(this);
	}

	hide(): void {
		this.hidden = true;
		this.hideCount += 1;
	}

	setMessage(message: unknown): this {
		this.message = message;
		return this;
	}
}

export class App {}

/**
 * Base class for the plugin under test. Inert: main.ts's own field initializers
 * are what tests care about, and a test that needs a bare instance without
 * running onload() should use `Object.create(PluginClass.prototype)` and assign
 * only the fields it exercises.
 */
export class Plugin {
	app: unknown;
	manifest: unknown;

	constructor(app?: unknown, manifest?: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	addCommand(_cmd: unknown): unknown {
		return _cmd;
	}
	addSettingTab(_tab: unknown): void {}
	addRibbonIcon(_icon: string, _title: string, _cb: unknown): ChainableStub {
		return new ChainableStub();
	}
	registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}
	registerEvent(_ref: unknown): void {}
	registerInterval(id: number): number {
		return id;
	}
	registerDomEvent(_el: unknown, _type: string, _cb: unknown): void {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
	onload(): void {}
	onunload(): void {}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: ChainableStub = new ChainableStub();

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {}
	hide(): void {}
}

/**
 * Observable button stub, handed to the callbacks `Setting.addButton` and
 * `addExtraButton` take. The real components are chainable and register a click
 * handler; this records the label and keeps the handler callable so a test can
 * fire the click. Without that, everything a settings button DOES is unreachable
 * from jest, which is how the issue #86 silent-failure path went uncovered.
 */
export class ButtonStub {
	label = "";
	cta = false;
	disabled = false;
	icon = "";
	tooltip = "";
	clickCount = 0;
	buttonEl: ChainableStub = new ChainableStub();
	/** Set by onClick(). Await it to drive the handler under test. */
	handler: (evt?: unknown) => unknown = () => undefined;

	setButtonText(text: string): this {
		this.label = text;
		return this;
	}
	setCta(): this {
		this.cta = true;
		return this;
	}
	setWarning(): this {
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	onClick(cb: (evt?: unknown) => unknown): this {
		this.handler = cb;
		return this;
	}
	/** Fire the registered handler the way a real click would. */
	async click(): Promise<void> {
		this.clickCount += 1;
		await this.handler();
	}
}

/**
 * Chainable Setting stub. Every setter and adder returns `this` so builder
 * chains run. The button adders INVOKE their callback with a ButtonStub and
 * collect it on `buttons`, because a callback that is never called cannot be
 * tested; find one with `settingButton(setting, "Sign in")`.
 */
export class Setting {
	settingEl: ChainableStub = new ChainableStub();
	nameEl: ChainableStub = new ChainableStub();
	descEl: ChainableStub = new ChainableStub();
	controlEl: ChainableStub = new ChainableStub();
	/** Every button added to this Setting, in the order they were added. */
	buttons: ButtonStub[] = [];

	constructor(_containerEl?: unknown) {}

	setName(_name: unknown): this {
		return this;
	}
	setDesc(_desc: unknown): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	setClass(_cls: string): this {
		return this;
	}
	setDisabled(_disabled: boolean): this {
		return this;
	}
	addToggle(_cb: unknown): this {
		return this;
	}
	addText(_cb: unknown): this {
		return this;
	}
	addTextArea(_cb: unknown): this {
		return this;
	}
	addDropdown(_cb: unknown): this {
		return this;
	}
	addButton(cb: (btn: ButtonStub) => unknown): this {
		const btn = new ButtonStub();
		this.buttons.push(btn);
		cb(btn);
		return this;
	}
	addExtraButton(cb: (btn: ButtonStub) => unknown): this {
		const btn = new ButtonStub();
		this.buttons.push(btn);
		cb(btn);
		return this;
	}
	addSearch(_cb: unknown): this {
		return this;
	}
	then(_cb: unknown): this {
		return this;
	}
}

/**
 * Find a button on a rendered Setting by its label. Throws rather than
 * returning undefined so a renamed label fails the test loudly instead of
 * quietly asserting nothing.
 */
export function settingButton(setting: Setting, label: string): ButtonStub {
	const found = setting.buttons.find((b) => b.label === label);
	if (found === undefined) {
		const seen = setting.buttons.map((b) => b.label).join(", ");
		throw new Error(`No button labeled "${label}". Present: ${seen || "none"}`);
	}
	return found;
}

export class SecretComponent {
	constructor(_containerEl?: unknown) {}

	setValue(_value: string): this {
		return this;
	}
	getValue(): string {
		return "";
	}
	onChange(_cb: unknown): this {
		return this;
	}
	setPlaceholder(_text: string): this {
		return this;
	}
}

export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
}

/** Network stub. Tests that need a response should jest.mock this per suite. */
export function requestUrl(_options: unknown): never {
	throw new Error(
		"requestUrl is not stubbed for this test. Mock it in the suite that needs it.",
	);
}

export function setIcon(_el: unknown, _icon: string): void {}

// Re-export the REAL moment. At runtime the plugin gets moment from Obsidian's
// externalized bundle (`import { moment } from 'obsidian'`); at test time there
// is no real obsidian module, so the pure date formatters would have no moment
// to call. moment@2.29.4 is already in node_modules (transitive via obsidian),
// so this needs no new install and keeps the formatters unit-testable. moment
// ships as an `export =` module, so a namespace import (not a default import)
// is what type-checks without esModuleInterop.
// The restricted-import rule's remedy is "import moment from 'obsidian'", which
// this file cannot do: it IS the 'obsidian' stub, so it would import itself.
// Scoped off for __mocks__ in the eslint config rather than disabled inline,
// because the config forbids inline disables of that rule.
import * as moment from "moment";
export { moment };
