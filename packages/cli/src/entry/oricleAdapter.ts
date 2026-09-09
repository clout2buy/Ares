// Oricle adapter — Ares as the first client of the estate.
//
// Oricle (F:\Oricle, `oricle` package) is the standalone, inheritable memory
// estate. Ares imports it; it never imports Ares. This module is the ONLY
// place Ares touches it, and every call is best-effort: a missing library, a
// missing estate, or a locked writer degrades to "no estate this turn" with
// one warning, never a broken turn.
//
// What crosses the seam, per the architecture map (F:\Oricle\ARCHITECTURE.md §9):
//   before a turn  → pack(): rules, preferences, open TASK cards (whole),
//                    recent episodes, query recall → one system reminder
//   after a turn   → attest(): which injected ids the reply cited;
//                    accepted Witness candidates → inferred fact/preference/insight;
//                    the session's episode card upserted (superseded) each turn
//   as a tool      → Estate: recall / history / about / tasks / task / commit / status
//
// Config: ARES_ORICLE=0 disables. ARES_ORICLE_DIR (default ORICLE_DIR, then
// ~/Oricle) is the estate. ARES_ORICLE_LIB points at the built library
// (default F:/Oricle/dist/index.js, then bare `oricle`). ARES_ORICLE_PACK_TOKENS
// (default 1500) budgets the pack.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { buildTool } from "@ares/tools";

// The library's surface, typed structurally so this file compiles without the
// package being resolvable at build time (it lives on another drive).
interface OricleLib {
  Oricle: {
    mount(dir: string, o: { principal: string; agent?: string; model?: string; readOnly?: boolean }): Promise<OricleEstate>;
  };
}
interface OricleRecordLike {
  id: string;
  kind: string;
  text: string;
  title?: string;
  tier: string;
  status?: string;
  ts: string;
  supersedes?: string[];
  data?: Record<string, unknown>;
  source?: { foreign?: { system: string; id: string } };
}
interface OricleEstate {
  writer: { id: string } | null;
  truth: { all: OricleRecordLike[] };
  commit(input: unknown): Promise<OricleRecordLike[]>;
  task(u: unknown): Promise<OricleRecordLike>;
  recall(q: string, o?: unknown): Array<{ record: OricleRecordLike; score: number; superseded: boolean; supersededBy?: string[] }>;
  history(id: string): { chain: OricleRecordLike[] };
  about(ref: string): OricleRecordLike[];
  openTasks(): OricleRecordLike[];
  pack(req: { budgetTokens: number; query?: string; activeProject?: string; head?: string; worldDelta?: string; agent?: string }): Promise<{ text: string; tokens: number; included: string[]; dropped: string[]; packId: string; truncatedCore: boolean }>;
  attest(packId: string, outcomes: Array<{ recordId: string; outcome: "cited" | "ignored" | "contradicted" }>, turnResult?: "ok" | "failed" | "unknown"): Promise<void>;
  render(months?: Set<string>): Promise<string[]>;
  status(): unknown;
  close(): Promise<void>;
}

/** The slice of LiveSession this adapter reads. Structural, so tests pass a stub. */
export interface OricleLive {
  context: { aresHome: string; workspace: string };
  selection: { model: string; provider: { name: string } };
  session: { meta: { id: string }; engine: { history(): ReadonlyArray<{ role: string; content: unknown }> } };
  queueSystemReminder(text: string, kind: "memory" | "instructions"): void;
}

export function oricleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ARES_ORICLE"] !== "0";
}

export function oricleDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["ARES_ORICLE_DIR"] ?? env["ORICLE_DIR"] ?? path.join(os.homedir(), "Oricle");
}

function packBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["ARES_ORICLE_PACK_TOKENS"]);
  return Number.isFinite(n) && n > 100 ? n : 1500;
}

function surface(): string {
  return process.argv.some((a) => a === "daemon" || a.endsWith("daemon.js")) ? "daemon" : "cli";
}

let libPromise: Promise<OricleLib | null> | null = null;
async function lib(): Promise<OricleLib | null> {
  if (!libPromise) {
    libPromise = (async () => {
      const candidates = [process.env["ARES_ORICLE_LIB"], "F:/Oricle/dist/index.js", "oricle"].filter((c): c is string => !!c);
      for (const c of candidates) {
        try {
          const spec = c.includes("/") || c.includes("\\") ? pathToFileURL(path.resolve(c)).href : c;
          const m = (await import(spec)) as Partial<OricleLib>;
          if (typeof m?.Oricle?.mount === "function") return m as OricleLib;
        } catch {
          /* next */
        }
      }
      return null;
    })();
  }
  return libPromise;
}

interface Handle {
  est: OricleEstate;
  dir: string;
  mountedAt: number;
  readOnly: boolean;
}
let handle: Handle | null = null;
let warned = false;
const REMOUNT_MS = 60_000;

/** Mount once per process (refreshed every minute so other writers' records appear). Null = no estate this turn. */
export async function oricleEstate(model?: string): Promise<OricleEstate | null> {
  if (!oricleEnabled()) return null;
  const dir = oricleDir();
  try {
    await fs.access(path.join(dir, "manifest.json"));
  } catch {
    return null;
  }
  if (handle && handle.dir === dir && Date.now() - handle.mountedAt < REMOUNT_MS) return handle.est;
  const L = await lib();
  if (!L) {
    if (!warned) {
      warned = true;
      process.stderr.write("oricle: estate found but the library is not importable (set ARES_ORICLE_LIB); memory estate disabled this process\n");
    }
    return null;
  }
  if (handle) await handle.est.close().catch(() => undefined);
  handle = null;
  const agent = `ares-${surface()}`;
  try {
    const est = await L.Oricle.mount(dir, { principal: "owner", agent, ...(model ? { model } : {}) });
    handle = { est, dir, mountedAt: Date.now(), readOnly: false };
    return est;
  } catch (err) {
    // Locked writer (another Ares process on this machine) → read-only.
    try {
      const est = await L.Oricle.mount(dir, { principal: "owner", agent, readOnly: true, ...(model ? { model } : {}) });
      handle = { est, dir, mountedAt: Date.now(), readOnly: true };
      if (!warned) {
        warned = true;
        process.stderr.write(`oricle: mounted read-only (${(err as Error).message.split("\n")[0]})\n`);
      }
      return est;
    } catch (e2) {
      if (!warned) {
        warned = true;
        process.stderr.write(`oricle: could not mount ${dir}: ${(e2 as Error).message}\n`);
      }
      return null;
    }
  }
}

export async function closeOricle(): Promise<void> {
  if (handle) await handle.est.close().catch(() => undefined);
  handle = null;
}

/** Best-effort: the workspace's git HEAD, so a task's asOf.commit can be compared. */
export async function workspaceHead(workspace: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(path.join(workspace, ".git", "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(4).trim();
    return (await fs.readFile(path.join(workspace, ".git", ref), "utf8")).trim();
  } catch {
    return undefined;
  }
}

// Per-live-session state: the last pack's ids for attestation, the session's episode card.
const turnState = new WeakMap<object, { packId: string; included: string[] }>();
const episodeState = new Map<string, { recordId: string; userMessages: string[]; turns: number }>();

export async function oricleBeforeTurn(live: OricleLive, userMessage: string): Promise<void> {
  try {
    const est = await oricleEstate(live.selection.model);
    if (!est) return;
    const head = await workspaceHead(live.context.workspace);
    const pack = await est.pack({ budgetTokens: packBudget(), query: userMessage.slice(0, 400), ...(head ? { head } : {}) });
    if (pack.included.length === 0) return;
    live.queueSystemReminder(pack.text, "memory");
    turnState.set(live, { packId: pack.packId, included: pack.included });
  } catch {
    // never break a turn over memory
  }
}

export interface WitnessAccepted {
  id: string;
  content: string;
  tags?: string[];
}

function witnessKind(tags: string[] | undefined): { kind: string; status?: string } | null {
  const t = tags ?? [];
  if (t.includes("crucible:user_fact")) return { kind: "fact" };
  if (t.includes("crucible:feedback") || t.includes("crucible:procedure")) return { kind: "preference" };
  if (t.includes("crucible:belief")) return { kind: "insight" };
  return null;
}

export async function oricleAfterTurn(
  live: OricleLive,
  finalStatus: "completed" | "interrupted" | "failed",
  opts: { userMessage?: string; assistantText?: string; accepted?: WitnessAccepted[] } = {},
): Promise<void> {
  try {
    const est = await oricleEstate(live.selection.model);
    if (!est || !est.writer) return;
    // 1. attest: which injected ids did the reply cite?
    const ts = turnState.get(live);
    if (ts) {
      turnState.delete(live);
      const text = opts.assistantText ?? "";
      const outcomes = ts.included.map((id) => ({ recordId: id, outcome: text.includes(id) ? ("cited" as const) : ("ignored" as const) }));
      await est.attest(ts.packId, outcomes, finalStatus === "completed" ? "ok" : finalStatus === "failed" ? "failed" : "unknown");
    }
    if (finalStatus === "interrupted") return;
    // 2. accepted Witness candidates → inferred records, idempotent by foreign id
    const known = new Set<string>();
    for (const r of est.truth.all) if (r.source?.foreign?.system === "ares-mind") known.add(r.source.foreign.id);
    for (const c of opts.accepted ?? []) {
      if (known.has(c.id)) continue;
      const k = witnessKind(c.tags);
      if (!k) continue;
      await est
        .commit({ kind: k.kind, text: c.content.slice(0, 2000), tier: "inferred", tags: ["witness"], source: { foreign: { system: "ares-mind", id: c.id }, session: live.session.meta.id } })
        .catch(() => undefined);
    }
    // 3. the session's episode card, superseded each turn (state lane)
    if (opts.userMessage) {
      const sid = live.session.meta.id;
      const ep = episodeState.get(sid) ?? { recordId: "", userMessages: [], turns: 0 };
      ep.userMessages.push(opts.userMessage.slice(0, 220));
      ep.turns += 1;
      const title = ep.userMessages[0]!.slice(0, 80);
      const body = [`Session ${sid} · ${ep.turns} turn(s) · ${live.selection.provider.name}/${live.selection.model}.`, ``, `The owner said, in order:`, ...ep.userMessages.slice(-12).map((m, i) => `${Math.max(1, ep.userMessages.length - 11) + i}. ${m}`)].join("\n").slice(0, 2000);
      const [rec] = await est
        .commit({ kind: "episode", title, text: body, tier: "confirmed", tags: ["ares-session"], source: { foreign: { system: "ares-session", id: sid }, session: sid }, ...(ep.recordId ? { supersedes: [ep.recordId] } : {}) })
        .catch(() => [] as OricleRecordLike[]);
      if (rec) ep.recordId = rec.id;
      episodeState.set(sid, ep);
    }
    await est.render(new Set([new Date().toISOString().slice(0, 7)])).catch(() => undefined);
  } catch {
    // never break the loop over memory
  }
}

// ── the Estate tool ──────────────────────────────────────────────────────────

const estateInput = z
  .object({
    action: z.enum(["recall", "history", "about", "tasks", "task", "commit", "status"]).describe("Estate operation."),
    query: z.string().optional().describe("recall: free-text query. about: an entity name or alias."),
    id: z.string().optional().describe("history: a record id. task: the task id to advance (omit to create)."),
    kind: z.enum(["fact", "event", "decision", "preference", "failure", "build", "voice", "letter"]).optional().describe("commit: record kind."),
    text: z.string().optional().describe("commit/task: the memory text (one idea, ≤2000 chars)."),
    title: z.string().optional(),
    goal: z.string().optional().describe("task: the goal (required to create)."),
    status: z.string().optional().describe("task: planned|active|blocked|waiting|done|abandoned. failure: open|fixed|wontfix."),
    next: z.string().optional().describe("task: the next action."),
    step: z.string().optional().describe("task: the current step."),
    blocker: z.string().optional().describe("task: 'signature: description' of what blocks it."),
    commit_sha: z.string().optional().describe("task: the commit the state is true at."),
    supersedes: z.array(z.string()).optional().describe("commit: ids whose truth this replaces."),
    limit: z.number().int().min(1).max(30).optional(),
    include_superseded: z.boolean().optional(),
  })
  .strict();

export function makeEstateTool(getModel: () => string | undefined) {
  return buildTool({
    name: "Estate",
    description:
      "Oricle: the owner's permanent, inheritable memory estate (outlives this session and this model). " +
      "Use recall for anything from the past ('why did we decide…', 'what is the kid's due date'), history to see how a fact changed, about for everything on a person or project, " +
      "tasks/task to read and ADVANCE long-running work (write a task at plan time, on every step or blocker change, and before you stop), commit to record a durable fact, decision, failure signature or build. " +
      "Records you write land as inferred; the owner confirms. Never put secrets or raw error dumps in text.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: estateInput,
    activityDescription: (i) => `Estate ${i.action}${i.query ? ": " + i.query.slice(0, 60) : i.id ? " " + i.id : ""}`,

    async call(i): Promise<{ output: unknown; display: string }> {
      const est = await oricleEstate(getModel());
      if (!est) return { output: { ok: false, note: "no estate mounted (ARES_ORICLE_DIR / library)" }, display: "Estate unavailable: no estate mounted." };
      const limit = i.limit ?? 8;
      switch (i.action) {
        case "status":
          return { output: est.status(), display: JSON.stringify(est.status()) };
        case "recall": {
          if (!i.query) throw new Error("recall needs query");
          const hits = est.recall(i.query, { limit, includeSuperseded: i.include_superseded ?? false });
          const rows = hits.map((h) => ({ id: h.record.id, kind: h.record.kind, tier: h.record.tier, status: h.record.status, title: h.record.title, text: h.record.text, superseded: h.superseded, supersededBy: h.supersededBy }));
          return { output: rows, display: rows.length ? rows.map((r) => `${r.id} · ${r.kind} · ${(r.title ? r.title + " — " : "") + r.text.slice(0, 120)}${r.superseded ? " (superseded)" : ""}`).join("\n") : "nothing in the estate matches" };
        }
        case "history": {
          if (!i.id) throw new Error("history needs id");
          const h = est.history(i.id);
          const rows = h.chain.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, tier: r.tier, status: r.status, text: r.text, supersedes: r.supersedes }));
          return { output: rows, display: rows.map((r) => `${r.ts.slice(0, 16)} ${r.id} ${r.supersedes ? "← " + r.supersedes.join(",") : ""} · ${r.text.slice(0, 120)}`).join("\n") };
        }
        case "about": {
          if (!i.query) throw new Error("about needs query (entity name)");
          const rs = est.about(i.query).slice(0, limit * 2);
          return { output: rs.map((r) => ({ id: r.id, kind: r.kind, text: r.text })), display: rs.length ? rs.map((r) => `${r.id} · ${r.kind} · ${r.text.slice(0, 120)}`).join("\n") : `no entity "${i.query}" (commit one first)` };
        }
        case "tasks": {
          const ts = est.openTasks();
          return { output: ts.map((t) => ({ id: t.id, status: t.status, title: t.title, data: t.data })), display: ts.length ? ts.map((t) => `${t.id} · ${t.status} · ${t.title} · next: ${(t.data as { nextAction?: string } | undefined)?.nextAction ?? "—"}`).join("\n") : "no open tasks" };
        }
        case "task": {
          if (!est.writer) throw new Error("estate is read-only in this process");
          const data: Record<string, unknown> = {};
          if (i.goal) data["goal"] = i.goal;
          if (i.next) data["nextAction"] = i.next;
          if (i.step) data["currentStep"] = i.step;
          if (i.commit_sha) data["asOf"] = { commit: i.commit_sha };
          if (i.blocker) data["blockers"] = [{ signature: i.blocker.split(":")[0]!.trim().slice(0, 60), text: i.blocker.slice(0, 300), since: new Date().toISOString() }];
          const rec = await est.task({ ...(i.id ? { id: i.id } : {}), ...(i.status ? { status: i.status } : {}), ...(i.title ? { title: i.title } : {}), ...(i.text ? { text: i.text } : {}), data });
          return { output: { id: rec.id, status: rec.status, title: rec.title }, display: `task ${rec.id} · ${rec.status} · ${rec.title}` };
        }
        case "commit": {
          if (!est.writer) throw new Error("estate is read-only in this process");
          if (!i.kind || !i.text) throw new Error("commit needs kind and text");
          const [rec] = await est.commit({ kind: i.kind, text: i.text, ...(i.title ? { title: i.title } : {}), ...(i.status ? { status: i.status } : {}), ...(i.supersedes ? { supersedes: i.supersedes } : {}), tags: ["estate-tool"] });
          return { output: { id: rec!.id, kind: rec!.kind, tier: rec!.tier }, display: `committed ${rec!.id} (${rec!.kind}, ${rec!.tier})` };
        }
      }
    },
  });
}
