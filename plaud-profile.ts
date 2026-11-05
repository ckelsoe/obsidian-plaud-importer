import {
	extractSpeakers,
	formatDurationHoursMinutes,
	formatLocalDateTime,
} from './note-writer';
import { recordingSourceLabel } from './plaud-client';
import type { Recording, Transcript } from './recording-model';
import type { ServiceProfile } from './service-profile';
import { trimTrailingChars } from './text-trim';

/** Prod (v3) web portal, the default when no environment base is supplied. */
export const PLAUD_WEB_URL_V3 = 'https://web.plaud.ai';

/**
 * Build the public web-app URL for a Plaud recording. This is the link a user
 * clicks to open the recording in Plaud's browser UI. The `/file/{id}` path
 * shape is the same on every portal, so only the origin differs: a v3 (prod)
 * account links to `https://web.plaud.ai`, a v4 (new portal) account to its own
 * sign-in portal (`https://web.plaud.ai` by default). The caller passes the environment's
 * base via `webBase`; it defaults to the prod portal so an unthreaded caller
 * stays correct for v3. Confirmed from a live Plaud session on 2026-04-14.
 *
 * The ID is passed through `encodeURIComponent` for defense-in-depth,
 * matching the same treatment `plaud-client-re.ts` applies to the ID
 * when building the `/ai/transsumm/{id}` API URL. Real Plaud IDs are
 * 32-char hex strings that need no encoding, but a future ID format
 * change (slashes, dots, etc.) would silently produce broken URLs
 * without this guard.
 */
export function formatPlaudWebUrl(
	recordingId: string,
	webBase: string = PLAUD_WEB_URL_V3,
): string {
	const base = trimTrailingChars(webBase, '/');
	return `${base}/file/${encodeURIComponent(recordingId)}`;
}

/**
 * Substitute Plaud's template placeholders inside a markdown body. Plaud's
 * summary templates contain tokens like `$[audio_start_time]` that the
 * Plaud web UI replaces with concrete values on the client before
 * rendering. Their API returns the RAW template body, so without this
 * substitution our notes would show literal `$[audio_start_time]` text
 * where a date should be.
 *
 * Known placeholders (filled in from the recording / transcript we
 * already have on hand):
 *   $[audio_start_time]  → "YYYY-MM-DD HH:MM:SS" in the capture zone
 *   $[audio_title]       → recording.title
 *   $[audio_duration]    → human-readable duration
 *   $[speakers]          → comma-separated speaker list
 *
 * Unknown placeholders are left untouched so user notes are never
 * silently mangled by a regex on a token we don't have data for. New
 * tokens Plaud adds in future templates show through verbatim and a
 * follow-up can wire them in once we know what they should resolve to.
 *
 * `offsetMinutes` is the recording's effective capture-zone offset, threaded so
 * $[audio_start_time] matches the note's own date/time. It defaults to the
 * importing device's zone for callers that omit it.
 */
export function substitutePlaudPlaceholders(
	markdown: string,
	recording: Recording,
	transcript: Transcript | null,
	offsetMinutes?: number,
): string {
	if (markdown.length === 0) return markdown;
	return markdown.replace(/\$\[([a-z0-9_]+)\]/g, (match, key: string) => {
		switch (key) {
			case 'audio_start_time':
				return formatLocalDateTime(recording.createdAt, offsetMinutes);
			case 'audio_title':
				return recording.title;
			case 'audio_duration':
				return formatDurationHoursMinutes(recording.durationSeconds);
			case 'speakers': {
				const speakers = extractSpeakers(transcript);
				return speakers.length > 0 ? speakers.join(', ') : match;
			}
			default:
				return match;
		}
	});
}

/**
 * `AttachmentAsset.dataType` the import runner stamps on a recording's marks
 * (screenshots) so the attachment importer routes them to the dedicated `mark`
 * kind: gated by the screenshots selection, downloaded, and repointed inline
 * WITHOUT a managed "Images and Attachments" entry (note-writer already renders
 * them in a `## Screenshots` section). The runner reads it from the profile.
 */
const PLAUD_MARK_DATA_TYPE = 'plaud_mark';

export const PLAUD_PROFILE: ServiceProfile = {
	keyPrefix: 'plaud',
	pluginId: 'plaud-importer',
	/**
	 * The v4 portal preserves each v3 recording's id and exposes it as
	 * `of_<v3id>`, so a note that stored the bare v3 id (`<v3id>`) and the
	 * current v4 recording (`of_<v3id>`) are the same meeting. Stripping the
	 * single leading `of_` makes them equal. v4-native ids (`f_...`, `f_s_...`)
	 * carry no v3 id and are returned unchanged. Pure and total.
	 */
	canonicalId: (id) => (id.startsWith('of_') ? id.slice(3) : id),
	serviceName: 'Plaud',
	pluginName: 'Plaud Importer',
	recordingUrl: formatPlaudWebUrl,
	placeholderCallout: [
		'> [!warning] Not imported: Plaud has no transcript or summary',
		'> Plaud has no transcript or summary available for this recording. This is a',
		'> Plaud-side condition, not a problem reading the data. A common cause is that',
		'> the audio has no detectable speech (Plaud shows "No speech detected"). It can',
		'> also mean the recording is still processing. Open it in Plaud to see the exact',
		'> reason. If Plaud later has content for it, re-run the import and this',
		'> placeholder is replaced automatically. If Plaud reports no speech, there is',
		'> nothing to import.',
		'>',
	],
	markDataType: PLAUD_MARK_DATA_TYPE,
	expandSummaryTokens: substitutePlaudPlaceholders,
	devices: { label: recordingSourceLabel, sampleName: 'Plaud Note' },
};
