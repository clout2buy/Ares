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

test("Browser act batches a multi-control job and verifies only the final state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-act-"));
  const calls = [];
  let url = "https://x.com/home";
  const browser = {
    name: "fake",
    async state() { return { url, title: "Profile" }; },
    async close() {},
    async attachToExisting(query) { calls.push(["attach", query]); return true; },
    async navigate(next) { calls.push(["open", next]); url = next; return { url, title: "Profile" }; },
    async accessibilityTree() { return []; },
    async fillByLabel(label, value) { calls.push(["fill", label, value]); },
    async clickByRole(role, name) { calls.push(["click", role, name]); },
    async screenshot() { calls.push(["screenshot"]); return { format: "png", bytes: "AA==" }; },
  };
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async () => browser);
  const ctx = { signal: new AbortController().signal };
  try {
    const result = await tool.call({
      action: "act",
      steps: [
        { action: "open", url: "https://x.com/example" },
        { action: "click", role: "button", name: "Edit profile" },
        { action: "fill", label: "Bio", value: "Ares" },
        { action: "click", role: "button", name: "Save" },
      ],
    }, ctx);
    assert.equal(result.output.status, "ok");
    assert.equal(result.output.result.completed.length, 4);
    assert.equal(result.images.length, 1);
    assert.deepEqual(calls, [
      ["attach", "https://x.com/example"],
      ["open", "https://x.com/example"],
      ["click", "button", "Edit profile"],
      ["fill", "Bio", "Ares"],
      ["click", "button", "Save"],
      ["screenshot"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
