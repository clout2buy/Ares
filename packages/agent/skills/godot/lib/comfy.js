// ComfyUI client — Ares's door to local AI asset generation (TRELLIS.2 image→3D
// and whatever else the owner's ComfyUI can run). Talks to the HTTP API,
// converts the shipped UI-format workflows into API prompts using
// /object_info (so example_workflows/*.json work unchanged), uploads the
// input image, waits for the run, and returns the produced files.
//
// Config: ~/.ares/godot.json { "comfyDir": "D:/ComfyUI", "comfyUrl": "http://127.0.0.1:8188" }
// (defaults: D:/ComfyUI next to common installs, 127.0.0.1:8188). ComfyUI is
// started on demand with its own venv when it is not already listening.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { sleep } from "./net.js";

const DEFAULT_URL = "http://127.0.0.1:8188";

export async function comfyConfig(home) {
  const file = path.join(home || path.join(os.homedir(), ".ares"), "godot.json");
  let cfg = {};
  try {
    cfg = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // defaults
  }
  const candidates = [cfg.comfyDir, process.env.ARES_COMFY_DIR, "D:/ComfyUI", "C:/ComfyUI", path.join(os.homedir(), "ComfyUI")].filter(Boolean);
  let dir = null;
  for (const c of candidates) {
    if (await fs.stat(path.join(c, "main.py")).then((s) => s.isFile(), () => false)) {
      dir = path.resolve(c);
      break;
    }
  }
  return {
    dir,
    url: String(cfg.comfyUrl ?? process.env.ARES_COMFY_URL ?? DEFAULT_URL).replace(/\/+$/, ""),
    python: cfg.comfyPython ?? (dir ? path.join(dir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python") : null),
    /** CUDA device index; null = pick the GPU with the most memory. */
    cudaDevice: cfg.comfyCudaDevice ?? (process.env.ARES_COMFY_CUDA_DEVICE ? Number(process.env.ARES_COMFY_CUDA_DEVICE) : null),
    extraArgs: Array.isArray(cfg.comfyArgs) ? cfg.comfyArgs : [],
    models: {
      flux: cfg.fluxModel ?? "flux-2-klein-4b-fp8.safetensors",
      fluxClip: cfg.fluxClip ?? "qwen_3_4b.safetensors",
      fluxVae: cfg.fluxVae ?? "flux2-vae.safetensors",
    },
  };
}

/** The GPU with the most memory, as torch numbers it — a multi-GPU box often
 * lists the small card first (cuda:0), which is where ComfyUI would default. */
export async function biggestCudaDevice(python) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(python, ["-c", "import torch,json;print(json.dumps([(i,torch.cuda.get_device_properties(i).total_memory) for i in range(torch.cuda.device_count())]))"], { timeout: 60_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = JSON.parse(stdout.trim());
        if (!list.length) return resolve(null);
        resolve(list.sort((a, b) => b[1] - a[1])[0][0]);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function comfyAlive(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/system_stats`, { signal: controller.signal });
    if (!res.ok) return null;
    const stats = await res.json();
    return { version: stats.system?.comfyui_version ?? null, devices: (stats.devices ?? []).map((d) => ({ name: d.name, vramTotal: d.vram_total, vramFree: d.vram_free })) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Start ComfyUI from its venv (detached, file-logged) and wait for the API. */
export async function ensureComfy({ dir, url, python, cudaDevice = null, extraArgs: cfgArgs = [] }, { startupTimeoutMs = 180_000, extraArgs = [] } = {}) {
  const alive = await comfyAlive(url);
  if (alive) return { started: false, ...alive };
  if (!dir || !python) throw new Error("ComfyUI not running and no install found (set comfyDir in ~/.ares/godot.json)");
  if (!(await fs.stat(python).then((s) => s.isFile(), () => false))) throw new Error(`ComfyUI venv python not found: ${python}`);
  const u = new URL(url);
  const logDir = path.join(dir, "ares", "logs");
  await fs.mkdir(logDir, { recursive: true });
  const log = path.join(logDir, `comfyui-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`);
  const device = cudaDevice ?? (await biggestCudaDevice(python));
  const args = ["main.py", "--listen", u.hostname, "--port", u.port || "8188", "--disable-auto-launch"];
  if (device !== null && device !== undefined) args.push("--cuda-device", String(device));
  args.push(...cfgArgs, ...extraArgs);
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(log, "a");
  let child;
  try {
    child = spawn(python, args, { cwd: dir, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...process.env, PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True" } });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const until = Date.now() + startupTimeoutMs;
  while (Date.now() < until) {
    await sleep(1500);
    const ok = await comfyAlive(url, 2000);
    if (ok) return { started: true, pid: child.pid, log, cudaDevice: device, ...ok };
    if (child.exitCode !== null) break;
  }
  const tail = await fs.readFile(log, "utf8").then((t) => t.split(/\r?\n/).slice(-15).join("\n")).catch(() => "");
  throw new Error(`ComfyUI did not come up on ${url} (pid ${child.pid}, exit ${child.exitCode}). Log tail:\n${tail}`);
}

export async function uploadImage(url, file) {
  const form = new FormData();
  form.append("image", new Blob([await fs.readFile(file)]), path.basename(file));
  form.append("overwrite", "true");
  const res = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`image upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()).name;
}

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

/** UI-format workflow (nodes/links/widgets_values) → API prompt. */
export function uiToApiPrompt(ui, objectInfo, { imageName, sets = {}, baseName } = {}) {
  const links = new Map();
  for (const l of ui.links ?? []) links.set(l[0], [String(l[1]), l[2]]);
  const prompt = {};
  for (const node of ui.nodes ?? []) {
    if (node.mode === 2 || node.mode === 4) continue;
    const info = objectInfo[node.type];
    if (!info) throw new Error(`unknown node class '${node.type}' — is the custom node installed in ComfyUI?`);
    const ordered = [...Object.entries(info.input?.required ?? {}), ...Object.entries(info.input?.optional ?? {})];
    const inputs = {};
    for (const inp of node.inputs ?? []) if (inp.link != null && links.has(inp.link)) inputs[inp.name] = links.get(inp.link);
    // The UI keeps a widgets_values slot for EVERY widget-typed input, including
    // ones converted to links (the link wins at run time), so every widget
    // consumes a slot whether linked or not. Inputs added to a node after the
    // workflow was saved have no slot and fall back to their declared default.
    const values = [...(node.widgets_values ?? [])];
    for (const [name, spec] of ordered) {
      const t = Array.isArray(spec) ? spec[0] : spec;
      const isWidget = Array.isArray(t) || WIDGET_TYPES.has(t);
      if (!isWidget) continue;
      const extra = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] : {};
      const linked = name in inputs;
      let value;
      if (values.length) {
        value = values.shift();
        if (extra.control_after_generate !== undefined || name === "seed" || name === "noise_seed") {
          if (values.length && ["fixed", "increment", "decrement", "randomize"].includes(values[0])) values.shift();
        }
      } else if (extra.default !== undefined) value = extra.default;
      else if (Array.isArray(t) && t.length) value = t[0];
      else continue;
      if (!linked) inputs[name] = value;
    }
    if (imageName && /LoadImage/i.test(node.type) && "image" in inputs) inputs.image = imageName;
    if (baseName && node.type === "PrimitiveString" && typeof inputs.value === "string") inputs.value = baseName;
    prompt[String(node.id)] = { class_type: node.type, inputs };
  }
  // sets: { "<nodeId>.<input>": value } or { "<ClassType>.<input>": value } (applies to every node of that class)
  for (const [key, value] of Object.entries(sets)) {
    const dot = key.indexOf(".");
    const target = key.slice(0, dot), input = key.slice(dot + 1);
    const ids = /^\d+$/.test(target) ? [target] : Object.keys(prompt).filter((id) => prompt[id].class_type === target);
    if (ids.length === 0) throw new Error(`workflow override '${key}': no node matches '${target}'`);
    for (const id of ids) prompt[id].inputs[input] = value;
  }
  return prompt;
}

/** FLUX.2 Klein 4B (distilled) text→image as an API prompt — the structure of
 * ComfyUI's `image_flux2_klein_text_to_image` template's distilled subgraph,
 * written out flat (the template itself is a subgraph, which the API cannot
 * run directly). 4 steps, cfg 1, euler, Flux2Scheduler. Apache-2.0 model. */
export function fluxKleinPrompt({ prompt, width = 1024, height = 1024, seed = Math.floor(Math.random() * 2 ** 48), steps = 4, model, clip, vae, filenamePrefix = "ares_concept" }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "flux2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: 1 } },
    "7": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "8": { class_type: "Flux2Scheduler", inputs: { steps, width, height } },
    "9": { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
    "10": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "11": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["6", 0], sampler: ["7", 0], sigmas: ["8", 0], latent_image: ["9", 0] } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: filenamePrefix } },
  };
}

/** Queue an API prompt and wait for its outputs. */
export async function runPrompt({ url, prompt, waitMs = 1_200_000, onStatus }) {
  const clientId = `ares-${Date.now()}`;
  const queued = await (await fetch(`${url}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, client_id: clientId }) })).json();
  if (queued.error) throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.error)} ${JSON.stringify(queued.node_errors ?? {}).slice(0, 1500)}`);
  const promptId = queued.prompt_id;
  const started = Date.now();
  let last = "";
  while (Date.now() - started < waitMs) {
    await sleep(2000);
    const history = await (await fetch(`${url}/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry) {
      if (entry.status?.status_str === "error") {
        const msgs = (entry.status?.messages ?? []).filter((m) => m[0] === "execution_error").map((m) => `${m[1]?.node_type}: ${m[1]?.exception_message}`);
        throw new Error(`ComfyUI run failed: ${msgs.join("; ") || JSON.stringify(entry.status).slice(0, 1500)}`);
      }
      const files = [];
      for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
        for (const [key, arr] of Object.entries(out)) {
          if (!Array.isArray(arr)) continue;
          for (const item of arr) {
            if (item && typeof item === "object" && item.filename) files.push({ node: nodeId, key, file: path.join(item.subfolder ?? "", item.filename), type: item.type ?? "output" });
            else if (typeof item === "string" && /\.(glb|gltf|obj|ply|stl|png|jpg|webp)$/i.test(item)) files.push({ node: nodeId, key, file: item, type: "output" });
          }
        }
      }
      return { promptId, seconds: Math.round((Date.now() - started) / 1000), files, prompt };
    }
    const queue = await (await fetch(`${url}/queue`)).json().catch(() => ({}));
    const running = (queue.queue_running ?? []).some((q) => q[1] === promptId);
    const status = running ? "running" : "queued";
    if (status !== last) {
      onStatus?.(status, Math.round((Date.now() - started) / 1000));
      last = status;
    }
  }
  throw new Error(`ComfyUI run timed out after ${Math.round(waitMs / 1000)}s`);
}

export async function runWorkflow({ url, workflowFile, image, baseName, sets, waitMs = 1_200_000, onStatus }) {
  const ui = JSON.parse(await fs.readFile(workflowFile, "utf8"));
  const objectInfo = await (await fetch(`${url}/object_info`)).json();
  const imageName = image ? await uploadImage(url, image) : undefined;
  const prompt = uiToApiPrompt(ui, objectInfo, { imageName, sets, baseName });
  return runPrompt({ url, prompt, waitMs, onStatus });
}

/** Resolve a ComfyUI output entry to an absolute file under the install. */
export function outputPath(dir, file) {
  const base = path.isAbsolute(file.file) ? file.file : path.join(dir, file.type === "temp" ? "temp" : file.type === "input" ? "input" : "output", file.file);
  return base;
}
