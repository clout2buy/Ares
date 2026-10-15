// Browser verification is not "stalling". Field case (Owlogy session,
// 2026-10-15, deepseek-v4.1-flash): the model ran a dozen distinct Browser
// `eval`s to verify its i18n fix in the live PWA. gatherSignature keyed the
// Browser tool on action+url only, so every eval collapsed to "browser:eval:",
// none counted as novel, the gather-stall tripped, and the engine told the
// model to "STOP gathering and act" mid-ship — it dumped a status wall and
// asked the user to say "continue". Now:
//   1. distinct eval scripts against one page are novel gathers;
//   2. a page-changing Browser action (act/open/click/preview) is progress,
//      exactly like ComputerUse;
//   3. the SAME eval re-run over and over still trips the stall.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Session } from "../packages/core/dist/index.js";

const browserTool = {
  schema: { name: "Browser", description: "browser", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "exclusive" },
  classifyInput(input) {
    return { safety: input?.action === "eval" || input?.action === "screenshot" ? "read-only" : "external-state" };
  },
  call: async (input) => ({ output: { action: input.action, status: "ok" } }),
};

/** Emits one Browser call per round from `inputs`, then ends the turn. */
function browserProvider(inputs) {
  let round = 0;
  return {
    name: "browser-scripted",
    async *stream() {
      const input = inputs[round];
      round++;
      if (input) {
        const id = `t${round}`;
        yield { type: "tool_use_start", id, name: "Browser" };
        yield { type: "tool_use_input_done", id, input };
        yield {
          type: "message_done",
          message: { id: `a${round}`, role: "assistant", content: [{ type: "tool_use", id, name: "Browser", input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "done", role: "assistant", content: [{ type: "text", text: "verified" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

async function run(inputs) {
  process.env.ARES_GATHER_STALL_ROUNDS = "3";
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-browser-stall-"));
  try {
    const session = new Session({ workspace, provider: browserProvider(inputs), model: "m", systemPrompt: "s", tools: [browserTool], contextBudgetTokens: 0 });
    const events = [];
    for await (const e of session.send("verify the fix in the browser")) events.push(e);
    return events.filter((e) => e.type === "system_reminder_injected" && /gather-stall|STOP gathering/.test(e.text ?? ""));
  } finally {
    delete process.env.ARES_GATHER_STALL_ROUNDS;
    rmSync(workspace, { recursive: true, force: true });
  }
}

const page = "https://example.test/app";

test("distinct Browser evals against one page are novel — no stall reminder across 8 checks", async () => {
  const inputs = Array.from({ length: 8 }, (_, i) => ({ action: "eval", url: page, js: `document.querySelector('#check-${i}').textContent` }));
  const stalls = await run(inputs);
  assert.equal(stalls.length, 0, `verification loop must not be told to stop: ${stalls.map((s) => s.text).join(" | ")}`);
});

test("a page-changing Browser action (act/open/click) resets the stall clock like ComputerUse", async () => {
  const same = { action: "eval", url: page, js: "document.title" };
  const inputs = [same, same, { action: "act", steps: [{ action: "click_text", query: "Save" }] }, same, same, { action: "open", url: page }, same, same];
  const stalls = await run(inputs);
  assert.equal(stalls.length, 0, "progress every two rounds keeps the three-round stall from firing");
});

test("the SAME eval re-run again and again still trips the stall", async () => {
  const same = { action: "eval", url: page, js: "document.title" };
  const stalls = await run([same, same, same, same, same]);
  assert.ok(stalls.length >= 1, "re-running one identical observation is a real stall");
});
