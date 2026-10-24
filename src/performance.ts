import { App, Platform, normalizePath } from "obsidian";

/** What Electron reports for each of Obsidian's processes (the parts used here). */
interface ProcessMetric {
	type: string;
	cpu: { percentCPUUsage: number };
	/** In kilobytes. */
	memory: { workingSetSize: number };
}

export interface Usage {
	/** Percent of one CPU core, added up across Obsidian's processes. */
	cpu: number;
	memoryMB: number;
	processes: number;
}

function electronApp(): { getAppMetrics(): ProcessMetric[] } | null {
	if (!Platform.isDesktopApp) return null;
	return (window as unknown as { electron?: { remote?: { app?: { getAppMetrics(): ProcessMetric[] } } } }).electron?.remote?.app ?? null;
}

/** Obsidian's current CPU and memory use, or null where it can't be measured (phones and tablets). */
export function currentUsage(): Usage | null {
	try {
		const metrics = electronApp()?.getAppMetrics();
		if (!metrics?.length) return null;
		return {
			cpu: metrics.reduce((n, m) => n + (m.cpu?.percentCPUUsage ?? 0), 0),
			memoryMB: Math.round(metrics.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0) / 1024),
			processes: metrics.length,
		};
	} catch {
		return null;
	}
}

export interface PluginSize {
	id: string;
	name: string;
	/** Size of the plugin's code in megabytes. Bigger plugins usually take more memory and slow startup. */
	sizeMB: number;
}

/** Turned-on community plugins, biggest first, measured by the size of their code. */
export async function enabledPluginSizes(app: App): Promise<PluginSize[]> {
	const adapter = app.vault.adapter;
	const dir = normalizePath(`${app.vault.configDir}/plugins`);
	let enabled: string[] = [];
	try {
		enabled = JSON.parse(await adapter.read(normalizePath(`${app.vault.configDir}/community-plugins.json`))) as string[];
	} catch {
		return [];
	}
	const out: PluginSize[] = [];
	for (const id of enabled) {
		try {
			const stat = await adapter.stat(`${dir}/${id}/main.js`);
			let name = id;
			try {
				name = (JSON.parse(await adapter.read(`${dir}/${id}/manifest.json`)) as { name?: string }).name ?? id;
			} catch {
				// Keep the id as the name.
			}
			out.push({ id, name, sizeMB: (stat?.size ?? 0) / 1024 / 1024 });
		} catch {
			// Plugin folder missing; skip it.
		}
	}
	return out.sort((a, b) => b.sizeMB - a.sizeMB);
}
