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
	PlaudClient,
	PlaudRecordingId,
	Recording,
	RecordingFilter,
	Summary,
	Transcript,
	TranscriptAndSummary,
	TranscriptSegment,
} from './plaud-client';

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
}

export class ReverseEngineeredPlaudClient implements PlaudClient {
	private readonly tokenProvider: PlaudTokenProvider;
	private readonly fetcher: PlaudHttpFetcher;
	private readonly baseUrl: string;

	constructor(
		tokenProvider: PlaudTokenProvider,
		fetcher: PlaudHttpFetcher,
		options: PlaudClientOptions = {},
	) {
		this.tokenProvider = tokenProvider;
		this.fetcher = fetcher;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
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
			skip: '0',
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
		const endpoint = `/ai/transsumm/${encodeURIComponent(id)}`;
		const url = `${this.baseUrl}${endpoint}`;
		// /ai/transsumm/{id} is POST despite carrying no payload — the empty
		// JSON object body is required. Confirmed against rsteckler/applaud
		// (server/src/plaud/transcript.ts) which is the canonical RE client.
		const raw = await this.fetchJson(url, endpoint, { method: 'POST', body: '{}' });
		return parseTranssummResponse(id, raw, endpoint);
	}

	private async fetchJson(
		url: string,
		endpoint: string,
		options: { method?: 'GET' | 'POST'; body?: string } = {},
	): Promise<unknown> {
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
		const method = options.method ?? 'GET';

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
		};
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
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
			throw new PlaudApiError(
				`Plaud API ${endpoint} network error: ${cause}`,
				undefined,
				endpoint,
			);
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
		durationSeconds: raw.duration,
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

	// Plaud transmits transcript timestamps in MILLISECONDS (unlike the
	// list endpoint, which uses unix seconds for recording start_time).
	// Convert here so the rest of the plugin sees consistent units.
	const startSeconds = raw.start_time / 1000;
	const endSeconds = raw.end_time / 1000;

	// Speaker may be empty; prefer original_speaker for stability across
	// re-transcription runs (Plaud may rewrite `speaker` when the user
	// edits labels or when the diarization model changes, but
	// original_speaker is the stable wire identifier). Fall back to
	// `speaker` only if original_speaker is empty.
	const speaker = pickNonEmptyString(raw.original_speaker, raw.speaker);

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
