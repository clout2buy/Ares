// Mission Learning Cards (Crix v6 / Phase B v1 — option 1: pure distiller).
//
// Ghost Continue tells you WHERE you left off. A Learning Card tells you WHAT
// Crix learned: when a mission reaches a terminal state, its contract already
// holds the raw material (met/failed criteria, verification results, blockers,
// decision evidence). `distillMissionCard` turns that into a durable lesson —
// what worked, what failed, the reusable procedure, and a confidence — WITHOUT
// an LLM and WITHOUT touching the execution path. Distillation is on-demand
// (`crix mission learn <id>`); auto-emit on completion is a deliberate later step.
//
// The card id is derived from the contract id, so re-distilling the same mission
// overwrites rather than duplicates (idempotent).

import path from "node:path";
import { promises as fs } from "node:fs";
import { writeFileAtomic } from "@crix/agent";
import { operatorPaths } from "./paths.js";
import type { MissionContract } from "./missionContract.js";
import type { Goal } from "./types.js";

export const LEARNING_CARD_SCHEMA_VERSION = 1;

export type MissionResult = "success" | "failed" | "abandoned" | "blocked";

export interface LearningCard {
  schemaVersion: number;
  id: string;
  missionContractId: string;
  goalId?: string;
  goalStatement?: string;
  intent: string;
  result: MissionResult;
  /** Receipts, newest first: "kind: summary". */
  evidence: string[];
  whatWorked: string[];
  whatFailed: string[];
  /** Ordered decisions that formed the approach — the reusable procedure. */
  reusableProcedure: string[];
  confidence: number;
  tags: string[];
  createdAt: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "build", "make", "add", "fix", "use", "using", "crix", "mission", "goal",
  "should", "would", "could", "have", "has", "are", "was", "will", "can",
]);

/** Distill a mission contract into a durable lesson. Pure: no I/O, no mutation. */
export function distillMissionCard(contract: MissionContract, opts?: { goal?: Goal; now?: Date }): LearningCard {
  const now = opts?.now ?? new Date();
  const result = deriveResult(contract);

  const metCriteria = contract.acceptanceCriteria.filter((c) => c.status === "met").map((c) => c.description);
  const failedCriteria = contract.acceptanceCriteria.filter((c) => c.status === "failed").map((c) => c.description);
  const passedProbes = contract.verificationProbeResults
    .filter((p) => p.status === "passed")
    .map((p) => p.summary ?? probeLabel(p.spec));
  const failedProbes = contract.verificationProbeResults
    .filter((p) => p.status === "failed")
    .map((p) => p.summary ?? probeLabel(p.spec));
  const openBlockers = contract.blockers.filter((b) => !b.resolvedAt).map((b) => b.reason);

  const whatWorked = dedupe([...metCriteria, ...passedProbes]);
  const whatFailed = dedupe([...failedCriteria, ...failedProbes, ...openBlockers]);

  const reusableProcedure = [...contract.evidenceLog]
    .filter((e) => e.kind === "decision")
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => e.summary);

  const evidence = [...contract.evidenceLog]
    .slice(-8)
    .reverse()
    .map((e) => `${e.kind}: ${e.summary}`);

  return {
    schemaVersion: LEARNING_CARD_SCHEMA_VERSION,
    id: learningCardId(contract.id),
    missionContractId: contract.id,
    goalId: contract.goalId,
    goalStatement: opts?.goal?.statement,
    intent: contract.intent,
    result,
    evidence,
    whatWorked,
    whatFailed,
    reusableProcedure,
    confidence: deriveConfidence(contract, result),
    tags: deriveTags(contract.intent, opts?.goal?.statement),
    createdAt: now.toISOString(),
  };
}

/** Deterministic card id from the contract id — re-distilling overwrites. */
export function learningCardId(contractId: string): string {
  return `lc_${contractId}`;
}

/** A compact one-paragraph summary for feeding the card into living memory. */
export function learningCardMemoryText(card: LearningCard): string {
  const parts = [`Lesson [${card.result}] — ${card.intent}.`];
  if (card.whatWorked.length) parts.push(`Worked: ${card.whatWorked.slice(0, 3).join("; ")}.`);
  if (card.whatFailed.length) parts.push(`Failed: ${card.whatFailed.slice(0, 3).join("; ")}.`);
  if (card.reusableProcedure.length) parts.push(`Procedure: ${card.reusableProcedure.slice(0, 4).join(" → ")}.`);
  parts.push(`Confidence ${Math.round(card.confidence * 100)}%.`);
  return parts.join(" ");
}

/**
 * Select lessons relevant to a set of open mission intents — by tag overlap,
 * falling back to the most recent cards. Pure + deterministic.
 */
export function selectRelevantLessons(cards: LearningCard[], openIntents: string[], max = 3): LearningCard[] {
  if (cards.length === 0) return [];
  const wanted = new Set(openIntents.flatMap((s) => keywords(s)));
  const byRecency = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (wanted.size === 0) return byRecency.slice(0, max);

  const scored = byRecency
    .map((card) => ({ card, score: card.tags.reduce((n, t) => (wanted.has(t) ? n + 1 : n), 0) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.card.createdAt.localeCompare(a.card.createdAt))
    .map((s) => s.card);

  return (scored.length ? scored : byRecency).slice(0, max);
}

// ── persistence ──────────────────────────────────────────────────────────────

function cardFile(home: string, id: string): string {
  return path.join(operatorPaths(home).lessonsDir, `${sanitizeId(id)}.json`);
}

export async function saveLearningCard(home: string, card: LearningCard): Promise<string> {
  const file = cardFile(home, card.id);
  await writeFileAtomic(file, JSON.stringify(card, null, 2) + "\n");
  return file;
}

export async function loadLearningCard(home: string, id: string): Promise<LearningCard | null> {
  try {
    return JSON.parse(await fs.readFile(cardFile(home, id), "utf8")) as LearningCard;
  } catch {
    return null;
  }
}

export async function learningCardExists(home: string, id: string): Promise<boolean> {
  return (await loadLearningCard(home, id)) !== null;
}

export async function listLearningCards(home: string): Promise<LearningCard[]> {
  const dir = operatorPaths(home).lessonsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const cards: LearningCard[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      cards.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as LearningCard);
    } catch {
      // skip corrupt card
    }
  }
  cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return cards;
}

// ── internals ──────────────────────────────────────────────────────────────

function deriveResult(c: MissionContract): MissionResult {
  if (c.progress.status === "satisfied") return "success";
  if (c.progress.status === "abandoned") return "abandoned";
  const anyFailed =
    c.acceptanceCriteria.some((ac) => ac.status === "failed") ||
    c.verificationProbeResults.some((p) => p.status === "failed");
  if (anyFailed) return "failed";
  return "blocked";
}

function deriveConfidence(c: MissionContract, result: MissionResult): number {
  const total = c.progress.totalCriteria;
  const metRatio = total > 0 ? c.progress.completedCriteria / total : result === "success" ? 1 : 0;
  const probes = c.verificationProbeResults;
  const passRate = probes.length > 0 ? probes.filter((p) => p.status === "passed").length / probes.length : 1;
  let base = metRatio * passRate;
  if (result === "abandoned") base = Math.min(base, 0.3);
  else if (result === "failed") base = Math.min(base, 0.4);
  else if (result === "blocked") base = Math.min(base, 0.5);
  return Math.round(Math.max(0, Math.min(1, base)) * 100) / 100;
}

function deriveTags(intent: string, goalStatement?: string): string[] {
  const seen = new Set<string>();
  for (const token of [...keywords(intent), ...keywords(goalStatement ?? "")]) {
    if (seen.size >= 6) break;
    seen.add(token);
  }
  return [...seen];
}

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function probeLabel(spec: { kind: string }): string {
  return `${spec.kind} probe`;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
