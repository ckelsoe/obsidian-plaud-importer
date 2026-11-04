// Service-neutral recording model: the shapes every importer layer (note
// writer, import runner, vault index, auto-sync) works with, independent of
// which recorder service produced them. A service client maps its own wire
// format onto these types. Moved out of plaud-client.ts for the
// recording-importer core extraction; fields that only Plaud fills are
// optional and documented as such.

/**
 * Branded string that identifies a recording in its source service. The same
 * ID covers the recording and all of its derived artifacts (transcript,
 * summary, audio), so one brand covers the whole entity tree. Consumers must
 * receive instances from a service client's parser; there is no public
 * constructor.
 */
export type RecordingId = string & {
	readonly __brand: 'RecordingId';
};

/**
 * A summary beyond the primary one (see `TranscriptAndSummary.additionalSummaries`).
 * `heading` is the note section title derived from the summary's object type
 * (e.g. `SUMMARY_BETA` -> "Summary (beta)"); `text` is the markdown body, already
 * image-resolved by the client. Rendered as its own `## <heading>` section.
 */
export interface AdditionalSummary {
	readonly heading: string;
	readonly text: string;
}

/**
 * One AI template output ("consumer note") attached to a recording in Plaud.
 * `heading` is the section title, taken from the generating template's name
 * (`extra.used_template.template_name`, e.g. "Meeting Summary") and falling
 * back to the tab label then the entry title; `markdown` is the fetched body.
 * These mirror the user's own Plaud-side template selection, so inclusion is
 * their choice, not ours.
 */
export interface ConsumerNote {
	readonly heading: string;
	readonly markdown: string;
}

/**
 * A single chapter entry extracted from Plaud's outline data. Titles are
 * trimmed non-empty strings; timestamps are in seconds (Plaud's wire
 * format is milliseconds, converted by the parser) so they match the
 * existing `TranscriptSegment.startSeconds` convention.
 *
 * `endSeconds` is optional because not every wire shape carries it — a
 * stripped-down outline may only give start points. Note-writer falls
 * back to showing just the start timestamp when end is absent.
 */
export interface Chapter {
	readonly title: string;
	readonly startSeconds: number;
	readonly endSeconds?: number;
}

export interface AttachmentAsset {
	/**
	 * Plaud's raw `data_type` discriminator from `/file/detail/{id}`.
	 * Useful for diagnostics and fallback naming when no filename is present.
	 */
	readonly dataType: string;
	/**
	 * Download URL, usually pre-signed S3.
	 */
	readonly url: string;
	/**
	 * Optional human-readable name from Plaud metadata if present.
	 */
	readonly name?: string;
	/**
	 * Optional MIME type hint from Plaud metadata if present.
	 */
	readonly mimeType?: string;
}

/**
 * One page of recordings plus the opaque forward cursor for the next page.
 * Returned by the v4 portal client's cursor-paginated `listRecordingsPage`.
 * `nextCursor` is null when the list is exhausted.
 */
export interface RecordingPage {
	readonly recordings: readonly Recording[];
	readonly nextCursor: string | null;
}

/**
 * Where a recording was captured, derived from the list payload's `scene` and
 * `serial_number`. Verified live 2026-08-21 (issue #110): `scene` 1 and 7 are
 * physical-device captures whose `serial_number` is the capturing device's
 * hardware serial (it joins to a `PlaudDevice.sn`); every other scene, or a
 * synthetic/empty serial, is the non-device app/desktop/import path. The
 * recording-source import filter uses this to keep a chosen device (for example
 * a personal NotePin) out of auto-sync.
 */
export type RecordingSource =
	| { readonly kind: 'device'; readonly serial: string }
	| { readonly kind: 'app' };

export interface Recording {
	readonly id: RecordingId;
	readonly title: string;
	readonly createdAt: Date;
	/**
	 * When the recording ended, as an absolute instant. Taken from Plaud's
	 * `end_time` when present and consistent, otherwise reconstructed as
	 * `createdAt + duration` (the two agree on 100% of the live-audited account,
	 * so the fallback is defensive). Used for the `end-time` frontmatter field.
	 */
	readonly endsAt: Date;
	readonly durationSeconds: number;
	/**
	 * The recording's own capture time-zone offset from UTC, in minutes
	 * (`timezone*60 + zonemins`), e.g. -240 for UTC-4. This is where the
	 * recording was actually made, independent of the importing computer, so the
	 * note's wall-clock time matches Plaud's own app. `null` only when the list
	 * payload omits `timezone` (not seen on the live account, kept for older
	 * payloads); the note writer then falls back to a configured or device zone.
	 */
	readonly captureOffsetMinutes: number | null;
	/**
	 * Advisory hint from the list endpoint that a transcript exists for this
	 * recording. The authoritative answer is `getTranscript(id) !== null` —
	 * this flag may be stale if Plaud updated the recording after it was
	 * listed. Useful for cheap UI decisions (show a transcript icon), not as
	 * a load-bearing invariant.
	 */
	readonly transcriptAvailable: boolean;
	/**
	 * Advisory hint from the list endpoint that an AI summary exists. The
	 * authoritative answer is `getSummary(id) !== null`.
	 */
	readonly summaryAvailable: boolean;
	/**
	 * True when the list endpoint does not report per-recording transcript/summary
	 * presence, so `transcriptAvailable`/`summaryAvailable` are both left false as
	 * "unknown" rather than "absent". The import runner's pre-fetch skip (both
	 * flags false means nothing to fetch) is WRONG in that case: it would skip
	 * every recording. When this is true the runner must fetch content and let the
	 * detail response be authoritative. The v4 portal list omits the flags; the
	 * prod list carries `is_trans`/`is_summary`, so it leaves this undefined.
	 */
	readonly contentAvailabilityUnknown?: boolean;
	/**
	 * True when the recording is in Plaud's trash. The list endpoint returns
	 * trashed and non-trashed recordings together, so consumers that should not
	 * surface trash (the import list) must filter on this. Defaults to false
	 * when the list payload omits the flag (older recordings).
	 */
	readonly isTrashed: boolean;
	readonly folderId?: string;
	readonly tags?: readonly string[];
	/**
	 * Plaud's classification of the recording's parent folder (v4
	 * `parent_folder.system_folder_type`). 0 (or undefined, incl. every v3
	 * recording) means a real user folder. A nonzero value is a built-in system
	 * bucket, not a folder the user filed into: 1 = "Recordings" (the default
	 * UNFILED bucket), 2 = "Import", 5 = "Conflict File". Import uses this to write
	 * `plaud-location` (unfiled/import/conflict) instead of a `plaud-folder` + tag
	 * for system-bucket recordings, so Plaud's plumbing buckets never pollute the
	 * tag pane. Optional; the v3 list has no such field.
	 */
	readonly systemFolderType?: number;
	/**
	 * Plaud's edit version for the recording, in unix milliseconds (the list's
	 * `version_ms`, equal to `edit_time * 1000`). Advances whenever the
	 * recording is edited or (re)processed in Plaud. Auto-sync stores this in
	 * frontmatter (`plaud-version-ms`) and compares it against the list to
	 * detect changed recordings. Optional: older list payloads may omit it.
	 */
	readonly versionMs?: number;
	/**
	 * True when the recording is still syncing from the capture device
	 * (`wait_pull === 1`): its content may be incomplete, so auto-sync skips it
	 * and picks it up on a later tick. Defaults to false when the flag is
	 * absent.
	 */
	readonly waitPull?: boolean;
	/**
	 * Where the recording was captured (`{ kind: 'device', serial }` for a
	 * physical Plaud device, `{ kind: 'app' }` for the desktop/phone/import path).
	 * Derived by the parser from `scene` + `serial_number`. Optional only so
	 * legacy/synthetic Recording values without it still type-check; the live
	 * parser always sets it. Consumed by the recording-source import filter.
	 */
	readonly source?: RecordingSource;
}

export interface Transcript {
	readonly id: RecordingId;
	readonly segments: readonly TranscriptSegment[];
	readonly rawText: string;
}

export interface TranscriptSegment {
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly speaker?: string;
	readonly text: string;
}

export interface Summary {
	readonly id: RecordingId;
	readonly text: string;
	readonly sections?: readonly SummarySection[];
	/**
	 * Optional extras surfaced by Plaud's flat GPT-5 schema (shape 5 of
	 * `data_result_summ`, rolled out 2026-05). Every field is best-effort:
	 * the parser pulls them with soft `typeof === 'string'` guards and
	 * drops anything missing or wrong-shaped. None of these fields are
	 * load-bearing for the import; their job is to surface useful Plaud
	 * metadata into the note's frontmatter (and the body for
	 * `aiSuggestion`) without ever blowing up when a future shape change
	 * removes or renames a field. New unknown top-level keys are silently
	 * ignored — extension is open, breakage is closed.
	 */
	readonly headline?: string;
	readonly category?: string;
	/**
	 * Plaud's `industry_category`: a topical/industry classification distinct
	 * from `category` (which in the current Plaud shape mirrors the template
	 * name). Surfaced as its own `plaud-industry` property rather than folded
	 * into `category` so the two never mix. Best-effort like the rest here.
	 */
	readonly industry?: string;
	readonly language?: string;
	readonly template?: string;
	readonly model?: string;
	readonly aiSuggestion?: string;
	readonly noteId?: string;
	readonly summaryId?: string;
	readonly version?: string;
}

interface SummarySection {
	readonly heading: string;
	readonly body: string;
}
