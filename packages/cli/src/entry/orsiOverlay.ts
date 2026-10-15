// ORSI overlay — the one text block Ares lets an evolution loop change.
//
// ORSI (~/ORSI on doingbox, reachable through its door) evolves what an agent
// runs on and proves each change in sandboxes before it ships. Ares exposes
// exactly one gene to it: `rules`, a short block of operating rules that rides
// the system prompt AFTER the laws (laws outrank it, always). The evolved text
// lives in <home>/orsi-genome.json, refreshed from the door by orsiDoor.ts;
// this module only READS it, synchronously and mtime-cached, so composing a
// prompt never waits on the network. No file, no door, no env → DEFAULT_RULES,
// which is also what ORSI measures as the champion, so production and the
// sandbox champion are the same text.
import fs from "node:fs";
import path from "node:path";

/** The seed gene. Short on purpose: ORSI's guard anchors to it and vetoes drift past the limit clauses. */
export const DEFAULT_RULES = [
  "Read before you edit, and re-read after: the file on disk is the truth, not your memory of it.",
  "A tool that errors is a fact to act on, not noise: fix the cause or change approach; never repeat the same failing call.",
  "Do not claim done without evidence from a tool: a test run, a command's output, a file read back.",
  "Say what you could not do, plainly, instead of narrating around it.",
].join("\n");

export const GENE = "rules";

export interface OrsiGenomeFile {
  genome?: Record<string, string>;
  proposal?: string | null;
  applied_at?: string | null;
  version?: string;
  fetched_at?: string;
}

export function genomePath(home: string): string {
  return path.join(home, "orsi-genome.json");
}

let cached: { file: string; mtimeMs: number; rules: string } | null = null;

/** The current `rules` text: evolved when ORSI proved one, the seed otherwise. */
export function currentRules(home: string): string {
  const file = genomePath(home);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return DEFAULT_RULES;
  }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.rules;
  let rules = DEFAULT_RULES;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as OrsiGenomeFile;
    const evolved = parsed.genome?.[GENE];
    if (typeof evolved === "string" && evolved.trim()) rules = evolved.trim();
  } catch {
    rules = DEFAULT_RULES;
  }
  cached = { file, mtimeMs, rules };
  return rules;
}

/** The prompt block. Rendered from `rules` (an explicit override wins — the sandbox runner passes the job's genome). */
export function evolvedRulesBlock(rules: string): string {
  const text = rules.trim();
  if (!text) return "";
  return `## Operating rules\n${text}`;
}
