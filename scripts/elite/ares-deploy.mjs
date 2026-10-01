#!/usr/bin/env node
// ares-deploy: put a VERIFIED sha live on this box, prove it works, roll back by itself if not.
//
//   node scripts/elite/ares-deploy.mjs (--sha <sha> | --branch <name>) [--dry-run]
//        [--yes [--ack-high-risk]] | [--approval-receipt <file>]
//        [--drain <minutes>] [--live ~/Ares] [--fetch-from rook|<path>] [--service ares-garrison]
//        [--base-url http://127.0.0.1:7422] [--smoke-ask on|warn|off] [--ready-timeout 120] [--title "..."]
//
// Exit: 0 deployed / already live / dry run, 1 refused, 3 busy (sessions mid-turn), 4 rolled back,
//       5 rollback FAILED (needs a human), 6 another deploy holds the lock.
// Never run against the live tree by anything but the owner, the lead, or Ares after the owner's
// approval. See docs/ELITE-SELFIMPROVE.md.

import os from "node:os";
import path from "node:path";
import { expandHome, parseArgs } from "./lib/common.mjs";
import { deployChange, EXIT } from "./lib/deploy.mjs";

process.on("SIGHUP", () => {}); // a closed terminal must not abandon a half-finished deploy

let a;
try { a = parseArgs(process.argv.slice(2), { booleans: ["dry-run", "yes", "ack-high-risk", "help", "json", "no-notify"] }); }
catch (err) { console.error(`ares-deploy: ${err.message}`); process.exit(2); }
if (a.help || (!a.sha && !a.branch)) {
  console.error("usage: ares-deploy (--sha SHA | --branch NAME) [--dry-run] [--yes [--ack-high-risk] | --approval-receipt FILE] [--drain MIN] [--live DIR] [--fetch-from REMOTE|PATH] [--service UNIT] [--base-url URL] [--smoke-ask on|warn|off] [--title TEXT]");
  process.exit(a.help ? 0 : 2);
}
const num = (v, d) => (v === undefined ? d : Number.isFinite(Number(v)) ? Number(v) : d);

const out = await deployChange({
  sha: a.sha,
  branch: a.branch,
  live: expandHome(a.live ?? process.env.ARES_LIVE_DIR ?? path.join(os.homedir(), "Ares")),
  home: expandHome(a.home),
  fetchFrom: expandHome(a["fetch-from"]),
  service: a.service,
  baseUrl: a["base-url"],
  dryRun: a["dry-run"] === true,
  yes: a.yes === true,
  ackHighRisk: a["ack-high-risk"] === true,
  receiptFile: expandHome(a["approval-receipt"]),
  drainMin: num(a.drain, 0),
  smokeAsk: a["smoke-ask"] ?? process.env.ARES_DEPLOY_SMOKE_ASK,
  readyTimeoutMs: num(a["ready-timeout"], 120) * 1000,
  requestedBy: a["requested-by"] ?? "cli",
  proposalId: a.proposal,
  title: a.title,
  notify: a["no-notify"] ? false : undefined,
  log: a.json ? () => {} : (l) => console.error(`ares-deploy: ${l}`),
});
if (a.json) console.log(JSON.stringify({ status: out.status, exitCode: out.exitCode, record: out.recordFile, reason: out.record.reason }));
else console.log(`${out.status.toUpperCase()}${out.record.sha ? ` ${out.record.sha.slice(0, 8)}` : ""}${out.record.reason ? ` - ${out.record.reason}` : ""}${out.recordFile ? `\nrecord: ${out.recordFile}` : ""}`);
process.exit(out.exitCode ?? EXIT.refused);
