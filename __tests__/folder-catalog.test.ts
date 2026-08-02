import {
	buildFolderNameMap,
	folderNameToTag,
	resolveFolderNames,
} from '../folder-catalog';
import type { PlaudFolder } from '../plaud-client';

const CATALOG: readonly PlaudFolder[] = [
	{ id: 'id-work', name: 'Work', icon: 'e644', color: '#fff' },
	{ id: 'id-journal', name: 'Daily Journal' },
	{ id: 'id-bnb', name: 'B&B' },
];

describe('buildFolderNameMap', () => {
	it('indexes the catalog by id', () => {
		const map = buildFolderNameMap(CATALOG);
		expect(map.get('id-work')).toBe('Work');
		expect(map.get('id-journal')).toBe('Daily Journal');
		expect(map.size).toBe(3);
	});

	it('skips entries with an empty id', () => {
		const map = buildFolderNameMap([
			{ id: '', name: 'Orphan' },
			...CATALOG,
		]);
		expect(map.has('')).toBe(false);
		expect(map.size).toBe(3);
	});

	it('keeps the first name when an id repeats', () => {
		const map = buildFolderNameMap([
			{ id: 'dup', name: 'First' },
			{ id: 'dup', name: 'Second' },
		]);
		expect(map.get('dup')).toBe('First');
	});

	it('returns an empty map for an empty catalog', () => {
		expect(buildFolderNameMap([]).size).toBe(0);
	});
});

describe('resolveFolderNames', () => {
	const map = buildFolderNameMap(CATALOG);

	it('resolves a hit to its name', () => {
		const { names, missing } = resolveFolderNames(['id-work'], map);
		expect(names).toEqual(['Work']);
		expect(missing).toEqual([]);
	});

	it('reports a miss and drops it from names', () => {
		const { names, missing } = resolveFolderNames(['id-gone'], map);
		expect(names).toEqual([]);
		expect(missing).toEqual(['id-gone']);
	});

	it('handles a mix of hits and misses, preserving order', () => {
		const { names, missing } = resolveFolderNames(
			['id-journal', 'id-gone', 'id-work'],
			map,
		);
		expect(names).toEqual(['Daily Journal', 'Work']);
		expect(missing).toEqual(['id-gone']);
	});

	it('returns empty results for undefined or empty ids', () => {
		expect(resolveFolderNames(undefined, map)).toEqual({
			names: [],
			missing: [],
		});
		expect(resolveFolderNames([], map)).toEqual({ names: [], missing: [] });
	});

	it('collapses a repeated id and skips empty/non-string ids', () => {
		const { names, missing } = resolveFolderNames(
			['id-work', 'id-work', '', 'id-work'],
			map,
		);
		expect(names).toEqual(['Work']);
		expect(missing).toEqual([]);
	});

	it('skips a resolvable id whose folder name is blank (not a miss)', () => {
		const blankMap = buildFolderNameMap([{ id: 'blank', name: '   ' }]);
		const { names, missing } = resolveFolderNames(['blank'], blankMap);
		expect(names).toEqual([]);
		expect(missing).toEqual([]);
	});

	it('collapses two ids that resolve to the same name', () => {
		const twinMap = buildFolderNameMap([
			{ id: 'a', name: 'Same' },
			{ id: 'b', name: 'Same' },
		]);
		const { names } = resolveFolderNames(['a', 'b'], twinMap);
		expect(names).toEqual(['Same']);
	});
});

describe('folderNameToTag', () => {
	it('lowercases and dashes spaces', () => {
		expect(folderNameToTag('Daily Journal')).toBe('daily-journal');
	});

	it('replaces invalid tag characters (& etc.) with a dash', () => {
		expect(folderNameToTag('B&B')).toBe('b-b');
	});

	it('trims leading and trailing separators', () => {
		expect(folderNameToTag('  Work  ')).toBe('work');
		expect(folderNameToTag('#tag!')).toBe('tag');
	});

	it('collapses runs of separators into a single dash', () => {
		expect(folderNameToTag('A  &  B')).toBe('a-b');
	});

	it('preserves letters, digits, and underscore', () => {
		expect(folderNameToTag('Q2_Review')).toBe('q2_review');
	});

	it('returns empty string when nothing usable remains', () => {
		expect(folderNameToTag('!!!')).toBe('');
		expect(folderNameToTag('   ')).toBe('');
	});
});
