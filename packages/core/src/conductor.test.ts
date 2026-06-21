// conductor.test.ts — proves the deterministic runtime works WITHOUT a live
// provider by injecting a mock runAgent fn. Covers the review-hardened behaviour:
// parallel fan-out + concat reduce, the HAND-OFF semaphore CAP (observed peak
// in-flight under deliberate overlap), pipeline stage hand-off via VALIDATED
// structured output + {{prev}} templates, the pipeline SCHEMA BARRIER (a failed
// extract stops the pipeline instead of seeding garbage), unresolved-template
// surfacing, schema reprompt success, budget PRE-FLIGHT enforcement (no new fork
// admitted once spent — overshoot bounded), the completed-but-over-budget status
// distinction, write-tool stripping under the unattended posture, agent-count and
// recursion-guard validation, and Promise.allSettled fault isolation.
//
// Run: node --test (or vitest) — no network, no model.

import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import type { TurnEndStatus, Usage } from "@ares/protocol";
import {
  runFleet,
  resolveTemplates,
  type ConductorDeps,
  type FleetSpec,
  type RunAgentArgs,
  type RunAgentResult,
  type LeafValidator,
  type SchemaHinter,
} from "./conductor.js";
import type { EngineTool } from "./queryEngine.js";

// ─── Mock substrate ────────────────────────────────────────────────────────

const U = (i = 10, o = 10): Usage => ({ inputTokens: i, outputTokens: o, modelCalls: 1 });

function tool(name: string, safety: "read-only" | "workspace-write" = "read-only"): EngineTool {
  return {
    schema: {
      name,
      description: "",
      inputJsonSchema: {},
      safety,
      concurrency: "parallel-safe",
    } as any,
    call: async () => ({ output: null }),
  };
}

// A shape-example validator: every example key must be present + type-compatible.
const validate: LeafValidator = (schema, parsed) => {
  if (parsed == null || typeof parsed !== "object") return { ok: false, issues: "not an object" };
  const p = parsed as Record<string, unknown>;
  for (const k of Object.keys(schema)) {
    if (!(k in p)) return { ok: false, issues: `${k}: missing` };
  }
  return { ok: true, value: parsed };
};
const schemaHint: SchemaHinter = (s) => JSON.stringify(s);

function baseDeps(
  overrides: Partial<ConductorDeps>,
  runAgent?: ConductorDeps["runAgent"],
): ConductorDeps {
  return {
    provider: { name: "mock", stream: async function* () {} } as any,
    model: "mock",
    parentTools: [tool("Read"), tool("Grep"), tool("Write", "workspace-write")],
    baseSystemPrompt: "base",
    workspace: os.tmpdir(), // journaling is best-effort; tmpdir keeps it harmless
    signal: new AbortController().signal,
    defaultMaxTurns: 4,
    validate,
    schemaHint,
    runAgent,
    ...overrides,
  };
}

// A mock runner that returns scripted finalText keyed by role, and records calls.
function scriptedRunner(
  script: Record<string, RunAgentResult | RunAgentResult[]>,
  record?: { calls: RunAgentArgs[]; inFlight: number; peak: number },
): ConductorDeps["runAgent"] {
  const cursor: Record<string, number> = {};
  return async (args: RunAgentArgs): Promise<RunAgentResult> => {
    if (record) {
      record.calls.push(args);
      record.inFlight++;
      record.peak = Math.max(record.peak, record.inFlight);
      await new Promise((r) => setTimeout(r, 5)); // overlap window for the cap test
    }
    const entry =
      script[args.role] ??
      ({ finalText: `default:${args.role}`, events: [], usage: U(), status: "completed" as TurnEndStatus });
    let out: RunAgentResult;
    if (Array.isArray(entry)) {
      const idx = Math.min(cursor[args.role] ?? 0, entry.length - 1);
      cursor[args.role] = (cursor[args.role] ?? 0) + 1;
      out = entry[idx];
    } else {
      out = entry;
    }
    if (record) record.inFlight--;
    return out;
  };
}

// ─── Unit: resolveTemplates ────────────────────────────────────────────────

test("resolveTemplates resolves known refs and counts unknown ones", () => {
  const ok = resolveTemplates("about {{prev.topic}}", { prev: { topic: "auth" } });
  assert.equal(ok.text, "about auth");
  assert.equal(ok.unresolved, 0);

  const bad = resolveTemplates("about {{prev.topic}} and {{prev.missing}}", { prev: { topic: "auth" } });
  assert.equal(bad.text, "about auth and {{prev.missing}}");
  assert.equal(bad.unresolved, 1);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

test("parallel phase fans out, concat reduce joins all leaves, status completed", async () => {
  const spec: FleetSpec = {
    phases: [
      {
        id: "survey",
        kind: "parallel",
        reduce: "concat",
        agents: [
          { role: "a", prompt: "do a" },
          { role: "b", prompt: "do b" },
        ],
      },
    ],
  };
  const run = scriptedRunner({
    a: { finalText: "ALPHA", events: [], usage: U(), status: "completed" },
    b: { finalText: "BETA", events: [], usage: U(), status: "completed" },
  });
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.status, "completed");
  assert.equal(res.phases[0].leaves.length, 2);
  assert.ok(res.summary.includes("ALPHA"));
  assert.ok(res.summary.includes("BETA"));
});

test("hand-off semaphore caps in-flight forks at the configured concurrency", async () => {
  const record = { calls: [] as RunAgentArgs[], inFlight: 0, peak: 0 };
  const agents = Array.from({ length: 6 }, (_, i) => ({ role: `r${i}`, prompt: "x" }));
  const spec: FleetSpec = { concurrency: 2, phases: [{ id: "p", kind: "parallel", agents }] };
  await runFleet(spec, baseDeps({}, scriptedRunner({}, record)));
  assert.equal(record.calls.length, 6);
  assert.ok(record.peak <= 2, `peak in-flight was ${record.peak}, expected <= 2`);
});

test("concurrency is hard-clamped to MAX_CONCURRENCY regardless of spec", async () => {
  // Spec asks for 1000; the runtime must clamp so a huge value never explodes.
  const record = { calls: [] as RunAgentArgs[], inFlight: 0, peak: 0 };
  const agents = Array.from({ length: 20 }, (_, i) => ({ role: `r${i}`, prompt: "x" }));
  const spec: FleetSpec = { concurrency: 1000, phases: [{ id: "p", kind: "parallel", agents }] };
  await runFleet(spec, baseDeps({}, scriptedRunner({}, record)));
  assert.ok(record.peak <= 8, `peak in-flight was ${record.peak}, expected <= MAX_CONCURRENCY (8)`);
});

test("pipeline seeds stage K with stage K-1 VALIDATED structured output via {{prev}}", async () => {
  const captured: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    captured.push(args.prompt);
    if (args.role === "extract") {
      return { finalText: '{"topic":"auth"}', events: [], usage: U(), status: "completed" };
    }
    return { finalText: "wrote it", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      {
        id: "pipe",
        kind: "pipeline",
        agents: [
          { role: "extract", prompt: "find the topic", schema: { topic: "..." } },
          { role: "write", prompt: "Write about {{prev.topic}}" },
        ],
      },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.status, "completed");
  // stage 2 prompt must have the {{prev.topic}} template resolved IN-HOST.
  const writePrompt = captured.find((p) => p.startsWith("Write about"));
  assert.equal(writePrompt, "Write about auth");
  assert.equal(res.phases[0].leaves[0].schemaValid, true);
  assert.equal(res.phases[0].status, "completed");
  assert.equal(res.phases[0].unresolvedTemplates, 0);
});

test("BARRIER: a failed-schema extract stops the pipeline; the write stage never runs", async () => {
  const captured: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    captured.push(args.role);
    if (args.role === "extract") {
      // No JSON at all → schema can never be satisfied (no subModel → invalid).
      return { finalText: "I could not find a topic.", events: [], usage: U(), status: "completed" };
    }
    return { finalText: "wrote it", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      {
        id: "pipe",
        kind: "pipeline",
        agents: [
          { role: "extract", prompt: "find the topic", schema: { topic: "..." } },
          { role: "write", prompt: "Write about {{prev.topic}}" },
        ],
      },
    ],
  };
  const res = await runFleet(spec, baseDeps({ schemaRetries: 0 }, run));
  assert.equal(res.phases[0].status, "failed");
  assert.equal(res.status, "failed");
  // The write stage must NOT have been invoked at all.
  assert.equal(captured.includes("write"), false);
  assert.ok(/schema/.test(res.phases[0].failureReason ?? ""));
});

test("BARRIER: an unresolved {{prev.field}} in a later stage stops the pipeline", async () => {
  const captured: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    captured.push(args.role);
    if (args.role === "extract") {
      // Valid schema, but the field the next stage references is 'subject' not 'topic'.
      return { finalText: '{"subject":"auth"}', events: [], usage: U(), status: "completed" };
    }
    return { finalText: "wrote it", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      {
        id: "pipe",
        kind: "pipeline",
        agents: [
          { role: "extract", prompt: "find it", schema: { subject: "..." } },
          { role: "write", prompt: "Write about {{prev.topic}}" }, // wrong field name
        ],
      },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.equal(res.status, "failed");
  // The write leaf is recorded (its unresolved ref is what tripped the barrier),
  // but no THIRD stage would ever run. Crucially the runtime detected the broken
  // hand-off rather than prompting downstream with literal mustache tokens.
  const writeLeaf = res.phases[0].leaves.find((l) => l.role === "write");
  assert.ok(writeLeaf && writeLeaf.unresolvedTemplates >= 1);
});

test("schema mismatch triggers a bounded reprompt re-fork carrying task context, then succeeds", async () => {
  const instructions: string[] = [];
  let calls = 0;
  const run: ConductorDeps["runAgent"] = async (args) => {
    calls++;
    instructions.push(args.prompt);
    // first call: missing required key; reprompt call: valid.
    return calls === 1
      ? { finalText: '{"wrong":1}', events: [], usage: U(), status: "completed" }
      : { finalText: '{"answer":"42"}', events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "compute the answer", schema: { answer: "..." } }] }],
  };
  const res = await runFleet(spec, baseDeps({ schemaRetries: 2 }, run));
  assert.ok(calls >= 2, "expected at least one reprompt re-fork");
  // The reprompt must carry the ORIGINAL task context (finding #4 hardening),
  // not a bare "reply with JSON" instruction.
  assert.ok(
    instructions.some((p) => p.includes("compute the answer")),
    "reprompt should re-anchor on the original task",
  );
  const leaf = res.phases[0].leaves[0];
  assert.equal(leaf.schemaValid, true);
  assert.deepEqual(leaf.structured, { answer: "42" });
});

test("persistent schema miss with no subModel yields schemaValid:false, never throws", async () => {
  const run: ConductorDeps["runAgent"] = async () => ({
    finalText: "not json at all",
    events: [],
    usage: U(),
    status: "completed",
  });
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "q", schema: { x: 0 } }] }],
  };
  const res = await runFleet(spec, baseDeps({ schemaRetries: 1 }, run));
  assert.equal(res.phases[0].leaves[0].schemaValid, false);
  assert.equal(res.status, "completed"); // a bad leaf in a PARALLEL phase is recorded, not fatal
});

test("budget PRE-FLIGHT halts the fleet: no new fork admitted once spent, status aborted", async () => {
  const ranRoles: string[] = [];
  // Each leaf burns 1000 tokens; budget 1500. After leaf #2 the running total is
  // 2000 ≥ 1500, so phase p2 must never admit its leaf.
  const run: ConductorDeps["runAgent"] = async (args) => {
    ranRoles.push(args.role);
    return { finalText: args.role, events: [], usage: U(500, 500), status: "completed" };
  };
  const spec: FleetSpec = {
    maxTotalTokens: 1500,
    concurrency: 1,
    phases: [
      { id: "p1", kind: "pipeline", agents: [{ role: "a", prompt: "x" }, { role: "b", prompt: "x" }] },
      { id: "p2", kind: "pipeline", agents: [{ role: "c", prompt: "x" }] },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.budgetExceeded, true);
  assert.equal(res.status, "aborted");
  // 'c' must NOT have been spawned (pre-flight gate).
  assert.equal(ranRoles.includes("c"), false);
});

test("a fleet that finishes every phase but is over budget is completed (not relabeled aborted)", async () => {
  // budget 50; a single leaf burns 100 → over budget AFTER it ran, but nothing
  // was cut: the one and only phase completed. status must stay 'completed'.
  const run: ConductorDeps["runAgent"] = async (args) => ({
    finalText: args.role,
    events: [],
    usage: U(60, 40),
    status: "completed",
  });
  const spec: FleetSpec = {
    maxTotalTokens: 50,
    phases: [{ id: "only", kind: "parallel", agents: [{ role: "a", prompt: "x" }] }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.budgetExceeded, true);
  assert.equal(res.status, "completed");
});

test("unattended posture STRIPS non-read-only tools from a leaf's catalog", async () => {
  let sawTools: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    sawTools = args.tools.map((t) => t.schema.name);
    return { finalText: "ok", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      { id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", tools: ["Read", "Write"] }] },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run)); // allowWriteTools defaults false
  assert.deepEqual(sawTools, ["Read"]); // Write (workspace-write) stripped
  assert.deepEqual(res.phases[0].leaves[0].strippedTools, ["Write"]);
});

test("allowWriteTools:true keeps write tools in the scoped catalog", async () => {
  let sawTools: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    sawTools = args.tools.map((t) => t.schema.name);
    return { finalText: "ok", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      { id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", tools: ["Read", "Write"] }] },
    ],
  };
  await runFleet(spec, baseDeps({ allowWriteTools: true }, run));
  assert.deepEqual(sawTools.sort(), ["Read", "Write"]);
});

test("Promise.allSettled isolates a thrown leaf: the phase still completes", async () => {
  const run: ConductorDeps["runAgent"] = async (args) => {
    if (args.role === "boom") throw new Error("leaf exploded");
    return { finalText: args.role, events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      {
        id: "p",
        kind: "parallel",
        agents: [{ role: "ok", prompt: "x" }, { role: "boom", prompt: "x" }],
      },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  const roles = res.phases[0].leaves.map((l) => `${l.role}:${l.status}`).sort();
  assert.deepEqual(roles, ["boom:failed", "ok:completed"]);
});

test("unknown tool in a whitelist throws loudly at spec-parse time", async () => {
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", tools: ["Nope"] }] }],
  };
  await assert.rejects(() => runFleet(spec, baseDeps({}, scriptedRunner({}))), /unknown tool 'Nope'/);
});

test("a child whitelisting an orchestration tool (recursion) is rejected", async () => {
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", tools: ["Conductor"] }] }],
  };
  await assert.rejects(() => runFleet(spec, baseDeps({}, scriptedRunner({}))), /Conductor/);
});

test("an over-large fan-out is rejected by the per-fleet agent cap", async () => {
  const agents = Array.from({ length: 100 }, (_, i) => ({ role: `r${i}`, prompt: "x" }));
  const spec: FleetSpec = { phases: [{ id: "p", kind: "parallel", agents }] };
  await assert.rejects(() => runFleet(spec, baseDeps({}, scriptedRunner({}))), /cap/);
});

// ─── New: judge reduce, resume, transcript ──────────────────────────────────

test("reduce:'judge' runs one extra synthesis fork over the siblings", async () => {
  const record = { calls: [] as RunAgentArgs[], inFlight: 0, peak: 0 };
  const spec: FleetSpec = {
    phases: [
      {
        id: "review",
        kind: "parallel",
        reduce: "judge",
        judgeInstruction: "merge them",
        agents: [
          { role: "correctness", prompt: "find bugs" },
          { role: "security", prompt: "find vulns" },
        ],
      },
    ],
  };
  const runner = scriptedRunner(
    {
      correctness: { finalText: "bug A", events: [], usage: U(), status: "completed" },
      security: { finalText: "vuln B", events: [], usage: U(), status: "completed" },
      "review-judge": { finalText: "MERGED: A + B", events: [], usage: U(), status: "completed" },
    },
    record,
  );
  const result = await runFleet(spec, baseDeps({}, runner));
  // The judge fork ran (3 calls = 2 leaves + 1 judge) and its output is the reduced result.
  assert.equal(record.calls.length, 3);
  assert.equal(result.phases[0].reduced, "MERGED: A + B");
  const judgeCall = record.calls.find((c) => c.role === "review-judge");
  assert.ok(judgeCall, "judge fork was spawned");
  assert.match(judgeCall!.prompt, /merge them/);
  assert.match(judgeCall!.prompt, /bug A/);
  assert.match(judgeCall!.prompt, /vuln B/);
});

test("resumeFleetId reuses completed leaves and only re-runs the rest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fleet-resume-"));
  const spec: FleetSpec = {
    phases: [
      {
        id: "p1",
        kind: "parallel",
        reduce: "concat",
        agents: [
          { role: "ok", prompt: "succeeds" },
          { role: "boom", prompt: "fails first time" },
        ],
      },
    ],
  };
  // First run: 'ok' completes, 'boom' fails.
  const run1Calls: RunAgentArgs[] = [];
  const runner1 = scriptedRunner(
    {
      ok: { finalText: "ok-output", events: [], usage: U(), status: "completed" },
      boom: { finalText: "boom-failed", events: [], usage: U(), status: "failed" },
    },
    { calls: run1Calls, inFlight: 0, peak: 0 },
  );
  const first = await runFleet(spec, baseDeps({ workspace }, runner1));
  assert.equal(run1Calls.length, 2);

  // Second run, resuming: 'ok' must NOT be re-invoked; only 'boom' re-runs (now succeeds).
  const run2Calls: RunAgentArgs[] = [];
  const runner2 = scriptedRunner(
    {
      ok: { finalText: "SHOULD-NOT-RUN", events: [], usage: U(), status: "completed" },
      boom: { finalText: "boom-fixed", events: [], usage: U(), status: "completed" },
    },
    { calls: run2Calls, inFlight: 0, peak: 0 },
  );
  const second = await runFleet(
    { ...spec, resumeFleetId: first.fleetId },
    baseDeps({ workspace }, runner2),
  );
  const roles2 = run2Calls.map((c) => c.role);
  assert.deepEqual(roles2, ["boom"], "only the failed leaf re-ran");
  const okLeaf = second.phases[0].leaves.find((l) => l.role === "ok");
  assert.equal(okLeaf?.text, "ok-output", "completed leaf reused verbatim");
  assert.equal(okLeaf?.usage.inputTokens, 0, "reused leaf charges no fresh tokens");
});

test("each leaf writes a transcript the manifest can reference", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fleet-transcript-"));
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "solo", prompt: "go" }] }],
  };
  const runner = scriptedRunner({
    solo: { finalText: "the answer", events: [], usage: U(), status: "completed" },
  });
  const result = await runFleet(spec, baseDeps({ workspace }, runner));
  const tp = result.phases[0].leaves[0].transcriptPath;
  assert.ok(tp, "transcriptPath is stamped");
  // fire-and-forget write — give the microtask a tick to flush
  await new Promise((r) => setTimeout(r, 20));
  const body = await readFile(tp, "utf8");
  assert.match(body, /the answer/, "transcript records the final text");
});


// ─── Gold-pass regression tests (recursion guard, schema reject, NaN, model
//     override, resume role-match, multi-bracket JSON) ──────────────────────

test("a leaf omitting `tools` never inherits Task/Operator/Conductor (recursion guard, gap #1)", async () => {
  let sawTools: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    sawTools = args.tools.map((t) => t.schema.name);
    return { finalText: "ok", events: [], usage: U(), status: "completed" };
  };
  const deps = baseDeps({}, run);
  // Host FORGOT to exclude Task/Conductor from the catalog — the runtime must still strip them.
  deps.parentTools = [
    tool("Read"),
    tool("Grep"),
    tool("Task"),
    tool("Conductor"),
    tool("Operator"),
    tool("Write", "workspace-write"),
  ];
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x" }] }], // tools omitted
  };
  const res = await runFleet(spec, deps);
  assert.deepEqual(sawTools.sort(), ["Grep", "Read"], "only read-only, non-orchestration tools survive");
  const stripped = res.phases[0].leaves[0].strippedTools.sort();
  assert.ok(stripped.includes("Task") && stripped.includes("Conductor") && stripped.includes("Operator"));
  assert.ok(stripped.includes("Write"));
});

test("an empty or primitive schema example throws at spec time (gap #2)", async () => {
  const emptyObj: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", schema: {} }] }],
  };
  await assert.rejects(() => runFleet(emptyObj, baseDeps({}, scriptedRunner({}))), /NON-EMPTY shape-example/);

  const primitive = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", schema: "topic" }] }],
  } as unknown as FleetSpec;
  await assert.rejects(() => runFleet(primitive, baseDeps({}, scriptedRunner({}))), /NON-EMPTY shape-example/);

  // sanity: a real non-empty shape is NOT rejected (it just runs).
  const ok: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x", schema: { topic: "..." } }] }],
  };
  const res = await runFleet(ok, baseDeps({}, scriptedRunner({ a: { finalText: '{"topic":"auth"}', events: [], usage: U(), status: "completed" } })));
  assert.equal(res.status, "completed");
});

test("NaN/non-finite concurrency is coerced to a safe default, no deadlock (gap #7)", async () => {
  const ran: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    ran.push(args.role);
    return { finalText: args.role, events: [], usage: U(), status: "completed" };
  };
  const agents = Array.from({ length: 4 }, (_, i) => ({ role: `r${i}`, prompt: "x" }));
  const spec = { concurrency: NaN, phases: [{ id: "p", kind: "parallel", agents }] } as unknown as FleetSpec;
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(ran.length, 4, "all leaves ran — no semaphore deadlock");
  assert.equal(res.phases[0].leaves.length, 4);
  assert.equal(res.status, "completed");
});

test("a per-agent model override reaches the runner args (gap #5)", async () => {
  const seen: Record<string, string | undefined> = {};
  const run: ConductorDeps["runAgent"] = async (args) => {
    seen[args.role] = args.model;
    return { finalText: args.role, events: [], usage: U(), status: "completed" };
  };
  const spec = {
    phases: [
      {
        id: "p",
        kind: "parallel",
        agents: [
          { role: "cheap", prompt: "x", model: "small-model" },
          { role: "inherit", prompt: "x" },
        ],
      },
    ],
  } as unknown as FleetSpec;
  await runFleet(spec, baseDeps({}, run));
  assert.equal(seen["cheap"], "small-model");
  assert.equal(seen["inherit"], undefined, "no override → inherits fleet model (undefined args.model)");
});

test("resume does not substitute a completed leaf when the slot's role changed (gap #4)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fleet-rolematch-"));
  const first = await runFleet(
    { phases: [{ id: "p", kind: "parallel", agents: [{ role: "old", prompt: "x" }] }] },
    baseDeps({ workspace }, scriptedRunner({ old: { finalText: "OLD-OUTPUT", events: [], usage: U(), status: "completed" } })),
  );
  const run2: RunAgentArgs[] = [];
  const second = await runFleet(
    { resumeFleetId: first.fleetId, phases: [{ id: "p", kind: "parallel", agents: [{ role: "new", prompt: "x" }] }] },
    baseDeps({ workspace }, scriptedRunner({ new: { finalText: "NEW-OUTPUT", events: [], usage: U(), status: "completed" } }, { calls: run2, inFlight: 0, peak: 0 })),
  );
  assert.deepEqual(run2.map((c) => c.role), ["new"], "the new agent ran fresh, not reused");
  assert.equal(second.phases[0].leaves[0].text, "NEW-OUTPUT");
});

test("a leaf with prose + inline brace before real JSON validates without reprompt (gap #6)", async () => {
  let calls = 0;
  const run: ConductorDeps["runAgent"] = async () => {
    calls++;
    return {
      finalText: 'Here is the result {as requested}: {"answer":"42"}',
      events: [],
      usage: U(),
      status: "completed",
    };
  };
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "compute", schema: { answer: "..." } }] }],
  };
  const res = await runFleet(spec, baseDeps({ schemaRetries: 2 }, run));
  assert.equal(calls, 1, "no reprompt re-fork needed — the real JSON parsed on the first pass");
  const leaf = res.phases[0].leaves[0];
  assert.equal(leaf.schemaValid, true);
  assert.deepEqual(leaf.structured, { answer: "42" });
});

test("a parallel phase whose every leaf fails is status failed, not completed (gap #9)", async () => {
  const run: ConductorDeps["runAgent"] = async (args) => {
    if (args.role === "x" || args.role === "y") throw new Error("boom");
    return { finalText: args.role, events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "x", prompt: "a" }, { role: "y", prompt: "b" }] }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.ok(res.phases[0].failureReason && /every leaf/.test(res.phases[0].failureReason));
});

test("a stage-0 {{prev.field}} reference fails the pipeline barrier (gap #15)", async () => {
  const ran: string[] = [];
  const run: ConductorDeps["runAgent"] = async (args) => {
    ran.push(args.role);
    return { finalText: "ok", events: [], usage: U(), status: "completed" };
  };
  const spec: FleetSpec = {
    phases: [
      {
        id: "pipe",
        kind: "pipeline",
        agents: [
          { role: "first", prompt: "build on {{prev.thing}}" }, // unresolved at idx 0
          { role: "second", prompt: "continue" },
        ],
      },
    ],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.equal(res.status, "failed");
  assert.equal(ran.includes("second"), false, "the second stage never ran on garbage");
});

test("a leaf wedged past the wall-clock cannot hang the fleet — the race returns (gap #3)", async () => {
  // A leaf that would run far past the wall-clock. It settles ONLY when the fleet
  // aborts (so the test leaves no dangling promise), but it never resolves on its
  // OWN — so the only thing that makes runFleet return is the wall-clock race.
  const run: ConductorDeps["runAgent"] = (args) =>
    new Promise<RunAgentResult>((resolve) => {
      args.signal.addEventListener(
        "abort",
        () => resolve({ finalText: "", events: [], usage: U(), status: "interrupted" }),
        { once: true },
      );
    });
  const spec: FleetSpec = {
    maxWallClockMs: 30, // fire fast
    phases: [{ id: "p", kind: "parallel", agents: [{ role: "hang", prompt: "x" }] }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.status, "aborted");
  assert.equal(res.phases[0].status, "aborted");
});

test("a hung-then-rejecting leaf is swallowed, not an unhandled rejection (gap #3 .catch guard)", async () => {
  // Belt-and-braces: fail the test if ANY unhandled rejection escapes during this run.
  let escaped: unknown;
  const onUnhandled = (err: unknown) => { escaped = err; };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Pipeline leaf: stays pending past the deadline, then rejects. The abandoned
    // phaseRun's rejection must be swallowed by the pre-race `void phaseRun.catch`.
    const run: ConductorDeps["runAgent"] = () =>
      new Promise<RunAgentResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late boom")), 120).unref?.();
      });
    const spec: FleetSpec = {
      maxWallClockMs: 20, // deadline fires well before the 120ms rejection
      phases: [{ id: "pipe", kind: "pipeline", agents: [{ role: "hang", prompt: "x" }] }],
    };
    const res = await runFleet(spec, baseDeps({}, run));
    assert.equal(res.status, "aborted");
    assert.equal(res.phases[0].status, "aborted");
    // Give the orphaned rejection a tick to fire so a missing .catch would be caught here.
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(escaped, undefined, "no unhandled rejection escaped — the .catch guard held");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
