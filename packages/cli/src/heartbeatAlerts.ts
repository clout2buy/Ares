import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** A tuning knob read once at boot: an unparseable value falls back rather than
 *  disabling the ceiling. */
function envInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** How many unprompted alerts the heartbeat may send the owner in one local day.
 *  ARES_HEARTBEAT_ALERT_CAP (0 = the heartbeat never speaks first). */
export const HEARTBEAT_ALERT_DAILY_CAP = envInt(process.env.ARES_HEARTBEAT_ALERT_CAP, 2);
/** A finding already delivered inside this window is not said again.
 *  ARES_HEARTBEAT_ALERT_REPEAT_H, hours (default 12 — twice a day at the cap). */
export const HEARTBEAT_ALERT_REPEAT_MS = envInt(process.env.ARES_HEARTBEAT_ALERT_REPEAT_H, 12) * 60 * 60 * 1000;

export interface HeartbeatAlertState {
  /** Local YYYY-MM-DD that `sent` counts against. */
  day: string;
  sent: number;
  /** finding id -> ISO timestamp of its last delivery. */
  seen: Record<string, string>;
}

/** Whitespace-insensitive so a finding that only shifted still counts as the same one. */
export function heartbeatAlertId(finding: string): string {
  return createHash("sha1").update(finding.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

export function localDayKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Which findings earn a word from me right now. Pure — the caller persists
 * `next`. A standing condition ("branch still has uncommitted work") is worth
 * saying once, not 45 times a day, so repeats inside the window are dropped and
 * the day's budget is hard.
 */
export function selectHeartbeatAlerts(
  findings: readonly string[],
  state: HeartbeatAlertState,
  now: Date,
  opts: { cap?: number; repeatMs?: number } = {},
): { selected: string[]; next: HeartbeatAlertState } {
  const cap = opts.cap ?? HEARTBEAT_ALERT_DAILY_CAP;
  const repeatMs = opts.repeatMs ?? HEARTBEAT_ALERT_REPEAT_MS;
  const day = localDayKey(now);
  const rolled = state.day === day ? state : { day, sent: 0, seen: state.seen };
  const seen = { ...rolled.seen };
  const selected: string[] = [];
  let sent = rolled.sent;

  for (const finding of findings) {
    const text = finding.trim();
    if (!text || sent >= cap) continue;
    const id = heartbeatAlertId(text);
    const lastAt = rolled.seen[id] ? Date.parse(rolled.seen[id]) : Number.NaN;
    if (Number.isFinite(lastAt) && now.getTime() - lastAt < repeatMs) continue;
    seen[id] = now.toISOString();
    selected.push(text);
    sent += 1;
  }

  return { selected, next: { day, sent, seen } };
}

export function heartbeatAlertStateFile(home: string): string {
  return path.join(home, "heartbeat-alerts.json");
}

export async function loadHeartbeatAlertState(home: string, now: Date): Promise<HeartbeatAlertState> {
  try {
    const raw = JSON.parse(await readFile(heartbeatAlertStateFile(home), "utf8")) as Partial<HeartbeatAlertState>;
    return {
      day: typeof raw.day === "string" ? raw.day : localDayKey(now),
      sent: typeof raw.sent === "number" && raw.sent >= 0 ? raw.sent : 0,
      seen: raw.seen && typeof raw.seen === "object" ? (raw.seen as Record<string, string>) : {},
    };
  } catch {
    return { day: localDayKey(now), sent: 0, seen: {} };
  }
}

export async function saveHeartbeatAlertState(home: string, state: HeartbeatAlertState): Promise<void> {
  await writeFile(heartbeatAlertStateFile(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface HeartbeatAlertSink {
  /** Run a turn in my own thread so the finding gets answered in my voice.
   *  Returns false when there is no thread to wake. */
  startTurn(text: string): Promise<boolean>;
  /** Direct banner, used only when there is no thread to wake. */
  push?(text: string): Promise<void>;
  log(line: string): void;
}

/**
 * Say the findings that earned it. Each delivery is a turn in my own thread, so
 * the owner hears it from me rather than from a status line — but a failed
 * delivery is NOT counted against the day's budget, so a broken sink retries on
 * the next tick instead of silently swallowing an alert.
 */
export async function deliverHeartbeatAlerts(deps: {
  home: string;
  findings: readonly string[];
  sink: HeartbeatAlertSink;
  now?: Date;
  cap?: number;
}): Promise<number> {
  const now = deps.now ?? new Date();
  const state = await loadHeartbeatAlertState(deps.home, now);
  const { selected, next } = selectHeartbeatAlerts(deps.findings, state, now, { cap: deps.cap });
  if (selected.length === 0) return 0;

  // The turn this opens runs unattended on a timer, so it is told what it is
  // FOR: saying what matters. An alert that silently starts fixing things is a
  // worse failure than a silent alert.
  const body = [selected.join("\n\n"), "", "(heartbeat alert — say what matters in this thread; no outward action from here.)"].join("\n");
  let delivered = false;
  try {
    delivered = await deps.sink.startTurn(body);
  } catch (err) {
    deps.sink.log(`heartbeat alert turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!delivered) {
    try {
      await deps.sink.push?.(body);
      delivered = deps.sink.push !== undefined;
    } catch (err) {
      deps.sink.log(`heartbeat alert push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // `seen` is always persisted: a finding that failed to send must not be
  // retried on the same cadence that made the heartbeat useless. Only the day's
  // budget is refunded, so a working sink cannot be starved by a broken one.
  const persisted = delivered ? next : { ...next, sent: Math.max(0, next.sent - selected.length) };
  await saveHeartbeatAlertState(deps.home, persisted).catch((err) =>
    deps.sink.log(`heartbeat alert state write failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  deps.sink.log(
    `heartbeat alert: ${delivered ? `${selected.length} delivered` : "NOT delivered — no thread and no push"} — ${selected[0]?.slice(0, 100) ?? ""}`,
  );
  return delivered ? selected.length : 0;
}
