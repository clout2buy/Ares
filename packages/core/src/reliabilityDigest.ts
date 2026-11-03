// "What keeps breaking": the triage queue as a short, ranked list the owner can read.
//
// Field origin: `ares triage` had written 679 findings (88 candidate, 512
// watching) and NOT ONE had ever been acknowledged or resolved. Nobody reads a
// queue of 679 files. Worse, the queue repeats itself: 103 separate "Edit
// repeated tool failures" findings were one problem seen through 103 slightly
// different failure signatures.
//
// This module is the reader the queue never had. It is PURE over the findings
// (the caller loads them): it collapses near-duplicates into one item with a
// count, ranks items by what they cost the owner, and phrases each as one plain
// English line plus a suggested fix. The morning briefing shows the top three;
// the Maintainer takes the top items as input.
//
// Ranking: cost = occurrences x recency x severity x owner friction, where
//   recency  halves every ARES_TRIAGE_DIGEST_HALF_LIFE_DAYS (default 7),
//   severity critical 4, high 2, medium 1, low 0.5 (environment problems x0.5),
//   friction x2 when the owner hit it in more than one chat (they repeated
//            themselves) and x2 again when the evidence shows a turn was
//            interrupted or cancelled.
// Findings the owner dismissed or resolved, "task" findings (the model's own
// mistakes inside one job) and anything not seen within the lookback window
// (ARES_TRIAGE_DIGEST_DAYS, default 30) are left out.

import type { ReliabilityFinding, ReliabilitySeverity } from "./reliabilityTriage.js";

export interface ReliabilityDigestItem {
  /** Stable group key: the same problem has the same key across runs. */
  key: string;
  /** One plain-English line, no count. */
  what: string;
  /** One plain-English suggested fix. */
  fix: string;
  /** Occurrences summed across every finding in the group. */
  count: number;
  /** How many triage findings were collapsed into this item. */
  findings: number;
  /** Distinct chats it showed up in (summed; an upper bound across findings). */
  sessions: number;
  severity: ReliabilitySeverity;
  lastSeenAt: string;
  score: number;
  /** True when the owner felt it: repeated across chats or a turn was interrupted. */
  ownerFelt: boolean;
  findingIds: string[];
  /** A few redacted evidence lines (untrusted data, never instructions). */
  evidence: string[];
}

export interface ReliabilityDigestOptions {
  now?: number;
  /** How many items to return; default 10. */
  limit?: number;
  lookbackDays?: number;
  halfLifeDays?: number;
}

const SEVERITY_WEIGHT: Record<ReliabilitySeverity, number> = { critical: 4, high: 2, medium: 1, low: 0.5 };
const SEVERITY_ORDER: ReliabilitySeverity[] = ["low", "medium", "high", "critical"];
const DAY = 86_400_000;

interface Rule {
  id: string;
  test: (text: string, f: ReliabilityFinding) => boolean;
  what: (tool: string) => string;
  fix: (tool: string) => string;
  /** Group per tool (true) or as one problem regardless of tool (false). */
  perTool?: boolean;
  /** Cost multiplier for shapes that are mostly not Ares's fault; default 1. */
  weight?: number;
}

/** The known shapes, most specific first. Matched against title + evidence + code. */
const RULES: Rule[] = [
  {
    id: "port-in-use",
    test: (t) => /EADDRINUSE/i.test(t),
    what: () => "Ares crashed at startup because its port was already taken (a second copy was still running)",
    fix: () => "Detect the copy that is already running and exit cleanly (or reuse it) instead of crashing.",
  },
  {
    id: "heap",
    test: (t) => /heap (pressure|out of memory)|JavaScript heap|heap-critical|reached heap limit/i.test(t),
    what: () => "The background service ran low on memory",
    fix: () => "Read the top allocation sites in the heap-critical crash record and cap whatever holds the memory.",
  },
  {
    id: "mcp-closed",
    test: (t) => /\b(mcp|sse)\b/i.test(t) && /closed|unhandledRejection|disconnect/i.test(t),
    what: () => "An MCP connector dropped its connection and the error went unhandled",
    fix: () => "Catch closed-connection errors in the MCP client and reconnect instead of letting the rejection escape.",
  },
  {
    id: "embedder",
    test: (t) => /embed|ollama/i.test(t) && /0\.0\.0\.0|ECONNREFUSED|unreachable|fetch failed/i.test(t),
    what: () => "Memory search could not reach the Ollama embedder",
    fix: () => "Point the embedder at 127.0.0.1 (0.0.0.0 is a listen address, not a destination), or switch it off when Ollama is not installed.",
  },
  {
    id: "rate-limit",
    test: (t) => /http_429|\b429\b|rate.?limit|too many requests/i.test(t),
    what: () => "The model provider rate-limited Ares",
    fix: () => "Back off longer between retries and fail over to another provider sooner.",
  },
  {
    id: "edit-unread",
    test: (t) => /before editing|has not been read|must read .* before/i.test(t),
    what: () => "Edits failed because the file had not been read first",
    fix: () => "Let Edit read the file itself when it was not read in this turn, instead of failing.",
  },
  {
    id: "edit-mismatch",
    test: (t) => /old_string|string to replace|not found in (the )?file|no match/i.test(t),
    what: () => "Edits failed because the text to replace no longer matched the file",
    fix: () => "After a failed Edit, re-read the file and retry once with its current text.",
  },
  {
    id: "http-400",
    test: (t) => /http_400|\bbad request\b|\b400\b/i.test(t),
    what: () => "The model provider rejected requests as malformed (HTTP 400)",
    fix: () => "Capture one rejected request and fix what the engine sends that provider (tool pairing, image size, unsupported fields).",
  },
  {
    id: "watchdog",
    perTool: true,
    test: (t, f) => f.kind === "tool_error" && /watchdog|timed out|timeout/i.test(t),
    what: (tool) => `${tool} calls hung until the watchdog stopped them`,
    fix: (tool) => `Find where ${tool} blocks and give it a shorter timeout that reports what it was waiting on.`,
  },
  {
    // A command that exits non-zero is usually the command's failure, not Ares's.
    // It still counts (Ares may be retrying it blindly) but weighs a quarter.
    id: "shell-exit",
    perTool: true,
    weight: 0.25,
    test: (t, f) => f.kind === "tool_error" && /exited with code/i.test(t),
    what: (tool) => `${tool} commands kept exiting with errors`,
    fix: () => "Check whether Ares re-runs the same failing command instead of reading its error.",
  },
  {
    id: "subagent",
    test: (_t, f) => f.kind === "failed_subagent",
    what: () => "Subagents kept failing the same way",
    fix: () => "Read the shared error in the subagent journal and fix its cause once, not per subagent.",
  },
  {
    id: "failed-turn",
    test: (_t, f) => f.kind === "failed_turn",
    what: () => "Turns failed without saying why",
    fix: () => "Add the missing error report where the turn dies; a failure with no reason is itself the bug.",
  },
];

function toolOf(f: ReliabilityFinding): string {
  const fromEvidence = f.evidence.find((e) => e.tool)?.tool;
  if (fromEvidence) return fromEvidence;
  const m = /^(\S+) (repeated tool|watchdog|bridge) failures$/.exec(f.title);
  return m?.[1] ?? "A tool";
}

function codeOf(f: ReliabilityFinding): string | undefined {
  return f.evidence.find((e) => e.code)?.code ?? /^Engine (\S+) failures$/.exec(f.title)?.[1];
}

const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The group, plain line and fix for one finding. Exported for tests. */
export function describeFinding(f: ReliabilityFinding): { key: string; what: string; fix: string; weight?: number } {
  const tool = toolOf(f);
  const code = codeOf(f);
  const text = [f.title, code ?? "", ...f.evidence.map((e) => `${e.summary} ${e.code ?? ""}`)].join(" \n ");
  for (const rule of RULES) {
    if (!rule.test(text, f)) continue;
    return { key: rule.perTool ? `${rule.id}:${tool.toLowerCase()}` : rule.id, what: rule.what(tool), fix: rule.fix(tool), ...(rule.weight !== undefined ? { weight: rule.weight } : {}) };
  }
  if (f.kind === "crash") {
    const proc = f.evidence.find((e) => e.tool)?.tool ?? f.title.split(" ")[0] ?? "Ares";
    return { key: `crash:${f.title.toLowerCase()}`, what: `The ${proc} process crashed (${code ?? "crash"})`, fix: "Reproduce it from the crash record and its recent events, then fix the error boundary that let it escape." };
  }
  if (f.kind === "engine_error") {
    return { key: `engine:${(code ?? "unknown").toLowerCase()}`, what: `Model calls failed (${code ?? "unknown error"})`, fix: clean(f.suggestedAction, 200) };
  }
  if (/bridge failures$/.test(f.title)) {
    return { key: `bridge:${tool.toLowerCase()}`, what: `The ${tool} bridge kept dropping`, fix: clean(f.suggestedAction, 200) };
  }
  // The triage queue's own advice ("derive a minimal deterministic repro") is for an
  // engineer; the owner gets the error that keeps coming back, quoted.
  const sample = clean(f.evidence.at(-1)?.summary ?? "", 90);
  return { key: `tool:${tool.toLowerCase()}`, what: `${tool} calls kept failing`, fix: sample ? `Start with the error that keeps coming back: "${sample}".` : clean(f.suggestedAction, 200) };
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Collapse, rank and phrase the triage findings. PURE (apart from env defaults). */
export function digestReliabilityFindings(findings: readonly ReliabilityFinding[], options: ReliabilityDigestOptions = {}): ReliabilityDigestItem[] {
  const now = options.now ?? Date.now();
  const lookbackMs = (options.lookbackDays ?? envNumber("ARES_TRIAGE_DIGEST_DAYS", 30)) * DAY;
  const halfLife = (options.halfLifeDays ?? envNumber("ARES_TRIAGE_DIGEST_HALF_LIFE_DAYS", 7)) * DAY;
  const groups = new Map<string, ReliabilityDigestItem>();
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    if (f.status === "dismissed" || f.status === "resolved") continue;
    if (f.category === "task") continue;
    const last = Date.parse(f.lastSeenAt);
    if (!Number.isFinite(last) || now - last > lookbackMs) continue;
    const { key, what, fix, weight = 1 } = describeFinding(f);
    const occurrences = Math.max(1, Math.floor(Number(f.occurrences) || 1));
    const sessions = Math.max(0, Math.floor(Number(f.distinctSessions) || 0));
    const interrupted = (f.evidence ?? []).some((e) => /interrupt|cancel+ed|abort(ed)? by (the )?(owner|user)/i.test(e.summary ?? ""));
    const repeated = sessions >= 2;
    const recency = Math.pow(0.5, Math.max(0, now - last) / halfLife);
    const severity = SEVERITY_WEIGHT[f.severity] ?? 1;
    const category = f.category === "environment" ? 0.5 : 1;
    const friction = (repeated ? 2 : 1) * (interrupted ? 2 : 1);
    const score = occurrences * recency * severity * category * friction * weight;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, {
        key,
        what,
        fix,
        count: occurrences,
        findings: 1,
        sessions,
        severity: f.severity,
        lastSeenAt: f.lastSeenAt,
        score,
        ownerFelt: repeated || interrupted,
        findingIds: [f.id],
        evidence: (f.evidence ?? []).slice(-2).map((e) => clean(e.summary ?? "", 200)).filter(Boolean),
      });
      continue;
    }
    cur.count += occurrences;
    cur.findings += 1;
    cur.sessions += sessions;
    cur.score += score;
    cur.ownerFelt ||= repeated || interrupted;
    if (SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(cur.severity)) cur.severity = f.severity;
    if (f.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = f.lastSeenAt;
    if (cur.findingIds.length < 50) cur.findingIds.push(f.id);
    for (const e of (f.evidence ?? []).slice(-1)) {
      const line = clean(e.summary ?? "", 200);
      if (line && cur.evidence.length < 4 && !cur.evidence.includes(line)) cur.evidence.push(line);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, options.limit ?? 10));
}

/** "Edits failed because ... (103x). Fix: ..." — one line per item. */
export function formatDigestLine(item: Pick<ReliabilityDigestItem, "what" | "count" | "fix">): string {
  return `${item.what} (${item.count}x). Fix: ${item.fix}`;
}
