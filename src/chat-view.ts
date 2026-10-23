import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, Platform, ViewStateResult, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { Activity, EditRequest, runAgent } from "./agent";
import { lineDiff } from "./diff";
import { memoryPath } from "./memory";
import { modelFor } from "./providers";
import { moment } from "./time";
import { EFFORT_LABELS, Effort, MODEL_SUGGESTIONS, PROVIDER_LABELS, ProviderId } from "./settings";

export const CHAT_VIEW_TYPE = "home-llm-chat";

export interface UIMessage {
	role: "user" | "assistant";
	content: string;
	/** Short label shown instead of a long content (for example a whole note). */
	display?: string;
	model?: string;
	error?: boolean;
	/** Notes the AI searched, read or edited while writing this reply. */
	activity?: Activity[];
}

export interface StoredChat {
	id: string;
	created: number;
	updated: number;
	provider: ProviderId;
	model: string;
	messages: UIMessage[];
}

interface ChatViewState extends Record<string, unknown> {
	chatId?: string | null;
	chatCreated?: number | null;
	messages?: UIMessage[];
	provider?: ProviderId;
	model?: string;
	includeNote?: boolean;
}

const SUGGESTIONS = [
	{ icon: "file-text", text: "Summarise this note", note: true },
	{ icon: "list-checks", text: "Find the action items in this note", note: true },
	{ icon: "lightbulb", text: "Brainstorm ideas with me", note: false },
	{ icon: "list-tree", text: "Help me draft an outline", note: false },
];

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5"; other ids are shown as-is. */
export function prettyModel(id: string | undefined): string {
	const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id ?? "");
	if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
	return id || "No model";
}

function chatTitle(chat: StoredChat): string {
	const first = chat.messages.find((m) => m.role === "user");
	const t = first ? (first.display ?? first.content).replace(/\s+/g, " ").trim() : "New chat";
	return t.length > 60 ? t.slice(0, 59) + "…" : t;
}

export class ChatView extends ItemView {
	plugin: HomeLLMPlugin;
	messages: UIMessage[] = [];
	includeNote = false;
	busy = false;
	provider: ProviderId;
	model: string;
	chatId: string | null = null;
	chatCreated: number | null = null;
	historyOpen = false;
	/** Steps taken so far in the reply being written. */
	private liveActivity: Activity[] = [];
	/** An edit waiting for the user's decision. */
	private pendingEdit: { req: EditRequest; resolve: (ok: boolean) => void } | null = null;
	private vaultBtn: HTMLButtonElement | null = null;

	private modelBtn: HTMLButtonElement | null = null;
	private historyBtn!: HTMLButtonElement;
	private listEl!: HTMLDivElement;
	private historyEl!: HTMLDivElement;
	private historySearch!: HTMLInputElement;
	private historyList!: HTMLDivElement;
	private chipsEl: HTMLDivElement | null = null;
	private inputEl!: HTMLTextAreaElement;
	private ctxBtn: HTMLButtonElement | null = null;
	private sendBtn!: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, plugin: HomeLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.provider = plugin.settings.provider;
		this.model = modelFor(plugin.settings, this.provider);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "AI chat";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("home-llm-chat");
		root.toggleClass("is-mobile", Platform.isMobile);

		const header = root.createDiv("hlc-header");
		this.modelBtn = header.createEl("button", { cls: "hlc-model" });
		this.modelBtn.onclick = (e) => this.modelMenu(e);
		const hActions = header.createDiv("hlc-header-actions");
		this.vaultBtn = this.iconButton(hActions, "library", "", () => void this.toggleVaultAccess());
		this.syncVaultButton();
		this.historyBtn = this.iconButton(hActions, "history", "Chat history", () => this.toggleHistory());
		this.iconButton(hActions, "square-pen", "New chat", () => this.newChat());
		this.iconButton(hActions, "more-horizontal", "More", (e) => this.moreMenu(e));

		const body = root.createDiv("hlc-body-wrap");
		this.listEl = body.createDiv("hlc-list");
		this.historyEl = body.createDiv("hlc-history");
		const hHead = this.historyEl.createDiv("hlc-history-head");
		this.historySearch = hHead.createEl("input", { type: "text", cls: "hlc-history-search", attr: { placeholder: "Search chats", spellcheck: "false" } });
		this.historySearch.addEventListener("input", () => this.renderHistory());
		this.historySearch.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.toggleHistory(false);
		});
		this.historyList = this.historyEl.createDiv("hlc-history-list");

		const composer = root.createDiv("hlc-composer");
		const box = composer.createDiv("hlc-box");
		this.chipsEl = box.createDiv("hlc-chips");
		this.inputEl = box.createEl("textarea", {
			cls: "hlc-input",
			attr: { placeholder: "Ask anything…", rows: "1", enterkeyhint: Platform.isMobile ? "enter" : "send" },
		});
		const row = box.createDiv("hlc-box-row");
		this.ctxBtn = this.iconButton(row, "paperclip", "Include current note", () => this.setIncludeNote(!this.includeNote));
		row.createDiv("hlc-spacer");
		this.sendBtn = row.createEl("button", { cls: "hlc-send", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.onclick = () => void this.send();
		this.inputEl.addEventListener("input", () => this.syncComposer());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !Platform.isMobile) {
				e.preventDefault();
				void this.send();
			}
		});

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.renderChips()));
		this.updateModelLabel();
		this.setIncludeNote(this.includeNote);
		this.syncComposer();
		this.renderMessages();
	}

	async onClose(): Promise<void> {
		this.pendingEdit?.resolve(false);
		this.pendingEdit = null;
		this.contentEl.empty();
	}

	private syncVaultButton(): void {
		const on = this.plugin.settings.vaultAccess;
		this.vaultBtn?.toggleClass("is-active", on);
		this.vaultBtn?.setAttr("aria-label", on ? "AI can search and read your notes (click to turn off)" : "AI can only see the open note (click to let it search your notes)");
	}

	private async toggleVaultAccess(): Promise<void> {
		this.plugin.settings.vaultAccess = !this.plugin.settings.vaultAccess;
		await this.plugin.saveSettings();
		this.syncVaultButton();
		new Notice(this.plugin.settings.vaultAccess ? "AI can now search and read your notes" : "AI can now only see the open note");
	}

	getState(): Record<string, unknown> {
		const state: ChatViewState = {
			chatId: this.chatId,
			chatCreated: this.chatCreated,
			messages: this.messages,
			provider: this.provider,
			model: this.model,
			includeNote: this.includeNote,
		};
		return state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const st = (state ?? {}) as ChatViewState;
		if (st.chatId) {
			this.chatId = st.chatId;
			this.chatCreated = st.chatCreated ?? null;
		}
		if (Array.isArray(st.messages)) this.messages = st.messages;
		if (st.provider && PROVIDER_LABELS[st.provider]) {
			this.provider = st.provider;
			this.model = st.model || modelFor(this.plugin.settings, this.provider);
		}
		if (typeof st.includeNote === "boolean") this.setIncludeNote(st.includeNote);
		if (this.modelBtn) {
			this.updateModelLabel();
			this.renderMessages();
		}
		await super.setState(state, result);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "clickable-icon hlc-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
		return b;
	}

	private updateModelLabel(): void {
		if (!this.modelBtn) return;
		this.modelBtn.empty();
		setIcon(this.modelBtn.createSpan("hlc-model-icon"), "sparkles");
		this.modelBtn.createSpan({ cls: "hlc-model-name", text: prettyModel(this.model) });
		const effort = this.plugin.settings.effort;
		if (effort !== "default") this.modelBtn.createSpan({ cls: "hlc-model-effort", text: EFFORT_LABELS[effort] });
		setIcon(this.modelBtn.createSpan("hlc-model-chevron"), "chevron-down");
		this.modelBtn.setAttr("aria-label", `${PROVIDER_LABELS[this.provider]} · ${this.model}`);
	}

	private hasKey(p: ProviderId): boolean {
		const s = this.plugin.settings;
		if (p === "custom") return !!s.customBaseUrl;
		return !!{ anthropic: s.anthropicKey, openai: s.openaiKey, openrouter: s.openrouterKey }[p];
	}

	private modelMenu(e: MouseEvent): void {
		const s = this.plugin.settings;
		const menu = new Menu();
		const all = Object.keys(PROVIDER_LABELS) as ProviderId[];
		let providers = all.filter((p) => this.hasKey(p) || p === this.provider);
		if (providers.length <= 1) providers = all;
		providers.forEach((p, i) => {
			if (i > 0) menu.addSeparator();
			menu.addItem((it) => it.setTitle(PROVIDER_LABELS[p]).setDisabled(true));
			const models = [...new Set([modelFor(s, p), ...MODEL_SUGGESTIONS[p]].filter(Boolean))];
			for (const m of models) {
				menu.addItem((it) =>
					it
						.setTitle(prettyModel(m))
						.setChecked(p === this.provider && m === this.model)
						.onClick(() => {
							this.provider = p;
							this.model = m;
							this.updateModelLabel();
							this.app.workspace.requestSaveLayout();
						})
				);
			}
		});
		menu.addSeparator();
		menu.addItem((it) => it.setTitle("Effort").setDisabled(true));
		for (const e of Object.keys(EFFORT_LABELS) as Effort[]) {
			menu.addItem((it) =>
				it
					.setTitle(EFFORT_LABELS[e])
					.setChecked(s.effort === e)
					.onClick(async () => {
						s.effort = e;
						await this.plugin.saveSettings();
						this.updateModelLabel();
					})
			);
		}
		menu.addSeparator();
		menu.addItem((it) =>
			it
				.setTitle("Models and API keys…")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings())
		);
		menu.showAtMouseEvent(e);
	}

	private moreMenu(e: MouseEvent): void {
		const inMain = this.leaf.getRoot() === this.app.workspace.rootSplit;
		const menu = new Menu();
		menu.addItem((it) =>
			it
				.setTitle("Save chat as note")
				.setIcon("save")
				.onClick(() => void this.saveChat())
		);
		menu.addItem((it) =>
			it
				.setTitle(inMain ? "Move to sidebar" : "Open in tab")
				.setIcon(inMain ? "panel-right" : "app-window")
				.onClick(() => void this.plugin.moveChat(this.leaf))
		);
		menu.addItem((it) =>
			it
				.setTitle("Open memory note")
				.setIcon("brain")
				.onClick(() => void this.plugin.openMemory())
		);
		menu.addSeparator();
		menu.addItem((it) =>
			it
				.setTitle("Settings")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings())
		);
		menu.showAtMouseEvent(e);
	}

	newChat(focus = true): void {
		if (this.busy) return;
		this.chatId = null;
		this.chatCreated = null;
		this.messages = [];
		this.renderMessages();
		if (this.historyOpen) this.toggleHistory(false);
		this.app.workspace.requestSaveLayout();
		if (focus) this.inputEl.focus();
	}

	/** Save this conversation to the history list (called after every reply). */
	private persist(): void {
		if (!this.messages.length) return;
		if (!this.chatId) {
			this.chatId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
			this.chatCreated = Date.now();
		}
		this.plugin.upsertChat({
			id: this.chatId,
			created: this.chatCreated ?? Date.now(),
			updated: Date.now(),
			provider: this.provider,
			model: this.model,
			messages: this.messages,
		});
	}

	private loadChat(chat: StoredChat): void {
		if (this.busy) return;
		this.chatId = chat.id;
		this.chatCreated = chat.created;
		this.messages = chat.messages.map((m) => ({ ...m }));
		if (PROVIDER_LABELS[chat.provider]) {
			this.provider = chat.provider;
			this.model = chat.model || modelFor(this.plugin.settings, this.provider);
		}
		this.updateModelLabel();
		this.renderMessages();
		this.toggleHistory(false);
		this.app.workspace.requestSaveLayout();
	}

	private toggleHistory(open = !this.historyOpen): void {
		this.historyOpen = open;
		this.historyEl.toggleClass("is-open", open);
		this.historyBtn.toggleClass("is-active", open);
		if (open) {
			this.historySearch.value = "";
			this.renderHistory();
			if (!Platform.isMobile) this.historySearch.focus();
		}
	}

	private renderHistory(): void {
		const list = this.historyList;
		list.empty();
		const q = this.historySearch.value.trim().toLowerCase();
		const chats = this.plugin.chats.filter(
			(c) => !q || chatTitle(c).toLowerCase().includes(q) || c.messages.some((m) => (m.display ?? m.content).toLowerCase().includes(q))
		);
		if (!chats.length) {
			list.createDiv({ cls: "hlc-history-empty", text: q ? "No chats match." : "Your conversations will appear here." });
			return;
		}
		const today = moment().startOf("day");
		const groupOf = (t: number) => {
			const d = moment(t);
			if (d.isSameOrAfter(today)) return "Today";
			if (d.isSameOrAfter(today.clone().subtract(1, "day"))) return "Yesterday";
			if (d.isSameOrAfter(today.clone().subtract(7, "day"))) return "Previous 7 days";
			if (d.isSameOrAfter(today.clone().subtract(30, "day"))) return "Previous 30 days";
			return d.format("MMMM YYYY");
		};
		let group = "";
		for (const c of chats) {
			const g = groupOf(c.updated);
			if (g !== group) {
				group = g;
				list.createDiv({ cls: "hlc-history-group", text: g });
			}
			const row = list.createDiv("hlc-history-item" + (c.id === this.chatId ? " is-current" : ""));
			const text = row.createDiv("hlc-history-text");
			text.createDiv({ cls: "hlc-history-title", text: chatTitle(c) });
			text.createDiv({ cls: "hlc-history-meta", text: `${prettyModel(c.model)} · ${moment(c.updated).fromNow()}` });
			row.onclick = () => this.loadChat(c);
			const del = row.createEl("button", { cls: "clickable-icon hlc-icon hlc-history-del", attr: { "aria-label": "Delete chat" } });
			setIcon(del, "trash-2");
			del.onclick = (e) => {
				e.stopPropagation();
				this.plugin.deleteChat(c.id);
				if (c.id === this.chatId) this.newChat(false);
				this.renderHistory();
			};
		}
	}

	setIncludeNote(on: boolean): void {
		this.includeNote = on;
		this.ctxBtn?.toggleClass("is-active", on);
		this.renderChips();
	}

	private renderChips(): void {
		if (!this.chipsEl) return;
		this.chipsEl.empty();
		const file = this.plugin.lastMarkdownFile();
		if (!this.includeNote || !file) return;
		const chip = this.chipsEl.createDiv("hlc-chip");
		setIcon(chip.createSpan("hlc-chip-icon"), "file-text");
		chip.createSpan({ cls: "hlc-chip-name", text: file.basename });
		const x = chip.createSpan({ cls: "hlc-chip-x", attr: { "aria-label": "Remove" } });
		setIcon(x, "x");
		x.onclick = () => this.setIncludeNote(false);
	}

	/** Grow the text box with its content, up to a limit. */
	private syncComposer(): void {
		const el = this.inputEl;
		el.setCssStyles({ height: "auto" });
		el.setCssStyles({ height: `${Math.min(el.scrollHeight, 200)}px` });
		el.toggleClass("is-scrolling", el.scrollHeight > 200);
		this.sendBtn.disabled = this.busy || !el.value.trim();
	}

	/** Called by other parts of the plugin, such as the "Ask about current note" command. */
	async ask(prompt: string): Promise<void> {
		this.inputEl.value = prompt;
		await this.send();
	}

	private async buildSystem(): Promise<string> {
		let system = this.plugin.settings.systemPrompt;
		if (this.includeNote) {
			const file = this.plugin.lastMarkdownFile();
			if (file) {
				const text = await this.app.vault.cachedRead(file);
				system += `\n\nThe user is currently looking at the note "${file.path}":\n<note>\n${text}\n</note>`;
			}
		}
		return system;
	}

	async send(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || this.busy) return;
		this.inputEl.value = "";
		this.messages.push({ role: "user", content: text });
		await this.request();
	}

	private async regenerate(): Promise<void> {
		if (this.busy || this.messages.length === 0) return;
		if (this.messages[this.messages.length - 1].role === "assistant") this.messages.pop();
		await this.request();
	}

	private async request(): Promise<void> {
		this.busy = true;
		this.syncComposer();
		this.renderMessages(true);
		this.liveActivity = [];
		try {
			const history = this.messages.map((m) => ({ role: m.role, content: m.content }));
			const reply = await runAgent(
				this.app,
				this.plugin.settings,
				this.provider,
				this.model,
				history,
				await this.buildSystem(),
				{
					vaultAccess: this.plugin.settings.vaultAccess,
					currentFile: this.plugin.lastMarkdownFile(),
					memory: this.plugin.settings.memoryEnabled ? { path: memoryPath(this.plugin.settings.memoryNote), askFirst: this.plugin.settings.memoryAskFirst } : null,
				},
				{
					onActivity: (a) => {
						this.liveActivity.push(a);
						this.renderMessages(true);
					},
					approveEdit: (req) =>
						new Promise<boolean>((resolve) => {
							this.pendingEdit = { req, resolve };
							this.renderMessages(true);
						}),
				}
			);
			this.messages.push({ role: "assistant", content: reply || "Done.", model: this.model, activity: [...this.liveActivity] });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.messages.push({ role: "assistant", content: msg, model: this.model, error: true, activity: [...this.liveActivity] });
		} finally {
			this.liveActivity = [];
			this.pendingEdit = null;
			this.busy = false;
			this.syncComposer();
			this.renderMessages();
			this.persist();
			this.app.workspace.requestSaveLayout();
		}
	}

	private renderEmpty(): void {
		const empty = this.listEl.createDiv("hlc-empty");
		setIcon(empty.createDiv("hlc-empty-icon"), "sparkles");
		empty.createDiv({ cls: "hlc-empty-title", text: "How can I help?" });
		empty.createDiv({ cls: "hlc-empty-sub", text: prettyModel(this.model) });
		const grid = empty.createDiv("hlc-suggestions");
		for (const sug of SUGGESTIONS) {
			const b = grid.createEl("button", { cls: "hlc-suggestion" });
			setIcon(b.createSpan("hlc-suggestion-icon"), sug.icon);
			b.createSpan({ text: sug.text });
			b.onclick = () => {
				if (sug.note) this.setIncludeNote(true);
				this.inputEl.value = sug.text;
				void this.send();
			};
		}
	}

	private renderMessages(thinking = false): void {
		this.listEl.empty();
		if (this.messages.length === 0 && !thinking) {
			this.renderEmpty();
			return;
		}
		const lastAssistant = this.messages.map((m) => m.role).lastIndexOf("assistant");
		this.messages.forEach((m, i) => {
			if (m.role === "user") {
				const wrap = this.listEl.createDiv("hlc-msg hlc-user");
				wrap.createDiv({ cls: "hlc-bubble", text: m.display ?? m.content });
				return;
			}
			const wrap = this.listEl.createDiv("hlc-msg hlc-assistant");
			const who = wrap.createDiv("hlc-who");
			setIcon(who.createSpan("hlc-who-icon"), "sparkles");
			who.createSpan({ text: prettyModel(m.model ?? this.model) });
			this.renderActivity(wrap, m.activity);
			const body = wrap.createDiv("hlc-body markdown-rendered");
			if (m.error) {
				body.addClass("hlc-error");
				setIcon(body.createSpan("hlc-error-icon"), "alert-triangle");
				body.createSpan({ text: m.content });
			} else {
				void MarkdownRenderer.render(this.app, m.content, body, "", this);
			}
			const tools = wrap.createDiv("hlc-tools");
			if (!m.error) {
				this.iconButton(tools, "copy", "Copy", () => {
					void navigator.clipboard.writeText(m.content);
					new Notice("Copied");
				});
				this.iconButton(tools, "text-cursor-input", "Insert into note", () => this.insertIntoNote(m.content));
			}
			if (i === lastAssistant) this.iconButton(tools, "refresh-cw", m.error ? "Try again" : "Regenerate", () => void this.regenerate());
		});
		if (thinking) {
			const wrap = this.listEl.createDiv("hlc-msg hlc-assistant");
			const who = wrap.createDiv("hlc-who");
			setIcon(who.createSpan("hlc-who-icon"), "sparkles");
			who.createSpan({ text: prettyModel(this.model) });
			this.renderActivity(wrap, this.liveActivity);
			if (this.pendingEdit) this.renderApproval(wrap, this.pendingEdit);
			else {
				const dots = wrap.createDiv("hlc-typing");
				for (let i = 0; i < 3; i++) dots.createSpan();
			}
		}
		this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	private renderActivity(parent: HTMLElement, activity: Activity[] | undefined): void {
		if (!activity?.length) return;
		const row = parent.createDiv("hlc-activity");
		for (const a of activity) {
			const chip = row.createDiv("hlc-activity-chip");
			setIcon(chip.createSpan("hlc-activity-icon"), a.icon);
			chip.createSpan({ text: a.text });
		}
	}

	/** The change the AI wants to make, with Approve and Reject. Nothing is saved until Approve. */
	private renderApproval(parent: HTMLElement, pending: { req: EditRequest; resolve: (ok: boolean) => void }): void {
		const { req } = pending;
		const card = parent.createDiv("hlc-approve");
		const head = card.createDiv("hlc-approve-head");
		setIcon(head.createSpan("hlc-approve-icon"), req.isNew ? "file-plus" : "pencil");
		const title = head.createDiv("hlc-approve-title");
		title.createDiv({ text: req.isNew ? "Create a new note" : "Edit a note" });
		title.createDiv({ cls: "hlc-approve-path", text: req.path });
		if (req.summary) card.createDiv({ cls: "hlc-approve-summary", text: req.summary });

		const diff = card.createDiv("hlc-diff");
		const lines = lineDiff(req.before, req.after);
		const shown = lines.slice(0, 80);
		for (const l of shown) {
			const row = diff.createDiv(`hlc-diff-line is-${l.type}`);
			row.createSpan({ cls: "hlc-diff-sign", text: l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "gap" ? "⋯" : " " });
			row.createSpan({ cls: "hlc-diff-text", text: l.text || " " });
		}
		if (lines.length > shown.length) diff.createDiv({ cls: "hlc-diff-line is-gap", text: `⋯ ${lines.length - shown.length} more lines` });

		const actions = card.createDiv("hlc-approve-actions");
		const decide = (ok: boolean) => {
			if (this.pendingEdit !== pending) return;
			this.pendingEdit = null;
			pending.resolve(ok);
			this.renderMessages(true);
		};
		const yes = actions.createEl("button", { cls: "mod-cta", text: req.isNew ? "Create note" : "Approve" });
		yes.onclick = () => decide(true);
		const no = actions.createEl("button", { text: "Reject" });
		no.onclick = () => decide(false);
	}

	private insertIntoNote(text: string): void {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			const target = this.plugin.lastMarkdownFile();
			const views = this.app.workspace
				.getLeavesOfType("markdown")
				.map((l) => l.view)
				.filter((v): v is MarkdownView => v instanceof MarkdownView);
			view = views.find((v) => v.file === target) ?? views[0] ?? null;
		}
		if (!view) {
			new Notice("Open a note first");
			return;
		}
		view.editor.replaceSelection(text);
		new Notice("Inserted into " + (view.file?.basename ?? "note"));
	}

	private async saveChat(): Promise<void> {
		if (this.messages.length === 0) {
			new Notice("Nothing to save");
			return;
		}
		const folder = normalizePath(this.plugin.settings.chatSaveFolder || "AI Chats");
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const stamp = moment().format("YYYY-MM-DD HHmmss");
		const path = normalizePath(`${folder}/Chat ${stamp}.md`);
		const body = this.messages
			.map((m) => (m.role === "user" ? `## You\n\n${m.display ?? m.content}` : `## ${prettyModel(m.model ?? this.model)}\n\n${m.content}`))
			.join("\n\n");
		const file = await this.app.vault.create(path, body + "\n");
		new Notice("Saved " + file.path);
	}
}
