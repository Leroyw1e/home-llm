import { Notice, TFile, normalizePath } from "obsidian";
import type HomeLLMPlugin from "./main";
import type { Issue } from "./proofread";
import { modelFor, sendChat } from "./providers";
import { proseOf } from "./stats";
import { moment } from "./time";

/** What spell check has found, kept so the AI can spot patterns in how you write. */
export interface WritingLog {
	/** Misspelt word (lower case) → its correction, how many times it was found, and when last. */
	spelling: Record<string, { fix: string; count: number; last: string }>;
	/** Recent grammar, punctuation and clarity problems, newest last. */
	other: { type: string; original: string; fix: string; reason: string }[];
	checks: number;
}

export const EMPTY_LOG: WritingLog = { spelling: {}, other: [], checks: 0 };

const MAX_SPELLING = 400;
const MAX_OTHER = 120;
/** Most writing sent to the AI when building the profile. */
const SAMPLE_LIMIT = 16_000;
const TABLE_START = "<!-- home-ai:mistakes -->";
const TABLE_END = "<!-- /home-ai:mistakes -->";

export function profilePath(setting: string): string {
	let p = normalizePath((setting || "Writing profile").trim());
	if (!/\.md$/i.test(p)) p += ".md";
	return p;
}

/** Adds what one spell check found to the log, then refreshes the mistakes table in the profile note. */
export async function recordIssues(plugin: HomeLLMPlugin, issues: Issue[]): Promise<void> {
	const s = plugin.settings;
	if (!s.writingLogEnabled) return;
	const log = s.writingLog ?? { ...EMPTY_LOG, spelling: {}, other: [] };
	const today = moment().format("YYYY-MM-DD");
	log.checks++;
	for (const i of issues) {
		const word = i.original.trim();
		// Spelling mistakes are counted per word; longer phrases are other kinds of problem.
		if (i.type === "spelling" && word.split(/\s+/).length <= 3) {
			const key = word.toLowerCase();
			// "Becuase" at the start of a sentence is the same mistake as "becuase"; store the fix in lower case too.
			let fix = i.fix.trim();
			if (/^[A-Z]/.test(word) && word.slice(1) === key.slice(1) && /^[A-Z]/.test(fix)) fix = fix[0].toLowerCase() + fix.slice(1);
			const entry = log.spelling[key] ?? { fix, count: 0, last: today };
			entry.count++;
			entry.fix = fix;
			entry.last = today;
			log.spelling[key] = entry;
		} else {
			log.other.push({ type: i.type, original: i.original, fix: i.fix, reason: i.reason });
		}
	}
	const words = Object.entries(log.spelling);
	if (words.length > MAX_SPELLING) {
		words.sort((a, b) => b[1].count - a[1].count || b[1].last.localeCompare(a[1].last));
		log.spelling = Object.fromEntries(words.slice(0, MAX_SPELLING));
	}
	if (log.other.length > MAX_OTHER) log.other = log.other.slice(-MAX_OTHER);
	s.writingLog = log;
	await plugin.saveSettings();
	await refreshMistakesTable(plugin);
}

/** The words you most often misspell, most frequent first. */
export function topMistakes(log: WritingLog | null, limit = 30): [string, { fix: string; count: number; last: string }][] {
	return Object.entries(log?.spelling ?? {})
		.sort((a, b) => b[1].count - a[1].count || b[1].last.localeCompare(a[1].last))
		.slice(0, limit);
}

/** A line for the spell checker's instructions, so it watches for your usual mistakes. */
export function knownMistakesHint(plugin: HomeLLMPlugin): string {
	if (!plugin.settings.writingLogEnabled) return "";
	const top = topMistakes(plugin.settings.writingLog, 20).filter(([, e]) => e.count > 1);
	if (!top.length) return "";
	return `\nThis writer often misspells these words, so check for them carefully: ${top.map(([w, e]) => `"${w}" (should be "${e.fix}")`).join(", ")}.`;
}

function mistakesTable(log: WritingLog | null): string {
	const top = topMistakes(log, 40);
	if (!top.length) return `${TABLE_START}\nNo spelling mistakes found yet. Run spell check on your notes and they'll show up here.\n${TABLE_END}`;
	const cell = (s: string) => s.replace(/\|/g, "\\|");
	return [
		TABLE_START,
		"| You wrote | Correct spelling | Times | Last seen |",
		"| --- | --- | --- | --- |",
		...top.map(([w, e]) => `| ${cell(w)} | ${cell(e.fix)} | ${e.count} | ${moment(e.last).format("D MMM")} |`),
		TABLE_END,
	].join("\n");
}

/** Keeps the table in the profile note up to date after each spell check, without asking the AI. */
async function refreshMistakesTable(plugin: HomeLLMPlugin): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(profilePath(plugin.settings.writingProfileNote));
	if (!(file instanceof TFile)) return;
	const table = mistakesTable(plugin.settings.writingLog);
	await plugin.app.vault.process(file, (data) => {
		const a = data.indexOf(TABLE_START);
		const b = data.indexOf(TABLE_END);
		if (a < 0 || b < a) return data.replace(/\s*$/, "\n\n## Common spelling mistakes\n\n" + table + "\n");
		return data.slice(0, a) + table + data.slice(b + TABLE_END.length);
	});
}

/** Your most recently edited notes, cleaned of plugin data, as samples of how you write. */
async function writingSamples(plugin: HomeLLMPlugin): Promise<{ text: string; notes: number }> {
	const s = plugin.settings;
	const skip = [profilePath(s.writingProfileNote), normalizePath(s.memoryNote || "AI Memory.md")];
	const chats = normalizePath(s.chatSaveFolder || "AI Chats") + "/";
	const files = plugin.app.vault
		.getMarkdownFiles()
		.filter((f) => !skip.includes(f.path) && !f.path.startsWith(chats) && !/ (flashcards|quiz)( \d+)?$/.test(f.basename))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	let text = "";
	let notes = 0;
	for (const f of files) {
		if (text.length >= SAMPLE_LIMIT) break;
		const cache = plugin.app.metadataCache.getFileCache(f);
		// Voice note transcripts are speech, not writing.
		const tags = cache?.frontmatter?.tags as unknown;
		if (Array.isArray(tags) && tags.includes("voice-note")) continue;
		const prose = proseOf(await plugin.app.vault.cachedRead(f)).trim();
		if (prose.split(/\s+/).length < 15) continue;
		text += `\n\n<note title="${f.basename}">\n${prose.slice(0, 4000)}\n</note>`;
		notes++;
	}
	return { text: text.slice(0, SAMPLE_LIMIT), notes };
}

/** Asks the AI to describe how you write from your notes and spell-check history, and saves it as a note. */
export async function updateWritingProfile(plugin: HomeLLMPlugin): Promise<void> {
	const s = plugin.settings;
	const log = s.writingLog;
	const { text, notes } = await writingSamples(plugin);
	if (!notes && !log?.checks) {
		new Notice("Write a few notes or run spell check first, so there's something to learn from.");
		return;
	}
	const notice = new Notice("Building your writing profile…", 0);
	const mistakes = topMistakes(log, 40).map(([w, e]) => `${w} → ${e.fix} (${e.count}×)`);
	const other = (log?.other ?? []).slice(-60).map((o) => `[${o.type}] "${o.original}" → "${o.fix}"${o.reason ? ` (${o.reason})` : ""}`);
	const ask = `Here are samples of my writing from my notes${log?.checks ? ", and the problems spell check has found in my writing" : ""}. Describe how I write so I can understand and improve it. Reply in Markdown with exactly these sections, written to me ("you"), in ${s.spellVariant} spelling:

## How you write
A short paragraph, then bullet points on tone, sentence length and structure, vocabulary, words and phrases you use a lot, and how you organise notes.

## Strengths
Two to four bullet points.

## Habits to watch
Bullet points on patterns in your grammar, punctuation and spelling mistakes, each with a short example of the fix.

## Tips
Three to five specific, practical tips.

Base everything on the evidence below. Don't invent examples, and don't include a title.

${mistakes.length ? `<spelling_mistakes>\n${mistakes.join("\n")}\n</spelling_mistakes>\n\n` : ""}${other.length ? `<other_problems>\n${other.join("\n")}\n</other_problems>\n\n` : ""}<writing_samples>${text || "\n(none yet)"}\n</writing_samples>`;
	let reply: string;
	try {
		const provider = s.anthropicKey ? "anthropic" : s.provider;
		reply = await sendChat(s, provider, modelFor(s, provider), [{ role: "user", content: ask }], "You are a friendly writing coach who studies someone's writing and describes it clearly and kindly.");
	} catch (e) {
		notice.hide();
		new Notice("Couldn't build your writing profile: " + (e instanceof Error ? e.message : String(e)));
		return;
	}
	notice.hide();
	const body = `# Writing profile

Updated ${moment().format("D MMMM YYYY")}, from ${notes} note${notes === 1 ? "" : "s"} and ${log?.checks ?? 0} spell check${log?.checks === 1 ? "" : "s"}. Run "Update my writing profile" again any time.

${reply.replace(/^#\s+.*\n+/, "").trim()}

## Common spelling mistakes

${mistakesTable(log)}
`;
	const path = profilePath(s.writingProfileNote);
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	let file: TFile;
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, body);
		file = existing;
	} else {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (dir && !plugin.app.vault.getAbstractFileByPath(dir)) await plugin.app.vault.createFolder(dir);
		file = await plugin.app.vault.create(path, body);
	}
	await plugin.app.workspace.getLeaf("tab").openFile(file);
}
