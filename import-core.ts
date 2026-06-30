// -----------------------------------------------------------------------------
// import-core.ts
//
// Pure, framework-free core of the import pipeline: shared option/result types
// and the pure helpers (error classification, formatting, tallying, paging
// merge). This module imports NO `obsidian` API and does NOT depend on
// `import-modal.ts`, so it is the acyclic base both the modal UI
// (`import-modal.ts`) and the future headless runner can build on. Keeping
// these symbols here also breaks the former `import-modal` <-> `attachment-importer`
// import cycle (attachment-importer imports `ArtifactSelection` from here).
//
// `import-modal.ts` re-exports every symbol below so existing import paths
// (main.ts, the test suite) keep resolving unchanged.
// -----------------------------------------------------------------------------

import type { Recording } from './plaud-client';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from './plaud-client-re';
import {
	NoteWriterError,
	type TagMode,
	type NoteWriterOptions,
	type WriteOutcome,
	type PlaceholderWriteOutcome,
} from './note-writer';
import type { DebugLogger } from './debug-logger';

/**
 * Modal-level options passed to `ImportModal`. Extends
 * `NoteWriterOptions` with concerns that belong to the post-write
 * pipeline — specifically whether to auto-fold the transcript wrapping
 * heading via `app.foldManager.save` after each created/overwritten
 * note. `foldTranscript` is not a NoteWriter concern (the writer
 * doesn't touch fold state) so it lives on the modal's options
 * surface, not inside `NoteWriterOptions`.
 */
export interface ImportModalOptions extends NoteWriterOptions {
	readonly foldTranscript?: boolean;
	/** Which tag sources land in `tags:` frontmatter. Defaults to 'plaud'. */
	readonly tagMode?: TagMode;
	/** Comma-separated user tags appended in every mode except 'none'. */
	readonly customTags?: string;
	/**
	 * Write AI keywords excluded from `tags:` to a `keywords:` frontmatter
	 * property. Defaults to true.
	 */
	readonly aiKeywordsAsProperty?: boolean;
	/**
	 * Auto-close the post-import summary view after a fully successful
	 * batch (no failures). Defaults to true. A batch with failures always
	 * keeps the summary open so the errors stay visible.
	 */
	readonly autoCloseSummary?: boolean;
	/** Countdown length for the summary auto-close, in seconds. Defaults to 20. */
	readonly autoCloseSummarySeconds?: number;
	/**
	 * When true (the default), a recording Plaud reports it cannot transcribe
	 * or summarize yet (an in-band server error such as -12) gets a placeholder
	 * note carrying the recording ID and a Plaud link, instead of a bare
	 * failure. The stub is replaced automatically by a later successful import.
	 * Set false to keep such recordings as plain failures with no file written.
	 */
	readonly writePlaceholderForUnprocessed?: boolean;
	/**
	 * Show recordings that are in Plaud's trash in the import list. Defaults to
	 * false (trash hidden, matching the Plaud web UI). The recordings are still
	 * fetched — they are filtered at the display layer — so pagination is
	 * unaffected.
	 */
	readonly showTrashedRecordings?: boolean;
	readonly defaultIncludeSummary?: boolean;
	readonly defaultIncludeAttachments?: boolean;
	readonly defaultIncludeMindmap?: boolean;
	readonly defaultIncludeCard?: boolean;
	/**
	 * Optional token provider used for follow-up attachment fetches that
	 * may require authenticated Plaud API calls (for example, image paths
	 * nested inside attachment JSON blobs).
	 */
	readonly getAuthToken?: () => string | null;
	/**
	 * Optional provider for the current Plaud API host. Threaded to the
	 * attachment importer so relative-asset download candidates resolve
	 * against the region the user was redirected to, not the hardcoded US
	 * host. Defaults to the US host when omitted.
	 */
	readonly getApiBaseUrl?: () => string;
	/**
	 * Optional debug logger shared with the Plaud client. When provided and
	 * enabled, attachment import emits granular events (JSON parsing, nested
	 * picture-link extraction, and per-candidate fetch attempts) so users can
	 * copy one coherent troubleshooting log.
	 */
	readonly debugLogger?: DebugLogger;
	/**
	 * Optional inline re-authentication via the email/password login window.
	 * Resolves true once a fresh token is captured and saved, false if the user
	 * closed the window or the login API is unavailable on this build. When
	 * supplied, the modal's error screen offers a "Sign in" CTA for the
	 * token-rejected / not-configured categories instead of dead-ending.
	 */
	readonly onReauth?: () => Promise<boolean>;
	/**
	 * Optional Google/Apple SSO affordances mirroring the settings tab's
	 * bookmarklet flow. When supplied alongside onReauth, the error screen adds
	 * an "Other sign-in methods" expander wiring these three callbacks.
	 */
	readonly onReauthSso?: {
		/** Open the one-time bookmarklet setup page in the system browser. */
		readonly setupBookmark: () => void;
		/** Launch the browser sign-in walkthrough (Google/Apple/password). */
		readonly signIn: () => void;
		/** Read a token from the clipboard and store it; resolves true on success. */
		readonly pasteToken: () => Promise<boolean>;
	};
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for unit testing). Keeping them outside the Modal
// class means the test suite can exercise classification and formatting
// without mocking the Modal base class or the DOM.
// -----------------------------------------------------------------------------

export type ErrorCategory =
	| 'not-configured'
	| 'token-rejected'
	| 'rate-limited'
	| 'server-error'
	| 'parse-error'
	| 'api-error'
	| 'network-error'
	| 'config-error'
	| 'write-collision'
	| 'write-failed'
	| 'unknown';

export interface ErrorClassification {
	readonly category: ErrorCategory;
	readonly message: string;
	readonly canRetry: boolean;
}

/**
 * Whether an error category represents an authentication problem the user can
 * resolve by re-authenticating (an expired/revoked token, or none configured).
 * The import modal shows its inline "Sign in" CTA only for these categories.
 * Pure and exported so it can be unit-tested without a DOM harness.
 */
export function categoryAllowsReauth(category: ErrorCategory): boolean {
	return category === 'token-rejected' || category === 'not-configured';
}

const NOT_CONFIGURED_MESSAGE =
	'No Plaud token configured. Open Settings → Community Plugins → Plaud Importer to paste your token, then run this command again.';
const TOKEN_REJECTED_MESSAGE =
	'Plaud rejected your token. It may be expired or revoked. Open Settings → Community Plugins → Plaud Importer and re-enter it.';
export function classifyError(err: unknown): ErrorClassification {
	// NoteWriterError classification must come first — it is not a
	// PlaudApiError subclass, and different messages map to different
	// categories (collision vs config vs vault-level write failure).
	if (err instanceof NoteWriterError) {
		const msg = err.message;
		if (msg.toLowerCase().includes('filename collision')) {
			return {
				category: 'write-collision',
				message: msg,
				canRetry: false,
			};
		}
		if (
			msg.toLowerCase().includes('invalid ondup') ||
			msg.toLowerCase().includes('escape the vault') ||
			msg.toLowerCase().includes('output folder')
		) {
			return {
				category: 'config-error',
				message: `${msg}. Open Settings → Community Plugins → Plaud Importer to fix it.`,
				canRetry: false,
			};
		}
		return {
			category: 'write-failed',
			message: msg,
			canRetry: true,
		};
	}
	// PlaudAuthError discriminates via its `reason` field so the UI never has
	// to match on message text. Both cases are non-retryable at this layer
	// because Obsidian modals are blocking — the user has to close and fix
	// settings before retrying makes sense.
	if (err instanceof PlaudAuthError) {
		if (err.reason === 'not_configured') {
			return {
				category: 'not-configured',
				message: NOT_CONFIGURED_MESSAGE,
				canRetry: false,
			};
		}
		return {
			category: 'token-rejected',
			message: TOKEN_REJECTED_MESSAGE,
			canRetry: false,
		};
	}
	// PlaudParseError must come before the generic PlaudApiError branch
	// because it extends PlaudApiError — ordering by specificity.
	if (err instanceof PlaudParseError) {
		return {
			category: 'parse-error',
			message: `Plaud returned data in an unexpected shape. The plugin may need an update. (${err.message})`,
			canRetry: false,
		};
	}
	if (err instanceof PlaudApiError) {
		if (err.status === 429) {
			return {
				category: 'rate-limited',
				message: 'Plaud is rate-limiting requests. Try again in a minute.',
				canRetry: true,
			};
		}
		if (err.status !== undefined && err.status >= 500) {
			return {
				category: 'server-error',
				message: `Plaud.AI returned a server error (${err.status}). This is usually temporary — try again in a moment.`,
				canRetry: true,
			};
		}
		if (err.status !== undefined && err.status >= 400 && err.status < 500) {
			// 4xx that isn't 401 (handled above) or 429 (handled above) —
			// things like 403 (revoked), 404 (endpoint moved), 400 (bad
			// request). These are almost always "the plugin is out of
			// date" or "Plaud changed something," not "your network is
			// broken," so saying "Could not reach Plaud.AI" would be a lie.
			return {
				category: 'api-error',
				message: `Plaud.AI returned HTTP ${err.status}. The plugin may need an update — check the plugin repository for a newer version.`,
				canRetry: false,
			};
		}
		// No status. Two sub-cases distinguished by message text:
		//   1. In-band error (Plaud returned a failure envelope on HTTP
		//      200) → api-error, message states plainly that this is a
		//      Plaud-side issue, NOT the plugin failing to read the response.
		//   2. Fetcher threw (DNS, TLS, offline) → network-error with a
		//      "could not reach" prefix.
		if (err.message.includes('in-band error from')) {
			// Lead with the ownership statement: an in-band error means Plaud
			// returned a structured error envelope that the plugin parsed
			// correctly, so the failure is on Plaud's side. -12 "start trans
			// task error" specifically means Plaud has not produced a transcript
			// or summary for this recording yet; other codes get the generic
			// Plaud-side phrasing. Plaud's raw status/msg is kept at the end for
			// bug reports.
			const lead =
				err.inBandStatus === -12
					? 'Plaud has no transcript or summary for this recording. A common cause is audio with no detectable speech (Plaud shows "No speech detected"); it can also mean the recording is still processing.'
					: 'Plaud could not complete this request and returned an error.';
			return {
				category: 'api-error',
				message:
					`${lead} This is a Plaud-side issue, not a problem with the plugin reading the data. ` +
					`The plugin received and parsed Plaud's response correctly. Open the recording in the ` +
					`Plaud app to check the exact reason, then re-import if content becomes available. (${err.message})`,
				canRetry: true,
			};
		}
		return {
			category: 'network-error',
			message: `Could not reach Plaud.AI: ${err.message}`,
			canRetry: true,
		};
	}
	// Defense in depth — should never hit this. Retrying an unknown error
	// almost never helps (the cause is a code bug, not a transient failure),
	// so we tell the user to report it instead of offering a retry that
	// will keep producing the same error.
	return {
		category: 'unknown',
		message: `Unexpected error in Plaud Importer. Please report this at the plugin's GitHub repository. (${
			err instanceof Error ? err.message : String(err)
		})`,
		canRetry: false,
	};
}

/**
 * True when an import error is a Plaud-side, in-band failure that means Plaud
 * itself has no transcript or summary for the recording yet (it returned a
 * structured error envelope, which the plugin parsed correctly). This is the
 * case where writing a placeholder note is the right move: the recording exists
 * on Plaud but has no derivable content, so a stub with the link is more useful
 * than a bare failure. Excludes token/auth failures (those need the user to fix
 * the token, not a stub) and transport/parse failures (retryable or plugin
 * bugs, where a placeholder would be misleading).
 */
export function isPlaudUnprocessedError(err: unknown): boolean {
	return (
		err instanceof PlaudApiError &&
		!(err instanceof PlaudAuthError) &&
		!(err instanceof PlaudParseError) &&
		err.message.includes('in-band error from')
	);
}

export function formatDate(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
		d.getHours(),
	)}:${pad(d.getMinutes())}`;
}

export function formatDuration(seconds: number): string {
	// Guard against non-finite input before any arithmetic — Math.floor(NaN)
	// returns NaN and downstream template interpolation produces garbage
	// like "NaNh NaNm NaNs" in the UI. The parser already rejects non-finite
	// durations upstream, but formatDuration is exported as a standalone
	// pure helper so this is defense-in-depth for future callers.
	if (!Number.isFinite(seconds)) {
		return '0m 0s';
	}
	const safe = Math.max(0, Math.floor(seconds));
	const h = Math.floor(safe / 3600);
	const m = Math.floor((safe % 3600) / 60);
	const s = safe % 60;
	if (h > 0) {
		return `${h}h ${m}m ${s}s`;
	}
	return `${m}m ${s}s`;
}

// -----------------------------------------------------------------------------
// Import result tallying — pure helpers, exported for unit testing.
// -----------------------------------------------------------------------------

export type ImportResult =
	| {
			readonly kind: 'written';
			readonly recording: Recording;
			readonly writeOutcome: WriteOutcome;
	  }
	| {
			readonly kind: 'failed';
			readonly recording: Recording;
			// Short human-readable reason for the failures list. Derived
			// from the classification so the UI doesn't have to re-run it.
			readonly reason: string;
			// Typed classification (category + retryability) so future
			// consumers can group failures by category, decide whether
			// to retry, or render category-specific help text.
			readonly classification: ErrorClassification;
			// Preserved original value so a future logError pass can
			// surface the full stack / error class / status in telemetry.
			readonly cause: unknown;
	  }
	| {
			// Plaud never produced a transcript OR a summary for this
			// recording (e.g. a never-processed raw clip). There is
			// genuinely nothing to write, so this is a benign skip, not a
			// failure: surfaced separately from duplicate-skips and from
			// the -12 error path so the user sees an honest "no content"
			// reason instead of a spurious error.
			readonly kind: 'skipped-no-content';
			readonly recording: Recording;
	  }
	| {
			// Plaud confirmed (via an in-band server error such as -12) that it
			// has no transcript or summary for this recording yet, but the
			// recording exists. Instead of a bare failure, the importer wrote a
			// placeholder note carrying the recording ID and a link back to
			// Plaud, which a later successful import replaces automatically.
			readonly kind: 'placeholder-written';
			readonly recording: Recording;
			readonly outcome: PlaceholderWriteOutcome;
			// The classified Plaud-side reason, surfaced in the summary and the
			// copy-details payload so the user knows why it was a placeholder.
			readonly reason: string;
			readonly classification: ErrorClassification;
	  };

export interface ImportTally {
	readonly total: number;
	readonly created: number;
	readonly overwritten: number;
	// Notes skipped because a same-path/same-id note already existed and
	// the duplicate policy was 'skip'. Distinct from noContent.
	readonly skipped: number;
	// Recordings skipped because Plaud has no transcript and no summary
	// for them — nothing to import, reported as a benign skip.
	readonly noContent: number;
	readonly failed: number;
	readonly failures: readonly ImportResult[];
	// The 'skipped-no-content' results, kept for the summary view's
	// informational (non-error) list.
	readonly noContentResults: readonly ImportResult[];
	// Recordings Plaud has not processed yet, for which a placeholder note was
	// written (created or refreshed). Counts only actual stubs, not the
	// 'kept-existing' case (which is reported as a skip via a 'written' result).
	readonly placeholdersWritten: number;
	readonly placeholderResults: readonly ImportResult[];
}

export function tallyImportResults(results: readonly ImportResult[]): ImportTally {
	let created = 0;
	let overwritten = 0;
	let skipped = 0;
	let noContent = 0;
	let failed = 0;
	let placeholdersWritten = 0;
	const failures: ImportResult[] = [];
	const noContentResults: ImportResult[] = [];
	const placeholderResults: ImportResult[] = [];
	for (const r of results) {
		if (r.kind === 'failed') {
			failed++;
			failures.push(r);
			continue;
		}
		if (r.kind === 'skipped-no-content') {
			noContent++;
			noContentResults.push(r);
			continue;
		}
		if (r.kind === 'placeholder-written') {
			placeholdersWritten++;
			placeholderResults.push(r);
			continue;
		}
		switch (r.writeOutcome.status) {
			case 'created':
				created++;
				break;
			case 'overwritten':
				overwritten++;
				break;
			case 'skipped':
				skipped++;
				break;
		}
	}
	return {
		total: results.length,
		created,
		overwritten,
		skipped,
		noContent,
		failed,
		failures,
		noContentResults,
		placeholdersWritten,
		placeholderResults,
	};
}

/**
 * Build the one-line Notice text shown after an import batch completes.
 * The Notice is the only feedback the user sees outside the modal itself,
 * so it needs to report counts compactly.
 */
export function formatImportNotice(tally: ImportTally): string {
	if (tally.total === 0) {
		return 'Plaud importer: nothing to import.';
	}
	const imported = tally.created + tally.overwritten;
	const parts: string[] = [];
	parts.push(`${imported} imported`);
	if (tally.skipped > 0) {
		parts.push(`${tally.skipped} skipped`);
	}
	if (tally.noContent > 0) {
		parts.push(`${tally.noContent} no content`);
	}
	if (tally.placeholdersWritten > 0) {
		parts.push(`${tally.placeholdersWritten} placeholder`);
	}
	if (tally.failed > 0) {
		parts.push(`${tally.failed} failed`);
	}
	return `Plaud importer: ${parts.join(', ')}.`;
}

/**
 * Format an error classification as a structured block suitable for
 * pasting into a bug report. Exported so the renderError path and any
 * future "copy failure details" button in the summary view can share
 * the same format.
 */
export function formatErrorForClipboard(classification: ErrorClassification): string {
	return [
		'Plaud Importer error',
		`Category: ${classification.category}`,
		`Retryable: ${classification.canRetry}`,
		'Message:',
		classification.message,
	].join('\n');
}

// -----------------------------------------------------------------------------
// Progressive paging helpers
// -----------------------------------------------------------------------------

/**
 * Number of recordings fetched per "Load more" click. Kept small so the
 * first render is cheap and the user can stop scrolling early if they
 * already see the meeting they want. Tune by feel — there is no hard cap
 * from Plaud's side.
 */
export const PAGE_SIZE = 10;

/**
 * Merge a freshly-fetched page into the accumulator that backs the modal
 * list, and decide whether more pages probably exist.
 *
 * Background:
 * - Plaud's `/file/simple/web` endpoint supports offset pagination via the
 *   `skip` and `limit` query params, but it does NOT report the total
 *   count of recordings, nor does it return an explicit "end of stream"
 *   marker. So we can only *infer* "no more recordings" from the batch
 *   size that came back.
 * - Recordings can be uploaded to Plaud while the modal is open. That
 *   means a naive `[...existing, ...incoming]` can produce duplicates: if
 *   a new recording is uploaded between page 1 and page 2, Plaud's newest-
 *   first sort will shift page 2 down by one, and the first row of the new
 *   page will be a repeat of the last row of the previous page.
 *
 * Strategy:
 * - Deduplicate by recording ID so mid-session uploads that shift Plaud's
 *   offset windows do not produce duplicate rows in the modal.
 * - Preserve first-seen ordering by appending only unseen incoming rows.
 * - Infer "has more" from page fullness (`incoming.length >= pageSize`).
 *   This avoids an extra empty trailing fetch on normal pagination.
 */
export function mergeRecordings(
	existing: readonly Recording[],
	incoming: readonly Recording[],
	pageSize: number,
): { readonly merged: readonly Recording[]; readonly hasMore: boolean } {
	const merged: Recording[] = [...existing];
	const seen = new Set(existing.map((r) => r.id));
	for (const recording of incoming) {
		if (seen.has(recording.id)) {
			continue;
		}
		seen.add(recording.id);
		merged.push(recording);
	}
	const hasMore = incoming.length >= pageSize;
	return { merged, hasMore };
}

/**
 * Filter the recordings the modal should DISPLAY. Trashed recordings are kept
 * in the modal's accumulator (so pagination math stays correct — the server
 * page size and skip offset must not change) but hidden from the list unless
 * the user opts in. Pure and exported so the view logic is unit-testable
 * without a DOM.
 */
export function filterVisibleRecordings(
	recordings: readonly Recording[],
	showTrashed: boolean,
): readonly Recording[] {
	if (showTrashed) {
		return recordings;
	}
	return recordings.filter((r) => !r.isTrashed);
}

export interface ArtifactSelection {
	readonly includeSummary: boolean;
	readonly includeTranscript: boolean;
	readonly includeAttachments: boolean;
	readonly includeMindmap: boolean;
	readonly includeCard: boolean;
}

/**
 * Five-button per-duplicate prompt used when the user has chosen "Ask
 * each time" duplicate handling. The last three buttons (overwrite-all,
 * skip-all, cancel) escalate the decision: the caller uses them to
 * short-circuit subsequent duplicates in the same batch.
 */
export type DuplicateDecisionChoice =
	| 'overwrite'
	| 'skip'
	| 'overwrite-all'
	| 'skip-all'
	| 'cancel';
