// Extracted from entry.ts — mindCmd.

import { notice } from "../terminalUi.js";
import { runCrucibleTrials, type Goal, type CapabilityNode } from "@ares/operator";
import { diagnoseMemory, MemoryRouter, MemoryStore, withConsolidationLock, type MemoryKind, type MemoryOverviewRow } from "@ares/mind";
import { ParsedArgs, cliRuntimeContext } from "./runtime.js";

function glyphFor(action: "promoted" | "archived" | "demoted" | "held"): string {
  return action === "promoted" ? "+" : action === "archived" ? "x" : action === "demoted" ? "v" : "~";
}

export async function mindCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  const memoryFile = args.flags.get("root") ?? context.mind.memoryFile;
  const store = await MemoryStore.open(memoryFile);
  const json = args.flags.has("json");

  if (subcommand === "add") {
    const content = args.flags.get("content") ?? args.positionals.slice(1).join(" ").trim();
    if (!content) {
      process.stderr.write('error: usage: ares mind add --content "<text>" [--kind episodic|semantic|procedural]\n');
      return 2;
    }
    const raw = args.flags.get("kind") ?? "episodic";
    const kind: MemoryKind = raw === "semantic" || raw === "procedural" ? raw : "episodic";
    const routed = await new MemoryRouter(store).write("manual", [{ kind, content }]);
    const node = routed.written[0]?.node;
    if (!node) {
      process.stderr.write("error: the memory router did not accept the write\n");
      return 1;
    }
    if (json) {
      process.stdout.write(JSON.stringify(node, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Mind", [`remembered (${node.kind}): ${node.content}`], "success"));
    return 0;
  }

  if (subcommand === "recall") {
    const cue = args.flags.get("cue") ?? args.positionals.slice(1).join(" ").trim();
    if (!cue) {
      process.stderr.write('error: usage: ares mind recall "<cue>"\n');
      return 2;
    }
    const results = await store.remember(cue);
    if (json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      return 0;
    }
    if (results.length === 0) {
      process.stdout.write(notice("Recall", ["Nothing comes to mind."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Recall",
        results.map((r) => `${r.viaAssociation ? "↝" : "•"} [${r.node.kind}] ${r.node.content}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "forget") {
    const id = args.flags.get("id") ?? args.positionals.slice(1).join(" ").trim();
    if (!id) {
      process.stderr.write('error: usage: ares mind forget <id>\n');
      return 2;
    }
    const forgotten = await store.forget(id);
    if (json) {
      process.stdout.write(JSON.stringify({ id, forgotten }, null, 2) + "\n");
      return forgotten ? 0 : 1;
    }
    process.stdout.write(
      forgotten
        ? notice("Mind", [`forgot ${id}`], "success")
        : notice("Mind", [`no memory found with id ${id}`], "warn"),
    );
    return forgotten ? 0 : 1;
  }

  if (subcommand === "about") {
    // The owner-facing "what I know" surface. Read-only (store.overview never
    // reinforces), owner scope only — a guest:* pool never renders here.
    const limitFlag = Number(args.flags.get("limit"));
    const groups = store.overview(Number.isFinite(limitFlag) && limitFlag > 0 ? { limit: limitFlag } : {});
    if (json) {
      process.stdout.write(JSON.stringify(groups, null, 2) + "\n");
      return 0;
    }
    const total = groups.semantic.length + groups.procedural.length + groups.episodic.length;
    if (total === 0) {
      process.stdout.write(notice("Mind · about", ["I hold no owner-scoped memories yet."], "warn"));
      return 0;
    }
    const renderRow = (r: MemoryOverviewRow): string =>
      `  ${r.id}  ${r.content}` +
      `  · str ${r.currentStrength.toFixed(2)}/${r.strength.toFixed(1)} · ×${r.activations} · ${r.ageDays}d` +
      (r.confidence !== undefined ? ` · conf ${r.confidence.toFixed(2)}` : "") +
      (r.tags?.length ? ` · ${r.tags.join(",")}` : "");
    const lines: string[] = ["what I believe about you and this work:"];
    const sections: Array<[string, MemoryOverviewRow[]]> = [
      ["believe (semantic)", groups.semantic],
      ["can do (procedural)", groups.procedural],
      ["remember happening (episodic)", groups.episodic],
    ];
    for (const [label, rows] of sections) {
      if (rows.length === 0) continue;
      lines.push(`${label}:`);
      for (const row of rows) lines.push(renderRow(row));
    }
    lines.push('`ares mind edit <id> "..."` corrects · `ares mind forget <id>` deletes');
    process.stdout.write(notice("Mind · about", lines, "info"));
    return 0;
  }

  if (subcommand === "edit") {
    const id = args.positionals[1] ?? "";
    const text = (args.flags.get("content") ?? args.positionals.slice(2).join(" ")).trim();
    if (!id || !text) {
      process.stderr.write('error: usage: ares mind edit <id> "<corrected text>"\n');
      return 2;
    }
    // Under the consolidation lock: an edit racing consolidate()'s whole-file
    // rewrite in another process would be silently clobbered otherwise.
    const result = await withConsolidationLock(memoryFile, () => store.edit(id, text));
    if (result === undefined) {
      const held = store.get(id) !== undefined;
      process.stderr.write(
        held
          ? "error: edit skipped — another Ares process holds the consolidation lock; try again in a moment\n"
          : `error: no memory found with id ${id}\n`,
      );
      return 1;
    }
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      notice("Mind · corrected", [
        `before: ${result.before.content}`,
        `after:  ${result.after.content}`,
        `confidence → 1 (you said so) · ${result.after.id}`,
      ], "success"),
    );
    return 0;
  }

  if (subcommand === "crucible") {
    // V7 — the trial. Candidates face their checks and records; confirmed
    // knowledge is tenure-audited. Deterministic; probes run against reality.
    const report = await runCrucibleTrials({ store, workspace: context.workspace });
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    const lines =
      report.verdicts.length === 0
        ? ["no candidates awaiting trial"]
        : report.verdicts.map((v) => `${glyphFor(v.action)} [${v.action}] ${v.claim} — ${v.reason}`);
    lines.push(`reviewed ${report.reviewed} · promoted ${report.promoted} · archived ${report.archived} · demoted ${report.demoted} · held ${report.held}`);
    process.stdout.write(notice("Crucible · trial", lines, report.archived + report.demoted > 0 ? "warn" : "success"));
    return 0;
  }

  if (subcommand === "consolidate") {
    const report = await withConsolidationLock(memoryFile, () => store.consolidate());
    if (!report) {
      process.stdout.write(notice("Mind", ["consolidation skipped — another Ares process holds the consolidation lock"], "warn"));
      return 0;
    }
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      notice(
        "Mind · consolidated",
        [`forgot ${report.pruned} trivial · merged ${report.deduped} duplicate(s) · crystallized ${report.promoted.length} theme(s)${report.promoted.length ? ` (${report.promoted.join(", ")})` : ""} · ${report.kept} kept`],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "doctor" || subcommand === "stats") {
    const report = diagnoseMemory(store.all());
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    const lines = [
      `${report.total} memories (${report.byKind.episodic} episodic, ${report.byKind.semantic} semantic, ${report.byKind.procedural} procedural)`,
      `${report.generatedThemeSemantics} generated theme semantic(s), ${report.noisyThemeSemantics} noisy`,
      `${report.duplicateGroups.length} duplicate group(s), ${report.orphanLinks.length} orphan-link node(s), ${report.lowStrengthEpisodes} faded episode(s)`,
    ];
    if (report.oversized.length) lines.push(`${report.oversized.length} oversized entr${report.oversized.length === 1 ? "y" : "ies"}`);
    lines.push("Recommendations:");
    for (const rec of report.recommendations) lines.push(`  ${rec}`);
    process.stdout.write(notice("Mind Doctor", lines, report.noisyThemeSemantics || report.orphanLinks.length ? "warn" : "info"));
    return 0;
  }

  // list (default)
  const all = store.all();
  if (json) {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return 0;
  }
  if (all.length === 0) {
    process.stdout.write(notice("Mind", ["Memory is empty."], "warn"));
    return 0;
  }
  process.stdout.write(
    notice(
      `Mind · ${all.length} memories`,
      all.slice(0, 40).map((n) => `[${n.kind}] ${n.content}${n.links.length ? ` · ${n.links.length} links` : ""}`),
      "info",
    ),
  );
  return 0;
}

export function capGlyph(status: CapabilityNode["status"]): string {
  switch (status) {
    case "mastered":
      return "★";
    case "have":
      return "✓";
    case "learning":
      return "…";
    case "want":
      return "?";
    case "rotted":
      return "⚠";
    case "forbidden":
      return "⛔";
    default:
      return "•";
  }
}

export function statusGlyph(status: Goal["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "blocked":
      return "⚠";
    case "abandoned":
      return "✗";
    default:
      return "•";
  }
}
