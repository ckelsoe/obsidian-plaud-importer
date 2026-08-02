/**
 * Issue #86, messaging half: a capture whose settings write fails must say so.
 *
 * The settings tab's two capture buttons used to show nothing at all when a
 * capture failed to save: the click handler rejected unhandled, the button
 * re-enabled, and the sign-in looked like it had quietly done nothing. The
 * deep-link handler and the reconnect modal's paste button already caught it.
 * These cover that gap.
 *
 * The mechanism underneath changed with the atomicity half: a settings write
 * the vault rejects is now a "reported" outcome out of `reauthenticate`, which
 * has already named it, rather than a throw. The catch blocks stay for what can
 * still throw past the store's commit point, and the tests below cover both
 * routes plus the rule that binds them: exactly one message, never two that
 * disagree.
 *
 * Built with `Object.create(prototype)` for the same reason the notice-lifecycle
 * suite is: `display()` renders the entire settings tab, and none of it is
 * needed to exercise one button's error path.
 */
import { PlaudImporterSettingsTab } from "../main";
import { Notice, Setting, settingButton } from "./__mocks__/obsidian";

type ReauthOutcome = "captured" | "closed" | "reported";

/** The subset of the settings tab these tests drive. Private members need the cast. */
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

// Shown only for a settings write the vault refused, which reaches these buttons
// as a value now, not a throw. Named here so the tests can assert it is NOT what
// an arbitrary throw produces.
const SAVE_FAILED =
	"Plaud: could not save the sign-in to this vault, so nothing was changed. Check that the vault is writable and has free space, then try again.";
// Shown for anything else that throws out of a capture. It claims neither a
// cause nor that nothing changed, because neither is known at that point.
const UNEXPECTED_FAILURE =
	"Plaud: the sign-in did not finish. Check the status under Plaud token in settings to see whether it was saved, and sign in again if it was not.";

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

/**
 * A throw from somewhere in the capture path that the store does not classify.
 * Deliberately not a vault error: a rejected settings write cannot reach these
 * handlers as a throw any more, so a fixture that looked like one would be
 * testing a route that no longer exists.
 */
function captureThrew(): Error {
	return new Error("unexpected failure inside the capture path");
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
		it("tells the user something went wrong when the capture throws", async () => {
			const tab = makeTab({
				reauthenticate: () => Promise.reject(new Error("login window blew up")),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await expect(
				settingButton(setting, "Sign in").click(),
			).resolves.toBeUndefined();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(UNEXPECTED_FAILURE);
			expect(consoleError).toHaveBeenCalled();
		});

		it("does not blame the vault for a throw that is not a save failure", async () => {
			// Codex caught this in review of the atomicity half. Once a rejected
			// settings write became an outcome rather than a throw, the only things
			// left reaching this catch are other stages, and some of them (anything
			// after the store's commit) throw with the credential already saved.
			// The old notice asserted both a vault cause and that nothing changed,
			// and neither is known here.
			const tab = makeTab({
				reauthenticate: () => Promise.reject(new Error("redraw exploded")),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await settingButton(setting, "Sign in").click();

			expect(Notice.instances[0].message).not.toBe(SAVE_FAILED);
			expect(Notice.instances[0].message).not.toContain("nothing was changed");
		});

		it("re-enables the button after a rejected store", async () => {
			// The failure mode this replaces left the button re-enabled with no
			// message, so re-enabling alone is not the fix; it still has to hold.
			const tab = makeTab({
				reauthenticate: () => Promise.reject(captureThrew()),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);
			const btn = settingButton(setting, "Sign in");

			await btn.click();

			expect(btn.disabled).toBe(false);
		});

		it("does not confuse a rejected store with a sign-in the user closed", async () => {
			// A closed window means something different: nothing was written and
			// nothing is wrong with the vault.
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

		it("says nothing more when the failure has already been reported", async () => {
			// The route a vault write failure now takes: reauthenticate showed the
			// specific reason and returns "reported". Adding "sign-in closed — no
			// token captured" on top would claim the user walked away from a
			// sign-in they actually completed, which is the over-claiming issue #86
			// is about. This case used to be indistinguishable from a closed window.
			const tab = makeTab({
				reauthenticate: () => Promise.resolve<ReauthOutcome>("reported"),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);

			await settingButton(setting, "Sign in").click();

			expect(Notice.instances).toHaveLength(0);
		});

		it("re-enables the button when the failure was already reported", async () => {
			// Same guarantee as the rejected case: whatever the outcome, the button
			// has to come back.
			const tab = makeTab({
				reauthenticate: () => Promise.resolve<ReauthOutcome>("reported"),
			});
			const setting = new Setting();
			tab.renderSigninControl(setting);
			const btn = settingButton(setting, "Sign in");

			await btn.click();

			expect(btn.disabled).toBe(false);
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
		it("tells the user something went wrong when the capture throws", async () => {
			const tab = makeTab({
				pasteTokenFromClipboard: () =>
					Promise.reject(new Error("probe client blew up")),
			});
			const setting = new Setting();
			tab.renderBrowserSignInControl(setting);

			await expect(
				settingButton(setting, "Paste token from clipboard").click(),
			).resolves.toBeUndefined();

			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toBe(UNEXPECTED_FAILURE);
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
