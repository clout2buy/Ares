// Engine binary installer — closes the last gap: fetch a llama.cpp multimodal
// build (llama-mtmd-cli) so Ares's local eyes can actually run, with zero manual
// setup. On "Awaken" the daemon pulls the CPU Windows build from the official
// ggml-org/llama.cpp releases, extracts it, and flattens the exe + its DLLs into
// <home>/engine — exactly where resolveEngineBinary() looks. No system install,
// no toolchain, no Ollama: Ares installs its own inference engine.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

const LATEST_RELEASE_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
/** Pinned fallback if the GitHub API is unreachable / rate-limited. */
const FALLBACK_TAG = "b9704";
const FALLBACK_ASSET = `llama-${FALLBACK_TAG}-bin-win-cpu-x64.zip`;
const FALLBACK_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${FALLBACK_TAG}/${FALLBACK_ASSET}`;

/** The multimodal CLI the vision engine drives. */
const TARGET_EXE = "llama-mtmd-cli.exe";

export function engineDir(home: string): string {
  return path.join(home, "engine");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface EngineDownloadProgress {
  id: "engine";
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  pct: number;
}

/** True once the multimodal binary is installed in <home>/engine. */
export async function engineBinaryInstalled(home: string): Promise<boolean> {
  return exists(path.join(engineDir(home), TARGET_EXE));
}

interface ResolvedAsset {
  url: string;
  name: string;
  bytes: number;
}

/** Pick the Windows CPU x64 build from the latest release; fall back to a pinned
 *  one when the API is unavailable. CPU build = no GPU/runtime dependency. */
async function resolveAsset(signal?: AbortSignal): Promise<ResolvedAsset> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ares" },
    });
    if (res.ok) {
      const json = (await res.json()) as { assets?: Array<{ name: string; browser_download_url: string; size: number }> };
      const assets = json.assets ?? [];
      const pick =
        assets.find((a) => /bin-win-cpu-x64\.zip$/i.test(a.name)) ??
        assets.find((a) => /bin-win-.*x64\.zip$/i.test(a.name) && !/cuda|hip|sycl|openvino/i.test(a.name));
      if (pick) return { url: pick.browser_download_url, name: pick.name, bytes: pick.size };
    }
  } catch {
    // fall through to the pinned asset
  }
  return { url: FALLBACK_URL, name: FALLBACK_ASSET, bytes: 16 * 1048576 };
}

async function downloadZip(
  url: string,
  dest: string,
  expectedBytes: number,
  onProgress: (p: EngineDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal, redirect: "follow", headers: { "User-Agent": "ares" } });
  if (!res.ok || !res.body) throw new Error(`engine download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || expectedBytes;
  const file = createWriteStream(dest);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let received = 0;
  let lastPct = -1;
  let lastTs = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (!file.write(Buffer.from(value))) await new Promise<void>((r) => file.once("drain", r));
      const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      const now = Date.now();
      if (pct !== lastPct && now - lastTs >= 400) {
        lastPct = pct;
        lastTs = now;
        onProgress({ id: "engine", filename: "vision engine", receivedBytes: received, totalBytes: total, pct });
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

/** Expand a .zip with PowerShell (no external dep). */
async function expandZip(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ps = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip failed (${code}): ${err.slice(0, 200)}`))));
  });
}

/** Find TARGET_EXE anywhere under root; return the directory that contains it
 *  (the exe needs its sibling DLLs). */
async function findExeDir(root: string): Promise<string | null> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === TARGET_EXE) {
      // Node's recursive Dirent.parentPath/path holds the containing dir.
      const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path?: string }).path;
      return parent ?? root;
    }
  }
  return null;
}

export interface PrepareEngineResult {
  installed: boolean;
  binary?: string;
  skipped?: boolean;
}

/**
 * Ensure the vision engine binary is installed in <home>/engine. Idempotent:
 * returns immediately if already present. Windows-only for now.
 */
export async function prepareEngineBinary(
  home: string,
  onProgress: (p: EngineDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<PrepareEngineResult> {
  if (process.platform !== "win32") return { installed: false, skipped: true };
  const dir = engineDir(home);
  const target = path.join(dir, TARGET_EXE);
  if (await exists(target)) return { installed: true, binary: target };

  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, ".tmp");
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const asset = await resolveAsset(signal);
  const zipPath = path.join(tmp, asset.name);
  await downloadZip(asset.url, zipPath, asset.bytes, onProgress, signal);

  const extractDir = path.join(tmp, "x");
  await mkdir(extractDir, { recursive: true });
  await expandZip(zipPath, extractDir);

  const exeDir = await findExeDir(extractDir);
  if (!exeDir) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`${TARGET_EXE} not found in downloaded build`);
  }

  // Flatten the exe + all sibling files (DLLs) into <home>/engine.
  for (const f of await readdir(exeDir, { withFileTypes: true })) {
    if (f.isFile()) await copyFile(path.join(exeDir, f.name), path.join(dir, f.name));
  }
  await rm(tmp, { recursive: true, force: true });

  if (!(await exists(target))) throw new Error("engine install completed but binary is missing");
  // Sanity: a non-trivial exe.
  if ((await stat(target)).size < 10_000) throw new Error("engine binary looks corrupt (too small)");
  onProgress({ id: "engine", filename: "vision engine", receivedBytes: asset.bytes, totalBytes: asset.bytes, pct: 100 });
  return { installed: true, binary: target };
}
