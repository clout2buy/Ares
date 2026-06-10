// Where the mind lives. Default is under the immortal home, but the memory
// root is PLUGGABLE — point it at a flashdrive and Ares just lives there
// ("make this your home"). That's the whole portability story: one path.
//
// Mind is the foundational layer, so it owns its own home resolution and depends
// on nothing above it. `aresHome` MUST resolve identically to the agent/operator
// home so the whole entity shares one ~/.ares.
//
// REBRAND (V0): the home moved from ~/.crix to ~/.ares. Resolution honors the
// legacy $CRIX_HOME env var, and the first touch of the default ~/.ares home
// copy-migrates an existing ~/.crix into it — copy, never move, with a
// MIGRATED.md breadcrumb left behind so nothing an older binary wrote is ever
// destroyed by the rename.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MindPaths {
  home: string;
  mindDir: string;
  memoryFile: string;
}

const LEGACY_HOME_DIRNAME = ".crix";
let migrationChecked = false;

/** Resolve Ares's immortal home (`$ARES_HOME`, legacy `$CRIX_HOME`, or ~/.ares). */
export function aresHome(explicit?: string): string {
  const resolved = path.resolve(
    explicit ?? process.env.ARES_HOME ?? process.env.CRIX_HOME ?? path.join(os.homedir(), ".ares"),
  );
  // Auto-migration only ever targets the DEFAULT home. An explicit or
  // env-selected home is the owner's deliberate choice — leave it alone.
  if (!migrationChecked && resolved === path.resolve(path.join(os.homedir(), ".ares"))) {
    migrationChecked = true;
    migrateLegacyHome(resolved, path.join(os.homedir(), LEGACY_HOME_DIRNAME));
  }
  return resolved;
}

/**
 * One-time copy-migration of a legacy ~/.crix home into ~/.ares.
 *
 * Invariants (tested in tests/ares-rebrand.test.mjs):
 *   - COPY, never move: the legacy home is left fully intact.
 *   - Idempotent: an existing target home is never touched again.
 *   - Breadcrumb: MIGRATED.md is written into the legacy home so a human
 *     (or an old binary) can see where the entity went.
 *   - Best-effort: any failure leaves both homes as they were and returns false.
 */
export function migrateLegacyHome(target: string, legacy: string): boolean {
  try {
    if (fs.existsSync(target)) return false;
    if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return false;
    fs.cpSync(legacy, target, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "MIGRATED.md"),
      [
        "# This home has been migrated",
        "",
        `Crix is now Ares. On ${new Date().toISOString()} this directory was COPIED to:`,
        "",
        `    ${target}`,
        "",
        "Nothing here was deleted or moved — this copy is now the inactive original.",
        "New Ares binaries read and write the new home; old Crix binaries keep working",
        "against this one. Once you trust the migration, this directory can be removed.",
      ].join("\n") + "\n",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror legacy CRIX_* environment variables onto their ARES_* names (never
 * overwriting an ARES_* value that is already set). Call once at process
 * start; returns the number of variables bridged.
 */
export function bridgeLegacyEnv(env: NodeJS.ProcessEnv = process.env): number {
  let bridged = 0;
  for (const key of Object.keys(env)) {
    if (!key.startsWith("CRIX_")) continue;
    const aresKey = `ARES_${key.slice("CRIX_".length)}`;
    if (env[aresKey] === undefined) {
      env[aresKey] = env[key];
      bridged++;
    }
  }
  return bridged;
}

/** Test seam: reset the one-time migration latch. */
export function __resetHomeMigrationForTests(): void {
  migrationChecked = false;
}

export function mindPaths(explicit?: string): MindPaths {
  const home = aresHome(explicit);
  const mindDir = path.join(home, "mind");
  return { home, mindDir, memoryFile: path.join(mindDir, "memory.jsonl") };
}
