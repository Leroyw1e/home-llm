import { App, TFile, normalizePath } from "obsidian";
import { Moment, moment } from "./time";

export interface DailyNoteConfig {
	folder: string;
	format: string;
	template: string;
}

export const DEFAULT_DAILY: DailyNoteConfig = { folder: "", format: "YYYY-MM-DD", template: "" };

/** Reads the core Daily notes settings (folder, date format, template) from the vault's config folder. */
export async function loadDailyConfig(app: App): Promise<DailyNoteConfig> {
	const path = normalizePath(`${app.vault.configDir}/daily-notes.json`);
	try {
		if (!(await app.vault.adapter.exists(path))) return { ...DEFAULT_DAILY };
		const raw = JSON.parse(await app.vault.adapter.read(path)) as Partial<DailyNoteConfig>;
		return {
			folder: (raw.folder ?? "").trim(),
			format: raw.format || DEFAULT_DAILY.format,
			template: (raw.template ?? "").trim(),
		};
	} catch {
		return { ...DEFAULT_DAILY };
	}
}

export function dailyPath(cfg: DailyNoteConfig, day: Moment): string {
	const name = day.format(cfg.format);
	return normalizePath(cfg.folder ? `${cfg.folder}/${name}.md` : `${name}.md`);
}

/** Fills in the template's {{date}}, {{time}} and {{title}} placeholders, including {{date:FORMAT}}. */
async function fillTemplate(app: App, cfg: DailyNoteConfig, day: Moment): Promise<string> {
	if (!cfg.template) return "";
	const tpl = app.vault.getAbstractFileByPath(normalizePath(cfg.template.endsWith(".md") ? cfg.template : `${cfg.template}.md`));
	if (!(tpl instanceof TFile)) return "";
	const text = await app.vault.cachedRead(tpl);
	return text
		.replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/gi, (_m, fmt: string) => day.format(fmt))
		.replace(/\{\{\s*time\s*:\s*([^}]+?)\s*\}\}/gi, (_m, fmt: string) => moment().format(fmt))
		.replace(/\{\{\s*date\s*\}\}/gi, day.format(cfg.format))
		.replace(/\{\{\s*time\s*\}\}/gi, moment().format("HH:mm"))
		.replace(/\{\{\s*title\s*\}\}/gi, day.format(cfg.format));
}

/** Returns the daily note for a day, creating it (with the template) if it doesn't exist yet. */
export async function getOrCreateDaily(app: App, cfg: DailyNoteConfig, day: Moment): Promise<TFile | null> {
	const path = dailyPath(cfg, day);
	let file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
		file = await app.vault.create(path, await fillTemplate(app, cfg, day));
	}
	return file instanceof TFile ? file : null;
}
