// v4 Plaud client for the new Plaud portal. Talks to the `file-app/v4`
// microservice API on the account's resolved regional host (read fresh each
// call from the captured domain). The plugin picks this client over the prod
// reverse-engineered client in plaud-client-re.ts when the account is on the
// new portal (see main.ts usesV4Portal). This module deliberately reuses that
// client's transport error types and validated content parsers so the two
// share one code path.
//
// Wire shapes captured live 2026-08-15, see the private workspace notes under
// dev-docs/plaud-importer/plaud-next-portal for the full capture.
//
// Like plaud-client-re.ts, this module must stay free of any `obsidian` import
// so it can be unit-tested with a stub fetcher.

import type {
	AdditionalSummary,
	PlaudClient,
	PlaudDevice,
	PlaudFolder,
	PlaudMark,
	PlaudRecordingId,
	Recording,
	RecordingFilter,
	RecordingPage,
	Summary,
	Transcript,
	TranscriptAndSummary,
} from './plaud-client';
import type { DebugLogger } from './debug-logger';
import { isTrustedPlaudHost } from './plaud-hosts';
import {
	PlaudApiError,
	PlaudAuthError,
	PlaudParseError,
	parseDeviceCatalog,
	parseOutlineBody,
	parseTranscriptField,
	type PlaudHttpFetcher,
	type PlaudHttpResponse,
	type PlaudTokenProvider,
} from './plaud-client-re';
import { trimTrailingChars } from './text-trim';

const DEFAULT_PAGE_SIZE = 300;
const DEFAULT_SCOPE_TYPE = 'workspace';
const DEFAULT_APP_PLATFORM = 'web';
const DEFAULT_APP_LANGUAGE = 'en';

// The file-detail memo only exists to coalesce the transcript+audio calls made
// for one recording during a single import. Keep it short so a later re-import
// in the same session refetches fresh metadata and fresh pre-signed content
// URLs (which expire) rather than reusing stale ones.
const DETAIL_CACHE_TTL_MS = 60_000;

// In-band status the v4 rename endpoint returns when the `origin_version` sent
// does not match the node's current version (optimistic concurrency). We re-read
// the node's version and retry once.
const NODE_VERSION_CONFLICT = -1800313;

// Unit-confusion guards for the millisecond timestamps the v4 API uses (same
// convention as the prod list endpoint). Kept local so this module does not
// depend on non-exported internals of plaud-client-re.ts.
const MIN_PLAUSIBLE_UNIX_MS = 946684800000; // 2000-01-01
const MAX_PLAUSIBLE_UNIX_MS = 4102444800000; // 2100-01-01
const MAX_PLAUSIBLE_DURATION_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * v4 object types seen inside `data.objects[]` of the file-detail response.
 * Each object carries a pre-signed `content_url` (when generated) plus a
 * vendor MIME type. POLISHED_TRANSCRIPT is the user-renamed/smoothed variant
 * and is preferred over the raw TRANSCRIPT when present.
 */
const OBJ_TRANSCRIPT = 'TRANSCRIPT';
const OBJ_POLISHED_TRANSCRIPT = 'POLISHED_TRANSCRIPT';
const OBJ_SUMMARY = 'SUMMARY';
const OBJ_OUTLINE = 'OUTLINE';
const OBJ_AUDIO = 'AUDIO';
// Screenshots ("marks") the user captured during the recording. Its
// `content_url` is a JSON array of `{ timestamp, mark_type, picture_link }`
// entries; each `picture_link` is a `c_<hex>` id that `relation_content_mapping`
// resolves to a pre-signed image URL (see parseMarkMemoArray).
const OBJ_MARK_MEMO = 'MARK_MEMO';

export interface PlaudV4ClientOptions {
	/**
	 * The account's resolved API host, e.g.
	 * `https://api-staging-apne1.plaud.ai`. The web app caches this per user in
	 * `localStorage.pld_plaud_user_api_domain`; the plugin captures it at
	 * sign-in. Required, v4 has no fixed default host.
	 *
	 * Accepts a value or a provider. Pass a provider (e.g. `() =>
	 * this.settings.apiBaseUrl`) so a host captured AFTER the client is
	 * constructed (first sign-in) takes effect without reconstruction, exactly
	 * like the token provider. The host is validated against the plaud.ai
	 * allowlist on every request, before the bearer is attached.
	 */
	readonly baseUrl: string | (() => string);
	/**
	 * Active workspace id (`ws_...`), sent as the `x-scope-id` header. Every v4
	 * data call is workspace-scoped; requests without a valid scope have no
	 * context. Required. Value or provider (read fresh each request).
	 */
	readonly workspaceId: string | (() => string);
	/** `x-scope-type` header. Defaults to `workspace`. */
	readonly scopeType?: string;
	/**
	 * `x-device-id` header, when the plugin captured one at sign-in. Value or
	 * provider (read fresh each request).
	 */
	readonly deviceId?: string | (() => string | undefined);
	/**
	 * `app-platform` / `edit-from` headers. Defaults to `web` (the value the
	 * web app sends and the value in a web-captured token's `client_id` claim).
	 * Override only if a non-web token is ever used.
	 */
	readonly appPlatform?: string;
	/** `app-language` header. Defaults to `en`. */
	readonly appLanguage?: string;
	/**
	 * `x-timezone-iana` header. Defaults to the host machine's IANA zone. Used
	 * by the server for display-time calculations, not by the plugin.
	 */
	readonly timezoneIana?: string;
	/** Page size for the list endpoint. Defaults to 300 (the web app's value). */
	readonly pageSize?: number;
	/**
	 * Optional debug logger. Authorization headers are never handed to it.
	 */
	readonly debugLogger?: DebugLogger;
}

interface FetchApiOptions {
	readonly method?: 'GET' | 'POST' | 'PATCH';
	readonly body?: string;
	readonly allowEmptyBody?: boolean;
}

export class PlaudV4Client implements PlaudClient {
	private readonly tokenProvider: PlaudTokenProvider;
	private readonly fetcher: PlaudHttpFetcher;
	private readonly baseUrlProvider: () => string;
	private readonly workspaceIdProvider: () => string;
	private readonly scopeType: string;
	private readonly deviceIdProvider: () => string | undefined;
	private readonly appPlatform: string;
	private readonly appLanguage: string;
	private readonly timezoneIana: string;
	private readonly pageSize: number;
	private readonly debugLogger: DebugLogger | undefined;

	// Folder names discovered from list items' `parent_folder`. v4 has no flat
	// `/filetag/` catalog; folder membership rides on each recording's
	// parent_folder, so we accumulate {folder_id -> name} as we page and serve
	// it through getFolderCatalog, letting the existing tag->folder resolution
	// in note-writer work unchanged. folder_id -> name. Keyed on the host and
	// workspace like the device list below: a re-sign-in to another workspace
	// keeps this client, and serving the old workspace's names would tag a new
	// note with the wrong folder.
	private folderNames:
		| {
				readonly baseUrl: string;
				readonly workspaceId: string;
				readonly names: Map<string, string>;
		  }
		| undefined;
	// Per-session cache of the paired-device list, same rationale as the folder
	// names: it changes rarely, so one fetch per plugin session is enough and a
	// reload clears it. undefined = not yet fetched; an empty array is a valid
	// cached "no devices" result.
	// Cached device list plus the context it belongs to. workspaceId is a dynamic
	// provider and the base URL can change, so the cache is keyed on both: a
	// catalog fetched for one account/host must not be served after a switch.
	private deviceCatalog:
		| {
				readonly baseUrl: string;
				readonly workspaceId: string;
				readonly devices: readonly PlaudDevice[];
		  }
		| undefined;

	// Single-entry, short-TTL memo of the last file-detail response, so
	// getAudioTempUrl and getTranscriptAndSummary for the same recording do not
	// each refetch the detail. Import processes one recording fully before the
	// next, so a single slot is enough; the TTL keeps a later re-import from
	// reusing stale metadata or expired pre-signed URLs.
	private lastDetail: {
		id: string;
		data: Record<string, unknown>;
		at: number;
	} | null = null;

	constructor(
		tokenProvider: PlaudTokenProvider,
		fetcher: PlaudHttpFetcher,
		options: PlaudV4ClientOptions,
	) {
		this.tokenProvider = tokenProvider;
		this.fetcher = fetcher;
		// Normalize value-or-provider options into providers read fresh on each
		// request. The base host is validated against the shared Plaud host
		// allowlist (isTrustedPlaudHost) per request in resolveBaseUrl (not here),
		// because it can be captured after construction and must be re-checked
		// before every bearer send.
		this.baseUrlProvider = toProvider(options.baseUrl);
		this.workspaceIdProvider = toProvider(options.workspaceId);
		this.scopeType = options.scopeType ?? DEFAULT_SCOPE_TYPE;
		const device = options.deviceId;
		this.deviceIdProvider =
			typeof device === 'function' ? device : () => device;
		this.appPlatform = options.appPlatform ?? DEFAULT_APP_PLATFORM;
		this.appLanguage = options.appLanguage ?? DEFAULT_APP_LANGUAGE;
		this.timezoneIana = options.timezoneIana ?? resolveLocalTimezone();
		this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
		this.debugLogger = options.debugLogger;
	}

	/**
	 * Resolve and validate the current API host. Read fresh each request so a
	 * host captured after construction takes effect immediately. Throws (before
	 * the bearer is attached) if the host is not an https plaud.ai origin.
	 */
	private resolveBaseUrl(): string {
		return trimTrailingChars(
			assertTrustedPlaudHost(this.baseUrlProvider()),
			'/',
		);
	}

	async listRecordings(
		filter?: RecordingFilter,
	): Promise<readonly Recording[]> {
		const page = await this.listRecordingsPage(filter);
		return page.recordings;
	}

	async listRecordingsPage(filter?: RecordingFilter): Promise<RecordingPage> {
		if (filter?.folderId !== undefined) {
			throw new PlaudApiError(
				'folderId filter is not supported by /file-app/v4/recordings/all',
				undefined,
				'/file-app/v4/recordings/all',
			);
		}
		// v4 pages with an opaque cursor, not an offset. Reject a non-zero
		// `skip` loudly rather than silently ignoring it (the RecordingFilter
		// contract requires this): a caller that still pages with `skip` would
		// otherwise re-receive page one forever. Callers must page with
		// `cursor` from the previous page's `nextCursor`.
		if (filter?.skip !== undefined && filter.skip !== 0) {
			throw new PlaudApiError(
				`Offset pagination (skip=${filter.skip}) is not supported by the v4 portal, page with the cursor from the previous page`,
				undefined,
				'/file-app/v4/recordings/all',
			);
		}
		// v4 sorts by `created` (recording order) or `updated` (edit order, the
		// auto-sync signal). Map the shared `sortBy` enum onto v4's names.
		const sortBy = filter?.sortBy === 'edit_time' ? 'updated' : 'created';
		const params = new URLSearchParams({
			sort_by: sortBy,
			sort_order: 'desc',
			page_size: String(filter?.limit ?? this.pageSize),
		});
		if (filter?.cursor !== undefined && filter.cursor.length > 0) {
			params.set('cursor', filter.cursor);
		}

		const endpoint = '/file-app/v4/recordings/all';
		const url = `${this.resolveBaseUrl()}${endpoint}?${params.toString()}`;
		// The scope this request is sent under. If the user switches workspace or
		// host while it is in flight, its folder names belong to the old scope and
		// must not land in the new scope's cache.
		const requestBaseUrl = this.baseUrlProvider();
		const requestWorkspaceId = this.workspaceIdProvider();
		const data = await this.fetchApiData(url, endpoint);
		const folderNames = this.folderNamesForScope(
			requestBaseUrl,
			requestWorkspaceId,
		);

		// Require a real array. A missing or reshaped `items` is an API-shape
		// regression, not an empty account, so surface it rather than silently
		// reporting zero recordings. (An empty list legitimately sends `[]`.)
		const rawItems = data['items'];
		if (!Array.isArray(rawItems)) {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} response has no items array`,
				endpoint,
			);
		}
		const items: readonly unknown[] = rawItems;
		const out: Recording[] = [];
		const rejected: Array<{ index: number; reason: string }> = [];
		items.forEach((item, index) => {
			try {
				const recording = this.parseV4ListItem(
					item,
					endpoint,
					folderNames,
				);
				if (matchesFilter(recording, filter)) {
					out.push(recording);
				}
			} catch (err) {
				if (err instanceof PlaudParseError) {
					rejected.push({ index, reason: err.message });
				} else {
					throw err;
				}
			}
		});
		if (rejected.length > 0) {
			const preview = rejected
				.slice(0, 3)
				.map((r) => `[${r.index}] ${r.reason}`)
				.join('; ');
			const suffix =
				rejected.length > 3 ? `; +${rejected.length - 3} more` : '';
			throw new PlaudParseError(
				`${rejected.length}/${items.length} recordings from ${endpoint} failed validation: ${preview}${suffix}`,
				endpoint,
			);
		}

		// A malformed (non-string) next_cursor falls through to null, ending the
		// page loop. A cursor that does not advance (the server echoes the one we
		// sent) would loop the pager forever, so reject it rather than repeat the
		// same page.
		const nextCursor = readNonEmptyString(data['next_cursor']) ?? null;
		if (
			nextCursor !== null &&
			filter?.cursor !== undefined &&
			nextCursor === filter.cursor
		) {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} returned a non-advancing cursor`,
				endpoint,
			);
		}
		return { recordings: out, nextCursor };
	}

	getFolderCatalog(): Promise<readonly PlaudFolder[]> {
		// Best-effort: v4 folders ride on each recording's parent_folder rather
		// than a flat catalog endpoint, so this returns what listing discovered.
		// If no listing has run yet it is empty, matching the interface contract
		// that a missing catalog degrades to "no folders resolved".
		// Deferred so a throw surfaces as a rejection, as it did when async.
		return Promise.resolve().then(() => {
			const catalog: PlaudFolder[] = [];
			for (const [id, name] of this.folderNamesForScope(
				this.baseUrlProvider(),
				this.workspaceIdProvider(),
			)) {
				catalog.push({ id, name });
			}
			return catalog;
		});
	}

	/**
	 * The folder-name map for a host and workspace. When that scope is the
	 * current one, this is the cache, reset if the current scope changed since
	 * it was filled. When it is not (a listing that was in flight across a
	 * switch), a throwaway map is returned so the stale names are discarded.
	 * Uses the raw host, not `resolveBaseUrl`, because this is only a cache key
	 * and `getFolderCatalog` must not throw.
	 */
	private folderNamesForScope(
		baseUrl: string,
		workspaceId: string,
	): Map<string, string> {
		if (
			baseUrl !== this.baseUrlProvider() ||
			workspaceId !== this.workspaceIdProvider()
		) {
			return new Map();
		}
		if (
			this.folderNames === undefined ||
			this.folderNames.baseUrl !== baseUrl ||
			this.folderNames.workspaceId !== workspaceId
		) {
			this.folderNames = { baseUrl, workspaceId, names: new Map() };
		}
		return this.folderNames.names;
	}

	/**
	 * The account's paired Plaud devices, for the source chip and `{{device}}`
	 * token. Cached per (account, host) so a later call in the same session is
	 * free, but an account or portal switch refetches rather than serving the
	 * previous account's devices.
	 */
	async getDeviceCatalog(): Promise<readonly PlaudDevice[]> {
		const baseUrl = this.resolveBaseUrl();
		const workspaceId = this.workspaceIdProvider();
		if (
			this.deviceCatalog !== undefined &&
			this.deviceCatalog.baseUrl === baseUrl &&
			this.deviceCatalog.workspaceId === workspaceId
		) {
			return this.deviceCatalog.devices;
		}
		// v4 serves the paired-device list at /device-app/device/list, but in the
		// v3 envelope ({status, msg, data_devices}), not the v4 {status, data}
		// shape (verified live 2026-09-18: sn/name/model/version_number, the same
		// PlaudDevice fields). So the whole body goes to the shared v3 parser.
		// Cached per (account, host) so an account or portal switch refetches; a
		// reload clears it too.
		const endpoint = '/device-app/device/list';
		const url = `${baseUrl}${endpoint}`;
		const raw = await this.fetchApi(url, endpoint, {});
		const { devices } = parseDeviceCatalog(raw, endpoint);
		this.deviceCatalog = { baseUrl, workspaceId, devices };
		return devices;
	}

	async getTranscriptAndSummary(
		id: PlaudRecordingId,
	): Promise<TranscriptAndSummary> {
		if (id.length === 0) {
			throw new PlaudApiError(
				'getTranscriptAndSummary called with empty id',
				undefined,
				'/file-app/v4/files/detail/:id',
			);
		}
		const detail = await this.fetchDetail(id);
		const objects = readArray(detail['objects']);
		// v4 keeps images out of the summary body: a summary embed points at a
		// content id (`c_<hex>`), and relation_content_mapping resolves that id to
		// a pre-signed image URL. resolveSummary rewrites those markers to real
		// image embeds so the shared attachment pipeline can download them.
		const relationContentMapping = readStringMap(
			detail['relation_content_mapping'],
		);

		const transcript = await this.resolveTranscript(id, objects);
		const { primary: summary, additional: additionalSummaries } =
			await this.resolveSummaries(id, objects, relationContentMapping);
		const chapters = await this.resolveChapters(objects);
		const marks = await this.resolveMarks(
			id,
			objects,
			relationContentMapping,
		);
		const aiKeywords = readKeywords(detail['meta']);

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'parsed',
				endpoint: '/getTranscriptAndSummary',
				message: `v4 detail for ${id}: transcript=${
					transcript
						? `${transcript.segments.length} segments`
						: 'null'
				}, summary=${
					summary ? `${summary.text.length} chars` : 'null'
				}, additionalSummaries=${additionalSummaries.length}, chapters=${chapters.length}, marks=${marks.length}, keywords=${aiKeywords.length}`,
			});
		}

		return {
			transcript,
			summary,
			aiKeywords: aiKeywords.length > 0 ? aiKeywords : undefined,
			chapters: chapters.length > 0 ? chapters : undefined,
			marks: marks.length > 0 ? marks : undefined,
			additionalSummaries:
				additionalSummaries.length > 0
					? additionalSummaries
					: undefined,
		};
	}

	async getAudioTempUrl(id: PlaudRecordingId): Promise<string | null> {
		const detail = await this.fetchDetail(id);
		const objects = readArray(detail['objects']);
		const audio = findObject(objects, OBJ_AUDIO);
		if (audio === undefined) {
			return null;
		}
		return readNonEmptyString(audio['content_url']) ?? null;
	}

	/**
	 * Rename a recording on the v4 portal so its title matches the note. Resolves
	 * the tree node for the file id, then PATCHes the rename endpoint with the
	 * node's current version for optimistic concurrency. Retries once on a version
	 * conflict; refuses a blank title. Throws PlaudApiError/PlaudParseError on
	 * failure so the caller can surface it.
	 */
	async updateTitle(id: PlaudRecordingId, filename: string): Promise<void> {
		const endpoint = '/file-app/v4/nodes/rename/:id';
		const title = filename.trim();
		if (title.length === 0) {
			throw new PlaudApiError(
				`Refusing to write an empty Plaud title for recording ${id}`,
				undefined,
				endpoint,
			);
		}
		// The rename targets the tree NODE (not the file), and the body carries
		// the node's CURRENT version as `origin_version` for optimistic
		// concurrency. Read that version fresh (never the coalescing detail cache)
		// so a stale value is not rejected as -1800313; on a genuine concurrent
		// bump, re-read once and retry.
		for (let attempt = 0; attempt < 2; attempt++) {
			const { nodeId, version } = await this.fetchNodeForRename(id);
			const url = `${this.resolveBaseUrl()}/file-app/v4/nodes/rename/${encodeURIComponent(
				nodeId,
			)}`;
			try {
				await this.fetchApi(url, endpoint, {
					method: 'PATCH',
					body: JSON.stringify({
						name: title,
						origin_version: version,
					}),
				});
				// The title changed on Plaud, so any cached detail for this
				// recording is now stale; drop it so a later read reflects it.
				if (this.lastDetail?.id === id) {
					this.lastDetail = null;
				}
				return;
			} catch (err) {
				if (
					attempt === 0 &&
					err instanceof PlaudApiError &&
					err.inBandStatus === NODE_VERSION_CONFLICT
				) {
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Read the tree node id and its current `version_ms` for a recording, fresh
	 * (bypassing the detail cache). The rename endpoint keys on the node, not the
	 * file id, and rejects a stale version, so `updateTitle` always reads this
	 * immediately before the write.
	 */
	private async fetchNodeForRename(
		id: PlaudRecordingId,
	): Promise<{ nodeId: string; version: number }> {
		const endpoint = '/file-app/v4/files/detail/:id';
		const url = `${this.resolveBaseUrl()}/file-app/v4/files/detail/${encodeURIComponent(
			id,
		)}`;
		const data = await this.fetchApiData(url, endpoint);
		const node = data['node'];
		if (!isRecord(node)) {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} response has no node to rename`,
				endpoint,
			);
		}
		const nodeId = readNonEmptyString(node['node_id']);
		const version = node['version_ms'];
		if (nodeId === undefined || typeof version !== 'number') {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} node is missing node_id or version_ms`,
				endpoint,
			);
		}
		return { nodeId, version };
	}

	// --- internals -------------------------------------------------------

	private async fetchDetail(
		id: PlaudRecordingId,
	): Promise<Record<string, unknown>> {
		if (
			this.lastDetail !== null &&
			this.lastDetail.id === id &&
			Date.now() - this.lastDetail.at < DETAIL_CACHE_TTL_MS
		) {
			return this.lastDetail.data;
		}
		const endpoint = `/file-app/v4/files/detail/${encodeURIComponent(id)}`;
		const url = `${this.resolveBaseUrl()}${endpoint}`;
		const data = await this.fetchApiData(url, endpoint);
		this.lastDetail = { id, data, at: Date.now() };
		return data;
	}

	private async resolveTranscript(
		id: PlaudRecordingId,
		objects: readonly unknown[],
	): Promise<Transcript | null> {
		// Prefer the polished (user-renamed) transcript when it has been
		// generated; fall back to the raw one.
		const polished = findObject(objects, OBJ_POLISHED_TRANSCRIPT);
		const raw = findObject(objects, OBJ_TRANSCRIPT);
		const chosen =
			polished !== undefined &&
			readNonEmptyString(polished['content_url']) !== undefined
				? polished
				: raw;
		const url =
			chosen !== undefined
				? readNonEmptyString(chosen['content_url'])
				: undefined;
		if (url === undefined) {
			return null;
		}
		const body = await this.fetchContentJson(url, `transcript for ${id}`);
		if (body === null) {
			return null;
		}
		return parseTranscriptField(id, body, `transcript for ${id}`);
	}

	/**
	 * Resolve the recording's summaries. A v4 recording can carry more than one
	 * summary object (the classic SUMMARY plus e.g. SUMMARY_BETA); the pull-all
	 * rule says every summary the user selected comes down, not just the first.
	 * The classic SUMMARY is the primary (returned in `summary`); each other
	 * summary is an AdditionalSummary with a heading derived from its object type.
	 * When there is no classic SUMMARY the first summary object becomes primary. A
	 * content fetch failure propagates (like the transcript resolver) so a
	 * transient error never silently drops a summary.
	 */
	private async resolveSummaries(
		id: PlaudRecordingId,
		objects: readonly unknown[],
		relationContentMapping: Readonly<Record<string, string>>,
	): Promise<{
		primary: Summary | null;
		additional: readonly AdditionalSummary[];
	}> {
		const summaryObjs = objects.filter(
			(o): o is Record<string, unknown> =>
				isRecord(o) &&
				isSummaryObjectType(o['object_type']) &&
				readNonEmptyString(o['content_url']) !== undefined,
		);
		// Primary-first: prefer the classic SUMMARY, else the first summary object.
		const classic = summaryObjs.find(
			(o) => o['object_type'] === OBJ_SUMMARY,
		);
		const ordered =
			classic !== undefined
				? [classic, ...summaryObjs.filter((o) => o !== classic)]
				: summaryObjs;
		const primaryObj = ordered[0];
		const primaryText =
			primaryObj !== undefined
				? await this.fetchSummaryText(
						id,
						primaryObj,
						relationContentMapping,
					)
				: null;
		const primary: Summary | null =
			primaryText !== null ? { id, text: primaryText } : null;

		const additional: AdditionalSummary[] = [];
		const usedHeadings = new Set<string>(['Summary']);
		for (const obj of ordered.slice(1)) {
			const text = await this.fetchSummaryText(
				id,
				obj,
				relationContentMapping,
			);
			if (text === null) {
				continue;
			}
			additional.push({
				heading: uniqueSummaryHeading(
					summaryHeadingFor(obj['object_type']),
					usedHeadings,
				),
				text,
			});
		}
		return { primary, additional };
	}

	/**
	 * Fetch one summary object's content_url and resolve its `c_<id>` image
	 * markers to embeds (v4 puts summary images here, not inline in the body, so
	 * the shared attachment pipeline can download and localize them). Returns null
	 * when the object has no url or the body is empty. Throws (does not swallow) on
	 * a fetch failure so a transient error never silently drops a summary.
	 */
	private async fetchSummaryText(
		id: PlaudRecordingId,
		obj: Record<string, unknown>,
		relationContentMapping: Readonly<Record<string, string>>,
	): Promise<string | null> {
		const url = readNonEmptyString(obj['content_url']);
		if (url === undefined) {
			return null;
		}
		const text = await this.fetchContentText(url, `summary for ${id}`);
		if (text.trim().length === 0) {
			return null;
		}
		return embedV4SummaryImages(text.trim(), relationContentMapping);
	}

	private async resolveChapters(
		objects: readonly unknown[],
	): Promise<ReturnType<typeof parseOutlineBody>> {
		const outline = findObject(objects, OBJ_OUTLINE);
		const url =
			outline !== undefined
				? readNonEmptyString(outline['content_url'])
				: undefined;
		if (url === undefined) {
			return [];
		}
		const body = await this.fetchContentJson(url, 'outline');
		if (body === null) {
			return [];
		}
		return parseOutlineBody(body);
	}

	/**
	 * Resolve the recording's marks (screenshots) from the MARK_MEMO object. The
	 * object's `content_url` is a JSON array of `{ timestamp, mark_type,
	 * picture_link }`; parseMarkMemoArray resolves each `picture_link` id to a
	 * pre-signed image URL via `relationContentMapping`. Returns [] when the
	 * recording has no MARK_MEMO object or no content_url. A transient
	 * content-fetch failure propagates (like the transcript/summary resolvers)
	 * rather than resolving to []: dropping the marks silently would let a
	 * re-import overwrite an existing note's screenshots with nothing.
	 */
	private async resolveMarks(
		id: PlaudRecordingId,
		objects: readonly unknown[],
		relationContentMapping: Readonly<Record<string, string>>,
	): Promise<readonly PlaudMark[]> {
		const markObj = findObject(objects, OBJ_MARK_MEMO);
		const url =
			markObj !== undefined
				? readNonEmptyString(markObj['content_url'])
				: undefined;
		if (url === undefined) {
			return [];
		}
		const body = await this.fetchContentJson(url, `marks for ${id}`);
		if (body === null) {
			return [];
		}
		return parseMarkMemoArray(body, relationContentMapping);
	}

	/**
	 * GET a v4 API endpoint (authenticated, workspace-scoped) and return the
	 * unwrapped `data` object. Mirrors plaud-client-re's fetchJson error
	 * handling: 401 -> PlaudAuthError, other non-2xx -> PlaudApiError, negative
	 * in-band `status` -> PlaudApiError (or PlaudAuthError when it reads as an
	 * auth/expiry failure).
	 */
	private async fetchApiData(
		url: string,
		endpoint: string,
		options: FetchApiOptions = {},
	): Promise<Record<string, unknown>> {
		const json = await this.fetchApi(url, endpoint, options);
		if (!isRecord(json)) {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} returned a non-object body`,
				endpoint,
			);
		}
		const data = json['data'];
		if (!isRecord(data)) {
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} response has no data object`,
				endpoint,
			);
		}
		return data;
	}

	private async fetchApi(
		url: string,
		endpoint: string,
		options: FetchApiOptions,
	): Promise<unknown> {
		const method = options.method ?? 'GET';
		// Auth is checked before scope. A user who has never signed in has neither
		// a token nor a workspace, and "sign in" is the actionable message.
		// Checking the workspace first reported "No workspace selected" as a
		// retryable network error (PlaudApiError), which reads as a Plaud outage to
		// someone who has simply not connected yet.
		const rawToken = this.tokenProvider();
		if (rawToken === null || rawToken.trim().length === 0) {
			throw new PlaudAuthError(
				'not_configured',
				'No Plaud token configured, sign in to the Plaud portal in the plugin settings',
				endpoint,
			);
		}
		// A token with no workspace means the sign-in predates workspace capture
		// (or captured none), not a network fault. Report it as not_configured so
		// it is not retried as a transient error, and name the fix.
		const workspaceId = this.workspaceIdProvider();
		if (workspaceId.trim().length === 0) {
			throw new PlaudAuthError(
				'not_configured',
				`Signed in, but no workspace was captured for ${endpoint}. Sign in to the Plaud portal again to capture your workspace.`,
				endpoint,
			);
		}
		const token = rawToken.trim().replace(/^bearer\s+/i, '');

		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: `Bearer ${token}`,
			'app-platform': this.appPlatform,
			'edit-from': this.appPlatform,
			'app-language': this.appLanguage,
			'x-scope-type': this.scopeType,
			'x-scope-id': workspaceId,
			'x-timezone-iana': this.timezoneIana,
			'x-request-id': genRequestId(),
		};
		const deviceId = this.deviceIdProvider();
		if (deviceId !== undefined && deviceId.length > 0) {
			headers['x-device-id'] = deviceId;
		}
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'request',
				endpoint,
				message: `${method} ${endpoint}`,
				// Never log the Authorization header, surface only non-auth
				// scope headers useful for diagnosing a scope mismatch.
				payload: {
					url,
					method,
					scopeId: workspaceId,
					scopeType: this.scopeType,
				},
			});
		}

		let response: PlaudHttpResponse;
		try {
			response = await this.fetcher({
				url,
				method,
				headers,
				body: options.body,
			});
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			throw new PlaudApiError(
				`Plaud v4 ${endpoint} network error: ${cause}`,
				undefined,
				endpoint,
			);
		}

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'response',
				endpoint,
				message: `${response.status} from ${endpoint}`,
				payload: {
					status: response.status,
					textSnippet:
						response.json === null || response.json === undefined
							? (response.text ?? '').slice(0, 500)
							: undefined,
				},
			});
		}

		if (response.status === 401) {
			throw new PlaudAuthError(
				'token_rejected',
				`Plaud token rejected by ${endpoint} (401), token is expired or revoked`,
				endpoint,
			);
		}
		if (response.status === 429) {
			throw new PlaudApiError(
				`Plaud rate-limited ${endpoint} (429), retry in a minute`,
				429,
				endpoint,
			);
		}
		if (response.status < 200 || response.status >= 300) {
			const snippet = (response.text ?? '')
				.slice(0, 200)
				.replace(/\s+/g, ' ');
			throw new PlaudApiError(
				`Plaud v4 ${endpoint} returned HTTP ${response.status}: ${snippet}`,
				response.status,
				endpoint,
			);
		}
		if (response.json === null || response.json === undefined) {
			if (
				options.allowEmptyBody === true &&
				(response.text ?? '').trim().length === 0
			) {
				return null;
			}
			const snippet = (response.text ?? '')
				.slice(0, 200)
				.replace(/\s+/g, ' ');
			throw new PlaudParseError(
				`Plaud v4 ${endpoint} returned 2xx with no JSON body (got: "${snippet}")`,
				endpoint,
			);
		}

		this.throwOnInBandError(response.json, endpoint);
		return response.json;
	}

	/**
	 * v4 reports failures in-band as an HTTP 200 with a negative top-level
	 * `status` and a `msg`. Route auth/expiry-shaped failures to PlaudAuthError
	 * so the UI prompts a reconnect; everything else is a PlaudApiError
	 * carrying the numeric in-band status.
	 */
	private throwOnInBandError(json: unknown, endpoint: string): void {
		if (!isRecord(json)) {
			return;
		}
		const status = json['status'];
		if (typeof status !== 'number' || status >= 0) {
			return;
		}
		const msg =
			readNonEmptyString(json['msg']) ?? `in-band status ${status}`;
		if (/expired|token|auth|unauthor/i.test(msg)) {
			throw new PlaudAuthError(
				'token_rejected',
				`Plaud v4 ${endpoint} rejected the session: ${msg} (status ${status})`,
				endpoint,
			);
		}
		throw new PlaudApiError(
			`Plaud v4 ${endpoint} error: ${msg} (status ${status})`,
			undefined,
			endpoint,
			status,
		);
	}

	/**
	 * Fetch a pre-signed content_url as text (no auth header, the URL carries
	 * its own signature). A failure here is NOT "content absent": callers only
	 * reach this with a content_url the detail actually advertised, so a network
	 * error, an expired 403, or a 5xx must propagate as an error rather than
	 * resolve to empty. Silently returning empty would let a transient failure
	 * overwrite an existing note's transcript/summary/chapters on re-import.
	 * A 2xx with an empty body is a genuine empty and is returned as `''`.
	 */
	private async fetchContentText(
		url: string,
		label: string,
	): Promise<string> {
		let response: PlaudHttpResponse;
		try {
			response = await this.fetcher({
				url,
				method: 'GET',
				headers: { Accept: 'text/plain, application/json, */*' },
			});
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			throw new PlaudApiError(
				`Plaud v4 content fetch for ${label} failed: ${cause}`,
				undefined,
				label,
			);
		}
		if (response.status < 200 || response.status >= 300) {
			const snippet = (response.text ?? '')
				.slice(0, 200)
				.replace(/\s+/g, ' ');
			throw new PlaudApiError(
				`Plaud v4 content fetch for ${label} returned HTTP ${response.status}: ${snippet}`,
				response.status,
				label,
			);
		}
		return response.text ?? '';
	}

	/** Fetch a pre-signed content_url and JSON-parse it. */
	private async fetchContentJson(
		url: string,
		label: string,
	): Promise<unknown> {
		const text = await this.fetchContentText(url, label);
		if (text.trim().length === 0) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch (err) {
			throw new PlaudParseError(
				`Plaud v4 content for ${label} is not valid JSON: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private parseV4ListItem(
		raw: unknown,
		endpoint: string,
		folderNames: Map<string, string>,
	): Recording {
		if (!isRecord(raw)) {
			throw new PlaudParseError(
				'recording item is not an object',
				endpoint,
			);
		}
		const fileId = readNonEmptyString(raw['file_id']);
		if (fileId === undefined) {
			throw new PlaudParseError(
				'recording item has no file_id',
				endpoint,
			);
		}
		const title = readNonEmptyString(raw['name']);
		if (title === undefined) {
			throw new PlaudParseError(
				`recording ${fileId} has empty name`,
				endpoint,
			);
		}
		const createdMs = readFiniteNumber(raw['created_at_show_ms']);
		if (
			createdMs === undefined ||
			createdMs < MIN_PLAUSIBLE_UNIX_MS ||
			createdMs > MAX_PLAUSIBLE_UNIX_MS
		) {
			throw new PlaudParseError(
				`recording ${fileId} has invalid created_at_show_ms (${String(
					raw['created_at_show_ms'],
				)})`,
				endpoint,
			);
		}
		const durationMs = readFiniteNumber(raw['duration_ms']) ?? 0;
		if (durationMs < 0 || durationMs > MAX_PLAUSIBLE_DURATION_MS) {
			throw new PlaudParseError(
				`recording ${fileId} has invalid duration_ms (${durationMs})`,
				endpoint,
			);
		}

		// Accumulate the folder name so getFolderCatalog can resolve it, and
		// surface folder membership through `tags` (the id) so note-writer's
		// existing tag->folder path resolves the name unchanged.
		let tags: readonly string[] | undefined;
		let systemFolderType: number | undefined;
		const parentFolder = raw['parent_folder'];
		if (isRecord(parentFolder)) {
			const folderId = readNonEmptyString(parentFolder['folder_id']);
			const folderName = readNonEmptyString(parentFolder['name']);
			// Plaud's folder classification: 0 = real user folder, nonzero = a
			// built-in system bucket (1 Recordings/unfiled, 2 Import, 5 Conflict).
			// Import routes a nonzero value to `plaud-location` instead of a folder
			// tag so the default bucket does not become a `#recordings` tag.
			systemFolderType = readFiniteNumber(
				parentFolder['system_folder_type'],
			);
			if (folderId !== undefined) {
				if (folderName !== undefined) {
					folderNames.set(folderId, folderName);
				}
				tags = [folderId];
			}
		}

		const versionMs = readFiniteNumber(raw['version_ms']);

		return {
			id: fileId as PlaudRecordingId,
			title,
			createdAt: new Date(createdMs),
			endsAt: new Date(createdMs + durationMs),
			// v4 list items omit the capture time-zone (the detail's meta carries
			// an IANA zone name, not an offset). Note-writer falls back to the
			// configured or device zone. Known fidelity gap vs the prod list.
			captureOffsetMinutes: null,
			durationSeconds: durationMs / 1000,
			// Advisory hints only, and note-writer treats transcriptAvailable as
			// a hard promise: it refuses to write when transcriptAvailable is
			// true but the transcript comes back null. The v4 list does not
			// carry per-recording transcript/summary presence (the
			// file_task_status enum is not yet mapped), so we must NOT
			// over-advertise. Leave both false; getTranscriptAndSummary is the
			// authoritative source and writes whatever content actually exists.
			transcriptAvailable: false,
			summaryAvailable: false,
			// ...but "both false" here means UNKNOWN, not "no content". Without
			// this flag the import runner reads both-false as "nothing to fetch"
			// and skips every recording (skipped-no-content) before ever calling
			// getTranscriptAndSummary. Tell it to fetch and let the detail decide.
			contentAvailabilityUnknown: true,
			// /recordings/all returns the active list; trash has its own view.
			isTrashed: false,
			tags,
			systemFolderType,
			versionMs,
			waitPull: false,
		};
	}
}

// --- module-local helpers ----------------------------------------------

function resolveLocalTimezone(): string {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * Validate that a base URL is an https Plaud origin before the client attaches
 * the bearer token to it. Accepts `plaud.ai` / `*.plaud.ai` and `theplaud.com` /
 * `*.theplaud.com` (the alpha portal's regional staging hosts, e.g.
 * `api-apne1.staging.theplaud.com`). Throws PlaudApiError on a
 * non-https scheme or a host outside that allowlist. Returns the URL unchanged
 * on success so it can be used inline.
 */
function assertTrustedPlaudHost(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new PlaudApiError(
			`Invalid Plaud API base URL: ${baseUrl}`,
			undefined,
			baseUrl,
		);
	}
	if (parsed.protocol !== 'https:' || !isTrustedPlaudHost(parsed.hostname)) {
		throw new PlaudApiError(
			`Refusing to use untrusted Plaud API host "${baseUrl}", must be https and a plaud.ai or theplaud.com domain`,
			undefined,
			baseUrl,
		);
	}
	// Reject a URL that carries userinfo (a username or password before the
	// host): the hostname is trusted, but the credentials would ride along on
	// every authed request. Mirrors isTrustedPlaudUrl in plaud-hosts.ts.
	if (parsed.username !== '' || parsed.password !== '') {
		throw new PlaudApiError(
			`Refusing a Plaud API URL with embedded credentials: "${baseUrl}"`,
			undefined,
			baseUrl,
		);
	}
	return baseUrl;
}

/**
 * Normalize a value-or-provider into a provider function that is read fresh on
 * each request, so a value captured after the client is constructed (first
 * sign-in) takes effect without reconstruction.
 */
function toProvider(valueOrProvider: string | (() => string)): () => string {
	return typeof valueOrProvider === 'function'
		? valueOrProvider
		: () => valueOrProvider;
}

function genRequestId(): string {
	// Just a per-request correlation id for the `x-request-id` header; the
	// server issues its own trace ids. A UUID is unnecessary, so this avoids
	// the `crypto` global (and the no-global-this lint) and works unchanged in
	// both the Electron renderer and the node test environment.
	const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16);
	return `${Date.now().toString(16)}-${rand()}-${rand()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0
		? value.trim()
		: undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function readKeywords(meta: unknown): readonly string[] {
	if (!isRecord(meta)) {
		return [];
	}
	const raw = meta['keywords'];
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: string[] = [];
	for (const k of raw) {
		const s = readNonEmptyString(k);
		if (s !== undefined) {
			out.push(s);
		}
	}
	return out;
}

/**
 * Read a JSON object of string values (like `relation_content_mapping`) into a
 * plain `Record<string, string>`, dropping any non-string or empty entry.
 */
function readStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const key of Object.keys(value)) {
		const v = value[key];
		if (typeof v === 'string' && v.length > 0) {
			out[key] = v;
		}
	}
	return out;
}

/**
 * Replace every Markdown link or image `[alt](target)` / `![alt](target)` in
 * `text` with `replace(whole, alt, target)`. A linear scan that matches exactly
 * what `/!?\[([^\]]*)\]\(([^)\s]+)\)/g` matched: the alt text runs to the first
 * `]` (it may contain `[`), and the target is a non-empty run with no `)` or
 * whitespace, closed by `)`. The regex form backtracks super-linearly.
 */
function replaceMarkdownLinks(
	text: string,
	replace: (whole: string, alt: string, target: string) => string,
): string {
	let out = '';
	let copied = 0;
	let pos = 0;
	while (pos < text.length) {
		const bang = text.charAt(pos) === '!' && text.charAt(pos + 1) === '[';
		const open = bang ? pos + 1 : pos;
		if (text.charAt(open) !== '[') {
			pos++;
			continue;
		}
		const close = text.indexOf(']', open + 1);
		if (close < 0) {
			break;
		}
		let targetEnd = close + 2;
		if (text.charAt(close + 1) === '(') {
			while (
				targetEnd < text.length &&
				text.charAt(targetEnd) !== ')' &&
				text.charAt(targetEnd).trim() !== ''
			) {
				targetEnd++;
			}
		}
		if (
			text.charAt(close + 1) !== '(' ||
			targetEnd === close + 2 ||
			text.charAt(targetEnd) !== ')'
		) {
			// Every `[` before `close` shares this `]` and fails the same way.
			pos = close + 1;
			continue;
		}
		const end = targetEnd + 1;
		out += text.slice(copied, pos);
		out += replace(
			text.slice(pos, end),
			text.slice(open + 1, close),
			text.slice(close + 2, targetEnd),
		);
		copied = end;
		pos = end;
	}
	return out + text.slice(copied);
}

/**
 * Rewrite v4 summary image markers to real image embeds.
 *
 * The v4 summary body does not carry image bytes or even a real image URL. It
 * embeds an image as a markdown link/embed whose target carries a content id
 * (`c_<32 hex>`), and the file-detail response's `relation_content_mapping`
 * resolves that id to a pre-signed image URL. This turns each such marker into a
 * plain `![alt](<signed-url>)` embed, so the SAME attachment pipeline the prod
 * plugin uses (extractAttachmentAssetsFromSummaryMarkdown -> download -> repoint
 * to a local `![[...]]`) picks it up with no v4-specific code downstream. A
 * marker whose id is absent from the map is left untouched. Exported for tests.
 */
export function embedV4SummaryImages(
	summary: string,
	relationContentMapping: Readonly<Record<string, string>>,
): string {
	if (Object.keys(relationContentMapping).length === 0) {
		return summary;
	}
	return replaceMarkdownLinks(
		summary,
		(whole: string, alt: string, target: string): string => {
			const idMatch = /c_[0-9a-f]{32}/i.exec(target);
			if (idMatch === null) {
				return whole;
			}
			const resolved = relationContentMapping[idMatch[0]];
			if (typeof resolved !== 'string' || resolved.length === 0) {
				return whole;
			}
			// Force the image form: the id resolves to an image, and the source
			// marker is sometimes a plain link with empty text.
			return `![${alt}](${resolved})`;
		},
	);
}

/**
 * Parse the MARK_MEMO content array (the JSON body fetched from the MARK_MEMO
 * object's `content_url`) into `PlaudMark`s. Each raw entry is
 * `{ timestamp, mark_type, picture_link }` (verified live, read-only,
 * 2026-09-18): `picture_link` is a `c_<hex>` content id that
 * `relationContentMapping` resolves to a pre-signed image URL, and `timestamp`
 * is the mark's offset into the recording in milliseconds. An entry whose
 * `picture_link` is missing or does not resolve is dropped (there is nothing to
 * download). `timestamp` is converted to seconds and, when missing or out of a
 * plausible range, clamped to 0 rather than dropping the screenshot (the image
 * is the point; its label is secondary). Marks are returned sorted by offset.
 * Exported for tests.
 */
export function parseMarkMemoArray(
	body: unknown,
	relationContentMapping: Readonly<Record<string, string>>,
): readonly PlaudMark[] {
	if (!Array.isArray(body)) {
		return [];
	}
	const out: PlaudMark[] = [];
	for (const entry of body) {
		if (!isRecord(entry)) {
			continue;
		}
		const pictureLink = readNonEmptyString(entry['picture_link']);
		if (pictureLink === undefined) {
			continue;
		}
		const url = relationContentMapping[pictureLink];
		if (typeof url !== 'string' || url.length === 0) {
			continue;
		}
		const rawTimestamp = readFiniteNumber(entry['timestamp']);
		const offsetMs =
			rawTimestamp !== undefined &&
			rawTimestamp >= 0 &&
			rawTimestamp <= MAX_PLAUSIBLE_DURATION_MS
				? rawTimestamp
				: 0;
		const markTypeRaw = entry['mark_type'];
		out.push({
			offsetSeconds: offsetMs / 1000,
			url,
			markType:
				typeof markTypeRaw === 'number' && Number.isFinite(markTypeRaw)
					? markTypeRaw
					: undefined,
		});
	}
	out.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
	return out;
}

/**
 * True when a v4 detail object is a summary: the classic `SUMMARY` or any
 * `SUMMARY_*` variant (e.g. `SUMMARY_BETA`). Used to gather every summary the
 * user selected, not just the first (the pull-all-artifacts rule).
 */
function isSummaryObjectType(objectType: unknown): boolean {
	return (
		objectType === OBJ_SUMMARY ||
		(typeof objectType === 'string' && objectType.startsWith('SUMMARY_'))
	);
}

/**
 * Section heading for a summary object's type. The classic `SUMMARY` renders as
 * "Summary"; a variant renders as "Summary (<suffix>)" (e.g. `SUMMARY_BETA` ->
 * "Summary (beta)"). Exported for tests.
 */
export function summaryHeadingFor(objectType: unknown): string {
	if (typeof objectType !== 'string' || objectType === OBJ_SUMMARY) {
		return 'Summary';
	}
	const suffix = objectType.startsWith('SUMMARY_')
		? objectType.slice('SUMMARY_'.length)
		: objectType;
	const pretty = suffix.toLowerCase().replace(/_/g, ' ').trim();
	return pretty.length > 0 ? `Summary (${pretty})` : 'Summary';
}

/**
 * Disambiguate a repeated summary heading with a numeric suffix ("Summary (beta)",
 * "Summary (beta) 2", ...) so two summaries never share a heading. Records the
 * chosen heading in `used`.
 */
function uniqueSummaryHeading(base: string, used: Set<string>): string {
	let heading = base;
	let n = 2;
	while (used.has(heading)) {
		heading = `${base} ${n}`;
		n += 1;
	}
	used.add(heading);
	return heading;
}

/**
 * Find the first object in a v4 detail `objects[]` array whose `object_type`
 * matches. Returns the raw record (still un-validated) or undefined.
 */
function findObject(
	objects: readonly unknown[],
	objectType: string,
): Record<string, unknown> | undefined {
	for (const obj of objects) {
		if (isRecord(obj) && obj['object_type'] === objectType) {
			return obj;
		}
	}
	return undefined;
}

/**
 * Apply the client-side filter dimensions the v4 list endpoint does not do
 * server-side. Mirrors the prod client's `matchesFilter` for the shared
 * fields (folderId is rejected earlier).
 */
function matchesFilter(
	recording: Recording,
	filter?: RecordingFilter,
): boolean {
	if (!filter) {
		return true;
	}
	if (
		filter.hasTranscript !== undefined &&
		// On v4 the list does not report per-recording transcript presence, so
		// transcriptAvailable is left false and contentAvailabilityUnknown is
		// set. Filtering by an unreliable flag would drop every v4 recording
		// even though the detail fetch is authoritative, so skip the check then.
		recording.contentAvailabilityUnknown !== true &&
		recording.transcriptAvailable !== filter.hasTranscript
	) {
		return false;
	}
	if (filter.since && recording.createdAt < filter.since) {
		return false;
	}
	if (filter.until && recording.createdAt > filter.until) {
		return false;
	}
	return true;
}
