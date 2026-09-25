/**
 * Issue #143: a Plaud 3.0 account signed in with a workspace token, so the
 * plugin probed it only against the 4.0 API and every sign-in was rejected.
 * These pin how the platform is now chosen and probed.
 */
import {
	isPlaudVersion,
	isPlaudVersionOverride,
	probeAcrossVersions,
	probeOrder,
	resolvePlaudVersion,
	type PlaudVersion,
} from '../plaud-version';
import { PlaudApiError, PlaudAuthError } from '../plaud-client-re';
import { asyncResult } from './helpers/async-result';

const rejected = (): PlaudAuthError =>
	new PlaudAuthError('token_rejected', 'rejected', '/x');
// What the 3.0 API answers for an account that moved to 4.0 (HTTP 200).
const movedToV4 = (): PlaudApiError =>
	new PlaudApiError('in-band', undefined, '/file/simple/web', -1800907);
const network = (): PlaudApiError =>
	new PlaudApiError('network down', undefined, '/x');

/** Runs probeAcrossVersions over scripted per-version outcomes. */
async function probe(
	order: readonly PlaudVersion[],
	outcomes: Partial<Record<PlaudVersion, Error>>,
): Promise<{ result: PlaudVersion | Error; tried: PlaudVersion[] }> {
	const tried: PlaudVersion[] = [];
	try {
		const result = await probeAcrossVersions(order, (version) =>
			asyncResult(() => {
				tried.push(version);
				const err = outcomes[version];
				if (err !== undefined) {
					throw err;
				}
			}),
		);
		return { result, tried };
	} catch (err) {
		return { result: err as Error, tried };
	}
}

describe('resolvePlaudVersion', () => {
	it('uses a pinned version whatever was detected', () => {
		expect(resolvePlaudVersion('v3', 'v4', true)).toBe('v3');
		expect(resolvePlaudVersion('v4', 'v3', false)).toBe('v4');
	});

	it('follows the detected version on auto, even against the workspace', () => {
		// The #143 account: a workspace token, but Plaud 3.0.
		expect(resolvePlaudVersion('auto', 'v3', true)).toBe('v3');
		expect(resolvePlaudVersion('auto', 'v4', false)).toBe('v4');
	});

	it('falls back to the old workspace inference when nothing was detected', () => {
		// An install upgraded from before detection keeps its behavior.
		expect(resolvePlaudVersion('auto', '', true)).toBe('v4');
		expect(resolvePlaudVersion('auto', '', false)).toBe('v3');
	});
});

describe('probeOrder', () => {
	it('tries only the pinned version', () => {
		expect(probeOrder('v3', true)).toEqual(['v3']);
		expect(probeOrder('v4', false)).toEqual(['v4']);
	});

	it('tries the likelier version first on auto, then the other', () => {
		expect(probeOrder('auto', true)).toEqual(['v4', 'v3']);
		expect(probeOrder('auto', false)).toEqual(['v3', 'v4']);
	});
});

describe('probeAcrossVersions', () => {
	it('returns the first version Plaud accepts without trying the rest', async () => {
		const run = await probe(['v4', 'v3'], {});
		expect(run.result).toBe('v4');
		expect(run.tried).toEqual(['v4']);
	});

	it('falls back to 3.0 when the 4.0 API rejects a 3.0 account (#143)', async () => {
		const run = await probe(['v4', 'v3'], { v4: rejected() });
		expect(run.result).toBe('v3');
		expect(run.tried).toEqual(['v4', 'v3']);
	});

	it('falls back to 4.0 when the 3.0 API says the account moved', async () => {
		const run = await probe(['v3', 'v4'], { v3: movedToV4() });
		expect(run.result).toBe('v4');
	});

	it('falls back on an HTTP 4xx from the wrong platform', async () => {
		const run = await probe(['v4', 'v3'], {
			v4: new PlaudApiError('HTTP 404', 404, '/x'),
		});
		expect(run.result).toBe('v3');
	});

	it('stops on a network fault instead of hiding it behind the other platform', async () => {
		const err = network();
		const run = await probe(['v4', 'v3'], { v4: err });
		expect(run.result).toBe(err);
		expect(run.tried).toEqual(['v4']);
	});

	it('does not treat a rate limit as a wrong-platform signal', async () => {
		const err = new PlaudApiError('HTTP 429', 429, '/x');
		const run = await probe(['v4', 'v3'], { v4: err });
		expect(run.result).toBe(err);
		expect(run.tried).toEqual(['v4']);
	});

	it('rethrows a credential rejection when both platforms fail, so the next candidate is tried', async () => {
		const first = new PlaudApiError('HTTP 403', 403, '/x');
		const second = rejected();
		const run = await probe(['v4', 'v3'], { v4: first, v3: second });
		expect(run.result).toBe(second);
	});

	it('rethrows the last error when neither failure was a rejection', async () => {
		const last = new PlaudApiError('HTTP 404', 404, '/y');
		const run = await probe(['v4', 'v3'], {
			v4: new PlaudApiError('HTTP 403', 403, '/x'),
			v3: last,
		});
		expect(run.result).toBe(last);
	});

	it('reports the outage when the fallback platform cannot be reached', async () => {
		const outage = network();
		const run = await probe(['v4', 'v3'], { v4: rejected(), v3: outage });
		expect(run.result).toBe(outage);
	});
});

describe('stored value guards', () => {
	it('accept only known values', () => {
		expect(isPlaudVersion('v3')).toBe(true);
		expect(isPlaudVersion('')).toBe(false);
		expect(isPlaudVersion('v5')).toBe(false);
		expect(isPlaudVersionOverride('auto')).toBe(true);
		expect(isPlaudVersionOverride('v4')).toBe(true);
		expect(isPlaudVersionOverride(null)).toBe(false);
	});
});
