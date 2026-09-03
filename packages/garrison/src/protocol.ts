// Gateway wire protocol v1 — the FIXED CONTRACT between the Garrison and every
// channel client (desktop, CLI, Telegram, ...). Discriminated unions on `type`,
// type-only imports, zero runtime dependencies.
//
// Transport: WebSocket on 127.0.0.1 (ARES_GARRISON_HOST to override), port from
// ARES_GARRISON_PORT or 7421, plus HTTP GET /health on the same port. The first
// client frame MUST be `hello` carrying the token from <home>/garrison/token;
// the server answers `welcome` or sends `error` and closes.

import type { PermissionPromptDecision, TurnEvent } from "@ares/protocol";
import type { ApprovalVerb, StagedApproval } from "@ares/effects";
import type { SchedulerEvent } from "./scheduler.js";

export const PROTO_VERSION = 1 as const;
export const DEFAULT_GARRISON_PORT = 7421;

/** One live (or rehydrated) session as clients see it. */
export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  provider: string;
  busy: boolean;
  /** Which host opened it (absent on sessions created before surfaces existed). */
  surface?: "desktop" | "tui" | "telegram" | "garrison" | "headless";
  /** Who is on the other end; absent means the owner. */
  tenant?: { role: "owner" | "guest"; chatId?: string };
}

/** Daemon vitals reported by the `status` frame. */
export interface GarrisonStatus {
  /** ISO timestamp of daemon boot. */
  startedAt: string;
  /** 0 when no scheduler is wired. */
  heartbeatEveryMs: number;
  /** ISO timestamp of the next dream eligibility, when a dream hook exists. */
  nextDreamAt?: string;
  sessions: number;
}

// ─── Client → server ────────────────────────────────────────────────────

export type GatewayClientFrame =
  | { type: "hello"; token: string; client: string; proto: typeof PROTO_VERSION }
  | {
      type: "session.create";
      provider?: string;
      model?: string;
      workspace?: string;
      /** Host + sender stamps (see SessionSummary); unknown values are dropped. */
      surface?: SessionSummary["surface"];
      tenant?: SessionSummary["tenant"];
    }
  | { type: "session.attach"; sessionId: string }
  | {
      type: "session.send";
      sessionId: string;
      text: string;
      /** Stable owner-generated identity. Reusing it retries one logical input
       * instead of creating a second coding turn after an ambiguous disconnect. */
      inputId?: string;
      /** queue starts a later turn; steer injects the correction at the next
       * safe boundary of the active canonical turn. Defaults to queue. */
      delivery?: "queue" | "steer";
      /** Per-message sender identity from a multi-user channel (Telegram). */
      tenant?: SessionSummary["tenant"];
    }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "sessions.list" }
  | {
      /** Read-only replay of a session's recorded events (the rollout/audit
       * trail) so a viewer can render history it wasn't attached for. */
      type: "session.history";
      sessionId: string;
      /** Newest-N cap; the server may clamp it. */
      limit?: number;
    }
  | { type: "status" }
  | {
      type: "permission.respond";
      sessionId: string;
      requestId: string;
      decision: PermissionPromptDecision;
    }
  | { type: "approval.respond"; approvalId: string; verb: ApprovalVerb; note?: string };

// ─── Server → client ────────────────────────────────────────────────────

export type GatewayServerFrame =
  | { type: "welcome"; sessions: SessionSummary[] }
  | { type: "session.created"; session: SessionSummary }
  /** TurnEvents pass through VERBATIM — clients render exactly what the engine yielded. */
  | { type: "event"; sessionId: string; event: TurnEvent }
  | { type: "sessions"; sessions: SessionSummary[] }
  | {
      type: "session.history";
      sessionId: string;
      /** Recorded {ts?, event} entries, oldest first. */
      entries: Array<{ ts?: string; event: TurnEvent }>;
    }
  | { type: "status"; garrison: GarrisonStatus }
  | { type: "approval.pending"; staged: StagedApproval }
  /** Daemon-level happenings with no session (nightly gauntlet outcome…),
   *  broadcast to every authed client so the UI/Telegram can surface them. */
  | { type: "garrison.event"; event: SchedulerEvent }
  | { type: "error"; message: string };
