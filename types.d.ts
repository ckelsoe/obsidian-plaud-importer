import 'obsidian';

declare module 'obsidian' {
    interface PluginManifest {
        version: string;
    }

    /**
     * Obsidian's internal fold state shape. Not part of the publicly
     * documented API — observed from the `liamcain/obsidian-creases`
     * plugin's type shim (MIT-licensed) and confirmed against live
     * behavior. The plaud-importer plugin uses this to auto-fold the
     * per-chapter H3 headings in a generated transcript so the note
     * opens with each chapter collapsed by default while real heading
     * links still resolve to their targets.
     */
    interface FoldPosition {
        /** 0-based line number of the fold range start. */
        from: number;
        /** 0-based line number of the fold range end (inclusive). */
        to: number;
    }

    interface FoldInfo {
        folds: FoldPosition[];
        /** Total line count of the file the folds belong to. */
        lines: number;
    }

    /**
     * Persistent fold-state store. `save` writes the payload to
     * Obsidian's per-file fold cache so the next `file-open` applies
     * it automatically; `load` reads it back.
     */
    interface FoldManager {
        load(file: import('obsidian').TFile): Promise<FoldInfo>;
        save(file: import('obsidian').TFile, foldInfo: FoldInfo): Promise<void>;
    }

    interface App {
        foldManager: FoldManager;

        /**
         * Obsidian's per-vault id. Not part of the publicly documented API, but
         * it is the key the vault is filed under in Obsidian's own vault
         * registry (`obsidian.json`), confirmed against live behavior on
         * 2026-07-31: the value read here matched the registry key exactly.
         *
         * Measured the same day: it is a stored random value, not a hash of the
         * vault path (six hash algorithms over four path encodings produced no
         * match), it differs between two vaults open simultaneously, and it
         * survives a restart unchanged.
         *
         * Used to give each vault its own Plaud sign-in partition (issue #87).
         * Typed as optional and validated at the point of use in
         * plaud-partition.ts, because it is an undocumented host property and a
         * future build could stop providing it.
         */
        appId?: string;
    }

    /**
     * MarkdownView's per-mode subview (source / live-preview / reading).
     * Carries its own fold state separate from the persisted one so a
     * plugin can apply fold info to the currently-active view without
     * forcing a reload.
     */
    interface MarkdownSubView {
        applyFoldInfo(foldInfo: FoldInfo): void;
        getFoldInfo(): FoldInfo | null;
    }
}

declare global {
    /**
     * Electron <webview> element. Obsidian enables `webviewTag` (its Web
     * Viewer core plugin depends on it), so a plugin-created <webview>
     * exposes Electron's webview methods at runtime. Only the surface the
     * Plaud login capture uses is declared here. Methods may be absent at
     * runtime if a future Obsidian build disables the tag, so call sites
     * still guard with `typeof`.
     */
    interface ElectronWebviewTag extends HTMLElement {
        src: string;
        partition: string;
        executeJavaScript(code: string): Promise<unknown>;
        getURL(): string;
        reload(): void;
        stop(): void;
    }

    interface HTMLElementTagNameMap {
        webview: ElectronWebviewTag;
    }
}