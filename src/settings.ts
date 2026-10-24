import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type HomeLLMPlugin from "./main";
import { SCENE_LABELS } from "./scenes";
import type { FocusState } from "./focus";
import type { WordBaseline } from "./stats";
import type { WritingLog } from "./writing";
import { Reader, voices } from "./speak";
import { currentUsage, enabledPluginSizes } from "./performance";
import { localAI } from "./local";
import { DEFAULT_TRANSCRIBE_MODEL, TRANSCRIBER_LABELS, type Transcriber } from "./voice";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "custom" | "local";
export type ChatLocation = "left" | "right" | "tab";
/** How hard the model thinks before answering; "default" leaves it to the model. */
export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LABELS: Record<Effort, string> = {
	default: "Model default",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export type Feature = "home" | "ai" | "chat" | "memory" | "spell" | "profile" | "study" | "voice" | "read" | "focus" | "draw" | "widgets" | "graph";

/** Every main feature's on/off switch, in the order shown under Features in settings. */
export const FEATURES: { id: Feature; key: keyof HomeLLMSettings & `${string}${"Enabled" | "Graph"}`; name: string; desc: string; needsAI?: boolean }[] = [
	{ id: "home", key: "homeEnabled", name: "Home screen", desc: "The home page and its ribbon button." },
	{ id: "ai", key: "aiEnabled", name: "AI", desc: "Everything that uses AI. When off, nothing is sent to any AI provider." },
	{ id: "chat", key: "chatEnabled", name: "AI chat", desc: "The chat in a sidebar or tab, and its ribbon button.", needsAI: true },
	{ id: "memory", key: "memoryEnabled", name: "AI memory", desc: "The chat remembers things about you in a note you can see and edit.", needsAI: true },
	{ id: "spell", key: "spellEnabled", name: "Spell check", desc: "AI spelling, punctuation and grammar check.", needsAI: true },
	{ id: "profile", key: "writingLogEnabled", name: "Writing profile", desc: "Spell check keeps a list of your common mistakes, and the AI can describe how you write in a note.", needsAI: true },
	{ id: "study", key: "studyEnabled", name: "Flashcards and quizzes", desc: "Make flashcards or a quiz from any note to study with.", needsAI: true },
	{ id: "voice", key: "voiceEnabled", name: "Voice notes", desc: "A microphone button that records into a new note. With AI on, you also get a transcript and summary." },
	{ id: "read", key: "readEnabled", name: "Read aloud", desc: "Hear a note read to you, using your device's own voices (works offline, free)." },
	{ id: "focus", key: "focusEnabled", name: "Focus timer", desc: "A Pomodoro timer on the home screen, in the left ribbon, in the tab bar while it runs, and in the menu bar." },
	{ id: "draw", key: "drawEnabled", name: "Canvas drawing", desc: "Draw on any canvas with Apple Pencil, a mouse or your finger, add shapes and arrows, and add sticky notes, like Freeform." },
	{ id: "widgets", key: "widgetsEnabled", name: "Note widgets", desc: "Live clocks, calendars, word counts and stats inside notes." },
	{ id: "graph", key: "purpleGraph", name: "Purple graph links", desc: "Draw the lines between linked notes in purple. Reopen graph view to see the change." },
];

export interface HomeLLMSettings {
	/** Low power mode: fewer updates and no animations, to use less CPU and battery. */
	lowPower: boolean;
	/** Moving parts in the illustrated home screen backgrounds. */
	animatedBackgrounds: boolean;
	/** How many past chats are kept (each is held in memory). */
	chatsToKeep: number;
	/** Feature switches: the home screen (and its ribbon button), and everything AI. */
	homeEnabled: boolean;
	aiEnabled: boolean;
	/** Separate switches for AI features (they also need aiEnabled on). */
	chatEnabled: boolean;
	spellEnabled: boolean;
	studyEnabled: boolean;
	/** Writing profile: spell check's findings, and the note the AI writes about how you write. */
	writingLogEnabled: boolean;
	writingLog: WritingLog | null;
	writingProfileNote: string;
	/** Canvas drawing: the last tool, colour ("ink" = black or white to suit the theme) and on-screen width. */
	drawEnabled: boolean;
	drawTool: string;
	drawColour: string;
	drawSize: number;
	/** Fingers draw instead of scrolling (for touch screens without a pencil). */
	drawWithFinger: boolean;
	/** Touching a canvas with Apple Pencil starts drawing straight away. */
	drawWithPencil: boolean;
	/** Read aloud: the voice's name ("" picks the best one for your spelling) and speed. */
	readEnabled: boolean;
	readVoice: string;
	readRate: number;
	/** Pomodoro timer: lengths in minutes, and its saved state. */
	focusEnabled: boolean;
	focusMinutes: number;
	focusShortBreak: number;
	focusLongBreak: number;
	focusLongEvery: number;
	focusSound: boolean;
	focusAutoStart: boolean;
	/** Colour of the timer's ring and buttons. */
	focusColour: string;
	/** Show the timer in the Mac menu bar (desktop). */
	focusMenuBar: boolean;
	focusState: FocusState | null;
	/** Live widgets in notes (```home-widget``` blocks). */
	widgetsEnabled: boolean;
	/** Voice notes: the mic button that records into a new note. */
	voiceEnabled: boolean;
	/** Who turns speech into text ("auto" picks whichever key is set). */
	voiceProvider: "auto" | Transcriber;
	/** Transcription model; empty uses the provider's default. */
	voiceModel: string;
	voiceFolder: string;
	/** Show what's being said under the recording bar while recording. */
	voiceLive: boolean;
	/** Start each transcript paragraph with a time you can click to hear that part. */
	voiceTimestamps: boolean;
	/** Google Gemini key, used only for voice notes. */
	geminiKey: string;
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
	effort: Effort;
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
	/** Days you wrote on (YYYY-MM-DD), for the writing streak. */
	writingDays: string[] | null;
	/** Total words at the first count today, for the "today" figure. */
	wordBaseline: WordBaseline | null;
}

export const DEFAULT_SETTINGS: HomeLLMSettings = {
	lowPower: false,
	animatedBackgrounds: true,
	chatsToKeep: 300,
	homeEnabled: true,
	aiEnabled: true,
	chatEnabled: true,
	spellEnabled: true,
	studyEnabled: true,
	writingLogEnabled: true,
	writingLog: null,
	writingProfileNote: "Writing profile.md",
	drawEnabled: true,
	drawTool: "pen",
	drawColour: "ink",
	drawSize: 6,
	drawWithFinger: false,
	drawWithPencil: true,
	readEnabled: true,
	readVoice: "",
	readRate: 1,
	focusEnabled: true,
	focusMinutes: 25,
	focusShortBreak: 5,
	focusLongBreak: 15,
	focusLongEvery: 4,
	focusSound: true,
	focusAutoStart: false,
	focusColour: "#8a5cf5",
	focusMenuBar: true,
	focusState: null,
	widgetsEnabled: true,
	voiceEnabled: true,
	voiceProvider: "auto",
	voiceModel: "",
	voiceFolder: "Voice notes",
	geminiKey: "",
	voiceLive: true,
	voiceTimestamps: true,
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
	maxTokens: 16000,
	effort: "default",
	chatLocation: "right",
	chatSaveFolder: "AI Chats",
	openHomeOnStartup: true,
	replaceNewTab: true,
	showSearch: true,
	showRecent: true,
	homeStyle: "dashboard",
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
	writingDays: null,
	wordBaseline: null,
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	anthropic: "Anthropic (Claude)",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	custom: "Custom / Ollama / LM Studio",
	local: "On this device",
};

export const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
	anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
	openai: ["gpt-4o", "gpt-4o-mini"],
	openrouter: ["anthropic/claude-sonnet-5.5", "openai/gpt-4o"],
	custom: [],
	local: [],
};

/** Settings whose value is any string (not a fixed set of choices). */
type StringKey = { [K in keyof HomeLLMSettings]: string extends HomeLLMSettings[K] ? K : never }[keyof HomeLLMSettings];
type BoolKey = { [K in keyof HomeLLMSettings]: HomeLLMSettings[K] extends boolean ? K : never }[keyof HomeLLMSettings];

export class HomeLLMSettingTab extends PluginSettingTab {
	plugin: HomeLLMPlugin;
	private usageTimer = 0;

	constructor(app: App, plugin: HomeLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		window.clearInterval(this.usageTimer);
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

		heading("Features");
		// Rows for features that need AI, so they can show when the AI switch makes them unavailable.
		const needsAI: { row: Setting; desc: string }[] = [];
		const showAIState = () => {
			for (const { row, desc } of needsAI) {
				row.setDesc(s.aiEnabled ? desc : `${desc} Turn on AI to use this.`);
				row.settingEl.toggleClass("hl-setting-off", !s.aiEnabled);
			}
		};
		for (const f of FEATURES) {
			const row = new Setting(containerEl)
				.setName(f.name)
				.setDesc(f.desc)
				.addToggle((t) =>
					t.setValue(s[f.key]).onChange(async (v) => {
						await this.plugin.setFeature(f.id, v);
						if (f.id === "ai") showAIState();
					})
				);
			if (f.needsAI) needsAI.push({ row, desc: f.desc });
		}
		showAIState();

		heading("Performance");
		const usage = currentUsage();
		if (usage) {
			const live = new Setting(containerEl).setName("Obsidian right now").setDesc("Measuring…");
			live.settingEl.addClass("hl-usage");
			const show = () => {
				const u = currentUsage();
				if (u) live.setDesc(`${Math.round(u.cpu)}% CPU · ${u.memoryMB.toLocaleString()} MB memory · ${u.processes} processes`);
			};
			window.clearInterval(this.usageTimer);
			this.usageTimer = window.setInterval(show, 2000);
			window.setTimeout(show, 300);
		}
		new Setting(containerEl)
			.setName("Low power mode")
			.setDesc("Uses less CPU and battery: stops background animations, counts words every 30 seconds instead of as you type, updates the focus timer once a minute, lets Obsidian rest in the background, and turns off the live transcript.")
			.addToggle((tg) =>
				tg.setValue(s.lowPower).onChange(async (v) => {
					s.lowPower = v;
					await save();
					this.plugin.applyPerformance();
				})
			);
		new Setting(containerEl)
			.setName("Animated backgrounds")
			.setDesc("Twinkling stars, rain, waves and the aurora on the home screen. They always pause while Obsidian isn't the app you're using.")
			.addToggle((tg) =>
				tg.setValue(s.animatedBackgrounds).onChange(async (v) => {
					s.animatedBackgrounds = v;
					await save();
					this.plugin.applyPerformance();
				})
			);
		new Setting(containerEl)
			.setName("Chats to keep")
			.setDesc("Older chats are deleted. Fewer chats use less memory.")
			.addDropdown((d) => {
				for (const n of [20, 50, 100, 300]) d.addOption(String(n), String(n));
				d.setValue(String(s.chatsToKeep)).onChange(async (v) => {
					s.chatsToKeep = Number(v);
					await save();
					this.plugin.trimChats();
				});
			});
		const pluginRows = containerEl.createDiv();
		void enabledPluginSizes(this.app).then((sizes) => {
			if (!sizes.length) return;
			new Setting(pluginRows)
				.setName("Biggest plugins")
				.setDesc("Every turned-on plugin loads when Obsidian starts. Big ones take the most memory, so turn off any you don't use often.")
				.addButton((b) => b.setButtonText("Manage plugins").onClick(() => this.plugin.openSettingsTab("community-plugins")));
			for (const p of sizes.slice(0, 6)) {
				const big = p.sizeMB >= 5;
				new Setting(pluginRows)
					.setName(p.name)
					.setDesc(`${p.sizeMB >= 1 ? p.sizeMB.toFixed(1) + " MB" : Math.max(1, Math.round(p.sizeMB * 1024)) + " KB"} of code${big ? ". Large: this is likely the biggest user of memory." : ""}`)
					.settingEl.toggleClass("hl-plugin-big", big);
			}
		});

		heading("AI provider");
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

		heading("On this device");
		const local = localAI();
		new Setting(containerEl)
			.setName(local ? `Using ${local.modelName()}` : "Home + AI Local add-on")
			.setDesc(
				local
					? "Runs a small AI model on this device with no internet and no API key. Choose the model and download it in the add-on's settings, then pick On this device as the provider."
					: "Install the Home + AI Local add-on from Community plugins to run a small AI model on this device (works best on recent iPads and Macs), with no internet or API key. It's separate so this plugin stays light."
			)
			.addButton((b) => b.setButtonText(local ? "Add-on settings" : "Find add-on").onClick(() => this.plugin.openSettingsTab(local ? "home-ai-local" : "community-plugins")));

		heading("Replies");
		new Setting(containerEl)
			.setName("Effort")
			.setDesc("How hard the AI thinks before answering. Higher handles harder questions but is slower and costs more. Some providers only go up to high, and models without this setting ignore it.")
			.addDropdown((d) => {
				for (const e of Object.keys(EFFORT_LABELS) as Effort[]) d.addOption(e, EFFORT_LABELS[e]);
				d.setValue(s.effort).onChange(async (v) => {
					s.effort = v as Effort;
					await save();
				});
			});
		new Setting(containerEl).setName("System prompt").addTextArea((t) => {
			t.inputEl.rows = 4;
			t.setValue(s.systemPrompt).onChange(async (v) => {
				s.systemPrompt = v;
				await save();
			});
		});
		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Randomness of replies. Used by OpenAI-compatible and older Claude models; current Claude models choose their own.")
			.addSlider((sl) =>
			sl
				.setLimits(0, 1, 0.05)
				.setValue(s.temperature)
				.onChange(async (v) => {
					s.temperature = v;
					await save();
				})
		);
		new Setting(containerEl)
			.setName("Max tokens")
			.setDesc("Longest reply allowed, including the AI's thinking.")
			.addText((t) =>
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

		heading("Voice notes");
		keyField("Gemini API key", "geminiKey").setDesc("Gemini listens to your recording and writes the transcript and summary, then Claude names the note. You can get a free key from Google.");
		new Setting(containerEl)
			.setName("Transcription")
			.setDesc("Claude can't listen to audio, so another service turns speech into text. Automatic uses Gemini if it has a key, then the other keys (with Claude writing the summary).")
			.addDropdown((d) => {
				for (const [v, label] of Object.entries(TRANSCRIBER_LABELS)) d.addOption(v, label);
				d.setValue(s.voiceProvider).onChange(async (v) => {
					s.voiceProvider = v as HomeLLMSettings["voiceProvider"];
					await save();
				});
			});
		textField("Transcription model", "voiceModel", `Leave empty for the default: ${DEFAULT_TRANSCRIBE_MODEL.gemini} on Gemini, ${DEFAULT_TRANSCRIBE_MODEL.openai} on OpenAI.`);
		toggle("Live transcript", "voiceLive", "Show what you're saying under the recording bar as you talk. Sends short clips while you speak, so it costs a little extra.");
		toggle("Timestamps", "voiceTimestamps", "Start each paragraph of the transcript with a time. Click it to hear that part of the recording.");
		textField("Voice notes folder", "voiceFolder", "Recordings go wherever Obsidian puts attachments.");

		heading("Canvas drawing");
		new Setting(containerEl)
			.setName("How to draw")
			.setDesc("In a canvas, press the pen button in the toolbar at the bottom. Draw, then press done and your drawing becomes a card you can move, resize and connect. Right-click a drawing and choose edit drawing to change it.");
		toggle("Draw as soon as the pencil touches", "drawWithPencil", "On a tablet, touching a canvas with a stylus starts drawing, while fingers keep scrolling and zooming.");
		toggle("Draw with finger", "drawWithFinger", "Fingers draw instead of scrolling while drawing. Useful without a stylus.");

		heading("Read aloud");
		const voiceRow = new Setting(containerEl).setName("Voice").setDesc("Your device's built-in voices. For the most natural sound, download a premium voice in your system's spoken content settings.");
		const fillVoices = () => {
			voiceRow.controlEl.empty();
			voiceRow.addDropdown((d) => {
				d.addOption("", "Automatic (matches your spelling)");
				const list = voices()
					.filter((v) => v.lang.startsWith("en"))
					.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
				for (const v of list) d.addOption(v.name, `${v.name} (${v.lang})`);
				d.setValue(list.some((v) => v.name === s.readVoice) ? s.readVoice : "").onChange(async (v) => {
					s.readVoice = v;
					await save();
				});
			});
			voiceRow.addExtraButton((b) =>
				b
					.setIcon("play")
					.setTooltip("Try this voice")
					.onClick(() => this.plugin.reader.start("Hi! This is how your notes will sound when I read them to you.", "Voice test"))
			);
		};
		if (Reader.supported()) {
			fillVoices();
			if (!voices().length) speechSynthesis.addEventListener("voiceschanged", fillVoices, { once: true });
		} else voiceRow.setDesc("Reading aloud isn't available on this device.");
		new Setting(containerEl).setName("Speed").addDropdown((d) => {
			for (const r of [0.75, 1, 1.25, 1.5, 2]) d.addOption(String(r), `${r}×`);
			d.setValue(String(s.readRate)).onChange(async (v) => {
				s.readRate = Number(v);
				await save();
			});
		});

		heading("Focus timer");
		const minutes = (name: string, key: "focusMinutes" | "focusShortBreak" | "focusLongBreak" | "focusLongEvery", min: number, max: number, unit = "minutes") => {
			const row = new Setting(containerEl).setName(name).setDesc(`${s[key]} ${unit}`);
			row.addSlider((sl) =>
				sl
					.setLimits(min, max, 1)
					.setValue(s[key])
					.onChange(async (v) => {
						s[key] = v;
						row.setDesc(`${v} ${unit}`);
						await save();
						this.plugin.focus.refresh();
					})
			);
		};
		minutes("Focus length", "focusMinutes", 5, 90);
		minutes("Short break", "focusShortBreak", 1, 30);
		minutes("Long break", "focusLongBreak", 5, 60);
		minutes("Long break after", "focusLongEvery", 2, 8, "focus sessions");
		toggle("Sound when time's up", "focusSound");
		toggle("Start the next session by itself", "focusAutoStart");
		new Setting(containerEl)
			.setName("Timer colour")
			.addColorPicker((c) =>
				c.setValue(s.focusColour).onChange(async (v) => {
					s.focusColour = v;
					await save();
					this.plugin.applyFocusColour();
				})
			)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Back to purple")
					.onClick(async () => {
						s.focusColour = DEFAULT_SETTINGS.focusColour;
						await save();
						this.plugin.applyFocusColour();
						this.plugin.focus.refresh();
					})
			);
		if (Platform.isDesktopApp)
			new Setting(containerEl)
				.setName("Show in the menu bar")
				.setDesc("Puts the timer at the top of your screen with the time left, so you can see and control it from any app.")
				.addToggle((tg) =>
					tg.setValue(s.focusMenuBar).onChange(async (v) => {
						s.focusMenuBar = v;
						await save();
						this.plugin.applyFeatures();
					})
				);

		heading("Writing profile");
		textField("Writing profile note", "writingProfileNote", "The AI describes how you write here, with a table of the words you most often misspell. The table updates after every spell check.");
		new Setting(containerEl)
			.setName("Update my writing profile")
			.setDesc("Reads your recent notes and spell check history, then rewrites the profile. Your words are sent to your AI provider.")
			.addButton((b) => b.setButtonText("Update").setCta().onClick(() => void this.plugin.updateWritingProfile()));
		new Setting(containerEl)
			.setName("Clear mistake history")
			.setDesc(`${Object.keys(s.writingLog?.spelling ?? {}).length} misspelt words and ${s.writingLog?.other.length ?? 0} other problems recorded from ${s.writingLog?.checks ?? 0} spell checks.`)
			.addButton((b) =>
				b.setButtonText("Clear").onClick(async () => {
					s.writingLog = null;
					await save();
					new Notice("Mistake history cleared");
				})
			);

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
		textField("Memory note", "memoryNote", "The AI reads this note at the start of every chat and adds short facts when you tell it something lasting. Its contents are sent to your AI provider with each chat. You can open, edit or clear it at any time.");
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
