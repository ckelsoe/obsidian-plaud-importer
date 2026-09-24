import { trimChars, trimTrailingChars } from '../text-trim';

describe('trimChars', () => {
	it('strips every leading and trailing match, keeps the middle', () => {
		expect(trimChars('--a-b--', '-')).toBe('a-b');
		expect(trimChars('//x/y//', '/')).toBe('x/y');
	});

	it('strips runs longer than any regex bound would allow', () => {
		const run = '/'.repeat(10_000);
		expect(trimChars(`${run}p${run}`, '/')).toBe('p');
	});

	it('returns empty for an all-trim value and leaves a clean value alone', () => {
		expect(trimChars('----', '-')).toBe('');
		expect(trimChars('abc', '-')).toBe('abc');
		expect(trimChars('', '-')).toBe('');
	});
});

describe('trimTrailingChars', () => {
	it('strips only the trailing run', () => {
		expect(trimTrailingChars('/a/b//', '/')).toBe('/a/b');
		expect(trimTrailingChars('abc==', '=')).toBe('abc');
	});

	it('treats every listed character as trimmable', () => {
		expect(trimTrailingChars('name. . .', '. ')).toBe('name');
	});

	it('handles an all-trim and an empty value', () => {
		expect(trimTrailingChars('...', '.')).toBe('');
		expect(trimTrailingChars('', '.')).toBe('');
	});
});
