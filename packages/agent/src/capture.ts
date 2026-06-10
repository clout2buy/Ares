// Runtime-side auto-capture.
//
// Every user turn, scan the message for signal patterns: preferences,
// corrections, defining statements about the agent, decisions. Each match
// appends a low-friction entry to today's raw daily memory log. The agent
// sees these on the next context load and decides whether to promote to
// SOUL/USER via SelfEvolve — no human prompt required.

import path from "node:path";
import { promises as fs } from "node:fs";
import { agentPaths, aresAgentHome } from "./paths.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { gainForTarget } from "./voice.js";

export interface CaptureMatch {
  kind: "correction" | "preference" | "identity" | "decision";
  pattern: string;
  excerpt: string;
}

const PATTERNS: ReadonlyArray<{ kind: CaptureMatch["kind"]; pattern: RegExp; label: string }> = [
  // Corrections — user pushing back on agent behavior
  { kind: "correction", pattern: /\b(?:no(?:t)? (?:don'?t|stop|wait|like that)|actually|wrong|don'?t (?:do|use|add|put|include|say)|never (?:do|say|use)|stop (?:doing|using|saying)|please (?:stop|don'?t))\b/i, label: "user-correction" },
  // Preferences — durable stylistic / working choices
  { kind: "preference", pattern: /\b(?:i (?:prefer|like|want|need|use|hate|love|always|never)|i'?m (?:into|not into)|prefer(?:ence)? (?:is|to be)|remember this|save this|keep (?:this|that) in mind|note (?:this|that)|don'?t forget)\b/i, label: "user-preference" },
  // Identity statements about the agent (what you are, how you should be)
  { kind: "identity", pattern: /\b(?:you(?:'?re| are) (?:not |going to be |becoming |suppose(?:d)? to|gonna be |meant to)|i (?:see|treat) you as|your (?:job|role|purpose) is|be (?:more|less) )/i, label: "agent-identity" },
  // Decisions — joint architectural / scope calls
  { kind: "decision", pattern: /\b(?:let'?s (?:go with|use|do|skip|drop)|we(?:'?ll| will|'?re) (?:use|going with|do(?:ing)?|skip(?:ping)?|drop(?:ping)?)|decided to|going with)\b/i, label: "joint-decision" },
];

export function detectCaptures(userMessage: string): CaptureMatch[] {
  const matches: CaptureMatch[] = [];
  const seen = new Set<string>();
  for (const rule of PATTERNS) {
    const found = userMessage.match(rule.pattern);
    if (!found) continue;
    const key = `${rule.kind}:${found[0].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      kind: rule.kind,
      pattern: rule.label,
      excerpt: excerptAround(userMessage, found.index ?? 0, found[0].length),
    });
  }
  return matches;
}

export interface CaptureResult {
  matches: CaptureMatch[];
  loggedTo?: string;
  bytesAppended: number;
}

export async function captureUserMessage(opts: {
  home?: string;
  userMessage: string;
  now?: Date;
}): Promise<CaptureResult> {
  const matches = detectCaptures(opts.userMessage);
  if (matches.length === 0) return { matches: [], bytesAppended: 0 };

  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  await fs.mkdir(paths.memoryDir, { recursive: true });
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const file = path.join(paths.memoryDir, `${today}.md`);
  const stamp = (opts.now ?? new Date()).toISOString();
  const lines = matches.map(
    (m) => `- ${stamp} — capture/${m.kind} (${m.pattern}) — "${m.excerpt.replace(/"/g, "'").slice(0, 220)}"`,
  );
  const exists = await fileExists(file);
  const payload = (exists ? "" : `# ${today} raw memory\n\n`) + lines.join("\n") + "\n";
  await fs.appendFile(file, payload, "utf8");

  // Group matches by kind so each kind gets a single +N CAPTURE card.
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.kind, (counts.get(match.kind) ?? 0) + 1);
  for (const [kind, count] of counts) {
    emitLifecycle({
      type: "capture_detected",
      kinds: [kind],
      excerpt: matches.find((m) => m.kind === kind)?.excerpt.slice(0, 120) ?? "",
      gain: gainForTarget(`CAPTURE/${kind.toUpperCase()}`, count, kind),
    });
  }

  return { matches, loggedTo: file, bytesAppended: payload.length };
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const info = await fs.stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}
