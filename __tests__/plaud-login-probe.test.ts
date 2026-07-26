import { runInNewContext } from 'vm';

import { PROBE_JS } from '../plaud-login';
import { isUsableUserToken } from '../plaud-token';
import { MAX_COLLECTED_CANDIDATES, collectTokenCandidates } from '../token-candidates';

// Executes the SHIPPED probe string against fixtures, the same way the
// bookmarklet parity tests do. The probe cannot import the shared collector (it
// runs via executeJavaScript inside the sign-in window), so it is a hand-written
// twin, and a twin that nothing executes is free to drift. 0.35.0 shipped a
// capture path that 1092 passing tests missed for exactly that reason.

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

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 24 * 3600;
const PAST_EXP = Math.floor(Date.now() / 1000) - 3600;

// Shapes read first-party off a real account on 2026-07-26. The workspace token
// probed in-band status 0; the refresh token beside it probed -3901.
const WORKSPACE_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ sub: 'u1', exp: FUTURE_EXP, iat: FUTURE_EXP - 24 * 3600, client_id: 'web', wid: 'ws-1' },
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
	{ sub: 'u1', exp: FUTURE_EXP + 300 * 24 * 3600, iat: FUTURE_EXP, client_id: 'web', region: 'us' },
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
	domain?: string | null;
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
				Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null,
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
	{ sub: 'u1', exp: FUTURE_EXP, iat: FUTURE_EXP - 24 * 3600, client_id: 'web', wid: 'ws-other' },
);

describe('PROBE_JS on a multi-workspace account', () => {
	const MULTI: Record<string, string> = {
		'pld_abc:currentWorkspaceId': 'ws_clF1vOqcHS',
		'pld_abc:workspaceList': JSON.stringify([
			{ workspaceId: 'ws_other', name: 'Team', workspaceToken: OTHER_WORKSPACE_TOKEN },
			{ workspaceId: 'ws_clF1vOqcHS', name: 'Personal', workspaceToken: WORKSPACE_TOKEN },
		]),
	};

	it('offers the ACTIVE workspace token first, not array order', () => {
		// Without this, selection takes the first workspace that probes OK and
		// imports silently target the wrong workspace's recordings.
		expect(usableFrom(runProbe(MULTI))[0]).toBe(WORKSPACE_TOKEN);
	});

	it('still degrades to plain collection when the hint is missing', () => {
		const noHint = { 'pld_abc:workspaceList': MULTI['pld_abc:workspaceList'] };
		expect(usableFrom(runProbe(noHint)).length).toBeGreaterThan(0);
	});

	it('quotes around the stored id do not defeat the match', () => {
		const quoted = { ...MULTI, 'pld_abc:currentWorkspaceId': '"ws_clF1vOqcHS"' };
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
		expect(runProbe(OVERSIZED).tokens).toHaveLength(MAX_COLLECTED_CANDIDATES);
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
		)
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')}.sig`;
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
			decoyed[`pld_abc:decoy${i}`] = [REFRESH_TOKEN, PROFILE_JWT, EXPIRED_TOKEN][i % 3];
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
		expect(usableFrom(runProbe(CURRENT_WEB_APP))).not.toContain(REFRESH_TOKEN);
	});

	it('never settles on the profile JWT holding email, id, and name', () => {
		expect(usableFrom(runProbe(CURRENT_WEB_APP))).not.toContain(PROFILE_JWT);
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
			ph_phc_abc_posthog: JSON.stringify({ auth: { jwt: LONG_LIVED_TOKEN } }),
			'sb-access-token': LONG_LIVED_TOKEN,
			ph_token: OTHER_WORKSPACE_TOKEN,
		};
		expect(usableFrom(runProbe(foreign))).toEqual([WORKSPACE_TOKEN]);
	});

	it('rejects an expired leftover', () => {
		expect(
			usableFrom(runProbe({ token: EXPIRED_TOKEN, pld_x: EXPIRED_TOKEN })),
		).toEqual([]);
	});

	it('captures nothing while signed out, so the window keeps waiting', () => {
		// Sign-out strips the credentials but leaves the key shells behind.
		const signedOut: Record<string, string> = {
			pld_loginMethod: '"email"',
			'pld_abc:frillSsoToken': PROFILE_JWT,
			'pld_abc:workspaceList': JSON.stringify([
				{ workspaceId: 'ws_clF1vOqcHS', name: 'Personal', role: 'owner' },
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
