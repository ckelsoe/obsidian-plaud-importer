// Browser-side token capture for the SSO sign-in flow (issue #78).
//
// Both halves of one protocol live here so they are read and changed together:
//
// 1. SIGN_IN_BOOKMARKLET, the JavaScript the user runs on a signed-in Plaud
//    tab. It collects every localStorage VALUE that decodes as a live Plaud
//    session JWT and hands the list to Obsidian over the
//    `obsidian://plaud-importer-token` deep link. It navigates with
//    location.replace, not location.href: the URL carries session tokens, and
//    replace cannot leave one behind in browser history.
// 2. The Obsidian-side parser (parseTokenCandidates) and selector
//    (selectWorkingCandidate) that decide which of those candidates is the
//    credential Plaud actually accepts.
//
// Why a LIST rather than one key. Issue #78 produced two account shapes that a
// single-key read cannot serve:
//   - au-coco (APSE1, Google SSO): `token` holds a 24-hour token.
//   - rogerfsh (us-west-2, Google SSO): `token` is ABSENT entirely. The only
//     live credential sits under a `pld_<workspaceId>` key; the 300-day token
//     under `tokenstr` still decodes cleanly but is server-revoked, and a
//     30-day value is a refresh token the API rejects with -3901.
// The browser cannot tell which value is live, and neither can the claims: a
// revoked token decodes exactly like a working one. So the bookmarklet
// collects, the plugin probes, and the first candidate Plaud accepts IN-BAND
// wins.
//
// Two rules this module exists to enforce, both from rogerfsh's survey:
//   - Extract from localStorage VALUES, never from key NAMES. A key-name match
//     swallowed adjacent flags into the signature and produced -3900 "invalid
//     auth header" for a token that was fine.
//   - Never rank candidates by `exp`. The revoked 300-day token wins that
//     ranking and is dead. Order is the `token` key first (the shape every
//     other observed account has), then stable localStorage order.
//
// Deliberately free of any Obsidian or Electron import so it stays pure and
// unit-testable; the caller supplies the probe.

import { PlaudApiError, PlaudAuthError } from './plaud-client-re';
import { isUsableUserToken } from './plaud-token';

/** localStorage key the Plaud web app uses on the accounts that have one. */
export const PRIMARY_TOKEN_KEY = 'token';

/** Custom-protocol URL the bookmarklet navigates to. */
export const TOKEN_DEEP_LINK_BASE = 'obsidian://plaud-importer-token';

/**
 * How many candidates the bookmarklet collects. Five covers every observed
 * account (the most any survey found was three plausible values) while keeping
 * the deep-link URL short and the probe loop to at most five API calls.
 */
export const MAX_COLLECTED_CANDIDATES = 5;

/**
 * How many candidates the deep-link handler accepts. Higher than the collect
 * cap because the handler is a trust boundary: the URL can come from anywhere,
 * so it enforces its own limit rather than trusting the sender's.
 */
export const MAX_DEEP_LINK_CANDIDATES = 8;

/**
 * Longest value considered as a candidate at all. Real Plaud JWTs run a few
 * hundred bytes; anything larger is a cached blob sharing the same storage,
 * and skipping it early keeps both the bookmarklet loop and the handler cheap.
 */
export const MAX_CANDIDATE_LENGTH = 4096;

/**
 * Deep-link URL budget. Windows hands a custom-protocol URL to the shell,
 * where the classic `INTERNET_MAX_URL_LENGTH` limit is 2083 characters, and
 * the #78 reporters are on Windows. Candidates are dropped from the END of the
 * list (never the front, which holds the `token`-key value) until the built URL
 * fits.
 */
export const MAX_DEEP_LINK_URL_LENGTH = 1900;

/** Ceiling on the raw `tokens` parameter before it is even JSON-parsed. */
const MAX_DEEP_LINK_PAYLOAD_LENGTH =
	MAX_CANDIDATE_LENGTH * MAX_DEEP_LINK_CANDIDATES + 64;

/** One localStorage entry, in the browser's own iteration order. */
export interface StoredEntry {
	readonly key: string;
	readonly value: string;
}

/**
 * Trims a raw stored value and strips a leading `bearer ` prefix, or returns
 * null when nothing is left. The prefix pattern matches the bookmarklet's
 * exactly (a literal space, no backslash escapes, since the bookmarklet cannot
 * carry any); every downstream consumer strips again with the more permissive
 * whitespace form, so a stray tab costs a few URL characters and nothing else.
 */
function normalizeCandidate(raw: string): string | null {
	const token = raw.trim().replace(/^bearer +/i, '').trim();
	return token.length === 0 ? null : token;
}

/**
 * Reference implementation of what SIGN_IN_BOOKMARKLET does in the browser:
 * pick the live Plaud session JWTs out of a localStorage snapshot, `token`
 * key first, deduplicated, capped, in stable order and never re-ranked by
 * expiry. The bookmarklet is a hand-minified copy of this (it cannot import),
 * and `__tests__/token-candidates.test.ts` runs the SHIPPED bookmarklet string
 * against the same fixtures and asserts the two agree, so the copy cannot
 * drift silently.
 */
export function collectTokenCandidates(
	entries: readonly StoredEntry[],
	nowMs: number = Date.now(),
): string[] {
	const ordered = [
		...entries.filter((entry) => entry.key === PRIMARY_TOKEN_KEY),
		...entries.filter((entry) => entry.key !== PRIMARY_TOKEN_KEY),
	];
	const out: string[] = [];
	for (const entry of ordered) {
		if (out.length >= MAX_COLLECTED_CANDIDATES) {
			break;
		}
		if (entry.value.length > MAX_CANDIDATE_LENGTH) {
			continue;
		}
		const token = normalizeCandidate(entry.value);
		// isUsableUserToken is the same guard every capture path applies: three
		// base64url segments, header `typ` not WRT, a non-empty `client_id`,
		// and a still-future numeric `exp`. It accepts a workspace token
		// (`typ: WT`), which on rogerfsh-shaped accounts is the ONLY live
		// credential, and rejects the neighboring profile JWT (no `exp`).
		if (token === null || !isUsableUserToken(token, nowMs)) {
			continue;
		}
		if (out.includes(token)) {
			continue;
		}
		out.push(token);
	}
	return out;
}

function tokenDeepLinkUrl(candidates: readonly string[]): string {
	return `${TOKEN_DEEP_LINK_BASE}?tokens=${encodeURIComponent(
		JSON.stringify(candidates),
	)}`;
}

/**
 * Builds the deep link the bookmarklet navigates to, dropping trailing
 * candidates until the URL fits MAX_DEEP_LINK_URL_LENGTH. Always keeps at
 * least one: a single oversized candidate is still worth attempting, and the
 * bookmarklet's copy/paste fallback covers it if the shell truncates the URL.
 */
export function buildTokenDeepLink(candidates: readonly string[]): string {
	let list = candidates.slice(0, MAX_COLLECTED_CANDIDATES);
	let url = tokenDeepLinkUrl(list);
	while (list.length > 1 && url.length > MAX_DEEP_LINK_URL_LENGTH) {
		list = list.slice(0, list.length - 1);
		url = tokenDeepLinkUrl(list);
	}
	return url;
}

/**
 * Parses deep-link parameters into an ordered, deduplicated candidate list.
 *
 * This is a trust boundary: an `obsidian://` URL can be fired by any page, so
 * every bound is enforced here rather than assumed of the sender. The legacy
 * single `token` parameter (0.32.1, and any bookmark a user has not re-added)
 * is read first and stays first, so an old bookmark keeps working unchanged.
 * Values are only shaped here; whether any of them is a usable Plaud token is
 * decided by selectWorkingCandidate.
 */
export function parseTokenCandidates(params: {
	readonly token?: unknown;
	readonly tokens?: unknown;
	// Obsidian's ObsidianProtocolData carries an index signature; declaring one
	// here too keeps a whole params object assignable without a cast.
	readonly [key: string]: unknown;
}): string[] {
	const out: string[] = [];
	const push = (raw: unknown): void => {
		if (typeof raw !== 'string' || raw.length > MAX_CANDIDATE_LENGTH) {
			return;
		}
		const token = normalizeCandidate(raw);
		if (token === null || out.includes(token)) {
			return;
		}
		out.push(token);
	};
	push(params.token);
	const rawList = params.tokens;
	if (
		typeof rawList === 'string' &&
		rawList.length <= MAX_DEEP_LINK_PAYLOAD_LENGTH
	) {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(rawList);
		} catch {
			parsed = null;
		}
		if (Array.isArray(parsed)) {
			for (const item of parsed.slice(0, MAX_DEEP_LINK_CANDIDATES)) {
				push(item);
			}
		}
	}
	return out.slice(0, MAX_DEEP_LINK_CANDIDATES);
}

/**
 * Parses whatever the user copied for the manual paste fallback.
 *
 * The bookmarklet's fallback offers the WHOLE deep link, not a single token,
 * so the copy/paste path selects between candidates exactly like the deep-link
 * path does. Handing over only the first candidate would defeat the point:
 * on a rogerfsh-shaped account the first value can be the revoked long-lived
 * token while the live one sits behind it, and the paste would save the dead
 * credential. A bare token still works, so a v1 bookmark, a hand-copied
 * `localStorage.token`, or a token from a maintainer stays supported.
 */
export function parseClipboardTokens(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.length > MAX_DEEP_LINK_PAYLOAD_LENGTH) {
		return [];
	}
	const marker = `${TOKEN_DEEP_LINK_BASE}?`;
	if (trimmed.toLowerCase().startsWith(marker.toLowerCase())) {
		const params = new URLSearchParams(trimmed.slice(marker.length));
		return parseTokenCandidates({
			token: params.get('token') ?? undefined,
			tokens: params.get('tokens') ?? undefined,
		});
	}
	return parseTokenCandidates({ token: trimmed });
}

/**
 * True when a probe failure is attributable to the CREDENTIAL rather than to
 * the connection, so the selector should move on to the next candidate:
 *
 * - PlaudAuthError / token_rejected covers HTTP 401 and the in-band token-death
 *   codes (-419 "workspace token expired", -3900 "invalid auth header").
 * - A PlaudApiError carrying an inBandStatus covers Plaud's other in-band
 *   rejections on this endpoint, notably -3901 for a refresh token.
 *
 * Everything else (network failure, 429, 5xx, a parse error) is a failure to
 * ASK the question. Those must abort the loop rather than convict every
 * candidate, or an offline click would report the user's session as revoked.
 *
 * The inBandStatus branch is deliberately not narrowed to a code allowlist.
 * Plaud does use in-band negatives for non-auth conditions elsewhere (-12 on
 * the transcription endpoints), but the probe only ever calls
 * /file/simple/web, a plain authenticated list where the token IS the variable,
 * and the two known token-death codes are already raised as PlaudAuthError
 * before reaching here. An allowlist would misread an auth rejection code we
 * have not catalogued as "Plaud unreachable" and, for a single candidate,
 * store a token already known to be dead. Failing toward "try the next
 * candidate" is the safer default for this one call.
 */
export function isCredentialRejection(err: unknown): boolean {
	if (err instanceof PlaudAuthError) {
		return err.reason === 'token_rejected';
	}
	if (err instanceof PlaudApiError) {
		return err.inBandStatus !== undefined;
	}
	return false;
}

export type CandidateOutcome =
	/** A candidate was accepted by Plaud; `token` holds it. */
	| 'selected'
	/** Nothing in the list passed the local capture guard. */
	| 'none-usable'
	/** Every usable candidate was rejected by Plaud. The session is dead. */
	| 'all-rejected'
	/** Plaud could not be reached, so no candidate was ruled out. */
	| 'unreachable';

export interface CandidateSelection {
	readonly outcome: CandidateOutcome;
	/** The accepted candidate, or null for every non-'selected' outcome. */
	readonly token: string | null;
	/** Candidates that passed the local guard, in probe order. */
	readonly usable: readonly string[];
	/** The error that ended an 'unreachable' run; null otherwise. */
	readonly error: unknown;
}

/**
 * Probes candidates in order and returns the first one Plaud accepts.
 *
 * Order is the list's own order, never a re-ranking: rogerfsh's account proved
 * that ranking by remaining lifetime picks a server-revoked 300-day token over
 * the live 24-hour one. HTTP status is likewise not the signal; the caller's
 * probe must be a real API call so the client's in-band error handling decides,
 * because Plaud answers auth failures with HTTP 200 and a negative body status.
 *
 * Pure apart from the injected probe, so the fall-through ordering is unit
 * tested rather than only reviewed.
 */
export async function selectWorkingCandidate(
	candidates: readonly string[],
	probe: (token: string) => Promise<void>,
	nowMs: number = Date.now(),
): Promise<CandidateSelection> {
	const usable = candidates.filter((token) => isUsableUserToken(token, nowMs));
	if (usable.length === 0) {
		return { outcome: 'none-usable', token: null, usable, error: null };
	}
	for (const candidate of usable) {
		try {
			await probe(candidate);
			return { outcome: 'selected', token: candidate, usable, error: null };
		} catch (err) {
			if (!isCredentialRejection(err)) {
				return { outcome: 'unreachable', token: null, usable, error: err };
			}
		}
	}
	return { outcome: 'all-rejected', token: null, usable, error: null };
}

// The browser half of the protocol: a bookmarklet the user keeps on their
// bookmarks bar and clicks on a signed-in Plaud tab.
//
// It collects the candidates (the hand-minified twin of collectTokenCandidates
// above, pinned by a parity test), then navigates to the
// `obsidian://plaud-importer-token` deep link. The bookmark click IS the user
// gesture a custom-protocol launch needs, which is why this now delivers
// directly instead of only offering a value to copy.
//
// The copy/paste path survives as the fallback, because a protocol launch
// cannot be feature-detected: 1.5 seconds later, IF this page still holds
// focus (Obsidian or the browser's "Open Obsidian?" dialog would have taken
// it), a prompt() appears offering the value to paste by hand. It offers the
// whole deep link rather than one token so the paste path can select between
// candidates too (see parseClipboardTokens); handing over just the first would
// save a revoked token on exactly the accounts this release exists for.
//
// Kept as one line with NO backslashes, so it pastes as a valid bookmark URL,
// and every limit is written as a literal because the bookmarklet cannot
// import the constants above. bookmarkSetupHtml escapes it before embedding it
// in an href.
//
// The `javascript:` scheme is held in its own const and concatenated, so the
// one place that strips it (the parity test, which executes the body) can
// reuse the same value instead of re-spelling the scheme.
export const BOOKMARKLET_SCHEME = "javascript:";

/**
 * Escapes the bookmarklet for embedding as an HTML attribute VALUE on the
 * setup page's draggable link.
 *
 * Escaping only `&` is not enough: the bookmarklet is dense with quotes and
 * comparison operators, and an unescaped quote could close the attribute
 * early. Both quote forms are escaped so the value is inert regardless of
 * which delimiter the surrounding markup uses. `&` MUST be replaced first, or
 * the later replacements' own entities would be double-encoded and the dragged
 * bookmark would receive mangled source.
 */
export function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export const SIGN_IN_BOOKMARKLET =
	BOOKMARKLET_SCHEME +
	"(function(){try{var h=location.hostname.toLowerCase();if(h!=='plaud.ai'&&h.slice(-9)!=='.plaud.ai'){alert('Open this on a Plaud tab (web.plaud.ai) after signing in, then click the bookmark.');return;}var seg=/^[A-Za-z0-9_-]+$/;var dec=function(s){try{var b=s.replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(atob(b+'='.repeat((4-b.length%4)%4)));}catch(e){return null;}};var now=Date.now();var pick=function(v){if(typeof v!=='string'||v.length>4096)return null;var t=v.trim().replace(/^bearer +/i,'').trim();var p=t.split('.');if(p.length!==3||!seg.test(p[0])||!seg.test(p[1])||!seg.test(p[2]))return null;var hd=dec(p[0]);var pl=dec(p[1]);if(hd===null||pl===null||hd.typ==='WRT')return null;if(typeof pl.client_id!=='string'||pl.client_id.length===0)return null;if(typeof pl.exp!=='number'||!(pl.exp*1000>now))return null;return t;};var a=[];var add=function(v){var t=pick(v);if(t!==null&&a.indexOf(t)<0&&a.length<5)a.push(t);};add(localStorage.getItem('token'));for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k!==null&&k!=='token')add(localStorage.getItem(k));}if(a.length===0){alert('No usable Plaud sign-in token found on this page. Sign in to Plaud in this tab, then click the bookmark again.');return;}var b='obsidian://plaud-importer-token?tokens=';var u=b+encodeURIComponent(JSON.stringify(a));while(a.length>1&&u.length>1900){a.pop();u=b+encodeURIComponent(JSON.stringify(a));}location.replace(u);setTimeout(function(){if(document.hasFocus())prompt('Obsidian should have opened and saved your Plaud sign-in. If nothing happened, copy this whole line, then click Paste token from clipboard in the plugin settings:',u);},1500);}catch(e){alert('Could not read the Plaud token: '+e);}})()";
