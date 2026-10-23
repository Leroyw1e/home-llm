import { Notice, debounce } from "obsidian";
import type HomeLLMPlugin from "./main";
import { notifyOutsideApp } from "./menubar";
import { moment } from "./time";

export type FocusMode = "focus" | "short" | "long";

export const FOCUS_LABELS: Record<FocusMode, string> = {
	focus: "Focus",
	short: "Short break",
	long: "Long break",
};

/** Saved with the settings, so the timer carries on after Obsidian restarts. */
export interface FocusState {
	mode: FocusMode;
	/** When the running timer reaches zero (ms since 1970), or null while paused. */
	endAt: number | null;
	/** Time left while paused, in ms. */
	left: number;
	/** Length of the current session when it was set up, in ms. */
	full?: number;
	/** Focus sessions finished today. */
	done: number;
	day: string;
}

export function formatClock(ms: number): string {
	const total = Math.ceil(ms / 1000);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A Pomodoro timer: focus sessions with short breaks, and a long break every few sessions. */
export class FocusTimer {
	private listeners = new Set<() => void>();
	state: FocusState;
	private saveSoon = debounce(() => void this.plugin.saveSettings(), 1000, true);

	constructor(private plugin: HomeLLMPlugin) {
		const saved = plugin.settings.focusState;
		this.state = saved ?? { mode: "focus", endAt: null, left: this.length("focus"), full: this.length("focus"), done: 0, day: moment().format("YYYY-MM-DD") };
		this.newDay();
	}

	length(mode: FocusMode): number {
		const s = this.plugin.settings;
		return (mode === "focus" ? s.focusMinutes : mode === "short" ? s.focusShortBreak : s.focusLongBreak) * 60_000;
	}

	get running(): boolean {
		return this.state.endAt !== null;
	}

	get left(): number {
		return this.state.endAt !== null ? Math.max(0, this.state.endAt - Date.now()) : this.state.left;
	}

	private get full(): number {
		return this.state.full ?? this.length(this.state.mode);
	}

	/** Started, or paused part-way through. */
	get active(): boolean {
		return this.running || this.state.left < this.full;
	}

	/** How much of the current session has gone, from 0 to 1. */
	get progress(): number {
		return this.full ? Math.min(1, 1 - this.left / this.full) : 0;
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(save = true): void {
		for (const fn of this.listeners) fn();
		if (save) {
			this.plugin.settings.focusState = this.state;
			this.saveSoon();
		}
	}

	private newDay(): void {
		const today = moment().format("YYYY-MM-DD");
		if (this.state.day !== today) this.state = { ...this.state, done: 0, day: today };
	}

	start(): void {
		if (this.running) return;
		this.state.endAt = Date.now() + (this.state.left > 0 ? this.state.left : this.length(this.state.mode));
		this.changed();
	}

	pause(): void {
		if (!this.running) return;
		this.state.left = this.left;
		this.state.endAt = null;
		this.changed();
	}

	toggle(): void {
		if (this.running) this.pause();
		else this.start();
	}

	/** Back to the start of the current session, paused. */
	reset(): void {
		this.state.endAt = null;
		this.state.left = this.state.full = this.length(this.state.mode);
		this.changed();
	}

	setMode(mode: FocusMode): void {
		this.state.mode = mode;
		this.reset();
	}

	/** Moves on to the next session without counting this one. */
	skip(): void {
		this.setMode(this.nextMode());
	}

	private nextMode(): FocusMode {
		if (this.state.mode !== "focus") return "focus";
		return this.state.done > 0 && this.state.done % this.plugin.settings.focusLongEvery === 0 ? "long" : "short";
	}

	/** Called every second by the plugin. */
	tick(): void {
		if (!this.running) return;
		if (this.left > 0) {
			this.changed(false);
			return;
		}
		this.newDay();
		const finished = this.state.mode;
		if (finished === "focus") this.state.done++;
		this.state.mode = this.nextMode();
		this.state.endAt = null;
		this.state.left = this.state.full = this.length(this.state.mode);
		this.changed();
		if (this.plugin.settings.focusSound) chime();
		const message = finished === "focus" ? `Focus session done! Time for a ${this.state.mode === "long" ? "long" : "short"} break.` : "Break's over. Ready to focus?";
		new Notice(message, 8000);
		notifyOutsideApp("Focus timer", message);
		if (this.plugin.settings.focusAutoStart) this.start();
	}

	/** Re-reads lengths after the settings change, if the timer hasn't started. */
	refresh(): void {
		if (!this.active) this.state.left = this.state.full = this.length(this.state.mode);
		this.changed();
	}
}

/** A soft two-note chime, made in code so there's no sound file. */
function chime(): void {
	try {
		const ctx = new AudioContext();
		const at = ctx.currentTime;
		[659.25, 880].forEach((freq, i) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			gain.gain.setValueAtTime(0, at + i * 0.18);
			gain.gain.linearRampToValueAtTime(0.25, at + i * 0.18 + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.18 + 1.2);
			osc.connect(gain).connect(ctx.destination);
			osc.start(at + i * 0.18);
			osc.stop(at + i * 0.18 + 1.3);
		});
		window.setTimeout(() => void ctx.close(), 2000);
	} catch {
		// No sound available; the notice still shows.
	}
}
