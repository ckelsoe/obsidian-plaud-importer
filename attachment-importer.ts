import {
	App,
	TFile,
	TFolder,
	requestUrl,
	type RequestUrlResponse,
} from 'obsidian';
import type { AttachmentAsset } from './plaud-client';
import { NoopDebugLogger, type DebugLogger } from './debug-logger';
import type { ArtifactSelection } from './import-core';

// Plaud host bases used to resolve relative asset paths into absolute
// download candidates. The API host can vary by region (EU accounts get
// `api-euc1.plaud.ai`, etc.), so it is supplied per-import via
// AttachmentImporterOptions.getApiBaseUrl rather than hardcoded. This
// constant is only the fallback when no provider is given. The web host has
// no known regional variants, so it stays a constant.
const DEFAULT_PLAUD_API_BASE = 'https://api.plaud.ai';
const PLAUD_WEB_BASE = 'https://web.plaud.ai';

type AttachmentKind = 'generic' | 'mindmap' | 'card';
type RenderedAsset = {
	readonly path: string;
	readonly isImage: boolean;
};
type AttachmentNamingCounters = {
	mindmapImage: number;
	mindmapFile: number;
	cardImage: number;
	cardFile: number;
	genericImage: number;
	genericFile: number;
};

export interface AttachmentImporterOptions {
	readonly app: App;
	/** Bearer-token provider for authenticated Plaud asset fetches. */
	readonly getAuthToken?: () => string | null;
	/**
	 * Provider for the current Plaud API host (e.g. a regional host detected
	 * at runtime). Read fresh per asset so a mid-session region switch is
	 * picked up. Defaults to the US host when omitted.
	 */
	readonly getApiBaseUrl?: () => string;
	/** Defaults to a NoopDebugLogger so logging calls never null-check. */
	readonly debugLogger?: DebugLogger;
}

/**
 * Downloads, classifies, names, and persists the supplemental assets of
 * one imported recording (mindmaps, cards, generic attachments, and the
 * picture links nested inside HTML/JSON wrappers), then rewrites the
 * note's managed attachments section.
 *
 * Extracted from ImportModal so the densest logic in the plugin lives
 * behind an explicit dependency surface (vault access, token provider,
 * debug logger) instead of inside the UI modal class.
 */
export class AttachmentImporter {
	private readonly app: App;
	private readonly resolveAuthToken: () => string | null;
	private readonly resolveApiBaseUrl: () => string;
	private readonly debugLogger: DebugLogger;

	constructor(options: AttachmentImporterOptions) {
		this.app = options.app;
		this.resolveAuthToken = options.getAuthToken ?? (() => null);
		this.resolveApiBaseUrl = options.getApiBaseUrl ?? (() => DEFAULT_PLAUD_API_BASE);
		this.debugLogger = options.debugLogger ?? new NoopDebugLogger();
	}

	async importAttachmentsForNote(
		notePath: string,
		attachments: readonly AttachmentAsset[],
		selection: ArtifactSelection,
		replaceExisting: boolean,
		recordingId: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): Promise<void> {
		if (attachments.length === 0) {
			return;
		}
		this.logAttachmentDebug('starting attachment import', {
			notePath,
			attachmentCount: attachments.length,
		});
		const noteFile = this.app.vault.getFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			this.logAttachmentDebug('attachment import aborted: note file not found', {
				notePath,
			});
			return;
		}
		const folderPath = notePath.replace(/\.md$/i, '-assets');
		const folder = this.app.vault.getFolderByPath(folderPath);
		if (folder === null) {
			await this.app.vault.createFolder(folderPath);
			this.logAttachmentDebug('created attachment folder', { folderPath });
		} else if (replaceExisting && folder instanceof TFolder) {
			await this.clearAttachmentFolder(folder);
			this.logAttachmentDebug('cleared existing attachment folder for overwrite', {
				folderPath,
			});
		}

		const genericLinks: string[] = [];
		const mindmapAssets: RenderedAsset[] = [];
		const cardAssets: RenderedAsset[] = [];
		const genericAssets: RenderedAsset[] = [];
		const mindmapLinks: string[] = [];
		const cardLinks: string[] = [];
		const payloadToPath = new Map<string, string>();
		// Maps a downloaded asset's ORIGINAL Plaud link (asset.url, the same
		// normalized string the summary extractor produced) to its local vault
		// path, so inline `![](permanent/...)` embeds in the summary body can be
		// repointed at the local copy after download (issue #52).
		const summaryEmbedRewrites = new Map<string, string>();
		const renderedLinks = new Set<string>();
		const namingCounters: AttachmentNamingCounters = {
			mindmapImage: 0,
			mindmapFile: 0,
			cardImage: 0,
			cardFile: 0,
			genericImage: 0,
			genericFile: 0,
		};
		const idPrefix = this.getAttachmentIdPrefix(recordingId);
		let htmlMindmapCandidates = 0;
		const pushRenderedAsset = (
			kind: AttachmentKind,
			path: string,
			isImage: boolean,
		): void => {
			const dedupeKey = `${kind}:${path}`;
			if (renderedLinks.has(dedupeKey)) {
				return;
			}
			renderedLinks.add(dedupeKey);
			switch (kind) {
				case 'mindmap':
					mindmapAssets.push({ path, isImage });
					break;
				case 'card':
					cardAssets.push({ path, isImage });
					break;
				default:
					genericAssets.push({ path, isImage });
			}
		};
		for (let i = 0; i < attachments.length; i++) {
			const asset = attachments[i];
			const assetLabel = `${asset.dataType}#${i + 1}`;
			const kind = this.classifyAttachmentKind(asset);
			if (!this.shouldIncludeAttachmentKind(kind, selection)) {
				this.logAttachmentDebug('skipping attachment due to artifact selection', {
					assetLabel,
					dataType: asset.dataType,
					kind,
				});
				continue;
			}
			this.logAttachmentDebug('downloading primary attachment', {
				assetLabel,
				dataType: asset.dataType,
				name: asset.name ?? null,
				mimeType: asset.mimeType ?? null,
				url: this.sanitizeUrlForDebug(asset.url),
			});
			const candidates = this.buildAssetUrlCandidates(
				asset.url,
				nestedAssetLinks,
			);
			this.logAttachmentDebug('primary attachment candidates resolved', {
				assetLabel,
				candidates: candidates.map((candidate) => this.sanitizeUrlForDebug(candidate)),
			});
			let imported = false;
			for (const candidate of candidates) {
				try {
					const headers: Record<string, string> = { Accept: '*/*' };
					const token = this.resolveAuthToken()?.trim();
					if (
						token &&
						token.length > 0 &&
						this.shouldSendAuthHeader(candidate)
					) {
						headers.Authorization = `Bearer ${token}`;
					}
				const blob = await requestUrl({
						url: candidate,
					method: 'GET',
					throw: false,
						headers,
				});
				const contentType = this.getResponseHeader(blob, 'content-type') ?? null;
				this.logAttachmentDebug('primary attachment response', {
					assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					status: blob.status,
					contentType,
				});
				if (blob.status < 200 || blob.status >= 300) {
					this.logAttachmentDebug('skipping primary attachment due to non-2xx status', {
						assetLabel,
							candidate: this.sanitizeUrlForDebug(candidate),
						status: blob.status,
					});
						continue;
				}
				const bytes = this.responseToArrayBuffer(blob);
				if (bytes === null) {
					this.logAttachmentDebug('skipping primary attachment: empty body', {
						assetLabel,
							candidate: this.sanitizeUrlForDebug(candidate),
					});
						continue;
				}
				const bodyText = blob.text ?? '';
				const ext = inferAssetExtension(asset, bodyText, contentType ?? '');
				this.logAttachmentDebug('resolved primary attachment extension', {
					assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					extension: ext,
					byteLength: bytes.byteLength,
				});
				if ((contentType ?? '').toLowerCase().includes('text/html')) {
					this.logAttachmentDebug('parsing html attachment for image references', {
						assetLabel,
						bodyPreview: this.makeBodyPreview(bodyText),
					});
					const imageLinks = this.extractImageLinksFromHtml(bodyText);
					const htmlKind = this.classifyHtmlArtifactKind(bodyText, kind);
					if (htmlKind === 'mindmap') {
						htmlMindmapCandidates += 1;
					}
					this.logAttachmentDebug('html attachment image extraction result', {
						assetLabel,
						htmlKind,
						imageLinkCount: imageLinks.length,
						imageLinks: imageLinks.map((link) => this.sanitizeUrlForDebug(link)),
					});
					if (imageLinks.length > 0) {
						for (let j = 0; j < imageLinks.length; j++) {
							const nestedLabel = `${assetLabel}/html#${j + 1}`;
							const nestedKind =
								htmlKind !== 'generic'
									? htmlKind
									: this.classifyAttachmentKindFromValues(
											asset.dataType,
											asset.name,
											imageLinks[j],
										);
							const nested = await this.downloadNestedPictureAsset(
								imageLinks[j],
								folderPath,
								nestedKind,
								nestedLabel,
								payloadToPath,
								namingCounters,
								idPrefix,
								nestedAssetLinks,
							);
							if (nested !== null) {
								pushRenderedAsset(nestedKind, nested, true);
							}
						}
					}
					if (imageLinks.length === 0 && htmlKind === 'mindmap') {
						const fp = this.computeAttachmentFingerprint(bytes);
						const existingPath = payloadToPath.get(fp);
						if (existingPath !== undefined) {
							pushRenderedAsset('mindmap', existingPath, false);
						} else {
							const baseName = this.nextAttachmentBaseName(
								'mindmap',
								false,
								namingCounters,
							);
							const prefixed = idPrefix.length > 0 ? `${idPrefix}-${baseName}` : baseName;
							const htmlPath = await this.resolveUniqueAttachmentPath(
								`${folderPath}/${prefixed}.html`,
							);
							await this.app.vault.createBinary(htmlPath, bytes);
							payloadToPath.set(fp, htmlPath);
							pushRenderedAsset('mindmap', htmlPath, false);
						}
					}
					// Never persist raw HTML wrappers as attachment files.
						imported = true;
						break;
				}
				// JSON blobs are only used as metadata envelopes (mainly to
				// discover nested picture_link images). We no longer persist
				// the raw JSON file to keep the imported asset folder clean.
				if (ext === 'json') {
					this.logAttachmentDebug('parsing json attachment for picture_link entries', {
						assetLabel,
						bodyPreview: this.makeBodyPreview(bodyText),
					});
					const extraction = this.extractPictureLinksFromJson(bodyText);
					this.logAttachmentDebug('json attachment picture_link extraction result', {
						assetLabel,
						pictureLinkCount: extraction.links.length,
						parseError: extraction.parseError ?? null,
						pictureLinks: extraction.links.map((link) =>
							this.sanitizeUrlForDebug(link),
						),
					});
					if (extraction.links.length > 0) {
						for (let j = 0; j < extraction.links.length; j++) {
							const nestedLabel = `${assetLabel}/nested#${j + 1}`;
							const nestedKind = this.classifyAttachmentKindFromValues(
								asset.dataType,
								asset.name,
								extraction.links[j],
							);
							const nested = await this.downloadNestedPictureAsset(
								extraction.links[j],
								folderPath,
								nestedKind,
								nestedLabel,
								payloadToPath,
								namingCounters,
								idPrefix,
								nestedAssetLinks,
							);
							if (nested !== null) {
								this.logAttachmentDebug('saved nested picture asset', {
									nestedLabel,
									path: nested,
								});
								pushRenderedAsset(nestedKind, nested, true);
							} else {
								this.logAttachmentDebug('nested picture asset download failed', {
									nestedLabel,
								});
							}
						}
					}
						imported = true;
						break;
				}
				const fp = this.computeAttachmentFingerprint(bytes);
				const existingPath = payloadToPath.get(fp);
				if (existingPath !== undefined) {
					this.logAttachmentDebug('reused existing attachment due to duplicate payload', {
						assetLabel,
						existingPath,
					});
					if (this.isImageExtension(ext)) {
						summaryEmbedRewrites.set(asset.url, existingPath);
						pushRenderedAsset(kind, existingPath, true);
					} else {
						pushRenderedAsset(kind, existingPath, false);
					}
					imported = true;
					break;
				}
				const base = this.nextAttachmentBaseName(
					kind,
					this.isImageExtension(ext),
					namingCounters,
				);
				const prefixed = idPrefix.length > 0 ? `${idPrefix}-${base}` : base;
				const attachmentPath = await this.resolveUniqueAttachmentPath(
					`${folderPath}/${prefixed}.${ext}`,
				);
				await this.app.vault.createBinary(attachmentPath, bytes);
				payloadToPath.set(fp, attachmentPath);
				this.logAttachmentDebug('saved primary attachment', {
					assetLabel,
					attachmentPath,
					byteLength: bytes.byteLength,
				});
				if (this.isImageExtension(ext)) {
					summaryEmbedRewrites.set(asset.url, attachmentPath);
					pushRenderedAsset(kind, attachmentPath, true);
				} else {
					pushRenderedAsset(kind, attachmentPath, false);
				}
					imported = true;
					break;
				} catch (err) {
					this.logAttachmentDebug('primary attachment import failed with exception', {
						assetLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			if (!imported) {
				console.warn(
					`Plaud importer: failed to import attachment for ${notePath}`,
					asset,
				);
			}
		}

		const renderSection = (
			title: string,
			assets: readonly RenderedAsset[],
			imageLabel: string,
			fileLabel: string,
		): readonly string[] => {
			if (assets.length === 0) {
				return [];
			}
			const lines: string[] = [title, ''];
			const images = assets.filter((asset) => asset.isImage);
			const files = assets.filter((asset) => !asset.isImage);
			if (images.length > 0) {
				for (let i = 0; i < images.length; i++) {
					lines.push(`#### ${imageLabel} ${i + 1}`, `![[${images[i].path}]]`, '');
				}
			}
			if (files.length > 0) {
				for (let i = 0; i < files.length; i++) {
					lines.push(`#### ${fileLabel} ${i + 1}`, `- [[${files[i].path}]]`, '');
				}
			}
			return lines;
		};
		const renderCardSection = (assets: readonly RenderedAsset[]): readonly string[] => {
			if (assets.length === 0) {
				return [];
			}
			const lines: string[] = ['### Card', ''];
			const images = assets.filter((asset) => asset.isImage);
			const files = assets.filter((asset) => !asset.isImage);
			for (const image of images) {
				lines.push(`![[${image.path}]]`, '');
			}
			for (const file of files) {
				lines.push(`- [[${file.path}]]`, '');
			}
			return lines;
		};
		mindmapLinks.push(
			...renderSection('### Mindmap', mindmapAssets, 'Mindmap image', 'Mindmap file'),
		);
		cardLinks.push(...renderCardSection(cardAssets));
		genericLinks.push(...renderSection('### Other attachments', genericAssets, 'Image', 'File'));
		if (selection.includeMindmap && mindmapAssets.length === 0) {
			const kindCounts = { generic: 0, mindmap: 0, card: 0 };
			for (const asset of attachments) {
				const k = this.classifyAttachmentKind(asset);
				kindCounts[k] += 1;
			}
			const keywordHintAssets = attachments
				.filter((asset) =>
					/(?:mindmap|mind-map|mind_map|mind map)/i.test(
						`${asset.dataType} ${asset.name ?? ''} ${asset.url}`,
					),
				)
				.map((asset) => ({
					dataType: asset.dataType,
					name: asset.name ?? null,
					url: this.sanitizeUrlForDebug(asset.url),
				}));
			const htmlLikeAssets = attachments
				.filter(
					(asset) =>
						/\.html?(?:$|\?)/i.test(asset.url) ||
						/\.html?(?:$|\?)/i.test(asset.name ?? ''),
				)
				.map((asset) => ({
					dataType: asset.dataType,
					name: asset.name ?? null,
					url: this.sanitizeUrlForDebug(asset.url),
				}));
			this.logAttachmentDebug('mindmap import produced no rendered assets', {
				notePath,
				attachmentCount: attachments.length,
				kindCounts,
				htmlMindmapCandidates,
				keywordHintAssetCount: keywordHintAssets.length,
				keywordHintAssets,
				htmlLikeAssetCount: htmlLikeAssets.length,
				htmlLikeAssets,
				likelyCause:
					keywordHintAssets.length === 0 && htmlMindmapCandidates === 0
						? 'no mindmap-like attachment references found in /file/detail bundle for this recording'
						: 'mindmap-like references were present but none rendered',
				attachmentDataTypes: attachments.map((a) => a.dataType),
				attachmentUrls: attachments.map((a) => this.sanitizeUrlForDebug(a.url)),
			});
		}
		const hasManagedLinks =
			genericLinks.length + mindmapLinks.length + cardLinks.length > 0;
		if (!hasManagedLinks && summaryEmbedRewrites.size === 0) {
			this.logAttachmentDebug('attachment import completed with no rendered links', {
				notePath,
			});
			return;
		}

		await this.app.vault.process(noteFile, (content) => {
			// Repoint Plaud's inline `![](permanent/...)` summary embeds at the
			// local copies we just downloaded (issue #52) BEFORE building the
			// managed section. The managed section uses `![[...]]` wikilinks,
			// which the inline-embed regex never matches, so ordering is safe.
			const repointed = rewriteInlineSummaryEmbeds(content, summaryEmbedRewrites);
			if (!hasManagedLinks) {
				return repointed;
			}
			const withoutManagedSection = this.stripManagedAttachmentsSection(repointed);
			const trimmed = withoutManagedSection.replace(/\s+$/, '');
			const section: string[] = [
				'## Images and Attachments',
				'',
				'_Imported from Plaud file-detail assets at import time._',
				'',
			];
			if (mindmapLinks.length > 0) section.push(...mindmapLinks);
			if (cardLinks.length > 0) section.push(...cardLinks);
			if (genericLinks.length > 0) section.push(...genericLinks);
			const renderedSection = section.join('\n');
			return this.insertManagedAttachmentsSection(trimmed, renderedSection);
		});
		this.logAttachmentDebug('attachments section appended to note', {
			notePath,
			renderedLinkCount: genericLinks.length + mindmapLinks.length + cardLinks.length,
			mindmapCount: mindmapLinks.length,
			cardCount: cardLinks.length,
		});
	}

	/**
	 * Download one recording's original audio into the note's `-assets` folder
	 * as `<idPrefix>-audio.ogg` and embed a playable transclude under a managed
	 * `## Audio` section. Returns the number of bytes written, or null when the
	 * download failed or produced no bytes, so the note is left intact and a
	 * missing or expired audio URL never breaks an import.
	 *
	 * The filename uses the short recording-id prefix (same scheme as image
	 * attachments), NOT the note title. The `-assets` folder is already named
	 * after the (often long) note title, so repeating the title in the audio
	 * filename pushed the absolute path over Windows' 260-char limit, and
	 * Obsidian's audio player then served no data (player stuck at 0:00). A
	 * short filename keeps the path well under the limit.
	 *
	 * Kept separate from importAttachmentsForNote because audio is not a
	 * file-detail asset: it comes from a dedicated temp-url, embeds as
	 * `![[...]]` (an inline player) rather than a file link, and is off by
	 * default. This never clears the assets folder (attachments own the
	 * overwrite-clear and run first in the import loop); on an overwrite it
	 * replaces its own `<idPrefix>-audio.ogg` in place, so re-imports never
	 * accumulate duplicate copies of the same recording.
	 */
	async importAudioForNote(
		notePath: string,
		audioUrl: string,
		recordingId: string,
	): Promise<number | null> {
		const noteFile = this.app.vault.getFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			this.logAttachmentDebug('audio import aborted: note file not found', {
				notePath,
			});
			return null;
		}
		const folderPath = notePath.replace(/\.md$/i, '-assets');
		// Best-effort contract: createFolder can throw. Keep the throw inside the
		// method so a real failure returns null instead of escaping. But an
		// "already exists" throw is NOT a failure: getFolderByPath and
		// createFolder can disagree (path normalization, a case-insensitive
		// filesystem, or a concurrent import that created the folder between the
		// check and the create). Key off the error message, exactly like
		// NoteWriter.ensureFolder, rather than a re-lookup that can disagree too;
		// only a genuine create failure returns null.
		if (this.app.vault.getFolderByPath(folderPath) === null) {
			try {
				await this.app.vault.createFolder(folderPath);
				this.logAttachmentDebug('created attachment folder for audio', { folderPath });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!/already exists/i.test(message)) {
					this.logAttachmentDebug('audio import aborted: could not create assets folder', {
						folderPath,
						error: message,
					});
					return null;
				}
				this.logAttachmentDebug('assets folder already present (create race)', {
					folderPath,
				});
			}
		}
		const idPrefix = this.getAttachmentIdPrefix(recordingId);
		const audioBase = idPrefix.length > 0 ? `${idPrefix}-audio` : 'audio';
		const audioPath = `${folderPath}/${audioBase}.ogg`;

		const headers: Record<string, string> = { Accept: '*/*' };
		const token = this.resolveAuthToken()?.trim();
		// The temp-url is a presigned S3 link carrying its own signature;
		// shouldSendAuthHeader returns false for it so no bearer is attached.
		const sendAuth =
			!!token && token.length > 0 && this.shouldSendAuthHeader(audioUrl);
		if (sendAuth && token) {
			headers.Authorization = `Bearer ${token}`;
		}
		this.logAttachmentDebug('downloading audio', {
			notePath,
			audioPath,
			url: this.sanitizeUrlForDebug(audioUrl),
			sendAuth,
		});
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: audioUrl,
				method: 'GET',
				throw: false,
				headers,
			});
		} catch (err) {
			this.logAttachmentDebug('audio download threw', {
				notePath,
				url: this.sanitizeUrlForDebug(audioUrl),
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
		const bytes = this.responseToArrayBuffer(response);
		this.logAttachmentDebug('audio download response', {
			notePath,
			status: response.status,
			contentType: this.getResponseHeader(response, 'content-type') ?? null,
			byteLength: bytes?.byteLength ?? 0,
		});
		if (response.status < 200 || response.status >= 300) {
			this.logAttachmentDebug('audio download returned non-2xx status', {
				notePath,
				url: this.sanitizeUrlForDebug(audioUrl),
				status: response.status,
			});
			return null;
		}
		if (bytes === null || bytes.byteLength === 0) {
			this.logAttachmentDebug('audio download produced no bytes', { notePath });
			return null;
		}

		// Vault writes can throw (path issues, a racing external edit). Keep
		// audio best-effort: log and return null rather than letting the throw
		// escape into the runner, which would otherwise surface only in the
		// DevTools console and never in the exportable debug session.
		try {
			const existing = this.app.vault.getFileByPath(audioPath);
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, bytes);
			} else {
				await this.app.vault.createBinary(audioPath, bytes);
			}

			await this.app.vault.process(noteFile, (content) => {
				const withoutManaged = this.stripManagedAudioSection(content);
				const trimmed = withoutManaged.replace(/\s+$/, '');
				const section = [
					'## Audio',
					'',
					'_Original recording audio downloaded from Plaud at import time._',
					'',
					`![[${audioPath}]]`,
				].join('\n');
				return this.insertSectionBeforeTranscript(trimmed, section);
			});
		} catch (err) {
			this.logAttachmentDebug('audio write failed', {
				notePath,
				audioPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
		this.logAttachmentDebug('audio section appended to note', {
			notePath,
			audioPath,
			byteLength: bytes.byteLength,
		});
		return bytes.byteLength;
	}

	private async clearAttachmentFolder(folder: TFolder): Promise<void> {
		const children = [...folder.children];
		for (const child of children) {
			if (child instanceof TFile) {
				await this.app.fileManager.trashFile(child);
				continue;
			}
			if (child instanceof TFolder) {
				await this.clearAttachmentFolder(child);
				await this.app.fileManager.trashFile(child);
			}
		}
	}

	private responseToArrayBuffer(response: RequestUrlResponse): ArrayBuffer | null {
		const candidate = (response as unknown as { arrayBuffer?: unknown }).arrayBuffer;
		if (candidate instanceof ArrayBuffer) {
			return candidate;
		}
		if (typeof response.text === 'string') {
			return new TextEncoder().encode(response.text).buffer;
		}
		return null;
	}

	private isImageExtension(ext: string): boolean {
		const normalized = ext.toLowerCase();
		return (
			normalized === 'png' ||
			normalized === 'jpg' ||
			normalized === 'jpeg' ||
			normalized === 'gif' ||
			normalized === 'webp' ||
			normalized === 'svg' ||
			normalized === 'bmp'
		);
	}

	classifyAttachmentKind(asset: AttachmentAsset): AttachmentKind {
		return this.classifyAttachmentKindFromValues(
			asset.dataType,
			asset.name,
			asset.url,
		);
	}

	private classifyAttachmentKindFromValues(
		dataType: string,
		name: string | undefined,
		url: string,
	): AttachmentKind {
		const haystack = `${dataType} ${name ?? ''} ${url}`.toLowerCase();
		if (
			haystack.includes('mindmap') ||
			haystack.includes('mind-map') ||
			haystack.includes('mind_map')
		) {
			return 'mindmap';
		}
		if (haystack.includes('card')) {
			return 'card';
		}
		return 'generic';
	}

	private classifyHtmlArtifactKind(
		html: string,
		baseKind: AttachmentKind,
	): AttachmentKind {
		if (baseKind !== 'generic') {
			return baseKind;
		}
		const lower = html.toLowerCase();
		if (
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map') ||
			lower.includes('mind map')
		) {
			return 'mindmap';
		}
		if (lower.includes('card')) {
			return 'card';
		}
		return 'generic';
	}

	private shouldIncludeAttachmentKind(
		kind: AttachmentKind,
		selection: ArtifactSelection,
	): boolean {
		switch (kind) {
			case 'mindmap':
				return selection.includeMindmap;
			case 'card':
				return selection.includeCard;
			default:
				return selection.includeAttachments;
		}
	}

	private getAttachmentIdPrefix(recordingId: string): string {
		const compact = recordingId.replace(/[^a-zA-Z0-9]/g, '');
		if (compact.length === 0) {
			return '';
		}
		return compact.slice(0, 8).toLowerCase();
	}

	private nextAttachmentBaseName(
		kind: AttachmentKind,
		isImage: boolean,
		counters: AttachmentNamingCounters,
	): string {
		if (kind === 'card' && isImage) {
			counters.cardImage += 1;
			return counters.cardImage === 1 ? 'card' : `card${counters.cardImage}`;
		}
		if (kind === 'mindmap' && isImage) {
			counters.mindmapImage += 1;
			return counters.mindmapImage === 1 ? 'mindmap' : `mindmap${counters.mindmapImage}`;
		}
		if (kind === 'mindmap' && !isImage) {
			counters.mindmapFile += 1;
			return counters.mindmapFile === 1 ? 'mindmap' : `mindmap-file${counters.mindmapFile}`;
		}
		if (kind === 'card' && !isImage) {
			counters.cardFile += 1;
			return counters.cardFile === 1 ? 'card-file' : `card-file${counters.cardFile}`;
		}
		if (isImage) {
			counters.genericImage += 1;
			return `image${counters.genericImage}`;
		}
		counters.genericFile += 1;
		return `file${counters.genericFile}`;
	}

	private async resolveUniqueAttachmentPath(basePath: string): Promise<string> {
		const dot = basePath.lastIndexOf('.');
		const stem = dot >= 0 ? basePath.slice(0, dot) : basePath;
		const ext = dot >= 0 ? basePath.slice(dot) : '';
		let candidate = basePath;
		let n = 2;
		while (this.app.vault.getFileByPath(candidate) !== null) {
			candidate = `${stem}-${n}${ext}`;
			n += 1;
		}
		return candidate;
	}

	private extractPictureLinksFromJson(text: string): {
		readonly links: readonly string[];
		readonly parseError?: string;
	} {
		const out: string[] = [];
		try {
			const parsed: unknown = JSON.parse(text);
			const walk = (value: unknown): void => {
				if (Array.isArray(value)) {
					for (const item of value) {
						walk(item);
					}
					return;
				}
				if (value !== null && typeof value === 'object') {
					const obj = value as Record<string, unknown>;
					const link = obj.picture_link;
					if (typeof link === 'string' && link.trim().length > 0) {
						out.push(link.trim());
					}
					for (const v of Object.values(obj)) {
						walk(v);
					}
				}
			};
			walk(parsed);
		} catch (err) {
			return {
				links: [],
				parseError: err instanceof Error ? err.message : String(err),
			};
		}
		return { links: [...new Set(out)] };
	}

	private extractImageLinksFromHtml(text: string): readonly string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const srcRegex = /<(?:img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
		const srcsetRegex = /<(?:img|source)\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["']/gi;
		const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/gi;
		const addCandidate = (raw: string): void => {
			const link = raw.trim();
			if (link.length === 0 || link.startsWith('data:')) {
				return;
			}
			const normalized = link.toLowerCase();
			if (
				normalized.includes('close.svg') ||
				normalized.includes('/close.svg')
			) {
				return;
			}
			if (
				!/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(normalized) &&
				!normalized.includes('mindmap') &&
				!normalized.includes('mind-map') &&
				!normalized.includes('mind_map') &&
				!normalized.includes('mind map') &&
				!normalized.includes('card')
			) {
				return;
			}
			if (!seen.has(link)) {
				seen.add(link);
				out.push(link);
			}
		};
		let match: RegExpExecArray | null;
		while ((match = srcRegex.exec(text)) !== null) {
			addCandidate(match[1]);
		}
		while ((match = srcsetRegex.exec(text)) !== null) {
			const candidates = match[1]
				.split(',')
				.map((entry) => entry.trim().split(/\s+/)[0])
				.filter((entry) => entry.length > 0);
			for (const candidate of candidates) {
				addCandidate(candidate);
			}
		}
		while ((match = cssUrlRegex.exec(text)) !== null) {
			addCandidate(match[2]);
		}
		return out;
	}

	private async downloadNestedPictureAsset(
		pictureLink: string,
		folderPath: string,
		kind: AttachmentKind,
		nestedLabel: string,
		payloadToPath: Map<string, string>,
		namingCounters: AttachmentNamingCounters,
		idPrefix: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): Promise<string | null> {
		const token = this.resolveAuthToken()?.trim();
		const candidates = this.buildAssetUrlCandidates(pictureLink, nestedAssetLinks);
		this.logAttachmentDebug('attempting nested picture download', {
			nestedLabel,
			pictureLink: this.sanitizeUrlForDebug(pictureLink),
			candidates: candidates.map((candidate) => this.sanitizeUrlForDebug(candidate)),
			hasAuthToken: Boolean(token && token.length > 0),
		});
		for (const candidate of candidates) {
			try {
				const headers: Record<string, string> = { Accept: '*/*' };
				if (token && token.length > 0 && this.shouldSendAuthHeader(candidate)) {
					headers.Authorization = `Bearer ${token}`;
				}
				const response = await requestUrl({
					url: candidate,
					method: 'GET',
					throw: false,
					headers,
				});
				this.logAttachmentDebug('nested picture response received', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					status: response.status,
					contentType: this.getResponseHeader(response, 'content-type') ?? null,
				});
				if (response.status < 200 || response.status >= 300) {
					this.logAttachmentDebug('nested candidate rejected by status', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						status: response.status,
					});
					continue;
				}
				const contentType = (this.getResponseHeader(response, 'content-type') ?? '').toLowerCase();
				if (contentType.includes('text/html')) {
					this.logAttachmentDebug('nested candidate rejected due to html content', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						contentType,
					});
					continue;
				}
				const bytes = this.responseToArrayBuffer(response);
				if (bytes === null) {
					this.logAttachmentDebug('nested candidate returned empty body', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
					});
					continue;
				}
				const ext = this.inferPictureExtension(
					candidate,
					response.text ?? '',
					this.getResponseHeader(response, 'content-type') ?? '',
				);
				const fp = this.computeAttachmentFingerprint(bytes);
				const existingPath = payloadToPath.get(fp);
				if (existingPath !== undefined) {
					this.logAttachmentDebug('nested picture reused existing payload', {
						nestedLabel,
						candidate: this.sanitizeUrlForDebug(candidate),
						existingPath,
					});
					return existingPath;
				}
				const baseName = this.nextAttachmentBaseName(kind, true, namingCounters);
				const prefixed = idPrefix.length > 0 ? `${idPrefix}-${baseName}` : baseName;
				const path = await this.resolveUniqueAttachmentPath(
					`${folderPath}/${prefixed}.${ext}`,
				);
				await this.app.vault.createBinary(path, bytes);
				payloadToPath.set(fp, path);
				this.logAttachmentDebug('nested picture asset saved', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					path,
					byteLength: bytes.byteLength,
				});
				return path;
			} catch (err) {
				this.logAttachmentDebug('nested candidate threw exception', {
					nestedLabel,
					candidate: this.sanitizeUrlForDebug(candidate),
					error: err instanceof Error ? err.message : String(err),
				});
				// Try next candidate host.
			}
		}
		this.logAttachmentDebug('all nested picture candidates exhausted', {
			nestedLabel,
			pictureLink: this.sanitizeUrlForDebug(pictureLink),
		});
		return null;
	}

	// Resolve an asset path (primary attachment or nested picture link) into
	// the ordered list of download candidates: an absolute URL passes through
	// untouched; a relative path tries the nested-asset-links map first, then
	// the API host, then the web host.
	private buildAssetUrlCandidates(
		pathOrUrl: string,
		nestedAssetLinks?: Readonly<Record<string, string>>,
	): readonly string[] {
		if (/^https?:\/\//i.test(pathOrUrl)) {
			return [pathOrUrl];
		}
		const normalized = pathOrUrl.replace(/^\/+/, '');
		const fromMap = nestedAssetLinks?.[normalized];
		const apiBase = this.resolveApiBaseUrl().replace(/\/+$/, '');
		return [
			...(typeof fromMap === 'string' && fromMap.length > 0 ? [fromMap] : []),
			`${apiBase}/${normalized}`,
			`${PLAUD_WEB_BASE}/${normalized}`,
		];
	}

	private shouldSendAuthHeader(url: string): boolean {
		try {
			const parsed = new URL(url);
			// Presigned S3 URLs include their own signature. Sending bearer auth can
			// invalidate the request and produce 400 signature errors.
			if (parsed.searchParams.has('X-Amz-Signature')) {
				return false;
			}
			if (parsed.hostname.endsWith('.amazonaws.com')) {
				return false;
			}
			return true;
		} catch {
			return true;
		}
	}

	private inferPictureExtension(
		url: string,
		bodyText: string,
		responseContentType: string,
	): string {
		const fromMime = responseContentType.toLowerCase();
		if (fromMime.includes('png')) return 'png';
		if (fromMime.includes('jpeg') || fromMime.includes('jpg')) return 'jpg';
		if (fromMime.includes('webp')) return 'webp';
		if (fromMime.includes('gif')) return 'gif';
		if (fromMime.includes('svg')) return 'svg';
		if (fromMime.includes('bmp')) return 'bmp';

		try {
			const pathname = new URL(url).pathname.toLowerCase();
			const m = pathname.match(/\.([a-z0-9]{2,6})$/);
			if (m) {
				return m[1];
			}
		} catch {
			// fallback below
		}
		const trimmed = bodyText.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
		return 'bin';
	}

	extractAttachmentAssetsFromSummaryMarkdown(
		summaryMarkdown: string | null,
	): readonly AttachmentAsset[] {
		if (summaryMarkdown === null || summaryMarkdown.trim().length === 0) {
			return [];
		}
		const out: AttachmentAsset[] = [];
		const seen = new Set<string>();
		const addCandidate = (raw: string): void => {
			const normalized = this.normalizeSummaryLink(raw);
			if (
				normalized.length === 0 ||
				!this.looksLikeSummaryAttachmentLink(normalized) ||
				seen.has(normalized)
			) {
				return;
			}
			seen.add(normalized);
			out.push({
				dataType: this.inferSummaryAttachmentDataType(normalized),
				url: normalized,
				name: this.extractSummaryAttachmentName(normalized),
			});
		};

		const markdownLinkRegex = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		let match: RegExpExecArray | null;
		while ((match = markdownLinkRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}

		const htmlAttributeRegex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
		while ((match = htmlAttributeRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}

		const bareUrlRegex =
			/(https?:\/\/[^\s<>"')\]]+|(?:\/)?permanent\/[^\s<>"')\]]+|\b[^/\s<>"')\]]*mindmap[^/\s<>"')\]]*\.html?\b)/gi;
		while ((match = bareUrlRegex.exec(summaryMarkdown)) !== null) {
			addCandidate(match[1]);
		}
		return out;
	}

	mergeAttachmentAssets(
		base: readonly AttachmentAsset[],
		extra: readonly AttachmentAsset[],
	): readonly AttachmentAsset[] {
		if (extra.length === 0) {
			return [...base];
		}
		const out: AttachmentAsset[] = [...base];
		const seen = new Set(base.map((asset) => asset.url));
		for (const asset of extra) {
			if (seen.has(asset.url)) {
				continue;
			}
			seen.add(asset.url);
			out.push(asset);
		}
		return out;
	}

	private normalizeSummaryLink(raw: string): string {
		const cleaned = raw.trim().replace(/^<|>$/g, '');
		return cleaned.replace(/^['"]|['"]$/g, '');
	}

	private looksLikeSummaryAttachmentLink(link: string): boolean {
		const lower = link.toLowerCase();
		return (
			lower.startsWith('http://') ||
			lower.startsWith('https://') ||
			lower.startsWith('permanent/') ||
			lower.startsWith('/permanent/') ||
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map') ||
			lower.includes('card') ||
			/\.(png|jpe?g|gif|webp|svg|bmp|html?|pdf|json)(\?|$)/i.test(link)
		);
	}

	private inferSummaryAttachmentDataType(link: string): string {
		const lower = link.toLowerCase();
		if (
			lower.includes('mindmap') ||
			lower.includes('mind-map') ||
			lower.includes('mind_map')
		) {
			return 'mindmap';
		}
		if (lower.includes('card')) {
			return 'card';
		}
		return 'summary_link';
	}

	private extractSummaryAttachmentName(link: string): string | undefined {
		const trimmed = link.trim();
		const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
		const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
		const withoutQuery = base.split('?')[0].split('#')[0].trim();
		return withoutQuery.length > 0 ? withoutQuery : undefined;
	}

	private computeAttachmentFingerprint(bytes: ArrayBuffer): string {
		const view = new Uint8Array(bytes);
		let hash = 2166136261;
		for (let i = 0; i < view.length; i++) {
			hash ^= view[i];
			hash = Math.imul(hash, 16777619);
		}
		return `${view.length}:${hash >>> 0}`;
	}

	private logAttachmentDebug(message: string, payload?: unknown): void {
		if (!this.debugLogger.enabled) {
			return;
		}
		this.debugLogger.log({
			kind: 'note',
			endpoint: '/attachments',
			message,
			payload,
		});
	}

	private sanitizeUrlForDebug(url: string): string {
		try {
			const parsed = new URL(url);
			return `${parsed.origin}${parsed.pathname}`;
		} catch {
			return url.slice(0, 200);
		}
	}

	private getResponseHeader(
		response: RequestUrlResponse,
		name: string,
	): string | undefined {
		const raw = (response as unknown as { headers?: Record<string, string> }).headers;
		if (!raw) {
			return undefined;
		}
		const wanted = name.toLowerCase();
		for (const [key, value] of Object.entries(raw)) {
			if (key.toLowerCase() === wanted) {
				return value;
			}
		}
		return undefined;
	}

	private makeBodyPreview(text: string, maxLength = 400): string {
		const compact = text.replace(/\s+/g, ' ').trim();
		if (compact.length <= maxLength) {
			return compact;
		}
		return `${compact.slice(0, maxLength)}...`;
	}

	private stripManagedAttachmentsSection(content: string): string {
		return content.replace(
			/\n## (?:Attachments|Images and Attachments)\s*\n\s*_Imported from Plaud file-detail assets at import time\._[\s\S]*$/m,
			'',
		);
	}

	private insertManagedAttachmentsSection(content: string, section: string): string {
		return this.insertSectionBeforeTranscript(content, section);
	}

	/**
	 * Insert a managed section just before the note's real transcript.
	 * Anchors on the LAST `Transcript` heading: it is always the real
	 * transcript (the final section). A consumer_note template output that
	 * renders a `### Transcript`/`#### Transcript` heading earlier in the
	 * note must not capture the anchor and split the Template outputs block.
	 * Shared by the attachments and audio sections.
	 */
	private insertSectionBeforeTranscript(content: string, section: string): string {
		const re = /\n#{1,6} Transcript\s*\n/g;
		let insertAt = -1;
		let match: RegExpExecArray | null;
		while ((match = re.exec(content)) !== null) {
			insertAt = match.index;
		}
		if (insertAt !== -1) {
			const before = content.slice(0, insertAt).replace(/\s+$/, '');
			const after = content.slice(insertAt).replace(/^\s*/, '');
			return `${before}\n\n${section}\n\n${after}\n`;
		}
		return `${content}\n\n${section}\n`;
	}

	private stripManagedAudioSection(content: string): string {
		// Precise-shape match (NOT greedy-to-EOF like the attachments strip)
		// so a re-import replaces only the managed Audio block and never eats
		// the neighbouring attachments or transcript sections.
		return content.replace(
			/\n## Audio\n\n_Original recording audio downloaded from Plaud at import time\._\n\n!\[\[[^\n]*\]\]\n?/,
			'\n',
		);
	}
}

/**
 * Repoint Plaud's inline image embeds in a note body at the locally
 * downloaded copies. Plaud's newer AI summary markdown embeds its card
 * poster (and any other picture) as `![alt](permanent/.../summary_poster/...)`
 * — a path that only resolves inside Plaud's own app, so Obsidian renders it
 * as "could not be found" (issue #52). The importer downloads the same asset
 * into the note's `-assets` folder; this rewrites every inline embed whose
 * target matches a downloaded asset into an Obsidian wikilink embed
 * `![[<local path>]]`. Embeds whose target is not in the map (external images
 * the user intentionally referenced) are left untouched.
 *
 * `urlToLocalPath` is keyed by the SAME normalized link string the extractor
 * produced (see `normalizeSummaryLink`), so the captured target is normalized
 * identically before lookup. Exported as a pure function so the rewrite is
 * unit-testable without the vault/network plumbing in AttachmentImporter.
 */
export function rewriteInlineSummaryEmbeds(
	content: string,
	urlToLocalPath: ReadonlyMap<string, string>,
): string {
	if (urlToLocalPath.size === 0) {
		return content;
	}
	// Inline markdown image: ![alt](<target>) with an optional angle-bracket
	// wrapper and an optional "title". Capture the bare target only.
	const inlineImage = /!\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
	return content.replace(inlineImage, (whole, rawTarget: string) => {
		const normalized = rawTarget.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '');
		const local = urlToLocalPath.get(normalized);
		return local !== undefined ? `![[${local}]]` : whole;
	});
}

// ===========================================================================
// DEPRECATED ONE-TIME MIGRATION (issue #52) — REMOVE IN A FUTURE VERSION.
//
// The rewrite above fixes card embeds only on (re)import. Notes imported BEFORE
// that fix keep the broken inline embed. The pure helpers below back a one-time,
// user-run "Repair card image links from older imports" command that repoints
// those existing notes at the card already sitting in their `-assets` folder.
// Once users have run it (a release or two out), delete this block, the command
// in main.ts, and their tests.
// ===========================================================================

/**
 * One-time #52 migration helper (REMOVE IN A FUTURE VERSION). True when a
 * filename is a downloaded card poster image. The importer names card posters
 * `<idPrefix>-card.<ext>` (or `card2`, ...), so the base ends with `card` or
 * `card<n>` and the extension is an image type.
 */
export function isLocalCardImage(fileName: string): boolean {
	return /(?:^|-)card\d*\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
}

/** One-time #52 migration result (REMOVE IN A FUTURE VERSION). */
export interface CardRepairResult {
	readonly content: string;
	/** How many broken inline card embeds were repointed at a local copy. */
	readonly repointed: number;
	/** Broken card embeds left as-is (no local card, or an ambiguous match). */
	readonly unrepairable: number;
}

/**
 * One-time #52 migration (REMOVE IN A FUTURE VERSION).
 * Repoint an ALREADY-IMPORTED note's broken inline card-poster embed
 * (`![...](.../summary_poster/...)`) at the card image already downloaded into
 * its `-assets` folder. Conservative: only touches embeds whose target carries
 * Plaud's `summary_poster` marker, and only repoints when EXACTLY ONE local card
 * image is available (0 or an ambiguous 2+ are left alone and counted). Existing
 * `![[...]]` wikilinks are never matched, so re-running is a no-op.
 */
export function repairLegacyCardEmbeds(
	content: string,
	cardAssetPaths: readonly string[],
): CardRepairResult {
	const brokenCard =
		/!\[[^\]]*]\(\s*<?([^)\s>]*summary_poster[^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;
	const target = cardAssetPaths.length === 1 ? cardAssetPaths[0] : null;
	let repointed = 0;
	let unrepairable = 0;
	const out = content.replace(brokenCard, (whole) => {
		if (target === null) {
			unrepairable += 1;
			return whole;
		}
		repointed += 1;
		return `![[${target}]]`;
	});
	return { content: out, repointed, unrepairable };
}

/**
 * Choose a file extension for a downloaded attachment from its MIME hint,
 * URL, and body. Mime wins, then a real extension on the URL, then a JSON
 * body sniff; anything else is treated as opaque binary (`bin`). Exported as
 * a pure function so the extension logic is unit-testable independent of the
 * vault/network plumbing in AttachmentImporter.
 */
export function inferAssetExtension(
	asset: AttachmentAsset,
	bodyText: string,
	responseContentType: string,
): string {
	const fromMime = `${asset.mimeType ?? ''};${responseContentType}`.toLowerCase();
	const isPlainTextMime = fromMime.includes('text/plain');
	if (fromMime.includes('text/html') || fromMime.includes('application/xhtml+xml')) {
		return 'html';
	}
	if (fromMime.includes('png')) return 'png';
	if (fromMime.includes('jpeg') || fromMime.includes('jpg')) return 'jpg';
	if (fromMime.includes('webp')) return 'webp';
	if (fromMime.includes('gif')) return 'gif';
	if (fromMime.includes('svg')) return 'svg';
	if (fromMime.includes('pdf')) return 'pdf';
	// An explicit markdown MIME is unambiguously text -> md. A generic
	// text/plain is handled AFTER the JSON-body sniff below, so a JSON envelope
	// served as text/plain still resolves to json (and its nested images import).
	if (fromMime.includes('markdown')) {
		return 'md';
	}

	try {
		const pathname = new URL(asset.url).pathname.toLowerCase();
		const m = pathname.match(/\.([a-z0-9]{2,6})$/);
		if (m) {
			return m[1];
		}
	} catch {
		// ignore parse failures and use fallbacks below
	}

	if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
		return 'json';
	}
	// text/plain that is not JSON-shaped: prefer md over the terminal bin so a
	// stray text asset stays readable instead of an unopenable `.bin`.
	if (isPlainTextMime) {
		return 'md';
	}
	return 'bin';
}

