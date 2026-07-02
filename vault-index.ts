// Vault scanner that surfaces which Plaud recordings already have a note
// in the configured output folder. The import modal uses this to render
// an "imported" badge on each recording row. Re-importing remains
// possible — the badge is purely informational and never blocks the
// existing duplicate-policy flow.
//
// Implementation notes:
// - We rely on Obsidian's `metadataCache`, which keeps a parsed YAML
//   frontmatter view of every markdown file in the vault. This is far
//   cheaper than reading file bytes ourselves, and the cache is already
//   warm by the time the import modal opens.
// - The scan is limited to files under the configured output folder.
//   Notes that live elsewhere (older imports written to a different
//   folder, hand-moved files) are intentionally NOT discovered. The
//   alternative — scanning every markdown file in the vault — would
//   bloat the badge logic and surface stale matches that the writer
//   wouldn't actually clash with anyway.
// - Returned data is a flat Map keyed by recording id. If the same
//   `plaud-id` appears in multiple files (a legacy duplication bug or
//   user copy-paste), the LAST entry wins; this is fine for the badge
//   use-case because the writer's collision check already refuses to
//   silently overwrite a note that belongs to a different recording.

import type { App, TFile } from 'obsidian';
import type { PlaudRecordingId } from './plaud-client';

/**
 * Lightweight pointer back to an imported note. The path is the only
 * load-bearing field — `openLinkText` uses it for click-through.
 * `versionMs` is the stored auto-sync cursor (`plaud-version-ms`): a listed
 * recording whose `version_ms` exceeds it is a CHANGED note to re-import; a
 * missing `versionMs` is treated as current (no re-import) so enabling
 * auto-sync never mass-overwrites a pre-existing library.
 */
export interface ImportedRecord {
	readonly path: string;
	readonly summaryVersion?: string;
	readonly summaryId?: string;
	readonly versionMs?: number;
}

/**
 * Build a map of `plaud-id` → existing note location by scanning the
 * configured output folder. Caller invokes this once per modal open
 * (and again after every successful import) so the badge state stays
 * in sync without re-reading files.
 *
 * Folder filter rules:
 * - `''` (vault root) matches every markdown file at depth 0.
 * - A nested folder matches itself and all descendants (`folder/sub/...`).
 * - Files outside the folder are skipped.
 *
 * Never throws: a malformed frontmatter entry is silently skipped so a
 * single bad note can never prevent the rest of the index from
 * building. Returns an empty map when the cache has not warmed yet —
 * the modal can call again later if it needs.
 */
export function buildPlaudIdIndex(
	app: App,
	outputFolder: string,
): Map<PlaudRecordingId, ImportedRecord> {
	const normalized = normalizeFolder(outputFolder);
	const out = new Map<PlaudRecordingId, ImportedRecord>();
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (!fileIsUnder(file, normalized)) continue;
		const cache = app.metadataCache.getFileCache(file);
		const rawFm: unknown = cache?.frontmatter;
		if (!isRecord(rawFm)) continue;
		const id = pickFrontmatterString(rawFm['plaud-id']);
		if (id === undefined) continue;
		const record: ImportedRecord = {
			path: file.path,
			summaryVersion: pickFrontmatterString(rawFm['plaud-summary-version']),
			summaryId: pickFrontmatterString(rawFm['plaud-summary-id']),
			versionMs: pickFrontmatterNumber(rawFm['plaud-version-ms']),
		};
		out.set(id as PlaudRecordingId, record);
	}
	return out;
}

function normalizeFolder(folder: string): string {
	// Match the note writer's normalization: a Windows-style "\Inbox" must
	// resolve to "Inbox" so the imported-note index finds files under the
	// folder Obsidian actually created. See normalizeFolderPath in
	// note-writer.ts for the underlying createFolder/getFolderByPath mismatch.
	const trimmed = folder
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	return trimmed;
}

function fileIsUnder(file: TFile, folder: string): boolean {
	if (folder === '') {
		return true;
	}
	const prefix = `${folder}/`;
	return file.path.startsWith(prefix);
}

/**
 * True when the metadata cache has NOT finished parsing the notes under the
 * output folder, i.e. at least one note there has no parsed cache yet
 * (getFileCache === null). buildPlaudIdIndex relies on the cache, so a cold
 * cache makes it return empty and every note look new; auto-sync uses this to
 * skip that tick and avoid a mass re-import.
 *
 * It checks cache warmth per file (any note under the folder with a null
 * cache), not "the folder has any markdown". Every note under the folder
 * counts, Plaud or not, which is correct: if ANY in-scope note is still
 * unparsed the cache is not ready and buildPlaudIdIndex is unreliable. For a
 * root output folder ('') "under the folder" means the whole vault, so a single
 * unparsed note anywhere reports cold until the vault finishes loading. Once
 * every in-scope note is parsed it returns false, so it cannot permanently
 * disable sync. Uses the SAME folder normalization + matching as the index
 * (Windows backslashes included). Returns false when the folder has no notes.
 */
export function outputFolderCacheIsCold(app: App, outputFolder: string): boolean {
	const normalized = normalizeFolder(outputFolder);
	// Single pass: this runs every auto-sync tick and, for a root output folder,
	// scans the whole vault. Return as soon as an in-scope note has a null cache;
	// falling through the loop covers both "no in-scope notes" and "all warm".
	for (const file of app.vault.getMarkdownFiles()) {
		if (!fileIsUnder(file, normalized)) continue;
		if (app.metadataCache.getFileCache(file) === null) return true;
	}
	return false;
}

// YAML frontmatter values can be parsed as strings or as numbers
// depending on shape. Only accept strings (after trim + non-empty
// check); reject everything else so badge state never depends on an
// ambiguous coercion.
function pickFrontmatterString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// plaud-version-ms is written as a raw number, so metadataCache usually
// surfaces it as a number. Accept a numeric string too (a user or a YAML
// quirk could quote it), and reject anything non-finite so a malformed marker
// stays undefined (treated as "current", never a spurious re-import).
function pickFrontmatterNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string') {
		const n = Number(value.trim());
		return value.trim().length > 0 && Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
