import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
} from "obsidian";

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

export default class PlaudImporterPlugin extends Plugin {
	settings!: PlaudImporterSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new PlaudImporterSettingsTab(this.app, this));

		this.addCommand({
			id: "import-recent",
			name: "Import recent recordings",
			callback: () => {
				new Notice("Plaud Importer: not implemented yet.");
			},
		});

		this.app.workspace.onLayoutReady(() => {
			// Real Plaud client construction lands in a follow-up iteration.
			// When it does, it will read the token via:
			//   const token = this.app.secretStorage.getSecret(this.settings.secretId);
			// and construct a ReverseEngineeredPlaudClient if the token is non-null.
		});
	}

	onunload() {
		// Nothing to tear down yet.
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
