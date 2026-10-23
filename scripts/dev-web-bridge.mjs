// Dev-only web bridge: run the REAL Ares daemon behind a plain browser tab.
//
// The desktop UI talks to the daemon through Tauri commands (ares_send,
// ares_drain_events, ...). In a plain browser there is no Tauri, so the UI is
// a demo with no agent. This process spawns the same bundled daemon the
// desktop shell spawns and answers those commands over HTTP on 127.0.0.1, so
// the UI (opened with ?bridge=http://127.0.0.1:1422) runs a live Garrison you
// can use — and so Claude can watch it error — inside a browser pane.
//
//   node scripts/dev-web-bridge.mjs            (port 1422, or BRIDGE_PORT)
//
// Loopback only, no auth: it is a developer tool, never shipped. Stop the
// desktop app first — two daemons on one ARES_HOME fight over the Garrison.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "tauri", "src-tauri", "runtime");
const cli = path.join(runtime, "cli", "ares-cli.mjs");
const node = existsSync(path.join(runtime, "bin", "node.exe")) ? path.join(runtime, "bin", "node.exe") : process.execPath;
const PORT = Number(process.env.BRIDGE_PORT || 1422);
const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
const workspace = process.env.ARES_WORKSPACE || path.join(os.homedir(), "Desktop", "Ares Workspace");

let child = null;
let seq = 0;
const events = [];
let status = { running: false, root: runtime, provider: null, model: null };

function push(event) {
  seq += 1;
  events.push({ seq, event });
  if (events.length > 4000) events.splice(0, events.length - 4000);
}

function startDaemon(provider, model) {
  if (child && child.exitCode === null) return status;
  const args = ["--max-old-space-size=4096", "--expose-gc", cli, "daemon", "--json", "--workspace", workspace];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  child = spawn(node, args, {
    cwd: workspace,
    env: { ...process.env, ARES_AGENT_ENABLED: "1", ARES_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { push(JSON.parse(line)); } catch { /* non-JSON noise */ }
    }
  });
  child.stderr.on("data", (c) => process.stderr.write(`[daemon] ${c}`));
  const me = child;
  child.on("exit", (code) => {
    if (child === me) status = { ...status, running: false };
    push({ type: "desktop_daemon_exited", code });
    process.stderr.write(`[bridge] daemon exited (${code})\n`);
  });
  status = { running: true, root: runtime, provider: provider ?? null, model: model ?? null };
  process.stderr.write(`[bridge] daemon started (pid ${child.pid}) workspace=${workspace}\n`);
  return status;
}

function stopDaemon() {
  // kill() is async: forget the child now, or a restart sees it still alive and starts nothing.
  if (child && child.exitCode === null) child.kill();
  child = null;
  status = { ...status, running: false };
}

function writeDaemon(frame) {
  if (!child || child.exitCode !== null) throw new Error("daemon is not running");
  child.stdin.write(JSON.stringify(frame) + "\n");
}

const handlers = {
  ares_start_daemon: (a) => startDaemon(a.provider, a.model),
  ares_restart_daemon: (a) => { stopDaemon(); push({ type: "desktop_daemon_restarting" }); return startDaemon(a.provider, a.model); },
  ares_stop_daemon: () => { stopDaemon(); return status; },
  ares_daemon_status: () => status,
  ares_drain_events: (a) => events.filter((e) => e.seq > (a.after ?? 0)),
  ares_send: (a) => writeDaemon({ type: "send", goal: String(a.goal ?? "").trim(), sessionId: a.sessionId ?? null, voice: !!a.voice, inputId: a.inputId ?? null }),
  ares_daemon_command: (a) => writeDaemon(a.command),
  ares_interrupt: (a) => writeDaemon({ type: "interrupt", sessionId: a.sessionId ?? null }),
  ares_permission_response: (a) => writeDaemon({ type: "permission_response", id: a.id ?? null, decision: a.decision }),
  ares_set_reasoning: (a) => writeDaemon({ type: "reasoning", level: a.level }),
  ares_set_routing: (a) => writeDaemon({ type: "routing", routing: a.routing }),
  ares_set_provider_key: (a) => writeDaemon({ type: "provider_key", provider: a.provider, key: a.key, model: a.model ?? null }),
  ares_dev_mode: () => true,
  ares_read_text_file: async (a) => (await import("node:fs/promises")).readFile(a.path, "utf8"),
};

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };

createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/file") {
    // serves a local file for the Forge iframe (the browser stand-in for the asset protocol)
    const p = url.searchParams.get("path") ?? "";
    if (!p || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404, cors).end(); return; }
    res.writeHead(200, { ...cors, "cache-control": "no-store" });
    createReadStream(p).pipe(res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/invoke") {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { cmd, args } = JSON.parse(body || "{}");
      const fn = handlers[cmd];
      const out = fn ? await fn(args ?? {}) : null; // unknown native commands are harmless no-ops
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ ok: true, value: out ?? null }));
    } catch (err) {
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    }
    return;
  }
  res.writeHead(200, { ...cors, "content-type": "text/plain" }).end("ares dev web bridge\n");
}).listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[bridge] http://127.0.0.1:${PORT}  (open the UI with ?bridge=http://127.0.0.1:${PORT})\n`);
});

process.on("exit", stopDaemon);
process.on("SIGINT", () => process.exit(0));
