// Decides which sign-in surface a Reconnect prompt should open. Pure logic,
// extracted from the plugin class so the routing (including the pre-0.32.0
// migration fallback) is unit-testable without an Obsidian harness.

export type SignInMethod = '' | 'window' | 'browser';

/**
 * True when Reconnect should open the embedded email sign-in window; false
 * routes to the browser/bookmarklet flow (Google and Apple cannot complete in
 * the embedded window). Prefers the recorded sign-in method. A session from
 * before 0.32.0 has none recorded; for those, a stored legacy refresh token
 * (typ WRT) is the signal, because only the embedded email window ever stored
 * one. A reader failure counts as "no legacy token": misrouting a legacy email
 * user to the browser flow still lets them sign in, while the reverse
 * (an SSO user sent to the embedded window) dead-ends.
 */
export function preferWindowForReconnect(
	method: SignInMethod,
	readLegacyRefreshToken: () => string | null,
): boolean {
	if (method === 'window') return true;
	if (method === 'browser') return false;
	try {
		const legacy = readLegacyRefreshToken();
		return legacy !== null && legacy.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Extra guidance to append to a Reconnect prompt for a Google or Apple (SSO)
 * session. Google and Apple sessions are less reliable than email: the plugin
 * attempts background renewal, but Plaud can still end one server-side, which is
 * why a `browser` user can keep having to sign in. Point them at the steadier
 * fix: add a password to their Plaud account and use email sign-in, which the
 * plugin renews for about 30 days. Returns a leading-space string so callers
 * can concatenate it directly. Empty for an email/window session and for an
 * unrecorded method (no reliable signal to nag on). Exported and pure for unit
 * testing.
 */
export function ssoReconnectHint(method: SignInMethod): string {
	return method === 'browser'
		? ' Google and Apple sessions are less reliable than email. The plugin tries to renew this kind of session, but Plaud can still end it early. For a session the plugin renews for about 30 days, add a password to your Plaud account and use email sign-in.'
		: '';
}

/**
 * Plain-English name of the sign-in method for the settings connection status,
 * so a user can see at a glance which flow their current session came from.
 * Empty for an unrecorded method (a pre-0.32.0 session, or none), where the
 * status line simply shows no method rather than guessing. Exported and pure for
 * unit testing.
 */
export function describeSignInMethod(method: SignInMethod): string {
	switch (method) {
		case 'browser':
			return 'Google or Apple (SSO)';
		case 'window':
			return 'email and password';
		default:
			return '';
	}
}
