// The Plaud sign-in partition name, per vault.
//
// One definition, imported by BOTH plaud-login.ts (which populates the
// partition) and plaud-refresh-net.ts (which authenticates against it). They
// previously each held their own copy of the constant, deliberately, so that
// neither module imported the other. That was a latent trap: the two copies had
// to be edited together or refresh would authenticate against a different cookie
// jar than sign-in had populated, and nothing would catch the mismatch until a
// renewal failed in the field. This module is the shared definition instead, and
// it imports nothing, so the original "no cross-import" reason still holds.
//
// WHY PER VAULT (issue #87): the partition belongs to the Obsidian installation,
// not to any one vault. Every vault's plugin instance therefore shared a single
// browser session while keeping its own workspace token (in secret storage) and
// its own renewal schedule. Two vaults renewing at once rotated the same
// underlying credential, and whichever finished second found the value it was
// holding already replaced and reported a false renewal failure. Sharing also
// meant the one session held whichever Plaud account signed in most recently, so
// two vaults on two accounts were already ambiguous before renewal existed.
//
// Measured 2026-07-31 before committing to this design: Plaud permits two
// concurrent sessions on one account, each rotating independently, verified at
// +0, +11 minutes and +23.5 hours. Per-vault sessions are therefore real
// sessions, not a client-side fiction.
//
// NOT a migration. A sign-in after this change writes its cookies straight into
// the vault's own partition; nothing is ever copied between partitions. Existing
// users sign in once more per vault, which is the tradeoff issue #87 records.
// Copying the old session into a new partition was considered and rejected: two
// vaults holding copies of one refresh token is one session in two jars, not two
// sessions, and the first to rotate would invalidate the other, reproducing this
// very bug at upgrade time.

/**
 * The pre-#87 installation-wide partition. Still referenced so the plugin can
 * recognise an old session's storage, never as a target for new sign-ins except
 * through the fallback below.
 */
export const LEGACY_PLAUD_PARTITION = 'persist:plaud-importer';

// Obsidian's own vault id is 16 lowercase hex characters, but the value is read
// from the host at runtime rather than computed here, so it is validated rather
// than trusted. Kept deliberately wider than hex: the goal is to reject anything
// that could make a surprising partition name, not to pin Obsidian's current
// format and break when it changes.
const SAFE_APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The sign-in partition for the vault identified by `appId`.
 *
 * `appId` is Obsidian's per-vault id (`app.appId`), which is the key the vault
 * is filed under in Obsidian's own vault registry. Measured 2026-07-31: it is a
 * stored random value rather than a hash of the vault path, it differs between
 * two vaults open at once, and it survives a restart unchanged. It was chosen
 * over generating a UUID into the plugin's own `data.json` because a UUID is
 * copied along when a user duplicates a vault folder, which would put both
 * copies back on one partition and reproduce #87 in exactly the case that
 * matters; a duplicated folder gets a distinct appId.
 *
 * Falls back to the legacy installation-wide partition when `appId` is missing
 * or unusable. That is deliberate: the fallback degrades to the pre-#87 shared
 * behavior, which is a known and survivable state, whereas refusing to produce a
 * partition would leave the user unable to sign in at all. A vault that falls
 * back does not collide with a vault that does not.
 */
export function plaudPartition(appId: unknown): string {
	if (typeof appId !== 'string' || !SAFE_APP_ID.test(appId)) {
		return LEGACY_PLAUD_PARTITION;
	}
	return `${LEGACY_PLAUD_PARTITION}-${appId}`;
}

/**
 * True when `partition` is the legacy shared one, i.e. when `plaudPartition`
 * could not derive a per-vault name. Call sites use this to log the degraded
 * state rather than to change behavior.
 */
export function isLegacyPartition(partition: string): boolean {
	return partition === LEGACY_PLAUD_PARTITION;
}
