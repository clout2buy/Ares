// A code search that ran out of embedding budget before asking for the query
// vector abandoned the request; when Ollama then answered 404 (model not
// pulled) the rejection was unhandled and landed in the daemon crash log.
import test from "node:test";
import assert from "node:assert/strict";
import { withinBudget } from "../packages/tools/dist/CodebaseSearch.js";

test("an abandoned embed request that fails later is not an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const late404 = new Promise((_, reject) => setTimeout(() => reject(new Error("ollama embed failed: HTTP 404")), 20));
    await assert.rejects(withinBudget(late404, Date.now() - 1), /budget exhausted/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
