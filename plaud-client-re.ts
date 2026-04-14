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
	AudioRef,
	PlaudClient,
	PlaudRecordingId,
	Recording,
	RecordingFilter,
	Summary,
	Transcript,
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
	readonly headers: Readonly<Record<string, string>>;
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

	async getTranscript(_id: PlaudRecordingId): Promise<Transcript | null> {
		throw new PlaudApiError(
			'ReverseEngineeredPlaudClient.getTranscript is not implemented yet',
			undefined,
			'/ai/transsumm/:id',
		);
	}

	async getSummary(_id: PlaudRecordingId): Promise<Summary | null> {
		throw new PlaudApiError(
			'ReverseEngineeredPlaudClient.getSummary is not implemented yet',
			undefined,
			'/ai/transsumm/:id',
		);
	}

	async getAudio(_id: PlaudRecordingId): Promise<AudioRef | null> {
		throw new PlaudApiError(
			'ReverseEngineeredPlaudClient.getAudio is not implemented yet',
			undefined,
			'/file/audio/:id',
		);
	}

	private async fetchJson(url: string, endpoint: string): Promise<unknown> {
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

		let response: PlaudHttpResponse;
		try {
			response = await this.fetcher({
				url,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/json',
					'User-Agent': USER_AGENT,
				},
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

// Upper bound on a plausible unix-seconds timestamp. If start_time is
// greater than this the producer probably sent milliseconds — reject
// loudly rather than creating a note dated in the year 6000.
const MAX_PLAUSIBLE_UNIX_SECONDS = 4102444800; // 2100-01-01 UTC

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
	if (raw.start_time > MAX_PLAUSIBLE_UNIX_SECONDS) {
		throw new PlaudParseError(
			`Recording ${raw.id} has start_time ${raw.start_time} which is beyond year 2100 — likely milliseconds instead of seconds`,
			endpoint,
		);
	}

	return {
		id: raw.id as PlaudRecordingId,
		title: raw.filename,
		// Plaud serializes start_time as unix seconds, not millis.
		createdAt: new Date(raw.start_time * 1000),
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
