// runForkedTurn — the ONE way to spawn a child run of the agent loop.
//
// Every autonomous driver (subagents, the operator dispatcher, and — later —
// Consciousness actions and Telegram missions) re-enters the SAME QueryEngine
// through here instead of hand-rolling `new QueryEngine + appendUserMessage +
// streamTurn`. Collapsing those duplicate drivers onto one primitive centralizes
// the two invariants that MUST hold for every fork:
//   1. a FRESH, empty fileReadStamps map — a child's Reads must never poison the
//      parent's re-read guard or grant it write-before-read on files the parent
//      never inspected (this is why the option type omits fileReadStamps: the
//      caller cannot pass one);
//   2. a goal/work-item seed by default (not a faked chat turn) so chat-only
//      consumers can tell autonomous work from a real user message.
// The child inherits every loop guard for free — watchdog, oscillation/ceiling/
// stall detection, the identity anchor, microcompact, and result spill.

import type { ContentBlock, Message, TurnEndStatus, TurnEvent, Usage, WorkStatus } from "@ares/protocol";
import { QueryEngine, type QueryEngineConfig } from "./queryEngine.js";
import { projectMessagesFromKernel, Session } from "./session.js";
import { openWorkspaceSessionKernel } from "./sessionKernel/workspace.js";

export type ForkedTurnSeed =
  | { kind: "work-item"; text: string }
  | { kind: "chat"; text: string }
  | { kind: "content"; content: ContentBlock[] };

export interface ForkedTurnOptions {
  /**
   * Child engine config. `fileReadStamps` is intentionally OMITTED — every fork
   * gets a fresh empty map, set here and never by the caller, so read-stamp
   * isolation can't be accidentally broken at a call site.
   */
  config: Omit<QueryEngineConfig, "fileReadStamps">;
  sessionId: string;
  /** Stable logical input identity when the caller can replay one invocation. */
  inputId?: string;
  /** What seeds the turn. Defaults to a tagged work-item (autonomous), not chat. */
  seed: ForkedTurnSeed;
  /** Live per-event hook — e.g. surfacing a subagent's tool activity to the parent UI. */
  onEvent?: (event: TurnEvent) => void;
  /** Give a child that ends without any text one tool-less turn to write its
   *  answer (see SUBAGENT_ANSWER_NUDGE). Subagents set this; the operator
   *  dispatcher does not. */
  answerNudge?: boolean;
}

export interface ForkedTurnResult {
  /** The child engine, for callers that need its full history(). */
  engine: QueryEngine;
  /** Every TurnEvent the run emitted, in order. */
  events: TurnEvent[];
  history: readonly Message[];
  /** Concatenated text_delta across the run (operator step verdict reads this). */
  streamedText: string;
  /** Text of the last assistant message — the canonical answer/summary. */
  finalText: string;
  usage: Usage;
  status: TurnEndStatus;
  /** Proof-bearing work truth is independent from loop termination. */
  workStatus: WorkStatus;
}

export async function runForkedTurn(opts: ForkedTurnOptions): Promise<ForkedTurnResult> {
  // Child engines survive a permission denial: the denied tool call becomes an
  // ordinary error result the model routes around, instead of interrupting the
  // whole fork — one denied out-of-workspace Glob used to kill a 5-agent
  // researcher fleet with zero output (bug 96ca5473). Callers can override.
  const config = {
    permissionDenialInterrupts: false,
    ...opts.config,
    fileReadStamps: new Map(),
  };
  const requiresDurableHost = config.hookManager !== undefined || config.tools.some((tool) =>
    tool.schema.safety !== "read-only" || tool.mayHaveEffects === true
  );

  let engine: QueryEngine;
  let stream: AsyncGenerator<TurnEvent>;
  let nudgeStream: () => AsyncGenerator<TurnEvent>;
  let durableWorkStatus: WorkStatus | undefined;
  if (requiresDurableHost) {
    // Compatibility callers used to be able to fork an effectful tool catalog
    // without providing a kernel. Do not revive that as an unledgered escape
    // hatch: lazily attach the target workspace's canonical store and execute
    // through the same hosted Session barriers as every production surface.
    const sessionKernel = await openWorkspaceSessionKernel(config.workspace);
    const restoredMessages = sessionKernel.getSession(opts.sessionId)
      ? projectMessagesFromKernel(sessionKernel, opts.sessionId)
      : [];
    const session = new Session({
      ...config,
      sessionId: opts.sessionId,
      sessionKernel,
      initialMessages: restoredMessages,
    });
    await session.waitForStartupRecovery();
    engine = session.engine;
    const canonical = sessionKernel.getSession(opts.sessionId);
    durableWorkStatus = canonical?.workOutcome === "pending"
      ? "unverified"
      : canonical?.workOutcome;
    stream = session.sendContent(forkSeedContent(opts.seed), {
      ...(opts.inputId ? { inputId: opts.inputId } : {}),
      source: opts.seed.kind === "work-item" ? "work-item" : "user-input",
    });
    nudgeStream = () => session.sendContent([{ type: "text", text: SUBAGENT_ANSWER_NUDGE }], { source: "work-item" });
  } else {
    engine = new QueryEngine(config, opts.sessionId);
    switch (opts.seed.kind) {
      case "content":
        engine.appendUserMessageContent(opts.seed.content);
        break;
      case "chat":
        engine.appendUserMessage(opts.seed.text);
        break;
      case "work-item":
        engine.appendWorkItem(opts.seed.text);
        break;
    }
    stream = engine.streamTurn();
    nudgeStream = () => {
      engine.appendWorkItem(SUBAGENT_ANSWER_NUDGE);
      return engine.streamTurn();
    };
  }

  const events: TurnEvent[] = [];
  let streamedText = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: TurnEndStatus = "completed";
  let workStatus: WorkStatus = "not_applicable";
  try {
    for await (const event of stream) {
      events.push(event);
      opts.onEvent?.(event);
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "turn_end") {
        usage = event.usage;
        status = event.status;
        workStatus = event.workStatus ?? "not_applicable";
      } else if (event.type === "error") {
        status = "failed";
      }
    }
  } catch {
    // A throw out of the loop is a failed fork, never a crash of the parent driver.
    status = "failed";
  }

  if (events.every((event) => event.type !== "turn_end") && durableWorkStatus) {
    workStatus = durableWorkStatus;
  }

  const history = engine.history();
  const finalText = lastAssistantText(history);

  if (!finalText && opts.answerNudge && answerNudgeEnabled() && !config.signal?.aborted && status !== "interrupted") {
    const nudged = await nudgeSilentChild(
      { engine, events, streamedText, usage, status, workStatus },
      nudgeStream,
      () => engine.history(),
      opts.onEvent,
    );
    return { engine, ...nudged };
  }

  return { engine, events, history, streamedText, finalText, usage, status, workStatus };
}

/**
 * The one extra turn a child gets when it ends without writing a word. Field
 * window Sep 20 - Nov 2: 26 of 29 subagent runs "failed", 16 of them as
 * "(subagent produced no text output)" right after a failing PowerShell call:
 * the child hit its turn budget or a stall mid-tool and never wrote the answer
 * the parent was waiting for. One tool-less nudge recovers most of them.
 * ARES_SUBAGENT_ANSWER_NUDGE=0 turns it off.
 */
export const SUBAGENT_ANSWER_NUDGE =
  "You stopped without writing your answer. Do not call any more tools. Write your final answer now: what you found or did, " +
  "what failed (quote the error), and what is left undone.";

export function answerNudgeEnabled(): boolean {
  return process.env.ARES_SUBAGENT_ANSWER_NUDGE !== "0";
}

/** Text of the last assistant message in `history` (the canonical answer). */
export function lastAssistantText(history: readonly Message[]): string {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  return lastAssistant
    ? lastAssistant.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim()
    : "";
}

/**
 * Run the answer nudge on a child that ended silent: one model iteration
 * (maxTurns 1), events appended to the run's own list. Returns the merged
 * result; when the nudge produced text, its turn status replaces the silent
 * one (the child did answer), otherwise the original status stands.
 */
export async function nudgeSilentChild(
  base: Omit<ForkedTurnResult, "history" | "finalText">,
  stream: () => AsyncGenerator<TurnEvent>,
  history: () => readonly Message[],
  onEvent?: (event: TurnEvent) => void,
): Promise<{ events: TurnEvent[]; streamedText: string; usage: Usage; status: TurnEndStatus; workStatus: WorkStatus; history: readonly Message[]; finalText: string }> {
  const events = [...base.events];
  let streamedText = base.streamedText;
  let usage = base.usage;
  let nudgeStatus: TurnEndStatus = "completed";
  let nudgeWork: WorkStatus | undefined;
  base.engine.setMaxTurns(1);
  try {
    for await (const event of stream()) {
      events.push(event);
      onEvent?.(event);
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "turn_end") {
        usage = {
          ...usage,
          inputTokens: usage.inputTokens + event.usage.inputTokens,
          outputTokens: usage.outputTokens + event.usage.outputTokens,
        };
        nudgeStatus = event.status;
        nudgeWork = event.workStatus;
      } else if (event.type === "error") nudgeStatus = "failed";
    }
  } catch {
    nudgeStatus = "failed";
  }
  const after = history();
  const finalText = lastAssistantText(after);
  const answered = finalText.length > 0;
  return {
    events,
    streamedText,
    usage,
    status: answered && nudgeStatus !== "failed" ? nudgeStatus : base.status,
    workStatus: answered && nudgeWork ? nudgeWork : base.workStatus,
    history: after,
    finalText,
  };
}

function forkSeedContent(seed: ForkedTurnSeed): ContentBlock[] {
  return seed.kind === "content"
    ? seed.content.map((block) => ({ ...block }))
    : [{ type: "text", text: seed.text }];
}
