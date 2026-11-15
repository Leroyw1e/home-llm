import type { ProviderId } from "./settings";

/**
 * What a model is good at, with rough ratings out of 10. These come from the model's family and size
 * (pro / standard / mini / nano and so on), not from tests, so a brand-new model gets a sensible estimate
 * from its name rather than nothing.
 */
export interface ModelInfo {
	goodAt: string;
	/** How capable its answers are. */
	smart: number;
	/** How quickly it replies. */
	speed: number;
	/** How far your credit or free limit goes with it (10 = lasts longest). */
	usage: number;
	tags: string[];
	/** True when the model's family wasn't recognised, so the ratings are a guess from its name alone. */
	guess: boolean;
}

type Tier = "top" | "reasoning" | "standard" | "chat" | "small" | "tiny" | "old";

const TIER: Record<Tier, Omit<ModelInfo, "tags" | "guess">> = {
	top: { goodAt: "The hardest work: long documents, tricky problems and careful reasoning. Slow, and uses the most credit.", smart: 10, speed: 3, usage: 2 },
	reasoning: { goodAt: "Maths, science and logic. Thinks step by step before it answers, so it's slower but more careful.", smart: 9, speed: 4, usage: 4 },
	standard: { goodAt: "A great all-rounder for writing, studying and questions about your notes.", smart: 9, speed: 6, usage: 5 },
	chat: { goodAt: "Friendly, conversational answers, the way ChatGPT itself talks.", smart: 8, speed: 7, usage: 5 },
	small: { goodAt: "Everyday chat, spell check and summaries: quick and good enough for most things.", smart: 7, speed: 8, usage: 8 },
	tiny: { goodAt: "Quick jobs like spell check, flashcards and short answers. The fastest and lightest on credit.", smart: 5, speed: 10, usage: 10 },
	old: { goodAt: "An older model. Newer ones are usually smarter and often cheaper.", smart: 4, speed: 8, usage: 7 },
};

function tierOf(provider: ProviderId, id: string): { tier: Tier; known: boolean } {
	const m = id.toLowerCase();
	if (provider === "anthropic") {
		if (m.includes("opus")) return { tier: "top", known: true };
		if (m.includes("sonnet")) return { tier: "standard", known: true };
		if (m.includes("haiku")) return { tier: "small", known: true };
	}
	if (provider === "gemini" || m.includes("gemini")) {
		if (/flash-lite|lite/.test(m)) return { tier: "tiny", known: true };
		if (m.includes("flash")) return { tier: "small", known: true };
		if (m.includes("pro")) return { tier: "top", known: true };
	}
	if (/gpt-3\.5|gpt-4(?!\.1|o)|turbo/.test(m)) return { tier: "old", known: true };
	if (/(^|\/)o\d/.test(m)) return { tier: /mini/.test(m) ? "small" : "reasoning", known: true };
	if (/nano/.test(m)) return { tier: "tiny", known: true };
	if (/mini/.test(m)) return { tier: "small", known: true };
	if (/-pro\b|\bpro\b/.test(m)) return { tier: "top", known: true };
	if (/chat-latest|chatgpt/.test(m)) return { tier: "chat", known: true };
	if (/^gpt-4(o|\.1)/.test(m)) return { tier: "standard", known: true };
	// A plain flagship name ("gpt-5.5") is standard; extra words we don't know ("-sol", "-luna") are a guess.
	return { tier: "standard", known: /^gpt-\d+(\.\d+)?$/.test(m) || provider === "anthropic" };
}

/** Major.minor version in the name, for nudging newer models up a little. */
function version(id: string): number {
	const v = /(?:gpt|gemini|claude-[a-z]+)-(\d+)(?:[.-](\d))?/.exec(id.toLowerCase());
	return v ? Number(v[1]) + (v[2] ? Number(v[2]) / 10 : 0) : 0;
}

const clamp = (n: number) => Math.max(1, Math.min(10, Math.round(n)));

export function modelInfo(provider: ProviderId, id: string, localName?: string): ModelInfo {
	if (provider === "local") {
		const small = /1b|1\.5b/i.test(localName ?? "");
		return {
			goodAt: "Runs on this device: private, free and offline. Simpler answers, and it can't search your notes.",
			smart: small ? 3 : 4,
			speed: small ? 8 : 6,
			usage: 10,
			tags: ["Offline", "Private", "Free"],
			guess: false,
		};
	}
	if (provider === "custom") {
		return { goodAt: "A model on your own server (Ollama, LM Studio and others). How good it is depends on the model you run.", smart: 5, speed: 6, usage: 10, tags: ["Your server", "Free"], guess: true };
	}
	const { tier, known } = tierOf(provider, id);
	const base = TIER[tier];
	// Newer generations of the same size are a bit smarter; very new big ones are a little slower.
	const v = version(id);
	const newer = provider === "openai" ? (v >= 6 ? 1 : v >= 5 ? 0.5 : 0) : 0;
	const tags: string[] = [];
	if (tier === "reasoning" || tier === "top" || (provider === "openai" && v >= 5) || provider === "anthropic") tags.push("Thinks first");
	if (provider === "gemini") tags.push("Free tier");
	if (provider !== "openrouter") tags.push("Uses your notes");
	if (tier === "tiny" || tier === "small") tags.push("Fast");
	if (tier === "top") tags.push("Smartest");
	return {
		goodAt: base.goodAt,
		smart: clamp(base.smart + newer),
		speed: base.speed,
		// The free tier makes Gemini go much further than paid credit.
		usage: clamp(provider === "gemini" ? base.usage + 2 : base.usage),
		tags,
		guess: !known,
	};
}

/** Order for the short list: newest version first, then flagship, small, tiny, top, chat, reasoning, old. */
export function rankModels(provider: ProviderId, ids: string[]): string[] {
	const order: Tier[] = ["standard", "small", "tiny", "top", "chat", "reasoning", "old"];
	return [...ids].sort((a, b) => version(b) - version(a) || order.indexOf(tierOf(provider, a).tier) - order.indexOf(tierOf(provider, b).tier) || a.localeCompare(b));
}
