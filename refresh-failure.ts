// Why a background refresh failed, in the two kinds that call for different
// reactions. Modeled on Plaud's own 4.0 web app (app 4.45.0, read from its
// bundle on 2026-10-15), which makes the same split:
//
//   denied       the session itself is over (or Plaud wants something only the
//                user can give, like a fresh sign-in or company SSO). Retrying
//                cannot help; pause renewal and ask the user to reconnect,
//                saying why.
//   unreachable  the server could not be reached or answered something we do
//                not recognize. The session may be fine. Plaud's app keeps it
//                and tries again later; so does the plugin, a bounded number
//                of times (see session-renewal.ts).
//
// Before this, every failure was treated as denied, so one network blip or one
// unrecognized status told the user to sign in again.
//
// Pure, no Obsidian or Electron imports, so the mapping is unit-testable.

/** A reason the session cannot be renewed without the user. */
export type DeniedReason =
	/** Plaud rejected the session or the refresh token. */
	| 'session-ended'
	/** Plaud no longer knows this account (HTTP 410 on the mint). */
	| 'user-not-found'
	/** The workspace enforces company single sign-on. */
	| 'sso-required'
	/** Plaud wants the user to verify their identity again (-2114). */
	| 'step-up-required'
	/** The user no longer has access to this workspace (-3003). */
	| 'workspace-invalid';

export type RefreshFailure =
	| {
			readonly failed: 'denied';
			readonly reason: DeniedReason;
			readonly status?: number;
	  }
	| { readonly failed: 'unreachable'; readonly reason: string };

/** True for a failure value, false for a successful refresh result. */
export function isRefreshFailure(value: unknown): value is RefreshFailure {
	return (
		typeof value === 'object' &&
		value !== null &&
		'failed' in value &&
		(value.failed === 'denied' || value.failed === 'unreachable')
	);
}

export function denied(reason: DeniedReason, status?: number): RefreshFailure {
	return status === undefined
		? { failed: 'denied', reason }
		: { failed: 'denied', reason, status };
}

export function unreachable(reason: string): RefreshFailure {
	return { failed: 'unreachable', reason };
}

// In-band statuses Plaud's app treats as "the user session is gone" on the
// user-token refresh (its `wde` set).
const SESSION_DENIED_STATUSES: ReadonlySet<number> = new Set([
	-100, -101, -102, -104, -105, -401,
]);
// The 4.0 app's named statuses (its `Pr` table).
const STATUS_WT_EXPIRED = -419;
const STATUS_WRT_EXPIRED = -420;
const STATUS_WORKSPACE_INVALID = -3003;
const STATUS_STEPUP_REQUIRED = -2114;
const SSO_REQUIRED = 'SSO_REQUIRED';

/** HTTP 410 on the workspace token mint: Plaud's app reads it as "user not found". */
export const HTTP_GONE = 410;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * True when an envelope says the workspace enforces company SSO. Plaud's app
 * reads `error_code` from `data` or the top level and requires a WorkOS
 * organization id beside it; the id is what makes it a real SSO demand rather
 * than a stray code.
 */
export function isSsoRequired(envelope: Record<string, unknown>): boolean {
	const data = isRecord(envelope.data) ? envelope.data : {};
	const code = data.error_code ?? envelope.error_code;
	if (code !== SSO_REQUIRED) return false;
	const org = data.workos_organization_id ?? envelope.workos_organization_id;
	return typeof org === 'string' && org.length > 0;
}

/**
 * Classify a non-success envelope. `expiredMeansDenied` is for the bearer
 * refresh, where -419/-420 mean the refresh token is spent or expired and there
 * is no cookie session to fall back on. Returns unreachable for anything not
 * known to be terminal.
 */
export function classifyEnvelope(
	envelope: Record<string, unknown>,
	options: { readonly expiredMeansDenied?: boolean } = {},
): RefreshFailure {
	const status = envelope.status;
	if (isSsoRequired(envelope)) {
		return denied(
			'sso-required',
			typeof status === 'number' ? status : undefined,
		);
	}
	if (typeof status !== 'number') {
		return unreachable('envelope has no numeric status');
	}
	if (status === STATUS_STEPUP_REQUIRED) {
		return denied('step-up-required', status);
	}
	if (status === STATUS_WORKSPACE_INVALID) {
		return denied('workspace-invalid', status);
	}
	if (SESSION_DENIED_STATUSES.has(status)) {
		return denied('session-ended', status);
	}
	if (
		options.expiredMeansDenied === true &&
		(status === STATUS_WT_EXPIRED || status === STATUS_WRT_EXPIRED)
	) {
		return denied('session-ended', status);
	}
	return unreachable(`unrecognized status ${status}`);
}

/** HTTP 401/403 mean the credential was refused; anything else non-2xx is transient. */
export function classifyHttpStatus(httpStatus: number): RefreshFailure {
	if (httpStatus === HTTP_GONE) return denied('user-not-found', httpStatus);
	if (httpStatus === 401 || httpStatus === 403) {
		return denied('session-ended', httpStatus);
	}
	return unreachable(`HTTP ${httpStatus}`);
}

/** The reconnect notice for a denied refresh, naming what Plaud asked for. */
export function deniedNoticeText(reason: DeniedReason): string {
	switch (reason) {
		case 'sso-required':
			return 'Your Plaud workspace now requires company single sign-on, so this session cannot be renewed here. Reconnect and sign in through your browser.';
		case 'step-up-required':
			return 'Plaud wants you to confirm your identity again before renewing your session. Reconnect to sign in.';
		case 'workspace-invalid':
			return 'You no longer have access to this Plaud workspace. Reconnect to sign in to your current workspace.';
		case 'user-not-found':
			return 'Plaud no longer recognizes this account. Reconnect to sign in again.';
		case 'session-ended':
			return 'Your Plaud session has ended. Reconnect to keep imports and auto-sync running.';
	}
}
