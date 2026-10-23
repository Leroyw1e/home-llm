import { App, Modal, Notice, TFile, normalizePath, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { modelFor, sendChat } from "./providers";

export type StudyKind = "flashcards" | "quiz";

interface Card {
	front: string;
	back: string;
}

interface Question {
	question: string;
	options: string[];
	answer: number;
	explain: string;
}

type Deck = { kind: "flashcards"; cards: Card[] } | { kind: "quiz"; questions: Question[] };

/** Longest note text sent to the AI; the start of a longer note is used. */
const NOTE_LIMIT = 40_000;

function prompt(kind: StudyKind, title: string, text: string, spelling: string): string {
	const what =
		kind === "flashcards"
			? `Make flashcards that test the important facts, ideas and definitions in it: between 6 and 25, depending on how much there is. Keep each side short (one question, one answer).
Reply with only JSON: {"cards":[{"front":"question","back":"answer"}]}`
			: `Make a multiple-choice quiz that tests understanding of it: between 5 and 15 questions, depending on how much there is. Each has four options, one of them right, with believable wrong options. Mix easy and hard questions.
Reply with only JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explain":"one sentence on why it's right"}]}, where answer is the index of the right option.`;
	return `Here's my note "${title}". ${what}
Use only what's in the note and ${spelling} spelling.

<note>
${text}
</note>`;
}

function parseDeck(kind: StudyKind, reply: string): Deck {
	const body = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	let data: { cards?: Partial<Card>[]; questions?: Partial<Question>[] };
	try {
		data = JSON.parse(body.slice(start, end + 1)) as typeof data;
	} catch {
		throw new Error("The AI's reply wasn't in the expected format. Try again.");
	}
	if (kind === "flashcards") {
		const cards = (data.cards ?? []).filter((c): c is Card => !!c.front?.trim() && !!c.back?.trim());
		if (!cards.length) throw new Error("No flashcards came back. Is there enough in this note to study?");
		return { kind, cards };
	}
	const questions = (data.questions ?? []).filter(
		(q): q is Question => !!q.question && Array.isArray(q.options) && q.options.length >= 2 && typeof q.answer === "number" && q.answer >= 0 && q.answer < q.options.length
	);
	if (!questions.length) throw new Error("No quiz questions came back. Is there enough in this note to study?");
	return { kind, questions: questions.map((q) => ({ ...q, explain: q.explain ?? "" })) };
}

/** Asks the AI for flashcards or a quiz from a note, then opens them to study. */
export async function studyNote(plugin: HomeLLMPlugin, file: TFile, kind: StudyKind): Promise<void> {
	const s = plugin.settings;
	let text = (await plugin.app.vault.cachedRead(file)).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	if (text.length < 40) {
		new Notice("This note is too short to make " + (kind === "flashcards" ? "flashcards" : "a quiz") + " from.");
		return;
	}
	if (text.length > NOTE_LIMIT) {
		text = text.slice(0, NOTE_LIMIT);
		new Notice("Long note: using the first part only.");
	}
	const notice = new Notice(kind === "flashcards" ? "Making flashcards…" : "Making a quiz…", 0);
	let deck: Deck;
	try {
		const reply = await sendChat(s, s.provider, modelFor(s, s.provider), [{ role: "user", content: prompt(kind, file.basename, text, s.spellVariant) }], "You write study material from people's notes. You reply with JSON only.");
		deck = parseDeck(kind, reply);
	} catch (e) {
		notice.hide();
		new Notice("Couldn't make " + (kind === "flashcards" ? "flashcards" : "a quiz") + ": " + (e instanceof Error ? e.message : String(e)));
		return;
	}
	notice.hide();
	new StudyModal(plugin.app, file, deck).open();
}

/** Flashcards to flip through, or a quiz to answer, with a score at the end and the option to keep it as a note. */
export class StudyModal extends Modal {
	private queue: number[] = [];
	private index = 0;
	private flipped = false;
	private firstTry = new Set<number>();
	private missed = new Set<number>();
	private score = 0;
	private answered = false;
	private keys: (e: KeyboardEvent) => void = () => {};

	constructor(
		app: App,
		private source: TFile,
		private deck: Deck
	) {
		super(app);
		this.reset();
	}

	private get total(): number {
		return this.deck.kind === "flashcards" ? this.deck.cards.length : this.deck.questions.length;
	}

	private reset(): void {
		this.queue = Array.from({ length: this.total }, (_, i) => i);
		this.index = 0;
		this.flipped = false;
		this.answered = false;
		this.score = 0;
		this.firstTry.clear();
		this.missed.clear();
	}

	onOpen(): void {
		this.modalEl.addClass("hl-study");
		this.setTitle(`${this.deck.kind === "flashcards" ? "Flashcards" : "Quiz"}: ${this.source.basename}`);
		this.keys = (e) => this.onKey(e);
		this.scope.register([], " ", (e) => {
			this.keys(e);
			return false;
		});
		for (const k of ["1", "2", "3", "4", "Enter", "ArrowRight"]) this.scope.register([], k, (e) => {
			this.keys(e);
			return false;
		});
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private onKey(e: KeyboardEvent): void {
		if (this.index >= this.queue.length) return;
		if (this.deck.kind === "flashcards") {
			if (e.key === " " || e.key === "Enter") this.flip();
			else if (this.flipped && e.key === "1") this.mark(false);
			else if (this.flipped && (e.key === "2" || e.key === "ArrowRight")) this.mark(true);
			return;
		}
		const n = Number(e.key);
		if (!this.answered && n >= 1 && n <= this.deck.questions[this.queue[this.index]].options.length) this.choose(n - 1);
		else if (this.answered && (e.key === "Enter" || e.key === "ArrowRight" || e.key === " ")) this.next();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		if (this.index >= this.queue.length) {
			this.renderDone(el);
			return;
		}
		const bar = el.createDiv("hl-study-progress");
		bar.createDiv("hl-study-progress-fill").setCssStyles({ width: `${(this.index / this.queue.length) * 100}%` });
		el.createDiv({ cls: "hl-study-count", text: `${this.index + 1} of ${this.queue.length}` });
		if (this.deck.kind === "flashcards") this.renderCard(el, this.deck.cards[this.queue[this.index]]);
		else this.renderQuestion(el, this.deck.questions[this.queue[this.index]]);
	}

	private renderCard(el: HTMLElement, card: Card): void {
		const face = el.createDiv({ cls: "hl-study-card" + (this.flipped ? " is-flipped" : "") });
		face.createDiv({ cls: "hl-study-side", text: this.flipped ? "Answer" : "Question" });
		face.createDiv({ cls: "hl-study-text", text: this.flipped ? card.back : card.front });
		if (this.flipped) face.createDiv({ cls: "hl-study-front-small", text: card.front });
		face.onclick = () => this.flip();
		const row = el.createDiv("hl-study-buttons");
		if (!this.flipped) {
			this.button(row, "Show answer", "rotate-cw", () => this.flip(), true).setAttr("aria-label", "Space");
		} else {
			this.button(row, "Again", "rotate-ccw", () => this.mark(false)).setAttr("aria-label", "1");
			this.button(row, "Got it", "check", () => this.mark(true), true).setAttr("aria-label", "2");
		}
	}

	private flip(): void {
		this.flipped = !this.flipped;
		this.render();
	}

	private mark(knew: boolean): void {
		const card = this.queue[this.index];
		if (knew && !this.missed.has(card)) this.firstTry.add(card);
		// Cards you didn't know come back at the end until you get them.
		if (!knew) {
			this.missed.add(card);
			this.queue.push(card);
		}
		this.index++;
		this.flipped = false;
		this.render();
	}

	private renderQuestion(el: HTMLElement, q: Question): void {
		el.createDiv({ cls: "hl-study-question", text: q.question });
		const list = el.createDiv("hl-study-options");
		q.options.forEach((opt, i) => {
			const b = list.createEl("button", { cls: "hl-study-option" });
			b.createSpan({ cls: "hl-study-letter", text: String.fromCharCode(65 + i) });
			b.createSpan({ text: opt });
			b.onclick = () => this.choose(i);
			b.disabled = this.answered;
			if (this.answered && i === q.answer) b.addClass("is-right");
		});
		if (this.answered) {
			if (q.explain) el.createDiv({ cls: "hl-study-explain", text: q.explain });
			const row = el.createDiv("hl-study-buttons");
			this.button(row, this.index + 1 < this.queue.length ? "Next" : "See score", "arrow-right", () => this.next(), true);
		}
	}

	private choose(i: number): void {
		if (this.answered || this.deck.kind !== "quiz") return;
		const q = this.deck.questions[this.queue[this.index]];
		this.answered = true;
		const right = i === q.answer;
		if (right) this.score++;
		this.render();
		const buttons = this.contentEl.querySelectorAll<HTMLButtonElement>(".hl-study-option");
		buttons[i]?.addClass(right ? "is-right" : "is-wrong");
	}

	private next(): void {
		this.index++;
		this.answered = false;
		this.render();
	}

	private renderDone(el: HTMLElement): void {
		const done = el.createDiv("hl-study-done");
		setIcon(done.createDiv("hl-study-done-icon"), "party-popper");
		const got = this.deck.kind === "flashcards" ? this.firstTry.size : this.score;
		done.createDiv({ cls: "hl-study-score", text: `${got} / ${this.total}` });
		done.createDiv({
			cls: "hl-study-score-label",
			text: this.deck.kind === "flashcards" ? "known first time" : got === this.total ? "Perfect score!" : got / this.total >= 0.7 ? "Nice work!" : "Keep practising",
		});
		const row = el.createDiv("hl-study-buttons");
		this.button(row, "Study again", "rotate-ccw", () => {
			this.reset();
			this.render();
		});
		this.button(row, "Save as note", "file-plus", () => void this.save(), true);
	}

	private button(parent: HTMLElement, text: string, icon: string, onClick: () => void, primary = false): HTMLButtonElement {
		const b = parent.createEl("button", { cls: primary ? "mod-cta" : "" });
		setIcon(b.createSpan("hl-study-btn-icon"), icon);
		b.createSpan({ text });
		b.onclick = onClick;
		return b;
	}

	/** Keeps the deck as a note next to the original. Flashcards use the question::answer format the Spaced Repetition plugin reads. */
	private async save(): Promise<void> {
		const oneLine = (s: string) => s.replace(/\s*\n\s*/g, "<br>").trim();
		const link = `[[${this.source.basename}]]`;
		const body =
			this.deck.kind === "flashcards"
				? `#flashcards\n\nFlashcards from ${link}.\n\n` + this.deck.cards.map((c) => `${oneLine(c.front)}::${oneLine(c.back)}`).join("\n\n") + "\n"
				: `Quiz from ${link}. Open each answer to check yourself.\n\n` +
					this.deck.questions
						.map(
							(q, i) =>
								`### ${i + 1}. ${oneLine(q.question)}\n\n` +
								q.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${oneLine(o)}`).join("\n") +
								`\n\n> [!success]- Answer\n> **${String.fromCharCode(65 + q.answer)}. ${oneLine(q.options[q.answer])}**${q.explain ? "\n> " + oneLine(q.explain) : ""}`
						)
						.join("\n\n") +
					"\n";
		const dir = this.source.parent && !this.source.parent.isRoot() ? this.source.parent.path + "/" : "";
		const name = `${this.source.basename} ${this.deck.kind === "flashcards" ? "flashcards" : "quiz"}`;
		let path = normalizePath(`${dir}${name}.md`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${name} ${i}.md`);
		const file = await this.app.vault.create(path, body);
		this.close();
		await this.app.workspace.getLeaf("tab").openFile(file);
	}
}
