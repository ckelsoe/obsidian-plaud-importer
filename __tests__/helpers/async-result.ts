/**
 * Runs `body` immediately and returns its result as a promise, with a throw
 * turned into a rejection. That is exactly how an `async` function behaves, so
 * a test double can implement a Promise-returning interface without `async`
 * (which @typescript-eslint/require-await rejects when there is nothing to
 * await) and still reject, not throw synchronously, when its body throws.
 */
export function asyncResult<T>(body: () => T | PromiseLike<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		resolve(body());
	});
}
