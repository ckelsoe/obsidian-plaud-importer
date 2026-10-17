import {
	MANAGED_BLOCK_END,
	MANAGED_BLOCK_START,
	locateManagedBlock,
	managedBodyRegion,
	spliceManagedBlock,
	transformManagedBody,
	wrapManagedBody,
} from '../managed-block';
import { insertSectionBeforeTranscript } from '../attachment-importer';

const FM = '---\nplaud-id: abc\n---\n';

function note(above: string, body: string, below: string): string {
	return `${FM}${above}${wrapManagedBody(body)}${below}`;
}

describe('locateManagedBlock', () => {
	it('reports none when the note has no markers', () => {
		expect(locateManagedBlock(`${FM}\n# Title\n`)).toEqual({
			kind: 'none',
		});
	});

	it('splits a well-formed note into before, inner, and after', () => {
		const content = note('\nmine above\n\n', '# Title', '\nmine below\n');
		const located = locateManagedBlock(content);
		expect(located).toEqual({
			kind: 'ok',
			before: `${FM}\nmine above\n\n`,
			inner: '\n# Title\n\n',
			after: '\nmine below\n',
		});
	});

	it('ignores a marker that is not alone on its line', () => {
		const content = `${FM}See \`${MANAGED_BLOCK_START}\` in the docs.\n`;
		expect(locateManagedBlock(content)).toEqual({ kind: 'none' });
	});

	it.each([
		['a start with no end', `${FM}${MANAGED_BLOCK_START}\n# T\n`],
		['an end with no start', `${FM}# T\n${MANAGED_BLOCK_END}\n`],
		[
			'two starts',
			`${FM}${MANAGED_BLOCK_START}\n${MANAGED_BLOCK_START}\n# T\n${MANAGED_BLOCK_END}\n`,
		],
		[
			'two ends',
			`${FM}${MANAGED_BLOCK_START}\n# T\n${MANAGED_BLOCK_END}\n${MANAGED_BLOCK_END}\n`,
		],
		[
			'the end before the start',
			`${FM}${MANAGED_BLOCK_END}\n# T\n${MANAGED_BLOCK_START}\n`,
		],
	])('reports malformed for %s', (_label, content) => {
		expect(locateManagedBlock(content).kind).toBe('malformed');
	});
});

describe('spliceManagedBlock', () => {
	const rendered = `---\nplaud-id: abc\nplaud-version-ms: 2\n---\n\n${wrapManagedBody('# Title\n\n## Summary\n\nnew summary')}\n`;

	it('returns the rendered note unchanged for a legacy note without markers', () => {
		expect(
			spliceManagedBlock(`${FM}\n# Title\n\nold body\n`, rendered),
		).toBe(rendered);
	});

	it('keeps the user text above and below and takes the new frontmatter and block', () => {
		const existing = note(
			'\n## My notes\n\n- [ ] follow up\n\n',
			'# Title\n\n## Summary\n\nold summary',
			'\n\n## Decisions\n\nShip it.\n',
		);
		const out = spliceManagedBlock(existing, rendered);
		expect(out).toBe(
			`---\nplaud-id: abc\nplaud-version-ms: 2\n---\n\n## My notes\n\n- [ ] follow up\n\n${wrapManagedBody('# Title\n\n## Summary\n\nnew summary')}\n\n## Decisions\n\nShip it.\n`,
		);
	});

	it('keeps user text when the note has no frontmatter left', () => {
		const existing = `intro\n\n${wrapManagedBody('# Title')}\n`;
		const out = spliceManagedBlock(existing, rendered);
		expect(out).toBe(
			`---\nplaud-id: abc\nplaud-version-ms: 2\n---\nintro\n\n${wrapManagedBody('# Title\n\n## Summary\n\nnew summary')}\n`,
		);
	});

	it('is a no-op when the note on disk already matches the rendered note', () => {
		expect(spliceManagedBlock(rendered, rendered)).toBe(rendered);
	});

	it('returns null for malformed markers', () => {
		const existing = `${FM}${MANAGED_BLOCK_START}\n# Title\nmine\n`;
		expect(spliceManagedBlock(existing, rendered)).toBeNull();
	});

	it('returns null rather than rebuilding when the rendered note has no block', () => {
		const existing = note('', '# Title', '\nmine\n');
		expect(spliceManagedBlock(existing, `${FM}\n# Title\n`)).toBeNull();
	});
});

describe('transformManagedBody', () => {
	const section = '## Images and Attachments\n\n_x_';

	it('appends inside the block, not after the user text', () => {
		const content = note(
			'',
			'# Title\n\n## Summary\n\ns',
			'\n\nmine below\n',
		);
		const out = transformManagedBody(content, (body) =>
			insertSectionBeforeTranscript(body.trimEnd(), section),
		);
		expect(out).toBe(
			note(
				'',
				`# Title\n\n## Summary\n\ns\n\n${section}`,
				'\n\nmine below\n',
			),
		);
	});

	it('anchors on the block transcript, not a Transcript heading the user wrote below', () => {
		const content = note(
			'',
			'# Title\n\n---\n\n#### Transcript\n\nlines',
			'\n\n#### Transcript\n\nmy own transcript notes\n',
		);
		const out = transformManagedBody(content, (body) =>
			insertSectionBeforeTranscript(body.trimEnd(), section),
		);
		expect(out).toBe(
			note(
				'',
				`# Title\n\n---\n\n${section}\n\n#### Transcript\n\nlines`,
				'\n\n#### Transcript\n\nmy own transcript notes\n',
			),
		);
	});

	it('rewrites the whole note when there is no block', () => {
		const out = transformManagedBody('# Title', (body) => `${body}!`);
		expect(out).toBe('# Title!');
	});
});

describe('transformManagedBody with damaged markers', () => {
	it('leaves the note unchanged instead of rewriting the whole note', () => {
		const content = `${FM}${MANAGED_BLOCK_START}\n\n# Title\n\nmine\n`;
		expect(transformManagedBody(content, () => 'rewritten')).toBe(content);
	});
});

describe('managedBodyRegion', () => {
	it('reports the block text and the line it starts on', () => {
		const content = note('\nmine\n\n', '# Title', '\n');
		const { body, lineOffset } = managedBodyRegion(content);
		expect(body).toBe('\n# Title\n\n');
		const lines = content.split('\n');
		expect(lines[lineOffset + 1]).toBe('# Title');
	});

	it('is the whole note without a block', () => {
		expect(managedBodyRegion('a\nb')).toEqual({
			body: 'a\nb',
			lineOffset: 0,
			textBelow: false,
		});
	});
});
