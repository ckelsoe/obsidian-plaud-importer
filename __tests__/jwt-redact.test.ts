import { redactJwtLike } from '../jwt-redact';

const SEG = 'abcdEFGH_-12';

describe('redactJwtLike', () => {
	it('redacts a JWT-shaped token and keeps the text around it', () => {
		expect(redactJwtLike(`before ${SEG}.${SEG}.${SEG} after`, '[t]')).toBe(
			'before [t] after',
		);
	});

	it('redacts the whole of a very long token, not just a bounded part', () => {
		const long = 'x'.repeat(20_000);
		expect(redactJwtLike(`${long}.${SEG}.${long}`, '[t]')).toBe('[t]');
	});

	it('leaves a dotted value alone when a segment is shorter than 8', () => {
		const text = `${SEG}.short.${SEG}`;
		expect(redactJwtLike(text, '[t]')).toBe(text);
	});

	it('does not reuse the last segment of one token as the first of the next', () => {
		expect(redactJwtLike(`${SEG}.${SEG}.${SEG}.${SEG}`, '[t]')).toBe(
			`[t].${SEG}`,
		);
	});

	it('redacts several tokens in one text', () => {
		const tok = `${SEG}.${SEG}.${SEG}`;
		expect(redactJwtLike(`${tok} and ${tok}`, '[t]')).toBe('[t] and [t]');
	});
});
