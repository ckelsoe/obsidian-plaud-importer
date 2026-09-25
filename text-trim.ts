/**
 * Linear, unbounded character-trim helpers used in place of `String.replace`
 * with anchored `+`/`*` regexes.
 *
 * eslint-plugin-sonarjs flags those regexes (e.g. `/\/+$/`) as super-linear
 * because an unanchored quantifier before `$` backtracks quadratically on a
 * long non-matching run. Bounding the quantifier (`/\/{1,64}$/`) silences the
 * rule but silently stops stripping past the bound, which corrupts a path or
 * filename (an illegal trailing dot survives, a folder prefix stops matching).
 * A plain left/right scan is linear AND strips every matching character.
 */

/** Strip every leading and trailing character that appears in `chars`. */
export function trimChars(value: string, chars: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && chars.includes(value.charAt(start))) start++;
	while (end > start && chars.includes(value.charAt(end - 1))) end--;
	return value.slice(start, end);
}

/** Strip every trailing character that appears in `chars`. */
export function trimTrailingChars(value: string, chars: string): string {
	let end = value.length;
	while (end > 0 && chars.includes(value.charAt(end - 1))) end--;
	return value.slice(0, end);
}
