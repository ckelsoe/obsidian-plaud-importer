// Contract between the plugin and any Plaud backend. The viability doc
// (dev-docs/00-viability-findings.md §6.1) is the source of truth for this
// surface — update it there first if the shape needs to change.

/**
 * Branded string that identifies a Plaud recording. Plaud returns the same
 * underlying ID for a recording and all of its derived artifacts (transcript,
 * summary, audio), so one brand covers the whole entity tree. Consumers must
 * receive instances from the parser — there is no public constructor.
 */
export type PlaudRecordingId = string & {
	readonly __brand: 'PlaudRecordingId';
};

/**
 * Bundle of derived artifacts for a single recording. Plaud returns the
 * transcript and summary together in a single POST /ai/transsumm/{id}
 * response, so fetching them with one method matches the wire protocol and
 * avoids the temptation to call the same endpoint twice.
 *
 * Either field may be null independently: a recording can have a
 * transcript without an AI summary (or vice versa) depending on Plaud's
 * processing status.
 */
export interface TranscriptAndSummary {
	readonly transcript: Transcript | null;
	readonly summary: Summary | null;
	/**
	 * Optional map of relative Plaud asset paths to pre-signed download URLs
	 * returned by `/ai/transsumm/{id}` (for example `download_link_map`).
	 * Used by attachment import to resolve `picture_link` entries to real image
	 * bytes instead of HTML wrapper pages.
	 */
	readonly nestedAssetLinks?: Readonly<Record<string, string>>;
	/**
	 * AI-generated keyword tags from Plaud, when the client can reach a
	 * source that provides them. Populated by the RE client from
	 * `/file/detail/{id}` → `data.extra_data.aiContentHeader.keywords`,
	 * left undefined when the field is absent (older recordings, or when
	 * the detail fetch failed silently). Consumers should route these
	 * through `buildNoteTags` in note-writer.ts so the tag-mode setting,
	 * namespacing, and dedup rules stay in one place.
	 */
	readonly aiKeywords?: readonly string[];
	/**
	 * Ordered list of AI-generated chapter markers for the recording.
	 * Populated by the RE client from the `outline` entry inside
	 * `/file/detail/{id}`'s `content_list`, which points at a pre-signed
	 * S3 URL whose body is the chapter list. Left undefined when the
	 * outline is absent (older recordings) or the S3 fetch/parse failed.
	 *
	 * The exact wire shape of the S3 body is still being pinned down — the
	 * RE client's `parseOutlineBody` handles the shapes seen so far and
	 * logs the raw body at debug level when it can't recognize it, so
	 * Charles can inspect and we can widen the parser in a follow-up.
	 */
	readonly chapters?: readonly Chapter[];
	/**
	 * Downloadable asset references discovered from `/file/detail/{id}`.
	 * These are typically pre-signed URLs (short-lived) for supplemental
	 * artifacts such as screenshots or other generated media.
	 *
	 * The RE client treats this as best-effort discovery: unknown data types
	 * with a `data_link` URL are surfaced, while known transcript/summary
	 * pipeline entries stay excluded. Import-time consumers should download
	 * these immediately and persist them into the vault, because pre-signed
	 * links expire quickly.
	 */
	readonly attachments?: readonly AttachmentAsset[];
	/**
	 * Additional AI template outputs the user generated in Plaud (Key Points,
	 * Daily Journal, Meeting Summary, etc.). Each is a `content_list` entry of
	 * `data_type: consumer_note` whose pre-signed S3 link serves a `text/plain`
	 * Markdown body. The RE client fetches each body during the detail pass and
	 * surfaces it here so note-writer can fold it into the note as a section
	 * rather than the import pipeline saving it as an unreadable `.bin`
	 * attachment. Left undefined when the recording has none.
	 */
	readonly consumerNotes?: readonly ConsumerNote[];
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
 * One Plaud "filetag". In Plaud a folder and a tag are the same primitive, so
 * this catalog entry doubles as both a recording's folder membership (via the
 * recording's `filetag_id_list`, surfaced as `Recording.tags`) and the source
 * for the `plaud-folder:` frontmatter field on import. The catalog is FLAT:
 * there is no `parent_id`, so folders never nest. `icon` and `color` are Plaud
 * display metadata, unused by the forward import path but modeled here so the
 * future folder-mirroring work (Phase 4) can reuse this shape without a second
 * fetch. Verified live 2026-06-29/2026-07-02: `GET /filetag/` returns
 * `{id, name, icon, color}` per entry.
 */
export interface PlaudFolder {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly color?: string;
}

/**
 * One paired device from the account (`GET /device/list` → `data_devices[]`).
 * `sn` is the hardware serial that a device-captured recording carries in its
 * `serial_number` field, so it is the join key between a recording and the
 * device that made it (verified live 2026-08-21, issue #110). `name` is the
 * user-assigned device name shown in the Plaud app; `model` is Plaud's numeric
 * class code (see `deviceModelLabel`).
 */
export interface PlaudDevice {
	readonly sn: string;
	readonly name: string;
	readonly model: string;
	readonly versionNumber?: number;
}

// Plaud's numeric device-class codes, observed live 2026-08-21. Unknown codes
// fall back to a generic label rather than guessing, so a future device model
// still renders a sensible name.
const DEVICE_MODEL_LABELS: Readonly<Record<string, string>> = {
	'880': 'NotePin',
	'881': 'Note Pro',
	'888': 'Note',
};

/** Human-readable class name for a device `model` code, e.g. `880` → "NotePin". */
export function deviceModelLabel(model: string): string {
	return DEVICE_MODEL_LABELS[model] ?? 'Plaud device';
}

/**
 * Display label for a recording's capture source (issue #110 follow-up): the
 * paired device's name when known, "App" for a non-device (Plaud app / desktop /
 * imported) recording, and a generic fallback for a device serial not in the
 * supplied name map. Used by the `{{device}}` frontmatter token and the import
 * list badge. Returns '' for a recording with no classified source.
 */
export function recordingSourceLabel(
	source: RecordingSource | undefined,
	deviceNames: ReadonlyMap<string, string>,
): string {
	if (source === undefined) {
		return '';
	}
	if (source.kind === 'app') {
		return 'App';
	}
	const name = deviceNames.get(source.serial);
	return name !== undefined && name.length > 0 ? name : 'Plaud device';
}

export interface PlaudClient {
	listRecordings(filter?: RecordingFilter): Promise<readonly Recording[]>;
	/**
	 * Fetch the account's paired devices (`GET /device/list`) so the import-
	 * source filter can list them by name and match a recording's
	 * `serial_number` to the device that captured it. Implementations should
	 * cache per session; the device list changes rarely. Best-effort at the call
	 * site: a failed fetch degrades to "no devices known", never fails a sync.
	 */
	getDeviceCatalog(): Promise<readonly PlaudDevice[]>;
	getTranscriptAndSummary(
		id: PlaudRecordingId,
	): Promise<TranscriptAndSummary>;
	/**
	 * Fetch the account's flat folder/tag catalog (`GET /filetag/`) so import
	 * can resolve a recording's `filetag_id_list` (opaque ids) into human folder
	 * NAMES. Implementations should cache per session; the catalog changes
	 * rarely and a re-fetch is cheap. Best-effort at the call site: a failed
	 * fetch must degrade to "no folders resolved", never fail an import.
	 */
	getFolderCatalog(): Promise<readonly PlaudFolder[]>;
	/**
	 * Resolve the pre-signed download URL for a recording's original audio
	 * (Opus in an Ogg container). Returns null when Plaud exposes no audio
	 * URL for the recording, so callers treat audio as best-effort and never
	 * fail an import over a missing URL. The returned URL is a presigned S3
	 * link carrying its own signature, so download it WITHOUT the Plaud bearer.
	 */
	getAudioTempUrl(id: PlaudRecordingId): Promise<string | null>;
	/**
	 * Update a recording's title (Plaud's `filename`) via `PATCH /file/{id}`.
	 * This is the plugin's only cloud write: callers MUST gate it behind an
	 * explicit user confirmation or the opt-in `autoUpdatePlaudTitle` setting.
	 * Resolves on success; rejects on failure (`PlaudAuthError` on 401 or an
	 * expired session, `PlaudApiError` on an in-band or HTTP error, and
	 * `PlaudParseError` when a 2xx carries a non-empty non-JSON body) so the
	 * caller can surface a clear message and avoid a retry that double-writes.
	 */
	updateTitle(id: PlaudRecordingId, filename: string): Promise<void>;
}

export interface RecordingFilter {
	readonly limit?: number;
	/**
	 * Offset into the remote result set, newest-first. Used for page-based
	 * "load more" in `ImportModal` — the modal asks for
	 * `{ skip: currentRecordings.length, limit: PAGE_SIZE }` on each Load
	 * More click. Plaud's `/file/simple/web` endpoint accepts this as the
	 * `skip` query param; clients that don't support offset pagination must
	 * reject non-zero values loudly rather than silently ignore them.
	 */
	readonly skip?: number;
	readonly since?: Date;
	readonly until?: Date;
	readonly folderId?: string;
	readonly hasTranscript?: boolean;
	/**
	 * Sort dimension for the list endpoint. `'start_time'` (default) is
	 * recording-creation order, newest first. `'edit_time'` is last-EDITED
	 * order, used by auto-sync so a recording edited today (even an old one)
	 * sorts to the top and its `version_ms` can be compared against the vault.
	 */
	readonly sortBy?: 'start_time' | 'edit_time';
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
	readonly id: PlaudRecordingId;
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
	 * True when the recording is in Plaud's trash. The list endpoint returns
	 * trashed and non-trashed recordings together, so consumers that should not
	 * surface trash (the import list) must filter on this. Defaults to false
	 * when the list payload omits the flag (older recordings).
	 */
	readonly isTrashed: boolean;
	readonly folderId?: string;
	readonly tags?: readonly string[];
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
	readonly id: PlaudRecordingId;
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
	readonly id: PlaudRecordingId;
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

export interface SummarySection {
	readonly heading: string;
	readonly body: string;
}
