#!/usr/bin/env node
// Shrink garrison rollouts written before tool_progress was capped on disk.
// Run with the garrison STOPPED (it appends to these files):
//   sudo systemctl stop ares-garrison.service
//   node scripts/compact-rollouts.mjs [~/.ares]
//   sudo systemctl start ares-garrison.service
// Each file is rewritten via a temp file + rename; only tool_progress lines
// change, everything else is kept byte-for-byte.
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { compactRolloutEvent, sessionsDir } from "../packages/garrison/dist/index.js";

const home = process.argv[2] ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
const dir = sessionsDir(home);
let before = 0;
let after = 0;
for (const name of await fs.readdir(dir)) {
  if (!name.endsWith(".jsonl")) continue;
  const file = path.join(dir, name);
  const size = (await fs.stat(file)).size;
  const tmp = `${file}.compact-${process.pid}`;
  const out = createWriteStream(tmp, { encoding: "utf8" });
  let changed = false;
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    let next = line;
    if (line.includes('"tool_progress"')) {
      try {
        const entry = JSON.parse(line);
        const event = compactRolloutEvent(entry.event);
        if (event !== entry.event) {
          next = JSON.stringify({ ...entry, event });
          changed = true;
        }
      } catch {
        // torn line: keep as is
      }
    }
    if (!out.write(next + "\n")) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  if (!changed) {
    await fs.rm(tmp);
    before += size;
    after += size;
    continue;
  }
  const newSize = (await fs.stat(tmp)).size;
  await fs.rename(tmp, file);
  before += size;
  after += newSize;
  console.log(`${name}: ${(size / 1e6).toFixed(1)}MB -> ${(newSize / 1e6).toFixed(1)}MB`);
}
console.log(`total ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
