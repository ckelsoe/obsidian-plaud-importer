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
        // eslint-disable-next-line no-undef
        load(file: TFile): Promise<FoldInfo>;
        // eslint-disable-next-line no-undef
        save(file: TFile, foldInfo: FoldInfo): Promise<void>;
    }

    interface App {
        foldManager: FoldManager;
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