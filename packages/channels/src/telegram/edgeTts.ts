// Edge TTS — Microsoft Edge's free text-to-speech via REST.
//
// No API key, no signup, no Edge browser needed. Uses the same endpoint the
// Edge Read Aloud feature uses, sending SSML and receiving audio bytes.
// The returned Buffer can be sent directly via TelegramApi.sendVoice().
//
// This is a clean-room implementation — no npm dependency, just fetch.
// Works on any platform with network access. Zero dependencies beyond ws
// (already in the repo for the Telegram bridge).

import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

// ─── Voice catalog ───────────────────────────────────────────────────────

export interface EdgeVoice {
  name: string;
  shortName: string;
  locale: string;
  gender: string;
}

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`;

let voiceCache: EdgeVoice[] | null = null;

export async function listVoices(): Promise<EdgeVoice[]> {
  if (voiceCache) return voiceCache;
  const res = await fetch(VOICES_URL, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`voice list failed: ${res.status}`);
  const raw = (await res.json()) as Array<{ Name?: string; ShortName?: string; Locale?: string; Gender?: string }>;
  voiceCache = raw
    .filter((v) => v.ShortName && v.Locale)
    .map((v) => ({
      name: v.Name ?? v.ShortName!,
      shortName: v.ShortName!,
      locale: v.Locale!,
      gender: v.Gender ?? "Unknown",
    }));
  return voiceCache;
}

export async function defaultVoice(): Promise<string> {
  try {
    const voices = await listVoices();
    const preferred = ["en-US-GuyNeural", "en-US-AriaNeural", "en-US-JennyNeural"];
    for (const p of preferred) {
      if (voices.some((v) => v.shortName === p)) return p;
    }
    const enUs = voices.find((v) => v.locale.startsWith("en-US"));
    if (enUs) return enUs.shortName;
  } catch {
    // fallback
  }
  return "en-US-GuyNeural";
}

// ─── Auth: Sec-MS-GEC token ─────────────────────────────────────────────

/** Generate the Sec-MS-GEC security token that Microsoft validates on the
 *  websocket handshake. This is a time-based hash — same approach the Python
 *  edge-tts library and every working open-source implementation uses. */
function generateSecMsGec(): string {
  const WINDOWS_EPOCH_DIFF = 11644473600n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ticks = (now + WINDOWS_EPOCH_DIFF) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return createHash("sha256")
    .update(`${rounded}${TRUSTED_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function connectId(): string {
  return randomUUID().replace(/-/g, "");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateToString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

// ─── Synthesis ───────────────────────────────────────────────────────────

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  outputFormat?: string;
  timeoutMs?: number;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSsml(text: string, voice: string, rate: string, pitch: string): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody rate='${escapeXml(rate)}' pitch='${escapeXml(pitch)}'>` +
    escapeXml(text) +
    `</prosody></voice></speak>`
  );
}

export async function synthesize(opts: SynthesizeOptions): Promise<Buffer> {
  const voice = opts.voice ?? "en-US-GuyNeural";
  const rate = opts.rate ?? "+0%";
  const pitch = opts.pitch ?? "+0Hz";
  const format = opts.outputFormat ?? "audio-24khz-48kbitrate-mono-mp3";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const connId = connectId();
  const secToken = generateSecMsGec();
  const muid = connectId() + connectId();

  const wssUrl =
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secToken}` +
    `&Sec-MS-GEC-Version=1-143.0.3650.75&ConnectionId=${connId}`;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* already closed */ }
        reject(new Error("edge-tts: timeout"));
      }
    }, timeoutMs);

    const ws = new WebSocket(wssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        Cookie: `muid=${muid};`,
      },
    });

    ws.on("open", () => {
      const ts = dateToString();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${format}"}}}}\r\n`,
      );

      const ssml = buildSsml(opts.text, voice, rate, pitch);
      ws.send(
        `X-RequestId:${connId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml,
      );
    });

    ws.on("message", (data: Buffer | string) => {
      if (settled) return;
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Binary frames from the Edge TTS service use a 2-byte big-endian
      // header-length prefix for audio, but text-style frames (turn.start,
      // response, turn.end) embed \r\n\r\n separators. Check both.
      const sepIdx = buf.indexOf("\r\n\r\n");
      if (sepIdx !== -1) {
        const headerStr = buf.subarray(0, sepIdx).toString("utf8");
        if (headerStr.includes("Path:turn.end")) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch { /* fine */ }
          resolve(Buffer.concat(chunks));
          return;
        }
        if (headerStr.includes("Path:audio")) {
          const audio = buf.subarray(sepIdx + 4);
          if (audio.length > 0) chunks.push(audio);
          return;
        }
        return;
      }

      // Fallback: 2-byte header-length prefix
      if (buf.length >= 2) {
        const hdrLen = buf.readUInt16BE(0);
        if (hdrLen + 2 <= buf.length) {
          const hdrStr = buf.subarray(2, 2 + hdrLen).toString("utf8");
          if (hdrStr.includes("Path:turn.end")) {
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* fine */ }
            resolve(Buffer.concat(chunks));
            return;
          }
          if (hdrStr.includes("Path:audio")) {
            const audio = buf.subarray(2 + hdrLen);
            if (audio.length > 0) chunks.push(audio);
          }
        }
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`edge-tts: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error("edge-tts: connection closed before audio received"));
      }
    });
  });
}

/** High-level: text → WebM/Opus buffer ready for Telegram sendVoice. */
export async function textToVoice(text: string, voice?: string, rate?: string): Promise<Buffer> {
  const v = voice ?? await defaultVoice();
  return synthesize({ text, voice: v, rate: rate ?? "+28%", outputFormat: "webm-24khz-16bit-mono-opus" });
}
