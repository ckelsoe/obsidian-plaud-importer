import {
	type Modal,
	Notice,
	Plugin,
	TFile,
	type ObsidianProtocolData,
	requestUrl,
	type RequestUrlResponse,
} from 'obsidian';
import {
	ReverseEngineeredPlaudClient,
	PlaudAuthError,
	type PlaudHttpFetcher,
} from './plaud-client-re';
import { ImportModal, classifyError } from './import-modal';
import { BufferedDebugLogger } from './debug-logger';
import { clearPlaudLoginSession, openPlaudLogin } from './plaud-login';
import {
	describeTokenLifetime,
	formatSessionStatus,
	isUsableUserToken,
	isWorkspaceToken,
	readTokenLifetime,
	SHORT_LIFETIME_HOURS,
} from './plaud-token';
import { isLegacyPartition, plaudPartition } from './plaud-partition';
import { sessionExpiryDecision } from './session-expiry';
import { computeRefreshDelayMs, isRefreshDue } from './refresh-schedule';
import {
	buildPartitionPost,
	extractWorkspaceId,
	performNetRefresh,
} from './plaud-refresh-net';
import {
	escapeHtmlAttribute,
	parseClipboardTokens,
	parseTokenCandidates,
	buildSignInBookmarklet,
} from './token-candidates';
import {
	NoteWriter,
	migrateLegacyDateTemplate,
	renameRecordingNote,
	isValidReplacementChar,
	sanitizeFilename,
	type RenameFileFn,
} from './note-writer';
import {
	AttachmentImporter,
	// DEPRECATED one-time #52 migration; remove with the repair command below.
	isLocalCardImage,
	repairLegacyCardEmbeds,
} from './attachment-importer';
import {
	buildPlaudIdIndex,
	buildPlaudIdIndexWithColdCheck,
	outputFolderCacheIsCold,
	type ImportedRecord,
} from './vault-index';
import { runImport } from './import-runner';
import {
	PAGE_SIZE,
	categoryAllowsReauth,
	type ArtifactSelection,
	type ImportModalOptions,
	type ImportViewStatePatch,
} from './import-core';
import type { PlaudClient, PlaudRecordingId, Recording } from './plaud-client';
import { runAutoSyncTick } from './auto-sync-runner';
import {
	coerceIntervalMinutes,
	nextAutoSyncState,
	tickOutcomeForCategory,
	INITIAL_AUTO_SYNC_STATE,
	type AutoSyncState,
} from './auto-sync';
import {
	preferWindowForReconnect,
	type SignInMethod,
} from './reconnect-routing';
import {
	CaptureStore,
	CAPTURED_SECRET_ID,
	type CaptureStoreResult,
	type ReauthOutcome,
} from './capture-store';
import {
	CURRENT_SETTINGS_VERSION,
	DEFAULT_SETTINGS,
	resolveRibbonIconId,
	type PlaudImporterSettings,
} from './settings-types';
import { PlaudImporterSettingsTab } from './settings-tab';
import {
	BrowserSignInModal,
	ConfirmModal,
	RenameRecordingModal,
} from './modals';

// Legacy secret id for the paired refresh token (typ WRT) that pre-0.32.0
// email sign-ins stored. The refresh subsystem is gone; the secret is only
// ever blanked (sign-out, fresh captures) and read once as the migration
// signal for routing Reconnect (a stored WRT means an email-window session).
const LEGACY_REFRESH_SECRET_ID = 'plaud-importer-refresh-token';

// Plaud web app, opened in the system browser for the browser-based sign-in
// flow (where Google/Apple SSO work, unlike an embedded webview).
const PLAUD_WEB_URL = 'https://web.plaud.ai';

// Standalone HTML page opened in the system browser for one-time bookmark
// setup. It offers the sign-in bookmarklet (token-candidates.ts) as a
// draggable link so a non-technical user can drag it onto their bookmarks bar
// instead of pasting a javascript: URL into a new bookmark by hand.
//
// The href is escaped as a full HTML attribute value (escapeHtmlAttribute,
// where the ordering rule and the round-trip are pinned by tests), not just
// for `&`: the bookmarklet carries `&&`, comparison operators, and quotes, and
// escaping the quote characters is what keeps the value from being able to
// close the attribute at all.
function bookmarkSetupHtml(vaultName: string): string {
	const href = escapeHtmlAttribute(buildSignInBookmarklet(vaultName));
	return [
		'<!doctype html>',
		'<html lang="en"><head><meta charset="utf-8">',
		'<title>Plaud Importer bookmark setup</title>',
		'<style>',
		'body{font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 24px;line-height:1.55;color:#1a1a1a}',
		'h1{font-size:1.35rem}',
		'.bm{display:inline-block;padding:12px 22px;background:#5b46f2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:1.05rem;cursor:grab}',
		'.note{color:#555;font-size:0.95rem}',
		'ol{color:#333}',
		'</style></head><body>',
		'<h1>Plaud Importer: one-time setup</h1>',
		"<p><strong>Drag this button up onto your browser's bookmarks bar:</strong></p>",
		'<p><a class="bm" href="' + href + '">Plaud → Obsidian (v2)</a></p>',
		'<p class="note">Bookmarks bar hidden? Press Ctrl+Shift+B (Cmd+Shift+B on Mac) to show it, then drag the button onto it.</p>',
		'<p class="note">Already have an older Plaud → Obsidian bookmark? Replace it with this one. The new bookmark sends the token to Obsidian for you instead of asking you to copy and paste it.</p>',
		// Names the target vault: the bookmark is built for ONE vault, and a
		// user with several open would otherwise have no way to tell which
		// bookmark belongs to which.
		'<p class="note">This bookmark delivers to your <strong>' +
			vaultName
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;') +
			'</strong> vault, so it works even when another vault has focus. Set it up again from a different vault to make a bookmark for that one.</p>',
		'<hr><p>After it is saved, each time you need to connect:</p>',
		'<ol>',
		'<li>Sign in to Plaud in this browser.</li>',
		'<li>Click the bookmark you just added. Obsidian opens and saves your token.</li>',
		'</ol>',
		'<p class="note">If Obsidian does not open, the bookmark falls back to showing a line of text in a box. Copy the whole line, switch to Obsidian, and click the paste button in the plugin settings.</p>',
		'</body></html>',
	].join('');
}

// Adapt Obsidian's requestUrl to the PlaudHttpFetcher shape the client
// depends on. Using requestUrl (not fetch) is required to avoid CORS and
// certificate issues on Electron. `throw: false` lets us map status codes
// in the client rather than Obsidian's implicit throw.
const obsidianFetcher: PlaudHttpFetcher = async ({
	url,
	method,
	headers,
	body,
}) => {
	const response = await requestUrl({
		url,
		method,
		headers: { ...headers },
		body,
		throw: false,
	});
	return {
		status: response.status,
		json: safeJson(response),
		text: response.text ?? '',
	};
};

// requestUrl's `json` is a getter that parses `text` lazily and throws a
// SyntaxError on invalid JSON. Catch ONLY SyntaxError and return null — the
// client will then produce a PlaudParseError with the raw body snippet.
// Any other exception type is a genuine bug (e.g. an internal Obsidian API
// change) and should propagate so it can be surfaced loudly instead of
// silently misclassified as "unexpected shape from Plaud."
function safeJson(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch (err) {
		if (err instanceof SyntaxError) {
			return null;
		}
		throw err;
	}
}

// Clipboard write with a user-visible fallback Notice if the platform
// blocks the clipboard API. Kept here rather than in a shared util because
// main.ts is the only caller — import-modal.ts has its own copy for the
// error-details flow.
async function copyToClipboard(
	text: string,
	onSuccess: () => void,
): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		onSuccess();
	} catch (err) {
		console.error('Plaud Importer: clipboard write failed', err);
		new Notice(
			'Plaud Importer: could not copy to clipboard — see the developer console (Ctrl+Shift+I) for the full error.',
		);
	}
}

export default class PlaudImporterPlugin extends Plugin {
	settings!: PlaudImporterSettings;
	private client?: ReverseEngineeredPlaudClient;
	// Single logger instance shared by the client and the settings tab.
	// The `enabled` flag is toggled in place by the settings toggle so
	// changes take effect immediately without reinstantiating the client.
	debugLogger!: BufferedDebugLogger;
	// Live reference to the ribbon icon element so the settings toggle
	// can add or remove it without reloading the plugin. Null when the
	// icon is currently hidden per the user's preference.
	private ribbonIconEl: HTMLElement | null = null;
	// The Lucide icon ID currently rendered on `ribbonIconEl`. Tracked
	// separately from the setting so updateRibbonIcon() knows when a
	// pure icon swap requires detach + re-add vs. a no-op.
	private ribbonIconId: string | null = null;

	// Auto-sync timers and state. The interval id and the deferred first-run
	// timeout id are kept so an interval/toggle change can clear and re-create
	// them; onunload clears both.
	private autoSyncIntervalId: number | undefined;
	private autoSyncFirstRunTimeoutId: number | undefined;
	private autoSyncState: AutoSyncState = INITIAL_AUTO_SYNC_STATE;
	// Pre-expiry session warning timer (issue #78). A real scheduled timeout,
	// deliberately NOT an auto-sync tick hook: auto-sync defaults off and its
	// cadence misses short warn windows. Armed by
	// reconcileSessionExpiryWarning(); cleared there and in onunload.
	private sessionExpiryTimeoutId: number | undefined;
	// The currently visible pre-expiry notice, if any, so a credential change
	// can dismiss it instead of leaving a sticky warning that describes the
	// OLD session. Also lives in actionNotices for the onunload sweep.
	private sessionExpiryNotice: Notice | null = null;
	// Silent session-refresh timer. Armed by reconcileSessionRefresh(); cleared
	// there and in onunload, same discipline as the two timers above.
	private sessionRefreshTimeoutId: number | undefined;
	// One refresh at a time. The timer, a credential change, and the manual
	// debug command can all reach the refresh; without this they could run
	// concurrent mints and spend the account's hourly refresh budget twice over
	// for one renewal.
	private sessionRefreshInFlight = false;
	// Set when a refresh attempt fails. Suppresses re-arming so a dead session
	// cannot loop against Plaud's ~10-per-hour refresh ceiling; cleared by any
	// successful capture or refresh. Recovery is the Reconnect prompt, not a
	// retry ladder.
	private sessionRefreshFailed = false;
	// The "could not renew" prompt, held so it can be dismissed rather than
	// left sticky. It has no duration (an auth prompt should not time out), so
	// without a handle a healed session would keep telling the user to
	// reconnect, and the later expiry warning would stack a second prompt on
	// top of it. Cleared wherever sessionExpiryNotice is.
	private sessionRefreshFailureNotice: Notice | null = null;
	// The auto-sync auth-pause "Reconnect" prompt, held for the same reason as
	// the two notices above (issue #88). It also has no duration, and a paused
	// session can now heal with NO user action: a background refresh finishing
	// after a tick already paused. Without a handle nothing can take the prompt
	// down, so it outlives the pause it describes and invites a reconnect the
	// plugin no longer needs. Cleared by clearAutoSyncPauseNotice().
	private autoSyncPauseNotice: Notice | null = null;
	/**
	 * True when unattended renewal has stopped for the current credential and
	 * will not resume without a reconnect. Read by the settings tab so its
	 * renewal line cannot keep promising a renewal that is no longer running.
	 */
	get sessionRenewalPaused(): boolean {
		return this.sessionRefreshFailed;
	}
	// Single-flight coordination between the manual modal and background ticks.
	// Two independent flags rather than one shared boolean, so the modal's
	// open/close never clobbers a tick's in-flight state and vice versa. An
	// auto-sync tick starts only when BOTH are clear.
	private importModalOpen = false;
	private autoSyncTickInFlight = false;
	// Set once in onunload. A tick or backfill captures `this.client` in a local
	// before its awaits, so clearing the client alone does not stop an in-flight
	// loop; the loops poll this flag and abort so a disable/re-enable cannot leave
	// the old instance writing while the new instance starts a tick.
	private disposed = false;
	// A sign-in window is open. Blocks a second concurrent sign-in from any
	// entry point (settings, the auth-pause notice, the backfill retry), so
	// stacked stale notices cannot launch clobbering capture sessions.
	private reauthInFlight = false;
	// Turns a candidate credential into a stored one, and owns the capture queue
	// that keeps concurrent captures in call order (#86). Built here rather than
	// in onload so it exists before any deep link can arrive; every dependency
	// below is read at call time, so none of them need to be ready yet.
	private readonly captureStore = new CaptureStore<PlaudImporterSettings>({
		// Re-read on every use: loadSettings REPLACES the settings object, so a
		// reference taken here would be the pre-load default forever after.
		getSettings: () => this.settings,
		setSecret: (id, secret) => this.app.secretStorage.setSecret(id, secret),
		saveData: (data) => this.saveData(data),
		isDisposed: () => this.disposed,
		clearStoredRefreshToken: () => this.clearStoredRefreshToken(),
		clearRefreshFailure: () => {
			this.sessionRefreshFailed = false;
		},
		noteShortLifetimeOnCapture: (token, signInMethod) =>
			this.noteShortLifetimeOnCapture(token, signInMethod),
		reconcileSessionExpiryWarning: () =>
			this.reconcileSessionExpiryWarning(),
		reconcileSessionRefresh: () => this.reconcileSessionRefresh(),
		// Read at call time, so a tab closed mid-store is simply null.
		redrawSettings: () => this.settingsRefresh?.(),
		// A THROWAWAY client per probe, built around a closure returning that one
		// candidate: the real client reads secretStorage, and nothing may be
		// written to storage before it is validated.
		probeCandidate: async (token, baseUrl, onBaseUrlChanged) => {
			const probe = new ReverseEngineeredPlaudClient(
				() => token,
				obsidianFetcher,
				{
					debugLogger: this.debugLogger,
					baseUrl,
					onBaseUrlChanged,
				},
			);
			await probe.listRecordings({ limit: 1 });
		},
	});
	// Redraws the open settings tab's sign-in status and secret picker. Set by
	// the tab's display() (the pre-1.13 imperative path; 1.13+ renders
	// declaratively and re-reads on its own) and cleared by its hide(), so it
	// is null whenever no tab is mounted. Lets a credential stored from OUTSIDE
	// the tab — a bookmarklet deep link arriving while settings sits open —
	// update what the user is looking at.
	settingsRefresh: (() => void) | null = null;
	// The browser-reconnect flow currently awaiting a token, if any. A token can
	// come back through the modal's paste button OR the obsidian:// deep link;
	// deliveryInFlight serializes those channels per flow (the second one
	// no-ops instead of starting a concurrent token store), and completion is
	// keyed to this exact object so a delivery that outlives a cancelled flow
	// can never complete a newer one. Null when no browser reconnect is open;
	// cleared by the modal's onClose on every path (completion, cancel,
	// dismiss) and by onunload.
	private browserReconnect: {
		modal: Modal;
		onReconnected?: () => unknown;
		deliveryInFlight: boolean;
		// Idempotent gate release, shared with the modal's onClose. Exposed on
		// the flow so completion and onunload can restore the single-flight
		// state even when Modal.close() itself throws.
		release: () => void;
	} | null = null;
	// DEPRECATED one-time #52 repair: guards against a double-invoke running two
	// bulk vault scans at once. REMOVE with the repair command.
	private repairInFlight = false;
	// Sticky action notices (e.g. the auth-pause "Reconnect") tracked so
	// onunload can hide any still on screen before their click handlers can run
	// plugin work after the plugin is gone.
	private readonly actionNotices = new Set<Notice>();
	// Loop guard for the rename cascade. Nonzero while WE rename a note or its
	// assets folder (auto-migration or the local rename command). Suppresses the
	// vault.on('rename') listener so our own rename is not treated as a
	// user-initiated one and cascaded a second time, and disables the rename
	// command and menu item so a user rename cannot start while our cascade is
	// running. A depth counter, not a boolean: if two self-renames overlap, the
	// guard stays set until the LAST one finishes, so an outer rename's later
	// events cannot leak when an inner rename's finally runs first.
	private selfRenameDepth = 0;

	async onload() {
		await this.loadSettings();

		this.debugLogger = new BufferedDebugLogger(this.settings.debug, {
			headerLines: [`Plugin version: ${this.manifest.version}`],
		});

		this.addSettingTab(new PlaudImporterSettingsTab(this.app, this));

		// Receive tokens handed back from the user's external browser (the
		// browser sign-in flow) via obsidian://plaud-importer-token?tokens=…
		// The handler now makes network calls to pick the working candidate, so
		// its rejection is caught here: an unhandled one would leave the user
		// with a clicked bookmark and no feedback at all.
		this.registerObsidianProtocolHandler(
			'plaud-importer-token',
			(params) => {
				void this.handleTokenDeepLink(params).catch((err: unknown) => {
					console.error(
						'Plaud importer: token deep link failed',
						err,
					);
					new Notice(
						'Plaud: could not save the token from your browser. Try again, or paste it in settings.',
					);
				});
			},
		);

		this.addCommand({
			id: 'import-recent',
			name: 'Import recent recordings',
			callback: () => this.launchImportModal('command'),
		});

		this.addCommand({
			id: 'backfill-version-markers',
			name: 'Backfill version markers for auto-sync',
			callback: () => {
				void this.backfillVersionMarkers();
			},
		});

		// Render the left-rail ribbon icon only when the user has opted
		// in via settings. updateRibbonIcon() is idempotent and is also
		// called from the settings toggle so enabling/disabling takes
		// effect without reloading the plugin.
		this.updateRibbonIcon();

		this.addCommand({
			id: 'debug-copy-log',
			name: 'Debug: copy debug log to clipboard',
			callback: () => {
				const formatted = this.debugLogger.format();
				void copyToClipboard(formatted, () => {
					const count = this.debugLogger.snapshot().length;
					new Notice(
						`Plaud Importer: copied ${count} debug event${
							count === 1 ? '' : 's'
						} to clipboard.`,
					);
				});
			},
		});

		this.addCommand({
			id: 'debug-clear-log',
			name: 'Debug: clear debug log',
			callback: () => {
				const count = this.debugLogger.snapshot().length;
				this.debugLogger.clear();
				new Notice(
					`Plaud Importer: cleared ${count} debug event${
						count === 1 ? '' : 's'
					}.`,
				);
			},
		});

		this.addCommand({
			id: 'debug-copy-session-status',
			name: 'Debug: copy session status to clipboard',
			callback: () => {
				void copyToClipboard(this.formatSessionStatus(), () => {
					new Notice(
						'Session status copied. It contains no token value and is safe to paste into a public issue.',
					);
				});
			},
		});

		// Forces the silent refresh instead of waiting out the ~22 hour cadence.
		// Kept rather than removed after the release verification, because the
		// refresh is a background path whose failures are otherwise invisible:
		// this is the only way a user on a support thread can produce a debug
		// log showing what it actually did. checkCallback hides it entirely
		// unless debug logging is on AND this session is one the refresh can
		// serve, so it never advertises a renewal SSO and bookmarklet users
		// cannot receive.
		this.addCommand({
			id: 'debug-refresh-session',
			name: 'Debug: refresh the session now',
			checkCallback: (checking) => {
				if (
					!this.settings.debug ||
					this.settings.signInMethod !== 'window'
				) {
					return false;
				}
				if (!checking) {
					void this.refreshSessionNow()
						.then((outcome) => {
							new Notice(
								outcome === 'refreshed'
									? 'Plaud session refreshed. A fresh token is stored.'
									: outcome === 'busy'
										? 'A session refresh is already running.'
										: outcome === 'superseded'
											? 'Session refresh skipped: the stored sign-in changed while it ran.'
											: outcome === 'unsupported'
												? 'This session cannot be refreshed in the background. Reconnect to sign in again.'
												: 'Session refresh failed. See the debug log, then reconnect.',
							);
						})
						.catch((err: unknown) => {
							// A command the user pressed must always answer. The
							// scheduled path has its own catch; without one here a
							// rejection would be swallowed as an unhandled promise
							// and the palette entry would look like it did nothing.
							console.error(
								'Plaud importer: manual session refresh failed',
								err,
							);
							new Notice(
								'Session refresh failed. See the debug log, then reconnect.',
							);
						});
				}
				return true;
			},
		});

		// DEPRECATED ONE-TIME MIGRATION (issue #52) — REMOVE IN A FUTURE VERSION.
		// The import-time fix only repoints card embeds on (re)import; notes
		// imported before it keep the broken inline embed. This user-invoked
		// (never automatic) command repairs those existing notes in place.
		this.addCommand({
			id: 'repair-legacy-card-links',
			name: 'Repair card image links from older imports (one-time)',
			callback: () => {
				void this.repairLegacyCardLinks();
			},
		});

		// Issue B: let the user rename an imported recording from Obsidian and
		// keep its `<base>-assets` folder in sync. A palette command and a note
		// context-menu item both open the rename prompt; a vault rename listener
		// cascades a user rename (from Obsidian's own rename UI) to the assets
		// folder. All local: no write back to Plaud (that is a later feature).
		this.addCommand({
			id: 'rename-recording',
			name: 'Rename recording',
			checkCallback: (checking) => {
				// Disable while a plugin-owned rename is in flight so a user
				// rename cannot race our own cascade (the listener is already
				// suppressed the same way).
				const file = this.app.workspace.getActiveFile();
				if (this.selfRenameDepth > 0 || !this.isPlaudNote(file)) {
					return false;
				}
				if (!checking) {
					this.promptRenameRecording(file);
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// Same suppression as the command: no user rename entry point
				// while our own rename cascade is running.
				if (this.selfRenameDepth > 0 || !this.isPlaudNote(file)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle('Rename imported recording')
						.setIcon('pencil')
						.onClick(() => this.promptRenameRecording(file)),
				);
			}),
		);

		// Cascade a user's rename of a Plaud note to its assets folder. Obsidian
		// has already renamed the note by the time this fires, so the note step
		// is a no-op inside renameRecordingNote and only the folder moves. The
		// self-rename guard skips our OWN renames (auto-migration and the command
		// above) so they do not double-cascade.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.selfRenameDepth > 0) {
					return;
				}
				if (!this.isPlaudNote(file)) {
					return;
				}
				void this.cascadeUserRename(oldPath, file.path);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			// Construct the client once. It reads the token fresh on every
			// API call via the provider, so settings changes take effect
			// immediately with no reinstantiation.
			this.client = new ReverseEngineeredPlaudClient(
				() => this.app.secretStorage.getSecret(this.settings.secretId),
				obsidianFetcher,
				{
					debugLogger: this.debugLogger,
					baseUrl: this.settings.apiBaseUrl,
					// Persist the regional host the first time Plaud redirects
					// us, so later sessions skip the round-trip.
					onBaseUrlChanged: (url) => {
						this.settings.apiBaseUrl = url;
						void this.saveSettings();
					},
				},
			);
			// The client exists now, so a scheduled tick can run. Starts the
			// timer only when auto-sync is enabled; deferred first run is inside.
			this.reconcileAutoSync();
			// Arm the pre-expiry session warning for the stored credential
			// (issue #78). Runs regardless of auto-sync state.
			this.reconcileSessionExpiryWarning();
			// And the silent refresh, for window sessions that can use it.
			this.reconcileSessionRefresh();
			// One-time heads-up when this vault's sign-in moved partitions (#87).
			this.notePerVaultSignInChange();
			// A vault whose id the host did not supply falls back to the old
			// shared partition. Behavior is the pre-#87 one, which is survivable,
			// but it means this vault can still race another, so say so where a
			// debug log will show it rather than failing silently.
			if (isLegacyPartition(this.signInPartition())) {
				this.debugLogger.log({
					kind: 'error',
					message:
						'per-vault sign-in unavailable: no usable vault id, using the shared partition',
				});
			}
		});
	}

	onunload() {
		// Signal any in-flight tick/backfill loop to stop between iterations. Set
		// before clearing the client so a loop that already captured the client
		// still sees the abort.
		this.disposed = true;
		this.client = undefined;
		// Clear the auto-sync timers. Both the interval and the deferred first-run
		// timeout are ours (plain setInterval/setTimeout), so we clear both here.
		if (this.autoSyncIntervalId !== undefined) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = undefined;
		}
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
			this.autoSyncFirstRunTimeoutId = undefined;
		}
		// Clear the pre-expiry session warning timer for the same reason.
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		// And the silent session-refresh timer.
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		// Close any waiting browser-reconnect modal. Plain Modal instances are
		// not plugin-owned components, so Obsidian does not close them on
		// unload; a stale one would stay interactive and write tokens and
		// settings through this dead instance. Clear the state first so the
		// modal's onClose callback (and any in-flight delivery) sees the flow
		// as gone.
		if (this.browserReconnect !== null) {
			const staleFlow = this.browserReconnect;
			this.browserReconnect = null;
			try {
				staleFlow.modal.close();
			} catch (err) {
				console.error(
					'Plaud importer: failed to close reconnect modal',
					err,
				);
			}
			staleFlow.release();
		}
		// Hide any sticky action notice (e.g. an auth-pause "Reconnect") so its
		// click handler cannot open sign-in or save settings after unload.
		for (const notice of this.actionNotices) {
			notice.hide();
		}
		this.actionNotices.clear();
		this.sessionExpiryNotice = null;
		this.autoSyncPauseNotice = null;
		// Obsidian auto-detaches ribbon icons on unload; clear our
		// state so a subsequent onload starts from a known baseline.
		this.ribbonIconEl = null;
		this.ribbonIconId = null;
	}

	// Reads the linked secret's raw stored value, or "" when none is linked.
	// Shared by the settings status line, Test connection, and the
	// session-status command, so they always describe the same credential.
	readStoredTokenValue(): string {
		const id = this.settings.secretId;
		return id.length > 0
			? (this.app.secretStorage.getSecret(id) ?? '')
			: '';
	}

	// Thin wrapper over the pure formatSessionStatus in plaud-token.ts (where
	// its never-leak contract is pinned by tests): supplies the live plugin
	// version, settings, and stored secret value.
	private formatSessionStatus(): string {
		return formatSessionStatus({
			pluginVersion: this.manifest.version,
			apiBaseUrl: this.settings.apiBaseUrl,
			signInMethod: this.settings.signInMethod,
			tokenValue: this.readStoredTokenValue(),
		});
	}

	// ---- Pre-expiry session warning (issue #78, 0.34.0) ------------------

	// Re-evaluates the session-expiry warning: clears any armed timer, then
	// either warns now (once per credential, keyed on the exact expMs) or
	// arms a clamped timeout to re-evaluate at expiry-minus-lead. Called from
	// onLayoutReady and EVERY credential mutation (storeAccessToken,
	// reauthenticate, clearSignIn, the settings secret picker), so the timer
	// can never describe a stale credential. Mirrors the timer-id clearing
	// discipline of reconcileAutoSync.
	reconcileSessionExpiryWarning(): void {
		if (this.sessionExpiryTimeoutId !== undefined) {
			window.clearTimeout(this.sessionExpiryTimeoutId);
			this.sessionExpiryTimeoutId = undefined;
		}
		// A still-visible warning describes the credential as it was when it
		// fired; every reconcile is a potential credential change, so dismiss
		// it and let the decision below re-derive. Hiding an already-hidden
		// notice is a no-op.
		if (this.sessionExpiryNotice !== null) {
			this.sessionExpiryNotice.hide();
			this.actionNotices.delete(this.sessionExpiryNotice);
			this.sessionExpiryNotice = null;
		}
		// The renewal-failure prompt goes with it, and for the same reason.
		// This reconcile runs on every credential mutation and when the warning
		// timer fires, so clearing it here is what stops a stale "could not
		// renew" notice outliving the credential it described or stacking under
		// the warning that replaces it.
		if (this.sessionRefreshFailureNotice !== null) {
			this.sessionRefreshFailureNotice.hide();
			this.actionNotices.delete(this.sessionRefreshFailureNotice);
			this.sessionRefreshFailureNotice = null;
		}
		if (this.disposed) return;
		const value = this.readStoredTokenValue();
		const life = value.length > 0 ? readTokenLifetime(value) : null;
		const decision = sessionExpiryDecision(
			Date.now(),
			life,
			this.settings.sessionWarnedForExpMs,
		);
		if (decision.action === 'scheduled' && decision.armDelayMs !== null) {
			this.sessionExpiryTimeoutId = window.setTimeout(() => {
				this.sessionExpiryTimeoutId = undefined;
				this.reconcileSessionExpiryWarning();
			}, decision.armDelayMs);
			return;
		}
		if (decision.action !== 'warn' || decision.expMs === null) {
			return;
		}
		// Stamp BEFORE showing, so a notice path that throws cannot re-nag on
		// every reconcile. The stamp is keyed to this exact expMs; a fresh
		// credential carries a different exp and warns again.
		this.settings.sessionWarnedForExpMs = decision.expMs;
		this.saveSettingsDetached('saving the session warning stamp failed');
		// Above ~2 days speak in days ("about 7 days"), below in hours: the
		// long (7-day) lead would otherwise read as "about 168 hours".
		const hoursLeft = Math.max(
			1,
			Math.round((decision.expMs - Date.now()) / 3_600_000),
		);
		const timeLeft =
			hoursLeft > 48
				? `${Math.round(hoursLeft / 24)} days`
				: `${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}`;
		this.sessionExpiryNotice = this.showActionNotice(
			decision.expired
				? 'Your Plaud session has expired. Reconnect to keep imports and auto-sync running.'
				: `Your Plaud session expires in about ${timeLeft}. Reconnect now to avoid an interruption.`,
			'Reconnect',
			() => this.reconnectFreshFromExpiryNotice(),
		);
	}

	// Re-evaluates the silent session refresh: clears any armed timer, then arms
	// a new one when this session is one the refresh can actually serve. Called
	// from onLayoutReady and every credential mutation, exactly like
	// reconcileSessionExpiryWarning, so the timer can never describe a stale
	// credential.
	//
	// This vault's Plaud sign-in partition (issue #87).
	//
	// Derived on every use rather than cached in a field, because the value is
	// only ever a pure function of the host's vault id and re-deriving costs a
	// regex test. Caching it would add a second place for sign-in and refresh to
	// disagree about which cookie jar is current, which is precisely the class of
	// bug this change exists to remove.
	private signInPartition(): string {
		return plaudPartition(this.app.appId);
	}

	// Gated on the RECORDED sign-in method. The refresh authenticates with the
	// embedded sign-in window's partition cookies, and only that window ever
	// populates that partition: SSO completes in the external browser and the
	// bookmarklet runs in the user's own browser, so neither leaves anything to
	// authenticate with. Attempting it for them would fail every cycle and
	// nag; they reconnect manually, by design.
	reconcileSessionRefresh(): void {
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		if (this.disposed || this.sessionRefreshFailed) return;
		if (this.settings.signInMethod !== 'window') return;
		const token = this.readStoredTokenValue();
		if (token.length === 0) return;
		// Only a workspace token wants this. Minting against a long-lived
		// credential would trade months of life for 24 hours; see
		// isWorkspaceToken.
		if (!isWorkspaceToken(token)) return;
		// No transport, no renewal. Arming a timer that can only ever return
		// "unsupported" wastes a wake-up and, worse, lets the settings copy go
		// on promising a renewal this build cannot perform.
		if (buildPartitionPost(this.signInPartition()) === null) return;
		const delay = computeRefreshDelayMs(token, Date.now());
		if (delay === null) return;
		this.sessionRefreshTimeoutId = window.setTimeout(() => {
			this.sessionRefreshTimeoutId = undefined;
			// Belt and braces on top of the store's own catch: nothing on a
			// background timer may reject into the console unhandled.
			void this.runScheduledSessionRefresh().catch((err: unknown) => {
				console.error(
					'Plaud importer: scheduled session refresh failed',
					err,
				);
			});
		}, delay);
	}

	// The timer callback. Re-reads the credential rather than closing over it:
	// the wake-up can be up to 20 days after arming (the clamp), and the
	// credential may have been replaced by a reconnect in between.
	private async runScheduledSessionRefresh(): Promise<void> {
		if (this.disposed || this.sessionRefreshInFlight) return;
		const token = this.readStoredTokenValue();
		// Not actually due yet: the 20 day clamp means an early wake is normal.
		// Re-arm rather than spend a mint call against the hourly ceiling.
		if (token.length > 0 && !isRefreshDue(token, Date.now())) {
			this.reconcileSessionRefresh();
			return;
		}
		const outcome = await this.refreshSessionNow();
		// A deferral is not a failure and must not silently end renewal. "busy"
		// means a sign-in window was open (or another refresh was running), and
		// the timer that brought us here is already spent: if the user then
		// CANCELS that sign-in nothing else reconciles the schedule, so this
		// token would run to expiry with no further attempt. Re-arm instead.
		// "superseded" re-arms through the newer credential's own store, but
		// reconciling again is idempotent and keeps the rule simple. "failed"
		// deliberately does not re-arm; "unsupported" has nothing to arm.
		if (outcome === 'busy' || outcome === 'superseded') {
			this.reconcileSessionRefresh();
		}
	}

	// Runs the two-step cookie refresh once and stores the result. Returns what
	// happened so the debug command can report it; the scheduled path reacts to
	// deferrals and otherwise goes through the state this sets.
	//
	// No retry, by measurement: step 1 reports `login_total_per_hour: 10`, so a
	// backoff ladder against a dead session spends the account's whole refresh
	// budget and can lock it out of renewing at all. One attempt; on failure
	// pause and prompt Reconnect.
	async refreshSessionNow(): Promise<
		'refreshed' | 'unsupported' | 'failed' | 'busy' | 'superseded'
	> {
		if (this.sessionRefreshInFlight) return 'busy';
		// Never run underneath an open sign-in window. Reconnect CLEARS the
		// sign-in partition before reopening it, and that partition's cookies
		// are the only thing this refresh authenticates with, so the two would
		// be fighting over the same session. reauthenticate() holds the mirror
		// of this lock; both are needed, because in the other order the sign-in
		// window can re-capture the stale pre-refresh token and store it over a
		// refresh that had already succeeded.
		if (this.reauthInFlight) return 'busy';
		if (this.settings.signInMethod !== 'window') return 'unsupported';
		const current = this.readStoredTokenValue();
		if (current.length === 0) return 'unsupported';
		// A long-lived credential must not be traded for a 24 hour one.
		if (!isWorkspaceToken(current)) return 'unsupported';
		// Which secret that value came from, not just the value. The picker can
		// be pointed at a DIFFERENT secret holding the same token, and a value
		// comparison alone would call that unchanged and then re-link
		// CAPTURED_SECRET_ID underneath the user's choice.
		const currentSecretId = this.settings.secretId;
		const post = buildPartitionPost(this.signInPartition());
		if (post === null) {
			this.debugLogger.log({
				kind: 'error',
				endpoint: '/session-refresh',
				message:
					'session refresh unavailable: no Electron session.fetch on this build',
			});
			return 'unsupported';
		}
		// Held until the fresh token is STORED, not merely fetched. Clearing it
		// when the network settled would reopen the gap it exists to close: the
		// user could start a sign-in during validation and storage, and that
		// window can capture the partition's stale token and write it over the
		// one this call just minted.
		this.sessionRefreshInFlight = true;
		try {
			const result = await performNetRefresh({
				currentToken: current,
				baseUrl: this.settings.apiBaseUrl,
				post,
				log: (message, payload) => {
					this.debugLogger.log({
						kind: 'note',
						endpoint: '/session-refresh',
						message,
						payload,
					});
				},
			});
			// A plugin unloaded mid-refresh must not write storage.
			if (this.disposed) return 'failed';
			// Supersede check FIRST, ahead of both the success and the failure
			// branch. The two calls above take seconds and nothing serializes them
			// against the user: a reconnect, a paste, a different linked secret or a
			// sign out can all land while they are in flight. Writing a success
			// afterwards would clobber the credential the user just chose, or
			// re-link one they just cleared. Recording a FAILURE afterwards is just
			// as wrong and less obvious: it would mark the user's brand new session
			// as failed and clear the refresh timer that session had just armed,
			// leaving it with no unattended renewal at all. This result belongs to a
			// credential nobody is using any more, so it is simply dropped.
			if (
				this.readStoredTokenValue() !== current ||
				this.settings.secretId !== currentSecretId
			) {
				this.debugLogger.log({
					kind: 'note',
					endpoint: '/session-refresh',
					message:
						'session refresh discarded: the stored credential changed while it ran',
				});
				return 'superseded';
			}
			// Validate before storing, the same guard every other capture path
			// applies. A mint that answered 200 with something that is not a usable
			// token must never replace a working credential.
			//
			// Plus one requirement specific to this path: the value has to carry a
			// `wid`. isUsableUserToken deliberately accepts anything future-dated
			// with a client_id that is not a WRT, which includes a user token with
			// no workspace id. Storing one of those looks like a success and then
			// silently ends unattended renewal, because the NEXT refresh reads its
			// workspace id off the stored token and aborts without one. Checked
			// here rather than by tightening the shared guard, which must keep
			// accepting WT.
			//
			// And it has to be a token that actually MOVED the expiry. A mint
			// that hands back the current credential, or any WT already inside
			// the refresh window, would be stored as a success, clear the
			// failure state, and then schedule its own next attempt at the 30
			// second floor, looping against a ceiling of about 10 refreshes an
			// hour. Refusing it leaves the old token in place to expire
			// normally, which surfaces as the ordinary reconnect prompt
			// instead of a retry storm.
			if (
				result === null ||
				!isUsableUserToken(result.token) ||
				!isWorkspaceToken(result.token) ||
				extractWorkspaceId(result.token) === null ||
				isRefreshDue(result.token, Date.now())
			) {
				this.debugLogger.log({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						result === null
							? 'session refresh failed: the two-step refresh did not return a token'
							: !isUsableUserToken(result.token)
								? 'session refresh failed: the minted value did not pass the capture guard'
								: !isWorkspaceToken(result.token)
									? 'session refresh failed: the minted value is not a workspace token'
									: extractWorkspaceId(result.token) === null
										? 'session refresh failed: the minted value carries no workspace id to refresh against'
										: 'session refresh failed: the minted token is already inside the refresh window',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			// A vault that will not take the settings write comes back as a
			// `save-failed` outcome now rather than a throw, so it can be named in
			// the log. The try/catch stays for everything else the store touches
			// after its commit: this runs from a timer whose caller only voids the
			// promise, so an escaping rejection would be an unhandled one AND would
			// skip both the failure prompt and the re-arm, quietly ending
			// unattended renewal until the next reload.
			//
			// The supersede check above is re-run inside the store, and has to be.
			// Since the store commits settings before writing the secret, a user
			// capture that is mid-commit has not reached `setSecret` yet, so
			// `readStoredTokenValue()` still returns the old value and that check
			// passes when it should not. It stays where it is because discarding
			// there is cheaper than queueing and then discarding.
			let stored: CaptureStoreResult;
			try {
				stored = await this.captureStore.storeAccessToken(
					result.token,
					'window',
					result.apiBaseUrl ?? undefined,
					true,
					() =>
						!this.disposed &&
						this.readStoredTokenValue() === current &&
						this.settings.secretId === currentSecretId,
				);
			} catch (err) {
				this.debugLogger.log({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						'session refresh failed: storing the fresh token threw',
					payload: {
						error: err instanceof Error ? err.message : String(err),
					},
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			if (stored.outcome === 'superseded') {
				// Same meaning as the early supersede check, so the same result:
				// drop it, and do NOT record a failure. Marking the user's brand new
				// session as failed would clear the timer it had just armed.
				this.debugLogger.log({
					kind: 'note',
					endpoint: '/session-refresh',
					message:
						'session refresh discarded: the stored credential changed while the store was queued',
				});
				return 'superseded';
			}
			if (stored.outcome !== 'stored') {
				this.debugLogger.log({
					kind: 'error',
					endpoint: '/session-refresh',
					message:
						stored.outcome === 'save-failed'
							? 'session refresh failed: the vault would not accept the settings write, so the fresh token was not stored and the previous session is unchanged'
							: stored.outcome === 'torn'
								? 'session refresh failed: the settings write landed but the credential write did not, so data.json names a session whose token was never stored'
								: 'session refresh failed: the minted token did not pass the capture guard at store time',
				});
				this.onSessionRefreshFailed();
				return 'failed';
			}
			this.sessionRefreshFailed = false;
			this.debugLogger.log({
				kind: 'note',
				endpoint: '/session-refresh',
				message: 'session refresh succeeded; a fresh token is stored',
			});
			// A tick that ran while the token was expired (Obsidian waking from
			// sleep, say) will have paused auto-sync before this refresh
			// finished. The credential is good again, so lift that pause;
			// otherwise every later tick stays skipped until the user resumes by
			// hand, which is exactly the unattended operation this exists for.
			this.resumeAutoSyncIfPaused();
			// storeAccessToken already reconciled the warning and this schedule.
			return 'refreshed';
		} finally {
			this.sessionRefreshInFlight = false;
		}
	}

	// Fire-and-forget settings write, for the paths that are synchronous by
	// design (timer callbacks, notice handlers) and have no caller to await it.
	// The catch is not optional here. This exact feature reaches these lines
	// BECAUSE a vault write failed, so a bare `void saveSettings()` would very
	// likely reject for the same reason and, being detached, would escape every
	// caller's catch as the unhandled rejection the refresh path exists to
	// avoid.
	private saveSettingsDetached(context: string): void {
		void this.saveSettings().catch((err: unknown) => {
			console.error(`Plaud importer: ${context}`, err);
		});
	}

	// A failed refresh pauses unattended renewal and asks for a reconnect. It
	// deliberately does NOT re-arm: see the no-retry note above.
	private onSessionRefreshFailed(): void {
		this.sessionRefreshFailed = true;
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		// Let the existing pre-expiry machinery own the user-facing prompt. The
		// credential is still live (the refresh runs a lead time before expiry),
		// so this surfaces as the normal Reconnect notice rather than a second,
		// competing one.
		//
		// Clearing the warn stamp first is what makes that actually appear. On a
		// 24 hour token both timers come due at the same two-hour lead, so the
		// warning has usually already fired and stamped this exact expiry while
		// the refresh was still on the network. reconcileSessionExpiryWarning
		// hides the visible notice before re-deriving, and a stamped expiry
		// re-derives as 'quiet', so without this the failure would take the
		// user's only Reconnect prompt away and put nothing back. The stamp
		// exists to stop repeat nagging for one expiry; a refresh that just
		// failed is new information and earns the one re-warn.
		// Persisted, not just assigned. reconcileSessionExpiryWarning only saves
		// when it actually warns, so without this the cleared stamp lives in
		// memory alone: a reload would restore the OLD stamp from disk and
		// suppress the reconnect warning for the very credential whose renewal
		// just failed.
		this.settings.sessionWarnedForExpMs = 0;
		this.saveSettingsDetached('clearing the session warning stamp failed');
		this.reconcileSessionExpiryWarning();
		// Renewal now runs a clear margin BEFORE the warning's own lead, so at
		// the moment a refresh fails the credential is usually still OUTSIDE
		// the warn window and the reconcile above only arms a timer. Waiting
		// that out would leave the user with no sign that unattended renewal
		// had stopped, for hours. Prompt directly instead, and stamp this
		// expiry so the scheduled warning does not later post a second,
		// near-identical notice for the same credential.
		// Deliberately does NOT stamp sessionWarnedForExpMs and does NOT take
		// over this.sessionExpiryNotice. Stamping would silence the scheduled
		// warning when it comes due, and that warning is the prompt covering
		// the final hours before expiry: the user would be told once, four
		// hours out, and then left with nothing at the point it matters most.
		// Leaving the stamp at zero lets the warning fire normally as an
		// escalation, and because reconcile hides the tracked notice before
		// showing its own, only one is ever on screen. Skipped when a warning
		// notice is already up, so the two never stack.
		if (this.sessionExpiryNotice === null) {
			this.sessionRefreshFailureNotice = this.showActionNotice(
				'Could not renew your Plaud session automatically. Reconnect to keep imports and auto-sync running.',
				'Reconnect',
				() => this.reconnectFreshFromExpiryNotice(),
			);
		}
		// Renewal has stopped for this credential, so an open settings tab is
		// now showing a renewal promise that is no longer true. Redraw it.
		try {
			this.settingsRefresh?.();
		} catch (err) {
			console.error('Plaud importer: settings refresh failed', err);
		}
	}
	// Reconnect action for the pre-expiry notice specifically. For a
	// window-flow account the embedded window's persistent session can still
	// hold the SAME near-expiry token, and openPlaudLogin captures any usable
	// token instantly: without clearing the login session first, "Reconnect"
	// would close immediately, report success, and change nothing. Clearing
	// only the login partition is non-destructive: the stored secret is
	// untouched, so closing the window without signing in loses nothing.
	// Skipped while a sign-in window is already open (the single-flight guard
	// in reauthenticate would refuse anyway; clearing under a live window
	// would break it).
	private async reconnectFreshFromExpiryNotice(): Promise<void> {
		// Checked HERE, ahead of the clear, not just inside reauthenticate. The
		// clear destroys the very cookies an in-flight refresh authenticates
		// with, so reaching reauthenticate's guard first would be too late: the
		// refresh would fail AND the sign-in would then be refused, which is
		// the worst of both. This is a reachable ordering, not a corner case:
		// on a 24 hour token the refresh timer and the warning that shows this
		// button both come due at the same two-hour lead. A refresh takes
		// seconds and, if it succeeds, removes the reason to reconnect at all.
		if (this.sessionRefreshInFlight) {
			new Notice(
				'Renewing your session now. Try reconnecting in a moment if it does not clear.',
			);
			return;
		}
		// Disarm the scheduled refresh BEFORE yielding to the clear. The check
		// above only proves no refresh is running right now; clearing is an
		// await, and the timer could come due during it and start one against a
		// partition being destroyed. Cancelling the timer closes that window,
		// because the timer is the only thing that starts a refresh on its own
		// (the other entry point is the manual debug command).
		if (this.sessionRefreshTimeoutId !== undefined) {
			window.clearTimeout(this.sessionRefreshTimeoutId);
			this.sessionRefreshTimeoutId = undefined;
		}
		try {
			if (this.reconnectPrefersWindow() && !this.reauthInFlight) {
				try {
					await clearPlaudLoginSession(this.app);
				} catch (err) {
					console.error(
						'Plaud importer: failed to clear login session before reconnect',
						err,
					);
				}
			}
			await this.reconnectFromNotice();
		} finally {
			// Put the schedule back however this ended. A reconnect that stored
			// a credential has already re-armed through storeAccessToken and
			// this is a no-op; one the user CANCELLED would otherwise be left
			// with the timer cancelled above and no renewal at all.
			this.reconcileSessionRefresh();
		}
	}

	// True when reconcileSessionRefresh would arm background renewal for this
	// credential: the right sign-in method, a workspace token (a long-lived
	// pre-v2 token is deliberately skipped, since refreshing would trade
	// months of life for 24 hours), a build that can reach the partition, and
	// an expiry the scheduler can compute a wake-up from. Runtime state
	// (disposed, a failed attempt, a pause) is deliberately NOT in here;
	// callers report those separately. Every user-facing claim about renewal
	// routes through here so the copy cannot disagree with what the scheduler
	// actually does. signInMethod is a parameter because capture surfaces are
	// not serialized (issue #86): a capture notice must describe the capture
	// it belongs to even if a concurrent capture rewrites settings meanwhile.
	canRenewCredential(
		token: string,
		signInMethod: SignInMethod = this.settings.signInMethod,
	): boolean {
		return (
			signInMethod === 'window' &&
			isWorkspaceToken(token) &&
			buildPartitionPost(this.signInPartition()) !== null &&
			computeRefreshDelayMs(token, Date.now()) !== null
		);
	}

	// One-time capture heads-up (issue #78): a short (24h) session is normal
	// now, so the message's job is to say what happens when it runs out.
	// Advisory only: lifetime never gates a capture, and an unreadable or
	// iat-less token stays silent rather than guessing.
	private noteShortLifetimeOnCapture(
		token: string,
		signInMethod: SignInMethod,
	): void {
		const life = readTokenLifetime(token);
		if (life === null || life.lifetimeHours === null) {
			return;
		}
		if (life.lifetimeHours > SHORT_LIFETIME_HOURS) {
			return;
		}
		const hours = Math.max(1, Math.round(life.lifetimeHours));
		// The method is passed in rather than read back from settings: a
		// concurrent capture could rewrite settings.signInMethod between this
		// capture's save and its notice.
		const canRenew = this.canRenewCredential(token, signInMethod);
		const issued = `Plaud issued this sign-in a session of about ${hours} hour${
			hours === 1 ? '' : 's'
		}.`;
		new Notice(
			canRenew
				? `${issued} The plugin renews it in the background for about 30 days, then asks you to sign in again.`
				: `${issued} The plugin will ask you to sign in again when it expires.`,
			12000,
		);
	}

	/**
	 * Make one lightweight authenticated call so the user can confirm their
	 * stored token actually reaches Plaud, without running a full import. Maps
	 * any failure through the same classifier the import modal uses, so an
	 * expired or wrong-type token reports the exact remediation (e.g. sign in
	 * again) instead of a generic failure.
	 */
	async testPlaudConnection(): Promise<{ ok: boolean; message: string }> {
		const client = this.client;
		if (client === undefined) {
			return {
				ok: false,
				message:
					'Plaud Importer is still starting up. Wait a moment and try again.',
			};
		}
		try {
			const recordings = await client.listRecordings({ limit: 1 });
			// A working token is a valid resume trigger for a paused auto-sync.
			this.resumeAutoSyncIfPaused();
			// Append the measured session status (issue #78): this button is
			// what users press when imports start failing, so it should say
			// how long the session was issued for and when it runs out.
			const value = this.readStoredTokenValue();
			const lifeSentence =
				value.length > 0
					? ` ${describeTokenLifetime(readTokenLifetime(value))}.`
					: '';
			return {
				ok: true,
				message:
					(recordings.length > 0
						? 'Connected to Plaud. Your token works and recordings are reachable.'
						: 'Connected to Plaud. Your token works (no recordings found yet).') +
					lifeSentence,
			};
		} catch (err) {
			return { ok: false, message: classifyError(err).message };
		}
	}

	// ---- Auto-sync (issue #5) -------------------------------------------

	private logAutoSync(message: string, payload?: unknown): void {
		if (!this.debugLogger.enabled) return;
		this.debugLogger.log({
			kind: 'note',
			endpoint: '/auto-sync',
			message,
			payload,
		});
	}

	/**
	 * Runtime import options shared by the manual modal and the headless
	 * auto-sync path, built from the current settings. Single-sourced so the two
	 * import paths never drift as settings are added.
	 */
	private buildImportRuntimeOptions(): ImportModalOptions {
		return {
			outputFolder: this.settings.outputFolder,
			subfolderTemplate: this.settings.subfolderTemplate,
			noteNameTemplate: this.settings.noteNameTemplate,
			datetimeTemplate: this.settings.datetimeTemplate,
			customFrontmatter: this.settings.customFrontmatter,
			preserveUnknownFrontmatter:
				this.settings.preserveUnknownFrontmatter,
			forbiddenCharReplacement: this.settings.forbiddenCharReplacement,
			onDuplicate: this.settings.onDuplicate,
			includeTranscript: this.settings.includeTranscript,
			includeSummary: this.settings.defaultIncludeSummary,
			foldTranscript: this.settings.foldTranscript,
			transcriptHeaderLevel: this.settings.transcriptHeaderLevel,
			defaultIncludeSummary: this.settings.defaultIncludeSummary,
			defaultIncludeAttachments: this.settings.defaultIncludeAttachments,
			defaultIncludeMindmap: this.settings.defaultIncludeMindmap,
			defaultIncludeCard: this.settings.defaultIncludeCard,
			defaultIncludeAudio: this.settings.defaultIncludeAudio,
			tagMode: this.settings.tagMode,
			customTags: this.settings.customTags,
			aiKeywordsAsProperty: this.settings.aiKeywordsAsProperty,
			autoCloseSummary: this.settings.autoCloseSummary,
			autoCloseSummarySeconds: this.settings.autoCloseSummarySeconds,
			writePlaceholderForUnprocessed:
				this.settings.writePlaceholderForUnprocessed,
			showTrashedRecordings: this.settings.showTrashedRecordings,
			hideProcessedRecordings: this.settings.hideProcessedRecordings,
			hideUpdatesRecordings: this.settings.hideUpdatesRecordings,
			hideIgnoredRecordings: this.settings.hideIgnoredRecordings,
			// data.json stores plain strings; PlaudRecordingId is a compile-time
			// brand over string. Re-tag each id at this boundary (a per-element
			// cast is legal where an array cast is not).
			ignoredRecordingIds: this.settings.ignoredRecordingIds.map(
				(id) => id as PlaudRecordingId,
			),
			debugLogger: this.debugLogger,
			getAuthToken: () =>
				this.settings.secretId.length > 0
					? this.app.secretStorage.getSecret(this.settings.secretId)
					: null,
			getApiBaseUrl: () => this.settings.apiBaseUrl,
			// Issue A: when a re-import lands a recording whose target name/path
			// differs from its existing note (a title or subfolder change), move
			// the note + its assets folder instead of overwriting stale-named
			// content in place. Wrapped with the self-rename loop guard so the
			// cascade does not re-fire the vault rename listener.
			migrateExistingNote: (oldPath, newPath) =>
				this.migrateRecordingNote(oldPath, newPath),
		};
	}

	/**
	 * Rename an existing note and its `<base>-assets` folder to `newNotePath` as
	 * a unit, guarding the whole cascade with the self-rename flag so our own
	 * rename does not trigger the vault rename listener. Backs both the
	 * auto-migration (Issue A) and the local rename command (Issue B).
	 */
	private async migrateRecordingNote(
		oldNotePath: string,
		newNotePath: string,
	): Promise<void> {
		const renameFile: RenameFileFn = async (from, to) => {
			const item = this.app.vault.getAbstractFileByPath(from);
			if (item === null) {
				throw new Error(`Nothing to rename at ${from}`);
			}
			await this.app.fileManager.renameFile(item, to);
		};
		this.selfRenameDepth += 1;
		try {
			await renameRecordingNote(
				this.app.vault,
				renameFile,
				oldNotePath,
				newNotePath,
			);
		} finally {
			this.selfRenameDepth -= 1;
		}
	}

	/**
	 * True when `file` is a markdown note this plugin imported, identified by a
	 * non-empty `plaud-id` in its frontmatter (read from the metadata cache).
	 * The rename command, context-menu item, and rename listener all gate on
	 * this so they never act on an unrelated note.
	 */
	private isPlaudNote(file: unknown): file is TFile {
		return (
			file instanceof TFile &&
			file.extension === 'md' &&
			this.plaudIdOf(file) !== null
		);
	}

	// DEPRECATED ONE-TIME MIGRATION (issue #52) — REMOVE IN A FUTURE VERSION.
	// Scans this plugin's imported notes for Plaud's broken inline card-poster
	// embed and repoints each at the card image already in the note's `-assets`
	// folder. User-invoked only, idempotent (a repointed wikilink is not matched
	// again), and never touches non-Plaud notes. Notes whose card was never
	// downloaded are left for a re-import and counted in the report.
	private async repairLegacyCardLinks(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.repairInFlight) {
			new Notice('Plaud importer: card link repair is already running.');
			return;
		}
		this.repairInFlight = true;
		let notesRepaired = 0;
		let linksRepointed = 0;
		let notesNeedingReimport = 0;
		try {
			for (const file of this.app.vault.getMarkdownFiles()) {
				// Stop cleanly if the plugin unloads mid-scan.
				if (this.disposed) {
					return;
				}
				if (!this.isPlaudNote(file)) {
					continue;
				}
				let content: string;
				try {
					content = await this.app.vault.read(file);
				} catch {
					continue;
				}
				if (this.disposed) {
					return;
				}
				// Cheap prefilter: Plaud's card poster path always carries this marker.
				if (!content.includes('summary_poster')) {
					continue;
				}
				const assetsPath = file.path.replace(/\.md$/i, '-assets');
				const folder = this.app.vault.getFolderByPath(assetsPath);
				const cardPaths: string[] = [];
				if (folder !== null) {
					for (const child of folder.children) {
						if (
							child instanceof TFile &&
							isLocalCardImage(child.name)
						) {
							cardPaths.push(child.path);
						}
					}
				}
				// Gate the write on the read content, but recompute inside process on
				// the FRESH content so a concurrent edit is never clobbered.
				const preview = repairLegacyCardEmbeds(content, cardPaths);
				if (preview.repointed === 0) {
					if (preview.unrepairable > 0) {
						notesNeedingReimport += 1;
					}
					continue;
				}
				let written = { repointed: 0, unrepairable: 0 };
				try {
					await this.app.vault.process(file, (fresh) => {
						const r = repairLegacyCardEmbeds(fresh, cardPaths);
						written = {
							repointed: r.repointed,
							unrepairable: r.unrepairable,
						};
						return r.content;
					});
				} catch {
					// A single-note write failure must not abort the whole batch.
					continue;
				}
				if (written.repointed > 0) {
					notesRepaired += 1;
					linksRepointed += written.repointed;
				}
				if (written.unrepairable > 0) {
					notesNeedingReimport += 1;
				}
			}
		} finally {
			this.repairInFlight = false;
		}
		const tail =
			notesNeedingReimport > 0
				? ` ${notesNeedingReimport} note${notesNeedingReimport === 1 ? '' : 's'} had a broken card with no local copy; re-import those.`
				: '';
		new Notice(
			`Plaud Importer: repaired ${linksRepointed} card link${linksRepointed === 1 ? '' : 's'} in ${notesRepaired} note${notesRepaired === 1 ? '' : 's'}.${tail}`,
		);
	}

	/**
	 * Ask for a new name for `file`, then rename the note and its assets folder
	 * together (same folder, new base name). Local only; no write back to Plaud.
	 */
	private promptRenameRecording(file: TFile): void {
		new RenameRecordingModal(this.app, file.basename, (rawName) => {
			// sanitizeFilename never returns empty (it falls back to "Untitled"),
			// and the modal already rejects an empty entry, so there is no
			// unusable-name case to handle here. Uses the configured replacement
			// character so a manual rename matches how imports sanitize names.
			const sanitized = sanitizeFilename(
				rawName,
				this.settings.forbiddenCharReplacement,
			);
			// Obsidian represents the vault root as either "" or "/" depending on
			// the call site; treat both as no-dir so a root note does not produce
			// a leading-slash path like "/New name.md".
			const parentPath = file.parent?.path ?? '';
			const dir =
				parentPath === '' || parentPath === '/' ? '' : `${parentPath}/`;
			const newPath = `${dir}${sanitized}.md`;
			if (newPath === file.path) {
				return;
			}
			void this.runLocalRename(file.path, newPath, sanitized);
		}).open();
	}

	/** Perform the command-driven rename and report success/failure to the user. */
	private async runLocalRename(
		oldPath: string,
		newPath: string,
		displayName: string,
	): Promise<void> {
		try {
			await this.migrateRecordingNote(oldPath, newPath);
			new Notice(`Plaud importer: renamed to "${displayName}".`);
		} catch (err) {
			console.error('Plaud importer: rename failed', err);
			new Notice(
				`Plaud importer: rename failed. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return;
		}
		// Offer/do the Plaud title write-back only after a successful local rename.
		await this.maybeUpdatePlaudTitle(newPath, true);
	}

	/**
	 * Cascade a user's note rename (from Obsidian's own UI) to the note's assets
	 * folder. The note is already at `newPath`; renameRecordingNote moves only
	 * the folder. Silent when there is no assets folder; surfaces a Notice only
	 * when the folder move fails (which would otherwise leave embeds broken).
	 */
	private async cascadeUserRename(
		oldPath: string,
		newPath: string,
	): Promise<void> {
		try {
			await this.migrateRecordingNote(oldPath, newPath);
		} catch (err) {
			console.error(
				'Plaud importer: attachments-folder rename cascade failed',
				err,
			);
			new Notice(
				`Plaud importer: could not rename the attachments folder. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return;
		}
		// A file-explorer rename pushes to Plaud only when auto-update is on
		// (fromCommand = false means no prompt; the setting is the sole gate).
		await this.maybeUpdatePlaudTitle(newPath, false);
	}

	/**
	 * Read a note's `plaud-id` from the metadata cache, or null when the note is
	 * not a Plaud import. Widened through unknown to avoid an unsafe any.
	 */
	private plaudIdOf(file: TFile): string | null {
		const fm: unknown =
			this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm === null || typeof fm !== 'object') {
			return null;
		}
		const id = (fm as Record<string, unknown>)['plaud-id'];
		return typeof id === 'string' && id.trim().length > 0
			? id.trim()
			: null;
	}

	/**
	 * After a local rename, optionally update the recording's title in Plaud.
	 * With autoUpdatePlaudTitle ON, pushes automatically. With it OFF, asks first,
	 * but only for a rename started from the plugin command (`fromCommand`); a
	 * file-explorer rename with the setting OFF stays local. No-op for a note
	 * without a plaud-id or when the client is not ready. The pushed title is the
	 * new note base name exactly (including any date prefix), so Plaud matches
	 * what the user set in Obsidian.
	 */
	private async maybeUpdatePlaudTitle(
		newNotePath: string,
		fromCommand: boolean,
	): Promise<void> {
		const file = this.app.vault.getFileByPath(newNotePath);
		if (!(file instanceof TFile)) {
			return;
		}
		const plaudId = this.plaudIdOf(file);
		if (plaudId === null) {
			return;
		}
		const title = file.basename;
		if (title.length === 0) {
			return;
		}
		const client = this.client;
		if (client === undefined) {
			if (fromCommand && this.settings.autoUpdatePlaudTitle) {
				new Notice(
					'Plaud importer: not connected, so the recording title was not updated.',
				);
			}
			return;
		}

		if (this.settings.autoUpdatePlaudTitle) {
			await this.pushPlaudTitle(client, file, plaudId, title);
			return;
		}
		if (!fromCommand) {
			return;
		}
		// Setting off and the user renamed via the command: confirm before any
		// cloud write.
		new ConfirmModal(this.app, {
			title: 'Update the recording title?',
			body: `Also update this recording's title in Plaud to "${title}"? This changes your Plaud account.`,
			confirmText: 'Update',
			cancelText: 'Keep local',
			onConfirm: () => {
				// Re-read at confirm time: the note may have been renamed again, or
				// removed, while the prompt was open. Push the note's current name,
				// and skip entirely if it is gone.
				const current = this.app.vault.getFileByPath(file.path);
				if (current instanceof TFile) {
					void this.pushPlaudTitle(
						client,
						current,
						plaudId,
						current.basename,
					);
				}
			},
		}).open();
	}

	/**
	 * Push the title to Plaud and, on success, refresh the note's stored version
	 * marker so auto-sync does not treat our own write as a changed recording.
	 * A failure surfaces a Notice but never throws to the caller.
	 */
	private async pushPlaudTitle(
		client: PlaudClient,
		file: TFile,
		plaudId: string,
		title: string,
		alreadyReauthed = false,
	): Promise<void> {
		// The confirm-modal path defers this call, so the plugin may have unloaded
		// between the prompt and the click; do not start a cloud write if so.
		if (this.disposed) {
			return;
		}
		try {
			await client.updateTitle(plaudId as PlaudRecordingId, title);
			// The plugin can unload during the network await; do not run the
			// follow-up re-list and frontmatter write against a torn-down state.
			// The title was already updated in Plaud, so skipping the marker
			// refresh only risks one benign re-import on the next sync.
			if (this.disposed) {
				return;
			}
			new Notice(
				`Plaud importer: recording title updated to "${title}".`,
			);
			await this.refreshPlaudVersionMarker(client, file, plaudId);
		} catch (err) {
			// An expired or rejected session must not silently drop the write-back.
			// The local rename already succeeded; offer to sign in and retry the
			// push once (not a loop) so the title update is not lost. Guard on
			// alreadyReauthed so a still-failing token after sign-in falls through
			// to the plain error rather than re-prompting forever.
			if (err instanceof PlaudAuthError && !alreadyReauthed) {
				this.promptReauthAndRetryTitle(file, plaudId, title);
				return;
			}
			console.error('Plaud importer: Plaud title update failed', err);
			new Notice(
				`Plaud importer: could not update the recording title. ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/**
	 * After an expired-session failure on the title push, ask the user to sign in
	 * and, on success, retry the push once with the note's current name. Keeps
	 * the rename's Plaud sync from being lost to a stale token.
	 */
	private promptReauthAndRetryTitle(
		file: TFile,
		plaudId: string,
		title: string,
	): void {
		new ConfirmModal(this.app, {
			title: 'Sign in to update the title?',
			body: `Your Plaud session expired, so the title was not updated to "${title}". Your note is already renamed. Sign in to Plaud and finish updating the title there?`,
			confirmText: 'Sign in',
			cancelText: 'Not now',
			onConfirm: () => {
				void this.reauthAndRetryTitle(file, plaudId);
			},
		}).open();
	}

	private async reauthAndRetryTitle(
		file: TFile,
		plaudId: string,
	): Promise<void> {
		try {
			const outcome = await this.reauthenticate();
			if (outcome !== 'captured') {
				// Shown for "reported" too: it adds the consequence rather than
				// restating the cause, so it reads as a follow-on, not a contradiction.
				new Notice(
					'Plaud importer: sign-in was not completed, so the recording title was not updated.',
				);
				return;
			}
			// The browser sign-in can take a while; re-validate everything after it.
			if (this.disposed) {
				return;
			}
			const client = this.client;
			if (client === undefined) {
				return;
			}
			// Re-read the note at its path and confirm it is STILL the same
			// recording (same plaud-id). During sign-in the file could have been
			// moved, deleted, or replaced, and we must not push an unrelated file's
			// name to this recording. alreadyReauthed = true so a second auth
			// failure does not loop back into another sign-in prompt.
			const current = this.app.vault.getFileByPath(file.path);
			if (
				!(current instanceof TFile) ||
				this.plaudIdOf(current) !== plaudId
			) {
				return;
			}
			await this.pushPlaudTitle(
				client,
				current,
				plaudId,
				current.basename,
				true,
			);
		} catch (err) {
			// reauthenticate() and its token persistence can throw; keep this
			// fire-and-forget path from becoming an unhandled rejection.
			console.error(
				'Plaud importer: sign-in retry for the title update failed',
				err,
			);
			new Notice(
				'Plaud importer: sign-in failed, so the recording title was not updated.',
			);
		}
	}

	/**
	 * Best-effort: after a title push, re-read the recording's new version_ms
	 * (the title edit bumps its edit_time, so it sorts to the top of an
	 * edit-time list) and store it in the note's `plaud-version-ms` frontmatter.
	 * Without this, the next auto-sync would see our own write as a changed
	 * recording and re-import it. A failure here is benign (one redundant
	 * re-import at worst, with the title already matching so no rename), so it is
	 * logged and swallowed.
	 */
	private async refreshPlaudVersionMarker(
		client: PlaudClient,
		file: TFile,
		plaudId: string,
	): Promise<void> {
		try {
			const recent = await client.listRecordings({
				sortBy: 'edit_time',
				limit: 10,
			});
			const updated = recent.find((r) => r.id === plaudId);
			if (updated?.versionMs === undefined) {
				return;
			}
			const versionMs = updated.versionMs;
			await this.app.fileManager.processFrontMatter(
				file,
				(fm: Record<string, unknown>) => {
					fm['plaud-version-ms'] = versionMs;
				},
			);
		} catch (err) {
			console.error(
				'Plaud importer: version marker refresh after title update failed',
				err,
			);
		}
	}

	/** Artifact selection for a headless auto-sync import, from settings. */
	private autoSyncSelection(): ArtifactSelection {
		return {
			includeSummary: this.settings.defaultIncludeSummary !== false,
			includeTranscript: this.settings.includeTranscript !== false,
			includeAttachments:
				this.settings.defaultIncludeAttachments !== false,
			includeMindmap: this.settings.defaultIncludeMindmap !== false,
			includeCard: this.settings.defaultIncludeCard !== false,
			includeAudio: this.settings.defaultIncludeAudio === true,
		};
	}

	/**
	 * Headless import of a tick's candidates. New recordings are created
	 * (skip-for-new); changed recordings overwrite the matched note
	 * (overwrite-for-changed). Never a blanket-overwrite writer. Throws a
	 * PlaudAuthError when a batch stops on a mid-run auth failure so the tick's
	 * state machine pauses; other per-recording failures stay non-fatal.
	 */
	private async importAutoSyncCandidates(
		newRecs: readonly Recording[],
		changedRecs: readonly Recording[],
		index: Map<PlaudRecordingId, ImportedRecord>,
	): Promise<{ imported: number; updated: number }> {
		const client = this.client;
		if (client === undefined) return { imported: 0, updated: 0 };
		const options = this.buildImportRuntimeOptions();
		const selection = this.autoSyncSelection();
		// Reuse the tick's index (passed in) rather than rebuilding: one snapshot
		// backs both classification and the writer's cross-folder dedup, and a
		// cold/partial metadataCache cannot diverge between the two.
		const attachments = new AttachmentImporter({
			app: this.app,
			getAuthToken: options.getAuthToken,
			getApiBaseUrl: options.getApiBaseUrl,
			debugLogger: this.debugLogger,
		});
		const fetchArtifacts = (id: PlaudRecordingId) =>
			client.getTranscriptAndSummary(id);
		const fetchAudioUrl = selection.includeAudio
			? (id: PlaudRecordingId) => client.getAudioTempUrl(id)
			: undefined;
		// policy is constrained to skip | overwrite (never 'prompt'): a background
		// tick has no dialog, so 'Ask each time' would have nothing to answer it.
		// options.onDuplicate (which may be 'prompt' from settings) is spread in but
		// overridden here, so the user's manual-import setting can never reach the
		// headless writer. This is the #43 safe fallback; keep the override even
		// when refactoring, or a background run could stall. NoteWriter's
		// constructor also throws on 'prompt' without a callback, so a regression
		// fails loud rather than hanging (see __tests__/note-writer.test.ts).
		const makeWriter = (policy: 'skip' | 'overwrite'): NoteWriter =>
			new NoteWriter(this.app.vault, {
				...options,
				onDuplicate: policy,
				existingPathForPlaudId: (id) =>
					index.get(id as PlaudRecordingId)?.path ?? null,
			});
		const runBatch = async (
			recordings: readonly Recording[],
			policy: 'skip' | 'overwrite',
		): Promise<number> => {
			if (recordings.length === 0) return 0;
			const outcome = await runImport({
				recordings,
				selection,
				writer: makeWriter(policy),
				attachments,
				options,
				fetchArtifacts,
				fetchAudioUrl,
				fetchFolderCatalog: () => client.getFolderCatalog(),
				// Stop between recordings if the plugin unloads mid-tick, so a
				// disable/re-enable cannot leave this loop writing while a fresh
				// instance starts its own tick.
				observer: { shouldAbort: () => this.disposed },
			});
			if (outcome.stop === 'auth-failed') {
				// token_rejected (not not_configured) is correct here: this batch
				// only runs after listPage already fetched a page with the stored
				// token, so a mid-import auth failure is a rejected/expired token,
				// not a missing one. Either way the state machine maps it to a
				// pause via categoryAllowsReauth; the reason only sharpens the log.
				throw new PlaudAuthError(
					'token_rejected',
					'Plaud session expired during auto-sync',
					'/auto-sync',
				);
			}
			// Count only real writes. A 'written' result whose writeOutcome is
			// 'skipped' is a duplicate-policy skip (a note already existed), not a
			// created/overwritten note, and must not inflate the notice counts.
			// A 'placeholder-written' result is a real stub write too, so it must
			// count; but its 'kept-existing' status means a real note already
			// existed and nothing was written, so it is excluded on the same
			// principle as a 'skipped' write.
			return outcome.results.filter(
				(r) =>
					(r.kind === 'written' &&
						r.writeOutcome.status !== 'skipped') ||
					(r.kind === 'placeholder-written' &&
						r.outcome.status !== 'kept-existing'),
			).length;
		};
		const imported = await runBatch(newRecs, 'skip');
		const updated = await runBatch(changedRecs, 'overwrite');
		return { imported, updated };
	}

	/**
	 * One auto-sync tick, wrapped so it never throws into the timer. Skips when
	 * disabled, paused for re-auth, or an import is already in flight. Maps a
	 * failure through the state machine (auth pauses; transient retries).
	 */
	private async runAutoSyncTickSafe(): Promise<void> {
		if (!this.settings.autoSyncEnabled) return;
		if (this.autoSyncState.paused) {
			this.logAutoSync('tick skipped: paused for re-auth');
			return;
		}
		if (this.importModalOpen || this.autoSyncTickInFlight) {
			this.logAutoSync('tick skipped: an import is already running');
			return;
		}
		const client = this.client;
		if (client === undefined) return;

		// Claim the single-flight gate BEFORE the (potentially expensive) index
		// scan below. The scan can take a while on a large vault, and a manual
		// import modal opened mid-scan checks this same flag; setting it only
		// after the scan would let that modal slip past the gate and overlap this
		// tick. Every early return from here runs through the finally that clears
		// the flag.
		this.autoSyncTickInFlight = true;
		try {
			// One pass: cold-cache guard and index build fused (see
			// buildPlaudIdIndexWithColdCheck). A cold cache would make the index
			// incomplete and every existing note look new, so skip; a later tick
			// with a warm cache proceeds.
			const indexState = buildPlaudIdIndexWithColdCheck(
				this.app,
				this.settings.outputFolder,
			);
			if (indexState.isCold) {
				this.logAutoSync(
					'tick skipped: output-folder metadata cache is cold',
				);
				return;
			}
			const index = indexState.index;

			const result = await runAutoSyncTick({
				pageSize: PAGE_SIZE,
				maxImportsPerTick: 25,
				maxPagesPerTick: 5,
				// Honor the ignore set: an ignored recording is never pulled in the
				// background. Rebuilt each tick so an ignore/unignore mid-session
				// takes effect on the next run. Per-element re-tag (branded id).
				ignoredIds: new Set(
					this.settings.ignoredRecordingIds.map(
						(id) => id as PlaudRecordingId,
					),
				),
				listPage: (skip, limit) =>
					client.listRecordings({ sortBy: 'edit_time', skip, limit }),
				buildIndex: () => index,
				// Reuse the index this tick already built (and cold-cache-guarded)
				// so classification and the writer's dedup share one snapshot.
				importCandidates: (n, c) =>
					this.importAutoSyncCandidates(n, c, index),
				log: (m, p) => this.logAutoSync(m, p),
			});
			this.autoSyncState = nextAutoSyncState(this.autoSyncState, 'ok');
			if (result.imported + result.updated > 0) {
				new Notice(
					`Plaud auto-sync: imported ${result.imported} new, updated ${result.updated}.`,
				);
			}
			this.logAutoSync('tick complete', result);
		} catch (err) {
			const classification = classifyError(err);
			const outcome = tickOutcomeForCategory(classification.category);
			this.autoSyncState = nextAutoSyncState(this.autoSyncState, outcome);
			if (outcome === 'auth') {
				// The auth outcome covers both a rejected/expired token and a
				// missing one; word the pause Notice for the actual category so a
				// user who never configured a token is not told it "expired". A
				// one-click Reconnect action runs the sign-in flow and resumes,
				// so the user does not have to hunt through settings. Signing in
				// sets the token in the not-configured case too.
				const lead =
					classification.category === 'not-configured'
						? 'Plaud auto-sync paused: no Plaud token is configured.'
						: 'Plaud auto-sync paused: your session expired.';
				// Lifecycle re-check AFTER this method's awaits, not just at its
				// top: onunload hides every sticky action notice and clears the
				// set, so a duration-0 prompt created after that sweep is
				// untracked, outlives the plugin, and sits on screen until the
				// user clicks it away. The log below still runs either way, so an
				// unload race stays visible in a debug capture.
				if (!this.disposed) {
					// Held so a session that heals itself can take this down
					// (issue #88). Clearing first keeps the field the single
					// owner of whatever is on screen: a tick short-circuits
					// while paused, so today there is nothing to replace, but
					// that is the tick guard's property rather than this call
					// site's.
					this.clearAutoSyncPauseNotice();
					this.autoSyncPauseNotice = this.showActionNotice(
						lead,
						'Reconnect',
						() => this.reconnectFromNotice(),
					);
				}
			}
			this.logAutoSync('tick failed', {
				outcome,
				message: classification.message,
			});
		} finally {
			this.autoSyncTickInFlight = false;
		}
	}

	/**
	 * Start, stop, or reschedule the auto-sync timer to match settings.
	 * Idempotent: clears the existing interval and deferred first-run timeout
	 * before (re)creating them. Called from onLayoutReady and on any auto-sync
	 * settings change.
	 */
	reconcileAutoSync(): void {
		if (this.autoSyncIntervalId !== undefined) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = undefined;
		}
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
			this.autoSyncFirstRunTimeoutId = undefined;
		}
		if (!this.settings.autoSyncEnabled) return;
		const minutes = coerceIntervalMinutes(
			this.settings.autoSyncIntervalMinutes,
		);
		// Plain setInterval, not registerInterval: this method reschedules on every
		// settings change and clears the previous id itself (above) and on unload.
		// registerInterval would push each id onto the component's cleanup list
		// without ever removing the cleared ones, so they would accumulate.
		this.autoSyncIntervalId = window.setInterval(
			() => {
				void this.runAutoSyncTickSafe();
			},
			minutes * 60 * 1000,
		);
		// Deferred first tick (~2 min) so startup is not blocked and the vault
		// metadata cache is warm before the first index build.
		this.autoSyncFirstRunTimeoutId = window.setTimeout(
			() => {
				this.autoSyncFirstRunTimeoutId = undefined;
				void this.runAutoSyncTickSafe();
			},
			2 * 60 * 1000,
		);
		this.logAutoSync('auto-sync scheduled', { minutes });
	}

	/**
	 * Take down the auth-pause "Reconnect" prompt if one is on screen (issue
	 * #88). Same three steps reconcileSessionExpiryWarning() uses for the expiry
	 * and renewal-failure notices: hide it, drop it from the onunload sweep set
	 * so dismissed notices do not accumulate there, and null the handle.
	 */
	private clearAutoSyncPauseNotice(): void {
		if (this.autoSyncPauseNotice === null) return;
		this.autoSyncPauseNotice.hide();
		this.actionNotices.delete(this.autoSyncPauseNotice);
		this.autoSyncPauseNotice = null;
	}

	/** Clear an auth pause and run a tick soon. Called on token re-save / test / toggle. */
	resumeAutoSyncIfPaused(): void {
		// Above the paused check on purpose. The prompt and the pause state can
		// come apart: a resume that already ran, or a path that cleared the pause
		// without coming through here, leaves state un-paused with the prompt
		// still up. Behind the early return that prompt would be stranded on
		// screen for the rest of the session.
		this.clearAutoSyncPauseNotice();
		if (!this.autoSyncState.paused) return;
		this.autoSyncState = nextAutoSyncState(this.autoSyncState, 'ok');
		this.logAutoSync('auto-sync resumed after re-auth');
		this.scheduleFollowUpTick();
	}

	/**
	 * Schedule one soon-ish auto-sync tick (~1s), reusing the first-run timeout
	 * slot so reconcileAutoSync() and onunload() clear it. No-op when auto-sync is
	 * disabled. Routed through one place so an untracked setTimeout can never
	 * fire after disable/reschedule/unload.
	 */
	private scheduleFollowUpTick(): void {
		if (!this.settings.autoSyncEnabled) return;
		if (this.autoSyncFirstRunTimeoutId !== undefined) {
			window.clearTimeout(this.autoSyncFirstRunTimeoutId);
		}
		this.autoSyncFirstRunTimeoutId = window.setTimeout(() => {
			this.autoSyncFirstRunTimeoutId = undefined;
			void this.runAutoSyncTickSafe();
		}, 1000);
	}

	// ---- Reconnect routing and legacy credential cleanup ----------------

	/**
	 * Blank the legacy stored refresh token (pre-0.32.0 sessions). Called on
	 * every fresh capture and on sign-out so the legacy WRT can never masquerade
	 * as the routing signal for a newer session.
	 */
	private clearStoredRefreshToken(): void {
		try {
			this.app.secretStorage.setSecret(LEGACY_REFRESH_SECRET_ID, '');
		} catch (err) {
			console.error('Plaud importer: failed to blank refresh token', err);
		}
	}

	/**
	 * Routes Reconnect to the sign-in surface that can re-auth this account.
	 * The decision logic lives in reconnect-routing.ts (pure, unit-tested);
	 * this wrapper only supplies the settings value and the legacy-secret
	 * reader.
	 */
	private reconnectPrefersWindow(): boolean {
		return preferWindowForReconnect(this.settings.signInMethod, () =>
			this.app.secretStorage.getSecret(LEGACY_REFRESH_SECRET_ID),
		);
	}

	/**
	 * Show a sticky notice carrying one inline action link. Used by the
	 * auth-pause path and the manual commands so a disconnected session offers
	 * a one-click fix instead of a dead-end error. The notice hides as soon as
	 * the action starts, so a slow sign-in window does not sit under a stale
	 * message; action errors are swallowed (each action shows its own result).
	 */
	private showActionNotice(
		message: string,
		actionLabel: string,
		onAction: () => unknown,
	): Notice {
		const frag = createFragment();
		frag.createSpan({ text: `${message} ` });
		// role/tabindex + key handling so keyboard and screen-reader users can
		// activate the action, not just a mouse click.
		const actionEl = frag.createSpan({
			text: actionLabel,
			cls: 'plaud-importer-notice-action',
			attr: { role: 'button', tabindex: '0' },
		});
		// 0 = stay until the user acts (or dismisses); an auth pause is not a
		// message to blink past.
		const notice = new Notice(frag, 0);
		this.actionNotices.add(notice);
		// Drop the reference whenever the notice is clicked away (manual dismiss
		// or the action itself), so dismissed notices do not accumulate in the
		// Set for the plugin's lifetime.
		notice.messageEl.addEventListener('click', () => {
			this.actionNotices.delete(notice);
		});
		const activate = (): void => {
			this.actionNotices.delete(notice);
			notice.hide();
			// If the plugin unloaded while the notice was on screen, do nothing.
			if (this.disposed) return;
			void (async () => {
				try {
					await onAction();
				} catch (err) {
					console.error('Plaud importer: notice action failed', err);
					new Notice(
						'Plaud: that action could not be completed. Try again from settings.',
					);
				}
			})();
		};
		actionEl.addEventListener('click', activate);
		actionEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' || evt.key === ' ') {
				evt.preventDefault();
				activate();
			}
		});
		// Returned so a caller can dismiss its own notice when it goes stale
		// (the pre-expiry warning does, on credential change). Most callers
		// ignore it.
		return notice;
	}

	/**
	 * Reconnect from an auth-pause surface: run the sign-in flow, and on success
	 * clear any auto-sync pause so the next tick runs. Owns its own result
	 * notice for every outcome (success, closed, error) so the user is never
	 * left with a hidden notice and no feedback. Returns whether a token was
	 * captured, so a caller (e.g. a failed command) can retry itself on success.
	 */
	async reconnectFromNotice(onReconnected?: () => unknown): Promise<boolean> {
		// A browser/bookmarklet (SSO) session cannot re-auth in the embedded
		// window (Google and Apple do not complete there), so routing it there
		// dead-ends. Open the browser + bookmarklet + paste flow instead. That
		// flow finishes asynchronously when the user pastes, so this returns
		// false now; the paste handler resumes any paused sync and runs
		// onReconnected (e.g. a backfill retry) itself.
		if (!this.reconnectPrefersWindow()) {
			this.openBrowserReconnect(onReconnected);
			return false;
		}
		try {
			const outcome = await this.reauthenticate();
			const captured = outcome === 'captured';
			// Plugin unloaded mid sign-in: skip side effects and messaging.
			if (this.disposed) return captured;
			if (captured) {
				new Notice('Plaud reconnected.');
				this.resumeAutoSyncIfPaused();
				if (onReconnected) await onReconnected();
			} else if (outcome === 'closed') {
				// Only when nothing else is on screen. This used to test
				// `!this.reauthInFlight`, which caught exactly one of the reasons
				// reauthenticate speaks for itself and let "sign-in closed"
				// contradict every other one, now including a failed save.
				new Notice('Plaud sign-in closed. Still disconnected.');
			}
			return captured;
		} catch (err) {
			console.error('Plaud importer: reconnect failed', err);
			if (!this.disposed) {
				new Notice('Plaud reconnect failed. Still disconnected.');
			}
			return false;
		}
	}

	/**
	 * Guided browser sign-in for SSO (Google/Apple) reconnect. Opens the same
	 * BrowserSignInModal the settings tab uses, but with an inline "Paste token"
	 * action so the whole reconnect completes from the modal: it opens Plaud in
	 * the system browser, the user runs the bookmarklet, and the token comes
	 * back through the paste button OR the bookmarklet's obsidian:// deep link;
	 * either channel stores it and runs completeBrowserReconnect (resume paused
	 * sync, close the modal, the optional onReconnected continuation such as a
	 * backfill retry), so a browser reconnect finishes the same follow-up the
	 * embedded flow does. Reuses openPlaudInBrowser and pasteTokenFromClipboard
	 * so there is one capture path.
	 */
	private openBrowserReconnect(onReconnected?: () => unknown): void {
		// One sign-in surface at a time, sharing the same gate as the embedded
		// window: two captures racing on the partition would clobber each
		// other's token write. Held for the modal's whole lifetime and
		// cleared when it closes; paste-success, deep-link success, cancel, and
		// dismiss all route through the modal's onClose.
		if (this.reauthInFlight) {
			new Notice('Plaud sign-in is already open.');
			return;
		}
		this.reauthInFlight = true;
		// Obsidian's Modal.close() runs onClose on EVERY call, and this modal
		// can legitimately be closed twice (completion closes it, then the
		// paste click handler's own close-on-success backstop fires after the
		// awaited continuation returns). Only the FIRST close may release the
		// single-flight gate: by the time a stale second close fires, a newer
		// sign-in may own it.
		let closeHandled = false;
		const releaseGate = (): void => {
			if (closeHandled) {
				return;
			}
			closeHandled = true;
			this.reauthInFlight = false;
			if (this.browserReconnect?.modal === modal) {
				this.browserReconnect = null;
			}
		};
		const modal = new BrowserSignInModal(
			this.app,
			() => this.openPlaudInBrowser(),
			async () => {
				// Deliver only for the flow this modal belongs to, one delivery
				// at a time: if the deep link is mid-store for the same flow,
				// this paste no-ops and lets that delivery finish.
				const flow = this.browserReconnect;
				if (flow === null || flow.modal !== modal) {
					return false;
				}
				if (flow.deliveryInFlight) {
					// Since 0.35.0 a deep-link delivery probes candidates against
					// Plaud, so this window is seconds rather than milliseconds.
					// Say so: a silent no-op reads as a broken button.
					new Notice(
						'Plaud sign-in from your browser is already being saved. Give it a moment.',
					);
					return false;
				}
				flow.deliveryInFlight = true;
				try {
					// The guard re-checks after the (possibly slow) clipboard
					// read: if this flow was cancelled meanwhile and a newer
					// sign-in stored its own token, the stale paste must not
					// overwrite it.
					const ok = await this.pasteTokenFromClipboard(
						() => !this.disposed && this.browserReconnect === flow,
					);
					if (ok) {
						const done = await this.completeBrowserReconnect(flow);
						// The flow was cancelled while the store ran; the token
						// is saved anyway, so a paused sync should still resume.
						if (!done && !this.disposed) {
							this.resumeAutoSyncIfPaused();
						}
					}
					return ok;
				} finally {
					flow.deliveryInFlight = false;
				}
			},
			releaseGate,
		);
		this.browserReconnect = {
			modal,
			onReconnected,
			deliveryInFlight: false,
			release: releaseGate,
		};
		try {
			modal.open();
		} catch (err) {
			// A modal that failed to open can never fire onClose; restore the
			// single-flight state here or every later sign-in would be refused.
			console.error(
				'Plaud importer: reconnect modal failed to open',
				err,
			);
			releaseGate();
		}
	}

	/**
	 * Follow-through for a browser reconnect whose token has just been stored,
	 * regardless of which channel delivered it (the modal's paste button or the
	 * obsidian:// deep link the bookmarklet fires): announce, resume any paused
	 * sync, close the modal (which releases the single-flight gate via its
	 * onClose), and run the optional onReconnected continuation. Runs at most
	 * once per flow: it claims the pending state first, and only for the exact
	 * flow the delivery started against, so a paste and a deep link landing
	 * together follow through once and a delivery that outlives a cancelled
	 * flow can never complete a newer one. Returns whether it ran.
	 */
	private async completeBrowserReconnect(
		flow: NonNullable<PlaudImporterPlugin['browserReconnect']>,
	): Promise<boolean> {
		if (this.disposed || this.browserReconnect !== flow) {
			return false;
		}
		this.browserReconnect = null;
		new Notice('Plaud reconnected.');
		this.resumeAutoSyncIfPaused();
		try {
			flow.modal.close();
		} catch (err) {
			console.error(
				'Plaud importer: failed to close reconnect modal',
				err,
			);
		}
		// close() normally releases the gate via the modal's onClose; if close
		// threw before onClose ran, release explicitly (idempotent) so the
		// continuation below never runs with the gate wedged.
		flow.release();
		if (flow.onReconnected) {
			try {
				await flow.onReconnected();
			} catch (err) {
				// The reconnect itself succeeded; only the follow-up (e.g. a
				// backfill retry) failed. Say so instead of letting the rejection
				// surface as an unhandled error with no context.
				console.error(
					'Plaud importer: post-reconnect follow-up failed',
					err,
				);
				new Notice(
					'Plaud reconnected, but the retried action failed. Run it again manually.',
				);
			}
		}
		return true;
	}

	/**
	 * One-time backfill of `plaud-version-ms` into notes imported before
	 * auto-sync existed. Reads each recording's current `version_ms` from the
	 * list and writes ONLY the frontmatter marker (no body rewrite), so those
	 * notes become edit-detectable. Without it, auto-sync treats a legacy note's
	 * edits as un-detectable (missing marker = current). Safe to re-run: notes
	 * that already have a marker are skipped.
	 */
	private async backfillVersionMarkers(): Promise<void> {
		const client = this.client;
		if (client === undefined) {
			new Notice(
				'Plaud importer: still starting up. Try again in a moment.',
			);
			return;
		}
		// Participate in the single-flight gate: the backfill writes frontmatter
		// across many notes, so it must not overlap a manual import or a tick.
		if (this.importModalOpen || this.autoSyncTickInFlight) {
			new Notice(
				'Plaud importer: an import is running. Try backfill again shortly.',
			);
			return;
		}
		if (outputFolderCacheIsCold(this.app, this.settings.outputFolder)) {
			// A cold cache would make buildPlaudIdIndex return a partial map, so
			// the backfill would silently miss notes ("backfilled 0"). Ask the
			// user to retry once Obsidian has finished loading.
			new Notice(
				'Plaud importer: still loading notes. Try backfill again in a moment.',
			);
			return;
		}
		this.autoSyncTickInFlight = true;
		new Notice('Plaud importer: backfilling version markers...');
		try {
			// Build id -> version_ms from the full list (bounded page loop).
			const MAX_BACKFILL_PAGES = 500;
			const versionById = new Map<PlaudRecordingId, number>();
			let skip = 0;
			let reachedListEnd = false;
			for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
				// Stop if the plugin unloaded mid-scan (finally clears the gate).
				if (this.disposed) return;
				const recs = await client.listRecordings({
					sortBy: 'edit_time',
					skip,
					limit: PAGE_SIZE,
				});
				if (recs.length === 0) {
					reachedListEnd = true;
					break;
				}
				for (const r of recs) {
					if (r.versionMs !== undefined)
						versionById.set(r.id, r.versionMs);
				}
				if (recs.length < PAGE_SIZE) {
					reachedListEnd = true;
					break;
				}
				skip += recs.length;
			}

			const index = buildPlaudIdIndex(
				this.app,
				this.settings.outputFolder,
			);
			let written = 0;
			for (const [id, record] of index) {
				// Stop writing frontmatter if the plugin unloaded mid-backfill.
				if (this.disposed) return;
				if (record.versionMs !== undefined) continue; // already has a marker
				const versionMs = versionById.get(id);
				if (versionMs === undefined) continue; // recording no longer listed
				const file = this.app.vault.getFileByPath(record.path);
				if (!(file instanceof TFile)) continue;
				await this.app.fileManager.processFrontMatter(
					file,
					(fm: Record<string, unknown>) => {
						fm['plaud-version-ms'] = versionMs;
					},
				);
				written += 1;
			}
			// The scan always restarts from the newest page, so re-running does not
			// advance past the cap; say what happened without promising a fix.
			const capNote = reachedListEnd
				? ''
				: ' Stopped at the scan limit; the least recently updated recordings were not checked, so a few legacy notes may still lack a marker.';
			new Notice(
				`Plaud importer: backfilled ${written} version marker${written === 1 ? '' : 's'}.${capNote}`,
			);
			this.logAutoSync('backfill complete', {
				written,
				listed: versionById.size,
				reachedListEnd,
			});
		} catch (err) {
			const classification = classifyError(err);
			// An expired/missing token used to dead-end here with a bare error.
			// Offer a one-click reconnect that retries the backfill on success,
			// matching the auth-pause notice, so a stale session is a single
			// click to fix rather than a trip to settings and back.
			if (categoryAllowsReauth(classification.category)) {
				this.showActionNotice(
					'Plaud importer: backfill needs a Plaud session.',
					'Reconnect and retry',
					// Pass the retry as the post-reconnect continuation so it runs on
					// BOTH the embedded (email) path and the async browser (SSO) path;
					// the SSO path returns false immediately (paste completes later), so
					// a caller that keyed the retry off the return value would skip it.
					() =>
						this.reconnectFromNotice(() =>
							this.backfillVersionMarkers(),
						),
				);
			} else {
				new Notice(
					`Plaud importer: backfill failed: ${classification.message}`,
				);
			}
		} finally {
			// Always release the gate so a failed or empty backfill never leaves
			// auto-sync permanently blocked.
			this.autoSyncTickInFlight = false;
		}
	}

	/**
	 * Add, remove, or swap the left-rail ribbon icon based on the
	 * current settings. Safe to call repeatedly — no-ops when the DOM
	 * state already matches the setting. An icon ID change triggers a
	 * detach + re-add cycle since Obsidian has no "change icon in
	 * place" API on the ribbon element.
	 */
	updateRibbonIcon(): void {
		if (!this.settings.showRibbonIcon) {
			if (this.ribbonIconEl !== null) {
				this.ribbonIconEl.detach();
				this.ribbonIconEl = null;
				this.ribbonIconId = null;
			}
			return;
		}
		const desiredId = resolveRibbonIconId(this.settings.ribbonIcon);
		if (this.ribbonIconEl !== null && this.ribbonIconId === desiredId) {
			return;
		}
		if (this.ribbonIconEl !== null) {
			this.ribbonIconEl.detach();
		}
		this.ribbonIconEl = this.addRibbonIcon(
			desiredId,
			'Plaud importer: Import recordings',
			() => this.launchImportModal('ribbon'),
		);
		this.ribbonIconId = desiredId;
	}

	/**
	 * Common entry point for launching the Plaud import modal. Called
	 * from both the command palette and the left-rail ribbon icon so
	 * that initialization guards and debug-log breadcrumbs only live in
	 * one place. The `source` tag differentiates the two trigger paths
	 * in the debug log when it's enabled.
	 */
	private launchImportModal(source: 'command' | 'ribbon'): void {
		if (!this.client) {
			new Notice(
				'Plaud importer: Still initializing. Try again in a moment.',
			);
			return;
		}
		if (this.debugLogger.enabled) {
			this.debugLogger.log({
				kind: 'note',
				message: `user invoked 'Import recent recordings' via ${source}`,
			});
		}
		// Refuse to launch while another import is active: a second modal, or a
		// modal opened over an in-flight auto-sync/backfill, would clobber the
		// shared single-flight gate (importModalOpen / autoSyncTickInFlight).
		if (this.importModalOpen) {
			new Notice('Plaud importer: an import window is already open.');
			return;
		}
		if (this.autoSyncTickInFlight) {
			new Notice(
				'Plaud importer: auto-sync is running. Try again shortly.',
			);
			return;
		}
		// Mark the modal open for its whole lifetime so a background auto-sync
		// tick does not start alongside a manual import. Cleared from onClosed
		// below. Uses its own flag (not the tick's) so the two never clobber.
		this.importModalOpen = true;
		try {
			// Snapshot settings at invocation time (via buildImportRuntimeOptions,
			// the same builder the headless auto-sync path uses) so changes in the
			// settings tab take effect on the next click without reinstantiation.
			new ImportModal(this.app, this.client, {
				...this.buildImportRuntimeOptions(),
				// Single-source the routing decision with reconnectFromNotice
				// (issue #78): a browser/bookmarklet (SSO) session must not be
				// pushed at the embedded email window on auth-error screens.
				prefersSsoReauth: !this.reconnectPrefersWindow(),
				// After a successful in-modal re-auth, clear any auth pause so
				// background sync resumes without waiting for the settings tab.
				onReauth: async () => {
					// The modal only needs to know whether to carry on, and
					// reauthenticate has already explained any failure it can.
					const captured =
						(await this.reauthenticate()) === 'captured';
					if (captured) this.resumeAutoSyncIfPaused();
					return captured;
				},
				onReauthSso: {
					setupBookmark: () => {
						void this.openBookmarkSetupPage();
					},
					signIn: () => {
						new BrowserSignInModal(this.app, () =>
							this.openPlaudInBrowser(),
						).open();
					},
					pasteToken: async () => {
						const ok = await this.pasteTokenFromClipboard();
						if (ok) this.resumeAutoSyncIfPaused();
						return ok;
					},
				},
				onClosed: () => {
					this.importModalOpen = false;
				},
				// Persist dialog filter toggles and ignore-set changes back to
				// settings so they survive reopen and auto-sync sees the updated
				// ignore set on its next tick. The modal owns its own in-memory
				// copy and calls this after each change.
				onViewStateChange: (patch) => {
					void this.applyImportViewState(patch);
				},
			}).open();
		} catch (err) {
			// If constructing/opening the modal throws, onClosed never fires;
			// release the flag here so a background tick is not blocked forever.
			this.importModalOpen = false;
			throw err;
		}
	}

	async loadSettings() {
		const stored =
			(await this.loadData()) as Partial<PlaudImporterSettings> | null;
		// Read the stored version BEFORE the merge: an existing pre-0.21.0
		// data.json has no settingsVersion field, and Object.assign would fill it
		// from DEFAULT_SETTINGS (1), hiding that a migration is due. An absent
		// field is version 0.
		const rawVersion = stored?.settingsVersion;
		// Treat a non-finite or non-numeric stored version as 0 (needs migration),
		// so a corrupted value cannot skip the migration and leave legacy tokens to
		// misrender under Moment. JSON parsing cannot itself produce NaN, but a
		// hand-edited file could carry a bad type; this is defense-in-depth.
		const storedVersion =
			typeof rawVersion === 'number' && Number.isFinite(rawVersion)
				? rawVersion
				: 0;
		// 0.32.0 removed the keepSessionAlive setting with the refresh
		// subsystem. Object.assign copies unknown stored keys through, so drop
		// the stale key here or it rides along in data.json forever.
		const merged: PlaudImporterSettings & { keepSessionAlive?: unknown } =
			Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
		delete merged.keepSessionAlive;
		this.settings = merged;
		// Repair a blank stored output folder back to the default. The
		// declarative control can persist an empty string; consumers expect a
		// non-empty folder name.
		if (
			typeof this.settings.outputFolder !== 'string' ||
			this.settings.outputFolder.trim().length === 0
		) {
			this.settings.outputFolder = 'Plaud';
		}
		// Repair a hand-edited or malformed replacement character back to the
		// default dash, so every consumer (imports and the rename command) gets a
		// safe single character. The settings UI validates on entry, but data.json
		// could carry anything; an unsafe value (e.g. "/") would otherwise let
		// sanitizing produce a path separator. NoteWriter also guards defensively.
		if (
			typeof this.settings.forbiddenCharReplacement !== 'string' ||
			!isValidReplacementChar(this.settings.forbiddenCharReplacement)
		) {
			this.settings.forbiddenCharReplacement = '-';
		}
		// v1 (issue #30): the date-template engine moved from bespoke lowercase
		// tokens to real Moment. Rewrite the two stored templates once, output-
		// preserving (see migrateLegacyDateTemplate), so an existing install's
		// filenames and folders do not change. Gated on an EXISTING install
		// (stored data present) so a fresh install writes nothing at startup: its
		// templates are already the Moment defaults, and skipping the save avoids
		// an unnecessary write and a load-time failure if saveData throws.
		if (stored !== null && storedVersion < 1) {
			this.settings.noteNameTemplate = migrateLegacyDateTemplate(
				this.settings.noteNameTemplate,
			);
			this.settings.subfolderTemplate = migrateLegacyDateTemplate(
				this.settings.subfolderTemplate,
			);
		}
		// v2 (issue #87): the sign-in partition is now derived from the vault's
		// own id, so a session captured before this upgrade sits in the old
		// installation-wide partition and this vault's renewal cannot see it.
		// Nothing is migrated between partitions, deliberately: two vaults holding
		// copies of one refresh token is one session in two jars, not two, and the
		// first to rotate would invalidate the other, reproducing the very bug
		// this change fixes. So the user signs in once more, per vault.
		//
		// Only vaults that HAD a window session are affected. SSO and bookmarklet
		// captures never populated a partition, and a vault with no stored
		// credential has nothing to lose, so neither gets a notice about a change
		// they cannot perceive. The flag is consumed at layout-ready rather than
		// shown here: loadSettings runs during onload, before the workspace can
		// render a Notice.
		if (stored !== null && storedVersion < 2) {
			this.perVaultSignInNoticePending =
				this.settings.signInMethod === 'window' &&
				this.settings.secretId.length > 0;
		}
		// One write covers every migration above, so an install arriving from
		// version 0 does not pay two saves.
		if (stored !== null && storedVersion < CURRENT_SETTINGS_VERSION) {
			this.settings.settingsVersion = CURRENT_SETTINGS_VERSION;
			await this.saveSettings();
		}
	}

	// Shown once per vault, at layout-ready, after the #87 partition change moved
	// where this vault's sign-in lives. Set by loadSettings' v2 migration.
	private perVaultSignInNoticePending = false;

	private notePerVaultSignInChange(): void {
		// Layout-ready can fire after the plugin was disabled (loadSettings runs
		// during onload and the callback is queued), and a notice from a
		// tearing-down plugin would outlive it on screen. Its neighbours in the
		// same callback guard on `disposed` for the same reason.
		//
		// Losing the notice here is accepted, not recovered: settingsVersion was
		// already written as 2, so a later enable reads a migrated install and
		// never re-arms this. The window is "disabled within a moment of the first
		// load after upgrading", and the cost is a heads-up the user does not see;
		// the behavior it describes is unaffected, and they still learn they need
		// to sign in from the reconnect prompt. Persisting a second flag purely to
		// survive that window would put a settings key on disk forever to protect
		// one cosmetic message.
		if (this.disposed) return;
		if (!this.perVaultSignInNoticePending) return;
		this.perVaultSignInNoticePending = false;
		new Notice(
			"Plaud sign-ins are now separate for each vault, so vaults no longer interrupt each other's sessions. Sign in again in this vault when convenient.",
			15000,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Persist a change to the import dialog's view state (the filter-bar toggles
	 * and the ignore set). Called by the modal after every toggle so the choice
	 * survives reopen and a background auto-sync tick, which reads
	 * `settings.ignoredRecordingIds` fresh each run, honors the updated ignore
	 * set. Stores a fresh plain-string array for the ignore set so the module-
	 * level DEFAULT_SETTINGS array is never mutated by reference.
	 */
	private async applyImportViewState(
		patch: ImportViewStatePatch,
	): Promise<void> {
		if (patch.showTrashedRecordings !== undefined) {
			this.settings.showTrashedRecordings = patch.showTrashedRecordings;
		}
		if (patch.hideProcessedRecordings !== undefined) {
			this.settings.hideProcessedRecordings =
				patch.hideProcessedRecordings;
		}
		if (patch.hideUpdatesRecordings !== undefined) {
			this.settings.hideUpdatesRecordings = patch.hideUpdatesRecordings;
		}
		if (patch.hideIgnoredRecordings !== undefined) {
			this.settings.hideIgnoredRecordings = patch.hideIgnoredRecordings;
		}
		if (patch.ignoredRecordingIds !== undefined) {
			this.settings.ignoredRecordingIds = [...patch.ignoredRecordingIds];
		}
		await this.saveSettings();
	}

	// Returns the plugin to a pre-sign-in state for a clean re-authentication:
	// clears the embedded browser's Plaud session (so the next sign-in starts
	// logged out) and unlinks the stored token by clearing secretId. The secret
	// value itself stays in Obsidian's SecretStorage, which exposes no delete
	// API; unlinking secretId means the plugin no longer reads or sends it, so
	// the plugin is effectively signed out. Region (apiBaseUrl) is left as-is;
	// it re-detects on the next import. Returns whether the browser session was
	// cleared, so the caller can tell the user if only the token was unlinked.
	async clearSignIn(): Promise<{ sessionCleared: boolean }> {
		let sessionCleared = false;
		try {
			// Explicit sign-out, so it also removes the pre-#87 shared leftover.
			// The reconnect path deliberately does not: see the note in
			// clearPlaudLoginSession about not signing out a sibling vault as a
			// side effect of one vault recovering.
			sessionCleared = await clearPlaudLoginSession(this.app, {
				includeLegacyShared: true,
			});
		} catch (err) {
			console.error(
				'Plaud importer: failed to clear sign-in browser session',
				err,
			);
		}
		// Wipe the stored token value(s). Obsidian's SecretStorage exposes no
		// delete call (only set/get/list), so the secret entry itself cannot be
		// removed; blanking the value is the most thorough removal available. The
		// legacy refresh token is blanked too so no credential outlives sign-out.
		for (const id of new Set([
			this.settings.secretId,
			CAPTURED_SECRET_ID,
			LEGACY_REFRESH_SECRET_ID,
		])) {
			if (id.length > 0) {
				try {
					this.app.secretStorage.setSecret(id, '');
				} catch (err) {
					console.error(
						'Plaud importer: failed to blank secret',
						err,
					);
				}
			}
		}
		this.settings.secretId = '';
		// A cleared plugin has no session, so there is no sign-in method to route
		// a Reconnect from until the next capture records one. The warn stamp
		// resets too: the next credential deserves its own warning.
		this.settings.signInMethod = '';
		this.settings.sessionWarnedForExpMs = 0;
		// A cleared session has nothing to refresh, and the next capture gets a
		// clean slate rather than inheriting this one's failure state.
		this.sessionRefreshFailed = false;
		await this.saveSettings();
		this.reconcileSessionExpiryWarning();
		this.reconcileSessionRefresh();
		return { sessionCleared };
	}

	// Re-authenticates via the email/password login window and persists the
	// captured token with the FULL recipe: set the secret, link secretId, and
	// adopt the redirected region (apiBaseUrl) so a region-redirected user is not
	// stranded on a stale host. Shared by the settings tab and the import modal's
	// inline re-auth. Resolves "captured" once a token is stored, "closed" when
	// the user closed the window (or the login API is unavailable on this build)
	// and nothing is on screen, and "reported" when the failure has already been
	// named in a Notice here, so callers add consequences, never causes. On the
	// captured and closed paths it shows no Notice; each caller phrases its own.
	async reauthenticate(): Promise<ReauthOutcome> {
		// One sign-in window at a time. Concurrent windows share the same
		// Electron capture partition and would clobber each other's token
		// capture, so a second caller (a stacked notice, a repeated command)
		// no-ops with a hint instead of opening a rival window.
		if (this.reauthInFlight) {
			new Notice('Plaud sign-in is already open.');
			return 'reported';
		}
		// Both directions of this pairing have to be locked, not just one. The
		// refresh refuses to start under an open sign-in; this is the mirror.
		// Without it the sign-in window can capture the partition's CURRENT
		// localStorage, which still holds the near-expiry token, and store that
		// AFTER the refresh stored the fresh one, quietly putting the session
		// back where it was. The refresh's own supersede check cannot catch
		// this ordering, because at the moment it stores nothing has changed
		// yet. Seconds at most: the refresh POSTs are bounded by a 30s timeout.
		if (this.sessionRefreshInFlight) {
			new Notice(
				'Finishing a background session refresh. Try signing in again in a moment.',
			);
			return 'reported';
		}
		this.reauthInFlight = true;
		try {
			const result = await openPlaudLogin(this.app, {
				debugLogger: this.debugLogger,
			});
			if (result === null) {
				return 'closed';
			}
			// Do not persist a token onto a plugin that unloaded mid sign-in. A
			// torn-down plugin has no surface left to explain itself on, so this is
			// "closed" (say nothing) rather than "reported".
			if (this.disposed) {
				return 'closed';
			}
			// The window now hands back CANDIDATES, because Plaud's web app stopped
			// writing a single plain token: the live credential is nested beside a
			// refresh token the API answers -3901 to. Route them through the same
			// probe-and-select the deep link uses, so exactly one place decides
			// which credential is real. "window" is preserved as the recorded
			// sign-in method so Reconnect still reopens this surface.
			// The region the window discovered is HANDED DOWN, never written to
			// settings first. Writing it up front is what created the defect
			// this closes: a sign-in that then failed to store left the new host
			// in memory beside the OLD linked credential, and the next unrelated
			// settings save would persist that pairing and send the old token to
			// the wrong region. Unwinding it afterwards is worse, not better -
			// capture paths are not serialized, so a rollback here can undo a
			// deep-link or paste capture that completed while this one was
			// probing. Passing it down means the host lands in settings only
			// alongside a credential that actually stored, so there is no window
			// to unwind and nothing to race.
			const outcome = await this.captureStore.storeFirstWorkingCandidate(
				result.tokens,
				() => !this.disposed,
				'window',
				result.apiBaseUrl ?? undefined,
			);
			if (!outcome.stored) {
				// An empty message means the plugin unloaded or a newer sign-in owns
				// the credential; nothing is on screen, so the caller's own wording is
				// all the user would see. Otherwise the reason has just been named and
				// the caller must not talk over it.
				if (outcome.message.length > 0) {
					new Notice(outcome.message);
					return 'reported';
				}
				return 'closed';
			}
			return 'captured';
		} finally {
			this.reauthInFlight = false;
		}
	}

	// Reads a token from the clipboard and stores it via storeAccessToken,
	// showing the same guidance Notices the settings paste button uses. Returns
	// true on success. Shared by the settings tab and the modal's SSO expander;
	// the success Notice is left to each caller.
	async pasteTokenFromClipboard(
		// Re-checked AFTER the (possibly slow) clipboard read, right before the
		// store: a caller whose context can go stale mid-read (the reconnect
		// modal, which may be cancelled while a newer sign-in stores its own
		// token) passes a guard so a stale paste can never overwrite the newer
		// credential. Callers with no such window keep the default.
		canStore: () => boolean = () => true,
	): Promise<boolean> {
		let text = '';
		try {
			text = await navigator.clipboard.readText();
		} catch (err) {
			console.error('Plaud importer: clipboard read failed', err);
			new Notice(
				'Could not read the clipboard. Copy the line the bookmark showed in your browser, then try again.',
			);
			return false;
		}
		if (!canStore()) {
			return false;
		}
		// The bookmarklet's fallback offers the whole deep link, so a paste can
		// carry several candidates and gets the same probe-and-select treatment
		// the deep link does. A bare token still works and, when it is the only
		// candidate, still stores even if Plaud cannot be reached, so this path
		// keeps the behavior it had before 0.35.0.
		const candidates = parseClipboardTokens(text);
		if (candidates.length === 0) {
			new Notice(
				'The clipboard did not hold a valid token. Make sure you are signed in, then click the bookmarklet and copy what it shows.',
			);
			return false;
		}
		// The same guard again, because the probe between here and the store is
		// a second, longer chance for this paste to go stale.
		const result = await this.captureStore.storeFirstWorkingCandidate(
			candidates,
			canStore,
		);
		if (!result.stored && result.message.length > 0) {
			new Notice(result.message);
		}
		return result.stored;
	}

	// Opens the Plaud web app in the system browser for the browser-based
	// sign-in flow. Google and Apple SSO complete there because it is a real
	// browser, not an embedded webview.
	openPlaudInBrowser(): void {
		window.open(PLAUD_WEB_URL, '_blank');
	}

	// Writes the one-time bookmark-setup page to a temp file and opens it in the
	// system browser, where the user drags the bookmarklet onto their bookmarks
	// bar. Falls back to copying the bookmarklet if Node/Electron APIs are
	// unavailable (e.g. a hardened build), so the manual path still works.
	async openBookmarkSetupPage(): Promise<void> {
		const req = (window as { require?: (id: string) => unknown }).require;
		if (typeof req !== 'function') {
			void copyToClipboard(
				buildSignInBookmarklet(this.app.vault.getName()),
				() => {
					new Notice(
						'Bookmarklet copied. Make a new bookmark and paste it into the address field.',
					);
				},
			);
			return;
		}
		try {
			const os = req('os') as { tmpdir(): string };
			const fs = req('fs') as {
				writeFileSync(path: string, data: string): void;
			};
			const pathMod = req('path') as {
				join(...parts: string[]): string;
			};
			const file = pathMod.join(
				os.tmpdir(),
				'plaud-importer-bookmark.html',
			);
			fs.writeFileSync(file, bookmarkSetupHtml(this.app.vault.getName()));
			const shell = (
				req('electron') as {
					shell?: { openPath(path: string): Promise<string> };
				}
			).shell;
			if (shell && typeof shell.openPath === 'function') {
				await shell.openPath(file);
			} else {
				window.open('file:///' + file.replace(/\\/g, '/'), '_blank');
			}
		} catch (err) {
			console.error('Plaud importer: bookmark setup page failed', err);
			new Notice(
				'Could not open the setup page. Copy the bookmarklet and add it as a bookmark manually.',
			);
		}
	}

	// Handles obsidian://plaud-importer-token deep links from the browser
	// sign-in bookmarklet. Reads the 0.35.0 `tokens` candidate list and the
	// legacy single `token` parameter, so a bookmark the user has not re-added
	// keeps working.
	private async handleTokenDeepLink(
		params: ObsidianProtocolData,
	): Promise<void> {
		const candidates = parseTokenCandidates(params);
		if (candidates.length === 0) {
			new Notice('Plaud sign-in link contained no token.');
			return;
		}
		// A deep link is one of the browser-reconnect return channels: when that
		// flow is waiting, deliver against it (serialized with the paste button
		// via deliveryInFlight) and run its full follow-through: resume, close
		// the modal, continuation, with its "Plaud reconnected." notice
		// (issue #75). The flow is snapshotted BEFORE the async store so a slow
		// store can never complete a different, newer flow.
		const flow = this.browserReconnect;
		if (flow !== null) {
			if (flow.deliveryInFlight) {
				// The paste button is mid-store for this flow; let it finish.
				return;
			}
			flow.deliveryInFlight = true;
			let result = { stored: false, message: '' };
			try {
				// Probing is several round-trips, so this delivery can outlive
				// its own flow. Refuse the store only when a DIFFERENT flow has
				// taken ownership meanwhile: that is the ABA case where a stale
				// delivery would clobber a newer sign-in's token. A flow that
				// was merely cancelled (nothing owns sign-in now) still stores,
				// which is the behavior every release before 0.35.0 had: the
				// user did just sign in, and the fall-through below reports it.
				result = await this.captureStore.storeFirstWorkingCandidate(
					candidates,
					() =>
						this.browserReconnect === null ||
						this.browserReconnect === flow,
				);
				if (result.stored) {
					const done = await this.completeBrowserReconnect(flow);
					if (done) {
						return;
					}
					// The flow was cancelled while the store ran; the token is
					// saved anyway, so fall through to the plain-path handling.
				} else {
					if (result.message.length > 0) {
						new Notice(result.message);
					}
					return;
				}
			} finally {
				flow.deliveryInFlight = false;
			}
			if (this.disposed) {
				return;
			}
			this.resumeAutoSyncIfPaused();
			new Notice(result.message);
			return;
		}
		const result =
			await this.captureStore.storeFirstWorkingCandidate(candidates);
		if (result.stored) {
			// Outside the reconnect flow a fresh token still means the session
			// is back; a paused auto-sync should not wait for its next trigger.
			this.resumeAutoSyncIfPaused();
		}
		// An empty message means the plugin unloaded mid-probe; say nothing.
		if (result.message.length > 0) {
			new Notice(result.message);
		}
	}
}
