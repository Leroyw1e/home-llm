import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type HomeLLMPlugin from "./main";
import { SCENE_LABELS } from "./scenes";
import type { WordBaseline } from "./stats";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "custom";
export type ChatLocation = "left" | "right" | "tab";

export interface HomeLLMSettings {
	provider: ProviderId;
	anthropicKey: string;
	anthropicModel: string;
	openaiKey: string;
	openaiModel: string;
	openrouterKey: string;
	openrouterModel: string;
	customBaseUrl: string;
	customKey: string;
	customModel: string;
	systemPrompt: string;
	temperature: number;
	maxTokens: number;
	chatLocation: ChatLocation;
	chatSaveFolder: string;
	openHomeOnStartup: boolean;
	replaceNewTab: boolean;
	showSearch: boolean;
	showRecent: boolean;
	homeStyle: "modern" | "dashboard";
	homeBackground: string;
	homeTitle: string;
	recentCount: number;
	ribbonSpacers: number;
	spellMode: "list" | "fix";
	spellVariant: string;
	purpleGraph: boolean;
	/** Let the chat search and read any note (edits always need approval). */
	vaultAccess: boolean;
	/** Long-term memory: a note the AI reads every chat and can add facts to. */
	memoryEnabled: boolean;
	memoryNote: string;
	memoryAskFirst: boolean;
	/** Total words at the first count today, for the "today" figure. */
	wordBaseline: WordBaseline | null;
}

export const DEFAULT_SETTINGS: HomeLLMSettings = {
	provider: "anthropic",
	anthropicKey: "",
	anthropicModel: "claude-sonnet-5-5",
	openaiKey: "",
	openaiModel: "gpt-4o",
	openrouterKey: "",
	openrouterModel: "anthropic/claude-sonnet-5.5",
	customBaseUrl: "http://localhost:11434/v1",
	customKey: "",
	customModel: "llama3.1",
	systemPrompt: "You are a helpful assistant inside the user's Obsidian vault. Answer in Markdown.",
	temperature: 0.7,
	maxTokens: 2048,
	chatLocation: "right",
	chatSaveFolder: "AI Chats",
	openHomeOnStartup: true,
	replaceNewTab: true,
	showSearch: true,
	showRecent: true,
	homeStyle: "modern",
	homeBackground: "glow",
	homeTitle: "Obsidian",
	recentCount: 10,
	ribbonSpacers: 3,
	spellMode: "list",
	spellVariant: "Australian English",
	purpleGraph: true,
	vaultAccess: true,
	memoryEnabled: true,
	memoryNote: "AI Memory.md",
	memoryAskFirst: false,
	wordBaseline: null,
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	anthropic: "Anthropic (Claude)",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	custom: "Custom / Ollama / LM Studio",
};

export const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
	anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
	openai: ["gpt-4o", "gpt-4o-mini"],
	openrouter: ["anthropic/claude-sonnet-5.5", "openai/gpt-4o"],
	custom: [],
};

/** Settings whose value is any string (not a fixed set of choices). */
type StringKey = { [K in keyof HomeLLMSettings]: string extends HomeLLMSettings[K] ? K : never }[keyof HomeLLMSettings];
type BoolKey = { [K in keyof HomeLLMSettings]: HomeLLMSettings[K] extends boolean ? K : never }[keyof HomeLLMSettings];

export class HomeLLMSettingTab extends PluginSettingTab {
	plugin: HomeLLMPlugin;

	constructor(app: App, plugin: HomeLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const refresh = async () => {
			await save();
			this.plugin.refreshHomeViews();
		};
		containerEl.empty();

		const heading = (name: string) => new Setting(containerEl).setName(name).setHeading();
		const keyField = (name: string, key: StringKey) =>
			new Setting(containerEl).setName(name).addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v.trim();
					await save();
				});
			});
		const textField = (name: string, key: StringKey, desc = "") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v.trim();
						await save();
					})
				);
		const toggle = (name: string, key: BoolKey, desc = "") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await refresh();
					})
				);

		// AI models
		new Setting(containerEl)
			.setName("Default provider")
			.setDesc("API keys are stored in this plugin's data file inside your vault. If you sync your vault, the keys sync too.")
			.addDropdown((d) => {
				for (const id of Object.keys(PROVIDER_LABELS) as ProviderId[]) d.addOption(id, PROVIDER_LABELS[id]);
				d.setValue(s.provider).onChange(async (v) => {
					s.provider = v as ProviderId;
					await save();
				});
			});
		heading("Anthropic");
		keyField("API key", "anthropicKey");
		textField("Model", "anthropicModel", MODEL_SUGGESTIONS.anthropic.join(", "));
		heading("OpenAI");
		keyField("API key", "openaiKey");
		textField("Model", "openaiModel");
		heading("OpenRouter");
		keyField("API key", "openrouterKey");
		textField("Model", "openrouterModel");
		heading("Custom (OpenAI-compatible)");
		textField("Base URL", "customBaseUrl", "For example http://localhost:11434/v1 for Ollama. On mobile it must be reachable from your phone.");
		keyField("API key (optional)", "customKey");
		textField("Model", "customModel");

		heading("Replies");
		new Setting(containerEl).setName("System prompt").addTextArea((t) => {
			t.inputEl.rows = 4;
			t.setValue(s.systemPrompt).onChange(async (v) => {
				s.systemPrompt = v;
				await save();
			});
		});
		new Setting(containerEl).setName("Temperature").addSlider((sl) =>
			sl
				.setLimits(0, 1, 0.05)
				.setValue(s.temperature)
				.onChange(async (v) => {
					s.temperature = v;
					await save();
				})
		);
		new Setting(containerEl).setName("Max tokens").addText((t) =>
			t.setValue(String(s.maxTokens)).onChange(async (v) => {
				const n = parseInt(v, 10);
				if (!isNaN(n) && n > 0) {
					s.maxTokens = n;
					await save();
				}
			})
		);

		heading("Spell check");
		new Setting(containerEl)
			.setName("Spell check mode")
			.setDesc("Uses your default AI model. Checks the selected text, or the whole note if nothing is selected.")
			.addDropdown((d) =>
				d
					.addOption("list", "List the problems with fixes")
					.addOption("fix", "Fix everything straight away")
					.setValue(s.spellMode)
					.onChange(async (v) => {
						s.spellMode = v as HomeLLMSettings["spellMode"];
						await save();
					})
			);
		new Setting(containerEl).setName("Spelling").addDropdown((d) => {
			for (const v of ["Australian English", "British English", "American English", "Canadian English", "New Zealand English"]) d.addOption(v, v);
			d.setValue(s.spellVariant).onChange(async (v) => {
				s.spellVariant = v;
				await save();
			});
		});

		heading("Chat");
		new Setting(containerEl)
			.setName("Default chat location")
			.setDesc("Where the ribbon button opens the chat.")
			.addDropdown((d) =>
				d
					.addOption("left", "Left sidebar")
					.addOption("right", "Right sidebar")
					.addOption("tab", "New tab")
					.setValue(s.chatLocation)
					.onChange(async (v) => {
						s.chatLocation = v as ChatLocation;
						await save();
						await this.plugin.placeChats();
					})
			);
		toggle(
			"Let AI search and read your notes",
			"vaultAccess",
			"When on, the chat can search and read any note to answer you (only the notes it needs are sent to your AI provider). When off, it can only see the open note. Either way, it can only change or create a note after you approve the change."
		);
		textField("Saved chats folder", "chatSaveFolder");

		heading("Memory");
		toggle(
			"Remember things about me",
			"memoryEnabled",
			"The AI reads your memory note at the start of every chat, and adds short facts when you tell it something lasting or ask it to remember. Its contents are sent to your AI provider with each chat."
		);
		textField("Memory note", "memoryNote", "A normal note you can open, edit or clear at any time.");
		toggle("Ask before remembering", "memoryAskFirst", "Show each new memory for approval before it's saved.");
		new Setting(containerEl).setName("Open memory note").addButton((b) => b.setButtonText("Open").onClick(() => void this.plugin.openMemory()));

		heading("Home screen");
		const pick = (name: string, key: "homeStyle" | "homeBackground", options: [string, string][]) =>
			new Setting(containerEl).setName(name).addDropdown((d) => {
				for (const [v, label] of options) d.addOption(v, label);
				d.setValue(s[key]).onChange(async (v) => {
					if (key === "homeStyle") s.homeStyle = v === "dashboard" ? "dashboard" : "modern";
					else s.homeBackground = v;
					await refresh();
				});
			});
		pick("Style", "homeStyle", [
			["modern", "Modern"],
			["dashboard", "Dashboard"],
		]);
		pick("Background", "homeBackground", SCENE_LABELS);
		new Setting(containerEl)
			.setName("Dashboard title")
			.setDesc("Shown next to the logo.")
			.addText((t) =>
				t.setValue(s.homeTitle).onChange(async (v) => {
					s.homeTitle = v;
					await refresh();
				})
			);
		toggle("Open on startup", "openHomeOnStartup");
		toggle("Replace empty new tab", "replaceNewTab", "Show the home screen instead of the blank new tab page.");
		toggle("Show search", "showSearch");
		toggle("Show recent notes", "showRecent");
		new Setting(containerEl).setName("Recent notes count").addSlider((sl) =>
			sl
				.setLimits(3, 30, 1)
				.setValue(s.recentCount)
				.onChange(async (v) => {
					s.recentCount = v;
					await refresh();
				})
		);

		heading("Graph view");
		new Setting(containerEl)
			.setName("Purple links")
			.setDesc("Draw the lines between linked notes in purple. Close and reopen graph view to see the change.")
			.addToggle((t) =>
				t.setValue(s.purpleGraph).onChange(async (v) => {
					s.purpleGraph = v;
					await save();
					this.plugin.applyGraphStyle();
				})
			);

		heading("Widgets");
		new Setting(containerEl)
			.setName("Widgets in notes")
			.setDesc("In a note, open the command palette and choose insert widget to add a live clock, calendar, word count, vault stats or recent notes. Widgets in a note also show on canvas when you add that note.");

		if (!Platform.isMobile) {
			heading("Ribbon");
			new Setting(containerEl)
				.setName("Spacers")
				.setDesc("Gaps you can drag between the icons in the left ribbon to group them. Hold the command key (control on Windows) to see them. Restart Obsidian to apply a new count.")
				.addSlider((sl) =>
					sl
						.setLimits(0, 10, 1)
						.setValue(s.ribbonSpacers)
						.onChange(async (v) => {
							s.ribbonSpacers = v;
							await save();
						})
				);
		}
	}
}
