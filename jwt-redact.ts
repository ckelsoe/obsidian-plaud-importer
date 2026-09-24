/**
 * Redact every JWT-shaped substring: three runs of `[A-Za-z0-9_-]`, each at
 * least 8 long, joined by single dots. A linear scan that replaces exactly what
 * `/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g` replaced. The
 * regex backtracks super-linearly on long runs, and bounding its quantifiers
 * would leave the tail of a long token unredacted.
 */
export function redactJwtLike(text: string, replacement: string): string {
	// Maximal runs of token characters, as [start, end) pairs.
	const runs: Array<readonly [number, number]> = [];
	let i = 0;
	while (i < text.length) {
		if (!isTokenChar(text.charCodeAt(i))) {
			i++;
			continue;
		}
		const start = i;
		while (i < text.length && isTokenChar(text.charCodeAt(i))) {
			i++;
		}
		runs.push([start, i]);
	}
	let out = '';
	let copied = 0;
	let k = 0;
	while (k + 2 < runs.length) {
		const a = runs[k];
		const b = runs[k + 1];
		const c = runs[k + 2];
		if (
			a !== undefined &&
			b !== undefined &&
			c !== undefined &&
			isSegment(a) &&
			isSegment(b) &&
			isSegment(c) &&
			joinedByDot(text, a, b) &&
			joinedByDot(text, b, c)
		) {
			out += text.slice(copied, a[0]) + replacement;
			copied = c[1];
			k += 3;
		} else {
			k++;
		}
	}
	return out + text.slice(copied);
}

function isTokenChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		code === 95 || // _
		code === 45 // -
	);
}

function isSegment(run: readonly [number, number]): boolean {
	return run[1] - run[0] >= 8;
}

function joinedByDot(
	text: string,
	left: readonly [number, number],
	right: readonly [number, number],
): boolean {
	return right[0] === left[1] + 1 && text.charAt(left[1]) === '.';
}
