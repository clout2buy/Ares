import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(__dirname, "..", "packages", "cli", "dist", "entry.js");

test("V4 V10: themes command exposes clean graphite and oxide themes", () => {
  const result = spawnSync(process.execPath, [cliEntry, "themes"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /graphite/);
  assert.match(result.stdout, /oxide/);
});

test("V4 V10: daemon --json emits ready event for companion UI protocol", () => {
  const result = spawnSync(process.execPath, [cliEntry, "daemon", "--json", "--provider", "mock"], {
    input: JSON.stringify({ type: "exit" }) + "\n",
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon_ready/);
});

