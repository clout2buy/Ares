#!/usr/bin/env node
// Measure the System surfaces against a real Ares home, READ-ONLY.
//   node scripts/elite/ops-bench.mjs [~/.ares] [workspace]
// Prints one JSON object: how long a cold and a cached snapshot take, the disk
// breakdown, and what a housekeeping DRY RUN would reclaim (nothing is deleted,
// nothing is written: persist=false). No secrets, no file contents.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createSystemService } = await import(path.join(root, "packages/cli/dist/systemSnapshot.js"));
const { Housekeeping } = await import(path.join(root, "packages/cli/dist/systemHousekeeping.js"));

const home = path.resolve(process.argv[2] ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"));
const workspace = path.resolve(process.argv[3] ?? process.env.ARES_WORKSPACE ?? path.join(os.homedir(), "Ares"));
const workspaces = [workspace];
if (path.basename(home) === ".ares") workspaces.push(path.dirname(home));

const service = createSystemService({ home, workspaces });
const t0 = performance.now();
const cold = await service.snapshot();
const coldMs = performance.now() - t0;
// The first snapshot waits at most 2 s for the background disk walk; give it time to finish for the breakdown.
let withDisk = cold;
for (let i = 0; i < 60 && (withDisk.disk.scanning || withDisk.disk.dirs.length === 0); i++) {
  await new Promise((r) => setTimeout(r, 500));
  withDisk = await service.snapshot({ fresh: true });
}
const t1 = performance.now();
await service.snapshot();
const cachedMs = performance.now() - t1;

const hk = new Housekeeping({ home, workspaces, persist: false, gcCheckpoints: async () => {} });
const t2 = performance.now();
const dry = await hk.run({ dryRun: true });
const dryMs = performance.now() - t2;
const mb = (n) => Math.round((n / 1_048_576) * 10) / 10;

console.log(JSON.stringify({
  home: home.replace(os.homedir(), "~"),
  snapshot: { coldMs: Math.round(coldMs), cachedMs: Math.round(cachedMs * 10) / 10, status: cold.status, headline: cold.headline },
  disk: { usedPct: withDisk.disk.usedPct, dirsMb: Object.fromEntries(withDisk.disk.dirs.map((d) => [d.key, mb(d.bytes)])) },
  housekeepingDryRun: {
    ms: Math.round(dryMs),
    wouldActOn: dry.totals.acted,
    wouldFreeMb: mb(dry.totals.bytes),
    perJob: Object.fromEntries(Object.entries(dry.jobs).map(([k, v]) => [k, { found: v.found, acted: v.acted, mb: mb(v.bytes), ...(v.error ? { error: v.error } : {}) }])),
  },
}, null, 2));
