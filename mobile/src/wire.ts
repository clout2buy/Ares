// The garrison gateway wire, as the phone sees it. Mirrors
// packages/garrison/src/protocol.ts and the TurnEvent subset the transcript
// renders. Kept local on purpose: the app is a plain Expo project outside the
// pnpm workspace, and a copy of ~60 lines beats a Metro watchFolders hack.

export type SessionSurface = "desktop" | "tui" | "telegram" | "garrison" | "headless" | "mobile";

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  provider: string;
  busy: boolean;
  surface?: SessionSurface;
  tenant?: { role: "owner" | "guest"; chatId?: string };
}

/** An image riding a session.send: base64 bytes plus MIME type. */
export interface SessionAttachment {
  kind: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface StagedApproval {
  id: string;
  kind: string;
  domain: string;
  reason: string;
  irreversibility?: string;
  preview?: unknown;
}

export type ClientFrame =
  | { type: "hello"; token: string; client: string; proto: 1 }
  | { type: "session.create"; surface?: SessionSurface }
  | { type: "session.attach"; sessionId: string }
  | { type: "session.send"; sessionId: string; text: string; inputId?: string; delivery?: "queue" | "steer"; attachments?: SessionAttachment[] }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "sessions.list" }
  | { type: "session.history"; sessionId: string; limit?: number }
  | { type: "permission.respond"; sessionId: string; requestId: string; decision: PermissionDecision }
  | { type: "approval.respond"; approvalId: string; verb: "allow_once" | "deny" };

export type ServerFrame =
  | { type: "welcome"; sessions: SessionSummary[] }
  | { type: "session.created"; session: SessionSummary }
  | { type: "event"; sessionId: string; event: TurnEvent }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session.history"; sessionId: string; entries: Array<{ ts?: string; event: TurnEvent }> }
  | { type: "approval.pending"; staged: StagedApproval }
  | { type: "error"; message: string }
  | { type: string; [key: string]: unknown };

/** A user message as the engine records it. */
export interface WireMessage {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export type TurnEvent =
  | { type: "input_admitted"; inputId: string; delivery: "queue" | "steer"; userMessage: WireMessage }
  | { type: "turn_start"; turnId: string; userMessage: WireMessage }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; activityDescription: string }
  | { type: "tool_end"; id: string; output: unknown; durationMs: number }
  | { type: "tool_error"; id: string; error: string; durationMs: number }
  | { type: "permission_request"; id: string; toolName: string; input: unknown; reason: string }
  | { type: "permission_response"; id: string; decision: PermissionDecision }
  | { type: "steer_routed"; inputId: string; disposition: string }
  | { type: "error"; error?: { code?: string; message?: string }; message?: string }
  | { type: "turn_end"; status?: string }
  | { type: string; [key: string]: unknown };

/** The plain text of a recorded user message, whatever shape it took. */
export function messageText(message: WireMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
