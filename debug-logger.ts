// Debug logger for Plaud Importer. When the plugin's debug setting is
// enabled, this module captures a bounded ring buffer of API request/
// response/parsed events so a user can reproduce a problem, export the
// captured session to the clipboard, and paste it into a bug report
// without having to fiddle with browser DevTools.
//
// Design contract:
// - NEVER log authentication headers, token values, or any secret. The
//   client adapter is responsible for filtering headers out of the
//   `log` call at the source — this module trusts its input and does
//   not re-scan for secrets.
// - Keep the module free of `obsidian` imports so tests can exercise it
//   with a plain Jest stub. The plugin wires the concrete logger instance
//   into the client via `PlaudClientOptions.debugLogger`.
// - Treat `enabled=false` as a strict no-op: when debug is off, `log()`
//   returns immediately without allocating the event object, storing it,
//   or writing to `console`. This keeps the hot path cheap.
//
// The `DebugLogger` type is a structural interface so tests and alternate
// implementations (e.g., a null logger, a streaming logger) can substitute
// freely. The concrete `BufferedDebugLogger` is the only implementation
// the plugin ships.

/**
 * Categorizes a single debug event. `request` fires before an HTTP call,
 * `response` fires after the status and body are read, `parsed` fires
 * after the client has successfully turned the raw JSON into typed
 * domain objects. `error` fires on any thrown/caught failure in the
 * client. `note` is a free-form developer marker the plugin can use to
 * annotate the timeline ("user clicked Import", "modal closed").
 */
export type DebugEventKind = 'request' | 'response' | 'parsed' | 'error' | 'note';

/**
 * Shape of an event as logged by a caller. The timestamp is filled in by
 * the logger so callers don't have to track their own clock — keeps the
 * call sites terse and prevents "logged time drifts from wall time"
 * bugs in long-running sessions.
 */
export interface DebugEventInput {
	readonly kind: DebugEventKind;
	readonly message: string;
	/**
	 * Optional free-form payload — typically the raw JSON returned by the
	 * API, or the parsed `Recording` array. Must be JSON-serializable (or
	 * throw-compatible with JSON.stringify's default handler). Callers
	 * should NOT include Authorization headers, tokens, or any other
	 * secret in the payload.
	 */
	readonly payload?: unknown;
	/**
	 * Optional endpoint path for request/response events, used for
	 * formatting and filtering. Free-form otherwise — purely human-facing.
	 */
	readonly endpoint?: string;
}

export interface DebugEvent extends DebugEventInput {
	readonly timestamp: Date;
}

export interface DebugLogger {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
	log(event: DebugEventInput): void;
	snapshot(): readonly DebugEvent[];
	clear(): void;
	format(): string;
}

/**
 * Maximum number of events the ring buffer will retain. Older events are
 * dropped when the cap is reached. Sized to hold roughly one full import
 * session worth of request/response pairs (list + per-recording transsumm)
 * plus user-click notes — 50 events comfortably covers 20+ recordings
 * without growing the plugin's memory footprint past a few MB.
 */
export const DEFAULT_MAX_EVENTS = 50;

/**
 * In-memory ring-buffer implementation of `DebugLogger`. The buffer is a
 * plain array that shifts the oldest entry when it hits `maxEvents` —
 * O(n) per drop, but n is tiny (50) so this never shows up in profiles.
 *
 * Public API is deliberately tiny: `log`, `snapshot`, `clear`, `format`,
 * plus an `enabled` toggle. Tests can assert against `snapshot()` without
 * caring about how the buffer is stored internally.
 */
export class BufferedDebugLogger implements DebugLogger {
	private _enabled: boolean;
	private readonly maxEvents: number;
	private readonly buffer: DebugEvent[] = [];
	// Wall-clock provider is injected so tests can pin timestamps. Defaults
	// to `Date.now()` in production; tests pass a counter-based fake.
	private readonly now: () => Date;
	// Sink for the live DevTools mirror. Defaults to `console.log` so the
	// plugin can tail events in Obsidian's developer console; tests pass
	// a no-op to keep Jest output clean.
	private readonly consoleSink: (message: string, payload?: unknown) => void;

	constructor(
		enabled: boolean,
		options: {
			readonly maxEvents?: number;
			readonly now?: () => Date;
			readonly consoleSink?: (message: string, payload?: unknown) => void;
		} = {},
	) {
		this._enabled = enabled;
		this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
		this.now = options.now ?? ((): Date => new Date());
		this.consoleSink =
			options.consoleSink ??
			((message, payload): void => {
				if (payload === undefined) {
					console.log(message);
				} else {
					console.log(message, payload);
				}
			});
	}

	get enabled(): boolean {
		return this._enabled;
	}

	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
	}

	log(event: DebugEventInput): void {
		if (!this._enabled) {
			return;
		}
		const withTs: DebugEvent = { ...event, timestamp: this.now() };
		this.buffer.push(withTs);
		while (this.buffer.length > this.maxEvents) {
			this.buffer.shift();
		}
		// Mirror to DevTools so the user can watch events stream live.
		const prefix = `[Plaud Debug] ${event.kind}${event.endpoint ? ` ${event.endpoint}` : ''}: ${event.message}`;
		this.consoleSink(prefix, event.payload);
	}

	snapshot(): readonly DebugEvent[] {
		return [...this.buffer];
	}

	clear(): void {
		this.buffer.length = 0;
	}

	/**
	 * Render the current buffer as a single newline-delimited string
	 * suitable for pasting into a bug report or a chat message. Each
	 * event is a block of the form:
	 *
	 *   [N] YYYY-MM-DDTHH:MM:SS.sssZ KIND [endpoint]: message
	 *   <pretty-printed JSON payload, if any>
	 *
	 * Payloads are formatted with `JSON.stringify(_, null, 2)`; cyclic
	 * or non-serializable payloads fall back to `String(payload)` with
	 * a `(non-serializable)` marker so the format call never throws.
	 */
	format(): string {
		const snap = this.snapshot();
		const header = [
			'=== Plaud Importer debug session ===',
			`Generated: ${this.now().toISOString()}`,
			`Events: ${snap.length}`,
			'Authorization headers are never captured. Payloads may contain',
			'transcript text, speaker names, and recording metadata.',
			'',
		].join('\n');
		if (snap.length === 0) {
			return `${header}(buffer is empty)\n=== End debug session ===\n`;
		}
		const blocks = snap.map((event, index) => {
			const n = index + 1;
			const ts = event.timestamp.toISOString();
			const kind = event.kind.toUpperCase();
			const endpointPart = event.endpoint ? ` ${event.endpoint}` : '';
			const headerLine = `[${n}] ${ts} ${kind}${endpointPart}: ${event.message}`;
			if (event.payload === undefined) {
				return headerLine;
			}
			let payloadText: string;
			try {
				payloadText = JSON.stringify(event.payload, null, 2);
				if (payloadText === undefined) {
					payloadText = `(non-serializable: ${String(event.payload)})`;
				}
			} catch (err) {
				payloadText = `(non-serializable: ${err instanceof Error ? err.message : String(err)})`;
			}
			return `${headerLine}\n${payloadText}`;
		});
		return `${header}${blocks.join('\n\n')}\n\n=== End debug session ===\n`;
	}
}

/**
 * A permanently-disabled logger. Useful as a default when debug is off so
 * callers can always call `log()` without null-checking. The `enabled`
 * setter is ignored — this logger stays off no matter what.
 *
 * The method signatures mirror `DebugLogger` (they accept parameters
 * even though they're unused) so tests and call sites can invoke them
 * without TypeScript narrowing the concrete type to a zero-arg form.
 */
export class NoopDebugLogger implements DebugLogger {
	readonly enabled = false;
	setEnabled(_enabled: boolean): void {
		// Deliberate no-op — the Noop logger cannot be turned on.
		void _enabled;
	}
	log(_event: DebugEventInput): void {
		// Deliberate no-op.
		void _event;
	}
	snapshot(): readonly DebugEvent[] {
		return [];
	}
	clear(): void {
		// Deliberate no-op.
	}
	format(): string {
		return '';
	}
}
