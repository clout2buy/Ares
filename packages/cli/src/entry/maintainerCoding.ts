// The Maintainer's coding hands: the SAME coding machinery the gauntlet and the operator use
// (buildCodingTools + runForkedTurn), pointed at a throwaway worktree, unattended.
//
// What bounds it:
//   - workspace = the worktree; its own isolated ARES_HOME (no live memory, no live vault) - the
//     provider selection is resolved up front, so it needs no keys from that home;
//   - permissions = the unattended policy gate: anything that needs a human (payments, secrets, mail,
//     destructive shell, git push, ...) is DENIED, nobody is there to ask;
//   - an extra wall: any tool input that mentions the live checkout is denied;
//   - model calls: a hard cap (task.maxModelCalls) enforced by aborting the turn, plus maxTurns;
//   - wall clock: task.timeoutMs; and the owner's kill switch / pause via task.signal.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { runForkedTurn, type ToolPermissionRequest } from "@ares/core";
import { ShellRegistry, TodoStore } from "@ares/tools";
import type { CodingResult, CodingRunner, CodingTask } from "../maintainer/maintainer.js";
import { gateToolPermission } from "../policyGate.js";
import { buildCodingTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore } from "./permissions.js";
import { selectProvider, type ProviderSelection } from "./providers.js";
import { cliRuntimeContext, type AresRuntimeState } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";

export interface CodingRunnerOptions {
  /** Where the live checkout is; a tool input that mentions it is refused. */
  liveDir: string;
  /** Resolve the provider (default: the same selection the gauntlet uses). Tests inject a mock. */
  selection?: () => Promise<ProviderSelection>;
  /** Install dependencies and build in the worktree before the agent starts (default true). */
  prepare?: boolean;
  /** Give the agent a shell (default true: it must be able to run tests). */
  shell?: boolean;
  log?: (line: string) => void;
}

function sh(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-4).join(" | ").slice(0, 300);
      resolve({ code: err ? 1 : 0, tail });
    });
  });
}

/** Deny a tool call that reaches for the live tree; otherwise the unattended policy gate decides. PURE. */
export function unattendedDecision(request: ToolPermissionRequest, liveDir: string): "allow_once" | "deny" {
  const text = (() => { try { return JSON.stringify(request.input ?? ""); } catch { return ""; } })().replaceAll("\\\\", "/");
  const live = liveDir.replaceAll("\\", "/").replace(/\/+$/, "");
  if (live && text.includes(live)) return "deny";
  const gate = gateToolPermission(request, { attended: false });
  return gate.kind === "allow" ? "allow_once" : "deny";
}

export function createMaintainerCodingRunner(opts: CodingRunnerOptions): CodingRunner {
  return {
    async run(task: CodingTask): Promise<CodingResult> {
      const log = opts.log ?? (() => {});
      if (opts.prepare !== false) {
        // Fresh worktree: no node_modules, no dist. Without them the agent cannot run a single test.
        const install = await sh("pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile", task.dir, 15 * 60_000);
        if (install.code !== 0) return { ok: false, summary: `could not install dependencies in the worktree: ${install.tail}` };
        const build = await sh("pnpm build", task.dir, 20 * 60_000);
        if (build.code !== 0) return { ok: false, summary: `the unmodified source does not build in the worktree: ${build.tail}` };
      }
      const selection = await (opts.selection ?? (() => selectProvider(new Map())))();
      const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "ares-maintainer-home-"));
      const shellRegistry = new ShellRegistry();
      const controller = new AbortController();
      const abortOn = (reason: string) => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
      const onOuterAbort = () => abortOn("stopped by the owner");
      if (task.signal.aborted) onOuterAbort(); else task.signal.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(() => abortOn("task time limit reached"), task.timeoutMs);
      try {
        const context = cliRuntimeContext({ workspace: task.dir, home: isolatedHome });
        const runtime: AresRuntimeState = { permissionMode: "workspace-write" };
        const [pathPermissions, commandPermissions] = await Promise.all([AresPathPermissionStore.load(context), AresCommandPermissionStore.load(context)]);
        const tools = await buildCodingTools(pathPermissions, commandPermissions, selection, runtime, context, shellRegistry, new TodoStore(), new Map(), { shell: opts.shell !== false });
        const out = await runForkedTurn({
          config: {
            provider: selection.provider,
            model: selection.model,
            systemPrompt: buildSystemPrompt("workspace-write", context),
            tools,
            workspace: task.dir,
            signal: controller.signal,
            maxTurns: task.maxModelCalls,
            requestPermission: async (request) => unattendedDecision(request, opts.liveDir),
          },
          sessionId: `maintainer_${path.basename(task.dir)}`,
          inputId: `maintainer_input_${path.basename(task.dir)}`,
          seed: { kind: "work-item", text: task.prompt },
          onEvent: (event) => {
            if (event.type === "message_done") {
              task.meter.calls += event.usage.modelCalls ?? 1;
              task.meter.tokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
              if (task.meter.calls >= task.maxModelCalls) abortOn("model-call budget reached");
              else if (task.meter.tokens >= task.maxTokens) abortOn("token budget reached");
            }
          },
        });
        const summary = (out.finalText || out.streamedText).replace(/\s+/g, " ").trim().slice(0, 800);
        const stopped = controller.signal.aborted ? ` (${String((controller.signal.reason as Error | undefined)?.message ?? "stopped")})` : "";
        const ok = out.status === "completed" && out.workStatus !== "blocked" && !controller.signal.aborted;
        log(`coding ${ok ? "finished" : "did not finish"}: status=${out.status} work=${out.workStatus} calls=${task.meter.calls}`);
        return { ok, summary: ok ? summary || "no summary" : `${out.status}/${out.workStatus}${stopped}: ${summary || "no output"}` };
      } finally {
        clearTimeout(timer);
        task.signal.removeEventListener("abort", onOuterAbort);
        await shellRegistry.killAll().catch(() => 0);
        await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
