import { requestUrl } from "obsidian";
import { LOCAL_MODEL, NO_LOCAL_ADDON, localAI } from "./local";
import type { Effort, HomeLLMSettings, ProviderId } from "./settings";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export function modelFor(s: HomeLLMSettings, p: ProviderId): string {
	switch (p) {
		case "anthropic":
			return s.anthropicModel;
		case "gemini":
			return s.geminiModel;
		case "openai":
			return s.openaiModel;
		case "openrouter":
			return s.openrouterModel;
		case "custom":
			return s.customModel;
		case "local":
			return LOCAL_MODEL;
	}
}

/** Output tokens to allow: current models think before answering, and thinking counts toward this limit. */
export function replyTokens(s: HomeLLMSettings): number {
	return Math.max(s.maxTokens, 4096);
}

export function errorText(status: number, body: string): string {
	if (/credit balance is too low/i.test(body)) return "Your Anthropic account is out of credit. Add credit at console.anthropic.com, or pick another provider (like Google Gemini, which has a free tier) in the model menu.";
	if (/generativelanguage|aiplatform/i.test(body) && /API key not valid|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(body))
		return "Google says this isn't a valid Gemini API key. Create one at aistudio.google.com/apikey (Get API key, then Create API key). It starts with AIza.";
	// OpenAI says "quota" when the account has no credit; Gemini says RESOURCE_EXHAUSTED when the free limit is used up.
	if (/RESOURCE_EXHAUSTED/.test(body)) return "You've reached the free Gemini limit for now. It resets daily, or you can pick another Gemini model or provider in the model menu.";
	if (/insufficient_quota|exceeded your current quota/i.test(body))
		return "Your OpenAI account has no credit (the API is billed separately from ChatGPT Plus). Add credit at platform.openai.com, or pick another provider, like Google Gemini's free tier, in the model menu.";
	if (status === 429) return "Too many requests at once. Wait a few seconds and try again.";
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

// ---------- Gemini model list ----------

export interface GeminiModel {
	id: string;
	name: string;
}

/** Every Gemini model your key can chat with, newest-looking first. */
export async function listGeminiModels(key: string): Promise<GeminiModel[]> {
	if (!key) throw new Error("Add your Gemini API key first.");
	const out: GeminiModel[] = [];
	let page = "";
	for (let i = 0; i < 5; i++) {
		const res = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
			headers: { "x-goog-api-key": key },
			throw: false,
		});
		if (res.status >= 400) throw new Error(errorText(res.status, res.text));
		const data = res.json as { models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
		for (const m of data.models ?? []) {
			const id = (m.name ?? "").replace(/^models\//, "");
			// Only text chat models: skip embeddings, speech, image generation and live audio.
			if (!id.startsWith("gemini") || !(m.supportedGenerationMethods ?? []).includes("generateContent")) continue;
			if (/embedding|tts|image|live|audio|aqa/i.test(id)) continue;
			out.push({ id, name: m.displayName || id });
		}
		page = data.nextPageToken ?? "";
		if (!page) break;
	}
	// Higher version numbers first, then "pro" before "flash" before "lite".
	const version = (id: string) => parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? "0");
	const tier = (id: string) => (/pro/.test(id) ? 0 : /flash-lite|lite/.test(id) ? 2 : 1);
	return out.sort((a, b) => version(b.id) - version(a.id) || tier(a.id) - tier(b.id) || a.id.localeCompare(b.id));
}

// ---------- OpenAI model list ----------

/** "gpt-5-mini" → "GPT-5 mini", "chatgpt-4o-latest" → "ChatGPT-4o latest". */
export function openaiModelName(id: string): string {
	// Words after the version become spaced: "gpt-6.1-sol" → "GPT-6.1 sol", "o4-mini" → "o4 mini".
	return id.replace(/^gpt-/, "GPT-").replace(/^chatgpt-/, "ChatGPT-").replace(/-([a-z][a-z]*)/g, " $1");
}

/** ChatGPT models your OpenAI key can chat with, newest first (dated snapshots and non-chat models left out). */
export async function listOpenAIModels(key: string): Promise<GeminiModel[]> {
	if (!key) throw new Error("Add your OpenAI API key first.");
	const res = await requestUrl({ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${key}` }, throw: false });
	if (res.status >= 400) throw new Error(errorText(res.status, res.text));
	const data = res.json as { data?: { id?: string; created?: number }[] };
	return (data.data ?? [])
		.filter((m): m is { id: string; created?: number } => !!m.id && /^(gpt-|o\d|chatgpt-)/.test(m.id))
		.filter((m) => !/embedding|tts|whisper|dall-e|image|realtime|live|audio|transcribe|moderation|search|instruct|codex|computer-use|-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(m.id))
		.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
		.map((m) => ({ id: m.id, name: openaiModelName(m.id) }));
}

// ---------- OpenAI-compatible ----------

interface OpenAIEndpoint {
	base: string;
	headers: Record<string, string>;
}

export function openaiEndpoint(s: HomeLLMSettings, provider: ProviderId): OpenAIEndpoint {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	let base: string;
	let key: string;
	if (provider === "openai") {
		base = "https://api.openai.com/v1";
		key = s.openaiKey;
	} else if (provider === "gemini") {
		// Gemini's OpenAI-compatible endpoint, so chat, tools and effort work the same way.
		base = "https://generativelanguage.googleapis.com/v1beta/openai";
		key = s.geminiKey;
	} else if (provider === "openrouter") {
		base = "https://openrouter.ai/api/v1";
		key = s.openrouterKey;
		headers["HTTP-Referer"] = "https://obsidian.md";
		headers["X-Title"] = "Home + AI";
	} else {
		base = s.customBaseUrl.replace(/\/+$/, "");
		key = s.customKey;
	}
	if (provider !== "custom" && !key) throw new Error(`No API key set for ${provider === "gemini" ? "Gemini" : provider}. Add it in plugin settings.`);
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
	// OpenAI's reasoning models (GPT-5, o-series) only accept their own temperature, and every current OpenAI model
	// takes max_completion_tokens instead of max_tokens. Anything else a model turns down is remembered and dropped.
	const reasoningModel = provider === "openai" && /^(o\d|gpt-5)/.test(model);
	for (let attempt = 0; attempt < 4; attempt++) {
		const useEffort = !!s.effort && s.effort !== "default" && provider !== "custom" && !unsupported.has(`effort:${provider}:${model}`);
		const useTemperature = !reasoningModel && !unsupported.has(`temperature:${provider}:${model}`);
		const lengthKey = provider === "openai" || unsupported.has(`max_tokens:${provider}:${model}`) ? "max_completion_tokens" : "max_tokens";
		const payload: Record<string, unknown> = { model, [lengthKey]: replyTokens(s), messages: body.messages };
		if (useTemperature) payload.temperature = s.temperature;
		if (body.tools?.length) payload.tools = body.tools;
		if (useEffort) {
			if (provider === "openrouter") payload.reasoning = { effort: openaiEffort(s.effort) };
			else {
				payload.reasoning_effort = openaiEffort(s.effort);
				// Reasoning settings and a custom temperature don't mix on OpenAI.
				delete payload.temperature;
			}
		}
		const res = await requestUrl({ url: `${base}/chat/completions`, method: "POST", headers, body: JSON.stringify(payload), throw: false });
		if (res.status === 400) {
			if (useEffort && /reasoning|effort/i.test(res.text)) {
				unsupported.add(`effort:${provider}:${model}`);
				continue;
			}
			if ("temperature" in payload && /temperature/i.test(res.text)) {
				unsupported.add(`temperature:${provider}:${model}`);
				continue;
			}
			if (lengthKey === "max_tokens" && /max_tokens|max_completion_tokens/i.test(res.text)) {
				unsupported.add(`max_tokens:${provider}:${model}`);
				continue;
			}
		}
		if (res.status >= 400) throw new Error(errorText(res.status, res.text));
		const msg = (res.json as { choices?: { message?: OpenAIMessage }[] } | undefined)?.choices?.[0]?.message;
		if (!msg) throw new Error("Unexpected response: " + res.text.slice(0, 300));
		return msg;
	}
	throw new Error("The request couldn't be completed.");
}

/** A single reply with no tools (used by spell check). */
export async function sendChat(s: HomeLLMSettings, provider: ProviderId, model: string, messages: ChatMessage[], system: string, onStatus?: (text: string) => void): Promise<string> {
	if (provider === "local") {
		const ai = localAI();
		if (!ai) throw new Error(NO_LOCAL_ADDON);
		// Small on-device models answer best with short replies; thinking budgets don't apply.
		return ai.chat([{ role: "system", content: system }, ...messages], { maxTokens: Math.min(s.maxTokens, 2048), temperature: s.temperature, onStatus });
	}
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
