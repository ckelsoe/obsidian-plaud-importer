/**
 * Issue #86, atomicity half: a capture applies completely or not at all.
 *
 * `storeAccessToken` used to write the credential with a synchronous
 * `setSecret` and THEN await the settings save. The save can fail for ordinary
 * reasons (read-only vault, full disk, a sync client holding data.json), and
 * when it did the new credential was already durably stored under the same id
 * the old one used while data.json still named the old region and sign-in
 * method. The mismatch survived a restart.
 *
 * Unwinding the secret afterwards is unsafe: the capture surfaces (deep link,
 * clipboard paste, sign-in window) are not serialized, so a rollback can undo
 * whichever capture finished last. The fix instead makes the settings write the
 * commit point and runs it FIRST, so a failure has nothing to unwind.
 *
 * These tests pin that ordering and its consequences from the outside: what was
 * written, in which order, and what a failure left behind.
 *
 * Built with `Object.create(prototype)` like the other main.ts suites: the store
 * is one method and constructing a real plugin would drag in the whole onload.
 */
import PlaudImporterPlugin from "../main";

// Build a minimal unsigned JWT. The capture guard reads unverified claims only,
// so an unsigned token with a dummy signature segment is a faithful fixture.
function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
function makeJwt(payload: unknown): string {
	return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

// Passes isUsableUserToken: a client_id and an exp comfortably in the future.
// Deliberately carries NO `iat`, so readTokenLifetime returns a null lifetime
// and the short-session heads-up notice stays out of these tests. What is being
// measured here is what got written, not what was said about it.
function usableToken(clientId = "web"): string {
	return makeJwt({
		sub: "user-123",
		client_id: clientId,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
	});
}

const CAPTURED_SECRET_ID = "plaud-importer-token";
const LEGACY_REFRESH_SECRET_ID = "plaud-importer-refresh-token";

type StoreOutcome =
	| { outcome: "stored" }
	| { outcome: "unusable" }
	| { outcome: "superseded" }
	| { outcome: "save-failed"; error: unknown };

/** The subset of the plugin the store touches. Private members need the cast. */
interface StoreHost {
	settings: Record<string, unknown>;
	app: { secretStorage: { setSecret(id: string, secret: string): void } };
	saveData(data: unknown): Promise<void>;
	/** Tail of the mutation queue. Seeded by hand: see the note in makeHarness. */
	stateWriteChain: Promise<unknown>;
	/** Bumped by each persisted sign-out. Seeded for the same reason. */
	signOutGeneration: number;
	sessionRefreshFailed: boolean;
	settingsRefresh?: () => void;
	reconcileSessionExpiryWarning(): void;
	reconcileSessionRefresh(): void;
	storeAccessToken(
		rawToken: string,
		signInMethod?: string,
		apiBaseUrl?: string,
		background?: boolean,
		stillOwns?: () => boolean,
	): Promise<StoreOutcome>;
	linkSecret(id: string): Promise<boolean>;
	clearSignIn(): Promise<{ sessionCleared: boolean; settingsSaved: boolean }>;
}

interface Harness {
	plugin: StoreHost;
	/** Every mutation in the order it happened, so ordering is assertable. */
	calls: string[];
	secrets: Map<string, string>;
	/** Set to reject the settings write, the failure this whole suite is about. */
	failSave: Error | null;
	/** Runs during the settings write, while the commit is still in flight. */
	duringSave: (() => void) | null;
}

/** What a vault that will not take the write looks like coming out of saveData. */
function vaultWriteError(): Error {
	return new Error("EROFS: read-only file system, open 'data.json'");
}

function makeHarness(
	settings: Record<string, unknown> = {},
): Harness {
	const plugin = Object.create(
		PlaudImporterPlugin.prototype,
	) as StoreHost;
	const harness: Harness = {
		plugin,
		calls: [],
		secrets: new Map<string, string>(),
		failSave: null,
		duringSave: null,
	};

	// `Object.create` builds the prototype chain but runs no field initializers,
	// so every class field the store reads has to be seeded here. This one is
	// load-bearing rather than cosmetic: the queue chains onto it, and leaving it
	// undefined fails at the first store rather than in some later assertion.
	plugin.stateWriteChain = Promise.resolve();
	plugin.signOutGeneration = 0;
	plugin.settings = {
		secretId: "some-other-secret",
		apiBaseUrl: "https://api.plaud.ai",
		signInMethod: "browser",
		// An unrelated setting, used to prove a concurrent edit is not reverted.
		autoSyncEnabled: false,
		...settings,
	};
	// Seed the credential a previous sign-in left, so "nothing was written" can
	// be checked as "the old value is still there" rather than merely "absent".
	harness.secrets.set(CAPTURED_SECRET_ID, "previous-token");
	harness.secrets.set(LEGACY_REFRESH_SECRET_ID, "previous-refresh-token");

	plugin.app = {
		secretStorage: {
			setSecret: (id: string, secret: string): void => {
				harness.calls.push(`setSecret:${id}`);
				harness.secrets.set(id, secret);
			},
		},
	};
	plugin.saveData = async (data: unknown): Promise<void> => {
		harness.calls.push("saveData");
		harness.duringSave?.();
		// A real settings write is not synchronous. Yielding here is what makes
		// "the credential lands only after the write resolves" a real assertion
		// rather than an artifact of everything running in one tick.
		await Promise.resolve();
		if (harness.failSave !== null) {
			throw harness.failSave;
		}
		harness.calls.push("saveData:ok");
		// Whatever reached disk, so a failed save can be checked as "nothing".
		harness.secrets.set("__data.json__", JSON.stringify(data));
	};
	plugin.sessionRefreshFailed = true;
	plugin.reconcileSessionExpiryWarning = (): void => {
		harness.calls.push("reconcileExpiry");
	};
	plugin.reconcileSessionRefresh = (): void => {
		harness.calls.push("reconcileRefresh");
	};
	return harness;
}

describe("storing a capture is all-or-nothing (issue #86)", () => {
	let consoleError: jest.SpyInstance;

	beforeEach(() => {
		// The store logs the cause; keep it out of the test output, and assert it
		// happened so a vault error is not swallowed silently either.
		consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	describe("when the settings write fails", () => {
		it("writes no credential at all", async () => {
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.calls).not.toContain(`setSecret:${CAPTURED_SECRET_ID}`);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("previous-token");
		});

		it("leaves the in-memory settings describing the previous sign-in", async () => {
			// The tear that survived a restart: a new credential linked while
			// settings still named the old region and method. Neither may move.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.plugin.storeAccessToken(
				usableToken(),
				"window",
				"https://api-eu.plaud.ai",
			);

			expect(h.plugin.settings.secretId).toBe("some-other-secret");
			expect(h.plugin.settings.signInMethod).toBe("browser");
			expect(h.plugin.settings.apiBaseUrl).toBe("https://api.plaud.ai");
		});

		it("reports the failure as its own outcome, carrying the cause", async () => {
			// Not "unusable": the token was fine and signing in again cannot fix a
			// full disk. Telling the two apart is the point of the result union.
			const h = makeHarness();
			const cause = vaultWriteError();
			h.failSave = cause;

			const result = await h.plugin.storeAccessToken(usableToken(), "window");

			expect(result.outcome).toBe("save-failed");
			expect(result).toHaveProperty("error", cause);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("could not save the captured sign-in"),
				cause,
			);
		});

		it("does not blank the legacy refresh token", async () => {
			// A capture that never stored must not clear the session it failed to
			// replace, or the routing signal for the surviving sign-in is gone.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe(
				"previous-refresh-token",
			);
		});

		it("does not reconcile the expiry warning or the refresh schedule", async () => {
			// Both derive from the linked credential. Re-deriving them against a
			// capture that did not happen would arm a schedule for a token that is
			// not there.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.calls).not.toContain("reconcileExpiry");
			expect(h.calls).not.toContain("reconcileRefresh");
		});

		it("does not clear a prior refresh failure", async () => {
			// The flag is cleared because "the user just replaced the thing that was
			// failing". They did not; nothing was replaced.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.plugin.sessionRefreshFailed).toBe(true);
		});

		it("does not redraw the settings tab", async () => {
			const h = makeHarness();
			h.failSave = vaultWriteError();
			h.plugin.settingsRefresh = () => h.calls.push("settingsRefresh");

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.calls).not.toContain("settingsRefresh");
		});
	});

	describe("when the settings write succeeds", () => {
		it("writes the credential only after the write has landed", async () => {
			// The ordering IS the fix. If setSecret ran first, a later failure would
			// leave the credential behind with nothing describing it.
			const h = makeHarness();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.calls.indexOf("saveData:ok")).toBeLessThan(
				h.calls.indexOf(`setSecret:${CAPTURED_SECRET_ID}`),
			);
		});

		it("links the credential, the method and the region together", async () => {
			const h = makeHarness();
			const token = usableToken();

			const result = await h.plugin.storeAccessToken(
				token,
				"window",
				"https://api-eu.plaud.ai",
			);

			expect(result).toEqual({ outcome: "stored" });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
			expect(h.plugin.settings.secretId).toBe(CAPTURED_SECRET_ID);
			expect(h.plugin.settings.signInMethod).toBe("window");
			expect(h.plugin.settings.apiBaseUrl).toBe("https://api-eu.plaud.ai");
		});

		it("persists the same pairing it applied in memory", async () => {
			// Disk and memory agreeing is the whole point; a commit that wrote one
			// shape and applied another would just move the tear.
			const h = makeHarness();

			await h.plugin.storeAccessToken(
				usableToken(),
				"window",
				"https://api-eu.plaud.ai",
			);

			const onDisk = JSON.parse(
				h.secrets.get("__data.json__") ?? "{}",
			) as Record<string, unknown>;
			expect(onDisk.secretId).toBe(CAPTURED_SECRET_ID);
			expect(onDisk.signInMethod).toBe("window");
			expect(onDisk.apiBaseUrl).toBe("https://api-eu.plaud.ai");
		});

		it("keeps the configured region when the capture found none", async () => {
			const h = makeHarness();

			await h.plugin.storeAccessToken(usableToken(), "browser");

			expect(h.plugin.settings.apiBaseUrl).toBe("https://api.plaud.ai");
		});

		it("does not revert an unrelated setting changed while the write was in flight", async () => {
			// The commit is a snapshot taken before the await, so adopting it
			// wholesale afterwards would silently undo an edit made during the
			// write. Only the three fields this capture owns are applied.
			const h = makeHarness();
			h.duringSave = () => {
				h.plugin.settings.autoSyncEnabled = true;
			};

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.plugin.settings.autoSyncEnabled).toBe(true);
			expect(h.plugin.settings.secretId).toBe(CAPTURED_SECRET_ID);
		});

		it("blanks the legacy refresh token and reconciles the session", async () => {
			const h = makeHarness();

			await h.plugin.storeAccessToken(usableToken(), "window");

			expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe("");
			expect(h.plugin.sessionRefreshFailed).toBe(false);
			expect(h.calls).toContain("reconcileExpiry");
			expect(h.calls).toContain("reconcileRefresh");
		});
	});

	describe("when the credential write itself fails", () => {
		// Codex raised this on the third pass. `setSecret` returns void but is
		// documented to throw on an invalid id, and this file already treats it as
		// fallible everywhere else. If it throws AFTER the commit, "do nothing" is
		// no longer available: the settings already describe a credential that was
		// never written. This is the one place a rollback is safe, because the
		// queue means the call owns the credential while it runs.

		it("puts the settings back rather than leaving them describing nothing", async () => {
			const h = makeHarness();
			h.plugin.app = {
				secretStorage: {
					setSecret: (id: string): void => {
						if (id === CAPTURED_SECRET_ID) {
							throw new Error("secret storage is unavailable");
						}
						h.calls.push(`setSecret:${id}`);
					},
				},
			};

			const result = await h.plugin.storeAccessToken(
				usableToken(),
				"window",
				"https://api-eu.plaud.ai",
			);

			expect(result.outcome).toBe("save-failed");
			expect(h.plugin.settings.secretId).toBe("some-other-secret");
			expect(h.plugin.settings.signInMethod).toBe("browser");
			expect(h.plugin.settings.apiBaseUrl).toBe("https://api.plaud.ai");
		});

		it("re-persists the restored settings", async () => {
			// Memory alone is not enough: the commit already put the new pairing on
			// disk, so the restore has to reach disk too.
			const h = makeHarness();
			h.plugin.app = {
				secretStorage: {
					setSecret: (): void => {
						throw new Error("secret storage is unavailable");
					},
				},
			};

			await h.plugin.storeAccessToken(usableToken(), "window");

			const onDisk = JSON.parse(
				h.secrets.get("__data.json__") ?? "{}",
			) as Record<string, unknown>;
			expect(onDisk.secretId).toBe("some-other-secret");
			expect(onDisk.signInMethod).toBe("browser");
		});

		it("keeps memory consistent even when the restoring write also fails", async () => {
			// Both writes gone. Disk cannot be fixed from here, but what the running
			// plugin reads still has to describe one coherent sign-in.
			const h = makeHarness();
			let saves = 0;
			h.plugin.app = {
				secretStorage: {
					setSecret: (): void => {
						throw new Error("secret storage is unavailable");
					},
				},
			};
			// Replaced outright rather than wrapped: the commit succeeds, the
			// restoring write that follows it does not.
			h.plugin.saveData = async (data: unknown): Promise<void> => {
				saves += 1;
				await Promise.resolve();
				if (saves > 1) {
					throw vaultWriteError();
				}
				h.secrets.set("__data.json__", JSON.stringify(data));
			};

			const result = await h.plugin.storeAccessToken(usableToken(), "window");

			expect(result.outcome).toBe("save-failed");
			expect(h.plugin.settings.secretId).toBe("some-other-secret");
			expect(h.plugin.settings.signInMethod).toBe("browser");
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("could not restore settings"),
				expect.anything(),
			);
		});
	});

	describe("when the token fails the capture guard", () => {
		it("reports it as unusable and writes nothing, without touching the vault", async () => {
			// The pre-write guard. It must stay distinguishable from a save failure:
			// this one IS fixed by signing in again.
			const h = makeHarness();

			const result = await h.plugin.storeAccessToken("not-a-jwt", "window");

			expect(result).toEqual({ outcome: "unusable" });
			expect(h.calls).toHaveLength(0);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("previous-token");
		});

		it("rejects an expired token before any write", async () => {
			const h = makeHarness();
			const expired = makeJwt({
				client_id: "web",
				exp: Math.floor(Date.now() / 1000) - 60,
			});

			const result = await h.plugin.storeAccessToken(expired, "window");

			expect(result).toEqual({ outcome: "unusable" });
			expect(h.calls).toHaveLength(0);
		});
	});

	describe("when two captures overlap", () => {
		// Codex raised this reviewing the reorder, and it was a real regression the
		// reorder introduced. The old store wrote the secret synchronously before
		// its await, so credentials landed in CALL order however the saves
		// interleaved. Committing settings first puts an await between a caller's
		// guard and its credential write, so without a queue a store that STARTED
		// earlier could FINISH later and put its older credential back on top of a
		// newer one. The real pairing is a background refresh mid-save when the
		// user pastes a token: no existing guard covers those two.

		it("lets the later caller win, not the later write", async () => {
			const h = makeHarness();
			const first = usableToken("first");
			const second = usableToken("second");
			// The first store's write takes longer than the second's, which is what
			// inverts the order when nothing serializes them.
			// Seeded with a no-op rather than null: the Promise executor runs
			// synchronously, but the compiler cannot know that and narrows a
			// null-initialized binding to `never` at the call below.
			let releaseFirst: () => void = () => undefined;
			let sawFirst = false;
			const slowFirstSave = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			h.plugin.saveData = async (): Promise<void> => {
				if (!sawFirst) {
					sawFirst = true;
					h.calls.push("saveData:slow");
					await slowFirstSave;
					h.calls.push("saveData:slow:ok");
					return;
				}
				h.calls.push("saveData:fast");
				await Promise.resolve();
				h.calls.push("saveData:fast:ok");
			};

			const a = h.plugin.storeAccessToken(first, "window");
			const b = h.plugin.storeAccessToken(second, "browser");
			// Let the second call get as far as it can while the first is blocked.
			await Promise.resolve();
			await Promise.resolve();
			releaseFirst();
			await Promise.all([a, b]);

			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(second);
			expect(h.plugin.settings.signInMethod).toBe("browser");
		});

		it("never runs one store's commit inside another's", async () => {
			// The window this closes: a store between its settings write and its
			// secret write, with a second store landing in between.
			const h = makeHarness();

			await Promise.all([
				h.plugin.storeAccessToken(usableToken("a"), "window"),
				h.plugin.storeAccessToken(usableToken("b"), "browser"),
			]);

			// Asserted as the exact sequence rather than as "no interleaving", so it
			// pins the whole run: two complete stores back to back, each one's
			// commit followed by its own writes before the next one begins.
			const oneStore = [
				"saveData",
				"saveData:ok",
				`setSecret:${CAPTURED_SECRET_ID}`,
				`setSecret:${LEGACY_REFRESH_SECRET_ID}`,
				"reconcileExpiry",
				"reconcileRefresh",
			];
			expect(h.calls).toEqual([...oneStore, ...oneStore]);
		});

		it("re-asks the caller's ownership guard after waiting its turn", async () => {
			// Codex raised this on the second pass, and it is the flip side of the
			// queue: ordering says WHEN a store runs, not whether it still should.
			// Every caller guard (a reconnect flow's canStore, the refresh's
			// supersede check) is evaluated before the call, and a queued store can
			// wait behind another mutation, so a guard checked out there is not
			// binding by the time the write happens.
			const h = makeHarness();
			const first = usableToken("first");
			const a = h.plugin.storeAccessToken(first, "window");
			// Queued behind the first, holding the same guard the background
			// refresh holds: "the credential I measured is still the live one".
			// It passes at call time, because the first store has not reached its
			// `setSecret` yet, and must be re-asked once this one's turn comes.
			const b = h.plugin.storeAccessToken(
				usableToken("stale"),
				"browser",
				undefined,
				false,
				() => h.secrets.get(CAPTURED_SECRET_ID) === "previous-token",
			);

			await expect(a).resolves.toEqual({ outcome: "stored" });
			await expect(b).resolves.toEqual({ outcome: "superseded" });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(first);
			expect(h.plugin.settings.signInMethod).toBe("window");
		});

		it("writes nothing at all when it finds itself superseded", async () => {
			// Superseded has to be as clean a no-op as a failed save: the mutation
			// that took over is the one the user is holding.
			const h = makeHarness();

			const result = await h.plugin.storeAccessToken(
				usableToken(),
				"window",
				"https://api-eu.plaud.ai",
				false,
				() => false,
			);

			expect(result).toEqual({ outcome: "superseded" });
			expect(h.calls).toHaveLength(0);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("previous-token");
			expect(h.plugin.settings.secretId).toBe("some-other-secret");
			expect(h.plugin.settings.apiBaseUrl).toBe("https://api.plaud.ai");
		});

		it("does not strand later captures behind one that threw", async () => {
			// The queue chains on completion, not on success. A store that throws
			// past its commit must not reject every capture queued after it.
			const h = makeHarness();
			h.plugin.reconcileSessionRefresh = (): void => {
				h.plugin.reconcileSessionRefresh = (): void => {
					h.calls.push("reconcileRefresh");
				};
				throw new Error("reconcile blew up");
			};
			const survivor = usableToken("survivor");

			const first = h.plugin.storeAccessToken(usableToken("doomed"), "window");
			const second = h.plugin.storeAccessToken(survivor, "browser");

			await expect(first).rejects.toThrow("reconcile blew up");
			await expect(second).resolves.toEqual({ outcome: "stored" });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(survivor);
		});
	});

	describe("the other two credential mutations", () => {
		// CodeRabbit raised these on the PR: both were routed through the queue but
		// neither reported a refused write, so a failing vault silently left the
		// UI showing a change that never happened. Both now commit before they
		// mutate anything, so a refusal changes nothing and is reportable.

		describe("linking a secret by hand", () => {
			it("applies the choice once the write lands", async () => {
				const h = makeHarness();

				await expect(h.plugin.linkSecret("another-secret")).resolves.toBe(true);

				expect(h.plugin.settings.secretId).toBe("another-secret");
				// Unknown provenance, so the recorded method no longer describes it.
				expect(h.plugin.settings.signInMethod).toBe("");
			});

			it("keeps the recorded method when the captured secret is re-linked", async () => {
				const h = makeHarness({ signInMethod: "window" });

				await h.plugin.linkSecret(CAPTURED_SECRET_ID);

				expect(h.plugin.settings.signInMethod).toBe("window");
			});

			it("leaves the previous secret linked when the vault refuses", async () => {
				const h = makeHarness();
				h.failSave = vaultWriteError();

				await expect(h.plugin.linkSecret("another-secret")).resolves.toBe(
					false,
				);

				expect(h.plugin.settings.secretId).toBe("some-other-secret");
				expect(h.plugin.settings.signInMethod).toBe("browser");
			});
		});

		describe("clearing the sign-in", () => {
			it("blanks the credentials once the sign-out is durable", async () => {
				const h = makeHarness();

				const result = await h.plugin.clearSignIn();

				expect(result.settingsSaved).toBe(true);
				expect(h.plugin.settings.secretId).toBe("");
				expect(h.plugin.settings.signInMethod).toBe("");
				expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("");
				expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe("");
				expect(h.secrets.get("some-other-secret")).toBe("");
			});

			it("destroys nothing when the vault refuses the write", async () => {
				// The ordering that matters: this used to blank the credentials and
				// THEN await the write, so a refusal left the user signed out in
				// practice, still linked on disk, and told it had worked.
				const h = makeHarness();
				h.failSave = vaultWriteError();

				const result = await h.plugin.clearSignIn();

				expect(result.settingsSaved).toBe(false);
				expect(h.plugin.settings.secretId).toBe("some-other-secret");
				expect(h.plugin.settings.signInMethod).toBe("browser");
				expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("previous-token");
				expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe(
					"previous-refresh-token",
				);
			});

			it("does not touch the browser session when the vault refuses", async () => {
				// Codex raised this on the follow-up. Clearing the Electron partition
				// ran FIRST, and it is what a window sign-in renews against, so a
				// sign-out whose write then failed left the old token linked and no
				// longer renewable. "Nothing was changed" has to cover that too.
				//
				// Asserted through the reconciles, which run only on the committed
				// path: a refused sign-out reaches neither them nor the session clear
				// that precedes them.
				const h = makeHarness();
				h.failSave = vaultWriteError();

				await h.plugin.clearSignIn();

				expect(h.calls).not.toContain("reconcileExpiry");
				expect(h.calls).not.toContain("reconcileRefresh");
			});
		});

		it("bumps the sign-out generation only when the sign-out persisted", async () => {
			// Codex raised the case this exists for: Clear sign-in clicked while a
			// capture is still probing (or the user is still in the sign-in window).
			// The capture commits after the sign-out, so queue order alone re-links
			// a session the UI has already reported as cleared. Capture surfaces
			// snapshot this counter when they START and refuse to store if it moved.
			const h = makeHarness();

			h.failSave = vaultWriteError();
			await h.plugin.clearSignIn();
			expect(h.plugin.signOutGeneration).toBe(0);

			h.failSave = null;
			await h.plugin.clearSignIn();
			expect(h.plugin.signOutGeneration).toBe(1);
		});

		it("abandons a capture whose sign-out generation moved", async () => {
			// The guard capture surfaces build from that counter, exercised through
			// the store the same way they use it.
			const h = makeHarness();
			const before = h.plugin.signOutGeneration;
			await h.plugin.clearSignIn();

			const result = await h.plugin.storeAccessToken(
				usableToken(),
				"window",
				undefined,
				false,
				() => h.plugin.signOutGeneration === before,
			);

			expect(result).toEqual({ outcome: "superseded" });
			expect(h.plugin.settings.secretId).toBe("");
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("");
		});

		it("orders a sign-out against a capture by call order", async () => {
			// Both hold the same queue, so the later caller wins. Before the queue a
			// capture already mid-commit could land after the sign-out and quietly
			// restore the session the user had just cleared.
			const h = makeHarness();

			const capture = h.plugin.storeAccessToken(usableToken(), "window");
			const signOut = h.plugin.clearSignIn();
			await Promise.all([capture, signOut]);

			expect(h.plugin.settings.secretId).toBe("");
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe("");
		});
	});

	it("accepts a bearer-prefixed token and stores the bare value", async () => {
		// Pre-existing behavior, pinned here because the trim/strip now happens
		// ahead of the commit rather than ahead of the secret write.
		const h = makeHarness();
		const token = usableToken();

		const result = await h.plugin.storeAccessToken(`Bearer ${token}`, "window");

		expect(result).toEqual({ outcome: "stored" });
		expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
	});
});
