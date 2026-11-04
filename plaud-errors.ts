// Plaud's side of the error contract: maps the Plaud client's error classes
// onto the shared categories. The core's classifyError (import-core.ts) handles
// note-writer failures and the unknown fallback and asks this policy about
// everything else, so the core never imports Plaud's error classes.

import {
	classifyError,
	type ErrorClassification,
	type ServiceErrorPolicy,
} from './import-core';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
} from './plaud-client-re';
import { PLAUD_PROFILE } from './plaud-profile';

const NOT_CONFIGURED_MESSAGE =
	'No Plaud token configured. Open Settings → Community Plugins → Plaud Importer to paste your token, then run this command again.';
// Rendered on three surfaces: the import dialog's auth-error screen (sign-in
// buttons right below it), the auto-sync pause notice (a Reconnect action
// beside it), and the settings Test connection result (the sign-in controls
// sit above it). So the remedy names the action generically rather than
// pointing at a button label or a settings path only one surface has
// (issue #78: the old "re-enter it in settings" text was wrong for
// browser-flow users, whose remedy is re-running the bookmarklet flow).
const TOKEN_REJECTED_MESSAGE =
	'Plaud rejected your token. It may be expired or revoked. Sign in again for your account type to start a fresh session.';
function classifyPlaudServiceError(err: unknown): ErrorClassification | null {
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
				message:
					'Plaud is rate-limiting requests. Try again in a minute.',
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
	return null;
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

export const PLAUD_ERROR_POLICY: ServiceErrorPolicy = {
	pluginName: PLAUD_PROFILE.pluginName,
	classify: classifyPlaudServiceError,
	isUnprocessed: isPlaudUnprocessedError,
};

/** classifyError bound to Plaud's policy, for the Plaud-side callers. */
export function classifyPlaudError(err: unknown): ErrorClassification {
	return classifyError(err, PLAUD_ERROR_POLICY);
}
