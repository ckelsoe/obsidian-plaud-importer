// Obsidian opens a modal in `activeWindow` and closes it when that window
// closes. Since 1.14, Settings is its own window, so an import started from a
// command while Settings has focus opened inside Settings and was cancelled
// when Settings closed. Bring the main window forward first.

/** Longest wait for the main window to take focus. */
export const FOCUS_WAIT_MS = 500;

/**
 * Bring `main` forward and report whether it is the active window. Settles
 * at once when it already is, on its focus event, or after
 * {@link FOCUS_WAIT_MS}; the result is read at that moment, so a timeout with
 * another window still active gives false. Aborting `signal` (plugin unload)
 * settles it early and frees the timer and listeners.
 */
export function focusMainWindow(
	signal: AbortSignal,
	main: Window = window,
	getActive: () => Window = () => activeWindow,
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	if (getActive() === main) return Promise.resolve(true);
	return new Promise((resolve) => {
		const done = (): void => {
			main.clearTimeout(timer);
			main.removeEventListener('focus', done);
			signal.removeEventListener('abort', done);
			resolve(!signal.aborted && getActive() === main);
		};
		const timer = main.setTimeout(done, FOCUS_WAIT_MS);
		main.addEventListener('focus', done);
		signal.addEventListener('abort', done);
		main.focus();
	});
}
