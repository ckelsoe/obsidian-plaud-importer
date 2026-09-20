/**
 * Unattended session renewal and the pre-expiry warning: the two timers that
 * keep a Plaud session alive without the user thinking about it, plus the
 * notices shown when they cannot.
 *
 * Extracted from main.ts, where these six pieces of timer state were mixed in
 * with the plugin's other twenty-odd fields and nothing stopped an unrelated
 * method from reaching into them. They are now owned by one object with one
 * teardown, which is what the discipline in these methods always assumed.
 *
 * The comments are the record of issues #78 (short sessions and the warning),
 * #86 (why a capture notice takes its sign-in method as a parameter) and #87
 * (the per-vault partition). Read them before changing the ordering rules.
 */
import { Notice } from 'obsidian';
import {
	isUsableUserToken,
	isWorkspaceToken,
	readTokenLifetime,
	workspaceIdFromToken,
	SHORT_LIFETIME_HOURS,
} from './plaud-token';
import { plaudPartition } from './plaud-partition';
import { sessionExpiryDecision } from './session-expiry';
import { computeRefreshDelayMs, isRefreshDue } from './refresh-schedule';
import {
	buildPartitionPost,
	extractWorkspaceId,
	performNetRefresh,
} from './plaud-refresh-net';
import { performV4Refresh } from './plaud-refresh-v4';
import { selectRefreshTokenForWorkspace } from './token-candidates';
import type { PlaudHttpFetcher } from './plaud-client-re';
import type { CaptureStoreResult } from './capture-store';
import type { PlaudImporterSettings } from './settings-types';
import type { SignInMethod } from './reconnect-routing';
import { ssoReconnectHint } from './reconnect-routing';

/** What one renewal attempt did. Reported by the debug command verbatim. */
export type RefreshOutcome =
	'refreshed' | 'unsupported' | 'failed' | 'busy' | 'superseded';

/** A log entry shaped the way BufferedDebugLogger takes one. */
interface DebugEntry {
	kind: 'note' | 'error';
	endpoint: string;
	message: string;
	payload?: unknown;
}

/**
 * What renewal needs from the plugin around it, one member at a time. The list
 * is long because renewal genuinely has that many collaborators: it reads the
 * credential, writes settings, posts notices, defers to an open sign-in, and
 * hands a freshly minted token to the capture store. Naming them is the point,
 * though. Before this, every one of them was an unannounced reach into the
 * plugin, and the ordering rules below depended on all of them silently.
 */
export interface SessionRenewalHost {
	/** Live settings; re-read on every use because loadSettings replaces it. */
	getSettings(): PlaudImporterSettings;
	/** True once the plugin has unloaded. Nothing may be written after. */
	isDisposed(): boolean;
	/** This vault's Obsidian app id, the input to the sign-in partition. */
	getAppId(): unknown;
	readStoredTokenValue(): string;
	/**
	 * The stored v4 workspace refresh token (CAPTURED_REFRESH_SECRET_ID), or ''
	 * when none is stored. The bearer the cookieless v4 refresh (browser session)
	 * uses; empty for a v3 or a pre-beta.3 session, which is what gates that path.
	 */
	readStoredRefreshTokenValue(): string;
	/** HTTP transport for the cookieless v4 refresh (the plugin's requestUrl adapter). */
	httpFetch: PlaudHttpFetcher;
	saveSettings(): Promise<void>;
	debugLog(entry: DebugEntry): void;
	/** A notice carrying an action button; tracked so unload can dismiss it. */
	showActionNotice(
		message: string,
		actionLabel: string,
		run: () => unknown,
	): Notice;
	/** Drop a notice from that tracking set, for one being hidden here. */
	forgetActionNotice(notice: Notice): void;
	/** Redraw the settings tab if one is open. */
	redrawSettings(): void;
	/** True while a sign-in window is open. Renewal refuses to run under one. */
	isReauthInFlight(): boolean;
	reconnectPrefersWindow(): boolean;
	reconnectFromNotice(): Promise<boolean>;
	/** Clear the embedded sign-in session for this vault only. */
	clearLoginSession(): Promise<void>;
	resumeAutoSyncIfPaused(): void;
	storeAccessToken(
		rawToken: string,
		signInMethod?: SignInMethod,
		apiBaseUrl?: string,
		background?: boolean,
		stillOwns?: () => boolean,
		// The rotated v4 refresh token to persist beside the fresh WT (the v4
		// refresh returns a new one each time). Undefined on the v3
		// cookie path, which does not carry one through here.
		refreshToken?: string | null,
	): Promise<CaptureStoreResult>;
}

export class SessionRenewal {
	// ---- Timer and notice state, owned here and nowhere else -------------

	private sessionExpiryTimeoutId: number | undefined;
	private sessionExpiryNotice: Notice | null = null;
	private sessionRefreshTimeoutId: number | undefined;
	private sessionRefreshInFlight = false;
	private sessionRefreshFailed = false;
	// Shown when renewal fails outside the warning window, so the user is not
	// left with no sign that it stopped. Cleared wherever the expiry notice is.
	private sessionRefreshFailureNotice: Notice | null = null;

	constructor(private readonly host: SessionRenewalHost) {}

	/** True when renewal has failed for the current credential and stopped. */
	get paused(): boolean {
		return this.sessionRefreshFailed;
	}

	/** True while a refresh is on the network. A sign-in must not start under one. */
	get refreshInFlight(): boolean {
		return this.sessionRefreshInFlight;
	}

	/**
	 * A fresh credential clears the failure state: whatever was wrong, the user
	 * just replaced the thing that was failing.
	 */
	clearFailure(): void {
		this.sessionRefreshFailed = false;
	}

	/** Cancel both timers and drop the notice references. Called from onunload. */
	dispose(): void {
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		this.sessionExpiryNotice = null;
		this.sessionRefreshFailureNotice = null;
	}

	// ---- Pre-expiry session warning (issue #78, 0.34.0) ------------------

	// Re-evaluates the session-expiry warning: clears any armed timer, then
	// either warns now (once per credential, keyed on the exact expMs) or
	// arms a clamped timeout to re-evaluate at expiry-minus-lead. Called from
	// onLayoutReady and EVERY credential mutation (storeAccessToken,
	// reauthenticate, clearSignIn, the settings secret picker), so the timer
	// can never describe a stale credential. Mirrors the timer-id clearing
	// discipline of reconcileAutoSync.
	reconcileExpiryWarning(): void {
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		// A still-visible warning describes the credential as it was when it
		// fired; every reconcile is a potential credential change, so dismiss
		// it and let the decision below re-derive. Hiding an already-hidden
		// notice is a no-op.
		if (this.sessionExpiryNotice !== null) {
			this.sessionExpiryNotice.hide();
			this.host.forgetActionNotice(this.sessionExpiryNotice);
			this.sessionExpiryNotice = null;
		}
		// The renewal-failure prompt goes with it, and for the same reason.
		// This reconcile runs on every credential mutation and when the warning
		// timer fires, so clearing it here is what stops a stale "could not
		// renew" notice outliving the credential it described or stacking under
		// the warning that replaces it.
		if (this.sessionRefreshFailureNotice !== null) {
			this.sessionRefreshFailureNotice.hide();
			this.host.forgetActionNotice(this.sessionRefreshFailureNotice);
			this.sessionRefreshFailureNotice = null;
		}
		if (this.host.isDisposed()) return;
		const value = this.host.readStoredTokenValue();
		const life = value.length > 0 ? readTokenLifetime(value) : null;
		const decision = sessionExpiryDecision(
			Date.now(),
			life,
			this.host.getSettings().sessionWarnedForExpMs,
		);
		if (decision.action === 'scheduled' && decision.armDelayMs !== null) {
			this.sessionExpiryTimeoutId = window.setTimeout(() => {
				this.sessionExpiryTimeoutId = undefined;
				this.reconcileExpiryWarning();
			}, decision.armDelayMs);
			return;
		}
		if (decision.action !== 'warn' || decision.expMs === null) {
			return;
		}
		// Stamp BEFORE showing, so a notice path that throws cannot re-nag on
		// every reconcile. The stamp is keyed to this exact expMs; a fresh
		// credential carries a different exp and warns again.
		this.host.getSettings().sessionWarnedForExpMs = decision.expMs;
		this.saveSettingsDetached('saving the session warning stamp failed');
		// Above ~2 days speak in days ("about 7 days"), below in hours: the
		// long (7-day) lead would otherwise read as "about 168 hours".
		const hoursLeft = Math.max(
			1,
			Math.round((decision.expMs - Date.now()) / 3_600_000),
		);
		const timeLeft =
			hoursLeft > 48
				? `${Math.round(hoursLeft / 24)} days`
				: `${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}`;
		const baseMessage = decision.expired
			? 'Your Plaud session has expired. Reconnect to keep imports and auto-sync running.'
			: `Your Plaud session expires in about ${timeLeft}. Reconnect now to avoid an interruption.`;
		this.sessionExpiryNotice = this.host.showActionNotice(
			baseMessage +
				ssoReconnectHint(this.host.getSettings().signInMethod),
			'Reconnect',
			() => this.reconnectFreshFromExpiryNotice(),
		);
	}

	// Re-evaluates the silent session refresh: clears any armed timer, then arms
	// a new one when this session is one the refresh can actually serve. Called
	// from onLayoutReady and every credential mutation, exactly like
	// reconcileSessionExpiryWarning, so the timer can never describe a stale
	// credential.
	//
	// This vault's Plaud sign-in partition (issue #87).
	//
	// Derived on every use rather than cached in a field, because the value is
	// only ever a pure function of the host's vault id and re-deriving costs a
	// regex test. Caching it would add a second place for sign-in and refresh to
	// disagree about which cookie jar is current, which is precisely the class of
	// bug this change exists to remove.
	signInPartition(): string {
		return plaudPartition(this.host.getAppId());
	}

	// Gated on the RECORDED sign-in method, because the two renewal transports
	// need different things:
	//   - 'window': the v3 cookie refresh (plaud-refresh-net) authenticates with
	//     the embedded sign-in window's partition cookies, and only that window
	//     populates that partition.
	//   - 'browser': the v4 cookieless refresh (plaud-refresh-v4) bearers the
	//     captured workspace refresh token, so it needs a v4 session (a ws_ wid)
	//     AND a stored refresh token. A prod SSO account (browser, no wid, no
	//     captured refresh token) matches neither and reconnects manually, by
	//     design, exactly as before.
	reconcileRefresh(): void {
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		if (this.host.isDisposed() || this.sessionRefreshFailed) return;
		const method = this.host.getSettings().signInMethod;
		const token = this.host.readStoredTokenValue();
		if (token.length === 0) return;
		// Only a workspace token wants this. Minting against a long-lived
		// credential would trade months of life for 24 hours; see
		// isWorkspaceToken.
		if (!isWorkspaceToken(token)) return;
		if (method === 'window') {
			// No transport, no renewal. Arming a timer that can only ever return
			// "unsupported" wastes a wake-up and, worse, lets the settings copy go
			// on promising a renewal this build cannot perform.
			if (buildPartitionPost(this.signInPartition()) === null) return;
		} else if (method === 'browser') {
			// v4 only: a browser session with no ws_ workspace is a prod SSO
			// account, which has no bearer-refresh endpoint here.
			if (workspaceIdFromToken(token) === null) return;
			// And only when a refresh token was actually captured (a pre-beta.3
			// v4 session has none until the user re-signs-in).
			if (this.host.readStoredRefreshTokenValue().length === 0) return;
		} else {
			return;
		}
		const delay = computeRefreshDelayMs(token, Date.now());
		if (delay === null) return;
		this.sessionRefreshTimeoutId = window.setTimeout(() => {
			this.sessionRefreshTimeoutId = undefined;
			// Belt and braces on top of the store's own catch: nothing on a
			// background timer may reject into the console unhandled.
			void this.runScheduledSessionRefresh().catch((err: unknown) => {
				console.error(
					'Plaud importer: scheduled session refresh failed',
					err,
				);
			});
		}, delay);
	}

	// The timer callback. Re-reads the credential rather than closing over it:
	// the wake-up can be up to 20 days after arming (the clamp), and the
	// credential may have been replaced by a reconnect in between.
	private async runScheduledSessionRefresh(): Promise<void> {
		if (this.host.isDisposed() || this.sessionRefreshInFlight) return;
		const token = this.host.readStoredTokenValue();
		// Not actually due yet: the 20 day clamp means an early wake is normal.
		// Re-arm rather than spend a mint call against the hourly ceiling.
		if (token.length > 0 && !isRefreshDue(token, Date.now())) {
			this.reconcileRefresh();
			return;
		}
		const outcome = await this.refreshNow();
		// A deferral is not a failure and must not silently end renewal. "busy"
		// means a sign-in window was open (or another refresh was running), and
		// the timer that brought us here is already spent: if the user then
		// CANCELS that sign-in nothing else reconciles the schedule, so this
		// token would run to expiry with no further attempt. Re-arm instead.
		// "superseded" re-arms through the newer credential's own store, but
		// reconciling again is idempotent and keeps the rule simple. "failed"
		// deliberately does not re-arm; "unsupported" has nothing to arm.
		if (outcome === 'busy' || outcome === 'superseded') {
			this.reconcileRefresh();
		}
	}

	// Runs one refresh and stores the result. Returns what happened so the debug
	// command can report it; the scheduled path reacts to deferrals and otherwise
	// goes through the state this sets. Dispatches on the recorded sign-in method:
	// a 'browser' (v4) session takes the cookieless bearer path, everything else
	// the v3 cookie path below.
	//
	// No retry, by measurement: step 1 reports `login_total_per_hour: 10`, so a
	// backoff ladder against a dead session spends the account's whole refresh
	// budget and can lock it out of renewing at all. One attempt; on failure
	// pause and prompt Reconnect.
	async refreshNow(): Promise<RefreshOutcome> {
		if (this.sessionRefreshInFlight) return 'busy';
		// Never run underneath an open sign-in window. Reconnect CLEARS the
		// sign-in partition before reopening it, and that partition's cookies
		// are the only thing this refresh authenticates with, so the two would
		// be fighting over the same session. reauthenticate() holds the mirror
		// of this lock; both are needed, because in the other order the sign-in
		// window can re-capture the stale pre-refresh token and store it over a
		// refresh that had already succeeded. The browser path holds the same
		// lock: a reconnect there re-captures the near-expiry token from the
		// portal and could store it over a fresh one.
		if (this.host.isReauthInFlight()) return 'busy';
		const method = this.host.getSettings().signInMethod;
		if (method === 'browser') return this.refreshBrowserSessionNow();
		if (method !== 'window') return 'unsupported';
		const current = this.host.readStoredTokenValue();
		if (current.length === 0) return 'unsupported';
		// A long-lived credential must not be traded for a 24 hour one.
		if (!isWorkspaceToken(current)) return 'unsupported';
		// Which secret that value came from, not just the value. The picker can
		// be pointed at a DIFFERENT secret holding the same token, and a value
		// comparison alone would call that unchanged and then re-link
		// CAPTURED_SECRET_ID underneath the user's choice.
		const currentSecretId = this.host.getSettings().secretId;
		const post = buildPartitionPost(this.signInPartition());
		if (post === null) {
			this.host.debugLog({
				kind: 'error',
				endpoint: '/session-refresh',
				message:
					'session refresh unavailable: no Electron session.fetch on this build',
			});
			return 'unsupported';
		}
		// Held until the fresh token is STORED, not merely fetched. Clearing it
		// when the network settled would reopen the gap it exists to close: the
		// user could start a sign-in during validation and storage, and that
		// window can capture the partition's stale token and write it over the
		// one this call just minted.
		this.sessionRefreshInFlight = true;
		try {
			const result = await performNetRefresh({
				currentToken: current,
				baseUrl: this.host.getSettings().apiBaseUrl,
				post,
				log: (message, payload) => {
					this.host.debugLog({
						kind: 'note',
						endpoint: '/session-refresh',
						message,
						payload,
					});
				},
			});
			// A plugin unloaded mid-refresh must not write storage.
			if (this.host.isDisposed()) return 'failed';
			// Supersede check FIRST, ahead of both the success and the failure
			// branch. The two calls above take seconds and nothing serializes them
			// against the user: a reconnect, a paste, a different linked secret or a
			// sign out can all land while they are in flight. Writing a success
			// afterwards would clobber the credential the user just chose, or
			// re-link one they just cleared. Recording a FAILURE afterwards is just
			// as wrong and less obvious: it would mark the user's brand new session
			// as failed and clear the refresh timer that session had just armed,
			// leaving it with no unattended renewal at all. This result belongs to a
			// credential nobody is using any more, so it is simply dropped.
			if (
				this.host.readStoredTokenValue() !== current ||
				this.host.getSettings().secretId !== currentSecretId
			) {
				this.host.debugLog({
					kind: 'note',
					endpoint: '/session-refresh',
					message:
						'session refresh discarded: the stored credential changed while it ran',
				});
				return 'superseded';
			}
			// Validate before storing, the same guard every other capture path
			// applies. A mint that answered 200 with something that is not a usable
			// token must never replace a working credential.
			//
			// Plus one requirement specific to this path: the value has to carry a
			// `wid`. isUsableUserToken deliberately accepts anything future-dated
			// with a client_id that is not a WRT, which includes a user token with
			// no workspace id. Storing one of those looks like a success and then
			// silently ends unattended renewal, because the NEXT refresh reads its
			// workspace id off the stored token and aborts without one. Checked
			// here rather than by tightening the shared guard, which must keep
			// accepting WT.
			//
			// And it has to be a token that actually MOVED the expiry. A mint
			// that hands back the current credential, or any WT already inside
			// the refresh window, would be stored as a success, clear the
			// failure state, and then schedule its own next attempt at the 30
			// second floor, looping against a ceiling of about 10 refreshes an
			// hour. Refusing it leaves the old token in place to expire
			// normally, which surfaces as the ordinary reconnect prompt
			// instead of a retry storm.
			if (
				result === null ||
				!isUsableUserToken(result.token) ||
				!isWorkspaceToken(result.token) ||
				extractWorkspaceId(result.token) === null ||
				isRefreshDue(result.token, Date.now())
			) {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						result === null
							? 'session refresh failed: the two-step refresh did not return a token'
							: !isUsableUserToken(result.token)
								? 'session refresh failed: the minted value did not pass the capture guard'
								: !isWorkspaceToken(result.token)
									? 'session refresh failed: the minted value is not a workspace token'
									: extractWorkspaceId(result.token) === null
										? 'session refresh failed: the minted value carries no workspace id to refresh against'
										: 'session refresh failed: the minted token is already inside the refresh window',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			// A vault that will not take the settings write comes back as a
			// `save-failed` outcome now rather than a throw, so it can be named in
			// the log. The try/catch stays for everything else the store touches
			// after its commit: this runs from a timer whose caller only voids the
			// promise, so an escaping rejection would be an unhandled one AND would
			// skip both the failure prompt and the re-arm, quietly ending
			// unattended renewal until the next reload.
			//
			// The supersede check above is re-run inside the store, and has to be.
			// Since the store commits settings before writing the secret, a user
			// capture that is mid-commit has not reached `setSecret` yet, so
			// `readStoredTokenValue()` still returns the old value and that check
			// passes when it should not. It stays where it is because discarding
			// there is cheaper than queueing and then discarding.
			let stored: CaptureStoreResult;
			try {
				stored = await this.host.storeAccessToken(
					result.token,
					'window',
					result.apiBaseUrl ?? undefined,
					true,
					() =>
						!this.host.isDisposed() &&
						this.host.readStoredTokenValue() === current &&
						this.host.getSettings().secretId === currentSecretId,
				);
			} catch (err) {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						'session refresh failed: storing the fresh token threw',
					payload: {
						error: err instanceof Error ? err.message : String(err),
					},
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			if (stored.outcome === 'superseded') {
				// Same meaning as the early supersede check, so the same result:
				// drop it, and do NOT record a failure. Marking the user's brand new
				// session as failed would clear the timer it had just armed.
				this.host.debugLog({
					kind: 'note',
					endpoint: '/session-refresh',
					message:
						'session refresh discarded: the stored credential changed while the store was queued',
				});
				return 'superseded';
			}
			if (stored.outcome !== 'stored') {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						stored.outcome === 'save-failed'
							? 'session refresh failed: the vault would not accept the settings write, so the fresh token was not stored and the previous session is unchanged'
							: stored.outcome === 'torn'
								? 'session refresh failed: the settings write landed but the credential write did not, so data.json names a session whose token was never stored'
								: 'session refresh failed: the minted token did not pass the capture guard at store time',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			this.sessionRefreshFailed = false;
			this.host.debugLog({
				kind: 'note',
				endpoint: '/session-refresh',
				message: 'session refresh succeeded; a fresh token is stored',
			});
			// A tick that ran while the token was expired (Obsidian waking from
			// sleep, say) will have paused auto-sync before this refresh
			// finished. The credential is good again, so lift that pause;
			// otherwise every later tick stays skipped until the user resumes by
			// hand, which is exactly the unattended operation this exists for.
			this.host.resumeAutoSyncIfPaused();
			// storeAccessToken already reconciled the warning and this schedule.
			return 'refreshed';
		} finally {
			this.sessionRefreshInFlight = false;
		}
	}

	// The v4 (browser) refresh: cookieless, bearering the captured workspace
	// refresh token against /user-app/auth/workspace/refresh/{wid}. Same
	// supersede/validate/store discipline as the window path above, minus the
	// partition (there is none for a browser session) and the region redirect
	// (v4 has no soft redirect). Reached only from refreshNow, after its busy and
	// reauth guards, so it may assume no refresh is already in flight.
	private async refreshBrowserSessionNow(): Promise<RefreshOutcome> {
		const current = this.host.readStoredTokenValue();
		if (current.length === 0) return 'unsupported';
		// A long-lived credential must not be traded for a 24 hour one, and a v3
		// browser (prod SSO) session has no bearer-refresh endpoint here.
		if (!isWorkspaceToken(current)) return 'unsupported';
		const currentWid = workspaceIdFromToken(current);
		if (currentWid === null) return 'unsupported';
		// The bearer. Absent for a v4 session captured before beta.3 added the
		// capture, in which case there is nothing to renew with (the user
		// re-signs-in to get one).
		const refreshToken = this.host.readStoredRefreshTokenValue();
		if (refreshToken.length === 0) return 'unsupported';
		// Which secret the WT came from, not just its value, so a picker pointed
		// at a different secret holding the same value is treated as a change.
		const currentSecretId = this.host.getSettings().secretId;
		const deviceId = this.host.getSettings().plaudDeviceId.trim();
		// Held until the fresh token is STORED, not merely fetched, so a sign-in
		// started during validation cannot re-capture the stale portal token and
		// write it over the one this call just minted.
		this.sessionRefreshInFlight = true;
		try {
			const result = await performV4Refresh({
				currentToken: current,
				refreshToken,
				baseUrl: this.host.getSettings().apiBaseUrl,
				deviceId: deviceId.length > 0 ? deviceId : undefined,
				fetch: this.host.httpFetch,
				log: (message, payload) => {
					this.host.debugLog({
						kind: 'note',
						endpoint: '/workspace-refresh',
						message,
						payload,
					});
				},
			});
			// A plugin unloaded mid-refresh must not write storage.
			if (this.host.isDisposed()) return 'failed';
			// Supersede check FIRST, ahead of both branches, for the same reason as
			// the window path: a reconnect, a paste, a different linked secret or a
			// sign out can land while the call is in flight, and neither a success
			// nor a failure belongs to a credential nobody is using any more. The
			// refresh token is part of that identity: a concurrent capture can
			// rotate the WRT while keeping the same WT and secret, and overwriting
			// that newer bearer with this call's rotation (or failing the new
			// session on this call's error) would be the same clobber.
			if (
				this.host.readStoredTokenValue() !== current ||
				this.host.getSettings().secretId !== currentSecretId ||
				this.host.readStoredRefreshTokenValue() !== refreshToken
			) {
				this.host.debugLog({
					kind: 'note',
					endpoint: '/workspace-refresh',
					message:
						'v4 session refresh discarded: the stored credential changed while it ran',
				});
				return 'superseded';
			}
			// Validate the minted WT before storing: a usable, future-dated
			// workspace token that MOVED the expiry past the refresh window AND
			// stays on the SAME workspace. Binding the wid to the original is what
			// stops a refresh (a stale refresh secret paired with a newly linked WT,
			// say) from quietly switching the account to another workspace, which
			// the v4 client would then send as x-scope-id on every call. The rotated
			// refresh token is bound the same way: it is what the next cycle bears,
			// and one for a different workspace could not renew this one. The
			// in-window check refuses a mint already inside the refresh window, which
			// would store as a success and then re-fire at the 30s floor against the
			// hourly ceiling.
			// The rotated refresh token has to be a real, live refresh token for
			// THIS workspace, not merely a JWT that carries the right wid. Reusing
			// selectRefreshTokenForWorkspace applies the exact capture-time guard
			// (typ WRT, future exp, ws_ wid matching the fresh WT), so an expired or
			// wrong-type value the endpoint might hand back is rejected instead of
			// stored as the next cycle's unusable bearer.
			const rotatedRefreshValid =
				result !== null &&
				selectRefreshTokenForWorkspace(
					[result.refreshToken],
					result.token,
				) === result.refreshToken;
			if (
				result === null ||
				!isUsableUserToken(result.token) ||
				!isWorkspaceToken(result.token) ||
				workspaceIdFromToken(result.token) !== currentWid ||
				!rotatedRefreshValid ||
				isRefreshDue(result.token, Date.now())
			) {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/workspace-refresh',
					message:
						result === null
							? 'v4 session refresh failed: the bearer refresh did not return a token'
							: !isUsableUserToken(result.token)
								? 'v4 session refresh failed: the minted value did not pass the capture guard'
								: !isWorkspaceToken(result.token)
									? 'v4 session refresh failed: the minted value is not a workspace token'
									: workspaceIdFromToken(result.token) !==
										  currentWid
										? 'v4 session refresh failed: the minted token is for a different workspace'
										: !rotatedRefreshValid
											? 'v4 session refresh failed: the rotated refresh token is not a valid refresh token for this workspace'
											: 'v4 session refresh failed: the minted token is already inside the refresh window',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			// Store the fresh WT and the ROTATED refresh token in one
			// batch. The refresh token is 'browser', with no host or scope change
			// (v4 has no region redirect and the workspace rides in the token). The
			// ownership guard is re-run inside the store for the same reason the
			// window path re-runs it.
			let stored: CaptureStoreResult;
			try {
				stored = await this.host.storeAccessToken(
					result.token,
					'browser',
					undefined,
					true,
					() =>
						!this.host.isDisposed() &&
						this.host.readStoredTokenValue() === current &&
						this.host.getSettings().secretId === currentSecretId &&
						this.host.readStoredRefreshTokenValue() ===
							refreshToken,
					result.refreshToken,
				);
			} catch (err) {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/workspace-refresh',
					message:
						'v4 session refresh failed: storing the fresh token threw',
					payload: {
						error: err instanceof Error ? err.message : String(err),
					},
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			if (stored.outcome === 'superseded') {
				this.host.debugLog({
					kind: 'note',
					endpoint: '/workspace-refresh',
					message:
						'v4 session refresh discarded: the stored credential changed while the store was queued',
				});
				return 'superseded';
			}
			if (stored.outcome !== 'stored') {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/workspace-refresh',
					message:
						stored.outcome === 'save-failed'
							? 'v4 session refresh failed: the vault would not accept the settings write, so the fresh token was not stored and the previous session is unchanged'
							: stored.outcome === 'torn'
								? 'v4 session refresh failed: the settings write landed but the credential write did not, so data.json names a session whose token was never stored'
								: 'v4 session refresh failed: the minted token did not pass the capture guard at store time',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			// The rotated refresh token MUST have landed. The store writes it in a
			// guarded step (a failed write leaves the WT stored and only degrades
			// renewal, which is right for a sign-in), so a 'stored' outcome does not
			// prove the new bearer persisted. Read it back: if the write was
			// swallowed the secret still holds the OLD bearer, and reporting success
			// here would clear the failure state and re-arm as healthy while the next
			// cycle silently bears a spent token. Treat that as a failure so the
			// user is prompted to reconnect instead.
			if (
				this.host.readStoredRefreshTokenValue() !== result.refreshToken
			) {
				this.host.debugLog({
					kind: 'error',
					endpoint: '/workspace-refresh',
					message:
						'v4 session refresh failed: the fresh workspace token was stored but the rotated refresh token was not, so the next renewal has no valid bearer',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			this.sessionRefreshFailed = false;
			this.host.debugLog({
				kind: 'note',
				endpoint: '/workspace-refresh',
				message:
					'v4 session refresh succeeded; a fresh token is stored',
			});
			this.host.resumeAutoSyncIfPaused();
			// storeAccessToken already reconciled the warning and this schedule.
			return 'refreshed';
		} finally {
			this.sessionRefreshInFlight = false;
		}
	}

	// Fire-and-forget settings write, for the paths that are synchronous by
	// design (timer callbacks, notice handlers) and have no caller to await it.
	// The catch is not optional here. This exact feature reaches these lines
	// BECAUSE a vault write failed, so a bare `void saveSettings()` would very
	// likely reject for the same reason and, being detached, would escape every
	// caller's catch as the unhandled rejection the refresh path exists to
	// avoid.
	private saveSettingsDetached(context: string): void {
		void this.host.saveSettings().catch((err: unknown) => {
			console.error(`Plaud importer: ${context}`, err);
		});
	}

	// A failed refresh pauses unattended renewal and asks for a reconnect. It
	// deliberately does NOT re-arm: see the no-retry note above.
	private onSessionRefreshFailed(): void {
		this.sessionRefreshFailed = true;
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		// Let the existing pre-expiry machinery own the user-facing prompt. The
		// credential is still live (the refresh runs a lead time before expiry),
		// so this surfaces as the normal Reconnect notice rather than a second,
		// competing one.
		//
		// Clearing the warn stamp first is what makes that actually appear. On a
		// 24 hour token both timers come due at the same two-hour lead, so the
		// warning has usually already fired and stamped this exact expiry while
		// the refresh was still on the network. reconcileSessionExpiryWarning
		// hides the visible notice before re-deriving, and a stamped expiry
		// re-derives as 'quiet', so without this the failure would take the
		// user's only Reconnect prompt away and put nothing back. The stamp
		// exists to stop repeat nagging for one expiry; a refresh that just
		// failed is new information and earns the one re-warn.
		// Persisted, not just assigned. reconcileSessionExpiryWarning only saves
		// when it actually warns, so without this the cleared stamp lives in
		// memory alone: a reload would restore the OLD stamp from disk and
		// suppress the reconnect warning for the very credential whose renewal
		// just failed.
		this.host.getSettings().sessionWarnedForExpMs = 0;
		this.saveSettingsDetached('clearing the session warning stamp failed');
		this.reconcileExpiryWarning();
		// Renewal now runs a clear margin BEFORE the warning's own lead, so at
		// the moment a refresh fails the credential is usually still OUTSIDE
		// the warn window and the reconcile above only arms a timer. Waiting
		// that out would leave the user with no sign that unattended renewal
		// had stopped, for hours. Prompt directly instead, and stamp this
		// expiry so the scheduled warning does not later post a second,
		// near-identical notice for the same credential.
		// Deliberately does NOT stamp sessionWarnedForExpMs and does NOT take
		// over this.sessionExpiryNotice. Stamping would silence the scheduled
		// warning when it comes due, and that warning is the prompt covering
		// the final hours before expiry: the user would be told once, four
		// hours out, and then left with nothing at the point it matters most.
		// Leaving the stamp at zero lets the warning fire normally as an
		// escalation, and because reconcile hides the tracked notice before
		// showing its own, only one is ever on screen. Skipped when a warning
		// notice is already up, so the two never stack.
		if (this.sessionExpiryNotice === null) {
			this.sessionRefreshFailureNotice = this.host.showActionNotice(
				'Could not renew your Plaud session automatically. Reconnect to keep imports and auto-sync running.',
				'Reconnect',
				() => this.reconnectFreshFromExpiryNotice(),
			);
		}
		// Renewal has stopped for this credential, so an open settings tab is
		// now showing a renewal promise that is no longer true. Redraw it.
		try {
			this.host.redrawSettings();
		} catch (err) {
			console.error('Plaud importer: settings refresh failed', err);
		}
	}
	// Reconnect action for the pre-expiry notice specifically. For a
	// window-flow account the embedded window's persistent session can still
	// hold the SAME near-expiry token, and openPlaudLogin captures any usable
	// token instantly: without clearing the login session first, "Reconnect"
	// would close immediately, report success, and change nothing. Clearing
	// only the login partition is non-destructive: the stored secret is
	// untouched, so closing the window without signing in loses nothing.
	// Skipped while a sign-in window is already open (the single-flight guard
	// in reauthenticate would refuse anyway; clearing under a live window
	// would break it).
	private async reconnectFreshFromExpiryNotice(): Promise<void> {
		// Checked HERE, ahead of the clear, not just inside reauthenticate. The
		// clear destroys the very cookies an in-flight refresh authenticates
		// with, so reaching reauthenticate's guard first would be too late: the
		// refresh would fail AND the sign-in would then be refused, which is
		// the worst of both. This is a reachable ordering, not a corner case:
		// on a 24 hour token the refresh timer and the warning that shows this
		// button both come due at the same two-hour lead. A refresh takes
		// seconds and, if it succeeds, removes the reason to reconnect at all.
		if (this.sessionRefreshInFlight) {
			new Notice(
				'Renewing your session now. Try reconnecting in a moment if it does not clear.',
			);
			return;
		}
		// Disarm the scheduled refresh BEFORE yielding to the clear. The check
		// above only proves no refresh is running right now; clearing is an
		// await, and the timer could come due during it and start one against a
		// partition being destroyed. Cancelling the timer closes that window,
		// because the timer is the only thing that starts a refresh on its own
		// (the other entry point is the manual debug command).
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		try {
			if (
				this.host.reconnectPrefersWindow() &&
				!this.host.isReauthInFlight()
			) {
				try {
					await this.host.clearLoginSession();
				} catch (err) {
					console.error(
						'Plaud importer: failed to clear login session before reconnect',
						err,
					);
				}
			}
			await this.host.reconnectFromNotice();
		} finally {
			// Put the schedule back however this ended. A reconnect that stored
			// a credential has already re-armed through storeAccessToken and
			// this is a no-op; one the user CANCELLED would otherwise be left
			// with the timer cancelled above and no renewal at all.
			this.reconcileRefresh();
		}
	}

	// True when reconcileSessionRefresh would arm background renewal for this
	// credential: the right sign-in method, a workspace token (a long-lived
	// pre-v2 token is deliberately skipped, since refreshing would trade
	// months of life for 24 hours), a build that can reach the partition, and
	// an expiry the scheduler can compute a wake-up from. Runtime state
	// (disposed, a failed attempt, a pause) is deliberately NOT in here;
	// callers report those separately. A window (email) session's renewal copy
	// routes through here so it cannot disagree with what the scheduler does. A
	// browser (Google/Apple) session is the deliberate exception: this can
	// return true so the scheduler still ATTEMPTS renewal, but the copy never
	// promises the session lasts, because Plaud can revoke an SSO session
	// server-side within hours regardless. signInMethod is a parameter because
	// capture surfaces are not serialized (issue #86): a capture notice must
	// describe the capture it belongs to even if a concurrent capture rewrites
	// settings meanwhile.
	canRenewCredential(
		token: string,
		signInMethod: SignInMethod = this.host.getSettings().signInMethod,
	): boolean {
		if (
			!isWorkspaceToken(token) ||
			computeRefreshDelayMs(token, Date.now()) === null
		) {
			return false;
		}
		if (signInMethod === 'window') {
			return buildPartitionPost(this.signInPartition()) !== null;
		}
		if (signInMethod === 'browser') {
			// A v4 session (ws_ wid) with a captured refresh token to bearer. A
			// prod SSO browser session has neither and cannot renew here.
			return (
				workspaceIdFromToken(token) !== null &&
				this.host.readStoredRefreshTokenValue().length > 0
			);
		}
		return false;
	}

	// One-time capture heads-up (issue #78): a short (24h) session is normal
	// now, so the message's job is to say what happens when it runs out.
	// Advisory only: lifetime never gates a capture, and an unreadable or
	// iat-less token stays silent rather than guessing.
	noteShortLifetimeOnCapture(
		token: string,
		signInMethod: SignInMethod,
	): void {
		const life = readTokenLifetime(token);
		if (life === null || life.lifetimeHours === null) {
			return;
		}
		if (life.lifetimeHours > SHORT_LIFETIME_HOURS) {
			return;
		}
		const hours = Math.max(1, Math.round(life.lifetimeHours));
		// The method is passed in rather than read back from settings: a
		// concurrent capture could rewrite settings.signInMethod between this
		// capture's save and its notice.
		const canRenew = this.canRenewCredential(token, signInMethod);
		const issued = `Plaud issued this sign-in a session of about ${hours} hour${
			hours === 1 ? '' : 's'
		}.`;
		new Notice(
			signInMethod === 'browser'
				? `${issued} Plaud can end a Google or Apple session early, so the plugin cannot keep it alive reliably. Add a password to your Plaud account and use email sign-in for a session that lasts about 30 days.`
				: canRenew
					? `${issued} The plugin renews it in the background for about 30 days, then asks you to sign in again.`
					: `${issued} The plugin will ask you to sign in again when it expires.`,
			12000,
		);
	}
}
