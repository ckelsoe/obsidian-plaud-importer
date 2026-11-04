import type { FileLike, FolderLike, VaultLike } from '../../note-writer';
import { asyncResult } from './async-result';

/**
 * In-memory `VaultLike` for headless writer and runner tests. `files` and
 * `folders` hold the vault state; the three call logs let a test assert which
 * paths were created, rewritten through `process`, or had a folder made.
 */
export type FakeVault = VaultLike & {
	files: Map<string, string>;
	folders: Set<string>;
	createdPaths: string[];
	overwrittenPaths: string[];
	createFolderCalls: string[];
};

export function makeFakeVault(): FakeVault {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const createdPaths: string[] = [];
	const overwrittenPaths: string[] = [];
	const createFolderCalls: string[] = [];

	return {
		files,
		folders,
		createdPaths,
		overwrittenPaths,
		createFolderCalls,
		getFileByPath(path: string): FileLike | null {
			return files.has(path) ? { path } : null;
		},
		getFolderByPath(path: string): FolderLike | null {
			return folders.has(path) ? { path } : null;
		},
		createFolder(path: string): Promise<FolderLike> {
			return asyncResult(() => {
				createFolderCalls.push(path);
				folders.add(path);
				return { path };
			});
		},
		create(path: string, data: string): Promise<FileLike> {
			return asyncResult(() => {
				files.set(path, data);
				createdPaths.push(path);
				return { path };
			});
		},
		read(file: FileLike): Promise<string> {
			return asyncResult(() => files.get(file.path) ?? '');
		},
		process(file: FileLike, fn: (data: string) => string): Promise<string> {
			return asyncResult(() => {
				const next = fn(files.get(file.path) ?? '');
				files.set(file.path, next);
				overwrittenPaths.push(file.path);
				return next;
			});
		},
	};
}
