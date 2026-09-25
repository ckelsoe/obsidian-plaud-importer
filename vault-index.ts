// Vault scanner that surfaces which Plaud recordings already have a note
// in the configured output folder. The import modal uses this to render
// an "imported" badge on each recording row, and auto-sync uses it to skip
// re-importing. Re-importing remains possible; the badge is informational.
//
// Dedup keys, in order of confidence (see stable-key.ts):
//   byId       CANONICAL recording id -> note. The primary key, and exact.
//   byInstant  minute-rounded start + duration -> note. Recognizes an
//              already-imported meeting whose id CHANGED (the v4 portal
//              re-issued every id). High confidence: a caller may heal the note.
//   byDay      calendar day + duration -> note. The only key a date-only older
//              note offers. Used to dedup, never to heal.
//
// Canonical id (see canonicalPlaudId): the v4 portal keeps every v3 recording's
// id and exposes it prefixed, so a v4 recording born in v3 has file_id
// `of_<v3id>` and resolves in the v4 API by that exact string. An old note may
// store the bare v3 id (`<v3id>`) or the prefixed form (`of_<v3id>`); both name
// the same recording. Stripping the `of_` prefix collapses them, so a bare-id
// note is recognized as already-imported and matched to its recording EXACTLY,
// with no date guessing. Only `of_` is stripped; `f_`/`f_s_` v4-native ids are
// opaque and compared as-is.
// A fallback key shared by two different notes is disabled (stored as `null`) so
// two meetings can never be merged onto one note.
//
// Implementation notes:
// - We rely on Obsidian's `metadataCache`, a parsed-frontmatter view of every
//   markdown file, which is already warm when the modal opens.
// - The scan is limited to files under the configured output folder.
// - Only notes carrying a `plaud-id` are indexed (this plugin's own notes).

import type { App, TFile } from 'obsidian';
import type { PlaudRecordingId } from './plaud-client';
import {
	stableKeysFromFrontmatter,
	stableKeysFromRecording,
} from './stable-key';
import { trimChars } from './text-trim';

/**
 * Lightweight pointer back to an imported note. The path is the only
 * load-bearing field; `openLinkText` uses it for click-through. `versionMs` is
 * the stored auto-sync cursor (`plaud-version-ms`).
 */
export interface ImportedRecord {
	readonly path: string;
	readonly summaryVersion?: string;
	readonly summaryId?: string;
	readonly versionMs?: number;
	/** The note's own `plaud-id`, so a heal can tell whether it is already the
	 * current id (no rewrite needed) or a stale one. */
	readonly plaudId?: string;
}

/**
 * The vault index: the primary id map plus two id-independent fallback maps.
 * A `null` value in a fallback map marks an AMBIGUOUS key (two notes share it);
 * `findImportedNote` treats that as no match.
 */
export interface ImportedIndex {
	readonly byId: Map<PlaudRecordingId, ImportedRecord>;
	readonly byInstant: Map<string, ImportedRecord | null>;
	readonly byDay: Map<string, ImportedRecord | null>;
}

/** How `findImportedNote` matched, most confident first. */
export type ImportMatch = 'id' | 'instant' | 'day';

/**
 * Collapse a recording id to the form shared by every portal that ever issued
 * it. The v4 portal preserves each v3 recording's id and exposes it as
 * `of_<v3id>`, so a note that stored the bare v3 id (`<v3id>`) and the current
 * v4 recording (`of_<v3id>`) are the same meeting. Stripping the single leading
 * `of_` makes them equal. v4-native ids (`f_...`, `f_s_...`) carry no v3 id and
 * are returned unchanged. Pure and total.
 */
export function canonicalPlaudId(id: string): string {
	return id.startsWith('of_') ? id.slice(3) : id;
}

/** The recording fields the finder needs (a subset of `Recording`). */
export interface RecordingIdentity {
	readonly id: string;
	readonly createdAt: Date;
	readonly durationSeconds: number;
}

function newIndex(): ImportedIndex {
	return {
		byId: new Map<PlaudRecordingId, ImportedRecord>(),
		byInstant: new Map<string, ImportedRecord | null>(),
		byDay: new Map<string, ImportedRecord | null>(),
	};
}

// Add a note under a fallback key, disabling the key (null) if a DIFFERENT note
// already claimed it. The same note re-registering the same key is a no-op.
function addFallback(
	map: Map<string, ImportedRecord | null>,
	key: string | null,
	record: ImportedRecord,
): void {
	if (key === null) return;
	if (!map.has(key)) {
		map.set(key, record);
		return;
	}
	const current = map.get(key);
	if (current && current.path !== record.path) {
		map.set(key, null); // ambiguous: two different notes share this key
	}
}

function recordFromFrontmatter(
	file: TFile,
	rawFm: Record<string, unknown>,
): { id: string; record: ImportedRecord } | null {
	const id = pickFrontmatterString(rawFm['plaud-id']);
	if (id === undefined) return null;
	return {
		id,
		record: {
			path: file.path,
			plaudId: id,
			summaryVersion: pickFrontmatterString(
				rawFm['plaud-summary-version'],
			),
			summaryId: pickFrontmatterString(rawFm['plaud-summary-id']),
			versionMs: pickFrontmatterNumber(rawFm['plaud-version-ms']),
		},
	};
}

function indexNote(
	index: ImportedIndex,
	file: TFile,
	rawFm: Record<string, unknown>,
): void {
	const parsed = recordFromFrontmatter(file, rawFm);
	if (parsed === null) return;
	// Key by the canonical id so a note storing the bare v3 id and a note storing
	// the `of_`-prefixed v4 id land on the same key and both match their recording.
	index.byId.set(
		canonicalPlaudId(parsed.id) as PlaudRecordingId,
		parsed.record,
	);
	const keys = stableKeysFromFrontmatter(rawFm);
	addFallback(index.byInstant, keys.instant, parsed.record);
	addFallback(index.byDay, keys.day, parsed.record);
}

/**
 * Build the vault index by scanning the configured output folder. Called once
 * per modal open and after each import. Never throws: a malformed note is
 * skipped. Returns an empty index when the cache has not warmed yet.
 */
export function buildImportedIndex(
	app: App,
	outputFolder: string,
): ImportedIndex {
	const normalized = normalizeFolder(outputFolder);
	const index = newIndex();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!fileIsUnder(file, normalized)) continue;
		const rawFm: unknown =
			app.metadataCache.getFileCache(file)?.frontmatter;
		if (!isRecord(rawFm)) continue;
		indexNote(index, file, rawFm);
	}
	return index;
}

/**
 * Cold-cache check and index build fused into ONE pass over the output folder.
 * The first in-scope note with a null cache returns `{ isCold: true }` and the
 * partial index is discarded; otherwise the fully built index is returned.
 */
export type OutputFolderIndexState =
	| { readonly isCold: true }
	| { readonly isCold: false; readonly index: ImportedIndex };

export function buildImportedIndexWithColdCheck(
	app: App,
	outputFolder: string,
): OutputFolderIndexState {
	const normalized = normalizeFolder(outputFolder);
	const index = newIndex();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!fileIsUnder(file, normalized)) continue;
		const cache = app.metadataCache.getFileCache(file);
		if (cache === null) return { isCold: true };
		const rawFm: unknown = cache.frontmatter;
		if (!isRecord(rawFm)) continue;
		indexNote(index, file, rawFm);
	}
	return { isCold: false, index };
}

/**
 * Find the existing note for a recording: by id, then by the precise instant
 * key, then by the coarse day key. Returns the match and HOW it matched, or null
 * when the recording is genuinely new. An `instant`/`day` match means the note's
 * stored id is stale (the recording id changed); the caller may heal on an
 * `instant` match (high confidence), never on a `day` match.
 */
const NO_AMBIGUOUS_KEYS: ReadonlySet<string> = new Set<string>();

export function findImportedNote(
	index: ImportedIndex,
	recording: RecordingIdentity,
	// Fuzzy keys carried by more than one recording in the current batch (see
	// recordingAmbiguousKeys). A fuzzy match on such a key cannot tell WHICH
	// recording the note belongs to, so it is skipped: matching would wrongly
	// mark a genuinely new recording as already imported and drop it. The exact
	// canonical-id match is unaffected. Defaults to none, for callers that match
	// a single recording with no batch context.
	ambiguousKeys: ReadonlySet<string> = NO_AMBIGUOUS_KEYS,
): { readonly record: ImportedRecord; readonly matchedBy: ImportMatch } | null {
	const byId = index.byId.get(
		canonicalPlaudId(recording.id) as PlaudRecordingId,
	);
	if (byId !== undefined) {
		return { record: byId, matchedBy: 'id' };
	}
	const keys = stableKeysFromRecording(
		recording.createdAt.getTime(),
		recording.durationSeconds,
	);
	if (keys.instant !== null && !ambiguousKeys.has(keys.instant)) {
		const hit = index.byInstant.get(keys.instant);
		if (hit) return { record: hit, matchedBy: 'instant' };
	}
	if (keys.day !== null && !ambiguousKeys.has(keys.day)) {
		const hit = index.byDay.get(keys.day);
		if (hit) return { record: hit, matchedBy: 'day' };
	}
	return null;
}

/**
 * The fuzzy (instant/day) keys carried by more than one recording in
 * `recordings`. Pass the result to findImportedNote so a fuzzy match is used
 * only when the key identifies exactly one recording; otherwise a genuinely new
 * recording that merely shares a minute-or-day and duration with an imported
 * one would be skipped as already imported. Mirrors the migration planner's
 * one-recording-per-key guard. The exact canonical-id match never depends on
 * this, so a v4 recording that resolves by id is unaffected.
 */
export function recordingAmbiguousKeys(
	recordings: readonly RecordingIdentity[],
): ReadonlySet<string> {
	const counts = new Map<string, number>();
	const bump = (k: string | null): void => {
		if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
	};
	for (const r of recordings) {
		const keys = stableKeysFromRecording(
			r.createdAt.getTime(),
			r.durationSeconds,
		);
		bump(keys.instant);
		bump(keys.day);
	}
	const ambiguous = new Set<string>();
	for (const [key, n] of counts) {
		if (n > 1) {
			ambiguous.add(key);
		}
	}
	return ambiguous;
}

function normalizeFolder(folder: string): string {
	// Match the note writer's normalization: a Windows-style "\Inbox" must
	// resolve to "Inbox" so the imported-note index finds files under the folder
	// Obsidian actually created.
	return trimChars(folder.trim().replace(/\\/g, '/'), '/');
}

function fileIsUnder(file: TFile, folder: string): boolean {
	if (folder === '') {
		return true;
	}
	return file.path.startsWith(`${folder}/`);
}

/**
 * True when the metadata cache has NOT finished parsing the notes under the
 * output folder (at least one in-scope note has a null cache). The index relies
 * on the cache, so a cold cache makes it return empty and every note look new;
 * auto-sync uses this to skip a tick and avoid a mass re-import.
 */
export function outputFolderCacheIsCold(
	app: App,
	outputFolder: string,
): boolean {
	const normalized = normalizeFolder(outputFolder);
	for (const file of app.vault.getMarkdownFiles()) {
		if (!fileIsUnder(file, normalized)) continue;
		if (app.metadataCache.getFileCache(file) === null) return true;
	}
	return false;
}

// Only accept a string frontmatter value (trimmed, non-empty); reject everything
// else so badge state never depends on an ambiguous coercion.
function pickFrontmatterString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// plaud-version-ms is written as a raw number; accept a numeric string too, and
// reject anything non-finite so a malformed marker stays undefined.
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
