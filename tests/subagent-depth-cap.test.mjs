// Subagent recursion cap + trimmed child prompt hook.
//
//   - ARES_SUBAGENT_MAX_DEPTH (default 1): children cannot spawn children.
//   - At the cap, Task/Conductor/CodingBackend are scoped out of the child's belt.
//   - A run that somehow arrives from the cap is a clear error (the Task tool
//     surfaces thrown errors as is_error tool results).
//   - SubagentRunnerOptions.systemPromptForChild lets a host hand children a
//     trimmed prompt instead of the full parent prompt; default unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AresSubagentRunner,
  SubagentRegistry,
  SUBAGENT_SPAWNING_TOOLS,
  scopeSubagentTools,
  currentSubagentDepth,
  runAtSubagentDepth,
  subagentMaxDepth,
} from "../packages/core/dist/index.js";

function fakeTool(name, call = async () => ({ output: "ok" })) {
  return { schema: { name, description: name, inputJsonSchema: { type: "object" }, safety: "read-only" }, call };
}

/** Records every request it sees, replies "done" — optionally calls a tool first. */
function recordingProvider(firstTool) {
  return {
    name: "recording",
    requests: [],
    async *stream(req) {
      this.requests.push({ system: req.system, tools: req.tools.map((t) => t.name) });
      const hasToolResult = req.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
      if (firstTool && !hasToolResult) {
        yield { type: "tool_use_start", id: "t1", name: firstTool.name };
        yield { type: "tool_use_input_done", id: "t1", input: firstTool.input };
        yield {
          type: "message_done",
          message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: firstTool.name, input: firstTool.input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield {
        type: "message_done",
        message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("scopeSubagentTools drops Task/Conductor/CodingBackend for a child at the cap", () => {
  const tools = [fakeTool("Read"), fakeTool("Task"), fakeTool("Conductor"), fakeTool("CodingBackend"), fakeTool("Grep")];
  assert.deepEqual(scopeSubagentTools(tools, undefined, { depth: 1 }).map((t) => t.schema.name), ["Read", "Grep"]);
  assert.deepEqual(scopeSubagentTools(tools, undefined, { depth: 0 }).map((t) => t.schema.name), ["Read", "Task", "Conductor", "CodingBackend", "Grep"], "below the cap the spawning tools stay");
  assert.deepEqual(scopeSubagentTools(tools).map((t) => t.schema.name), ["Read", "Task", "Conductor", "CodingBackend", "Grep"], "legacy call without depth is unchanged");
  assert.deepEqual([...SUBAGENT_SPAWNING_TOOLS].sort(), ["CodingBackend", "Conductor", "Task"]);
  assert.equal(subagentMaxDepth(), 1, "default max depth");
});

test("a general-purpose child runs at depth 1 with Task scoped out; a nested Task is a clear error", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-depth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let nestedAttempts = 0;
  let nestedError = null;
  let depthSeenInsideChild = -1;
  const provider = recordingProvider({ name: "Probe", input: {} });
  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider,
    model: "m",
    baseSystemPrompt: "PARENT PROMPT",
    parentTools: [
      fakeTool("Read"),
      fakeTool("Task"),
      fakeTool("Conductor"),
      // Simulates a tool the child calls that tries to spawn through the shared runner.
      fakeTool("Probe", async () => {
        depthSeenInsideChild = currentSubagentDepth();
        nestedAttempts++;
        try {
          await runner.run({ subagent_type: "researcher", description: "nested", prompt: "x", workspace: dir });
        } catch (err) {
          nestedError = err;
        }
        return { output: "probed" };
      }),
    ],
  });
  const result = await runner.run({ subagent_type: "general-purpose", description: "outer", prompt: "do it", workspace: dir });
  assert.equal(result.status, "completed");
  assert.equal(depthSeenInsideChild, 1, "the child turn runs at depth 1");
  assert.equal(nestedAttempts, 1);
  assert.ok(nestedError, "the nested spawn was refused");
  assert.match(String(nestedError.message), /depth cap/);
  assert.match(String(nestedError.message), /ARES_SUBAGENT_MAX_DEPTH=1/);
  const childTools = provider.requests[0].tools;
  assert.ok(childTools.includes("Read") && childTools.includes("Probe"));
  assert.ok(!childTools.includes("Task") && !childTools.includes("Conductor"), "spawning tools scoped out of the child's belt");
  assert.equal(currentSubagentDepth(), 0, "depth does not leak past the run");
});

test("explicit depth on the request and the ALS depth both hit the cap; ARES_SUBAGENT_MAX_DEPTH raises it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-depth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = recordingProvider();
  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider,
    model: "m",
    baseSystemPrompt: "P",
    parentTools: [fakeTool("Read"), fakeTool("Task")],
  });
  await assert.rejects(
    () => runner.run({ subagent_type: "researcher", description: "d", prompt: "p", workspace: dir, depth: 1 }),
    /depth cap/,
  );
  await assert.rejects(
    () => runAtSubagentDepth(1, () => runner.run({ subagent_type: "researcher", description: "d", prompt: "p", workspace: dir })),
    /depth cap/,
  );
  await withEnv("ARES_SUBAGENT_MAX_DEPTH", "2", async () => {
    const result = await runner.run({ subagent_type: "general-purpose", description: "d", prompt: "p", workspace: dir, depth: 1 });
    assert.equal(result.status, "completed", "depth 1 → child at depth 2 is allowed when the cap is 2");
    assert.ok(!provider.requests.at(-1).tools.includes("Task"), "…but that child (at the new cap) still loses Task");
  });
});

test("systemPromptForChild replaces the appended parent prompt; default behaviour unchanged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-depth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const full = "FULL PARENT PROMPT ".repeat(50);
  const withDefault = recordingProvider();
  await new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider: withDefault,
    model: "m",
    baseSystemPrompt: full,
    parentTools: [fakeTool("Read")],
  }).run({ subagent_type: "researcher", description: "d", prompt: "p", workspace: dir });
  assert.ok(withDefault.requests[0].system.includes(full), "default: the parent prompt is appended");

  const trimmed = recordingProvider();
  const seenTypes = [];
  await new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider: trimmed,
    model: "m",
    baseSystemPrompt: full,
    systemPromptForChild: (type) => {
      seenTypes.push(type.name);
      return "TRIMMED CHILD PROMPT";
    },
    parentTools: [fakeTool("Read")],
  }).run({ subagent_type: "researcher", description: "d", prompt: "p", workspace: dir });
  assert.deepEqual(seenTypes, ["researcher"]);
  assert.ok(trimmed.requests[0].system.includes("TRIMMED CHILD PROMPT"));
  assert.ok(!trimmed.requests[0].system.includes(full), "the full parent prompt is NOT appended");
  assert.match(trimmed.requests[0].system, /RESEARCHER subagent/, "the type prompt still leads");
});
