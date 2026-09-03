// Named tool_choice + structural plan-before-edit.
//
//   - ProviderRequest.toolChoice admits "auto" | "any" | "none" | {type:"tool",name}
//     and every provider body builder emits the right wire shape.
//   - With planBeforeEdit set by the host and no TodoWrite plan yet, the FIRST
//     model call of the turn forces TodoWrite; the second call is auto.
//     ARES_PLAN_BEFORE_EDIT=0 disables; chat turns are untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";
import { buildMessagesBody } from "../packages/core/dist/providers/anthropic.js";
import { buildRequestBody, responsesToolChoice } from "../packages/core/dist/providers/openaiResponses.js";
import { buildChatBody, chatToolChoice } from "../packages/core/dist/providers/openrouter.js";

const tools = [{ name: "TodoWrite", description: "plan", input_schema: { type: "object", properties: {} } }];
const req = (toolChoice, extra = {}) => ({
  model: "m",
  system: "s",
  messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: new Date().toISOString() }],
  tools,
  toolChoice,
  reasoningLevel: "off",
  ...extra,
});

test("Anthropic body: any / none / named tool; thinking suppresses forced calls except on DeepSeek", () => {
  assert.deepEqual(buildMessagesBody(req("any")).tool_choice, { type: "any" });
  assert.deepEqual(buildMessagesBody(req("none")).tool_choice, { type: "none" });
  assert.deepEqual(buildMessagesBody(req({ type: "tool", name: "TodoWrite" })).tool_choice, { type: "tool", name: "TodoWrite" });
  assert.equal(buildMessagesBody(req("auto")).tool_choice, undefined);
  assert.equal(buildMessagesBody(req(undefined)).tool_choice, undefined);
  // Extended thinking forbids forced tool use on Anthropic proper…
  assert.equal(buildMessagesBody(req({ type: "tool", name: "TodoWrite" }, { reasoningLevel: "high" })).tool_choice, undefined);
  // …"none" is not a forced call, so it survives thinking…
  assert.deepEqual(buildMessagesBody(req("none", { reasoningLevel: "high" })).tool_choice, { type: "none" });
  // …and the DeepSeek dialect accepts both.
  assert.deepEqual(buildMessagesBody(req({ type: "tool", name: "TodoWrite" }, { reasoningLevel: "high" }), "deepseek").tool_choice, { type: "tool", name: "TodoWrite" });
});

test("OpenAI Responses body: required / none / {type:function,name}", () => {
  assert.equal(buildRequestBody(req("any")).tool_choice, "required");
  assert.equal(buildRequestBody(req("none")).tool_choice, "none");
  assert.deepEqual(buildRequestBody(req({ type: "tool", name: "TodoWrite" })).tool_choice, { type: "function", name: "TodoWrite" });
  assert.equal(buildRequestBody(req(undefined)).tool_choice, "auto");
  assert.equal(responsesToolChoice("auto"), "auto");
});

test("OpenRouter / DeepSeek chat body: required / none / {type:function,function:{name}}", () => {
  for (const flavor of ["openrouter", "deepseek"]) {
    assert.equal(buildChatBody("m", req("any"), flavor).tool_choice, "required");
    assert.equal(buildChatBody("m", req("none"), flavor).tool_choice, "none");
    assert.deepEqual(buildChatBody("m", req({ type: "tool", name: "TodoWrite" }), flavor).tool_choice, { type: "function", function: { name: "TodoWrite" } });
    assert.equal(buildChatBody("m", req(undefined), flavor).tool_choice, "auto");
  }
  assert.deepEqual(chatToolChoice({ type: "tool", name: "X" }), { type: "function", function: { name: "X" } });
});

// ─── Engine: plan-before-edit forces TodoWrite on the first call only ─────────

function planningProvider() {
  let call = 0;
  return {
    name: "planning",
    choices: [],
    async *stream(req) {
      this.choices.push(req.toolChoice);
      call++;
      if (call === 1) {
        const input = { todos: [{ content: "step 1", status: "pending", activeForm: "doing step 1" }] };
        yield { type: "tool_use_start", id: "todo1", name: "TodoWrite" };
        yield { type: "tool_use_input_done", id: "todo1", input };
        yield {
          type: "message_done",
          message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "todo1", name: "TodoWrite", input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield {
        type: "message_done",
        message: { id: `m${call}`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

const todoWriteTool = {
  schema: { name: "TodoWrite", description: "plan", inputJsonSchema: { type: "object" }, safety: "read-only" },
  async call(input) { return { output: { todos: input.todos.map((t) => ({ ...t, status: "completed" })) } }; },
};

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
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

test("planBeforeEdit: first call forced to TodoWrite, second call auto, next turn untouched", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-plan-first-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = planningProvider();
  let substantial = true;
  const engine = QueryEngine.forTesting({
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [todoWriteTool],
    workspace: dir,
    planBeforeEdit: () => substantial,
  }, "sess_plan_first");
  engine.appendUserMessage("refactor the whole auth module");
  const events = await collect(engine);
  assert.equal(events.at(-1).status, "completed");
  assert.deepEqual(provider.choices[0], { type: "tool", name: "TodoWrite" }, "first call forced");
  assert.equal(provider.choices[1], undefined, "second call auto");
  // A later turn already has a plan on record → no forcing even if still substantial.
  engine.appendUserMessage("continue");
  await collect(engine);
  assert.equal(provider.choices[2], undefined, "an existing plan disables forcing");
});

test("planBeforeEdit is inert for chat/trivial turns, when TodoWrite is absent, and under ARES_PLAN_BEFORE_EDIT=0", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-plan-first-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chat = planningProvider();
  const chatEngine = QueryEngine.forTesting({ provider: chat, model: "m", systemPrompt: "s", tools: [todoWriteTool], workspace: dir }, "sess_plan_chat");
  chatEngine.appendUserMessage("hi");
  await collect(chatEngine);
  assert.equal(chat.choices[0], undefined, "no host flag → no forcing");

  const noTool = planningProvider();
  const noToolEngine = QueryEngine.forTesting({ provider: noTool, model: "m", systemPrompt: "s", tools: [], workspace: dir, planBeforeEdit: true }, "sess_plan_notool");
  noToolEngine.appendUserMessage("big task");
  await collect(noToolEngine);
  assert.equal(noTool.choices[0], undefined, "cannot force a tool that is not in the belt");

  await withEnv("ARES_PLAN_BEFORE_EDIT", "0", async () => {
    const off = planningProvider();
    const offEngine = QueryEngine.forTesting({ provider: off, model: "m", systemPrompt: "s", tools: [todoWriteTool], workspace: dir, planBeforeEdit: true }, "sess_plan_off");
    offEngine.appendUserMessage("big task");
    await collect(offEngine);
    assert.equal(off.choices[0], undefined, "env kill-switch");
  });
});

test("act-first 'any' for goal mode still applies when plan-before-edit is not requested", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-plan-first-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = planningProvider();
  const engine = QueryEngine.forTesting({ provider, model: "m", systemPrompt: "s", tools: [todoWriteTool], workspace: dir }, "sess_goal_any");
  engine.appendWorkItem("autonomous goal");
  await collect(engine);
  assert.equal(provider.choices[0], "any");
  assert.equal(provider.choices[1], undefined);
});
