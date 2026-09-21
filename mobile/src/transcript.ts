// The transcript reducer: every gateway event folds into a list of items the
// chat renders. Pure — no React, no side effects — so history replay and the
// live stream go through the same door.

import { finishStep, newActivityCard, sealCard, shortFailureDetail, type ActivityCardState } from "./activity";
import { describePermissionInput, oauthProviderFromError } from "./prompts";
import { messageText, type PermissionDecision, type TurnEvent } from "./wire";

export type Item =
  | { kind: "user"; key: string; text: string; steer?: boolean; images?: string[] }
  | { kind: "image"; key: string; path: string; label: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "activity"; key: string; card: ActivityCardState }
  | { kind: "permission"; key: string; id: string; toolName: string; detail?: string; reason: string; decision?: PermissionDecision }
  | { kind: "connect"; key: string; provider: string; expired: boolean }
  | { kind: "notice"; key: string; text: string; tone: "error" | "info" };

export interface Transcript {
  items: Item[];
  busy: boolean;
  /** Where this turn's activity card lives, so tool events find it. */
  activityKey?: string;
}

let keySeq = 0;
export function nextKey(prefix = "i"): string {
  keySeq += 1;
  return `${prefix}${keySeq}`;
}

/** A screenshot path on a tool result, image extensions only. */
export function screenshotPathOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const candidate = (output as { screenshotPath?: unknown }).screenshotPath;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return /\.(png|jpe?g|webp|gif)$/i.test(candidate) ? candidate : undefined;
}

export function emptyTranscript(): Transcript {
  return { items: [], busy: false };
}

function lastUserText(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "user") return item.text;
    if (item.kind === "assistant" && !item.streaming) return undefined;
  }
  return undefined;
}

/** Add the user's words unless the optimistic bubble already shows them. */
function addUser(items: Item[], text: string, steer: boolean): void {
  const trimmed = stripSystemNotes(text).trim();
  if (!trimmed) return;
  if (lastUserText(items) === trimmed) return;
  items.push({ kind: "user", key: nextKey("u"), text: trimmed, steer: steer || undefined });
}

/** The preamble the app prepends on a session's first message is for the
 *  model, not the owner — keep it out of the bubbles. */
export function stripSystemNotes(text: string): string {
  return text.replace(/^\(System:[\s\S]*?\)\n\n/, "");
}

function activityOf(state: Transcript): ActivityCardState {
  if (state.activityKey) {
    const item = state.items.find((i) => i.key === state.activityKey);
    if (item && item.kind === "activity") return item.card;
  }
  const card = newActivityCard(Date.now());
  const key = nextKey("a");
  state.items.push({ kind: "activity", key, card });
  state.activityKey = key;
  return card;
}

export function fold(prev: Transcript, event: TurnEvent, now = Date.now()): Transcript {
  const state: Transcript = { ...prev, items: [...prev.items] };
  const items = state.items;
  const last = items[items.length - 1];

  switch (event.type) {
    case "input_admitted": {
      const e = event as Extract<TurnEvent, { type: "input_admitted" }>;
      addUser(items, messageText(e.userMessage), e.delivery === "steer");
      if (e.delivery === "steer" && state.activityKey) {
        const card = activityOf(state);
        card.steering = true;
      }
      return state;
    }
    case "turn_start": {
      const e = event as Extract<TurnEvent, { type: "turn_start" }>;
      addUser(items, messageText(e.userMessage), false);
      state.busy = true;
      state.activityKey = undefined;
      return state;
    }
    case "text_delta": {
      const text = String((event as { text?: string }).text ?? "");
      if (!text) return state;
      if (last && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: "assistant", key: nextKey("m"), text, streaming: true });
      }
      state.busy = true;
      return state;
    }
    case "tool_start": {
      const e = event as Extract<TurnEvent, { type: "tool_start" }>;
      // Seal the paragraph before the tool so later text starts a new bubble
      // under the card — the chat reads in the order things happened.
      if (last && last.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const card = activityOf(state);
      card.steps.push({ id: e.id, label: e.activityDescription || e.name, startedAt: now, state: "running" });
      state.busy = true;
      return state;
    }
    case "tool_end": {
      const e = event as Extract<TurnEvent, { type: "tool_end" }>;
      if (state.activityKey) finishStep(activityOf(state), e.id, "ok", now);
      // ComputerUse / RemotePC report the screenshot they took — show it, so
      // the phone sees what Ares saw.
      const shot = screenshotPathOf(e.output);
      if (shot) items.push({ kind: "image", key: nextKey("s"), path: shot, label: "What Ares saw" });
      const hit = oauthProviderFromError(e.output);
      if (hit) items.push({ kind: "connect", key: nextKey("c"), provider: hit.provider, expired: hit.expired });
      return state;
    }
    case "tool_error": {
      const e = event as Extract<TurnEvent, { type: "tool_error" }>;
      if (state.activityKey) finishStep(activityOf(state), e.id, "failed", now, shortFailureDetail(e.error));
      const hit = oauthProviderFromError(e.error);
      if (hit) items.push({ kind: "connect", key: nextKey("c"), provider: hit.provider, expired: hit.expired });
      return state;
    }
    case "permission_request": {
      const e = event as Extract<TurnEvent, { type: "permission_request" }>;
      if (last && last.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: "permission", key: nextKey("p"), id: e.id, toolName: e.toolName, detail: describePermissionInput(e.input), reason: e.reason });
      return state;
    }
    case "permission_response": {
      const e = event as Extract<TurnEvent, { type: "permission_response" }>;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === "permission" && item.id === e.id) {
          items[i] = { ...item, decision: e.decision };
          break;
        }
      }
      return state;
    }
    case "steer_routed": {
      const card = activityOf(state);
      card.steering = true;
      return state;
    }
    case "error": {
      const e = event as { error?: { message?: string; code?: string }; message?: string };
      const text = e.error?.message ?? e.message ?? e.error?.code ?? "something went wrong";
      items.push({ kind: "notice", key: nextKey("n"), text, tone: "error" });
      return state;
    }
    case "turn_end": {
      if (last && last.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      if (state.activityKey) sealCard(activityOf(state), now);
      state.activityKey = undefined;
      state.busy = false;
      return state;
    }
    default:
      return prev;
  }
}
