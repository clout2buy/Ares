// Standing orders — durable, recurring missions Ares runs unattended.
//
// A standing order is a mission TEMPLATE with a cadence ("every 2h, summarize
// new important email"). On each background tick the daemon materializes the DUE
// ones into ordinary Goals; the existing control loop then executes them under
// the unattended safety gate and reports to Telegram. The order itself persists
// and fires again next cadence. This is what makes Ares move while you're gone:
// not idle suggestions, but real recurring work.
//
// One JSON file per order under ~/.ares/operator/standing-orders/. Atomic writes,
// tolerant reads — same resume-safe discipline as goals.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@ares/agent";
import { operatorPaths } from "./paths.js";
import { createGoal } from "./goal.js";
import { newGoalId, saveGoal } from "./store.js";
import type { Goal } from "./types.js";

export const STANDING_ORDER_SCHEMA = 1;
/** Don't let a runaway cadence hammer the model — 5 minutes is the floor. */
export const MIN_CADENCE_MS = 5 * 60_000;

export interface StandingOrder {
  schemaVersion: number;
  id: string;
  /** The recurring mission, e.g. "Summarize any new important email and report it". */
  statement: string;
  /** How often to materialize it into a goal. Clamped to >= MIN_CADENCE_MS. */
  cadenceMs: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function orderFile(home: string | undefined, id: string): string {
  return path.join(operatorPaths(home).standingDir, `${sanitizeId(id)}.json`);
}

export function newStandingOrderId(now = new Date()): string {
  return `so_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

export function normalizeStandingOrder(input: Partial<StandingOrder> & { statement: string }, now = new Date()): StandingOrder {
  return {
    schemaVersion: STANDING_ORDER_SCHEMA,
    id: input.id ?? newStandingOrderId(now),
    statement: input.statement.trim(),
    cadenceMs: Math.max(MIN_CADENCE_MS, Math.floor(input.cadenceMs ?? 60 * 60_000)),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? now.toISOString(),
    lastRunAt: input.lastRunAt,
    runCount: input.runCount ?? 0,
  };
}

export async function saveStandingOrder(home: string | undefined, order: StandingOrder): Promise<string> {
  const file = orderFile(home, order.id);
  await writeFileAtomic(file, JSON.stringify(order, null, 2) + "\n");
  return file;
}

export async function loadStandingOrders(home?: string): Promise<StandingOrder[]> {
  const dir = operatorPaths(home).standingDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const orders: StandingOrder[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      orders.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as StandingOrder);
    } catch {
      // skip a corrupt order file
    }
  }
  return orders.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function addStandingOrder(
  home: string | undefined,
  input: { statement: string; cadenceMs?: number },
  now = new Date(),
): Promise<StandingOrder> {
  const order = normalizeStandingOrder({ statement: input.statement, cadenceMs: input.cadenceMs }, now);
  if (!order.statement) throw new Error("a standing order needs a statement");
  await saveStandingOrder(home, order);
  return order;
}

export async function removeStandingOrder(home: string | undefined, id: string): Promise<boolean> {
  try {
    await fs.unlink(orderFile(home, id));
    return true;
  } catch {
    return false;
  }
}

export async function setStandingOrderEnabled(home: string | undefined, id: string, enabled: boolean): Promise<boolean> {
  const orders = await loadStandingOrders(home);
  const order = orders.find((o) => o.id === id);
  if (!order) return false;
  order.enabled = enabled;
  await saveStandingOrder(home, order);
  return true;
}

/** The orders due to fire: enabled, and either never run or past their cadence. */
export function dueStandingOrders(orders: readonly StandingOrder[], now: Date): StandingOrder[] {
  const t = now.getTime();
  return orders.filter((o) => {
    if (!o.enabled) return false;
    if (!o.lastRunAt) return true;
    return t - Date.parse(o.lastRunAt) >= o.cadenceMs;
  });
}

export interface MaterializeResult {
  goals: Goal[];
  fired: StandingOrder[];
}

/**
 * Turn every DUE standing order into a fresh active Goal (so the existing control
 * loop executes it this tick), stamping lastRunAt + runCount so it won't re-fire
 * until next cadence. Pure-ish: storage is injected only via `home`. Returns the
 * goals created so the caller can report them.
 */
export async function materializeDueStandingOrders(home: string | undefined, now = new Date()): Promise<MaterializeResult> {
  const resolvedHome = operatorPaths(home).home;
  const due = dueStandingOrders(await loadStandingOrders(home), now);
  const goals: Goal[] = [];
  const fired: StandingOrder[] = [];
  for (const order of due) {
    const goal = createGoal({
      id: newGoalId(now),
      statement: order.statement,
      now,
    });
    await saveGoal(resolvedHome, goal);
    order.lastRunAt = now.toISOString();
    order.runCount = (order.runCount ?? 0) + 1;
    await saveStandingOrder(home, order);
    goals.push(goal);
    fired.push(order);
  }
  return { goals, fired };
}

/** Human-readable list for Telegram/CLI. */
export function renderStandingOrders(orders: readonly StandingOrder[]): string {
  if (orders.length === 0) return "No standing orders. Add one and Ares hunts it on a schedule.";
  return orders
    .map((o) => {
      const mins = Math.round(o.cadenceMs / 60_000);
      const cadence = mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h` : `${mins}m`;
      const last = o.lastRunAt ? new Date(o.lastRunAt).toLocaleString() : "never";
      return `${o.enabled ? "🟢" : "⚪"} ${o.id} · every ${cadence} · runs ${o.runCount} · last ${last}\n   ${o.statement}`;
    })
    .join("\n");
}
