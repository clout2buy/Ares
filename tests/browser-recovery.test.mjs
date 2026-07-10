import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBrowserTool } from "../packages/cli/dist/entry/browserBridge.js";

test("Browser tool reacquires a connector after its page is closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-recovery-"));
  let creations = 0;
  let firstClosed = false;
  let closeCalls = 0;
  const createBrowser = async () => {
    creations++;
    const mine = creations;
    return {
      name: "fake",
      async state() {
        if (mine === 1 && firstClosed) throw new Error("Target page, context or browser has been closed");
        return { url: mine === 1 ? "https://first.test" : "https://recovered.test", title: mine === 1 ? "first" : "recovered" };
      },
      async close() { closeCalls++; },
      async navigate(url) { return { url, title: "fake" }; },
      async accessibilityTree() { return []; },
      async fillByLabel() {},
      async clickByRole() {},
      async screenshot() { return { format: "png", bytes: "" }; },
    };
  };
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, createBrowser);
  const ctx = { signal: new AbortController().signal };
  try {
    const first = await tool.call({ action: "state" }, ctx);
    assert.equal(first.output.result.url, "https://first.test");
    firstClosed = true;
    const recovered = await tool.call({ action: "state" }, ctx);
    assert.equal(recovered.output.result.url, "https://recovered.test");
    assert.equal(creations, 2);
    assert.equal(closeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
