#!/usr/bin/env node
// ares-verify: build + typecheck + full suite + security check of ONE sha in a throwaway worktree,
// then a signed result file (<ARES_HOME>/elite/results/<sha>.json) that ares-deploy demands.
//
//   node scripts/elite/ares-verify.mjs --sha <sha|ref> [--branch auto/2026-10-01-x] [--base <sha>]
//        [--repo ~/forge/ares] [--live-dir ~/Ares] [--keep] [--json]
//
// Exit: 0 green, 1 red (details in the result), 2 usage/setup error.
// The signing key is created on first use (0600) or comes from ARES_VERIFY_KEY. See docs/ELITE-SELFIMPROVE.md.

import { expandHome, parseArgs } from "./lib/common.mjs";
import { verifyChange } from "./lib/verify.mjs";

let args;
try { args = parseArgs(process.argv.slice(2), { booleans: ["keep", "json", "help"] }); }
catch (err) { console.error(`ares-verify: ${err.message}`); process.exit(2); }
if (args.help || !args.sha) {
  console.error("usage: ares-verify --sha <sha|ref> [--branch B] [--base SHA] [--repo DIR] [--live-dir DIR] [--keep] [--json]");
  process.exit(args.help ? 0 : 2);
}

try {
  const out = await verifyChange({
    sha: args.sha,
    branch: args.branch,
    base: args.base,
    repo: expandHome(args.repo),
    liveDir: expandHome(args["live-dir"]),
    home: expandHome(args.home),
    keep: args.keep === true,
    log: args.json ? () => {} : (l) => console.error(`ares-verify: ${l}`),
    commands: Object.fromEntries(["install", "build", "lint", "test"].filter((k) => args[`${k}-cmd`]).map((k) => [k, args[`${k}-cmd`]])),
  });
  if (args.json) console.log(JSON.stringify({ green: out.green, file: out.file, sha: out.payload.sha, risk: out.payload.risk.class, tests: out.payload.tests }));
  else console.log(`${out.green ? "GREEN" : "RED"} ${out.payload.sha.slice(0, 8)} risk=${out.payload.risk.class}${out.payload.risk.requiresOwnerApproval ? " (needs explicit owner approval)" : ""} tests=${out.payload.tests.pass}/${out.payload.tests.total} -> ${out.file}`);
  process.exit(out.green ? 0 : 1);
} catch (err) {
  console.error(`ares-verify: ${err?.message ?? err}`);
  process.exit(2);
}
