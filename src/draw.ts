import { ItemView, Menu, Notice, Platform, TFile, View, setIcon, setTooltip } from "obsidian";
import { getStroke } from "perfect-freehand";
import type HomeLLMPlugin from "./main";
import { moment } from "./time";

/**
 * Freeform-style drawing for Obsidian Canvas. Strokes are drawn on a layer over the canvas that follows its
 * panning and zooming; when you press Done they're saved as an SVG file and added to the canvas as a card,
 * so a drawing can be moved, resized and connected like anything else. The stroke data is kept inside the
 * SVG, so a drawing can be opened again and changed.
 */

type Tool = "pen" | "marker" | "eraser" | "line" | "arrow" | "rect" | "ellipse";
type InkTool = Exclude<Tool, "eraser">;

interface Stroke {
	tool: InkTool;
	colour: string;
	/** Width in canvas units. */
	size: number;
	/** [x, y, pressure] in canvas units. Shapes have just a start and an end. */
	points: number[][];
	/** Whether the pressure came from a pen (otherwise it's simulated from speed). */
	pressure?: boolean;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The parts of Obsidian's (unpublished) canvas API used here. */
interface CanvasNode extends Box {
	file?: TFile;
	nodeEl: HTMLElement;
	setColor(colour: string): void;
	moveAndResize(box: Box): void;
}
interface Canvas {
	x: number;
	y: number;
	scale: number;
	readonly: boolean;
	wrapperEl: HTMLElement;
	cardMenuEl?: HTMLElement;
	posFromEvt(e: MouseEvent): { x: number; y: number };
	posCenter(): { x: number; y: number };
	createFileNode(o: { pos: { x: number; y: number }; size: { width: number; height: number }; file: TFile; save?: boolean; focus?: boolean }): CanvasNode;
	createTextNode(o: { pos: { x: number; y: number }; position?: string; size?: { width: number; height: number }; text?: string; save?: boolean; focus?: boolean }): CanvasNode;
	removeNode(node: CanvasNode): void;
	deselectAll(): void;
	requestSave(): void;
}
type CanvasView = ItemView & { canvas?: Canvas; file: TFile | null };

const TOOLS: { id: Tool; icon: string; label: string }[] = [
	{ id: "pen", icon: "pen-tool", label: "Pen" },
	{ id: "marker", icon: "highlighter", label: "Highlighter" },
	{ id: "eraser", icon: "eraser", label: "Eraser" },
	{ id: "line", icon: "minus", label: "Line" },
	{ id: "arrow", icon: "move-up-right", label: "Arrow" },
	{ id: "rect", icon: "square", label: "Rectangle" },
	{ id: "ellipse", icon: "circle", label: "Oval" },
];
/** "ink" is black on light themes and white on dark ones. */
const COLOURS = ["ink", "#8a5cf5", "#e93147", "#ec7500", "#e0ac00", "#08b94e", "#086ddd"];
/** Pen widths on screen, in pixels. */
const SIZES = [3, 6, 12];
const META_ID = "home-ai-drawing";

export function isCanvasView(view: View | null | undefined): view is CanvasView {
	return view instanceof ItemView && view.getViewType() === "canvas" && !!(view as CanvasView).canvas;
}

/** Turns perfect-freehand's outline points into a smooth SVG path. */
function outlinePath(pts: number[][]): string {
	if (pts.length < 2) return "";
	const parts: string[] = [`M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}Q`];
	for (let i = 0; i < pts.length; i++) {
		const [x0, y0] = pts[i];
		const [x1, y1] = pts[(i + 1) % pts.length];
		parts.push(`${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`);
	}
	return parts.join(" ") + "Z";
}

/** SVG for one stroke, with the colour already worked out. */
function strokeSvg(s: Stroke, colour: string): { tag: "path"; attrs: Record<string, string> } {
	const [a, b] = [s.points[0], s.points[s.points.length - 1]];
	if (s.tool === "pen" || s.tool === "marker") {
		const marker = s.tool === "marker";
		const outline = getStroke(s.points, {
			size: s.size,
			thinning: marker ? 0 : 0.6,
			smoothing: 0.5,
			streamline: 0.45,
			simulatePressure: !marker && !s.pressure,
			last: true,
		});
		return { tag: "path", attrs: { d: outlinePath(outline), fill: colour, ...(marker ? { opacity: "0.35" } : {}) } };
	}
	const line = { fill: "none", stroke: colour, "stroke-width": String(s.size), "stroke-linecap": "round", "stroke-linejoin": "round" };
	if (s.tool === "line") return { tag: "path", attrs: { d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, ...line } };
	if (s.tool === "arrow") {
		const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
		const head = Math.max(10, s.size * 4);
		const p = (d: number) => `${b[0] - head * Math.cos(angle + d)} ${b[1] - head * Math.sin(angle + d)}`;
		return { tag: "path", attrs: { d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}M${p(0.45)}L${b[0]} ${b[1]}L${p(-0.45)}`, ...line } };
	}
	const x = Math.min(a[0], b[0]);
	const y = Math.min(a[1], b[1]);
	const w = Math.abs(b[0] - a[0]);
	const h = Math.abs(b[1] - a[1]);
	if (s.tool === "rect") {
		const r = Math.min(12, w / 4, h / 4);
		return { tag: "path", attrs: { d: `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`, ...line } };
	}
	const rx = w / 2;
	const ry = h / 2;
	const cx = x + rx;
	const cy = y + ry;
	return { tag: "path", attrs: { d: `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`, ...line } };
}

/** Points along a stroke, for the eraser to test against. Shapes are sampled along their outline. */
function strokeSamples(s: Stroke): number[][] {
	if (s.tool === "pen" || s.tool === "marker") return s.points;
	const [a, b] = [s.points[0], s.points[s.points.length - 1]];
	const out: number[][] = [];
	const n = 48;
	if (s.tool === "line" || s.tool === "arrow") {
		for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
	} else if (s.tool === "rect") {
		const corners = [a, [b[0], a[1]], b, [a[0], b[1]], a];
		for (let c = 0; c < 4; c++) for (let i = 0; i <= n / 4; i++) out.push([corners[c][0] + ((corners[c + 1][0] - corners[c][0]) * i * 4) / n, corners[c][1] + ((corners[c + 1][1] - corners[c][1]) * i * 4) / n]);
	} else {
		const cx = (a[0] + b[0]) / 2;
		const cy = (a[1] + b[1]) / 2;
		for (let i = 0; i < n; i++) out.push([cx + (Math.abs(b[0] - a[0]) / 2) * Math.cos((i / n) * Math.PI * 2), cy + (Math.abs(b[1] - a[1]) / 2) * Math.sin((i / n) * Math.PI * 2)]);
	}
	return out;
}

function bounds(strokes: Stroke[]): Box {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of strokes) {
		const pad = s.tool === "marker" ? s.size : s.tool === "arrow" ? Math.max(10, s.size * 4) : s.size;
		for (const [x, y] of strokeSamples(s)) {
			minX = Math.min(minX, x - pad);
			minY = Math.min(minY, y - pad);
			maxX = Math.max(maxX, x + pad);
			maxY = Math.max(maxY, y + pad);
		}
	}
	return { x: Math.floor(minX), y: Math.floor(minY), width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };
}

/** A whole drawing as an SVG file, with its strokes stored inside so it can be edited later. */
export function drawingSvg(strokes: Stroke[], ink: string): string {
	const box = bounds(strokes);
	const meta = JSON.stringify({ v: 1, box, strokes }).replace(/</g, "\\u003c");
	const body = strokes
		.map((s) => {
			const { tag, attrs } = strokeSvg(s, s.colour === "ink" ? ink : s.colour);
			return `<${tag} ${Object.entries(attrs)
				.map(([k, v]) => `${k}="${v}"`)
				.join(" ")}/>`;
		})
		.join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${box.width}" height="${box.height}">\n<metadata id="${META_ID}">${meta}</metadata>\n${body}\n</svg>\n`;
}

/** Reads the strokes back out of a drawing, moved and scaled to where its card is now. */
export function strokesFromSvg(svg: string, card: Box): Stroke[] | null {
	const m = new RegExp(`<metadata id="${META_ID}">([\\s\\S]*?)</metadata>`).exec(svg);
	if (!m) return null;
	try {
		const data = JSON.parse(m[1]) as { box: Box; strokes: Stroke[] };
		const sx = card.width / Math.max(1, data.box.width);
		const sy = card.height / Math.max(1, data.box.height);
		return data.strokes.map((s) => ({
			...s,
			size: s.size * Math.sqrt(sx * sy),
			points: s.points.map(([x, y, p]) => [card.x + (x - data.box.x) * sx, card.y + (y - data.box.y) * sy, p]),
		}));
	} catch {
		return null;
	}
}

/** One drawing session on one canvas. */
class InkSession {
	strokes: Stroke[] = [];
	private undoStack: Stroke[][] = [];
	private redoStack: Stroke[][] = [];
	private svg: SVGSVGElement;
	private layer: SVGGElement;
	private live: SVGPathElement | null = null;
	private current: Stroke | null = null;
	private erasing = false;
	private lastErase: { x: number; y: number } | null = null;
	private palette: HTMLElement;
	private frame = 0;
	private lastView = "";
	private toolButtons = new Map<Tool, HTMLElement>();
	private colourButtons = new Map<string, HTMLElement>();
	private sizeButtons = new Map<number, HTMLElement>();
	private fingerButton: HTMLElement | null = null;

	constructor(
		private ink: CanvasInk,
		readonly view: CanvasView,
		readonly canvas: Canvas,
		/** The drawing card being changed, or null for a new drawing. */
		readonly editing: CanvasNode | null
	) {
		const wrapper = canvas.wrapperEl;
		this.svg = wrapper.createSvg("svg", { cls: "hl-ink-layer" });
		this.layer = this.svg.createSvg("g");
		view.contentEl.addClass("hl-ink-active");
		editing?.nodeEl.addClass("hl-ink-hidden");
		this.palette = this.buildPalette();
		this.tick();
	}

	private get settings() {
		return this.ink.plugin.settings;
	}

	/** Black or white ink, whichever shows on the current theme. */
	inkColour(): string {
		return activeDocument.body.hasClass("theme-dark") ? "#f2f2f2" : "#1e1e1e";
	}

	/** Keeps the layer lined up with the canvas while it's panned or zoomed. */
	private tick = (): void => {
		this.frame = window.requestAnimationFrame(this.tick);
		const c = this.canvas;
		const w = c.wrapperEl.clientWidth;
		const h = c.wrapperEl.clientHeight;
		const key = `${c.x}|${c.y}|${c.scale}|${w}|${h}`;
		if (key === this.lastView) return;
		this.lastView = key;
		this.layer.setAttribute("transform", `translate(${w / 2} ${h / 2}) scale(${c.scale}) translate(${-c.x} ${-c.y})`);
	};

	setStrokes(strokes: Stroke[]): void {
		this.strokes = strokes;
		this.redraw();
	}

	private redraw(): void {
		this.layer.empty();
		for (const s of this.strokes) this.addPath(s);
		this.live = null;
	}

	private addPath(s: Stroke): SVGPathElement {
		const { attrs } = strokeSvg(s, s.colour === "ink" ? this.inkColour() : s.colour);
		const path = this.layer.createSvg("path");
		for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
		return path;
	}

	private remember(): void {
		this.undoStack.push(this.strokes.slice());
		this.redoStack = [];
	}

	undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.strokes);
		this.setStrokes(prev);
	}

	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.strokes);
		this.setStrokes(next);
	}

	// ---------- Pointer input ----------

	/** Whether this pointer should draw. Apple Pencil always draws; fingers scroll unless "draw with finger" is on. */
	wants(e: PointerEvent): boolean {
		if (e.pointerType === "pen") return true;
		if (e.pointerType === "touch") return this.settings.drawWithFinger;
		return e.button === 0 && !e.metaKey && !e.ctrlKey;
	}

	down(e: PointerEvent): void {
		const tool = this.settings.drawTool as Tool;
		const pos = this.canvas.posFromEvt(e);
		if (tool === "eraser") {
			this.erasing = true;
			this.remember();
			this.eraseAt(pos);
			return;
		}
		this.current = {
			tool,
			colour: this.settings.drawColour,
			// Sizes are picked on screen, so a stroke looks the same width at any zoom.
			size: (tool === "marker" ? this.settings.drawSize * 3.5 : this.settings.drawSize) / this.canvas.scale,
			points: [[pos.x, pos.y, e.pointerType === "pen" ? e.pressure || 0.5 : 0.5]],
			pressure: e.pointerType === "pen",
		};
		this.live = this.addPath(this.current);
	}

	move(e: PointerEvent): void {
		const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
		if (this.erasing) {
			for (const ev of events.length ? events : [e]) this.eraseAt(this.canvas.posFromEvt(ev));
			return;
		}
		const s = this.current;
		if (!s) return;
		const shape = s.tool !== "pen" && s.tool !== "marker";
		for (const ev of events.length ? events : [e]) {
			const pos = this.canvas.posFromEvt(ev);
			const point = [pos.x, pos.y, ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5];
			if (shape) s.points[1] = point;
			else s.points.push(point);
		}
		if (shape && e.shiftKey && s.points[1]) s.points[1] = this.constrain(s.points[0], s.points[1], s.tool);
		const { attrs } = strokeSvg(s, s.colour === "ink" ? this.inkColour() : s.colour);
		if (this.live) for (const [k, v] of Object.entries(attrs)) this.live.setAttribute(k, v);
	}

	/** Shift makes squares, circles and straight 45° lines. */
	private constrain(a: number[], b: number[], tool: InkTool): number[] {
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		if (tool === "rect" || tool === "ellipse") {
			const d = Math.max(Math.abs(dx), Math.abs(dy));
			return [a[0] + Math.sign(dx || 1) * d, a[1] + Math.sign(dy || 1) * d, b[2]];
		}
		const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
		const len = Math.hypot(dx, dy);
		return [a[0] + Math.cos(angle) * len, a[1] + Math.sin(angle) * len, b[2]];
	}

	up(): void {
		if (this.erasing) {
			this.erasing = false;
			this.lastErase = null;
			// Nothing was erased: drop the undo step this gesture added.
			const last = this.undoStack[this.undoStack.length - 1];
			if (last && last.length === this.strokes.length) this.undoStack.pop();
			return;
		}
		const s = this.current;
		this.current = null;
		if (!s) return;
		const shape = s.tool !== "pen" && s.tool !== "marker";
		const tiny = shape ? !s.points[1] || Math.hypot(s.points[1][0] - s.points[0][0], s.points[1][1] - s.points[0][1]) < 2 / this.canvas.scale : false;
		if (tiny) {
			this.live?.remove();
			this.live = null;
			return;
		}
		this.remember();
		this.strokes = [...this.strokes, s];
		this.live = null;
	}

	/** Removes every stroke the eraser touches, checking along the path since the last position so fast swipes don't skip lines. */
	private eraseAt(pos: { x: number; y: number }): void {
		const reach = 10 / this.canvas.scale;
		const from = this.lastErase ?? pos;
		this.lastErase = pos;
		const steps = Math.max(1, Math.ceil(Math.hypot(pos.x - from.x, pos.y - from.y) / (reach / 2)));
		const probes = Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((pos.x - from.x) * i) / steps, y: from.y + ((pos.y - from.y) * i) / steps }));
		const keep = this.strokes.filter((s) => {
			const r = reach + s.size / 2;
			return !strokeSamples(s).some(([x, y]) => probes.some((p) => Math.hypot(x - p.x, y - p.y) < r));
		});
		if (keep.length !== this.strokes.length) this.setStrokes(keep);
	}

	// ---------- Palette ----------

	private buildPalette(): HTMLElement {
		const bar = this.view.contentEl.createDiv("hl-ink-palette" + (Platform.isMobile ? " is-mobile" : ""));
		const group = () => bar.createDiv("hl-ink-group");
		const button = (parent: HTMLElement, icon: string, label: string, fn: () => void, cls = "") => {
			const b = parent.createEl("button", { cls: "hl-ink-btn clickable-icon " + cls, attr: { "aria-label": label } });
			setIcon(b, icon);
			setTooltip(b, label, { placement: "top" });
			b.onclick = fn;
			return b;
		};

		const tools = group();
		for (const t of TOOLS) this.toolButtons.set(t.id, button(tools, t.icon, t.label, () => this.pick({ drawTool: t.id })));

		const colours = group();
		for (const c of COLOURS) {
			const b = colours.createEl("button", { cls: "hl-ink-swatch", attr: { "aria-label": c === "ink" ? "Black or white" : c } });
			b.setCssProps({ "--hl-swatch": c === "ink" ? "var(--text-normal)" : c });
			b.onclick = () => this.pick({ drawColour: c });
			this.colourButtons.set(c, b);
		}

		const sizes = group();
		for (const sz of SIZES) {
			const b = sizes.createEl("button", { cls: "hl-ink-size", attr: { "aria-label": sz === SIZES[0] ? "Thin" : sz === SIZES[1] ? "Medium" : "Thick" } });
			b.createSpan("hl-ink-size-dot").setCssProps({ "--hl-dot": `${4 + sz}px` });
			b.onclick = () => this.pick({ drawSize: sz });
			this.sizeButtons.set(sz, b);
		}

		const history = group();
		button(history, "undo-2", "Undo", () => this.undo());
		button(history, "redo-2", "Redo", () => this.redo());
		if (Platform.isMobile) this.fingerButton = button(history, "pointer", "Draw with finger", () => this.pick({ drawWithFinger: !this.settings.drawWithFinger }));

		const end = bar.createDiv("hl-ink-group");
		const done = end.createEl("button", { cls: "mod-cta hl-ink-done", text: "Done" });
		done.onclick = () => void this.ink.finish(true);
		const cancel = button(end, "x", "Discard changes", () => void this.ink.finish(false));
		cancel.addClass("hl-ink-cancel");
		this.showChoices();
		return bar;
	}

	private pick(change: Partial<HomeLLMPlugin["settings"]>): void {
		Object.assign(this.settings, change);
		void this.ink.plugin.saveSettings();
		this.showChoices();
	}

	private showChoices(): void {
		const s = this.settings;
		for (const [t, b] of this.toolButtons) b.toggleClass("is-active", t === s.drawTool);
		for (const [c, b] of this.colourButtons) b.toggleClass("is-active", c === s.drawColour);
		for (const [sz, b] of this.sizeButtons) b.toggleClass("is-active", sz === s.drawSize);
		this.fingerButton?.toggleClass("is-active", s.drawWithFinger);
		this.view.contentEl.toggleClass("hl-ink-erasing", s.drawTool === "eraser");
	}

	close(): void {
		window.cancelAnimationFrame(this.frame);
		this.svg.remove();
		this.palette.remove();
		this.view.contentEl.removeClass("hl-ink-active", "hl-ink-erasing");
		this.editing?.nodeEl.removeClass("hl-ink-hidden");
	}
}

/** Adds drawing and sticky notes to every open canvas. */
export class CanvasInk {
	private session: InkSession | null = null;
	private wired = new WeakSet<View>();
	private pointer: number | null = null;

	constructor(readonly plugin: HomeLLMPlugin) {}

	get drawing(): boolean {
		return !!this.session;
	}

	/** Adds the Draw and Sticky note buttons and the pencil listener to canvases that don't have them yet. */
	wireCanvases(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view;
			if (!isCanvasView(view) || this.wired.has(view)) continue;
			this.wired.add(view);
			this.addButtons(view);
			// Capture on the view (above the canvas) so a pen stroke never reaches the canvas's own handlers.
			this.plugin.registerDomEvent(view.contentEl, "pointerdown", (e) => this.onPointerDown(view, e), { capture: true });
			this.plugin.registerDomEvent(view.contentEl, "pointermove", (e) => this.onPointerMove(e), { capture: true });
			this.plugin.registerDomEvent(view.contentEl, "pointerup", (e) => this.onPointerUp(e), { capture: true });
			this.plugin.registerDomEvent(view.contentEl, "pointercancel", (e) => this.onPointerUp(e), { capture: true });
		}
		this.showButtons();
	}

	/** Hides or shows the buttons when the feature is switched. */
	showButtons(): void {
		const on = this.plugin.isOn("draw");
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("canvas")) {
			leaf.view.containerEl.querySelectorAll(".hl-ink-menu-btn").forEach((b) => b.toggleClass("hl-hidden", !on));
		}
		if (!on && this.session) void this.finish(true);
	}

	private addButtons(view: CanvasView): void {
		const menu = view.canvas?.cardMenuEl;
		if (!menu) return;
		const add = (icon: string, label: string, fn: () => void) => {
			const b = menu.createDiv({ cls: "canvas-card-menu-button hl-ink-menu-btn" });
			setIcon(b, icon);
			setTooltip(b, label, { placement: "top" });
			b.addEventListener("click", fn);
		};
		add("pen-tool", "Draw", () => this.start(view));
		add("sticky-note", "Add sticky note", () => this.addSticky(view));
	}

	start(view: CanvasView, editing: CanvasNode | null = null, strokes: Stroke[] = []): void {
		const canvas = view.canvas;
		if (!canvas) return;
		if (canvas.readonly) {
			new Notice("This canvas is read-only. Unlock it to draw.");
			return;
		}
		if (this.session) void this.finish(true);
		canvas.deselectAll();
		this.session = new InkSession(this, view, canvas, editing);
		if (strokes.length) this.session.setStrokes(strokes);
	}

	/** Opens a drawing card so it can be changed. */
	async edit(view: CanvasView, node: CanvasNode): Promise<void> {
		const file = node.file;
		if (!file) return;
		const strokes = strokesFromSvg(await this.plugin.app.vault.cachedRead(file), node);
		if (!strokes) {
			new Notice("This image wasn't drawn here, so it can't be edited.");
			return;
		}
		this.start(view, node, strokes);
	}

	/** Ends drawing, saving the strokes as a drawing card (or throwing them away). */
	async finish(save: boolean): Promise<void> {
		const session = this.session;
		if (!session) return;
		this.session = null;
		this.pointer = null;
		session.close();
		if (!save) return;
		const { canvas, editing, strokes, view } = session;
		const app = this.plugin.app;
		try {
			if (!strokes.length) {
				// Everything was erased from an existing drawing: take its card off the canvas.
				if (editing) {
					canvas.removeNode(editing);
					canvas.requestSave();
				}
				return;
			}
			const svg = drawingSvg(strokes, session.inkColour());
			const box = bounds(strokes);
			if (editing?.file) {
				await app.vault.modify(editing.file, svg);
				editing.moveAndResize(box);
				// The card shows the old picture until its image is reloaded.
				const img = editing.nodeEl.querySelector("img");
				if (img) img.src = app.vault.getResourcePath(editing.file);
				canvas.requestSave();
				return;
			}
			const name = `Drawing ${moment().format("YYYY-MM-DD HHmmss")}.svg`;
			const path = await app.fileManager.getAvailablePathForAttachment(name, view.file?.path ?? "");
			const file = await app.vault.create(path, svg);
			canvas.createFileNode({ pos: { x: box.x, y: box.y }, size: { width: box.width, height: box.height }, file, save: true, focus: false });
		} catch (e) {
			new Notice("Couldn't save the drawing: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	/** A yellow, square text card, like a Freeform sticky note. */
	addSticky(view: CanvasView): void {
		const canvas = view.canvas;
		if (!canvas || canvas.readonly) return;
		const node = canvas.createTextNode({ pos: canvas.posCenter(), position: "center", size: { width: 240, height: 240 }, text: "", focus: true });
		node.setColor("3");
		canvas.requestSave();
	}

	/** "Edit drawing" in a drawing card's right-click menu. */
	nodeMenu(menu: Menu, node: CanvasNode): void {
		if (!this.plugin.isOn("draw") || node.file?.extension !== "svg") return;
		const view = this.plugin.app.workspace.getMostRecentLeaf()?.view;
		if (!isCanvasView(view)) return;
		menu.addItem((it) =>
			it
				.setTitle("Edit drawing")
				.setIcon("pen-tool")
				.onClick(() => void this.edit(view, node))
		);
	}

	private onPointerDown(view: CanvasView, e: PointerEvent): void {
		if (!this.plugin.isOn("draw")) return;
		// Clicks on the drawing palette are buttons, not strokes.
		if (e.target instanceof Element && e.target.closest(".hl-ink-palette, .canvas-card-menu, .canvas-controls")) return;
		let session = this.session;
		// Like Freeform: touching the canvas with Apple Pencil starts drawing straight away.
		if (!session && e.pointerType === "pen" && this.plugin.settings.drawWithPencil && view.canvas && !view.canvas.readonly) {
			this.start(view);
			session = this.session;
		}
		if (!session || session.view !== view || !session.wants(e) || this.pointer !== null) return;
		e.preventDefault();
		e.stopPropagation();
		this.pointer = e.pointerId;
		try {
			view.contentEl.setPointerCapture(e.pointerId);
		} catch {
			// Capture isn't essential: moves still arrive while the pointer stays over the canvas.
		}
		session.down(e);
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.session && e.pointerId === this.pointer) {
			e.preventDefault();
			e.stopPropagation();
			this.session.move(e);
		}
	}

	private onPointerUp(e: PointerEvent): void {
		if (this.session && e.pointerId === this.pointer) {
			e.stopPropagation();
			this.pointer = null;
			this.session.up();
		}
	}

	/** Undo, redo, Escape and Enter while drawing. Returns true if the key was used. */
	onKey(e: KeyboardEvent): boolean {
		const s = this.session;
		if (!s) return false;
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		if (mod && e.key.toLowerCase() === "z") {
			if (e.shiftKey) s.redo();
			else s.undo();
		} else if (e.key === "Escape" || e.key === "Enter") {
			void this.finish(true);
		} else return false;
		e.preventDefault();
		return true;
	}

	unload(): void {
		if (this.session) void this.finish(true);
		for (const el of activeDocument.querySelectorAll(".hl-ink-menu-btn")) el.remove();
	}
}
