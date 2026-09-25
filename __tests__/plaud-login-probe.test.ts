import { runInNewContext } from 'vm';

import { PROBE_JS, normalizeApiDomain } from '../plaud-login';
import { isUsableUserToken } from '../plaud-token';
import {
	MAX_COLLECTED_CANDIDATES,
	collectTokenCandidates,
} from '../token-candidates';
import { at, defined } from './helpers/checked';

// Executes the SHIPPED probe string against fixtures, the same way the
// bookmarklet parity tests do. The probe cannot import the shared collector (it
// runs via executeJavaScript inside the sign-in window), so it is a hand-written
// twin, and a twin that nothing executes is free to drift. 0.35.0 shipped a
// capture path that 1092 passing tests missed for exactly that reason.

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function makeJwt(header: unknown, payload: unknown): string {
	return `${b64url(header)}.${b64url(payload)}.sig`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 24 * 3600;

// A web workspace token (typ WT) for workspace `ws_<n>`.
const workspaceTokenFor = (n: number): string =>
	makeJwt(
		{ alg: 'HS256', typ: 'WT' },
		{
			sub: 'u1',
			exp: FUTURE_EXP,
			client_id: 'web',
			wid: `ws_${n}`,
		},
	);
const PAST_EXP = Math.floor(Date.now() / 1000) - 3600;

// Shapes read first-party off a real account on 2026-07-26. The workspace token
// probed in-band status 0; the refresh token beside it probed -3901.
const WORKSPACE_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{
		sub: 'u1',
		exp: FUTURE_EXP,
		iat: FUTURE_EXP - 24 * 3600,
		client_id: 'web',
		wid: 'ws-1',
	},
);
const REFRESH_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WRT' },
	{ sub: 'u1', exp: FUTURE_EXP + 700 * 3600, client_id: 'web', wid: 'ws-1' },
);
const PROFILE_JWT = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ email: 'a@b.com', id: 'u1', name: 'A B' },
);
const LONG_LIVED_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{
		sub: 'u1',
		exp: FUTURE_EXP + 300 * 24 * 3600,
		iat: FUTURE_EXP,
		client_id: 'web',
		region: 'us',
	},
);
const EXPIRED_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ sub: 'u1', exp: PAST_EXP, client_id: 'web' },
);

/** The real account shape: no `token` key, credential nested in workspaceList. */
const CURRENT_WEB_APP: Record<string, string> = {
	pld_loginMethod: '"email"',
	pld_pweblang: '"en-US"',
	'pld_abc:frillSsoToken': PROFILE_JWT,
	'pld_abc:currentWorkspaceId': 'ws_clF1vOqcHS',
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
	'chakra-ui-color-mode': 'dark',
};

interface ProbeOut {
	tokens?: string[];
	refreshTokens?: string[];
	domain?: string | null;
	workspaceId?: string | null;
	deviceId?: string | null;
	href?: string;
	error?: string;
}

function runProbe(
	map: Record<string, string>,
	href = 'https://web.plaud.ai/',
): ProbeOut {
	const keys = Object.keys(map);
	const url = new URL(href);
	const sandbox = {
		location: { hostname: url.hostname, protocol: url.protocol, href },
		localStorage: {
			get length(): number {
				return keys.length;
			},
			key: (i: number): string | null => keys[i] ?? null,
			getItem: (k: string): string | null =>
				Object.prototype.hasOwnProperty.call(map, k)
					? (map[k] ?? null)
					: null,
		},
		JSON,
		// The probe applies the claim guard in-page now, so the sandbox has to
		// offer the same primitives the real sign-in window does.
		atob,
		Date,
	};
	return JSON.parse(runInNewContext(PROBE_JS, sandbox) as string) as ProbeOut;
}

/** What the window would actually settle on: the plugin's own guard. */
function usableFrom(out: ProbeOut): string[] {
	return (out.tokens ?? []).filter((value) => isUsableUserToken(value));
}

// A second workspace, whose token is equally valid FOR ITS OWN WORKSPACE and so
// would pass every probe. Ordering is the only thing that keeps imports pointed
// at the workspace the user is actually in.
const OTHER_WORKSPACE_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{
		sub: 'u1',
		exp: FUTURE_EXP,
		iat: FUTURE_EXP - 24 * 3600,
		client_id: 'web',
		wid: 'ws-other',
	},
);

describe('PROBE_JS on a multi-workspace account', () => {
	const MULTI: Record<string, string> = {
		'pld_abc:currentWorkspaceId': 'ws_clF1vOqcHS',
		'pld_abc:workspaceList': JSON.stringify([
			{
				workspaceId: 'ws_other',
				name: 'Team',
				workspaceToken: OTHER_WORKSPACE_TOKEN,
			},
			{
				workspaceId: 'ws_clF1vOqcHS',
				name: 'Personal',
				workspaceToken: WORKSPACE_TOKEN,
			},
		]),
	};

	it('offers the ACTIVE workspace token first, not array order', () => {
		// Without this, selection takes the first workspace that probes OK and
		// imports silently target the wrong workspace's recordings.
		expect(usableFrom(runProbe(MULTI))[0]).toBe(WORKSPACE_TOKEN);
	});

	it('still degrades to plain collection when the hint is missing', () => {
		const noHint = {
			'pld_abc:workspaceList': defined(MULTI['pld_abc:workspaceList']),
		};
		expect(usableFrom(runProbe(noHint)).length).toBeGreaterThan(0);
	});

	it('quotes around the stored id do not defeat the match', () => {
		const quoted = {
			...MULTI,
			'pld_abc:currentWorkspaceId': '"ws_clF1vOqcHS"',
		};
		expect(usableFrom(runProbe(quoted))[0]).toBe(WORKSPACE_TOKEN);
	});
});

// The probe caps how many candidates it collects, and so does the shared
// collector it is a twin of. Those two caps disagreeing is not cosmetic: every
// collected candidate is later sent to Plaud as a bearer token during probing,
// and section 2.5 measured a server-side ceiling of 10 sign-in calls per hour.
// A probe that collects more than the reference spends that budget on values
// the reference already decided were surplus. 0.35.3 shipped the twin capped at
// 8 against a reference of 5. Constant drift between a hand-written twin and
// its reference is the exact bug class that shipped 0.35.0 capturing nothing,
// so the cap is pinned by execution here rather than by review.
describe('PROBE_JS candidate cap', () => {
	/** More distinct, individually valid workspace tokens than either cap. */
	const OVERSIZED: Record<string, string> = {};
	for (let i = 0; i < MAX_COLLECTED_CANDIDATES + 4; i++) {
		OVERSIZED[`pld_abc:slot${i}`] = makeJwt(
			{ alg: 'HS256', typ: 'WT' },
			{
				sub: 'u1',
				exp: FUTURE_EXP,
				iat: FUTURE_EXP - 24 * 3600,
				client_id: 'web',
				wid: `ws-${i}`,
			},
		);
	}

	it('stops at MAX_COLLECTED_CANDIDATES, not a literal of its own', () => {
		expect(runProbe(OVERSIZED).tokens).toHaveLength(
			MAX_COLLECTED_CANDIDATES,
		);
	});

	it('collects exactly as many as the reference collector does', () => {
		const reference = collectTokenCandidates(
			Object.entries(OVERSIZED).map(([key, value]) => ({ key, value })),
		);
		expect(runProbe(OVERSIZED).tokens).toHaveLength(reference.length);
	});

	it('agrees with the plugin guard on a non-finite exp', () => {
		// JSON.parse turns an exp of 1e400 into Infinity, which passes a bare
		// "is it in the future" test but fails isUsableUserToken's
		// Number.isFinite. Counting it would spend a cap slot on a value the
		// plugin was always going to discard, which is the same starvation the
		// cap parity above exists to prevent.
		// Written as raw JSON, not a numeric literal: the value only exists as
		// Infinity once JSON.parse has read it, which is exactly how it would
		// arrive off a hostile or corrupt localStorage entry.
		const infinite = `${b64url({ alg: 'HS256', typ: 'WT' })}.${Buffer.from(
			'{"sub":"u1","client_id":"web","exp":1e400}',
		).toString('base64url')}.sig`;
		expect(isUsableUserToken(infinite)).toBe(false);
		expect(runProbe({ 'pld_abc:odd': infinite }).tokens).toHaveLength(0);
	});

	it('does not let unusable JWTs burn the cap ahead of the credential', () => {
		// The cap counts what the plugin would ACCEPT, not what merely looks
		// like a JWT. A shape-only cap regresses here: these decoys are all
		// JWT-shaped and sort ahead of workspaceList, so they would fill the
		// list and startPolling (which applies isUsableUserToken only AFTER the
		// probe returns) would see nothing usable and poll forever.
		const decoyed: Record<string, string> = {};
		for (let i = 0; i < MAX_COLLECTED_CANDIDATES + 3; i++) {
			decoyed[`pld_abc:decoy${i}`] = at(
				[REFRESH_TOKEN, PROFILE_JWT, EXPIRED_TOKEN],
				i % 3,
			);
		}
		decoyed['pld_abc:workspaceList'] = JSON.stringify([
			{ workspaceId: 'ws_clF1vOqcHS', workspaceToken: WORKSPACE_TOKEN },
		]);
		expect(usableFrom(runProbe(decoyed))).toContain(WORKSPACE_TOKEN);
	});
});

describe('PROBE_JS against the current Plaud web app', () => {
	it('finds the credential nested inside workspaceList', () => {
		// The 0.35.2 regression: a top-level-only read returns nothing here, so
		// the window polls forever and email sign-in never completes.
		const usable = usableFrom(runProbe(CURRENT_WEB_APP));
		expect(usable).toEqual([WORKSPACE_TOKEN]);
	});

	it('never settles on the 30-day refresh token beside it', () => {
		// Probed live: this value answers -3901. It also outlives the credential,
		// so any longest-expiry preference would pick exactly the wrong one.
		expect(usableFrom(runProbe(CURRENT_WEB_APP))).not.toContain(
			REFRESH_TOKEN,
		);
	});

	it('never settles on the profile JWT holding email, id, and name', () => {
		expect(usableFrom(runProbe(CURRENT_WEB_APP))).not.toContain(
			PROFILE_JWT,
		);
	});

	it('still prefers a plain `token` key when one exists', () => {
		// The widening must stay additive: if Plaud ever restores the long-lived
		// token, it is read first and wins selection.
		const withLegacy = { ...CURRENT_WEB_APP, token: LONG_LIVED_TOKEN };
		expect(usableFrom(runProbe(withLegacy))[0]).toBe(LONG_LIVED_TOKEN);
	});

	it('does not let ordinary pld_ settings crowd out the credential', () => {
		// Regression: an unvalidated add() filled the candidate cap with plain
		// strings before the walk reached workspaceList, so nothing was captured.
		const noisy: Record<string, string> = { ...CURRENT_WEB_APP };
		for (let i = 0; i < 40; i += 1) {
			noisy[`pld_setting_${i}`] = `value-${i}`;
		}
		expect(usableFrom(runProbe(noisy))).toEqual([WORKSPACE_TOKEN]);
	});

	it('ignores third-party JWTs, wrapped in JSON or bare at top level', () => {
		// Candidates are probed against Plaud, so collecting another service's
		// JWT would hand Plaud that credential. The earlier version of this test
		// only covered the JSON-wrapped case and so passed for the wrong reason:
		// a bare top-level foreign token was still being collected.
		const foreign = {
			...CURRENT_WEB_APP,
			ph_phc_abc_posthog: JSON.stringify({
				auth: { jwt: LONG_LIVED_TOKEN },
			}),
			'sb-access-token': LONG_LIVED_TOKEN,
			ph_token: OTHER_WORKSPACE_TOKEN,
		};
		expect(usableFrom(runProbe(foreign))).toEqual([WORKSPACE_TOKEN]);
	});

	it('rejects an expired leftover', () => {
		expect(
			usableFrom(
				runProbe({ token: EXPIRED_TOKEN, pld_x: EXPIRED_TOKEN }),
			),
		).toEqual([]);
	});

	it('captures nothing while signed out, so the window keeps waiting', () => {
		// Sign-out strips the credentials but leaves the key shells behind.
		const signedOut: Record<string, string> = {
			pld_loginMethod: '"email"',
			'pld_abc:frillSsoToken': PROFILE_JWT,
			'pld_abc:workspaceList': JSON.stringify([
				{
					workspaceId: 'ws_clF1vOqcHS',
					name: 'Personal',
					role: 'owner',
				},
			]),
		};
		expect(usableFrom(runProbe(signedOut))).toEqual([]);
	});

	it('reads nothing at all off a non-Plaud origin', () => {
		// The window can be redirected mid-login; localStorage elsewhere is never
		// a token source, whatever the claim guard would say about it.
		const out = runProbe(CURRENT_WEB_APP, 'https://evil.example.com/');
		expect(out.tokens).toEqual([]);
	});

	it('reads nothing over plain http', () => {
		const out = runProbe(CURRENT_WEB_APP, 'http://web.plaud.ai/');
		expect(out.tokens).toEqual([]);
	});
});

describe('PROBE_JS v4 scope capture', () => {
	it('returns the cleaned workspace id, device id, and api domain', () => {
		const map: Record<string, string> = {
			...CURRENT_WEB_APP,
			// Real portal quotes these JSON-string values; the probe strips quotes.
			'pld_abc:currentWorkspaceId': '"ws_f8EANnTZa8"',
			pld_DEVICE_ID: '"1bfbd3b642c68958"',
			pld_plaud_user_api_domain:
				'{"domain":"https://api-staging-apne1.plaud.ai","timestamp":123}',
		};
		const out = runProbe(map, 'https://alpha.plaud.ai/');
		expect(out.workspaceId).toBe('ws_f8EANnTZa8');
		expect(out.deviceId).toBe('1bfbd3b642c68958');
		// domain is returned raw (the JSON blob); normalizeApiDomain unwraps it.
		expect(out.domain).toContain('api-staging-apne1.plaud.ai');
	});

	it('returns null scope when the keys are absent', () => {
		const out = runProbe(CURRENT_WEB_APP, 'https://alpha.plaud.ai/');
		// CURRENT_WEB_APP has an unquoted currentWorkspaceId and no device id.
		expect(out.workspaceId).toBe('ws_clF1vOqcHS');
		expect(out.deviceId).toBeNull();
	});
});

describe('normalizeApiDomain', () => {
	it('unwraps the new portal JSON object form to the inner domain', () => {
		expect(
			normalizeApiDomain(
				'{"domain":"https://api-staging-apne1.plaud.ai","timestamp":123}',
			),
		).toBe('https://api-staging-apne1.plaud.ai');
	});

	it('still accepts a bare host string (prod form)', () => {
		expect(normalizeApiDomain('api-euc1.plaud.ai')).toBe(
			'https://api-euc1.plaud.ai',
		);
	});

	it('accepts the alpha v4 theplaud.com host so the region auto-detects', () => {
		// The exact value the alpha portal caches. Before the host allowlists
		// were unified this was rejected here, so the region never auto-filled
		// and had to be entered by hand. Both the JSON-object and bare forms.
		expect(
			normalizeApiDomain(
				'{"domain":"https://api-apne1.staging.theplaud.com","timestamp":123}',
			),
		).toBe('https://api-apne1.staging.theplaud.com');
		expect(normalizeApiDomain('api-apne1.staging.theplaud.com')).toBe(
			'https://api-apne1.staging.theplaud.com',
		);
	});

	it('rejects a JSON object whose inner domain is a non-plaud host', () => {
		expect(
			normalizeApiDomain('{"domain":"https://evil.example.com"}'),
		).toBeNull();
	});

	it('rejects malformed JSON and empty input', () => {
		expect(normalizeApiDomain('{not json')).toBeNull();
		expect(normalizeApiDomain('')).toBeNull();
		expect(normalizeApiDomain(null)).toBeNull();
	});
});

describe('PROBE_JS API-domain resolution', () => {
	const WS = 'ws_clF1vOqcHS';

	it('falls back to the active workspace domain when the api-domain key is absent (beta)', () => {
		// Beta has NO pld_plaud_user_api_domain key; the resolved host lives only
		// on the active workspace. The probe must still surface it so the region
		// auto-detects instead of falling back to the prod default.
		const beta: Record<string, string> = {
			'pld_abc:currentWorkspaceId': WS,
			'pld_abc:workspaceList': JSON.stringify([
				{
					workspaceId: WS,
					workspaceToken: WORKSPACE_TOKEN,
					domain: 'https://api-test.plaud.ai',
				},
			]),
		};
		expect(runProbe(beta, 'https://beta.plaud.ai/').domain).toBe(
			'https://api-test.plaud.ai',
		);
	});

	it('prefers the pld_plaud_user_api_domain key over the workspace domain (alpha)', () => {
		const alpha: Record<string, string> = {
			pld_plaud_user_api_domain:
				'{"domain":"https://api-apne1.staging.theplaud.com","timestamp":1}',
			'pld_abc:currentWorkspaceId': WS,
			'pld_abc:workspaceList': JSON.stringify([
				{
					workspaceId: WS,
					workspaceToken: WORKSPACE_TOKEN,
					domain: 'https://api-test.plaud.ai',
				},
			]),
		};
		// The probe returns the raw key value; normalizeApiDomain unwraps it.
		expect(runProbe(alpha, 'https://alpha.plaud.ai/').domain).toBe(
			'{"domain":"https://api-apne1.staging.theplaud.com","timestamp":1}',
		);
	});
});

describe('PROBE_JS v4 refresh token capture', () => {
	// A ws_ workspace token and its matching ws_ refresh token, in the shipped 4.0
	// workspaceTokens map shape (token + refreshToken keyed by workspace id).
	const V4_WT = makeJwt(
		{ alg: 'HS256', typ: 'WT' },
		{ sub: 'u1', exp: FUTURE_EXP, client_id: 'web', wid: 'ws_f8EANnTZa8' },
	);
	const V4_REFRESH = makeJwt(
		{ alg: 'HS256', typ: 'WRT' },
		{
			sub: 'u1',
			exp: FUTURE_EXP + 700 * 3600,
			client_id: 'web',
			wid: 'ws_f8EANnTZa8',
		},
	);

	it('collects the v4 refresh token beside the workspace token', () => {
		const out = runProbe({
			'pld_u1:currentWorkspaceId': '"ws_f8EANnTZa8"',
			'pld_u1:workspaceTokens': JSON.stringify({
				ws_f8EANnTZa8: { token: V4_WT, refreshToken: V4_REFRESH },
			}),
		});
		expect(out.tokens).toContain(V4_WT);
		expect(out.refreshTokens).toEqual([V4_REFRESH]);
	});

	it('never collects a workspace refresh token that carries no ws_ wid', () => {
		// REFRESH_TOKEN's wid is `ws-1` (hyphen), not a v4 `ws_` workspace, so it
		// is not a v4 refresh token and must not be captured.
		const out = runProbe(CURRENT_WEB_APP);
		expect(out.refreshTokens).toEqual([]);
	});

	it('returns an empty refresh list for a v3 sign-in with no refresh token', () => {
		const out = runProbe({ token: LONG_LIVED_TOKEN });
		expect(out.refreshTokens).toEqual([]);
	});

	it('hoists the ACTIVE workspace refresh token ahead of the small cap on a 3+ workspace account', () => {
		// The active workspace is third. Without hoisting, the generic walk fills
		// the 2-slot refresh cap with the first two workspaces' tokens and the
		// active one is lost, so the store would find no match and disable renewal.
		const refreshFor = (n: number): string =>
			makeJwt(
				{ alg: 'HS256', typ: 'WRT' },
				{ sub: 'u1', exp: FUTURE_EXP + 700 * 3600, wid: `ws_${n}` },
			);
		const tokenFor = workspaceTokenFor;
		const out = runProbe({
			'pld_u1:currentWorkspaceId': '"ws_3"',
			'pld_u1:workspaceTokens': JSON.stringify({
				ws_1: { token: tokenFor(1), refreshToken: refreshFor(1) },
				ws_2: { token: tokenFor(2), refreshToken: refreshFor(2) },
				ws_3: { token: tokenFor(3), refreshToken: refreshFor(3) },
			}),
		});
		// The active workspace's WT is offered first (existing behavior)...
		expect(out.tokens?.[0]).toBe(tokenFor(3));
		// ...and its refresh token is captured, at the front, despite the cap.
		expect(out.refreshTokens).toContain(refreshFor(3));
		expect(out.refreshTokens?.[0]).toBe(refreshFor(3));
	});

	it('captures a refresh token even when the access-token cap fills first', () => {
		// No currentWorkspaceId, so no hoist: the shared walk must keep scanning
		// past the access-token cap to reach the refresh token behind it.
		const wt = workspaceTokenFor;
		const map: Record<string, string> = {
			'pld_a:t': wt(1),
			'pld_b:t': wt(2),
			'pld_c:t': wt(3),
			'pld_d:t': wt(4),
			'pld_e:t': wt(5),
			'pld_f:r': makeJwt(
				{ alg: 'HS256', typ: 'WRT' },
				{ sub: 'u1', exp: FUTURE_EXP + 700 * 3600, wid: 'ws_6' },
			),
		};
		const out = runProbe(map);
		expect(out.tokens).toHaveLength(MAX_COLLECTED_CANDIDATES);
		expect(out.refreshTokens?.length).toBeGreaterThan(0);
	});
});
