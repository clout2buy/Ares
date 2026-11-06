// Running a forged tool: a module Ares wrote, evaluated in a worker thread
// inside a vm context that holds nothing but the `ares` capability object
// the owner approved. The module cannot `require`, cannot see `process`,
// and reaches the file system, the network and the belt only through
// `ares.readFile / writeFile / fetch / call`, each of which checks the
// manifest before doing anything. A static scan (`scanToolSource`) names what
// the source appears to need so the owner approves the real list, not the
// claimed one.
//
// This is a capability floor, not a proof against a hostile module (dsh says
// the same about its vm realm); what it buys is that an honest tool can only
// do what its card said, and a dishonest one is refused at mount for asking
// for more than it declared.

import { Worker } from "node:worker_threads";
import path from "node:path";
import type { ToolCapabilities } from "./extensionStore.js";

export interface ScanFinding {
  capability: "fs" | "net" | "tools" | "process" | "require";
  evidence: string;
}

/** What the source seems to reach for. */
export function scanToolSource(source: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (capability: ScanFinding["capability"], evidence: string) => {
    if (!findings.some((f) => f.capability === capability && f.evidence === evidence)) findings.push({ capability, evidence });
  };
  for (const m of source.matchAll(/\bares\.(readFile|writeFile|readDir)\s*\(/g)) add("fs", m[1]);
  for (const m of source.matchAll(/\bares\.fetch\s*\(/g)) add("net", m[0].trim());
  for (const m of source.matchAll(/\bares\.call\s*\(\s*["']([A-Za-z0-9_]+)["']/g)) add("tools", m[1]);
  for (const m of source.matchAll(/\b(require|import)\s*\(/g)) add("require", m[1]);
  if (/\bprocess\b/.test(source)) add("process", "process");
  if (/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source) && !/\bares\.fetch\b/.test(source)) add("net", "bare fetch");
  return findings;
}

/** The problems that stop a mount: the source wants more than the manifest grants. */
export function manifestProblems(source: string, caps: ToolCapabilities): string[] {
  const problems: string[] = [];
  const findings = scanToolSource(source);
  if (findings.some((f) => f.capability === "require")) problems.push("the module uses require()/import(): forged tools get only the ares object, no modules");
  if (findings.some((f) => f.capability === "process")) problems.push("the module references `process`: forged tools have no process");
  if (findings.some((f) => f.capability === "net" && f.evidence === "bare fetch")) problems.push("the module calls fetch directly: use ares.fetch, which checks the manifest's hosts");
  if (findings.some((f) => f.capability === "fs") && !caps.readRoots.length && !caps.writeRoots.length) problems.push("the module reads or writes files but the manifest grants no readRoots/writeRoots");
  if (findings.some((f) => f.capability === "net" && f.evidence !== "bare fetch") && !caps.hosts.length) problems.push("the module uses ares.fetch but the manifest grants no hosts");
  for (const f of findings.filter((f) => f.capability === "tools")) {
    if (!caps.tools.includes(f.evidence)) problems.push(`the module calls ares.call("${f.evidence}") but the manifest's tools do not include it`);
  }
  return problems;
}

export interface RunForgedToolOptions {
  source: string;
  input: unknown;
  workspace: string;
  capabilities: ToolCapabilities;
  /** Gated belt call for ares.call; absent = refused. */
  callTool?: (tool: string, input: unknown) => Promise<unknown>;
  timeoutMs?: number;
}

export interface RunForgedToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const fs = require("node:fs/promises");
const path = require("node:path");
const { source, input, workspace, capabilities } = workerData;
const logs = [];
let seq = 0;
const pending = new Map();
parentPort.on("message", (m) => {
  if (m && m.type === "call_result" && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.ok ? p.resolve(m.output) : p.reject(new Error(m.error || "call failed"));
  }
});
const inside = (roots, target) => {
  const abs = path.resolve(workspace, target);
  return roots.some((root) => {
    const r = path.resolve(workspace, root);
    const rel = path.relative(r, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }) ? abs : null;
};
const ares = Object.freeze({
  workspace,
  log: (...a) => { logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ").slice(0, 2000)); },
  async readFile(p) { const abs = inside(capabilities.readRoots, String(p)); if (!abs) throw new Error("readFile: " + p + " is outside the manifest's readRoots"); return fs.readFile(abs, "utf8"); },
  async readDir(p) { const abs = inside(capabilities.readRoots, String(p)); if (!abs) throw new Error("readDir: " + p + " is outside the manifest's readRoots"); return fs.readdir(abs); },
  async writeFile(p, text) { const abs = inside(capabilities.writeRoots, String(p)); if (!abs) throw new Error("writeFile: " + p + " is outside the manifest's writeRoots"); await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, String(text), "utf8"); return true; },
  async fetch(url, init) {
    let host; try { host = new URL(String(url)).hostname; } catch { throw new Error("fetch: bad url"); }
    if (!capabilities.hosts.some((h) => host === h || host.endsWith("." + h))) throw new Error("fetch: " + host + " is not in the manifest's hosts");
    const res = await globalThis.fetch(String(url), init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text, json() { try { return JSON.parse(text); } catch { return null; } } };
  },
  call(tool, callInput) {
    if (!capabilities.tools.includes(String(tool))) return Promise.reject(new Error("call: " + tool + " is not in the manifest's tools"));
    const id = ++seq;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parentPort.postMessage({ type: "call", id, tool: String(tool), input: callInput }); });
  },
});
const sandbox = { ares, console: { log: ares.log, error: ares.log, warn: ares.log }, JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Map, Set, Error, TypeError, RangeError, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout, structuredClone, module: { exports: {} }, exports: {} };
sandbox.exports = sandbox.module.exports;
(async () => {
  try {
    vm.runInNewContext(source, sandbox, { timeout: 5000, filename: "forged-tool.js" });
    const mod = sandbox.module.exports && typeof sandbox.module.exports === "object" && Object.keys(sandbox.module.exports).length ? sandbox.module.exports : sandbox.exports;
    const fn = typeof mod === "function" ? mod : typeof mod.call === "function" ? mod.call : typeof mod.default === "function" ? mod.default : null;
    if (!fn) throw new Error("the module must export a call(input, ares) function (module.exports = { call })");
    const output = await fn(input, ares);
    parentPort.postMessage({ type: "done", ok: true, output, logs });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: err && err.message ? err.message : String(err), logs });
  }
})();
`;

export function runForgedTool(options: RunForgedToolOptions): Promise<RunForgedToolResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: options.source, input: options.input, workspace: path.resolve(options.workspace), capabilities: options.capabilities },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    const finish = (result: Omit<RunForgedToolResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...result, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `the tool ran past ${timeoutMs}ms`, logs: [] }), timeoutMs);
    worker.on("message", (m: { type?: string; id?: number; tool?: string; input?: unknown; ok?: boolean; output?: unknown; error?: string; logs?: string[] }) => {
      if (m?.type === "call" && typeof m.id === "number" && typeof m.tool === "string") {
        const reply = (ok: boolean, output?: unknown, error?: string) => worker.postMessage({ type: "call_result", id: m.id, ok, output, error });
        if (!options.callTool) { reply(false, undefined, "this host cannot call belt tools"); return; }
        options.callTool(m.tool, m.input).then((out) => reply(true, out)).catch((err) => reply(false, undefined, err instanceof Error ? err.message : String(err)));
        return;
      }
      if (m?.type === "done") finish({ ok: m.ok === true, output: m.output, error: m.error, logs: Array.isArray(m.logs) ? m.logs : [] });
    });
    worker.on("error", (err) => finish({ ok: false, error: err.message, logs: [] }));
    worker.on("exit", (code) => { if (!settled) finish({ ok: false, error: `worker exited with code ${code}`, logs: [] }); });
  });
}
