// World Graph — Ares's map of its own universe (Nexus / Phase 1 keystone).
//
// A lightweight, READ-ONLY entity graph that links the things Ares already
// knows about — itself, the project, its subsystems, missions, goals, lessons,
// and crystallized memories — into one navigable map. This is the connective
// tissue that turns "a pile of stores" into "an entity that understands its
// world": a voice-input mission, the voice subsystem, and a voice-related
// memory all link together instead of sitting on separate islands.
//
// NOTE: distinct from {@link ./worldModel.ts} WorldModel — that re-derives
// reality from verification probes for the control loop. This is the entity map.
//
// The core (assembleWorldGraph) is PURE: no I/O, no mutation, no new storage.
// The CLI does the loading and hands durable truth to this shaper, exactly like
// continuity.ts. Nothing here writes anything.

import { tokenizeSalient } from "@ares/mind";
import type { LearningCard } from "./learningCard.js";
import type { MissionContract } from "./missionContract.js";
import type { Goal } from "./types.js";

export type WorldEntityKind = "ares" | "project" | "subsystem" | "mission" | "goal" | "lesson" | "memory";

export type WorldRelationKind =
  | "embodies" // ares → project
  | "part-of" // subsystem → project
  | "serves" // mission → goal
  | "distilled-from" // lesson → mission
  | "relates-to" // mission/lesson/memory → subsystem (keyword overlap)
  | "about"; // memory → mission (domain overlap)

export interface WorldEntity {
  /** Stable id: `${kind}:${ref}`. */
  id: string;
  kind: WorldEntityKind;
  label: string;
  summary?: string;
  /** Mission status, etc. */
  status?: string;
  /** Where it came from: "operator:mission" | "mind:semantic" | "repo:subsystem" | … */
  source: string;
  /** Native id within its store. */
  ref: string;
  tags?: string[];
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface WorldRelation {
  from: string;
  to: string;
  kind: WorldRelationKind;
  /** 0..1 association strength. */
  weight: number;
  reason?: string;
}

export interface WorldGraph {
  entities: WorldEntity[];
  relations: WorldRelation[];
  /** Entity tally by kind. */
  counts: Record<WorldEntityKind, number>;
}

/** A Ares subsystem the graph can link missions/memories to (curated self-knowledge). */
export interface WorldSubsystemInput {
  name: string;
  label: string;
  summary?: string;
  /** Salient keywords used to relate missions/lessons/memories to this subsystem. */
  keywords: string[];
}

/** Minimal memory shape the graph needs — decoupled from @ares/mind's MemoryNode. */
export interface WorldMemoryInput {
  id: string;
  kind: string;
  content: string;
  tags?: string[];
  source?: string;
}

export interface AssembleWorldGraphInput {
  projectName?: string;
  contracts: MissionContract[];
  goals: Goal[];
  lessons: LearningCard[];
  /** Crystallized memories (synthesis insight/belief nodes) — NOT every episode. */
  memory: WorldMemoryInput[];
  subsystems: WorldSubsystemInput[];
}

/**
 * Ares's own subsystems — honest self-knowledge of its architecture. Keywords
 * are what mission/memory text is matched against to wire the connective edges.
 */
export const ARES_SUBSYSTEMS: WorldSubsystemInput[] = [
  { name: "protocol", label: "@ares/protocol", summary: "Shared event/provider/tool shapes", keywords: ["protocol", "event", "schema", "tool"] },
  { name: "core", label: "@ares/core", summary: "Sessions, query engine, providers, reasoning", keywords: ["core", "queryengine", "provider", "session", "reasoning", "checkpoint", "verifier", "model"] },
  { name: "tools", label: "@ares/tools", summary: "Local tool catalog + executors", keywords: ["tools", "read", "write", "edit", "bash", "grep", "glob", "narration"] },
  { name: "agent", label: "@ares/agent", summary: "Identity, dreaming, skills, self-model", keywords: ["agent", "identity", "charter", "dreaming", "skill", "heartbeat", "bootstrap", "self", "soul"] },
  { name: "mind", label: "@ares/mind", summary: "Living memory, synthesis, cognition", keywords: ["mind", "memory", "recall", "synthesis", "cognition", "intent", "belief", "insight", "dream"] },
  { name: "operator", label: "@ares/operator", summary: "Missions, goals, lessons, continuity", keywords: ["operator", "mission", "goal", "lesson", "continuity", "capability", "attention", "recap", "briefing"] },
  { name: "effects", label: "@ares/effects", summary: "Budgets, ledger, kill-switch, rails", keywords: ["effects", "budget", "ledger", "rails", "approval", "killswitch", "proof"] },
  { name: "connectors", label: "@ares/connectors", summary: "Browser connector + proof", keywords: ["connectors", "browser", "filmstrip", "web"] },
  { name: "cli", label: "@ares/cli", summary: "Command-line + terminal UI", keywords: ["cli", "command", "terminal", "daemon", "chat"] },
  { name: "tauri", label: "Tauri desktop shell", summary: "Desktop UI, themes, mind panel, composer", keywords: ["tauri", "desktop", "theme", "panel", "mindpanel", "composer", "window", "animation"] },
  { name: "voice", label: "Voice (TTS + STT)", summary: "Kokoro TTS + Whisper STT sidecar", keywords: ["voice", "tts", "stt", "kokoro", "whisper", "speech", "audio", "mic", "talk"] },
];

function tokenSet(text: string): Set<string> {
  return new Set(tokenizeSalient(text));
}

function shared(tokens: Set<string>, keywords: Iterable<string>): string[] {
  const out: string[] = [];
  for (const k of keywords) if (tokens.has(k)) out.push(k);
  return out;
}

function relateWeight(count: number): number {
  return Math.min(1, count * 0.34);
}

/**
 * Build the entity graph from durable truth. PURE: never reads disk, never
 * mutates inputs, deterministic for the same input.
 */
export function assembleWorldGraph(input: AssembleWorldGraphInput): WorldGraph {
  const entities: WorldEntity[] = [];
  const relations: WorldRelation[] = [];
  const has = new Set<string>();
  const add = (entity: WorldEntity): void => {
    if (has.has(entity.id)) return;
    has.add(entity.id);
    entities.push(entity);
  };
  const relate = (from: string, to: string, kind: WorldRelationKind, weight: number, reason?: string): void => {
    if (!has.has(from) || !has.has(to) || from === to) return;
    relations.push({ from, to, kind, weight, reason });
  };

  // Root: Ares and the project it is embodied in.
  const projectName = input.projectName?.trim() || "Ares";
  add({ id: "ares:self", kind: "ares", label: "Ares", summary: "The entity", source: "self", ref: "self" });
  const projectId = `project:${projectName.toLowerCase()}`;
  add({ id: projectId, kind: "project", label: projectName, summary: "The codebase Ares is built from", source: "repo:project", ref: projectName });
  relate("ares:self", projectId, "embodies", 1, "Ares is this project");

  // Subsystems (curated self-knowledge), each part-of the project.
  for (const sub of input.subsystems) {
    const id = `subsystem:${sub.name}`;
    add({ id, kind: "subsystem", label: sub.label, summary: sub.summary, source: "repo:subsystem", ref: sub.name, tags: sub.keywords });
    relate(id, projectId, "part-of", 1, "subsystem of the project");
  }

  // Goals.
  for (const goal of input.goals) {
    add({ id: `goal:${goal.id}`, kind: "goal", label: goal.statement, source: "operator:goal", ref: goal.id, status: goal.status });
  }

  // Missions → serve goals.
  for (const c of input.contracts) {
    const id = `mission:${c.id}`;
    add({
      id,
      kind: "mission",
      label: c.intent,
      status: c.progress.status,
      source: "operator:mission",
      ref: c.id,
      updatedAt: c.updatedAt,
      meta: { percent: c.progress.percent, completedCriteria: c.progress.completedCriteria, totalCriteria: c.progress.totalCriteria },
    });
    if (c.goalId) relate(id, `goal:${c.goalId}`, "serves", 1, "mission serves goal");
  }

  // Lessons → distilled from their mission (card id is `lc_<contractId>`).
  for (const card of input.lessons) {
    const id = `lesson:${card.id}`;
    add({ id, kind: "lesson", label: card.intent, summary: card.result, source: "operator:lesson", ref: card.id, tags: card.tags, meta: { confidence: card.confidence, result: card.result } });
    const missionRef = card.id.startsWith("lc_") ? card.id.slice(3) : "";
    if (missionRef) relate(id, `mission:${missionRef}`, "distilled-from", 1, "lesson distilled from mission");
  }

  // Crystallized memories (synthesis insight/belief nodes only).
  for (const node of input.memory) {
    add({ id: `memory:${node.id}`, kind: "memory", label: clip(node.content, 80), summary: node.content, source: `mind:${node.kind}`, ref: node.id, tags: node.tags });
  }

  // Connective tissue: relate missions/lessons/memories to subsystems by keyword
  // overlap, and memories to missions by domain overlap. This is what makes the
  // graph feel like a map instead of a list.
  for (const sub of input.subsystems) {
    const keywords = sub.keywords;
    const subId = `subsystem:${sub.name}`;
    for (const c of input.contracts) {
      const hits = shared(tokenSet(c.intent), keywords);
      if (hits.length) relate(`mission:${c.id}`, subId, "relates-to", relateWeight(hits.length), `shares ${hits.join(", ")}`);
    }
    for (const card of input.lessons) {
      const hits = shared(tokenSet(card.intent), keywords);
      if (hits.length) relate(`lesson:${card.id}`, subId, "relates-to", relateWeight(hits.length), `shares ${hits.join(", ")}`);
    }
    for (const node of input.memory) {
      const hits = shared(new Set([...tokenizeSalient(node.content), ...(node.tags ?? [])]), keywords);
      if (hits.length) relate(`memory:${node.id}`, subId, "relates-to", relateWeight(hits.length), `shares ${hits.join(", ")}`);
    }
  }

  // Memory → mission "about" edges by domain-token overlap.
  for (const node of input.memory) {
    const memTokens = tokenSet(node.content);
    for (const c of input.contracts) {
      const hits = shared(memTokens, tokenizeSalient(c.intent));
      if (hits.length) relate(`memory:${node.id}`, `mission:${c.id}`, "about", relateWeight(hits.length), `about ${hits.join(", ")}`);
    }
  }

  const counts = { ares: 0, project: 0, subsystem: 0, mission: 0, goal: 0, lesson: 0, memory: 0 } as Record<WorldEntityKind, number>;
  for (const e of entities) counts[e.kind] += 1;

  return { entities, relations, counts };
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
