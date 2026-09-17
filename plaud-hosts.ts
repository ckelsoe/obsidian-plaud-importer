/**
 * The single allowlist of hosts the plugin trusts as Plaud's own.
 *
 * One place, on purpose. The captured bearer token is only ever sent to a host
 * that passes this, and the sign-in window only reads a token from, and
 * auto-detects an API domain from, a page on one of these hosts. The client, the
 * refresh path, and the sign-in capture each used to carry their own copy, and
 * they drifted: the alpha's v4 API domain (`api-apne1.staging.theplaud.com`) was
 * accepted by the client's allowlist but rejected by the sign-in capture's, so
 * the region never auto-detected and had to be typed in by hand. Centralizing
 * the predicate makes that class of drift impossible.
 *
 * Two registered domains are trusted: `plaud.ai` (production and its regional
 * hosts) and `theplaud.com` (the new portal's regional hosts, currently on a
 * staging cluster). A future general-availability host is added HERE, once, and
 * every trust check picks it up.
 */
export function isTrustedPlaudHost(host: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, '');
	return (
		h === 'plaud.ai' ||
		h.endsWith('.plaud.ai') ||
		h === 'theplaud.com' ||
		h.endsWith('.theplaud.com')
	);
}

/**
 * True when `url` is an https URL on a trusted Plaud host, with no embedded
 * credentials. The shared gate for a base URL or a portal URL the plugin is
 * about to load or send a token to. Returns false (never throws) on a malformed
 * URL, so callers can branch.
 */
export function isTrustedPlaudUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== ''
	) {
		return false;
	}
	return isTrustedPlaudHost(parsed.hostname);
}
