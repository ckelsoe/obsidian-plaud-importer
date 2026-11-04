/**
 * The stored names one importer writes into users' notes: frontmatter keys,
 * the managed-block markers, the transcript-file marker, the chapters block id
 * and the AI-keyword tag namespace all derive from `keyPrefix`. Notes already
 * on disk carry these names, so a shipped service must never change them.
 */
export interface ServiceProfile {
	/** Prefix of every frontmatter key, marker and tag this importer writes. */
	readonly keyPrefix: string;
	/** Plugin id, written into the managed transcript file's marker. */
	readonly pluginId: string;
	/** Collapses alternative spellings of one recording id to a single key. */
	readonly canonicalId: (id: string) => string;
}
