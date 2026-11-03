// Weekly self-file refresh — IDENTITY.md / USER.md that keep up with the truth.
//
// Field evidence, 2026-11-02: IDENTITY.md still opened with "I am Rook ...
// living in ~/.crix/" and "doingbox at 192.168.1.41", followed further down
// by a correction paragraph saying .237, followed by a second correction
// retracting the first. Self-files only ever grew by appended corrections, so
// every session read three contradicting answers to "where is my box?" and
// the stale one came first.
//
// This pass runs inside the DEEP dream (the existing dream cadence — no new
// timer), at most once per ARES_SELF_REFRESH_DAYS (default 7, 0 = off). It
// gathers the recent typed facts, finds contradictions (one host with two
// IPs, one "Name:" with two values), and writes a PROPOSED rewrite beside each
// file (IDENTITY.proposed.md, USER.proposed.md). It never overwrites a
// self-file: the owner reviews the proposal and adopts it (or asks Ares to).
// With a model (`rewrite`), the proposal is a full rewritten file; without
// one it is the current file under a header listing what to fix.

import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { factSignature, parseCuratedMemory, curatedTypeOf, type CuratedFact } from "@ares/mind";
import { agentPaths } from "./paths.js";
import { writeFileAtomic } from "./files.js";

export type SelfFileName = "IDENTITY.md" | "USER.md";

/** Model hook: return the full rewritten file, or "" to fall back. */
export type SelfFileRewriter = (input: {
  name: SelfFileName;
  current: string;
  records: string[];
  contradictions: string[];
}) => Promise<string>;

export interface SelfFileProposal {
  name: SelfFileName;
  /** Where the proposal was written (beside the self-file). */
  file: string;
  contradictions: string[];
  /** Recent records the file does not reflect yet. */
  records: number;
  /** True when a model wrote the proposal. */
  rewritten: boolean;
}

export interface SelfRefreshResult {
  /** False when the weekly gate said "not yet" (or the pass is off). */
  ran: boolean;
  proposals: SelfFileProposal[];
}

/** ARES_SELF_REFRESH_DAYS: days between refreshes (default 7; 0 = off). */
export function selfRefreshEveryDays(): number {
  const raw = process.env.ARES_SELF_REFRESH_DAYS;
  if (raw === undefined || raw.trim() === "") return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

export function selfRefreshMarker(home: string): string {
  return path.join(home, "mind", ".last-self-refresh");
}

export function proposalPathFor(selfFile: string): string {
  return selfFile.replace(/\.md$/i, ".proposed.md");
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Words that sit before "is at" but name no particular machine. */
const GENERIC_HOST_WORDS = new Set([
  "box", "server", "machine", "host", "it", "that", "this", "home", "address", "ip", "the", "which", "laptop", "pc",
  "computer", "device", "user", "now", "currently", "still", "really", "actually", "also",
]);
const KEYED_FIELDS = new Set(["name", "ip", "address", "host", "hostname", "email", "phone", "timezone", "time zone", "location", "birthday", "pronouns", "username"]);

interface HostMention { host: string; at: number }

function hostMentions(line: string): HostMention[] {
  const out: HostMention[] = [];
  // `name` — a backticked identifier that is not itself an address or a path.
  for (const m of line.matchAll(/`([A-Za-z][\w.-]{2,})`/g)) {
    const name = m[1].toLowerCase();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(name) || GENERIC_HOST_WORDS.has(name)) continue;
    out.push({ host: name, at: m.index ?? 0 });
  }
  // name is at / name at / name on / name ( <ip>
  for (const m of line.matchAll(/\b([A-Za-z][\w-]{2,})\s+(?:is\s+(?:now\s+)?)?(?:at|on|@|\()\s*[`*]*(?=\d{1,3}\.)/g)) {
    const name = m[1].toLowerCase();
    if (GENERIC_HOST_WORDS.has(name)) continue;
    out.push({ host: name, at: m.index ?? 0 });
  }
  for (const m of line.matchAll(/\b([A-Za-z][\w-]{2,})\s*\(\s*[`*]*(?=\d{1,3}\.)/g)) {
    const name = m[1].toLowerCase();
    if (GENERIC_HOST_WORDS.has(name)) continue;
    out.push({ host: name, at: m.index ?? 0 });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Deterministic contradiction finder. Two kinds, both cheap and specific:
 *   - one host named with two different IPv4 addresses ("doingbox: 192.168.1.41
 *     vs 192.168.1.237"). Each address belongs to the nearest host mention
 *     before it on its line (or after it, when none precedes);
 *   - one identity field ("- Name:", "- Email:", ...) given two values.
 * Order of values = order of appearance, so the LAST one is the newest claim.
 */
export function findContradictions(text: string): string[] {
  const ipsByHost = new Map<string, string[]>();
  const valuesByKey = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const ips = [...line.matchAll(IPV4)];
    if (ips.length > 0) {
      const hosts = hostMentions(line);
      for (const ip of ips) {
        const at = ip.index ?? 0;
        const before = hosts.filter((h) => h.at < at).at(-1);
        const host = before ?? hosts.find((h) => h.at > at);
        if (!host) continue;
        const list = ipsByHost.get(host.host) ?? [];
        if (!list.includes(ip[0])) list.push(ip[0]);
        ipsByHost.set(host.host, list);
      }
    }
    const kv = /^\s*[-*]\s*\*{0,2}([A-Za-z][A-Za-z ]{1,20}?)\*{0,2}\s*:\s*(.+?)\s*$/.exec(line);
    if (kv && KEYED_FIELDS.has(kv[1].trim().toLowerCase())) {
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].replace(/[`*_]/g, "").trim();
      const list = valuesByKey.get(key) ?? [];
      if (value && !list.some((v) => v.toLowerCase() === value.toLowerCase())) list.push(value);
      valuesByKey.set(key, list);
    }
  }
  const out: string[] = [];
  for (const [host, ips] of ipsByHost) if (ips.length > 1) out.push(`${host}: ${ips.join(" vs ")}`);
  for (const [key, values] of valuesByKey) if (values.length > 1) out.push(`${key}: ${values.join(" vs ")}`);
  return out;
}

/** Is this record already said in `text`? (Most of its salient words present.) */
function reflectedIn(record: string, textTokens: Set<string>): boolean {
  const tokens = factSignature(record).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const present = tokens.filter((t) => textTokens.has(t)).length;
  return present / tokens.length >= 0.8;
}

function renderRecord(fact: CuratedFact): string {
  return `- [${fact.type}] ${fact.content}${fact.why ? ` — why: ${fact.why}` : ""}`;
}

/** Which self-file a typed record belongs in: who the owner is → USER.md;
 *  how the agent works, where things live, what it is doing → IDENTITY.md. */
function belongsIn(fact: CuratedFact): SelfFileName {
  return fact.type === "user" ? "USER.md" : "IDENTITY.md";
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run the refresh if it is due (or `force`). `records` are the recent typed
 * facts (oldest first) — the deep dream passes what it just curated; when
 * absent, MEMORY.md's entries are used. Never throws for a missing file.
 */
export async function runSelfFileRefresh(opts: {
  home: string;
  now?: Date;
  records?: readonly CuratedFact[];
  rewrite?: SelfFileRewriter;
  force?: boolean;
}): Promise<SelfRefreshResult> {
  const now = opts.now ?? new Date();
  const everyDays = selfRefreshEveryDays();
  if (!opts.force && everyDays <= 0) return { ran: false, proposals: [] };
  const marker = selfRefreshMarker(opts.home);
  if (!opts.force) {
    const last = await stat(marker).then((s) => s.mtimeMs).catch(() => 0);
    if (last > 0 && now.getTime() - last < everyDays * 86_400_000) return { ran: false, proposals: [] };
  }
  const paths = agentPaths(opts.home);
  const records = opts.records ?? parseCuratedMemory(await readIfExists(paths.memory));
  const proposals: SelfFileProposal[] = [];
  for (const [name, file] of [["IDENTITY.md", paths.identity], ["USER.md", paths.user]] as const) {
    const current = await readIfExists(file);
    if (!current.trim()) continue;
    const textTokens = new Set(factSignature(current).split(" "));
    const fresh = records.filter((r) => belongsIn({ ...r, type: curatedTypeOf(r.type) }) === name && !reflectedIn(r.content, textTokens)).map(renderRecord);
    const contradictions = findContradictions(current);
    if (fresh.length === 0 && contradictions.length === 0) continue;
    let body = "";
    if (opts.rewrite) {
      body = (await opts.rewrite({ name, current, records: fresh, contradictions }).catch(() => "")).trim();
    }
    const rewritten = body.length > 0;
    const header = [
      `<!-- Proposed rewrite of ${name}, from the weekly self-file refresh (${now.toISOString()}).`,
      `     ${name} itself was NOT changed. Review this, then replace ${name} with it (or ask Ares to). -->`,
      "",
    ];
    if (!rewritten) {
      header.push(`# Proposed changes to ${name}`, "");
      if (contradictions.length > 0) {
        header.push("## Contradictions — keep the newest, delete the rest", "", ...contradictions.map((c) => `- ${c}`), "");
      }
      if (fresh.length > 0) header.push("## Recent records this file does not reflect yet", "", ...fresh, "");
      header.push("## Current file", "");
    }
    const target = proposalPathFor(file);
    await writeFileAtomic(target, `${header.join("\n")}${rewritten ? body : current.trimEnd()}\n`);
    proposals.push({ name, file: target, contradictions, records: fresh.length, rewritten });
  }
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, `${now.toISOString()}\n`, "utf8");
  return { ran: true, proposals };
}

/** The system prompt for the model rewrite (daemon side-call). */
export const SELF_FILE_REWRITE_SYSTEM =
  "You maintain an AI agent's self-file (IDENTITY.md describes the agent and its world; USER.md describes its owner). " +
  "Rewrite the file so it states what is true NOW: fold in the recent records, resolve every listed contradiction in favour " +
  "of the newest statement (records are newer than the file; later lines are newer than earlier ones), delete superseded " +
  "and retracted text instead of appending corrections, and keep everything still true. Keep the owner's voice and headings. " +
  "Output ONLY the full rewritten markdown file.";

/** The user turn for the model rewrite. */
export function selfFileRewritePrompt(input: { name: SelfFileName; current: string; records: string[]; contradictions: string[] }): string {
  return [
    `File: ${input.name}`,
    "",
    "Contradictions found:",
    ...(input.contradictions.length ? input.contradictions.map((c) => `- ${c}`) : ["- (none)"]),
    "",
    "Recent records (newest knowledge):",
    ...(input.records.length ? input.records : ["- (none)"]),
    "",
    "Current file:",
    "",
    input.current,
  ].join("\n");
}
