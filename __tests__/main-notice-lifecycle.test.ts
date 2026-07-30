/**
 * First tests to reach `main.ts` (issue #90). Everything else in the suite
 * covers extracted pure modules, which is how 0.35.0 shipped broken with the
 * whole suite green.
 *
 * Subject: the auth-pause "Reconnect" prompt lifecycle from issue #88. These
 * assertions were first run by hand against a live Obsidian renderer over CDP;
 * this encodes them so they run in CI instead.
 *
 * The plugin class is built with `Object.create(prototype)` rather than `new`,
 * deliberately: `onload()` opens network clients and timers, none of which is
 * needed to exercise notice lifecycle. Each test assigns only the fields the
 * methods under test actually read.
 *
 * Globals Obsidian injects (`createFragment`) come from jest.setup.js, so
 * nothing here touches globalThis.
 */
import PlaudImporterPlugin from "../main";
import { Notice } from "./__mocks__/obsidian";

/** The subset of the plugin these tests drive. Private members need the cast. */
interface NoticeHost {
	autoSyncState: { paused: boolean; consecutiveTransientFailures: number };
	autoSyncPauseNotice: Notice | null;
	actionNotices: Set<Notice>;
	settings: { autoSyncEnabled: boolean };
	debugLogger: { enabled: boolean };
	autoSyncFirstRunTimeoutId: number | undefined;
	disposed: boolean;
	resumeAutoSyncIfPaused(): void;
	clearAutoSyncPauseNotice(): void;
	showActionNotice(
		message: string,
		actionLabel: string,
		onAction: () => unknown,
	): Notice;
}

function makeHost(overrides: Partial<NoticeHost> = {}): NoticeHost {
	const host = Object.create(PlaudImporterPlugin.prototype) as NoticeHost;
	host.autoSyncState = { paused: true, consecutiveTransientFailures: 0 };
	host.autoSyncPauseNotice = null;
	host.actionNotices = new Set();
	// Off so scheduleFollowUpTick() early-returns before it reaches `window`,
	// which jest's node environment does not provide. Tick scheduling is a
	// separate concern from notice lifecycle and is not what these cover.
	host.settings = { autoSyncEnabled: false };
	host.debugLogger = { enabled: false };
	host.autoSyncFirstRunTimeoutId = undefined;
	host.disposed = false;
	Object.assign(host, overrides);
	return host;
}

/** Post a sticky prompt the way the auto-sync tick's auth branch does. */
function postPausePrompt(host: NoticeHost): Notice {
	const notice = host.showActionNotice(
		"Plaud auto-sync paused: your session expired.",
		"Reconnect",
		() => undefined,
	);
	host.autoSyncPauseNotice = notice;
	return notice;
}

describe("auth-pause prompt lifecycle (issue #88)", () => {
	beforeEach(() => {
		Notice.reset();
	});

	it("posts the prompt as sticky and tracks it for the unload sweep", () => {
		const host = makeHost();
		const notice = postPausePrompt(host);

		// duration 0 means "stay until the user acts". An auth prompt that
		// auto-dismissed would defeat its own purpose.
		expect(notice.duration).toBe(0);
		expect(host.actionNotices.has(notice)).toBe(true);
	});

	it("clears a held prompt and resumes when paused", () => {
		const host = makeHost();
		const notice = postPausePrompt(host);

		host.resumeAutoSyncIfPaused();

		expect(notice.hideCount).toBe(1);
		expect(notice.hidden).toBe(true);
		expect(host.actionNotices.has(notice)).toBe(false);
		expect(host.autoSyncPauseNotice).toBeNull();
		expect(host.autoSyncState.paused).toBe(false);
	});

	it("clears a held prompt even when the pause was already cleared", () => {
		// The regression case, and the reason the teardown sits ABOVE
		// resumeAutoSyncIfPaused's `if (!paused) return` guard: the prompt and the
		// pause state can come apart. Move the teardown below that guard and this
		// test fails, which is a prompt stranded on screen for the whole session.
		const host = makeHost({
			autoSyncState: { paused: false, consecutiveTransientFailures: 0 },
		});
		const notice = postPausePrompt(host);

		host.resumeAutoSyncIfPaused();

		expect(notice.hidden).toBe(true);
		expect(host.actionNotices.has(notice)).toBe(false);
		expect(host.autoSyncPauseNotice).toBeNull();
	});

	it("is a no-op when no prompt is held", () => {
		const host = makeHost();

		expect(() => {
			host.resumeAutoSyncIfPaused();
		}).not.toThrow();
		expect(host.autoSyncState.paused).toBe(false);
		expect(Notice.instances).toHaveLength(0);
	});

	it("does not hide the same prompt twice across repeated resumes", () => {
		const host = makeHost();
		const notice = postPausePrompt(host);

		host.resumeAutoSyncIfPaused();
		host.resumeAutoSyncIfPaused();
		host.resumeAutoSyncIfPaused();

		expect(notice.hideCount).toBe(1);
	});

	it("replaces rather than orphans a prompt when one is already held", () => {
		const host = makeHost();
		const first = postPausePrompt(host);
		// The tick's auth branch clears before posting, so the field stays the
		// single owner of whatever is on screen.
		host.clearAutoSyncPauseNotice();
		const second = postPausePrompt(host);

		expect(first.hidden).toBe(true);
		expect(second.hidden).toBe(false);
		expect(host.actionNotices.has(first)).toBe(false);
		expect(Notice.visible).toEqual([second]);
	});
});
