import { requestUrl } from "obsidian";
import type { HomeLLMSettings, ProviderId } from "./settings";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export function modelFor(s: HomeLLMSettings, p: ProviderId): string {
	switch (p) {
		case "anthropic":
			return s.anthropicModel;
		case "openai":
			return s.openaiModel;
		case "openrouter":
			return s.openrouterModel;
		case "custom":
			return s.customModel;
	}
}

interface OpenAIResponse {
	choices?: { message?: { content?: unknown } }[];
}

interface AnthropicResponse {
	content?: { type: string; text?: string }[];
}

/** Sends a conversation to the chosen provider and returns the reply text. */
export async function sendChat(s: HomeLLMSettings, provider: ProviderId, model: string, messages: ChatMessage[], system: string): Promise<string> {
	if (provider === "anthropic") return sendAnthropic(s, model, messages, system);

	let base: string;
	let key: string;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (provider === "openai") {
		base = "https://api.openai.com/v1";
		key = s.openaiKey;
	} else if (provider === "openrouter") {
		base = "https://openrouter.ai/api/v1";
		key = s.openrouterKey;
		headers["HTTP-Referer"] = "https://obsidian.md";
		headers["X-Title"] = "Home & LLM";
	} else {
		base = s.customBaseUrl.replace(/\/+$/, "");
		key = s.customKey;
	}
	if (provider !== "custom" && !key) throw new Error(`No API key set for ${provider}. Add it in plugin settings.`);
	if (key) headers["Authorization"] = `Bearer ${key}`;

	const res = await requestUrl({
		url: `${base}/chat/completions`,
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			temperature: s.temperature,
			max_tokens: s.maxTokens,
			messages: [{ role: "system", content: system }, ...messages],
		}),
		throw: false,
	});
	if (res.status >= 400) throw new Error(errorText(res.status, res.text));
	const text = (res.json as OpenAIResponse | undefined)?.choices?.[0]?.message?.content;
	if (typeof text !== "string") throw new Error("Unexpected response: " + res.text.slice(0, 300));
	return text;
}

async function sendAnthropic(s: HomeLLMSettings, model: string, messages: ChatMessage[], system: string): Promise<string> {
	if (!s.anthropicKey) throw new Error("No Anthropic API key set. Add it in plugin settings.");
	const res = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": s.anthropicKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({ model, max_tokens: s.maxTokens, temperature: s.temperature, system, messages }),
		throw: false,
	});
	if (res.status >= 400) throw new Error(errorText(res.status, res.text));
	const blocks = (res.json as AnthropicResponse | undefined)?.content;
	if (!Array.isArray(blocks)) throw new Error("Unexpected response: " + res.text.slice(0, 300));
	return blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

function errorText(status: number, body: string): string {
	try {
		const j = JSON.parse(body) as { error?: { message?: string }; message?: string };
		return `HTTP ${status}: ${j.error?.message ?? j.message ?? body}`;
	} catch {
		return `HTTP ${status}: ${body.slice(0, 300)}`;
	}
}
