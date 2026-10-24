import { App, TFile, normalizePath } from "obsidian";
import { readMemory, saveMemory, withFact, withoutFact } from "./memory";
import { ChatMessage, anthropicCall, openaiCall, sendChat } from "./providers";
import type { HomeLLMSettings, ProviderId } from "./settings";

/** A step the AI took, shown as a small label above its reply. */
export interface Activity {
	icon: string;
	text: string;
}

/** A change the AI wants to make; nothing is written until the user approves. */
export interface EditRequest {
	path: string;
	before: string;
	after: string;
	isNew: boolean;
	summary: string;
}

export interface AgentHooks {
	/** Called as the AI works, for live progress. */
	onActivity: (a: Activity) => void;
	/** Shows the change to the user and resolves true if they approve it. */
	approveEdit: (req: EditRequest) => Promise<boolean>;
}

export interface AgentOptions {
	/** Whether the AI may search and read any note (otherwise only the open note). */
	vaultAccess: boolean;
	currentFile: TFile | null;
	/** Long-term memory note, or null when memory is off. */
	memory: { path: string; askFirst: boolean } | null;
}

/** Most tool rounds in one reply, so a confused model can't loop forever. */
const MAX_ROUNDS = 10;
/** Longest note text handed to the model in one read. */
const READ_LIMIT = 30_000;

interface ToolDef {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	vaultOnly?: boolean;
	memoryOnly?: boolean;
}

const TOOLS: ToolDef[] = [
	{
		name: "read_current_note",
		description: "Read the note the user currently has open. Use this when they ask about \"this note\".",
		schema: { type: "object", properties: {} },
	},
	{
		name: "search_notes",
		description: "Full-text search across all the user's notes. Returns matching note paths with a short snippet.",
		schema: { type: "object", properties: { query: { type: "string", description: "Words to search for" }, limit: { type: "integer", description: "Max results, default 8" } }, required: ["query"] },
		vaultOnly: true,
	},
	{
		name: "list_notes",
		description: "List note paths, most recently edited first, optionally only inside one folder.",
		schema: { type: "object", properties: { folder: { type: "string", description: "Folder path, for example \"School\"" } } },
		vaultOnly: true,
	},
	{
		name: "read_note",
		description: "Read a note by its path or name.",
		schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		vaultOnly: true,
	},
	{
		name: "edit_note",
		description:
			"Change an existing note or create a new one. The user is shown the change and must approve it before anything is saved. Prefer small find/replace edits; use content only to create a note or rewrite all of it.",
		schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path, for example \"School/Maths.md\"" },
				summary: { type: "string", description: "One short sentence describing the change, shown to the user" },
				edits: {
					type: "array",
					description: "Find/replace edits. Each find must match the note's current text exactly, once.",
					items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
				},
				content: { type: "string", description: "The whole new text of the note" },
			},
			required: ["path", "summary"],
		},
	},
	{
		name: "remember",
		description:
			"Save a short lasting fact about the user to their memory note, so you know it in future chats (for example their school, goals, people in their life, or how they like answers). Use it when they share something lasting or ask you to remember something. Don't save passwords, private numbers or one-off details.",
		schema: { type: "object", properties: { fact: { type: "string", description: "One short sentence, for example \"Studies at BPCS and likes maths\"" } }, required: ["fact"] },
		memoryOnly: true,
	},
	{
		name: "forget",
		description: "Remove facts from the user's memory note that contain the given text. Use when they ask you to forget something or a fact is out of date.",
		schema: { type: "object", properties: { text: { type: "string", description: "Words that appear in the fact to remove" } }, required: ["text"] },
		memoryOnly: true,
	},
];

function systemAddendum(opts: AgentOptions, memory: string): string {
	let mem = "";
	if (opts.memory) {
		mem = memory
			? `\n\nWhat you remember about the user from earlier chats (their memory note "${opts.memory.path}", which they can read and edit):\n<memory>\n${memory}\n</memory>\nUse this naturally; don't recite it.`
			: `\n\nYou have a long-term memory note ("${opts.memory.path}") but it's empty so far.`;
		mem += " When the user tells you something lasting about themselves or asks you to remember something, call remember. When they ask you to forget something, call forget.";
	}
	const open = opts.currentFile ? `The note open right now is "${opts.currentFile.path}".` : "No note is open right now.";
	const vault = opts.vaultAccess
		? "You can search, list and read any of the user's notes with tools; look things up rather than guessing, and mention notes as [[wikilinks]]."
		: "You can only read the note that is open; you can't search the rest of the vault.";
	return `\n\nYou are working inside the user's Obsidian vault. ${open} ${vault} To change or create a note, call edit_note: the user sees the change and approves or rejects it, so describe it clearly in "summary", and prefer small find/replace edits. If an edit is rejected, don't try again unless the user asks.${mem}`;
}

/** Runs and describes tool calls against the vault. */
class VaultTools {
	constructor(
		private app: App,
		private opts: AgentOptions,
		private hooks: AgentHooks
	) {}

	defs(): ToolDef[] {
		return TOOLS.filter((t) => (this.opts.vaultAccess || !t.vaultOnly) && (this.opts.memory || !t.memoryOnly));
	}

	private resolve(path: string): TFile | null {
		const { vault, metadataCache } = this.app;
		const clean = normalizePath(path.replace(/^\[\[|\]\]$/g, ""));
		const direct = vault.getAbstractFileByPath(clean) ?? vault.getAbstractFileByPath(`${clean}.md`);
		if (direct instanceof TFile) return direct;
		return metadataCache.getFirstLinkpathDest(clean.replace(/\.md$/, ""), "");
	}

	/** Paths the AI may write: Markdown notes, not inside the config folder, no "..". */
	private writablePath(path: string): string | null {
		let p = normalizePath(path.trim().replace(/^\/+/, ""));
		if (!p || p.split("/").includes("..") || p.startsWith(this.app.vault.configDir + "/") || p.startsWith(".")) return null;
		if (!/\.md$/i.test(p)) p += ".md";
		return p;
	}

	async run(name: string, input: Record<string, unknown>): Promise<string> {
		const str = (k: string) => (typeof input[k] === "string" ? (input[k]) : "");
		const { vault } = this.app;
		switch (name) {
			case "read_current_note": {
				const f = this.opts.currentFile;
				if (!f) return "No note is open.";
				this.hooks.onActivity({ icon: "file-text", text: `Read ${f.basename}` });
				return this.readOut(f);
			}
			case "read_note": {
				const f = this.resolve(str("path"));
				if (!f) return `No note found at "${str("path")}". Try search_notes.`;
				this.hooks.onActivity({ icon: "file-text", text: `Read ${f.basename}` });
				return this.readOut(f);
			}
			case "list_notes": {
				const folder = normalizePath(str("folder") || "/");
				const files = vault
					.getMarkdownFiles()
					.filter((f) => folder === "/" || f.path.startsWith(folder + "/"))
					.sort((a, b) => b.stat.mtime - a.stat.mtime);
				this.hooks.onActivity({ icon: "list", text: str("folder") ? `Listed notes in ${str("folder")}` : "Listed your notes" });
				const shown = files.slice(0, 300).map((f) => `${f.path} (edited ${new Date(f.stat.mtime).toISOString().slice(0, 10)})`);
				return `${files.length} notes${files.length > 300 ? " (showing the 300 most recent)" : ""}:\n${shown.join("\n")}`;
			}
			case "search_notes": {
				const query = str("query");
				const limit = Math.min(20, Math.max(1, typeof input.limit === "number" ? input.limit : 8));
				this.hooks.onActivity({ icon: "search", text: `Searched for “${query}”` });
				return this.search(query, limit);
			}
			case "edit_note":
				return this.edit(input);
			case "remember":
				return this.remember(str("fact"));
			case "forget":
				return this.forget(str("text"));
			default:
				return `Unknown tool ${name}.`;
		}
	}

	private async remember(fact: string): Promise<string> {
		const mem = this.opts.memory;
		if (!mem) return "Memory is turned off.";
		if (!fact.trim()) return "Give the fact to remember.";
		const { before, after, exists } = await withFact(this.app, mem.path, fact);
		if (mem.askFirst && !(await this.hooks.approveEdit({ path: mem.path, before, after, isNew: !exists, summary: `Remember: ${fact}` }))) {
			this.hooks.onActivity({ icon: "x-circle", text: "Didn't remember that" });
			return "The user chose not to save this to memory.";
		}
		try {
			await saveMemory(this.app, mem.path, before, after);
		} catch (e) {
			return `Couldn't save to memory: ${e instanceof Error ? e.message : String(e)}`;
		}
		this.hooks.onActivity({ icon: "brain", text: `Remembered: ${fact.length > 60 ? fact.slice(0, 59) + "\u2026" : fact}` });
		return "Saved to memory.";
	}

	private async forget(text: string): Promise<string> {
		const mem = this.opts.memory;
		if (!mem) return "Memory is turned off.";
		const { before, after, removed } = await withoutFact(this.app, mem.path, text);
		if (!removed.length) return `Nothing in memory mentions "${text}".`;
		if (mem.askFirst && !(await this.hooks.approveEdit({ path: mem.path, before, after, isNew: false, summary: `Forget ${removed.length} ${removed.length === 1 ? "fact" : "facts"}` }))) {
			return "The user chose to keep these memories.";
		}
		try {
			await saveMemory(this.app, mem.path, before, after);
		} catch (e) {
			return `Couldn't update memory: ${e instanceof Error ? e.message : String(e)}`;
		}
		this.hooks.onActivity({ icon: "eraser", text: `Forgot ${removed.length} ${removed.length === 1 ? "thing" : "things"}` });
		return `Removed from memory: ${removed.join("; ")}`;
	}

	private async readOut(f: TFile): Promise<string> {
		const text = await this.app.vault.cachedRead(f);
		const cut = text.length > READ_LIMIT;
		return `Path: ${f.path}\n${cut ? `(Only the first ${READ_LIMIT} characters.)\n` : ""}---\n${cut ? text.slice(0, READ_LIMIT) : text}`;
	}

	private async search(query: string, limit: number): Promise<string> {
		const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
		if (!terms.length) return "Give some words to search for.";
		const hits: { f: TFile; score: number; snippet: string }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const text = await this.app.vault.cachedRead(f);
			const lower = text.toLowerCase();
			const name = f.basename.toLowerCase();
			let score = 0;
			let first = -1;
			for (const t of terms) {
				if (name.includes(t)) score += 5;
				let i = lower.indexOf(t);
				if (i >= 0 && (first < 0 || i < first)) first = i;
				while (i >= 0 && score < 200) {
					score++;
					i = lower.indexOf(t, i + t.length);
				}
			}
			if (!score) continue;
			const start = Math.max(0, first - 60);
			const snippet = first >= 0 ? text.slice(start, start + 180).replace(/\s+/g, " ").trim() : "";
			hits.push({ f, score, snippet });
		}
		hits.sort((a, b) => b.score - a.score);
		if (!hits.length) return `No notes mention "${query}".`;
		return hits
			.slice(0, limit)
			.map((h) => `${h.f.path}${h.snippet ? ` — …${h.snippet}…` : ""}`)
			.join("\n");
	}

	private async edit(input: Record<string, unknown>): Promise<string> {
		const rawPath = typeof input.path === "string" ? input.path : "";
		const summary = typeof input.summary === "string" ? input.summary : "Edit note";
		const existing = this.resolve(rawPath);
		const path = existing?.path ?? this.writablePath(rawPath);
		if (!path) return `Can't write to "${rawPath}". Use a normal note path.`;
		if (existing && existing.extension !== "md") return "Only Markdown notes can be edited.";
		const before = existing ? await this.app.vault.read(existing) : "";
		let after: string;
		if (typeof input.content === "string") {
			after = input.content;
		} else if (Array.isArray(input.edits) && existing) {
			after = before;
			for (const e of input.edits as { find?: unknown; replace?: unknown }[]) {
				if (typeof e.find !== "string" || typeof e.replace !== "string") return "Each edit needs find and replace text.";
				const at = after.indexOf(e.find);
				if (at < 0) return `This text wasn't found in the note, so nothing changed: "${e.find.slice(0, 120)}". Read the note again and copy the text exactly.`;
				if (after.indexOf(e.find, at + 1) >= 0) return `This text appears more than once, so nothing changed: "${e.find.slice(0, 120)}". Include more of the surrounding text.`;
				after = after.slice(0, at) + e.replace + after.slice(at + e.find.length);
			}
		} else {
			return existing ? "Give either edits or content." : `There's no note at "${rawPath}". To create it, give its content.`;
		}
		if (after === before) return "That wouldn't change anything.";

		const name = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
		const ok = await this.hooks.approveEdit({ path, before, after, isNew: !existing, summary });
		if (!ok) {
			this.hooks.onActivity({ icon: "x-circle", text: `${existing ? "Edit to" : "New note"} ${name} declined` });
			return "The user declined this change, so nothing was saved. Don't try again unless they ask.";
		}
		try {
			if (existing) {
				await this.app.vault.process(existing, (data) => {
					if (data !== before) throw new Error("The note changed while you were waiting.");
					return after;
				});
			} else {
				const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
				await this.app.vault.create(path, after);
			}
		} catch (e) {
			return `Couldn't save: ${e instanceof Error ? e.message : String(e)}`;
		}
		this.hooks.onActivity({ icon: existing ? "pencil" : "file-plus", text: `${existing ? "Edited" : "Created"} ${name}` });
		return "The user approved the change and it's saved.";
	}
}

function parseArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw !== "string" || !raw.trim()) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function anthropicLoop(s: HomeLLMSettings, model: string, history: ChatMessage[], system: string, tools: VaultTools): Promise<string> {
	const messages: { role: "user" | "assistant"; content: unknown }[] = history.map((m) => ({ role: m.role, content: m.content }));
	const toolSpec = tools.defs().map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const reply = await anthropicCall(s, model, { system, messages, tools: toolSpec });
		const blocks = reply.content;
		const calls = blocks.filter((b) => b.type === "tool_use");
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
		if (!calls.length) return text;
		// Pass the whole reply back unchanged (thinking blocks included); the history only ever grows.
		messages.push({ role: "assistant", content: blocks });
		const results = [];
		for (const c of calls) results.push({ type: "tool_result", tool_use_id: c.id, content: await tools.run(c.name ?? "", parseArgs(c.input)) });
		messages.push({ role: "user", content: results });
	}
	return "I stopped after too many steps. Try asking in a more specific way.";
}

async function openaiLoop(s: HomeLLMSettings, provider: ProviderId, model: string, history: ChatMessage[], system: string, tools: VaultTools | null): Promise<string> {
	const messages: Record<string, unknown>[] = [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))];
	const toolSpec = tools?.defs().map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const msg = await openaiCall(s, provider, model, { messages, tools: toolSpec });
		const calls = msg.tool_calls ?? [];
		if (!calls.length || !tools) return msg.content ?? "";
		messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
		for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: await tools.run(c.function.name, parseArgs(c.function.arguments)) });
	}
	return "I stopped after too many steps. Try asking in a more specific way.";
}

/**
 * Sends the conversation with note tools attached and runs any tool calls until the model gives a final answer.
 * Local servers that don't support tools fall back to a plain reply.
 */
export async function runAgent(
	app: App,
	s: HomeLLMSettings,
	provider: ProviderId,
	model: string,
	history: ChatMessage[],
	system: string,
	opts: AgentOptions,
	hooks: AgentHooks
): Promise<string> {
	const tools = new VaultTools(app, opts, hooks);
	const memory = opts.memory ? await readMemory(app, opts.memory.path) : "";
	const fullSystem = system + systemAddendum(opts, memory);
	if (provider === "anthropic") return anthropicLoop(s, model, history, fullSystem, tools);
	if (provider === "local") {
		// On-device models are too small to use note tools reliably, so they answer from the chat (and memory) alone.
		hooks.onActivity({ icon: "cpu", text: "Answered on this device" });
		return sendChat(s, provider, model, history, opts.memory && memory ? `${system}\n\nWhat you know about the user:\n${memory}` : system, (text) => hooks.onActivity({ icon: "download", text }));
	}
	try {
		return await openaiLoop(s, provider, model, history, fullSystem, tools);
	} catch (e) {
		// Many local models reject the "tools" field; answer without them rather than failing.
		if (provider === "custom" && /tool/i.test(e instanceof Error ? e.message : "")) {
			hooks.onActivity({ icon: "info", text: "This model can't use note tools" });
			return openaiLoop(s, provider, model, history, opts.memory && memory ? `${system}\n\nWhat you know about the user:\n${memory}` : system, null);
		}
		throw e;
	}
}
