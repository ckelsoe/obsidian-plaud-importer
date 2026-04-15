import {
	BufferedDebugLogger,
	DEFAULT_MAX_EVENTS,
	NoopDebugLogger,
	type DebugEvent,
} from '../debug-logger';

// A pinned-clock factory — every call returns the next second from a
// fixed base, so test assertions can compare ISO strings byte-for-byte
// without flake from real wall-clock drift. Base is 2026-04-14T12:00:00Z
// to match the codebase's "today" date for readability.
const PINNED_BASE_MS = Date.UTC(2026, 3, 14, 12, 0, 0); // 2026-04-14T12:00:00Z
function fakeClock(baseMs: number = PINNED_BASE_MS): () => Date {
	let offset = 0;
	return (): Date => {
		const d = new Date(baseMs + offset * 1000);
		offset++;
		return d;
	};
}

function silentSink(): (message: string, payload?: unknown) => void {
	return (): void => {
		// swallow — tests don't want Jest output polluted by live console
	};
}

describe('BufferedDebugLogger', () => {
	it('is a no-op when constructed with enabled=false', () => {
		const logger = new BufferedDebugLogger(false, { consoleSink: silentSink() });
		logger.log({ kind: 'request', message: 'GET /foo' });
		expect(logger.snapshot()).toEqual([]);
		expect(logger.enabled).toBe(false);
	});

	it('captures events when enabled', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(), // 2026-04-14T12:00:00Z
			consoleSink: silentSink(),
		});
		logger.log({
			kind: 'request',
			endpoint: '/file/simple/web',
			message: 'GET /file/simple/web',
			payload: { url: 'https://api.plaud.ai/file/simple/web', method: 'GET' },
		});
		logger.log({
			kind: 'response',
			endpoint: '/file/simple/web',
			message: '200 from /file/simple/web',
			payload: { status: 200, json: { data_file_list: [] } },
		});
		const events = logger.snapshot();
		expect(events).toHaveLength(2);
		expect(events[0].kind).toBe('request');
		expect(events[0].endpoint).toBe('/file/simple/web');
		expect(events[0].timestamp).toBeInstanceOf(Date);
		expect(events[1].kind).toBe('response');
	});

	it('respects the maxEvents ring buffer cap by dropping the oldest events', () => {
		const logger = new BufferedDebugLogger(true, {
			maxEvents: 3,
			consoleSink: silentSink(),
		});
		for (let i = 0; i < 5; i++) {
			logger.log({ kind: 'note', message: `event ${i}` });
		}
		const events = logger.snapshot();
		expect(events).toHaveLength(3);
		// Oldest two (0 and 1) should have been dropped.
		expect(events.map((e) => e.message)).toEqual(['event 2', 'event 3', 'event 4']);
	});

	it('defaults to DEFAULT_MAX_EVENTS when maxEvents is not passed', () => {
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		for (let i = 0; i < DEFAULT_MAX_EVENTS + 10; i++) {
			logger.log({ kind: 'note', message: `n${i}` });
		}
		expect(logger.snapshot()).toHaveLength(DEFAULT_MAX_EVENTS);
	});

	it('setEnabled toggles capture on and off mid-session without clearing the buffer', () => {
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		logger.log({ kind: 'note', message: 'first' });
		logger.setEnabled(false);
		logger.log({ kind: 'note', message: 'second (should be dropped)' });
		expect(logger.snapshot()).toHaveLength(1);
		logger.setEnabled(true);
		logger.log({ kind: 'note', message: 'third' });
		expect(logger.snapshot().map((e) => e.message)).toEqual(['first', 'third']);
	});

	it('clear() empties the buffer without affecting future capture', () => {
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		logger.log({ kind: 'note', message: 'one' });
		logger.log({ kind: 'note', message: 'two' });
		logger.clear();
		expect(logger.snapshot()).toEqual([]);
		logger.log({ kind: 'note', message: 'after clear' });
		expect(logger.snapshot()).toHaveLength(1);
	});

	it('mirrors events to the console sink when enabled', () => {
		const calls: Array<{ message: string; payload: unknown }> = [];
		const sink = (message: string, payload?: unknown): void => {
			calls.push({ message, payload });
		};
		const logger = new BufferedDebugLogger(true, { consoleSink: sink });
		logger.log({
			kind: 'request',
			endpoint: '/file/simple/web',
			message: 'GET /file/simple/web',
			payload: { url: 'https://api.plaud.ai/file/simple/web' },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].message).toBe(
			'[Plaud Debug] request /file/simple/web: GET /file/simple/web',
		);
		expect(calls[0].payload).toEqual({ url: 'https://api.plaud.ai/file/simple/web' });
	});

	it('does not call the console sink when disabled', () => {
		const calls: string[] = [];
		const logger = new BufferedDebugLogger(false, {
			consoleSink: (m): void => {
				calls.push(m);
			},
		});
		logger.log({ kind: 'note', message: 'ignored' });
		expect(calls).toEqual([]);
	});
});

describe('BufferedDebugLogger.format', () => {
	it('renders an empty-buffer header when nothing has been logged', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
		});
		const out = logger.format();
		expect(out).toContain('=== Plaud Importer debug session ===');
		expect(out).toContain('Events: 0');
		expect(out).toContain('(buffer is empty)');
		expect(out).toContain('=== End debug session ===');
	});

	it('renders one block per event with indexed headers, ISO timestamps, and pretty JSON', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
		});
		logger.log({
			kind: 'request',
			endpoint: '/file/simple/web',
			message: 'GET /file/simple/web',
			payload: { url: 'https://api.plaud.ai/file/simple/web' },
		});
		logger.log({
			kind: 'response',
			endpoint: '/file/simple/web',
			message: '200 from /file/simple/web',
			payload: { status: 200, json: { data_file_list: [] } },
		});
		const out = logger.format();
		expect(out).toContain('Events: 2');
		expect(out).toMatch(
			/\[1\] 2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z REQUEST \/file\/simple\/web: GET \/file\/simple\/web/,
		);
		expect(out).toContain('"url": "https://api.plaud.ai/file/simple/web"');
		expect(out).toMatch(/\[2\] .* RESPONSE \/file\/simple\/web: 200 from \/file\/simple\/web/);
		expect(out).toContain('"status": 200');
	});

	it('omits the payload block when an event has no payload', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
		});
		logger.log({ kind: 'note', message: 'user clicked Import' });
		const out = logger.format();
		expect(out).toContain('NOTE: user clicked Import');
		// No JSON block should follow a payload-less note. The next line
		// after the NOTE header is either blank or the end marker — never
		// a `{` that would indicate a stringified payload.
		expect(out).not.toContain('user clicked Import\n{');
		expect(out).not.toContain('user clicked Import\n"');
	});

	it('gracefully handles non-serializable payloads (circular references)', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
		});
		const cyclic: Record<string, unknown> = { name: 'cyclic' };
		cyclic.self = cyclic;
		logger.log({ kind: 'response', message: 'bad payload', payload: cyclic });
		// format() must not throw, and must indicate the serialization failure.
		const out = logger.format();
		expect(out).toContain('RESPONSE');
		expect(out).toContain('bad payload');
		expect(out).toContain('(non-serializable');
	});

	it('warns that Authorization headers are not captured in the header block', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
		});
		const out = logger.format();
		expect(out).toContain('Authorization headers are never captured');
	});

	it('includes optional header lines in the exported debug header', () => {
		const logger = new BufferedDebugLogger(true, {
			now: fakeClock(),
			consoleSink: silentSink(),
			headerLines: ['Plugin version: 0.1.1'],
		});
		const out = logger.format();
		expect(out).toContain('Plugin version: 0.1.1');
	});

	it('produces a snapshot that is a defensive copy (mutating it does not affect future snapshots)', () => {
		const logger = new BufferedDebugLogger(true, { consoleSink: silentSink() });
		logger.log({ kind: 'note', message: 'one' });
		const snap = logger.snapshot() as DebugEvent[];
		snap.push({
			kind: 'note',
			message: 'injected',
			timestamp: new Date(),
		});
		expect(logger.snapshot()).toHaveLength(1);
	});
});

describe('NoopDebugLogger', () => {
	it('stays disabled even after setEnabled(true)', () => {
		const logger = new NoopDebugLogger();
		logger.setEnabled(true);
		expect(logger.enabled).toBe(false);
	});

	it('log/snapshot/clear/format never throw and always return empty state', () => {
		const logger = new NoopDebugLogger();
		logger.log({ kind: 'note', message: 'ignored' });
		expect(logger.snapshot()).toEqual([]);
		logger.clear();
		expect(logger.format()).toBe('');
	});
});
