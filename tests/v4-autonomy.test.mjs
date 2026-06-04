// Verifies the autonomy layer:
//   1. composeAgentSystemPrompt injects the Autonomy Charter.
//   2. detectCaptures picks up preference / correction / identity / decision signals.
//   3. captureUserMessage appends those signals to today's raw memory file.
//   4. Bootstrap charter is included when IDENTITY is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BootstrapTool,
  agentPaths,
  captureUserMessage,
  composeAgentSystemPrompt,
  detectCaptures,
  loadAgentSystemContext,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "crix-autonomy-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("Autonomy Charter is injected into the composed system prompt", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-ws-");
  process.env.CRIX_HOME = home;
  try {
    await BootstrapTool.call(
      { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct", emoji: "*" },
      { workspace, signal: new AbortController().signal },
    );
    const context = await loadAgentSystemContext({ home, workspace });
    const composed = composeAgentSystemPrompt("BASE SYSTEM PROMPT", context);
    assert.match(composed, /Autonomy Charter/);
    assert.match(composed, /you initiate/i);
    assert.match(composed, /SelfEvolve/);
    assert.match(composed, /full sovereignty/i);
    assert.ok(!/Agent Bootstrap \(required/.test(composed), "bootstrap charter should be absent post-bootstrap");
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("Bootstrap Charter is included when IDENTITY is absent", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-ws-");
  const context = await loadAgentSystemContext({ home, workspace });
  const composed = composeAgentSystemPrompt("BASE", context);
  assert.equal(context.bootstrapRequired, true);
  assert.match(composed, /Autonomy Charter/);
  assert.match(composed, /Agent Bootstrap/);
  assert.match(composed, /call the `Bootstrap` tool/);
});

test("detectCaptures recognizes preference / correction / identity / decision signals", () => {
  const corrections = detectCaptures("no don't add error handling there");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].kind, "correction");

  const prefs = detectCaptures("honestly i prefer terse commits with no fluff");
  assert.ok(prefs.some((m) => m.kind === "preference"), "should detect preference");

  const explicitMemory = detectCaptures("remember this: I want image attachments in the app");
  assert.ok(explicitMemory.some((m) => m.kind === "preference"), "should detect explicit memory request");

  const identity = detectCaptures("i see you as more than a chatbot, you're becoming something new");
  assert.ok(identity.some((m) => m.kind === "identity"), "should detect identity statement");

  const decision = detectCaptures("let's go with pnpm and skip yarn");
  assert.ok(decision.some((m) => m.kind === "decision"), "should detect joint decision");

  const noise = detectCaptures("can you read foo.ts and explain what it does");
  assert.equal(noise.length, 0, "neutral request should not match");
});

test("captureUserMessage appends signals to today's raw memory file", async () => {
  const home = await makeTmp();
  process.env.CRIX_HOME = home;
  try {
    const paths = agentPaths(home);
    const result = await captureUserMessage({
      home,
      userMessage: "honestly i prefer blunt no fluff, dont be careful, just drive",
    });
    assert.ok(result.matches.length >= 1, "expected at least one capture");
    assert.ok(result.loggedTo, "loggedTo should be set when matches exist");
    const today = new Date().toISOString().slice(0, 10);
    const expectedPath = path.join(paths.memoryDir, `${today}.md`);
    assert.equal(path.resolve(result.loggedTo), path.resolve(expectedPath));
    const log = await fs.readFile(result.loggedTo, "utf8");
    assert.match(log, /capture\/(preference|correction)/);
    assert.match(log, /prefer blunt/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("captureUserMessage is a no-op for neutral messages", async () => {
  const home = await makeTmp();
  process.env.CRIX_HOME = home;
  try {
    const result = await captureUserMessage({
      home,
      userMessage: "what does this function do",
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.bytesAppended, 0);
    assert.equal(result.loggedTo, undefined);
  } finally {
    delete process.env.CRIX_HOME;
  }
});
