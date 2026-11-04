/**
 * Obsidian 1.14's SecretComponent reports a cleared picker as null. Before the
 * picker handled that, a cleared link could be saved to data.json as
 * `"secretId": null`, and every later `secretId.length` read would throw.
 * loadSettings must coerce it back to the empty "no token linked" id.
 */
import PlaudImporterPlugin from '../main';

async function loadWith(
	stored: Record<string, unknown>,
): Promise<PlaudImporterPlugin> {
	const plugin = new PlaudImporterPlugin({} as never, {} as never);
	plugin.loadData = () => Promise.resolve(stored);
	plugin.saveData = () => Promise.resolve();
	await plugin.loadSettings();
	return plugin;
}

describe('loadSettings secretId', () => {
	it('coerces a stored null secretId to an empty id', async () => {
		const plugin = await loadWith({ settingsVersion: 99, secretId: null });
		expect(plugin.settings.secretId).toBe('');
	});

	it('keeps a stored secret id', async () => {
		const plugin = await loadWith({
			settingsVersion: 99,
			secretId: 'my-token',
		});
		expect(plugin.settings.secretId).toBe('my-token');
	});
});
