import { Platform } from "obsidian";
import { FOCUS_LABELS, FocusMode, FocusTimer } from "./focus";

/** The parts of Electron's remote module used here (Obsidian's desktop app provides it). */
interface NativeImage {
	addRepresentation(o: { scaleFactor: number; width: number; height: number; dataURL: string }): void;
}
interface Tray {
	setImage(img: NativeImage): void;
	setTitle(title: string, options?: { fontType?: "monospaced" | "monospacedDigit" }): void;
	setToolTip(text: string): void;
	setContextMenu(menu: unknown): void;
	destroy(): void;
	isDestroyed(): boolean;
}
interface MenuItem {
	label?: string;
	type?: "normal" | "separator" | "radio";
	checked?: boolean;
	enabled?: boolean;
	click?: () => void;
}
interface Remote {
	Tray: new (img: NativeImage) => Tray;
	nativeImage: { createEmpty(): NativeImage };
	Menu: { buildFromTemplate(items: MenuItem[]): unknown };
	getCurrentWindow(): { show(): void; focus(): void };
	getCurrentWebContents(): { setBackgroundThrottling(allowed: boolean): void };
}

function remote(): Remote | null {
	if (!Platform.isDesktopApp) return null;
	return (window as unknown as { electron?: { remote?: Remote } }).electron?.remote ?? null;
}

/**
 * Lets the timer run on time while Obsidian is in the background. Hidden windows normally have their
 * timers slowed to once a minute, which would make the chime late.
 */
export function keepTimerAwake(on: boolean): void {
	try {
		remote()?.getCurrentWebContents().setBackgroundThrottling(!on);
	} catch {
		// Not available; the timer still catches up when Obsidian comes back.
	}
}

/** A system notification, so time's up is seen even when Obsidian isn't in front. */
export function notifyOutsideApp(title: string, body: string): void {
	if (!Platform.isDesktopApp || typeof Notification === "undefined" || activeDocument.hasFocus()) return;
	try {
		new Notification(title, { body, silent: true });
	} catch {
		// Notifications blocked; the in-app notice still shows.
	}
}

/** The focus timer in the Mac menu bar (or Windows tray): a ring showing time left, and the time. */
export class MenuBarTimer {
	private tray: Tray | null = null;
	private menuKey = "";
	private drawnStep = -1;
	private drawnColour = "";
	private shownTitle = "";
	private shownTip = "";

	constructor(
		private timer: FocusTimer,
		private colour: () => string
	) {}

	static supported(): boolean {
		return !!remote();
	}

	show(on: boolean): void {
		if (!on) {
			this.destroy();
			return;
		}
		const r = remote();
		if (!r) return;
		try {
			if (!this.tray || this.tray.isDestroyed()) {
				this.tray = new r.Tray(this.icon(r));
				this.menuKey = "";
				this.shownTitle = "";
			}
			this.update();
		} catch (e) {
			console.error("Home + AI: couldn't add the timer to the menu bar", e);
			this.tray = null;
		}
	}

	/** Called every second and whenever the timer changes. */
	update(): void {
		const r = remote();
		const tray = this.tray;
		if (!r || !tray || tray.isDestroyed()) return;
		const t = this.timer;
		const title = t.active ? ` ${t.clock()}` : "";
		if (title !== this.shownTitle) {
			this.shownTitle = title;
			tray.setTitle(title, { fontType: "monospacedDigit" });
		}
		// Redraw the ring in 2% steps so it isn't redrawn every second.
		const step = Math.round(t.progress * 50);
		if (step !== this.drawnStep || this.colour() !== this.drawnColour) tray.setImage(this.icon(r));
		const tip = t.active ? `${FOCUS_LABELS[t.state.mode]}: ${t.clock()} left${t.running ? "" : " (paused)"}` : "Focus timer";
		if (tip !== this.shownTip) {
			this.shownTip = tip;
			tray.setToolTip(tip);
		}
		const key = `${t.running}|${t.active}|${t.state.mode}`;
		if (key !== this.menuKey) {
			this.menuKey = key;
			tray.setContextMenu(r.Menu.buildFromTemplate(this.menu(r)));
		}
	}

	private menu(r: Remote): MenuItem[] {
		const t = this.timer;
		const items: MenuItem[] = [
			{ label: t.running ? "Pause" : t.active ? "Resume" : "Start", click: () => t.toggle() },
			{ label: "Stop", enabled: t.active || t.state.mode !== "focus", click: () => t.stop() },
			{ label: "Reset", enabled: t.active, click: () => t.reset() },
			{ label: "Skip to next", click: () => t.skip() },
			{ type: "separator" },
		];
		for (const m of Object.keys(FOCUS_LABELS) as FocusMode[]) {
			items.push({ label: `${FOCUS_LABELS[m]} (${t.length(m) / 60_000} min)`, type: "radio", checked: t.state.mode === m, click: () => t.setMode(m) });
		}
		items.push({ type: "separator" }, { label: `${t.state.done} focus session${t.state.done === 1 ? "" : "s"} today`, enabled: false }, { type: "separator" });
		items.push({
			label: "Open Obsidian",
			click: () => {
				const w = r.getCurrentWindow();
				w.show();
				w.focus();
			},
		});
		return items;
	}

	/** An 18-point ring in the timer colour, drawn at double size for sharp Retina screens. */
	private icon(r: Remote): NativeImage {
		const t = this.timer;
		const colour = this.colour();
		this.drawnStep = Math.round(t.progress * 50);
		this.drawnColour = colour;
		const size = 36;
		const canvas = createEl("canvas");
		canvas.width = canvas.height = size;
		const g = canvas.getContext("2d");
		if (g) {
			const c = size / 2;
			const rad = 13;
			g.lineWidth = 4;
			g.strokeStyle = colour;
			g.globalAlpha = 0.3;
			g.beginPath();
			g.arc(c, c, rad, 0, Math.PI * 2);
			g.stroke();
			g.globalAlpha = 1;
			g.lineCap = "round";
			const left = t.active ? 1 - t.progress : 1;
			g.beginPath();
			g.arc(c, c, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
			g.stroke();
			if (!t.active) {
				// Not started: a small play triangle.
				g.fillStyle = colour;
				g.beginPath();
				g.moveTo(c - 3, c - 5.5);
				g.lineTo(c + 5.5, c);
				g.lineTo(c - 3, c + 5.5);
				g.closePath();
				g.fill();
			} else if (!t.running) {
				// Paused: two small bars.
				g.fillStyle = colour;
				g.fillRect(c - 5, c - 5, 3.5, 10);
				g.fillRect(c + 1.5, c - 5, 3.5, 10);
			} else {
				g.fillStyle = colour;
				g.beginPath();
				g.arc(c, c, 4, 0, Math.PI * 2);
				g.fill();
			}
		}
		const img = r.nativeImage.createEmpty();
		img.addRepresentation({ scaleFactor: 2, width: size, height: size, dataURL: canvas.toDataURL("image/png") });
		return img;
	}

	destroy(): void {
		try {
			if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
		} catch {
			// Already gone.
		}
		this.tray = null;
	}
}
