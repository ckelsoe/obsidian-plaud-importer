import { asyncResult } from './helpers/async-result';

describe('asyncResult', () => {
	it('runs the body synchronously, like an async function', () => {
		const calls: string[] = [];
		void asyncResult(() => {
			calls.push('ran');
		});
		expect(calls).toEqual(['ran']);
	});

	it('resolves with the body result', async () => {
		await expect(asyncResult(() => 42)).resolves.toBe(42);
	});

	it('turns a throw into a rejection instead of a synchronous throw', async () => {
		const boom = new Error('boom');
		let promise: Promise<never> | undefined;
		expect(() => {
			promise = asyncResult((): never => {
				throw boom;
			});
		}).not.toThrow();
		await expect(promise).rejects.toBe(boom);
	});

	it('adopts a returned promise', async () => {
		await expect(asyncResult(() => Promise.resolve('x'))).resolves.toBe(
			'x',
		);
	});
});
