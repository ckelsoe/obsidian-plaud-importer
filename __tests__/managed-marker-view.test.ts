import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import {
	hideManagedMarkers,
	managedMarkerDecorations,
} from '../managed-marker-view';
import { isManagedMarkerLine, wrapManagedBody } from '../managed-block';

const DOC = `---\nplaud-id: abc\n---\nmine above\n\n${wrapManagedBody('# Title\n\nbody')}\n\nmine below\n`;

function stateWith(doc: string, cursor = 0): EditorState {
	return EditorState.create({
		doc,
		selection: EditorSelection.cursor(cursor),
		extensions: [editorLivePreviewField, hideManagedMarkers],
	});
}

function hiddenTexts(state: EditorState, set: DecorationSet): string[] {
	const out: string[] = [];
	set.between(0, state.doc.length, (from, to) => {
		out.push(state.sliceDoc(from, to));
	});
	return out;
}

describe('isManagedMarkerLine', () => {
	it.each([
		['<!-- plaud:managed:start -->', true],
		['<!-- plaud:managed:end -->', true],
		['<!-- plaud:managed:end -->  ', true],
		['see <!-- plaud:managed:start -->', false],
		['<!-- plaud:managed:middle -->', false],
		['', false],
	])('%j is a marker line: %s', (line, expected) => {
		expect(isManagedMarkerLine(line)).toBe(expected);
	});
});

describe('managedMarkerDecorations', () => {
	it('hides both marker lines in Live Preview', () => {
		const state = stateWith(DOC);
		expect(
			hiddenTexts(state, managedMarkerDecorations(state, true)),
		).toEqual([
			'<!-- plaud:managed:start -->',
			'<!-- plaud:managed:end -->',
		]);
	});

	it('hides nothing in source mode', () => {
		const state = stateWith(DOC);
		expect(managedMarkerDecorations(state, false).size).toBe(0);
	});

	it('shows a marker line while the cursor is on it', () => {
		const at = DOC.indexOf('<!-- plaud:managed:end -->') + 3;
		const state = stateWith(DOC, at);
		expect(
			hiddenTexts(state, managedMarkerDecorations(state, true)),
		).toEqual(['<!-- plaud:managed:start -->']);
	});

	it('shows a marker line a selection runs across', () => {
		const state = stateWith(DOC).update({
			selection: EditorSelection.range(
				DOC.indexOf('mine above'),
				DOC.indexOf('# Title'),
			),
		}).state;
		expect(
			hiddenTexts(state, managedMarkerDecorations(state, true)),
		).toEqual(['<!-- plaud:managed:end -->']);
	});

	it('follows a marker the user types above', () => {
		const state = stateWith(DOC).update({
			changes: { from: 0, insert: 'new first line\n' },
		}).state;
		expect(
			hiddenTexts(state, managedMarkerDecorations(state, true)),
		).toEqual([
			'<!-- plaud:managed:start -->',
			'<!-- plaud:managed:end -->',
		]);
	});

	it('stops hiding a line once it is no longer a marker', () => {
		const at = DOC.indexOf('managed:end');
		const state = stateWith(DOC).update({
			changes: { from: at, to: at + 'managed'.length, insert: 'x' },
		}).state;
		expect(
			hiddenTexts(state, managedMarkerDecorations(state, true)),
		).toEqual(['<!-- plaud:managed:start -->']);
	});

	it('hides nothing in a note without markers', () => {
		const state = stateWith('# Title\n\nbody\n');
		expect(managedMarkerDecorations(state, true).size).toBe(0);
	});
});

describe('hideManagedMarkers extension', () => {
	it('provides the hiding decorations to the editor', () => {
		const state = stateWith(DOC);
		const sets = state
			.facet(EditorView.decorations)
			.filter((d): d is DecorationSet => typeof d !== 'function');
		expect(sets.map((s) => hiddenTexts(state, s))).toEqual([
			['<!-- plaud:managed:start -->', '<!-- plaud:managed:end -->'],
		]);
	});
});

describe('marker tracking across edits', () => {
	// Deterministic pseudo-random edits; the incrementally tracked markers must
	// always match a fresh full scan of the same text.
	function rng(seed: number): () => number {
		let s = seed;
		return () => {
			s = (s * 1103515245 + 12345) % 2147483648;
			return s / 2147483648;
		};
	}
	const PIECES = [
		'\n',
		'x',
		'<!-- plaud:managed:start -->',
		'<!-- plaud:managed:end -->',
		'\n<!-- plaud:managed:end -->\n',
		'',
	];

	it('matches a full rescan after every edit', () => {
		const rand = rng(59);
		let state = stateWith(DOC, DOC.length);
		for (let i = 0; i < 400; i++) {
			const len = state.doc.length;
			const from = Math.floor(rand() * (len + 1));
			const to = Math.min(len, from + Math.floor(rand() * 30));
			const insert = PIECES[Math.floor(rand() * PIECES.length)] ?? '';
			state = state.update({
				changes: { from, to, insert },
				selection: EditorSelection.cursor(0),
			}).state;
			const fresh = stateWith(state.doc.toString());
			expect(
				hiddenTexts(state, managedMarkerDecorations(state, true)),
			).toEqual(
				hiddenTexts(fresh, managedMarkerDecorations(fresh, true)),
			);
		}
	});
});
