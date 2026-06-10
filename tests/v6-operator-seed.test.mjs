import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { listCapabilities, seedNativeCapabilities } from "../packages/operator/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-op-seed-"));
}

test("operator: native capability seed gives a fresh graph a truthful body", async () => {
  const home = await makeDir();
  const first = await seedNativeCapabilities(home, new Date("2026-06-02T00:00:00Z"));
  assert.ok(first.created >= 8, "fresh graph should create native capabilities");
  assert.equal(first.kept, 0);

  const caps = await listCapabilities(home);
  assert.ok(caps.some((c) => c.id === "native/read-files" && c.status === "mastered"));
  assert.ok(caps.some((c) => c.id === "native/recall-memory" && c.outcomes.ok >= 3));
  assert.equal(caps.every((c) => c.novelDeltaAtBirth === 0), true, "native floor is not novel learned work");

  const second = await seedNativeCapabilities(home);
  assert.equal(second.created, 0, "seed is idempotent");
  assert.ok(second.kept >= first.created);

  await fs.rm(home, { recursive: true, force: true });
});
