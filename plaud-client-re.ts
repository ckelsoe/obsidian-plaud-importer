// Reverse-engineered Plaud client. Talks to the undocumented api.plaud.ai
// web endpoints used by rsteckler/applaud and JamesStuder/Plaud_API.
//
// This module must stay free of any `obsidian` import so it can be unit-tested
// with a stub fetcher. The Obsidian adapter (requestUrl → PlaudHttpFetcher)
// lives in main.ts.
//
// See dev-docs/00-viability-findings.md §6 for the bridge strategy this
// implements and §4.2 for the source research on the endpoint shapes.

import type {
	AttachmentAsset,
	Chapter,
	PlaudClient,
	PlaudRecordingId,
	Recording,
	RecordingFilter,
	Summary,
	Transcript,
	TranscriptAndSummary,
	TranscriptSegment,
} from './plaud-client';
import type { DebugLogger } from './debug-logger';

/**
 * Abstract HTTP call shape the client depends on. main.ts adapts Obsidian's
 * `requestUrl` to this; tests pass a stub. Keeping this small (url + headers
 * in, status + json out) means the adapter is three lines and the test
 * doubles don't have to simulate a full Response.
 */
export type PlaudHttpFetcher = (req: PlaudHttpRequest) => Promise<PlaudHttpResponse>;

/**
 * Function that returns the currently-configured Plaud token, or null if the
 * user has not set one. The client calls this on every API request so that
 * settings changes take effect immediately — no stale-token problem, no
 * "reinstantiate on save" dance in the plugin. Returning null (or an empty /
 * whitespace string) produces a PlaudAuthError with a "not configured"
 * message, which the UI can route to the settings tab.
 */
export type PlaudTokenProvider = () => string | null;

export interface PlaudHttpRequest {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface PlaudHttpResponse {
	readonly status: number;
	readonly json: unknown;
	readonly text: string;
}

export class PlaudApiError extends Error {
	readonly status: number | undefined;
	readonly endpoint: string | undefined;

	constructor(message: string, status?: number, endpoint?: string) {
		super(message);
		this.name = 'PlaudApiError';
		this.status = status;
		this.endpoint = endpoint;
	}
}

/**
 * Reason for an auth failure, used by consumers to route users to the right
 * remediation. `not_configured` means the plugin has no token at all and the
 * user needs to set one; `token_rejected` means Plaud returned 401 on a call
 * that did include a token. Keeping this as a machine-readable enum rather
 * than relying on message-substring matching keeps the UI robust against
 * message rewording.
 */
export type PlaudAuthReason = 'not_configured' | 'token_rejected';

export class PlaudAuthError extends PlaudApiError {
	readonly reason: PlaudAuthReason;

	constructor(reason: PlaudAuthReason, message: string, endpoint?: string) {
		super(message, 401, endpoint);
		this.name = 'PlaudAuthError';
		this.reason = reason;
	}
}

export class PlaudParseError extends PlaudApiError {
	constructor(message: string, endpoint?: string) {
		super(message, undefined, endpoint);
		this.name = 'PlaudParseError';
	}
}

const DEFAULT_BASE_URL = 'https://api.plaud.ai';
const USER_AGENT = 'obsidian-plaud-importer/0.1.0';
const DEFAULT_LIMIT = 50;

export interface PlaudClientOptions {
	readonly baseUrl?: string;
	/**
	 * Optional debug logger. When provided, every HTTP request emits a
	 * `request` event before the call and a `response` event after the
	 * status/body are read. Authorization headers are NEVER included in
	 * the logged payload — the client strips them before handing the
	 * event to the logger. When omitted, debug logging is a no-op with
	 * zero hot-path cost.
	 */
	readonly debugLogger?: DebugLogger;
}

export class ReverseEngineeredPlaudClient implements PlaudClient {
	private readonly tokenProvider: PlaudTokenProvider;
	private readonly fetcher: PlaudHttpFetcher;
	private readonly baseUrl: string;
	private readonly debugLogger: DebugLogger | undefined;

	constructor(
		tokenProvider: PlaudTokenProvider,
		fetcher: PlaudHttpFetcher,
		options: PlaudClientOptions = {},
	) {
		this.tokenProvider = tokenProvider;
		this.fetcher = fetcher;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.debugLogger = options.debugLogger;
	}

	async listRecordings(filter?: RecordingFilter): Promise<readonly Recording[]> {
		// Reject unsupported filter dimensions loudly rather than silently
		// dropping them. /file/simple/web does not return folder metadata,
		// so folderId cannot be applied at this layer.
		if (filter?.folderId !== undefined) {
			throw new PlaudApiError(
				'folderId filter is not supported by /file/simple/web in v0.1',
				undefined,
				'/file/simple/web',
			);
		}

		const params = new URLSearchParams({
			skip: String(filter?.skip ?? 0),
			limit: String(filter?.limit ?? DEFAULT_LIMIT),
			is_trash: '2',
			sort_by: 'start_time',
			is_desc: 'true',
		});

		const endpoint = '/file/simple/web';
		const url = `${this.baseUrl}${endpoint}?${params.toString()}`;
		const raw = await this.fetchJson(url, endpoint);
		const list = parseListResponse(raw, endpoint);

		// Parse each record individually. Aggregate parse failures and throw
		// one PlaudParseError at the end that names the count and the first
		// few failing indexes — never silently drop data.
		const out: Recording[] = [];
		const rejected: Array<{ index: number; reason: string }> = [];
		list.forEach((item, index) => {
			try {
				const recording = parseRecording(item, endpoint);
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
			const suffix = rejected.length > 3 ? `; +${rejected.length - 3} more` : '';
			throw new PlaudParseError(
				`${rejected.length}/${list.length} recordings from ${endpoint} failed validation: ${preview}${suffix}`,
				endpoint,
			);
		}

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'parsed',
				endpoint,
				message: `parsed ${out.length} recordings (raw=${list.length})`,
				payload: out.map((r) => ({
					id: r.id,
					title: r.title,
					createdAt: r.createdAt.toISOString(),
					durationSeconds: r.durationSeconds,
					transcriptAvailable: r.transcriptAvailable,
					summaryAvailable: r.summaryAvailable,
					tags: r.tags,
				})),
			});
		}

		return out;
	}

	async getTranscriptAndSummary(id: PlaudRecordingId): Promise<TranscriptAndSummary> {
		if (id.length === 0) {
			throw new PlaudApiError(
				'getTranscriptAndSummary called with empty id',
				undefined,
				'/ai/transsumm/:id',
			);
		}

		// Two-step strategy after the 2026-04-14 reverse-engineering pass:
		//
		//   1. Call the legacy /ai/transsumm/{id} endpoint to get the raw
		//      transcript and the legacy AI summary. The raw transcript
		//      carries Plaud's diarization labels ("Speaker 1", "Speaker
		//      2") with only the account owner's voice auto-mapped. The
		//      legacy summary is a STATIC snapshot taken at generation
		//      time — even after a user renames speakers in the web app,
		//      it still says "Speaker 2".
		//
		//   2. Call /file/detail/{id} and extract three fields in one
		//      pass (see fetchFileDetailBundle):
		//        a. transaction_polish transcript — user-renamed + smoothed
		//        b. newer auto_sum_note summary — regenerated with real
		//           participant names, fixes the "Speaker 2 in Summary"
		//           issue noted in DD-003's resolution
		//        c. aiContentHeader.keywords — Plaud's auto-tag guess,
		//           surfaced into frontmatter via mergeTagSources
		//
		// The bundle lookup is best-effort: any failure at /file/detail/
		// or in the polish S3 fetch falls back silently to the legacy
		// transcript and legacy summary. A recording may not have these
		// fields generated yet, and older recordings may never have had
		// them. See dev-docs/deferred-decisions.md DD-003 and DD-004.

		const legacy = await this.fetchLegacyTranssumm(id);

		let bundle: FileDetailBundle = {
			polishedTranscript: null,
			newerSummary: null,
			aiKeywords: [],
			chapters: [],
			attachments: [],
			nestedAssetLinks: {},
			detailDataTypes: [],
			attachmentDataTypes: [],
		};
		let bundleError: unknown = null;
		try {
			bundle = await this.fetchFileDetailBundle(id);
		} catch (err) {
			bundleError = err;
		}

		const finalTranscript = bundle.polishedTranscript ?? legacy.transcript;
		const finalSummary = bundle.newerSummary ?? legacy.summary;

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'parsed',
				endpoint: '/getTranscriptAndSummary',
				message: `resolved transcript+summary for ${id}: transcript=${
					bundle.polishedTranscript !== null
						? `polished (${bundle.polishedTranscript.segments.length} segments)`
						: legacy.transcript !== null
							? `raw fallback (${legacy.transcript.segments.length} segments)${bundleError ? ` — file-detail lookup failed: ${bundleError instanceof Error ? bundleError.message : String(bundleError)}` : ' — no polish available'}`
							: 'null (no transcript available from either source)'
				}, summary=${
					bundle.newerSummary !== null
						? `newer (${bundle.newerSummary.text.length} chars)`
						: legacy.summary !== null
							? `legacy fallback (${legacy.summary.text.length} chars)`
							: 'null (no summary available from either source)'
				}, aiKeywords=${bundle.aiKeywords.length}`,
				payload: {
					transcriptSource:
						bundle.polishedTranscript !== null ? 'transaction_polish' : 'ai/transsumm',
					summarySource:
						bundle.newerSummary !== null ? 'auto_sum_note' : 'ai/transsumm',
					bundleErrorMessage:
						bundleError instanceof Error
							? bundleError.message
							: bundleError !== null
								? String(bundleError)
								: null,
					segmentCount: finalTranscript?.segments.length ?? 0,
					summaryLength: finalSummary?.text.length ?? 0,
					aiKeywordCount: bundle.aiKeywords.length,
					aiKeywordSample: bundle.aiKeywords.slice(0, 5),
					chapterCount: bundle.chapters.length,
					attachmentCount: bundle.attachments.length,
					attachmentDataTypes: bundle.attachmentDataTypes,
					detailDataTypes: bundle.detailDataTypes,
				},
			});
		}

		return {
			transcript: finalTranscript,
			summary: finalSummary,
			nestedAssetLinks:
				Object.keys(bundle.nestedAssetLinks).length > 0
					? bundle.nestedAssetLinks
					: legacy.nestedAssetLinks,
			aiKeywords: bundle.aiKeywords.length > 0 ? bundle.aiKeywords : undefined,
			chapters: bundle.chapters.length > 0 ? bundle.chapters : undefined,
			attachments:
				bundle.attachments.length > 0 ? bundle.attachments : undefined,
		};
	}

	/**
	 * Fetch the raw transcript + summary bundle via the legacy POST
	 * /ai/transsumm/{id} endpoint. This is the original path the plugin
	 * has always used. It returns the RAW transcript — speaker renames
	 * applied in Plaud's web app are NOT visible through this endpoint.
	 * Callers who want the polished transcript should layer
	 * fetchPolishedTranscript on top.
	 */
	private async fetchLegacyTranssumm(
		id: PlaudRecordingId,
	): Promise<TranscriptAndSummary> {
		const endpoint = `/ai/transsumm/${encodeURIComponent(id)}`;
		const url = `${this.baseUrl}${endpoint}`;
		// /ai/transsumm/{id} is POST despite carrying no payload — the empty
		// JSON object body is required. Confirmed against rsteckler/applaud
		// (server/src/plaud/transcript.ts) which is the canonical RE client.
		const raw = await this.fetchJson(url, endpoint, { method: 'POST', body: '{}' });
		return parseTranssummResponse(id, raw, endpoint);
	}

	/**
	 * Single-trip fetch of `/file/detail/{id}` that pulls every field we
	 * care about out of one response:
	 *   - polished transcript (follows the transaction_polish S3 link)
	 *   - newer AI-generated summary (embedded under
	 *     `pre_download_content_list[auto_sum_note].data_content`)
	 *   - AI keyword tags (under `extra_data.aiContentHeader.keywords`)
	 *   - chapters outline (follows the outline S3 link)
	 *
	 * The fields are independent: a recording may have any subset. Newer
	 * recordings typically have all of them; older ones may only have
	 * the polish (or nothing at all). Callers treat each field as
	 * best-effort and fall back to the legacy `/ai/transsumm/` response
	 * for transcript and summary when the bundle lacks them.
	 *
	 * Throws on any network / structural-parse error so the caller can
	 * decide whether to fall back or surface. The two-hop polish and
	 * outline fetches run back-to-back with the detail fetch so the
	 * 5-minute pre-signed S3 URLs don't expire in between.
	 */
	private async fetchFileDetailBundle(
		id: PlaudRecordingId,
	): Promise<FileDetailBundle> {
		const detailEndpoint = `/file/detail/${encodeURIComponent(id)}`;
		const detailUrl = `${this.baseUrl}${detailEndpoint}`;
		const rawDetail = await this.fetchJson(detailUrl, detailEndpoint);

		const polishLink = findTransactionPolishLink(rawDetail, detailEndpoint);
		const outlineLink = findOutlineLink(rawDetail, detailEndpoint);
		const newerSummaryMarkdown = findNewerSummaryMarkdown(rawDetail, detailEndpoint);
		const aiKeywords = findAiKeywords(rawDetail, detailEndpoint);
		const attachments = findAttachmentAssets(rawDetail, detailEndpoint);
		const nestedAssetLinks = findNestedAssetLinks(rawDetail, detailEndpoint);
		const detailDataTypes = collectDetailDataTypes(rawDetail);
		const attachmentDataTypes = [
			...new Set(attachments.map((asset) => asset.dataType)),
		];

		const newerSummary: Summary | null =
			newerSummaryMarkdown !== null ? { id, text: newerSummaryMarkdown } : null;

		let polishedTranscript: Transcript | null = null;
		if (polishLink !== null) {
			// Fetch the pre-signed S3 URL without the Bearer token — it already
			// carries its own X-Amz-Signature. Synthetic endpoint label for
			// logging / errors so the origin of the call is obvious in debug
			// output without leaking the full URL (which contains an AWS
			// session token query param).
			const polishEndpoint = `/s3/file_transaction_polish/${encodeURIComponent(id)}`;
			const rawPolish = await this.fetchJson(polishLink, polishEndpoint, {
				skipAuth: true,
			});
			// The polish file is a bare JSON array of segments (no envelope).
			// parseTranscriptField handles that shape directly — pass the raw
			// value as the segments list.
			polishedTranscript = parseTranscriptField(id, rawPolish, polishEndpoint);
		}

		let chapters: readonly Chapter[] = [];
		if (outlineLink !== null) {
			const outlineEndpoint = `/s3/file_outline/${encodeURIComponent(id)}`;
			// Same authless fetch pattern as the polish: the S3 URL carries
			// its own signature and must not receive the Bearer token. Any
			// failure at this step is swallowed upstream in
			// getTranscriptAndSummary (best-effort outline), so we don't
			// wrap it here.
			const rawOutline = await this.fetchJson(outlineLink, outlineEndpoint, {
				skipAuth: true,
			});
			chapters = parseOutlineBody(rawOutline);
			if (chapters.length === 0 && this.debugLogger?.enabled === true) {
				// Shape discovery aid: the wire shape of the outline body is
				// not yet fully captured, so when the parser returns empty
				// we log the raw body (truncated to 2 KB) to make iteration
				// cheap. Once Charles confirms the real shape, tighten
				// parseOutlineBody and remove this diagnostic.
				const sample =
					typeof rawOutline === 'string'
						? rawOutline.slice(0, 2048)
						: JSON.stringify(rawOutline).slice(0, 2048);
				this.debugLogger.log({
					kind: 'parsed',
					endpoint: outlineEndpoint,
					message: `outline body present but parseOutlineBody returned 0 chapters — shape may be new`,
					payload: { rawSample: sample },
				});
			}
		}

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'parsed',
				endpoint: detailEndpoint,
				message: `file/detail inventory for ${id}: dataTypes=${detailDataTypes.length}, attachments=${attachments.length}`,
				payload: {
					detailDataTypes,
					attachmentDataTypes,
					attachments: attachments.map((asset) => ({
						dataType: asset.dataType,
						name: asset.name,
						mimeType: asset.mimeType,
						url: asset.url,
					})),
				},
			});
		}

		return {
			polishedTranscript,
			newerSummary,
			aiKeywords,
			chapters,
			attachments,
			nestedAssetLinks,
			detailDataTypes,
			attachmentDataTypes,
		};
	}

	private async fetchJson(
		url: string,
		endpoint: string,
		options: { method?: 'GET' | 'POST'; body?: string; skipAuth?: boolean } = {},
	): Promise<unknown> {
		const method = options.method ?? 'GET';

		const headers: Record<string, string> = {
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
		};

		// `skipAuth` is for fetching pre-signed S3 URLs (e.g., the polished
		// transcript hosted in the Plaud content storage bucket). Those URLs
		// carry their own `X-Amz-Signature`, and adding a Bearer token would
		// be ignored at best and rejected at worst. When skipAuth is true,
		// we do NOT read the token provider at all — this also means an
		// authless call never triggers the "no token configured" error.
		if (options.skipAuth !== true) {
			// Read the token fresh on every call so that settings changes take
			// effect immediately. If the user hasn't configured one, surface a
			// PlaudAuthError the UI can route to the settings tab.
			const rawToken = this.tokenProvider();
			if (rawToken === null || rawToken.trim().length === 0) {
				throw new PlaudAuthError(
					'not_configured',
					'No Plaud token configured — open Settings → Community Plugins → Plaud Importer to set one',
					endpoint,
				);
			}
			const token = rawToken.trim();
			headers.Authorization = `Bearer ${token}`;
		}

		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		// Debug instrumentation: emit a `request` event before the call and
		// a `response` event after. The payload NEVER includes the
		// Authorization header — we build a scrubbed-headers view here
		// rather than relying on every call site to remember to redact.
		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'request',
				endpoint,
				message: `${method} ${endpoint}`,
				payload: {
					url,
					method,
					body: options.body,
					// Intentionally NOT logging `headers` — Authorization
					// lives there. If future diagnostics need non-auth
					// headers, build a scrubbed subset here rather than
					// passing the full object.
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
			// Fetcher itself rejected (DNS, offline, TLS, etc). Wrap so the
			// caller's error-routing treats it like any other Plaud failure.
			const cause = err instanceof Error ? err.message : String(err);
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'error',
					endpoint,
					message: `${method} ${endpoint} fetcher rejected: ${cause}`,
				});
			}
			throw new PlaudApiError(
				`Plaud API ${endpoint} network error: ${cause}`,
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
					json: response.json,
					// Only include a short text snippet when JSON parsing
					// failed (json === null), since the full text body
					// duplicates json on success and wastes buffer space.
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
				`Plaud token rejected by ${endpoint} (401) — token is expired or revoked`,
				endpoint,
			);
		}
		if (response.status === 429) {
			throw new PlaudApiError(
				`Plaud rate-limited ${endpoint} (429) — retry in a minute`,
				429,
				endpoint,
			);
		}
		if (response.status === 204) {
			// Semantically an empty list. Let the parser handle it uniformly.
			return { data_file_list: [], data_file_total: 0 };
		}
		if (response.status < 200 || response.status >= 300) {
			const bodySnippet = (response.text ?? '').slice(0, 200).replace(/\s+/g, ' ');
			throw new PlaudApiError(
				`Plaud API ${endpoint} returned HTTP ${response.status}: ${bodySnippet}`,
				response.status,
				endpoint,
			);
		}
		if (response.json === null || response.json === undefined) {
			const bodySnippet = (response.text ?? '').slice(0, 200).replace(/\s+/g, ' ');
			throw new PlaudParseError(
				`Plaud API ${endpoint} returned 2xx with no JSON body (got: "${bodySnippet}")`,
				endpoint,
			);
		}
		return response.json;
	}
}

// -----------------------------------------------------------------------------
// Internal parser. Validates shape at the trust boundary, mints branded IDs,
// and refuses to return a partially-valid object. Any invalid input throws a
// PlaudParseError with enough context to debug without leaking values.
// -----------------------------------------------------------------------------

interface RawRecording {
	readonly id: string;
	readonly filename: string;
	readonly start_time: number;
	readonly duration: number;
	readonly is_trans: boolean;
	readonly is_summary: boolean;
	readonly filetag_id_list?: readonly string[];
}

function parseListResponse(raw: unknown, endpoint: string): readonly RawRecording[] {
	if (!isRecord(raw)) {
		throw new PlaudParseError('Response body is not an object', endpoint);
	}
	const list = raw.data_file_list;
	if (!Array.isArray(list)) {
		throw new PlaudParseError('Response is missing data_file_list array', endpoint);
	}
	return list.map((item, index) => {
		if (!isRawRecording(item)) {
			throw new PlaudParseError(
				`data_file_list[${index}] is missing required fields`,
				endpoint,
			);
		}
		return item;
	});
}

// Plausibility bounds for a Plaud recording's start_time, which is a unix
// MILLISECONDS timestamp. Reject anything beyond 2100 or before 2000 — the
// former catches unit-confusion where something even larger than ms is
// sent, the latter catches a regression to unix seconds which would map to
// ~1970 when interpreted as ms.
const MIN_PLAUSIBLE_UNIX_MS = 946684800000; // 2000-01-01 UTC
const MAX_PLAUSIBLE_UNIX_MS = 4102444800000; // 2100-01-01 UTC

// Upper bound on a plausible transcript-segment timestamp in milliseconds.
// A single recording longer than 24h is unheard of; a segment offset
// greater than 24h almost certainly means the producer sent a unix
// timestamp instead of a segment offset — reject as a unit-confusion canary.
const MAX_PLAUSIBLE_SEGMENT_MS = 24 * 60 * 60 * 1000; // 24h

// Upper bound on a plausible recording duration in milliseconds. Plaud
// Note Pro's hardware battery life caps real-world recordings around
// 40-44h, so 48h gives comfortable headroom while still catching a
// regression to unit confusion (e.g., if the producer ever sent unix ms
// timestamps in the duration field by mistake).
const MAX_PLAUSIBLE_DURATION_MS = 48 * 60 * 60 * 1000;

function parseRecording(raw: RawRecording, endpoint: string): Recording {
	if (raw.id.length === 0) {
		throw new PlaudParseError('Recording has empty id', endpoint);
	}
	if (raw.filename.length === 0) {
		throw new PlaudParseError(`Recording ${raw.id} has empty filename`, endpoint);
	}
	if (raw.duration < 0 || !Number.isFinite(raw.duration)) {
		throw new PlaudParseError(
			`Recording ${raw.id} has invalid duration (${raw.duration})`,
			endpoint,
		);
	}
	// Plaud serializes `duration` as MILLISECONDS on /file/simple/web —
	// same convention as `start_time` / `end_time` / segment timestamps.
	// Confirmed from real-API capture on 2026-04-14: a 21-minute recording
	// reported `duration: 1303000` (1303000 ms = 1303 s = 21m 43s). The
	// initial reverse-engineering assumed seconds and let this field flow
	// through unchanged, which produced `361h 57m` display values in the
	// NoteWriter output. Reject any value larger than MAX_PLAUSIBLE_DURATION_MS
	// loudly as a unit-confusion canary — a future regression sending unix
	// ms instead of a delta would otherwise silently produce "millennia-
	// long" durations in notes.
	if (raw.duration > MAX_PLAUSIBLE_DURATION_MS) {
		throw new PlaudParseError(
			`Recording ${raw.id} has duration ${raw.duration}ms which is beyond 48h — probably a unix timestamp instead of a duration delta`,
			endpoint,
		);
	}
	if (raw.start_time <= 0 || !Number.isFinite(raw.start_time)) {
		throw new PlaudParseError(
			`Recording ${raw.id} has invalid start_time (${raw.start_time})`,
			endpoint,
		);
	}
	// Plaud serializes start_time as unix MILLISECONDS on /file/simple/web.
	// Earlier reverse-engineering notes (rsteckler/applaud pre-2026) said
	// "seconds" and that was what the initial commit 2 of this client
	// assumed — commit 4c corrected to ms after real-API testing showed
	// values like 1776085791000 (2026-04-15 in ms) on every recording.
	if (raw.start_time < MIN_PLAUSIBLE_UNIX_MS) {
		throw new PlaudParseError(
			`Recording ${raw.id} has start_time ${raw.start_time} which is before year 2000 — likely seconds instead of milliseconds`,
			endpoint,
		);
	}
	if (raw.start_time > MAX_PLAUSIBLE_UNIX_MS) {
		throw new PlaudParseError(
			`Recording ${raw.id} has start_time ${raw.start_time} which is beyond year 2100 — probably not a unix timestamp at all`,
			endpoint,
		);
	}

	return {
		id: raw.id as PlaudRecordingId,
		title: raw.filename,
		createdAt: new Date(raw.start_time),
		// Convert ms → seconds at the trust boundary so every downstream
		// consumer (NoteWriter, ImportModal display, Dataview queries)
		// sees seconds. Matches the segment-timestamp treatment at
		// parseTranscriptSegment which divides by 1000 for the same reason.
		durationSeconds: raw.duration / 1000,
		transcriptAvailable: raw.is_trans,
		summaryAvailable: raw.is_summary,
		tags: raw.filetag_id_list,
	};
}

function matchesFilter(recording: Recording, filter?: RecordingFilter): boolean {
	if (!filter) {
		return true;
	}
	if (
		filter.hasTranscript !== undefined &&
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
	// folderId is handled at the top of listRecordings — it throws rather than
	// silently ignoring, so by the time we reach this filter it is guaranteed
	// to be undefined.
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawRecording(value: unknown): value is RawRecording {
	if (!isRecord(value)) {
		return false;
	}
	if (typeof value.id !== 'string') return false;
	if (typeof value.filename !== 'string') return false;
	if (typeof value.start_time !== 'number') return false;
	if (typeof value.duration !== 'number') return false;
	if (typeof value.is_trans !== 'boolean') return false;
	if (typeof value.is_summary !== 'boolean') return false;
	if (
		value.filetag_id_list !== undefined &&
		!(Array.isArray(value.filetag_id_list) &&
			value.filetag_id_list.every((t) => typeof t === 'string'))
	) {
		return false;
	}
	return true;
}

// -----------------------------------------------------------------------------
// /ai/transsumm/{id} parser. The response is flat (no envelope wrapper).
// Both transcript and summary are independently nullable — a recording can
// have one without the other depending on Plaud's processing status.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// /file/detail/{id} parser. Extracts the `transaction_polish` pre-signed S3
// URL when present. Pure, exported for unit tests.
// -----------------------------------------------------------------------------

/**
 * Walk a raw `/file/detail/{id}` response and return the pre-signed S3 URL
 * of the polished transcript, or null when the recording has no polish
 * available.
 *
 * The response shape (reverse-engineered 2026-04-14):
 *
 *   {
 *     status: 0, msg: 'success', request_id: '',
 *     data: {
 *       file_id, file_name, duration, ...
 *       content_list: [
 *         { data_type: 'transaction',        task_status: 1, data_link: 's3://...' },
 *         { data_type: 'outline',            task_status: 1, data_link: 's3://...' },
 *         { data_type: 'transaction_polish', task_status: 1, data_link: 's3://...' },
 *         { data_type: 'auto_sum_note',      task_status: 1, data_link: 's3://...' },
 *       ],
 *       extra_data: { has_replaced_speaker: bool, ... },
 *     }
 *   }
 *
 * Returns null — not an error — when:
 *  - The response is well-formed but has no `transaction_polish` entry
 *  - The `transaction_polish` entry exists but `task_status !== 1`
 *    (in-progress or failed)
 *  - The entry has no `data_link`
 *
 * Throws `PlaudParseError` on a structurally-invalid response (missing
 * `data` object, non-array `content_list`, etc.) so the caller can route
 * it through the normal parse-error path.
 */
/**
 * Shape returned by `fetchFileDetailBundle` — the four extracts we pull
 * from a single `/file/detail/{id}` round trip (plus follow-up S3 fetches
 * for polish and outline). Keeping them bundled lets the caller make one
 * fetch and consume all the fields at once instead of walking the
 * response multiple times with independent helpers.
 */
export interface FileDetailBundle {
	readonly polishedTranscript: Transcript | null;
	readonly newerSummary: Summary | null;
	readonly aiKeywords: readonly string[];
	readonly chapters: readonly Chapter[];
	readonly attachments: readonly AttachmentAsset[];
	readonly nestedAssetLinks: Readonly<Record<string, string>>;
	readonly detailDataTypes: readonly string[];
	readonly attachmentDataTypes: readonly string[];
}

/**
 * Walk a raw `/file/detail/{id}` response and return the markdown text of
 * Plaud's NEWER summary, or null when this recording has no newer summary.
 *
 * The newer summary lives at
 * `data.pre_download_content_list[data_type='auto_sum_note'].data_content`
 * — embedded directly in the response body (no S3 follow-up). It differs
 * from the legacy `/ai/transsumm/{id}` summary in two important ways:
 *  1. Participant names are resolved from Plaud's speaker-rename map, so
 *     a note reads "Participants: Charles Kelsoe, Vijay Muniswamy" instead
 *     of "Speaker 2, Speaker 3".
 *  2. Plaud regenerates it when the user edits speakers in the web app,
 *     unlike the legacy summary which is a static snapshot.
 *
 * Returns null — not an error — when:
 *  - The response has no `pre_download_content_list` field (older recordings)
 *  - The list is present but contains no `auto_sum_note` entry
 *  - The `auto_sum_note` entry has no `data_content` string
 *
 * Throws `PlaudParseError` on structurally-invalid responses (missing
 * `data`, non-array `pre_download_content_list`) so the caller can surface
 * the bad shape via the normal parse-error path.
 *
 * See `dev-docs/deferred-decisions.md` DD-004 for the field inventory.
 */
export function findNewerSummaryMarkdown(
	raw: unknown,
	endpoint: string,
): string | null {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}
	const list = data.pre_download_content_list;
	if (list === undefined || list === null) {
		return null;
	}
	if (!Array.isArray(list)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} has 'pre_download_content_list' that is not an array`,
			endpoint,
		);
	}
	for (const item of list) {
		if (!isRecord(item)) {
			continue;
		}
		if (item.data_type !== 'auto_sum_note') {
			continue;
		}
		const content = item.data_content;
		if (typeof content === 'string' && content.trim().length > 0) {
			return content.trim();
		}
		return null;
	}
	return null;
}

/**
 * Walk a raw `/file/detail/{id}` response and return the AI-generated
 * keyword list, or an empty array when absent.
 *
 * The keywords live at `data.extra_data.aiContentHeader.keywords` — an
 * array of short strings like `["AI Agent", "Customer Data", "AWS"]`.
 * They are Plaud's topical tag guess for the recording, suitable for
 * merging into the note's `tags:` frontmatter via `mergeTagSources` in
 * note-writer.ts.
 *
 * Returns `[]` — not an error — when any of the optional intermediate
 * fields are missing (`extra_data`, `aiContentHeader`, `keywords`). This
 * matches the reality that older recordings and newer failed-generation
 * recordings legitimately lack this data, and the caller should treat
 * "no AI tags" as a normal case.
 *
 * Non-string items inside the keywords array are silently dropped so a
 * mid-field format drift (e.g., Plaud starting to emit `{label, score}`
 * objects) degrades to fewer tags rather than a hard error.
 *
 * Throws `PlaudParseError` only on structurally-invalid top-level
 * responses (missing `data`, non-object response body).
 */
export function findAiKeywords(
	raw: unknown,
	endpoint: string,
): readonly string[] {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}
	const extraData = data.extra_data;
	if (!isRecord(extraData)) {
		return [];
	}
	const header = extraData.aiContentHeader;
	if (!isRecord(header)) {
		return [];
	}
	const keywords = header.keywords;
	if (!Array.isArray(keywords)) {
		return [];
	}
	const out: string[] = [];
	for (const kw of keywords) {
		if (typeof kw === 'string' && kw.trim().length > 0) {
			out.push(kw.trim());
		}
	}
	return out;
}

/**
 * Walk a `/file/detail/{id}` response and return the pre-signed S3 URL of
 * the outline content entry, or null when the recording has no outline
 * available.
 *
 * Same selection rules as `findTransactionPolishLink`: scan `content_list`
 * for the entry whose `data_type === 'outline'`, require `task_status === 1`,
 * return the `data_link` string. Null on any absent-but-valid case; throws
 * only on structurally corrupt responses.
 */
export function findOutlineLink(
	raw: unknown,
	endpoint: string,
): string | null {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}
	const contentList = data.content_list;
	if (contentList === undefined || contentList === null) {
		return null;
	}
	if (!Array.isArray(contentList)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} has 'content_list' that is not an array`,
			endpoint,
		);
	}
	for (const item of contentList) {
		if (!isRecord(item)) {
			continue;
		}
		if (item.data_type !== 'outline') {
			continue;
		}
		if (item.task_status !== 1) {
			return null;
		}
		const link = item.data_link;
		if (typeof link !== 'string' || link.length === 0) {
			return null;
		}
		return link;
	}
	return null;
}

/**
 * Discover downloadable supplemental assets from `/file/detail/{id}`.
 *
 * We scan both `content_list` and `pre_download_content_list` for entries
 * with a `data_link` URL, skip known transcript/summary pipeline types, and
 * surface everything else as an attachment candidate.
 */
export function findAttachmentAssets(
	raw: unknown,
	endpoint: string,
): readonly AttachmentAsset[] {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}

	const out: AttachmentAsset[] = [];
	const seenUrls = new Set<string>();
	const excludedTypes = new Set([
		'transaction',
		'transaction_polish',
		'outline',
		'auto_sum_note',
	]);

	const collectFrom = (list: unknown): void => {
		if (!Array.isArray(list)) {
			return;
		}
		for (const item of list) {
			if (!isRecord(item)) {
				continue;
			}
			const dataType = pickNonEmptyString(item.data_type);
			if (dataType === undefined || excludedTypes.has(dataType)) {
				continue;
			}
			if (item.task_status !== undefined && item.task_status !== 1) {
				continue;
			}
			const urls = [
				...collectAttachmentUrls(item.data_link),
				...collectAttachmentUrls(item.data_content),
			];
			for (const url of urls) {
				if (seenUrls.has(url)) {
					continue;
				}
				seenUrls.add(url);
				out.push({
					dataType,
					url,
					name: pickNonEmptyString(
						item.file_name,
						item.filename,
						item.data_name,
						item.name,
						item.title,
					),
					mimeType: pickNonEmptyString(
						item.mime_type,
						item.content_type,
						item.file_type,
					),
				});
			}
		}
	};

	collectFrom(data.content_list);
	collectFrom(data.pre_download_content_list);
	collectFromMappedLinks(data.download_link_map);
	collectFromMappedLinks(data.download_path_mapping);
	return out;

	function collectFromMappedLinks(map: unknown): void {
		if (!isRecord(map)) {
			return;
		}
		for (const [pathKey, rawUrl] of Object.entries(map)) {
			if (typeof rawUrl !== 'string') {
				continue;
			}
			const url = rawUrl.trim();
			if (!looksLikeAttachmentUrl(url) || seenUrls.has(url)) {
				continue;
			}
			seenUrls.add(url);
			out.push({
				dataType: inferAttachmentDataTypeFromPath(pathKey),
				url,
				name: basenameLike(pathKey),
				mimeType: undefined,
			});
		}
	}
}

function collectAttachmentUrls(value: unknown): readonly string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (candidate: string): void => {
		const trimmed = candidate.trim();
		if (trimmed.length === 0 || !looksLikeAttachmentUrl(trimmed)) {
			return;
		}
		if (seen.has(trimmed)) {
			return;
		}
		seen.add(trimmed);
		out.push(trimmed);
	};
	const walk = (cursor: unknown): void => {
		if (cursor === null || cursor === undefined) {
			return;
		}
		if (typeof cursor === 'string') {
			const trimmed = cursor.trim();
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				try {
					walk(JSON.parse(trimmed));
					return;
				} catch {
					// If it's not valid JSON, still treat as a potential URL/path.
				}
			}
			add(trimmed);
			return;
		}
		if (Array.isArray(cursor)) {
			for (const item of cursor) {
				walk(item);
			}
			return;
		}
		if (!isRecord(cursor)) {
			return;
		}
		for (const [key, nested] of Object.entries(cursor)) {
			if (
				key === 'data_link' ||
				key === 'download_link' ||
				key === 'picture_link' ||
				key === 'url' ||
				key === 'href' ||
				key === 'path' ||
				key === 'file_path'
			) {
				if (typeof nested === 'string') {
					add(nested);
					continue;
				}
			}
			walk(nested);
		}
	};
	walk(value);
	return out;
}

function looksLikeAttachmentUrl(value: string): boolean {
	const lower = value.toLowerCase();
	if (lower.startsWith('http://') || lower.startsWith('https://')) {
		return true;
	}
	if (value.startsWith('/')) {
		return true;
	}
	if (lower.startsWith('permanent/') || lower.includes('/permanent/')) {
		return true;
	}
	if (
		/\.(png|jpe?g|gif|webp|bmp|svg|json|html|pdf|txt)(\?|$)/i.test(value)
	) {
		return true;
	}
	if (lower.includes('mindmap') || lower.includes('card')) {
		return true;
	}
	return false;
}

function inferAttachmentDataTypeFromPath(path: string): string {
	const lower = path.toLowerCase();
	if (
		lower.includes('mindmap') ||
		lower.includes('mind-map') ||
		lower.includes('mind_map')
	) {
		return 'mindmap';
	}
	if (lower.includes('card')) {
		return 'card';
	}
	return 'mapped_asset';
}

function basenameLike(path: string): string | undefined {
	const normalized = path.trim().replace(/\\/g, '/');
	if (normalized.length === 0) {
		return undefined;
	}
	const slash = normalized.lastIndexOf('/');
	const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	const clean = base.trim();
	return clean.length > 0 ? clean : undefined;
}

/**
 * Extract Plaud nested-asset signed URLs from `/file/detail/{id}`.
 *
 * We currently observe two maps in the wild:
 * - `download_link_map`
 * - `download_path_mapping`
 *
 * Both map relative asset paths (for example `permanent/.../mark/foo.png`)
 * to pre-signed S3 URLs.
 */
export function findNestedAssetLinks(
	raw: unknown,
	endpoint: string,
): Readonly<Record<string, string>> {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}

	const out: Record<string, string> = {};
	const mergeMap = (candidate: unknown): void => {
		if (!isRecord(candidate)) {
			return;
		}
		for (const [rawKey, rawValue] of Object.entries(candidate)) {
			if (typeof rawValue !== 'string') {
				continue;
			}
			const key = rawKey.trim().replace(/^\/+/, '');
			const value = rawValue.trim();
			if (key.length === 0 || value.length === 0) {
				continue;
			}
			out[key] = value;
		}
	};

	mergeMap(data.download_link_map);
	mergeMap(data.download_path_mapping);
	return out;
}

function collectDetailDataTypes(raw: unknown): readonly string[] {
	if (!isRecord(raw)) {
		return [];
	}
	const data = raw.data;
	if (!isRecord(data)) {
		return [];
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const collectFrom = (list: unknown): void => {
		if (!Array.isArray(list)) {
			return;
		}
		for (const item of list) {
			if (!isRecord(item)) {
				continue;
			}
			const dataType = pickNonEmptyString(item.data_type);
			if (dataType === undefined || seen.has(dataType)) {
				continue;
			}
			seen.add(dataType);
			out.push(dataType);
		}
	};
	collectFrom(data.content_list);
	collectFrom(data.pre_download_content_list);
	return out;
}

/**
 * Parse the body of Plaud's outline S3 file into an ordered Chapter list.
 *
 * The wire shape is not yet fully characterized (no capture on hand as of
 * 2026-04-14), so this parser is deliberately defensive: it handles every
 * plausible shape listed below and returns an empty array when none match.
 * When a non-empty body fails to parse, the caller logs the raw body
 * (truncated) through the debug logger so Charles can inspect during the
 * first real import and we can tighten the parser in a follow-up.
 *
 * Supported shapes (in precedence order):
 *
 *  1. Bare array of objects with a title-like field and a start-time
 *     field in milliseconds. Accepted keys:
 *     - title: `title` | `heading` | `name` | `topic`
 *     - start: `start_time` | `startTime` | `start` | `start_ms` | `begin`
 *     - end:   `end_time`   | `endTime`   | `end`   | `end_ms`   | `finish`
 *
 *  2. Envelope `{ content: string }` where the string is JSON that
 *     re-parses to shape 1. Mirrors `data_result_summ`.
 *
 *  3. Envelope `{ content: { topics: [...] } }` or `{ content: { outline: [...] } }`
 *     or `{ topics: [...] }` or `{ outline: [...] }`.
 *
 *  4. JSON-encoded string that parses to any of the above.
 *
 * Timestamps in the source are assumed to be milliseconds (matching every
 * other Plaud time field), divided by 1000 for the returned `startSeconds`
 * / `endSeconds`. Titles are trimmed; entries with an empty title or a
 * non-finite start are dropped.
 */
export function parseOutlineBody(raw: unknown): readonly Chapter[] {
	const candidates = collectOutlineCandidates(raw);
	const out: Chapter[] = [];
	for (const item of candidates) {
		if (!isRecord(item)) {
			continue;
		}
		const title = pickNonEmptyString(
			item.title,
			item.heading,
			item.name,
			item.topic,
		);
		if (title === undefined) {
			continue;
		}
		const startMs = pickFiniteNumber(
			item.start_time,
			item.startTime,
			item.start,
			item.start_ms,
			item.begin,
		);
		if (startMs === undefined) {
			continue;
		}
		const endMs = pickFiniteNumber(
			item.end_time,
			item.endTime,
			item.end,
			item.end_ms,
			item.finish,
		);
		const chapter: Chapter =
			endMs !== undefined
				? { title, startSeconds: startMs / 1000, endSeconds: endMs / 1000 }
				: { title, startSeconds: startMs / 1000 };
		out.push(chapter);
	}
	return out;
}

/**
 * Unwrap Plaud's many possible envelopes around the outline data and
 * return the array of candidate chapter objects (still raw, still
 * un-validated). Returns an empty array when no recognizable shape is
 * found at any level of nesting.
 */
function collectOutlineCandidates(raw: unknown): readonly unknown[] {
	let cursor: unknown = raw;

	// JSON-encoded string → parse first.
	if (typeof cursor === 'string') {
		const trimmed = cursor.trim();
		if (trimmed.length === 0) {
			return [];
		}
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				cursor = JSON.parse(trimmed);
			} catch {
				return [];
			}
		} else {
			return [];
		}
	}

	// Bare array → candidates directly.
	if (Array.isArray(cursor)) {
		return cursor;
	}

	// Envelope walk: unwrap { content: ... } → { topics: ... } / { outline: ... }
	// until we hit an array or run out of known keys.
	const keyChain = ['content', 'data', 'result', 'topics', 'outline', 'chapters'] as const;
	const visited = new Set<unknown>();
	while (isRecord(cursor) && !visited.has(cursor)) {
		visited.add(cursor);
		let advanced = false;
		for (const key of keyChain) {
			const next = cursor[key];
			if (next === undefined || next === null) {
				continue;
			}
			if (Array.isArray(next)) {
				return next;
			}
			if (typeof next === 'string') {
				// Recurse into the parsed string.
				return collectOutlineCandidates(next);
			}
			if (isRecord(next)) {
				cursor = next;
				advanced = true;
				break;
			}
		}
		if (!advanced) {
			break;
		}
	}
	return [];
}

function pickFiniteNumber(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === 'number' && Number.isFinite(v)) {
			return v;
		}
		if (typeof v === 'string') {
			const n = Number(v);
			if (Number.isFinite(n)) {
				return n;
			}
		}
	}
	return undefined;
}

export function findTransactionPolishLink(
	raw: unknown,
	endpoint: string,
): string | null {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is missing the 'data' object`,
			endpoint,
		);
	}
	const contentList = data.content_list;
	if (contentList === undefined || contentList === null) {
		// content_list absent — recording has no content pipeline entries
		// yet (e.g., a just-uploaded file). Not an error — just no polish.
		return null;
	}
	if (!Array.isArray(contentList)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} has 'content_list' that is not an array`,
			endpoint,
		);
	}
	for (const item of contentList) {
		if (!isRecord(item)) {
			continue;
		}
		if (item.data_type !== 'transaction_polish') {
			continue;
		}
		// task_status === 1 means the polish pipeline completed successfully.
		// Any other value (0 = pending, higher = failure states) means the
		// polish isn't ready yet — treat like "absent" so the caller falls
		// back to the raw transcript.
		if (item.task_status !== 1) {
			return null;
		}
		const link = item.data_link;
		if (typeof link !== 'string' || link.length === 0) {
			return null;
		}
		return link;
	}
	return null;
}

function parseTranssummResponse(
	id: PlaudRecordingId,
	raw: unknown,
	endpoint: string,
): TranscriptAndSummary {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}

	// Plaud surfaces in-band failures via a non-empty err_code field.
	// Historical note: commit 4b tried to also require `status === 0` as
	// a success sentinel, but real-API testing on 2026-04-14 showed Plaud
	// returning `status: 1, err_code: "", msg: "success"` on legitimate
	// success responses — the status field is apparently not a 0=success
	// signal at all. err_code is the only reliable failure discriminator,
	// so trust it alone and let the parsers handle null data_result /
	// data_result_summ as the "no data yet" signal downstream.
	const errCode = raw.err_code;
	const hasErrCode =
		(typeof errCode === 'string' && errCode.length > 0) ||
		(typeof errCode === 'number' && errCode !== 0);
	if (hasErrCode) {
		const errMsg =
			typeof raw.err_msg === 'string' && raw.err_msg.length > 0
				? raw.err_msg
				: typeof raw.msg === 'string'
					? raw.msg
					: '(no message)';
		throw new PlaudApiError(
			`Plaud returned in-band error from ${endpoint}: err_code=${JSON.stringify(
				errCode,
			)} msg=${errMsg}`,
			undefined,
			endpoint,
		);
	}

	const transcript = parseTranscriptField(id, raw.data_result, endpoint);
	const summary = parseSummaryField(id, raw.data_result_summ, endpoint);
	return { transcript, summary };
}

function parseTranscriptField(
	id: PlaudRecordingId,
	rawSegments: unknown,
	endpoint: string,
): Transcript | null {
	// Distinguish the three wire signals:
	//   null/undefined   → "not yet processed" — return null so the caller
	//                      can retry or tell the user to wait.
	//   empty array []   → "processed but produced zero segments" (silent
	//                      audio, for example) — return an empty-but-
	//                      present transcript so NoteWriter doesn't trip
	//                      the advertised-but-null guard.
	//   non-empty array  → parse normally.
	if (rawSegments === null || rawSegments === undefined) {
		return null;
	}
	if (!Array.isArray(rawSegments)) {
		throw new PlaudParseError(
			`data_result for ${id} is not an array`,
			endpoint,
		);
	}
	if (rawSegments.length === 0) {
		return { id, segments: [], rawText: '' };
	}

	const segments: TranscriptSegment[] = [];
	const textParts: string[] = [];
	for (let i = 0; i < rawSegments.length; i++) {
		const segment = parseTranscriptSegment(rawSegments[i], i, id, endpoint);
		segments.push(segment);
		textParts.push(segment.text);
	}

	return {
		id,
		segments,
		rawText: textParts.join(' '),
	};
}

function parseTranscriptSegment(
	raw: unknown,
	index: number,
	id: PlaudRecordingId,
	endpoint: string,
): TranscriptSegment {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} is not an object`,
			endpoint,
		);
	}
	if (
		typeof raw.start_time !== 'number' ||
		typeof raw.end_time !== 'number' ||
		typeof raw.content !== 'string'
	) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} is missing required fields (start_time/end_time/content)`,
			endpoint,
		);
	}
	if (!Number.isFinite(raw.start_time) || raw.start_time < 0) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} has invalid start_time`,
			endpoint,
		);
	}
	if (!Number.isFinite(raw.end_time) || raw.end_time < 0) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} has invalid end_time`,
			endpoint,
		);
	}
	if (raw.end_time < raw.start_time) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} has end_time (${raw.end_time}) before start_time (${raw.start_time})`,
			endpoint,
		);
	}
	if (raw.start_time > MAX_PLAUSIBLE_SEGMENT_MS || raw.end_time > MAX_PLAUSIBLE_SEGMENT_MS) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} has timestamps beyond 24h (start=${raw.start_time}ms end=${raw.end_time}ms) — producer may have sent seconds instead of milliseconds`,
			endpoint,
		);
	}

	// Plaud transmits transcript timestamps in milliseconds for transcript
	// segments (same as the list endpoint's recording start_time — both
	// fixed in commit 4c after real-API testing).
	const startSeconds = raw.start_time / 1000;
	const endSeconds = raw.end_time / 1000;

	// Prefer the user-editable `speaker` field over `original_speaker`.
	// Real-API testing on 2026-04-14 showed that `original_speaker` holds
	// the raw diarization label ("Speaker 1", "Speaker 2") while `speaker`
	// holds the label the user assigned in Plaud's UI (e.g., "Charles",
	// "Mary"). An earlier commit flipped this the other way based on an
	// incorrect agent recommendation that "original_speaker is the stable
	// wire identifier" — the real semantics are the opposite.
	const speaker = pickNonEmptyString(raw.speaker, raw.original_speaker);

	const segment: TranscriptSegment = speaker !== undefined
		? { startSeconds, endSeconds, speaker, text: raw.content }
		: { startSeconds, endSeconds, text: raw.content };
	return segment;
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === 'string' && v.trim().length > 0) {
			return v.trim();
		}
	}
	return undefined;
}

/**
 * Normalize Plaud's `data_result_summ` to a markdown string, mirroring
 * applaud's `extractSummaryMarkdown` helper. The field has four documented
 * shapes:
 *   1. JSON-encoded string that parses to {content: {markdown: string}}
 *   2. Structured object {content: {markdown: string}}
 *   3. Structured object {content: string}
 *   4. Raw string that is NOT JSON — treat as markdown verbatim
 *
 * Any other shape is a silent-failure trap: Plaud may have changed the
 * wire format and we'd swap null summaries into user vaults without
 * anyone noticing. Throw PlaudParseError on unknown shapes so the error
 * surfaces loudly per viability doc §10.
 */
function parseSummaryField(
	id: PlaudRecordingId,
	rawSumm: unknown,
	endpoint: string,
): Summary | null {
	if (rawSumm === null || rawSumm === undefined) {
		return null;
	}

	let obj: unknown = rawSumm;
	if (typeof rawSumm === 'string') {
		const trimmed = rawSumm.trim();
		if (trimmed.length === 0) {
			return null;
		}
		// Only attempt JSON.parse if the string LOOKS structured. A raw
		// markdown body that happens to start with a non-JSON character
		// (shape 4) gets returned directly; a string that looks like JSON
		// but fails to parse is a real error and must surface.
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				obj = JSON.parse(trimmed);
			} catch (err) {
				throw new PlaudParseError(
					`data_result_summ for ${id} looks like JSON but failed to parse: ${
						err instanceof Error ? err.message : String(err)
					}`,
					endpoint,
				);
			}
		} else {
			return { id, text: trimmed };
		}
	}

	if (!isRecord(obj)) {
		throw new PlaudParseError(
			`data_result_summ for ${id} has unrecognized shape (${
				Array.isArray(obj) ? 'array' : typeof obj
			}) — expected a JSON object with content.markdown or content string`,
			endpoint,
		);
	}
	const content = obj.content;
	if (typeof content === 'string') {
		const text = content.trim();
		return text.length > 0 ? { id, text } : null;
	}
	if (isRecord(content)) {
		const md = content.markdown;
		if (typeof md === 'string') {
			const text = md.trim();
			return text.length > 0 ? { id, text } : null;
		}
		throw new PlaudParseError(
			`data_result_summ.content for ${id} has keys [${Object.keys(content).join(', ')}] but no markdown string — Plaud format may have changed`,
			endpoint,
		);
	}
	throw new PlaudParseError(
		`data_result_summ for ${id} has content field of unexpected type (${typeof content}) — expected string or object with markdown`,
		endpoint,
	);
}
