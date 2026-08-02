/**
 * The capture store: everything that turns a candidate credential into a stored
 * one. Extracted verbatim from main.ts, where it was five methods on the plugin
 * class reachable only through `Object.create(PlaudImporterPlugin.prototype)`.
 *
 * The store reaches its surroundings through CaptureStoreHost and nothing else,
 * so it can be built with `new` in a test. That is the point of the extraction:
 * the atomicity rules below are the plugin's most delicate code and they were
 * the hardest thing in the repo to exercise.
 */
import { Notice } from 'obsidian';
import { isUsableUserToken } from './plaud-token';
import { selectWorkingCandidate } from './token-candidates';
import type { SignInMethod } from './reconnect-routing';

// Stable SecretStorage id for a token captured by the in-app sign-in flow.
// Re-running sign-in overwrites it, mirroring "replace my token".
export const CAPTURED_SECRET_ID = 'plaud-importer-token';

// Deep-link result notices. Held in consts because the strings are shown from
// two code paths (during a browser reconnect and standalone) and must stay
// identical; built as variables so the sentence-case lint, which only inspects
// literals at the call site, accepts the product name mid-sentence.
const DEEP_LINK_SAVED_NOTICE =
	'Plaud token received from your browser and saved.';
const DEEP_LINK_BAD_TOKEN_NOTICE =
	'Plaud sign-in link did not carry a usable token. In your browser, sign in to Plaud before clicking the bookmarklet, then try again.';
// Every candidate the browser sent was rejected by Plaud itself, so the
// browser session is signed out or revoked rather than the link being wrong
// (issue #78: rogerfsh's 300-day token still decodes cleanly but is revoked).
const DEEP_LINK_ALL_REJECTED_NOTICE =
	'Plaud rejected every sign-in token from your browser, so that session looks signed out or revoked. Sign in to Plaud in your browser again, then click the bookmark.';
// One candidate, and Plaud could not be reached to check it. Storing it
// unverified matches the pre-0.35.0 behavior and keeps an offline reconnect
// working; the user finds out from the next import if it was already dead.
const DEEP_LINK_UNVERIFIED_NOTICE =
	'Plaud token received from your browser and saved, but Plaud could not be reached to check it. Run Test connection once you are back online.';
// Shown while several candidates are probed. A const like its siblings so the
// sentence-case lint, which only inspects literals at the call site, accepts
// the product name mid-sentence.
const DEEP_LINK_PROBING_NOTICE = 'Checking which Plaud sign-in still works…';
// A capture that failed while being SAVED, rather than one the token was wrong
// for. Every notice above means the credential was the problem; this one means
// it may well have been fine, so repeating the sign-in is not the fix. The
// wording names the likely cause as something to check rather than as a
// diagnosis: the capture path throws opaquely (a settings write is the common
// source, but not the only one), so asserting "the vault is not writable" would
// be the same over-claiming this notice exists to stop. Telling the two apart
// properly needs the result union tracked in issue #86.
export const CAPTURE_SAVE_FAILED_NOTICE =
	'Plaud: could not save the token. If this keeps happening, check that this vault is writable and has free space.';
// The one failure that cannot promise "nothing changed": the settings commit
// landed, the credential write then threw, and writing the old settings back
// failed too. Signing in again rewrites both halves, so that is the instruction.
const CAPTURE_TORN_NOTICE =
	'Plaud: the sign-in was recorded but its credential could not be stored, so the previous session is still in use. Sign in again to finish reconnecting.';
// Several candidates and no way to ask which one works. Picking blind would
// store the wrong credential (a revoked long-lived token outranks a live short
// one on every claim we can read), so store nothing and let the user retry.
const DEEP_LINK_UNREACHABLE_NOTICE =
	'Could not reach Plaud to check which sign-in token to use, so nothing was saved. Check your connection, then click the bookmark again.';

/**
 * What storing a captured credential did (issue #86). A boolean could not carry
 * the distinction the issue asks for: a credential the plugin REJECTED is fixed
 * by signing in again, and one it never got to WRITE is not. The second used to
 * arrive only as an opaque throw, so no surface could tell them apart.
 *
 * No outcome here means "partly applied and unreported". "torn" exists for the
 * one sequence that can still half-apply (commit landed, credential write
 * threw, restore write failed too), so even that arrives as a value a surface
 * can explain rather than as an opaque rejection.
 */
export type CaptureStoreResult =
	/** Failed the pre-write capture guard. Nothing was written. */
	| { outcome: 'unusable' }
	/**
	 * Something took over the credential while this store waited its turn.
	 * Nothing was written, and nothing should be said: whatever superseded this
	 * is what the user is holding.
	 */
	| { outcome: 'superseded' }
	/**
	 * The settings write rejected (read-only vault, full disk, a sync client
	 * holding the file), or the credential write threw and the settings were
	 * rolled back. Either way nothing is changed. Carries the cause for
	 * logging; surfaces show CAPTURE_SAVE_FAILED_NOTICE rather than the raw
	 * error.
	 */
	| { outcome: 'save-failed'; error: unknown }
	/**
	 * The settings commit landed, the credential write then threw, and writing
	 * the previous settings back failed too. data.json names this capture
	 * while the secret still holds the previous credential; the previous
	 * session keeps working in memory. Signing in again rewrites both sides,
	 * so surfaces show CAPTURE_TORN_NOTICE, which says exactly that. Carries
	 * the credential write's cause.
	 */
	| { outcome: 'torn'; error: unknown }
	| { outcome: 'stored' };

/** The settings fields the store itself reads and writes. */
export interface CaptureSettings {
	secretId: string;
	signInMethod: SignInMethod;
	apiBaseUrl: string;
}

/**
 * Everything the store needs from the plugin around it, named one call at a
 * time rather than as `plugin: PlaudImporterPlugin`. Passing the plugin would
 * have moved the lines and kept the coupling, which is the part worth removing.
 *
 * Generic over the full settings type because the store persists the WHOLE
 * settings object (it spreads it into the commit) while only reading and
 * writing the three fields in CaptureSettings.
 */
export interface CaptureStoreHost<S extends CaptureSettings> {
	/**
	 * The LIVE settings object, re-read on every use. A method rather than a
	 * property because loadSettings REPLACES the object, so a reference taken
	 * once at construction would go stale on the next load. Callers mutate what
	 * this returns; see the note at the end of commitCapturedToken for why the
	 * commit applies its own fields to the live object instead of adopting the
	 * snapshot it took before the await.
	 */
	getSettings(): S;
	/** Throwable, and treated as such: SecretStorage.setSecret returns void. */
	setSecret(id: string, secret: string): void;
	saveData(data: S): Promise<void>;
	/** True once the plugin has unloaded. Nothing may be stored onto it after. */
	isDisposed(): boolean;
	/** Blank the legacy pre-0.32.0 refresh token so it cannot shadow this one. */
	clearStoredRefreshToken(): void;
	/** A fresh credential clears any prior refresh failure. */
	clearRefreshFailure(): void;
	/** One-time short-session heads-up (issue #78). Suppressed for background stores. */
	noteShortLifetimeOnCapture(token: string, signInMethod: SignInMethod): void;
	reconcileSessionExpiryWarning(): void;
	reconcileSessionRefresh(): void;
	/** Redraw the settings tab's status line and secret picker, if it is open. */
	redrawSettings(): void;
	/**
	 * One authenticated round-trip against `baseUrl` using `token`, resolving on
	 * acceptance and rejecting on refusal. A host call rather than a client the
	 * store constructs itself, so the store carries no transport dependency and
	 * its tests need no client mock. `onBaseUrlChanged` reports a region
	 * redirect followed during the probe.
	 */
	probeCandidate(
		token: string,
		baseUrl: string,
		onBaseUrlChanged: (url: string) => void,
	): Promise<void>;
}

export class CaptureStore<S extends CaptureSettings> {
	/**
	 * Tail of the capture queue. Owned by the store now; it used to be a plugin
	 * field that every test had to seed by hand because `Object.create` runs no
	 * field initializers.
	 */
	private captureStoreChain: Promise<unknown> = Promise.resolve();

	constructor(private readonly host: CaptureStoreHost<S>) {}

	// Validates a raw token value (the long-lived user token, optionally bearer-
	// prefixed) and, if valid, stores it in the captured-token secret and links
	// it. Overwrites the same secret each time, so replacing a token never
	// requires creating or deleting a secret. Returns false without changing
	// anything when the value fails the capture guard (payload must carry a
	// client_id and a still-future exp). Shared by the browser deep-link handler
	// and the clipboard-paste button.
	async storeAccessToken(
		rawToken: string,
		// Which surface captured this credential. Reconnect reopens the same one,
		// so the embedded window must record "window" even though it now shares
		// the browser path's probe-and-select machinery.
		signInMethod: SignInMethod = 'browser',
		// The API origin this credential belongs to, when the capture surface
		// discovered one. Applied HERE, in the same mutation batch as the token,
		// rather than by the caller beforehand: a host written ahead of the
		// store outlives a store that then fails, leaving the new region paired
		// with the old credential. A token and the region it is valid for move
		// together or not at all.
		apiBaseUrl?: string,
		// True when this store came from the unattended refresh rather than a
		// user action. Suppresses the capture-time notices: the short-lifetime
		// heads-up is written for someone who just finished signing in, and on
		// the ~22 hour refresh cycle it would pop a 12 second notice saying the
		// plugin will ask them to sign in again, which is both noisy and, for a
		// refresh that just succeeded, wrong. A silent path that announces
		// itself every cycle is not silent.
		background = false,
		// Re-checked immediately before the commit, for callers whose right to
		// store can lapse while they wait: a cancelled reconnect flow, or a
		// background refresh whose credential the user has since replaced. Their
		// own checks run BEFORE this call, and this method now has an await ahead
		// of the credential write, so a check made out there is not binding by the
		// time the write happens. Callers with nothing to go stale keep the
		// default.
		stillOwns: () => boolean = () => true,
	): Promise<CaptureStoreResult> {
		const token = rawToken.trim().replace(/^bearer\s+/i, '');
		if (token.length === 0 || !isUsableUserToken(token)) {
			return { outcome: 'unusable' };
		}
		// Serialized, and ONLY this method is. The old store wrote the secret with
		// a synchronous setSecret before its await, so credentials landed in CALL
		// order however the saves interleaved. Committing settings first puts an
		// await between a caller's decision and its credential write, so without
		// this a store that STARTED earlier could FINISH later and overwrite a
		// newer one: a background refresh mid-save when the user pastes a token.
		// The queue exists to restore the ordering this reorder breaks, nothing
		// more, so it is scoped to captures rather than to settings writes at
		// large.
		return this.serializeCaptureStore(() =>
			this.commitCapturedToken(
				token,
				signInMethod,
				apiBaseUrl,
				background,
				stillOwns,
			),
		);
	}

	/** Runs capture stores one at a time, in the order they were called. */
	private serializeCaptureStore(
		work: () => Promise<CaptureStoreResult>,
	): Promise<CaptureStoreResult> {
		// Both handlers run `work`: a predecessor that failed still had its turn,
		// and a queue that stopped on the first failure would strand every later
		// capture behind it.
		const run = this.captureStoreChain.then(work, work);
		// The chain must never carry a rejection forward, or one throwing store
		// would reject every store queued after it. Successors wait for this one to
		// FINISH, not to succeed; the result still reaches its own caller.
		this.captureStoreChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * The store itself, always run through the queue above. `token` has already
	 * passed the capture guard and been trimmed.
	 */
	private async commitCapturedToken(
		token: string,
		signInMethod: SignInMethod,
		apiBaseUrl: string | undefined,
		background: boolean,
		stillOwns: () => boolean,
	): Promise<CaptureStoreResult> {
		// The queue guarantees order, not relevance. This caller may have waited
		// while a newer capture took over, and its own guard was evaluated before
		// it joined. Re-ask now, with nothing yet written.
		if (!stillOwns()) {
			return { outcome: 'superseded' };
		}
		// THE SETTINGS WRITE IS THE COMMIT POINT, AND IT RUNS FIRST (issue #86).
		//
		// It used to run last, after `setSecret` had already put the credential on
		// disk. `setSecret` is a synchronous void call (obsidian.d.ts: `setSecret(
		// id: string, secret: string): void`), so it persists the moment it is
		// called and there is no promise to fail. The awaited settings save right
		// after it CAN fail, for ordinary reasons: a vault on read-only storage, a
		// full disk, a sync client holding data.json. When it did, the new
		// credential was already durably stored under the same id the old one used
		// while data.json still named the old region and sign-in method, and that
		// mismatch survived a restart.
		//
		// Unwinding the secret afterwards is the obvious fix and it is the wrong
		// one. Three attempts were each faulted correctly, the last because the
		// capture surfaces are not serialized against each other, so an unwind can
		// undo whichever capture finished last: the one the user is holding.
		//
		// Doing the failable write first removes the unwind instead of trying to
		// make one safe. Until `saveData` resolves nothing is mutated: not the
		// secret, not the live settings, not the file. A rejection is a clean
		// no-op, which is what lets CAPTURE_SAVE_FAILED_NOTICE promise nothing
		// changed.
		//
		// KNOWN, ACCEPTED RESIDUAL, and the one thing this reorder makes worse
		// rather than better. Everything below hangs on one fact: the live
		// settings still hold the OLD auth fields until the commit resolves,
		// because they are applied only after it. So during that window:
		//
		// - Clear sign-in or the token picker can run. This method then resumes
		//   and re-links its own credential, undoing a sign-out the user asked
		//   for. The old synchronous store had already written by then, so the
		//   sign-out won.
		// - An ordinary saveSettings() from any settings control writes the stale
		//   auth fields. If it lands after this commit, disk names the old sign-in
		//   while the secret holds the new token, which is this bug's own shape
		//   arriving from the other side.
		//
		// The queue above covers captures against each other and nothing else, on
		// purpose. Closing these two needs every settings write and credential
		// mutation to share one ordering protocol, which is a change to the whole
		// plugin rather than to this method, with a much wider blast radius than
		// the defect being fixed. It belongs in its own issue and its own review.
		//
		// The trade, stated so it can be argued with: both windows are the
		// duration of one file write, both need a competing action inside those
		// few milliseconds, and both are recoverable by repeating the action. What
		// they buy is the removal of a failure that anyone on a read-only or full
		// vault hit every single time, silently, and permanently.
		//
		// Residual, stated plainly: a crash between the commit and `setSecret`
		// leaves data.json naming the new region and method with the previous
		// token. Closing that needs a fresh secret id per capture and a pointer
		// swap; rejected because SecretStorage has no delete (see clearSignIn) and
		// the settings token picker lists every id, so each orphan is permanent
		// and user-visible. A crash window one synchronous step wide, worst case a
		// one-generation-stale credential and a reconnect prompt, against a
		// failure reproducible on any read-only vault whose worst case was silent,
		// restart-surviving corruption. A THROWN credential write is not part of
		// this residual: it is caught below, the settings are written back, and
		// only when even that restore fails does it surface, as a reported
		// `torn` outcome rather than silence. What remains is the hard crash.
		const settings = this.host.getSettings();
		const next: S = {
			...settings,
			secretId: CAPTURED_SECRET_ID,
			// A pasted/deep-linked token came through the browser flow. Record that
			// so Reconnect routes there.
			signInMethod,
		};
		if (apiBaseUrl !== undefined) {
			next.apiBaseUrl = apiBaseUrl;
		}
		try {
			await this.host.saveData(next);
		} catch (err) {
			console.error(
				'Plaud importer: could not save the captured sign-in',
				err,
			);
			return { outcome: 'save-failed', error: err };
		}
		// The credential write CAN THROW: this plugin treats setSecret as
		// throwable everywhere else it writes one (clearSignIn,
		// clearStoredRefreshToken). Left bare here, a backing store that refused
		// the write would recreate the tear this method exists to prevent, from
		// the other side: data.json naming a sign-in whose credential never
		// landed. It runs BEFORE the in-memory fields are applied, so on failure
		// memory still describes the credential that survives.
		try {
			this.host.setSecret(CAPTURED_SECRET_ID, token);
		} catch (err) {
			console.error(
				'Plaud importer: could not store the captured credential',
				err,
			);
			// The commit above already landed, so write the previous settings
			// back. A rollback is safe HERE and nowhere else: this store holds
			// the capture queue, so no other capture can interleave with it,
			// which is exactly what faulted the three pre-#97 rollback attempts.
			// The live settings are untouched at this point and still describe
			// the surviving credential, concurrent non-capture edits included.
			try {
				await this.host.saveData({ ...this.host.getSettings() });
			} catch (restoreErr) {
				console.error(
					'Plaud importer: could not restore settings after the credential write failed',
					restoreErr,
				);
				return { outcome: 'torn', error: err };
			}
			return { outcome: 'save-failed', error: err };
		}
		// Committed. Apply the fields this capture owns to the live settings object
		// rather than swapping in `next` wholesale: `next` was snapshotted before
		// the await, so adopting it would silently revert an unrelated setting the
		// user changed while the write was in flight. Re-read rather than reusing
		// the reference taken above, for the same reason.
		const live = this.host.getSettings();
		live.secretId = next.secretId;
		live.signInMethod = next.signInMethod;
		if (apiBaseUrl !== undefined) {
			live.apiBaseUrl = apiBaseUrl;
		}
		// Blank any legacy WRT from a previous session so it cannot shadow the
		// recorded method. After the commit, like the credential: a capture that
		// never stored must not clear the session it failed to replace.
		this.host.clearStoredRefreshToken();
		// A newly stored credential clears any prior refresh failure: whatever
		// was wrong, the user just replaced the thing that was failing.
		this.host.clearRefreshFailure();
		// Everything below is bookkeeping about a store that has already
		// succeeded. A throw in it must not escape, or the caller reports a
		// save failure for a credential that is durably linked; the redraw
		// guard this generalizes existed for exactly that reason. Each call is
		// guarded ALONE, because they are independent: one failing must not
		// skip the rest, or a stored credential is left without its renewal
		// timer or with a stale settings tab.
		const guarded = (what: string, run: () => void): void => {
			try {
				run();
			} catch (err) {
				console.error(
					`Plaud importer: ${what} after a stored capture failed`,
					err,
				);
			}
		};
		if (!background) {
			guarded('short-lifetime notice', () =>
				this.host.noteShortLifetimeOnCapture(token, signInMethod),
			);
		}
		guarded('expiry-warning reconcile', () =>
			this.host.reconcileSessionExpiryWarning(),
		);
		guarded('session-refresh reconcile', () =>
			this.host.reconcileSessionRefresh(),
		);
		// A deep link can land while the settings tab is open, which is exactly
		// what the one-click bookmark encourages: launch sign-in from settings,
		// click the bookmark, come back. Redraw the status line and secret
		// picker so the tab does not keep saying "not connected yet". Read at
		// call time, so a tab closed during the await above is simply null.
		guarded('settings redraw', () => this.host.redrawSettings());
		return { outcome: 'stored' };
	}

	/**
	 * Renders a store outcome as the {stored, message} pair the capture surfaces
	 * show, so a save failure cannot be reported as a bad token on one path and
	 * correctly on another. `savedNotice` differs per path (a probed capture and
	 * an unverified one say different things), so it is passed in.
	 */
	private describeCaptureOutcome(
		result: CaptureStoreResult,
		savedNotice: string,
	): { stored: boolean; message: string } {
		switch (result.outcome) {
			case 'stored':
				return { stored: true, message: savedNotice };
			case 'save-failed':
				return { stored: false, message: CAPTURE_SAVE_FAILED_NOTICE };
			case 'torn':
				// NOT the save-failed notice: that one promises nothing changed,
				// which is untrue on this path. This one says what did.
				return { stored: false, message: CAPTURE_TORN_NOTICE };
			case 'superseded':
				// The established "say nothing" signal on this path, already used
				// when the plugin unloads or a newer sign-in owns the credential.
				return { stored: false, message: '' };
			case 'unusable':
				return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
	}

	// Probes candidate tokens against Plaud and stores the first one Plaud
	// accepts (issue #78, 0.35.0). Each probe runs on a THROWAWAY client built
	// around a closure returning that one candidate: the real client reads
	// secretStorage, and nothing may be written to storage before it is
	// validated. The probe is a real API call because Plaud answers auth
	// failures with HTTP 200 and a negative in-band status, so only the
	// client's in-band handling can tell acceptance from rejection.
	//
	// Returns the Notice text to show, plus whether a token was stored.
	async storeFirstWorkingCandidate(
		candidates: readonly string[],
		// Re-checked immediately before the store, never only before the probe.
		// Probing is several round-trips, so it reopens the exact window PR #76
		// closed: a delivery whose flow was cancelled while it ran must not
		// overwrite a newer sign-in's token. Callers with no such window keep
		// the default.
		canStore: () => boolean = () => true,
		signInMethod: SignInMethod = 'browser',
		// Region the capture surface already discovered, when it found one. Used
		// to aim the probes and handed on to the store; deliberately NOT written
		// to settings on the way in, so a capture that never stores leaves the
		// configured host untouched.
		discoveredBaseUrl?: string,
	): Promise<{ stored: boolean; message: string }> {
		const probeBaseUrl =
			discoveredBaseUrl ?? this.host.getSettings().apiBaseUrl;
		// The region redirect a probe may follow is captured locally instead of
		// being persisted by the client's own callback: an unvalidated
		// candidate must not rewrite the configured API host. It is handed to
		// the store below only for the candidate that is actually stored. Held
		// on an object so the value written inside the probe closure is read
		// back correctly after the await.
		const detected: { baseUrl: string | null } = { baseUrl: null };
		// Probing several candidates is several round-trips, and the user has
		// just switched from the browser to Obsidian expecting something to
		// happen. Say what is happening rather than sitting silent. Given a
		// finite duration as well as an explicit hide, so an unload mid-probe
		// cannot strand it.
		const progress =
			candidates.length > 1
				? new Notice(DEEP_LINK_PROBING_NOTICE, 15000)
				: null;
		let selection;
		try {
			selection = await selectWorkingCandidate(
				candidates,
				async (candidate) => {
					detected.baseUrl = null;
					await this.host.probeCandidate(
						candidate,
						probeBaseUrl,
						(url) => {
							detected.baseUrl = url;
						},
					);
				},
			);
		} finally {
			progress?.hide();
		}
		// An empty message means "say nothing": the plugin unloaded, or a newer
		// sign-in owns the credential and this delivery is stale.
		// Checked here to skip the store entirely, and handed to the store as well,
		// which re-asks immediately before its commit. This check alone stopped
		// being binding once the store had an await ahead of its credential write.
		const stillOwns = (): boolean => !this.host.isDisposed() && canStore();
		if (!stillOwns()) {
			return { stored: false, message: '' };
		}
		if (selection.outcome === 'none-usable') {
			return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
		if (selection.outcome === 'all-rejected') {
			return { stored: false, message: DEEP_LINK_ALL_REJECTED_NOTICE };
		}
		if (selection.outcome === 'unreachable') {
			// With several candidates the whole point is choosing between them,
			// and no claim distinguishes a revoked token from a live one, so a
			// blind pick would store the wrong credential. With exactly one
			// there is nothing to choose: store it unverified, which is what
			// every release before 0.35.0 did, so an offline reconnect still
			// works.
			if (selection.usable.length !== 1) {
				return { stored: false, message: DEEP_LINK_UNREACHABLE_NOTICE };
			}
			// Unreachable means nothing was proven, so no redirect was observed
			// either; the surface's own discovered region is the best available.
			return this.describeCaptureOutcome(
				await this.storeAccessToken(
					selection.usable[0],
					signInMethod,
					discoveredBaseUrl,
					false,
					stillOwns,
				),
				DEEP_LINK_UNVERIFIED_NOTICE,
			);
		}
		// Selected. A 'selected' outcome always carries a token; fail closed
		// rather than assert it.
		const token = selection.token;
		if (token === null) {
			return { stored: false, message: DEEP_LINK_BAD_TOKEN_NOTICE };
		}
		// Hand the store the regional host this candidate was actually proven
		// against, so the token and its region are written in one batch. A
		// redirect followed during probing outranks the surface's own guess.
		return this.describeCaptureOutcome(
			await this.storeAccessToken(
				token,
				signInMethod,
				detected.baseUrl ?? discoveredBaseUrl,
				false,
				stillOwns,
			),
			DEEP_LINK_SAVED_NOTICE,
		);
	}
}
