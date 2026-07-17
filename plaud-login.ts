// In-app Plaud sign-in.
//
// Opens Plaud's web app in a real Electron BrowserWindow (a separate top-level
// window) so the user can log in with email and password. The plugin never sees
// the user's password — it captures the session token the web app itself mints.
//
// Why a separate window and not an embedded <webview>: an embedded webview in a
// modal proved unusable. It alternated, open by open, between a frozen,
// unclickable render and a working one, because Electron does not reliably tear
// down a webview's guest process between opens. Electron's own docs recommend
// against the <webview> tag for exactly these input/lifecycle bugs. A real
// BrowserWindow is the render path that consistently works.
//
// Capture strategy: read the long-lived user token from the sign-in window's
// own `localStorage`. Plaud's web app persists it under the `token` key on
// web.plaud.ai (the origin this window loads), with a ~300-day life, and sends
// it as `Authorization: Bearer <token>` on every data call. We poll
// `localStorage.getItem('token')` via `executeJavaScript` and accept a value
// only once its decoded payload passes the capture guard (client_id + a still
// future exp; see plaud-token.ts). That guard, not the key name, is what keeps
// a neighboring profile/ID JWT (no `exp`) or a stale expired token from ever
// being stored.
//
// A session-level `webRequest.onSendHeaders` listener still records the paired
// refresh token (typ WRT) so the (now inert for a long-lived token) silent
// refresh path and the reconnect-routing heuristic keep working until that
// subsystem is removed. It no longer sources the STORED credential.

import { App, Platform } from 'obsidian';
import { NoopDebugLogger, type DebugLogger } from './debug-logger';
import { isUsableUserToken } from './plaud-token';

// Load the same web client the data API expects. The token is platform-typed:
// a token minted by app.plaud.ai is parsed in a different mode by /file/simple/web
// and rejected with `status: -3901 "token type does not match parse mode"`. The
// client tags its requests `app-platform: web` / `edit-from: web` (see
// plaud-client-re.ts), so the captured token must come from the web client to
// match. Verified against a live web.plaud.ai HAR capture on 2026-06-18.
const PLAUD_LOGIN_URL = 'https://web.plaud.ai';
// Persistent partition so a returning user keeps their Plaud session and does
// not have to sign in every time. Isolated from Obsidian's own web sessions.
const PLAUD_PARTITION = 'persist:plaud-importer';
const POLL_INTERVAL_MS = 1000;
// Match patterns for Plaud API hosts (covers regional hosts like api-euc1).
const SESSION_FILTER = { urls: ['*://*.plaud.ai/*'] };
// A JWT, optionally bearer-prefixed.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

// Plaud's data API tags tokens by type in the JWT header `typ`. The workspace
// ACCESS token used for /file/* data calls is `WT`; the paired REFRESH token is
// `WRT`. During login the web app sends the refresh token (WRT) in an
// Authorization header before the access token (WT), so a "grab the first
// Authorization header" capture stores the WRT and the data API then rejects it
// with `status: -3901 "token type does not match parse mode"`. Only accept the
// access token. Verified against a live web.plaud.ai session on 2026-06-18.
const ACCESS_TOKEN_TYP = 'WT';
// The paired REFRESH token type. The web app sends the WRT in an Authorization
// header during login before the WT; we now keep it (in addition to the WT) so
// the silent-refresh path can send it as a bearer if that is the credential the
// refresh endpoint wants. See plaud-refresh.ts.
const REFRESH_TOKEN_TYP = 'WRT';

// Reads the JWT header `typ` from a (possibly bearer-prefixed) token, or null
// when the value is not a decodable JWT.
function jwtTyp(value: string): string | null {
	const match = value.replace(/^bearer\s+/i, '').match(JWT_RE);
	if (match === null) {
		return null;
	}
	const seg = match[0].split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
	const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
	try {
		// atob is always present in Obsidian's Electron renderer (and Node 18+);
		// avoid the Node `Buffer` global, which is untyped in the marketplace
		// scan's type-checked lint and trips the no-unsafe-* rules.
		const header = JSON.parse(atob(padded)) as Record<string, unknown>;
		return typeof header.typ === 'string' ? header.typ : null;
	} catch {
		return null;
	}
}

export function isAccessToken(value: string): boolean {
	return jwtTyp(value) === ACCESS_TOKEN_TYP;
}

export function isRefreshToken(value: string): boolean {
	return jwtTyp(value) === REFRESH_TOKEN_TYP;
}

// Reads the long-lived user token and the regional API host from the page's
// own localStorage. `getItem` returns the raw stored string (no JSON-quote
// stripping needed), which the plugin then validates with the capture guard.
const PROBE_JS = `(() => {
	try {
		var token = null;
		try { token = localStorage.getItem('token'); } catch (e) {}
		var domain = null;
		try { domain = localStorage.getItem('pld_plaud_user_api_domain'); } catch (e) {}
		return JSON.stringify({ token: token, domain: domain, href: location.href });
	} catch (e) {
		return JSON.stringify({ error: String(e) });
	}
})()`;

export interface PlaudLoginResult {
	/** The long-lived user token read from the window's localStorage. */
	readonly token: string;
	/** Regional API origin if discoverable, else null. */
	readonly apiBaseUrl: string | null;
	/**
	 * The paired refresh token (typ WRT) if it flew by during login, else null.
	 * Kept for the silent-refresh path (plaud-refresh.ts); the WT is what the
	 * data API uses. May carry a "bearer " prefix.
	 */
	readonly refreshToken: string | null;
}

export interface PlaudLoginOptions {
	readonly debugLogger?: DebugLogger;
}

interface ProbeResult {
	token?: string | null;
	domain?: string | null;
	href?: string;
	error?: string;
}

// Minimal Electron surface accessed at runtime via window.require('electron').
// Methods may be absent on builds that disable the remote module, so all access
// is guarded.
interface WebRequestDetails {
	requestHeaders?: Record<string, string>;
}
interface WebRequestLike {
	onSendHeaders(
		filter: { urls: string[] },
		listener: ((details: WebRequestDetails) => void) | null,
	): void;
}
interface SessionLike {
	webRequest?: WebRequestLike;
	// Electron Session storage controls. Present on real builds; guarded at the
	// call site because they may be absent where the remote module is disabled.
	clearStorageData?(): Promise<void>;
	clearCache?(): Promise<void>;
	// Sets the user-agent for every request in this session.
	setUserAgent?(userAgent: string): void;
}
interface WebContentsLike {
	executeJavaScript(code: string): Promise<unknown>;
	// Deny/allow popups and new windows the loaded page requests. Present on real
	// Electron builds; guarded at the call site. We deny all: the sign-in only
	// needs the main frame's own API call, never a popup, and the Plaud web app
	// otherwise spawns feedback/analytics popups that Obsidian routes to the
	// system browser.
	setWindowOpenHandler?(
		handler: (details: { url: string }) => { action: 'deny' | 'allow' },
	): void;
}
interface BrowserWindowLike {
	webContents: WebContentsLike;
	on(event: string, listener: () => void): void;
	loadURL(url: string): Promise<void>;
	close(): void;
	isDestroyed(): boolean;
}
interface BrowserWindowOptions {
	width?: number;
	height?: number;
	title?: string;
	autoHideMenuBar?: boolean;
	webPreferences?: { partition?: string };
}
interface BrowserWindowConstructor {
	new (options: BrowserWindowOptions): BrowserWindowLike;
}
interface ElectronRemoteLike {
	session?: { fromPartition(partition: string): SessionLike };
	BrowserWindow?: BrowserWindowConstructor;
}
interface ElectronLike {
	remote?: ElectronRemoteLike;
}

function requireElectron(): ElectronLike | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		return req('electron') as ElectronLike;
	} catch {
		return null;
	}
}

// Presents the sign-in window as plain desktop Chrome. Obsidian's own
// user-agent carries `obsidian/x` and `Electron/x` product tokens; a clean
// Chrome UA avoids a few sites refusing an Electron user-agent. The OS token
// comes from Obsidian's Platform API (the navigator UA is off-limits to the
// obsidianmd lint) so it matches the host.
function spoofUserAgent(): string {
	const os = Platform.isMacOS
		? 'Macintosh; Intel Mac OS X 10_15_7'
		: Platform.isLinux
			? 'X11; Linux x86_64'
			: 'Windows NT 10.0; Win64; x64';
	return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

/**
 * Clear the sign-in browser's stored session for the Plaud partition: cookies,
 * local storage, and cache. After this, the next sign-in starts logged out.
 * Returns true if a clearable session was found, false when the session API is
 * unavailable on this build (in which case there is nothing to clear because
 * sign-in is unavailable anyway).
 */
export async function clearPlaudLoginSession(): Promise<boolean> {
	const session = requireElectron()?.remote?.session?.fromPartition(
		PLAUD_PARTITION,
	);
	if (session === undefined || typeof session.clearStorageData !== 'function') {
		return false;
	}
	await session.clearStorageData();
	if (typeof session.clearCache === 'function') {
		try {
			await session.clearCache();
		} catch {
			// Best effort; clearing cookies/storage is what signs the user out.
		}
	}
	return true;
}

/**
 * Open the Plaud sign-in window. Resolves with the captured token (and region)
 * once the web app makes an authenticated request, or null if the user closes
 * the window first or the BrowserWindow API is unavailable on this build.
 */
export function openPlaudLogin(
	app: App,
	options: PlaudLoginOptions = {},
): Promise<PlaudLoginResult | null> {
	void app;
	return new Promise((resolve) => {
		new PlaudLoginSession(options, resolve).start();
	});
}

class PlaudLoginSession {
	private readonly debugLogger: DebugLogger;
	private readonly resolve: (result: PlaudLoginResult | null) => void;
	private win: BrowserWindowLike | null = null;
	private pollHandle: number | null = null;
	private settled = false;
	// The paired refresh token (typ WRT) seen during login, kept for the silent
	// refresh path and the reconnect-routing heuristic. It flies during login,
	// so it is set by the time the localStorage token read settles the session.
	private capturedRefresh: string | null = null;
	private webRequestSession: SessionLike | null = null;

	constructor(
		options: PlaudLoginOptions,
		resolve: (result: PlaudLoginResult | null) => void,
	) {
		this.debugLogger = options.debugLogger ?? new NoopDebugLogger();
		this.resolve = resolve;
	}

	start(): void {
		// Arm the session-level capture BEFORE the window loads, so the first
		// authenticated request the web app makes is recorded automatically.
		this.armSessionCapture();

		const BrowserWindow = requireElectron()?.remote?.BrowserWindow;
		if (BrowserWindow === undefined) {
			this.note('BrowserWindow unavailable; sign-in window cannot open', 'error');
			this.settle(null);
			return;
		}

		try {
			this.win = new BrowserWindow({
				width: 520,
				height: 760,
				title: 'Plaud sign-in',
				autoHideMenuBar: true,
				webPreferences: {
					partition: PLAUD_PARTITION,
				},
			});
		} catch (err) {
			this.note(`failed to open sign-in window: ${String(err)}`, 'error');
			this.settle(null);
			return;
		}

		// Deny every popup / new window the page requests, BEFORE loading it. The
		// Plaud web app fires window.open on load (feedback widget, analytics, an
		// auth-redirect popup); Obsidian routes those to the system browser, which
		// spawned stray tabs. We only need the main frame's own API call.
		const contents = this.win.webContents;
		if (typeof contents.setWindowOpenHandler === 'function') {
			try {
				contents.setWindowOpenHandler(() => ({ action: 'deny' }));
			} catch (err) {
				this.note(`could not install window-open handler: ${String(err)}`, 'error');
			}
		}

		// If the user closes the window before a token is captured, the caller
		// gets null. settle() guards against double-resolve, so closing the
		// window after a successful capture is a no-op.
		this.win.on('closed', () => {
			this.win = null;
			this.settle(null);
		});

		this.win.loadURL(PLAUD_LOGIN_URL).catch((err: unknown) => {
			this.note(`failed to load sign-in URL: ${String(err)}`, 'error');
		});
		this.note('sign-in window opened');
		this.startPolling();
	}

	private startPolling(): void {
		if (this.pollHandle !== null) {
			return;
		}
		const poll = async (): Promise<void> => {
			if (this.settled || this.win === null) {
				return;
			}
			const contents = this.win.webContents;
			let probe: ProbeResult | null = null;
			try {
				probe = this.parseProbe(await contents.executeJavaScript(PROBE_JS));
			} catch {
				// Page mid-navigation; try again next tick.
			}
			const token =
				typeof probe?.token === 'string' && probe.token.trim().length > 0
					? probe.token.trim()
					: null;
			const apiBaseUrl = normalizeApiDomain(probe?.domain);
			// The capture guard is the gate: it accepts a live long-lived user
			// token (client_id + future exp) and rejects the neighboring profile/ID
			// JWT and any already-expired token still sitting in localStorage.
			const usable = token !== null && isUsableUserToken(token);
			if (this.debugLogger.enabled) {
				this.note('probe', 'note', { href: probe?.href, captured: usable });
			}
			if (usable && !this.settled) {
				this.captureToken(token, apiBaseUrl);
			}
		};
		void poll();
		this.pollHandle = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
	}

	private captureToken(token: string, apiBaseUrl: string | null): void {
		// Store the bare token; the web app persists it as `bearer eyJ…`, and the
		// data client prepends its own scheme, so strip any leading `bearer `.
		const value = token.trim().replace(/^bearer\s+/i, '');
		if (value.length === 0) {
			return;
		}
		this.note('token captured', 'note', {
			apiBaseUrl,
			refreshTokenCaptured: this.capturedRefresh !== null,
		});
		this.settle({
			token: value,
			apiBaseUrl,
			refreshToken: this.capturedRefresh,
		});
		this.closeWindow();
	}

	private closeWindow(): void {
		if (this.win === null) {
			return;
		}
		try {
			if (!this.win.isDestroyed()) {
				this.win.close();
			}
		} catch {
			// Best effort; the closed handler still cleans up.
		}
	}

	private armSessionCapture(): void {
		const session = requireElectron()?.remote?.session?.fromPartition(
			PLAUD_PARTITION,
		);
		if (session === undefined) {
			this.note('session unavailable; relying on in-page hook, host user-agent');
			return;
		}
		if (typeof session.setUserAgent === 'function') {
			try {
				session.setUserAgent(spoofUserAgent());
			} catch (err) {
				this.note(`set user-agent failed: ${String(err)}`, 'error');
			}
		}
		if (typeof session.webRequest?.onSendHeaders !== 'function') {
			this.note('session header capture unavailable; relying on in-page hook');
			return;
		}
		this.webRequestSession = session;
		try {
			session.webRequest.onSendHeaders(SESSION_FILTER, (details) => {
				const headers = details.requestHeaders ?? {};
				const auth = headers.Authorization ?? headers.authorization;
				if (typeof auth !== 'string') {
					return;
				}
				// The STORED credential is now the long-lived user token read from
				// localStorage (see the poll). Here we only keep the paired refresh
				// token (typ WRT) for the silent-refresh path (inert for a
				// long-lived token) and the reconnect-routing heuristic in main.ts.
				if (isRefreshToken(auth)) {
					this.capturedRefresh = auth;
				}
			});
			this.note('session header capture armed');
		} catch (err) {
			this.note(`session capture setup failed: ${String(err)}`, 'error');
			this.webRequestSession = null;
		}
	}

	private teardownSessionCapture(): void {
		if (this.webRequestSession?.webRequest !== undefined) {
			try {
				this.webRequestSession.webRequest.onSendHeaders(SESSION_FILTER, null);
			} catch {
				// Best effort; nothing actionable if teardown fails.
			}
		}
		this.webRequestSession = null;
	}

	private parseProbe(raw: unknown): ProbeResult | null {
		if (typeof raw !== 'string') {
			return null;
		}
		try {
			return JSON.parse(raw) as ProbeResult;
		} catch {
			return null;
		}
	}

	private settle(result: PlaudLoginResult | null): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.stopPolling();
		this.teardownSessionCapture();
		// Close the window on every settle path (success closes it too, via
		// captureToken). Guarded/idempotent; a no-op once 'closed' has fired.
		this.closeWindow();
		this.resolve(result);
	}

	private stopPolling(): void {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
	}

	private note(
		message: string,
		kind: 'note' | 'error' = 'note',
		payload?: unknown,
	): void {
		if (this.debugLogger.enabled) {
			this.debugLogger.log({ kind, message: `plaud-login: ${message}`, payload });
		}
	}
}

// Normalize the regional host into an https origin, or null when missing or
// not a trusted Plaud host. Mirrors the client's region allowlist: only ever
// return a plaud.ai origin.
function normalizeApiDomain(domain: string | null | undefined): string | null {
	if (typeof domain !== 'string' || domain.trim().length === 0) {
		return null;
	}
	const candidate = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
		return null;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	if (host !== 'plaud.ai' && !host.endsWith('.plaud.ai')) {
		return null;
	}
	return `https://${parsed.host}`.replace(/\/+$/, '');
}
