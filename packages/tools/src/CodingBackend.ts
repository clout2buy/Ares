// CodingBackend - optional bridge to an external coding harness
// (Claude Code / Codex) WITHOUT ever falling back to the user's Claude/Codex
// OAuth.
//
// Ares already has its own coding harness: tools, checkpoints, permissions,
// verifier, CodeMode, ApplyIntent, subagents, and memory. This adapter is only
// for cases where the owner explicitly wants to wrap a local CLI harness around
// the same Ares account/model. If a harness cannot be bound to Ares-owned auth,
// we refuse instead of silently consuming the user's separate Claude/OpenAI
// login.
//
// Flow: detect a real CLI on PATH -> if missing, offer a consented global
// install -> drive it headless in the workspace with Ares-owned env injected ->
// stream output into the Ares UI -> return a summary. Edits land on disk, so
// the engine's pre-tool checkpoint covers every backend change.
//
// Auth substitute, not bypass: this still REQUIRES the Ares account token.
// One Ares login replaces per-CLI OAuth.

import { spawn } from "node:child_process";
import path from "node:path";
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
  /** Optional extra detection probe used to reject wrapper collisions. */
  probeArgs?: string[];
  /** If the probe output matches this, the command is not the intended backend. */
  rejectProbePattern?: RegExp;
  /** Model-facing explanation when the probe rejects the command. */
  rejectProbeReason?: string;
  /** Headless run args. The PROMPT is fed via stdin (never argv) so it can
   *  carry quotes/newlines/code with zero escaping risk on any platform. */
  runArgs(base: string, model: string): string[];
  /** Whether this backend has a verified Ares-owned auth binding today. Running
   *  an unbound CLI would fall back to the user's own CLI OAuth, which is
   *  forbidden by this tool's contract. */
  gatewayReady: boolean;
  /** Env that binds the CLI to the Ares account/provider (no user OAuth). */
  gatewayEnv(base: string, token: string, model: string): Record<string, string>;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
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
    // On the owner's Windows box a Bun binary is named claude.exe and reports a
    // plausible version, but --help reveals Bun's CLI. Treat that as missing so
    // we do not try to run Bun as Claude Code.
    probeArgs: ["--help"],
    rejectProbePattern: /\bUsage:\s*bun\b|Bun is a fast JavaScript runtime/i,
    rejectProbeReason: "the claude command on PATH is Bun, not Claude Code",
    runArgs: () => ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
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
    runArgs: (base, model) => [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--json",
      "-m",
      model,
      "-c",
      'model_provider="ares_gateway"',
      "-c",
      `model=${tomlString(model)}`,
      "-c",
      'model_providers.ares_gateway.name="Ares Gateway"',
      "-c",
      `model_providers.ares_gateway.base_url=${tomlString(`${base}/api/gateway/v1`)}`,
      "-c",
      'model_providers.ares_gateway.env_key="ARES_GATEWAY_TOKEN"',
      "-c",
      'model_providers.ares_gateway.wire_api="responses"',
      "-c",
      "model_providers.ares_gateway.requires_openai_auth=false",
      "-",
    ],
    gatewayReady: true,
    gatewayEnv: (base, token, model) => ({
      ARES_GATEWAY_BASE_URL: base,
      ARES_GATEWAY_TOKEN: token,
      ARES_GATEWAY_MODEL: model,
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

const ARES_AGENT_NAME = "Ares";

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
): Promise<{ installed: boolean; version?: string; reason?: string }> {
  const res = await runProc(spawnImpl, spec.bin, spec.versionArgs, {
    cwd,
    env: {},
    timeoutMs: 15_000,
    signal,
  });
  if (res.spawnError || res.code !== 0) return { installed: false };
  const version = res.stdout.trim().split(/\r?\n/)[0] || undefined;
  if (spec.probeArgs && spec.rejectProbePattern) {
    const probe = await runProc(spawnImpl, spec.bin, spec.probeArgs, {
      cwd,
      env: {},
      timeoutMs: 15_000,
      signal,
    });
    const probeText = `${probe.stdout}\n${probe.stderr}`;
    if (!probe.spawnError && spec.rejectProbePattern.test(probeText)) {
      return { installed: false, version, reason: spec.rejectProbeReason ?? `${spec.bin} is not ${spec.label}` };
    }
  }
  return { installed: true, version };
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

function parseCodexStream(stdout: string): { result?: string; isError: boolean; files: string[] } {
  const files = new Set<string>();
  let result: string | undefined;
  let isError = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    const type = String(obj.type ?? obj.event ?? "");
    if (/error|failed|failure/i.test(type)) isError = true;
    collectTouchedPaths(obj, files);
    const text = bestText(obj);
    if (text && (/message|completed|final|result/i.test(type) || !result)) result = text;
  }
  return { result, isError, files: [...files] };
}

function bestText(obj: Record<string, unknown>): string | undefined {
  for (const key of ["message", "text", "summary", "result", "output"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const item = obj.item;
  if (item && typeof item === "object") {
    const nested = bestText(item as Record<string, unknown>);
    if (nested) return nested;
  }
  return undefined;
}

function collectTouchedPaths(value: unknown, files: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTouchedPaths(item, files);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(file_path|path|notebook_path)$/.test(key) && typeof entry === "string" && looksLikeEditedPath(entry)) {
      files.add(entry);
    } else {
      collectTouchedPaths(entry, files);
    }
  }
}

function looksLikeEditedPath(value: string): boolean {
  const s = value.trim();
  return Boolean(s) && !/^https?:\/\//i.test(s) && /[\\/]|^\w:[\\/]|[.][A-Za-z0-9]+$/.test(s);
}

const inputSchema = z
  .object({
    task: z
      .string()
      .min(1)
      .describe("Self-contained coding task for Ares to run through the external harness. The harness has NONE of your conversation context — spell out the files, the change, and how to verify."),
    backend: z
      .enum(["auto", "claude", "codex"])
      .default("auto")
      .describe("Which coding harness to drive. 'auto' prefers an installed backend with a verified Ares-owned auth binding."),
    allow_install: z
      .boolean()
      .default(false)
      .describe("If the chosen backend isn't installed, permit a consented global npm install before running."),
    offer: z
      .boolean()
      .default(true)
      .describe("Pop the 'Use Claude Code / Codex / or Ares does it?' choice to the user before delegating. Set false ONLY when the user EXPLICITLY named the backend already."),
  })
  .strict();

export interface CodingBackendOutput {
  backend: BackendName;
  label: string;
  status: "completed" | "failed" | "declined";
  summary: string;
  filesTouched: string[];
  installed: boolean;
}

function chooseBackend(requested: "auto" | BackendName): BackendSpec {
  if (requested !== "auto") return BACKENDS[requested];
  // Fallback only. The call path probes installed backends for auto.
  return BACKENDS.claude;
}

const AUTO_BACKEND_ORDER: BackendName[] = ["claude", "codex"];

function backendDisplayLabel(spec: BackendSpec): string {
  return `${ARES_AGENT_NAME} via ${spec.label}`;
}

export function buildAresHarnessPrompt(spec: BackendSpec, task: string): string {
  return [
    "ARES HARNESS CONTRACT",
    `You are ${ARES_AGENT_NAME} running through the ${spec.label} local coding harness.`,
    "The harness provides the operating structure for shell, filesystem, editing, and verification actions.",
    `The agent identity, account, model selection, and final behavior remain ${ARES_AGENT_NAME}.`,
    "Use only the Ares-owned credentials and model supplied by the parent process.",
    "Do not ask the user to sign in to Claude, Codex, Anthropic, or OpenAI.",
    `Do not claim to be ${spec.label}; when naming the agent, say ${ARES_AGENT_NAME}.`,
    "Keep changes scoped, verify when practical, and report concise results.",
    "",
    "DELEGATED TASK",
    task,
  ].join("\n");
}

function buildBackendEnv(spec: BackendSpec, deps: CodingBackendDeps, model: string, workspace: string): Record<string, string> {
  const env: Record<string, string> = {
    ...spec.gatewayEnv(deps.gatewayBase, deps.gatewayToken ?? "", model),
    ARES_AGENT_NAME,
    ARES_HARNESS_BACKEND: spec.name,
    ARES_HARNESS_LABEL: spec.label,
  };
  if (spec.name === "codex") {
    // Keep Codex away from the user's normal ~/.codex auth/config. All provider
    // config is supplied via -c overrides and ARES_GATEWAY_TOKEN.
    env.CODEX_HOME = path.join(workspace, ".ares", "codex-harness");
  }
  return env;
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
      let spec = chooseBackend(i.backend);
      let detection: { installed: boolean; version?: string; reason?: string } | undefined;

      // Auth substitute for OAuth: the Ares account token. No token → nothing to
      // inject, so the backend would fall back to the user's own login (the very
      // thing we're avoiding). Guide them to connect the account instead.
      if (!deps.gatewayToken) {
        throw toolError(
          `${spec.label} runs on your Ares account so no separate login is needed — but no Ares account is connected. ` +
            `Connect it at doingteam.com → Account (or set ARES_GATEWAY_TOKEN), then retry.`,
        );
      }

      if (i.backend === "auto") {
        ctx.emitProgress?.({ kind: "coding_backend", backend: "auto", label: "Ares via coding harness", phase: "detect" });
        for (const candidateName of AUTO_BACKEND_ORDER) {
          const candidate = BACKENDS[candidateName];
          if (!candidate.gatewayReady) continue;
          const candidateDetection = await detectBackend(candidate, ctx.workspace, ctx.signal, spawnImpl);
          if (candidateDetection.installed) {
            spec = candidate;
            detection = candidateDetection;
            break;
          }
          if (!detection) detection = candidateDetection;
        }
      }

      if (!spec.gatewayReady) {
        throw toolError(
          `${spec.label} is a harness target, but this build has no verified Ares-owned auth binding for it yet. ` +
            `Running it raw could use the user's Codex/ChatGPT OAuth or API-key auth, which this tool is not allowed to do. ` +
            `Use Ares' native coding harness, or backend "claude" once a real Claude Code CLI is installed and bound to the Ares account.`,
        );
      }

      // The choice popup: unless the user already named the backend, offer them
      // "Use ${label} / or Ares does it directly". Reuses the permission
      // round-trip (allow = delegate, deny = do it inline). The desktop renders
      // the distinct "CodingBackend:offer" toolName as backend-choice buttons.
      if (i.offer && ctx.requestPermission) {
        const choice = await ctx.requestPermission({
          toolName: "CodingBackend:offer",
          input: { task: i.task.slice(0, 240), backend: spec.name, label: backendDisplayLabel(spec) },
          reason: `Run this as ${backendDisplayLabel(spec)} (Ares identity/account through the harness), or have Ares do it directly?`,
          suggestion: "allow_once",
        });
        if (choice === "deny") {
          return {
            output: {
              backend: spec.name,
              label: backendDisplayLabel(spec),
              status: "declined",
              summary:
                "The user chose to have YOU do this directly instead of delegating. Do NOT call CodingBackend again for this task — implement it now with your own tools (Read/Edit/Write/Bash).",
              filesTouched: [],
              installed: false,
            },
            display: "→ Ares handles it directly",
          };
        }
      }

      ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: backendDisplayLabel(spec), phase: "detect" });
      detection ??= await detectBackend(spec, ctx.workspace, ctx.signal, spawnImpl);

      // Not installed → consented global install.
      if (!detection.installed) {
        if (!i.allow_install) {
          throw toolError(
            `${spec.label} isn't installed${detection.reason ? ` (${detection.reason})` : ""}. Re-run with allow_install: true to install it globally ` +
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
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: backendDisplayLabel(spec), phase: "install" });
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
          throw toolError(
            `${spec.label} still isn't usable after install${detection.reason ? ` (${detection.reason})` : ""} — a new shell may be needed.`,
          );
        }
      }

      // Drive it headless, on the Ares account, in the workspace.
      const delegatedPrompt = buildAresHarnessPrompt(spec, i.task);
      ctx.emitProgress?.({
        kind: "coding_backend",
        backend: spec.name,
        label: backendDisplayLabel(spec),
        phase: "running",
        version: detection.version,
      });
      const run = await runProc(spawnImpl, spec.bin, spec.runArgs(deps.gatewayBase, model), {
        cwd: ctx.workspace,
        env: buildBackendEnv(spec, deps, model, ctx.workspace),
        input: delegatedPrompt,
        timeoutMs: runTimeoutMs,
        signal: ctx.signal,
        onLine: (stream, line) =>
          ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, phase: "running", stream, line }),
      });

      if (run.spawnError) {
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: backendDisplayLabel(spec), phase: "failed" });
        throw toolError(`Couldn't launch ${spec.label}: ${run.spawnError.message}`);
      }

      const parsed = spec.name === "claude" ? parseClaudeStream(run.stdout) : parseCodexStream(run.stdout);
      const failed = run.timedOut || run.code !== 0 || parsed.isError;
      const finalText =
        parsed.result?.trim() ||
        run.stdout.trim().split(/\r?\n/).slice(-40).join("\n") ||
        run.stderr.trim().slice(-2000);

      if (failed) {
        // Let the cut-scene shatter, then surface the correctable error.
        ctx.emitProgress?.({ kind: "coding_backend", backend: spec.name, label: backendDisplayLabel(spec), phase: "failed" });
        throw toolError(
          `${spec.label} ${run.timedOut ? "timed out" : `exited ${run.code}`}. ` +
            `Last output:\n${(finalText || run.stderr).slice(-1500)}`,
        );
      }

      // Victory: the cut-scene celebrates with the final file tally.
      ctx.emitProgress?.({
        kind: "coding_backend",
        backend: spec.name,
        label: backendDisplayLabel(spec),
        phase: "done",
        filesTouched: parsed.files.length,
      });
      return {
        output: {
          backend: spec.name,
          label: backendDisplayLabel(spec),
          status: "completed",
          summary: finalText || "(no textual output)",
          filesTouched: parsed.files,
          installed: true,
        },
        touchedFiles: parsed.files,
        display: `⚡ ${backendDisplayLabel(spec)} → done${parsed.files.length ? ` (${parsed.files.length} file(s))` : ""}`,
      };
    },
  });
}

function buildDescription(): string {
  return `Optionally run a coding task through an external coding harness (Claude Code or Codex) and stream its work back.

Use this only when the user explicitly asks to run something through Claude Code / Codex, or wants a second pass from that local harness. Ares' native coding harness is the default coding path.

KEY PROPERTY: the external harness must run on the ARES ACCOUNT via injected Ares-owned credentials — the user needs NO separate Claude/Codex login or API key, and this tool must never fall back to the user's CLI OAuth.

- backend "auto" picks an installed backend with a verified Ares-owned auth binding.
- Codex is bound through a Codex custom provider named "ares_gateway"; it uses ARES_GATEWAY_TOKEN and an isolated CODEX_HOME, not the user's Codex login.
- If the CLI isn't installed, pass allow_install: true to offer a consented global npm install.
- The task prompt must be SELF-CONTAINED — the backend has none of your conversation context.
- Edits land in the workspace and are covered by the engine's pre-tool checkpoint.

Prefer Ares' own tools for ordinary coding work. Reach for this only on explicit user request or a deliberate harness-comparison pass.`;
}
