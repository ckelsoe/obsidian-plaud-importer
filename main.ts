import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	requestUrl,
	type RequestUrlResponse,
} from "obsidian";
import {
	ReverseEngineeredPlaudClient,
	type PlaudHttpFetcher,
} from "./plaud-client-re";
import { ImportModal } from "./import-modal";

interface PlaudImporterSettings {
	secretId: string;
	outputFolder: string;
	onDuplicate: "skip" | "overwrite";
}

const DEFAULT_SETTINGS: PlaudImporterSettings = {
	secretId: "",
	outputFolder: "Plaud",
	onDuplicate: "skip",
};

// Adapt Obsidian's requestUrl to the PlaudHttpFetcher shape the client
// depends on. Using requestUrl (not fetch) is required to avoid CORS and
// certificate issues on Electron. `throw: false` lets us map status codes
// in the client rather than Obsidian's implicit throw.
const obsidianFetcher: PlaudHttpFetcher = async ({ url, headers }) => {
	const response = await requestUrl({
		url,
		method: "GET",
		headers: { ...headers },
		throw: false,
	});
	return {
		status: response.status,
		json: safeJson(response),
		text: response.text ?? "",
	};
};

// requestUrl's `json` is a getter that parses `text` lazily and throws a
// SyntaxError on invalid JSON. Catch ONLY SyntaxError and return null — the
// client will then produce a PlaudParseError with the raw body snippet.
// Any other exception type is a genuine bug (e.g. an internal Obsidian API
// change) and should propagate so it can be surfaced loudly instead of
// silently misclassified as "unexpected shape from Plaud."
function safeJson(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch (err) {
		if (err instanceof SyntaxError) {
			return null;
		}
		throw err;
	}
}

export default class PlaudImporterPlugin extends Plugin {
	settings!: PlaudImporterSettings;
	private client?: ReverseEngineeredPlaudClient;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new PlaudImporterSettingsTab(this.app, this));

		this.addCommand({
			id: "import-recent",
			name: "Import recent recordings",
			callback: () => {
				if (!this.client) {
					new Notice(
						"Plaud Importer: still initializing. Try again in a moment.",
					);
					return;
				}
				new ImportModal(this.app, this.client).open();
			},
		});

		this.app.workspace.onLayoutReady(() => {
			// Construct the client once. It reads the token fresh on every
			// API call via the provider, so settings changes take effect
			// immediately with no reinstantiation.
			this.client = new ReverseEngineeredPlaudClient(
				() => this.app.secretStorage.getSecret(this.settings.secretId),
				obsidianFetcher,
			);
		});
	}

	onunload() {
		this.client = undefined;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PlaudImporterSettingsTab extends PluginSettingTab {
	plugin: PlaudImporterPlugin;

	constructor(app: App, plugin: PlaudImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Plaud token")
			.setDesc(
				"Select or create a stored secret holding your Plaud.AI session token. The secret value is stored in Obsidian's per-vault secret storage, never in data.json.",
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.secretId)
					.onChange(async (id) => {
						this.plugin.settings.secretId = id;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc(
				"Folder inside your vault where imported notes are written.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Plaud")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder =
							value.trim() || "Plaud";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Duplicate handling")
			.setDesc(
				"What to do when a note for the recording already exists in the output folder.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("skip", "Skip")
					.addOption("overwrite", "Overwrite")
					.setValue(this.plugin.settings.onDuplicate)
					.onChange(async (value) => {
						this.plugin.settings.onDuplicate =
							value as "skip" | "overwrite";
						await this.plugin.saveSettings();
					}),
			);
	}
}
