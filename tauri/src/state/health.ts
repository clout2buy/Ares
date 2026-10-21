// Daemon health from the out-of-band ping/pong (pure, so it is testable).

export interface PongTurn {
  sessionId: string;
  inputId?: string;
  startedMs?: number;
  lastEvent?: string;
  lastEventMs?: number;
  activeTools: number;
  stopping: boolean;
}

export interface Pong {
  nonce?: string;
  at: number;
  queued: number;
  loop: { busyWith: string; sessionId?: string; forMs: number } | null;
  turns: PongTurn[];
}

export type DaemonHealth = "ok" | "slow" | "unresponsive";

/** A ping is outstanding when it was sent after the last pong. */
export function daemonHealth(lastPingAt: number, lastPongAt: number, now: number): DaemonHealth {
  if (!lastPingAt || lastPongAt >= lastPingAt) return "ok";
  const waited = now - lastPingAt;
  if (waited >= 25_000) return "unresponsive";
  if (waited >= 8_000) return "slow";
  return "ok";
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 120 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const EVENT_WORDS: Record<string, string> = {
  turn_phase: "preparing context",
  turn_start: "starting the turn",
  provider_attempt_started: "waiting on the model",
  text_delta: "writing the reply",
  thinking_delta: "thinking",
  tool_start: "starting a tool",
  tool_progress: "a tool reporting progress",
  tool_end: "a tool finishing",
  permission_request: "waiting for your approval",
  interrupt_requested: "stopping",
  compaction: "compacting history",
};

/** What a quiet turn last did, in owner words. Null while it is not quiet. */
export function turnStatusNote(turn: PongTurn | undefined, quietAfterMs = 90_000): string | null {
  if (!turn || turn.lastEventMs === undefined || turn.lastEventMs < quietAfterMs) return null;
  const what = (turn.lastEvent && EVENT_WORDS[turn.lastEvent]) ?? turn.lastEvent ?? "unknown";
  const tools = turn.activeTools > 0 ? `, ${turn.activeTools === 1 ? "a tool is" : `${turn.activeTools} tools are`} still running` : "";
  return `last activity: ${what}, ${fmtAgo(turn.lastEventMs)} ago${tools}`;
}

/** The command loop busy on one command long enough to hold other chats. */
export function loopStuckNote(pong: Pong | null, afterMs = 20_000): string | null {
  if (!pong?.loop || pong.loop.forMs < afterMs) return null;
  const waiting = pong.queued > 0 ? `; ${pong.queued} request${pong.queued === 1 ? "" : "s"} waiting behind it` : "";
  return `Ares has been busy with "${pong.loop.busyWith}" for ${fmtAgo(pong.loop.forMs)}${waiting}.`;
}
