// "Remember this": an owner-pinned memory lands in MEMORY.md at once and
// survives deep dreaming, which rewrites MEMORY.md wholesale and would
// otherwise drop a memory nobody has recalled yet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinOwnerMemory, runDeepDream, loadAgentConfig, createMemoryStore } from "../packages/agent/dist/index.js";

test("a pinned memory is in MEMORY.md now and after a deep dream", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-pin-"));
  try {
    const pinned = await pinOwnerMemory({ home, text: "  Crix wants   game builds to target 60 fps on the laptop.  " });
    assert.equal(pinned.content, "Crix wants game builds to target 60 fps on the laptop.");
    const memoryFile = path.join(home, "MEMORY.md");
    assert.match(readFileSync(memoryFile, "utf8"), /\[USER#\d+\] Crix wants game builds to target 60 fps/);

    const config = await loadAgentConfig(home);
    // Something ordinary that qualifies, so deep dreaming really rewrites the file.
    const store = await createMemoryStore(config, home);
    await store.add({ category: "PROJECT", content: "The parkour map uses three.js.", source: "light-dreaming", score: 1 });
    await runDeepDream({ home, config });
    assert.match(readFileSync(memoryFile, "utf8"), /parkour map uses three\.js/, "the rewrite happened");
    assert.match(readFileSync(memoryFile, "utf8"), /Crix wants game builds to target 60 fps/, "deep dreaming keeps what the owner pinned");

    await assert.rejects(pinOwnerMemory({ home, text: "   " }), /nothing to remember/);
  } finally {
    // Windows keeps the SQLite file locked a moment after the test; a leftover
    // temp dir must not fail the test.
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the OS reaps temp */ }
  }
});
