// /gateway/timeline — who handed what to whom.
//
//   GET /gateway/timeline?since=<rev>&limit=<n>&agent=<id>&status=<s>&wait=<ms>&epoch=<e>
//        200 { epoch, cursor, now, reset?, events[], agents[] }
//
// The owner's agents hand work to each other: a Task to a subagent, a
// Conductor fleet, a CodingBackend run, a family message to a person, a family
// reply routed back into an agent's thread. Each of those is already in the
// session event stream (and in the on-disk rollouts); this module folds them
// into ONE normalised stream the phone can draw as a handoff timeline, with who
// gave it, who took it, what it was, whether it finished and how it came out.
//
// Shape of the data. Every handoff is a record with a STABLE id and a `rev` —
// a counter bumped each time the record is created or changes (running ->
// done). A client keeps `cursor` (the newest rev it has) and asks for
// `since=<cursor>`: it receives only the records that are new or changed, and
// merges them by id. That is the whole live protocol; `wait=<ms>` turns the
// same GET into a long poll (held until something changes, at most 25 s) so the
// screen updates within a beat of the work without a second socket or a new
// event bus. `epoch` identifies this server run: revs restart with it, so a
// client that presents a different epoch is told to start over (`reset: true`).
//
// Where the records come from. The tracker attaches to every LIVE owner
// session (SessionManager.attach — the same stream every surface reads) and,
// once at boot and again for a thread caught mid-turn, replays the tail of the
// session's rollout. Both feed the same fold, keyed by tool-use id, so seeing a
// handoff twice is harmless. Guest (Telegram stranger) sessions are never read.
//
// What a record may carry. Text is untrusted model output on its way to a
// screen: control characters are dropped, anything credential-shaped is
// redacted (@ares/protocol redactSecrets), a leading "(System: …)" note is
// stripped, and every field is length-capped. No file paths from the client are
// ever read; the only paths touched are this home's own rollouts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets, type TurnEvent } from "@ares/protocol";
import { stripPreamble } from "./personas.js";

export const TIMELINE_STORE_CAP = 600;
export const TIMELINE_DEFAULT_LIMIT = 80;
export const TIMELINE_MAX_LIMIT = 300;
export const TIMELINE_MAX_WAIT_MS = 25_000;
export const TASK_CAP = 200;
export const BRIEF_CAP = 480;
export const EXCERPT_CAP = 700;
/** A background job with no result this long after it began is flagged `stale`. */
export const STALE_AFTER_MS = 6 * 60 * 60_000;

export type HandoffStatus = "running" | "done" | "failed" | "cancelled";
export type HandoffVia = "task" | "fleet" | "coding" | "family" | "subagent";
export type PartyKind = "agent" | "subagent" | "fleet" | "backend" | "person";

/** One side of a handoff. `id` of an `agent` is the persona id the app knows
 *  ("ares" for the default assistant), so a client can look up its face. */
export interface Party {
  id: string;
  name: string;
  kind: PartyKind;
  color?: string;
  emoji?: string;
}

export interface Handoff {
  id: string;
  rev: number;
  via: HandoffVia;
  from: Party;
  to: Party;
  /** The short label: what was handed over. */
  task: string;
  /** More of what was handed over (the brief), capped. */
  brief?: string;
  status: HandoffStatus;
  /** When it began, epoch ms. */
  at: number;
  endedAt?: number;
  durationMs?: number;
  /** How it came out: the result or the failure, capped. */
  excerpt?: string;
  /** The delegating agent's thread, so the phone can open it. */
  sessionId?: string;
  /** Detached from the turn that started it. */
  background?: boolean;
  /** Agents in a fleet. */
  count?: number;
  /** Still "running", but nothing has been heard for a long time. */
  stale?: boolean;
}

// ─── text hygiene ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Untrusted text bound for a phone screen: no control or bidi characters, no
 *  credential-shaped substrings, no leading "(System: …)" note, one line of
 *  whitespace, clipped with an ellipsis. */
export function scrub(input: unknown, max: number): string {
  if (typeof input !== "string" || !input) return "";
  let t = input.length > max * 8 ? input.slice(0, max * 8) : input;
  t = stripPreamble(t);
  t = redactSecrets(t).replace(CONTROL, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The same, but keeping paragraph breaks (a result excerpt reads better with them). */
export function scrubBlock(input: unknown, max: number): string {
  if (typeof input !== "string" || !input) return "";
  let t = input.length > max * 8 ? input.slice(0, max * 8) : input;
  t = redactSecrets(t).replace(CONTROL, " ").replace(/\r\n?/g, "\n");
  t = t.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "general-purpose" -> "General purpose"; a persona slug keeps its words. */
export function prettyType(type: string): string {
  const words = type.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "Subagent";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const textOf = (message: unknown): string => {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
};

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** The words that best describe how a tool came out, from whatever shape it returned. */
export function excerptOf(output: unknown, max = EXCERPT_CAP): string {
  if (typeof output === "string") return scrubBlock(output, max);
  const o = obj(output);
  if (!o) return "";
  for (const key of ["summary", "result", "text", "message", "report", "answer", "output"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return scrubBlock(v, max);
    const inner = obj(v);
    if (inner) {
      const nested = excerptOf(inner, max);
      if (nested) return nested;
    }
  }
  if (typeof o.status === "string") return scrubBlock(`Status: ${o.status}`, max);
  return "";
}

// ─── recognising a handoff ────────────────────────────────────────────────

export interface Classified {
  via: HandoffVia;
  to: Party;
  task: string;
  brief?: string;
  background?: boolean;
  count?: number;
}

function countAgents(phases: unknown): number {
  if (!Array.isArray(phases)) return 0;
  let n = 0;
  for (const p of phases) {
    const agents = obj(p)?.agents;
    if (Array.isArray(agents)) n += agents.length;
  }
  return n;
}

/** A tool call that hands work to someone else, or null for every other tool. */
export function classifyToolStart(name: string, input: unknown): Classified | null {
  const i = obj(input) ?? {};
  if (name === "Task") {
    const type = str(i.subagent_type) ?? "general-purpose";
    const description = scrub(i.description, TASK_CAP) || scrub(i.prompt, TASK_CAP) || "A task";
    const brief = scrub(i.prompt, BRIEF_CAP);
    return {
      via: "task",
      to: { id: `sub:${type.toLowerCase().slice(0, 60)}`, name: prettyType(type.slice(0, 60)), kind: "subagent" },
      task: description,
      ...(brief && brief !== description ? { brief } : {}),
      ...(i.run_in_background === true ? { background: true } : {}),
    };
  }
  if (name === "Conductor") {
    const count = countAgents(i.phases);
    const goal = scrub(i.goal, TASK_CAP) || scrub(i.plan, TASK_CAP);
    const task = goal || (count > 0 ? `A fleet of ${count} agents` : "A fleet");
    const brief = scrub(i.plan, BRIEF_CAP);
    return {
      via: "fleet",
      to: { id: "fleet", name: "Fleet", kind: "fleet" },
      task,
      ...(brief && brief !== task ? { brief } : {}),
      ...(count > 0 ? { count } : {}),
    };
  }
  if (name === "CodingBackend") {
    const backend = str(i.backend) ?? "auto";
    const label = backend === "claude" ? "Claude Code" : backend === "codex" ? "Codex" : "Coding harness";
    const task = scrub(i.task, TASK_CAP) || "A coding task";
    const brief = scrub(i.task, BRIEF_CAP);
    return {
      via: "coding",
      to: { id: `backend:${backend.slice(0, 20)}`, name: label, kind: "backend" },
      task,
      ...(brief && brief !== task ? { brief } : {}),
    };
  }
  if (name === "Bash" || name === "PowerShell") {
    const family = parseFamilySend(str(i.command) ?? "");
    if (!family) return null;
    return {
      via: "family",
      to: personParty(family.to),
      task: scrub(family.text, TASK_CAP) || "A message",
      ...(family.text.length > TASK_CAP ? { brief: scrub(family.text, BRIEF_CAP) } : {}),
    };
  }
  return null;
}

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

export function personParty(name: string): Party {
  const clean = scrub(name, 40) || "Someone";
  return { id: `person:${clean.toLowerCase()}`, name: titleCase(clean), kind: "person" };
}

/** Split a shell-ish command into words, honouring '…' and "…" and backslash
 *  escapes. Not a shell — only enough to read `family-message send …`. */
export function shellWords(command: string, limit = 24): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < command.length && out.length < limit; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (c === ";" || c === "|" || c === "&") {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      break;
    } else {
      cur += c;
      has = true;
    }
  }
  if ((has || cur) && out.length < limit) out.push(cur);
  return out;
}

export interface FamilySend {
  to: string;
  sender: string;
  mode: "private" | "group";
  text: string;
}

/** `family-message send <to> <your-name> <private|group> <thread-id|new> <message>`,
 *  with or without a `node …/family-message.mjs` in front. */
export function parseFamilySend(command: string): FamilySend | null {
  if (!/family-message/.test(command)) return null;
  const words = shellWords(command);
  const at = words.findIndex((w, i) => w === "send" && i > 0 && /family-message/.test(words[i - 1] ?? ""));
  if (at < 0) return null;
  const [to, sender, mode, , ...rest] = words.slice(at + 1);
  if (!to || !sender || (mode !== "private" && mode !== "group") || rest.length === 0) return null;
  return { to, sender, mode, text: rest.join(" ") };
}

export interface FamilyInbound {
  from: string;
  mode: string;
  text: string;
}

/** The note familyReplies puts in front of an agent: "(Family message from X in
 *  private chat: …)\nWrite only your natural reply …". */
export function parseFamilyInbound(text: string): FamilyInbound | null {
  const m = /^\(Family message from ([^\n()]{1,60}?) in (private|group) chat: ([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  let body = m[3] ?? "";
  const tail = body.search(/\)\s*\n\s*Write only your natural reply/);
  body = tail >= 0 ? body.slice(0, tail) : body.replace(/\)\s*$/, "");
  return { from: m[1].trim(), mode: m[2], text: body.trim() };
}

// ─── the store ────────────────────────────────────────────────────────────

export interface TimelineQuery {
  since?: number;
  limit?: number;
  agent?: string;
  status?: HandoffStatus;
}

interface OpenLink {
  /** The record a tool call opened. */
  id: string;
  sessionId: string;
}

const publicOf = (r: Handoff): Handoff => {
  const copy: Handoff = { ...r, from: { ...r.from }, to: { ...r.to } };
  return copy;
};

const sameRecord = (a: Handoff, b: Handoff): boolean => {
  const { rev: _a, ...x } = a;
  const { rev: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
};

export class TimelineStore {
  readonly epoch: string;
  private revision = 0;
  private readonly records = new Map<string, Handoff>();
  /** tool-use id -> record, per session, while a call is in flight. */
  private readonly open = new Map<string, OpenLink>();
  /** Background Task job id -> record id. */
  private readonly jobs = new Map<string, string>();
  /** Family messages put to an agent whose turn has not ended. */
  private readonly inbound = new Map<string, string[]>();
  /** The last thing each session said, for an inbound handoff's result. */
  private readonly lastSaid = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now, epoch?: string) {
    this.epoch = epoch ?? `${this.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  }

  get rev(): number {
    return this.revision;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(rec: Handoff): void {
    const prev = this.records.get(rec.id);
    if (prev && sameRecord(prev, rec)) return;
    rec.rev = ++this.revision;
    this.records.set(rec.id, rec);
    if (this.records.size > TIMELINE_STORE_CAP) this.evict();
    for (const l of [...this.listeners]) {
      try { l(); } catch { /* a throwing waiter never breaks the fold */ }
    }
  }

  private evict(): void {
    // Oldest first, but never an in-flight record.
    const sorted = [...this.records.values()].sort((a, b) => a.at - b.at);
    for (const r of sorted) {
      if (this.records.size <= TIMELINE_STORE_CAP) break;
      if (r.status === "running") continue;
      this.records.delete(r.id);
    }
  }

  private update(id: string, patch: Partial<Handoff>): void {
    const prev = this.records.get(id);
    if (!prev) return;
    this.commit({ ...prev, ...patch });
  }

  private finish(id: string, status: HandoffStatus, ts: number, excerpt?: string): void {
    const prev = this.records.get(id);
    // The first outcome wins: a replay of the same call must not rewrite it.
    if (!prev || prev.status !== "running") return;
    const ended = Math.max(prev.at, ts);
    this.commit({
      ...prev,
      status,
      endedAt: ended,
      durationMs: Math.max(0, ended - prev.at),
      ...(excerpt ? { excerpt } : {}),
      stale: undefined,
    });
  }

  /** Fold one session event. `agent` is who this session belongs to. Cheap for
   *  the events that matter nothing to a handoff (every streamed token). */
  observe(sessionId: string, agent: Party, ts: number, event: TurnEvent): void {
    switch (event.type) {
      case "tool_start": {
        const name = String(event.name ?? "");
        const hit = classifyToolStart(name, event.input);
        if (hit) {
          const id = `${sessionId}:${event.id}`;
          this.open.set(`${sessionId}\0${event.id}`, { id, sessionId });
          const prev = this.records.get(id);
          if (prev) return; // a replay of a call already folded
          this.commit({
            id, rev: 0, via: hit.via, from: agent, to: hit.to, task: hit.task,
            ...(hit.brief ? { brief: hit.brief } : {}),
            status: "running", at: ts, sessionId,
            ...(hit.background ? { background: true } : {}),
            ...(hit.count ? { count: hit.count } : {}),
          });
          return;
        }
        // TaskOutput / KillTask poll or cancel a background job by id.
        if (name === "TaskOutput" || name === "KillTask") {
          this.open.set(`${sessionId}\0${event.id}`, { id: `job:${String(obj(event.input)?.job_id ?? "")}`, sessionId });
        }
        return;
      }
      case "tool_end": {
        const link = this.open.get(`${sessionId}\0${event.id}`);
        if (!link) return;
        this.open.delete(`${sessionId}\0${event.id}`);
        if (link.id.startsWith("job:")) return this.jobResult(link.id.slice(4), event.output, ts);
        const rec = this.records.get(link.id);
        if (!rec) return;
        const out = obj(event.output);
        const detached = rec.via === "task" && typeof out?.jobId === "string" && out.status !== undefined && rec.background === true;
        if (detached) {
          this.jobs.set(String(out!.jobId), link.id);
          const status = String(out!.status);
          if (status === "completed" || status === "failed" || status === "cancelled" || status === "orphaned") this.jobResult(String(out!.jobId), event.output, ts);
          return;
        }
        if (rec.via === "fleet") {
          const s = String(out?.status ?? "completed");
          return this.finish(link.id, s === "completed" ? "done" : s === "aborted" || s === "cancelled" ? "cancelled" : "failed", ts, excerptOf(event.output));
        }
        if (rec.via === "coding") {
          const s = String(out?.status ?? "completed");
          return this.finish(link.id, s === "completed" ? "done" : "failed", ts, excerptOf(event.output));
        }
        if (rec.via === "task") {
          const s = String(out?.status ?? "completed");
          return this.finish(link.id, s === "completed" ? "done" : s === "cancelled" ? "cancelled" : "failed", ts, excerptOf(event.output));
        }
        return this.finish(link.id, "done", ts, excerptOf(event.output) || "Sent");
      }
      case "tool_error": {
        const link = this.open.get(`${sessionId}\0${event.id}`);
        if (!link) return;
        this.open.delete(`${sessionId}\0${event.id}`);
        if (link.id.startsWith("job:")) return;
        const msg = scrub(event.error, EXCERPT_CAP);
        const cancelled = /\bcancel(?:led|ed)\b|interrupted|stopped by owner|aborted/i.test(msg);
        this.finish(link.id, cancelled ? "cancelled" : "failed", ts, msg || (cancelled ? "Cancelled" : "Failed"));
        return;
      }
      case "subagent_start": {
        const id = `${sessionId}:sub:${event.id}`;
        if (this.records.has(id)) return;
        this.commit({
          id, rev: 0, via: "subagent", from: agent,
          to: { id: `sub:${String(event.name).toLowerCase().slice(0, 60)}`, name: prettyType(String(event.name).slice(0, 60)), kind: "subagent" },
          task: scrub(event.description, TASK_CAP) || "A check",
          status: "running", at: ts, sessionId,
        });
        return;
      }
      case "subagent_end": {
        const id = `${sessionId}:sub:${event.id}`;
        const status = event.status === "completed" ? "done" : event.status === "cancelled" ? "cancelled" : "failed";
        this.finish(id, status, ts, scrubBlock(event.summary, EXCERPT_CAP));
        return;
      }
      case "input_admitted": {
        const family = parseFamilyInbound(textOf(event.userMessage));
        if (!family) return;
        const id = `${sessionId}:in:${String(event.inputId ?? ts)}`;
        if (this.records.has(id)) return;
        this.commit({
          id, rev: 0, via: "family", from: personParty(family.from), to: agent,
          task: scrub(family.text, TASK_CAP) || "A message",
          ...(family.text.length > TASK_CAP ? { brief: scrub(family.text, BRIEF_CAP) } : {}),
          status: "running", at: ts, sessionId,
        });
        const list = this.inbound.get(sessionId) ?? [];
        list.push(id);
        this.inbound.set(sessionId, list.slice(-8));
        return;
      }
      case "message_done": {
        if (event.message?.role !== "assistant") return;
        const t = textOf(event.message);
        if (t.trim()) this.lastSaid.set(sessionId, t);
        return;
      }
      case "turn_end": {
        const ids = this.inbound.get(sessionId);
        if (ids?.length) {
          const said = scrubBlock(this.lastSaid.get(sessionId), EXCERPT_CAP);
          const status: HandoffStatus = event.status === "failed" ? "failed" : event.status === "interrupted" ? "cancelled" : "done";
          for (const id of ids) this.finish(id, status, ts, said || undefined);
          this.inbound.delete(sessionId);
        }
        this.lastSaid.delete(sessionId);
        // Calls that were open when the turn ended without a result never will
        // get one (the owner stopped it, or it died): close them, but leave
        // detached background jobs alone — they outlive the turn by design.
        for (const [key, link] of [...this.open]) {
          if (link.sessionId !== sessionId || link.id.startsWith("job:")) continue;
          const rec = this.records.get(link.id);
          this.open.delete(key);
          if (!rec || rec.status !== "running" || rec.background) continue;
          this.finish(link.id, event.status === "interrupted" ? "cancelled" : "failed", ts, event.status === "interrupted" ? "Stopped before it finished" : "The turn ended before it came back");
        }
        return;
      }
      default:
        return;
    }
  }

  /** A TaskOutput / KillTask result: update the detached Task it names. */
  private jobResult(jobId: string, output: unknown, ts: number): void {
    const recId = this.jobs.get(jobId);
    if (!recId) return;
    const o = obj(output);
    const status = String(o?.status ?? "");
    if (status === "completed") this.finish(recId, "done", ts, excerptOf(o?.result ?? o));
    else if (status === "failed" || status === "orphaned") this.finish(recId, "failed", ts, excerptOf(o?.error ?? o?.result) || "The background task failed");
    else if (status === "cancelled") this.finish(recId, "cancelled", ts, "Cancelled");
  }

  /** The records a client asked for, oldest first. With a cursor: the changes
   *  after it, oldest change first, `cursor` advancing as far as the page goes.
   *  Without one: the newest `limit` handoffs. */
  list(q: TimelineQuery = {}): { events: Handoff[]; more: boolean; cursor: number } {
    const now = this.now();
    const since = q.since ?? 0;
    const limit = Math.min(TIMELINE_MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? TIMELINE_DEFAULT_LIMIT)));
    let rows = [...this.records.values()].filter((r) => r.rev > since);
    if (q.agent) rows = rows.filter((r) => r.from.id === q.agent || r.to.id === q.agent);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    let page: Handoff[];
    let more: boolean;
    let cursor = this.revision;
    if (since > 0) {
      rows.sort((a, b) => a.rev - b.rev);
      more = rows.length > limit;
      page = more ? rows.slice(0, limit) : rows;
      if (more) cursor = page[page.length - 1]!.rev;
    } else {
      rows.sort((a, b) => a.at - b.at || a.rev - b.rev);
      more = rows.length > limit;
      page = more ? rows.slice(rows.length - limit) : rows;
    }
    page.sort((a, b) => a.at - b.at || a.rev - b.rev);
    return {
      events: page.map((r) => {
        const copy = publicOf(r);
        if (copy.status === "running" && now - copy.at > STALE_AFTER_MS) copy.stale = true;
        return copy;
      }),
      more,
      cursor,
    };
  }

  /** Every agent that appears in the store, for the client's filter chips. */
  agents(): Party[] {
    const seen = new Map<string, Party>();
    for (const r of this.records.values()) {
      for (const p of [r.from, r.to]) if (p.kind === "agent" && !seen.has(p.id)) seen.set(p.id, { ...p });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolves when the revision passes `since`, or after `ms`. */
  waitForChange(since: number, ms: number, signal?: { aborted: boolean; addEventListener?: (t: "abort", f: () => void) => void }): Promise<void> {
    if (this.revision > since || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let off: () => void = () => {};
      const timer = setTimeout(() => { off(); resolve(); }, ms);
      off = this.onChange(() => {
        if (this.revision > since) { clearTimeout(timer); off(); resolve(); }
      });
      signal?.addEventListener?.("abort", () => { clearTimeout(timer); off(); resolve(); });
    });
  }
}

// ─── the tracker ──────────────────────────────────────────────────────────

/** The slice of SessionManager the tracker drives (tests pass a fake). */
export interface TimelineSessionHost {
  list(): Array<{ id: string; busy?: boolean; tenant?: { role?: string } }>;
  attach(sessionId: string, subscriber: (event: TurnEvent) => void): () => void;
}

export interface TimelineApiOptions {
  home: string;
  /** Who a session belongs to: a persona, or the default assistant. */
  agentOf: (sessionId: string) => Party;
  log?: (line: string) => void;
  now?: () => number;
  /** How often new sessions are noticed, ms. 0 disables the timer (tests call sync()). */
  syncEveryMs?: number;
  /** Bytes of each rollout's tail replayed at boot. */
  tailBytes?: number;
  /** Most rollouts replayed at boot, newest first. */
  backfillSessions?: number;
  /** Rollouts older than this are not replayed. */
  backfillMaxAgeMs?: number;
}

export interface TimelineApi {
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  store: TimelineStore;
  /** Notice live sessions that are not tracked yet. */
  sync: () => void;
  /** Resolves when the boot-time replay has finished. */
  ready: Promise<void>;
  stop: () => void;
}

const sessionsDirOf = (home: string) => path.join(home, "garrison", "sessions");

/** The newest `bytes` of a rollout as parsed entries (a torn first line is dropped). */
export async function readRolloutTail(file: string, bytes: number): Promise<Array<{ ts?: string; event: TurnEvent }>> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const out: Array<{ ts?: string; event: TurnEvent }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { ts?: unknown; event?: TurnEvent };
        if (entry && typeof entry === "object" && entry.event && typeof entry.event.type === "string") {
          out.push({ ...(typeof entry.ts === "string" ? { ts: entry.ts } : {}), event: entry.event });
        }
      } catch { /* a torn or corrupt line */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class BadQuery extends Error {}

function intParam(url: URL, name: string, lo: number, hi: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new BadQuery(`${name} must be a whole number`);
  return Math.min(hi, Math.max(lo, Number(raw)));
}

const STATUSES = new Set<HandoffStatus>(["running", "done", "failed", "cancelled"]);

export function createTimelineApi(host: TimelineSessionHost, opts: TimelineApiOptions): TimelineApi {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const store = new TimelineStore(now);
  const attached = new Map<string, () => void>();
  const tailBytes = opts.tailBytes ?? 1_500_000;
  const maxSessions = opts.backfillSessions ?? 30;
  const maxAge = opts.backfillMaxAgeMs ?? 14 * 24 * 60 * 60_000;

  const owner = (s: { tenant?: { role?: string } }) => s.tenant?.role !== "guest";

  const replay = async (sessionId: string): Promise<void> => {
    if (!sessionId || path.basename(sessionId) !== sessionId) return;
    const agent = opts.agentOf(sessionId);
    const entries = await readRolloutTail(path.join(sessionsDirOf(opts.home), `${sessionId}.jsonl`), tailBytes);
    for (const { ts, event } of entries) {
      const at = ts ? Date.parse(ts) : NaN;
      store.observe(sessionId, agent, Number.isFinite(at) ? at : now(), event);
    }
  };

  const track = (s: { id: string; busy?: boolean }): void => {
    if (attached.has(s.id)) return;
    let off: () => void;
    try {
      off = host.attach(s.id, (event) => {
        try { store.observe(s.id, opts.agentOf(s.id), now(), event); } catch { /* never break a turn */ }
      });
    } catch {
      return; // not live (yet)
    }
    attached.set(s.id, off);
    // A turn already under way was missed from its start: read it back.
    if (s.busy) void replay(s.id).catch(() => undefined);
  };

  const sync = (): void => {
    let live: Array<{ id: string; busy?: boolean; tenant?: { role?: string } }>;
    try { live = host.list(); } catch { return; }
    const ids = new Set<string>();
    for (const s of live) {
      if (!owner(s)) continue;
      ids.add(s.id);
      track(s);
    }
    for (const [id, off] of [...attached]) {
      if (ids.has(id)) continue;
      try { off(); } catch { /* already gone */ }
      attached.delete(id);
    }
  };

  const backfill = async (): Promise<void> => {
    let live: Array<{ id: string; tenant?: { role?: string } }>;
    try { live = host.list().filter(owner); } catch { return; }
    const dir = sessionsDirOf(opts.home);
    const dated = await Promise.all(
      live.map(async (s) => ({ id: s.id, at: await fs.stat(path.join(dir, `${s.id}.jsonl`)).then((st) => st.mtimeMs).catch(() => 0) })),
    );
    const cutoff = now() - maxAge;
    const recent = dated.filter((d) => d.at > cutoff).sort((a, b) => b.at - a.at).slice(0, maxSessions);
    // Oldest first, so records are created in the order they happened.
    for (const d of recent.reverse()) await replay(d.id).catch(() => undefined);
    log(`timeline: replayed ${recent.length} thread(s), ${store.list({ limit: TIMELINE_MAX_LIMIT }).events.length} handoff(s)`);
  };

  sync();
  const ready = backfill().catch((err) => log(`timeline: replay failed (${err instanceof Error ? err.message : String(err)})`));
  const every = opts.syncEveryMs ?? 3_000;
  const timer = every > 0 ? setInterval(sync, every) : undefined;
  timer?.unref?.();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };

  async function get(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    let since: number | undefined;
    let limit: number | undefined;
    let wait = 0;
    let agent: string | undefined;
    let status: HandoffStatus | undefined;
    try {
      since = intParam(url, "since", 0, Number.MAX_SAFE_INTEGER);
      limit = intParam(url, "limit", 1, TIMELINE_MAX_LIMIT);
      wait = intParam(url, "wait", 0, TIMELINE_MAX_WAIT_MS) ?? 0;
      const a = url.searchParams.get("agent");
      if (a) {
        // eslint-disable-next-line no-control-regex
        if (a.length > 128 || /[\u0000-\u001f]/.test(a)) throw new BadQuery("agent is not a valid id");
        agent = a;
      }
      const s = url.searchParams.get("status");
      if (s) {
        if (!STATUSES.has(s as HandoffStatus)) throw new BadQuery("status must be running, done, failed or cancelled");
        status = s as HandoffStatus;
      }
    } catch (err) {
      if (err instanceof BadQuery) return send(res, 400, { error: err.message });
      throw err;
    }
    // A client that remembers another run of the server starts from the top.
    const presented = url.searchParams.get("epoch");
    const reset = presented !== null && presented !== store.epoch;
    if (reset) since = 0;
    sync();
    // The first answer waits (briefly) for the boot replay so it is not empty.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ready, new Promise<void>((r) => { grace = setTimeout(r, 4_000); grace.unref?.(); })]);
    if (grace) clearTimeout(grace);
    const cursor0 = since ?? 0;
    if (wait > 0 && !reset && since !== undefined) {
      const aborted = { aborted: false, addEventListener: (_t: "abort", f: () => void) => { res.on("close", f); } };
      await store.waitForChange(cursor0, wait, aborted);
    }
    const { events, more, cursor } = store.list({ ...(since !== undefined ? { since } : {}), ...(limit !== undefined ? { limit } : {}), ...(agent ? { agent } : {}), ...(status ? { status } : {}) });
    if (res.destroyed) return;
    send(res, 200, {
      epoch: store.epoch,
      cursor,
      now: now(),
      ...(reset ? { reset: true } : {}),
      ...(more ? { more: true } : {}),
      events,
      agents: store.agents(),
    });
  }

  return {
    store,
    sync,
    ready,
    stop: () => {
      if (timer) clearInterval(timer);
      for (const off of attached.values()) {
        try { off(); } catch { /* already gone */ }
      }
      attached.clear();
    },
    handle: async (req, res, url) => {
      const p = url.pathname.replace(/\/+$/, "");
      if (p !== "/gateway/timeline") return false;
      try {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" }), true;
        await get(req, res, url);
      } catch (err) {
        log(`timeline: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) send(res, 500, { error: "timeline failed" });
      }
      return true;
    },
  };
}
