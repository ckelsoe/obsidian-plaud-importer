import { FOCUS_WAIT_MS, focusMainWindow } from '../main-window';

const OTHER_WINDOW = {} as Window;

// A stand-in main window with real listeners and timers. `focus()` is counted
// and, when `takesFocus`, makes the window active and fires its focus event,
// the way Obsidian updates `activeWindow` before later focus listeners run.
function fakeWindow(takesFocus: boolean): {
	win: Window;
	focus: import('vitest').Mock;
	getActive: () => Window;
} {
	const target = new EventTarget();
	let active: Window = OTHER_WINDOW;
	const focus = vi.fn(() => {
		if (!takesFocus) return;
		active = win;
		target.dispatchEvent(new Event('focus'));
	});
	const win = {
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		setTimeout: (cb: () => void, ms: number) => window.setTimeout(cb, ms),
		clearTimeout: (id: number) => window.clearTimeout(id),
		focus,
	} as unknown as Window;
	return { win, focus, getActive: () => active };
}

describe('focusMainWindow', () => {
	afterEach(() => vi.useRealTimers());

	it('is true at once when the main window is already active', async () => {
		const { win, focus } = fakeWindow(true);
		const signal = new AbortController().signal;
		await expect(focusMainWindow(signal, win, () => win)).resolves.toBe(
			true,
		);
		expect(focus).not.toHaveBeenCalled();
	});

	it('focuses the main window and is true on its focus event', async () => {
		vi.useFakeTimers();
		const { win, focus, getActive } = fakeWindow(true);
		const signal = new AbortController().signal;
		await expect(focusMainWindow(signal, win, getActive)).resolves.toBe(
			true,
		);
		expect(focus).toHaveBeenCalledTimes(1);
		// Settled by the event, not the fallback timer, which is cleared.
		expect(vi.getTimerCount()).toBe(0);
	});

	it('is false after the wait when the main window never takes focus', async () => {
		vi.useFakeTimers();
		const { win, focus, getActive } = fakeWindow(false);
		const signal = new AbortController().signal;
		let result: boolean | undefined;
		const p = focusMainWindow(signal, win, getActive).then((r) => {
			result = r;
		});
		await Promise.resolve();
		expect(focus).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
		vi.advanceTimersByTime(FOCUS_WAIT_MS);
		await p;
		expect(result).toBe(false);
	});

	it('is false at once and frees the timer when aborted', async () => {
		vi.useFakeTimers();
		const { win, getActive } = fakeWindow(false);
		const ac = new AbortController();
		const p = focusMainWindow(ac.signal, win, getActive);
		expect(vi.getTimerCount()).toBe(1);
		ac.abort();
		await expect(p).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not focus when already aborted', async () => {
		const { win, focus, getActive } = fakeWindow(true);
		const ac = new AbortController();
		ac.abort();
		await expect(focusMainWindow(ac.signal, win, getActive)).resolves.toBe(
			false,
		);
		expect(focus).not.toHaveBeenCalled();
	});
});
