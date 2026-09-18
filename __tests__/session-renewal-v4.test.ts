/**
 * The v4 (browser) branch of session renewal: the cookieless bearer refresh and
 * the gating that keeps it off prod SSO and pre-beta.3 sessions.
 *
 * The window (v3 cookie) branch is exercised by the modules it delegates to
 * (plaud-refresh-net, refresh-schedule, session-expiry); this suite drives the
 * new dispatch, so it builds a real SessionRenewal over a stub host and asserts
 * the v4 path validates, supersede-checks, and stores the rotated refresh token.
 */
import { SessionRenewal, type SessionRenewalHost } from '../session-renewal';
import {
	DEFAULT_SETTINGS,
	type PlaudImporterSettings,
} from '../settings-types';
import type { CaptureStoreResult } from '../capture-store';
import type { PlaudHttpFetcher, PlaudHttpResponse } from '../plaud-client-re';

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

const NOW_S = Math.floor(Date.now() / 1000);
const WID = 'ws_abc';
// A v4 workspace token: typ WT, ws_ wid, still valid.
const V4_WT = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ client_id: 'web', wid: WID, exp: NOW_S + 3600 },
);
// A freshly minted WT: usable, ws_ wid, and far enough from expiry that it is
// NOT already inside the refresh window (REFRESH_LEAD is a few hours).
const FRESH_WT = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ client_id: 'web', wid: WID, exp: NOW_S + 30 * 24 * 3600 },
);
// A freshly minted WT for a DIFFERENT workspace: used to prove the refresh binds
// to the original workspace and refuses a cross-workspace switch.
const OTHER_WID = 'ws_other';
const FRESH_WT_OTHER_WS = makeJwt(
	{ alg: 'HS256', typ: 'WT' },
	{ client_id: 'web', wid: OTHER_WID, exp: NOW_S + 30 * 24 * 3600 },
);
// A v3 long-lived user token: typ JWT, no wid.
const V3_TOKEN = makeJwt(
	{ alg: 'HS256', typ: 'JWT' },
	{ client_id: 'web', exp: NOW_S + 300 * 24 * 3600 },
);
// The bearer is opaque to the refresh (only borne), so a plain string is fine.
const STORED_REFRESH = 'stored-workspace-refresh-token';
// The ROTATED refresh token is validated: it is a WRT JWT carrying the same wid.
const ROTATED_REFRESH = makeJwt(
	{ alg: 'HS256', typ: 'WRT' },
	{ wid: WID, exp: NOW_S + 30 * 24 * 3600 },
);
// A rotated refresh token for a different workspace, to prove the wid check.
const ROTATED_REFRESH_OTHER_WS = makeJwt(
	{ alg: 'HS256', typ: 'WRT' },
	{ wid: OTHER_WID, exp: NOW_S + 30 * 24 * 3600 },
);

function okRefresh(
	workspaceToken: string = FRESH_WT,
	refresh_token: string = ROTATED_REFRESH,
): PlaudHttpResponse {
	const body = {
		status: 0,
		data: { workspace_token: workspaceToken, refresh_token },
	};
	return { status: 200, json: body, text: JSON.stringify(body) };
}

interface Harness {
	renewal: SessionRenewal;
	settings: PlaudImporterSettings;
	storedToken: { value: string };
	storedRefresh: { value: string };
	fetchCalls: number;
	stored: Array<{ token: string; refreshToken?: string | null }>;
	debug: Array<{ kind: string; message: string }>;
	setFetch: (fetch: PlaudHttpFetcher) => void;
	setStoreOutcome: (outcome: CaptureStoreResult) => void;
	/** Simulate a swallowed refresh-secret write: 'stored' but the WRT does not land. */
	setDropRefreshWrite: (drop: boolean) => void;
}

// Every SessionRenewal built here, so afterEach can dispose them. A failed
// refresh reconciles the pre-expiry warning, which can arm a real (up to 20 day)
// timer against the fresh token; left running it keeps the Jest process alive
// after the suite finishes ("Jest did not exit"). dispose() clears both timers.
const built: SessionRenewal[] = [];
afterEach(() => {
	for (const r of built) r.dispose();
	built.length = 0;
});

function makeHarness(overrides: Partial<PlaudImporterSettings> = {}): Harness {
	const settings: PlaudImporterSettings = {
		...DEFAULT_SETTINGS,
		signInMethod: 'browser',
		secretId: 'plaud-importer-token',
		apiBaseUrl: 'https://api-test.plaud.ai',
		plaudDeviceId: 'dev-1',
		...overrides,
	};
	const storedToken = { value: V4_WT };
	const storedRefresh = { value: STORED_REFRESH };
	const state = {
		fetchCalls: 0,
		fetch: (() => Promise.resolve(okRefresh())) as PlaudHttpFetcher,
		storeOutcome: { outcome: 'stored' } as CaptureStoreResult,
		dropRefreshWrite: false,
	};
	const stored: Array<{ token: string; refreshToken?: string | null }> = [];
	const debug: Array<{ kind: string; message: string }> = [];

	const host: SessionRenewalHost = {
		getSettings: () => settings,
		isDisposed: () => false,
		getAppId: () => 'app-1',
		readStoredTokenValue: () => storedToken.value,
		readStoredRefreshTokenValue: () => storedRefresh.value,
		httpFetch: (req) => {
			state.fetchCalls += 1;
			return state.fetch(req);
		},
		saveSettings: () => Promise.resolve(),
		debugLog: (entry) =>
			debug.push({ kind: entry.kind, message: entry.message }),
		showActionNotice: () => ({ hide: () => {} }) as never,
		forgetActionNotice: () => {},
		redrawSettings: () => {},
		isReauthInFlight: () => false,
		reconnectPrefersWindow: () => false,
		reconnectFromNotice: () => Promise.resolve(true),
		clearLoginSession: () => Promise.resolve(),
		resumeAutoSyncIfPaused: () => {},
		storeAccessToken: (raw, _method, _base, _bg, _owns, refreshToken) => {
			stored.push({ token: raw, refreshToken });
			// Reflect a successful store into the stub's stored values, like the
			// real capture store would, so a follow-up read sees the fresh token.
			if (state.storeOutcome.outcome === 'stored') {
				storedToken.value = raw;
				if (
					!state.dropRefreshWrite &&
					refreshToken !== undefined &&
					refreshToken !== null
				) {
					storedRefresh.value = refreshToken;
				}
			}
			return Promise.resolve(state.storeOutcome);
		},
	};

	const renewal = new SessionRenewal(host);
	built.push(renewal);
	return {
		renewal,
		settings,
		storedToken,
		storedRefresh,
		get fetchCalls() {
			return state.fetchCalls;
		},
		stored,
		debug,
		setFetch: (fetch) => {
			state.fetch = fetch;
		},
		setStoreOutcome: (outcome) => {
			state.storeOutcome = outcome;
		},
		setDropRefreshWrite: (drop) => {
			state.dropRefreshWrite = drop;
		},
	};
}

describe('canRenewCredential for a browser (v4) session', () => {
	it('is true for a v4 workspace token with a captured refresh token', () => {
		const h = makeHarness();
		expect(h.renewal.canRenewCredential(V4_WT, 'browser')).toBe(true);
	});

	it('is false when no refresh token was captured', () => {
		const h = makeHarness();
		h.storedRefresh.value = '';
		expect(h.renewal.canRenewCredential(V4_WT, 'browser')).toBe(false);
	});

	it('is false for a v3 token with no ws_ wid (a prod SSO session)', () => {
		const h = makeHarness();
		expect(h.renewal.canRenewCredential(V3_TOKEN, 'browser')).toBe(false);
	});
});

describe('refreshNow on a browser (v4) session', () => {
	it('bearers the refresh token, stores the fresh WT and the rotated refresh token', async () => {
		const h = makeHarness();
		const outcome = await h.renewal.refreshNow();
		expect(outcome).toBe('refreshed');
		expect(h.fetchCalls).toBe(1);
		expect(h.stored).toHaveLength(1);
		expect(h.stored[0].token).toBe(FRESH_WT);
		expect(h.stored[0].refreshToken).toBe(ROTATED_REFRESH);
		// The rotated token is now what is stored, so the next refresh uses it.
		expect(h.storedRefresh.value).toBe(ROTATED_REFRESH);
	});

	it('is unsupported (no network call) with no captured refresh token', async () => {
		const h = makeHarness();
		h.storedRefresh.value = '';
		expect(await h.renewal.refreshNow()).toBe('unsupported');
		expect(h.fetchCalls).toBe(0);
	});

	it('is unsupported for a v3 token with no ws_ wid', async () => {
		const h = makeHarness();
		h.storedToken.value = V3_TOKEN;
		expect(await h.renewal.refreshNow()).toBe('unsupported');
		expect(h.fetchCalls).toBe(0);
	});

	it('fails when the mint returns something that is not a usable WT', async () => {
		const h = makeHarness();
		h.setFetch(() =>
			Promise.resolve({
				status: 200,
				json: { status: -420, msg: 'workspace refresh token expired' },
				text: '{"status":-420}',
			}),
		);
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.stored).toHaveLength(0);
		expect(h.renewal.paused).toBe(true);
	});

	it('discards the result when the stored credential changed while it ran', async () => {
		const h = makeHarness();
		// The fetch flips the stored token before it resolves, so the supersede
		// check finds the credential is no longer the one this refresh belongs to.
		h.setFetch(() => {
			h.storedToken.value = makeJwt(
				{ alg: 'HS256', typ: 'WT' },
				{ client_id: 'web', wid: 'ws_other', exp: NOW_S + 3600 },
			);
			return Promise.resolve(okRefresh());
		});
		expect(await h.renewal.refreshNow()).toBe('superseded');
		expect(h.stored).toHaveLength(0);
		expect(h.renewal.paused).toBe(false);
	});

	it('fails and stores nothing when the minted WT is for a different workspace', async () => {
		const h = makeHarness();
		h.setFetch(() => Promise.resolve(okRefresh(FRESH_WT_OTHER_WS)));
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.stored).toHaveLength(0);
		expect(h.renewal.paused).toBe(true);
	});

	it('fails when the rotated refresh token is for a different workspace', async () => {
		const h = makeHarness();
		h.setFetch(() =>
			Promise.resolve(okRefresh(FRESH_WT, ROTATED_REFRESH_OTHER_WS)),
		);
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.stored).toHaveLength(0);
		expect(h.renewal.paused).toBe(true);
	});

	it('fails when the fresh WT stored but the rotated refresh token did not persist', async () => {
		const h = makeHarness();
		// storeAccessToken reports 'stored' (the WT landed) but the guarded
		// refresh-secret write was swallowed, so the read-back does not match.
		h.setDropRefreshWrite(true);
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.renewal.paused).toBe(true);
	});
});
