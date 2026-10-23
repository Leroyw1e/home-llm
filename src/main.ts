import { App, Editor, MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, SuggestModal, TFile, WorkspaceLeaf, debounce, normalizePath, setIcon } from "obsidian";
import { CHAT_VIEW_TYPE, ChatView, StoredChat } from "./chat-view";
import { DEFAULT_DAILY, DailyNoteConfig, loadDailyConfig } from "./daily";
import { HOME_VIEW_TYPE, HomeView } from "./home-view";
import { ensureMemoryNote, memoryPath } from "./memory";
import { proofread } from "./proofread";
import { ChatLocation, DEFAULT_SETTINGS, HomeLLMSettingTab, HomeLLMSettings } from "./settings";
import { VaultStats } from "./stats";
import { VoiceRecorder, saveVoiceNote } from "./voice";
import { WIDGETS } from "./widgets";

/** Code block language for note widgets: ```home-widget\nstats\n``` */
const WIDGET_BLOCK = "home-widget";

type WidgetEntry = [string, (typeof WIDGETS)[string]];

/** Picker for the "Insert widget" command. */
class WidgetSuggest extends SuggestModal<WidgetEntry> {
	constructor(
		app: App,
		private editor: Editor
	) {
		super(app);
		this.setPlaceholder("Choose a widget to insert");
	}

	getSuggestions(query: string): WidgetEntry[] {
		const q = query.toLowerCase();
		return Object.entries(WIDGETS).filter(([key, w]) => key.includes(q) || w.label.toLowerCase().includes(q));
	}

	renderSuggestion([, w]: WidgetEntry, el: HTMLElement): void {
		el.addClass("hl-widget-suggestion");
		setIcon(el.createSpan("hl-widget-suggestion-icon"), w.icon);
		el.createSpan({ text: w.label });
	}

	onChooseSuggestion([key]: WidgetEntry): void {
		this.editor.replaceSelection("```" + WIDGET_BLOCK + "\n" + key + "\n```\n");
	}
}

/** Most chats kept in history; older ones drop off. */
const MAX_CHATS = 300;

/**
 * Obsidian has no public API to open the settings window, so this uses the app's internal one when present.
 * It's only used by the "Settings" buttons, and fails quietly if the internals change.
 */
interface AppWithSettings {
	setting?: { open?: () => void; openTabById?: (id: string) => void };
}

export default class HomeLLMPlugin extends Plugin {
	settings: HomeLLMSettings = { ...DEFAULT_SETTINGS };
	chats: StoredChat[] = [];
	/** Core Daily notes settings, used by the calendar. */
	daily: DailyNoteConfig = { ...DEFAULT_DAILY };
	stats!: VaultStats;
	private lastFile: TFile | null = null;
	private homeRibbon: HTMLElement | null = null;
	private chatRibbon: HTMLElement | null = null;
	private voiceRibbon: HTMLElement | null = null;
	private recording: VoiceRecorder | null = null;
	private startingRecording = false;
	private saveChatsSoon = debounce(() => void this.saveChats(), 500, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadChats();
		this.stats = new VaultStats(this.app, {
			get: () => this.settings.wordBaseline,
			set: (b) => {
				this.settings.wordBaseline = b;
				void this.saveSettings();
			},
		});
		this.registerEvent(this.app.vault.on("modify", (f) => void this.stats.onModify(f)));
		this.registerEvent(this.app.vault.on("create", (f) => void this.stats.onModify(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.stats.onDelete(f)));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.stats.onRename(f, oldPath)));
		this.applyGraphStyle();

		// Widgets: put ```home-widget``` with a widget name (stats, words, clock, calendar, vault, recent) in any note.
		this.registerMarkdownCodeBlockProcessor(WIDGET_BLOCK, (source, el, mdCtx) => {
			const name = source.trim().split(/\s+/)[0]?.toLowerCase() || "stats";
			const child = new MarkdownRenderChild(el);
			mdCtx.addChild(child);
			const host = el.createDiv("hl-widget");
			const widget = WIDGETS[name];
			if (!widget) {
				host.createDiv({ cls: "hlh-empty", text: `Unknown widget "${name}". Try: ${Object.keys(WIDGETS).join(", ")}.` });
				return;
			}
			widget.render(host, { app: this.app, plugin: this, component: child, open: (f) => void this.app.workspace.getLeaf(false).openFile(f) });
		});
		this.addCommand({ id: "open-memory", name: "Open AI memory note", icon: "brain", checkCallback: this.when("ai", () => void this.openMemory()) });
		this.addCommand({
			id: "insert-widget",
			name: "Insert widget",
			icon: "layout-grid",
			editorCallback: (editor) => new WidgetSuggest(this.app, editor).open(),
		});

		this.registerView(HOME_VIEW_TYPE, (leaf) => new HomeView(leaf, this));
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.homeRibbon = this.addRibbonIcon("home", "Open home", () => void this.openHome());
		this.chatRibbon = this.addRibbonIcon("bot", "Open AI chat", () => void this.openChat());
		this.voiceRibbon = this.addRibbonIcon("mic", "Record voice note", () => void this.toggleRecording());
		if (!Platform.isMobile) this.addRibbonSpacers();

		this.addCommand({ id: "open-home", name: "Open home screen", checkCallback: this.when("home", () => void this.openHome()) });
		this.addCommand({ id: "open-chat", name: "Open AI chat", checkCallback: this.when("ai", () => void this.openChat()) });
		this.addCommand({ id: "open-chat-left", name: "Open AI chat in left sidebar", checkCallback: this.when("ai", () => void this.openChat("left")) });
		this.addCommand({ id: "open-chat-right", name: "Open AI chat in right sidebar", checkCallback: this.when("ai", () => void this.openChat("right")) });
		this.addCommand({ id: "open-chat-tab", name: "Open AI chat in new tab", checkCallback: this.when("ai", () => void this.openChat("tab")) });
		this.addCommand({
			id: "ask-about-note",
			name: "Ask AI about current note",
			checkCallback: (checking) => {
				if (!this.settings.aiEnabled || !this.app.workspace.getActiveFile()) return false;
				if (!checking) void this.openChat(undefined, true);
				return true;
			},
		});
		this.addCommand({
			id: "record-voice-note",
			name: "Record voice note (start or stop)",
			icon: "mic",
			checkCallback: (checking) => {
				if (!this.settings.voiceEnabled && !this.recording) return false;
				if (!checking) void this.toggleRecording();
				return true;
			},
		});
		this.addCommand({
			id: "pause-voice-note",
			name: "Pause or resume recording",
			icon: "pause",
			checkCallback: (checking) => {
				if (!this.recording) return false;
				if (!checking) this.recording.togglePause();
				return true;
			},
		});
		this.addCommand({ id: "toggle-home", name: "Turn home screen on or off", callback: () => void this.toggleFeature("home") });
		this.addCommand({ id: "toggle-ai", name: "Turn AI on or off", callback: () => void this.toggleFeature("ai") });
		// Spell check shows up in the command palette and, with the core Slash commands plugin on, when you type "/" in a note.
		const spell = (mode: () => "list" | "fix") => (checking: boolean, editor: Editor) => {
			if (!this.settings.aiEnabled) return false;
			if (!checking) void proofread(this, editor, mode());
			return true;
		};
		this.addCommand({ id: "spell-check", name: "Spell check", icon: "spell-check", editorCheckCallback: spell(() => this.settings.spellMode) });
		this.addCommand({ id: "spell-check-list", name: "Spell check: list problems with fixes", icon: "list-checks", editorCheckCallback: spell(() => "list") });
		this.addCommand({ id: "spell-check-fix", name: "Spell check: fix everything", icon: "wand-2", editorCheckCallback: spell(() => "fix") });
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.aiEnabled) return;
				menu.addItem((it) =>
					it
						.setTitle("Spell check")
						.setIcon("spell-check")
						.onClick(() => void proofread(this, editor, this.settings.spellMode))
				);
			})
		);

		this.addSettingTab(new HomeLLMSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView && leaf.view.file) this.lastFile = leaf.view.file;
				this.maybeReplaceEmpty(leaf);
			})
		);
		this.applyFeatures();
		this.registerEvent(this.app.workspace.on("layout-change", () => this.maybeReplaceEmpty(this.app.workspace.getMostRecentLeaf())));
		// Obsidian may reset body classes while starting up or changing theme, so re-apply after both.
		this.registerEvent(this.app.workspace.on("css-change", () => activeDocument.body.toggleClass("hl-graph-default-lines", !this.settings.purpleGraph)));
		this.app.workspace.onLayoutReady(() => {
			this.applyGraphStyle();
			void this.refreshDailyConfig();
			// Version 2.0 removed the web browser; close any of its tabs left in a saved layout.
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.getViewState().type === "home-llm-web") leaf.detach();
			});
			void this.placeChats();
			if (this.settings.homeEnabled && this.settings.openHomeOnStartup) void this.openHome(true);
		});
	}

	onunload(): void {
		this.recording?.cancel();
		void this.saveChats();
		activeDocument.body.removeClass("hl-graph-default-lines");
		this.app.workspace.trigger("css-change");
	}

	/**
	 * Purple link lines in graph view are on by default in styles.css; this class turns them off.
	 * Triggering css-change makes open graphs re-read their colours straight away.
	 */
	applyGraphStyle(): void {
		activeDocument.body.toggleClass("hl-graph-default-lines", !this.settings.purpleGraph);
		this.app.workspace.trigger("css-change");
	}

	/** A command check that only offers the command while its feature is switched on. */
	private when(feature: "home" | "ai", run: () => void): (checking: boolean) => boolean {
		return (checking) => {
			if (!(feature === "home" ? this.settings.homeEnabled : this.settings.aiEnabled)) return false;
			if (!checking) run();
			return true;
		};
	}

	async toggleFeature(feature: "home" | "ai"): Promise<void> {
		if (feature === "home") this.settings.homeEnabled = !this.settings.homeEnabled;
		else this.settings.aiEnabled = !this.settings.aiEnabled;
		await this.saveSettings();
		this.applyFeatures();
		const on = feature === "home" ? this.settings.homeEnabled : this.settings.aiEnabled;
		new Notice(`${feature === "home" ? "Home screen" : "AI"} turned ${on ? "on" : "off"}`);
	}

	/** Shows or hides each feature's ribbon button and closes its views when switched off. */
	applyFeatures(): void {
		const { homeEnabled, aiEnabled } = this.settings;
		this.homeRibbon?.toggleClass("hl-hidden", !homeEnabled);
		this.chatRibbon?.toggleClass("hl-hidden", !aiEnabled);
		this.voiceRibbon?.toggleClass("hl-hidden", !this.settings.voiceEnabled && !this.recording);
		if (!homeEnabled) this.app.workspace.detachLeavesOfType(HOME_VIEW_TYPE);
		if (!aiEnabled) this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
		this.refreshHomeViews();
	}

	/** Starts a recording, or stops the current one and turns it into a note. */
	async toggleRecording(): Promise<void> {
		if (this.recording) {
			await this.stopRecording();
			return;
		}
		if (this.startingRecording) return;
		this.startingRecording = true;
		try {
			this.recording = await VoiceRecorder.start(
				() => this.recording?.togglePause(),
				() => void this.stopRecording()
			);
		} finally {
			this.startingRecording = false;
		}
		this.voiceRibbon?.toggleClass("hl-recording", !!this.recording);
	}

	private async stopRecording(): Promise<void> {
		const rec = this.recording;
		if (!rec) return;
		this.recording = null;
		this.voiceRibbon?.removeClass("hl-recording");
		const { blob, ms } = await rec.stop();
		if (!blob.size || ms < 500) {
			new Notice("Recording too short, nothing saved");
			return;
		}
		try {
			await saveVoiceNote(this, blob, ms);
		} catch (e) {
			new Notice("Couldn't save the voice note: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	/** Opens the AI's memory note in a new tab, creating it if needed. */
	async openMemory(): Promise<void> {
		const file = await ensureMemoryNote(this.app, memoryPath(this.settings.memoryNote));
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	async refreshDailyConfig(): Promise<void> {
		this.daily = await loadDailyConfig(this.app);
	}

	/** Gaps for the left ribbon. Drag them like any ribbon icon; holding Command (Ctrl) makes them easy to see. */
	private addRibbonSpacers(): void {
		for (let i = 1; i <= this.settings.ribbonSpacers; i++) {
			const el = this.addRibbonIcon("grip-horizontal", `Spacer ${i}`, () => {});
			el.addClass("home-llm-ribbon-spacer");
			el.removeAttribute("aria-label");
		}
		const setEditing = (on: boolean) => activeDocument.body.toggleClass("home-llm-ribbon-editing", on);
		this.registerDomEvent(window, "keydown", (e) => {
			if (e.key === "Meta" || e.key === "Control") setEditing(true);
		});
		this.registerDomEvent(window, "keyup", (e) => {
			if (e.key === "Meta" || e.key === "Control") setEditing(false);
		});
		this.registerDomEvent(window, "blur", () => setEditing(false));
		this.register(() => setEditing(false));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<HomeLLMSettings> | null);
		// 2048 was the old default; current models also spend reply tokens thinking, so lift it.
		if (this.settings.maxTokens === 2048) this.settings.maxTokens = DEFAULT_SETTINGS.maxTokens;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Chat history lives in its own file next to the settings so they stay small. */
	private chatsPath(): string {
		return normalizePath(`${this.manifest.dir ?? ""}/chats.json`);
	}

	private async loadChats(): Promise<void> {
		this.chats = [];
		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(this.chatsPath())) {
				const data = JSON.parse(await adapter.read(this.chatsPath())) as { chats?: StoredChat[] };
				this.chats = Array.isArray(data.chats) ? data.chats : [];
			}
		} catch (e) {
			console.error("Home + AI: could not read chat history", e);
		}
	}

	private async saveChats(): Promise<void> {
		await this.app.vault.adapter.write(this.chatsPath(), JSON.stringify({ chats: this.chats }));
	}

	upsertChat(chat: StoredChat): void {
		this.chats = [chat, ...this.chats.filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS);
		this.saveChatsSoon();
	}

	deleteChat(id: string): void {
		this.chats = this.chats.filter((c) => c.id !== id);
		this.saveChatsSoon();
	}

	lastMarkdownFile(): TFile | null {
		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === "md") return active;
		return this.lastFile;
	}

	refreshHomeViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)) {
			if (leaf.view instanceof HomeView) leaf.view.render();
		}
	}

	/** Shows the home screen in place of Obsidian's blank "New tab" page. */
	private maybeReplaceEmpty(leaf: WorkspaceLeaf | null): void {
		if (!this.settings.homeEnabled || !this.settings.replaceNewTab || !leaf) return;
		if (leaf.view?.getViewType() !== "empty") return;
		if (leaf.getRoot() !== this.app.workspace.rootSplit) return;
		void leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
	}

	async openHome(startup = false): Promise<void> {
		const ws = this.app.workspace;
		const existing = ws.getLeavesOfType(HOME_VIEW_TYPE)[0];
		if (existing) {
			await ws.revealLeaf(existing);
			if (existing.view instanceof HomeView) existing.view.render();
			return;
		}
		const current = ws.getMostRecentLeaf(ws.rootSplit);
		const leaf = startup && current?.view?.getViewType() === "empty" ? current : ws.getLeaf("tab");
		await leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
		await ws.revealLeaf(leaf);
	}

	async openChat(location?: ChatLocation, includeNote = false): Promise<void> {
		const ws = this.app.workspace;
		const where = location ?? this.settings.chatLocation;
		let leaf: WorkspaceLeaf | null = location ? null : (ws.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null);
		if (!leaf) {
			leaf = where === "left" ? ws.getLeftLeaf(false) : where === "right" ? ws.getRightLeaf(false) : ws.getLeaf("tab");
			if (!leaf) {
				new Notice("Could not open chat");
				return;
			}
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		await ws.revealLeaf(leaf);
		if (includeNote && leaf.view instanceof ChatView) leaf.view.setIncludeNote(true);
	}

	private sidebarSide(): "left" | "right" {
		return this.settings.chatLocation === "left" ? "left" : "right";
	}

	/** Moves a chat between a main tab and the sidebar, keeping the conversation. */
	async moveChat(leaf: WorkspaceLeaf): Promise<void> {
		const inMain = leaf.getRoot() === this.app.workspace.rootSplit;
		await this.moveChatLeaf(leaf, inMain ? this.sidebarSide() : "tab", true);
	}

	private async moveChatLeaf(from: WorkspaceLeaf, where: ChatLocation, reveal: boolean): Promise<void> {
		const ws = this.app.workspace;
		const leaf = where === "left" ? ws.getLeftLeaf(false) : where === "right" ? ws.getRightLeaf(false) : ws.getLeaf("tab");
		if (!leaf) {
			new Notice("Could not move chat");
			return;
		}
		// getViewState works even when the sidebar view hasn't been loaded yet.
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: reveal, state: from.getViewState().state });
		from.detach();
		if (reveal) await ws.revealLeaf(leaf);
	}

	/** Keep sidebar chats on the side chosen in settings. */
	async placeChats(): Promise<void> {
		const ws = this.app.workspace;
		const side = this.sidebarSide();
		const wrong = side === "right" ? ws.leftSplit : ws.rightSplit;
		for (const leaf of ws.getLeavesOfType(CHAT_VIEW_TYPE)) {
			if (leaf.getRoot() === wrong) await this.moveChatLeaf(leaf, side, false);
		}
	}

	/** Opens Obsidian's settings window, on this plugin's page unless `pluginTab` is false. */
	openSettings(pluginTab = true): void {
		const setting = (this.app as unknown as AppWithSettings).setting;
		setting?.open?.();
		if (pluginTab) setting?.openTabById?.(this.manifest.id);
	}
}
