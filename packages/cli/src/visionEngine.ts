// Vision engine — STAGE 2 of Consciousness. The embedded local "eyes."
//
// Ares drives a llama.cpp multimodal CLI (`llama-mtmd-cli`) over the SmolVLM
// weights pulled by the model manager. It runs locally, needs no provider/key,
// and is fully self-contained — the binary is bundled (or dropped into
// <home>/engine), so to the outside world Ares simply interprets the screen by
// itself. This module resolves the binary + weights, builds the invocation, and
// turns a screenshot into a one-line description. The always-on loop that calls
// it lives in watch.ts.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import { CONSCIOUSNESS_MODELS, modelsDir } from "./consciousness.js";

const BINARY_NAMES =
  process.platform === "win32"
    ? ["llama-mtmd-cli.exe", "llama-mtmd.exe", "llava-cli.exe"]
    : ["llama-mtmd-cli", "llama-mtmd", "llava-cli"];

/** Thrown when the eyes aren't installed yet — the loop degrades quietly. */
export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the multimodal binary may live: an explicit override, then <home>/engine,
 *  then alongside the bundled runtime (resourced with the app). */
export function engineSearchDirs(home: string): string[] {
  const dirs: string[] = [];
  if (process.env.ARES_LLAMA_MTMD) dirs.push(path.dirname(process.env.ARES_LLAMA_MTMD));
  dirs.push(path.join(home, "engine"));
  if (process.env.ARES_RUNTIME_DIR) dirs.push(path.join(process.env.ARES_RUNTIME_DIR, "engine"));
  return dirs;
}

export async function resolveEngineBinary(home: string): Promise<string | null> {
  if (process.env.ARES_LLAMA_MTMD && (await exists(process.env.ARES_LLAMA_MTMD))) {
    return process.env.ARES_LLAMA_MTMD;
  }
  for (const dir of engineSearchDirs(home)) {
    for (const name of BINARY_NAMES) {
      const full = path.join(dir, name);
      if (await exists(full)) return full;
    }
  }
  return null;
}

export interface VisionModelPaths {
  model: string;
  mmproj: string;
  ready: boolean;
}

export async function visionModelPaths(home: string): Promise<VisionModelPaths> {
  const dir = modelsDir(home);
  // Derive from the single source of truth (the manifest) so a model swap never
  // silently breaks the engine.
  const visionModel = CONSCIOUSNESS_MODELS.find((m) => m.role === "vision");
  const projector = CONSCIOUSNESS_MODELS.find((m) => m.role === "vision-projector");
  const model = path.join(dir, visionModel?.filename ?? "__missing_vision_model__");
  const mmproj = path.join(dir, projector?.filename ?? "__missing_mmproj__");
  const ready = Boolean(visionModel && projector) && (await exists(model)) && (await exists(mmproj));
  return { model, mmproj, ready };
}

export interface EngineStatus {
  binary: string | null;
  modelsReady: boolean;
  available: boolean;
}

export async function engineStatus(home: string): Promise<EngineStatus> {
  const binary = await resolveEngineBinary(home);
  const { ready } = await visionModelPaths(home);
  return { binary, modelsReady: ready, available: Boolean(binary) && ready };
}

export interface DescribeOptions {
  prompt?: string;
  maxTokens?: number;
  /** GPU layers to offload (0 = CPU only). */
  gpuLayers?: number;
  timeoutMs?: number;
}

/** The watcher's read is deliberately terse and STRICTLY factual — present
 *  tense, only what is literally visible. No narrative, no history, no guessing;
 *  the eerie tone is applied later, only if it decides to speak. */
const DEFAULT_PROMPT =
  "Look at this screenshot. In ONE short factual sentence, state only what is " +
  "literally visible right now: the foreground app/window and what is on screen. " +
  "Use the present tense. Do NOT guess intent, invent history, or mention anything " +
  "not visible. If the screen is unclear, say exactly: unclear.";

/** Pure: build the llama-mtmd-cli argument vector. Exported for testing. */
export function buildVisionArgs(
  paths: VisionModelPaths,
  imagePath: string,
  opts: DescribeOptions = {},
): string[] {
  // Only widely-supported flags — an unknown flag aborts the whole run, so we
  // keep it conservative and strip any echoed prompt in cleanVisionOutput.
  return [
    "-m", paths.model,
    "--mmproj", paths.mmproj,
    "--image", imagePath,
    "-p", opts.prompt ?? DEFAULT_PROMPT,
    "-n", String(opts.maxTokens ?? 80),
    "--temp", "0.2",
    "-ngl", String(opts.gpuLayers ?? 99),
  ];
}

/** Clean the model's stdout into a single tidy line. Strips llama.cpp's
 *  diagnostic lines and any echoed prompt (some builds print the prompt before
 *  the answer when --no-display-prompt isn't passed). */
export function cleanVisionOutput(raw: string, prompt?: string): string {
  let text = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^(llama_|clip_|mtmd_|llava_|main:|sampler|encode_image|ggml_|build:|system_info|print_info|load_|n_past|eval:|warning:|<__media__>)/i.test(l),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (prompt) {
    const p = prompt.trim();
    const idx = text.indexOf(p);
    if (idx !== -1) text = text.slice(idx + p.length).trim();
  }
  return text;
}

/**
 * Interpret one screenshot. Throws EngineUnavailableError when the eyes aren't
 * installed (no binary or no weights) so the watch loop can skip a tick quietly.
 */
export async function describeImage(home: string, imagePath: string, opts: DescribeOptions = {}): Promise<string> {
  const binary = await resolveEngineBinary(home);
  const paths = await visionModelPaths(home);
  if (!binary) throw new EngineUnavailableError("vision engine binary not installed");
  if (!paths.ready) throw new EngineUnavailableError("vision model weights not present");

  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const args = buildVisionArgs(paths, imagePath, opts);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`vision inference timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = cleanVisionOutput(out, prompt);
      if (code !== 0 && text.length === 0) {
        reject(new Error(`vision engine exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      resolve(text);
    });
  });
}
