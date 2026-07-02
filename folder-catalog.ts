// -----------------------------------------------------------------------------
// folder-catalog.ts
//
// Pure helpers for turning Plaud's flat folder/tag catalog into the two things
// the import path needs:
//   1. human folder NAMES for the `plaud-folder:` frontmatter field, and
//   2. valid Obsidian tag tokens for the `tags:` field (issue #16 fixes the
//      latent bug where raw filetag IDs leaked into `tags:`).
//
// No I/O and no `obsidian` import: the client fetches `GET /filetag/`, these
// functions do the id->name join and the name->tag slug so both are unit
// testable in isolation. Phase 4 (folder mirroring) will extend this module
// with the reverse name->id direction.
// -----------------------------------------------------------------------------

import type { PlaudFolder } from './plaud-client';

/**
 * Index a folder catalog by id for O(1) name lookup. Built once per import run
 * (the catalog is small) and reused across every recording. First occurrence
 * wins if Plaud ever returns a duplicate id, so the map is deterministic.
 */
export function buildFolderNameMap(
	catalog: readonly PlaudFolder[],
): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	for (const folder of catalog) {
		if (folder.id.length === 0 || map.has(folder.id)) {
			continue;
		}
		map.set(folder.id, folder.name);
	}
	return map;
}

/**
 * Resolve a recording's `filetag_id_list` to folder names using a prebuilt
 * name map. Duplicate ids and duplicate resolved names collapse (a note should
 * never show `[Work, Work]`), preserving first-seen order. Ids with no catalog
 * entry are dropped from `names` and returned in `missing` so the caller can
 * debug-log them. A miss means the id has no name to show, so surfacing the
 * raw id would just reintroduce the bug this feature fixes.
 */
export function resolveFolderNames(
	ids: readonly string[] | undefined,
	nameMap: ReadonlyMap<string, string>,
): { names: string[]; missing: string[] } {
	const names: string[] = [];
	const missing: string[] = [];
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	for (const id of ids ?? []) {
		if (typeof id !== 'string' || id.length === 0 || seenIds.has(id)) {
			continue;
		}
		seenIds.add(id);
		const name = nameMap.get(id);
		if (name === undefined) {
			missing.push(id);
			continue;
		}
		// A resolvable id with a blank name (an unnamed Plaud folder) has nothing
		// to show: skip it silently rather than emit an empty `plaud-folder`
		// entry or a bare dash tag. Not a "miss": the id did resolve.
		if (name.trim().length === 0 || seenNames.has(name)) {
			continue;
		}
		seenNames.add(name);
		names.push(name);
	}
	return { names, missing };
}

/**
 * Convert a folder name into a single valid Obsidian tag token. Obsidian tags
 * allow letters, numbers, and `_`; spaces and other punctuation are not valid
 * inside a tag, so a raw name like `"B&B"` or `"Daily Journal"` would break the
 * tag pane. Runs of any non-tag character collapse to a single dash, dashes are
 * de-duplicated, and leading/trailing dashes are trimmed. Unicode letters and
 * digits are preserved (Obsidian tags accept them). Returns `''` when nothing
 * usable remains (e.g. a name of only punctuation); callers filter those out.
 *
 *   "Daily Journal" -> "daily-journal"
 *   "B&B"           -> "b-b"
 *   "  Work  "      -> "work"
 */
export function folderNameToTag(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}
