/**
 * A click anywhere in the summary cancels the auto-close countdown, and says so,
 * unless the click is on Done, which closes the modal itself. The check reads
 * the event path rather than `instanceof Node`, which is false for a node in a
 * popout window.
 *
 * Built with `Object.create(prototype)`: only the countdown is exercised.
 */
import { ImportModal } from '../import-modal';

interface CountdownHost {
	noteWriterOptions: Record<string, unknown>;
	autoCloseTimer: number | null;
	contentEl: { addEventListener: (type: string, fn: Handler) => void };
	maybeStartAutoClose(
		tally: { failed: number; placeholdersWritten: number },
		buttonRow: unknown,
		closeButton: unknown,
	): void;
}

type Handler = (event: { composedPath: () => unknown[] }) => void;

function startCountdown(): {
	host: CountdownHost;
	press: (path: unknown[]) => void;
	texts: string[];
	closeButton: object;
} {
	const host = Object.create(ImportModal.prototype) as CountdownHost;
	const handlers: Handler[] = [];
	const texts: string[] = [];
	host.noteWriterOptions = { autoCloseSummary: true };
	host.autoCloseTimer = null;
	host.contentEl = {
		addEventListener: (type, fn) => {
			if (type === 'pointerdown') handlers.push(fn);
		},
	};
	const buttonRow = {
		createSpan: () => ({ setText: (t: string) => texts.push(t) }),
	};
	const closeButton = {};
	host.maybeStartAutoClose(
		{ failed: 0, placeholdersWritten: 0 },
		buttonRow,
		closeButton,
	);
	expect(handlers).toHaveLength(1);
	const press = (path: unknown[]): void => {
		for (const h of handlers) h({ composedPath: () => path });
	};
	return { host, press, texts, closeButton };
}

describe('summary auto-close countdown', () => {
	it('says it was cancelled when the click is not on Done', () => {
		const { host, press, texts } = startCountdown();
		press([{}, {}]);
		expect(host.autoCloseTimer).toBeNull();
		expect(texts).toEqual(['Auto-close cancelled']);
	});

	it('stops quietly when the click is on Done or inside it', () => {
		const { host, press, texts, closeButton } = startCountdown();
		press([{}, closeButton, {}]);
		expect(host.autoCloseTimer).toBeNull();
		expect(texts).toEqual([]);
	});
});
