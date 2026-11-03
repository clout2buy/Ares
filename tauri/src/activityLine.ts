// The live activity line in the typing bubble, and the job line under each
// agent in the list. The words come from the shared table in
// packages/protocol/src/activityLine.ts; this module folds daemon events into
// a short step history and turns it into lines:
//
//   Read parkour.html ✓
//   Now running the tests · 14s
//
// Owner, 2026-10-20: "i hate not knowing what its doing turn stuck?" and
// "it should say like doing this, then after now im doing this". Pure (no
// React) so the fold and the view are unit-tested (tests/desktop-activity-line).
// Nothing here animates: lines swap in place, done lines are just faint.

import {
  toolActivity,
  reminderActivity,
  withRetryCountdown,
  modelFriendlyName,
  type ActivityGroup,
  type ActivityPhrase,
} from "../../packages/protocol/src/activityLine";

export { toolActivity, reminderActivity, modelFriendlyName };

/** One step of what the agent did this turn. */
export interface ActivityStep {
  key: string;
  /** Tool-call ids still running inside this step (a merged step holds several). */
  ids: string[];
  group: ActivityGroup | "prep" | "think" | "reply";
  now: string;
  done: string;
  /** Distinct files a merged read/edit/write step covers. */
  files?: string[];
  startedAt: number;
  finished: boolean;
  failed?: boolean;
  /** Thinking, writing, waiting, getting ready: shown while current, never
   *  kept as a done line ("Thought ✓" tells nobody anything). */
  transient: boolean;
  /** Authored but not yet running (a big Write still streaming in). */
  drafting?: boolean;
  /** When the next provider retry fires; the line counts down to it. */
  retryAt?: number;
}

/** How many lines the bubble ever shows: two done, one current. */
export const ACTIVITY_KEEP = 3;
/** Per-step elapsed time appears once a step has run this long. */
export const ACTIVITY_ELAPSED_AFTER_MS = 10_000;
/** No event at all for this long: the line says "Still on: …" and offers Stop. */
export const ACTIVITY_STUCK_AFTER_MS = 60_000;

let seq = 0;
const freshKey = () => `act${++seq}`;

const trim = (steps: ActivityStep[]): ActivityStep[] =>
  steps.length > ACTIVITY_KEEP ? steps.slice(-ACTIVITY_KEEP) : steps;

const dropTrailingTransient = (steps: ActivityStep[]): ActivityStep[] => {
  let end = steps.length;
  while (end > 0 && steps[end - 1].transient) end--;
  return end === steps.length ? steps : steps.slice(0, end);
};

const MERGEABLE = new Set<ActivityStep["group"]>(["read", "edit", "create"]);

function mergedText(group: ActivityStep["group"], files: string[]): { now: string; done: string } {
  const n = files.length;
  const one = files[0];
  switch (group) {
    case "read": return n === 1 ? { now: `Reading ${one}`, done: `Read ${one}` } : { now: `Reading ${n} files`, done: `Read ${n} files` };
    case "create": return n === 1 ? { now: `Writing ${one}`, done: `Wrote ${one}` } : { now: `Writing ${n} files`, done: `Wrote ${n} files` };
    default: return n === 1 ? { now: `Editing ${one}`, done: `Edited ${one}` } : { now: `Editing ${n} files`, done: `Edited ${n} files` };
  }
}

/**
 * A tool step begins (or a drafting skeleton becomes a running call). Same-
 * family file steps back to back merge into one line ("Editing 3 files");
 * whatever transient line was current (Thinking…) is replaced, not kept.
 */
export function startToolStep(steps: ActivityStep[] | undefined, id: string, p: ActivityPhrase, nowMs: number, opts: { drafting?: boolean } = {}): ActivityStep[] {
  let list = [...(steps ?? [])];
  let startedAt = nowMs;
  // A drafting skeleton for this very call: take its clock and re-place it, so
  // it can merge with the step before it now that its file is known.
  const own = list.findIndex((s) => s.ids.includes(id));
  if (own !== -1) {
    const prior = list[own];
    if (prior.drafting && prior.ids.length === 1) {
      startedAt = prior.startedAt;
      list.splice(own, 1);
    } else {
      // Already counted (a merged step): only learn the file.
      if (p.file && prior.files && !prior.files.includes(p.file)) {
        const files = [...prior.files, p.file];
        list[own] = { ...prior, files, ...mergedText(prior.group, files), drafting: opts.drafting ?? false };
      } else {
        list[own] = { ...prior, drafting: opts.drafting ?? false };
      }
      return list;
    }
  }
  list = dropTrailingTransient(list);
  const last = list.at(-1);
  if (last && p.file && last.files && last.group === p.group && MERGEABLE.has(p.group) && !last.failed) {
    const files = last.files.includes(p.file) ? last.files : [...last.files, p.file];
    list[list.length - 1] = {
      ...last,
      ids: [...last.ids, id],
      files,
      ...mergedText(last.group, files),
      finished: false,
      drafting: opts.drafting ?? false,
    };
    return trim(list);
  }
  list.push({
    key: id || freshKey(),
    ids: [id],
    group: p.group,
    now: p.now,
    done: p.done,
    ...(p.file ? { files: [p.file] } : {}),
    startedAt,
    finished: false,
    transient: false,
    ...(opts.drafting ? { drafting: true } : {}),
  });
  return trim(list);
}

/** A tool call settled. The step is done once every call inside it is. */
export function finishToolStep(steps: ActivityStep[] | undefined, id: string, ok: boolean): ActivityStep[] {
  const list = [...(steps ?? [])];
  const at = list.findIndex((s) => s.ids.includes(id));
  if (at === -1) return list;
  const step = list[at];
  const ids = step.ids.filter((x) => x !== id);
  list[at] = {
    ...step,
    ids,
    finished: ids.length === 0,
    ...(ok ? {} : { failed: true }),
  };
  return list;
}

/**
 * The current line becomes a transient one (Thinking, Writing the reply,
 * Waiting on Claude…). The same text again keeps its clock, so a long think
 * reads as one long step rather than restarting every token.
 */
export function setTransientStep(
  steps: ActivityStep[] | undefined,
  group: ActivityStep["group"],
  now: string,
  nowMs: number,
  retryAt?: number,
): ActivityStep[] {
  const list = [...(steps ?? [])];
  const last = list.at(-1);
  if (last?.transient && last.now === now) {
    if (retryAt !== last.retryAt) list[list.length - 1] = { ...last, retryAt };
    return list;
  }
  // A tool still running keeps the line; a provider wait cannot preempt it.
  if (last && !last.transient && !last.finished && !last.drafting) return list;
  const base = last?.transient ? list.slice(0, -1) : list;
  base.push({
    key: freshKey(),
    ids: [],
    group,
    now,
    done: now,
    startedAt: nowMs,
    finished: false,
    transient: true,
    ...(retryAt !== undefined ? { retryAt } : {}),
  });
  return trim(base);
}

/** A finished, one-shot step (a compaction that already happened). */
export function addDoneStep(steps: ActivityStep[] | undefined, group: ActivityGroup, done: string, nowMs: number): ActivityStep[] {
  const list = dropTrailingTransient([...(steps ?? [])]);
  list.push({ key: freshKey(), ids: [], group, now: done, done, startedAt: nowMs, finished: true, transient: false });
  return trim(list);
}

/** Every step a stopped or ended turn left open is closed (nothing is "Now" any more). */
export function closeAllSteps(steps: ActivityStep[] | undefined): ActivityStep[] {
  return dropTrailingTransient(steps ?? []).map((s) => (s.finished ? s : { ...s, finished: true, ids: [] }));
}

/** Names keep their capital after "Now …" / "Still on: …". */
const NAMES = /^(Claude|DeepSeek|Gemini|Grok|Kimi|GLM|Qwen|ChatGPT|Llama)\b/;
const lowerFirst = (s: string): string => (NAMES.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** "14s", "1m 20s", "1h 3m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface ActivityLineVm {
  key: string;
  text: string;
  done: boolean;
  failed?: boolean;
  /** Per-step time, only once it passes ACTIVITY_ELAPSED_AFTER_MS. */
  elapsed?: string;
}

export interface ActivityView {
  lines: ActivityLineVm[];
  /** Nothing heard for ACTIVITY_STUCK_AFTER_MS: the surface says Stop is there. */
  stuck: boolean;
}

/**
 * The lines the typing bubble shows right now. Pure: same steps + clock in,
 * same lines out.
 */
export function activityView(steps: ActivityStep[] | undefined, nowMs: number, lastEventAt?: number): ActivityView {
  const list = steps ?? [];
  const last = list.at(-1);
  const current = last && !last.finished ? last : undefined;
  const doneSteps = list.filter((s) => s !== current && !s.transient && s.finished);
  const lines: ActivityLineVm[] = doneSteps.map((s) => ({
    key: s.key,
    text: s.failed ? `${s.done} (hit a problem)` : s.done,
    done: true,
    ...(s.failed ? { failed: true } : {}),
  }));
  const quietMs = lastEventAt ? nowMs - lastEventAt : 0;
  const stuck = list.length > 0 && quietMs >= ACTIVITY_STUCK_AFTER_MS;
  if (current) {
    const base = withRetryCountdown(current.now, current.retryAt, nowMs);
    const ranMs = nowMs - current.startedAt;
    if (stuck) {
      lines.push({ key: current.key, text: `Still on: ${lowerFirst(base)} (${formatElapsed(ranMs)})`, done: false });
    } else {
      lines.push({
        key: current.key,
        text: lines.length ? `Now ${lowerFirst(base)}` : base,
        done: false,
        ...(ranMs >= ACTIVITY_ELAPSED_AFTER_MS && current.retryAt === undefined ? { elapsed: formatElapsed(ranMs) } : {}),
      });
    }
  } else if (stuck && last) {
    lines.push({ key: `${last.key}-still`, text: `Still working (${formatElapsed(quietMs)} since the last step)`, done: false });
  }
  return { lines: lines.slice(-ACTIVITY_KEEP), stuck };
}

/**
 * The one-line job under an agent's name in the list while it works: what it
 * is doing right now, no clock (the list does not tick). Undefined when idle.
 */
export function jobLine(steps: ActivityStep[] | undefined, busy: boolean): string | undefined {
  if (!busy) return undefined;
  const list = steps ?? [];
  const last = list.at(-1);
  if (!last) return "Working on it";
  if (!last.finished) return last.now;
  return last.failed ? `${last.done} (hit a problem)` : `${last.done}, working on the next step`;
}

/** Drop skeletons of calls that never ran (a superseded attempt's drafts). */
export function dropDrafts(steps: ActivityStep[] | undefined): ActivityStep[] {
  return (steps ?? []).filter((s) => !s.drafting);
}

/** A drafting call's file became known mid-stream ("Writing parkour.html"). */
export function learnDraftTarget(steps: ActivityStep[] | undefined, id: string, name: string, target: string, nowMs: number): ActivityStep[] | undefined {
  const step = steps?.find((s) => s.ids.includes(id));
  if (!step || !step.drafting || step.files?.length || !target) return steps;
  const p = toolActivity(name, { file_path: target });
  return p ? startToolStep(steps, id, p, nowMs, { drafting: true }) : steps;
}

/** The event fields foldActivity reads (a subset of the desktop's AresEvent). */
export interface ActivityEvent {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  label?: string;
  text?: string;
  error?: unknown;
  method?: string;
  description?: string;
  toolName?: string;
  status?: string;
  continuing?: boolean;
}

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Fold one daemon event into the step history. `ctx.preparing`/`busy` are the
 * session's state BEFORE the event. Returns undefined when the turn is over
 * (the bubble and the job line go with it).
 */
export function foldActivity(
  steps: ActivityStep[] | undefined,
  e: ActivityEvent,
  ctx: { nowMs: number; model?: string; preparing?: boolean; busy?: boolean },
): ActivityStep[] | undefined {
  const now = ctx.nowMs;
  switch (e.type) {
    case "turn_start":
      return setTransientStep([], "prep", "Getting ready", now);
    case "turn_phase":
      if (!ctx.preparing || typeof e.label !== "string" || !e.label) return steps;
      return setTransientStep(steps, "prep", e.label.charAt(0).toUpperCase() + e.label.slice(1), now);
    case "provider_attempt_started":
      return setTransientStep(dropDrafts(steps), "think", "Thinking", now);
    case "thinking_delta":
      return setTransientStep(steps, "think", "Thinking", now);
    case "text_delta":
      return setTransientStep(steps, "reply", "Writing the reply", now);
    case "provider_attempt_superseded":
    case "provider_attempt_effects_skipped":
      return setTransientStep(dropDrafts(steps), "think", "Taking your correction into account", now);
    case "tool_use_start": {
      const p = toolActivity(e.name ?? "", {});
      return p && e.id ? startToolStep(steps, e.id, p, now, { drafting: true }) : steps;
    }
    case "tool_start": {
      if (!e.id) return steps;
      const p = toolActivity(e.name ?? "", e.input);
      if (!p) return (steps ?? []).filter((s) => !(s.drafting && s.ids.length === 1 && s.ids[0] === e.id));
      return startToolStep(steps, e.id, p, now);
    }
    case "tool_end":
    case "tool_error":
      return e.id ? finishToolStep(steps, e.id, e.type === "tool_end") : steps;
    case "subagent_start": {
      const last = steps?.at(-1);
      // The Task call that spawned it already says "A helper is on: …".
      if (last && last.group === "delegate" && !last.finished) return steps;
      const d = (e.description ?? "").trim();
      const p: ActivityPhrase = d
        ? { group: "delegate", now: `A helper is on: ${clipTo(d, 60)}`, done: `Helper finished: ${clipTo(d, 60)}` }
        : { group: "delegate", now: "Handing part of this to a helper", done: "A helper finished its part" };
      return startToolStep(steps, e.id ?? freshKey(), p, now);
    }
    case "subagent_end":
      return e.id ? finishToolStep(steps, e.id, e.status !== "failed") : steps;
    case "permission_request": {
      const p = toolActivity(e.toolName ?? "", e.input);
      const what = p ? `: ${p.now.charAt(0).toLowerCase()}${p.now.slice(1)}` : "";
      return setTransientStep(steps, "wait", `Waiting for your OK${what}`, now);
    }
    case "system_reminder_injected":
    case "error": {
      if (!ctx.busy) return steps;
      const err = e.error as { message?: unknown } | string | undefined;
      const text = e.type === "error"
        ? typeof err === "string" ? err : typeof err?.message === "string" ? err.message : e.text ?? ""
        : e.text ?? "";
      const r = reminderActivity(text, ctx.model, now);
      return r ? setTransientStep(steps, r.group, r.now, now, r.retryAt) : steps;
    }
    case "compaction":
      return e.method === "micro" ? steps : addDoneStep(steps, "compact", "Compacted memory of this chat", now);
    case "turn_end":
      return setTransientStep(closeAllSteps(steps), "think", "Wrapping up", now);
    case "interrupt_requested":
    case "interrupt_pending":
    case "interrupt_forced":
      return setTransientStep(closeAllSteps(steps), "wait", "Stopping safely", now);
    case "turn_settled":
      return e.continuing ? steps : undefined;
    case "interrupt_settled":
    case "interrupted_by_user":
    case "interrupt_idle":
    case "desktop_pending_input_cancelled":
    case "startup_recovery_failed":
      return undefined;
    default:
      return steps;
  }
}
