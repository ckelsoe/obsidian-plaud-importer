/**
 * Which Plaud platform an account is on, and how the plugin decides it.
 *
 * Plaud runs two platforms behind the same public hosts: Plaud 3.0 (the v3
 * `/file/*` endpoints) and Plaud 4.0 (the `/file-app/v4/*` endpoints). Verified
 * live 2026-09-25: web.plaud.ai serves the 4.0 app or the 3.0 app to the same
 * hostname depending on the account, and both call https://api.plaud.ai.
 *
 * The plugin used to infer the platform from the credential: a workspace id
 * (captured, or the token's own `wid`) meant 4.0. That broke in issue #143,
 * because Plaud now issues workspace tokens to 3.0 accounts too, so a 3.0
 * account was probed only against the 4.0 API and every sign-in was rejected.
 *
 * Now the sign-in probe tries both clients and records which one Plaud
 * accepted (`plaudDetectedVersion`). The user can pin a version in settings
 * (`plaudVersionOverride`) as an escape hatch. This whole module, the setting,
 * and the v3 client go away once Plaud retires 3.0.
 */
import { PlaudApiError } from './plaud-client-re';
import { isCredentialRejection } from './token-candidates';

export type PlaudVersion = 'v3' | 'v4';

/** The settings choice: follow detection, or pin one platform. */
export type PlaudVersionOverride = 'auto' | PlaudVersion;

export function isPlaudVersion(value: unknown): value is PlaudVersion {
	return value === 'v3' || value === 'v4';
}

export function isPlaudVersionOverride(
	value: unknown,
): value is PlaudVersionOverride {
	return value === 'auto' || isPlaudVersion(value);
}

/** Display name for a version, as Plaud itself names it. */
export function plaudVersionLabel(version: PlaudVersion): string {
	return version === 'v4' ? 'Plaud 4.0' : 'Plaud 3.0';
}

/**
 * The platform the plugin should talk to. A pinned override wins. Otherwise the
 * version the last sign-in detected. Otherwise (an install that has not signed
 * in since detection shipped) the old inference, so an upgrade changes nothing
 * until the next sign-in records a real answer.
 */
export function resolvePlaudVersion(
	override: PlaudVersionOverride,
	detected: PlaudVersion | '',
	hasWorkspace: boolean,
): PlaudVersion {
	if (override !== 'auto') {
		return override;
	}
	if (detected !== '') {
		return detected;
	}
	return hasWorkspace ? 'v4' : 'v3';
}

/**
 * The order to probe a sign-in candidate in. A pinned version is the only one
 * tried. On auto, the likelier platform goes first (4.0 when the capture has a
 * workspace) so a 4.0 sign-in still costs one call; the other is the fallback.
 */
export function probeOrder(
	override: PlaudVersionOverride,
	hasWorkspace: boolean,
): readonly PlaudVersion[] {
	if (override !== 'auto') {
		return [override];
	}
	return hasWorkspace ? ['v4', 'v3'] : ['v3', 'v4'];
}

/**
 * True when an error means "this client is the wrong platform for this
 * credential" rather than "Plaud could not be reached". A credential rejection
 * qualifies (a 3.0 account's token is refused by the 4.0 API, and -1800907 is
 * an in-band rejection from the 3.0 API), and so does an HTTP 4xx other than
 * 429. Network faults, 5xx, and rate limits do not: they say nothing about the
 * platform, and trying the other client would only hide the outage.
 */
function isWrongPlatformSignal(err: unknown): boolean {
	if (isCredentialRejection(err)) {
		return true;
	}
	return (
		err instanceof PlaudApiError &&
		err.status !== undefined &&
		err.status >= 400 &&
		err.status < 500 &&
		err.status !== 429
	);
}

/**
 * Runs `attempt` for each version in `order` and resolves with the first one
 * Plaud accepts. Stops early on an error that is not a wrong-platform signal,
 * rethrowing it, so an outage still reads as "unreachable" to the candidate
 * selection. When every version fails, rethrows the first credential
 * rejection if there was one, so the candidate selection moves on to the next
 * candidate instead of treating the run as unreachable.
 */
export async function probeAcrossVersions(
	order: readonly PlaudVersion[],
	attempt: (version: PlaudVersion) => Promise<void>,
): Promise<PlaudVersion> {
	const errors: unknown[] = [];
	for (const version of order) {
		try {
			await attempt(version);
			return version;
		} catch (err) {
			if (!isWrongPlatformSignal(err)) {
				throw err;
			}
			errors.push(err);
		}
	}
	const rejection = errors.find((err) => isCredentialRejection(err));
	throw rejection ?? errors[errors.length - 1];
}
