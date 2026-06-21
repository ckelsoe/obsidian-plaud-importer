// In-app Plaud sign-in.
//
// Opens Plaud's web app inside an Electron <webview> so the user can log in
// with whatever method they normally use (email/password, Google SSO, MFA).
// The plugin never sees the user's password — it captures the session token
// the web app itself mints.
//
// Capture strategy (two layers, both keyed on the live request, NOT storage):
//  1. Primary: an Electron session `webRequest.onSendHeaders` listener on the
//     webview's partition records the Authorization header of Plaud's own API
//     calls. This needs no in-page injection and no timing race — the first
//     authenticated request (the library load) is captured automatically.
//  2. Fallback: if the session API is unavailable, an injected fetch/XHR hook
//     records the same header from inside the page.
//
// Storage scraping is deliberately NOT used: Plaud stores no usable API token
// in localStorage (it is derived at request time), so the only reliable source
// is the Authorization header on a real request.

import { App, Modal, Platform } from 'obsidian';
import { NoopDebugLogger, type DebugLogger } from './debug-logger';

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
// If the embedded browser never reaches dom-ready in this window, treat the
// <webview> as unavailable on this Obsidian/Electron build.
const LOAD_TIMEOUT_MS = 15000;
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
		const json =
			typeof atob === 'function'
				? atob(padded)
				: Buffer.from(padded, 'base64').toString('binary');
		const header = JSON.parse(json) as Record<string, unknown>;
		return typeof header.typ === 'string' ? header.typ : null;
	} catch {
		return null;
	}
}

export function isAccessToken(value: string): boolean {
	return jwtTyp(value) === ACCESS_TOKEN_TYP;
}

// Injected as a fallback when the session-level capture is unavailable.
// Monkey-patches fetch and XMLHttpRequest to record the Authorization header
// the page sends, exposing it as window.__pldAuth.
const HOOK_JS = `(() => {
	if (window.__pldAuthHook) { return 'already'; }
	window.__pldAuthHook = true;
	window.__pldAuth = null;
	function typOf(v) {
		try {
			var jwt = v.replace(/^bearer\\s+/i, '').match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);
			if (!jwt) { return null; }
			var seg = jwt[0].split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
			seg += '='.repeat((4 - seg.length % 4) % 4);
			var header = JSON.parse(atob(seg));
			return header && header.typ;
		} catch (e) { return null; }
	}
	function remember(v) {
		// Only the workspace ACCESS token (typ WT) works on the data API; the
		// refresh token (WRT) appears first during login and must be ignored.
		if (typeof v === 'string' && typOf(v) === 'WT') {
			window.__pldAuth = v;
		}
	}
	try {
		var origFetch = window.fetch;
		window.fetch = function (input, init) {
			try {
				var h = init && init.headers;
				if (h) {
					if (typeof Headers !== 'undefined' && h instanceof Headers) { remember(h.get('authorization')); }
					else if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) { if (h[i] && /^authorization$/i.test(h[i][0])) { remember(h[i][1]); } } }
					else { remember(h.Authorization || h.authorization); }
				}
				if (input && input.headers && typeof input.headers.get === 'function') { remember(input.headers.get('authorization')); }
			} catch (e) {}
			return origFetch.apply(this, arguments);
		};
		var origSet = XMLHttpRequest.prototype.setRequestHeader;
		XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
			try { if (/^authorization$/i.test(k)) { remember(v); } } catch (e) {}
			return origSet.apply(this, arguments);
		};
	} catch (e) {}
	return 'hooked';
})()`;

// Reads the fallback-captured header and the regional API host from the page.
const PROBE_JS = `(() => {
	try {
		var authHeader = (typeof window.__pldAuth === 'string' && window.__pldAuth) ? window.__pldAuth : null;
		var domain = null;
		try { domain = localStorage.getItem('pld_plaud_user_api_domain'); } catch (e) {}
		return JSON.stringify({ token: authHeader, domain: domain, href: location.href });
	} catch (e) {
		return JSON.stringify({ error: String(e) });
	}
})()`;

export interface PlaudLoginResult {
	/** Authorization header value the web app sent (may carry a "bearer " prefix). */
	readonly token: string;
	/** Regional API origin if discoverable, else null. */
	readonly apiBaseUrl: string | null;
}

export interface PlaudLoginOptions {
	readonly debugLogger?: DebugLogger;
}

// Local view of the Electron <webview> surface we drive.
interface WebviewElement extends HTMLElement {
	executeJavaScript(code: string): Promise<unknown>;
}

interface ProbeResult {
	token?: string | null;
	domain?: string | null;
	href?: string;
	error?: string;
}

// Minimal Electron surface for session-level header capture. Required at
// runtime via window.require('electron'); methods may be absent on builds that
// disable the remote module, so all access is guarded.
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
	// Sets the user-agent for every request in this session, including popups
	// (e.g. the Google/Apple SSO window) that share the partition.
	setUserAgent?(userAgent: string): void;
}
interface ElectronRemoteLike {
	session?: { fromPartition(partition: string): SessionLike };
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

// Presents the embedded browser as plain desktop Chrome. Obsidian's own
// user-agent carries `obsidian/x` and `Electron/x` product tokens that Google
// and Apple key on to refuse OAuth inside embedded webviews; a clean Chrome UA
// is the standard workaround. The OS token comes from Obsidian's Platform API
// (the navigator UA is off-limits to the obsidianmd lint) so it matches the
// host. Best-effort only: the providers also fingerprint other signals, so this
// may not lift the block on its own.
function spoofUserAgent(): string {
	const os = Platform.isMacOS
		? 'Macintosh; Intel Mac OS X 10_15_7'
		: Platform.isLinux
			? 'X11; Linux x86_64'
			: 'Windows NT 10.0; Win64; x64';
	return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

/**
 * Clear the embedded sign-in browser's stored session for the Plaud partition:
 * cookies, local storage, and cache. After this, the next sign-in starts logged
 * out (so a Google-SSO account reaches the account picker again instead of being
 * silently re-authenticated). Returns true if a clearable session was found,
 * false when the embedded-browser session API is unavailable on this build (in
 * which case there is nothing to clear because automatic sign-in is unavailable
 * anyway).
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
 * Open the in-app Plaud sign-in modal. Resolves with the captured token (and
 * region) once the web app makes an authenticated request, or null if the user
 * closes the modal first or the embedded browser is unavailable.
 */
export function openPlaudLogin(
	app: App,
	options: PlaudLoginOptions = {},
): Promise<PlaudLoginResult | null> {
	return new Promise((resolve) => {
		new PlaudLoginModal(app, options, resolve).open();
	});
}

class PlaudLoginModal extends Modal {
	private readonly debugLogger: DebugLogger;
	private readonly resolve: (result: PlaudLoginResult | null) => void;
	private pollHandle: number | null = null;
	private loadTimeoutHandle: number | null = null;
	private closeTimeoutHandle: number | null = null;
	private settled = false;
	private domReady = false;
	private statusEl: HTMLElement | null = null;
	private diagEl: HTMLElement | null = null;
	// Authorization header captured by the session-level listener (primary path).
	private capturedAuth: string | null = null;
	private webRequestSession: SessionLike | null = null;

	constructor(
		app: App,
		options: PlaudLoginOptions,
		resolve: (result: PlaudLoginResult | null) => void,
	) {
		super(app);
		this.debugLogger = options.debugLogger ?? new NoopDebugLogger();
		this.resolve = resolve;
	}

	onOpen(): void {
		this.modalEl.addClass('plaud-importer-login-modal');
		this.setTitle('Plaud sign-in');

		this.contentEl.createEl('p', {
			cls: 'plaud-importer-login-intro',
			text: 'Sign in below. The plugin captures your session token automatically once you are signed in — it never sees your password.',
		});

		// Arm the session-level capture BEFORE the webview loads, so the first
		// authenticated request the web app makes is recorded automatically.
		this.armSessionCapture();

		const webview = this.contentEl.createEl('webview', {
			cls: 'plaud-importer-login-webview',
			// allowpopups lets Google-SSO popup windows open. useragent presents
			// the frame as plain desktop Chrome so Google/Apple are less likely to
			// block SSO as an embedded webview (best-effort; see spoofUserAgent).
			// The session-level setUserAgent in armSessionCapture covers the SSO
			// popup, which this frame attribute alone does not.
			attr: {
				partition: PLAUD_PARTITION,
				allowpopups: '',
				useragent: spoofUserAgent(),
			},
		});

		this.statusEl = this.contentEl.createEl('p', {
			cls: 'plaud-importer-login-status',
			text: 'Loading…',
		});

		// Diagnostics panel — only populated when Debug logging is enabled.
		this.diagEl = this.contentEl.createEl('pre', {
			cls: 'plaud-importer-login-diag plaud-importer-hidden',
		});

		this.note('login modal opened');

		webview.addEventListener('dom-ready', () => {
			this.domReady = true;
			this.clearLoadTimeout();
			// Route input focus into the embedded page once it is live. Helps the
			// first-open case where the webview renders but does not yet have
			// focus, alongside the transform fix in styles.css.
			if (typeof webview.focus === 'function') {
				webview.focus();
			}
			if (typeof webview.executeJavaScript !== 'function') {
				this.fail(
					'This Obsidian build does not expose an embedded browser, so automatic sign-in is unavailable. Use manual token entry instead.',
				);
				return;
			}
			// Install the in-page fallback hook (idempotent; reinstalled on each
			// navigation because a full page load wipes the patched fetch).
			void webview.executeJavaScript(HOOK_JS).catch(() => undefined);
			this.setStatus('Sign in to continue — your token is captured automatically.');
			this.startPolling(webview);
		});

		webview.addEventListener('did-fail-load', () => {
			this.note('webview did-fail-load');
		});

		// Defer the actual load one tick so the modal paints first. Setting the
		// src synchronously during open can hang the first open on some builds.
		window.setTimeout(() => {
			try {
				webview.src = PLAUD_LOGIN_URL;
			} catch (err) {
				this.note(`failed to set webview src: ${String(err)}`, 'error');
			}
		}, 0);

		this.loadTimeoutHandle = window.setTimeout(() => {
			if (!this.domReady) {
				this.fail(
					'The embedded Plaud sign-in did not load. Check your connection, or use manual token entry.',
				);
			}
		}, LOAD_TIMEOUT_MS);
	}

	onClose(): void {
		this.stopPolling();
		this.clearLoadTimeout();
		this.clearCloseTimeout();
		this.teardownSessionCapture();
		this.contentEl.empty();
		// If the user closed before capture, the caller gets null. settle()
		// guards against double-resolve.
		this.settle(null);
	}

	private armSessionCapture(): void {
		const session = requireElectron()?.remote?.session?.fromPartition(PLAUD_PARTITION);
		if (session === undefined) {
			this.note('session unavailable; relying on in-page hook, host user-agent');
			return;
		}
		// Spoof the user-agent at the session level so the main frame AND its
		// SSO popups (same partition) present as plain desktop Chrome. Done
		// independently of header capture so it still applies on builds where
		// webRequest is missing.
		if (typeof session.setUserAgent === 'function') {
			try {
				session.setUserAgent(spoofUserAgent());
				this.note('spoofed session user-agent for SSO');
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
				// Only keep the workspace ACCESS token (typ WT). The refresh
				// token (WRT) is sent first during login; capturing it is what
				// produced `-3901 "token type does not match parse mode"`.
				if (typeof auth === 'string' && isAccessToken(auth)) {
					this.capturedAuth = auth;
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

	private startPolling(webview: WebviewElement): void {
		// dom-ready fires again on every in-app navigation, so guard against
		// stacking a second interval.
		if (this.pollHandle !== null) {
			return;
		}
		const poll = async (): Promise<void> => {
			if (this.settled) {
				return;
			}
			let probe: ProbeResult | null = null;
			try {
				probe = this.parseProbe(await webview.executeJavaScript(PROBE_JS));
			} catch (err) {
				this.note(`probe rejected: ${String(err)}`, 'error');
			}
			if (probe?.error !== undefined) {
				this.note(`probe page error: ${probe.error}`, 'error');
			}
			// Prefer the session-captured header; fall back to the in-page hook.
			const token =
				this.capturedAuth ??
				(typeof probe?.token === 'string' && probe.token.length > 0 ? probe.token : null);
			const apiBaseUrl = normalizeApiDomain(probe?.domain);
			if (this.debugLogger.enabled) {
				this.note('probe', 'note', {
					href: probe?.href,
					captured: token !== null,
					via: this.capturedAuth !== null ? 'session' : probe?.token ? 'page-hook' : 'none',
				});
				this.renderDiagnostics(probe, token !== null);
			}
			// Defense in depth: both capture paths already filter to the access
			// token, but re-check here so a refresh token can never be the value
			// we store and close the modal on.
			if (token !== null && isAccessToken(token) && !this.settled) {
				this.captureToken(token, apiBaseUrl);
			}
		};
		void poll();
		this.pollHandle = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
	}

	private captureToken(token: string, apiBaseUrl: string | null): void {
		const value = token.trim();
		if (value.length === 0) {
			return;
		}
		this.note('token captured', 'note', {
			apiBaseUrl,
			via: this.capturedAuth !== null ? 'session' : 'page-hook',
		});
		this.setStatus('Signed in. Saving your token…');
		this.stopPolling();
		this.settle({ token: value, apiBaseUrl });
		// Brief pause so the success message is visible, then close.
		this.closeTimeoutHandle = window.setTimeout(() => this.close(), 800);
	}

	// Debug-only: show what the probe saw, for troubleshooting a capture miss.
	private renderDiagnostics(probe: ProbeResult | null, captured: boolean): void {
		if (this.diagEl === null) {
			return;
		}
		const lines = [
			`page: ${probe?.href ?? '(unknown)'}`,
			`token captured: ${captured ? 'yes' : 'not yet'}`,
			`source: ${this.capturedAuth !== null ? 'session header listener' : probe?.token ? 'in-page hook' : '(waiting for a request)'}`,
		];
		this.diagEl.setText(lines.join('\n'));
		this.diagEl.removeClass('plaud-importer-hidden');
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

	private fail(message: string): void {
		this.note(`login unavailable: ${message}`, 'error');
		this.setStatus(message);
		this.stopPolling();
	}

	private settle(result: PlaudLoginResult | null): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.stopPolling();
		this.resolve(result);
	}

	private stopPolling(): void {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
	}

	private clearLoadTimeout(): void {
		if (this.loadTimeoutHandle !== null) {
			window.clearTimeout(this.loadTimeoutHandle);
			this.loadTimeoutHandle = null;
		}
	}

	private clearCloseTimeout(): void {
		if (this.closeTimeoutHandle !== null) {
			window.clearTimeout(this.closeTimeoutHandle);
			this.closeTimeoutHandle = null;
		}
	}

	private setStatus(text: string): void {
		if (this.statusEl !== null) {
			this.statusEl.setText(text);
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
