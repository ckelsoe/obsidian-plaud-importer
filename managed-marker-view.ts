/**
 * Hides the managed-block marker lines (#59) in Live Preview.
 *
 * Reading view already hides HTML comments, but Live Preview shows them as a
 * dimmed line, so every imported note showed two `<!-- plaud:managed:... -->`
 * lines while editing. This extension replaces each marker line with nothing
 * while Live Preview is on, and shows it again whenever a selection or the
 * cursor touches that line, the same way Live Preview reveals other markup. The
 * note on disk is never changed. Source mode shows the markers as written.
 */

import {
	Facet,
	StateField,
	type EditorState,
	type Extension,
	type Range,
	type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import {
	isManagedMarkerLine,
	managedMarkers,
	type ManagedMarkers,
} from './managed-block';
import type { ServiceProfile } from './service-profile';

// The service whose markers are hidden, so the field below can stay a single
// module-level definition. Set by hideManagedMarkers.
const markersFacet = Facet.define<ManagedMarkers, ManagedMarkers | undefined>({
	combine: (values) => values[0],
});

function isMarker(state: EditorState, text: string): boolean {
	const markers = state.facet(markersFacet);
	return markers !== undefined && isManagedMarkerLine(markers, text);
}

interface LineSpan {
	readonly from: number;
	readonly to: number;
}

/**
 * Every marker line in the document. Built by one full scan, then kept current
 * per edit: untouched spans are mapped through the change and only the lines
 * an edit touched are rescanned, so typing in a long note does not rescan it.
 */
const markerLinesField = StateField.define<readonly LineSpan[]>({
	create: (state) => findMarkerLines(state),
	update: (spans, tr) => {
		// A different service's markers make every cached span suspect.
		if (
			tr.startState.facet(markersFacet) !== tr.state.facet(markersFacet)
		) {
			return findMarkerLines(tr.state);
		}
		return tr.docChanged ? updateMarkerLines(spans, tr) : spans;
	},
});

function findMarkerLines(state: EditorState): LineSpan[] {
	const spans: LineSpan[] = [];
	let from = 0;
	for (const text of state.doc.iterLines()) {
		if (isMarker(state, text)) {
			spans.push({ from, to: from + text.length });
		}
		from += text.length + 1;
	}
	return spans;
}

function updateMarkerLines(
	spans: readonly LineSpan[],
	tr: Transaction,
): LineSpan[] {
	const byStart = new Map<number, LineSpan>();
	for (const span of spans) {
		// A span an edit touches may no longer be a marker; its line is
		// rescanned below with the other changed lines.
		if (!tr.changes.touchesRange(span.from, span.to)) {
			const from = tr.changes.mapPos(span.from);
			byStart.set(from, { from, to: tr.changes.mapPos(span.to) });
		}
	}
	const { doc } = tr.state;
	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		const last = doc.lineAt(toB).number;
		for (let n = doc.lineAt(fromB).number; n <= last; n++) {
			const line = doc.line(n);
			// A kept span is never stale here: if this line was a marker the
			// edit touched, its span was dropped above.
			if (isMarker(tr.state, line.text)) {
				byStart.set(line.from, { from: line.from, to: line.to });
			}
		}
	});
	return [...byStart.values()].sort((a, b) => a.from - b.from);
}

/**
 * The decorations that hide every marker line no selection touches. Exported
 * for tests; `livePreview` is false in source mode, which hides nothing.
 */
export function managedMarkerDecorations(
	state: EditorState,
	livePreview: boolean,
): DecorationSet {
	if (!livePreview) {
		return Decoration.none;
	}
	const hidden: Range<Decoration>[] = [];
	for (const line of state.field(markerLinesField)) {
		const touched = state.selection.ranges.some(
			(r) => r.from <= line.to && r.to >= line.from,
		);
		if (!touched) {
			hidden.push(
				Decoration.replace({ block: true }).range(line.from, line.to),
			);
		}
	}
	return Decoration.set(hidden);
}

/**
 * The editor extension for one service's markers. Block replacements cannot
 * come from a view plugin, so the decorations are a facet value recomputed
 * when the marker lines, the selection, or the Live Preview toggle change.
 */
export const hideManagedMarkers = (profile: ServiceProfile): Extension => [
	markersFacet.of(managedMarkers(profile)),
	markerLinesField,
	EditorView.decorations.compute(
		[markerLinesField, 'selection', editorLivePreviewField],
		(state) =>
			managedMarkerDecorations(
				state,
				state.field(editorLivePreviewField, false) ?? false,
			),
	),
];
