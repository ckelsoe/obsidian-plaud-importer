// Cookieless v4 workspace-token refresh. The background renewal path for a v4
// SSO / browser session (signInMethod 'browser'), where the v3 cookie flow in
// plaud-refresh-net.ts cannot run: an external-browser or bookmarklet capture
// never populates the embedded window's partition, so there are no cookies to
// authenticate with. This path authenticates with a BEARER token instead, the
// workspace refresh token captured at sign-in, so it works with no window.
//
// One call, reverse-engineered from the beta.plaud.ai bundle and VERIFIED LIVE
// 2026-09-18 against a real signed-in account:
//
//   POST /user-app/auth/workspace/refresh/{wid}   body {}
//     Authorization: Bearer <workspace REFRESH token>
//     x-scope-type: workspace   x-scope-id: <wid>   x-device-id: <id?>
//     app-platform: <client_id>
//   -> data { workspace_token, refresh_token, wt_expires_at, ... }, in-band 0
//
// This is NOT /user-app/auth/workspace/token/{wid}: that endpoint is the
// cookie-based mint the web app uses (it needs the user session cookie and is
// unusable for a browser capture, which has none). The bearer refresh endpoint
// is the only one that works from Obsidian for a browser session.
//
// The refresh token ROTATES: every success returns a NEW refresh_token, and the
// caller MUST persist it and bearer the LATEST one next time. The bundle
// documents the previous token as single-use (in-band -420 WRT_EXPIRED once
// spent), but a live check on 2026-09-18 saw the previous token still accepted
// (in-band 0) on the test host, so this path does NOT depend on the old one
// expiring: it always stores and uses the newest, and treats any non-zero status
// (including -419 WT_EXPIRED and -420 WRT_EXPIRED) as a failed refresh that
// leaves the old token in place and prompts a reconnect. Every status is in-band
// on an HTTP 200, like every other Plaud endpoint.
//
// FAIL-SAFE, exactly like plaud-refresh-net.ts: this module only ever RETURNS a
// candidate {WT, rotated WRT}; it never writes storage. The caller re-validates
// (typ WT, future exp, moved the expiry) before replacing anything, and on any
// null result the background pauses and prompts the user to reconnect. Every
// step is guarded and the orchestrator never throws.
//
// Deliberately free of any Obsidian/Electron import so the contract is
// unit-testable with a stub fetcher, like plaud-client-re.ts and
// plaud-refresh-net.ts.

import type { PlaudHttpFetcher } from './plaud-client-re';
import { normalizeTrustedOrigin } from './plaud-refresh-net';
import { readTokenClientId, workspaceIdFromToken } from './plaud-token';
import { redactJwtLike } from './jwt-redact';

const WORKSPACE_REFRESH_PATH_PREFIX = '/user-app/auth/workspace/refresh/';

// Plaud's "success" status in a JSON envelope. Anything else (including -419
// WT_EXPIRED and -420 WRT_EXPIRED) is a failure the caller treats as "reconnect".
const STATUS_OK = 0;

export interface V4RefreshDeps {
	/** The stored workspace token (may be expired). Source of the `wid` to scope against. */
	readonly currentToken: string;
	/** The stored workspace refresh token (typ WRT) to bearer. */
	readonly refreshToken: string;
	/** Current API origin, no trailing slash, e.g. `https://api-test.plaud.ai`. */
	readonly baseUrl: string;
	/** The `x-device-id` header, when the plugin captured one at sign-in. */
	readonly deviceId?: string;
	/** HTTP transport (the plugin passes its requestUrl adapter). */
	readonly fetch: PlaudHttpFetcher;
	/**
	 * Optional diagnostic sink. Only ever receives HTTP status, the envelope's
	 * numeric status, and a short redacted body snippet of a FAILING response;
	 * never a token value.
	 */
	readonly log?: (message: string, payload?: unknown) => void;
}

export interface V4RefreshResult {
	/** The fresh workspace token (typ WT). Caller validates before storing. */
	readonly token: string;
	/**
	 * The ROTATED workspace refresh token. Single-use: the caller must persist
	 * this and bearer it next time, or the next refresh answers -420.
	 */
	readonly refreshToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Parse a JSON envelope, or null when the text is not a JSON object. */
function parseEnvelope(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** A human-readable `message`/`msg` field off an envelope, when present. */
function envelopeMessage(
	envelope: Record<string, unknown>,
): string | undefined {
	if (typeof envelope.message === 'string') return envelope.message;
	if (typeof envelope.msg === 'string') return envelope.msg;
	return undefined;
}

/**
 * First 200 chars of a response body for a failure diagnostic, with any
 * JWT-shaped substring redacted first. A failing refresh response should not
 * carry a token, but redacting guarantees the debug logger's no-secrets contract
 * holds even if one slips into an error body. Mirrors plaud-refresh-net's
 * bodySnippet.
 */
function bodySnippet(text: string): string {
	const redacted = redactJwtLike(text, '[redacted-token]');
	return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted;
}

/**
 * Extract the fresh workspace token AND the rotated refresh token from a refresh
 * response, or null when the envelope is not a success carrying BOTH strings.
 *
 * Both are required. The success contract returns a rotated `refresh_token`
 * every time, so a response missing it is a shape we do not understand; treating
 * it as a success would store a WT with no fresh bearer to renew against next
 * time. Refusing it leaves the previous credential in place to expire normally,
 * which surfaces as the ordinary reconnect prompt. Exported for unit testing.
 */
export function parseV4RefreshResponse(
	envelope: Record<string, unknown>,
): V4RefreshResult | null {
	if (envelope.status !== STATUS_OK) {
		return null;
	}
	const data = envelope.data;
	if (!isRecord(data)) {
		return null;
	}
	const token = data.workspace_token;
	const refresh = data.refresh_token;
	if (
		typeof token !== 'string' ||
		token.length === 0 ||
		typeof refresh !== 'string' ||
		refresh.length === 0
	) {
		return null;
	}
	return { token, refreshToken: refresh };
}

/**
 * Run the cookieless bearer refresh once. Returns a candidate {fresh WT, rotated
 * WRT} (never stores it), or null on any failure so the caller can pause and
 * prompt the user. Never throws (it runs in the background refresh timer).
 */
export async function performV4Refresh(
	deps: V4RefreshDeps,
): Promise<V4RefreshResult | null> {
	// Wrap the injected sink so a throwing logger can never break the "never
	// throws" contract.
	const log = (message: string, payload?: unknown): void => {
		try {
			deps.log?.(message, payload);
		} catch {
			// A logging failure must not propagate into the timer or the sync tick.
		}
	};
	try {
		if (deps.refreshToken.trim().length === 0) {
			log('v4 refresh aborted: no stored workspace refresh token');
			return null;
		}
		const wid = workspaceIdFromToken(deps.currentToken);
		if (wid === null) {
			log('v4 refresh aborted: stored token carries no ws_ workspace id');
			return null;
		}
		// Validate the host BEFORE attaching the bearer: a malformed or tampered
		// stored base must never send the refresh token to a non-Plaud origin.
		const base = normalizeTrustedOrigin(deps.baseUrl);
		if (base === null) {
			log(
				'v4 refresh aborted: stored base URL is not a trusted Plaud host',
				{
					baseUrl: deps.baseUrl,
				},
			);
			return null;
		}
		// app-platform tracks the token's client_id so the server's parse-mode
		// check agrees, matching plaud-client-v4 and plaud-refresh-net.
		const clientId = readTokenClientId(deps.currentToken) ?? 'web';
		const headers: Record<string, string> = {
			accept: 'application/json, text/plain, */*',
			'content-type': 'application/json',
			authorization: `Bearer ${deps.refreshToken.trim()}`,
			'app-platform': clientId,
			'edit-from': clientId,
			'app-language': 'en',
			'x-scope-type': 'workspace',
			'x-scope-id': wid,
		};
		const deviceId = deps.deviceId?.trim();
		if (deviceId !== undefined && deviceId.length > 0) {
			headers['x-device-id'] = deviceId;
		}

		let res;
		try {
			res = await deps.fetch({
				url: `${base}${WORKSPACE_REFRESH_PATH_PREFIX}${wid}`,
				method: 'POST',
				headers,
				body: '{}',
			});
		} catch (err) {
			log('v4 refresh: transport error', {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}

		if (res.status < 200 || res.status >= 300) {
			log('v4 refresh: non-2xx response', {
				httpStatus: res.status,
				body: bodySnippet(res.text ?? ''),
			});
			return null;
		}
		const envelope = parseEnvelope(res.text ?? '');
		if (envelope === null) {
			log('v4 refresh: non-JSON response', {
				httpStatus: res.status,
				body: bodySnippet(res.text ?? ''),
			});
			return null;
		}
		const parsed = parseV4RefreshResponse(envelope);
		if (parsed === null) {
			// -419 WT_EXPIRED / -420 WRT_EXPIRED land here, as does any other
			// non-zero status or a success missing either token.
			log('v4 refresh: non-OK envelope', {
				httpStatus: res.status,
				envelopeStatus: envelope.status,
				message: envelopeMessage(envelope),
			});
			return null;
		}
		log('v4 refresh succeeded via the bearer (cookieless) path');
		return parsed;
	} catch (err) {
		// A refresh bug must never throw into the timer or the auto-sync tick.
		log('v4 refresh threw', {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
