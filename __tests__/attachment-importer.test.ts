import {
	inferAssetExtension,
	rewriteInlineSummaryEmbeds,
} from '../attachment-importer';
import type { AttachmentAsset } from '../plaud-client';

function asset(overrides: Partial<AttachmentAsset> = {}): AttachmentAsset {
	return {
		dataType: 'consumer_note',
		url: 'https://s3.amazonaws.com/blob?X-Amz-Signature=fake',
		...overrides,
	};
}

describe('inferAssetExtension', () => {
	it('maps a non-JSON text/plain response to .md instead of falling through to .bin', () => {
		expect(
			inferAssetExtension(asset(), '# Heading\n\nbody', 'text/plain; charset=utf-8'),
		).toBe('md');
	});

	it('treats a JSON body served as text/plain as json, not md (nested images still import)', () => {
		// The text/plain fallback runs AFTER the JSON-body sniff, so a JSON
		// envelope with a generic text MIME still resolves to json.
		expect(
			inferAssetExtension(
				asset({ url: 'https://s3.test/blob?sig=x' }),
				'{"picture_link":"https://x/y.png"}',
				'text/plain; charset=utf-8',
			),
		).toBe('json');
	});

	it('maps a Markdown mime hint to .md', () => {
		expect(inferAssetExtension(asset({ mimeType: 'text/markdown' }), 'body', '')).toBe(
			'md',
		);
	});

	it('still classifies known binary mimes ahead of the text branch', () => {
		expect(inferAssetExtension(asset(), '', 'image/png')).toBe('png');
		expect(inferAssetExtension(asset(), '', 'application/pdf')).toBe('pdf');
	});

	it('uses a real file extension on the URL when no mime is decisive', () => {
		expect(
			inferAssetExtension(asset({ url: 'https://s3.test/file.webp?sig=x' }), '', ''),
		).toBe('webp');
	});

	it('sniffs a JSON body when nothing else matches', () => {
		expect(
			inferAssetExtension(asset({ url: 'https://s3.test/blob?sig=x' }), '[1,2,3]', ''),
		).toBe('json');
	});

	it('falls back to bin for an opaque binary body', () => {
		expect(
			inferAssetExtension(asset({ url: 'https://s3.test/blob?sig=x' }), '\x00\x01', ''),
		).toBe('bin');
	});
});

describe('rewriteInlineSummaryEmbeds', () => {
	// Regression for issue #52: Plaud's newer AI summary embeds the card poster
	// as an inline `![alt](permanent/...)` link that only resolves inside
	// Plaud's app. The importer downloads the same asset locally; the summary
	// embed must be repointed at the local copy or Obsidian shows
	// "could not be found".
	it('repoints an inline Plaud poster embed at the downloaded local asset (#52)', () => {
		const plaudUrl =
			'permanent/e2506c1e4048400f8dfecacc50bc3028/abc/summary_poster/card_20260706192510-v2@1024';
		const body =
			'## Summary\n\nMeeting recap.\n\n![PLAUD NOTE](' + plaudUrl + ')\n\nEnd.\n';
		const out = rewriteInlineSummaryEmbeds(
			body,
			new Map([[plaudUrl, 'Meetings/Standup-assets/00ec8400-card.png']]),
		);
		expect(out).toContain('![[Meetings/Standup-assets/00ec8400-card.png]]');
		expect(out).not.toContain('summary_poster');
		expect(out).not.toContain('](permanent/');
	});

	it('leaves an unmapped embed untouched (external image the user referenced)', () => {
		const body = '![diagram](https://example.com/diagram.png)\n';
		const out = rewriteInlineSummaryEmbeds(
			body,
			new Map([['permanent/x/card_y', 'note-assets/card.png']]),
		);
		expect(out).toBe(body);
	});

	it('returns the content unchanged when the rewrite map is empty', () => {
		const body = '![PLAUD NOTE](permanent/x/summary_poster/card_y)\n';
		expect(rewriteInlineSummaryEmbeds(body, new Map())).toBe(body);
	});

	it('does not disturb existing `![[...]]` wikilink embeds in the managed section', () => {
		const body = '## Images and Attachments\n\n![[note-assets/00ec8400-card.png]]\n';
		const out = rewriteInlineSummaryEmbeds(
			body,
			new Map([['permanent/x/card_y', 'note-assets/00ec8400-card.png']]),
		);
		expect(out).toBe(body);
	});

	it('handles the angle-bracket and title variants of an inline embed', () => {
		const url = 'permanent/x/summary_poster/card_z';
		const body =
			'![a](<' + url + '> "Poster")\n![b](' + url + ' "Poster")\n';
		const out = rewriteInlineSummaryEmbeds(
			body,
			new Map([[url, 'n-assets/card.png']]),
		);
		expect(out).toBe('![[n-assets/card.png]]\n![[n-assets/card.png]]\n');
	});

	// The rewrite key is the whole target string, query suffix included; it must
	// equal asset.url (the extractor's normalized link) exactly. Locks the
	// handoff's key-match risk: a differing suffix silently no-ops rather than
	// partial-matching the wrong asset.
	it('requires an exact key match including any query suffix (#52 risk)', () => {
		const url = 'permanent/x/summary_poster/card_z?v=abc';
		const body = '![PLAUD NOTE](' + url + ')\n';
		expect(
			rewriteInlineSummaryEmbeds(body, new Map([[url, 'n-assets/card.png']])),
		).toContain('![[n-assets/card.png]]');
		expect(
			rewriteInlineSummaryEmbeds(
				body,
				new Map([
					['permanent/x/summary_poster/card_z?v=OTHER', 'n-assets/card.png'],
				]),
			),
		).toBe(body);
	});

	// Scope of #52: only markdown image embeds are repointed. An `<img>` tag or a
	// bare URL is downloaded by the importer but left as-is here (documented gap).
	it('rewrites only markdown image embeds, not <img> tags or bare URLs', () => {
		const url = 'permanent/x/summary_poster/card_z';
		const map = new Map([[url, 'n-assets/card.png']]);
		const html = '<img src="' + url + '">\n';
		const bare = 'See ' + url + ' for the card.\n';
		expect(rewriteInlineSummaryEmbeds(html, map)).toBe(html);
		expect(rewriteInlineSummaryEmbeds(bare, map)).toBe(bare);
	});
});
