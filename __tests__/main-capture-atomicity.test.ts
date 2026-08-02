/**
 * Issue #86, atomicity half: a capture applies completely or not at all.
 *
 * `storeAccessToken` used to write the credential with a synchronous
 * `setSecret` and THEN await the settings save. The save fails for ordinary
 * reasons (read-only vault, full disk, a sync client holding data.json), and
 * when it did the new credential was already durably stored under the same id
 * the old one used while data.json still named the old region and sign-in
 * method. The mismatch survived a restart.
 *
 * Unwinding the secret afterwards is unsafe: the capture surfaces are not
 * serialized, so a rollback can undo whichever capture finished last. The fix
 * makes the settings write the commit point and runs it FIRST, so a failure has
 * nothing to unwind.
 *
 * This suite used to build its subject with
 * `Object.create(PlaudImporterPlugin.prototype)`, because the store was five
 * methods on the plugin class and constructing a real plugin would have dragged
 * in the whole onload. `Object.create` runs no field initializers, so every
 * field the store touched had to be seeded by hand, and a field added later was
 * silently `undefined` rather than a failure. The store now lives in
 * capture-store.ts with a constructor and an explicit host, so the subject
 * below is a real `new CaptureStore(...)` over an ordinary stub.
 */
import { CaptureStore, type CaptureStoreHost } from '../capture-store';
import type { SignInMethod } from '../reconnect-routing';

// Build a minimal unsigned JWT. The capture guard reads unverified claims only,
// so an unsigned token with a dummy signature segment is a faithful fixture.
function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function makeJwt(payload: unknown): string {
	return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

// Passes isUsableUserToken: a client_id and an exp comfortably in the future.
// Deliberately carries NO `iat`, so readTokenLifetime returns a null lifetime
// and the short-session heads-up notice stays out of these tests. What is
// measured here is what got written, not what was said about it.
function usableToken(clientId = 'web'): string {
	return makeJwt({
		sub: 'user-123',
		client_id: clientId,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
	});
}

// Written out rather than imported from the source. These ids address secrets
// that already exist in every user's vault, so a change to either is a breaking
// change; a literal here fails when one moves, an import would follow it.
const CAPTURED_SECRET_ID = 'plaud-importer-token';
const LEGACY_REFRESH_SECRET_ID = 'plaud-importer-refresh-token';

/** Settings shaped like the plugin's, plus one unrelated field to watch. */
interface HarnessSettings {
	secretId: string;
	apiBaseUrl: string;
	signInMethod: SignInMethod;
	/** Unrelated to auth, used to prove a concurrent edit is not reverted. */
	autoSyncEnabled: boolean;
	[key: string]: unknown;
}

/**
 * Stands in for the plugin. It is the object main.ts builds inline, with the
 * plugin state the store mutates hoisted onto it so the assertions can read it
 * back, and with the hooks the tests override left as plain properties.
 */
interface HostStub extends CaptureStoreHost<HarnessSettings> {
	settings: HarnessSettings;
	/** Cleared by a successful store, exactly as on the plugin. */
	sessionRefreshFailed: boolean;
	/** Null when no settings tab is mounted, exactly as on the plugin. */
	settingsRefresh: (() => void) | null;
}

interface Harness {
	store: CaptureStore<HarnessSettings>;
	host: HostStub;
	/** Every mutation in the order it happened, so ordering is assertable. */
	calls: string[];
	secrets: Map<string, string>;
	/** Set to reject the settings write, the failure this suite is about. */
	failSave: Error | null;
	/** Set to make the CAPTURED-id credential write throw, recording nothing. */
	failSecret: Error | null;
	/**
	 * Set to make the LEGACY-id blank throw. A separate switch from failSecret
	 * because the two happen on opposite sides of the commit: the credential
	 * write can still undo a capture, the legacy blank is bookkeeping after one
	 * has already succeeded and must not be able to fail it.
	 */
	failLegacySecret: Error | null;
	/** Runs during the settings write, while the commit is still in flight. */
	duringSave: (() => void) | null;
	/**
	 * How many times the short-lifetime heads-up hook was invoked. Counted
	 * rather than pushed into `calls`, because the real method is advisory and
	 * silent for the iat-less fixtures above: recording it as a mutation would
	 * put an event in the ordering assertions that a real capture of these
	 * tokens never produces.
	 */
	shortLifetimeNotices: number;
}

/** What a vault that will not take the write looks like out of saveData. */
function vaultWriteError(): Error {
	return new Error("EROFS: read-only file system, open 'data.json'");
}

function makeHarness(settings: Partial<HarnessSettings> = {}): Harness {
	const secrets = new Map<string, string>();
	const calls: string[] = [];
	// Seed the credential a previous sign-in left, so "nothing was written" can
	// be checked as "the old value is still there" rather than merely "absent".
	secrets.set(CAPTURED_SECRET_ID, 'previous-token');
	secrets.set(LEGACY_REFRESH_SECRET_ID, 'previous-refresh-token');

	const harness: Harness = {
		// Both filled in below; the host closes over `harness`, so it cannot be
		// built before the object exists.
		store: null as unknown as CaptureStore<HarnessSettings>,
		host: null as unknown as HostStub,
		calls,
		secrets,
		failSave: null,
		failSecret: null,
		failLegacySecret: null,
		duringSave: null,
		shortLifetimeNotices: 0,
	};

	const host: HostStub = {
		settings: {
			secretId: 'some-other-secret',
			apiBaseUrl: 'https://api.plaud.ai',
			signInMethod: 'browser',
			autoSyncEnabled: false,
			...settings,
		},
		sessionRefreshFailed: true,
		settingsRefresh: null,
		getSettings: () => host.settings,
		setSecret: (id: string, secret: string): void => {
			if (id === CAPTURED_SECRET_ID && harness.failSecret !== null) {
				// A backend that refused the write recorded nothing.
				throw harness.failSecret;
			}
			if (
				id === LEGACY_REFRESH_SECRET_ID &&
				harness.failLegacySecret !== null
			) {
				throw harness.failLegacySecret;
			}
			calls.push(`setSecret:${id}`);
			secrets.set(id, secret);
		},
		saveData: async (data: HarnessSettings): Promise<void> => {
			calls.push('saveData');
			harness.duringSave?.();
			// A real settings write is not synchronous. Yielding here is what makes
			// "the credential lands only after the write resolves" a real assertion
			// rather than an artifact of everything running in one tick.
			await Promise.resolve();
			if (harness.failSave !== null) {
				throw harness.failSave;
			}
			calls.push('saveData:ok');
			// Whatever reached disk, so a failed save can be checked as "nothing".
			secrets.set('__data.json__', JSON.stringify(data));
		},
		isDisposed: () => false,
		// Mirrors the plugin's one-liner rather than recording a bare call, so the
		// "does not blank the legacy refresh token" assertions keep measuring a
		// secret value instead of a spy.
		clearStoredRefreshToken: (): void => {
			host.setSecret(LEGACY_REFRESH_SECRET_ID, '');
		},
		clearRefreshFailure: (): void => {
			host.sessionRefreshFailed = false;
		},
		noteShortLifetimeOnCapture: (): void => {
			harness.shortLifetimeNotices += 1;
		},
		reconcileSessionExpiryWarning: (): void => {
			calls.push('reconcileExpiry');
		},
		reconcileSessionRefresh: (): void => {
			calls.push('reconcileRefresh');
		},
		redrawSettings: (): void => host.settingsRefresh?.(),
		probeCandidate: (): Promise<void> => {
			// storeAccessToken never probes; only storeFirstWorkingCandidate does,
			// and this suite does not exercise it. Fail loudly if that changes.
			throw new Error('probeCandidate is not part of this suite');
		},
	};

	harness.host = host;
	harness.store = new CaptureStore<HarnessSettings>(host);
	return harness;
}
describe('storing a capture is all-or-nothing (issue #86)', () => {
	let consoleError: jest.SpyInstance;

	beforeEach(() => {
		// The store logs the cause; keep it out of the test output, and assert it
		// happened so a vault error is not swallowed silently either.
		consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	describe('when the settings write fails', () => {
		it('writes no credential at all', async () => {
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.calls).not.toContain(`setSecret:${CAPTURED_SECRET_ID}`);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe('previous-token');
		});

		it('leaves the in-memory settings describing the previous sign-in', async () => {
			// The tear that survived a restart: a new credential linked while
			// settings still named the old region and method. Neither may move.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.store.storeAccessToken(
				usableToken(),
				'window',
				'https://api-eu.plaud.ai',
			);

			expect(h.host.settings.secretId).toBe('some-other-secret');
			expect(h.host.settings.signInMethod).toBe('browser');
			expect(h.host.settings.apiBaseUrl).toBe('https://api.plaud.ai');
		});

		it('reports the failure as its own outcome, carrying the cause', async () => {
			// Not "unusable": the token was fine, and signing in again cannot fix a
			// full disk. Telling the two apart is the point of the result union.
			const h = makeHarness();
			const cause = vaultWriteError();
			h.failSave = cause;

			const result = await h.store.storeAccessToken(
				usableToken(),
				'window',
			);

			expect(result.outcome).toBe('save-failed');
			expect(result).toHaveProperty('error', cause);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining('could not save the captured sign-in'),
				cause,
			);
		});

		it('does not blank the legacy refresh token', async () => {
			// A capture that never stored must not clear the session it failed to
			// replace, or the routing signal for the surviving sign-in is gone.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe(
				'previous-refresh-token',
			);
		});

		it('does not reconcile the expiry warning or the refresh schedule', async () => {
			// Both derive from the linked credential. Re-deriving them against a
			// capture that did not happen would arm a schedule for a token that is
			// not there.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.calls).not.toContain('reconcileExpiry');
			expect(h.calls).not.toContain('reconcileRefresh');
		});

		it('does not clear a prior refresh failure', async () => {
			// The flag is cleared because "the user just replaced the thing that was
			// failing". They did not; nothing was replaced.
			const h = makeHarness();
			h.failSave = vaultWriteError();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.host.sessionRefreshFailed).toBe(true);
		});

		it('does not redraw the settings tab', async () => {
			const h = makeHarness();
			h.failSave = vaultWriteError();
			h.host.settingsRefresh = () => h.calls.push('settingsRefresh');

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.calls).not.toContain('settingsRefresh');
		});
	});

	describe('when the settings write succeeds', () => {
		it('writes the credential only after the write has landed', async () => {
			// The ordering IS the fix. If setSecret ran first, a later failure would
			// leave the credential behind with nothing describing it.
			const h = makeHarness();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.calls.indexOf('saveData:ok')).toBeLessThan(
				h.calls.indexOf(`setSecret:${CAPTURED_SECRET_ID}`),
			);
		});

		it('links the credential, the method and the region together', async () => {
			const h = makeHarness();
			const token = usableToken();

			const result = await h.store.storeAccessToken(
				token,
				'window',
				'https://api-eu.plaud.ai',
			);

			expect(result).toEqual({ outcome: 'stored' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
			expect(h.host.settings.secretId).toBe(CAPTURED_SECRET_ID);
			expect(h.host.settings.signInMethod).toBe('window');
			expect(h.host.settings.apiBaseUrl).toBe('https://api-eu.plaud.ai');
		});

		it('persists the same pairing it applied in memory', async () => {
			// Disk and memory agreeing is the point; a commit that wrote one shape
			// and applied another would just move the tear.
			const h = makeHarness();

			await h.store.storeAccessToken(
				usableToken(),
				'window',
				'https://api-eu.plaud.ai',
			);

			const onDisk = JSON.parse(
				h.secrets.get('__data.json__') ?? '{}',
			) as Record<string, unknown>;
			expect(onDisk.secretId).toBe(CAPTURED_SECRET_ID);
			expect(onDisk.signInMethod).toBe('window');
			expect(onDisk.apiBaseUrl).toBe('https://api-eu.plaud.ai');
		});

		it('keeps the configured region when the capture found none', async () => {
			const h = makeHarness();

			await h.store.storeAccessToken(usableToken(), 'browser');

			expect(h.host.settings.apiBaseUrl).toBe('https://api.plaud.ai');
		});

		it('does not revert an unrelated setting changed while the write was in flight', async () => {
			// The commit is a snapshot taken before the await, so adopting it
			// wholesale afterwards would silently undo an edit made during the
			// write. Only the fields this capture owns are applied.
			const h = makeHarness();
			h.duringSave = () => {
				h.host.settings.autoSyncEnabled = true;
			};

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.host.settings.autoSyncEnabled).toBe(true);
			expect(h.host.settings.secretId).toBe(CAPTURED_SECRET_ID);
		});

		it('blanks the legacy refresh token and reconciles the session', async () => {
			const h = makeHarness();

			await h.store.storeAccessToken(usableToken(), 'window');

			expect(h.secrets.get(LEGACY_REFRESH_SECRET_ID)).toBe('');
			expect(h.host.sessionRefreshFailed).toBe(false);
			expect(h.calls).toContain('reconcileExpiry');
			expect(h.calls).toContain('reconcileRefresh');
		});

		it('does not fail a stored capture when post-store bookkeeping throws', async () => {
			// The credential and settings are durably linked by the time the
			// reconcilers run. A throw there used to escape as a rejection, which
			// the settings tab renders as a save failure: a stored sign-in
			// reported as a failed one. The calls are also independent, so one
			// failing must not skip the rest: a stored window credential still
			// arms its renewal timer and the tab still redraws.
			const h = makeHarness();
			h.host.reconcileSessionExpiryWarning = (): void => {
				throw new Error('expiry reconcile blew up');
			};
			h.host.settingsRefresh = () => h.calls.push('settingsRefresh');
			const token = usableToken();

			const result = await h.store.storeAccessToken(token, 'window');

			expect(result).toEqual({ outcome: 'stored' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining('after a stored capture failed'),
				expect.any(Error),
			);
			expect(h.calls).toContain('reconcileRefresh');
			expect(h.calls).toContain('settingsRefresh');
		});

		it('does not fail a stored capture when blanking the legacy token throws', async () => {
			// The legacy blank writes a secret, and setSecret is throwable. On the
			// plugin this call was a private method that swallowed its own errors,
			// so it could sit outside the guard; behind the host interface it is an
			// arbitrary callback, and a throwing one would reject a store whose
			// credential is already durably written. The bookkeeping after it must
			// still run: a stored window credential without its renewal timer stops
			// renewing silently.
			const h = makeHarness();
			h.failLegacySecret = new Error('secret backing store unavailable');
			h.host.settingsRefresh = () => h.calls.push('settingsRefresh');
			const token = usableToken();

			const result = await h.store.storeAccessToken(token, 'window');

			expect(result).toEqual({ outcome: 'stored' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
			expect(h.host.settings.secretId).toBe(CAPTURED_SECRET_ID);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'legacy refresh-token blank after a stored capture failed',
				),
				expect.any(Error),
			);
			expect(h.calls).toContain('reconcileExpiry');
			expect(h.calls).toContain('reconcileRefresh');
			expect(h.calls).toContain('settingsRefresh');
		});

		it('does not fail a stored capture when clearing the refresh failure throws', async () => {
			// Same reasoning as the legacy blank. On the plugin this was a bare
			// field assignment that could not throw; through the host it is a
			// callback like any other.
			const h = makeHarness();
			h.host.clearRefreshFailure = (): void => {
				throw new Error('refresh-failure clear blew up');
			};
			const token = usableToken();

			const result = await h.store.storeAccessToken(token, 'window');

			expect(result).toEqual({ outcome: 'stored' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'refresh-failure clear after a stored capture failed',
				),
				expect.any(Error),
			);
			expect(h.calls).toContain('reconcileRefresh');
		});
	});

	describe('when the credential write fails after the commit', () => {
		it('writes the previous settings back and reports a clean save failure', async () => {
			// The settings commit has landed by the time setSecret throws, so a
			// bare return would leave data.json naming a credential that never
			// arrived: the original tear, from the other side. Inside the queue a
			// rollback is safe (no other capture can interleave), so the store
			// puts the old settings back and the failure is a real no-op again.
			const h = makeHarness();
			const cause = new Error('secret backing store unavailable');
			h.failSecret = cause;

			const result = await h.store.storeAccessToken(
				usableToken(),
				'window',
				'https://api-eu.plaud.ai',
			);

			expect(result).toEqual({ outcome: 'save-failed', error: cause });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe('previous-token');
			const onDisk = JSON.parse(
				h.secrets.get('__data.json__') ?? '{}',
			) as Record<string, unknown>;
			expect(onDisk.secretId).toBe('some-other-secret');
			expect(onDisk.signInMethod).toBe('browser');
			expect(onDisk.apiBaseUrl).toBe('https://api.plaud.ai');
			expect(h.host.settings.secretId).toBe('some-other-secret');
			expect(h.calls).not.toContain('reconcileRefresh');
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'could not store the captured credential',
				),
				cause,
			);
		});

		it('reports the tear, not a clean failure, when the restore write fails too', async () => {
			// The one sequence that can still half-apply: commit landed,
			// credential write threw, restore write refused. It must arrive as
			// its own value, because the save-failed notice promises nothing
			// changed and that would be a lie here.
			const h = makeHarness();
			const cause = new Error('secret backing store unavailable');
			h.failSecret = cause;
			// The restore write is the second save this store makes; refuse
			// exactly that one via the harness's own failure switch.
			const restoreFailure = vaultWriteError();
			let saves = 0;
			h.duringSave = () => {
				saves += 1;
				if (saves === 2) {
					h.failSave = restoreFailure;
				}
			};

			const result = await h.store.storeAccessToken(
				usableToken(),
				'window',
			);

			expect(result).toEqual({ outcome: 'torn', error: cause });
			// Disk kept the committed capture; memory and the secret still hold
			// the previous session, which keeps working until the re-sign-in.
			const onDisk = JSON.parse(
				h.secrets.get('__data.json__') ?? '{}',
			) as Record<string, unknown>;
			expect(onDisk.secretId).toBe(CAPTURED_SECRET_ID);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe('previous-token');
			expect(h.host.settings.secretId).toBe('some-other-secret');
			expect(h.calls).not.toContain('reconcileRefresh');
			// BOTH causes have to reach the log. The torn notice tells the user
			// to sign in again and says nothing about why, so the console is the
			// only place the two failures behind it are recorded; losing either
			// leaves the rarest path in the store undiagnosable from a report.
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'could not store the captured credential',
				),
				cause,
			);
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'could not restore settings after the credential write failed',
				),
				restoreFailure,
			);
		});
	});

	describe('when two captures overlap', () => {
		// The reorder puts an await between a caller's decision and its credential
		// write. The old store wrote the secret synchronously before its await, so
		// credentials landed in CALL order however the saves interleaved. Without
		// the queue a store that STARTED earlier could FINISH later and put its
		// older credential back on top of a newer one: a background refresh
		// mid-save when the user pastes a token.

		it('lets the later caller win, not the later write', async () => {
			const h = makeHarness();
			const first = usableToken('first');
			const second = usableToken('second');
			// The first store's write takes longer than the second's, which is what
			// inverts the order when nothing serializes them.
			let releaseFirst: () => void = () => undefined;
			let sawFirst = false;
			const slowFirstSave = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			h.host.saveData = async (): Promise<void> => {
				if (!sawFirst) {
					sawFirst = true;
					h.calls.push('saveData:slow');
					await slowFirstSave;
					h.calls.push('saveData:slow:ok');
					return;
				}
				h.calls.push('saveData:fast');
				await Promise.resolve();
				h.calls.push('saveData:fast:ok');
			};

			const a = h.store.storeAccessToken(first, 'window');
			const b = h.store.storeAccessToken(second, 'browser');
			await Promise.resolve();
			await Promise.resolve();
			releaseFirst();
			await Promise.all([a, b]);

			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(second);
			expect(h.host.settings.signInMethod).toBe('browser');
		});

		it("never runs one store's commit inside another's", async () => {
			// The window this closes: a store between its settings write and its
			// secret write, with a second store landing in between. Asserted as the
			// exact sequence so it pins the whole run.
			const h = makeHarness();

			await Promise.all([
				h.store.storeAccessToken(usableToken('a'), 'window'),
				h.store.storeAccessToken(usableToken('b'), 'browser'),
			]);

			const oneStore = [
				'saveData',
				'saveData:ok',
				`setSecret:${CAPTURED_SECRET_ID}`,
				`setSecret:${LEGACY_REFRESH_SECRET_ID}`,
				'reconcileExpiry',
				'reconcileRefresh',
			];
			expect(h.calls).toEqual([...oneStore, ...oneStore]);
		});

		it("re-asks the caller's ownership guard after waiting its turn", async () => {
			// Ordering says WHEN a store runs, not whether it still should. Every
			// caller guard (a reconnect flow's canStore, the refresh's supersede
			// check) is evaluated before the call, so it is not binding by the time
			// the write happens.
			const h = makeHarness();
			const first = usableToken('first');
			const a = h.store.storeAccessToken(first, 'window');
			// Holds the same guard the background refresh holds: "the credential I
			// measured is still the live one". It passes at call time, because the
			// first store has not reached its setSecret yet.
			const b = h.store.storeAccessToken(
				usableToken('stale'),
				'browser',
				undefined,
				false,
				() => h.secrets.get(CAPTURED_SECRET_ID) === 'previous-token',
			);

			await expect(a).resolves.toEqual({ outcome: 'stored' });
			await expect(b).resolves.toEqual({ outcome: 'superseded' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(first);
			expect(h.host.settings.signInMethod).toBe('window');
		});

		it('writes nothing at all when it finds itself superseded', async () => {
			const h = makeHarness();

			const result = await h.store.storeAccessToken(
				usableToken(),
				'window',
				'https://api-eu.plaud.ai',
				false,
				() => false,
			);

			expect(result).toEqual({ outcome: 'superseded' });
			expect(h.calls).toHaveLength(0);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe('previous-token');
			expect(h.host.settings.secretId).toBe('some-other-secret');
			expect(h.host.settings.apiBaseUrl).toBe('https://api.plaud.ai');
		});

		it('does not strand later captures behind one that threw', async () => {
			// The queue chains on completion, not success. The store's own writes
			// all resolve to outcomes now, so the throw that can still escape is
			// caller-supplied code: the ownership guard. One of those must not
			// reject every capture queued after it.
			const h = makeHarness();
			const survivor = usableToken('survivor');

			const first = h.store.storeAccessToken(
				usableToken('doomed'),
				'window',
				undefined,
				false,
				() => {
					throw new Error('guard blew up');
				},
			);
			const second = h.store.storeAccessToken(survivor, 'browser');

			await expect(first).rejects.toThrow('guard blew up');
			await expect(second).resolves.toEqual({ outcome: 'stored' });
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(survivor);
		});
	});

	describe('when the token fails the capture guard', () => {
		it('reports it as unusable and writes nothing, without touching the vault', async () => {
			// The pre-write guard. It must stay distinguishable from a save failure:
			// this one IS fixed by signing in again.
			const h = makeHarness();

			const result = await h.store.storeAccessToken(
				'not-a-jwt',
				'window',
			);

			expect(result).toEqual({ outcome: 'unusable' });
			expect(h.calls).toHaveLength(0);
			expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe('previous-token');
		});

		it('rejects an expired token before any write', async () => {
			const h = makeHarness();
			const expired = makeJwt({
				client_id: 'web',
				exp: Math.floor(Date.now() / 1000) - 60,
			});

			const result = await h.store.storeAccessToken(expired, 'window');

			expect(result).toEqual({ outcome: 'unusable' });
			expect(h.calls).toHaveLength(0);
		});
	});

	it('accepts a bearer-prefixed token and stores the bare value', async () => {
		// Pre-existing behavior, pinned because the trim now happens ahead of the
		// commit rather than ahead of the secret write.
		const h = makeHarness();
		const token = usableToken();

		const result = await h.store.storeAccessToken(
			`Bearer ${token}`,
			'window',
		);

		expect(result).toEqual({ outcome: 'stored' });
		expect(h.secrets.get(CAPTURED_SECRET_ID)).toBe(token);
	});
});
