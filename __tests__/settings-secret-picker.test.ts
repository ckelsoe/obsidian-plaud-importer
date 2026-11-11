/**
 * Obsidian 1.14's SecretComponent passes null to onChange when the user clears
 * the picker. The settings tab must store that as an empty secret id, never
 * null, because everything downstream reads `secretId` as a string.
 *
 * Built with `Object.create(prototype)`, like the other settings-tab suites:
 * only the token row is rendered.
 */
import { PlaudImporterSettingsTab } from '../settings-tab';
import { SecretComponent, Setting } from './__mocks__/obsidian';
import { at } from './helpers/checked';

interface TokenRowHost {
	app: unknown;
	plugin: Record<string, unknown> & {
		settings: {
			secretId: string;
			signInMethod: string;
			plaudDetectedVersion: string;
		};
		saveSettings: import('vitest').Mock;
	};
	renderTokenControl(setting: Setting): void;
}

function makeTab(): TokenRowHost {
	const tab = Object.create(
		PlaudImporterSettingsTab.prototype,
	) as TokenRowHost;
	tab.app = {};
	tab.plugin = {
		settings: {
			secretId: 'plaud-token',
			signInMethod: 'google',
			plaudDetectedVersion: 'v4',
		},
		saveSettings: vi.fn(() => Promise.resolve()),
		readStoredTokenValue: () => '',
		canRenewCredential: () => false,
		sessionRenewalPaused: false,
		syncClientToPlaudVersion: () => undefined,
		resumeAutoSyncIfPaused: () => undefined,
		reconcileSessionExpiryWarning: () => undefined,
		reconcileSessionRefresh: () => undefined,
	};
	return tab;
}

describe('settings tab secret picker', () => {
	beforeEach(() => {
		SecretComponent.instances = [];
	});

	it('stores a cleared picker as an empty secret id, not null', async () => {
		const tab = makeTab();
		tab.renderTokenControl(new Setting());
		const picker = at(SecretComponent.instances, 0);
		expect(picker.changeHandler).toBeDefined();

		await picker.changeHandler?.(null);

		expect(tab.plugin.settings.secretId).toBe('');
		expect(tab.plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('stores a chosen secret id as given', async () => {
		const tab = makeTab();
		tab.renderTokenControl(new Setting());

		await at(SecretComponent.instances, 0).changeHandler?.('other-secret');

		expect(tab.plugin.settings.secretId).toBe('other-secret');
	});
});
