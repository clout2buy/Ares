// The friction telemetry, read back for Introspect: the newest friction_turn
// lines from <home>/telemetry/friction-YYYY-MM.jsonl, newest first. The
// recorder (core/frictionLog.ts) writes them; `ares friction` aggregates
// them; this is the per-turn view the model uses to notice what keeps
// failing or taking long — the raw material for "want a tool for that?".

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { telemetryDir } from "@ares/core";

export interface FrictionRow {
  at: string;
  sessionId?: string;
  status?: string;
  durationMs?: number;
  tools?: Record<string, { calls: number; errors: number }>;
  stalls?: number;
  compactions?: number;
  diagnostics?: unknown[];
  unverified?: unknown;
  model?: string;
}

export async function readRecentFriction(home: string, limit = 60): Promise<FrictionRow[]> {
  const dir = telemetryDir(home);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("friction-") && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const rows: FrictionRow[] = [];
  for (const file of files.slice(0, 2)) {
    let text: string;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as FrictionRow & { recordType?: string };
        if (row.recordType !== "friction_turn") continue;
        const { at, sessionId, status, durationMs, tools, stalls, compactions, diagnostics, unverified, model } = row;
        rows.push({ at, sessionId, status, durationMs, tools, stalls, compactions, ...(diagnostics?.length ? { diagnostics } : {}), ...(unverified ? { unverified } : {}), model });
      } catch {
        // a torn line at the tail of a live file
      }
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}
