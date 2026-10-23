import { App, Component, TFile, TFolder, getAllTags, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { dailyPath, getOrCreateDaily } from "./daily";
import { FOCUS_LABELS, FocusMode, formatClock } from "./focus";
import { StatsSummary } from "./stats";
import { moment } from "./time";

/** What a card needs to draw itself and clean up after itself. */
export interface CardContext {
	app: App;
	plugin: HomeLLMPlugin;
	/** Owns the card's timers and listeners; unloading it stops them. */
	component: Component;
	/** Opens a file: the home screen opens it in its own tab, widgets next to the note. */
	open: (file: TFile) => void;
}

export function greeting(): string {
	const hour = new Date().getHours();
	return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** 12-hour time with a small am/pm. */
export function renderTime(el: HTMLElement): void {
	const now = moment();
	el.empty();
	el.createSpan({ text: now.format("h:mm") });
	el.createSpan({ cls: "hlh-ampm", text: now.format("a") });
}

function card(parent: HTMLElement, icon: string, title: string, cls = ""): { card: HTMLElement; head: HTMLElement } {
	const el = parent.createDiv("hlh-card" + (cls ? " " + cls : ""));
	const head = el.createDiv("hlh-card-head");
	setIcon(head.createSpan("hlh-card-icon"), icon);
	head.createSpan({ text: title });
	return { card: el, head };
}

export function fileRow(parent: HTMLElement, f: TFile, open: (f: TFile) => void, meta?: string): HTMLElement {
	const row = parent.createDiv("hlh-row");
	setIcon(row.createSpan("hlh-row-icon"), f.extension === "canvas" ? "layout-dashboard" : "file-text");
	const text = row.createDiv("hlh-row-text");
	text.createDiv({ cls: "hlh-row-name", text: f.basename });
	if (f.parent && !f.parent.isRoot()) text.createDiv({ cls: "hlh-row-sub", text: f.parent.path });
	row.createSpan({ cls: "hlh-row-meta", text: meta ?? moment(f.stat.mtime).fromNow(true) });
	row.onclick = () => open(f);
	return row;
}

export function clockCard(parent: HTMLElement, ctx: CardContext): void {
	const el = parent.createDiv("hlh-card hlh-clock-card");
	el.createDiv({ cls: "hlh-clock-greet", text: greeting() });
	const time = el.createDiv("hlh-clock-big");
	el.createDiv({ cls: "hlh-clock-date", text: moment().format("dddd D MMMM") });
	renderTime(time);
	ctx.component.registerInterval(window.setInterval(() => renderTime(time), 10_000));
}

export function calendarCard(parent: HTMLElement, ctx: CardContext): void {
	const { card: el } = card(parent, "calendar", "Calendar");
	const body = el.createDiv("hlh-cal");
	let month = moment().startOf("month");
	const draw = () => {
		const cfg = ctx.plugin.daily;
		body.empty();
		const nav = body.createDiv("hlh-cal-nav");
		const prev = nav.createEl("button", { cls: "hlh-cal-btn", attr: { "aria-label": "Previous month" } });
		setIcon(prev, "chevron-left");
		nav.createDiv({ cls: "hlh-cal-title", text: month.format("MMMM YYYY") });
		const next = nav.createEl("button", { cls: "hlh-cal-btn", attr: { "aria-label": "Next month" } });
		setIcon(next, "chevron-right");
		prev.onclick = () => {
			month = month.clone().subtract(1, "month");
			draw();
		};
		next.onclick = () => {
			month = month.clone().add(1, "month");
			draw();
		};
		const days = body.createDiv("hlh-cal-grid");
		for (const d of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) days.createDiv({ cls: "hlh-cal-dow", text: d });
		const start = month.clone().startOf("isoWeek");
		const today = moment().format("YYYY-MM-DD");
		for (let i = 0; i < 42; i++) {
			const day = start.clone().add(i, "day");
			if (i >= 35 && day.month() !== month.month()) break;
			const cell = days.createEl("button", { cls: "hlh-cal-day", text: String(day.date()) });
			cell.toggleClass("is-other", day.month() !== month.month());
			cell.toggleClass("is-today", day.format("YYYY-MM-DD") === today);
			cell.toggleClass("has-note", !!ctx.app.vault.getAbstractFileByPath(dailyPath(cfg, day)));
			cell.setAttr("aria-label", day.format("dddd D MMMM"));
			cell.onclick = () =>
				void getOrCreateDaily(ctx.app, cfg, day).then((f) => {
					if (f) ctx.open(f);
				});
		}
	};
	draw();
}

/** Notes, canvases, folders, tags and notes edited today. */
export function vaultCard(parent: HTMLElement, ctx: CardContext): void {
	const { card: el } = card(parent, "vault", "Vault");
	const { vault, metadataCache } = ctx.app;
	const files = vault.getFiles();
	const startOfDay = moment().startOf("day").valueOf();
	const tags = new Set<string>();
	for (const f of vault.getMarkdownFiles()) {
		const cache = metadataCache.getFileCache(f);
		if (cache) for (const t of getAllTags(cache) ?? []) tags.add(t.toLowerCase());
	}
	const folders = vault.getAllLoadedFiles().filter((f) => f instanceof TFolder && !f.isRoot()).length;
	const stats: [string, number, string][] = [
		["file-text", files.filter((f) => f.extension === "md").length, "Notes"],
		["layout-dashboard", files.filter((f) => f.extension === "canvas").length, "Canvases"],
		["folder", folders, "Folders"],
		["tag", tags.size, "Tags"],
		["pencil", files.filter((f) => f.stat.mtime >= startOfDay).length, "Edited today"],
	];
	const row = el.createDiv("hlh-stats-row");
	for (const [icon, n, label] of stats) {
		const st = row.createDiv("hlh-stat");
		setIcon(st.createSpan("hlh-stat-icon"), icon);
		st.createDiv({ cls: "hlh-stat-num", text: n.toLocaleString() });
		st.createDiv({ cls: "hlh-stat-label", text: label });
	}
}

function readingTime(min: number): string {
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	return `${h} h ${min % 60} min`;
}

/**
 * Total word count and other numbers about the vault, kept live as notes change.
 * `compact` shows just the word count and today's change (for small widgets).
 */
/** The writing streak: days in a row with new words, your best run, and a nudge if today isn't done yet. */
function streakRow(parent: HTMLElement, s: StatsSummary): void {
	const row = parent.createDiv("hls-streak" + (s.streak ? "" : " is-zero") + (s.wroteToday ? " is-done" : ""));
	setIcon(row.createSpan("hls-streak-icon"), "flame");
	const text = row.createDiv("hls-streak-text");
	text.createDiv({ cls: "hls-streak-num", text: s.streak === 1 ? "1 day streak" : `${s.streak} day streak` });
	text.createDiv({
		cls: "hls-streak-sub",
		text: s.wroteToday ? "You've written today" : s.streak ? "Write today to keep it going" : "Write today to start a streak",
	});
	if (s.bestStreak > 1) row.createDiv({ cls: "hls-streak-best", text: `Best ${s.bestStreak}` });
}

export function statsCard(parent: HTMLElement, ctx: CardContext, compact = false): void {
	const { card: el } = card(parent, "bar-chart-3", compact ? "Words" : "Vault stats", "hls-card");
	const body = el.createDiv("hls-body");
	const stats = ctx.plugin.stats;

	const draw = () => {
		body.empty();
		if (!stats.ready) {
			body.createDiv({ cls: "hlh-empty", text: "Counting words…" });
			return;
		}
		const s: StatsSummary = stats.summary();
		const hero = body.createDiv("hls-hero");
		hero.createDiv({ cls: "hls-big", text: s.words.toLocaleString() });
		const sub = hero.createDiv("hls-big-sub");
		sub.createSpan({ text: "words in your vault" });
		const delta = sub.createSpan({ cls: "hls-today", text: `${s.wordsToday >= 0 ? "+" : "−"}${Math.abs(s.wordsToday).toLocaleString()} today` });
		delta.toggleClass("is-down", s.wordsToday < 0);
		streakRow(body, s);
		if (compact) return;

		const grid = body.createDiv("hls-grid");
		const tile = (icon: string, value: string, label: string) => {
			const t = grid.createDiv("hls-tile");
			setIcon(t.createSpan("hls-tile-icon"), icon);
			t.createDiv({ cls: "hls-tile-num", text: value });
			t.createDiv({ cls: "hls-tile-label", text: label });
		};
		tile("pilcrow", s.chars.toLocaleString(), "Characters");
		tile("divide", s.avgWords.toLocaleString(), "Words per note");
		tile("book-open", readingTime(s.readingMinutes), "To read it all");
		tile("link", s.links.toLocaleString(), "Links");
		tile("calendar-plus", s.newThisWeek.toLocaleString(), "New this week");
		tile("calendar-range", s.newThisMonth.toLocaleString(), "New this month");
		tile("unlink", s.orphans.toLocaleString(), "Unlinked notes");
		tile("paperclip", s.attachments.toLocaleString(), "Attachments");

		const total = s.tasksDone + s.tasksOpen;
		if (total) {
			const tasks = body.createDiv("hls-tasks");
			const top = tasks.createDiv("hls-tasks-top");
			top.createSpan({ text: "Tasks" });
			top.createSpan({ cls: "hls-tasks-count", text: `${s.tasksDone.toLocaleString()} of ${total.toLocaleString()} done` });
			const bar = tasks.createDiv("hls-bar");
			bar.createDiv("hls-bar-fill").setCssStyles({ width: `${Math.round((s.tasksDone / total) * 100)}%` });
		}

		const rows = body.createDiv("hls-rows");
		if (s.longest) {
			rows.createDiv({ cls: "hls-rows-label", text: "Longest note" });
			fileRow(rows, s.longest.file, ctx.open, `${s.longest.words.toLocaleString()} words`);
		}
		if (s.mostLinked) {
			rows.createDiv({ cls: "hls-rows-label", text: "Most linked" });
			fileRow(rows, s.mostLinked.file, ctx.open, `${s.mostLinked.links.toLocaleString()} links`);
		}
	};

	draw();
	ctx.component.register(stats.subscribe(draw));
	if (!stats.ready) void stats.build();
}

export function recentCard(parent: HTMLElement, ctx: CardContext, title = "Recent"): void {
	const { card: el } = card(parent, "clock", title);
	const body = el.createDiv("hlh-card-body");
	const files = ctx.app.workspace
		.getLastOpenFiles()
		.map((p) => ctx.app.vault.getAbstractFileByPath(p))
		.filter((f): f is TFile => f instanceof TFile)
		.slice(0, ctx.plugin.settings.recentCount);
	if (files.length === 0) body.createDiv({ cls: "hlh-empty", text: "Notes you open will show up here." });
	for (const f of files) fileRow(body, f, ctx.open);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Pomodoro timer: a ring showing time left, start/pause, reset and skip, and today's sessions. */
export function focusCard(parent: HTMLElement, ctx: CardContext, compact = false): void {
	const timer = ctx.plugin.focus;
	const { card: el } = card(parent, "timer", "Focus timer", "hlh-focus-card" + (compact ? " is-compact" : ""));
	const body = el.createDiv("hlh-focus-body");

	const modes = body.createDiv("hlh-focus-modes");
	const modeBtns = (Object.keys(FOCUS_LABELS) as FocusMode[]).map((m: FocusMode) => {
		const b = modes.createEl("button", { cls: "hlh-focus-mode", text: FOCUS_LABELS[m] });
		b.onclick = () => timer.setMode(m);
		return [m, b] as const;
	});

	const dial = body.createDiv("hlh-focus-dial");
	const svg = dial.createSvg("svg", { attr: { viewBox: "0 0 120 120", class: "hlh-focus-ring" } });
	const track = document.createElementNS(SVG_NS, "circle");
	const arc = document.createElementNS(SVG_NS, "circle");
	for (const [c, cls] of [
		[track, "hlh-focus-track"],
		[arc, "hlh-focus-arc"],
	] as const) {
		c.setAttribute("cx", "60");
		c.setAttribute("cy", "60");
		c.setAttribute("r", "52");
		c.setAttribute("class", cls);
		svg.appendChild(c);
	}
	const circumference = 2 * Math.PI * 52;
	arc.setAttribute("stroke-dasharray", String(circumference));
	const centre = dial.createDiv("hlh-focus-centre");
	const time = centre.createDiv("hlh-focus-time");
	const label = centre.createDiv("hlh-focus-label");

	const controls = body.createDiv("hlh-focus-controls");
	const iconButton = (icon: string, aria: string, fn: () => void, cls = "") => {
		const b = controls.createEl("button", { cls: "hlh-focus-btn " + cls, attr: { "aria-label": aria } });
		setIcon(b, icon);
		b.onclick = fn;
		return b;
	};
	iconButton("rotate-ccw", "Reset", () => timer.reset());
	const play = iconButton("play", "Start", () => timer.toggle(), "is-primary");
	iconButton("skip-forward", "Skip to next", () => timer.skip());
	const dots = body.createDiv("hlh-focus-dots");

	let lastRunning: boolean | null = null;
	const draw = () => {
		const st = timer.state;
		time.setText(formatClock(timer.left));
		label.setText(timer.running ? FOCUS_LABELS[st.mode] : timer.active ? "Paused" : FOCUS_LABELS[st.mode]);
		arc.setAttribute("stroke-dashoffset", String(circumference * timer.progress));
		el.toggleClass("is-running", timer.running);
		el.toggleClass("is-break", st.mode !== "focus");
		for (const [m, b] of modeBtns) b.toggleClass("is-active", m === st.mode);
		if (lastRunning !== timer.running) {
			lastRunning = timer.running;
			setIcon(play, timer.running ? "pause" : "play");
			play.setAttr("aria-label", timer.running ? "Pause" : "Start");
		}
		const every = ctx.plugin.settings.focusLongEvery;
		dots.empty();
		const round = st.done % every;
		for (let i = 0; i < every; i++) dots.createSpan({ cls: "hlh-focus-dot" + (i < round || (round === 0 && st.done > 0) ? " is-done" : "") });
		dots.createSpan({ cls: "hlh-focus-today", text: `${st.done} today` });
	};
	draw();
	ctx.component.register(timer.subscribe(draw));
}

/** Widgets you can put in any note with a `home-widget` code block. */
export const WIDGETS: Record<string, { label: string; icon: string; render: (parent: HTMLElement, ctx: CardContext) => void }> = {
	stats: { label: "Vault stats", icon: "bar-chart-3", render: (p, c) => statsCard(p, c) },
	words: { label: "Word count", icon: "type", render: (p, c) => statsCard(p, c, true) },
	clock: { label: "Clock", icon: "clock", render: clockCard },
	calendar: { label: "Calendar", icon: "calendar", render: calendarCard },
	vault: { label: "Vault summary", icon: "vault", render: vaultCard },
	recent: { label: "Recent notes", icon: "history", render: (p, c) => recentCard(p, c) },
	focus: { label: "Focus timer", icon: "timer", render: (p, c) => focusCard(p, c) },
};
