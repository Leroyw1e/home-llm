import { App, TFile, normalizePath } from "obsidian";
import { moment } from "./time";

/** Most memory text put into the AI's instructions, so a huge note can't crowd out the conversation. */
const MEMORY_LIMIT = 8_000;

const HEADER = `# AI memory

Things the AI chat remembers about you. It reads this note at the start of every chat. Edit or delete anything you like.

`;

export function memoryPath(setting: string): string {
	let p = normalizePath((setting || "AI Memory").trim());
	if (!/\.md$/i.test(p)) p += ".md";
	return p;
}

function memoryFile(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}

/** The memory note's text without its title and intro, or "" if there's no note yet. */
export async function readMemory(app: App, path: string): Promise<string> {
	const f = memoryFile(app, path);
	if (!f) return "";
	// Drop the title and intro line (even if the user has reworded the intro) so only the facts are sent.
	const text = (await app.vault.cachedRead(f))
		.replace(/^# AI memory[ \t]*\n+(?:Things the AI chat remembers[^\n]*\n+)?/i, "")
		.trim();
	return text.length > MEMORY_LIMIT ? text.slice(0, MEMORY_LIMIT) + "\n(older memories cut off)" : text;
}

/** The note's full text before and after adding a fact, for showing or saving. */
export async function withFact(app: App, path: string, fact: string): Promise<{ before: string; after: string; exists: boolean }> {
	const f = memoryFile(app, path);
	const before = f ? await app.vault.read(f) : "";
	const line = `- ${fact.replace(/\s+/g, " ").trim()} (${moment().format("D MMM YYYY")})`;
	const after = f && before.trim() ? before.replace(/\s*$/, "") + "\n" + line + "\n" : HEADER + line + "\n";
	return { before, after, exists: !!f };
}

/** The note's text with every bullet that contains `text` (ignoring case) removed. */
export async function withoutFact(app: App, path: string, text: string): Promise<{ before: string; after: string; removed: string[] }> {
	const f = memoryFile(app, path);
	if (!f) return { before: "", after: "", removed: [] };
	const before = await app.vault.read(f);
	const needle = text.toLowerCase().trim();
	const removed: string[] = [];
	const kept = before.split("\n").filter((line) => {
		const hit = needle && /^\s*[-*]\s/.test(line) && line.toLowerCase().includes(needle);
		if (hit) removed.push(line.replace(/^\s*[-*]\s+/, ""));
		return !hit;
	});
	return { before, after: kept.join("\n"), removed };
}

/** Writes the memory note, creating it (and its folder) if needed. */
export async function saveMemory(app: App, path: string, before: string, after: string): Promise<void> {
	const f = memoryFile(app, path);
	if (f) {
		await app.vault.process(f, (data) => {
			if (data !== before) throw new Error("The memory note changed while waiting.");
			return after;
		});
		return;
	}
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
	await app.vault.create(path, after);
}

/** Opens the memory note, creating it with its intro if it doesn't exist yet. */
export async function ensureMemoryNote(app: App, path: string): Promise<TFile> {
	const existing = memoryFile(app, path);
	if (existing) return existing;
	await saveMemory(app, path, "", HEADER);
	const created = memoryFile(app, path);
	if (!created) throw new Error("Couldn't create the memory note.");
	return created;
}
