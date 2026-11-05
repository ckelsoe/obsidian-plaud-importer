// Obsidian opens a modal in `activeWindow` and closes it when that window
// closes. Since 1.14, Settings is its own window, so an import started from a
// command while Settings has focus opened inside Settings and was cancelled
// when Settings closed. Bring the main window forward first.

/** Longest wait for the main window to take focus before opening anyway. */
export const FOCUS_WAIT_MS = 500;

/**
 * Resolve once `main` is the active window. Resolves at once when it already
 * is, and after {@link FOCUS_WAIT_MS} if it never takes focus, so the caller
 * always opens its modal (in the other window, as before, at worst).
 * Aborting `signal` (plugin unload) settles it early and frees the timer and
 * listener; the caller re-checks its own lifecycle state afterwards.
 */
export function focusMainWindow(
	signal: AbortSignal,
	main: Window = window,
	getActive: () => Window = () => activeWindow,
): Promise<void> {
	if (signal.aborted || getActive() === main) return Promise.resolve();
	return new Promise((resolve) => {
		const done = (): void => {
			main.clearTimeout(timer);
			main.removeEventListener('focus', done);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = main.setTimeout(done, FOCUS_WAIT_MS);
		main.addEventListener('focus', done);
		signal.addEventListener('abort', done);
		main.focus();
	});
}
