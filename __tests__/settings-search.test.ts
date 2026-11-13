// Obsidian's settings search finds a setting by its name, description and
// aliases. A section drawn by hand has none of those unless it is given them,
// so every one of them except the chrome (the sign-in intro text and the
// footer) must carry a name and be searchable. A row that only applies while
// another setting is on is hidden with `visible`, and changing that setting
// re-evaluates it.

import type { App } from 'obsidian';
import { setMockApiVersion } from './__mocks__/obsidian';
import {
	PlaudImporterSettingsTab,
	type SettingsTabHost,
} from '../settings-tab';
import {
	DEFAULT_SETTINGS,
	type PlaudImporterSettings,
} from '../settings-types';

interface Item {
	type?: string;
	name?: string;
	desc?: unknown;
	searchable?: boolean;
	visible?: boolean | (() => boolean);
	render?: unknown;
	items?: Item[];
}

function leaves(items: Item[]): Item[] {
	return items.flatMap((i) => (i.items ? leaves(i.items) : [i]));
}

function makeTab(): {
	tab: PlaudImporterSettingsTab;
	settings: PlaudImporterSettings;
	items: Item[];
	update: ReturnType<typeof vi.fn>;
} {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const plugin = {
		settings,
		saveSettings: () => Promise.resolve(),
		updateRibbonIcon: () => undefined,
		reconcileAutoSync: () => undefined,
		resumeAutoSyncIfPaused: () => undefined,
		usesV4Portal: () => false,
	} as unknown as SettingsTabHost;
	const tab = new PlaudImporterSettingsTab({} as App, plugin);
	const update = vi.fn();
	tab.update = update;
	const items = leaves(tab.getSettingDefinitions() as unknown as Item[]);
	return { tab, settings, items, update };
}

function shown(items: Item[], name: string): boolean {
	const item = items.find((i) => i.name === name);
	if (!item) throw new Error(`no setting named ${name}`);
	return typeof item.visible === 'function'
		? item.visible()
		: item.visible !== false;
}

describe('settings search', () => {
	it('gives every hand-drawn section a name and makes it searchable, except the chrome', () => {
		const { items } = makeTab();
		const custom = items.filter((i) => i.render !== undefined && !i.type);
		// Obsidian treats an absent `searchable` as true.
		const hidden = custom.filter((i) => i.searchable === false);
		expect(hidden).toHaveLength(2);
		for (const i of hidden) expect(i.name).toBe('');
		for (const i of custom.filter((c) => c.searchable !== false)) {
			expect(i.name).not.toBe('');
			expect(typeof i.desc).toBe('string');
		}
	});

	it('finds the sections people look for by name', () => {
		const names = makeTab().items.map((i) => i.name);
		for (const n of [
			'Plaud token',
			'Sign in with email',
			'Clear sign-in',
			'Note name template',
			'Datetime property',
			'Extra frontmatter',
			'Sources',
		])
			expect(names).toContain(n);
	});

	it.each([
		['Ribbon icon', 'showRibbonIcon', true, false],
		['Auto-close delay', 'autoCloseSummary', true, false],
		['Sync interval', 'autoSyncEnabled', true, false],
		['Custom tags', 'tagMode', 'custom', 'none'],
		['Keep AI keywords as note property', 'tagMode', 'plaud', 'all'],
		[
			'Fold transcript by default',
			'transcriptPlacement',
			'heading',
			'callout',
		],
		[
			'Transcript heading level',
			'transcriptPlacement',
			'file-embed',
			'callout',
		],
	] as const)(
		"shows '%s' only while %s applies, and re-evaluates on change",
		async (name, key, on, off) => {
			const { tab, settings, items, update } = makeTab();
			const record = settings as unknown as Record<string, unknown>;
			record[key] = on;
			expect(shown(items, name)).toBe(true);
			record[key] = off;
			expect(shown(items, name)).toBe(false);

			await tab.setControlValue(key, on);
			expect(update).toHaveBeenCalledTimes(1);
			expect(shown(items, name)).toBe(true);
		},
	);

	it('keeps Sources visible while the filter is off, so devices can be excluded first', () => {
		const { settings, items } = makeTab();
		settings.sourceFilterEnabled = false;
		expect(shown(items, 'Sources')).toBe(true);
	});

	it('does not call update() before Obsidian 1.13, where it does not exist', async () => {
		setMockApiVersion('1.12.7');
		try {
			const { tab, update } = makeTab();
			await tab.setControlValue('autoSyncEnabled', true);
			expect(update).not.toHaveBeenCalled();
		} finally {
			setMockApiVersion(null);
		}
	});

	it('does not re-evaluate visibility for a setting no row depends on', async () => {
		const { tab, update } = makeTab();
		await tab.setControlValue('customTags', 'meeting');
		expect(update).not.toHaveBeenCalled();
	});
});
