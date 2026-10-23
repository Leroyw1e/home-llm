import { MarkdownView, Notice, Platform, TFile, arrayBufferToBase64, normalizePath, requestUrl, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { errorText, modelFor, openaiCall, openaiEndpoint, sendChat } from "./providers";
import type { HomeLLMSettings } from "./settings";
import { moment } from "./time";

export type Transcriber = "gemini" | "openai" | "openrouter" | "custom";

export const TRANSCRIBER_LABELS: Record<"auto" | Transcriber, string> = {
	auto: "Automatic",
	gemini: "Google Gemini",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	custom: "Custom server",
};

export const DEFAULT_TRANSCRIBE_MODEL: Record<Transcriber, string> = {
	gemini: "gemini-3.8-flash",
	openai: "gpt-4o-transcribe",
	openrouter: "google/gemini-3.8-flash",
	custom: "whisper-1",
};

/** OpenAI rejects uploads bigger than this. */
const UPLOAD_LIMIT = 25 * 1024 * 1024;
/** Gemini requests must stay under 20 MB, and base64 adds a third, so bigger recordings are uploaded first. */
const GEMINI_INLINE_LIMIT = 14 * 1024 * 1024;
const GEMINI_API = "https://generativelanguage.googleapis.com";
/** How often the waveform moves along, in milliseconds. */
const WAVE_STEP = 60;
/** Length of each clip sent off for the live transcript. */
const LIVE_STEP = 6_000;
/** Loudness (RMS) above which a moment counts as someone speaking. */
const SPEECH_LEVEL = 0.015;

/** One paragraph of transcript, with when it starts in the recording (in seconds) if known. */
export interface Segment {
	start: number | null;
	text: string;
}

/** Turns a short clip into text for the live transcript. */
export type LiveTranscriber = (clip: Blob) => Promise<string>;

/**
 * Claude can't listen to audio, so speech is turned into text by a provider that can.
 * Gemini comes first: it writes the transcript and summary in one go.
 */
export function pickTranscriber(s: HomeLLMSettings): Transcriber | null {
	if (s.voiceProvider !== "auto") return s.voiceProvider;
	if (s.geminiKey) return "gemini";
	if (s.openaiKey) return "openai";
	if (s.openrouterKey) return "openrouter";
	if (s.provider === "custom" && s.customBaseUrl) return "custom";
	return null;
}

function formatTime(ms: number): string {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function extensionFor(mime: string): string {
	if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
	if (mime.includes("ogg")) return "ogg";
	return "webm";
}

/** A recording in progress, with the bar across the top of the window that shows it. */
export class VoiceRecorder {
	private chunks: Blob[] = [];
	private levels: number[] = [];
	private frame = 0;
	private lastStep = 0;
	private elapsed = 0;
	private segmentStart = performance.now();
	private shownSecond = -1;
	private wrap: HTMLElement;
	private bar: HTMLElement;
	private liveEl: HTMLElement | null = null;
	private timeEl: HTMLElement;
	private pauseBtn: HTMLButtonElement;
	private canvas: HTMLCanvasElement;
	private samples: Uint8Array<ArrayBuffer>;
	private stopped: Promise<Blob>;
	/** Live transcript: a second recorder cut into short clips, and what each clip said, in order. */
	private clip: MediaRecorder | null = null;
	private clipCount = 0;
	private heard: string[] = [];
	private hearing = 0;
	private loudMoments = 0;
	private timers: number[] = [];
	private closed = false;

	private constructor(
		private stream: MediaStream,
		private recorder: MediaRecorder,
		private audio: AudioContext,
		private analyser: AnalyserNode,
		onPause: () => void,
		onStop: () => void,
		private live: LiveTranscriber | null
	) {
		this.samples = new Uint8Array(analyser.fftSize);
		this.stopped = new Promise((resolve) => {
			recorder.ondataavailable = (e) => {
				if (e.data.size) this.chunks.push(e.data);
			};
			recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
		});

		this.wrap = activeDocument.body.createDiv({ cls: "hl-rec-wrap" + (Platform.isMobile ? " is-mobile" : "") });
		this.bar = this.wrap.createDiv("hl-rec-bar");
		this.bar.createSpan("hl-rec-dot");
		this.timeEl = this.bar.createSpan({ cls: "hl-rec-time", text: "0:00" });
		this.canvas = this.bar.createEl("canvas", { cls: "hl-rec-wave" });
		this.pauseBtn = this.bar.createEl("button", { cls: "hl-rec-btn clickable-icon", attr: { "aria-label": "Pause" } });
		setIcon(this.pauseBtn, "pause");
		this.pauseBtn.onclick = onPause;
		const stopBtn = this.bar.createEl("button", { cls: "hl-rec-btn hl-rec-stop clickable-icon", attr: { "aria-label": "Stop and make notes" } });
		setIcon(stopBtn, "square");
		stopBtn.onclick = onStop;

		recorder.start(1000);
		this.frame = window.requestAnimationFrame(this.draw);
		// Loudness is sampled on a timer rather than per frame, so it keeps working while the window is hidden.
		this.timers.push(window.setInterval(() => this.sampleLoudness(), 200));
		if (live) {
			this.liveEl = this.wrap.createDiv({ cls: "hl-rec-live is-empty", text: "Listening…" });
			this.startClip();
			this.timers.push(window.setInterval(() => this.nextClip(), LIVE_STEP));
		}
	}

	/** Asks for the microphone and starts recording, or explains why it can't. */
	static async start(onPause: () => void, onStop: () => void, live: LiveTranscriber | null): Promise<VoiceRecorder | null> {
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
			new Notice("Recording isn't available on this device.");
			return null;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch (e) {
			const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
			new Notice(
				denied
					? Platform.isIosApp
						? "Obsidian isn't allowed to use the microphone. Turn it on in Settings → Obsidian → Microphone."
						: "Obsidian isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone."
					: "Couldn't start the microphone: " + (e instanceof Error ? e.message : String(e))
			);
			return null;
		}
		const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
		const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48_000 });
		const audio = new AudioContext();
		const analyser = audio.createAnalyser();
		analyser.fftSize = 1024;
		audio.createMediaStreamSource(stream).connect(analyser);
		return new VoiceRecorder(stream, recorder, audio, analyser, onPause, onStop, live);
	}

	get paused(): boolean {
		return this.recorder.state === "paused";
	}

	togglePause(): void {
		if (this.recorder.state === "recording") {
			this.recorder.pause();
			if (this.clip?.state === "recording") this.clip.pause();
			this.elapsed += performance.now() - this.segmentStart;
		} else if (this.recorder.state === "paused") {
			this.recorder.resume();
			if (this.clip?.state === "paused") this.clip.resume();
			this.segmentStart = performance.now();
		}
		const paused = this.paused;
		this.bar.toggleClass("is-paused", paused);
		setIcon(this.pauseBtn, paused ? "play" : "pause");
		this.pauseBtn.setAttr("aria-label", paused ? "Resume" : "Pause");
	}

	/** Length of the recording so far, not counting pauses. */
	duration(): number {
		return this.elapsed + (this.recorder.state === "recording" ? performance.now() - this.segmentStart : 0);
	}

	/** Stops recording and returns the audio. */
	async stop(): Promise<{ blob: Blob; ms: number }> {
		const ms = this.duration();
		if (this.recorder.state !== "inactive") this.recorder.stop();
		const blob = await this.stopped;
		this.close();
		return { blob, ms };
	}

	/** Throws the recording away (used when the plugin unloads). */
	cancel(): void {
		if (this.recorder.state !== "inactive") this.recorder.stop();
		this.close();
	}

	private close(): void {
		this.closed = true;
		window.cancelAnimationFrame(this.frame);
		for (const id of this.timers) window.clearInterval(id);
		if (this.clip && this.clip.state !== "inactive") this.clip.stop();
		for (const t of this.stream.getTracks()) t.stop();
		void this.audio.close();
		this.wrap.remove();
	}

	private sampleLoudness(): void {
		if (this.recorder.state !== "recording") return;
		this.analyser.getByteTimeDomainData(this.samples);
		let sum = 0;
		for (const v of this.samples) sum += ((v - 128) / 128) ** 2;
		if (Math.sqrt(sum / this.samples.length) > SPEECH_LEVEL) this.loudMoments++;
	}

	/**
	 * Records a short standalone clip for the live transcript. Clips with no speech in them
	 * aren't sent anywhere, so silence costs nothing.
	 */
	private startClip(): void {
		const parts: Blob[] = [];
		const index = this.clipCount++;
		const loudBefore = this.loudMoments;
		const clip = new MediaRecorder(this.stream, { ...(this.recorder.mimeType ? { mimeType: this.recorder.mimeType } : {}), audioBitsPerSecond: 48_000 });
		clip.ondataavailable = (e) => {
			if (e.data.size) parts.push(e.data);
		};
		clip.onstop = () => {
			if (!this.closed && this.loudMoments - loudBefore >= 2) void this.hear(index, new Blob(parts, { type: clip.mimeType }));
		};
		clip.start();
		this.clip = clip;
	}

	private nextClip(): void {
		if (this.closed || this.recorder.state !== "recording") return;
		this.clip?.stop();
		this.startClip();
	}

	private async hear(index: number, clip: Blob): Promise<void> {
		if (!this.live) return;
		this.hearing++;
		this.showLive();
		try {
			this.heard[index] = await this.live(clip);
		} catch (e) {
			// One failure usually means they all will (a bad key, no internet), so stop trying and say why.
			this.live = null;
			if (this.liveEl) {
				this.liveEl.setText("Live transcript unavailable: " + (e instanceof Error ? e.message : String(e)));
				this.liveEl.addClass("is-error");
			}
			return;
		} finally {
			this.hearing--;
		}
		this.showLive();
	}

	private showLive(): void {
		const el = this.liveEl;
		if (!el || this.closed || !this.live) return;
		const text = this.heard.filter((t) => t).join(" ");
		el.toggleClass("is-empty", !text);
		el.setText(text || "Listening…");
		if (this.hearing) el.createSpan({ cls: "hl-rec-live-dots", text: " …" });
		el.scrollTop = el.scrollHeight;
	}

	/** Each frame: update the timer, and every WAVE_STEP add the current loudness to the scrolling waveform. */
	private draw = (now: number): void => {
		this.frame = window.requestAnimationFrame(this.draw);
		const second = Math.floor(this.duration() / 1000);
		if (second !== this.shownSecond) {
			this.shownSecond = second;
			this.timeEl.setText(formatTime(second * 1000));
		}
		if (now - this.lastStep < WAVE_STEP) return;
		this.lastStep = now;

		const c = this.canvas;
		const dpr = activeWindow.devicePixelRatio || 1;
		const w = Math.round(c.clientWidth * dpr);
		const h = Math.round(c.clientHeight * dpr);
		if (!w || !h) return;
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
		const step = 5 * dpr;
		const max = Math.ceil(w / step);
		if (this.recorder.state === "recording") {
			this.analyser.getByteTimeDomainData(this.samples);
			let sum = 0;
			for (const v of this.samples) sum += ((v - 128) / 128) ** 2;
			// Speech is quiet in absolute terms, so boost it and ease off at the top.
			this.levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / this.samples.length)) * 1.6));
			if (this.levels.length > max) this.levels.splice(0, this.levels.length - max);
		}

		const g = c.getContext("2d");
		if (!g) return;
		g.clearRect(0, 0, w, h);
		g.strokeStyle = getComputedStyle(c).color;
		g.lineCap = "round";
		g.lineWidth = 3 * dpr;
		const mid = h / 2;
		const room = mid - 2 * dpr;
		// A faint dotted line where there's no sound yet, then the newest on the right, older bars fading out to the left.
		const empty = max - this.levels.length;
		g.globalAlpha = 0.25;
		for (let i = 0; i < empty; i++) {
			const x = i * step + step / 2;
			g.beginPath();
			g.moveTo(x, mid - 1.5 * dpr);
			g.lineTo(x, mid + 1.5 * dpr);
			g.stroke();
		}
		for (let i = 0; i < this.levels.length; i++) {
			const x = w - (this.levels.length - i) * step + step / 2;
			const half = Math.max(1.5 * dpr, this.levels[i] * room);
			g.globalAlpha = 0.35 + 0.65 * (i / Math.max(1, this.levels.length - 1));
			g.beginPath();
			g.moveTo(x, mid - half);
			g.lineTo(x, mid + half);
			g.stroke();
		}
		g.globalAlpha = 1;
	};
}

// ---------- Turning a recording into a note ----------

/** The recording as 16 kHz mono WAV, the format audio chat models accept. */
async function toWav(blob: Blob): Promise<ArrayBuffer> {
	const ctx = new AudioContext();
	let decoded: AudioBuffer;
	try {
		decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
	} finally {
		void ctx.close();
	}
	const rate = 16_000;
	const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
	const src = offline.createBufferSource();
	src.buffer = decoded;
	src.connect(offline.destination);
	src.start();
	const pcm = (await offline.startRendering()).getChannelData(0);

	const out = new ArrayBuffer(44 + pcm.length * 2);
	const v = new DataView(out);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, "RIFF");
	v.setUint32(4, 36 + pcm.length * 2, true);
	text(8, "WAVE");
	text(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	text(36, "data");
	v.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
	return out;
}

/** Parses a time the model wrote ("1:02:03", "2:15", "75" or 75) into seconds. */
function seconds(v: unknown): number | null {
	if (typeof v === "number" && isFinite(v)) return Math.max(0, v);
	if (typeof v !== "string") return null;
	const parts = v.trim().split(":").map(Number);
	if (!parts.length || parts.some((n) => isNaN(n))) return null;
	return Math.max(0, parts.reduce((total, n) => total * 60 + n, 0));
}

/** Joins Whisper's short segments into paragraphs of roughly half a minute, ending on a full stop. */
function paragraphs(segs: { start: number; text: string }[]): Segment[] {
	const out: Segment[] = [];
	for (const seg of segs) {
		const text = seg.text.trim();
		if (!text) continue;
		const last = out[out.length - 1];
		if (last && last.start !== null && seg.start - last.start < 25) last.text += " " + text;
		else if (last && last.start !== null && !/[.?!]["']?$/.test(last.text) && seg.start - last.start < 45) last.text += " " + text;
		else out.push({ start: seg.start, text });
	}
	return out;
}

/** The type to tell a service the recording is in. iPhone and iPad record AAC in an MP4 file, which Gemini calls m4a. */
function audioType(blob: Blob, forGemini = false): string {
	const mime = blob.type.split(";")[0] || "audio/webm";
	return forGemini && mime === "audio/mp4" ? "audio/m4a" : mime;
}

/** OpenAI-style /audio/transcriptions upload (OpenAI, or a local Whisper server). */
async function transcribeUpload(s: HomeLLMSettings, provider: "openai" | "custom", model: string, audio: ArrayBuffer, name: string, mime: string, timed = false): Promise<Segment[]> {
	if (audio.byteLength > UPLOAD_LIMIT) throw new Error("The recording is too long to transcribe in one go (25 MB limit).");
	const { base, headers } = openaiEndpoint(s, provider);
	delete headers["Content-Type"];
	const boundary = "----HomeAI" + Math.random().toString(36).slice(2);
	const enc = new TextEncoder();
	const field = (k: string, val: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`;
	// Only whisper-style models can give times for each part of the transcript.
	const withTimes = timed && (model === "whisper-1" || provider === "custom");
	const fields = field("model", model) + (withTimes ? field("response_format", "verbose_json") + field("timestamp_granularities[]", "segment") : "");
	const head = enc.encode(fields + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`);
	const tail = enc.encode(`\r\n--${boundary}--\r\n`);
	const body = new Uint8Array(head.length + audio.byteLength + tail.length);
	body.set(head, 0);
	body.set(new Uint8Array(audio), head.length);
	body.set(tail, head.length + audio.byteLength);

	const res = await requestUrl({
		url: `${base}/audio/transcriptions`,
		method: "POST",
		headers,
		contentType: `multipart/form-data; boundary=${boundary}`,
		body: body.buffer,
		throw: false,
	});
	if (res.status >= 400) {
		// The newer transcription models have a length cap that whisper-1 doesn't.
		if (provider === "openai" && model !== "whisper-1" && /duration|too long|longer than/i.test(res.text)) return transcribeUpload(s, provider, "whisper-1", audio, name, mime, timed);
		// Some local servers don't support timestamps; try again without them.
		if (withTimes && provider === "custom" && res.status === 400) return transcribeUpload(s, provider, model, audio, name, mime, false);
		throw new Error(errorText(res.status, res.text));
	}
	let data: { text?: string; segments?: { start: number; text: string }[] } | undefined;
	try {
		data = res.json as typeof data;
	} catch {
		data = undefined;
	}
	if (data?.segments?.length) return paragraphs(data.segments);
	const text = (data?.text ?? res.text).trim();
	return text ? [{ start: null, text }] : [];
}

/** Reads a JSON reply that may be wrapped in a code fence. */
function parseJson<T>(text: string): T | null {
	const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		return JSON.parse(body) as T;
	} catch {
		return null;
	}
}

/** OpenRouter has no transcription endpoint, so an audio-capable chat model writes the transcript. */
async function transcribeWithChat(s: HomeLLMSettings, model: string, blob: Blob, timed = false): Promise<Segment[]> {
	const wav = await toWav(blob);
	const ask = timed
		? 'Transcribe this recording word for word, split into paragraphs of a few sentences. Reply with only JSON: {"segments":[{"start":"m:ss","text":"..."}]}, where start is when the paragraph begins. If nobody speaks, reply {"segments":[]}.'
		: "Transcribe this recording word for word, with punctuation. Reply with only the transcript. If nobody speaks, reply with nothing.";
	const msg = await openaiCall({ ...s, effort: "default", temperature: 0 }, "openrouter", model, {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: ask },
					{ type: "input_audio", input_audio: { data: arrayBufferToBase64(wav), format: "wav" } },
				],
			},
		],
	});
	const text = (msg.content ?? "").trim();
	if (!timed) return text ? [{ start: null, text }] : [];
	const out = parseJson<{ segments?: { start?: unknown; text?: string }[] }>(text);
	if (!out) return text ? [{ start: null, text }] : [];
	return (out.segments ?? []).filter((g) => g.text?.trim()).map((g) => ({ start: seconds(g.start), text: (g.text ?? "").trim() }));
}

interface GeminiReply {
	candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
	promptFeedback?: { blockReason?: string };
}

/** Uploads a big recording to Gemini's Files API and waits until it's ready to use. */
async function geminiUpload(key: string, audio: ArrayBuffer, mime: string): Promise<string> {
	const start = await requestUrl({
		url: `${GEMINI_API}/upload/v1beta/files`,
		method: "POST",
		headers: {
			"x-goog-api-key": key,
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(audio.byteLength),
			"X-Goog-Upload-Header-Content-Type": mime,
		},
		contentType: "application/json",
		body: JSON.stringify({ file: { display_name: "Voice note" } }),
		throw: false,
	});
	const uploadUrl = Object.entries(start.headers).find(([k]) => k.toLowerCase() === "x-goog-upload-url")?.[1];
	if (start.status >= 400 || !uploadUrl) throw new Error(errorText(start.status, start.text));
	const done = await requestUrl({
		url: uploadUrl,
		method: "POST",
		headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
		contentType: mime,
		body: audio,
		throw: false,
	});
	if (done.status >= 400) throw new Error(errorText(done.status, done.text));
	let file = (done.json as { file?: { name?: string; uri?: string; state?: string } }).file;
	if (!file?.uri || !file.name) throw new Error("Gemini didn't accept the recording.");
	for (let i = 0; i < 60 && file?.state === "PROCESSING"; i++) {
		await new Promise((r) => window.setTimeout(r, 2000));
		const check = await requestUrl({ url: `${GEMINI_API}/v1beta/${file.name}`, headers: { "x-goog-api-key": key }, throw: false });
		file = check.json as typeof file;
	}
	if (file?.state === "FAILED") throw new Error("Gemini couldn't process the recording.");
	return file?.uri ?? "";
}

/** Sends a prompt and a recording to Gemini and returns the text of its reply. */
async function geminiAsk(s: HomeLLMSettings, model: string, blob: Blob, prompt: string, schema?: unknown): Promise<string> {
	const key = s.geminiKey;
	if (!key) throw new Error("No Gemini API key set. Add it under Voice notes in Home + AI settings.");
	const mime = audioType(blob, true);
	const audio = await blob.arrayBuffer();
	const media =
		audio.byteLength > GEMINI_INLINE_LIMIT
			? { file_data: { mime_type: mime, file_uri: await geminiUpload(key, audio, mime) } }
			: { inline_data: { mime_type: mime, data: arrayBufferToBase64(audio) } };
	const res = await requestUrl({
		url: `${GEMINI_API}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		method: "POST",
		headers: { "x-goog-api-key": key },
		contentType: "application/json",
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: prompt }, media] }],
			...(schema ? { generationConfig: { responseMimeType: "application/json", responseSchema: schema } } : {}),
		}),
		throw: false,
	});
	if (res.status >= 400) throw new Error(errorText(res.status, res.text));
	const data = res.json as GeminiReply;
	if (data.promptFeedback?.blockReason) throw new Error(`Gemini declined the recording (${data.promptFeedback.blockReason}).`);
	const parts = data.candidates?.[0]?.content?.parts;
	if (!parts) throw new Error(`Gemini didn't return anything (${data.candidates?.[0]?.finishReason ?? "no reply"}).`);
	return parts.map((p) => p.text ?? "").join("");
}

/** One Gemini request that hears the recording and returns the transcript (with times) and a summary. */
async function geminiTranscribe(s: HomeLLMSettings, model: string, blob: Blob): Promise<{ segments: Segment[]; summary: string }> {
	const text = await geminiAsk(
		s,
		model,
		blob,
		`This is a voice recording I made. Give me:
- segments: everything that's said, word for word with punctuation, split into paragraphs of a few sentences (start a new one when the topic or speaker changes, or about every 30 seconds). For each, start is when it begins in the recording, as m:ss. Leave segments empty if nobody speaks.
- summary: a summary in Markdown of what the recording is about. Start with two to four sentences, then add bullet points for the main points and anything to do, if there are any. No heading.
Use ${s.spellVariant} spelling.`,
		{
			type: "OBJECT",
			properties: {
				segments: { type: "ARRAY", items: { type: "OBJECT", properties: { start: { type: "STRING" }, text: { type: "STRING" } }, required: ["start", "text"] } },
				summary: { type: "STRING" },
			},
			required: ["segments", "summary"],
		}
	);
	const out = parseJson<{ segments?: { start?: unknown; text?: string }[]; summary?: string }>(text);
	if (!out) throw new Error("Gemini's reply was cut off. Try a shorter recording.");
	return {
		segments: (out.segments ?? []).filter((g) => g.text?.trim()).map((g) => ({ start: seconds(g.start), text: (g.text ?? "").trim() })),
		summary: (out.summary ?? "").trim(),
	};
}

async function transcribe(s: HomeLLMSettings, who: Transcriber, blob: Blob, name: string): Promise<{ segments: Segment[]; summary: string }> {
	const timed = s.voiceTimestamps;
	// gpt-4o-transcribe can't give times, so use whisper-1 for timestamps unless a model was chosen.
	const model = s.voiceModel.trim() || (who === "openai" && timed ? "whisper-1" : DEFAULT_TRANSCRIBE_MODEL[who]);
	if (who === "gemini") return geminiTranscribe(s, model, blob);
	const segments = who === "openrouter" ? await transcribeWithChat(s, model, blob, timed) : await transcribeUpload(s, who, model, await blob.arrayBuffer(), name, audioType(blob), timed);
	return { segments, summary: "" };
}

/** The live-transcript function for the current settings, or null if there's no service to use. */
export function liveTranscriber(s: HomeLLMSettings): LiveTranscriber | null {
	if (!s.aiEnabled || !s.voiceLive) return null;
	const who = pickTranscriber(s);
	if (!who) return null;
	const chosen = s.voiceModel.trim();
	return async (clip) => {
		if (who === "gemini") {
			const text = await geminiAsk(s, chosen || DEFAULT_TRANSCRIBE_MODEL.gemini, clip, "Transcribe this short audio clip word for word. Reply with only the words spoken, nothing else. If nobody speaks, reply with nothing.");
			return text.trim();
		}
		const segs =
			who === "openrouter"
				? await transcribeWithChat(s, chosen || DEFAULT_TRANSCRIBE_MODEL.openrouter, clip)
				: await transcribeUpload(s, who, chosen || (who === "openai" ? "gpt-4o-mini-transcribe" : DEFAULT_TRANSCRIBE_MODEL.custom), await clip.arrayBuffer(), `clip.${extensionFor(clip.type)}`, audioType(clip));
		return segs.map((g) => g.text).join(" ");
	};
}

// ---------- Timestamps that jump to that point in the recording ----------

export const SEEK_ACTION = "home-ai-seek";

/** The transcript in Markdown, each paragraph starting with a clickable time when there is one. */
function transcriptMarkdown(plugin: HomeLLMPlugin, segments: Segment[]): string {
	const vault = encodeURIComponent(plugin.app.vault.getName());
	return segments
		.map((g) => (plugin.settings.voiceTimestamps && g.start !== null ? `[${formatTime(g.start * 1000)}](obsidian://${SEEK_ACTION}?vault=${vault}&t=${Math.floor(g.start)}) ${g.text}` : g.text))
		.join("\n\n");
}

let miniPlayer: { el: HTMLElement; audio: HTMLAudioElement; src: string } | null = null;

/** A small player at the bottom of the window, for when the recording in the note isn't on screen. */
function playInMiniPlayer(src: string, name: string, at: number): void {
	if (!miniPlayer || miniPlayer.src !== src) {
		miniPlayer?.el.remove();
		const el = activeDocument.body.createDiv({ cls: "hl-mini-player" + (Platform.isMobile ? " is-mobile" : "") });
		setIcon(el.createSpan("hl-mini-player-icon"), "audio-lines");
		el.createSpan({ cls: "hl-mini-player-name", text: name });
		const audio = el.createEl("audio", { attr: { controls: "", src } });
		const close = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close player" } });
		setIcon(close, "x");
		close.onclick = () => {
			audio.pause();
			el.remove();
			miniPlayer = null;
		};
		miniPlayer = { el, audio, src };
	}
	miniPlayer.audio.currentTime = at;
	void miniPlayer.audio.play();
}

/** Jumps the open note's recording to a time and plays it. */
export function seekAudio(plugin: HomeLLMPlugin, at: number): void {
	const { app } = plugin;
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view?.file) return;
	// Use the player in the note if it's on screen.
	const shown = Array.from(view.containerEl.querySelectorAll("audio")).find((a) => {
		const r = a.getBoundingClientRect();
		return r.height > 0 && r.bottom > 0 && r.top < activeWindow.innerHeight;
	});
	if (shown) {
		miniPlayer?.audio.pause();
		shown.currentTime = at;
		void shown.play();
		return;
	}
	const embed = app.metadataCache.getFileCache(view.file)?.embeds?.find((e) => /\.(webm|m4a|mp4|mp3|wav|ogg|flac|3gp)$/i.test(e.link));
	const file = embed ? app.metadataCache.getFirstLinkpathDest(embed.link, view.file.path) : null;
	if (!file) {
		new Notice("Couldn't find the recording in this note.");
		return;
	}
	playInMiniPlayer(app.vault.getResourcePath(file), file.basename, at);
}

/** Closes the mini player (when the plugin unloads). */
export function closeMiniPlayer(): void {
	miniPlayer?.audio.pause();
	miniPlayer?.el.remove();
	miniPlayer = null;
}

/**
 * Claude names the note, and writes the summary too when the transcription service didn't.
 * Uses Claude whenever there's an Anthropic key, otherwise the default model.
 */
async function nameAndSummarise(s: HomeLLMSettings, transcript: string, summary: string): Promise<{ title: string; summary: string }> {
	const provider = s.anthropicKey ? "anthropic" : s.provider;
	const ask = summary
		? `Here's a summary and transcript of a voice recording I made. Reply with only a short title for the note (at most 8 words), nothing else.`
		: `Here's the transcript of a voice recording I made. Reply in Markdown:
- First line: "# " then a short title for the note (at most 8 words).
- Then a summary: two to four sentences, then bullet points for the main points and anything to do, if there are any. No other headings.
Use only what's in the transcript and ${s.spellVariant} spelling. Don't repeat the transcript.`;
	const reply = await sendChat(
		summary ? { ...s, effort: "low" } : s,
		provider,
		modelFor(s, provider),
		[{ role: "user", content: `${ask}

${summary ? `<summary>
${summary}
</summary>

` : ""}<transcript>
${summary ? transcript.slice(0, 6000) : transcript}
</transcript>` }],
		"You name and summarise voice recordings for a notes app."
	);
	if (summary) return { title: cleanTitle(reply.replace(/^#+\s*/, "").split("\n")[0]), summary };
	const m = /^\s*#\s+(.+)\n?/.exec(reply);
	return { title: m ? cleanTitle(m[1]) : "", summary: (m ? reply.slice(m[0].length) : reply).trim() };
}

/** A file name made from the AI's title, without characters that aren't allowed in note names. */
function cleanTitle(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/^["'“‘]+|["'”’.]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

async function availablePath(plugin: HomeLLMPlugin, folder: string, name: string): Promise<string> {
	const vault = plugin.app.vault;
	const dir = folder ? normalizePath(folder) + "/" : "";
	if (dir && !vault.getAbstractFileByPath(dir.slice(0, -1))) await vault.createFolder(dir.slice(0, -1));
	let path = normalizePath(`${dir}${name}.md`);
	for (let i = 2; vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${name} ${i}.md`);
	return path;
}

const PENDING = "> [!info] Writing your notes…\n> Turning the recording into text. This note fills in by itself.";

/**
 * Saves the recording, opens a new note for it straight away, then fills in the transcript
 * and AI notes. The audio is always kept, so nothing is lost if a step fails.
 */
export async function saveVoiceNote(plugin: HomeLLMPlugin, blob: Blob, ms: number): Promise<void> {
	const { app } = plugin;
	const s = plugin.settings;
	const now = moment();
	const name = `Voice note ${now.format("YYYY-MM-DD HHmm")}`;
	const notePath = await availablePath(plugin, s.voiceFolder, name);
	const audioName = `Recording ${now.format("YYYY-MM-DD HHmmss")}.${extensionFor(blob.type)}`;
	const audioPath = await app.fileManager.getAvailablePathForAttachment(audioName, notePath);
	const audioFile = await app.vault.createBinary(audioPath, await blob.arrayBuffer());

	const who = s.aiEnabled ? pickTranscriber(s) : null;
	const header = `---\nrecorded: ${now.format("YYYY-MM-DDTHH:mm")}\nlength: ${formatTime(ms)}\ntags:\n  - voice-note\n---\n\n!${app.fileManager.generateMarkdownLink(audioFile, notePath)}\n\n`;
	let note: TFile = await app.vault.create(notePath, header + (who ? PENDING : ""));
	await app.workspace.getLeaf("tab").openFile(note);

	if (!s.aiEnabled) return;
	if (!who) {
		await setBody(plugin, note, header, "> [!warning] No transcript\n> Claude can't listen to audio, so add a Gemini API key (or an OpenAI or OpenRouter key) under Voice notes in Home + AI settings to get a transcript and summary. Your recording is saved above.");
		return;
	}

	let heard: { segments: Segment[]; summary: string };
	try {
		heard = await transcribe(s, who, blob, audioName);
	} catch (e) {
		await setBody(plugin, note, header, `> [!warning] Couldn't transcribe the recording\n> ${e instanceof Error ? e.message : String(e)}\n> Your recording is saved above.`);
		return;
	}
	const transcript = heard.segments.map((g) => g.text).join("\n\n");
	if (!transcript) {
		await setBody(plugin, note, header, "> [!note] No speech was found in this recording.");
		return;
	}

	let { summary } = heard;
	let title = "";
	let problem = "";
	try {
		({ title, summary } = await nameAndSummarise(s, transcript, summary));
	} catch (e) {
		problem = `> [!warning] Couldn't ${summary ? "name the note" : "write the summary"}\n> ${e instanceof Error ? e.message : String(e)}\n\n`;
	}
	// The heading is added here, so drop one if the model wrote its own.
	summary = summary.replace(/^#+\s*summary\s*\n+/i, "").trim();
	note = await setBody(plugin, note, header, `${problem}${summary ? `## Summary\n\n${summary}\n\n` : ""}## Transcript\n\n${transcriptMarkdown(plugin, heard.segments)}\n`);

	if (title) {
		const parent = note.parent && !note.parent.isRoot() ? note.parent.path : "";
		await app.fileManager.renameFile(note, await availablePath(plugin, parent, title));
	}
}

/** Replaces everything after the note's header, leaving any edits the user made above the placeholder. */
async function setBody(plugin: HomeLLMPlugin, note: TFile, header: string, body: string): Promise<TFile> {
	await plugin.app.vault.process(note, (data) => {
		if (data.includes(PENDING)) return data.replace(PENDING, body);
		return data.startsWith(header) ? header + body : data.replace(/\s*$/, "\n\n") + body;
	});
	return note;
}
