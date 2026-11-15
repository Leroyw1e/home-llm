import { Platform, setIcon } from "obsidian";
import { ModelInfo, modelInfo } from "./model-info";
import type { Effort, ProviderId } from "./settings";

export interface PickerSection {
	provider: ProviderId;
	label: string;
	/** False when the provider still needs a key (or the add-on); the section then offers to set it up. */
	ready: boolean;
	setupLabel: string;
	models: { id: string; name: string }[];
}

export interface PickerOptions {
	anchor: HTMLElement;
	current: { provider: ProviderId; model: string };
	sections: PickerSection[];
	effort: Effort;
	effortLabels: Record<Effort, string>;
	/** The on-device model's name, for its details. */
	localName?: string;
	onPick: (provider: ProviderId, model: string) => void;
	onEffort: (effort: Effort) => void;
	onSetup: () => void;
}

/**
 * True when every word typed starts a word in the text, so "mini" finds "GPT-5 mini" but not "Gemini",
 * and "5.4 nano" finds "GPT-5.4 nano".
 */
function matchesWords(query: string, text: string): boolean {
	const lower = text.toLowerCase();
	// Whole words ("gpt-5", "o3") and their hyphenated parts ("gpt", "5", "mini") both count.
	const words = [...lower.split(/[\s()/]+/), ...lower.split(/[\s\-_/()]+/)].filter(Boolean);
	return query
		.split(/\s+/)
		.filter(Boolean)
		.every((q) => words.some((w) => w.startsWith(q)));
}

/** How many models each provider shows before "Show all". */
const SHORT_LIST = 6;

const PROVIDER_ICONS: Partial<Record<ProviderId, string>> = {
	anthropic: "sparkles",
	gemini: "gem",
	openai: "bot",
	openrouter: "route",
	custom: "server",
	local: "cpu",
};

interface Row {
	el: HTMLElement;
	provider: ProviderId;
	id: string;
	name: string;
}

/** A searchable, grouped model picker with a details card showing what the highlighted model is good at. */
export class ModelPicker {
	private el: HTMLElement;
	private listEl: HTMLElement;
	private infoEl: HTMLElement;
	private search: HTMLInputElement;
	private rows: Row[] = [];
	private active = -1;
	private expanded = new Set<ProviderId>();
	private cleanup: (() => void)[] = [];

	constructor(private o: PickerOptions) {
		const narrow = Platform.isMobile || activeWindow.innerWidth < 640;
		this.el = activeDocument.body.createDiv({ cls: "hl-picker" + (narrow ? " is-narrow" : "") });
		const main = this.el.createDiv("hl-picker-main");
		const searchWrap = main.createDiv("hl-picker-search");
		setIcon(searchWrap.createSpan("hl-picker-search-icon"), "search");
		this.search = searchWrap.createEl("input", { type: "text", attr: { placeholder: "Search models", spellcheck: "false" } });
		this.listEl = main.createDiv("hl-picker-list");
		this.buildEffort(main);
		const foot = main.createDiv("hl-picker-foot");
		const setup = foot.createEl("button", { cls: "hl-picker-link" });
		setIcon(setup.createSpan(), "settings");
		setup.createSpan({ text: "Models and API keys" });
		setup.onclick = () => {
			this.close();
			o.onSetup();
		};
		this.infoEl = this.el.createDiv("hl-picker-info");

		this.search.addEventListener("input", () => {
			this.active = 0;
			this.renderList();
		});
		this.search.addEventListener("keydown", (e) => this.onKey(e));
		this.renderList();
		this.position();
		const current = this.rows.findIndex((r) => r.provider === o.current.provider && r.id === o.current.model);
		this.highlight(current >= 0 ? current : 0, true);
		if (!Platform.isMobile) this.search.focus();

		const outside = (e: PointerEvent) => {
			if (!(e.target instanceof Node) || (!this.el.contains(e.target) && !o.anchor.contains(e.target))) this.close();
		};
		const escape = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		activeDocument.addEventListener("pointerdown", outside, true);
		activeDocument.addEventListener("keydown", escape, true);
		activeWindow.addEventListener("resize", this.close);
		this.cleanup.push(
			() => activeDocument.removeEventListener("pointerdown", outside, true),
			() => activeDocument.removeEventListener("keydown", escape, true),
			() => activeWindow.removeEventListener("resize", this.close)
		);
	}

	close = (): void => {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
		this.el.remove();
	};

	private position(): void {
		const r = this.o.anchor.getBoundingClientRect();
		const width = Math.min(this.el.hasClass("is-narrow") ? 360 : 600, activeWindow.innerWidth - 16);
		const left = Math.max(8, Math.min(r.left, activeWindow.innerWidth - width - 8));
		const top = r.bottom + 6;
		const room = `${Math.max(240, activeWindow.innerHeight - top - 12)}px`;
		// Stacked (narrow) layout needs a fixed height so the list scrolls and the details stay on screen.
		this.el.setCssStyles({ left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: room, height: this.el.hasClass("is-narrow") ? room : "" });
	}

	private renderList(): void {
		const q = this.search.value.trim().toLowerCase();
		this.listEl.empty();
		this.rows = [];
		for (const sec of this.o.sections) {
			const matches = sec.models.filter((m) => !q || matchesWords(q, `${m.name} ${m.id} ${sec.label}`));
			if (q && !matches.length) continue;
			const head = this.listEl.createDiv("hl-picker-head");
			setIcon(head.createSpan("hl-picker-head-icon"), PROVIDER_ICONS[sec.provider] ?? "bot");
			head.createSpan({ text: sec.label });
			if (!sec.ready) {
				const b = this.listEl.createEl("button", { cls: "hl-picker-setup" });
				setIcon(b.createSpan(), sec.provider === "local" ? "download" : "key-round");
				b.createSpan({ text: sec.setupLabel });
				b.onclick = () => {
					this.close();
					this.o.onSetup();
				};
				continue;
			}
			const showAll = !!q || this.expanded.has(sec.provider) || matches.length <= SHORT_LIST + 1;
			// Keep the current model visible even when it isn't in the short list.
			const shown = showAll ? matches : matches.filter((m, i) => i < SHORT_LIST || (sec.provider === this.o.current.provider && m.id === this.o.current.model));
			for (const m of shown) this.addRow(sec.provider, m.id, m.name);
			if (!showAll) {
				const more = this.listEl.createEl("button", { cls: "hl-picker-more", text: `Show all ${matches.length} models` });
				more.onclick = () => {
					this.expanded.add(sec.provider);
					this.renderList();
					this.highlight(Math.min(this.active, this.rows.length - 1), false);
				};
			}
		}
		if (!this.rows.length) this.listEl.createDiv({ cls: "hl-picker-empty", text: "No models match." });
		this.highlight(Math.min(Math.max(this.active, 0), this.rows.length - 1), false);
	}

	private addRow(provider: ProviderId, id: string, name: string): void {
		const info = modelInfo(provider, id, this.o.localName);
		const isCurrent = provider === this.o.current.provider && id === this.o.current.model;
		const el = this.listEl.createDiv({ cls: "hl-picker-row" + (isCurrent ? " is-current" : "") });
		setIcon(el.createSpan("hl-picker-check"), isCurrent ? "check" : "");
		el.createSpan({ cls: "hl-picker-name", text: name });
		const badge = info.tags.find((t) => t === "Smartest" || t === "Fast" || t === "Free tier" || t === "Offline");
		if (badge) el.createSpan({ cls: "hl-picker-badge", text: badge });
		const index = this.rows.length;
		this.rows.push({ el, provider, id, name });
		el.addEventListener("mouseenter", () => this.highlight(index, false));
		// With no hover on touch screens, the first tap shows the details and a second tap picks.
		el.onclick = () => {
			if (Platform.isMobile && this.active !== index) this.highlight(index, false);
			else this.pick(index);
		};
	}

	private highlight(index: number, scroll: boolean): void {
		if (index < 0 || index >= this.rows.length) {
			this.showInfo(null);
			return;
		}
		this.rows[this.active]?.el.removeClass("is-active");
		this.active = index;
		const row = this.rows[index];
		row.el.addClass("is-active");
		if (scroll) row.el.scrollIntoView({ block: "nearest" });
		this.showInfo(row);
	}

	private showInfo(row: Row | null): void {
		const box = this.infoEl;
		box.empty();
		if (!row) return;
		const info: ModelInfo = modelInfo(row.provider, row.id, this.o.localName);
		box.createDiv({ cls: "hl-picker-info-name", text: row.name });
		box.createDiv({ cls: "hl-picker-info-id", text: row.provider === "local" ? "On this device" : row.id });
		box.createDiv({ cls: "hl-picker-info-good", text: info.goodAt });
		const bars = box.createDiv("hl-picker-bars");
		for (const [label, value, hint] of [
			["Smart", info.smart, "How capable its answers are"],
			["Speed", info.speed, "How quickly it replies"],
			["Usage", info.usage, "How far your credit or free limit goes"],
		] as const) {
			const bar = bars.createDiv({ cls: "hl-picker-bar", attr: { "aria-label": hint } });
			bar.createSpan({ cls: "hl-picker-bar-label", text: label });
			bar.createDiv("hl-picker-bar-track").createDiv("hl-picker-bar-fill").setCssProps({ "--hl-fill": `${value * 10}%` });
			bar.createSpan({ cls: "hl-picker-bar-num", text: `${value}/10` });
		}
		if (info.tags.length) {
			const tags = box.createDiv("hl-picker-tags");
			for (const t of info.tags) tags.createSpan({ cls: "hl-picker-tag", text: t });
		}
		if (Platform.isMobile) {
			const use = box.createEl("button", { cls: "mod-cta hl-picker-use", text: "Use this model" });
			use.onclick = () => this.pick(this.rows.indexOf(row));
		}
		box.createDiv({
			cls: "hl-picker-info-note",
			text: info.guess ? "This model is newer than the plugin knows about, so these are rough guesses from its name." : "Ratings are estimates from the model's family and size, not test results.",
		});
	}

	private buildEffort(parent: HTMLElement): void {
		const wrap = parent.createDiv("hl-picker-effort");
		wrap.createSpan({ cls: "hl-picker-effort-label", text: "Effort" });
		const seg = wrap.createDiv("hl-picker-seg");
		const buttons: HTMLButtonElement[] = [];
		for (const e of Object.keys(this.o.effortLabels) as Effort[]) {
			const b = seg.createEl("button", { text: e === "default" ? "Auto" : this.o.effortLabels[e], attr: { "aria-label": this.o.effortLabels[e] } });
			b.toggleClass("is-active", e === this.o.effort);
			b.onclick = () => {
				for (const other of buttons) other.removeClass("is-active");
				b.addClass("is-active");
				this.o.effort = e;
				this.o.onEffort(e);
			};
			buttons.push(b);
		}
	}

	private pick(index: number): void {
		const row = this.rows[index];
		if (!row) return;
		this.close();
		this.o.onPick(row.provider, row.id);
	}

	private onKey(e: KeyboardEvent): void {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const n = this.rows.length;
			if (n) this.highlight((this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n, true);
		} else if (e.key === "Enter") {
			e.preventDefault();
			this.pick(this.active);
		}
	}
}
