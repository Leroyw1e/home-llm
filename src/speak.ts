import { Notice, Platform, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { proseOf } from "./stats";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/** Locale to prefer for each spelling choice, so the voice matches your accent. */
const LOCALES: Record<string, string> = {
	"Australian English": "en-AU",
	"British English": "en-GB",
	"American English": "en-US",
	"Canadian English": "en-CA",
	"New Zealand English": "en-NZ",
};

/** Turns a note's Markdown into plain sentences worth hearing: no links syntax, code, tables or plugin data. */
export function speakableText(markdown: string): string {
	// Code and plugin data blocks aren't worth hearing, so drop them whole before cleaning the rest.
	return proseOf(markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, ""))
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/^>\s*\[![^\]]*\][+-]?\s*/gm, "")
		.replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*$/gm, "")
		.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_row: string, cells: string) => cells.split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*#{1,6}\s+(.*)$/gm, "$1.")
		.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
		.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
		.replace(/[*_~=`]+/g, "")
		.replace(/(^|\s)#[\w/-]+/g, "$1")
		.replace(/\.\.+/g, ".")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/** Splits text into short pieces; browsers can cut off one long utterance part-way. */
function sentences(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const parts = line.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [];
		for (let p of parts) {
			p = p.trim();
			while (p.length > 220) {
				const cut = Math.max(p.lastIndexOf(", ", 220), p.lastIndexOf(" ", 220));
				const at = cut > 60 ? cut + 1 : 220;
				out.push(p.slice(0, at).trim());
				p = p.slice(at).trim();
			}
			if (/\w/.test(p)) out.push(p);
		}
	}
	return out;
}

export function voices(): SpeechSynthesisVoice[] {
	return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices();
}

/** The chosen voice, or the best one for your spelling choice (enhanced and premium voices sound much better). */
function pickVoice(plugin: HomeLLMPlugin): SpeechSynthesisVoice | null {
	const all = voices();
	const chosen = all.find((v) => v.name === plugin.settings.readVoice);
	if (chosen) return chosen;
	const locale = LOCALES[plugin.settings.spellVariant] ?? "en-US";
	const rank = (v: SpeechSynthesisVoice) => (v.lang.replace("_", "-") === locale ? 10 : v.lang.startsWith("en") ? 5 : 0) + (/premium/i.test(v.name) ? 3 : /enhanced/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
	return all.filter((v) => rank(v) > 0).sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** Reads text aloud with the device's own voices, with a bar at the bottom of the window to control it. */
export class Reader {
	private queue: string[] = [];
	private index = 0;
	private bar: HTMLElement | null = null;
	private lineEl: HTMLElement | null = null;
	private playBtn: HTMLElement | null = null;
	private speedBtn: HTMLElement | null = null;
	private paused = false;
	/** Bumped on every stop or jump, so a finished utterance from before doesn't move things on. */
	private run = 0;

	constructor(private plugin: HomeLLMPlugin) {}

	static supported(): boolean {
		return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
	}

	get reading(): boolean {
		return !!this.bar;
	}

	start(text: string, title: string): void {
		if (!Reader.supported()) {
			new Notice("Reading aloud isn't available on this device.");
			return;
		}
		const parts = sentences(speakableText(text));
		if (!parts.length) {
			new Notice("There's nothing to read in this note.");
			return;
		}
		this.stop();
		this.queue = parts;
		this.index = 0;
		this.paused = false;
		this.showBar(title);
		// Voices load in the background the first time; wait for them so the right one is used.
		if (!voices().length) speechSynthesis.addEventListener("voiceschanged", () => this.speak(), { once: true });
		window.setTimeout(() => this.speak(), voices().length ? 0 : 400);
	}

	private speak(): void {
		if (!this.bar || this.paused) return;
		const run = ++this.run;
		speechSynthesis.cancel();
		const text = this.queue[this.index];
		if (text === undefined) {
			this.stop();
			return;
		}
		this.lineEl?.setText(text);
		this.updateProgress();
		const u = new SpeechSynthesisUtterance(text);
		const voice = pickVoice(this.plugin);
		if (voice) {
			u.voice = voice;
			u.lang = voice.lang;
		}
		u.rate = this.plugin.settings.readRate;
		u.onend = () => {
			if (run !== this.run || this.paused) return;
			this.index++;
			this.speak();
		};
		u.onerror = (e) => {
			if (run !== this.run || e.error === "interrupted" || e.error === "canceled") return;
			new Notice("Couldn't read aloud: " + e.error);
			this.stop();
		};
		speechSynthesis.speak(u);
	}

	togglePause(): void {
		if (!this.bar) return;
		this.paused = !this.paused;
		if (this.paused) {
			this.run++;
			speechSynthesis.cancel();
		} else {
			this.speak();
		}
		if (this.playBtn) {
			setIcon(this.playBtn, this.paused ? "play" : "pause");
			this.playBtn.setAttr("aria-label", this.paused ? "Resume" : "Pause");
		}
	}

	/** Moves back or forward a sentence. */
	jump(by: number): void {
		if (!this.bar) return;
		this.index = Math.max(0, Math.min(this.queue.length - 1, this.index + by));
		if (this.paused) {
			this.lineEl?.setText(this.queue[this.index]);
			this.updateProgress();
		} else this.speak();
	}

	private cycleSpeed(): void {
		const s = this.plugin.settings;
		const i = SPEEDS.indexOf(s.readRate);
		s.readRate = SPEEDS[(i + 1) % SPEEDS.length];
		void this.plugin.saveSettings();
		this.speedBtn?.setText(`${s.readRate}×`);
		if (!this.paused) this.speak();
	}

	stop(): void {
		this.run++;
		if (Reader.supported()) speechSynthesis.cancel();
		this.bar?.remove();
		this.bar = this.lineEl = this.playBtn = this.speedBtn = null;
	}

	private updateProgress(): void {
		this.bar?.setCssProps({ "--hl-read-progress": `${(this.index / Math.max(1, this.queue.length)) * 100}%` });
	}

	private showBar(title: string): void {
		const bar = activeDocument.body.createDiv({ cls: "hl-reader" + (Platform.isMobile ? " is-mobile" : "") });
		this.bar = bar;
		const head = bar.createDiv("hl-reader-head");
		setIcon(head.createSpan("hl-reader-icon"), "audio-lines");
		head.createSpan({ cls: "hl-reader-title", text: title });
		this.lineEl = bar.createDiv("hl-reader-line");
		const controls = bar.createDiv("hl-reader-controls");
		const btn = (icon: string, label: string, fn: () => void, cls = "") => {
			const b = controls.createEl("button", { cls: "hl-reader-btn clickable-icon " + cls, attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = fn;
			return b;
		};
		btn("skip-back", "Previous sentence", () => this.jump(-1));
		this.playBtn = btn("pause", "Pause", () => this.togglePause(), "is-primary");
		btn("skip-forward", "Next sentence", () => this.jump(1));
		this.speedBtn = controls.createEl("button", { cls: "hl-reader-speed", text: `${this.plugin.settings.readRate}×`, attr: { "aria-label": "Speed" } });
		this.speedBtn.onclick = () => this.cycleSpeed();
		btn("x", "Stop reading", () => this.stop());
		bar.createDiv("hl-reader-progress");
	}
}
