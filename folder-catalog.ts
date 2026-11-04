// -----------------------------------------------------------------------------
// folder-catalog.ts
//
// Pure helpers for turning Plaud's flat folder/tag catalog into the two things
// the import path needs:
//   1. human folder NAMES for the `plaud-folder:` frontmatter field, and
//   2. valid Obsidian tag tokens for the `tags:` field (issue #16 fixes the
//      latent bug where raw filetag IDs leaked into `tags:`).
//
// The helpers are pure (no I/O, no `obsidian` import): the client fetches
// `GET /filetag/`, and they do the id->name join and the name->tag slug, so
// both are unit testable in isolation. `plaudFolderLoader` at the end is the
// one async piece: the import runner's `loadFolders` hook, which fetches the
// catalog through the client and builds the resolver from these helpers.
// -----------------------------------------------------------------------------

import {
	type FolderResolver,
	type ImportDebugLog,
	trimChars,
} from 'obsidian-recording-importer-core';
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
	return trimChars(
		name
			.toLowerCase()
			.replace(/[^\p{L}\p{N}_]+/gu, '-')
			.replace(/-+/g, '-'),
		'-',
	);
}

/**
 * A recording's location when it sits in a Plaud SYSTEM bucket rather than a real
 * user folder. Keyed on `Recording.systemFolderType` (v4
 * `parent_folder.system_folder_type`): the three known built-in buckets get a
 * plain status word; any other nonzero type falls back to Plaud's own folder name
 * (never a guessed label), or `system` when that name is blank. Only called for a
 * nonzero type; a real folder (0 or undefined) uses `plaud-folder` + a tag
 * instead. Written to the note's `plaud-location` frontmatter.
 */
export function normalizePlaudLocation(
	systemFolderType: number,
	folderName?: string,
): string {
	switch (systemFolderType) {
		case 1:
			return 'unfiled';
		case 2:
			return 'import';
		case 5:
			return 'conflict';
		default: {
			const name = (folderName ?? '').trim();
			return name.length > 0 ? name : 'system';
		}
	}
}

/**
 * Plaud's `loadFolders` hook for the import runner: fetches the catalog once
 * per run, then resolves each recording's `filetag_id_list` to folder names,
 * folder tags and, for a system bucket, a `plaud-location`.
 */
export function plaudFolderLoader(
	fetchCatalog: () => Promise<readonly PlaudFolder[]>,
): (log: ImportDebugLog) => Promise<FolderResolver> {
	return async (log) => {
		// Best-effort: a fetch failure degrades to an empty map, so notes just
		// carry no folder data rather than the import failing. A system bucket
		// still gets its location from systemFolderType alone. This also fixes
		// the latent bug where raw filetag ids leaked into `tags:`: names
		// replace ids, and an unresolved id is dropped, never shown raw.
		let folderNameMap: ReadonlyMap<string, string> = new Map();
		try {
			folderNameMap = buildFolderNameMap(await fetchCatalog());
		} catch (err) {
			log('folder catalog fetch failed; folders unresolved', {
				reason: err instanceof Error ? err.message : String(err),
			});
		}
		return (recording) => {
			// Empty-after-slug names (a punctuation-only folder) are filtered.
			const { names: folderNames, missing: missingFolderIds } =
				resolveFolderNames(recording.tags, folderNameMap);
			if (missingFolderIds.length > 0) {
				log(
					'folder ids not in catalog; dropped from tags/plaud-folder',
					{
						recordingId: recording.id,
						missing: missingFolderIds,
					},
				);
			}
			// A recording in a Plaud SYSTEM bucket (nonzero system_folder_type) is
			// not filed in a real folder: record its location
			// (unfiled/import/conflict) as plaud-location and emit no folder tag or
			// plaud-folder, so the default "Recordings" bucket never becomes a
			// `#recordings` tag. A real folder (0/undefined, incl. every v3
			// recording) keeps the folder tag + plaud-folder unchanged. The two
			// keys are mutually exclusive; folderNames still feeds the location
			// label (an unknown system type falls back to Plaud's own name).
			const isSystemFolder =
				typeof recording.systemFolderType === 'number' &&
				recording.systemFolderType !== 0;
			if (isSystemFolder) {
				const location = normalizePlaudLocation(
					recording.systemFolderType,
					folderNames[0],
				);
				return {
					location: location.length > 0 ? location : undefined,
					tags: [],
				};
			}
			return {
				names: folderNames,
				tags: folderNames
					.map(folderNameToTag)
					.filter((tag) => tag.length > 0),
			};
		};
	};
}
