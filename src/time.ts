import { moment as obsidianMoment } from "obsidian";
import type momentFn from "moment";

/**
 * Obsidian's bundled copy of moment.js. Obsidian types it as a namespace, which newer TypeScript
 * no longer treats as callable, so re-type it as the moment function.
 */
export const moment = obsidianMoment as unknown as typeof momentFn;
export type { Moment } from "moment";
