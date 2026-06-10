import type { CapabilityNode } from "./capability.js";
import type { Goal } from "./types.js";

export type AttentionItemKind =
  | "foreground"
  | "active_goal"
  | "capability_gap"
  | "maintenance"
  | "blocked_goal"
  | "idle";

export interface AttentionItem {
  id: string;
  kind: AttentionItemKind;
  title: string;
  priority?: number;
  reason?: string;
  blocked?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RankedAttentionItem extends AttentionItem {
  score: number;
}

export interface AttentionDecision {
  selected: RankedAttentionItem | null;
  queue: RankedAttentionItem[];
  parked: RankedAttentionItem[];
  summary: string;
}

export interface AttentionOptions {
  now?: Date;
  includeBlocked?: boolean;
  ageBonusPerHour?: number;
  maxAgeBonus?: number;
}

const KIND_WEIGHT: Record<AttentionItemKind, number> = {
  foreground: 10_000,
  active_goal: 200,
  capability_gap: 150,
  maintenance: 80,
  blocked_goal: -100,
  idle: 0,
};

/**
 * Pick what Ares should pay attention to right now.
 *
 * This is intentionally deterministic and model-free. The model can propose
 * work, but the Operator owns scheduling so foreground user intent cannot be
 * accidentally buried under background self-maintenance.
 */
export function decideAttention(items: readonly AttentionItem[], opts: AttentionOptions = {}): AttentionDecision {
  const now = opts.now ?? new Date();
  const includeBlocked = opts.includeBlocked ?? false;
  const ranked = items.map((item) => rankAttentionItem(item, { ...opts, now }));
  const parked = ranked
    .filter((item) => isParked(item) && !includeBlocked)
    .sort(attentionSort);
  const queue = ranked
    .filter((item) => includeBlocked || !isParked(item))
    .sort(attentionSort);
  const selected = queue[0] ?? null;
  return {
    selected,
    queue,
    parked,
    summary: summarizeAttention(selected, queue.length, parked.length),
  };
}

export function rankAttentionItem(item: AttentionItem, opts: AttentionOptions = {}): RankedAttentionItem {
  const now = opts.now ?? new Date();
  const priority = clamp(item.priority ?? defaultPriority(item.kind), 0, 100);
  const ageBonus = attentionAgeBonus(item, now, opts);
  const blockedPenalty = isParked(item) ? 1_000 : 0;
  return {
    ...item,
    score: KIND_WEIGHT[item.kind] + priority + ageBonus - blockedPenalty,
  };
}

export function attentionItemsFromGoals(goals: readonly Goal[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const goal of goals) {
    if (goal.status === "active") {
      items.push({
        id: `goal:${goal.id}`,
        kind: "active_goal",
        title: goal.statement,
        priority: 70,
        reason: `${goal.progress} moved / ${goal.stepLog.length} step(s)`,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      });
      continue;
    }
    if (goal.status === "blocked") {
      items.push({
        id: `goal:${goal.id}`,
        kind: "blocked_goal",
        title: goal.statement,
        priority: 30,
        reason: goal.verdict ?? "blocked",
        blocked: true,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      });
    }
  }
  return items;
}

export function attentionItemsFromCapabilities(caps: readonly CapabilityNode[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const cap of caps) {
    if (cap.status === "want" || cap.status === "learning") {
      items.push({
        id: `capability:${cap.id}`,
        kind: "capability_gap",
        title: cap.name,
        priority: cap.status === "want" ? 55 : 45,
        reason: `${cap.status}; ${cap.outcomes.ok} verified success(es), ${cap.outcomes.fail} failure(s)`,
        createdAt: cap.createdAt,
        updatedAt: cap.updatedAt,
      });
      continue;
    }
    if (cap.status === "rotted") {
      items.push({
        id: `capability:${cap.id}`,
        kind: "maintenance",
        title: `Repair capability: ${cap.name}`,
        priority: 90,
        reason: cap.outcomes.lastError ?? "health check failed",
        createdAt: cap.createdAt,
        updatedAt: cap.updatedAt,
      });
      continue;
    }
    if (cap.status === "forbidden") {
      items.push({
        id: `capability:${cap.id}`,
        kind: "blocked_goal",
        title: cap.name,
        priority: 10,
        reason: cap.outcomes.lastError ?? "forbidden",
        blocked: true,
        createdAt: cap.createdAt,
        updatedAt: cap.updatedAt,
      });
    }
  }
  return items;
}

function attentionSort(a: RankedAttentionItem, b: RankedAttentionItem): number {
  if (a.score !== b.score) return b.score - a.score;
  return (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
}

function attentionAgeBonus(item: AttentionItem, now: Date, opts: AttentionOptions): number {
  const ageBonusPerHour = opts.ageBonusPerHour ?? 0.5;
  const maxAgeBonus = opts.maxAgeBonus ?? 24;
  const stamp = item.updatedAt ?? item.createdAt;
  if (!stamp) return 0;
  const then = Date.parse(stamp);
  if (!Number.isFinite(then)) return 0;
  const hours = Math.max(0, now.getTime() - then) / 3_600_000;
  return Math.min(maxAgeBonus, hours * ageBonusPerHour);
}

function defaultPriority(kind: AttentionItemKind): number {
  switch (kind) {
    case "foreground":
      return 100;
    case "active_goal":
      return 70;
    case "capability_gap":
      return 50;
    case "maintenance":
      return 40;
    case "blocked_goal":
      return 10;
    case "idle":
      return 0;
  }
}

function isParked(item: AttentionItem): boolean {
  return Boolean(item.blocked || item.kind === "blocked_goal");
}

function summarizeAttention(selected: RankedAttentionItem | null, queued: number, parked: number): string {
  if (!selected) return parked ? `No runnable work; ${parked} blocked item(s) parked.` : "No runnable work.";
  const parkedText = parked ? `; ${parked} blocked item(s) parked` : "";
  return `Selected ${selected.kind}: ${selected.title} (${Math.round(selected.score)} score, ${queued} runnable${parkedText}).`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
