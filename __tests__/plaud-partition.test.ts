import type { App } from 'obsidian';
import { clearPlaudLoginSession } from '../plaud-login';
import {
	isLegacyPartition,
	LEGACY_PLAUD_PARTITION,
	plaudPartition,
} from '../plaud-partition';
import { buildPartitionPost } from '../plaud-refresh-net';

// Two real Obsidian vault ids, measured 2026-07-31 from two vaults open at the
// same time. Used as fixtures rather than invented strings so the shape the code
// meets in the field is the shape under test.
const VAULT_A = '624a1da862f9179f';
const VAULT_B = '0bb8309763b6e8a9';

describe('plaudPartition', () => {
	it('derives a distinct partition per vault', () => {
		expect(plaudPartition(VAULT_A)).toBe(`${LEGACY_PLAUD_PARTITION}-${VAULT_A}`);
		expect(plaudPartition(VAULT_A)).not.toBe(plaudPartition(VAULT_B));
	});

	it('is stable for the same vault id', () => {
		expect(plaudPartition(VAULT_A)).toBe(plaudPartition(VAULT_A));
	});

	it('never returns the shared partition for a usable vault id', () => {
		for (const id of [VAULT_A, VAULT_B, 'a', 'A_b-9', 'x'.repeat(64)]) {
			expect(isLegacyPartition(plaudPartition(id))).toBe(false);
		}
	});

	// The fallback is deliberate: degrading to the pre-#87 shared partition is a
	// known, survivable state, whereas refusing to produce a partition name would
	// leave the user unable to sign in at all.
	it('falls back to the shared partition when the vault id is unusable', () => {
		const unusable: unknown[] = [
			undefined,
			null,
			'',
			'   ',
			'has space',
			'has/slash',
			'has:colon',
			'x'.repeat(65),
			42,
			{},
			[],
		];
		for (const id of unusable) {
			expect(plaudPartition(id)).toBe(LEGACY_PLAUD_PARTITION);
		}
	});

	// A path separator or scheme character reaching a partition name would be a
	// surprising value at best; the validator rejects rather than sanitizes.
	it('does not sanitize an unsafe id into a usable partition', () => {
		expect(plaudPartition('../../evil')).toBe(LEGACY_PLAUD_PARTITION);
		expect(plaudPartition('persist:other')).toBe(LEGACY_PLAUD_PARTITION);
	});

	it('identifies the legacy partition', () => {
		expect(isLegacyPartition(LEGACY_PLAUD_PARTITION)).toBe(true);
		expect(isLegacyPartition(plaudPartition(VAULT_A))).toBe(false);
	});
});

// --- The #87 regression guard ---------------------------------------------
//
// Sign-in populates a partition and renewal authenticates against one. Before
// this change each module held its own copy of the partition constant, so the
// two could drift apart silently: renewal would look in an empty cookie jar and
// every cycle would fail as though the session had died. These tests pin the
// property that matters, that a given vault resolves to exactly one jar and that
// two vaults never share one.

interface FetchCall {
	partition: string;
	url: string;
}

/**
 * Install a fake Electron whose `session.fromPartition` records which partition
 * each request was routed to. Returns the recorded calls.
 */
function installFakeElectron(): FetchCall[] {
	const calls: FetchCall[] = [];
	const win = window as unknown as { require: (id: string) => unknown };
	win.require = () => ({
		remote: {
			session: {
				fromPartition: (partition: string) => ({
					fetch: (url: string) => {
						calls.push({ partition, url });
						return Promise.resolve({
							status: 200,
							text: () => Promise.resolve('{"status":0}'),
						});
					},
				}),
			},
		},
	});
	return calls;
}

describe('per-vault partition routing (issue #87)', () => {
	afterEach(() => {
		delete (window as unknown as { require?: unknown }).require;
	});

	it('routes a vault\'s renewal at that vault\'s own partition', async () => {
		const calls = installFakeElectron();
		const post = buildPartitionPost(plaudPartition(VAULT_A));
		expect(post).not.toBeNull();
		await post?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {});
		expect(calls).toHaveLength(1);
		expect(calls[0].partition).toBe(plaudPartition(VAULT_A));
	});

	// The actual bug: two vaults renewing at once. Before the fix both landed on
	// one shared jar and rotated the same underlying credential, so whichever
	// finished second found its value already replaced and reported a false
	// failure. Concurrent here, not sequential, because sequential calls would
	// pass even if the partition were a shared mutable global.
	it('keeps two vaults renewing concurrently in separate jars', async () => {
		const calls = installFakeElectron();
		const postA = buildPartitionPost(plaudPartition(VAULT_A));
		const postB = buildPartitionPost(plaudPartition(VAULT_B));

		await Promise.all([
			postA?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {}),
			postB?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {}),
		]);

		const partitions = calls.map((c) => c.partition);
		expect(partitions).toHaveLength(2);
		expect(new Set(partitions).size).toBe(2);
		expect(partitions).toContain(plaudPartition(VAULT_A));
		expect(partitions).toContain(plaudPartition(VAULT_B));
		// Neither vault touched the pre-#87 shared jar.
		expect(partitions).not.toContain(LEGACY_PLAUD_PARTITION);
	});

	// Two vaults that BOTH fail to get a usable id share the legacy partition,
	// which is the pre-#87 behavior. Pinned so the fallback's blast radius is a
	// deliberate, visible choice rather than an accident.
	it('shares the legacy partition only when no vault id is usable', async () => {
		const calls = installFakeElectron();
		const postA = buildPartitionPost(plaudPartition(undefined));
		const postB = buildPartitionPost(plaudPartition(undefined));
		await Promise.all([
			postA?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {}),
			postB?.('https://api.plaud.ai/auth/refresh-user-token', '{}', {}),
		]);
		expect(new Set(calls.map((c) => c.partition))).toEqual(
			new Set([LEGACY_PLAUD_PARTITION]),
		);
	});

	it('reports unavailable when the Electron surface is missing', () => {
		expect(buildPartitionPost(plaudPartition(VAULT_A))).toBeNull();
	});
});

// --- Sign-out scope --------------------------------------------------------

/**
 * Fake Electron recording which partitions had their storage cleared. Optionally
 * makes a named partition's clear reject, to exercise the best-effort path.
 */
function installClearRecorder(failOn?: string): string[] {
	const cleared: string[] = [];
	const win = window as unknown as { require: (id: string) => unknown };
	win.require = () => ({
		remote: {
			session: {
				fromPartition: (partition: string) => ({
					clearStorageData: () => {
						if (partition === failOn) {
							return Promise.reject(new Error('nope'));
						}
						cleared.push(partition);
						return Promise.resolve();
					},
					clearCache: () => Promise.resolve(),
				}),
			},
		},
	});
	return cleared;
}

describe('clearPlaudLoginSession scope (issue #87)', () => {
	afterEach(() => {
		delete (window as unknown as { require?: unknown }).require;
	});

	it('clears this vault\'s partition, not another vault\'s', async () => {
		const cleared = installClearRecorder();
		await clearPlaudLoginSession({ appId: VAULT_A } as unknown as App);
		expect(cleared).toContain(plaudPartition(VAULT_A));
		expect(cleared).not.toContain(plaudPartition(VAULT_B));
	});

	// The leftover shared session holds a refresh token good for up to 30 days
	// and nothing else in the plugin can reach it, so an explicit sign-out is its
	// only route out. Without this the credential would sit on disk until it
	// expired, with no way to remove it from the UI.
	it('clears the pre-#87 shared partition when explicitly asked to', async () => {
		const cleared = installClearRecorder();
		await clearPlaudLoginSession({ appId: VAULT_A } as unknown as App, {
			includeLegacyShared: true,
		});
		expect(cleared).toContain(LEGACY_PLAUD_PARTITION);
	});

	// The reconnect path clears the session only to force a fresh sign-in screen.
	// If that also wiped the shared leftover, one vault recovering its own
	// session would sign out a sibling vault still on an older build. Sign-out
	// may do that; recovery must not. This is the default, so forgetting the flag
	// fails safe.
	it('leaves the shared partition alone by default', async () => {
		const cleared = installClearRecorder();
		await clearPlaudLoginSession({ appId: VAULT_A } as unknown as App);
		expect(cleared).toEqual([plaudPartition(VAULT_A)]);
		expect(cleared).not.toContain(LEGACY_PLAUD_PARTITION);
	});

	// The vault's own sign-out is the promise the button makes; a leftover that
	// refuses to clear must not break it.
	it('still signs this vault out when the leftover refuses to clear', async () => {
		const cleared = installClearRecorder(LEGACY_PLAUD_PARTITION);
		await expect(
			clearPlaudLoginSession({ appId: VAULT_A } as unknown as App, {
				includeLegacyShared: true,
			}),
		).resolves.toBe(true);
		expect(cleared).toContain(plaudPartition(VAULT_A));
		expect(cleared).not.toContain(LEGACY_PLAUD_PARTITION);
	});

	// A vault that fell back to the legacy partition already cleared it as its
	// own session; it must not be cleared twice.
	it('does not double-clear when the vault fell back to the legacy partition', async () => {
		const cleared = installClearRecorder();
		await clearPlaudLoginSession({} as unknown as App, {
			includeLegacyShared: true,
		});
		expect(cleared).toEqual([LEGACY_PLAUD_PARTITION]);
	});

	it('reports nothing cleared when the Electron surface is missing', async () => {
		await expect(
			clearPlaudLoginSession({ appId: VAULT_A } as unknown as App),
		).resolves.toBe(false);
	});
});
