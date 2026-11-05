import { FOCUS_WAIT_MS, focusMainWindow } from '../main-window';

const OTHER_WINDOW = {} as Window;

// A stand-in main window: real event listeners and timers, a counted focus()
// that fires the window's focus event when `takesFocus` is true.
function fakeWindow(takesFocus: boolean): { win: Window; focus: jest.Mock } {
	const target = new EventTarget();
	const focus = jest.fn(() => {
		if (takesFocus) target.dispatchEvent(new Event('focus'));
	});
	const win = {
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		setTimeout: (cb: () => void, ms: number) => window.setTimeout(cb, ms),
		clearTimeout: (id: number) => window.clearTimeout(id),
		focus,
	} as unknown as Window;
	return { win, focus };
}

describe('focusMainWindow', () => {
	afterEach(() => jest.useRealTimers());

	it('resolves at once when the main window is already active', async () => {
		const { win, focus } = fakeWindow(true);
		await focusMainWindow(new AbortController().signal, win, () => win);
		expect(focus).not.toHaveBeenCalled();
	});

	it('focuses the main window and resolves on its focus event', async () => {
		jest.useFakeTimers();
		const { win, focus } = fakeWindow(true);
		await focusMainWindow(
			new AbortController().signal,
			win,
			() => OTHER_WINDOW,
		);
		expect(focus).toHaveBeenCalledTimes(1);
		// Resolved by the event, not the fallback timer, which is cleared.
		expect(jest.getTimerCount()).toBe(0);
	});

	it('resolves after the wait when the main window never takes focus', async () => {
		jest.useFakeTimers();
		const { win, focus } = fakeWindow(false);
		let resolved = false;
		const p = focusMainWindow(
			new AbortController().signal,
			win,
			() => OTHER_WINDOW,
		).then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(focus).toHaveBeenCalledTimes(1);
		expect(resolved).toBe(false);
		jest.advanceTimersByTime(FOCUS_WAIT_MS);
		await p;
		expect(resolved).toBe(true);
	});

	it('settles at once and frees the timer when aborted', async () => {
		jest.useFakeTimers();
		const { win } = fakeWindow(false);
		const ac = new AbortController();
		const p = focusMainWindow(ac.signal, win, () => OTHER_WINDOW);
		expect(jest.getTimerCount()).toBe(1);
		ac.abort();
		await p;
		expect(jest.getTimerCount()).toBe(0);
	});

	it('does not focus when already aborted', async () => {
		const { win, focus } = fakeWindow(true);
		const ac = new AbortController();
		ac.abort();
		await focusMainWindow(ac.signal, win, () => OTHER_WINDOW);
		expect(focus).not.toHaveBeenCalled();
	});
});
