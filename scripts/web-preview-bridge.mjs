import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.ARES_WEB_BRIDGE_PORT || 1421);
const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

let child = null;
let childStdin = null;
let provider = null;
let model = null;
let nextSeq = 1;
let events = [];

function push(event) {
  events.push({ seq: nextSeq++, event });
  if (events.length > 1200) events = events.slice(-1200);
}

function status() {
  return {
    running: Boolean(child),
    root,
    provider,
    model,
  };
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function startDaemon(args = {}) {
  if (child) return status();
  provider = clean(args.provider);
  model = clean(args.model);

  const cli = path.join(root, "packages", "cli", "dist", "entry.js");
  if (!existsSync(cli)) {
    throw new Error("Could not find packages/cli/dist/entry.js. Build Ares before launching the preview bridge.");
  }

  const commandArgs = [cli, "daemon", "--json"];
  if (provider) commandArgs.push("--provider", provider);
  if (model) commandArgs.push("--model", model);

  const daemon = spawn("node", commandArgs, {
    cwd: root,
    env: { ...process.env, ARES_AGENT_ENABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child = daemon;
  childStdin = child.stdin;

  readLines(daemon.stdout, (line) => {
    const parsed = parseJsonLine(line);
    push(parsed ?? { type: "daemon_stdout", text: line });
  });
  readLines(daemon.stderr, (line) => {
    push({ type: "daemon_stderr", text: line });
  });
  daemon.once("exit", (code, signal) => {
    push({ type: "desktop_daemon_stream_closed", code, signal });
    if (child !== daemon) return;
    child = null;
    childStdin = null;
    provider = null;
    model = null;
  });

  push({
    type: "desktop_daemon_started",
    root,
    provider,
    model,
  });
  return status();
}

function stopDaemon() {
  if (child) {
    child.kill();
    child = null;
    childStdin = null;
    provider = null;
    model = null;
  }
}

function writeDaemon(command) {
  if (!childStdin) throw new Error("Ares daemon is not running");
  childStdin.write(`${JSON.stringify(command)}\n`);
}

function readLines(stream, onLine) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
      index = buffered.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function invoke(cmd, args = {}) {
  switch (cmd) {
    case "plugin:event|listen":
      return 0;
    case "plugin:event|unlisten":
      return null;
    case "ares_set_theme":
      return args.name ?? null;
    case "ares_dev_mode":
      return true;
    case "ares_ollama_models":
      return discoverOllamaModels();
    case "ares_agent_identity":
      return loadAgentIdentity();
    case "ares_self_model":
      return loadSelfModel();
    case "ares_daemon_status":
      return status();
    case "ares_drain_events":
      return events.filter((event) => event.seq > Number(args.after ?? 0));
    case "ares_start_daemon":
      return startDaemon(args);
    case "ares_restart_daemon":
      stopDaemon();
      push({ type: "desktop_daemon_restarting" });
      return startDaemon(args);
    case "ares_send":
      writeDaemon({ type: "send", goal: String(args.goal ?? "") });
      return null;
    case "ares_set_reasoning":
      writeDaemon({ type: "reasoning", level: String(args.level ?? "") });
      return null;
    case "ares_set_routing":
      writeDaemon({ type: "routing", routing: args.routing ?? {} });
      return null;
    case "ares_set_openrouter_key":
      writeDaemon({ type: "openrouter_key", key: String(args.key ?? ""), model: clean(args.model) });
      return null;
    case "ares_permission_response":
      writeDaemon({ type: "permission_response", id: clean(args.id), decision: String(args.decision ?? "") });
      return null;
    case "ares_stop_daemon":
      stopDaemon();
      push({ type: "desktop_daemon_stopped" });
      return null;
    case "ares_window_minimize":
    case "ares_window_toggle_maximize":
    case "ares_window_close":
      return null;
    default:
      throw new Error(`Unsupported preview bridge command: ${cmd}`);
  }
}

async function discoverOllamaModels() {
  try {
    const response = await fetch(`${ollamaHost.replace(/\/$/, "")}/api/tags`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models)
      ? payload.models.map((item) => ({
          id: String(item.name ?? item.model ?? ""),
          hint: item.details?.family || "Local Ollama model",
          group: "local",
          source: "local",
          size: item.size,
          modifiedAt: item.modified_at,
          description: "Discovered from the local Ollama daemon.",
          family: item.details?.family,
          parameters: item.details?.parameter_size,
          quantization: item.details?.quantization_level,
          modalities: ["Text"],
          capabilities: [],
        })).filter((item) => item.id)
      : [];
    return { host: ollamaHost, reachable: true, models };
  } catch (error) {
    return { host: ollamaHost, reachable: false, models: [], error: String(error) };
  }
}

async function loadAgentIdentity() {
  const candidates = [
    path.join(root, "IDENTITY.md"),
    path.join(root, ".ares", "IDENTITY.md"),
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".ares", "IDENTITY.md"),
  ];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    return {
      name: field(text, "Name"),
      avatar: field(text, "Avatar") || field(text, "Picture") || field(text, "Icon"),
      mark: field(text, "Mark") || field(text, "Plain-text mark") || field(text, "Plain text mark"),
    };
  }
  return {};
}

async function loadSelfModel() {
  const candidates = [
    path.join(root, ".ares", "self", "model.json"),
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".ares", "self", "model.json"),
  ];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function field(text, key) {
  const prefix = `${key}:`;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^-+\s*/, "");
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim().replace(/^\*+|\*+$/g, "").trim() || null;
  }
  return null;
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.searchParams.get("path");
  if (!file || !/\.(png|jpe?g|webp|gif)$/i.test(file) || !path.isAbsolute(file) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = ext === ".png"
    ? "image/png"
    : ext === ".webp"
      ? "image/webp"
      : ext === ".gif"
        ? "image/gif"
        : "image/jpeg";
  res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/file")) {
    serveFile(req, res);
    return;
  }
  if (req.method !== "POST" || req.url !== "/invoke") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }
  try {
    const body = await readBody(req);
    const { cmd, args } = JSON.parse(body || "{}");
    const value = await invoke(String(cmd), args ?? {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, value }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Ares web preview bridge listening on http://127.0.0.1:${port}`);
});

process.on("SIGINT", () => {
  stopDaemon();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopDaemon();
  process.exit(0);
});
