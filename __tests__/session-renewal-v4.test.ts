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
import { at } from './helpers/checked';

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
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
	/** Text of every action notice shown (the reconnect prompts). */
	notices: string[];
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

function makeHarness(
	overrides: Partial<PlaudImporterSettings> = {},
	isDisposed: () => boolean = () => false,
): Harness {
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
	const notices: string[] = [];

	const host: SessionRenewalHost = {
		getSettings: () => settings,
		isDisposed,
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
		showActionNotice: (message) => {
			notices.push(message);
			return { hide: () => {} } as never;
		},
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
		notices,
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
		expect(at(h.stored, 0).token).toBe(FRESH_WT);
		expect(at(h.stored, 0).refreshToken).toBe(ROTATED_REFRESH);
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

// --- Failure classification and the transient retry ladder ----------------
//
// Modeled on Plaud's own 4.0 app: a session Plaud refuses ("denied") pauses
// renewal at once with a reason-specific prompt, while one Plaud could not be
// reached ("unreachable") is kept and retried on a bounded ladder.

function httpError(status: number, body = 'oops'): PlaudHttpResponse {
	return { status, json: null, text: body };
}

function envelope(body: Record<string, unknown>): PlaudHttpResponse {
	return { status: 200, json: body, text: JSON.stringify(body) };
}

describe('transient refresh failures retry on a ladder', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it('keeps the session and schedules a retry when Plaud is unreachable', async () => {
		const h = makeHarness();
		h.setFetch(() => Promise.resolve(httpError(503)));
		expect(await h.renewal.refreshNow()).toBe('retrying');
		expect(h.renewal.paused).toBe(false);
		expect(h.notices).toHaveLength(0);
		expect(h.debug.map((d) => d.message).join('\n')).toContain(
			'retry 1 of 3 in 5 minutes',
		);
	});

	it('retries at 5, 20 and 60 minutes, then pauses and prompts once', async () => {
		const h = makeHarness();
		h.setFetch(() => Promise.resolve(httpError(503)));
		expect(await h.renewal.refreshNow()).toBe('retrying');
		expect(h.fetchCalls).toBe(1);

		await jest.advanceTimersByTimeAsync(4 * 60_000);
		expect(h.fetchCalls).toBe(1);
		await jest.advanceTimersByTimeAsync(60_000);
		expect(h.fetchCalls).toBe(2);
		await jest.advanceTimersByTimeAsync(20 * 60_000);
		expect(h.fetchCalls).toBe(3);
		expect(h.renewal.paused).toBe(false);
		await jest.advanceTimersByTimeAsync(60 * 60_000);
		expect(h.fetchCalls).toBe(4);

		expect(h.renewal.paused).toBe(true);
		// One reconnect prompt. The fixture token has expired by now, so it is
		// the expiry warning rather than the separate failure notice.
		expect(h.notices).toHaveLength(1);
		expect(at(h.notices, 0)).toContain('Reconnect');
		// Paused means no more attempts against the hourly ceiling.
		await jest.advanceTimersByTimeAsync(3 * 60 * 60_000);
		expect(h.fetchCalls).toBe(4);
	});

	it('does not let an unrelated reconcile pull a retry forward', async () => {
		const h = makeHarness();
		h.setFetch(() => Promise.resolve(httpError(503)));
		expect(await h.renewal.refreshNow()).toBe('retrying');
		h.renewal.reconcileRefresh();
		await jest.advanceTimersByTimeAsync(60_000);
		expect(h.fetchCalls).toBe(1);
	});

	it('renews on a retry and stores the fresh token', async () => {
		const h = makeHarness();
		let calls = 0;
		h.setFetch(() =>
			Promise.resolve(calls++ === 0 ? httpError(503) : okRefresh()),
		);
		expect(await h.renewal.refreshNow()).toBe('retrying');
		await jest.advanceTimersByTimeAsync(5 * 60_000);
		expect(h.stored).toEqual([
			{ token: FRESH_WT, refreshToken: ROTATED_REFRESH },
		]);
		expect(h.renewal.paused).toBe(false);
	});
});

describe('denied refresh failures pause at once with the reason', () => {
	it.each([
		[
			'step-up (-2114)',
			envelope({ status: -2114, msg: 'step up' }),
			'Plaud wants you to confirm your identity again before renewing your session. Reconnect to sign in.',
		],
		[
			'workspace invalid (-3003)',
			envelope({ status: -3003 }),
			'You no longer have access to this Plaud workspace. Reconnect to sign in to your current workspace.',
		],
		[
			'company SSO required',
			httpError(
				403,
				JSON.stringify({
					status: -1,
					data: {
						error_code: 'SSO_REQUIRED',
						workos_organization_id: 'org_1',
					},
				}),
			),
			'Your Plaud workspace now requires company single sign-on, so this session cannot be renewed here. Reconnect and sign in through your browser.',
		],
		[
			'expired refresh token (-420)',
			envelope({ status: -420 }),
			'Your Plaud session has ended. Reconnect to keep imports and auto-sync running.',
		],
		[
			'HTTP 401',
			httpError(401),
			'Your Plaud session has ended. Reconnect to keep imports and auto-sync running.',
		],
	])('%s', async (_label, response, notice) => {
		const h = makeHarness();
		h.setFetch(() => Promise.resolve(response));
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.renewal.paused).toBe(true);
		expect(h.fetchCalls).toBe(1);
		expect(h.notices).toEqual([notice]);
	});
});

// --- Email (window) session: cookie path first, bearer as the fallback ------

interface FakeCookieResponse {
	status: number;
	body: string;
}

/** Fake Electron whose session.fetch answers the cookie path in order. */
function installCookieTransport(responses: FakeCookieResponse[]): string[] {
	const urls: string[] = [];
	let i = 0;
	const win = window as unknown as { require: (id: string) => unknown };
	win.require = () => ({
		remote: {
			getGlobal: () => ({ timeout: () => ({}) }),
			session: {
				fromPartition: () => ({
					fetch: (url: string) => {
						urls.push(url);
						const r = at(
							responses,
							Math.min(i++, responses.length - 1),
						);
						return Promise.resolve({
							status: r.status,
							text: () => Promise.resolve(r.body),
						});
					},
				}),
			},
		},
	});
	return urls;
}

describe('email session renewal falls back to the bearer refresh', () => {
	afterEach(() => {
		delete (window as unknown as { require?: unknown }).require;
	});

	it('renews by bearer when the cookie path is refused', async () => {
		const cookieUrls = installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -401 }) },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		expect(await h.renewal.refreshNow()).toBe('refreshed');
		expect(cookieUrls).toHaveLength(1);
		expect(h.fetchCalls).toBe(1);
		expect(h.stored).toEqual([
			{ token: FRESH_WT, refreshToken: ROTATED_REFRESH },
		]);
	});

	it('pauses with the cookie reason when there is no refresh token to fall back on', async () => {
		installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -401 }) },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		h.storedRefresh.value = '';
		expect(await h.renewal.refreshNow()).toBe('failed');
		expect(h.fetchCalls).toBe(0);
		expect(h.notices).toEqual([
			'Your Plaud session has ended. Reconnect to keep imports and auto-sync running.',
		]);
	});

	it('retries when either path could not reach Plaud', async () => {
		installCookieTransport([{ status: 502, body: 'bad gateway' }]);
		const h = makeHarness({ signInMethod: 'window' });
		h.setFetch(() => Promise.resolve(envelope({ status: -420 })));
		expect(await h.renewal.refreshNow()).toBe('retrying');
		expect(h.renewal.paused).toBe(false);
	});
});

// --- Review findings: lock, request budget, cancellation --------------------

describe('renewal safety around the fallback and retries', () => {
	afterEach(() => {
		delete (window as unknown as { require?: unknown }).require;
		jest.useRealTimers();
	});

	it('holds the in-flight lock until the bearer fallback has stored', async () => {
		installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -401 }) },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		let release: (r: PlaudHttpResponse) => void = () => {};
		h.setFetch(
			() =>
				new Promise<PlaudHttpResponse>((resolve) => {
					release = resolve;
				}),
		);
		const pending = h.renewal.refreshNow();
		// Let the cookie path settle and the bearer request go out.
		for (let i = 0; i < 20 && h.fetchCalls === 0; i++) {
			await Promise.resolve();
		}
		expect(h.fetchCalls).toBe(1);
		expect(h.renewal.refreshInFlight).toBe(true);
		release(okRefresh());
		expect(await pending).toBe('refreshed');
		expect(h.renewal.refreshInFlight).toBe(false);
	});

	it('keeps persistent conflicts within 8 requests an hour', async () => {
		jest.useFakeTimers();
		const urls = installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -4302 }) },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		h.storedRefresh.value = '';
		void h.renewal.refreshNow();
		await jest.advanceTimersByTimeAsync(59 * 60_000);
		// Two attempts of four step-1 calls each fill the budget, so the next
		// ladder step waits for the first attempt to age out of the hour
		// instead of firing at 25 minutes.
		expect(urls).toHaveLength(8);
		expect(h.renewal.paused).toBe(false);
		expect(h.debug.map((d) => d.message).join('\n')).toContain(
			'retry 2 of 3 in 55 minutes',
		);
	});

	it('ends a pending conflict wait on unload without another request', async () => {
		jest.useFakeTimers();
		const urls = installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -4302 }) },
		]);
		let disposed = false;
		const h = makeHarness({ signInMethod: 'window' }, () => disposed);
		const pending = h.renewal.refreshNow();
		await jest.advanceTimersByTimeAsync(0);
		expect(urls).toHaveLength(1);
		disposed = true;
		h.renewal.dispose();
		expect(jest.getTimerCount()).toBe(0);
		expect(await pending).toBe('failed');
		expect(urls).toHaveLength(1);
	});

	it('defers, not pauses, when the bearer fallback does not fit the budget', async () => {
		// Each attempt: step 1 ok, mint 401, then the bearer. Three requests.
		const urls = installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: 0, data: {} }) },
			{ status: 401, body: '{}' },
			{ status: 200, body: JSON.stringify({ status: 0, data: {} }) },
			{ status: 401, body: '{}' },
			{ status: 200, body: JSON.stringify({ status: 0, data: {} }) },
			{ status: 401, body: '{}' },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		expect(await h.renewal.refreshNow()).toBe('refreshed');
		expect(await h.renewal.refreshNow()).toBe('refreshed');
		// Six requests spent; this attempt's step 1 and mint fill the budget.
		expect(await h.renewal.refreshNow()).toBe('retrying');
		expect(urls).toHaveLength(6);
		expect(h.fetchCalls).toBe(2);
		expect(h.renewal.paused).toBe(false);
	});

	it('stops a conflict retry when the user signs out meanwhile', async () => {
		jest.useFakeTimers();
		const urls = installCookieTransport([
			{ status: 200, body: JSON.stringify({ status: -4302 }) },
		]);
		const h = makeHarness({ signInMethod: 'window' });
		const pending = h.renewal.refreshNow();
		await jest.advanceTimersByTimeAsync(0);
		expect(urls).toHaveLength(1);
		h.storedToken.value = '';
		await jest.advanceTimersByTimeAsync(1000);
		expect(await pending).toBe('superseded');
		expect(urls).toHaveLength(1);
		expect(h.fetchCalls).toBe(0);
	});
});
