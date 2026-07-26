import { runInNewContext } from 'vm';

import { PROBE_JS } from '../plaud-login';
import { isUsableUserToken } from '../plaud-token';

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

	it('does not descend into a third-party SDK cache', () => {
		// Candidates are probed against Plaud, so collecting another service's
		// JWT would send that credential to Plaud.
		const foreign = {
			...CURRENT_WEB_APP,
			ph_phc_abc_posthog: JSON.stringify({ auth: { jwt: LONG_LIVED_TOKEN } }),
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
