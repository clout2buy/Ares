// Godot process control: find the executable, read project.godot, run headless
// checks, and host instrumented play sessions. Nothing here guesses success —
// every run returns the engine's own stdout/stderr classified into errors.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { rpcCall, rpcPing, waitForPort, sleep } from "./net.js";

const IS_WIN = process.platform === "win32";

// ---- project ----------------------------------------------------------------

export async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

export function resToAbs(root, p) {
  const s = String(p ?? "");
  if (s.startsWith("res://")) return path.join(root, s.slice(6));
  if (s.startsWith("user://")) return s;
  if (path.isAbsolute(s)) return s;
  return path.join(root, s);
}

export function absToRes(root, p) {
  const rel = path.relative(root, p).split(path.sep).join("/");
  return rel.startsWith("..") ? p : `res://${rel}`;
}

/** Minimal INI-ish parser for project.godot / .cfg files (values kept raw). */
export function parseGodotIni(text) {
  const sections = { "": {} };
  let current = "";
  let pendingKey = null;
  let pendingVal = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (pendingKey) {
      pendingVal += "\n" + line;
      if (balancedBrackets(pendingVal)) {
        sections[current][pendingKey] = pendingVal;
        pendingKey = null;
      }
      continue;
    }
    if (!line.trim() || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]\s*$/);
    if (sec) {
      current = sec[1];
      sections[current] ??= {};
      continue;
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kv) continue;
    if (balancedBrackets(kv[2])) sections[current][kv[1]] = kv[2];
    else {
      pendingKey = kv[1];
      pendingVal = kv[2];
    }
  }
  return sections;
}

function balancedBrackets(text) {
  let depth = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return depth <= 0 && !inStr;
}

function unquote(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

export async function readProject(root) {
  const file = path.join(root, "project.godot");
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const ini = parseGodotIni(text);
  const app = ini.application ?? {};
  const featuresRaw = String(app["config/features"] ?? "");
  const features = [...featuresRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const autoloads = Object.fromEntries(Object.entries(ini.autoload ?? {}).map(([k, v]) => [k, unquote(v)]));
  const inputs = Object.keys(ini.input ?? {});
  const plugins = [...String(ini.editor_plugins?.enabled ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const dotnet = (await fs.readdir(root).catch(() => [])).some((n) => n.endsWith(".csproj") || n.endsWith(".sln"));
  return {
    file,
    name: unquote(app["config/name"]) ?? path.basename(root),
    mainScene: unquote(app["run/main_scene"]) ?? null,
    configVersion: Number(ini[""].config_version ?? 0),
    features,
    engineVersion: features.find((f) => /^\d+\.\d+/.test(f)) ?? null,
    dotnet: dotnet || features.includes("C#"),
    renderer: unquote(ini.rendering?.["renderer/rendering_method"]) ?? "forward_plus",
    viewport: {
      width: unquote(ini.display?.["window/size/viewport_width"]) ?? 1152,
      height: unquote(ini.display?.["window/size/viewport_height"]) ?? 648,
      stretch: unquote(ini.display?.["window/stretch/mode"]) ?? "disabled",
    },
    physics: {
      ticksPerSecond: unquote(ini.physics?.["common/physics_ticks_per_second"]) ?? 60,
      gravity3d: unquote(ini.physics?.["3d/default_gravity"]) ?? 9.8,
      gravity2d: unquote(ini.physics?.["2d/default_gravity"]) ?? 980,
      engine3d: unquote(ini.physics?.["3d/physics_engine"]) ?? "DEFAULT",
    },
    autoloads,
    inputActions: inputs,
    plugins,
    aresBridgeEnabled: plugins.some((p) => p.includes("ares_bridge")),
    sections: Object.keys(ini).filter(Boolean),
  };
}

export async function readAresConfig(root, home) {
  const out = { bridgePort: 6505, runtimePort: 6506, godotPath: null, source: [] };
  for (const [file, label] of [[path.join(home ?? "", "godot.json"), "home"], [path.join(root, ".ares", "godot.json"), "project"]]) {
    if (!file || file === "godot.json") continue;
    try {
      const cfg = JSON.parse(await fs.readFile(file, "utf8"));
      if (cfg.bridgePort) out.bridgePort = Number(cfg.bridgePort);
      if (cfg.runtimePort) out.runtimePort = Number(cfg.runtimePort);
      if (cfg.godotPath) out.godotPath = String(cfg.godotPath);
      out.source.push(label);
    } catch {
      // absent
    }
  }
  return out;
}

// ---- locate -------------------------------------------------------------------

function candidateDirs() {
  const home = os.homedir();
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(local, "Programs", "Godot"),
      path.join(local, "Godot"),
      path.join(local, "Microsoft", "WinGet", "Packages"),
      "C:\\Program Files\\Godot",
      "C:\\Godot",
      "D:\\Godot",
      "D:\\Tools",
      "D:\\Tools\\Godot",
      path.join(home, "scoop", "apps", "godot", "current"),
      path.join(home, "scoop", "apps", "godot-mono", "current"),
      path.join(home, "Downloads"),
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
      "C:\\Program Files\\Epic Games",
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/Godot.app/Contents/MacOS", "/Applications/Godot_mono.app/Contents/MacOS", path.join(home, "Applications/Godot.app/Contents/MacOS"), "/opt/homebrew/bin", "/usr/local/bin"];
  }
  return ["/usr/bin", "/usr/local/bin", path.join(home, ".local", "bin"), "/opt/godot", "/snap/bin", path.join(home, "Downloads"), "/var/lib/flatpak/exports/bin"];
}

const EXE_RE = IS_WIN ? /^godot.*\.exe$/i : /^godot/i;

async function listExecutables(dir, depth = 0) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && EXE_RE.test(e.name) && !/\.(zip|txt|sha256|pck|json)$/i.test(e.name)) out.push(full);
    else if (e.isDirectory() && depth < 2 && /godot/i.test(e.name)) out.push(...(await listExecutables(full, depth + 1)));
  }
  return out;
}

async function whichAll(names) {
  const tool = IS_WIN ? "where.exe" : "which";
  const found = [];
  for (const name of names) {
    const { stdout } = await exec(tool, [name], { timeoutMs: 4000 }).catch(() => ({ stdout: "" }));
    for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) found.push(line);
  }
  return found;
}

function scoreCandidate(p, { dotnet }) {
  const base = path.basename(p).toLowerCase();
  let score = 0;
  if (/mono|dotnet/.test(base)) score += dotnet ? 50 : -20;
  if (IS_WIN && /console/.test(base)) score += 10; // console build pipes stdout reliably for headless/log capture
  const ver = base.match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (ver) score += Number(ver[1]) * 100 + Number(ver[2]) * 10 + Number(ver[3] ?? 0);
  if (/\b3\.\d/.test(base)) score -= 1000;
  return score;
}

export async function locateGodot({ root, home, dotnet = false, verify = true } = {}) {
  const cfg = await readAresConfig(root ?? process.cwd(), home);
  const explicit = [process.env.ARES_GODOT, process.env.GODOT, process.env.GODOT4_BIN, cfg.godotPath].filter(Boolean);
  const candidates = [];
  for (const p of explicit) if (await exists(p)) candidates.push({ path: p, from: "configured" });
  for (const p of await whichAll(IS_WIN ? ["godot", "godot4", "godot-mono", "Godot"] : ["godot", "godot4", "godot-mono", "godot4-mono", "org.godotengine.Godot"])) {
    if (!candidates.some((c) => c.path === p)) candidates.push({ path: p, from: "PATH" });
  }
  for (const dir of candidateDirs()) {
    for (const p of await listExecutables(dir)) if (!candidates.some((c) => c.path === p)) candidates.push({ path: p, from: dir });
  }
  const sorted = candidates
    .map((c) => ({ ...c, score: (c.from === "configured" ? 10_000 : 0) + scoreCandidate(c.path, { dotnet }) }))
    .sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return { found: false, candidates: [], hint: "Install Godot 4 (godotengine.org/download) and set ARES_GODOT=<path to exe>, or run `ares godot init --godot <path>`." };
  const pick = sorted[0];
  let version = null;
  if (verify) {
    const { stdout, stderr } = await exec(pick.path, ["--version"], { timeoutMs: 12_000 }).catch((e) => ({ stdout: "", stderr: String(e) }));
    version = (stdout + stderr).trim().split(/\r?\n/).find((l) => /^\d+\.\d+/.test(l)) ?? (stdout + stderr).trim().slice(0, 80) ?? null;
  }
  return { found: true, path: pick.path, from: pick.from, version, candidates: sorted.slice(0, 8).map((c) => c.path), mono: /mono|dotnet/i.test(path.basename(pick.path)) };
}

export async function rememberGodot(home, godotPath, version) {
  if (!home) return;
  const file = path.join(home, "godot.json");
  let cfg = {};
  try {
    cfg = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // fresh
  }
  cfg.godotPath = godotPath;
  cfg.version = version;
  cfg.checkedAt = new Date().toISOString();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ---- processes ------------------------------------------------------------

export function exec(command, args, { cwd, env, timeoutMs = 60_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, ...(env ?? {}) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "", stderr = "", timedOut = false;
    const cap = (s) => (s.length > 400_000 ? s.slice(-400_000) : s);
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      stdout = cap(stdout + s);
      onLine?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      stderr = cap(stderr + s);
      onLine?.(s);
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    try {
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}

// ---- diagnostics -----------------------------------------------------------

const ERROR_PATTERNS = [
  /SCRIPT ERROR/i,
  /Parse Error/i,
  /^ERROR:/m,
  /error CS\d+/,
  /Failed to load (script|resource|scene)/i,
  /Cannot (open|load) file/i,
  /Invalid (call|get index|set index|operands|access|type)/i,
  /Resource file not found/i,
  /Unexpected token/i,
  /Identifier .* not declared/i,
  /Could not find type/i,
  /Node not found/i,
  /Nonexistent function/i,
  /Attempt to call function .* on a null instance/i,
  /Condition ".*" is true/,
  /Division by zero/i,
  /Out of bounds/i,
  /Stack overflow/i,
];

/** Turn raw engine output into structured diagnostics. */
export function classifyOutput(text) {
  const errors = [], warnings = [], info = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const isError = ERROR_PATTERNS.some((re) => re.test(line)) || /^USER ERROR/.test(line);
    const isWarning = /WARNING|USER WARNING|deprecated/i.test(line) && !isError;
    if (!isError && !isWarning) {
      if (/Godot Engine v|Vulkan|OpenGL|Using .* renderer|Ares (bridge|runtime)/i.test(line)) info.push(line);
      continue;
    }
    // Godot prints location on the following "at:" line.
    let at = "";
    for (let k = 1; k <= 3 && i + k < lines.length; k++) {
      const next = lines[i + k].trim();
      if (/^at:|^\s*at /.test(next) || /\(res:\/\/.*:\d+\)/.test(next)) {
        at = next.replace(/^at:\s*/, "");
        break;
      }
    }
    const loc = (line + " " + at).match(/(res:\/\/[^\s:)]+):(\d+)/) ?? (line + " " + at).match(/([\w./\\-]+\.(?:gd|cs|tscn))[:(](\d+)/);
    const entry = { message: line.replace(/^(SCRIPT ERROR|ERROR|WARNING|USER ERROR|USER WARNING):\s*/, ""), file: loc?.[1] ?? null, line: loc ? Number(loc[2]) : null, at: at || undefined };
    const key = `${entry.file}:${entry.line}:${entry.message.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (isError ? errors : warnings).push(entry);
  }
  return { errors, warnings, info };
}

export async function listScripts(root, { exts = ["gd"], limit = 400 } = {}) {
  const out = [];
  const skip = new Set([".git", ".godot", ".import", "node_modules", ".ares", ".mono", "bin", "obj"]);
  const walk = async (dir, depth) => {
    if (depth > 12 || out.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= limit) return;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (exts.includes(e.name.split(".").pop().toLowerCase())) out.push(full);
    }
  };
  await walk(root, 0);
  return out;
}

export async function listAssets(root, { limit = 600 } = {}) {
  const groups = { scenes: [], scripts: [], models: [], textures: [], audio: [], shaders: [], resources: [], fonts: [], other: [] };
  const map = { tscn: "scenes", scn: "scenes", gd: "scripts", cs: "scripts", glb: "models", gltf: "models", obj: "models", fbx: "models", dae: "models", blend: "models", png: "textures", jpg: "textures", jpeg: "textures", webp: "textures", svg: "textures", exr: "textures", hdr: "textures", wav: "audio", ogg: "audio", mp3: "audio", gdshader: "shaders", gdshaderinc: "shaders", tres: "resources", res: "resources", ttf: "fonts", otf: "fonts" };
  let count = 0;
  const skip = new Set([".git", ".godot", ".import", "node_modules", ".ares", ".mono", "bin", "obj", "addons"]);
  const walk = async (dir, depth) => {
    if (depth > 12 || count >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (count >= limit) return;
      if (skip.has(e.name) || e.name.endsWith(".import") || e.name.endsWith(".uid")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        const ext = e.name.split(".").pop().toLowerCase();
        const group = map[ext];
        if (!group) continue;
        groups[group].push(absToRes(root, full));
        count++;
      }
    }
  };
  await walk(root, 0);
  return groups;
}

// ---- headless check ---------------------------------------------------------

export async function checkScripts(godot, root, scripts, { concurrency = 4, timeoutMs = 25_000, onProgress } = {}) {
  const results = [];
  let index = 0;
  const worker = async () => {
    while (index < scripts.length) {
      const file = scripts[index++];
      const res = file.endsWith(".gd") ? absToRes(root, file) : file;
      const run = await exec(godot, ["--headless", "--path", root, "--check-only", "--script", res], { cwd: root, timeoutMs }).catch((e) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
      const diag = classifyOutput(run.stdout + "\n" + run.stderr);
      // --check-only exits non-zero on parse errors even when output is sparse.
      if (run.code !== 0 && diag.errors.length === 0) diag.errors.push({ message: run.timedOut ? `check timed out after ${timeoutMs}ms` : `exit code ${run.code}`, file: res, line: null });
      for (const e of diag.errors) e.file ??= res;
      results.push({ file: res, ok: diag.errors.length === 0, errors: diag.errors, warnings: diag.warnings });
      onProgress?.(results.length, scripts.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scripts.length) }, worker));
  return results;
}

export async function bootCheck(godot, root, { scene, frames = 3, timeoutMs = 60_000 } = {}) {
  const args = ["--headless", "--path", root, "--quit-after", String(frames)];
  if (scene) args.push(scene);
  let run = await exec(godot, args, { cwd: root, timeoutMs });
  if (/unrecognized|unknown (command line )?option.*quit-after/i.test(run.stderr + run.stdout)) {
    run = await exec(godot, ["--headless", "--path", root, "--quit", ...(scene ? [scene] : [])], { cwd: root, timeoutMs });
  }
  const diag = classifyOutput(run.stdout + "\n" + run.stderr);
  return { code: run.code, timedOut: run.timedOut, ...diag, tail: (run.stdout + run.stderr).split(/\r?\n/).filter(Boolean).slice(-40) };
}

export async function dotnetBuild(root, { timeoutMs = 240_000 } = {}) {
  const run = await exec(IS_WIN ? "dotnet.exe" : "dotnet", ["build", "--nologo", "-v", "q"], { cwd: root, timeoutMs }).catch((e) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
  const text = run.stdout + "\n" + run.stderr;
  const errors = [...new Set([...text.matchAll(/^(.*?)\((\d+),\d+\): error (CS\d+): (.*?)(?: \[|$)/gm)].map((m) => JSON.stringify({ file: m[1].trim(), line: Number(m[2]), message: `${m[3]}: ${m[4]}` })))].map((s) => JSON.parse(s));
  const warnings = [...text.matchAll(/warning (CS\d+): (.*?)(?: \[|$)/gm)].slice(0, 30).map((m) => ({ message: `${m[1]}: ${m[2]}` }));
  return { ok: run.code === 0, code: run.code, errors, warnings, tail: text.split(/\r?\n/).filter(Boolean).slice(-20) };
}

// ---- play session -----------------------------------------------------------

/** Launch the game with the Ares runtime enabled and hand back a controller. */
export async function launchGame(godot, root, { scene, runtimePort, width, height, headless = false, extraArgs = [], onLine, startupTimeoutMs = 45_000 } = {}) {
  const args = ["--path", root];
  if (headless) args.push("--headless");
  if (width && height) args.push("--resolution", `${width}x${height}`);
  args.push("--position", "60,60");
  args.push(...extraArgs);
  if (scene) args.push(scene);
  const env = { ARES_GODOT_RUNTIME: "1", ARES_GODOT_RUNTIME_PORT: String(runtimePort) };
  const child = spawn(godot, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (d) => {
    const s = d.toString("utf8");
    output = output.length > 600_000 ? output.slice(-600_000) + s : output + s;
    onLine?.(s);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let exited = false;
  let exitCode = null;
  child.once("close", (code) => {
    exited = true;
    exitCode = code;
  });
  const pong = await waitForPort(runtimePort, { timeoutMs: startupTimeoutMs, isAlive: () => !exited });
  return {
    pid: child.pid,
    args,
    ready: !!pong,
    pong,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get output() {
      return output;
    },
    call: (method, params, timeoutMs) => rpcCall(runtimePort, method, params, timeoutMs),
    async stop(graceMs = 2500) {
      if (exited) return exitCode;
      await rpcCall(runtimePort, "quit", {}, 2000).catch(() => {});
      const until = Date.now() + graceMs;
      while (!exited && Date.now() < until) await sleep(100);
      if (!exited) kill(child);
      return exitCode;
    },
    detach() {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.unref();
    },
  };
}

export { rpcPing };
