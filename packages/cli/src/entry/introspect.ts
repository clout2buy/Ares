// Extracted from entry.ts — introspect.

import { OllamaCloudPool, DEFAULT_OLLAMA_SLOTS, listWorkspaceCheckpoints, diffWorkspaceCheckpoint, restoreWorkspaceCheckpoint, authStatus, deviceCodeLogin, summarizeFriction, type Provider } from "@ares/core";
import { notice, themesList } from "../terminalUi.js";
import { loadUiSettings } from "../uiSettings.js";
import { deliberateForTurn, loadAgentConfig, unifiedRecallForTurn } from "@ares/agent";
import { listLearningCards, selectRelevantLessons, listGoals, listMissionContracts, summarizeContinuity, type ContinuitySummary, assembleWorldGraph, ARES_SUBSYSTEMS, type WorldGraph, rankBriefing, type DailyBriefing } from "@ares/operator";
import { MemoryStore } from "@ares/mind";
import { chatCommand } from "./chat.js";
import { NATIVE_OLLAMA_OPTS } from "./providers.js";
import { ParsedArgs, cliRuntimeContext, compactLine, relativeAge } from "./runtime.js";
import { printSessions, requireResumeSessionId, terminalKeyStatus } from "./terminalLines.js";

export async function sessionsCommand(): Promise<number> {
  await printSessions();
  return 0;
}

export async function checkpointsCommand(): Promise<number> {
  const context = cliRuntimeContext();
  const checkpoints = await listWorkspaceCheckpoints(context.workspace);
  if (checkpoints.length === 0) {
    process.stdout.write(notice("Checkpoints", ["No checkpoints in this workspace yet."], "warn"));
    return 0;
  }
  process.stdout.write(
    notice(
      "Checkpoints",
      checkpoints.slice(0, 20).map((cp) => `${cp.id}  ${cp.createdAt}  ${cp.fileManifest.length} files${cp.label ? `  ${cp.label}` : ""}`),
      "info",
    ),
  );
  return 0;
}

export async function checkpointDiffCommand(id: string): Promise<number> {
  if (!id) {
    process.stderr.write(notice("Checkpoint Diff", ["Usage: /checkpoint-diff <id>"], "error"));
    return 2;
  }
  try {
    const diff = await diffWorkspaceCheckpoint(cliRuntimeContext().workspace, id);
    const lines = [
      `added: ${diff.added.length}`,
      ...diff.added.slice(0, 20).map((f) => `+ ${f}`),
      `modified: ${diff.modified.length}`,
      ...diff.modified.slice(0, 20).map((f) => `~ ${f}`),
      `deleted: ${diff.deleted.length}`,
      ...diff.deleted.slice(0, 20).map((f) => `- ${f}`),
    ];
    process.stdout.write(notice("Checkpoint Diff", lines, "info"));
    return 0;
  } catch (err) {
    process.stderr.write(notice("Checkpoint Diff", [err instanceof Error ? err.message : String(err)], "error"));
    return 1;
  }
}

export async function rollbackCommand(id: string): Promise<number> {
  if (!id) {
    process.stderr.write(notice("Rollback", ["Usage: /rollback <checkpoint-id>"], "error"));
    return 2;
  }
  try {
    const result = await restoreWorkspaceCheckpoint(cliRuntimeContext().workspace, id);
    process.stdout.write(notice("Rollback", [`restored ${result.restored} file(s)`, `deleted ${result.deleted} file(s)`], "success"));
    return 0;
  } catch (err) {
    process.stderr.write(notice("Rollback", [err instanceof Error ? err.message : String(err)], "error"));
    return 1;
  }
}

export function themesCommand(): number {
  process.stdout.write(themesList());
  process.stdout.write(`\nUse --theme <name> for one run, or ares theme <name> / /theme <name> to save it.\n`);
  return 0;
}

export async function resumeCommand(args: ParsedArgs): Promise<number> {
  try {
    const target = args.positionals[0] ?? args.flags.get("session") ?? "last";
    const sessionId = await requireResumeSessionId(target, cliRuntimeContext());
    return chatCommand(args, sessionId);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function buildContinuitySummary(context = cliRuntimeContext()): Promise<ContinuitySummary> {
  const [contracts, goals] = await Promise.all([
    listMissionContracts(context.home).catch(() => []),
    listGoals(context.home).catch(() => []),
  ]);

  // Enrich from the freshest open missions — best-effort: enrichment must never
  // break the recap, and it never mutates anything.
  const open = contracts.filter(
    (c) => c.progress.status === "active" || c.progress.status === "blocked" || c.progress.status === "draft",
  );
  let relatedMemory: string[] | undefined;
  let advisory: ContinuitySummary["advisory"] = null;
  if (open.length > 0) {
    const situation = open.slice(0, 3).map((c) => c.intent).join("; ");
    try {
      const config = await loadAgentConfig(context.home);
      const recall = await unifiedRecallForTurn({
        query: situation,
        workspace: context.workspace,
        livingMemoryFile: context.mind.memoryFile,
        vector: { config, home: context.home },
        limit: 5,
        reinforce: false, // inspecting status must not strength-bump memory
      });
      relatedMemory = recall.items.map((i) => i.content);
      const adv = await deliberateForTurn({ situation, recalled: recall.living, shouldDeliberate: true });
      advisory = adv.intention
        ? { goal: adv.intention.goal, rationale: adv.intention.rationale, confidence: adv.intention.confidence }
        : null;
    } catch {
      // enrichment is optional — fall back to mission state alone
    }
  }

  // Relevant Learning Cards (Phase B) — read-only: just reading lesson files.
  const cards = await listLearningCards(context.home).catch(() => []);
  const relevant = selectRelevantLessons(cards, open.map((c) => c.intent), 3);
  const lessons = relevant.map((c) => `[${c.result}] ${compactLine(c.intent, 110)} (${Math.round(c.confidence * 100)}%)`);

  return summarizeContinuity({ contracts, goals, relatedMemory, advisory, lessons: lessons.length ? lessons : undefined });
}

export function continuityLines(summary: ContinuitySummary): string[] {
  if (summary.empty) {
    return [
      "Clean slate — no missions on record yet.",
      'Start one with: ares operator add --goal "<what you want done>"',
    ];
  }
  const lines: string[] = [];
  if (summary.lastActiveAt) lines.push(`Last active: ${relativeAge(summary.lastActiveAt)} (${summary.lastActiveAt})`);
  lines.push(`${summary.missionCount} mission${summary.missionCount === 1 ? "" : "s"} on record`);

  const renderMission = (m: ContinuitySummary["active"][number], glyph: string): void => {
    const pct = m.totalCriteria > 0 ? ` — ${m.percent}% (${m.completedCriteria}/${m.totalCriteria})` : "";
    lines.push(`${glyph} ${compactLine(m.intent, 120)}${pct}`);
    if (m.goalStatement) lines.push(`    goal: ${compactLine(m.goalStatement, 120)}`);
    for (const b of m.blockers) lines.push(`    blocker: ${compactLine(b, 140)}`);
    if (m.nextAction) lines.push(`    next: ${compactLine(m.nextAction, 140)}`);
    if (m.topEvidence.length) lines.push(`    evidence: ${compactLine(m.topEvidence[0], 120)}`);
  };

  if (summary.active.length) {
    lines.push("", `Active (${summary.active.length}):`);
    for (const m of summary.active) renderMission(m, "•");
  }
  if (summary.blocked.length) {
    lines.push("", `Blocked (${summary.blocked.length}):`);
    for (const m of summary.blocked) renderMission(m, "⚠");
  }
  if (summary.recentlySatisfied.length) {
    lines.push("", `Recently completed (${summary.recentlySatisfied.length}):`);
    for (const m of summary.recentlySatisfied) lines.push(`✓ ${compactLine(m.intent, 120)}`);
  }
  if (summary.lessons?.length) {
    lines.push("", "Relevant lessons:");
    for (const l of summary.lessons.slice(0, 3)) lines.push(`- ${compactLine(l, 140)}`);
  }
  if (summary.relatedMemory?.length) {
    lines.push("", "Relevant memory:");
    for (const r of summary.relatedMemory.slice(0, 5)) lines.push(`- ${compactLine(r, 140)}`);
  }
  if (summary.advisory) {
    lines.push(
      "",
      `Suggested next: ${compactLine(summary.advisory.goal, 140)} (confidence ${Math.round(summary.advisory.confidence * 100)}%)`,
    );
    lines.push(`    why: ${compactLine(summary.advisory.rationale, 140)}`);
  }
  return lines;
}

export async function recapCommand(args: ParsedArgs): Promise<number> {
  try {
    const summary = await buildContinuitySummary();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Ghost Continue", continuityLines(summary), summary.blocked.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function buildWorldGraph(context = cliRuntimeContext()): Promise<WorldGraph> {
  const [contracts, goals, lessons] = await Promise.all([
    listMissionContracts(context.home).catch(() => []),
    listGoals(context.home).catch(() => []),
    listLearningCards(context.home).catch(() => []),
  ]);
  // Crystallized memories only (synthesis insight/belief nodes) — read-only.
  let memory: { id: string; kind: string; content: string; tags?: string[]; source?: string }[] = [];
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    memory = store
      .all()
      .filter((n) => n.source === "synthesis" || (n.tags ?? []).some((t) => t.startsWith("insight:") || t.startsWith("belief:")))
      .map((n) => ({ id: n.id, kind: n.kind, content: n.content, tags: n.tags, source: n.source }));
  } catch {
    // memory is optional — the graph still maps missions/lessons/subsystems
  }
  return assembleWorldGraph({ projectName: "Ares", contracts, goals, lessons, memory, subsystems: ARES_SUBSYSTEMS });
}

export function worldGraphLines(graph: WorldGraph): string[] {
  const lines: string[] = [];
  const c = graph.counts;
  lines.push(`${c.subsystem} subsystems · ${c.mission} missions · ${c.goal} goals · ${c.lesson} lessons · ${c.memory} memories · ${graph.relations.length} links`);
  const byId = new Map(graph.entities.map((e) => [e.id, e] as const));
  const linkedSubs = (fromId: string): string[] =>
    graph.relations.filter((r) => r.from === fromId && r.kind === "relates-to").map((r) => byId.get(r.to)?.ref ?? "").filter(Boolean);

  const missions = graph.entities.filter((e) => e.kind === "mission");
  if (missions.length) {
    lines.push("", "Missions:");
    for (const m of missions) {
      const pct = typeof m.meta?.percent === "number" ? ` ${m.meta.percent}%` : "";
      const serves = graph.relations.find((r) => r.from === m.id && r.kind === "serves");
      const goalLabel = serves ? byId.get(serves.to)?.label : undefined;
      const subs = linkedSubs(m.id);
      lines.push(`  • ${compactLine(m.label, 64)} [${m.status ?? "?"}${pct}]${subs.length ? `  → ${subs.join(", ")}` : ""}${goalLabel ? `  ⇒ ${compactLine(goalLabel, 40)}` : ""}`);
    }
  }

  const memories = graph.entities.filter((e) => e.kind === "memory");
  if (memories.length) {
    lines.push("", "Crystallized memory:");
    for (const mem of memories.slice(0, 8)) {
      const subs = linkedSubs(mem.id);
      lines.push(`  ~ ${mem.label}${subs.length ? `  → ${subs.join(", ")}` : ""}`);
    }
  }

  lines.push("", "Subsystems (most connected first):");
  const subsystems = graph.entities.filter((e) => e.kind === "subsystem");
  const inboundLinks = (id: string): number => graph.relations.filter((r) => r.to === id && r.kind === "relates-to").length;
  for (const s of [...subsystems].sort((a, b) => inboundLinks(b.id) - inboundLinks(a.id))) {
    const n = inboundLinks(s.id);
    lines.push(`  ${s.ref}${n ? ` · ${n} link${n === 1 ? "" : "s"}` : ""}`);
  }

  if (c.mission === 0 && c.lesson === 0) {
    lines.push("", "No missions or lessons yet — the map fills in as you run missions (ares operator add).");
  }
  return lines;
}

export async function worldCommand(args: ParsedArgs): Promise<number> {
  try {
    const graph = await buildWorldGraph();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("World Graph", worldGraphLines(graph), "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function buildBriefing(context = cliRuntimeContext()): Promise<DailyBriefing> {
  // Reuse the continuity summary (mission buckets + read-only advisory) and the
  // World Graph — no new store-reading logic, no mutation.
  const [summary, worldGraph, lessons] = await Promise.all([
    buildContinuitySummary(context),
    buildWorldGraph(context),
    listLearningCards(context.home).catch(() => []),
  ]);
  return rankBriefing({ summary, worldGraph, lessons, now: new Date().toISOString() });
}

export function briefingLines(b: DailyBriefing): string[] {
  const lines: string[] = [b.headline];
  if (b.focus.length) {
    lines.push("", "Focus:");
    for (const f of b.focus) {
      lines.push(`  • ${compactLine(f.intent, 60)} [${f.status} ${f.percent}%]${f.relatedSubsystems.length ? `  → ${f.relatedSubsystems.join(", ")}` : ""}`);
      lines.push(`     ${f.reasons.join(" · ")}`);
      if (f.lesson) lines.push(`     ${f.lesson}`);
    }
  }
  if (b.decisionsNeeded.length) {
    lines.push("", "Decisions needed (blocked):");
    for (const d of b.decisionsNeeded) lines.push(`  ! ${compactLine(d.intent, 60)} — ${compactLine(d.detail, 80)}`);
  }
  if (b.reviveOrDrop.length) {
    lines.push("", "Revive or drop (stale):");
    for (const d of b.reviveOrDrop) lines.push(`  · ${compactLine(d.intent, 60)} — ${d.detail}`);
  }
  if (b.recentlyShipped.length) {
    lines.push("", "Recently shipped:");
    for (const s of b.recentlyShipped) lines.push(`  ✓ ${compactLine(s.intent, 70)}`);
  }
  if (b.suggestion) {
    lines.push("", `Suggested (advisory, not a command): ${compactLine(b.suggestion.goal, 80)}`);
    lines.push(`  why: ${compactLine(b.suggestion.rationale, 90)} (${Math.round(b.suggestion.confidence * 100)}%)`);
  }
  return lines;
}

export async function todayCommand(args: ParsedArgs): Promise<number> {
  try {
    const briefing = await buildBriefing();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(briefing, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Today", briefingLines(briefing), briefing.decisionsNeeded.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function loginCommand(): Promise<number> {
  process.stderr.write("ares: starting ChatGPT OAuth device-code flow…\n");
  try {
    const file = await deviceCodeLogin({
      onDeviceCode: (code) => {
        process.stdout.write(
          [
            "",
            "  Open this URL in your browser:",
            `    ${code.verificationUrl}`,
            "",
            `  Enter the code: ${code.userCode}`,
            "",
            "  Waiting for authorization…",
            "",
          ].join("\n"),
        );
      },
    });
    process.stdout.write(`Logged in${file.profile.email ? ` as ${file.profile.email}` : ""}.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** `ares friction [--days N] [--json]` — the upgrade-priority report: what
 *  actually goes wrong across every surface, aggregated from telemetry. */
export async function frictionCommand(args: ParsedArgs): Promise<number> {
  const days = Math.max(1, Number(args.flags.get("days")) || 7);
  const summary = await summarizeFriction(undefined, days);
  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  if (summary.turns === 0) {
    process.stdout.write(notice("Friction", [`No telemetry in the last ${days} day(s). Run some turns first (ARES_TELEMETRY=0 disables logging).`], "warn"));
    return 0;
  }
  const lines: string[] = [
    `${summary.turns} turn(s) · ${summary.completed} completed · ${summary.failed} failed · last ${days} day(s)`,
    "",
  ];
  const tools = Object.entries(summary.tools).sort((a, b) => b[1].errors - a[1].errors || b[1].calls - a[1].calls);
  if (tools.length) {
    lines.push("Tools (worst error-rate first):");
    for (const [name, t] of tools.slice(0, 10)) {
      const rate = t.calls > 0 ? Math.round((t.errors / t.calls) * 100) : 0;
      lines.push(`  ${String(rate).padStart(3)}% err  ${String(t.calls).padStart(4)} calls  ${name}${t.errors ? ` (${t.errors} error${t.errors === 1 ? "" : "s"})` : ""}`);
    }
  }
  const e = summary.editTiers;
  const editTotal = e.exact + e.whitespace + e.anchor + e.miss;
  if (editTotal > 0) {
    lines.push("", `Edit tiers: ${e.exact} exact · ${e.whitespace} whitespace · ${e.anchor} anchor · ${e.miss} MISS${e.miss > 0 ? "  ← misses burn turns" : ""}`);
  }
  lines.push(
    "",
    `Stalls cut by the effort dial: ${summary.stalls} (${summary.reasoningStalls} thinking)`,
    `Verifier red flags: ${summary.verifyReminders} · compactions: ${summary.compactions}`,
    `Prompt cache: ${summary.avgCacheReadRatio === null ? "no data" : `${Math.round(summary.avgCacheReadRatio * 100)}% of input tokens served from cache`}`,
  );
  process.stdout.write(notice("Friction · what to upgrade next", lines, "info"));
  return 0;
}

export async function doctorCommand(): Promise<number> {
  process.stdout.write("ares doctor\n\n");

  // Auth
  const auth = await authStatus();
  process.stdout.write("OpenAI auth:\n");
  process.stdout.write(`  configured: ${auth.configured ? "yes" : "no"}\n`);
  process.stdout.write(`  mode:       ${auth.mode}\n`);
  process.stdout.write(`  source:     ${auth.source}\n`);
  if (auth.email) process.stdout.write(`  email:      ${auth.email}\n`);
  if (auth.tokenPreview) process.stdout.write(`  token:      ${auth.tokenPreview}\n`);
  process.stdout.write(`  authPath:   ${auth.authPath}\n`);
  process.stdout.write("\n");

  // Ollama Cloud
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS, ...NATIVE_OLLAMA_OPTS });
  const health = await pool.health();
  process.stdout.write("Ollama Cloud:\n");
  process.stdout.write(`  host:       ${health.host}\n`);
  process.stdout.write(`  reachable:  ${health.reachable ? "yes" : "no"}\n`);
  process.stdout.write(`  available:  ${health.availableModels.length} model(s)\n`);
  for (const slot of health.slots) {
    process.stdout.write(
      `  ${slot.name.padEnd(10)} ${slot.model.padEnd(35)} ${slot.present ? "[present]" : "[missing]"}\n`,
    );
  }
  process.stdout.write("\n");

  // Key-based providers — terminalKeyStatus already checks anthropic/deepseek/
  // openrouter/ollama/brave correctly; reuse it instead of only checking OpenAI
  // OAuth + Ollama and silently ignoring everything else.
  const keyStatus = terminalKeyStatus(await loadUiSettings());
  process.stdout.write("Provider keys:\n");
  for (const [provider, saved] of keyStatus) {
    process.stdout.write(`  ${provider.padEnd(10)} ${saved ? "configured" : "not set"}\n`);
  }
  process.stdout.write("\n");

  const anyKeyProviderConfigured = keyStatus.some(([, saved]) => saved);
  process.stdout.write(`ares: ${auth.configured || health.reachable || anyKeyProviderConfigured ? "ready" : "no providers configured"}\n`);
  return 0;
}
