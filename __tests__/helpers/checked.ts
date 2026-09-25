/**
 * Checked access for tests. Each returns the value with `undefined` (and, for
 * `defined`, `null`) removed from its type, and fails the test with a clear
 * message when the value is missing. Used instead of non-null assertions
 * (`x!`), which only silence the type checker.
 */

/** The element at `index`, or a failure naming the index and length. */
export function at<T>(items: readonly T[] | undefined, index: number): T {
	if (items === undefined) {
		throw new Error(
			`expected an array to read index ${index}, got undefined`,
		);
	}
	const item = items[index];
	if (item === undefined) {
		throw new Error(
			`expected an element at index ${index}, array length is ${items.length}`,
		);
	}
	return item;
}

/** The value itself, or a failure when it is null or undefined. */
export function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error(`expected a value, got ${String(value)}`);
	}
	return value;
}
