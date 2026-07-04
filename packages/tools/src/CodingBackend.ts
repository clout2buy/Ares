// CodingBackend — Ares wielding an external coding agent (Claude Code / Codex)
// as a delegated backend, WITHOUT the user ever logging into it.
//
// The whole trick, and the owner's explicit requirement ("connect Ares with
// Ares, no OAuth"): instead of the CLI using the user's own Anthropic/OpenAI
// login, Ares spawns it with its OWN gateway credentials injected as env vars.
// Claude Code honours ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY; Codex honours
// OPENAI_BASE_URL + OPENAI_API_KEY. Point those at the Ares gateway (which
// speaks the Anthropic wire and resolves the virtual "ares-internal" model
// server-side) and the external coder runs entirely on the ARES account —
// the user needs no key and no OAuth. Ares's single account login IS the auth.
//
// Flow: detect the CLI on PATH → if missing, offer a consented global install
// → drive it headless in the workspace with gateway env injected → stream its
// output into the Ares UI (with a "which backend" badge) → return a summary.
// Edits land on disk, so the engine's pre-tool checkpoint (this tool is
// workspace-write) already covers every change the backend makes.
//
// Auth substitute, not bypass: this still REQUIRES the Ares gateway token
// (the account). That's the point — one Ares login replaces per-CLI OAuth.

import { spawn } from "node:child_process";
import { z } from "zod";
import { buildTool, toolError, type RichToolContext } from "./_shared.js";

export type BackendName = "claude" | "codex";

export interface BackendSpec {
  name: BackendName;
  /** Human label shown in the UI badge, e.g. "Claude Code". */
  label: string;
  /** Executable resolved on PATH. */
  bin: string;
  /** npm package for the consented install. */
  installPkg: string;
  /** Args that print a version (detection). */
  versionArgs: string[];
  /** Headless run args. The PROMPT is fed via stdin (never argv) so it can
   *  carry quotes/newlines/code with zero escaping risk on any platform. */
  runArgs: string[];
  /** Whether this backend can run on the Ares gateway TODAY. Claude Code speaks
   *  the Anthropic wire the gateway already serves; Codex needs an OpenAI-
   *  compatible gateway route that may not exist yet. */
  gatewayReady: boolean;
  /** Env that binds the CLI to the Ares gateway account (no user OAuth). */
  gatewayEnv(base: string, token: string, model: string): Record<string, string>;
}

// ANTHROPIC_BASE_URL note: Claude Code POSTs to `${ANTHROPIC_BASE_URL}/v1/messages`.
// The Ares gateway serves messages at `${base}/api/gateway/v1/messages`, so the
// base we hand Claude Code is `${base}/api/gateway`. The account token goes as
// ANTHROPIC_API_KEY (x-api-key header) — the gateway takes the account bearer
// token as x-api-key. Model "ares-internal" is the gateway's house-model
// sentinel; we pin BOTH the main and the small/fast model to it so Claude Code
// never emits a real model id the gateway hasn't been taught to map.
export const BACKENDS: Record<BackendName, BackendSpec> = {
  claude: {
    name: "claude",
    label: "Claude Code",
    bin: "claude",
    installPkg: "@anthropic-ai/claude-code",
    versionArgs: ["--version"],
    runArgs: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
    gatewayReady: true,
    gatewayEnv: (base, token, model) => ({
      ANTHROPIC_BASE_URL: `${base}/api/gateway`,
      ANTHROPIC_API_KEY: token,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      // Keep a headless run quiet: no auto-update mid-run, no nonessential calls.
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
  },
  codex: {
    name: "codex",
    label: "Codex",
    bin: "codex",
    installPkg: "@openai/codex",
    versionArgs: ["--version"],
    // codex exec = non-interactive automation mode; prompt via stdin.
    runArgs: ["exec", "--skip-git-repo-check", "-"],
    // Codex speaks the OpenAI wire; the Ares gateway currently exposes the
    // Anthropic wire only. Until an OpenAI-compatible route exists at
    // ${base}/api/gateway/v1/chat|responses, Codex-on-Ares can't authenticate.
    // We keep the wiring so it lights up the moment that route ships.
    gatewayReady: false,
    gatewayEnv: (base, token, model) => ({
      OPENAI_BASE_URL: `${base}/api/gateway/v1`,
      OPENAI_API_KEY: token,
      OPENAI_MODEL: model,
    }),
  },
};

export interface CodingBackendDeps {
  /** Canonical gateway origin, e.g. https://www.doingteam.com (no trailing slash). */
  gatewayBase: string;
  /** The Ares account token. Absent → the tool can't run (guides user to connect). */
  gatewayToken?: string;
  /** Virtual model id the gateway resolves server-side. */
  defaultModel?: string;
  /** Overall wall-clock cap for one delegated run (ms). */
  runTimeoutMs?: number;
  /** Injectable spawner for tests — defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

const MAX_CAPTURE = 200_000;

/** Spawn a child with injected env, feed `input` on stdin, stream lines out. */
function runProc(
  spawnImpl: typeof spawn,
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    input?: string;
    timeoutMs: number;
    signal: AbortSignal;
    onLine?: (stream: "stdout" | "stderr", line: string) => void;
  },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(cmd, args, {
        cwd: opts.cwd,
        // Merge over the real environment so PATH/HOME survive; our keys win.
        env: { ...process.env, ...opts.env },
        signal: opts.signal,
        windowsHide: true,
        // Global npm bins are .cmd shims on Windows — shell:true lets the OS
        // resolve them. Only fixed, space-free flags reach argv; the prompt
        // rides stdin, so there is no injection surface here.
        shell: true,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: err as Error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
          try { child.kill(); } catch { /* ignore */ }
        });
      } else {
        child.kill();
      }
    }, opts.timeoutMs);

    const pump = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout = (stdout + text).slice(-MAX_CAPTURE);
      else stderr = (stderr + text).slice(-MAX_CAPTURE);
      if (opts.onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine(stream, line);
    };
    child.stdout?.on("data", (c: Buffer) => pump("stdout", c));
    child.stderr?.on("data", (c: Buffer) => pump("stderr", c));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Is the backend's CLI present on PATH? Returns its version string if so. */
export async function detectBackend(
  spec: BackendSpec,
  cwd: string,
  signal: AbortSignal,
  spawnImpl: typeof spawn = spawn,
): Promise<{ installed: boolean; version?: string }> {
  const res = await runProc(spawnImpl, spec.bin, spec.versionArgs, {
    cwd,
    env: {},
    timeoutMs: 15_000,
    signal,
  });
  if (res.spawnError || res.code !== 0) return { installed: false };
  return { installed: true, version: res.stdout.trim().split(/\r?\n/)[0] || undefined };
}

// Pull a clean final answer + the files the backend touched out of Claude
// Code's stream-json. Best-effort: unknown/other backends fall back to stdout.
function parseClaudeStream(stdout: string): { result?: string; isError: boolean; files: string[] } {
  const files = new Set<string>();
  let result: string | undefined;
  let isError = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (obj.type === "result") {
      if (typeof obj.result === "string") result = obj.result;
      isError = obj.is_error === true || obj.subtype === "error" || obj.subtype === "error_max_turns";
    }
    // Collect edited files from tool_use blocks in assistant messages.
    const msg = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "");
      if (!/^(Edit|Write|MultiEdit|NotebookEdit|Update)$/.test(name)) continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      for (const key of ["file_path", "path", "notebook_path"]) {
        const v = input[key];
        if (typeof v === "string" && v.trim()) files.add(v.trim());
      }
    }
  }
  return { result, isError, files: [...files] };
}

const inputSchema = z
  .object({
    task: z
      .string()
      .min(1)
      .describe("Self-contained coding task for the external agent. It has NONE of your conversation context — spell out the files, the change, and how to verify."),
    backend: z
      .enum(["auto", "claude", "codex"])
      .default("auto")
      .describe("Which coding CLI to drive. 'auto' prefers an installed, gateway-ready backend (Claude Code)."),
    allow_install: z
      .boolean()
      .default(false)
      .describe("If the chosen backend isn't installed, permit a consented global npm install before running."),
  })
  .strict();

export interface CodingBackendOutput {
  backend: BackendName;
  label: string;
  status: "completed" | "failed";
  summary: string;
  filesTouched: string[];
  installed: boolean;
}

function chooseBackend(requested: "auto" | BackendName): BackendSpec {
  if (requested !== "auto") return BACKENDS[requested];
  // auto: the gateway-ready one wins (Claude Code today).
  return BACKENDS.claude;
}

export function makeCodingBackendTool(deps: CodingBackendDeps) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const model = deps.defaultModel ?? "ares-internal";
  const runTimeoutMs = deps.runTimeoutMs ?? 10 * 60_000;

  return buildTool({
    name: "CodingBackend",
    description: buildDescription(),
    // Edits land on disk — the engine checkpoints before this runs, so every
    // change the delegated agent makes is covered by one reversible snapshot.
    safety: "workspace-write",
    // A heavy external process editing files: never overlap with other writers.
    concurrency: "exclusive",
    // Delegated runs take minutes; we enforce our own wall-clock cap in call().
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    activityDescription: (i) => `CodingBackend[${i.backend}] ${i.task.slice(0, 60)}`,
    async call(i, ctx: RichToolContext): Promise<{ output: CodingBackendOutput; display: string; touchedFiles?: string[] }> {
      const spec = chooseBackend(i.backend);

      // Auth substitute for OAuth: the Ares account token. No token → nothing to
      // inject, so the backend would fall back to the user's own login (the very
      // thing we're avoiding). Guide them to connect the account instead.
      if (!deps.gatewayToken) {
        throw toolError(
          `${spec.label} runs on your Ares account so no separate login is needed — but no Ares account is connected. ` +
            `Connect it at doingteam.com → Account (or set ARES_GATEWAY_TOKEN), then retry.`,
        );
      }

      if (!spec.gatewayReady) {
        throw toolError(
          `${spec.label} can't run on the Ares account yet: it speaks the OpenAI wire and the Ares gateway ` +
            `only exposes the Anthropic API today. Use backend "claude" for now.`,
        );
      }

      ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: spec.label, phase: "detect" });
      let detection = await detectBackend(spec, ctx.workspace, ctx.signal, spawnImpl);

      // Not installed → consented global install.
      if (!detection.installed) {
        if (!i.allow_install) {
          throw toolError(
            `${spec.label} isn't installed. Re-run with allow_install: true to install it globally ` +
              `(npm i -g ${spec.installPkg}) — you'll be asked to approve it.`,
          );
        }
        const decision = ctx.requestPermission
          ? await ctx.requestPermission({
              toolName: "CodingBackend",
              input: { install: spec.installPkg },
              reason: `Install ${spec.label} globally with: npm i -g ${spec.installPkg}`,
              suggestion: "allow_once",
            })
          : "deny";
        if (decision === "deny") {
          throw toolError(`${spec.label} isn't installed and the install was declined.`);
        }
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: spec.label, phase: "install" });
        const install = await runProc(spawnImpl, "npm", ["install", "-g", spec.installPkg], {
          cwd: ctx.workspace,
          env: {},
          timeoutMs: 5 * 60_000,
          signal: ctx.signal,
          onLine: (stream, line) =>
            ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, phase: "install", stream, line }),
        });
        if (install.spawnError || install.code !== 0) {
          throw toolError(
            `Installing ${spec.label} failed (npm exit ${install.code ?? "spawn-error"}). ` +
              `${(install.stderr || install.spawnError?.message || "").slice(-400)}`,
          );
        }
        detection = await detectBackend(spec, ctx.workspace, ctx.signal, spawnImpl);
        if (!detection.installed) {
          throw toolError(`${spec.label} still isn't on PATH after install — a new shell may be needed.`);
        }
      }

      // Drive it headless, on the Ares account, in the workspace.
      ctx.emitProgress?.({
        kind: "coding_backend",
        backend: spec.name,
        label: spec.label,
        phase: "running",
        version: detection.version,
      });
      const run = await runProc(spawnImpl, spec.bin, spec.runArgs, {
        cwd: ctx.workspace,
        env: spec.gatewayEnv(deps.gatewayBase, deps.gatewayToken, model),
        input: i.task,
        timeoutMs: runTimeoutMs,
        signal: ctx.signal,
        onLine: (stream, line) =>
          ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, phase: "running", stream, line }),
      });

      if (run.spawnError) {
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: spec.label, phase: "failed" });
        throw toolError(`Couldn't launch ${spec.label}: ${run.spawnError.message}`);
      }

      const parsed = spec.name === "claude" ? parseClaudeStream(run.stdout) : { result: undefined, isError: false, files: [] as string[] };
      const failed = run.timedOut || run.code !== 0 || parsed.isError;
      const finalText =
        parsed.result?.trim() ||
        run.stdout.trim().split(/\r?\n/).slice(-40).join("\n") ||
        run.stderr.trim().slice(-2000);

      if (failed) {
        // Let the cut-scene shatter, then surface the correctable error.
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: spec.label, phase: "failed" });
        throw toolError(
          `${spec.label} ${run.timedOut ? "timed out" : `exited ${run.code}`}. ` +
            `Last output:\n${(finalText || run.stderr).slice(-1500)}`,
        );
      }

      // Victory: the cut-scene celebrates with the final file tally.
      ctx.emitProgress?.({
        kind: "coding_backend",
        backend: spec.name,
        label: spec.label,
        phase: "done",
        filesTouched: parsed.files.length,
      });
      return {
        output: {
          backend: spec.name,
          label: spec.label,
          status: "completed",
          summary: finalText || "(no textual output)",
          filesTouched: parsed.files,
          installed: true,
        },
        touchedFiles: parsed.files,
        display: `⚡ ${spec.label} → done${parsed.files.length ? ` (${parsed.files.length} file(s))` : ""}`,
      };
    },
  });
}

function buildDescription(): string {
  return `Delegate a coding task to an external coding agent (Claude Code or Codex) and stream its work back.

Use this when a task wants a heavyweight, battle-tested coding agent — or when the user explicitly asks to run something through Claude Code / Codex, or distrusts the in-house result and wants a second pass.

KEY PROPERTY: the external agent runs on the ARES ACCOUNT via injected gateway credentials — the user needs NO separate login or API key. One Ares account replaces per-CLI OAuth.

- backend "auto" picks an installed, gateway-ready backend (Claude Code today).
- If the CLI isn't installed, pass allow_install: true to offer a consented global npm install.
- The task prompt must be SELF-CONTAINED — the backend has none of your conversation context.
- Edits land in the workspace and are covered by the engine's pre-tool checkpoint.

Prefer your own tools for small edits. Reach for this for large, autonomous coding jobs or on explicit user request.`;
}
