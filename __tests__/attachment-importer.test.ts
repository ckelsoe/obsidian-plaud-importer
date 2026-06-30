import { inferAssetExtension } from '../attachment-importer';
import type { AttachmentAsset } from '../plaud-client';

function asset(overrides: Partial<AttachmentAsset> = {}): AttachmentAsset {
	return {
		dataType: 'consumer_note',
		url: 'https://s3.amazonaws.com/blob?X-Amz-Signature=fake',
		...overrides,
	};
}

describe('inferAssetExtension', () => {
	it('maps a text/plain response to .md instead of falling through to .bin', () => {
		expect(
			inferAssetExtension(asset(), '# Heading\n\nbody', 'text/plain; charset=utf-8'),
		).toBe('md');
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
