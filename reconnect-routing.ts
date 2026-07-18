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
