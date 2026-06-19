// The coding gauntlet (ARES C6) — the referee that refuses to care about
// your feelings.
//
// Every task is a real miniature repo materialized into a fresh temp
// workspace. The candidate (any provider/model) gets one engine session and
// the tools the composition root hands it. Scoring is reality probes ONLY:
// tests pass, commands print the right thing, files exist with the right
// bones. No LLM judges, no partial credit for confident prose.
//
// "Ares makes any model code better" stops being a claim and becomes a
// number: run the gauntlet with the harness features on and off, same model,
// and read the difference. Every C-phase change must move this number.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QueryEngine, ContinuousVerifier, type EngineTool, type Provider } from "@ares/core";
import { runProbe, type ProbeResult } from "./probe.js";
import type { VerificationSpec } from "./types.js";

export const GAUNTLET_SCHEMA_VERSION = 1;

export interface GauntletTask {
  id: string;
  title: string;
  /** The user prompt the candidate receives. */
  prompt: string;
  /** Workspace setup: relative path → file content. */
  files: Record<string, string>;
  /** Reality probes scored against the workspace after the run. */
  probes: VerificationSpec[];
  /** Engine iteration cap for this task (default 16). */
  maxTurns?: number;
}

export interface GauntletProbeOutcome {
  met: boolean;
  summary: string;
}

export interface GauntletTaskResult {
  id: string;
  title: string;
  /** met probes / total probes, 0..1. */
  score: number;
  probes: GauntletProbeOutcome[];
  toolCalls: number;
  durationMs: number;
  error?: string;
}

export interface GauntletReport {
  schemaVersion: number;
  suite: string;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Mean task score, 0..1 — THE number. */
  total: number;
  tasks: GauntletTaskResult[];
}

export interface GauntletOptions {
  provider: Provider;
  model: string;
  /** Tool composition per workspace — the harness under test. */
  tools: (workspace: string) => readonly EngineTool[] | Promise<readonly EngineTool[]>;
  tasks?: readonly GauntletTask[];
  suite?: string;
  workspaceRoot?: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Keep task workspaces on disk for post-mortems. */
  keepWorkspaces?: boolean;
  /** Probe seam for tests. */
  probe?: (spec: VerificationSpec, ctx: { workspace: string; signal?: AbortSignal }) => Promise<ProbeResult>;
  systemPrompt?: string;
  /** Run with the verification harness (ContinuousVerifier end-gate) ON. This is
   *  the single biggest coding-quality feature — the model can't finish a turn
   *  while its own edits leave the workspace red. Default ON; set false for the
   *  A/B baseline that proves the harness moves the number. */
  harness?: boolean;
}

const GAUNTLET_SYSTEM = `You are Ares running a scored coding evaluation. The workspace contains one task. Work it to completion with your tools: read what exists, make the change, and VERIFY it yourself (run the tests or the command) before finishing. Reality is scored after you stop — unverified claims earn nothing.`;

export async function runGauntlet(opts: GauntletOptions): Promise<GauntletReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const tasks = opts.tasks ?? CODING_GAUNTLET;
  const probe = opts.probe ?? ((spec, ctx) => runProbe(spec, ctx));
  const root = opts.workspaceRoot ?? tmpdir();
  const results: GauntletTaskResult[] = [];

  for (const task of tasks) {
    if (opts.signal?.aborted) break;
    const t0 = Date.now();
    let workspace: string | null = null;
    let toolCalls = 0;
    let error: string | undefined;
    try {
      workspace = await mkdtemp(path.join(root, `gauntlet-${task.id}-`));
      for (const [rel, content] of Object.entries(task.files)) {
        const target = path.join(workspace, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }

      // The verification harness under test: when on, edits schedule a narrow
      // verify, and the end-gate refuses to let the turn finish while the
      // workspace is red — the exact feature this gauntlet exists to measure.
      const harnessOn = opts.harness !== false;
      const verifier = harnessOn ? new ContinuousVerifier({ workspace }) : null;
      const engine = new QueryEngine(
        {
          provider: opts.provider,
          model: opts.model,
          systemPrompt: opts.systemPrompt ?? GAUNTLET_SYSTEM,
          tools: await opts.tools(workspace),
          workspace,
          signal: opts.signal,
          maxTurns: task.maxTurns ?? 16,
          ...(verifier
            ? {
                drainSystemReminders: () => verifier.drainReminders().map((r) => ({ text: r.text, source: "verifier" as const })),
                confirmTurnEnd: async () => {
                  await verifier.settle(10_000);
                  return verifier.drainReminders().map((r) => ({ text: r.text, source: "verifier" as const }));
                },
              }
            : {}),
        },
        `gauntlet_${task.id}`,
      );
      engine.appendUserMessage(task.prompt);
      try {
        for await (const event of engine.streamTurn()) {
          if (event.type === "tool_start") toolCalls++;
          if (event.type === "tool_end" && event.touchedFiles?.length) verifier?.scheduleFor(event.touchedFiles);
          if (event.type === "error" && !error) error = event.error.message;
        }
      } finally {
        await verifier?.cancel();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // Reality is scored even when the run errored — partial work counts
    // exactly as much as reality says it does.
    const probeOutcomes: GauntletProbeOutcome[] = [];
    for (const spec of task.probes) {
      try {
        const result = workspace
          ? await probe(spec, { workspace, signal: opts.signal })
          : { met: false, summary: "workspace never materialized" };
        probeOutcomes.push({ met: result.met, summary: result.summary });
      } catch (err) {
        probeOutcomes.push({ met: false, summary: `probe threw: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const met = probeOutcomes.filter((p) => p.met).length;
    results.push({
      id: task.id,
      title: task.title,
      score: task.probes.length > 0 ? met / task.probes.length : 0,
      probes: probeOutcomes,
      toolCalls,
      durationMs: Date.now() - t0,
      ...(error ? { error } : {}),
    });

    if (workspace && !opts.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const finishedAt = now();
  return {
    schemaVersion: GAUNTLET_SCHEMA_VERSION,
    suite: opts.suite ?? "coding-v1",
    provider: opts.provider.name,
    model: opts.model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    total: results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0,
    tasks: results,
  };
}

// ─── coding-v1: the seed suite ─────────────────────────────────────────────
//
// Small on purpose: each task is one canonical failure mode, runs in seconds,
// and is scored by running real code. Friend-challenge tasks get appended
// here as they're collected — beating THEIR benchmarks is the point.

export const CODING_GAUNTLET: GauntletTask[] = [
  {
    id: "fix-failing-test",
    title: "Fix the bug the test exposes (do not touch the test)",
    prompt:
      "The test in math.test.mjs is failing. Find the bug, fix it WITHOUT changing the test, and run the test to confirm it passes.",
    files: {
      "math.mjs": "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
      "math.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, mul } from "./math.mjs";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n\ntest("mul", () => {\n  assert.equal(mul(3, 4), 12);\n});\n',
    },
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "math.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "file", path: "math.test.mjs", contains: "add(2, 3), 5" },
    ],
  },
  {
    id: "implement-to-spec",
    title: "Implement a module to satisfy an existing test suite",
    prompt:
      "Implement slugify.mjs exporting `slugify(text)` so every test in slugify.test.mjs passes. Run the tests to confirm.",
    files: {
      "slugify.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "./slugify.mjs";\n\ntest("lowercases", () => assert.equal(slugify("Hello"), "hello"));\ntest("spaces to dashes", () => assert.equal(slugify("hello world"), "hello-world"));\ntest("strips punctuation", () => assert.equal(slugify("hello, world!"), "hello-world"));\ntest("collapses dashes", () => assert.equal(slugify("a  --  b"), "a-b"));\ntest("trims edge dashes", () => assert.equal(slugify("  hi  "), "hi"));\n',
    },
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "slugify.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "file", path: "slugify.mjs", contains: "export" },
    ],
  },
  {
    id: "cross-file-bug",
    title: "Trace a bug across module boundaries",
    prompt:
      'Running `node app.mjs` prints "listening on undefined". Fix the codebase so it prints "listening on 8080". Run it to confirm.',
    files: {
      "config.mjs": "export const config = {\n  portt: 8080,\n  host: \"127.0.0.1\",\n};\n",
      "app.mjs": 'import { config } from "./config.mjs";\n\nconsole.log(`listening on ${config.port}`);\n',
    },
    probes: [
      { kind: "command", cmd: "node", args: ["app.mjs"], expectExit: 0, contains: "listening on 8080", timeoutMs: 15_000 },
    ],
  },
  {
    id: "holo-viewer",
    title: "The Holotable task — generate a hologram-style 3D viewer",
    prompt:
      "Create holo.html: a SELF-CONTAINED hologram-style 3D viewer using three.js from a CDN. Requirements: dark background; a procedurally-built mech/robot from primitive geometries (no external model files); bronze wireframe + additive-glow materials; an exploded-view range slider that smoothly moves the parts outward from the core along their assembly axes and back; orbit controls (drag to rotate, wheel to zoom); a small HUD label naming the focused part. One file, opens directly in a browser, no build step.",
    files: {
      "README.md": "# Holotable task\nDeliver holo.html per the prompt. It will be structurally scored.\n",
    },
    probes: [
      { kind: "file", path: "holo.html", contains: "three" },
      { kind: "file", path: "holo.html", contains: "exploded" },
      { kind: "file", path: "holo.html", contains: "input" },
      { kind: "file", path: "holo.html", contains: "wireframe" },
    ],
    maxTurns: 24,
  },
];
