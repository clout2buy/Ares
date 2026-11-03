import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPaths, aresAgentHome } from "./paths.js";
import { readTextIfExists, writeFileAtomic } from "./files.js";
import { expandHomePath, type AresAgentConfig } from "./config.js";
import { createMemoryStore } from "./memory/vectorStore.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { loadSelfModel } from "./self/store.js";
import { reflect } from "./self/reflect.js";
import { gainForTarget } from "./voice.js";
import {
  MemoryRouter,
  MemoryStore as LivingMemoryStore,
  OWNER_SCOPE,
  curatedTypeOf,
  isOperationalNoise,
  isRawQuote,
  mergeCuratedFacts,
  mergeDurableFacts,
  migrateLegacyVectors,
  mindPaths,
  renderCuratedMemory,
  type CuratedFact,
  type DurableFact,
} from "@ares/mind";
import { runSelfFileRefresh, type SelfFileRewriter, type SelfRefreshResult } from "./selfRefresh.js";

const DREAM_MEMORY_ITEM_CHARS = 420;
const DREAM_MEMORY_MAX_ITEMS = 120;

export interface DreamResult {
  phase: "light" | "deep" | "rem";
  promoted: number;
  pruned: number;
  report: string;
  /** DEEP only: the weekly self-file refresh, when it ran. */
  selfRefresh?: SelfRefreshResult;
}

/**
 * The model behind a deep dream (the daemon supplies it; garrison/CLI may
 * not). `distill` turns staged session notes into typed facts — called ONLY
 * when something is staged, so an idle night costs no model call.
 * `rewriteSelfFile` writes the weekly IDENTITY/USER proposal.
 */
export interface DreamModel {
  distill?: (notes: readonly string[]) => Promise<DurableFact[]>;
  rewriteSelfFile?: SelfFileRewriter;
}

/** Light dreaming's raw session notes, waiting for a model to distill them.
 *  JSONL of {at, sessionId, text}; consumed by the next deep dream. */
export function dreamStagingFile(home: string): string {
  return path.join(agentPaths(home).memoryDir, ".dream-staged.jsonl");
}

/** Staged notes kept while no model is around to distill them. */
const DREAM_STAGED_MAX = 200;

export async function runLightDream(opts: {
  home?: string;
  workspace: string;
  sessionId: string;
  transcriptPath?: string;
  config: AresAgentConfig;
  now?: Date;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  const now = opts.now ?? new Date();
  const events = opts.transcriptPath ? await readTextIfExists(opts.transcriptPath, 2_000_000) : "";
  // Noise-gated at the source: a pasted stack trace in a user message is
  // still a user message to extractSessionSignals, but it is not knowledge.
  const snippets = extractSessionSignals(events ?? "").filter((s) => !isOperationalNoise(s)).slice(0, 5);
  // A session with nothing to stage leaves no trace. 490 of 620 DREAMS.md
  // entries were "LIGHT found no durable memory candidates.", burying the 25
  // that staged something, and each one also fired a dream phase on the bus.
  if (snippets.length === 0) {
    return { phase: "light", promoted: 0, pruned: 0, report: "LIGHT found no durable memory candidates." };
  }
  emitLifecycle({ type: "dream_phase_started", phase: "light" });
  const daily = path.join(paths.memoryDir, `${now.toISOString().slice(0, 10)}.md`);
  await mkdir(path.dirname(daily), { recursive: true });
  await appendFile(daily, [`\n## Session ${opts.sessionId}`, ...snippets.map((s) => `- ${s}`), ""].join("\n"), "utf8");
  // Staged, NOT promoted: these are the owner's raw words ("User asked: ...").
  // They used to go straight into the v4 store, and deep dreaming copied them
  // verbatim into MEMORY.md — 45 quotes, the same line six times under six
  // ids, no fact anywhere (field MEMORY.md, 2026-11-02). Now they wait in the
  // staging file for the deep dream's model pass to distill into typed facts;
  // the daily log above keeps the words themselves.
  await stageDreamNotes(home, opts.sessionId, snippets, now);
  // The v6 living memory still gets them as episodes, so recall can find what
  // was said; consolidation fades the ones that never come up again.
  const living = await LivingMemoryStore.open(mindPaths(home).memoryFile).catch(() => null);
  // Episodic in v6: a dream candidate is a raw session signal; consolidation
  // crystallizes the recurring ones into semantic. Routed through the ONE
  // write spine ("dream" channel: ungated — consolidate() merges repeats into
  // strength later) and flushed as a single batch. Best-effort — a dream is
  // never broken by the living store being unavailable.
  if (living) {
    await new MemoryRouter(living)
      .write("dream", snippets.map((snippet) => ({ kind: "episodic" as const, content: snippet, source: "light-dreaming", strength: 0.55 })))
      .catch(() => undefined);
  }
  const report = `LIGHT staged ${snippets.length} memory candidate(s).`;
  await appendDreamDiary(paths.dreamsDiary, now, report);
  emitLifecycle({ type: "dream_phase_ended", phase: "light", promoted: snippets.length, pruned: 0 });
  return { phase: "light", promoted: snippets.length, pruned: 0, report };
}

export async function runDeepDream(opts: {
  home?: string;
  workspace?: string;
  config: AresAgentConfig;
  now?: Date;
  /** Optional model hooks; see {@link DreamModel}. */
  model?: DreamModel;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  const now = opts.now ?? new Date();
  const parts: string[] = [];

  // 1. Distill what light dreaming staged — the ONLY model call a dream makes,
  //    and only when there is something staged.
  const distilled = await distillStagedNotes(home, opts.model?.distill);
  if (distilled.notes > 0) parts.push(`distilled ${distilled.notes} staged note(s) into ${distilled.facts} fact(s)`);

  // 2. Curate MEMORY.md from typed facts.
  const store = await createMemoryStore(opts.config, home);
  const memories = await store.list();
  // The noise gate applies at PROMOTION, not just at write time: the v4 vector
  // store is append-only (no delete API), so "Tool error observed:" rows
  // harvested by long-gone code re-surfaced into MEMORY.md on every deep dream
  // — a field user's index was 24 error entries against 5 real memories
  // (2026-08-06). Raw quotes ("User asked: ...") are refused the same way: a
  // chat line is history, not knowledge. What the owner pinned is never
  // scored, noise-gated or trimmed away.
  const pinned = memories.filter((memory) => memory.source === "owner-pinned");
  const promoted = memories.filter((memory) =>
    memory.source !== "owner-pinned" &&
    memory.score >= opts.config.dreaming.minScore &&
    (memory.hits >= opts.config.dreaming.minRecallCount || memory.source === "light-dreaming") &&
    !isOperationalNoise(memory.content) &&
    !isRawQuote(memory.content)
  );
  const timed: Array<{ ts: number; fact: CuratedFact }> = [
    ...pinned.map((m) => ({ ts: m.createdAt, fact: { type: curatedTypeOf(m.category), content: m.content, pinned: true } as CuratedFact })),
    ...promoted.map((m) => ({ ts: m.createdAt, fact: { type: curatedTypeOf(m.category), content: m.content } as CuratedFact })),
    ...(await livingCuratedFacts(home)),
  ];
  timed.sort((a, b) => a.ts - b.ts);
  const curated = mergeCuratedFacts(timed.map((t) => t.fact));
  const curatedCount = Math.min(curated.facts.length, DREAM_MEMORY_MAX_ITEMS);
  let memoryChanged = false;
  if (curated.facts.length > 0) {
    const next = renderCuratedMemory(curated.facts, { max: DREAM_MEMORY_MAX_ITEMS, itemChars: DREAM_MEMORY_ITEM_CHARS });
    const current = await readFile(paths.memory, "utf8").catch(() => "");
    if (next !== current) {
      await writeFileAtomic(paths.memory, next);
      memoryChanged = true;
      parts.push(`curated ${curatedCount} fact(s) into MEMORY.md${curated.merged > 0 ? ` (${curated.merged} duplicate(s) merged)` : ""}`);
    }
  }
  const soulPromoted = await promoteSoulRules(paths.soul, promoted, opts.config.dreaming.soulRewriteThreshold);
  if (soulPromoted > 0) parts.push(`${soulPromoted} SOUL rule(s)`);
  // One-time v4→v6 fold: migrate the legacy vector store into living memory once,
  // guarded by a marker file so it never re-scans. Idempotent on its own too
  // (content-hash dedup) — the marker just avoids the read every deep dream.
  await migrateLegacyVectorsOnce(home, expandHomePath(opts.config.memory.jsonFallbackPath, home));
  // Real reflection: reason over the self-model and record what to fix, acquire,
  // or prune. This is the "why did I fail / what should I become" layer. The
  // same directives as last time are not news (34 identical "[acquire] godot"
  // blocks in the field diary) — only a changed set is written and counted.
  const selfDirectives = await reflectSelfModel(home, paths.dreamsDiary, now);
  if (selfDirectives > 0) parts.push(`${selfDirectives} self-directive(s)`);
  // Real synthesis over the v6 living memory: crystallize recurring episodes into
  // insight nodes and recurring failures into belief nodes — the "what should I
  // believe now" pass that turns raw episodes into durable knowledge.
  const synthesized = await synthesizeLivingMemory(home, now);
  if (synthesized) parts.push(synthesized);
  // Weekly: propose rewritten IDENTITY.md / USER.md (never overwrites them).
  const selfRefresh = await runSelfFileRefresh({
    home,
    now,
    records: curated.facts,
    ...(opts.model?.rewriteSelfFile ? { rewrite: opts.model.rewriteSelfFile } : {}),
  }).catch(() => undefined);
  if (selfRefresh?.proposals.length) {
    const flagged = selfRefresh.proposals.reduce((n, p) => n + p.contradictions.length, 0);
    parts.push(`proposed ${selfRefresh.proposals.map((p) => p.name).join(" + ")} rewrite${flagged > 0 ? ` (${flagged} contradiction(s) flagged)` : ""}`);
    emitLifecycle({
      type: "thought",
      kind: "reflect",
      text: `Proposed updates to ${selfRefresh.proposals.map((p) => p.name).join(" and ")} — review ${selfRefresh.proposals.map((p) => path.basename(p.file)).join(", ")}.`,
    });
  }

  const promotedCount = memoryChanged ? curatedCount : 0;
  // A dream that changed nothing leaves no trace: no diary line, no phase
  // event. 470 of 542 field diary ticks were "found nothing" or identical
  // repeats, burying the few that mattered.
  if (parts.length === 0) {
    return { phase: "deep", promoted: 0, pruned: 0, report: "DEEP found nothing new.", ...(selfRefresh ? { selfRefresh } : {}) };
  }
  const report = `DEEP ${parts.join(", ")}.`;
  emitLifecycle({ type: "dream_phase_started", phase: "deep" });
  await appendDreamDiary(paths.dreamsDiary, now, report);
  emitLifecycle({ type: "dream_phase_ended", phase: "deep", promoted: promotedCount, pruned: 0 });
  return { phase: "deep", promoted: promotedCount, pruned: 0, report, ...(selfRefresh ? { selfRefresh } : {}) };
}

/**
 * The model-written facts in living memory (the conversation distiller and
 * the dream distiller both write them: semantic, source
 * "conversation-reflection"), owner pool only — a guest's or an agent's
 * facts never land in the owner's MEMORY.md.
 */
async function livingCuratedFacts(home: string): Promise<Array<{ ts: number; fact: CuratedFact }>> {
  try {
    const living = await LivingMemoryStore.open(mindPaths(home).memoryFile);
    const out: Array<{ ts: number; fact: CuratedFact }> = [];
    for (const node of living.all()) {
      if (node.kind !== "semantic" || node.source !== "conversation-reflection") continue;
      if (node.scope !== undefined && node.scope !== OWNER_SCOPE) continue;
      if (isOperationalNoise(node.content) || isRawQuote(node.content)) continue;
      const tags = node.tags ?? [];
      const typeTag = tags.find((t) => t.startsWith("type:"))?.slice(5);
      const kindTag = tags.find((t) => !["reflected", "conversation"].includes(t) && !t.includes(":"));
      const why = tags.find((t) => t.startsWith("why:"))?.slice(4);
      const ts = Date.parse(node.at);
      out.push({ ts: Number.isNaN(ts) ? 0 : ts, fact: { type: curatedTypeOf(typeTag ?? kindTag), content: node.content, ...(why ? { why } : {}) } });
    }
    return out;
  } catch {
    return [];
  }
}

async function stageDreamNotes(home: string, sessionId: string, notes: readonly string[], now: Date): Promise<void> {
  const file = dreamStagingFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
  const lines = [...existing, ...notes.map((text) => JSON.stringify({ at: now.toISOString(), sessionId, text }))];
  await writeFileAtomic(file, lines.slice(-DREAM_STAGED_MAX).join("\n") + "\n");
}

/**
 * Hand the staged notes to the model once and write what it distills as typed
 * facts through the write spine. Nothing staged → no call. No model → the
 * notes stay staged for a dream that has one. A failed call keeps them too.
 */
async function distillStagedNotes(home: string, distill: DreamModel["distill"]): Promise<{ notes: number; facts: number }> {
  const file = dreamStagingFile(home);
  const raw = await readFile(file, "utf8").catch(() => "");
  const notes = [...new Set(raw.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return String((JSON.parse(line) as { text?: unknown }).text ?? "").trim();
    } catch {
      return "";
    }
  }).filter(Boolean))];
  if (notes.length === 0 || !distill) return { notes: 0, facts: 0 };
  let facts: DurableFact[];
  try {
    facts = await distill(notes);
  } catch {
    return { notes: 0, facts: 0 };
  }
  let added = 0;
  if (Array.isArray(facts) && facts.length > 0) {
    const living = await LivingMemoryStore.open(mindPaths(home).memoryFile);
    added = (await mergeDurableFacts(living, facts)).added;
  }
  await writeFile(file, "", "utf8");
  return { notes: notes.length, facts: added };
}

export async function runRemDream(opts: {
  home?: string;
  config: AresAgentConfig;
  now?: Date;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  const files = await readdir(paths.memoryDir).catch(() => []);
  const scanned = files.filter((file) => file.endsWith(".md")).length;
  const report = `REM scanned ${scanned} daily memory file(s) for cross-workspace patterns.`;
  // Nothing to scan, or the same count as last time: no news, no trace.
  if (scanned === 0 || !(await appendDreamDiary(paths.dreamsDiary, opts.now ?? new Date(), report))) {
    return { phase: "rem", promoted: 0, pruned: 0, report };
  }
  emitLifecycle({ type: "dream_phase_started", phase: "rem" });
  emitLifecycle({ type: "dream_phase_ended", phase: "rem", promoted: 0, pruned: 0 });
  return { phase: "rem", promoted: 0, pruned: 0, report };
}

/**
 * Synthesize durable insight/belief nodes from the v6 living memory — best-effort,
 * never throws, so a dream can never be broken by it. Opens the SAME living store
 * the live turn reads/writes (mindPaths(home).memoryFile) so insights surface in
 * future recall.
 */
async function synthesizeLivingMemory(home: string, now: Date): Promise<string> {
  try {
    const store = await LivingMemoryStore.open(mindPaths(home).memoryFile);
    const report = await store.synthesize({ now });
    if (report.insights + report.beliefs + report.updated === 0) return "";
    emitLifecycle({
      type: "thought",
      kind: "reflect",
      text: `Crystallized ${report.insights} insight(s) and ${report.beliefs} belief(s) from recurring memory.`,
    });
    return `${report.insights} insight(s) + ${report.beliefs} belief(s) crystallized`;
  } catch {
    return "";
  }
}

/**
 * Fold the legacy v4 vector store into v6 living memory exactly once. Guarded by a
 * `.v4-migrated` marker beside the memory file so it doesn't re-scan vectors.json
 * on every deep dream. Best-effort — never throws, so a dream can't be broken by a
 * missing/corrupt legacy file (migrateLegacyVectors already no-ops on those).
 */
async function migrateLegacyVectorsOnce(home: string, legacyDbJsonPath: string): Promise<void> {
  try {
    const memoryFile = mindPaths(home).memoryFile;
    const marker = path.join(path.dirname(memoryFile), ".v4-migrated");
    if (await readTextIfExists(marker, 256)) return; // already migrated
    const store = await LivingMemoryStore.open(memoryFile);
    const report = await migrateLegacyVectors({ store, legacyDbJsonPath });
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, `${new Date().toISOString()} migrated=${report.migrated} scanned=${report.scanned}\n`, "utf8");
    if (report.migrated > 0) {
      emitLifecycle({
        type: "thought",
        kind: "reflect",
        text: `Folded ${report.migrated} legacy v4 memory(ies) into living memory.`,
      });
    }
  } catch {
    // Migration is an upgrade convenience; a failure must never break a dream.
  }
}

async function reflectSelfModel(home: string, dreamsDiary: string, now: Date): Promise<number> {
  try {
    const directives = reflect(await loadSelfModel(home));
    if (directives.length === 0) return 0;
    const lines = directives.slice(0, 8).map((d) => `- [${d.kind}] ${d.capabilityName}: ${d.reason}`);
    if (lastSelfReflection(await readFile(dreamsDiary, "utf8").catch(() => "")) === lines.join("\n")) return 0;
    await mkdir(path.dirname(dreamsDiary), { recursive: true });
    await appendFile(dreamsDiary, `\n### Self-reflection (${now.toISOString()})\n\n${lines.join("\n")}\n`, "utf8");
    emitLifecycle({
      type: "self_reflected",
      directives: directives.length,
      topKind: directives[0].kind,
      gain: gainForTarget("SELF", directives.length, "reflected"),
    });
    return directives.length;
  } catch {
    return 0;
  }
}

function extractSessionSignals(eventsJsonl: string): string[] {
  const signals = new Set<string>();
  for (const line of eventsJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { event?: { type?: string; userMessage?: unknown; message?: unknown; error?: string } };
      const event = entry.event;
      if (!event) continue;
      if (event.type === "turn_start") {
        const text = messageText((event as any).userMessage);
        if (durable(text)) signals.add(`User asked: ${compact(text)}`);
      }
      // Tool errors are DELIBERATELY not memories.
      //
      // They used to be captured here as durable FEEDBACK entries, which meant
      // long-term memory filled with lines like "Tool error observed:
      // <tool_use_error>...". Every session then injected that history back
      // into context, priming the model on its own past failures — and worse,
      // preserving bugs forever: memory still carried "SearXNG: no instance
      // URL" long after that bug was fixed in the harness.
      //
      // Transient failures already have a proper home: the friction telemetry
      // (~/.ares/telemetry/friction-*.jsonl), which reliabilityTriage and the
      // Self tool read on demand. Memory is for what stays true.
    } catch {
      // Ignore torn JSONL tails.
    }
  }
  return [...signals];
}

/**
 * Does this message state something that stays TRUE after the session ends?
 *
 * The old test was a bare keyword list including "use", "tool", and "test" —
 * words present in nearly every message anyone sends a coding agent. That is
 * how conversational openers ("...just to test your capabilities...") became
 * permanent memories, stored as truncated mid-sentence fragments.
 *
 * A standing fact is a STATEMENT, not a request: an expressed preference, a
 * settled decision, or an explicit instruction to remember. Questions and
 * task requests are work, not knowledge — the coding journal and the session
 * transcript already hold those.
 */
function durable(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  // Too short to carry a fact, or a bare question → not knowledge.
  if (clean.length < 25) return false;
  if (/^(?:hi|hey|yo|hello|sup|thanks|ok|okay)\b/i.test(clean)) return false;
  if (clean.endsWith("?")) return false;
  return (
    // Explicit instruction to retain.
    /\b(?:remember|keep in mind|for future reference|from now on|going forward)\b/i.test(clean) ||
    // Expressed preference / standing rule, stated in the first person.
    /\b(?:i|we)\s+(?:prefer|always|never|usually|don'?t|do not|like to|want you to|need you to)\b/i.test(clean) ||
    /\b(?:always|never)\s+(?:use|write|run|commit|verify|assume|ask)\b/i.test(clean) ||
    // A settled decision about how the work is done.
    /\b(?:we (?:decided|agreed|settled on|are using)|the (?:convention|standard|rule) is|stick (?:to|with))\b/i.test(clean)
  );
}

function messageText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
}

function compact(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, Math.max(0, limit - 3))}...` : clean;
}

async function promoteSoulRules(soulPath: string, memories: readonly { id: number; category: string; content: string; hits: number }[], threshold: number): Promise<number> {
  const candidates = memories.filter((memory) => memory.category === "SELF" && memory.hits >= threshold);
  if (candidates.length === 0) return 0;
  const current = (await readTextIfExists(soulPath, 1_000_000)) ?? "# SOUL.md - Who I Am\n\n## Learned Rules\n";
  const lines = [current.trimEnd(), ""];
  let added = 0;
  for (const memory of candidates) {
    const rule = `- ${compact(memory.content, DREAM_MEMORY_ITEM_CHARS)} (source memory #${memory.id})`;
    if (current.includes(rule)) continue;
    lines.push(rule);
    added += 1;
  }
  if (added > 0) await writeFileAtomic(soulPath, lines.join("\n") + "\n");
  return added;
}

/** Append one diary entry — unless it repeats the previous entry word for
 *  word ("DEEP promoted 33 memory candidate(s)" ten nights running). Returns
 *  whether a line was written. */
async function appendDreamDiary(file: string, now: Date, report: string): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => "");
  if (lastDiaryReport(current) === report.trim()) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `\n## ${now.toISOString()}\n\n${report}\n`, "utf8");
  return true;
}

/** The text of the last "## <timestamp>" diary entry, or undefined. */
export function lastDiaryReport(diary: string): string | undefined {
  const entries = [...diary.matchAll(/^## \d{4}-\d{2}-\d{2}T[^\n]*\n\n([^\n]+)/gm)];
  return entries.at(-1)?.[1]?.trim();
}

/** The directive lines of the last "### Self-reflection" block, or undefined. */
function lastSelfReflection(diary: string): string | undefined {
  const at = diary.lastIndexOf("### Self-reflection");
  if (at < 0) return undefined;
  const body = diary.slice(at).split(/\r?\n/).slice(1);
  const lines: string[] = [];
  for (const line of body) {
    if (line.startsWith("- ")) lines.push(line);
    else if (lines.length > 0) break;
  }
  return lines.join("\n");
}

