/**
 * Issue #86, messaging half: a capture whose settings write fails must say so.
 *
 * Storing a captured sign-in writes the credential into secret storage and then
 * awaits a settings save. That save can reject for ordinary reasons (read-only
 * vault, full disk, a sync client holding the file), and the rejection is the
 * ONLY way a save failure can surface: `storeAccessToken`'s single `return
 * false` is the pre-write validation guard, so a save failure never comes back
 * as a boolean.
 *
 * The deep-link handler and the reconnect modal's paste button already catch it.
 * The settings tab's two buttons did not, so the click handler rejected
 * unhandled, the button re-enabled, and the user was shown nothing at all. These
 * cover that gap.
 *
 * Built with `Object.create(prototype)` for the same reason the notice-lifecycle
 * suite is: `display()` renders the entire settings tab, and none of it is
 * needed to exercise one button's error path.
 */
import { PlaudImporterSettingsTab } from "../main";
import { Notice, Setting, settingButton } from "./__mocks__/obsidian";

/** The subset of the settings tab these tests drive. Private members need the cast. */
type ReauthOutcome = "captured" | "closed" | "reported";

interface SigninHost {
	plugin: {
		reauthenticate(): Promise<ReauthOutcome>;
		pasteTokenFromClipboard(): Promise<boolean>;
	};
	signinRefresh?: () => void;
	tokenRefresh?: () => void;
	renderSigninControl(setting: Setting): void;
	renderBrowserSignInControl(setting: Setting): void;
}

const SAVE_FAILED =
	"Plaud: could not save the token. If this keeps happening, check that this vault is writable and has free space.";

function makeTab(plugin: Partial<SigninHost["plugin"]> = {}): SigninHost {
	const tab = Object.create(PlaudImporterSettingsTab.prototype) as SigninHost;
	tab.plugin = {
		reauthenticate: () => Promise.resolve<ReauthOutcome>("captured"),
		pasteTokenFromClipboard: () => Promise.resolve(true),
		...plugin,
	};
	tab.signinRefresh = () => undefined;
	tab.tokenRefresh = () => undefined;
	return tab;
}

/** What a rejected settings save looks like coming out of the store. */
function vaultWriteError(): Error {
	return new Error("EROFS: read-only file system, open 'data.json'");
}

describe("settings tab reports a capture that failed to save (issue #86)", () => {
	let consoleError: jest.SpyInstance;

	beforeEach(() => {
		Notice.reset();
		// The handlers log the cause; keep it out of the test output, and assert
		// it happened so the error is not swallowed silently either.
		consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	describe('the "Sign in" button', () => {
		it("tells the user the vault could not be written when the store rejects", async () => {
			const tab = makeTab({
				reauthenticate: () => Promise.reject(vaultWriteError()),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await expect(
				settingButton(setting, "Sign in").click(),
			).resolves.toBeUndefined();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(SAVE_FAILED);
			expect(consoleError).toHaveBeenCalled();
		});

		it("re-enables the button after a rejected store", async () => {
			// The failure mode this replaces left the button re-enabled with no
			// message, so re-enabling alone is not the fix; it still has to hold.
			const tab = makeTab({
				reauthenticate: () => Promise.reject(vaultWriteError()),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);
			const btn = settingButton(setting, "Sign in");

			await btn.click();

			expect(btn.disabled).toBe(false);
		});

		it("does not confuse a rejected store with a sign-in the user closed", async () => {
			// A closed window resolves false and means something different: nothing
			// was written and nothing is wrong with the vault.
			const tab = makeTab({
				reauthenticate: () => Promise.resolve<ReauthOutcome>("closed"),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await settingButton(setting, "Sign in").click();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).not.toBe(SAVE_FAILED);
			expect(consoleError).not.toHaveBeenCalled();
		});

		it("still reports success normally", async () => {
			const tab = makeTab();
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await settingButton(setting, "Sign in").click();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(
				"Plaud token captured and saved.",
			);
		});

		it("says nothing more when the failure has already been reported", async () => {
			// The route a refused settings write now takes. Turning that failure
			// from a throw into a value moved it out of the catch above and into
			// the ordinary "did not store" branch, which used to answer with the
			// button's own closed-sign-in wording on top of the real reason. That
			// claims the user walked away from a sign-in they completed, which is
			// the over-claiming issue #86 exists to stop.
			const tab = makeTab({
				reauthenticate: () => Promise.resolve<ReauthOutcome>("reported"),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await settingButton(setting, "Sign in").click();

			expect(Notice.instances).toHaveLength(0);
		});

		it("does not blame the save when a post-success redraw throws", async () => {
			// Codex caught this in review of the first cut of this fix. That version
			// wrapped the success branch too, so a redraw failing AFTER the token was
			// safely stored produced the success notice followed by a save-failure
			// notice flatly contradicting it, on a capture that worked. The catch is
			// scoped to the capture call alone so the two cannot be confused.
			const tab = makeTab();
			tab.signinRefresh = () => {
				throw new Error("settings redraw failed");
			};
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await expect(
				settingButton(setting, "Sign in").click(),
			).rejects.toThrow("settings redraw failed");

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(
				"Plaud token captured and saved.",
			);
		});
	});

	describe('the "Paste token from clipboard" button', () => {
		it("tells the user the vault could not be written when the store rejects", async () => {
			const tab = makeTab({
				pasteTokenFromClipboard: () => Promise.reject(vaultWriteError()),
			});
			const setting = new Setting();
			tab.renderBrowserSignInControl(setting);

			await expect(
				settingButton(setting, "Paste token from clipboard").click(),
			).resolves.toBeUndefined();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(SAVE_FAILED);
			expect(consoleError).toHaveBeenCalled();
		});

		it("stays silent when the paste itself failed and already spoke", async () => {
			// pasteTokenFromClipboard handles a clipboard read failure itself and
			// shows its own guidance, returning false. Adding a second notice here
			// would contradict it.
			const tab = makeTab({
				pasteTokenFromClipboard: () => Promise.resolve(false),
			});
			const setting = new Setting();
			tab.renderBrowserSignInControl(setting);

			await settingButton(setting, "Paste token from clipboard").click();

			expect(Notice.instances).toHaveLength(0);
		});

		it("still reports success normally", async () => {
			const tab = makeTab();
			const setting = new Setting();
			tab.renderBrowserSignInControl(setting);

			await settingButton(setting, "Paste token from clipboard").click();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(
				"Token saved. Run a connection test to confirm it works.",
			);
		});

		it("does not blame the save when a post-success redraw throws", async () => {
			const tab = makeTab();
			tab.tokenRefresh = () => {
				throw new Error("settings redraw failed");
			};
			const setting = new Setting();
			tab.renderBrowserSignInControl(setting);

			await expect(
				settingButton(setting, "Paste token from clipboard").click(),
			).rejects.toThrow("settings redraw failed");

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(
				"Token saved. Run a connection test to confirm it works.",
			);
		});
	});
});
