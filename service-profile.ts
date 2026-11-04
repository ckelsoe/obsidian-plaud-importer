import type { Recording, RecordingSource, Transcript } from './recording-model';

/**
 * The stored names one importer writes into users' notes: frontmatter keys,
 * the managed-block markers, the transcript-file marker, the chapters block id
 * and the AI-keyword tag namespace all derive from `keyPrefix`. Notes already
 * on disk carry these names, so a shipped service must never change them.
 *
 * It also carries the user-visible facts about the service that the shared
 * note writer prints, so a note written for one service never names another.
 */
export interface ServiceProfile {
	/** Prefix of every frontmatter key, marker and tag this importer writes. */
	readonly keyPrefix: string;
	/** Plugin id, written into the managed transcript file's marker. */
	readonly pluginId: string;
	/** Collapses alternative spellings of one recording id to a single key. */
	readonly canonicalId: (id: string) => string;
	/** The service's name as users know it, e.g. in "Open in <serviceName>". */
	readonly serviceName: string;
	/** The plugin's name as listed under Settings → Community Plugins. */
	readonly pluginName: string;
	/**
	 * The recording's page in the service's web app. `webBase` is the account's
	 * portal origin when the service has more than one; omitted means the default.
	 */
	readonly recordingUrl: (id: string, webBase?: string) => string;
	/**
	 * The callout opening a placeholder note: the `> [!warning]` title line and
	 * its prose, ending with a bare `>` separator. The writer appends the
	 * recording id and the service's reason.
	 */
	readonly placeholderCallout: readonly string[];
	/**
	 * Fills the service's own template tokens in a summary body. Omitted when
	 * the service's summaries carry none.
	 */
	readonly expandSummaryTokens?: (
		markdown: string,
		recording: Recording,
		transcript: Transcript | null,
		offsetMinutes: number,
	) => string;
	/**
	 * Powers the `{{device}}` token. Omitted when the service reports no capture
	 * source, and the token then renders empty.
	 */
	readonly devices?: {
		readonly label: (
			source: RecordingSource | undefined,
			deviceNames: ReadonlyMap<string, string>,
		) => string;
		/** Sample value for the settings live preview. */
		readonly sampleName: string;
	};
}
