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
	ConsumerNote,
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
	/**
	 * Plaud's own negative `status` code when this error came from an in-band
	 * error envelope (HTTP 200 body with a negative `status` + `msg`), for
	 * example `-12` "start trans task error". Undefined for HTTP-status errors,
	 * network failures, and parse errors. Lets the UI distinguish a genuine
	 * Plaud-side rejection (the plugin read the response correctly) from a
	 * transport or parsing failure, and recognize specific codes like `-12`.
	 */
	readonly inBandStatus: number | undefined;

	constructor(
		message: string,
		status?: number,
		endpoint?: string,
		inBandStatus?: number,
	) {
		super(message);
		this.name = 'PlaudApiError';
		this.status = status;
		this.endpoint = endpoint;
		this.inBandStatus = inBandStatus;
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
	/**
	 * Called when the client auto-detects a regional API host (Plaud routes
	 * EU and other accounts to hosts like `api-euc1.plaud.ai`). The plugin
	 * persists the value so future sessions skip the redirect round-trip.
	 * See `detectRegionRedirect` for the wire format.
	 */
	readonly onBaseUrlChanged?: (newBaseUrl: string) => void;
}

export class ReverseEngineeredPlaudClient implements PlaudClient {
	private readonly tokenProvider: PlaudTokenProvider;
	private readonly fetcher: PlaudHttpFetcher;
	// Mutable: a region-mismatch response rewrites this in place so every
	// later request goes straight to the regional host.
	private baseUrl: string;
	private readonly debugLogger: DebugLogger | undefined;
	private readonly onBaseUrlChanged: ((newBaseUrl: string) => void) | undefined;

	constructor(
		tokenProvider: PlaudTokenProvider,
		fetcher: PlaudHttpFetcher,
		options: PlaudClientOptions = {},
	) {
		this.tokenProvider = tokenProvider;
		this.fetcher = fetcher;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.debugLogger = options.debugLogger;
		this.onBaseUrlChanged = options.onBaseUrlChanged;
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
		//           surfaced into frontmatter via buildNoteTags
		//
		// The bundle lookup is best-effort: any failure at /file/detail/
		// or in the polish S3 fetch falls back silently to the legacy
		// transcript and legacy summary. A recording may not have these
		// fields generated yet, and older recordings may never have had
		// them. See dev-docs/deferred-decisions.md DD-003 and DD-004.

		// The legacy /ai/transsumm/{id} POST appears to START a transcription
		// task server-side. On older recordings Plaud returns the in-band
		// status=-12 "start trans task error" instead of cached data, which
		// used to throw and abort the whole recording. Make it best-effort,
		// exactly like the bundle below: /file/detail/{id} is a plain read of
		// already-stored data and usually still carries the polished transcript
		// and newer summary for those recordings. We only fail when BOTH
		// sources come back empty. See dev-docs/deferred-decisions.md DD-003.
		let legacy: TranscriptAndSummary = {
			transcript: null,
			summary: null,
			nestedAssetLinks: {},
		};
		let legacyError: unknown = null;
		try {
			legacy = await this.fetchLegacyTranssumm(id);
		} catch (err) {
			legacyError = err;
		}

		let bundle: FileDetailBundle = {
			polishedTranscript: null,
			newerSummary: null,
			aiKeywords: [],
			chapters: [],
			attachments: [],
			nestedAssetLinks: {},
			detailDataTypes: [],
			attachmentDataTypes: [],
			consumerNotes: [],
		};
		let bundleError: unknown = null;
		try {
			bundle = await this.fetchFileDetailBundle(id);
		} catch (err) {
			bundleError = err;
		}

		const finalTranscript = bundle.polishedTranscript ?? legacy.transcript;
		const finalSummary = bundle.newerSummary ?? legacy.summary;

		// If the legacy endpoint errored AND the detail bundle yielded no
		// transcript or summary, there is genuinely nothing to write. Surface
		// the original Plaud error (retryable api-error) rather than writing an
		// empty note. When the bundle DID produce content, the legacy failure
		// was recoverable, so it is intentionally swallowed.
		if (legacyError !== null && finalTranscript === null && finalSummary === null) {
			throw legacyError instanceof Error
				? legacyError
				: new PlaudApiError(
						`Plaud transcript/summary fetch failed for ${id}: ${describeUnknownError(legacyError)}`,
						undefined,
						`/ai/transsumm/${encodeURIComponent(id)}`,
					);
		}

		if (this.debugLogger?.enabled === true) {
			this.debugLogger.log({
				kind: 'parsed',
				endpoint: '/getTranscriptAndSummary',
				message: `resolved transcript+summary for ${id}: transcript=${
					bundle.polishedTranscript !== null
						? `polished (${bundle.polishedTranscript.segments.length} segments)`
						: legacy.transcript !== null
							? `raw fallback (${legacy.transcript.segments.length} segments)${bundleError ? ` — file-detail lookup failed: ${describeUnknownError(bundleError)}` : ' — no polish available'}`
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
						bundleError !== null ? describeUnknownError(bundleError) : null,
					legacyErrorMessage:
						legacyError !== null ? describeUnknownError(legacyError) : null,
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
			consumerNotes:
				bundle.consumerNotes.length > 0 ? bundle.consumerNotes : undefined,
		};
	}

	/**
	 * Resolve a recording's original-audio download URL via
	 * `GET /file/temp-url/{id}`. The response envelope carries `temp_url`
	 * (a presigned S3 link to the Opus/Ogg audio) and a mostly-empty legacy
	 * `temp_url_opus`. Returns null (not an error) when the recording has
	 * no usable `temp_url`, so a missing URL never fails an import. The
	 * metadata call itself is authenticated (bearer); the presigned URL it
	 * returns must be downloaded WITHOUT the bearer (it carries its own
	 * signature), which AttachmentImporter enforces via shouldSendAuthHeader.
	 */
	async getAudioTempUrl(id: PlaudRecordingId): Promise<string | null> {
		const endpoint = `/file/temp-url/${encodeURIComponent(id)}`;
		const url = `${this.baseUrl}${endpoint}`;
		const raw = await this.fetchJson(url, endpoint);
		return parseAudioTempUrl(raw, endpoint);
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
		const rawTranscriptLink = findRawTranscriptLink(rawDetail, detailEndpoint);
		const outlineLink = findOutlineLink(rawDetail, detailEndpoint);
		// Best-effort: a drift in Plaud's summary envelope (malformed JSON,
		// missing ai_content, non-array list) must never abort the bundle and
		// drag the transcript down with it. Isolate the throw, log it for
		// visibility, and fall back to the legacy summary (newerSummary stays
		// null). Structural corruption of the response envelope itself already
		// surfaces earlier via findTransactionPolishLink.
		let newerSummaryMarkdown: string | null = null;
		try {
			newerSummaryMarkdown = findNewerSummaryMarkdown(rawDetail, detailEndpoint);
		} catch (err) {
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'parsed',
					endpoint: detailEndpoint,
					message: `newer-summary extraction failed for ${id}; falling back to legacy summary: ${describeUnknownError(err)}`,
					payload: { summaryExtractError: describeUnknownError(err) },
				});
			}
		}
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
		// Prefer the polished transcript (real speaker names from Plaud's
		// rename map); fall back to the raw `transaction` transcript when a
		// recording was never polished. Older recordings frequently have only
		// the raw entry AND fail the legacy /ai/transsumm endpoint with -12, so
		// this raw fallback is what lets them import at all.
		const transcriptLink = polishLink ?? rawTranscriptLink;
		if (transcriptLink !== null) {
			// Fetch the pre-signed S3 URL without the Bearer token — it already
			// carries its own X-Amz-Signature. Synthetic endpoint label for
			// logging / errors so the origin of the call is obvious in debug
			// output without leaking the full URL (which contains an AWS
			// session token query param).
			const transcriptEndpoint =
				polishLink !== null
					? `/s3/file_transaction_polish/${encodeURIComponent(id)}`
					: `/s3/file_transaction/${encodeURIComponent(id)}`;
			const rawTranscript = await this.fetchJson(transcriptLink, transcriptEndpoint, {
				skipAuth: true,
			});
			// The transcript file is a bare JSON array of segments (no
			// envelope). parseTranscriptField handles that shape directly —
			// pass the raw value as the segments list.
			polishedTranscript = parseTranscriptField(id, rawTranscript, transcriptEndpoint);
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

		// Additional AI template outputs (Key Points, Daily Journal, etc.) live
		// as `consumer_note` content_list entries whose S3 links serve text/plain
		// Markdown. Fetch each body now so note-writer can fold them into the
		// note. Isolated like the newer-summary extraction: a failure here must
		// never abort the bundle and drag the transcript/summary down with it.
		let consumerNotes: readonly ConsumerNote[] = [];
		try {
			consumerNotes = await this.fetchConsumerNotes(rawDetail, detailEndpoint, id);
		} catch (err) {
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'parsed',
					endpoint: detailEndpoint,
					message: `consumer_note extraction failed for ${id}; continuing without template outputs: ${describeUnknownError(err)}`,
					payload: { consumerNoteError: describeUnknownError(err) },
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
			consumerNotes,
		};
	}

	/**
	 * Fetch the Markdown body of every `consumer_note` template output on a
	 * recording. Each entry's `data_link` is a short-lived pre-signed S3 URL
	 * serving `text/plain`, so the fetch is authless (the URL carries its own
	 * signature) and best-effort: a dead link or empty body drops that one
	 * section, never the whole bundle. Fetched sequentially to match the
	 * back-to-back transcript/outline pattern above and avoid hammering S3.
	 */
	private async fetchConsumerNotes(
		rawDetail: unknown,
		detailEndpoint: string,
		id: PlaudRecordingId,
	): Promise<readonly ConsumerNote[]> {
		const refs = findConsumerNoteEntries(rawDetail, detailEndpoint);
		const notes: ConsumerNote[] = [];
		for (let i = 0; i < refs.length; i++) {
			const ref = refs[i];
			const noteEndpoint = `/s3/file_consumer_note_${i}/${encodeURIComponent(id)}`;
			const body = await this.fetchTextBody(ref.dataLink, noteEndpoint);
			if (body === null || body.trim().length === 0) {
				if (this.debugLogger?.enabled === true) {
					this.debugLogger.log({
						kind: 'parsed',
						endpoint: noteEndpoint,
						message: `consumer_note "${ref.heading}" body empty for ${id}; skipping section`,
					});
				}
				continue;
			}
			notes.push({ heading: ref.heading, markdown: body.trim() });
		}
		return notes;
	}

	/**
	 * Fetch a pre-signed S3 URL as raw text. Unlike `fetchJson`, this asserts
	 * nothing about the body shape (consumer_note bodies are Markdown, not
	 * JSON), so it must not route through the JSON parser. Authless: the URL
	 * carries its own `X-Amz-Signature` and a Bearer token would be rejected.
	 * Returns null on any network or non-2xx failure so callers stay
	 * best-effort.
	 */
	private async fetchTextBody(
		url: string,
		endpoint: string,
	): Promise<string | null> {
		let response: PlaudHttpResponse;
		try {
			response = await this.fetcher({
				url,
				method: 'GET',
				headers: {
					Accept: 'text/plain, text/markdown, */*',
					'User-Agent': USER_AGENT,
				},
			});
		} catch (err) {
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'error',
					endpoint,
					message: `GET ${endpoint} fetcher rejected: ${
						err instanceof Error ? err.message : String(err)
					}`,
				});
			}
			return null;
		}
		if (response.status < 200 || response.status >= 300) {
			return null;
		}
		return response.text ?? null;
	}

	private async fetchJson(
		url: string,
		endpoint: string,
		options: {
			method?: 'GET' | 'POST';
			body?: string;
			skipAuth?: boolean;
			// Internal: set when this call is the retry after a region
			// redirect, so a second redirect throws instead of looping.
			isRegionRetry?: boolean;
		} = {},
	): Promise<unknown> {
		const method = options.method ?? 'GET';

		const headers: Record<string, string> = {
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
		};
		// Debug-only: non-identifying token claims (client_id/typ/ver), filled
		// below when a token is attached. Surfaced in the request event so a
		// debug log can show a token-type / parse-mode mismatch.
		let tokenDiagnostics: Record<string, unknown> | null = null;

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
			// Plaud's web app stores the token in localStorage as
			// `bearer eyJ…`, so a user who copies the value verbatim
			// would otherwise double-prefix to `Bearer bearer eyJ…` and
			// get rejected. Strip any leading `bearer ` (case-insensitive)
			// before we prepend our own capitalized scheme token.
			const token = rawToken.trim().replace(/^bearer\s+/i, '');
			headers.Authorization = `Bearer ${token}`;
			if (this.debugLogger?.enabled === true) {
				tokenDiagnostics = decodeTokenDiagnostics(token);
			}

			// Plaud's data API selects a token "parse mode" from the
			// `app-platform` header and rejects the token with
			// `status: -3901 "token type does not match parse mode"` when it
			// disagrees with the token's own `client_id` claim. Derive the
			// header from the token so the two always match, whichever Plaud
			// client minted it; fall back to 'web' (the web app's value) when
			// the claim is absent. Scoped to authenticated calls — the skipAuth
			// path fetches pre-signed S3 asset URLs, which must not carry extra
			// headers. Verified against a live web.plaud.ai token (client_id
			// 'web') on 2026-06-18.
			const clientId = readTokenClientId(token) ?? 'web';
			headers['app-platform'] = clientId;
			headers['edit-from'] = clientId;
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
					// lives there. Surface only the non-auth platform header
					// and the redacted token claims needed to diagnose a
					// `-3901 token type does not match parse mode` mismatch.
					appPlatform: headers['app-platform'],
					tokenDiagnostics,
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

		// Region mismatch is a soft redirect carried in the JSON envelope with
		// an HTTP 200, not an HTTP 3xx — so it lands here, past every status
		// branch. Plaud returns the correct regional host; switch to it,
		// persist it via the callback, and retry the same request once.
		const redirectHost = detectRegionRedirect(response.json);
		if (redirectHost !== null && redirectHost !== this.baseUrl) {
			if (options.isRegionRetry === true) {
				// We already followed one redirect and got pointed somewhere
				// else again. Stop rather than loop indefinitely.
				throw new PlaudApiError(
					`Plaud API ${endpoint} returned a second region redirect (to ${redirectHost}) — refusing to loop`,
					undefined,
					endpoint,
				);
			}
			const previousBase = this.baseUrl;
			this.baseUrl = redirectHost;
			this.onBaseUrlChanged?.(redirectHost);
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'response',
					endpoint,
					message: `region redirect: ${previousBase} -> ${redirectHost}, retrying`,
				});
			}
			// The URL was built as `${previousBase}${endpoint}...`, so swapping
			// the leading host preserves the path and query verbatim.
			const retryUrl = url.startsWith(previousBase)
				? redirectHost + url.slice(previousBase.length)
				: url;
			return this.fetchJson(retryUrl, endpoint, { ...options, isRegionRetry: true });
		}

		// Plaud reports failures in-band: HTTP 200 with a negative `status` and
		// a `msg`, no data payload. Catch them here so they surface as a
		// truthful auth/API error carrying Plaud's own message, instead of
		// falling through to a data parser that mislabels them as an
		// "unexpected shape" parse error. (The -302 region redirect is handled
		// above.)
		const inBand = detectInBandError(response.json);
		if (inBand !== null) {
			if (this.debugLogger?.enabled === true) {
				this.debugLogger.log({
					kind: 'response',
					endpoint,
					message: `in-band error: status=${inBand.status} msg=${inBand.msg}`,
				});
			}
			// Token-expiry codes route to the re-login remediation. -419
			// "workspace token expired" is the observed expiry code; the
			// /expired/i guard also catches sibling codes worded the same way.
			if (inBand.status === -419 || /expired/i.test(inBand.msg)) {
				throw new PlaudAuthError(
					'token_rejected',
					`Plaud rejected the token on ${endpoint} (status ${inBand.status}: ${inBand.msg})`,
					endpoint,
				);
			}
			// Any other in-band failure (e.g. -3901 "token type does not match
			// parse mode") surfaces Plaud's own message. The "in-band error
			// from" prefix routes it to the api-error category in classifyError,
			// and inBandStatus carries Plaud's numeric code so the UI can give a
			// code-specific explanation (e.g. -12 "start trans task error").
			throw new PlaudApiError(
				`Plaud returned in-band error from ${endpoint}: status=${inBand.status} msg=${inBand.msg}`,
				undefined,
				endpoint,
				inBand.status,
			);
		}

		return response.json;
	}
}

// Hosts the region redirect is allowed to point at. The retry re-sends the
// Bearer token, so the redirect target is a credential trust boundary: a
// tampered or malicious -302 body must never be able to steer the token at an
// arbitrary host. Restrict to Plaud's own domains.
const ALLOWED_REGION_EXACT_HOSTS = new Set(['plaud.ai', 'api.plaud.ai']);
const ALLOWED_REGION_HOST_SUFFIX = '.plaud.ai';

// Detects Plaud's region-mismatch soft redirect. EU and other non-US accounts
// hitting the US host get an HTTP 200 whose JSON body is:
//
//   { "status": -302, "msg": "user region mismatch",
//     "data": { "domains": { "api": "https://api-euc1.plaud.ai" } } }
//
// Returns the regional origin (scheme + host, no trailing slash, no path)
// when the body matches that shape AND the target is a trusted Plaud https
// host; otherwise null. Returning only the parsed origin (not the raw string)
// also strips any path/query/userinfo an attacker might have appended.
function detectRegionRedirect(json: unknown): string | null {
	if (!isRecord(json) || json.status !== -302) {
		return null;
	}
	const data = json.data;
	if (!isRecord(data)) {
		return null;
	}
	const domains = data.domains;
	if (!isRecord(domains)) {
		return null;
	}
	const api = domains.api;
	if (typeof api !== 'string') {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(api);
	} catch {
		return null;
	}
	// Plaud always serves over https. Reject anything else, and reject
	// embedded credentials (https://api.plaud.ai@evil.example parses with
	// hostname evil.example — the userinfo is the bypass).
	if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
		return null;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	const allowed =
		ALLOWED_REGION_EXACT_HOSTS.has(host) || host.endsWith(ALLOWED_REGION_HOST_SUFFIX);
	if (!allowed) {
		return null;
	}
	// Rebuild from the parsed origin so only scheme + host[:port] survive.
	return `https://${parsed.host}`.replace(/\/+$/, '');
}

// Detects Plaud's in-band error envelope. Plaud signals failures on the data
// API as an HTTP 200 whose JSON body carries a NEGATIVE `status` code and a
// human-readable `msg`, with no data payload. Captured from a real broken
// session on 2026-06-18:
//
//   { "status": -419,  "msg": "workspace token expired" }
//   { "status": -3901, "msg": "token type does not match parse mode" }
//
// This is the same envelope family as the -302 region redirect (consumed by
// detectRegionRedirect before we reach here). Successful responses use a
// non-negative status — the listing endpoint returns `status: 0` and the
// transcript/summary endpoint returns `status: 1` on success — so keying on a
// negative status cleanly separates errors from success without misreading a
// valid payload. Returns the code and message, or null when the body is not an
// in-band error.
function detectInBandError(json: unknown): { status: number; msg: string } | null {
	if (!isRecord(json)) {
		return null;
	}
	const status = json.status;
	if (typeof status !== 'number' || status >= 0) {
		return null;
	}
	// -302 is the region redirect, already consumed by detectRegionRedirect.
	if (status === -302) {
		return null;
	}
	const msg =
		typeof json.msg === 'string' && json.msg.length > 0 ? json.msg : '(no message)';
	return { status, msg };
}

// Decodes ONLY the non-identifying diagnostic claims from a Plaud bearer token,
// for debug logging. Plaud's data API selects a token "parse mode" from the
// `app-platform` request header and rejects the token with
// `status: -3901 "token type does not match parse mode"` when that mode does
// not match the token's own `client_id`. Surfacing `client_id`/`typ`/`ver`
// (never `sub`/`wid`/`jti` or the token string) lets a debug log reveal that
// mismatch without leaking identity. Returns null when debug is off / no token.
function decodeJwtSegment(seg: string): Record<string, unknown> | null {
	try {
		const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
		// atob is always present in Obsidian's Electron renderer (and Node 18+);
		// avoid the Node `Buffer` global, which is untyped in the marketplace
		// scan's type-checked lint and trips the no-unsafe-* rules.
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// The Plaud client that minted the token, read from the JWT `client_id` claim
// (e.g. 'web', 'app'). The data API rejects a token with
// `status: -3901 "token type does not match parse mode"` when the request's
// `app-platform` header disagrees with this claim, so the client uses it to
// keep the two in sync. Returns null when the token is opaque or has no claim.
function readTokenClientId(token: string): string | null {
	const parts = token.split('.');
	if (parts.length < 2) {
		return null;
	}
	const payload = decodeJwtSegment(parts[1]);
	return payload !== null && typeof payload.client_id === 'string'
		? payload.client_id
		: null;
}

// Decodes ONLY the non-identifying diagnostic claims from a Plaud bearer token,
// for debug logging. Surfaces `client_id`/`typ`/`ver` (never `sub`/`wid`/`jti`
// or the token string) so a debug log can reveal a token-type / parse-mode
// mismatch without leaking identity.
const TOKEN_DIAG_CLAIMS = ['typ', 'alg', 'client_id', 'ver', 'wtype', 'auth_method', 'exp'];
function decodeTokenDiagnostics(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (parts.length < 2) {
		return { token: 'not-a-jwt' };
	}
	const safe: Record<string, unknown> = {};
	for (const [name, seg] of [
		['header', parts[0]],
		['payload', parts[1]],
	] as const) {
		const obj = decodeJwtSegment(seg);
		if (obj === null) {
			safe[name] = 'decode-failed';
			continue;
		}
		for (const claim of TOKEN_DIAG_CLAIMS) {
			if (claim in obj) {
				safe[`${name}.${claim}`] = obj[claim];
			}
		}
	}
	return safe;
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
	// Optional: present on current Plaud payloads, absent on some older ones.
	// Treated as not-trashed when missing.
	readonly is_trash?: boolean;
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
		isTrashed: raw.is_trash === true,
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

// Human-readable description of an unknown error value for diagnostic
// strings. Avoids `String(err)` which produces "[object Object]" for
// non-Error rejections (rare but possible when third-party code
// rejects with a plain object).
function describeUnknownError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	if (err === null || err === undefined) return String(err);
	if (typeof err === 'number' || typeof err === 'boolean') return String(err);
	try {
		const json = JSON.stringify(err);
		if (json !== undefined) return json;
	} catch {
		// Fall through to constructor-name fallback.
	}
	const ctor = (err as { constructor?: { name?: string } })?.constructor?.name;
	return ctor ? `[object ${ctor}]` : 'unknown error';
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
	readonly consumerNotes: readonly ConsumerNote[];
}

/**
 * Walk a raw `/file/detail/{id}` response and return the markdown text of
 * Plaud's NEWER summary, or null when this recording has no newer summary.
 *
 * The newer summary lives in `data.pre_download_content_list` — the entry
 * whose `data_id` starts with `auto_sum:` (these entries carry NO
 * `data_type` field; that exists only on `content_list`). Its
 * `data_content` is either a JSON envelope carrying the markdown under
 * `ai_content`, or a bare markdown string. Embedded directly in the
 * response body (no S3 follow-up). It differs from the legacy
 * `/ai/transsumm/{id}` summary in two important ways:
 *  1. Participant names are resolved from Plaud's speaker-rename map, so
 *     a note reads "Participants: Charles Kelsoe, Vijay Muniswamy" instead
 *     of "Speaker 2, Speaker 3".
 *  2. Plaud regenerates it when the user edits speakers in the web app,
 *     unlike the legacy summary which is a static snapshot.
 *
 * Returns null — not an error — when:
 *  - The response has no `pre_download_content_list` field (older recordings)
 *  - The list is present but contains no `auto_sum:` entry
 *  - The `auto_sum:` entry has no `data_content` string, or its envelope
 *    `ai_content` trims to empty
 *
 * Throws `PlaudParseError` on structurally-invalid responses (missing
 * `data`, non-array `pre_download_content_list`) so the caller can surface
 * the bad shape via the normal parse-error path.
 *
 * See `dev-docs/deferred-decisions.md` DD-004 for the field inventory.
 */
/**
 * Validate the standard Plaud response envelope and return its `data`
 * object. Every `/file/detail/{id}`-shaped parser shares this prologue:
 * the body must be an object carrying an object `data` field; anything
 * else is structurally corrupt and surfaces as a PlaudParseError.
 */
/**
 * Extract the original-audio download URL from a `/file/temp-url/{id}`
 * response. The envelope's `data.temp_url` is the presigned S3 link; a
 * missing, non-string, or empty value means no audio URL is available and
 * returns null (not an error). Exported as a pure function so the URL
 * extraction is unit-testable without the fetch plumbing.
 */
export function parseAudioTempUrl(raw: unknown, endpoint: string): string | null {
	if (!isRecord(raw)) {
		throw new PlaudParseError(
			`Response body for ${endpoint} is not an object`,
			endpoint,
		);
	}
	// Unlike /file/detail this endpoint returns temp_url at the TOP LEVEL of
	// the response ({ status, temp_url, temp_url_opus }), NOT inside the usual
	// { data: {...} } envelope. Read the top level; fall back to a data-wrapped
	// value defensively in case Plaud ever normalizes the shape.
	const dataRecord = isRecord(raw.data) ? raw.data : undefined;
	const tempUrl = raw.temp_url ?? dataRecord?.temp_url;
	if (typeof tempUrl !== 'string' || tempUrl.trim().length === 0) {
		return null;
	}
	return tempUrl;
}

function requireDataEnvelope(
	raw: unknown,
	endpoint: string,
): Record<string, unknown> {
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
	return data;
}

/**
 * Scan a `/file/detail/{id}` response's `content_list` for the entry with
 * the given `data_type` and return its pre-signed S3 `data_link`.
 *
 * Selection rules shared by every content-pipeline artifact (outline,
 * transaction_polish):
 *  - `content_list` absent: the recording has no content pipeline entries
 *    yet (e.g., a just-uploaded file). Not an error, just no artifact.
 *  - `task_status === 1` means the pipeline completed successfully. Any
 *    other value (0 = pending, higher = failure states) means the artifact
 *    isn't ready: treated like "absent" so the caller falls back.
 *  - Throws PlaudParseError only on structurally corrupt responses.
 */
function findContentListLink(
	raw: unknown,
	endpoint: string,
	dataType: string,
): string | null {
	const data = requireDataEnvelope(raw, endpoint);
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
		if (item.data_type !== dataType) {
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

export function findNewerSummaryMarkdown(
	raw: unknown,
	endpoint: string,
): string | null {
	const data = requireDataEnvelope(raw, endpoint);
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
		// pre_download_content_list entries are keyed by `data_id`, NOT by
		// `data_type` (that field only exists on `content_list`). The
		// pre-rendered auto summary is the entry whose data_id starts with
		// `auto_sum:` — e.g. "auto_sum:899720e9:<fileId>". The previous code
		// keyed on `data_type === 'auto_sum_note'`, which is absent on these
		// entries, so it matched nothing in production and silently dropped
		// every summary while transcripts still imported (0.11.0 regression).
		const dataId = item.data_id;
		if (typeof dataId !== 'string' || !dataId.startsWith('auto_sum:')) {
			continue;
		}
		const content = item.data_content;
		if (typeof content !== 'string') {
			return null;
		}
		return extractAutoSumMarkdown(content, endpoint);
	}
	return null;
}

/**
 * Pull the markdown summary body out of an `auto_sum:` entry's
 * `data_content`. Two shapes occur in the wild:
 *  1. Newer recordings: a JSON envelope string carrying the markdown under
 *     `ai_content`, alongside `category` / `summary_id` metadata.
 *  2. Brief or older recordings: the markdown string verbatim, with no JSON
 *     wrapper — e.g. "The transcript is brief, no summary is needed...".
 *
 * Returns null when the content trims to empty, or when the JSON envelope's
 * `ai_content` is present but empty. Throws PlaudParseError when the payload
 * looks like JSON but fails to parse, or parses to an object lacking an
 * `ai_content` string — a loud signal that Plaud's summary envelope drifted.
 * The caller (fetchFileDetailBundle) isolates this throw so a summary-shape
 * drift can never block the transcript path. Mirrors parseSummaryField's
 * JSON-vs-verbatim discrimination.
 */
function extractAutoSumMarkdown(
	content: string,
	endpoint: string,
): string | null {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return null;
	}
	// Only JSON.parse when the payload looks structured; a bare markdown
	// body (shape 2) is returned verbatim.
	if (!trimmed.startsWith('{')) {
		return trimmed;
	}
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch (err) {
		throw new PlaudParseError(
			`auto_sum data_content for ${endpoint} looks like JSON but failed to parse: ${
				err instanceof Error ? err.message : String(err)
			}`,
			endpoint,
		);
	}
	if (isRecord(obj) && typeof obj.ai_content === 'string') {
		const aiContent = obj.ai_content.trim();
		return aiContent.length > 0 ? aiContent : null;
	}
	throw new PlaudParseError(
		`auto_sum data_content for ${endpoint} parsed to JSON but has no 'ai_content' string — Plaud summary envelope may have changed. Keys: [${
			isRecord(obj) ? Object.keys(obj).join(', ') : typeof obj
		}]`,
		endpoint,
	);
}

/**
 * Walk a raw `/file/detail/{id}` response and return the AI-generated
 * keyword list, or an empty array when absent.
 *
 * The keywords live at `data.extra_data.aiContentHeader.keywords` — an
 * array of short strings like `["AI Agent", "Customer Data", "AWS"]`.
 * They are Plaud's topical tag guess for the recording. `buildNoteTags`
 * in note-writer.ts decides per the tag-mode setting whether they land
 * in the note's `tags:` frontmatter or in a `keywords:` property.
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
	const data = requireDataEnvelope(raw, endpoint);
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
	return findContentListLink(raw, endpoint, 'outline');
}

/**
 * Reference to one `consumer_note` template output discovered in a
 * `/file/detail/{id}` response: the section label plus the pre-signed S3
 * link whose body is the Markdown. The body itself is fetched separately
 * because it is text/plain, not part of the detail JSON envelope.
 */
interface ConsumerNoteRef {
	readonly heading: string;
	readonly dataLink: string;
}

/**
 * Scan a `/file/detail/{id}` response's `content_list` for `consumer_note`
 * entries — the extra AI template outputs (Key Points, Daily Journal, etc.)
 * the user generated in Plaud. Each is headed by its generating template's
 * name (`extra.used_template.template_name`, falling back to the tab label
 * then the entry title) and carries a pre-signed `data_link` whose body is
 * text/plain Markdown. Only ready entries (`task_status === 1`) that carry a
 * link are returned; the body is fetched downstream. Distinct from
 * `findAttachmentAssets`, which excludes `consumer_note` so these never get
 * saved as unreadable binary attachments.
 */
export function findConsumerNoteEntries(
	raw: unknown,
	endpoint: string,
): readonly ConsumerNoteRef[] {
	const data = requireDataEnvelope(raw, endpoint);
	const out: ConsumerNoteRef[] = [];
	const seen = new Set<string>();
	const list = data.content_list;
	if (!Array.isArray(list)) {
		return out;
	}
	for (const item of list) {
		if (!isRecord(item)) {
			continue;
		}
		if (pickNonEmptyString(item.data_type) !== 'consumer_note') {
			continue;
		}
		// task_status 1 = ready. Skip in-flight or errored outputs so a
		// half-generated template never lands a broken section in the note.
		if (item.task_status !== undefined && item.task_status !== 1) {
			continue;
		}
		const links = collectAttachmentUrls(item.data_link);
		if (links.length === 0) {
			continue;
		}
		const dataLink = links[0];
		if (seen.has(dataLink)) {
			continue;
		}
		seen.add(dataLink);
		// Prefer the generating template's name (extra.used_template.template_name)
		// for the section header; fall back to the tab label then the entry title.
		const usedTemplate =
			isRecord(item.extra) && isRecord(item.extra.used_template)
				? item.extra.used_template
				: undefined;
		const heading =
			pickNonEmptyString(
				usedTemplate?.template_name,
				item.data_tab_name,
				item.data_title,
			) ?? 'Template output';
		out.push({ heading, dataLink });
	}
	return out;
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
	const data = requireDataEnvelope(raw, endpoint);

	const out: AttachmentAsset[] = [];
	const seenUrls = new Set<string>();
	const excludedTypes = new Set([
		'transaction',
		'transaction_polish',
		'outline',
		'auto_sum_note',
		// consumer_note bodies are text/plain Markdown folded into the note by
		// note-writer (see findConsumerNoteEntries); never download them as
		// binary attachments or they land as unreadable `.bin` files.
		'consumer_note',
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
	// Pipeline DATA blobs — the gzipped transcript/outline JSON and the
	// gzipped summary markdown — are never user attachments. They appear in
	// some older recordings' download maps, and without this guard they leak
	// in as bogus ".gz" attachment links (Plaud/.../-assets/<id>-fileN.gz).
	// Reject them before the permissive https:// check below accepts them.
	if (isPipelineDataUrl(lower)) {
		return false;
	}
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

/**
 * True when a URL/path points at one of Plaud's transcript/outline/summary
 * pipeline data blobs rather than a real user attachment. These are always
 * gzipped JSON or markdown; an actual attachment (card PNG, mindmap, photo,
 * PDF) is never `.gz`. The path markers are defensive in case a future data
 * file is not gzipped. Input is expected already lower-cased.
 */
function isPipelineDataUrl(lower: string): boolean {
	if (/\.gz(\?|$)/.test(lower)) {
		return true;
	}
	return (
		lower.includes('/file_transcript/') ||
		lower.includes('/file_outline/') ||
		lower.includes('/file_summary/') ||
		lower.includes('/file_transaction_polish/') ||
		lower.includes('trans_result') ||
		lower.includes('ai_content')
	);
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
	const data = requireDataEnvelope(raw, endpoint);

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
	return findContentListLink(raw, endpoint, 'transaction_polish');
}

/**
 * Walk a `/file/detail/{id}` response and return the pre-signed S3 URL of the
 * RAW transcript (`data_type === 'transaction'`) — the unpolished transcript
 * with Plaud's "Speaker 1/2" labels and no rename map. Used as a fallback when
 * a recording has no `transaction_polish` entry, which is common on older
 * recordings that also fail the legacy `/ai/transsumm/{id}` endpoint with the
 * in-band `-12` "start trans task error". Same selection rules as the polish
 * finder: requires `task_status === 1`, returns null when absent.
 */
export function findRawTranscriptLink(
	raw: unknown,
	endpoint: string,
): string | null {
	return findContentListLink(raw, endpoint, 'transaction');
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
	if (raw.start_time > MAX_PLAUSIBLE_SEGMENT_MS || raw.end_time > MAX_PLAUSIBLE_SEGMENT_MS) {
		throw new PlaudParseError(
			`data_result[${index}] for ${id} has timestamps beyond 24h (start=${raw.start_time}ms end=${raw.end_time}ms) — producer may have sent seconds instead of milliseconds`,
			endpoint,
		);
	}

	// Real-API capture on 2026-06-10 (recording 9a3a1db8...) showed Plaud
	// can emit a segment whose end_time lands BEFORE its start_time (13.5s
	// earlier, mid-recording). This parser used to reject the whole
	// transcript for that one mis-ordered boundary, which failed an
	// otherwise valid import. Normalize instead: start_time stays
	// authoritative (segment ordering and the rendered timestamps key off
	// it) and end_time is clamped up to start_time. The negative,
	// non-finite, and beyond-24h checks above still throw.
	const endTimeMs = Math.max(raw.end_time, raw.start_time);

	// Plaud transmits transcript timestamps in milliseconds for transcript
	// segments (same as the list endpoint's recording start_time — both
	// fixed in commit 4c after real-API testing).
	const startSeconds = raw.start_time / 1000;
	const endSeconds = endTimeMs / 1000;

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
 * applaud's `extractSummaryMarkdown` helper. The field has five documented
 * shapes:
 *   1. JSON-encoded string that parses to {content: {markdown: string}}
 *   2. Structured object {content: {markdown: string}}
 *   3. Structured object {content: string}
 *   4. Raw string that is NOT JSON — treat as markdown verbatim
 *   5. Flat GPT-5 schema (rolled out 2026-05): top-level {markdown: string,
 *      summary: string, first_summary: string, header, form, ...}. The
 *      `content` wrapper is gone. Prefer top-level `markdown` (canonical
 *      rendered output); fall back to `summary` if absent. Skip
 *      `first_summary` — that field is the pre-edit raw GPT output and is
 *      usually a near-duplicate of `summary` but without persona / form
 *      normalization applied.
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
			return buildSummary(id, trimmed, undefined);
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
		return text.length > 0 ? buildSummary(id, text, obj) : null;
	}
	if (isRecord(content)) {
		const md = content.markdown;
		if (typeof md === 'string') {
			const text = md.trim();
			return text.length > 0 ? buildSummary(id, text, obj) : null;
		}
		throw new PlaudParseError(
			`data_result_summ.content for ${id} has keys [${Object.keys(content).join(', ')}] but no markdown string — Plaud format may have changed. Sample: ${summarizeShape(content)}`,
			endpoint,
		);
	}

	// Shape 5: flat GPT-5 schema. No `content` wrapper; markdown lives at
	// the top level. Try `markdown` first (canonical); if that key is
	// present but its value trims to empty, treat it as "no summary yet"
	// (return null) — same semantic as legacy content.markdown trimming
	// to empty. Only when `markdown` is wholly absent do we try
	// `summary` as a fallback shape.
	if (content === undefined) {
		const flatMarkdown = obj.markdown;
		if (typeof flatMarkdown === 'string') {
			const text = flatMarkdown.trim();
			return text.length > 0 ? buildSummary(id, text, obj) : null;
		}
		const flatSummary = obj.summary;
		if (typeof flatSummary === 'string') {
			const text = flatSummary.trim();
			return text.length > 0 ? buildSummary(id, text, obj) : null;
		}
	}

	throw new PlaudParseError(
		`data_result_summ for ${id} has content field of unexpected type (${typeof content}) — expected string or object with markdown. Outer keys: [${Object.keys(obj).join(', ')}]. Sample: ${summarizeShape(obj)}`,
		endpoint,
	);
}

// Build a Summary, layering any optional extras pulled from the outer
// envelope. The extras are best-effort: every field is soft-guarded with
// `typeof === 'string'` + non-empty trim, and missing or wrong-typed
// fields are silently dropped. Never throws — extras must never be
// load-bearing for the import to succeed. Open to new unknown keys: any
// novel field Plaud adds is ignored without breaking.
function buildSummary(
	id: PlaudRecordingId,
	text: string,
	envelope: unknown,
): Summary {
	if (!isRecord(envelope)) {
		return { id, text };
	}

	const aiSuggestion = pickNonEmptyString(envelope.ai_suggestion);
	const language = pickNonEmptyString(envelope.language);
	const template = pickNonEmptyString(
		envelope.summ_type,
		envelope.select_prompt_type,
	);
	const model = pickNonEmptyString(envelope.model, envelope.endpoint);
	const noteId = pickNonEmptyString(envelope.note_id);
	const summaryId = pickNonEmptyString(envelope.summary_id);

	// `version` may arrive as either a string or a number. Coerce numbers
	// to strings so the frontmatter emitter has a single shape to deal
	// with; ignore anything that isn't string/number/finite.
	const rawVersion = envelope.version;
	let version: string | undefined;
	if (typeof rawVersion === 'string' && rawVersion.trim().length > 0) {
		version = rawVersion.trim();
	} else if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) {
		version = String(rawVersion);
	}

	let headline: string | undefined;
	let category: string | undefined;
	const header = envelope.header;
	if (isRecord(header)) {
		headline = pickNonEmptyString(header.headline);
		category = pickNonEmptyString(header.category);
	}

	const summary: Summary = {
		id,
		text,
		...(aiSuggestion !== undefined && { aiSuggestion }),
		...(language !== undefined && { language }),
		...(template !== undefined && { template }),
		...(model !== undefined && { model }),
		...(noteId !== undefined && { noteId }),
		...(summaryId !== undefined && { summaryId }),
		...(version !== undefined && { version }),
		...(headline !== undefined && { headline }),
		...(category !== undefined && { category }),
	};
	return summary;
}

// Bounded JSON sample for shape-drift diagnostics. Strips token-like
// values (any string that looks like a JWT or > 64 chars) so an exported
// error message can never accidentally leak credentials, and caps total
// length to 400 chars to keep the user-facing notice readable.
function summarizeShape(value: unknown): string {
	try {
		const json = JSON.stringify(value, (_key, v: unknown) => {
			if (typeof v === 'string') {
				if (v.length > 120) return `[string:${v.length}chars]`;
				if (/^(bearer\s+)?ey[A-Za-z0-9_-]+\./i.test(v)) return '[redacted-token]';
			}
			return v;
		});
		if (json === undefined) return '(unserializable)';
		return json.length > 400 ? `${json.slice(0, 400)}…` : json;
	} catch {
		return '(serialize-failed)';
	}
}
