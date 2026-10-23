import { App, Editor, Modal, Notice, Platform, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { modelFor, sendChat } from "./providers";
import { knownMistakesHint, recordIssues } from "./writing";

/** Longest text sent in one check; longer notes are checked from the start. */
const PROOF_LIMIT = 12_000;

const PROOF_TYPES = {
	spelling: { label: "Spelling", icon: "spell-check" },
	punctuation: { label: "Punctuation", icon: "quote" },
	grammar: { label: "Grammar", icon: "pilcrow" },
	clarity: { label: "Doesn't make sense", icon: "message-circle-question" },
} as const;

type ProofType = keyof typeof PROOF_TYPES;

export interface Issue {
	type: ProofType;
	original: string;
	fix: string;
	reason: string;
}

export interface LocatedIssue extends Issue {
	/** Offsets in the editor's document. */
	from: number;
	to: number;
}

interface ModalIssue extends LocatedIssue {
	state: "open" | "fixed" | "ignored" | "missing";
}

const undoKey = () => (Platform.isMacOS ? "⌘Z" : "Ctrl+Z");

function proofSystem(variant: string): string {
	return `You are a careful proofreader. Check the user's text for:
- spelling mistakes (use ${variant} spelling),
- punctuation mistakes (missing full stops, commas, apostrophes, capital letters),
- grammar mistakes,
- sentences that don't make sense or are hard to follow (type "clarity"; give a clearer version of the whole sentence).

Leave Markdown syntax, links, code, tags and names alone. Don't change the meaning or the writer's style, and don't flag things that are fine.

Reply with JSON only, no other text, in this shape:
{"issues":[{"type":"spelling|punctuation|grammar|clarity","original":"exact text copied from the input","fix":"replacement text","reason":"short explanation"}]}

"original" must be copied exactly from the input, character for character, and should be just long enough to be unique (a few words). If there are no problems, reply {"issues":[]}.`;
}

/** Pull the JSON object out of a model reply, even if it's wrapped in a code fence or chatter. */
export function parseIssues(reply: string): Issue[] {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("The model didn't return a list of fixes.");
	const data = JSON.parse(reply.slice(start, end + 1)) as { issues?: unknown };
	const raw = Array.isArray(data.issues) ? (data.issues as Record<string, unknown>[]) : [];
	return raw
		.filter((i) => i && typeof i.original === "string" && typeof i.fix === "string" && i.original && i.original !== i.fix)
		.map((i) => ({
			type: typeof i.type === "string" && i.type in PROOF_TYPES ? (i.type as ProofType) : "grammar",
			original: i.original as string,
			fix: i.fix as string,
			reason: typeof i.reason === "string" ? i.reason : "",
		}));
}

/** Proofreads the selection (or whole note) in an editor, then lists the fixes or applies them all. */
export async function proofread(plugin: HomeLLMPlugin, editor: Editor, mode: "list" | "fix"): Promise<void> {
	const s = plugin.settings;
	const sel = editor.getSelection();
	const base = sel ? editor.posToOffset(editor.getCursor("from")) : 0;
	let text = sel || editor.getValue();
	if (!text.trim()) {
		new Notice("Nothing to check");
		return;
	}
	if (text.length > PROOF_LIMIT) {
		text = text.slice(0, PROOF_LIMIT);
		new Notice("Long note: checking the first part only. Select a section to check the rest.");
	}

	const notice = new Notice("Checking spelling and grammar…", 0);
	let issues: Issue[];
	try {
		const reply = await sendChat(
			{ ...s, temperature: 0, maxTokens: Math.max(s.maxTokens, 4096) },
			s.provider,
			modelFor(s, s.provider),
			[{ role: "user", content: text }],
			proofSystem(s.spellVariant) + knownMistakesHint(plugin)
		);
		issues = parseIssues(reply);
		void recordIssues(plugin, issues);
	} catch (e) {
		notice.hide();
		new Notice("Spell check failed: " + (e instanceof Error ? e.message : String(e)));
		return;
	}
	notice.hide();

	// Locate each issue in the checked text, skipping any the model misquoted or that overlap an earlier one.
	const located: LocatedIssue[] = [];
	let searchFrom = 0;
	for (const issue of issues) {
		let at = text.indexOf(issue.original, searchFrom);
		if (at < 0) at = text.indexOf(issue.original);
		if (at < 0 || located.some((l) => base + at < l.to && base + at + issue.original.length > l.from)) continue;
		located.push({ ...issue, from: base + at, to: base + at + issue.original.length });
		searchFrom = at + issue.original.length;
	}

	if (!located.length) {
		new Notice("No spelling or grammar problems found ✨");
		return;
	}
	if (mode === "fix") {
		const n = applyFixes(editor, located);
		new Notice(`Fixed ${n} ${n === 1 ? "problem" : "problems"}. Press ${undoKey()} to undo.`);
		return;
	}
	new ProofreadModal(plugin.app, editor, located).open();
}

/** Apply fixes in one undo step, from the end backwards. Positions are re-checked against the current text first. */
export function applyFixes(editor: Editor, fixes: LocatedIssue[]): number {
	const doc = editor.getValue();
	const ok = fixes.filter((f) => doc.slice(f.from, f.to) === f.original).sort((a, b) => b.from - a.from);
	if (!ok.length) return 0;
	editor.transaction({
		changes: ok.map((f) => ({ from: editor.offsetToPos(f.from), to: editor.offsetToPos(f.to), text: f.fix })),
	});
	return ok.length;
}

export class ProofreadModal extends Modal {
	private editor: Editor;
	issues: ModalIssue[];

	constructor(app: App, editor: Editor, issues: LocatedIssue[]) {
		super(app);
		this.editor = editor;
		this.issues = issues.map((i) => ({ ...i, state: "open" }));
	}

	onOpen(): void {
		this.modalEl.addClass("hlp-modal");
		this.titleEl.setText("Spelling and grammar");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** After a fix, later issues shift by the change in length. */
	private shiftAfter(fixed: ModalIssue): void {
		const delta = fixed.fix.length - fixed.original.length;
		for (const i of this.issues) {
			if (i !== fixed && i.from >= fixed.to) {
				i.from += delta;
				i.to += delta;
			}
		}
	}

	fix(issue: ModalIssue): void {
		if (applyFixes(this.editor, [issue])) {
			issue.state = "fixed";
			this.shiftAfter(issue);
		} else {
			issue.state = "missing";
		}
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const open = this.issues.filter((i) => i.state === "open");
		const top = el.createDiv("hlp-top");
		top.createDiv({ cls: "hlp-count", text: open.length ? `${open.length} ${open.length === 1 ? "suggestion" : "suggestions"}` : "All done ✨" });
		if (open.length) {
			const all = top.createEl("button", { cls: "mod-cta", text: "Fix all" });
			all.onclick = () => {
				const n = applyFixes(this.editor, open);
				open.forEach((i) => (i.state = "fixed"));
				new Notice(`Fixed ${n} ${n === 1 ? "problem" : "problems"}. Press ${undoKey()} to undo.`);
				this.close();
			};
		}
		const list = el.createDiv("hlp-list");
		for (const issue of this.issues) {
			const row = list.createDiv(`hlp-item hlp-${issue.type} is-${issue.state}`);
			const head = row.createDiv("hlp-item-head");
			const badge = head.createSpan("hlp-badge");
			setIcon(badge.createSpan("hlp-badge-icon"), PROOF_TYPES[issue.type].icon);
			badge.createSpan({ text: PROOF_TYPES[issue.type].label });
			if (issue.state !== "open") {
				head.createSpan({ cls: "hlp-state", text: issue.state === "fixed" ? "Fixed" : issue.state === "ignored" ? "Ignored" : "Text changed, couldn't apply" });
			}
			const change = row.createDiv("hlp-change");
			change.createSpan({ cls: "hlp-old", text: issue.original });
			setIcon(change.createSpan("hlp-arrow"), "arrow-right");
			change.createSpan({ cls: "hlp-new", text: issue.fix });
			if (issue.reason) row.createDiv({ cls: "hlp-reason", text: issue.reason });
			if (issue.state === "open") {
				const actions = row.createDiv("hlp-actions");
				const fix = actions.createEl("button", { cls: "mod-cta", text: "Fix" });
				fix.onclick = () => {
					this.fix(issue);
					this.render();
				};
				const show = actions.createEl("button", { text: "Show" });
				show.onclick = () => {
					const from = this.editor.offsetToPos(issue.from);
					const to = this.editor.offsetToPos(issue.to);
					this.editor.setSelection(from, to);
					this.editor.scrollIntoView({ from, to }, true);
				};
				const ignore = actions.createEl("button", { text: "Ignore" });
				ignore.onclick = () => {
					issue.state = "ignored";
					this.render();
				};
			}
		}
	}
}
