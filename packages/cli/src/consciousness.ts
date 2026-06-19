// Consciousness — Ares's embedded local "watcher" brain. STAGE 1: the model
// manager. When the owner awakens Consciousness, Ares pulls the tiny models it
// watches and remembers with — a small vision model (sees the screen, fully
// offline) and an embedding model (vector memory / RAG) — into <home>/models.
// No Ollama, no provider, no API key: these are meant to run INSIDE Ares via the
// embedded llama.cpp engine (a later stage). This module only fetches + tracks
// the weights; the engine that loads them and the screen-watch loop come next.

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

export type ConsciousnessRole = "vision" | "vision-projector" | "embedding";

export interface ConsciousnessModel {
  id: string;
  role: ConsciousnessRole;
  label: string;
  filename: string;
  url: string;
  /** Expected size in bytes (from the HF CDN) — drives accurate progress. */
  bytes: number;
}

/**
 * The local brain's weights. SmolVLM-500M is a purpose-built tiny VLM (sees the
 * screen on CPU); its mmproj is the vision projector llama.cpp needs for images.
 * Nomic-embed powers the vector memory. ~600MB total, pulled once on first awaken.
 */
export const CONSCIOUSNESS_MODELS: readonly ConsciousnessModel[] = [
  {
    id: "smolvlm-500m",
    role: "vision",
    label: "SmolVLM 500M — the eyes",
    filename: "SmolVLM-500M-Instruct-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf",
    bytes: 436_806_912,
  },
  {
    id: "smolvlm-500m-mmproj",
    role: "vision-projector",
    label: "SmolVLM vision projector",
    filename: "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
    bytes: 108_783_360,
  },
  {
    id: "nomic-embed-1.5",
    role: "embedding",
    label: "Nomic Embed v1.5 — memory",
    filename: "nomic-embed-text-v1.5.Q4_K_M.gguf",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf",
    bytes: 84_106_624,
  },
] as const;

export function modelsDir(home: string): string {
  return path.join(home, "models");
}

export interface ModelStatus {
  id: string;
  role: ConsciousnessRole;
  label: string;
  filename: string;
  bytes: number;
  present: boolean;
  downloadedBytes: number;
}

/** A file within 1% of expected size counts as complete — CDN revisions wobble. */
function isComplete(size: number, expected: number): boolean {
  return size >= expected * 0.99;
}

export async function consciousnessStatus(home: string): Promise<ModelStatus[]> {
  const dir = modelsDir(home);
  const out: ModelStatus[] = [];
  for (const m of CONSCIOUSNESS_MODELS) {
    let present = false;
    let downloadedBytes = 0;
    try {
      const st = await stat(path.join(dir, m.filename));
      downloadedBytes = st.size;
      present = isComplete(st.size, m.bytes);
    } catch {
      present = false;
    }
    out.push({ id: m.id, role: m.role, label: m.label, filename: m.filename, bytes: m.bytes, present, downloadedBytes });
  }
  return out;
}

export interface DownloadProgress {
  id: string;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  pct: number;
}

/** Available free bytes on the volume holding `dir`, or null if undeterminable. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

/** A single download pass — resumes from an existing .part via HTTP Range when
 *  the server supports it; falls back to a clean restart when it doesn't. */
async function downloadOnce(
  partPath: string,
  model: ConsciousnessModel,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  let startByte = 0;
  try {
    startByte = (await stat(partPath)).size;
  } catch {
    startByte = 0;
  }

  const headers: Record<string, string> = {};
  if (startByte > 0) headers.Range = `bytes=${startByte}-`;
  const res = await fetch(model.url, { signal, redirect: "follow", headers });

  // 416 = the .part is already at/past EOF (a complete file whose rename never
  // ran). Nothing to fetch; the caller's size guard renames it.
  if (res.status === 416) {
    void res.body?.cancel();
    return;
  }

  let received = startByte;
  let append = false;
  if (res.status === 206) {
    append = true; // server honored the Range — resume
  } else if (res.ok) {
    append = false; // server ignored Range — start over
    received = 0;
    startByte = 0;
  } else {
    throw new Error(`download ${model.filename} failed: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`download ${model.filename} failed: empty body`);

  // total: prefer the content-range total; else startByte + content-length; else manifest.
  let total = model.bytes;
  const cr = res.headers.get("content-range");
  const crTotal = cr && /\/(\d+)$/.exec(cr)?.[1];
  if (crTotal) total = Number(crTotal);
  else {
    const len = Number(res.headers.get("content-length"));
    if (len > 0) total = startByte + len;
  }

  const file = createWriteStream(partPath, { flags: append ? "a" : "w" });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let lastPct = -1;
  let lastTs = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
      const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      const now = Date.now();
      if (pct !== lastPct && now - lastTs >= 400) {
        lastPct = pct;
        lastTs = now;
        onProgress({ id: model.id, filename: model.filename, receivedBytes: received, totalBytes: total, pct });
      }
    }
  } finally {
    reader.releaseLock();
    file.end();
  }
  await new Promise<void>((resolve, reject) => {
    file.on("finish", () => resolve());
    file.on("error", reject);
  });
}

/**
 * Download one model into <home>/models, streaming to a .part file then
 * atomically renaming on success (so a half-file is never mistaken for ready).
 * Skips when already complete. Resumable across interruptions and retried with
 * backoff on transient network failures. Progress is throttled to ~1%/400ms.
 */
export async function downloadConsciousnessModel(
  home: string,
  model: ConsciousnessModel,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const dir = modelsDir(home);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, model.filename);
  try {
    if (isComplete((await stat(dest)).size, model.bytes)) return;
  } catch {
    // not present — download it
  }

  const partPath = `${dest}.part`;

  // A complete .part whose rename never ran (crash/kill between finish and
  // rename): finish it now, no network round-trip.
  try {
    const partSize = (await stat(partPath)).size;
    if (isComplete(partSize, model.bytes)) {
      await rename(partPath, dest);
      onProgress({ id: model.id, filename: model.filename, receivedBytes: partSize, totalBytes: partSize, pct: 100 });
      return;
    }
  } catch {
    // no .part yet — normal first download
  }

  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(partPath, model, onProgress, signal);
      break;
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw err;
      if (attempt >= maxAttempts) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt), signal); // 1s, 2s, 4s
    }
  }

  // Guard against a truncated file masquerading as done.
  const finalSize = (await stat(partPath)).size;
  if (!isComplete(finalSize, model.bytes)) {
    throw new Error(`download ${model.filename} ended undersized (${finalSize}/${model.bytes})`);
  }
  await rename(partPath, dest);
  onProgress({ id: model.id, filename: model.filename, receivedBytes: finalSize, totalBytes: finalSize, pct: 100 });
}

/** Pull every missing weight in sequence. onModelReady fires per completed file.
 *  Preflights free disk space against the total still needed. */
export async function downloadAllConsciousnessModels(
  home: string,
  onProgress: (p: DownloadProgress) => void,
  onModelReady: (model: ConsciousnessModel) => void,
  signal?: AbortSignal,
): Promise<void> {
  const dir = modelsDir(home);
  await mkdir(dir, { recursive: true }); // so the disk check below actually runs on a fresh install
  const status = await consciousnessStatus(home);
  const missing = CONSCIOUSNESS_MODELS.filter((m) => !status.find((s) => s.id === m.id)?.present);
  const needed = missing.reduce((sum, m) => sum + m.bytes, 0);
  const free = await freeBytes(dir);
  if (free !== null && needed > 0 && free < needed * 1.1) {
    throw new Error(
      `not enough disk space: need ~${(needed / 1048576).toFixed(0)} MB, ~${(free / 1048576).toFixed(0)} MB free`,
    );
  }
  for (const model of CONSCIOUSNESS_MODELS) {
    await downloadConsciousnessModel(home, model, onProgress, signal);
    onModelReady(model);
  }
}
