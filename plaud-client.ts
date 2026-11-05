// Contract between the plugin and any Plaud backend. The viability doc
// (dev-docs/00-viability-findings.md §6.1) is the source of truth for this
// surface — update it there first if the shape needs to change.

import type {
	RecordingId,
	RecordingPage,
	RecordingSource,
	Recording,
	RecordingMark,
	RecordingArtifacts,
} from './recording-model';

/**
 * Plaud's artifact bundle: the neutral `RecordingArtifacts`, with marks typed
 * as `PlaudMark` so the clients keep Plaud's `mark_type`. Plaud returns the
 * transcript and summary together in a single POST /ai/transsumm/{id}
 * response, hence the name.
 *
 * Where the optional fields come from:
 * - `nestedAssetLinks`: the transsumm response's `download_link_map`.
 * - `aiKeywords`: `/file/detail/{id}` → `data.extra_data.aiContentHeader.keywords`.
 * - `chapters`: the `outline` entry of the detail's `content_list`, a pre-signed
 *   S3 body parsed by `parseOutlineBody`, which logs an unrecognized body at
 *   debug level so the parser can be widened.
 * - `attachments`: detail `content_list` entries with an unknown data type and
 *   a `data_link` URL; transcript and summary entries are excluded.
 * - `consumerNotes`: `content_list` entries of `data_type: consumer_note`, each
 *   a pre-signed `text/plain` Markdown body.
 * - `marks`: the v4 detail's `MARK_MEMO` object (none from the v3 client).
 * - `additionalSummaries`: v4 summaries other than the classic `SUMMARY`, such
 *   as `SUMMARY_BETA` (none from the v3 client).
 */
export interface TranscriptAndSummary extends RecordingArtifacts {
	readonly marks?: readonly PlaudMark[];
}

/**
 * One "mark" a user captured during a recording: a screenshot/photo taken at a
 * point in the recording. On the v4 portal these live in the file-detail's
 * `MARK_MEMO` object, whose `content_url` is a JSON array of
 * `{ timestamp, mark_type, picture_link }` entries; `picture_link` is a content
 * id the detail's `relation_content_mapping` resolves to a pre-signed image URL.
 * Shape verified live (read-only) 2026-09-18: every entry carried a resolvable
 * `picture_link` and `mark_type` 2 (photo). The v3 client does not produce these.
 */
export interface PlaudMark extends RecordingMark {
	/**
	 * Plaud's `mark_type` discriminator (2 = photo/screenshot on every recording
	 * observed live). Kept for diagnostics and possible future differentiation;
	 * the parser keys off a resolvable `picture_link`, not this value.
	 */
	readonly markType?: number;
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
	/**
	 * Cursor-paginated variant of `listRecordings` for the new Plaud portal
	 * (`/file-app/v4/recordings/all`, which pages with an opaque `next_cursor`
	 * instead of `skip`/`limit`). Returns the page plus the next cursor.
	 *
	 * OPTIONAL: the prod reverse-engineered client does not implement it (it
	 * uses offset pagination via `listRecordings`). The v4 client implements
	 * both; `listRecordings` returns just this page's `recordings` array.
	 *
	 * Paging contract: a caller that pages MUST feature-detect this method and,
	 * when it is present, drive subsequent pages with `filter.cursor` set to the
	 * prior page's `nextCursor`. The v4 client rejects a non-zero `filter.skip`
	 * rather than silently repeating page one. The import modal, auto-sync, and
	 * version backfill feature-detect it and page by cursor on the v4 client,
	 * by offset on the prod client.
	 */
	listRecordingsPage?(filter?: RecordingFilter): Promise<RecordingPage>;
	getTranscriptAndSummary(id: RecordingId): Promise<TranscriptAndSummary>;
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
	getAudioTempUrl(id: RecordingId): Promise<string | null>;
	/**
	 * Update a recording's title (Plaud's `filename`) via `PATCH /file/{id}`.
	 * This is the plugin's only cloud write: callers MUST gate it behind an
	 * explicit user confirmation or the opt-in `autoUpdatePlaudTitle` setting.
	 * Resolves on success; rejects on failure (`PlaudAuthError` on 401 or an
	 * expired session, `PlaudApiError` on an in-band or HTTP error, and
	 * `PlaudParseError` when a 2xx carries a non-empty non-JSON body) so the
	 * caller can surface a clear message and avoid a retry that double-writes.
	 */
	updateTitle(id: RecordingId, filename: string): Promise<void>;
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
	/**
	 * Opaque forward cursor for the v4 portal's cursor-paginated list
	 * (`/file-app/v4/recordings/all`). Mutually exclusive with `skip`: the v4
	 * client pages with this, the prod RE client pages with `skip`. Undefined
	 * requests the first page. Ignored by clients that use offset pagination.
	 */
	readonly cursor?: string;
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
