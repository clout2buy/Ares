// Tracking — the commitments Ares made that are still open.
//
// A reminder fires once and is gone; a memory is a fact, not a promise. What
// neither holds is "I booked you a table for Friday", "the charger arrives
// Thursday", "I said I'd check the refund on Monday" — things that stay OPEN
// until someone resolves them. Without a ledger the only record was a line in
// some old transcript, so a promised follow-up happened only if the owner
// remembered to ask. This file is that ledger: one JSON document under the
// Ares home, written atomically, read by the Track tool, the phone's Today tab
// (/gateway/tracking) and the heartbeat (overdue items surface there so Ares
// follows up on its own).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TRACKING_KINDS = ["reservation", "delivery", "order", "reminder", "promise", "other"] as const;
export type TrackingKind = (typeof TRACKING_KINDS)[number];
export type TrackingStatus = "open" | "done" | "cancelled";

export interface TrackingItem {
  id: string;
  title: string;
  kind: TrackingKind;
  status: TrackingStatus;
  detail?: string;
  /** ISO timestamp the commitment is due (a reservation's time, a delivery ETA). */
  dueAt?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

/** Closed items older than this drop off the phone's list (they stay on disk
 *  until the file is pruned — see MAX_CLOSED_KEPT). */
export const TRACKING_CLOSED_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Hard cap on closed items kept on disk, newest first. Open items are never
 *  pruned — dropping an unresolved commitment is the bug this file exists for. */
const MAX_CLOSED_KEPT = 200;
const MAX_TITLE = 200;
const MAX_DETAIL = 2_000;
const MAX_URL = 2_000;

export function trackingPath(home?: string): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "tracking.json");
}

/** Accepts an ISO-ish date string; returns normalized ISO or undefined. An
 *  unparseable date is dropped rather than stored, so "overdue" math never
 *  runs against garbage. */
export function normalizeDueAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isItem(value: unknown): value is TrackingItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.title === "string" && typeof v.status === "string";
}

/** Serialize writers inside this process: the Track tool and the phone's
 *  close button can land in the same tick, and read-modify-write on one JSON
 *  file loses one of them without a queue. */
const writeChains = new Map<string, Promise<unknown>>();

export class TrackingStore {
  readonly file: string;

  constructor(home?: string) {
    this.file = trackingPath(home);
  }

  async load(): Promise<TrackingItem[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { items?: unknown };
      return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : [];
    } catch {
      return [];
    }
  }

  private async save(items: TrackingItem[]): Promise<void> {
    const open = items.filter((i) => i.status === "open");
    const closed = items
      .filter((i) => i.status !== "open")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_CLOSED_KEPT);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, items: [...open, ...closed] }, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.file);
  }

  private mutate<T>(fn: (items: TrackingItem[]) => T | Promise<T>): Promise<T> {
    const prior = writeChains.get(this.file) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const items = await this.load();
      const result = await fn(items);
      await this.save(items);
      return result;
    });
    writeChains.set(this.file, next);
    return next;
  }

  async add(input: { title: string; kind?: string; detail?: string; dueAt?: string; url?: string }, now = new Date()): Promise<TrackingItem> {
    const title = clip(input.title, MAX_TITLE);
    if (!title) throw new Error("a tracking item needs a title");
    const kind = (TRACKING_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as TrackingKind) : "other";
    const at = now.toISOString();
    const item: TrackingItem = {
      id: `trk_${randomUUID().slice(0, 12)}`,
      title,
      kind,
      status: "open",
      ...(clip(input.detail, MAX_DETAIL) ? { detail: clip(input.detail, MAX_DETAIL) } : {}),
      ...(normalizeDueAt(input.dueAt) ? { dueAt: normalizeDueAt(input.dueAt) } : {}),
      ...(clip(input.url, MAX_URL) ? { url: clip(input.url, MAX_URL) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    return this.mutate((items) => {
      items.push(item);
      return item;
    });
  }

  /** null when no item has that id. */
  async update(
    id: string,
    patch: { status?: string; detail?: string; dueAt?: string; title?: string; url?: string },
    now = new Date(),
  ): Promise<TrackingItem | null> {
    return this.mutate((items) => {
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      if (patch.status === "open" || patch.status === "done" || patch.status === "cancelled") item.status = patch.status;
      const title = clip(patch.title, MAX_TITLE);
      if (title) item.title = title;
      if (patch.detail !== undefined) {
        const detail = clip(patch.detail, MAX_DETAIL);
        if (detail) item.detail = detail;
        else delete item.detail;
      }
      if (patch.dueAt !== undefined) {
        const due = normalizeDueAt(patch.dueAt);
        if (due) item.dueAt = due;
        else delete item.dueAt;
      }
      const url = clip(patch.url, MAX_URL);
      if (url) item.url = url;
      item.updatedAt = now.toISOString();
      return { ...item };
    });
  }

  async close(id: string, status: "done" | "cancelled", now = new Date()): Promise<TrackingItem | null> {
    return this.update(id, { status }, now);
  }

  async list(status?: TrackingStatus): Promise<TrackingItem[]> {
    const items = await this.load();
    return status ? items.filter((i) => i.status === status) : items;
  }

  /**
   * What the phone shows: every open item (soonest due first, undated last),
   * then items closed within the last 30 days, most recently closed first.
   */
  async forPhone(now = new Date()): Promise<TrackingItem[]> {
    const items = await this.load();
    const open = items
      .filter((i) => i.status === "open")
      .sort((a, b) => (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿") || b.createdAt.localeCompare(a.createdAt));
    const cutoff = now.getTime() - TRACKING_CLOSED_WINDOW_MS;
    const closed = items
      .filter((i) => i.status !== "open" && Date.parse(i.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...open, ...closed];
  }

  /** Open items whose due time has passed. */
  async overdue(now = new Date()): Promise<TrackingItem[]> {
    const items = await this.list("open");
    return items.filter((i) => i.dueAt && Date.parse(i.dueAt) <= now.getTime());
  }
}

/**
 * The short block the heartbeat (and Telegram check-ins) carry so Ares follows
 * up on what it promised. Empty string when nothing is overdue — a heartbeat
 * with nothing to say must stay silent.
 */
export async function overdueTrackingBlock(home?: string, now = new Date(), max = 5): Promise<string> {
  const overdue = await new TrackingStore(home).overdue(now).catch(() => [] as TrackingItem[]);
  if (overdue.length === 0) return "";
  const lines = overdue.slice(0, max).map((i) => `- [${i.kind}] ${i.title} (due ${i.dueAt}, id ${i.id})${i.detail ? ` — ${i.detail.slice(0, 120)}` : ""}`);
  const more = overdue.length > max ? `\n- …and ${overdue.length - max} more` : "";
  return `Overdue tracked commitments — follow up, then Track close/update each:\n${lines.join("\n")}${more}`;
}
