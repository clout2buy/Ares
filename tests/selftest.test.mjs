// `ares selftest` and the daily self-test put a throwaway offline daemon
// through the paths that have bricked chats, and must never reach the
// owner's real home, memory server or garrison.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfTest, isolatedEnv, formatSelfTest } from "../packages/cli/dist/selfTest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("the self-test passes every brick check on a healthy build", { timeout: 120_000 }, async () => {
  const result = await runSelfTest(entry);
  assert.equal(result.ok, true, formatSelfTest(result));
  assert.deepEqual(result.checks.map((c) => c.name), [
    "the engine starts",
    "a message gets a reply",
    "a ping is answered while a turn is stuck",
    "another chat answers while one is stuck",
    "Stop frees the stuck chat and it answers again",
  ]);
});

test("the throwaway daemon is cut off from the owner's environment", () => {
  process.env.ARES_SOME_OWNER_SETTING = "secret";
  process.env.ARES_MNEMOSYNE_PORT = "7777";
  try {
    const env = isolatedEnv("/tmp/selftest-home");
    assert.equal(env.ARES_SOME_OWNER_SETTING, undefined);
    assert.equal(env.ARES_MNEMOSYNE_PORT, undefined);
    assert.equal(env.ARES_MNEMOSYNE, "0");
    assert.equal(env.ARES_SELFTEST_DAILY, "0", "no recursion");
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ARES_HOME"]) assert.equal(env[key], "/tmp/selftest-home", key);
  } finally {
    delete process.env.ARES_SOME_OWNER_SETTING;
    delete process.env.ARES_MNEMOSYNE_PORT;
  }
});
