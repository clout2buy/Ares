// Gateway wire protocol v1 — the channel-side copy of the frame contract.
// The Garrison owns the canonical server; channels deliberately do NOT import
// from @ares/garrison (parallel build, no cycle). These shapes mirror the
// fixed v1 contract exactly: hello/welcome handshake, session intents,
// TurnEvent fan-out, and the Gate's approval frames.

import type { PermissionPromptDecision, TurnEvent } from "@ares/protocol";

/** Session summary as the gateway reports it (welcome / sessions / session.created). */
export interface GatewaySessionInfo {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  busy?: boolean;
  surface?: GatewaySurface;
  tenant?: GatewayTenant;
}

/** Which host opened a session — mirrors the garrison's SessionSurface. */
export type GatewaySurface = "desktop" | "tui" | "telegram" | "garrison" | "headless";

/** Who is on the other end of a session or message. The chatId is a string
 *  on the wire so the garrison never has to reason about Telegram's numeric
 *  ids; memory scoping keys on `guest:<chatId>`. */
export interface GatewayTenant {
  role: "owner" | "guest";
  chatId?: string;
}

/** Mirrors @ares/effects ApprovalVerb without taking the dependency. */
export type ApprovalVerb = "allow_once" | "allow_always" | "deny";

/** A staged effect waiting at the Gate, as broadcast by the gateway. */
export interface StagedApprovalFrame {
  id: string;
  kind?: string;
  domain?: string;
  reason?: string;
  preview?: unknown;
}

export interface GarrisonStatus {
  startedAt: string;
  heartbeatEveryMs: number;
  nextDreamAt?: string;
  sessions: number;
}

export type ClientFrame =
  | { type: "hello"; token: string; client: string; proto: 1 }
  | { type: "session.create"; provider?: string; model?: string; workspace?: string; surface?: GatewaySurface; tenant?: GatewayTenant }
  | { type: "session.attach"; sessionId: string }
  | {
      type: "session.send";
      sessionId: string;
      text: string;
      inputId?: string;
      delivery?: "queue" | "steer";
      tenant?: GatewayTenant;
    }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "sessions.list" }
  | { type: "status" }
  | { type: "permission.respond"; sessionId: string; requestId: string; decision: PermissionPromptDecision }
  | { type: "approval.respond"; approvalId: string; verb: ApprovalVerb; note?: string };

/** A daemon-level event with no session (mirrors the garrison's SchedulerEvent
 *  loosely — channels render what they recognize and ignore the rest). */
export interface GarrisonEventFrame {
  kind: string;
  at?: string;
  summary?: { passed?: number; total?: number; gateOk?: boolean; suite?: string; model?: string; provider?: string };
  reasons?: string[];
  previous?: { at: string; passed: number; total: number } | null;
  findingId?: string;
  regressed?: boolean;
}

export type ServerFrame =
  | { type: "welcome"; sessions: GatewaySessionInfo[] }
  | { type: "session.created"; session: GatewaySessionInfo }
  | { type: "event"; sessionId: string; event: TurnEvent }
  | { type: "sessions"; sessions: GatewaySessionInfo[] }
  | { type: "status"; garrison: GarrisonStatus }
  | { type: "approval.pending"; staged: StagedApprovalFrame }
  | { type: "garrison.event"; event: GarrisonEventFrame }
  | { type: "error"; message: string };

/** Minimal structural WebSocket — satisfied by `ws` and by injected fakes. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;
