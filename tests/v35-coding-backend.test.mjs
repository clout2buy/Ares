// CodingBackend — Ares driving an external coding CLI (Claude Code / Codex) on
// the ARES ACCOUNT via injected gateway credentials, so the user needs no login.
// These lock the contract that makes "no OAuth" real:
//   - the child is spawned with ANTHROPIC_BASE_URL/API_KEY pointing at the Ares
//     gateway (NOT the user's own auth);
//   - the task prompt is fed on stdin (no argv escaping);
//   - a missing CLI installs ONLY on consent;
//   - no Ares account token → a clear, correctable error (not a silent fallback
//     to the user's own login);
//   - Codex is gated until the gateway speaks the OpenAI wire.
//
// A fake spawn stands in for child_process, so nothing real is installed/run.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { makeCodingBackendTool, detectBackend, BACKENDS } from "../packages/tools/dist/index.js";

const BASE = "https://www.doingteam.com";
const TOKEN = "ares_acct_tok_123";

// Claude Code stream-json sample: an Edit tool_use + a success result.
const CLAUDE_STREAM = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:/ws/mod.lua" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fixed the HUD icon." }),
].join("\n") + "\n";

function makeFakeSpawn(router) {
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const input = [];
    child.stdin = { write: (c) => input.push(String(c)), end: () => {} };
    child.pid = 4242;
    child.kill = () => {};
    const rec = { cmd, args, env: opts?.env ?? {}, input };
    fn.calls.push(rec);
    const res = router(cmd, args) ?? { code: 0 };
    queueMicrotask(() => {
      if (res.error) return void child.emit("error", new Error(res.error));
      if (res.stdout) child.stdout.emit("data", Buffer.from(res.stdout));
      if (res.stderr) child.stderr.emit("data", Buffer.from(res.stderr));
      child.emit("close", res.code ?? 0);
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

function ctx(requestPermission) {
  return {
    workspace: "C:/ws",
    signal: new AbortController().signal,
    permissionMode: "bypass",
    fileReadStamps: new Map(),
    emitProgress: () => {},
    requestPermission,
  };
}

const input = (over = {}) => ({ task: "fix the mod", backend: "auto", allow_install: false, ...over });

// ── detectBackend ────────────────────────────────────────────────────────────

test("detectBackend: installed CLI reports its version", async () => {
  const spawn = makeFakeSpawn((cmd) => (cmd === "claude" ? { code: 0, stdout: "1.0.42 (Claude Code)\n" } : { code: 0 }));
  const d = await detectBackend(BACKENDS.claude, "C:/ws", new AbortController().signal, spawn);
  assert.equal(d.installed, true);
  assert.match(d.version, /1\.0\.42/);
});

test("detectBackend: a missing CLI (spawn error) reports not installed", async () => {
  const spawn = makeFakeSpawn(() => ({ error: "spawn claude ENOENT" }));
  const d = await detectBackend(BACKENDS.claude, "C:/ws", new AbortController().signal, spawn);
  assert.equal(d.installed, false);
});

// ── The headline: runs on the ARES gateway, prompt via stdin ────────────────

test("CodingBackend: drives Claude Code with Ares gateway creds injected, prompt on stdin", async () => {
  const spawn = makeFakeSpawn((cmd, args) => {
    if (cmd === "claude" && args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
    if (cmd === "claude" && args.includes("-p")) return { code: 0, stdout: CLAUDE_STREAM };
    return { code: 0 };
  });
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, defaultModel: "ares-internal", spawnImpl: spawn });
  const res = await tool.call(input({ backend: "claude", task: "fix the mod" }), ctx());

  assert.equal(res.output.status, "completed");
  assert.equal(res.output.summary, "Fixed the HUD icon.");
  assert.deepEqual(res.output.filesTouched, ["C:/ws/mod.lua"]);
  assert.match(res.display, /⚡ Claude Code/);

  const runCall = spawn.calls.find((c) => c.cmd === "claude" && c.args.includes("-p"));
  assert.ok(runCall, "the backend was actually driven");
  // The auth substitute: Ares gateway, NOT the user's own login.
  assert.equal(runCall.env.ANTHROPIC_BASE_URL, `${BASE}/api/gateway`, "base points at the Ares gateway (CC appends /v1/messages)");
  assert.equal(runCall.env.ANTHROPIC_API_KEY, TOKEN, "the Ares account token is the key (x-api-key)");
  assert.equal(runCall.env.ANTHROPIC_MODEL, "ares-internal", "model is the gateway house sentinel");
  // The task rode stdin — never argv.
  assert.equal(runCall.input.join(""), "fix the mod");
  assert.ok(!runCall.args.includes("fix the mod"), "prompt is NOT in argv (no escaping surface)");
});

// ── No account token → guide to connect, never fall back to user's own auth ──

test("CodingBackend: with no Ares account token it errors instead of using user auth", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0, stdout: "1.0.0\n" }));
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: undefined, spawnImpl: spawn });
  await assert.rejects(
    () => tool.call(input({ backend: "claude" }), ctx()),
    /no Ares account is connected|connect it at doingteam/i,
  );
  assert.equal(spawn.calls.length, 0, "nothing was spawned without an account — no silent user-auth fallback");
});

// ── Codex is gated until the gateway speaks the OpenAI wire ──────────────────

test("CodingBackend: Codex is refused until the gateway exposes an OpenAI route", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, spawnImpl: spawn });
  await assert.rejects(
    () => tool.call(input({ backend: "codex" }), ctx()),
    /OpenAI wire|use backend "claude"/i,
  );
});

// ── Install is consented, not silent ─────────────────────────────────────────

test("CodingBackend: a missing CLI without allow_install refuses with guidance", async () => {
  const spawn = makeFakeSpawn((cmd, args) =>
    cmd === "claude" && args.includes("--version") ? { error: "ENOENT" } : { code: 0 },
  );
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, spawnImpl: spawn });
  await assert.rejects(
    () => tool.call(input({ backend: "claude", allow_install: false }), ctx()),
    /allow_install: true/,
  );
});

test("CodingBackend: install runs only after a permission grant, then drives the backend", async () => {
  let installed = false;
  const spawn = makeFakeSpawn((cmd, args) => {
    if (cmd === "npm" && args.includes("install")) { installed = true; return { code: 0, stdout: "added 1 package\n" }; }
    if (cmd === "claude" && args.includes("--version")) return installed ? { code: 0, stdout: "1.0.0\n" } : { error: "ENOENT" };
    if (cmd === "claude" && args.includes("-p")) return { code: 0, stdout: CLAUDE_STREAM };
    return { code: 0 };
  });
  const prompts = [];
  const grant = async (req) => { prompts.push(req); return "allow_once"; };
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, spawnImpl: spawn });

  const res = await tool.call(input({ backend: "claude", allow_install: true }), ctx(grant));

  assert.equal(prompts.length, 1, "install asked for consent");
  assert.match(prompts[0].reason, /npm i -g @anthropic-ai\/claude-code/);
  const npmCall = spawn.calls.find((c) => c.cmd === "npm");
  assert.deepEqual(npmCall.args, ["install", "-g", "@anthropic-ai/claude-code"]);
  assert.equal(res.output.status, "completed");
});

test("CodingBackend: a denied install fails with a correctable error, installs nothing", async () => {
  const spawn = makeFakeSpawn((cmd, args) =>
    cmd === "claude" && args.includes("--version") ? { error: "ENOENT" } : { code: 0 },
  );
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, spawnImpl: spawn });
  await assert.rejects(
    () => tool.call(input({ backend: "claude", allow_install: true }), ctx(async () => "deny")),
    /install was declined/,
  );
  assert.equal(spawn.calls.some((c) => c.cmd === "npm"), false, "nothing was installed after a deny");
});

// ── A backend error surfaces as a correctable tool error ─────────────────────

test("CodingBackend: a backend that reports is_error surfaces as a tool error", async () => {
  const errStream = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "could not apply edit" }) + "\n";
  const spawn = makeFakeSpawn((cmd, args) => {
    if (cmd === "claude" && args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
    if (cmd === "claude" && args.includes("-p")) return { code: 0, stdout: errStream };
    return { code: 0 };
  });
  const tool = makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, spawnImpl: spawn });
  await assert.rejects(() => tool.call(input({ backend: "claude" }), ctx()), /could not apply edit|Claude Code/);
});
