// Voice — the desktop app's bridge to the local voice sidecar (voice_service/,
// ws://127.0.0.1:8765). The sidecar already ships Kokoro TTS + faster-whisper
// STT and is auto-spawned by the Rust shell; this module is the app-side client
// the UI was missing. Everything here is local-first and degrades to silence /
// the legacy STT path when the sidecar isn't running.
//
// Three pieces:
//   • sanitizeForSpeech — turn a markdown chat reply into something worth
//     hearing: no emoji, no "hashtag", no "asterisk asterisk", URLs as domains,
//     code blocks summarized, not read out line by line.
//   • TtsClient — a persistent /tts WebSocket + an audio queue player, with a
//     hard stop() for barge-in.
//   • sidecarTranscribe — push-to-talk STT against /stt (mic captured
//     server-side, so no WebView getUserMedia permission dance).

import { useCallback, useEffect, useRef, useState } from "react";

export const VOICE_HTTP_BASE = "http://127.0.0.1:8765";
export const VOICE_WS_BASE = "ws://127.0.0.1:8765";

export interface VoiceInfo {
  id: string;
  label: string;
  accent?: string;
  gender?: string;
  tier?: string | number;
  character?: string;
}

// ── Speakability ─────────────────────────────────────────────────────────
// A chat reply is written to be READ. Spoken verbatim it's miserable — the TTS
// pronounces "#", "**", every emoji name, and reads 200-char URLs and whole
// code blocks aloud. Strip it down to the words a person would actually say.

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]/gu;

export function sanitizeForSpeech(input: string): string {
  if (!input) return "";
  let t = input;

  // Fenced code blocks → a short spoken placeholder (never read code aloud).
  t = t.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang: string | undefined, body: string) => {
    const lines = body.split("\n").filter((l) => l.trim()).length;
    return ` (${lang ? `${lang} ` : ""}code block, ${lines} line${lines === 1 ? "" : "s"}) `;
  });
  // Inline code → its contents, sans backticks.
  t = t.replace(/`([^`]+)`/g, "$1");

  // Images ![alt](url) → nothing; links [text](url) → the visible text.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Bare URLs → their domain ("according to example.com" not the whole path).
  t = t.replace(/https?:\/\/([^\s/]+)[^\s]*/g, (_m, host: string) => host.replace(/^www\./, ""));

  // Markdown emphasis / headings / quotes / list bullets / rules.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");      // # headings
  t = t.replace(/^\s{0,3}>\s?/gm, "");           // > blockquotes
  t = t.replace(/^\s*[-*+]\s+/gm, "");           // - bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, "");           // 1. ordered markers
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, " ");      // --- horizontal rules
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");      // **bold** / __bold__
  t = t.replace(/(\*|_)(.*?)\1/g, "$2");          // *italic* / _italic_
  t = t.replace(/~~(.*?)~~/g, "$1");             // ~~strike~~

  // Hashtags → the word without the hash ("#winning" → "winning").
  t = t.replace(/(^|\s)#(\w+)/g, "$1$2");

  // Emoji + variation selectors → gone (don't speak "sparkles").
  t = t.replace(EMOJI_RE, "");

  // Markdown tables read as pipe soup — turn cell separators into pauses.
  t = t.replace(/^\s*\|?[-:|\s]+\|?\s*$/gm, " "); // separator rows
  t = t.replace(/\s*\|\s*/g, ", ");

  // Collapse whitespace and stray punctuation left behind.
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/\s+([.,!?;:])/g, "$1");
  t = t.replace(/(^|\n)[,;:]\s*/g, "$1");

  return t.trim();
}

// ── TTS client ─────────────────────────────────────────────────────────────

interface TtsChunk { type: string; audio?: string; mime?: string; message?: string }

/** A persistent /tts WebSocket with a serial audio-queue player. speak() streams
 *  one WAV per sentence and plays them in order; stop() is an immediate barge-in
 *  (cancel the server + drop the queue + halt the current clip). */
export class TtsClient {
  private ws: WebSocket | null = null;
  private queue: string[] = [];       // object URLs awaiting playback
  private current: HTMLAudioElement | null = null;
  private playing = false;
  private seq = 0;
  private onState?: (speaking: boolean) => void;

  constructor(onState?: (speaking: boolean) => void) {
    this.onState = onState;
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${VOICE_WS_BASE}/tts`);
      } catch (err) {
        reject(err);
        return;
      }
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("tts sidecar unreachable"));
      ws.onmessage = (e) => {
        let m: TtsChunk;
        try { m = JSON.parse(e.data as string) as TtsChunk; } catch { return; }
        if (m.type === "audio" && m.audio) {
          this.queue.push(b64ToUrl(m.audio, m.mime));
          this.pump();
        }
      };
      ws.onclose = () => { if (this.ws === ws) this.ws = null; };
      this.ws = ws;
    });
  }

  private pump(): void {
    if (this.playing) return;
    const url = this.queue.shift();
    if (!url) {
      if (!this.current) this.onState?.(false);
      return;
    }
    this.playing = true;
    this.onState?.(true);
    const a = new Audio(url);
    this.current = a;
    const done = () => {
      URL.revokeObjectURL(url);
      this.playing = false;
      if (this.current === a) this.current = null;
      this.pump();
    };
    a.onended = done;
    a.onerror = done;
    void a.play().catch(done);
  }

  /** Speak text through the built-in sidecar (already spoken-cleaned, or we
   *  clean it here). */
  async speak(text: string, voice: string, speed = 1): Promise<void> {
    const clean = sanitizeForSpeech(text);
    if (!clean) return;
    const ws = await this.connect();
    ws.send(JSON.stringify({ type: "speak", id: `s${++this.seq}`, text: clean, voice, speed }));
  }

  /** Enqueue externally-produced audio (a TTS-provider SKILL's output) onto the
   *  SAME queue + player, so barge-in and ordering work identically whether the
   *  audio came from the built-in sidecar or a provider skill. */
  enqueueAudio(base64: string, mime?: string): void {
    if (!base64) return;
    this.queue.push(b64ToUrl(base64, mime));
    this.pump();
  }

  /** Barge-in: silence everything now. */
  stop(): void {
    this.queue.forEach((u) => URL.revokeObjectURL(u));
    this.queue = [];
    if (this.current) { try { this.current.pause(); } catch { /* ignore */ } this.current = null; }
    this.playing = false;
    try { this.ws?.send(JSON.stringify({ type: "cancel" })); } catch { /* ignore */ }
    this.onState?.(false);
  }

  dispose(): void {
    this.stop();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

function b64ToUrl(b64: string, mime?: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || "audio/wav" }));
}

/** Fetch the sidecar's voice catalog (empty when it isn't running). */
export async function fetchVoices(signal?: AbortSignal): Promise<{ voices: VoiceInfo[]; default: string }> {
  try {
    const res = await fetch(`${VOICE_HTTP_BASE}/voices`, { signal });
    if (!res.ok) return { voices: [], default: "" };
    const data = (await res.json()) as { voices?: VoiceInfo[]; default?: string };
    return { voices: data.voices ?? [], default: data.default ?? "" };
  } catch {
    return { voices: [], default: "" };
  }
}

// ── React hook: the voice bus ───────────────────────────────────────────────

/** A TTS-provider SKILL: given text, return audio (or null). When set, the bus
 *  routes speech through it instead of the built-in sidecar — this is how any
 *  voice engine (Piper, ElevenLabs, …) overrides the default. */
export type ProviderSpeak = (text: string, voice: string, speed: number) => Promise<{ audio?: string; mime?: string } | null>;

export interface UseTtsOptions {
  enabled: boolean;
  voice: string;
  speed?: number;
  /** When present, speech is produced by this provider skill; the built-in
   *  sidecar is the fallback (and the default when this is undefined). */
  provider?: ProviderSpeak;
}

/** The app's TTS bus. Keeps one TtsClient for the session; `speak` no-ops when
 *  disabled, `stop` is the barge-in used by conversation mode + manual stop. */
export function useTts(opts: UseTtsOptions) {
  const clientRef = useRef<TtsClient | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const client = new TtsClient((s) => setSpeaking(s));
    clientRef.current = client;
    return () => { client.dispose(); clientRef.current = null; };
  }, []);

  // Disabling voice mid-utterance stops it immediately.
  useEffect(() => {
    if (!opts.enabled) clientRef.current?.stop();
  }, [opts.enabled]);

  const speak = useCallback((text: string) => {
    const o = optsRef.current;
    if (!o.enabled || !o.voice) return;
    const client = clientRef.current;
    if (!client) return;
    if (o.provider) {
      // Provider skill: sanitize, hand it the clean text, play what it returns.
      const clean = sanitizeForSpeech(text);
      if (!clean) return;
      void o.provider(clean, o.voice, o.speed ?? 1)
        .then((out) => { if (out?.audio) client.enqueueAudio(out.audio, out.mime); })
        .catch(() => { /* provider failed — stay silent, never error per reply */ });
      return;
    }
    void client.speak(text, o.voice, o.speed ?? 1).catch(() => {
      // Sidecar down — stay silent rather than surface an error per reply.
    });
  }, []);

  const stop = useCallback(() => clientRef.current?.stop(), []);

  return { speak, stop, speaking };
}

// ── Sidecar STT (push-to-talk) ───────────────────────────────────────────────

export interface SttHandle {
  /** Resolves with the transcript (empty string if nothing recognized). */
  stop: () => Promise<string>;
  cancel: () => void;
}

/**
 * Start a push-to-talk STT capture on the sidecar. The sidecar records the mic
 * server-side; we get status events and, on stop, the transcript. Rejects fast
 * if the sidecar isn't reachable so the caller can fall back to the legacy path.
 */
export function sidecarListen(onStatus?: (s: "connecting" | "listening" | "transcribing") => void): Promise<SttHandle> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${VOICE_WS_BASE}/stt`);
    } catch (err) {
      reject(err);
      return;
    }
    let settledOpen = false;
    let transcriptResolve: ((t: string) => void) | null = null;

    const failOpen = () => { if (!settledOpen) { settledOpen = true; reject(new Error("stt sidecar unreachable")); } };
    ws.onerror = failOpen;
    ws.onclose = () => { failOpen(); transcriptResolve?.(""); transcriptResolve = null; };

    ws.onopen = () => {
      onStatus?.("connecting");
      ws.send(JSON.stringify({ type: "listen_start" }));
    };
    ws.onmessage = (e) => {
      let m: { type: string; text?: string; available?: boolean };
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.type === "ready" && m.available === false) { failOpen(); try { ws.close(); } catch { /* ignore */ } return; }
      if (m.type === "listening") { if (!settledOpen) { settledOpen = true; resolve(handle); } onStatus?.("listening"); }
      if (m.type === "transcribing") onStatus?.("transcribing");
      if (m.type === "transcript") { transcriptResolve?.(m.text ?? ""); transcriptResolve = null; try { ws.close(); } catch { /* ignore */ } }
      if (m.type === "cancelled") { transcriptResolve?.(""); transcriptResolve = null; try { ws.close(); } catch { /* ignore */ } }
      if (m.type === "error") { transcriptResolve?.(""); transcriptResolve = null; }
    };

    const handle: SttHandle = {
      stop: () =>
        new Promise<string>((res) => {
          transcriptResolve = res;
          try { ws.send(JSON.stringify({ type: "listen_stop" })); } catch { res(""); }
        }),
      cancel: () => { try { ws.send(JSON.stringify({ type: "listen_cancel" })); ws.close(); } catch { /* ignore */ } },
    };
  });
}
