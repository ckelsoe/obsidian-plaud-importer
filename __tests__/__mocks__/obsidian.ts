// Minimal stub of the `obsidian` module for jest. Wired in via
// moduleNameMapper in jest.config.js.
//
// The `obsidian` package is a peer dependency provided at runtime by
// Obsidian itself — at test time there is no real module to resolve, so
// any source file that imports from it would fail in jest without this
// stub. Tests never exercise the stubbed code paths (they only cover the
// pure helpers in import-modal.ts), so these stubs are deliberately
// inert: they satisfy the imports and return empty shapes, nothing more.
//
// Add more stub classes here as new source modules begin importing from
// obsidian. Keep stubs inert — behavioral testing of anything that uses
// Obsidian's runtime belongs in manual smoke-tests inside a real vault,
// not in jest.

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

export class Notice {
	constructor(_message: string) {}
}

export class App {}
