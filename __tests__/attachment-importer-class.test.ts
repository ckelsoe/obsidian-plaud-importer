/**
 * Characterization tests for AttachmentImporter. They pin what the class does
 * TODAY (vault paths, note text, request URLs and headers) so the planned
 * extraction into a shared library cannot change behavior silently. Odd
 * behavior is pinned too and marked "possibly a bug"; do not "fix" a test
 * without deciding the behavior change on purpose.
 */
import * as obsidian from 'obsidian';
import {
	TFile,
	TFolder,
	type App,
	type RequestUrlParam,
	type RequestUrlResponse,
	type RequestUrlResponsePromise,
	type TAbstractFile,
} from 'obsidian';
import { AttachmentImporter } from '../attachment-importer';
import type { ArtifactSelection } from '../import-core';
import type { AttachmentAsset } from '../plaud-client';
import { asyncResult } from './helpers/async-result';
import { at, defined } from './helpers/checked';

// ---------------------------------------------------------------------------
// In-memory vault + App
// ---------------------------------------------------------------------------

type Stored = { file: TFile; data: string | ArrayBuffer };

class MemoryVault {
	readonly files = new Map<string, Stored>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	readonly modifiedBinary: string[] = [];
	readonly processed: string[] = [];
	/** When set, createBinary throws this for the matching path. */
	failCreateBinary: string | null = null;
	/** When set, createFolder throws this message. */
	createFolderError: string | null = null;

	addText(path: string, text: string): void {
		this.addFolderChain(parentOf(path));
		this.files.set(path, { file: makeFile(path), data: text });
	}

	addBinary(path: string, bytes: Uint8Array): void {
		this.addFolderChain(parentOf(path));
		this.files.set(path, { file: makeFile(path), data: toBuffer(bytes) });
	}

	addFolderChain(path: string): void {
		const parts = path.split('/').filter((p) => p.length > 0);
		for (let i = 1; i <= parts.length; i++) {
			this.folders.add(parts.slice(0, i).join('/'));
		}
	}

	text(path: string): string {
		const data = defined(this.files.get(path)).data;
		if (typeof data !== 'string') {
			throw new Error(`${path} is binary`);
		}
		return data;
	}

	bytes(path: string): Uint8Array {
		const data = defined(this.files.get(path)).data;
		if (typeof data === 'string') {
			throw new Error(`${path} is text`);
		}
		return new Uint8Array(data);
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	private folderObject(path: string): TFolder {
		const folder = new TFolder();
		folder.path = path;
		folder.name = path.split('/').pop() ?? path;
		const children: Array<TFile | TFolder> = [];
		for (const stored of this.files.values()) {
			if (parentOf(stored.file.path) === path) {
				children.push(stored.file);
			}
		}
		for (const sub of this.folders) {
			if (parentOf(sub) === path) {
				children.push(this.folderObject(sub));
			}
		}
		folder.children = children;
		return folder;
	}

	private trash(file: TAbstractFile): Promise<void> {
		return asyncResult(() => {
			this.trashed.push(file.path);
			if (file instanceof TFolder) {
				for (const key of [...this.files.keys()]) {
					if (key.startsWith(`${file.path}/`)) this.files.delete(key);
				}
				for (const sub of [...this.folders]) {
					if (sub === file.path || sub.startsWith(`${file.path}/`)) {
						this.folders.delete(sub);
					}
				}
				return;
			}
			this.files.delete(file.path);
		});
	}

	app(): App {
		const vault = {
			getFileByPath: (path: string): TFile | null =>
				this.files.get(path)?.file ?? null,
			getFolderByPath: (path: string): TFolder | null =>
				this.folders.has(path) ? this.folderObject(path) : null,
			createFolder: (path: string): Promise<TFolder> =>
				asyncResult(() => {
					if (this.createFolderError !== null) {
						throw new Error(this.createFolderError);
					}
					if (this.folders.has(path)) {
						throw new Error('Folder already exists.');
					}
					this.addFolderChain(path);
					return this.folderObject(path);
				}),
			createBinary: (path: string, data: ArrayBuffer): Promise<TFile> =>
				asyncResult(() => {
					if (this.failCreateBinary === path) {
						throw new Error('disk full');
					}
					if (this.files.has(path)) {
						throw new Error('File already exists.');
					}
					this.addFolderChain(parentOf(path));
					const file = makeFile(path);
					this.files.set(path, { file, data });
					return file;
				}),
			modifyBinary: (file: TFile, data: ArrayBuffer): Promise<void> =>
				asyncResult(() => {
					this.modifiedBinary.push(file.path);
					this.files.set(file.path, { file, data });
				}),
			process: (
				file: TFile,
				fn: (data: string) => string,
			): Promise<string> =>
				asyncResult(() => {
					const next = fn(this.text(file.path));
					this.processed.push(file.path);
					this.files.set(file.path, { file, data: next });
					return next;
				}),
		};
		const fileManager = {
			trashFile: (file: TAbstractFile): Promise<void> => this.trash(file),
		};
		return { vault, fileManager } as unknown as App;
	}
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '';
}

function makeFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split('/').pop() ?? path;
	const dot = file.name.lastIndexOf('.');
	file.basename = dot >= 0 ? file.name.slice(0, dot) : file.name;
	file.extension = dot >= 0 ? file.name.slice(dot + 1) : '';
	return file;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

// ---------------------------------------------------------------------------
// requestUrl fake
// ---------------------------------------------------------------------------

type FakeResponse = {
	readonly status?: number;
	readonly contentType?: string;
	readonly body: string | Uint8Array;
};
type Route = FakeResponse | Error;

type RecordedRequest = {
	readonly url: string;
	readonly headers: Record<string, string>;
};

function installNetwork(routes: Record<string, Route>): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	jest.spyOn(obsidian, 'requestUrl').mockImplementation(
		(param: RequestUrlParam | string): RequestUrlResponsePromise => {
			const req = typeof param === 'string' ? { url: param } : param;
			requests.push({ url: req.url, headers: { ...req.headers } });
			const route = routes[req.url] ?? { status: 404, body: '' };
			if (route instanceof Error) {
				throw route;
			}
			const bytes =
				typeof route.body === 'string'
					? new TextEncoder().encode(route.body)
					: route.body;
			const response: RequestUrlResponse = {
				status: route.status ?? 200,
				headers:
					route.contentType === undefined
						? {}
						: { 'Content-Type': route.contentType },
				arrayBuffer: toBuffer(bytes),
				json: null,
				text: new TextDecoder().decode(bytes),
			};
			return Object.assign(Promise.resolve(response), {
				arrayBuffer: Promise.resolve(response.arrayBuffer),
				json: Promise.resolve(null),
				text: Promise.resolve(response.text),
			});
		},
	);
	return requests;
}

function png(seed: number): Uint8Array {
	return new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed + 1]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTE = 'Plaud/Meeting.md';
const FOLDER = 'Plaud/Meeting-assets';
const REC = 'Rec-1234-5678-abc';
const P = 'rec12345';
const TOKEN = 'test-token';

const ALL: ArtifactSelection = {
	includeSummary: true,
	includeTranscript: true,
	includeAttachments: true,
	includeMindmap: true,
	includeCard: true,
	includeScreenshots: true,
	includeAudio: true,
};

function note(body: string): string {
	return [
		'---',
		'plaud-id: x',
		'---',
		'<!-- plaud:managed:start -->',
		'',
		body,
		'',
		'<!-- plaud:managed:end -->',
		'',
		'User text below.',
		'',
	].join('\n');
}

function setup(
	opts: {
		token?: string | null;
		apiBase?: string;
		noteText?: string;
	} = {},
): {
	vault: MemoryVault;
	importer: AttachmentImporter;
} {
	const vault = new MemoryVault();
	vault.addText(
		NOTE,
		opts.noteText ?? note('# Meeting\n\n## Transcript\n\nhello'),
	);
	const token = opts.token === undefined ? TOKEN : opts.token;
	const apiBase = opts.apiBase;
	const importer = new AttachmentImporter({
		app: vault.app(),
		getAuthToken: () => token,
		...(apiBase === undefined ? {} : { getApiBaseUrl: () => apiBase }),
	});
	return { vault, importer };
}

function snapshotState(
	vault: MemoryVault,
	requests: readonly RecordedRequest[],
): unknown {
	return {
		files: vault.paths().map((path) => {
			const data = defined(vault.files.get(path)).data;
			if (typeof data === 'string') {
				return { path, text: data };
			}
			const view = new Uint8Array(data);
			return {
				path,
				byteLength: view.byteLength,
				head: [...view.slice(0, 4)]
					.map((b) => b.toString(16).padStart(2, '0'))
					.join(''),
			};
		}),
		trashed: [...vault.trashed],
		requests: requests.map((r) => ({
			url: r.url,
			headerNames: Object.keys(r.headers).sort(),
		})),
	};
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// importAttachmentsForNote
// ---------------------------------------------------------------------------

describe('AttachmentImporter.importAttachmentsForNote: early exits', () => {
	it('does nothing at all for an empty attachment list', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(NOTE, [], ALL, true, REC);
		expect(requests).toEqual([]);
		expect(vault.folders.has(FOLDER)).toBe(false);
		expect(vault.processed).toEqual([]);
	});

	it('aborts before creating the folder when the note does not exist', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			'Plaud/Other.md',
			[{ dataType: 'x', url: 'https://cdn.example.com/a.png' }],
			ALL,
			true,
			REC,
		);
		expect(requests).toEqual([]);
		expect(vault.folders.has('Plaud/Other-assets')).toBe(false);
	});

	it('creates no assets folder when the selection skips every attachment, and leaves the note alone', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		const before = vault.text(NOTE);
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{ dataType: 'mindmap', url: 'https://cdn.example.com/m.png' },
				{ dataType: 'card', url: 'https://cdn.example.com/c.png' },
				{
					dataType: 'plaud_mark',
					url: 'https://cdn.example.com/k.png',
				},
				{ dataType: 'other', url: 'https://cdn.example.com/o.png' },
			],
			{
				...ALL,
				includeAttachments: false,
				includeMindmap: false,
				includeCard: false,
				includeScreenshots: false,
			},
			false,
			REC,
		);
		expect(requests).toEqual([]);
		// Nothing will be imported, so no empty `-assets` folder is created.
		expect(vault.folders.has(FOLDER)).toBe(false);
		expect(vault.processed).toEqual([]);
		expect(vault.text(NOTE)).toBe(before);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: generic attachments', () => {
	it('names, dedupes and renders generic images and files, continuing past failures', async () => {
		const requests = installNetwork({
			'https://cdn.example.com/a/photo.png': {
				contentType: 'image/png',
				body: png(1),
			},
			'https://bucket.s3.amazonaws.com/doc.pdf?X-Amz-Signature=sig': {
				contentType: 'application/pdf',
				body: '%PDF-1.4 fake',
			},
			// Same bytes as photo.png: reuses the first path.
			'https://cdn.example.com/b/copy.png': {
				contentType: 'image/png',
				body: png(1),
			},
			'https://cdn.example.com/missing.png': { status: 404, body: '' },
			'https://cdn.example.com/boom.png': new Error('network down'),
			'https://cdn.example.com/second.jpeg': {
				contentType: 'image/jpeg',
				body: png(9),
			},
		});
		const { vault, importer } = setup({
			noteText: note(
				[
					'# Meeting',
					'',
					'![inline](https://cdn.example.com/b/copy.png)',
					'![other](https://elsewhere.example.com/x.png)',
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		});

		await importer.importAttachmentsForNote(
			NOTE,
			[
				{
					dataType: 'other',
					url: 'https://cdn.example.com/a/photo.png',
				},
				{
					dataType: 'other',
					url: 'https://bucket.s3.amazonaws.com/doc.pdf?X-Amz-Signature=sig',
				},
				{
					dataType: 'other',
					url: 'https://cdn.example.com/b/copy.png',
				},
				{
					dataType: 'other',
					url: 'https://cdn.example.com/missing.png',
				},
				{ dataType: 'other', url: 'https://cdn.example.com/boom.png' },
				{
					dataType: 'other',
					url: 'https://cdn.example.com/second.jpeg',
				},
			],
			ALL,
			false,
			REC,
		);

		expect(vault.paths()).toEqual([
			`${FOLDER}/${P}-file1.pdf`,
			`${FOLDER}/${P}-image1.png`,
			`${FOLDER}/${P}-image2.jpg`,
			NOTE,
		]);
		expect(vault.bytes(`${FOLDER}/${P}-image1.png`)).toEqual(png(1));
		// Both failures are warned once each; the run kept going.
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenNthCalledWith(
			1,
			`Plaud importer: failed to import attachment for ${NOTE}`,
			{ dataType: 'other', url: 'https://cdn.example.com/missing.png' },
		);

		expect(vault.text(NOTE)).toBe(
			note(
				[
					'# Meeting',
					'',
					`![[${FOLDER}/${P}-image1.png]]`,
					'![other](https://elsewhere.example.com/x.png)',
					'',
					'## Images and Attachments',
					'',
					'_Imported from Plaud file-detail assets at import time._',
					'',
					'### Other attachments',
					'',
					'#### Image 1',
					`![[${FOLDER}/${P}-image1.png]]`,
					'',
					'#### Image 2',
					`![[${FOLDER}/${P}-image2.jpg]]`,
					'',
					'#### File 1',
					`- [[${FOLDER}/${P}-file1.pdf]]`,
					'',
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		);

		// The bearer goes only to Plaud's own hosts: a third-party host and a
		// presigned S3 URL both get none.
		const authByUrl = Object.fromEntries(
			requests.map((r) => [r.url, r.headers.Authorization ?? null]),
		);
		expect(authByUrl['https://cdn.example.com/a/photo.png']).toBeNull();
		expect(
			authByUrl[
				'https://bucket.s3.amazonaws.com/doc.pdf?X-Amz-Signature=sig'
			],
		).toBeNull();
		expect(requests.every((r) => r.headers.Accept === '*/*')).toBe(true);
		expect(snapshotState(vault, requests)).toMatchSnapshot();
	});

	it('uses no name prefix when the recording id has no alphanumerics', async () => {
		installNetwork({
			'https://cdn.example.com/a.png': {
				contentType: 'image/png',
				body: png(1),
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'https://cdn.example.com/a.png' }],
			ALL,
			false,
			'---',
		);
		expect(vault.files.has(`${FOLDER}/image1.png`)).toBe(true);
	});

	it('does not save or embed an empty 200 response', async () => {
		installNetwork({
			'https://cdn.example.com/empty.png': {
				contentType: 'image/png',
				body: '',
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'https://cdn.example.com/empty.png' }],
			ALL,
			false,
			REC,
		);
		expect(vault.files.has(`${FOLDER}/${P}-image1.png`)).toBe(false);
		expect(vault.text(NOTE)).not.toContain(`${P}-image1.png`);
	});

	it('treats a body as an attachment page when only the asset mimeType says HTML', async () => {
		installNetwork({
			'https://cdn.example.com/page': { body: '<html>card</html>' },
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{
					dataType: 'other',
					url: 'https://cdn.example.com/page',
					mimeType: 'text/html',
				},
			],
			ALL,
			false,
			REC,
		);
		// The response has no content type, so Plaud's mimeType decides: it is
		// an attachment page, which is never saved as a raw .html file.
		expect(vault.files.has(`${FOLDER}/${P}-file1.html`)).toBe(false);
		expect(vault.text(NOTE)).not.toContain('.html');
	});

	it('warns when a generic HTML wrapper has no image links (no file, note untouched)', async () => {
		const requests = installNetwork({
			'https://cdn.example.com/a.html': {
				contentType: 'text/html; charset=utf-8',
				body: '<html><body>Nothing to see</body></html>',
			},
			'https://cdn.example.com/b.png': {
				contentType: 'image/png',
				body: png(3),
			},
		});
		const { vault, importer } = setup();
		const before = vault.text(NOTE);
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'https://cdn.example.com/a.html' }],
			ALL,
			false,
			REC,
		);
		expect(requests.map((r) => r.url)).toEqual([
			'https://cdn.example.com/a.html',
		]);
		// Nothing is saved from the wrapper, so the user gets a warning.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(vault.paths()).toEqual([NOTE]);
		expect(vault.text(NOTE)).toBe(before);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: relative paths and auth', () => {
	it('tries the nested map, then the API base, then the web base for a relative path', async () => {
		const requests = installNetwork({
			'https://bucket.s3.amazonaws.com/mm.png?X-Amz-Signature=s': {
				status: 403,
				body: 'denied',
			},
			'https://api-euc1.plaud.ai/permanent/rec/other.png': {
				status: 500,
				body: '',
			},
			'https://web.plaud.ai/permanent/rec/other.png': {
				contentType: 'image/png',
				body: png(5),
			},
		});
		const { vault, importer } = setup({
			apiBase: 'https://api-euc1.plaud.ai//',
		});
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: '/permanent/rec/other.png' }],
			ALL,
			false,
			REC,
			{
				'permanent/rec/other.png':
					'https://bucket.s3.amazonaws.com/mm.png?X-Amz-Signature=s',
			},
		);
		expect(
			requests.map((r) => [r.url, r.headers.Authorization ?? null]),
		).toEqual([
			['https://bucket.s3.amazonaws.com/mm.png?X-Amz-Signature=s', null],
			[
				'https://api-euc1.plaud.ai/permanent/rec/other.png',
				`Bearer ${TOKEN}`,
			],
			['https://web.plaud.ai/permanent/rec/other.png', `Bearer ${TOKEN}`],
		]);
		expect(vault.files.has(`${FOLDER}/${P}-image1.png`)).toBe(true);
	});

	it('falls back to https://api.plaud.ai when no API base provider is given', async () => {
		const requests = installNetwork({});
		const vault = new MemoryVault();
		vault.addText(NOTE, note('# M'));
		const importer = new AttachmentImporter({ app: vault.app() });
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'permanent/a.png' }],
			ALL,
			false,
			REC,
		);
		expect(requests).toEqual([
			{
				url: 'https://api.plaud.ai/permanent/a.png',
				headers: { Accept: '*/*' },
			},
			{
				url: 'https://web.plaud.ai/permanent/a.png',
				headers: { Accept: '*/*' },
			},
		]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it.each<[string, string | null, string, string | null]>([
		['null token', null, 'https://api.plaud.ai/x.png', null],
		['blank token', '   ', 'https://api.plaud.ai/x.png', null],
		[
			'padded token on a Plaud host',
			` ${TOKEN} `,
			'https://api.plaud.ai/x.png',
			`Bearer ${TOKEN}`,
		],
		[
			'X-Amz-Signature query on any host',
			TOKEN,
			'https://files.example.com/x.png?X-Amz-Signature=abc',
			null,
		],
		[
			'amazonaws.com host without a signature',
			TOKEN,
			'https://bucket.s3.us-west-2.amazonaws.com/x.png',
			null,
		],
	])('Authorization header: %s', async (_label, token, url, expected) => {
		const requests = installNetwork({
			[url]: { contentType: 'image/png', body: png(1) },
		});
		const { importer } = setup({ token });
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url }],
			ALL,
			false,
			REC,
		);
		expect(at(requests, 0).headers.Authorization ?? null).toBe(expected);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: mindmap and card', () => {
	it('handles mindmap images, mindmap HTML, card HTML wrappers and card files', async () => {
		const requests = installNetwork({
			// 1. Mindmap image via relative path.
			'https://api.plaud.ai/permanent/rec/mindmap.png': {
				contentType: 'image/png',
				body: png(10),
			},
			// 2. Mindmap HTML with no images: saved as an .html file.
			'https://cdn.example.com/mm.html': {
				contentType: 'text/html',
				body: '<html><div id="mindmap">tree</div></html>',
			},
			// 3. Card HTML wrapper: nested images scraped and downloaded.
			'https://cdn.example.com/card-wrapper': {
				contentType: 'text/html',
				body: [
					'<html>',
					'<img src="data:image/png;base64,AAAA">',
					'<img src="https://cdn.example.com/icons/close.svg">',
					'<img src="permanent/rec/poster.png">',
					'<img src="https://cdn.example.com/notes.txt">',
					'<source srcset="https://cdn.example.com/p-1x.webp 1x, https://cdn.example.com/p-2x.webp 2x">',
					'<div style="background:url(\'https://cdn.example.com/bg.jpg\')"></div>',
					'</html>',
				].join('\n'),
			},
			'https://api.plaud.ai/permanent/rec/poster.png': {
				contentType: 'text/html',
				body: '<html>login</html>',
			},
			'https://web.plaud.ai/permanent/rec/poster.png': {
				contentType: 'image/png',
				body: png(20),
			},
			'https://cdn.example.com/p-1x.webp': {
				contentType: 'image/webp',
				body: png(21),
			},
			'https://cdn.example.com/p-2x.webp': {
				contentType: 'image/webp',
				body: png(22),
			},
			'https://cdn.example.com/bg.jpg': { status: 404, body: '' },
			// 4/5. Card non-image files.
			'https://cdn.example.com/card-a.txt': {
				contentType: 'text/plain',
				body: 'card text a',
			},
			'https://cdn.example.com/card-b.txt': {
				contentType: 'text/plain',
				body: 'card text b',
			},
			// 6. Generic HTML whose body mentions "mind map": its image is a
			// mindmap image.
			'https://cdn.example.com/wrapper2': {
				contentType: 'text/html',
				body: '<h1>Mind map</h1><img src="https://cdn.example.com/x/diagram.png">',
			},
			'https://cdn.example.com/x/diagram.png': {
				contentType: 'image/png',
				body: png(30),
			},
		});
		const { vault, importer } = setup();

		await importer.importAttachmentsForNote(
			NOTE,
			[
				{ dataType: 'mindmap', url: 'permanent/rec/mindmap.png' },
				{
					dataType: 'mindmap_html',
					url: 'https://cdn.example.com/mm.html',
				},
				{
					dataType: 'card',
					url: 'https://cdn.example.com/card-wrapper',
				},
				{ dataType: 'card', url: 'https://cdn.example.com/card-a.txt' },
				{ dataType: 'card', url: 'https://cdn.example.com/card-b.txt' },
				{ dataType: 'other', url: 'https://cdn.example.com/wrapper2' },
			],
			ALL,
			false,
			REC,
		);

		expect(vault.paths()).toEqual([
			`${FOLDER}/${P}-card-file.txt`,
			`${FOLDER}/${P}-card-file2.txt`,
			`${FOLDER}/${P}-card.png`,
			`${FOLDER}/${P}-card2.webp`,
			`${FOLDER}/${P}-card3.webp`,
			`${FOLDER}/${P}-mindmap.html`,
			`${FOLDER}/${P}-mindmap.png`,
			`${FOLDER}/${P}-mindmap2.png`,
			NOTE,
		]);
		// The bg.jpg 404 is a nested failure, which never warns; every
		// primary asset imported.
		expect(warnSpy).not.toHaveBeenCalled();
		// data:, close.svg and the non-image notes.txt are never requested.
		const urls = requests.map((r) => r.url);
		expect(urls).not.toContain('https://cdn.example.com/icons/close.svg');
		expect(urls).not.toContain('https://cdn.example.com/notes.txt');
		expect(urls.some((u) => u.startsWith('data:'))).toBe(false);

		expect(vault.text(NOTE)).toBe(
			note(
				[
					'# Meeting',
					'',
					'## Images and Attachments',
					'',
					'_Imported from Plaud file-detail assets at import time._',
					'',
					'### Mindmap',
					'',
					'#### Mindmap image 1',
					`![[${FOLDER}/${P}-mindmap.png]]`,
					'',
					'#### Mindmap image 2',
					`![[${FOLDER}/${P}-mindmap2.png]]`,
					'',
					'#### Mindmap file 1',
					`- [[${FOLDER}/${P}-mindmap.html]]`,
					'',
					'### Card',
					'',
					`![[${FOLDER}/${P}-card.png]]`,
					'',
					`![[${FOLDER}/${P}-card2.webp]]`,
					'',
					`![[${FOLDER}/${P}-card3.webp]]`,
					'',
					`- [[${FOLDER}/${P}-card-file.txt]]`,
					'',
					`- [[${FOLDER}/${P}-card-file2.txt]]`,
					'',
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		);
		expect(snapshotState(vault, requests)).toMatchSnapshot();
	});

	it('names a second mindmap HTML file mindmap-file2 and a mindmap image collision gets a -2 suffix', async () => {
		installNetwork({
			'https://cdn.example.com/m1.html': {
				contentType: 'text/html',
				body: '<p>mindmap one</p>',
			},
			'https://cdn.example.com/m2.html': {
				contentType: 'text/html',
				body: '<p>mindmap two</p>',
			},
			// Same bytes as m1: reuses the first path, renders once.
			'https://cdn.example.com/m1-again.html': {
				contentType: 'text/html',
				body: '<p>mindmap one</p>',
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{ dataType: 'mindmap', url: 'https://cdn.example.com/m1.html' },
				{ dataType: 'mindmap', url: 'https://cdn.example.com/m2.html' },
				{
					dataType: 'mindmap',
					url: 'https://cdn.example.com/m1-again.html',
				},
			],
			ALL,
			false,
			REC,
		);
		expect(vault.paths()).toEqual([
			`${FOLDER}/${P}-mindmap-file2.html`,
			`${FOLDER}/${P}-mindmap.html`,
			NOTE,
		]);
		const text = vault.text(NOTE);
		expect(text).toContain('#### Mindmap file 2');
		expect(text).not.toContain('#### Mindmap file 3');
	});
});

describe('AttachmentImporter.importAttachmentsForNote: JSON picture_link envelopes', () => {
	it('downloads every distinct picture_link and never saves the JSON', async () => {
		const requests = installNetwork({
			'https://cdn.example.com/meta.json': {
				contentType: 'application/json',
				body: JSON.stringify({
					items: [
						{ picture_link: ' permanent/p/one.png ' },
						{
							nested: {
								picture_link: 'https://cdn.example.com/two',
							},
						},
						{ picture_link: 'permanent/p/one.png' },
						{ picture_link: '' },
					],
				}),
			},
			'https://bucket.s3.amazonaws.com/one.png?X-Amz-Signature=z': {
				contentType: 'image/png',
				body: png(40),
			},
			'https://cdn.example.com/two': {
				contentType: 'image/webp',
				body: png(41),
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{
					dataType: 'summary_link',
					url: 'https://cdn.example.com/meta.json',
				},
			],
			ALL,
			false,
			REC,
			{
				'permanent/p/one.png':
					'https://bucket.s3.amazonaws.com/one.png?X-Amz-Signature=z',
			},
		);
		expect(requests.map((r) => r.url)).toEqual([
			'https://cdn.example.com/meta.json',
			'https://bucket.s3.amazonaws.com/one.png?X-Amz-Signature=z',
			'https://cdn.example.com/two',
		]);
		expect(vault.paths()).toEqual([
			`${FOLDER}/${P}-image1.png`,
			`${FOLDER}/${P}-image2.webp`,
			NOTE,
		]);
		expect(vault.text(NOTE)).toContain(
			[
				'### Other attachments',
				'',
				'#### Image 1',
				`![[${FOLDER}/${P}-image1.png]]`,
				'',
				'#### Image 2',
				`![[${FOLDER}/${P}-image2.webp]]`,
			].join('\n'),
		);
		expect(snapshotState(vault, requests)).toMatchSnapshot();
	});

	it('warns when an unparseable JSON envelope yields nothing', async () => {
		installNetwork({
			'https://cdn.example.com/bad.json': {
				contentType: 'application/json',
				body: '{not json',
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'https://cdn.example.com/bad.json' }],
			ALL,
			false,
			REC,
		);
		// Nothing is saved from the envelope, so the user gets a warning.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(vault.paths()).toEqual([NOTE]);
		expect(vault.processed).toEqual([]);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: Plaud marks', () => {
	const MARK1 = 'https://bucket.s3.amazonaws.com/m1.jpg?X-Amz-Signature=a';
	const MARK2 = 'https://bucket.s3.amazonaws.com/m2.jpg?X-Amz-Signature=b';

	it('saves screenshots, repoints inline embeds, and adds no managed section', async () => {
		const requests = installNetwork({
			[MARK1]: { contentType: 'image/jpeg', body: png(50) },
			[MARK2]: { contentType: 'image/jpeg', body: png(51) },
		});
		const body = [
			'# Meeting',
			'',
			'## Screenshots',
			'',
			`![](${MARK1})`,
			`![shot "2"](${MARK2} "title")`,
			'',
			'## Transcript',
			'',
			'hello',
		].join('\n');
		const { vault, importer } = setup({ noteText: note(body) });
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{ dataType: 'plaud_mark', url: MARK1 },
				{ dataType: 'plaud_mark', url: MARK2 },
			],
			ALL,
			false,
			REC,
		);
		expect(vault.paths()).toEqual([
			`${FOLDER}/${P}-screenshot.jpg`,
			`${FOLDER}/${P}-screenshot2.jpg`,
			NOTE,
		]);
		expect(
			requests.every((r) => r.headers.Authorization === undefined),
		).toBe(true);
		expect(vault.processed).toEqual([NOTE]);
		expect(vault.text(NOTE)).toBe(
			note(
				body
					.replace(
						`![](${MARK1})`,
						`![[${FOLDER}/${P}-screenshot.jpg]]`,
					)
					.replace(
						`![shot "2"](${MARK2} "title")`,
						`![[${FOLDER}/${P}-screenshot2.jpg]]`,
					),
			),
		);
	});

	it('skips marks entirely when screenshots are deselected', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'plaud_mark', url: MARK1 }],
			{ ...ALL, includeScreenshots: false },
			false,
			REC,
		);
		expect(requests).toEqual([]);
		expect(vault.processed).toEqual([]);
	});

	it('saves a non-image mark and lists it under other attachments', async () => {
		installNetwork({
			[MARK1]: { contentType: 'application/pdf', body: '%PDF' },
		});
		const { vault, importer } = setup();
		const before = vault.text(NOTE);
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'plaud_mark', url: MARK1 }],
			ALL,
			false,
			REC,
		);
		// The note links the file, so nothing in the assets folder is orphaned.
		expect(vault.files.has(`${FOLDER}/${P}-file1.pdf`)).toBe(true);
		expect(vault.text(NOTE)).not.toBe(before);
		expect(vault.text(NOTE)).toContain(`- [[${FOLDER}/${P}-file1.pdf]]`);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: replaceExisting', () => {
	const IMG = 'https://cdn.example.com/a.png';

	function seedFolder(vault: MemoryVault): void {
		vault.addBinary(`${FOLDER}/${P}-image1.png`, png(99));
		vault.addText(`${FOLDER}/Transcript.md`, 'transcript file');
		vault.addBinary(`${FOLDER}/sub/x.png`, png(98));
		vault.addText(`${FOLDER}/sub/Transcript.md`, 'nested');
	}

	it('true: trashes everything except the top-level Transcript.md, then reuses the freed names', async () => {
		const requests = installNetwork({
			[IMG]: { contentType: 'image/png', body: png(1) },
		});
		const { vault, importer } = setup({
			noteText: note(
				[
					'# Meeting',
					'',
					'## Images and Attachments',
					'',
					'_Imported from Plaud file-detail assets at import time._',
					'',
					'### Other attachments',
					'',
					'#### Image 1',
					'![[old.png]]',
				].join('\n'),
			),
		});
		seedFolder(vault);
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: IMG }],
			ALL,
			true,
			REC,
		);
		expect([...vault.trashed].sort()).toEqual([
			`${FOLDER}/${P}-image1.png`,
			`${FOLDER}/sub`,
			`${FOLDER}/sub/Transcript.md`,
			`${FOLDER}/sub/x.png`,
		]);
		expect(vault.paths()).toEqual([
			`${FOLDER}/Transcript.md`,
			`${FOLDER}/${P}-image1.png`,
			NOTE,
		]);
		expect(vault.bytes(`${FOLDER}/${P}-image1.png`)).toEqual(png(1));
		// The old managed section is replaced, not duplicated.
		const text = vault.text(NOTE);
		expect(text).not.toContain('old.png');
		expect(text.match(/## Images and Attachments/g)).toHaveLength(1);
		expect(snapshotState(vault, requests)).toMatchSnapshot();
	});

	it('false: keeps existing files and suffixes the colliding name', async () => {
		installNetwork({ [IMG]: { contentType: 'image/png', body: png(1) } });
		const { vault, importer } = setup();
		seedFolder(vault);
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: IMG }],
			ALL,
			false,
			REC,
		);
		expect(vault.trashed).toEqual([]);
		expect(vault.paths()).toEqual([
			`${FOLDER}/Transcript.md`,
			`${FOLDER}/${P}-image1-2.png`,
			`${FOLDER}/${P}-image1.png`,
			`${FOLDER}/sub/Transcript.md`,
			`${FOLDER}/sub/x.png`,
			NOTE,
		]);
		expect(vault.bytes(`${FOLDER}/${P}-image1.png`)).toEqual(png(99));
		expect(vault.text(NOTE)).toContain(`![[${FOLDER}/${P}-image1-2.png]]`);
	});

	it('replacing an existing managed section keeps the Audio and Transcript sections after it', async () => {
		installNetwork({ [IMG]: { contentType: 'image/png', body: png(1) } });
		const { vault, importer } = setup({
			noteText: note(
				[
					'# Meeting',
					'',
					'## Images and Attachments',
					'',
					'_Imported from Plaud file-detail assets at import time._',
					'',
					'![[old.png]]',
					'',
					'## Audio',
					'',
					'_Original recording audio downloaded from Plaud at import time._',
					'',
					'![[a.ogg]]',
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		});
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: IMG }],
			ALL,
			false,
			REC,
		);
		const text = vault.text(NOTE);
		expect(text).not.toContain('old.png');
		expect(text.match(/## Images and Attachments/g)).toHaveLength(1);
		expect(text).toContain(`![[${FOLDER}/${P}-image1.png]]`);
		expect(text).toContain('## Audio');
		expect(text).toContain('![[a.ogg]]');
		// The new section lands before the transcript, which is kept intact.
		expect(text.indexOf('## Images and Attachments')).toBeLessThan(
			text.indexOf('## Transcript'),
		);
		expect(text).toContain('## Transcript\n\nhello');
	});
});

describe('AttachmentImporter.importAttachmentsForNote: kind dedupe across kinds', () => {
	it('lists the same payload under each kind that downloaded it', async () => {
		installNetwork({
			'https://cdn.example.com/a.png': {
				contentType: 'image/png',
				body: png(7),
			},
			'https://cdn.example.com/card.png': {
				contentType: 'image/png',
				body: png(7),
			},
		});
		const { vault, importer } = setup();
		await importer.importAttachmentsForNote(
			NOTE,
			[
				{ dataType: 'other', url: 'https://cdn.example.com/a.png' },
				{ dataType: 'other', url: 'https://cdn.example.com/card.png' },
			],
			ALL,
			false,
			REC,
		);
		// The second URL contains "card", so it classifies as a card and
		// reuses the generic image path.
		expect(vault.paths()).toEqual([`${FOLDER}/${P}-image1.png`, NOTE]);
		const text = vault.text(NOTE);
		expect(text).toContain(
			`### Card\n\n![[${FOLDER}/${P}-image1.png]]\n\n`,
		);
		expect(text).toContain(`#### Image 1\n![[${FOLDER}/${P}-image1.png]]`);
	});
});

describe('AttachmentImporter.importAttachmentsForNote: notes without markers', () => {
	it('rewrites the whole note and appends when there is no transcript', async () => {
		installNetwork({
			'https://cdn.example.com/a.pdf': {
				contentType: 'application/pdf',
				body: '%PDF',
			},
		});
		const { vault, importer } = setup({ noteText: '# Legacy\n\nbody\n' });
		await importer.importAttachmentsForNote(
			NOTE,
			[{ dataType: 'other', url: 'https://cdn.example.com/a.pdf' }],
			ALL,
			false,
			REC,
		);
		expect(vault.text(NOTE)).toBe(
			[
				'# Legacy',
				'',
				'body',
				'',
				'## Images and Attachments',
				'',
				'_Imported from Plaud file-detail assets at import time._',
				'',
				'### Other attachments',
				'',
				'#### File 1',
				`- [[${FOLDER}/${P}-file1.pdf]]`,
				'',
				'',
			].join('\n'),
		);
	});
});

// ---------------------------------------------------------------------------
// importAudioForNote
// ---------------------------------------------------------------------------

describe('AttachmentImporter.importAudioForNote', () => {
	const AUDIO = 'https://bucket.s3.amazonaws.com/a.ogg?X-Amz-Signature=q';
	const AUDIO_PATH = `${FOLDER}/${P}-audio.ogg`;
	const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

	it('downloads, writes the file, inserts the section before the transcript, and returns the byte count', async () => {
		const requests = installNetwork({
			[AUDIO]: { contentType: 'audio/ogg', body: OGG },
		});
		const { vault, importer } = setup();
		const result = await importer.importAudioForNote(NOTE, AUDIO, REC);
		expect(result).toBe(OGG.byteLength);
		expect(vault.bytes(AUDIO_PATH)).toEqual(OGG);
		expect(requests).toEqual([{ url: AUDIO, headers: { Accept: '*/*' } }]);
		expect(vault.text(NOTE)).toBe(
			note(
				[
					'# Meeting',
					'',
					'## Audio',
					'',
					'_Original recording audio downloaded from Plaud at import time._',
					'',
					`![[${AUDIO_PATH}]]`,
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		);
		expect(snapshotState(vault, requests)).toMatchSnapshot();
	});

	it('re-import modifies the existing file in place and replaces its section', async () => {
		installNetwork({ [AUDIO]: { contentType: 'audio/ogg', body: OGG } });
		const { vault, importer } = setup();
		await importer.importAudioForNote(NOTE, AUDIO, REC);
		const once = vault.text(NOTE);
		const second = await importer.importAudioForNote(NOTE, AUDIO, REC);
		expect(second).toBe(OGG.byteLength);
		expect(vault.modifiedBinary).toEqual([AUDIO_PATH]);
		expect(vault.text(NOTE)).toBe(once);
	});

	it('sends the bearer to a non-AWS audio URL and names the file audio.ogg without a prefix', async () => {
		const url = 'https://api.plaud.ai/file/audio/1';
		const requests = installNetwork({
			[url]: { contentType: 'audio/ogg', body: OGG },
		});
		const { vault, importer } = setup();
		await importer.importAudioForNote(NOTE, url, '!!!');
		expect(at(requests, 0).headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(vault.files.has(`${FOLDER}/audio.ogg`)).toBe(true);
	});

	it('places audio after an existing attachments section and before the transcript', async () => {
		installNetwork({ [AUDIO]: { contentType: 'audio/ogg', body: OGG } });
		const { vault, importer } = setup({
			noteText: note(
				[
					'# M',
					'',
					'## Images and Attachments',
					'',
					'_Imported from Plaud file-detail assets at import time._',
					'',
					'![[i.png]]',
					'',
					'## Transcript',
					'',
					'hello',
				].join('\n'),
			),
		});
		await importer.importAudioForNote(NOTE, AUDIO, REC);
		const text = vault.text(NOTE);
		const iAttach = text.indexOf('## Images and Attachments');
		const iAudio = text.indexOf('## Audio');
		const iTranscript = text.indexOf('## Transcript');
		expect(iAttach).toBeLessThan(iAudio);
		expect(iAudio).toBeLessThan(iTranscript);
	});

	it('returns null without a request when the note is missing', async () => {
		const requests = installNetwork({});
		const { importer } = setup();
		expect(
			await importer.importAudioForNote('Plaud/Nope.md', AUDIO, REC),
		).toBeNull();
		expect(requests).toEqual([]);
	});

	it('continues when createFolder throws "already exists"', async () => {
		installNetwork({ [AUDIO]: { contentType: 'audio/ogg', body: OGG } });
		const { vault, importer } = setup();
		vault.createFolderError = 'Folder already exists.';
		expect(await importer.importAudioForNote(NOTE, AUDIO, REC)).toBe(
			OGG.byteLength,
		);
	});

	it('returns null on any other createFolder failure', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		vault.createFolderError = 'EACCES';
		expect(await importer.importAudioForNote(NOTE, AUDIO, REC)).toBeNull();
		expect(requests).toEqual([]);
	});

	it.each<[string, Route]>([
		['non-2xx', { status: 403, body: 'denied' }],
		['empty body', { contentType: 'audio/ogg', body: '' }],
		['thrown error', new Error('offline')],
	])('returns null and leaves the note intact on %s', async (_l, route) => {
		installNetwork({ [AUDIO]: route });
		const { vault, importer } = setup();
		const before = vault.text(NOTE);
		expect(await importer.importAudioForNote(NOTE, AUDIO, REC)).toBeNull();
		expect(vault.files.has(AUDIO_PATH)).toBe(false);
		expect(vault.text(NOTE)).toBe(before);
	});

	it('returns null when the vault write throws, without touching the note', async () => {
		installNetwork({ [AUDIO]: { contentType: 'audio/ogg', body: OGG } });
		const { vault, importer } = setup();
		vault.failCreateBinary = AUDIO_PATH;
		const before = vault.text(NOTE);
		expect(await importer.importAudioForNote(NOTE, AUDIO, REC)).toBeNull();
		expect(vault.text(NOTE)).toBe(before);
	});

	it('skips an empty or unparseable audio URL without any request', async () => {
		const requests = installNetwork({});
		const { vault, importer } = setup();
		const before = vault.text(NOTE);
		expect(await importer.importAudioForNote(NOTE, '', REC)).toBeNull();
		expect(
			await importer.importAudioForNote(NOTE, 'not a url', REC),
		).toBeNull();
		expect(requests).toEqual([]);
		expect(vault.text(NOTE)).toBe(before);
	});

	it('sends the bearer to a Plaud host but not to another host or over http', async () => {
		const plaud = 'https://api.plaud.ai/audio/x.ogg';
		const other = 'https://cdn.example.com/x.ogg';
		const insecure = 'http://api.plaud.ai/audio/x.ogg';
		const requests = installNetwork({
			[plaud]: { contentType: 'audio/ogg', body: OGG },
			[other]: { contentType: 'audio/ogg', body: OGG },
			[insecure]: { contentType: 'audio/ogg', body: OGG },
		});
		const { importer } = setup();
		await importer.importAudioForNote(NOTE, plaud, REC);
		await importer.importAudioForNote(NOTE, other, REC);
		await importer.importAudioForNote(NOTE, insecure, REC);
		expect(
			requests.map((r) => [r.url, r.headers.Authorization ?? null]),
		).toEqual([
			[plaud, `Bearer ${TOKEN}`],
			[other, null],
			[insecure, null],
		]);
	});
});

// ---------------------------------------------------------------------------
// Summary-link extraction and merge
// ---------------------------------------------------------------------------

describe('AttachmentImporter summary-link helpers', () => {
	const importer = new AttachmentImporter({ app: new MemoryVault().app() });

	it('extracts markdown, HTML-attribute and bare links, deduped and classified', () => {
		const md = [
			'![poster](permanent/x/summary_poster/p.png "t")',
			'[doc](<https://cdn.example.com/a.pdf?sig=1>)',
			'<img src="https://cdn.example.com/card-front.png">',
			'see https://cdn.example.com/a.pdf?sig=1 again',
			'/permanent/y/mind_map.html',
			'my-mindmap.htm',
			'[plain](notes.txt)',
		].join('\n');
		expect(importer.extractAttachmentAssetsFromSummaryMarkdown(md)).toEqual(
			[
				{
					dataType: 'summary_link',
					url: 'permanent/x/summary_poster/p.png',
					name: 'p.png',
				},
				{
					dataType: 'summary_link',
					url: 'https://cdn.example.com/a.pdf?sig=1',
					name: 'a.pdf',
				},
				{
					dataType: 'card',
					url: 'https://cdn.example.com/card-front.png',
					name: 'card-front.png',
				},
				{
					dataType: 'mindmap',
					url: '/permanent/y/mind_map.html',
					name: 'mind_map.html',
				},
				{
					dataType: 'mindmap',
					url: 'my-mindmap.htm',
					name: 'my-mindmap.htm',
				},
			],
		);
	});

	it('returns nothing for null or blank markdown', () => {
		expect(
			importer.extractAttachmentAssetsFromSummaryMarkdown(null),
		).toEqual([]);
		expect(
			importer.extractAttachmentAssetsFromSummaryMarkdown(' \n'),
		).toEqual([]);
	});

	it('merges by url, keeping base order and the base copy on conflict', () => {
		const a: AttachmentAsset = { dataType: 'a', url: 'u1' };
		const b: AttachmentAsset = { dataType: 'b', url: 'u2' };
		const dup: AttachmentAsset = { dataType: 'dup', url: 'u1' };
		const c: AttachmentAsset = { dataType: 'c', url: 'u3' };
		expect(importer.mergeAttachmentAssets([a, b], [dup, c, c])).toEqual([
			a,
			b,
			c,
		]);
		const base = [a];
		const merged = importer.mergeAttachmentAssets(base, []);
		expect(merged).toEqual([a]);
		expect(merged).not.toBe(base);
	});
});
