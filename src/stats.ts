import { App, TAbstractFile, TFile, debounce } from "obsidian";
import { moment } from "./time";

interface Count {
	words: number;
	chars: number;
}

export interface WordBaseline {
	date: string;
	total: number;
	/** Counting rules the total was made with. */
	v?: number;
}

export interface StatsSummary {
	notes: number;
	words: number;
	chars: number;
	/** Net words since the first count today (can be negative after deleting text). */
	wordsToday: number;
	avgWords: number;
	readingMinutes: number;
	links: number;
	orphans: number;
	tasksDone: number;
	tasksOpen: number;
	newThisWeek: number;
	newThisMonth: number;
	attachments: number;
	longest: { file: TFile; words: number } | null;
	mostLinked: { file: TFile; links: number } | null;
}

/** Bump when counting rules change, so a day-start total from the old rules isn't compared with new counts. */
const COUNT_VERSION = 2;

/** Average adult silent reading speed, in words per minute. */
const READING_WPM = 238;

/**
 * Fenced blocks that hold data for other plugins rather than writing, so their contents aren't counted:
 * Sheet Plus spreadsheets, Excalidraw drawings, Dataview queries and our own widgets.
 */
const DATA_BLOCKS = new Set(["sheet", "multisheet", "json", "compressed-json", "excalidraw", "dataview", "dataviewjs", "home-widget"]);

interface SheetData {
	sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
}

/** The text typed into a Sheet Plus spreadsheet's cells (its `sheet` block is JSON). */
function sheetCellText(json: string): string {
	try {
		const data = JSON.parse(json) as SheetData;
		const parts: string[] = [];
		for (const sheet of Object.values(data.sheets ?? {})) {
			for (const row of Object.values(sheet.cellData ?? {})) {
				for (const cell of Object.values(row)) {
					if (typeof cell.v === "string" || typeof cell.v === "number") parts.push(String(cell.v));
				}
			}
		}
		return parts.join("\n");
	} catch {
		return "";
	}
}

/** The prose in a note: no frontmatter, no %%comments%%, and no plugin data blocks (spreadsheets count their cells). */
export function proseOf(text: string): string {
	return text
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(/^(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_block: string, _fence: string, lang: string, body: string) => {
			const l = lang.toLowerCase();
			if (l === "sheet") return sheetCellText(body);
			// Ordinary code blocks count their contents, but not the fences or language label.
			return DATA_BLOCKS.has(l) ? "" : body;
		});
}

/** Word and character count for a note's prose. */
export function countText(text: string): Count {
	const body = proseOf(text);
	const words = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
	const chars = body.replace(/\s/g, "").length;
	return { words, chars };
}

/**
 * Word counts for every note, built once in the background and then kept up to date as notes change.
 * Everything else (links, tasks, dates) comes straight from Obsidian's metadata cache when asked.
 */
export class VaultStats {
	private counts = new Map<string, Count>();
	private building: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	ready = false;
	private notifySoon = debounce(() => this.listeners.forEach((fn) => fn()), 1000, true);

	constructor(
		private app: App,
		/** Day-start word total, so "today" can be worked out; persisted by the plugin. */
		private baseline: { get: () => WordBaseline | null; set: (b: WordBaseline) => void }
	) {}

	/** Counts every note once. Safe to call repeatedly. */
	build(): Promise<void> {
		if (!this.building) {
			this.building = (async () => {
				for (const f of this.app.vault.getMarkdownFiles()) this.counts.set(f.path, countText(await this.app.vault.cachedRead(f)));
				this.ready = true;
				this.notifySoon();
			})();
		}
		return this.building;
	}

	async onModify(file: TAbstractFile): Promise<void> {
		if (!this.ready || !(file instanceof TFile) || file.extension !== "md") return;
		this.counts.set(file.path, countText(await this.app.vault.cachedRead(file)));
		this.notifySoon();
	}

	onDelete(file: TAbstractFile): void {
		if (this.counts.delete(file.path)) this.notifySoon();
	}

	onRename(file: TAbstractFile, oldPath: string): void {
		const c = this.counts.get(oldPath);
		if (!c) return;
		this.counts.delete(oldPath);
		this.counts.set(file.path, c);
		this.notifySoon();
	}

	/** Calls `fn` (at most once a second) whenever the numbers change. Returns an unsubscribe function. */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	summary(): StatsSummary {
		const { vault, metadataCache } = this.app;
		const notes = vault.getMarkdownFiles();
		let words = 0;
		let chars = 0;
		let longest: StatsSummary["longest"] = null;
		for (const f of notes) {
			const c = this.counts.get(f.path);
			if (!c) continue;
			words += c.words;
			chars += c.chars;
			if (!longest || c.words > longest.words) longest = { file: f, words: c.words };
		}

		const today = moment().format("YYYY-MM-DD");
		let base = this.baseline.get();
		if (this.ready && (!base || base.date !== today || base.v !== COUNT_VERSION)) {
			base = { date: today, total: words, v: COUNT_VERSION };
			this.baseline.set(base);
		}

		// Links: resolvedLinks maps each note to the notes it links to, with counts.
		const incoming = new Map<string, number>();
		const hasOutgoing = new Set<string>();
		let links = 0;
		for (const [from, targets] of Object.entries(metadataCache.resolvedLinks)) {
			for (const [to, n] of Object.entries(targets)) {
				links += n;
				hasOutgoing.add(from);
				if (to !== from) incoming.set(to, (incoming.get(to) ?? 0) + n);
			}
		}
		let mostLinked: StatsSummary["mostLinked"] = null;
		let orphans = 0;
		let tasksDone = 0;
		let tasksOpen = 0;
		const weekStart = moment().startOf("week").valueOf();
		const monthStart = moment().startOf("month").valueOf();
		let newThisWeek = 0;
		let newThisMonth = 0;
		for (const f of notes) {
			const n = incoming.get(f.path) ?? 0;
			if (n && (!mostLinked || n > mostLinked.links)) mostLinked = { file: f, links: n };
			if (!n && !hasOutgoing.has(f.path)) orphans++;
			for (const li of metadataCache.getFileCache(f)?.listItems ?? []) {
				if (li.task === undefined) continue;
				if (li.task === " ") tasksOpen++;
				else tasksDone++;
			}
			if (f.stat.ctime >= weekStart) newThisWeek++;
			if (f.stat.ctime >= monthStart) newThisMonth++;
		}
		const attachments = vault.getFiles().filter((f) => f.extension !== "md" && f.extension !== "canvas").length;

		return {
			notes: notes.length,
			words,
			chars,
			wordsToday: this.ready && base ? words - base.total : 0,
			avgWords: notes.length ? Math.round(words / notes.length) : 0,
			readingMinutes: Math.round(words / READING_WPM),
			links,
			orphans,
			tasksDone,
			tasksOpen,
			newThisWeek,
			newThisMonth,
			attachments,
			longest,
			mostLinked,
		};
	}
}
