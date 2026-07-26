import { runInNewContext } from 'vm';

import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from '../plaud-client-re';
import {
	BOOKMARKLET_SCHEME,
	buildTokenDeepLink,
	collectTokenCandidates,
	escapeHtmlAttribute,
	isCredentialRejection,
	MAX_CANDIDATE_LENGTH,
	MAX_DEEP_LINK_URL_LENGTH,
	MAX_WALK_DEPTH,
	parseClipboardTokens,
	parseTokenCandidates,
	selectWorkingCandidate,
	SIGN_IN_BOOKMARKLET,
	TOKEN_DEEP_LINK_BASE,
	type StoredEntry,
} from '../token-candidates';

// Same fixture construction as plaud-token.test.ts: the helpers read unverified
// claims, so an unsigned token with a dummy signature segment is faithful.
function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function makeJwt(header: unknown, payload: unknown): string {
	return `${b64url(header)}.${b64url(payload)}.sig`;
}

const NOW_MS = 1_780_000_000_000; // 2026-05-28
const FUTURE_EXP = 1_800_000_000; // seconds → 2027-01-15, after NOW_MS
const PAST_EXP = 1_770_000_000; // seconds → 2026-02-01, before NOW_MS

// The au-coco / treyb shape: a user token under the `token` key.
const USER_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'u1', exp: FUTURE_EXP, iat: 1_774_000_000, client_id: 'web', region: 'us' },
);

// The rogerfsh shape: the only LIVE credential is a workspace token (typ WT,
// wid claim) under a `pld_<workspaceId>` key. Must be accepted.
const WORKSPACE_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ sub: 'u1', exp: FUTURE_EXP, client_id: 'web', wid: 'ws-1' },
);

// A second live user token, for ordering and cap assertions.
const OTHER_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'u2', exp: FUTURE_EXP, client_id: 'web', region: 'apse1' },
);

// The paired refresh token. Decodes cleanly and has a future exp, but the data
// API answers -3901, so it must never become a candidate.
const REFRESH_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WRT' },
	{ sub: 'u1', exp: FUTURE_EXP, client_id: 'web' },
);

// The neighboring profile JWT: {email,id,name}, no exp. Carries identity, so it
// must never reach the deep link or the fallback prompt.
const PROFILE_JWT = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ email: 'a@b.com', id: 'u1', name: 'A B' },
);

// The revoked-but-still-decodable long-lived token rogerfsh found under
// `tokenstr`. Nothing in its claims marks it dead; only a probe can tell.
const REVOKED_LONG_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'u1', exp: FUTURE_EXP, iat: 1_750_000_000, client_id: 'web' },
);

const EXPIRED_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'u1', exp: PAST_EXP, client_id: 'web' },
);

function entries(map: Record<string, string>): StoredEntry[] {
	return Object.keys(map).map((key) => ({ key, value: map[key] }));
}

describe('collectTokenCandidates', () => {
	it('puts the `token` key first regardless of storage order', () => {
		const found = collectTokenCandidates(
			entries({ pld_ws1: WORKSPACE_TOKEN, token: USER_TOKEN }),
			NOW_MS,
		);
		expect(found).toEqual([USER_TOKEN, WORKSPACE_TOKEN]);
	});

	it('keeps stable storage order for the non-primary keys', () => {
		const found = collectTokenCandidates(
			entries({ zzz: OTHER_TOKEN, aaa: WORKSPACE_TOKEN }),
			NOW_MS,
		);
		expect(found).toEqual([OTHER_TOKEN, WORKSPACE_TOKEN]);
	});

	it('collects the workspace token when the `token` key is absent', () => {
		// rogerfsh's account: no `token` key at all, and the WT is the only live
		// credential. A `token`-key-only read captures nothing here.
		const found = collectTokenCandidates(
			entries({ pld_ws1: WORKSPACE_TOKEN, profile: PROFILE_JWT }),
			NOW_MS,
		);
		expect(found).toEqual([WORKSPACE_TOKEN]);
	});

	it('does NOT rank by remaining lifetime', () => {
		// The revoked 300-day token has the longest life and would win any
		// exp-based ranking. Order must stay `token` first, storage order after.
		const found = collectTokenCandidates(
			entries({ tokenstr: REVOKED_LONG_TOKEN, token: WORKSPACE_TOKEN }),
			NOW_MS,
		);
		expect(found[0]).toBe(WORKSPACE_TOKEN);
	});

	it('strips a bearer prefix', () => {
		const found = collectTokenCandidates(
			entries({ token: `bearer ${USER_TOKEN}` }),
			NOW_MS,
		);
		expect(found).toEqual([USER_TOKEN]);
	});

	it('rejects a refresh token by header typ', () => {
		expect(
			collectTokenCandidates(entries({ token: REFRESH_TOKEN }), NOW_MS),
		).toEqual([]);
	});

	it('rejects the profile JWT, which carries identity claims and no exp', () => {
		expect(
			collectTokenCandidates(entries({ userInfo: PROFILE_JWT }), NOW_MS),
		).toEqual([]);
	});

	it('rejects an already-expired token', () => {
		expect(
			collectTokenCandidates(entries({ token: EXPIRED_TOKEN }), NOW_MS),
		).toEqual([]);
	});

	it('ignores non-JWT values and values with extra segments', () => {
		expect(
			collectTokenCandidates(
				entries({
					theme: 'dark',
					n: '42',
					wrapped: `prefix.${USER_TOKEN}`,
					json: '{"a":1}',
				}),
				NOW_MS,
			),
		).toEqual([]);
	});

	it('never extracts a JWT embedded in a key NAME', () => {
		// The -3900 trap: a key-name match swallows adjacent flags into the
		// signature. Only values are read, so a JWT-shaped key is invisible.
		const found = collectTokenCandidates(
			[{ key: `pld_${USER_TOKEN}`, value: 'true' }],
			NOW_MS,
		);
		expect(found).toEqual([]);
	});

	it('deduplicates identical values stored under different keys', () => {
		const found = collectTokenCandidates(
			entries({ token: USER_TOKEN, tokenstr: `bearer ${USER_TOKEN}` }),
			NOW_MS,
		);
		expect(found).toEqual([USER_TOKEN]);
	});

	it('caps the list at five candidates', () => {
		const many: StoredEntry[] = [];
		for (let i = 0; i < 9; i += 1) {
			many.push({
				key: `k${i}`,
				value: makeJwt(
					{ alg: 'HS256', typ: 'JWT' },
					{ sub: `u${i}`, exp: FUTURE_EXP, client_id: 'web' },
				),
			});
		}
		expect(collectTokenCandidates(many, NOW_MS)).toHaveLength(5);
	});

	it('skips oversized values without decoding them', () => {
		const huge = `${USER_TOKEN}${'A'.repeat(MAX_CANDIDATE_LENGTH)}`;
		expect(collectTokenCandidates(entries({ blob: huge }), NOW_MS)).toEqual([]);
	});
});

// Reproduces the localStorage of a real Apple-SSO account, read first-party on
// 2026-07-26 (the shape that made 0.35.0 capture nothing). There is NO `token`
// key. The only live credential is a workspace token nested two levels inside
// the `workspaceList` JSON string, beside a 30-day WRT that the API answers
// -3901 to, with a profile JWT elsewhere. Both neighbours were probed live:
// workspaceToken returned in-band status 0, refreshToken returned -3901.
const APPLE_SSO_STORAGE: Record<string, string> = {
	'pld_abc:unlimitedYearPriceValue': '119.99',
	pld_pweblang: '"en-US"',
	pld_loginMethod: '"apple"',
	pld_userId: '56d20710fed5011bad1b30c885498dbf',
	'pld_abc:frillSsoToken': PROFILE_JWT,
	pld_desktop_version: '1.2.3',
	'pld_abc:workspaceList': JSON.stringify([
		{
			workspaceId: 'ws_clF1vOqcHS',
			name: 'Personal',
			role: 'owner',
			workspaceToken: WORKSPACE_TOKEN,
			refreshToken: REFRESH_TOKEN,
		},
	]),
	gbFeaturesCache: '{"features":{"a":{"defaultValue":false}}}',
};

describe('the Apple-SSO account shape (issue #78, 0.35.0 regression)', () => {
	it('finds the workspace token nested inside workspaceList', () => {
		expect(collectTokenCandidates(entries(APPLE_SSO_STORAGE), NOW_MS)).toEqual([
			WORKSPACE_TOKEN,
		]);
	});

	it('never offers the 30-day refresh token sitting beside it', () => {
		// Probed live: this value answers -3901 "token type does not match parse
		// mode". It has a longer life than the credential, so any exp-based
		// ranking would have picked exactly the wrong one.
		const found = collectTokenCandidates(entries(APPLE_SSO_STORAGE), NOW_MS);
		expect(found).not.toContain(REFRESH_TOKEN);
	});

	it('never offers the profile JWT holding email, id, and name', () => {
		expect(collectTokenCandidates(entries(APPLE_SSO_STORAGE), NOW_MS)).not.toContain(
			PROFILE_JWT,
		);
	});

	it('delivers that token through the deep link', () => {
		const url = buildTokenDeepLink(
			collectTokenCandidates(entries(APPLE_SSO_STORAGE), NOW_MS),
		);
		expect(parseTokenCandidates(
			Object.fromEntries(new URLSearchParams(url.slice(url.indexOf('?') + 1))),
		)).toEqual([WORKSPACE_TOKEN]);
	});
});

describe('nested extraction bounds', () => {
	it('walks arrays, objects, and JSON-inside-JSON', () => {
		const nested = JSON.stringify({ a: [{ b: JSON.stringify({ c: USER_TOKEN }) }] });
		expect(collectTokenCandidates([{ key: 'pld_k', value: nested }], NOW_MS)).toEqual([
			USER_TOKEN,
		]);
	});

	it('stops descending past the depth cap', () => {
		let deep: unknown = USER_TOKEN;
		for (let i = 0; i < MAX_WALK_DEPTH + 3; i += 1) deep = [deep];
		expect(
			collectTokenCandidates([{ key: 'pld_k', value: JSON.stringify(deep) }], NOW_MS),
		).toEqual([]);
	});

	it('does NOT descend into a third-party SDK cache', () => {
		// A feature-flag or analytics SDK sharing this storage may cache its own
		// JWT. Descending into it would make that credential a candidate, and
		// probing SENDS every candidate to Plaud as a bearer token. Handing
		// another service's credential to Plaud is not an acceptable cost.
		const foreign = JSON.stringify({ auth: { jwt: USER_TOKEN } });
		expect(
			collectTokenCandidates(
				[
					{ key: 'ph_phc_abc_posthog', value: foreign },
					{ key: 'gbFeaturesCache', value: foreign },
				],
				NOW_MS,
			),
		).toEqual([]);
	});

	it('still reads a bare top-level token under a non-Plaud key', () => {
		// Narrowing where we DESCEND must not narrow what we accept at the top
		// level, or a future key that drops the prefix stops working.
		expect(
			collectTokenCandidates([{ key: 'somethingElse', value: USER_TOKEN }], NOW_MS),
		).toEqual([USER_TOKEN]);
	});

	it('leaves non-JSON values alone instead of scanning them for substrings', () => {
		// The -3900 lesson: only complete parsed string values are candidates,
		// never a substring cut out of arbitrary text.
		const smuggled = `noise ${USER_TOKEN} noise`;
		expect(collectTokenCandidates([{ key: 'pld_k', value: smuggled }], NOW_MS)).toEqual(
			[],
		);
	});
});

describe('buildTokenDeepLink', () => {
	it('encodes the candidate list as a JSON tokens parameter', () => {
		const url = buildTokenDeepLink([USER_TOKEN, WORKSPACE_TOKEN]);
		expect(url.startsWith(`${TOKEN_DEEP_LINK_BASE}?tokens=`)).toBe(true);
		const encoded = url.slice(`${TOKEN_DEEP_LINK_BASE}?tokens=`.length);
		expect(JSON.parse(decodeURIComponent(encoded))).toEqual([
			USER_TOKEN,
			WORKSPACE_TOKEN,
		]);
	});

	it('drops trailing candidates until the URL fits the shell budget', () => {
		const bulky = (n: number): string =>
			makeJwt(
				{ alg: 'HS256', typ: 'JWT' },
				{ sub: `u${n}`, exp: FUTURE_EXP, client_id: 'web', pad: 'x'.repeat(600) },
			);
		const url = buildTokenDeepLink([bulky(1), bulky(2), bulky(3), bulky(4)]);
		expect(url.length).toBeLessThanOrEqual(MAX_DEEP_LINK_URL_LENGTH);
		const encoded = url.slice(`${TOKEN_DEEP_LINK_BASE}?tokens=`.length);
		const kept = JSON.parse(decodeURIComponent(encoded)) as string[];
		// Front of the list is preserved; only the tail is dropped.
		expect(kept[0]).toBe(bulky(1));
		expect(kept.length).toBeLessThan(4);
	});

	it('keeps one candidate even when it alone exceeds the budget', () => {
		const enormous = makeJwt(
			{ alg: 'HS256', typ: 'JWT' },
			{ sub: 'u1', exp: FUTURE_EXP, client_id: 'web', pad: 'x'.repeat(3000) },
		);
		const url = buildTokenDeepLink([enormous]);
		expect(url.length).toBeGreaterThan(MAX_DEEP_LINK_URL_LENGTH);
		const encoded = url.slice(`${TOKEN_DEEP_LINK_BASE}?tokens=`.length);
		expect(JSON.parse(decodeURIComponent(encoded))).toEqual([enormous]);
	});
});

describe('parseTokenCandidates', () => {
	it('reads the legacy single token parameter', () => {
		expect(parseTokenCandidates({ token: USER_TOKEN })).toEqual([USER_TOKEN]);
	});

	it('strips a bearer prefix and surrounding whitespace', () => {
		expect(parseTokenCandidates({ token: `  bearer ${USER_TOKEN} ` })).toEqual([
			USER_TOKEN,
		]);
	});

	it('reads the tokens array', () => {
		expect(
			parseTokenCandidates({
				tokens: JSON.stringify([USER_TOKEN, WORKSPACE_TOKEN]),
			}),
		).toEqual([USER_TOKEN, WORKSPACE_TOKEN]);
	});

	it('keeps a legacy token first and deduplicates it out of the array', () => {
		expect(
			parseTokenCandidates({
				token: OTHER_TOKEN,
				tokens: JSON.stringify([USER_TOKEN, OTHER_TOKEN]),
			}),
		).toEqual([OTHER_TOKEN, USER_TOKEN]);
	});

	it('caps the array at eight elements', () => {
		const list = Array.from({ length: 20 }, (_unused, i) =>
			makeJwt(
				{ alg: 'HS256', typ: 'JWT' },
				{ sub: `u${i}`, exp: FUTURE_EXP, client_id: 'web' },
			),
		);
		expect(parseTokenCandidates({ tokens: JSON.stringify(list) })).toHaveLength(
			8,
		);
	});

	it('drops non-string elements', () => {
		expect(
			parseTokenCandidates({
				tokens: JSON.stringify([1, null, { a: 1 }, [USER_TOKEN], USER_TOKEN]),
			}),
		).toEqual([USER_TOKEN]);
	});

	it('drops oversized elements', () => {
		const huge = 'A'.repeat(MAX_CANDIDATE_LENGTH + 1);
		expect(
			parseTokenCandidates({ tokens: JSON.stringify([huge, USER_TOKEN]) }),
		).toEqual([USER_TOKEN]);
	});

	it('drops empty and whitespace-only elements', () => {
		expect(
			parseTokenCandidates({ tokens: JSON.stringify(['', '   ', '\t\n']) }),
		).toEqual([]);
	});

	it('returns nothing for malformed JSON, missing params, or a non-array', () => {
		expect(parseTokenCandidates({ tokens: 'not json' })).toEqual([]);
		expect(parseTokenCandidates({})).toEqual([]);
		expect(parseTokenCandidates({ tokens: JSON.stringify({ a: 1 }) })).toEqual(
			[],
		);
	});

	it('falls back to the legacy token when the array is malformed', () => {
		expect(
			parseTokenCandidates({ token: USER_TOKEN, tokens: '[[[' }),
		).toEqual([USER_TOKEN]);
	});

	it('shapes values but does not judge them; the selector does that', () => {
		// A profile JWT survives parsing and is rejected at selection, so the
		// trust boundary and the credential guard stay separate concerns.
		expect(parseTokenCandidates({ token: PROFILE_JWT })).toEqual([PROFILE_JWT]);
	});
});

describe('parseClipboardTokens', () => {
	it('reads a bare token, the pre-0.35.0 clipboard shape', () => {
		expect(parseClipboardTokens(`  ${USER_TOKEN}  `)).toEqual([USER_TOKEN]);
		expect(parseClipboardTokens(`bearer ${USER_TOKEN}`)).toEqual([USER_TOKEN]);
	});

	it('reads a pasted deep link and keeps every candidate', () => {
		const link = buildTokenDeepLink([REVOKED_LONG_TOKEN, WORKSPACE_TOKEN]);
		expect(parseClipboardTokens(link)).toEqual([
			REVOKED_LONG_TOKEN,
			WORKSPACE_TOKEN,
		]);
	});

	it('reads a pasted legacy single-token deep link', () => {
		expect(
			parseClipboardTokens(
				`${TOKEN_DEEP_LINK_BASE}?token=${encodeURIComponent(USER_TOKEN)}`,
			),
		).toEqual([USER_TOKEN]);
	});

	it('tolerates surrounding whitespace and scheme casing on a deep link', () => {
		const link = buildTokenDeepLink([USER_TOKEN]);
		expect(parseClipboardTokens(`\n ${link.toUpperCase().slice(0, 10)}${link.slice(10)} `)).toEqual(
			[USER_TOKEN],
		);
	});

	it('returns nothing for empty or absurdly large clipboard content', () => {
		expect(parseClipboardTokens('')).toEqual([]);
		expect(parseClipboardTokens('   ')).toEqual([]);
		expect(parseClipboardTokens('x'.repeat(100_000))).toEqual([]);
	});
});

describe('isCredentialRejection', () => {
	it('treats a rejected token as the candidate’s fault', () => {
		expect(
			isCredentialRejection(
				new PlaudAuthError('token_rejected', 'dead', '/file/simple/web'),
			),
		).toBe(true);
	});

	it('treats an in-band error as the candidate’s fault', () => {
		expect(
			isCredentialRejection(
				new PlaudApiError('in-band', undefined, '/file/simple/web', -3901),
			),
		).toBe(true);
	});

	it('does not blame the candidate for a missing token, network, rate limit, or parse failure', () => {
		expect(
			isCredentialRejection(new PlaudAuthError('not_configured', 'none')),
		).toBe(false);
		expect(isCredentialRejection(new PlaudApiError('network error'))).toBe(
			false,
		);
		expect(isCredentialRejection(new PlaudApiError('429', 429))).toBe(false);
		expect(isCredentialRejection(new PlaudParseError('bad shape'))).toBe(false);
		expect(isCredentialRejection(new Error('boom'))).toBe(false);
	});
});

describe('selectWorkingCandidate', () => {
	const rejected = (): never => {
		throw new PlaudAuthError('token_rejected', 'dead', '/file/simple/web');
	};
	const inBand = (status: number): never => {
		throw new PlaudApiError('in-band', undefined, '/file/simple/web', status);
	};

	it('selects the first candidate Plaud accepts', async () => {
		const probed: string[] = [];
		const result = await selectWorkingCandidate(
			[USER_TOKEN, WORKSPACE_TOKEN],
			async (token) => {
				probed.push(token);
			},
			NOW_MS,
		);
		expect(result.outcome).toBe('selected');
		expect(result.token).toBe(USER_TOKEN);
		// Short-circuits: the second candidate is never probed.
		expect(probed).toEqual([USER_TOKEN]);
	});

	it('falls through an in-band -3900 to the next candidate', async () => {
		// The rogerfsh case in miniature: the long-lived token is revoked, the
		// workspace token behind it is the live one.
		const probed: string[] = [];
		const result = await selectWorkingCandidate(
			[REVOKED_LONG_TOKEN, WORKSPACE_TOKEN],
			async (token) => {
				probed.push(token);
				if (token === REVOKED_LONG_TOKEN) {
					inBand(-3900);
				}
			},
			NOW_MS,
		);
		expect(result.outcome).toBe('selected');
		expect(result.token).toBe(WORKSPACE_TOKEN);
		expect(probed).toEqual([REVOKED_LONG_TOKEN, WORKSPACE_TOKEN]);
	});

	it('reports all-rejected when every candidate is refused', async () => {
		const result = await selectWorkingCandidate(
			[USER_TOKEN, WORKSPACE_TOKEN],
			async () => rejected(),
			NOW_MS,
		);
		expect(result.outcome).toBe('all-rejected');
		expect(result.token).toBeNull();
		expect(result.usable).toEqual([USER_TOKEN, WORKSPACE_TOKEN]);
	});

	it('aborts on a network failure instead of convicting every candidate', async () => {
		const probed: string[] = [];
		const boom = new PlaudApiError('Plaud API network error: offline');
		const result = await selectWorkingCandidate(
			[USER_TOKEN, WORKSPACE_TOKEN],
			async (token) => {
				probed.push(token);
				throw boom;
			},
			NOW_MS,
		);
		expect(result.outcome).toBe('unreachable');
		expect(result.error).toBe(boom);
		// Only the first candidate is tried; the rest are not ruled out.
		expect(probed).toEqual([USER_TOKEN]);
		expect(result.usable).toEqual([USER_TOKEN, WORKSPACE_TOKEN]);
	});

	it('filters unusable candidates before probing anything', async () => {
		const probed: string[] = [];
		const result = await selectWorkingCandidate(
			[PROFILE_JWT, REFRESH_TOKEN, EXPIRED_TOKEN, USER_TOKEN],
			async (token) => {
				probed.push(token);
			},
			NOW_MS,
		);
		expect(probed).toEqual([USER_TOKEN]);
		expect(result.token).toBe(USER_TOKEN);
	});

	it('reports none-usable without probing when nothing passes the guard', async () => {
		const probe = jest.fn(async () => undefined);
		const result = await selectWorkingCandidate(
			[PROFILE_JWT, REFRESH_TOKEN],
			probe,
			NOW_MS,
		);
		expect(result.outcome).toBe('none-usable');
		expect(probe).not.toHaveBeenCalled();
	});
});

// The bookmarklet is a hand-minified copy of collectTokenCandidates +
// buildTokenDeepLink that cannot import them (it runs as a javascript: URL in
// the user's browser). These tests execute the SHIPPED string against the same
// fixtures and assert the two agree, so the copy cannot drift silently.
describe('SIGN_IN_BOOKMARKLET', () => {
	interface BookmarkletRun {
		alerts: string[];
		prompts: Array<{ message: string; value: string }>;
		href: string | null;
	}

	function runBookmarklet(
		map: Record<string, string>,
		options: { hostname?: string; hasFocus?: boolean; nowMs?: number } = {},
	): BookmarkletRun {
		const nowMs = options.nowMs ?? NOW_MS;
		const keys = Object.keys(map);
		const run: BookmarkletRun = { alerts: [], prompts: [], href: null };
		const localStorage = {
			get length(): number {
				return keys.length;
			},
			key: (i: number): string | null => keys[i] ?? null,
			getItem: (k: string): string | null =>
				Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null,
		};
		const location = {
			hostname: options.hostname ?? 'web.plaud.ai',
			// replace(), not an href setter: the shipped bookmarklet must not
			// push a token-bearing URL into browser history. A stub with no
			// href setter also means a regression back to `location.href = u`
			// silently sets a dead property and fails these tests.
			replace: (value: string): void => {
				run.href = value;
			},
		};
		const doc = { hasFocus: (): boolean => options.hasFocus ?? true };
		// The deferred fallback prompt runs immediately here so its arguments
		// can be asserted; the shipped delay is 1500ms.
		const timeout = (fn: () => void): number => {
			fn();
			return 0;
		};
		// Executed in a fresh vm context rather than through the Function
		// constructor, which the scorecard ruleset bans outright. The context
		// gets only the browser globals the bookmarklet is allowed to touch, so
		// a reach for anything else fails the test instead of passing quietly.
		// `atob` is a Node global, not a JS intrinsic, so it must be injected.
		// `Date` is stubbed to the same fixed clock the reference helpers are
		// given: the fixtures expire in 2027, and reading the wall clock here
		// would turn every live-token assertion into a time bomb.
		runInNewContext(SIGN_IN_BOOKMARKLET.slice(BOOKMARKLET_SCHEME.length), {
			location,
			localStorage,
			document: doc,
			atob,
			Date: { now: () => nowMs },
			alert: (message: string) => run.alerts.push(message),
			prompt: (message: string, value: string) =>
				run.prompts.push({ message, value }),
			setTimeout: timeout,
		});
		return run;
	}

	it('survives HTML-attribute escaping intact, entity for entity', () => {
		// The setup page embeds the bookmarklet in an href, so a browser will
		// entity-decode it back before the user's bookmark ever runs it. Decode
		// in the reverse order (&amp; LAST) and the original must come back
		// byte for byte, or the dragged bookmark is subtly corrupt.
		const escaped = escapeHtmlAttribute(SIGN_IN_BOOKMARKLET);
		const decoded = escaped
			.replace(/&#39;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&gt;/g, '>')
			.replace(/&lt;/g, '<')
			.replace(/&amp;/g, '&');
		expect(decoded).toBe(SIGN_IN_BOOKMARKLET);
	});

	it('cannot break out of the attribute it is embedded in', () => {
		const escaped = escapeHtmlAttribute(SIGN_IN_BOOKMARKLET);
		expect(escaped).not.toContain('"');
		expect(escaped).not.toContain("'");
		expect(escaped).not.toContain('<');
		expect(escaped).not.toContain('>');
	});

	it('is a single line with no backslashes, so it pastes as a bookmark URL', () => {
		expect(SIGN_IN_BOOKMARKLET).not.toContain('\n');
		expect(SIGN_IN_BOOKMARKLET).not.toContain('\\');
		expect(SIGN_IN_BOOKMARKLET.startsWith(BOOKMARKLET_SCHEME)).toBe(true);
	});

	it('refuses to run off a Plaud origin', () => {
		const run = runBookmarklet({ token: USER_TOKEN }, {
			hostname: 'evil.example.com',
		});
		expect(run.href).toBeNull();
		expect(run.prompts).toEqual([]);
		expect(run.alerts).toHaveLength(1);
	});

	it('accepts the apex domain and subdomains', () => {
		expect(
			runBookmarklet({ token: USER_TOKEN }, { hostname: 'plaud.ai' }).href,
		).not.toBeNull();
		expect(
			runBookmarklet({ token: USER_TOKEN }, { hostname: 'WEB.Plaud.AI' }).href,
		).not.toBeNull();
		// Suffix match must not accept a lookalike registrable domain.
		expect(
			runBookmarklet({ token: USER_TOKEN }, { hostname: 'notplaud.ai' }).href,
		).toBeNull();
	});

	it.each([
		[
			'primary key plus a workspace token',
			{ pld_ws1: WORKSPACE_TOKEN, token: USER_TOKEN, theme: 'dark' },
		],
		[
			'no primary key at all (the rogerfsh shape)',
			{ pld_ws1: WORKSPACE_TOKEN, tokenstr: REVOKED_LONG_TOKEN, userInfo: PROFILE_JWT },
		],
		[
			'refresh token, expired token, and junk mixed in',
			{
				refresh: REFRESH_TOKEN,
				stale: EXPIRED_TOKEN,
				token: `bearer ${USER_TOKEN}`,
				n: '42',
			},
		],
		['duplicates under different keys', { token: USER_TOKEN, copy: USER_TOKEN }],
	])('matches collectTokenCandidates for %s', (_name, map) => {
		const expected = collectTokenCandidates(entries(map), NOW_MS);
		expect(runBookmarklet(map).href).toBe(buildTokenDeepLink(expected));
	});

	it('never dead-ends: a miss offers a diagnostic instead of only an alert', () => {
		// 0.35.0 alerted and returned here, leaving the user with nothing at all
		// - strictly worse than the pre-deep-link bookmarklet, which at least
		// showed something to paste. A miss must now always hand back something
		// actionable.
		const run = runBookmarklet({ userInfo: PROFILE_JWT, stale: EXPIRED_TOKEN });
		expect(run.href).toBeNull();
		expect(run.alerts).toEqual([]);
		expect(run.prompts).toHaveLength(1);
		const payload = run.prompts[0].value;
		expect(payload.startsWith('plaud-capture-miss')).toBe(true);
		// Shapes only. The profile JWT carries {email,id,name} and the diagnostic
		// is something users paste into public issues, so no token segment and no
		// claim VALUE may appear in it.
		expect(payload).not.toContain(PROFILE_JWT.split('.')[1]);
		expect(payload).not.toContain(EXPIRED_TOKEN.split('.')[1]);
		expect(payload).toContain('keys=2');
	});

	it('never copies an untrusted JWT typ into the shareable diagnostic', () => {
		// `typ` is attacker/vendor-controlled text from a decoded header, and the
		// diagnostic is something the user is explicitly told is safe to send on.
		// Only the known categories may appear.
		const weird = makeJwt(
			{ alg: 'HS256', typ: 'secret-internal-tenant-42' },
			{ sub: 'u1', client_id: 'web' },
		);
		const run = runBookmarklet({ pld_odd: weird });
		const payload = run.prompts[0].value;
		expect(payload).not.toContain('tenant-42');
		expect(payload).toContain('other');
	});

	it('offers the whole deep link to copy when the page keeps focus', () => {
		// Not just the first candidate: the paste path has to be able to choose
		// between them too, or the fallback saves a revoked token on the very
		// accounts this release exists for.
		const run = runBookmarklet({ pld_ws1: WORKSPACE_TOKEN, token: USER_TOKEN });
		expect(run.prompts).toHaveLength(1);
		expect(run.prompts[0].value).toBe(run.href);
		expect(parseClipboardTokens(run.prompts[0].value)).toEqual([
			USER_TOKEN,
			WORKSPACE_TOKEN,
		]);
	});

	it('reads the clock it is given, so these fixtures cannot age out', () => {
		// Pins the injected Date: at a clock past every fixture's exp the same
		// storage yields nothing. Without the injection this suite would start
		// failing on its own in 2027 with the code unchanged.
		const map = { token: USER_TOKEN };
		expect(runBookmarklet(map).href).not.toBeNull();
		const later = runBookmarklet(map, { nowMs: (FUTURE_EXP + 1) * 1000 });
		expect(later.href).toBeNull();
		expect(later.prompts[0].value.startsWith('plaud-capture-miss')).toBe(true);
	});

	it('stays silent when the deep link took focus away', () => {
		const run = runBookmarklet({ token: USER_TOKEN }, { hasFocus: false });
		expect(run.href).not.toBeNull();
		expect(run.prompts).toEqual([]);
	});

	it('produces a link the deep-link parser reads back unchanged', () => {
		const map = { pld_ws1: WORKSPACE_TOKEN, token: USER_TOKEN };
		const href = runBookmarklet(map).href ?? '';
		const query = href.slice(href.indexOf('?') + 1);
		const params = Object.fromEntries(new URLSearchParams(query));
		expect(parseTokenCandidates(params)).toEqual([USER_TOKEN, WORKSPACE_TOKEN]);
	});
});
