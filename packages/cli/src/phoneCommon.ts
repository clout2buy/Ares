// Small shared pieces of the phone API handlers that keep their own state on
// disk: the owner's time zone arithmetic, atomic JSON files, bounded body
// reads and JSON replies. Pure where it can be, so the schedulers built on it
// are tested with a fake clock.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

// ─── Time zones ───────────────────────────────────────────────────────────

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The owner's zone: an explicit override, then ARES_OWNER_TIMEZONE, then this machine's. */
export function resolveTimeZone(override?: string): string {
  if (isValidTimeZone(override)) return override;
  const env = process.env.ARES_OWNER_TIMEZONE?.trim();
  if (isValidTimeZone(env)) return env;
  try {
    const machine = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(machine)) return machine;
  } catch {
    // fall through
  }
  return "UTC";
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at the instant `ms`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: WEEKDAYS[out.weekday ?? "Sun"] ?? 0,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-09-30" in the owner's zone. */
export function localDayKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function minutesOfDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** The instant a wall clock reads `y-m-d h:mi` in `timeZone` (a time skipped by daylight saving lands just after the gap). */
export function zonedTimeToMs(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wall - seen;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** "07:30" → minutes after midnight, or undefined. */
export function parseClock(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export function formatClock(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.floor(minutes)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Is `minute` inside [from, to)? A window that wraps midnight (22:00-07:00) works. */
export function inClockWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

// ─── Files ────────────────────────────────────────────────────────────────

/** Read a JSON file; undefined when it is missing or torn. */
export async function readJsonFile<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const writeChains = new Map<string, Promise<unknown>>();

/** Atomic (temp + rename) and serialized per file, so two saves never interleave. */
export function writeJsonFile(file: string, value: unknown): Promise<void> {
  const prior = writeChains.get(file) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
    });
  writeChains.set(file, next);
  void next.finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); }).catch(() => undefined);
  return next;
}

export function newId(prefix: string, bytes = 5): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

/** A JSON object body of at most `limit` bytes; throws HttpError(400/413) otherwise. An empty body is {}. */
export async function readJsonObject(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "request body too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : undefined;
}

/** Every balanced {...} in `text`, in order of its opening brace. String-aware,
 *  so a brace inside a value never ends an object early. For parsing a model's
 *  reply that may have prose or a code fence around the JSON. */
export function* extractJsonObjects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

/** Parse the model's JSON reply: last fenced block first, then the whole text. */
export function parseModelJson<T>(raw: string, accept: (value: unknown) => T | null): T | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  for (const source of [...fenced.reverse(), raw]) {
    for (const candidate of extractJsonObjects(source)) {
      let value: unknown;
      try {
        value = JSON.parse(candidate);
      } catch {
        continue;
      }
      const ok = accept(value);
      if (ok) return ok;
    }
  }
  return null;
}
