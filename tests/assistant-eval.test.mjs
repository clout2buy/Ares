// Assistant-quality evals wired into `pnpm test`.
//
// Both suites run the REAL memory store + REAL recall (no LLM), so a change to
// recall.ts, strength.ts, router.ts or consolidate() that quietly degrades
// what Ares remembers fails here — the first evals that measure the assistant
// rather than the coding harness. Numbers land in the isolated home's
// telemetry/eval-trend.jsonl under `assistant`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAssistantEval, ASSISTANT_THRESHOLDS } from "./eval/assistant/runner.mjs";
import { runRecallPrecision, buildRecallSeeds } from "./eval/assistant/recallPrecision.mjs";
import { MemoryStore } from "../packages/mind/dist/index.js";

test("assistant eval: seed corpus is 60 = 20 relevant + 10 near-duplicates + 30 distractors", () => {
  const seeds = buildRecallSeeds();
  assert.equal(seeds.length, 60);
  assert.equal(seeds.filter((s) => s.relevant && !s.nearDuplicate).length, 20);
  assert.equal(seeds.filter((s) => s.nearDuplicate).length, 10);
  assert.equal(seeds.filter((s) => !s.relevant).length, 30);
  assert.equal(new Set(seeds.map((s) => s.content)).size, 60, "no literal duplicates");
});

test("assistant eval: recall precision/recall clears the bar and is deterministic", { timeout: 60_000 }, async () => {
  const a = await runRecallPrecision({ store: MemoryStore.memory() });
  const b = await runRecallPrecision({ store: MemoryStore.memory() });
  assert.deepEqual(a.queries.map((q) => [q.p5, q.r10]), b.queries.map((q) => [q.p5, q.r10]), "same inputs, same numbers");
  assert.ok(a.p5 >= ASSISTANT_THRESHOLDS.p5, `P@5 ${a.p5} < ${ASSISTANT_THRESHOLDS.p5}\n${JSON.stringify(a.queries, null, 1)}`);
  assert.ok(a.r10 >= ASSISTANT_THRESHOLDS.r10, `R@10 ${a.r10} < ${ASSISTANT_THRESHOLDS.r10}\n${JSON.stringify(a.queries, null, 1)}`);
  for (const q of a.queries) assert.ok(q.returned >= 5, `${q.id}: returned ${q.returned}`);
});

test("assistant eval: both suites run against the isolated home and record to eval-trend.jsonl", { timeout: 120_000 }, async () => {
  const home = process.env.ARES_HOME;
  assert.ok(home, "tests/_isolate-home.mjs must have set ARES_HOME");
  const r = await runAssistantEval({ home });

  assert.ok(r.recall.p5 >= ASSISTANT_THRESHOLDS.p5, `P@5 ${r.recall.p5}`);
  assert.ok(r.recall.r10 >= ASSISTANT_THRESHOLDS.r10, `R@10 ${r.recall.r10}`);

  const p = r.persistence;
  assert.equal(p.turns, 50);
  assert.ok(p.gated > 0, "the conversation channel gated the low-salience chatter");
  assert.ok(p.rememberedTop3, `turn-1 fact ranked ${p.factRank} for the paraphrased cue after 50 turns + consolidation`);
  assert.ok(p.contradictionResolved, `correction ranked ${p.correctionRank} vs stale ${p.staleRank}: ${JSON.stringify(r.detail.persistence.topForCorrectionCue)}`);
  assert.match(r.detail.persistence.topForCorrectionCue[0], /11:00am/, "the cue about the changed detail resolves to Y");

  assert.equal(r.trendFile, path.join(home, "telemetry", "eval-trend.jsonl"));
  const lines = (await readFile(r.trendFile, "utf8")).trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.at, r.at);
  assert.equal(typeof last.assistant.recall.p5, "number");
  assert.equal(typeof last.assistant.recall.r10, "number");
  assert.equal(last.assistant.persistence.contradictionResolved, true);
  assert.equal(last.assistant.detail, undefined, "the trend line carries numbers, not the corpus");
});
