import type { App } from "obsidian";

/**
 * On-device AI comes from the separate "Home + AI Local" add-on, so the model runtime (several megabytes)
 * only loads on devices that want it. The add-on publishes this interface as `api` on its plugin object.
 */
export interface LocalAI {
	version: 1;
	/** The chosen model's display name, such as "Qwen 3.5 2B". */
	modelName(): string;
	/** Whether this device can run models (WebGPU), and why not if it can't. */
	supported(): Promise<{ ok: boolean; reason?: string }>;
	/** Runs one reply. The model is downloaded and loaded first if needed; `onStatus` reports that progress. */
	chat(
		messages: { role: "system" | "user" | "assistant"; content: string }[],
		opts?: { maxTokens?: number; temperature?: number; onStatus?: (text: string) => void }
	): Promise<string>;
}

export const LOCAL_PLUGIN_ID = "home-ai-local";
export const LOCAL_MODEL = "on-device";

let appRef: App | null = null;

export function setLocalApp(app: App): void {
	appRef = app;
}

/** The add-on's interface, or null if it isn't installed and turned on. */
export function localAI(): LocalAI | null {
	const plugins = (appRef as unknown as { plugins?: { getPlugin(id: string): unknown } } | null)?.plugins;
	const api = (plugins?.getPlugin(LOCAL_PLUGIN_ID) as { api?: LocalAI } | null | undefined)?.api;
	return api?.version === 1 ? api : null;
}

export const NO_LOCAL_ADDON = "On-device AI needs the Home + AI Local add-on. Install it from Community plugins, turn it on, then try again.";
