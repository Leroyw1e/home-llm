import { Component, ItemView, Platform, TFile, WorkspaceLeaf, debounce, normalizePath, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { OBSIDIAN_LOGO, svgEl } from "./logo";
import { HILLS_SVG, SCENES, Scene, autoScene, rng, setPeakScale } from "./scenes";
import { moment } from "./time";
import { CardContext, fileRow, focusCard, greeting, recentCard, renderTime, statsCard, vaultCard } from "./widgets";

export const HOME_VIEW_TYPE = "home-llm-home";

interface SearchRow {
	el: HTMLElement;
	go: () => void;
}

export class HomeView extends ItemView {
	plugin: HomeLLMPlugin;
	private heroClock: HTMLElement | null = null;
	private sceneName = "";
	private sceneObserver: ResizeObserver | null = null;
	private sceneSize: [number, number] | null = null;
	/** Owns everything drawn by the current render (timers, listeners); replaced on each render. */
	private renderScope: Component | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: HomeLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Home";
	}

	getIcon(): string {
		return "home";
	}

	async onOpen(): Promise<void> {
		await this.plugin.refreshDailyConfig();
		this.render();
		this.registerInterval(window.setInterval(() => this.tick(), 10_000));
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf) void this.plugin.refreshDailyConfig().then(() => this.render());
			})
		);
	}

	async onClose(): Promise<void> {
		this.sceneObserver?.disconnect();
		this.contentEl.empty();
	}

	render(): void {
		const s = this.plugin.settings;
		if (this.renderScope) this.removeChild(this.renderScope);
		this.renderScope = this.addChild(new Component());
		this.heroClock = null;

		const root = this.contentEl;
		root.empty();
		for (const c of Array.from(root.classList)) if (c.startsWith("hlh-")) root.removeClass(c);
		root.addClass("home-llm-home");
		root.toggleClass("hlh-still", s.lowPower || !s.animatedBackgrounds);
		root.toggleClass("is-mobile", Platform.isMobile);
		const bg = s.homeBackground === "auto" ? autoScene() : s.homeBackground;
		this.sceneName = bg;
		root.addClass("hlh-bg-" + bg);
		const scene = SCENES[bg];
		if (scene) {
			root.addClass("hlh-scene-" + scene.tone);
			this.renderSky(root, scene);
		}
		const dashboard = s.homeStyle === "dashboard";
		root.toggleClass("hlh-style-dashboard", dashboard);
		const page = root.createDiv("hlh-scroll").createDiv("hlh-page" + (dashboard ? " hlh-dashboard" : ""));
		const ctx: CardContext = { app: this.app, plugin: this.plugin, component: this.renderScope, open: (f) => void this.leaf.openFile(f) };
		if (dashboard) this.renderDashboard(page, ctx);
		else this.renderModern(page, ctx);
	}

	/** Draws the scene layers: sky, effects, landscape, front effects, then grain and vignette. */
	private renderSky(root: HTMLElement, scene: Scene): void {
		this.sceneObserver?.disconnect();
		this.sceneSize = null;
		const sky = root.createDiv("hlh-sky");
		if (scene.legacy || !scene.build) {
			const stars = sky.createDiv("hlh-stars");
			const rnd = rng(20261022);
			for (let i = 0; i < 110; i++) {
				const st = stars.createSpan("hlh-star");
				const size = rnd() > 0.88 ? "2.5px" : "1.5px";
				st.setCssStyles({
					left: (rnd() * 100).toFixed(2) + "%",
					top: (rnd() * 62).toFixed(2) + "%",
					width: size,
					height: size,
					opacity: (0.35 + rnd() * 0.65).toFixed(2),
					animationDelay: (rnd() * 5).toFixed(2) + "s",
				});
				if (rnd() > 0.6) st.addClass("is-twinkle");
			}
			for (let i = 0; i < 4; i++) sky.createDiv("hlh-fx hlh-cloud-" + i);
			sky.createDiv("hlh-land hlh-land-night").appendChild(svgEl(HILLS_SVG));
			sky.createDiv("hlh-grain");
			return;
		}
		const build = scene.build;
		const back = sky.createDiv("hlh-layer");
		for (const e of scene.fx ?? []) sky.createDiv("hlh-fx hlh-" + e);
		const land = sky.createDiv("hlh-layer");
		for (const e of scene.front ?? []) sky.createDiv("hlh-fx hlh-" + e);
		sky.createDiv("hlh-vignette");
		sky.createDiv("hlh-grain");
		const dashboard = this.plugin.settings.homeStyle === "dashboard";
		// Scenes are drawn at the view's real size, so redraw when it changes noticeably.
		const draw = () => {
			const w = Math.round(root.clientWidth);
			const h = Math.round(root.clientHeight);
			if (!w || !h) return;
			const prev = this.sceneSize;
			if (prev && Math.abs(prev[0] - w) < 16 && Math.abs(prev[1] - h) < 16) return;
			this.sceneSize = [w, h];
			setPeakScale(w, h);
			const out = build({ w, h, rnd: rng(7919), p: "hlh" + Math.random().toString(36).slice(2, 7) + "-", dashboard });
			back.empty();
			back.appendChild(svgEl(out.sky));
			land.empty();
			land.appendChild(svgEl(out.land));
		};
		draw();
		this.sceneObserver = new ResizeObserver(debounce(draw, 150, true));
		this.sceneObserver.observe(root);
	}

	private renderDashboard(page: HTMLElement, ctx: CardContext): void {
		const s = this.plugin.settings;
		const top = page.createDiv("hlh-dash-top");
		const heading = top.createDiv("hlh-brand-wrap");
		const brand = heading.createDiv("hlh-brand");
		brand.createSpan("hlh-brand-logo").appendChild(svgEl(OBSIDIAN_LOGO));
		brand.createSpan({ cls: "hlh-brand-name", text: s.homeTitle || "Obsidian" });
		const bar = top.createDiv("hlh-dash-bar");
		if (s.showSearch) this.renderSearch(bar);
		const quick = top.createDiv("hlh-dash-quick");
		const chip = (icon: string, label: string, fn: () => void) => {
			const b = quick.createEl("button", { cls: "hlh-dash-chip", attr: { "aria-label": label } });
			setIcon(b.createSpan("hlh-dash-chip-icon"), icon);
			b.createSpan({ text: label });
			b.onclick = fn;
		};
		chip("file-plus", "New note", () => void this.newFile("md", ""));
		chip("layout-dashboard", "New canvas", () => void this.newFile("canvas", '{"nodes":[],"edges":[]}'));
		if (this.plugin.isOn("chat")) chip("sparkles", "AI chat", () => void this.plugin.openChat());
		chip("settings", "Settings", () => this.plugin.openSettings(false));

		const focus = this.plugin.isOn("focus");
		const grid = page.createDiv("hlh-dash-grid" + (focus ? " has-focus" : ""));
		// Fixed grid areas so rows line up: wide stats and recent notes on the left, timer and vault on the right.
		const area = (name: string) => grid.createDiv("hlh-area hlh-area-" + name);
		statsCard(area("stats"), ctx);
		if (focus) focusCard(area("focus"), ctx);
		if (s.showRecent) recentCard(area("recent"), ctx);
		vaultCard(area("vault"), ctx);
	}

	private renderModern(page: HTMLElement, ctx: CardContext): void {
		const s = this.plugin.settings;

		const hero = page.createDiv("hlh-hero");
		const left = hero.createDiv("hlh-hero-text");
		left.createDiv({ cls: "hlh-eyebrow", text: moment().format("dddd, D MMMM") });
		left.createEl("h1", { cls: "hlh-greeting", text: greeting() });
		this.heroClock = hero.createDiv("hlh-clock");
		renderTime(this.heroClock);

		if (s.showSearch) this.renderSearch(page);

		const actions = page.createDiv("hlh-actions");
		this.action(actions, "file-plus", "New note", "Blank page", "blue", () => void this.newFile("md", ""));
		if (this.plugin.isOn("chat")) this.action(actions, "sparkles", "AI chat", "Ask anything", "purple", () => void this.plugin.openChat());
		this.action(actions, "layout-dashboard", "New canvas", "Freeform board", "orange", () => void this.newFile("canvas", '{"nodes":[],"edges":[]}'));
		this.action(actions, "settings", "Settings", "Customise", "green", () => this.plugin.openSettings(false));

		if (this.plugin.isOn("focus")) focusCard(page, ctx, true);

		const cols = page.createDiv("hlh-columns");
		if (s.showRecent) recentCard(cols, ctx, "Jump back in");
		statsCard(cols, ctx);
		cols.toggleClass("is-single", cols.childElementCount < 2);
	}

	private tick(): void {
		if (this.plugin.settings.homeBackground === "auto" && this.sceneName !== autoScene()) {
			this.render();
			return;
		}
		if (this.heroClock) renderTime(this.heroClock);
	}

	private renderSearch(parent: HTMLElement): void {
		const wrap = parent.createDiv("hlh-search");
		setIcon(wrap.createSpan("hlh-search-icon"), "search");
		const input = wrap.createEl("input", { type: "text", cls: "hlh-search-input", attr: { placeholder: "Search notes", enterkeyhint: "search", spellcheck: "false" } });
		const results = wrap.createDiv("hlh-results");
		const open = (f: TFile) => void this.leaf.openFile(f);
		let rows: SearchRow[] = [];
		let sel = 0;
		const highlight = () => rows.forEach((r, i) => r.el.toggleClass("is-selected", i === sel));
		const update = () => {
			results.empty();
			rows = [];
			sel = 0;
			const q = input.value.trim().toLowerCase();
			wrap.toggleClass("is-open", !!q);
			if (!q) return;
			const hits = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f.path.toLowerCase().includes(q))
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 7);
			if (!hits.length) results.createDiv({ cls: "hlh-empty", text: "No matching notes." });
			for (const f of hits) rows.push({ el: fileRow(results, f, open), go: () => open(f) });
			highlight();
		};
		input.oninput = update;
		input.onkeydown = (e) => {
			if (e.key === "Escape") {
				input.value = "";
				update();
				return;
			}
			if (!rows.length) return;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				sel = (sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
				highlight();
			} else if (e.key === "Enter") {
				e.preventDefault();
				rows[sel].go();
			}
		};
	}

	private action(parent: HTMLElement, icon: string, label: string, sub: string, hue: string, onClick: () => void): void {
		const b = parent.createEl("button", { cls: `hlh-action hlh-hue-${hue}` });
		setIcon(b.createSpan("hlh-action-icon"), icon);
		const text = b.createSpan("hlh-action-text");
		text.createSpan({ cls: "hlh-action-label", text: label });
		text.createSpan({ cls: "hlh-action-sub", text: sub });
		b.onclick = onClick;
	}

	/** Creates "Untitled.<ext>" (or "Untitled 1", ...) where new files normally go, then opens it here. */
	private async newFile(ext: "md" | "canvas", content: string): Promise<void> {
		const parent = this.app.fileManager.getNewFileParent("");
		const dir = parent.isRoot() ? "" : `${parent.path}/`;
		let path = normalizePath(`${dir}Untitled.${ext}`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}Untitled ${i}.${ext}`);
		const file = await this.app.vault.create(path, content);
		await this.leaf.openFile(file);
	}
}
