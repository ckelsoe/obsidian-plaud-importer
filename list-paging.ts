// Sequential page fetching that works on both Plaud clients.
//
// The prod reverse-engineered client pages by offset (`skip`); the v4 portal
// client pages by an opaque cursor (`listRecordingsPage`). Auto-sync and the
// version backfill are written against a simple `(skip, limit) => Recording[]`
// contract and page sequentially (skip 0, then N, then 2N, ...). This adapter
// preserves that contract on top of either client: on the cursor client it
// holds the cursor in a closure, translating skip 0 into "start over" and
// skip > 0 into "continue from the stored cursor", and returns an empty page
// once the cursor is exhausted.
//
// No `obsidian` import, so it is unit-tested with a stub client.

import type { PlaudClient, Recording } from './plaud-client';

export type SequentialPageFetcher = (
	skip: number,
	limit: number,
) => Promise<readonly Recording[]>;

/**
 * Build a sequential page fetcher for a client + sort order.
 *
 * IMPORTANT: callers MUST page sequentially and must NOT share one fetcher
 * across concurrent scans, because the cursor is stateful. Each independent
 * scan gets its own fetcher (its own closure cursor).
 */
export function createSequentialPageFetcher(
	client: PlaudClient,
	sortBy: 'start_time' | 'edit_time',
): SequentialPageFetcher {
	if (client.listRecordingsPage === undefined) {
		// Offset client: a plain passthrough. Idempotent per skip.
		return (skip, limit) => client.listRecordings({ sortBy, skip, limit });
	}
	// Cursor client: translate sequential skips into cursor advances, and
	// BUFFER so each returned page is exactly `limit` until the list is truly
	// exhausted. Callers (auto-sync, backfill) treat a page shorter than the
	// requested limit as "end of list". A cursor page can be short while more
	// pages remain (that is what next_cursor is for), so without buffering a
	// short middle page would falsely end the scan and later pages would be
	// missed. Buffering makes a short return happen ONLY at the real end.
	let cursor: string | null | undefined = undefined;
	let buffer: Recording[] = [];
	return async (skip, limit) => {
		if (skip === 0) {
			cursor = undefined;
			buffer = [];
		} else if (
			buffer.length === 0 &&
			(cursor === null || cursor === undefined)
		) {
			// skip > 0 with nothing buffered and an exhausted (null) or unset
			// (undefined) cursor: the scan ran off the end (or never started).
			// Return empty rather than silently restarting from page one.
			return [];
		}
		// Re-narrow inside the closure (the outer guard does not cross the
		// boundary) and call on the client so `this` stays bound.
		if (client.listRecordingsPage === undefined) {
			return [];
		}
		// Fill the buffer to at least `limit`, or until the cursor is exhausted.
		while (buffer.length < limit && cursor !== null) {
			const result = await client.listRecordingsPage({
				sortBy,
				cursor: cursor ?? undefined,
				limit,
			});
			buffer.push(...result.recordings);
			cursor = result.nextCursor;
			// Safety: a cursor that returns no records but keeps handing back a
			// non-null cursor would loop forever. Treat "no progress" as the end.
			if (result.recordings.length === 0) {
				cursor = null;
			}
		}
		const out = buffer.slice(0, limit);
		buffer = buffer.slice(limit);
		return out;
	};
}
