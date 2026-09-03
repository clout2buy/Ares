// Assistant-quality evals — the runner.
//
// Two mock-driven, deterministic suites that exercise the REAL memory store
// and the REAL recall path (no LLM, no embedder, no network):
//   recall       — precision/recall of spreading-activation recall over a
//                  seeded 60-memory store (recallPrecision.mjs)
//   persistence  — a fact survives 50 turns and a contradiction resolves to
//                  the newer value (longHorizon.mjs)
//
// Each suite gets its own fresh file-backed store under `home` (the isolated
// test home from tests/_isolate-home.mjs — never the owner's ~/.ares), and the
// numbers are appended to <home>/telemetry/eval-trend.jsonl under `assistant`
// so HELM's trend chart can plot assistant quality next to coding quality.
//
//   node tests/eval/assistant/runner.mjs            # prints both suites
//   node tests/eval/assistant/runner.mjs --json

import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MemoryStore } from "../../../packages/mind/dist/index.js";
import { telemetryDir } from "../../../packages/core/dist/index.js";
import { runRecallPrecision } from "./recallPrecision.mjs";
import { runLongHorizon } from "./longHorizon.mjs";

export const ASSISTANT_EVAL_SCHEMA = 1;

/** The bar. Same numbers the test asserts — kept here so the CLI print and the test agree. */
export const ASSISTANT_THRESHOLDS = { p5: 0.6, r10: 0.7 };

async function freshStore(home, label) {
  const dir = await mkdtemp(path.join(home, `assistant-eval-${label}-`));
  const memoryFile = path.join(dir, "memory.jsonl");
  return { store: await MemoryStore.open(memoryFile), memoryFile };
}

export async function runAssistantEval({ home = process.env.ARES_HOME, record = true, now = new Date() } = {}) {
  if (!home) throw new Error("runAssistantEval needs a home (ARES_HOME) — never run against the owner's real ~/.ares");
  await mkdir(home, { recursive: true });

  const recallStore = await freshStore(home, "recall");
  const recall = await runRecallPrecision({ store: recallStore.store });

  const horizon = await freshStore(home, "horizon");
  const persistence = await runLongHorizon({ store: horizon.store, memoryFile: horizon.memoryFile });

  const result = {
    schemaVersion: ASSISTANT_EVAL_SCHEMA,
    at: now.toISOString(),
    recall: { p5: recall.p5, r10: recall.r10, seeds: recall.seeds, queries: recall.queries.map((q) => ({ id: q.id, p5: q.p5, r10: q.r10 })), pass: recall.p5 >= ASSISTANT_THRESHOLDS.p5 && recall.r10 >= ASSISTANT_THRESHOLDS.r10 },
    persistence: {
      turns: persistence.turns,
      accepted: persistence.accepted,
      gated: persistence.gated,
      storeSize: persistence.storeSize,
      factRank: persistence.factRank,
      rememberedTop3: persistence.rememberedTop3,
      correctionRank: persistence.correctionRank,
      staleRank: persistence.staleRank,
      contradictionResolved: persistence.contradictionResolved,
      pass: persistence.rememberedTop3 && persistence.contradictionResolved,
    },
    detail: { recall, persistence },
  };

  if (record) {
    const file = path.join(telemetryDir(home), "eval-trend.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    const { detail: _detail, ...trend } = result;
    await appendFile(file, JSON.stringify({ at: result.at, assistant: { recall: trend.recall, persistence: trend.persistence } }) + "\n", "utf8");
    result.trendFile = file;
  }
  return result;
}

export function formatAssistantEval(r) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = ["", `Ares assistant-quality eval — ${r.at}`, "=".repeat(60)];
  lines.push(`recall       P@5 ${pct(r.recall.p5)} (bar ${pct(ASSISTANT_THRESHOLDS.p5)}) · R@10 ${pct(r.recall.r10)} (bar ${pct(ASSISTANT_THRESHOLDS.r10)}) · ${r.recall.pass ? "PASS" : "FAIL"}`);
  for (const q of r.recall.queries) lines.push(`  ${q.id.padEnd(18)} P@5 ${pct(q.p5).padStart(4)}  R@10 ${pct(q.r10).padStart(4)}`);
  lines.push(`persistence  fact rank ${r.persistence.factRank || "—"} after ${r.persistence.turns} turns · correction rank ${r.persistence.correctionRank || "—"} vs stale ${r.persistence.staleRank || "—"} · ${r.persistence.pass ? "PASS" : "FAIL"}`);
  lines.push(`  ${r.persistence.accepted} writes accepted, ${r.persistence.gated} gated by the spine, ${r.persistence.storeSize} nodes after consolidation`);
  if (r.trendFile) lines.push(`trend → ${r.trendFile}`);
  lines.push("=".repeat(60));
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  runAssistantEval()
    .then((r) => {
      console.log(json ? JSON.stringify(r, null, 2) : formatAssistantEval(r));
      process.exit(r.recall.pass && r.persistence.pass ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
