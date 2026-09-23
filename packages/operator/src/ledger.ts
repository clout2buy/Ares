// The capabilities ledger — ONE source of truth.
//
// Before this file there were two: the JSON capability graph (what the planner
// reads) and a hand-maintained CAPABILITIES.md (what the model narrates to
// itself). They diverged — the markdown claimed skills the graph had never
// heard of and pointed at a home that no longer existed. Divergent ledgers are
// poison: the entity believes one thing and plans on another.
//
// Resolution: the JSON graph is authoritative. CAPABILITIES.md is GENERATED
// from it (never hand-edited, never trusted by the planner). `renderCapabilities
// Doc` is a pure function of the graph, so the doc can never silently drift —
// regenerate and it matches reality by construction.
//
// Field notes are the one exception, and they are the part that matters most:
// proven how-tos ("the doingbot admin API: log in like this, read a channel
// with that GET"). Ares does its best work exactly where one exists. The doc
// is rewritten on every session start, and until 2026-09-22 that rewrite
// silently deleted every recipe anyone had added — the music and Discord
// recipes that made those tasks one call instead of thirty-four were lost this
// way. Notes now live between FIELD_NOTES markers, are carried across every
// rewrite verbatim, and sit ABOVE the generated lists so a context budget that
// truncates the tail cuts the generated inventory, never a recipe.

import { readFile } from "node:fs/promises";
import { agentPaths, writeFileAtomic } from "@ares/agent";
import type { CapabilityNode, CapabilityStatus } from "./capability.js";
import { reliabilityOf } from "./capability.js";

const PREAMBLE = `# Capabilities ledger

_GENERATED FROM the operator capability graph (~/.ares/operator/graph/). Do not
hand-edit the generated lists — they are overwritten on the next seed/sync. The
JSON graph is the single source of truth; this file is a human-readable
projection of it. EXCEPTION: the Field notes section is kept verbatim across
regeneration — add proven recipes there (or append them at the end of the file;
they are moved into Field notes on the next rewrite)._

_Status legend: **mastered** (crystallized + verified) · **have** (>=1 verified
success) · **available** (real tool/skill wired, not yet proven) · **learning**
· **want** (gap, no method) · **rotted** (health check failing) · **forbidden**._
`;

const STATUS_ORDER: CapabilityStatus[] = [
  "mastered",
  "have",
  "available",
  "learning",
  "want",
  "rotted",
  "forbidden",
];

const STATUS_HEADING: Record<CapabilityStatus, string> = {
  mastered: "Mastered",
  have: "Have (verified, not yet crystallized)",
  available: "Available (wired, not yet proven)",
  learning: "Learning",
  want: "Want (gap — no method yet)",
  rotted: "Rotted (was working, now failing)",
  forbidden: "Forbidden (ToS/KYC/policy)",
};

function renderNode(node: CapabilityNode): string {
  const methods = (node.methods ?? []).map((m) => `${m.kind}:${m.ref}`).join(", ") || "—";
  const rel = reliabilityOf(node);
  const bits = [
    node.domain ? `domain ${node.domain}` : null,
    `via ${methods}`,
    `${node.outcomes.ok}✓/${node.outcomes.fail}✗`,
    rel === null ? null : `${Math.round(rel * 100)}% reliable`,
    node.requiresHumanApproval ? "**requires human approval**" : null,
  ].filter(Boolean);
  return `- \`${node.id}\` — ${node.name} (${bits.join(", ")})`;
}

export const FIELD_NOTES_START = "<!-- field-notes:start — kept verbatim across regeneration -->";
export const FIELD_NOTES_END = "<!-- field-notes:end -->";
const FOOTER_RE = /^_\d+ capabilities — generated [^\n]*_$/m;

/**
 * The hand/agent-written notes in an existing ledger: the text between the
 * FIELD_NOTES markers, plus anything appended after the generated footer
 * (SelfEvolve appends to the end of the file). Empty when there are none.
 */
export function extractFieldNotes(existing: string): string {
  const parts: string[] = [];
  const start = existing.indexOf(FIELD_NOTES_START);
  const end = existing.indexOf(FIELD_NOTES_END);
  if (start >= 0 && end > start) {
    parts.push(existing.slice(start + FIELD_NOTES_START.length, end));
  }
  const footer = FOOTER_RE.exec(existing);
  if (footer) parts.push(existing.slice(footer.index + footer[0].length));
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Pure projection of the capability graph into the ledger markdown. */
export function renderCapabilitiesDoc(nodes: readonly CapabilityNode[], fieldNotes = ""): string {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sections: string[] = [PREAMBLE];
  const notes = fieldNotes.trim();
  if (notes) {
    sections.push(`## Field notes — proven recipes (use these first)\n\n${FIELD_NOTES_START}\n${notes}\n${FIELD_NOTES_END}`);
  }
  for (const status of STATUS_ORDER) {
    const inStatus = sorted.filter((n) => n.status === status);
    if (inStatus.length === 0) continue;
    sections.push(`## ${STATUS_HEADING[status]}\n\n${inStatus.map(renderNode).join("\n")}`);
  }
  sections.push(`_${sorted.length} capabilities — generated ${nodes.length ? "from the live graph" : "(empty graph)"}._`);
  return sections.join("\n\n") + "\n";
}

/** Write the generated ledger to ~/.ares/CAPABILITIES.md from the live graph,
 *  carrying the existing field notes across. */
export async function writeCapabilitiesDoc(home: string, nodes: readonly CapabilityNode[]): Promise<string> {
  const file = agentPaths(home).capabilities;
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFileAtomic(file, renderCapabilitiesDoc(nodes, extractFieldNotes(existing)));
  return file;
}
