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
import { loadUiSettings, updateUiSettings } from "../uiSettings.js";

// The library's surface, typed structurally so this file compiles without the
// package being resolvable at build time (it lives in its own repo).
interface OricleLib {
  Oricle: {
    mount(dir: string, o: { principal: string; agent?: string; model?: string; readOnly?: boolean }): Promise<OricleEstate>;
  };
  OricleClient: new (url: string, token: string, o?: { timeoutMs?: number }) => OricleNetClient;
  sync(dir: string, client: OricleNetClient, o?: { direction?: "both" | "push" | "pull"; log?: (l: string) => void }): Promise<OricleSyncReport>;
  clone(dir: string, client: OricleNetClient, o?: { log?: (l: string) => void }): Promise<OricleSyncReport>;
}
interface OricleNetClient {
  base: string;
  health(): Promise<{ ok: true; estate: string }>;
  manifest(): Promise<{ manifest: { id: string; name: string } }>;
  writers(): Promise<{ writers: Record<string, unknown> }>;
}
interface OricleSyncReport {
  estate: string;
  pushed: number;
  pulled: number;
  redactionsApplied: number;
  diverged: { writer: string; reason: string }[];
  errors: string[];
  pulledRecords: OricleRecordLike[];
  at: string;
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
  /** v1.1: fold records another writer appended (a sync just pulled them). */
  absorb?(records: OricleRecordLike[]): number;
  refresh?(): Promise<void>;
  manifest: { id: string; name: string };
}

/** The slice of LiveSession this adapter reads. Structural, so tests pass a stub. */
export interface OricleLive {
  context: { aresHome: string; workspace: string };
  selection: { model: string; provider: { name: string } };
  session: { meta: { id: string }; engine: { history(): ReadonlyArray<{ role: string; content: unknown }> } };
  queueSystemReminder(text: string, kind: "memory" | "instructions", key?: string): void;
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
      const configured = await loadUiSettings().then((s) => s.oricleLibPath).catch(() => undefined);
      const candidates = [process.env["ARES_ORICLE_LIB"], configured, "D:/Oricle/dist/index.js", "F:/Oricle/dist/index.js", "oricle"].filter((c): c is string => !!c);
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
    live.queueSystemReminder(pack.text, "memory", "oricle");
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
    scheduleNetworkPush();
  } catch {
    // never break the loop over memory
  }
}

/**
 * A garrison (remote/Telegram) turn: those sessions never pass through
 * prepareUserTurn/finishTurn, so the estate would never hear them. The owner's
 * remote sends get the same per-session episode card as desktop turns; a
 * guest's conversation stays out of the owner's estate (memory isolation).
 */
export async function oricleRemoteTurn(text: string, tenant: { role: "owner" | "guest" } | undefined, sessionId: string, model?: string, surfaceName = "telegram"): Promise<void> {
  try {
    if (tenant && tenant.role !== "owner") return;
    const clean = text.replace(/^\(System:[\s\S]*?\)\s*/m, "").trim();
    if (!clean) return;
    const est = await oricleEstate(model);
    if (!est || !est.writer) return;
    const ep = episodeState.get(sessionId) ?? { recordId: "", userMessages: [], turns: 0 };
    ep.userMessages.push(clean.slice(0, 220));
    ep.turns += 1;
    const title = ep.userMessages[0]!.slice(0, 80);
    const body = [`Session ${sessionId} (${surfaceName}) · ${ep.turns} turn(s)${model ? ` · ${model}` : ""}.`, ``, `The owner said, in order:`, ...ep.userMessages.slice(-12).map((m, i) => `${Math.max(1, ep.userMessages.length - 11) + i}. ${m}`)].join("\n").slice(0, 2000);
    const [rec] = await est
      .commit({ kind: "episode", title, text: body, tier: "confirmed", tags: ["ares-session", surfaceName], source: { foreign: { system: "ares-session", id: sessionId }, session: sessionId }, ...(ep.recordId ? { supersedes: [ep.recordId] } : {}) })
      .catch(() => [] as OricleRecordLike[]);
    if (rec) ep.recordId = rec.id;
    episodeState.set(sessionId, ep);
    scheduleNetworkPush();
  } catch {
    // never break a remote turn over memory
  }
}

// ── mid-turn checkpoints ─────────────────────────────────────────────────────
//
// The long-horizon review's demand: writes at the moments a long task loses
// the thread, not only at turn end. Every N tool completions, and on every
// context compaction, the most recently advanced open task owned by this
// writer gets its card re-stamped (lastAction, asOf.commit=HEAD) and a
// `checkpoint` record linked to it. Cheap, best-effort, never blocks the loop.

function checkpointEveryTools(): number {
  const n = Number(process.env["ARES_ORICLE_CHECKPOINT_TOOLS"]);
  return Number.isFinite(n) && n > 0 ? n : 25;
}
const toolCounts = new WeakMap<object, number>();
let checkpointing: Promise<void> | null = null;

export function oricleOnSessionEvent(live: OricleLive, ev: { type: string; name?: string }): void {
  if (!oricleEnabled()) return;
  let reason: string | null = null;
  if (ev.type === "tool_end") {
    const n = (toolCounts.get(live) ?? 0) + 1;
    toolCounts.set(live, n);
    if (n % checkpointEveryTools() === 0) reason = `${n} tool calls this turn`;
  } else if (ev.type === "compaction") {
    reason = "context compacted";
  } else if (ev.type === "turn_start") {
    toolCounts.set(live, 0);
  }
  if (!reason) return;
  const why = reason;
  // serialize: one checkpoint at a time per process
  checkpointing = (checkpointing ?? Promise.resolve()).then(() => writeCheckpoint(live, why)).catch(() => undefined);
}

async function writeCheckpoint(live: OricleLive, reason: string): Promise<void> {
  const est = await oricleEstate(live.selection.model);
  if (!est || !est.writer) return;
  const mine = est.openTasks().filter((t) => (t.data as { owner?: { writer?: string } } | undefined)?.owner?.writer === est.writer!.id);
  const target = (mine.length ? mine : est.openTasks()).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  if (!target) return;
  const head = await workspaceHead(live.context.workspace);
  const at = new Date().toISOString();
  const advanced = await est.task({ id: target.id, data: { lastAction: { text: `checkpoint: ${reason}`, at, ...(head ? { commit: head } : {}) }, ...(head ? { asOf: { commit: head } } : {}) } });
  await est.commit({ kind: "checkpoint", text: `${reason} · session ${live.session.meta.id}${head ? ` · HEAD ${head.slice(0, 10)}` : ""}`, tier: "confirmed", links: [advanced.id], source: { session: live.session.meta.id, ...(head ? { commit: head } : {}) }, tags: ["auto-checkpoint"] });
  scheduleNetworkPush();
}

// ── the Ares network ─────────────────────────────────────────────────────────
//
// One hosted estate (`oricle serve` on the owner's laptop, tunneled to his
// domain) that every Ares instance plugs into. Connect = verify the door,
// clone the estate if this machine has none, otherwise sync; then keep
// syncing: a debounced push a few seconds after every write this process
// makes, and a full push+pull on a timer so other instances' records arrive.
// All best-effort and off the turn path: memory never blocks a reply.

export interface AresNetworkStatus {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  busy: boolean;
  url: string;
  estateDir: string;
  estateId?: string;
  estateName?: string;
  records?: number;
  writers?: number;
  lastSyncAt?: number;
  lastPushed?: number;
  lastPulled?: number;
  totalPushed: number;
  totalPulled: number;
  error?: string;
  libFound: boolean;
}

interface NetState {
  url: string;
  token: string;
  client: OricleNetClient;
  timer?: ReturnType<typeof setInterval>;
  pushTimer?: ReturnType<typeof setTimeout>;
  syncing: Promise<void> | null;
  connected: boolean;
  estateId?: string;
  estateName?: string;
  writers?: number;
  lastSyncAt?: number;
  lastPushed?: number;
  lastPulled?: number;
  totalPushed: number;
  totalPulled: number;
  error?: string;
}
let net: NetState | null = null;
let netEnabled = false;
let netUrl = "";
const netListeners = new Set<(s: AresNetworkStatus) => void>();

function syncEveryMs(): number {
  const n = Number(process.env["ARES_NETWORK_SYNC_MS"]);
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
}
const PUSH_DEBOUNCE_MS = 4_000;

/** Subscribe to status changes (the daemon forwards them to the UI). */
export function onAresNetworkStatus(fn: (s: AresNetworkStatus) => void): () => void {
  netListeners.add(fn);
  return () => netListeners.delete(fn);
}

async function emitNetStatus(): Promise<void> {
  const s = await aresNetworkStatus();
  for (const fn of netListeners) {
    try {
      fn(s);
    } catch {
      /* a listener never breaks the loop */
    }
  }
}

export async function aresNetworkStatus(): Promise<AresNetworkStatus> {
  const dir = oricleDir();
  const L = await lib();
  let records: number | undefined;
  let estateId = net?.estateId;
  let estateName = net?.estateName;
  if (handle) {
    const st = handle.est.status() as { records?: number; id?: string; name?: string };
    records = st.records;
    estateId ??= st.id;
    estateName ??= st.name;
  }
  return {
    configured: netUrl.length > 0,
    enabled: netEnabled,
    connected: net?.connected === true,
    busy: net?.syncing !== null && net?.syncing !== undefined,
    url: net?.url ?? netUrl,
    estateDir: dir,
    ...(estateId ? { estateId } : {}),
    ...(estateName ? { estateName } : {}),
    ...(records !== undefined ? { records } : {}),
    ...(net?.writers !== undefined ? { writers: net.writers } : {}),
    ...(net?.lastSyncAt ? { lastSyncAt: net.lastSyncAt } : {}),
    ...(net?.lastPushed !== undefined ? { lastPushed: net.lastPushed } : {}),
    ...(net?.lastPulled !== undefined ? { lastPulled: net.lastPulled } : {}),
    totalPushed: net?.totalPushed ?? 0,
    totalPulled: net?.totalPulled ?? 0,
    ...(net?.error ? { error: net.error } : {}),
    libFound: L !== null,
  };
}

/**
 * Connect this instance to the network. Verifies the door, clones the estate
 * when this machine has none, syncs, mounts, and starts the sync loop. The
 * url/token persist (token encrypted) so the next boot reconnects itself.
 */
export async function aresNetworkConnect(o: { url: string; token: string; persist?: boolean }): Promise<AresNetworkStatus> {
  const url = o.url.trim().replace(/\/+$/, "");
  const token = o.token.trim();
  if (!/^https?:\/\//.test(url)) throw new Error("the network URL must start with http:// or https://");
  if (token.length < 8) throw new Error("the network token looks too short");
  const L = await lib();
  if (!L) throw new Error("the Oricle library is not installed on this machine (set the library path in Settings → Consciousness, or ARES_ORICLE_LIB)");
  if (typeof L.OricleClient !== "function" || typeof L.sync !== "function") throw new Error("this Oricle library predates the network layer; update D:/Oricle (git pull && pnpm test)");
  await aresNetworkDisconnect({ persist: false });
  const client = new L.OricleClient(url, token, { timeoutMs: 60_000 });
  const health = await client.health();
  const remote = await client.manifest();
  const dir = oricleDir();
  let hasLocal = true;
  try {
    await fs.access(path.join(dir, "manifest.json"));
  } catch {
    hasLocal = false;
  }
  const state: NetState = { url, token, client, syncing: null, connected: false, totalPushed: 0, totalPulled: 0, estateId: remote.manifest.id, estateName: remote.manifest.name };
  net = state;
  netUrl = url;
  netEnabled = true;
  if (!hasLocal) {
    const rep = await L.clone(dir, client, { log: netLog });
    state.totalPulled += rep.pulled;
    state.lastPulled = rep.pulled;
    state.lastSyncAt = Date.now();
    netLog(`cloned ${health.estate} (${rep.pulled} records) into ${dir}`);
  }
  state.connected = true;
  if (o.persist !== false) await updateUiSettings({ aresNetworkUrl: url, aresNetworkToken: token, aresNetworkEnabled: true }).catch(() => undefined);
  await runSync("connect");
  state.timer = setInterval(() => void runSync("timer"), syncEveryMs());
  state.timer.unref?.();
  return aresNetworkStatus();
}

export async function aresNetworkDisconnect(o: { persist?: boolean } = {}): Promise<AresNetworkStatus> {
  if (net) {
    if (net.timer) clearInterval(net.timer);
    if (net.pushTimer) clearTimeout(net.pushTimer);
    await (net.syncing ?? Promise.resolve()).catch(() => undefined);
    net = null;
  }
  netEnabled = false;
  if (o.persist !== false) await updateUiSettings({ aresNetworkEnabled: false }).catch(() => undefined);
  await emitNetStatus();
  return aresNetworkStatus();
}

/** A full push+pull now (the "Sync now" button). */
export async function aresNetworkSyncNow(): Promise<AresNetworkStatus> {
  await runSync("manual");
  return aresNetworkStatus();
}

/** Boot: reconnect if the owner left the network on. Never throws. */
export async function startAresNetworkFromSettings(): Promise<void> {
  try {
    const s = await loadUiSettings();
    netUrl = s.aresNetworkUrl ?? "";
    if (s.aresNetworkEnabled !== true || !s.aresNetworkUrl || !s.aresNetworkToken) return;
    await aresNetworkConnect({ url: s.aresNetworkUrl, token: s.aresNetworkToken, persist: false });
  } catch (err) {
    if (net) net.error = (err as Error).message;
    netLog(`reconnect failed: ${(err as Error).message}`);
    await emitNetStatus();
  }
}

/** Called after every local write: push a few seconds later, coalescing bursts. */
export function scheduleNetworkPush(): void {
  if (!net || !net.connected) return;
  if (net.pushTimer) clearTimeout(net.pushTimer);
  net.pushTimer = setTimeout(() => void runSync("push"), PUSH_DEBOUNCE_MS);
  net.pushTimer.unref?.();
}

async function runSync(reason: "connect" | "timer" | "manual" | "push"): Promise<void> {
  const state = net;
  if (!state) return;
  if (state.syncing) {
    if (reason === "push") return; // a running sync will carry the write
    await state.syncing.catch(() => undefined);
  }
  const L = await lib();
  if (!L) return;
  const job = (async () => {
    try {
      const rep = await L.sync(oricleDir(), state.client, { direction: reason === "push" ? "push" : "both", log: netLog });
      state.lastSyncAt = Date.now();
      state.lastPushed = rep.pushed;
      state.lastPulled = rep.pulled;
      state.totalPushed += rep.pushed;
      state.totalPulled += rep.pulled;
      state.connected = true;
      state.error = rep.errors[0] ?? (rep.diverged[0] ? `writer ${rep.diverged[0].writer} diverged: ${rep.diverged[0].reason}` : undefined);
      if (rep.pulled > 0 && handle) {
        // Fold what arrived into the live mount so the next pack sees it.
        if (typeof handle.est.absorb === "function") handle.est.absorb(rep.pulledRecords);
        else if (typeof handle.est.refresh === "function") await handle.est.refresh();
      }
      try {
        state.writers = Object.keys((await state.client.writers()).writers).length;
      } catch {
        /* status only */
      }
    } catch (err) {
      state.error = (err as Error).message;
      state.connected = false;
      netLog(`sync (${reason}) failed: ${(err as Error).message}`);
    }
  })();
  state.syncing = job;
  await job;
  if (net === state) state.syncing = null;
  await emitNetStatus();
}

function netLog(line: string): void {
  process.stderr.write(`ares-network: ${line}\n`);
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
