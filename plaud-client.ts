// Contract between the plugin and any Plaud backend. The viability doc
// (dev-docs/00-viability-findings.md §6.1) is the source of truth for this
// surface — update it there first if the shape needs to change.

/**
 * Branded string that identifies a Plaud recording. Plaud returns the same
 * underlying ID for a recording and all of its derived artifacts (transcript,
 * summary, audio), so one brand covers the whole entity tree. Consumers must
 * receive instances from the parser — there is no public constructor.
 */
export type PlaudRecordingId = string & { readonly __brand: 'PlaudRecordingId' };

export interface PlaudClient {
	listRecordings(filter?: RecordingFilter): Promise<readonly Recording[]>;
	getTranscript(id: PlaudRecordingId): Promise<Transcript | null>;
	getSummary(id: PlaudRecordingId): Promise<Summary | null>;
	getAudio(id: PlaudRecordingId): Promise<AudioRef | null>;
}

export interface RecordingFilter {
	readonly limit?: number;
	readonly since?: Date;
	readonly until?: Date;
	readonly folderId?: string;
	readonly hasTranscript?: boolean;
}

export interface Recording {
	readonly id: PlaudRecordingId;
	readonly title: string;
	readonly createdAt: Date;
	readonly durationSeconds: number;
	/**
	 * Advisory hint from the list endpoint that a transcript exists for this
	 * recording. The authoritative answer is `getTranscript(id) !== null` —
	 * this flag may be stale if Plaud updated the recording after it was
	 * listed. Useful for cheap UI decisions (show a transcript icon), not as
	 * a load-bearing invariant.
	 */
	readonly transcriptAvailable: boolean;
	/**
	 * Advisory hint from the list endpoint that an AI summary exists. The
	 * authoritative answer is `getSummary(id) !== null`.
	 */
	readonly summaryAvailable: boolean;
	readonly folderId?: string;
	readonly tags?: readonly string[];
}

export interface Transcript {
	readonly id: PlaudRecordingId;
	readonly segments: readonly TranscriptSegment[];
	readonly rawText: string;
}

export interface TranscriptSegment {
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly speaker?: string;
	readonly text: string;
}

export interface Summary {
	readonly id: PlaudRecordingId;
	readonly text: string;
	readonly sections?: readonly SummarySection[];
}

export interface SummarySection {
	readonly heading: string;
	readonly body: string;
}

export type AudioFormat = 'mp3' | 'ogg' | 'wav';

export interface AudioRef {
	readonly id: PlaudRecordingId;
	readonly url: string;
	readonly expiresAt?: Date;
	readonly format: AudioFormat;
}
