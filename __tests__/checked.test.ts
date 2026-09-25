import { at, defined } from './helpers/checked';

describe('at', () => {
	it('returns the element at the index', () => {
		expect(at(['a', 'b'], 1)).toBe('b');
	});

	it('fails with the index and length when the element is missing', () => {
		expect(() => at(['a'], 3)).toThrow(
			'expected an element at index 3, array length is 1',
		);
	});

	it('fails when the array itself is undefined', () => {
		expect(() => at(undefined, 0)).toThrow('got undefined');
	});
});

describe('defined', () => {
	it('returns a present value, including falsy ones', () => {
		expect(defined(0)).toBe(0);
		expect(defined('')).toBe('');
		expect(defined(false)).toBe(false);
	});

	it('fails on null and undefined', () => {
		expect(() => defined(null)).toThrow('got null');
		expect(() => defined(undefined)).toThrow('got undefined');
	});
});
