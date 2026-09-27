// Imagine — Ares makes media: images, short videos, speech, two-voice podcasts.
//
// Everything lands as a file under <ARES_HOME>/media/<date>/ and the tool
// answers with its absolute path: the phone renders any path under the Ares
// home as an artifact, so "make me a poster" shows the poster instead of
// describing it.
//
// Providers, only what their official docs support (checked 2026-09):
//  - images: OpenAI Images API (gpt-image-2 — OpenAI is consolidating its
//    image models onto it; gpt-image-1.x/mini shut down 2026-12-01) or Gemini
//    image models via the Interactions API (gemini-3.1-flash-image), with the
//    legacy generateContent path as a fallback. Model ids are env knobs
//    because they move faster than releases.
//  - video: Google Veo 3.1 through the Gemini API's predictLongRunning
//    operation, polled with a hard deadline. OpenAI's Sora Videos API is
//    deprecated and shuts down 2026-09-24, so it is deliberately absent.
//  - speech/podcast: the SAME Edge TTS voice the phone's /gateway/tts uses,
//    injected by the garrison (setImagineSpeech) rather than re-implemented.
//    Podcast segments share one mp3 format, so their frames concatenate into
//    a valid stream without ffmpeg (the box has none with an mp3 encoder).
//
// Money: an image is cents and allowed; a video is dollars, so it asks the
// owner (checkPermissions here + the policy gate's payment category).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const OPENAI_API = "https://api.openai.com/v1";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

function openaiImageModel(): string {
  return process.env.ARES_IMAGINE_OPENAI_MODEL?.trim() || "gpt-image-2";
}
function geminiImageModel(): string {
  return process.env.ARES_IMAGINE_GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
}
function geminiLegacyImageModel(): string {
  return process.env.ARES_IMAGINE_GEMINI_LEGACY_MODEL?.trim() || "gemini-2.5-flash-image";
}
function veoModel(): string {
  return process.env.ARES_IMAGINE_VEO_MODEL?.trim() || "veo-3.1-fast-generate-preview";
}
/** Poll cadence for a Veo operation; ARES_IMAGINE_POLL_MS (tests shrink it). */
function pollMs(): number {
  const n = Number(process.env.ARES_IMAGINE_POLL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}
/** How long a video may take before we give up; ARES_IMAGINE_VIDEO_TIMEOUT_MS. */
function videoDeadlineMs(): number {
  const n = Number(process.env.ARES_IMAGINE_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 60_000;
}

// ─── Speech injection ────────────────────────────────────────────────────────

export type ImagineSpeech = (text: string, voice?: string) => Promise<Buffer>;
let speechRef: ImagineSpeech | null = null;

/** The garrison hands in the same synthesizer /gateway/tts uses. */
export function setImagineSpeech(fn: ImagineSpeech | null): void {
  speechRef = fn;
}

// ─── Files ───────────────────────────────────────────────────────────────────

function aresHomeDir(): string {
  return process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

export function mediaSlug(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug || "media";
}

/** A fresh path under media/<local date>/ — never overwrites an earlier file. */
export async function mediaPath(prompt: string, ext: string, now = new Date()): Promise<string> {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dir = path.join(aresHomeDir(), "media", day);
  await fs.mkdir(dir, { recursive: true });
  const base = mediaSlug(prompt);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base}${n === 1 ? "" : `-${n}`}.${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

// ─── Shared HTTP ─────────────────────────────────────────────────────────────

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (message) return `HTTP ${res.status}: ${message.slice(0, 300)}`;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
}

function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** Find the first base64 image anywhere in a response: the Interactions API
 *  nests it under steps[].content[] ({type:"image", data}); generateContent
 *  under candidates[].content.parts[].inlineData. Walking the tree survives
 *  either — and the next reshuffle. */
export function findImageData(value: unknown, depth = 0): { data: string; mimeType: string } | null {
  if (!value || typeof value !== "object" || depth > 12) return null;
  const v = value as Record<string, unknown>;
  if (v.type === "image" && typeof v.data === "string" && v.data.length > 0) {
    return { data: v.data, mimeType: typeof v.mime_type === "string" ? v.mime_type : "image/png" };
  }
  const inline = (v.inlineData ?? v.inline_data) as Record<string, unknown> | undefined;
  if (inline && typeof inline.data === "string" && inline.data.length > 0) {
    const mime = inline.mimeType ?? inline.mime_type;
    if (typeof mime !== "string" || mime.startsWith("image/")) return { data: inline.data, mimeType: typeof mime === "string" ? mime : "image/png" };
  }
  for (const child of Array.isArray(value) ? value : Object.values(v)) {
    const found = findImageData(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const SIZE_TO_ASPECT: Record<string, string> = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" };
const MIME_FOR_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// ─── Images ──────────────────────────────────────────────────────────────────

export interface ImageRequest {
  prompt: string;
  size?: string;
  source?: { bytes: Buffer; mimeType: string; name: string };
}

export async function openaiImage(key: string, req: ImageRequest, signal?: AbortSignal): Promise<Buffer> {
  let res: Response;
  if (req.source) {
    const form = new FormData();
    form.set("model", openaiImageModel());
    form.set("prompt", req.prompt);
    if (req.size) form.set("size", req.size);
    form.set("image", new Blob([new Uint8Array(req.source.bytes)], { type: req.source.mimeType }), req.source.name);
    res = await fetch(`${OPENAI_API}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: withDeadline(signal, 180_000) });
  } else {
    res = await fetch(`${OPENAI_API}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: openaiImageModel(), prompt: req.prompt, n: 1, ...(req.size ? { size: req.size } : {}) }),
      signal: withDeadline(signal, 180_000),
    });
  }
  if (!res.ok) throw new Error(`OpenAI images ${await readError(res)}`);
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const img = await fetch(first.url, { signal: withDeadline(signal, 60_000) });
    if (!img.ok) throw new Error(`OpenAI image download HTTP ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("OpenAI returned no image");
}

export async function geminiImage(key: string, req: ImageRequest, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
  const aspect = req.size ? SIZE_TO_ASPECT[req.size] : undefined;
  const input: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
  if (req.source) input.push({ type: "image", mime_type: req.source.mimeType, data: req.source.bytes.toString("base64") });
  const res = await fetch(`${GEMINI_API}/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model: geminiImageModel(),
      input,
      response_format: { type: "image", mime_type: "image/png", ...(aspect ? { aspect_ratio: aspect } : {}) },
    }),
    signal: withDeadline(signal, 180_000),
  });
  if (res.ok) {
    const found = findImageData(await res.json());
    if (found) return { bytes: Buffer.from(found.data, "base64"), mimeType: found.mimeType };
    throw new Error("Gemini returned no image (the prompt may have been refused)");
  }
  // The Interactions API is new; a key or region without it answers 400/404.
  // generateContent is the long-standing path for the same capability.
  if (res.status !== 400 && res.status !== 404) throw new Error(`Gemini images ${await readError(res)}`);
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
  if (req.source) parts.push({ inline_data: { mime_type: req.source.mimeType, data: req.source.bytes.toString("base64") } });
  const legacy = await fetch(`${GEMINI_API}/models/${geminiLegacyImageModel()}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}) } }),
    signal: withDeadline(signal, 180_000),
  });
  if (!legacy.ok) throw new Error(`Gemini images ${await readError(legacy)}`);
  const found = findImageData(await legacy.json());
  if (!found) throw new Error("Gemini returned no image (the prompt may have been refused)");
  return { bytes: Buffer.from(found.data, "base64"), mimeType: found.mimeType };
}

// ─── Video (Veo) ─────────────────────────────────────────────────────────────

/** Veo takes 4, 6 or 8 seconds; anything else snaps to the nearest. */
export function veoSeconds(seconds: number | undefined): "4" | "6" | "8" {
  const s = seconds ?? 8;
  return s <= 5 ? "4" : s <= 7 ? "6" : "8";
}

export async function veoVideo(
  key: string,
  req: { prompt: string; seconds?: number; aspect?: "16:9" | "9:16" },
  signal?: AbortSignal,
): Promise<Buffer> {
  const start = await fetch(`${GEMINI_API}/models/${veoModel()}:predictLongRunning`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: req.prompt }],
      parameters: { aspectRatio: req.aspect ?? "16:9", durationSeconds: veoSeconds(req.seconds) },
    }),
    signal: withDeadline(signal, 60_000),
  });
  if (!start.ok) throw new Error(`Veo ${await readError(start)}`);
  const op = (await start.json()) as { name?: string };
  if (!op.name) throw new Error("Veo returned no operation name");
  const deadline = Date.now() + videoDeadlineMs();
  for (;;) {
    if (signal?.aborted) throw new Error("video generation stopped");
    const statusRes = await fetch(`${GEMINI_API}/${op.name}`, { headers: { "x-goog-api-key": key }, signal: withDeadline(signal, 30_000) });
    if (!statusRes.ok) throw new Error(`Veo status ${await readError(statusRes)}`);
    const status = (await statusRes.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
    };
    if (status.done) {
      if (status.error) throw new Error(`Veo failed: ${status.error.message ?? "unknown error"}`);
      const uri = status.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error("Veo finished without a video (the prompt may have been filtered)");
      const video = await fetch(uri, { headers: { "x-goog-api-key": key }, signal: withDeadline(signal, 120_000) });
      if (!video.ok) throw new Error(`Veo download HTTP ${video.status}`);
      return Buffer.from(await video.arrayBuffer());
    }
    if (Date.now() >= deadline) throw new Error(`Veo still rendering after ${Math.round(videoDeadlineMs() / 1000)}s — operation ${op.name}; gave up waiting`);
    await new Promise((resolve) => setTimeout(resolve, pollMs()));
  }
}

// ─── Speech / podcast ────────────────────────────────────────────────────────

/** Drop a leading ID3v2 tag so concatenated segments are one clean stream of
 *  MPEG frames (a tag mid-stream makes some players stop there). */
export function stripId3(buf: Buffer): Buffer {
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    const footer = (buf[5]! & 0x10) ? 10 : 0;
    return buf.subarray(10 + size + footer);
  }
  return buf;
}

/** Split long text at sentence ends so each TTS call stays well inside the
 *  voice service's comfortable request size. */
export function chunkText(text: string, max = 2_500): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
    const at = cut > max / 2 ? cut + 1 : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** "A: …" / "B: …" lines → ordered segments; unlabeled lines continue the
 *  current speaker. */
export function parsePodcastScript(script: string): Array<{ speaker: "A" | "B"; text: string }> {
  const segments: Array<{ speaker: "A" | "B"; text: string }> = [];
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\**\s*(?:speaker\s+|host\s+)?([AB])\s*\**\s*[:：]\s*(.*)$/i.exec(line);
    if (m) {
      const speaker = m[1]!.toUpperCase() as "A" | "B";
      if (m[2]) segments.push({ speaker, text: m[2] });
      else segments.push({ speaker, text: "" });
    } else if (segments.length > 0) {
      const last = segments[segments.length - 1]!;
      last.text = `${last.text} ${line}`.trim();
    }
  }
  return segments.filter((s) => s.text.length > 0);
}

// ─── Tool ────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    action: z.enum(["image", "video", "speech", "podcast"]).describe(
      "image: generate (or edit, with edit_from) an image. video: a short clip (costs dollars; the owner approves). speech: read text aloud to an mp3. podcast: a two-voice mp3 from a script of 'A:' / 'B:' lines.",
    ),
    prompt: z.string().optional().describe("image/video: what to make. Be concrete: subject, style, framing, lighting."),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional().describe("image: square, landscape or portrait (default auto)."),
    edit_from: z.string().optional().describe("image: path of an existing png/jpg/webp to edit instead of generating from scratch."),
    provider: z.enum(["openai", "gemini"]).optional().describe("image: force a provider (default: OpenAI if connected, else Gemini)."),
    seconds: z.number().int().positive().optional().describe("video: length, 4/6/8 (default 8)."),
    aspect: z.enum(["16:9", "9:16"]).optional().describe("video: landscape (default) or vertical."),
    text: z.string().optional().describe("speech: the text to read."),
    voice: z.string().optional().describe("speech: Edge voice name (default en-US-GuyNeural)."),
    script: z.string().optional().describe("podcast: lines starting 'A:' or 'B:'."),
    voice_a: z.string().optional().describe("podcast: voice for A (default en-US-GuyNeural)."),
    voice_b: z.string().optional().describe("podcast: voice for B (default en-US-JennyNeural)."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface ImagineOutput {
  path?: string;
  provider?: string;
  message: string;
}

const NO_IMAGE_KEY =
  "No image provider is connected. Call Connect with service \"openai\" (an OpenAI API key) or \"gemini\" (a Google AI Studio key) — the owner pastes it in a secure form on their phone — then retry.";
const NO_VIDEO_KEY =
  "Video needs Google Veo: call Connect with service \"gemini\" (a Google AI Studio API key), then retry. (OpenAI's Sora video API is shut down.)";
const MAX_SPEECH_CHARS = 20_000;
const MAX_PODCAST_SEGMENTS = 120;

export const ImagineTool = buildTool<typeof inputSchema, ImagineOutput>({
  name: "Imagine",
  description:
    "Create media and save it as a file the owner sees on their phone: image (generate or edit_from an existing image — OpenAI gpt-image or Gemini), " +
    "video (a 4–8s clip with Google Veo; costs real money, the owner approves), speech (text → mp3 in Ares's voice), podcast (a two-voice mp3 from 'A:'/'B:' lines). " +
    "Returns the file path — put it in your reply. If a provider isn't connected, call Connect service \"openai\" or \"gemini\".",
  // Images/speech only write a file under the Ares home; a video spends real
  // money, so only it is external-state (and asks).
  safety: "workspace-write",
  dynamicSafety: (input) => (input.action === "video" ? "external-state" : "workspace-write"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  watchdogFor: (input) =>
    input.action === "video" ? videoDeadlineMs() + 180_000 : input.action === "podcast" ? 10 * 60_000 : 4 * 60_000,
  async checkPermissions(input) {
    if (input.action === "video") {
      return {
        kind: "ask",
        prompt: `Generate a ${veoSeconds(input.seconds)}s video with Google Veo (${veoModel()}) — billed to your Gemini account, roughly $0.10–$0.40 per second: "${(input.prompt ?? "").slice(0, 140)}"`,
        suggestion: "allow_once",
      };
    }
    return { kind: "allow" };
  },
  activityDescription: (i) => {
    if (i.action === "image") return `${i.edit_from ? "Editing" : "Generating"} image: ${(i.prompt ?? "").slice(0, 60)}`;
    if (i.action === "video") return `Generating video: ${(i.prompt ?? "").slice(0, 60)}`;
    if (i.action === "podcast") return "Recording a podcast";
    return "Recording speech";
  },
  async call(input: Input, ctx): Promise<ToolResult<ImagineOutput>> {
    const fail = (message: string): ToolResult<ImagineOutput> => ({ output: { message }, display: message, failure: message });
    const done = (file: string, provider: string, what: string): ToolResult<ImagineOutput> => {
      const message = `${what} saved to ${file}`;
      return { output: { path: file, provider, message }, display: message, touchedFiles: [file] };
    };
    try {
      switch (input.action) {
        case "image": {
          if (!input.prompt?.trim()) return fail("image needs a prompt.");
          const openaiKey = await getCredential("OPENAI_API_KEY").catch(() => undefined);
          const geminiKey = await getCredential("GEMINI_API_KEY", { envFallback: ["GOOGLE_API_KEY"] }).catch(() => undefined);
          const provider = input.provider ?? (openaiKey ? "openai" : geminiKey ? "gemini" : undefined);
          if (!provider) return fail(NO_IMAGE_KEY);
          const key = provider === "openai" ? openaiKey : geminiKey;
          if (!key) return fail(`${provider === "openai" ? "OpenAI" : "Gemini"} isn't connected. Call Connect with service "${provider}", then retry.`);
          let source: ImageRequest["source"];
          if (input.edit_from) {
            const file = path.resolve(input.edit_from);
            const mimeType = MIME_FOR_EXT[path.extname(file).toLowerCase()];
            if (!mimeType) return fail("edit_from must be a .png, .jpg or .webp file.");
            const bytes = await fs.readFile(file).catch(() => null);
            if (!bytes) return fail(`Can't read ${file}.`);
            if (bytes.byteLength > 20 * 1024 * 1024) return fail("edit_from is larger than 20 MB.");
            source = { bytes, mimeType, name: path.basename(file) };
          }
          const size = input.size && input.size !== "auto" ? input.size : undefined;
          const req: ImageRequest = { prompt: input.prompt, ...(size ? { size } : {}), ...(source ? { source } : {}) };
          if (provider === "openai") {
            const bytes = await openaiImage(key, req, ctx.signal);
            const file = await mediaPath(input.prompt, "png");
            await fs.writeFile(file, bytes);
            return done(file, `openai:${openaiImageModel()}`, "Image");
          }
          const image = await geminiImage(key, req, ctx.signal);
          const file = await mediaPath(input.prompt, image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png");
          await fs.writeFile(file, image.bytes);
          return done(file, `gemini:${geminiImageModel()}`, "Image");
        }
        case "video": {
          if (!input.prompt?.trim()) return fail("video needs a prompt.");
          const key = await getCredential("GEMINI_API_KEY", { envFallback: ["GOOGLE_API_KEY"] }).catch(() => undefined);
          if (!key) return fail(NO_VIDEO_KEY);
          const bytes = await veoVideo(key, { prompt: input.prompt, seconds: input.seconds, ...(input.aspect ? { aspect: input.aspect } : {}) }, ctx.signal);
          const file = await mediaPath(input.prompt, "mp4");
          await fs.writeFile(file, bytes);
          return done(file, `gemini:${veoModel()}`, "Video");
        }
        case "speech": {
          if (!speechRef) return fail("No voice on this machine — speech runs in the garrison (the phone/Telegram host).");
          const text = input.text?.trim();
          if (!text) return fail("speech needs text.");
          if (text.length > MAX_SPEECH_CHARS) return fail(`speech text is over ${MAX_SPEECH_CHARS} characters — split it.`);
          const parts: Buffer[] = [];
          for (const chunk of chunkText(text)) parts.push(stripId3(await speechRef(chunk, input.voice)));
          const file = await mediaPath(text.slice(0, 60), "mp3");
          await fs.writeFile(file, Buffer.concat(parts));
          return done(file, "edge-tts", "Speech");
        }
        case "podcast": {
          if (!speechRef) return fail("No voice on this machine — podcasts are recorded in the garrison (the phone/Telegram host).");
          const segments = parsePodcastScript(input.script ?? "");
          if (segments.length === 0) return fail("podcast needs a script of lines starting with 'A:' or 'B:'.");
          if (segments.length > MAX_PODCAST_SEGMENTS) return fail(`podcast has ${segments.length} lines; keep it under ${MAX_PODCAST_SEGMENTS}.`);
          const total = segments.reduce((n, s) => n + s.text.length, 0);
          if (total > MAX_SPEECH_CHARS) return fail(`podcast script is over ${MAX_SPEECH_CHARS} characters — shorten it.`);
          const voices = { A: input.voice_a ?? "en-US-GuyNeural", B: input.voice_b ?? "en-US-JennyNeural" };
          const parts: Buffer[] = [];
          for (const segment of segments) {
            if (ctx.signal?.aborted) return fail("podcast stopped.");
            for (const chunk of chunkText(segment.text)) parts.push(stripId3(await speechRef(chunk, voices[segment.speaker])));
          }
          const file = await mediaPath(`podcast ${segments[0]!.text.slice(0, 40)}`, "mp3");
          await fs.writeFile(file, Buffer.concat(parts));
          return done(file, "edge-tts", `Podcast (${segments.length} lines)`);
        }
      }
    } catch (err) {
      return fail(`Imagine ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
