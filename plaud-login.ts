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
// Capture strategy: read the user token from the sign-in window's own
// `localStorage`. Plaud's web app persists it under the `token` key on
// web.plaud.ai (the origin this window loads) and sends it as
// `Authorization: Bearer <token>` on every data call. Its lifetime varies by
// account: ~300 days observed on US accounts, 24 hours reported on an APSE1
// account (issue #78), so the capture notes the measured lifetime and never
// assumes one. We poll
// `localStorage.getItem('token')` via `executeJavaScript` and accept a value
// only once its decoded payload passes the capture guard (client_id + a still
// future exp; see plaud-token.ts). That guard, not the key name, is what keeps
// a neighboring profile/ID JWT (no `exp`) or a stale expired token from ever
// being stored.

import { App, Platform } from 'obsidian';
import { NoopDebugLogger, type DebugLogger } from './debug-logger';
import { isUsableUserToken, readTokenLifetime } from './plaud-token';

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


// Reads the long-lived user token and the regional API host from the page's
// own localStorage. `getItem` returns the raw stored string (no JSON-quote
// stripping needed), which the plugin then validates with the capture guard.
// The in-page hostname gate means a non-Plaud page's localStorage is never
// even read; the plugin-side isPlaudOrigin check on the returned href stays
// as the authoritative gate (defense in depth, both keyed on the same page).
/**
 * Injected into the sign-in window each poll to collect candidate tokens.
 *
 * Exported ONLY so `__tests__/plaud-login-probe.test.ts` can execute this exact
 * string against fixtures. It is a string, not a function, because it runs via
 * `executeJavaScript` inside the window, so it cannot import the shared
 * collector and is necessarily a hand-written twin of it. That twin is what the
 * test pins: 0.35.0 shipped a capture that no unit test caught because every
 * fixture was written from the same assumption as the code.
 */
export const PROBE_JS = `(() => {
	try {
		var tokens = [];
		var domain = null;
		var h = String(location.hostname || '').toLowerCase().replace(/\\.$/, '');
		var httpsOk = location.protocol === 'https:';
		if (httpsOk && (h === 'plaud.ai' || (h.length > 9 && h.slice(-9) === '.plaud.ai'))) {
			// Collect candidates the same way the bookmarklet does. Plaud's web app
			// stopped writing a plain 'token' key: the live credential is nested
			// inside the workspaceList JSON, so a top-level-only read finds nothing
			// and the window never settles. Descend ONLY into Plaud's own key
			// namespace so an unrelated SDK's cached JWT can never be captured.
			// Only JWT-SHAPED values count toward the cap. Without this, ordinary
			// string settings sharing the pld_ namespace fill the list before the
			// walk reaches the credential nested in workspaceList, and the window
			// never settles. Shape only here; the claim guard runs plugin-side.
			var seg = /^[A-Za-z0-9_-]+$/;
			var add = function (v) {
				if (typeof v !== 'string' || v.length > 4096) { return; }
				var t = v.trim().replace(/^bearer +/i, '').trim();
				var p = t.split('.');
				if (p.length !== 3 || !seg.test(p[0]) || !seg.test(p[1]) || !seg.test(p[2])) { return; }
				if (tokens.indexOf(t) < 0 && tokens.length < 8) { tokens.push(t); }
			};
			var budget = 4000;
			var walk = function (x, depth) {
				if (depth > 6 || budget <= 0 || tokens.length >= 8) { return; }
				budget = budget - 1;
				if (typeof x === 'string') {
					add(x);
					var t = x.trim();
					if (t.length <= 262144 && (t.charAt(0) === '{' || t.charAt(0) === '[')) {
						try { walk(JSON.parse(t), depth + 1); } catch (e) {}
					}
					return;
				}
				if (x !== null && typeof x === 'object') {
					for (var q in x) {
						if (Object.prototype.hasOwnProperty.call(x, q)) { walk(x[q], depth + 1); }
					}
				}
			};
			var scoped = function (k) {
				return k === 'token' || k === 'tokenstr' || k.slice(0, 4) === 'pld_';
			};
			try { walk(localStorage.getItem('token'), 0); } catch (e) {}
			// Then hoist the ACTIVE workspace's token ahead of the other
			// workspaces. The plain token key is read first and outranks this: it
			// is account-scoped and long-lived, so if Plaud ever restores it, it
			// wins. On a multi-workspace account the generic sweep below collects
			// every workspace's token in array order, and each is genuinely valid
			// for its OWN workspace, so selection would settle on whichever came
			// first and imports would silently target the wrong workspace. A
			// preference, not a filter: if Plaud reshapes this we lose the
			// ordering hint and still capture. No backticks in here, ever: this
			// whole probe is a template literal.
			try {
				var current = null;
				for (var c = 0; c < localStorage.length; c++) {
					var ck = localStorage.key(c);
					if (ck !== null && ck.slice(-19) === ':currentWorkspaceId') {
						current = localStorage.getItem(ck);
					}
				}
				if (current) {
					current = String(current).replace(/^"|"$/g, '');
					for (var w = 0; w < localStorage.length; w++) {
						var wk = localStorage.key(w);
						if (wk === null || wk.slice(-13) !== 'workspaceList') { continue; }
						var list = JSON.parse(localStorage.getItem(wk));
						if (!list || typeof list !== 'object') { continue; }
						for (var e in list) {
							if (!Object.prototype.hasOwnProperty.call(list, e)) { continue; }
							var entry = list[e];
							if (entry && typeof entry === 'object' && entry.workspaceId === current) {
								add(entry.workspaceToken);
							}
						}
					}
				}
			} catch (e) {}
			for (var i = 0; i < localStorage.length; i++) {
				var k = localStorage.key(i);
				if (k === null || k === 'token') { continue; }
				try { if (scoped(k)) { walk(localStorage.getItem(k), 0); } else { add(localStorage.getItem(k)); } } catch (e) {}
			}
			try { domain = localStorage.getItem('pld_plaud_user_api_domain'); } catch (e) {}
		}
		return JSON.stringify({ tokens: tokens, domain: domain, href: location.href });
	} catch (e) {
		return JSON.stringify({ error: String(e) });
	}
})()`;

export interface PlaudLoginResult {
	/**
	 * Candidate session tokens read from the window's localStorage, in
	 * collection order. A LIST because Plaud stopped writing a single plain
	 * `token` key: the live credential is nested, and sits beside a refresh
	 * token the API rejects, so only probing each against the API can tell
	 * which one works. The caller does that selection.
	 */
	readonly tokens: readonly string[];
	/** Regional API origin if discoverable, else null. */
	readonly apiBaseUrl: string | null;
}

export interface PlaudLoginOptions {
	readonly debugLogger?: DebugLogger;
}

interface ProbeResult {
	tokens?: unknown;
	domain?: string | null;
	href?: string;
	error?: string;
}

// Minimal Electron surface accessed at runtime via window.require('electron').
// Methods may be absent on builds that disable the remote module, so all access
// is guarded.
interface SessionLike {
	// Electron Session storage controls. Present on real builds; guarded at the
	// call site because they may be absent where the remote module is disabled.
	clearStorageData?(): Promise<void>;
	clearCache?(): Promise<void>;
	// Sets the user-agent for every request in this session.
	setUserAgent?(userAgent: string): void;
}
interface WebContentsLike {
	executeJavaScript(code: string): Promise<unknown>;
	// EventEmitter surface, forwarded synchronously to the real main-process
	// webContents by the remote proxy. Used to strip the host's will-navigate
	// listener from this plugin-owned window (see start()).
	listenerCount?(eventName: string): number;
	removeAllListeners?(eventName: string): unknown;
	// Deny/allow popups and new windows the loaded page requests. Present on real
	// Electron builds; guarded at the call site. We deny all: the sign-in only
	// needs the main frame itself, never a popup, and the Plaud web app
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
	// Wraps a constant so a main-process API sees it as a function whose return
	// value is available SYNCHRONOUSLY. A plain renderer callback crosses the
	// remote bridge asynchronously, so its return value never reaches the
	// main-process caller.
	createFunctionWithReturnValue?<T>(this: void, returnValue: T): () => T;
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
 * once the signed-in page's localStorage holds a usable long-lived token, or
 * null if the user closes the window first or the BrowserWindow API is
 * unavailable on this build.
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

	constructor(
		options: PlaudLoginOptions,
		resolve: (result: PlaudLoginResult | null) => void,
	) {
		this.debugLogger = options.debugLogger ?? new NoopDebugLogger();
		this.resolve = resolve;
	}

	start(): void {
		// Present the window as plain desktop Chrome before it loads.
		this.applySessionUserAgent();

		const remote = requireElectron()?.remote;
		const BrowserWindow = remote?.BrowserWindow;
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

		const contents = this.win.webContents;

		// Obsidian 1.13+ attaches a main-process will-navigate listener to every
		// top-level window. It cancels any navigation off Obsidian's own app://
		// origin and reroutes the URL to shell.openExternal, so Plaud's own login
		// redirect (web.plaud.ai -> /login) opened as a stray tab in the user's
		// default browser. Strip that listener from THIS window only; the page
		// then navigates in-window like a normal browser window. Safe to call on
		// older Obsidian builds without the listener (count is simply 0). Remote
		// method calls execute synchronously in the main process, and the
		// listener is attached during the BrowserWindow constructor
		// (web-contents-created), so this cannot race the attach. Verified live
		// against Obsidian 1.13.2 on 2026-07-17: with the listener a page
		// navigation logs "Opening URL:" in the main process and opens the
		// default browser; with it removed the same navigation stays in-window.
		try {
			if (typeof contents.removeAllListeners !== 'function') {
				throw new Error('webContents.removeAllListeners unavailable');
			}
			const before = contents.listenerCount?.('will-navigate') ?? null;
			contents.removeAllListeners('will-navigate');
			const after = contents.listenerCount?.('will-navigate') ?? null;
			this.note('host navigation guard removed', 'note', { before, after });
			if (after !== null && after !== 0) {
				throw new Error(`removal incomplete, ${String(after)} listener(s) remain`);
			}
		} catch (err) {
			this.note(`could not remove host navigation guard: ${String(err)}`, 'error');
			// Fail closed: loading the page with the guard attached would spray
			// sign-in URLs into the user's default browser. settle() closes the
			// window.
			this.settle(null);
			return;
		}

		// Deny every popup / new window the page requests, BEFORE loading it. The
		// Plaud web app fires window.open on load (feedback widget, analytics, an
		// auth-redirect popup); without a deny handler the host routes those to
		// the system browser. We only need the main frame itself.
		if (typeof contents.setWindowOpenHandler === 'function') {
			try {
				// The deny must reach Electron SYNCHRONOUSLY in the main process. A
				// plain renderer callback crosses the remote bridge asynchronously,
				// so its return value is lost and every popup escapes to the system
				// browser (the stray-tab defect). createFunctionWithReturnValue
				// serializes the constant deny into the main process; the plain
				// callback remains only as a last resort on builds without it.
				const makeSyncReturn = remote?.createFunctionWithReturnValue;
				if (typeof makeSyncReturn === 'function') {
					contents.setWindowOpenHandler(
						makeSyncReturn({ action: 'deny' as const }),
					);
				} else {
					this.note('createFunctionWithReturnValue unavailable; popup deny may not hold', 'error');
					contents.setWindowOpenHandler(() => ({ action: 'deny' }));
				}
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
			// Re-strip the host's navigation guard as defense in depth. Nothing
			// re-attaches it on 1.13 (isSecured guard in the host), but a 1s no-op
			// is cheap insurance against future host changes.
			try {
				contents.removeAllListeners?.('will-navigate');
			} catch {
				// Window mid-teardown; the 'closed' handler settles the session.
			}
			let probe: ProbeResult | null = null;
			try {
				probe = this.parseProbe(await contents.executeJavaScript(PROBE_JS));
			} catch {
				// Page mid-navigation; try again next tick.
			}
			// Every candidate that survives the shared capture guard, not just one.
			const candidates = Array.isArray(probe?.tokens)
				? (probe.tokens as unknown[])
						.filter((v): v is string => typeof v === 'string')
						.map((v) => v.trim().replace(/^bearer\s+/i, '').trim())
						.filter((v) => v.length > 0)
				: [];
			const apiBaseUrl = normalizeApiDomain(probe?.domain);
			// Only ever read the token off a Plaud origin. The window loads
			// web.plaud.ai, but a login redirect could land it elsewhere; a generic
			// localStorage `token` on some other origin must never be captured, even
			// though the claim guard would usually reject it too.
			const onPlaud = isPlaudOrigin(probe?.href);
			// The capture guard is the gate: it accepts a live long-lived user
			// token (client_id + future exp) and rejects the neighboring profile/ID
			// JWT and any already-expired token still sitting in localStorage.
			const usable = onPlaud
				? candidates.filter((value) => isUsableUserToken(value))
				: [];
			if (this.debugLogger.enabled) {
				// Counts only: never the values. Enough to diagnose a capture miss
				// from a shipped debug log without putting a credential in it.
				this.note('probe', 'note', {
					href: probe?.href,
					candidates: candidates.length,
					usable: usable.length,
					captured: usable.length > 0,
				});
			}
			if (usable.length > 0 && !this.settled) {
				this.captureToken(usable, apiBaseUrl);
			}
		};
		void poll();
		this.pollHandle = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
	}

	private captureToken(tokens: readonly string[], apiBaseUrl: string | null): void {
		// Values arrive already trimmed and bearer-stripped by the caller.
		const values = tokens.filter((value) => value.length > 0);
		if (values.length === 0) {
			return;
		}
		// Measure, never assume, the issued lifetime (issue #78: some accounts
		// get a 24h token). Advisory: never blocks capture. Reported for the
		// FIRST candidate only; which one actually wins is decided by the
		// caller probing them against the API.
		const life = readTokenLifetime(values[0]);
		this.note('token captured', 'note', {
			apiBaseUrl,
			candidates: values.length,
			lifetimeHours: life?.lifetimeHours ?? null,
			typ: life?.typ ?? null,
		});
		this.settle({ tokens: values, apiBaseUrl });
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

	private applySessionUserAgent(): void {
		const session = requireElectron()?.remote?.session?.fromPartition(
			PLAUD_PARTITION,
		);
		if (session === undefined) {
			this.note('session unavailable; relying on localStorage poll, host user-agent');
			return;
		}
		if (typeof session.setUserAgent === 'function') {
			try {
				session.setUserAgent(spoofUserAgent());
			} catch (err) {
				this.note(`set user-agent failed: ${String(err)}`, 'error');
			}
		}
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

// True when the page URL is a Plaud origin (plaud.ai or a subdomain). Gates the
// localStorage token read so a login redirect to a non-Plaud origin can never
// have its `token` key captured.
export function isPlaudOrigin(href: string | null | undefined): boolean {
	if (typeof href !== 'string' || href.length === 0) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		return false;
	}
	// HTTPS only: an http page (even on a plaud.ai host) is MITM-able and the
	// capture guard validates claims, not a signature, so a plain-http page
	// must never be a token source.
	if (parsed.protocol !== 'https:') {
		return false;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	return host === 'plaud.ai' || host.endsWith('.plaud.ai');
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
