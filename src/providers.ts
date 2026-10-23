import { requestUrl } from "obsidian";
import type { Effort, HomeLLMSettings, ProviderId } from "./settings";

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

/** Output tokens to allow: current models think before answering, and thinking counts toward this limit. */
export function replyTokens(s: HomeLLMSettings): number {
	return Math.max(s.maxTokens, 4096);
}

export function errorText(status: number, body: string): string {
	try {
		const j = JSON.parse(body) as { error?: { message?: string }; message?: string };
		return `HTTP ${status}: ${j.error?.message ?? j.message ?? body}`;
	} catch {
		return `HTTP ${status}: ${body.slice(0, 300)}`;
	}
}

// ---------- Anthropic ----------

/**
 * Claude Opus 4.7 / Sonnet 5 and newer reject sampling settings such as temperature,
 * so it's only sent to older models that accept it.
 */
function claudeTakesTemperature(model: string): boolean {
	return /^claude-(3|(opus|sonnet|haiku)-4(-[0-6])?$|(opus|sonnet|haiku)-4-[0-6]-)/.test(model);
}

/** Effort works on Claude Opus 4.5+, Sonnet 4.6+ and every 5.x model; older ones reject it. */
function claudeTakesEffort(model: string): boolean {
	return !/^claude-(3|haiku-4|sonnet-4(-[0-5])?($|-\d{8})|opus-4(-[0-4])?($|-\d{8}))/.test(model);
}

/** Models that can hand a declined request to another model server-side ("refusal fallback"). */
function claudeTakesFallbacks(model: string): boolean {
	return /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/.test(model);
}

export interface AnthropicBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

export interface AnthropicReply {
	content: AnthropicBlock[];
	stop_reason?: string;
}

/** Features a provider turned down once this session, so later requests skip them instead of failing again. */
const unsupported = new Set<string>();

/**
 * One Anthropic Messages API call. Adds effort and refusal fallbacks where the model supports them,
 * and retries once without a feature if the API rejects it.
 */
export async function anthropicCall(s: HomeLLMSettings, model: string, body: { system: string; messages: unknown[]; tools?: unknown[] }): Promise<AnthropicReply> {
	if (!s.anthropicKey) throw new Error("No Anthropic API key set. Add it in plugin settings.");
	for (let attempt = 0; attempt < 3; attempt++) {
		const useEffort = !!s.effort && s.effort !== "default" && claudeTakesEffort(model) && !unsupported.has(`effort:${model}`);
		const useFallbacks = claudeTakesFallbacks(model) && !unsupported.has(`fallbacks:${model}`);
		const headers: Record<string, string> = { "Content-Type": "application/json", "x-api-key": s.anthropicKey, "anthropic-version": "2023-06-01" };
		if (useFallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
		const payload: Record<string, unknown> = { model, max_tokens: replyTokens(s), system: body.system, messages: body.messages };
		if (body.tools?.length) payload.tools = body.tools;
		if (claudeTakesTemperature(model)) payload.temperature = s.temperature;
		if (useEffort) payload.output_config = { effort: s.effort };
		if (useFallbacks) payload.fallbacks = "default";

		const res = await requestUrl({ url: "https://api.anthropic.com/v1/messages", method: "POST", headers, body: JSON.stringify(payload), throw: false });
		if (res.status === 400) {
			if (useEffort && /effort|output_config/i.test(res.text)) {
				unsupported.add(`effort:${model}`);
				continue;
			}
			if (useFallbacks && /fallback|anthropic-beta/i.test(res.text)) {
				unsupported.add(`fallbacks:${model}`);
				continue;
			}
		}
		if (res.status >= 400) throw new Error(errorText(res.status, res.text));
		const data = res.json as AnthropicReply | undefined;
		if (!data || !Array.isArray(data.content)) throw new Error("Unexpected response: " + res.text.slice(0, 300));
		// Always check why the model stopped before using what it wrote.
		if (data.stop_reason === "refusal") throw new Error("The model declined this request. Try rewording it, or pick another model.");
		if (data.stop_reason === "max_tokens" && !data.content.some((b) => b.type === "text" && b.text) && !data.content.some((b) => b.type === "tool_use")) {
			throw new Error("The reply was cut off before it finished. Raise Max tokens in settings, or lower the effort.");
		}
		return data;
	}
	throw new Error("The request couldn't be completed.");
}

// ---------- OpenAI-compatible ----------

interface OpenAIEndpoint {
	base: string;
	headers: Record<string, string>;
}

function openaiEndpoint(s: HomeLLMSettings, provider: ProviderId): OpenAIEndpoint {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	let base: string;
	let key: string;
	if (provider === "openai") {
		base = "https://api.openai.com/v1";
		key = s.openaiKey;
	} else if (provider === "openrouter") {
		base = "https://openrouter.ai/api/v1";
		key = s.openrouterKey;
		headers["HTTP-Referer"] = "https://obsidian.md";
		headers["X-Title"] = "Home + AI";
	} else {
		base = s.customBaseUrl.replace(/\/+$/, "");
		key = s.customKey;
	}
	if (provider !== "custom" && !key) throw new Error(`No API key set for ${provider}. Add it in plugin settings.`);
	if (key) headers["Authorization"] = `Bearer ${key}`;
	return { base, headers };
}

/** OpenAI-style effort only goes up to "high". */
function openaiEffort(e: Effort): string {
	return e === "xhigh" || e === "max" ? "high" : e;
}

export interface OpenAIToolCall {
	id: string;
	function: { name: string; arguments: string };
}

export interface OpenAIMessage {
	content?: string | null;
	tool_calls?: OpenAIToolCall[];
}

/**
 * One chat/completions call (OpenAI, OpenRouter, or a local server). Adds effort where the provider has it,
 * and retries once without it if the model rejects it (most non-reasoning models do).
 */
export async function openaiCall(s: HomeLLMSettings, provider: ProviderId, model: string, body: { messages: unknown[]; tools?: unknown[] }): Promise<OpenAIMessage> {
	const { base, headers } = openaiEndpoint(s, provider);
	for (let attempt = 0; attempt < 2; attempt++) {
		const useEffort = !!s.effort && s.effort !== "default" && provider !== "custom" && !unsupported.has(`effort:${provider}:${model}`);
		const payload: Record<string, unknown> = { model, temperature: s.temperature, max_tokens: replyTokens(s), messages: body.messages };
		if (body.tools?.length) payload.tools = body.tools;
		if (useEffort) {
			if (provider === "openrouter") payload.reasoning = { effort: openaiEffort(s.effort) };
			else {
				payload.reasoning_effort = openaiEffort(s.effort);
				// OpenAI's reasoning models only accept the default temperature.
				delete payload.temperature;
			}
		}
		const res = await requestUrl({ url: `${base}/chat/completions`, method: "POST", headers, body: JSON.stringify(payload), throw: false });
		if (res.status === 400 && useEffort && /reasoning|effort/i.test(res.text)) {
			unsupported.add(`effort:${provider}:${model}`);
			continue;
		}
		if (res.status >= 400) throw new Error(errorText(res.status, res.text));
		const msg = (res.json as { choices?: { message?: OpenAIMessage }[] } | undefined)?.choices?.[0]?.message;
		if (!msg) throw new Error("Unexpected response: " + res.text.slice(0, 300));
		return msg;
	}
	throw new Error("The request couldn't be completed.");
}

/** A single reply with no tools (used by spell check). */
export async function sendChat(s: HomeLLMSettings, provider: ProviderId, model: string, messages: ChatMessage[], system: string): Promise<string> {
	if (provider === "anthropic") {
		const reply = await anthropicCall(s, model, { system, messages });
		return reply.content
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}
	const msg = await openaiCall(s, provider, model, { messages: [{ role: "system", content: system }, ...messages] });
	return msg.content ?? "";
}
