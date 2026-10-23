import { Notice, Platform, TFile, arrayBufferToBase64, normalizePath, requestUrl, setIcon } from "obsidian";
import type HomeLLMPlugin from "./main";
import { errorText, modelFor, openaiCall, openaiEndpoint, sendChat } from "./providers";
import type { HomeLLMSettings } from "./settings";
import { moment } from "./time";

export type Transcriber = "openai" | "openrouter" | "custom";

export const TRANSCRIBER_LABELS: Record<"auto" | Transcriber, string> = {
	auto: "Automatic",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	custom: "Custom server",
};

const DEFAULT_TRANSCRIBE_MODEL: Record<Transcriber, string> = {
	openai: "gpt-4o-transcribe",
	openrouter: "google/gemini-2.5-flash",
	custom: "whisper-1",
};

/** OpenAI rejects uploads bigger than this. */
const UPLOAD_LIMIT = 25 * 1024 * 1024;
/** How often the waveform moves along, in milliseconds. */
const WAVE_STEP = 60;

/**
 * Claude can't listen to audio, so speech is turned into text by a provider that can,
 * then the notes are written by the user's usual AI model.
 */
export function pickTranscriber(s: HomeLLMSettings): Transcriber | null {
	if (s.voiceProvider !== "auto") return s.voiceProvider;
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
	private bar: HTMLElement;
	private timeEl: HTMLElement;
	private pauseBtn: HTMLButtonElement;
	private canvas: HTMLCanvasElement;
	private samples: Uint8Array<ArrayBuffer>;
	private stopped: Promise<Blob>;

	private constructor(
		private stream: MediaStream,
		private recorder: MediaRecorder,
		private audio: AudioContext,
		private analyser: AnalyserNode,
		onPause: () => void,
		onStop: () => void
	) {
		this.samples = new Uint8Array(analyser.fftSize);
		this.stopped = new Promise((resolve) => {
			recorder.ondataavailable = (e) => {
				if (e.data.size) this.chunks.push(e.data);
			};
			recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
		});

		this.bar = activeDocument.body.createDiv({ cls: "hl-rec-bar" + (Platform.isMobile ? " is-mobile" : "") });
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
	}

	/** Asks for the microphone and starts recording, or explains why it can't. */
	static async start(onPause: () => void, onStop: () => void): Promise<VoiceRecorder | null> {
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
		return new VoiceRecorder(stream, recorder, audio, analyser, onPause, onStop);
	}

	get paused(): boolean {
		return this.recorder.state === "paused";
	}

	togglePause(): void {
		if (this.recorder.state === "recording") {
			this.recorder.pause();
			this.elapsed += performance.now() - this.segmentStart;
		} else if (this.recorder.state === "paused") {
			this.recorder.resume();
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
		window.cancelAnimationFrame(this.frame);
		for (const t of this.stream.getTracks()) t.stop();
		void this.audio.close();
		this.bar.remove();
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

/** OpenAI-style /audio/transcriptions upload (OpenAI, or a local Whisper server). */
async function transcribeUpload(s: HomeLLMSettings, provider: "openai" | "custom", model: string, audio: ArrayBuffer, name: string, mime: string): Promise<string> {
	if (audio.byteLength > UPLOAD_LIMIT) throw new Error("The recording is too long to transcribe in one go (25 MB limit).");
	const { base, headers } = openaiEndpoint(s, provider);
	delete headers["Content-Type"];
	const boundary = "----HomeAI" + Math.random().toString(36).slice(2);
	const enc = new TextEncoder();
	const field = (k: string, val: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`;
	const head = enc.encode(field("model", model) + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`);
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
		if (provider === "openai" && model !== "whisper-1" && /duration|too long|longer than/i.test(res.text)) return transcribeUpload(s, provider, "whisper-1", audio, name, mime);
		throw new Error(errorText(res.status, res.text));
	}
	const data = res.json as { text?: string } | undefined;
	return (data?.text ?? res.text).trim();
}

/** OpenRouter has no transcription endpoint, so an audio-capable chat model writes the transcript. */
async function transcribeWithChat(s: HomeLLMSettings, model: string, blob: Blob): Promise<string> {
	const wav = await toWav(blob);
	const msg = await openaiCall({ ...s, effort: "default", temperature: 0 }, "openrouter", model, {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Transcribe this recording word for word, with punctuation and paragraphs. Reply with only the transcript. If nobody speaks, reply with nothing." },
					{ type: "input_audio", input_audio: { data: arrayBufferToBase64(wav), format: "wav" } },
				],
			},
		],
	});
	return (msg.content ?? "").trim();
}

async function transcribe(s: HomeLLMSettings, who: Transcriber, blob: Blob, name: string): Promise<string> {
	const model = s.voiceModel.trim() || DEFAULT_TRANSCRIBE_MODEL[who];
	if (who === "openrouter") return transcribeWithChat(s, model, blob);
	return transcribeUpload(s, who, model, await blob.arrayBuffer(), name, blob.type.split(";")[0]);
}

function notesPrompt(s: HomeLLMSettings, transcript: string): string {
	return `Below is the transcript of a voice recording I made. Turn it into tidy notes in Markdown:

- First line: "# " then a short title for the recording (at most 8 words).
- "## Summary": two to four sentences.
- "## Key points": a bulleted list of the main ideas, facts and decisions.
- "## Action items": a task list ("- [ ] ...") of anything to do, only if the recording mentions some.

Use only what's in the transcript, keep my wording where it helps, and use ${s.spellVariant} spelling. Don't repeat the transcript.

<transcript>
${transcript}
</transcript>`;
}

/** A file name made from the AI's title, without characters that aren't allowed in note names. */
function cleanTitle(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
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
		await setBody(plugin, note, header, "> [!warning] No transcript\n> Claude can't listen to audio, so add an OpenAI or OpenRouter API key in Home + AI settings to turn recordings into notes. Your recording is saved above.");
		return;
	}

	let transcript: string;
	try {
		transcript = await transcribe(s, who, blob, audioName);
	} catch (e) {
		await setBody(plugin, note, header, `> [!warning] Couldn't transcribe the recording\n> ${e instanceof Error ? e.message : String(e)}\n> Your recording is saved above.`);
		return;
	}
	if (!transcript) {
		await setBody(plugin, note, header, "> [!note] No speech was found in this recording.");
		return;
	}

	let notes = "";
	let title = "";
	try {
		const reply = await sendChat(s, s.provider, modelFor(s, s.provider), [{ role: "user", content: notesPrompt(s, transcript) }], "You turn voice recordings into clear, well-organised notes.");
		const m = /^\s*#\s+(.+)\n?/.exec(reply);
		if (m) title = cleanTitle(m[1]);
		notes = (m ? reply.slice(m[0].length) : reply).trim() + "\n\n";
	} catch (e) {
		notes = `> [!warning] Couldn't write notes from the transcript\n> ${e instanceof Error ? e.message : String(e)}\n\n`;
	}
	note = await setBody(plugin, note, header, `${notes}## Transcript\n\n${transcript}\n`);

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
