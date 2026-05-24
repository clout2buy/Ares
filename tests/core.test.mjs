import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentOrchestrator, AgentRuntime, CrixKernel, EventStore, MemoryStore, OpenAIOAuthProvider, SafetyPolicy, ShellExecutor, ToolRuntime, TurnEngine, TurnRecorder, analyzeShellCommand, defaultAgents, defaultTools, guardFinalAnswerClaims, planTurnIntent, runProviderToolLoop } from "../packages/core/dist/index.js";

async function tempWorkspace() {
  return await mkdtemp(path.join(os.tmpdir(), "crix-ts-test-"));
}

test("memory search ranks relevant memories", async () => {
  const workspace = await tempWorkspace();
  const memory = new MemoryStore(workspace);
  await memory.remember("Use TypeScript for the main agent harness", ["architecture"]);
  await memory.remember("Java worker remains available for heavier analysis", ["java"]);
  const hits = await memory.search("typescript harness");
  assert.equal(hits[0]?.tags[0], "architecture");
});

test("policy blocks unsafe git push verification", async () => {
  const workspace = await tempWorkspace();
  const report = await new ShellExecutor(workspace).verify({ program: "git", args: ["push"] });
  assert.equal(report.ok, false);
  assert.match(report.blockedReason ?? "", /not verification-safe|blocked/i);
});

test("shell safety analyzer blocks shell wrappers and dangerous commands", () => {
  assert.equal(analyzeShellCommand({ program: "powershell", args: ["-EncodedCommand", "AAAA"] }).denied, true);
  assert.equal(analyzeShellCommand({ program: "git", args: ["reset", "--hard"] }).denied, true);
  assert.equal(analyzeShellCommand({ program: "curl", args: ["https://example.invalid"] }).denied, true);
  assert.equal(analyzeShellCommand({ program: "node", args: ["--check", "src/app.js"] }).readOnly, true);
});

test("verification policy uses shell safety analysis", async () => {
  const workspace = await tempWorkspace();
  const report = await new ShellExecutor(workspace).verify({ program: "powershell", args: ["-Command", "Remove-Item -Recurse -Force ."] });
  assert.equal(report.ok, false);
  assert.match(report.blockedReason ?? "", /blocked shell command|remove-item/i);
});

test("dry run does not write workspace file but writes proof", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "dry run",
    summary: "dry run plan",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "x" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "dry run", planFile: planPath, dryRun: true });
  assert.equal(proof.status, "dry-run");
  assert.equal(existsSync(path.join(workspace, "marker.txt")), false);
  assert.equal(existsSync(proof.proofPath), true);
});

test("apply plan writes file and runs allowlisted verification", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "apply plan",
    summary: "write check file",
    steps: [{ id: "write", title: "write check", safety: "workspace-write", type: "write_file", path: "check.js", content: "const ok = true;\n" }],
    verification: [{ program: "node", args: ["--check", "check.js"], timeoutMs: 120000 }]
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "apply plan", planFile: planPath });
  assert.equal(proof.status, "passed");
  assert.match(proof.turnId, /^turn_/);
  assert.equal(existsSync(proof.turnArtifactPath), true);
  assert.match(await readFile(path.join(workspace, "check.js"), "utf8"), /ok/);
  assert.equal(proof.verification[0]?.ok, true);

  const turn = JSON.parse(await readFile(proof.turnArtifactPath, "utf8"));
  assert.deepEqual(
    turn.items.map((item) => item.kind),
    ["tool_call", "assistant_message", "policy_decision", "file_change", "tool_call", "command_execution", "proof"],
  );
  assert.equal(turn.items[0]?.title, "list_dir");
  assert.equal(turn.items.find((item) => item.kind === "policy_decision")?.summary, "workspace-write allows scoped local edits");
  assert.match(turn.items.find((item) => item.kind === "file_change")?.summary, /wrote/);
  assert.equal(turn.items.some((item) => item.kind === "tool_call" && item.title === "write_file"), true);
});

test("run goal records denied steps as policy decision turn items", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "deny write",
    summary: "try a write",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "x" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "auto-safe" });
  const proof = await kernel.runGoal({ goal: "deny write", planFile: planPath });
  const turn = JSON.parse(await readFile(proof.turnArtifactPath, "utf8"));
  const policyItem = turn.items.find((item) => item.kind === "policy_decision");
  const fileItem = turn.items.find((item) => item.kind === "file_change");

  assert.equal(proof.status, "blocked");
  assert.equal(existsSync(path.join(workspace, "marker.txt")), false);
  assert.equal(policyItem.status, "cancelled");
  assert.match(policyItem.summary, /auto-safe refuses writes/);
  assert.equal(fileItem.status, "cancelled");
  assert.match(fileItem.summary, /denied/);
});

test("run goal derives effective safety from step type instead of trusting provider labels", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "mislabeled write",
    summary: "write mislabeled as read-only",
    steps: [{ id: "write", title: "write marker", safety: "read-only", type: "write_file", path: "marker.txt", content: "x" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "auto-safe" });
  const proof = await kernel.runGoal({ goal: "mislabeled write", planFile: planPath });
  const turn = JSON.parse(await readFile(proof.turnArtifactPath, "utf8"));
  const policyItem = turn.items.find((item) => item.kind === "policy_decision");

  assert.equal(proof.status, "blocked");
  assert.equal(existsSync(path.join(workspace, "marker.txt")), false);
  assert.equal(policyItem.input.metadata.declaredSafety, "read-only");
  assert.equal(policyItem.input.metadata.effectiveSafety, "workspace-write");
  assert.match(policyItem.summary, /auto-safe refuses writes/);
});

test("run goal executes bounded provider tool calls before accepting a plan", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Tool Loop\n");
  let calls = 0;
  const provider = {
    kind: "tool-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "need context",
          toolCalls: [{ id: "call_readme", name: "read_file", input: { path: "README.md" } }],
        };
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && message.content.includes("Tool Loop")), true);
      return {
        text: "plan ready",
        plan: {
          goal: request.goal,
          summary: "used tool context",
          steps: [],
          verification: [],
        },
      };
    },
  };
  const kernel = await CrixKernel.create({ workspace, permissionMode: "auto-safe", provider });
  const proof = await kernel.runGoal({ goal: "inspect with tools" });
  const turn = JSON.parse(await readFile(proof.turnArtifactPath, "utf8"));

  assert.equal(calls, 2);
  assert.equal(proof.status, "passed");
  assert.equal(turn.items.some((item) => item.kind === "tool_call" && item.title === "read_file"), true);
  assert.equal(turn.items.some((item) => item.kind === "assistant_message" && item.title === "plan created"), true);
});

test("run goal applies plan steps through real runtime tool calls", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "runtime apply event",
    summary: "write through tool runtime",
    steps: [{ id: "write", title: "write app", safety: "workspace-write", type: "write_file", path: "app.html", content: "<!doctype html><title>ok</title>\n" }],
    verification: [],
  }), "utf8");
  const events = [];
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "runtime apply event", planFile: planPath, onEvent: (event) => events.push(event.type === "apply_tool_start" ? `${event.type}:${event.call.name}` : event.type) });
  const turn = JSON.parse(await readFile(proof.turnArtifactPath, "utf8"));

  assert.equal(await readFile(path.join(workspace, "app.html"), "utf8"), "<!doctype html><title>ok</title>\n");
  assert.ok(events.includes("apply_tool_start:write_file"));
  assert.ok(events.includes("apply_tool_result"));
  assert.equal(turn.items.some((item) => item.kind === "tool_call" && item.title === "write_file"), true);
});

test("event store lists and reads run sessions", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "session visibility",
    summary: "write visible proof",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "ok\n" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "session visibility", planFile: planPath });

  const sessions = await EventStore.listSessions(workspace);
  assert.equal(sessions[0]?.sessionId, proof.sessionId);
  assert.equal(sessions[0]?.status, "passed");
  assert.equal(sessions[0]?.goal, "session visibility");
  assert.ok(sessions[0]?.eventCount > 0);

  const read = await EventStore.readSession(workspace, proof.sessionId);
  assert.equal(read.proof?.sessionId, proof.sessionId);
  assert.match(read.events.map((event) => event.kind).join(","), /session_started/);
});

test("event store compacts and forks sessions for resume-style workflows", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "compact fork",
    summary: "write marker",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "ok\n" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "compact fork", planFile: planPath });
  const compact = await EventStore.compactSession(workspace, proof.sessionId);
  const read = await EventStore.readSession(workspace, proof.sessionId);
  const fork = await EventStore.forkSession(workspace, proof.sessionId);
  const forkRead = await EventStore.readSession(workspace, fork.sessionId);

  assert.equal(compact.sessionId, proof.sessionId);
  assert.equal(read.compact.sessionId, proof.sessionId);
  assert.equal(fork.sourceSessionId, proof.sessionId);
  assert.equal(forkRead.proof.sessionId, fork.sessionId);
  assert.match(forkRead.events.at(-1).message, new RegExp(proof.sessionId));
});

test("event store rehydrates full thread history from events and turn artifacts", async () => {
  const workspace = await tempWorkspace();
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "thread history",
    summary: "write thread marker",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "ok\n" }],
    verification: []
  }), "utf8");
  const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write" });
  const proof = await kernel.runGoal({ goal: "thread history", planFile: planPath, interventions: ["keep proof visible"] });
  const history = await EventStore.readThreadHistory(workspace, proof.sessionId);
  const compact = await EventStore.compactSession(workspace, proof.sessionId);

  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0].id, proof.turnId);
  assert.ok(history.messages.some((message) => message.name === "session_goal" && /thread history/.test(message.content)));
  assert.ok(history.messages.some((message) => message.name === "intervention" && /keep proof visible/.test(message.content)));
  assert.ok(history.timeline.some((item) => item.source === "turn" && item.kind === "file_change"));
  assert.equal(compact.turnCount, 1);
  assert.ok(compact.messageCount >= 2);
});

test("turn intent planner routes local harness requests without CLI magic strings", () => {
  assert.equal(planTurnIntent("inspect the tool runtime").kind, "tool_audit");
  assert.equal(planTurnIntent("inspect agent orchestration").kind, "agent_orchestration");
  assert.equal(planTurnIntent("dont do any work, were those tools real?").kind, "provider_chat");
  assert.equal(planTurnIntent("i never asked u to do that", { activeWorkspace: "D:\\Crix" }).kind, "provider_chat");
  assert.equal(planTurnIntent("is it something in ur coding that makes u do that? its honestly something im trying to trouble shoot", { activeWorkspace: "D:\\Crix" }).kind, "provider_chat");
  assert.equal(planTurnIntent("what do you think?", { activeWorkspace: "D:\\Crix" }).kind, "provider_chat");
  assert.equal(planTurnIntent("HOW ARE YOU").kind, "local_status");
  assert.equal(planTurnIntent("oh").kind, "local_status");
  assert.equal(planTurnIntent("man tf").kind, "local_status");
  assert.equal(planTurnIntent("wtf").kind, "local_status");
  assert.equal(planTurnIntent("make me an html then open it").kind, "goal_run");
  assert.equal(planTurnIntent("make me a simple notes app at D:\\Apps\\nuts and open it when done").kind, "goal_run");
  assert.equal(planTurnIntent("check this repo", { activeWorkspace: "D:\\Crix" }).kind, "repo_scan");
  assert.equal(planTurnIntent("D:\\Apps\\nuts is u!", { pathExists: () => true }).kind, "workspace_capture");
  assert.deepEqual(
    {
      kind: planTurnIntent("deep scan it", { activeWorkspace: "D:\\Crix" }).kind,
      mode: planTurnIntent("deep scan it", { activeWorkspace: "D:\\Crix" }).repoScanMode,
    },
    { kind: "repo_scan", mode: "deep" },
  );
});

test("agent runtime keeps behavior meta questions conversation-only", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Meta Repo\n", "utf8");
  let capturedToolNames;
  const provider = {
    kind: "meta-chat",
    async complete(request) {
      capturedToolNames = request.tools.map((tool) => tool.name);
      return { text: "That was routing behavior, not a repository task." };
    },
  };
  const runtime = await AgentRuntime.create({ workspace, provider, permissionMode: "auto-safe" });
  const events = [];
  let final;
  for await (const event of runtime.submit("is it something in ur coding that makes u do that? its honestly something im trying to trouble shoot")) {
    events.push(event);
    if (event.type === "final") final = event;
  }

  assert.deepEqual(capturedToolNames, []);
  assert.equal(events.some((event) => event.type === "tool_start"), false);
  assert.equal(final.text, "That was routing behavior, not a repository task.");
  assert.doesNotMatch(final.text, /I inspected/);
});

test("turn recorder captures structured runtime items and writes an artifact", async () => {
  const workspace = await tempWorkspace();
  const turn = new TurnRecorder({ metadata: { source: "test" } });
  const item = turn.startItem({
    kind: "tool_call",
    title: "read_file",
    input: { path: "README.md" },
    metadata: { toolName: "read_file" },
  });
  turn.completeItem(item.id, {
    summary: "read README.md",
    output: "ok",
    metadata: { durationMs: 12, ok: true },
  });
  const artifact = await turn.writeArtifact(workspace);
  const parsed = JSON.parse(await readFile(artifact, "utf8"));
  const listed = await TurnRecorder.listArtifacts(workspace);
  const read = await TurnRecorder.readArtifact(workspace, turn.turnId);

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.items[0].kind, "tool_call");
  assert.equal(parsed.items[0].status, "completed");
  assert.equal(parsed.items[0].summary, "read README.md");
  assert.equal(listed[0].turnId, turn.turnId);
  assert.equal(read.items[0].title, "read_file");
});

test("turn engine owns tool calls and queued interventions", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Harness\n");
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe", metadata: { source: "engine-test" } });

  const queued = engine.queueIntervention("tighten the next tool call");
  const drained = engine.drainInterventions();
  const result = await engine.runCall({ name: "read_file", input: { path: "README.md" } });
  const artifact = await engine.writeArtifact();
  const parsed = JSON.parse(await readFile(artifact, "utf8"));

  assert.equal(queued.content, "tighten the next tool call");
  assert.equal(drained.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(parsed.items.map((item) => item.kind), ["user_intervention", "tool_call"]);
  assert.equal(parsed.items[0].status, "completed");
  assert.equal(parsed.items[1].title, "read_file");
});

test("provider tool loop emits assistant/tool events before final response", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Loop\n", "utf8");
  let calls = 0;
  const provider = {
    kind: "loop",
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { text: "need README", toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" } }] };
      }
      return { text: "final answer" };
    },
  };
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe" });
  const events = [];
  const result = await runProviderToolLoop({
    goal: "inspect loop",
    systemPrompt: "system",
    context: { workspace, goal: "inspect loop", messages: [], memories: [], files: [], budget: { maxChars: 0, usedChars: 0 } },
    tools: defaultTools(),
    agents: defaultAgents(),
    messages: [],
    provider,
    engine,
    mode: "chat",
    onEvent(event) {
      events.push(event.type);
    },
  });

  assert.equal(result.response.text, "final answer");
  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(events, ["assistant", "tool_start", "tool_result", "assistant", "final"]);
  assert.equal(result.messages.some((message) => message.role === "tool" && /Loop/.test(message.content)), true);
});

test("provider tool loop executes inline tool syntax instead of printing it", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Inline Loop\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), "{\"name\":\"inline-loop\"}\n", "utf8");
  let calls = 0;
  const provider = {
    kind: "inline-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          text: 'Let me inspect that. read_file({"path":"README.md"}): read_file({"path":"package.json"}):',
        };
      }
      assert.equal(request.messages.filter((message) => message.role === "tool").length, 2);
      assert.equal(request.messages.some((message) => message.role === "tool" && /Inline Loop/.test(message.content)), true);
      assert.equal(request.messages.some((message) => message.role === "tool" && /inline-loop/.test(message.content)), true);
      return { text: "real answer after tools" };
    },
  };
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe" });
  const events = [];
  const result = await runProviderToolLoop({
    goal: "inspect inline",
    systemPrompt: "system",
    context: { workspace, goal: "inspect inline", messages: [], memories: [], files: [], budget: { maxChars: 0, usedChars: 0 } },
    tools: defaultTools(),
    agents: defaultAgents(),
    messages: [],
    provider,
    engine,
    mode: "chat",
    onEvent(event) {
      events.push(event.type);
    },
  });

  assert.equal(result.response.text, "real answer after tools");
  assert.equal(result.toolCallCount, 2);
  assert.deepEqual(events, ["assistant", "tool_start", "tool_start", "tool_result", "tool_result", "assistant", "final"]);
});

test("provider tool loop corrects task turns that answer without required tools", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Required Tool\n", "utf8");
  let calls = 0;
  let sawCorrection = false;
  const provider = {
    kind: "require-tool-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) return { text: "Done, I created it." };
      sawCorrection = request.messages.some((message) => message.metadata?.correction === "require-tool-use");
      if (calls === 2) {
        return { text: "using a real tool", toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" } }] };
      }
      return { text: "final after real tool" };
    },
  };
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe" });
  const result = await runProviderToolLoop({
    goal: "inspect with required tools",
    systemPrompt: "system",
    context: { workspace, goal: "inspect with required tools", messages: [], memories: [], files: [], budget: { maxChars: 0, usedChars: 0 } },
    tools: defaultTools(),
    agents: defaultAgents(),
    messages: [],
    provider,
    engine,
    mode: "chat",
    requireToolUse: true,
    toolUseCorrection: "Use a real tool before answering.",
  });

  assert.equal(calls, 3);
  assert.equal(sawCorrection, true);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.response.text, "final after real tool");
});

test("provider tool loop blocks completion when a required tool never appears", async () => {
  const workspace = await tempWorkspace();
  let calls = 0;
  const provider = {
    kind: "no-tool-loop",
    async complete() {
      calls += 1;
      return { text: "Done without tools." };
    },
  };
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe" });
  const result = await runProviderToolLoop({
    goal: "create a file",
    systemPrompt: "system",
    context: { workspace, goal: "create a file", messages: [], memories: [], files: [], budget: { maxChars: 0, usedChars: 0 } },
    tools: defaultTools(),
    agents: defaultAgents(),
    messages: [],
    provider,
    engine,
    mode: "chat",
    requireToolUse: true,
  });

  assert.equal(calls, 2);
  assert.equal(result.toolCallCount, 0);
  assert.match(result.response.text, /requires real tool use/i);
  assert.match(result.response.text, /No task completion was claimed/i);
});

test("final claim guard flags completion claims without verification evidence", () => {
  assert.match(guardFinalAnswerClaims("Implemented the fix.", []), /Verification note/);
  assert.equal(guardFinalAnswerClaims("Implemented the fix.", [{
    kind: "verification",
    toolName: "run_verification",
    ok: true,
    summary: "tests passed",
  }]), "Implemented the fix.");
});

test("agent runtime inspects an explicit repo path before answering", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "agent-first-repo",
    packageManager: "pnpm@10.33.0",
  }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Agent First Repo\n", "utf8");
  let sawToolContext = false;
  const provider = {
    kind: "weak-chat",
    async complete(request) {
      sawToolContext = request.messages.some((message) => message.role === "tool" && /agent-first-repo|Agent First Repo/.test(message.content));
      return { text: "It's a Windows directory path. I don't have any automatic opinion about it, but I can look with your permission." };
    },
  };
  const runtime = await AgentRuntime.create({ workspace: process.cwd(), provider, permissionMode: "auto-safe" });
  const events = [];
  let final;
  for await (const event of runtime.submit(`what u think about ${workspace} ?`)) {
    events.push(event);
    if (event.type === "final") final = event;
  }

  assert.equal(sawToolContext, true);
  assert.equal(events.some((event) => event.type === "tool_start" && event.call.name === "list_dir"), true);
  assert.equal(events.some((event) => event.type === "tool_start" && event.call.name === "read_file"), true);
  assert.match(final.text, /I inspected/);
  assert.match(final.text, /agent-first-repo/);
  assert.doesNotMatch(final.text, /no automatic opinion|with your permission/i);
  assert.equal(existsSync(final.turnArtifactPath), true);
});

test("agent runtime streams provider tool cards and drains queued interventions into the next round", async () => {
  const workspace = await tempWorkspace();
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "streaming-agent" }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Streaming Agent\n", "utf8");
  await writeFile(path.join(workspace, "src", "app.ts"), "export const value = 42;\n", "utf8");
  let calls = 0;
  let sawQueuedIntervention = false;
  const provider = {
    kind: "stream-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return { text: "need source", toolCalls: [{ id: "source", name: "read_file", input: { path: "src/app.ts" } }] };
      }
      sawQueuedIntervention = request.messages.some((message) => message.role === "user" && /also check tests/i.test(message.content));
      return { text: sawQueuedIntervention ? "final after queued intervention" : "missing intervention" };
    },
  };
  const runtime = await AgentRuntime.create({ workspace, provider, permissionMode: "auto-safe" });
  const events = [];
  let final;
  for await (const event of runtime.submit("inspect this repo")) {
    events.push(event);
    if (event.type === "tool_start" && event.call.name === "read_file" && event.call.input.path === "src/app.ts") {
      runtime.queueIntervention("also check tests before final");
    }
    if (event.type === "final") final = event;
  }

  assert.equal(sawQueuedIntervention, true);
  assert.equal(events.some((event) => event.type === "assistant" && event.toolCallCount === 1), true);
  assert.equal(events.some((event) => event.type === "intervention"), true);
  assert.equal(events.some((event) => event.type === "tool_result" && event.call.input.path === "src/app.ts" && /value = 42/.test(event.result.output)), true);
  assert.equal(final.text, "final after queued intervention");
});

test("agent runtime replays compacted prior session messages on later turns", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "README.md"), "# Memory Loop\n", "utf8");
  let providerCalls = 0;
  let sawPriorTurn = false;
  const provider = {
    kind: "memory-loop",
    async complete(request) {
      providerCalls += 1;
      if (request.goal === "second question") {
        sawPriorTurn = request.messages.some((message) => /first question|first answer/i.test(message.content));
      }
      return { text: providerCalls === 1 ? "first answer" : "second answer" };
    },
  };
  const runtime = await AgentRuntime.create({ workspace, provider, permissionMode: "auto-safe" });
  for await (const _event of runtime.submit("first question")) {
    // Drain the turn.
  }
  let final;
  for await (const event of runtime.submit("second question")) {
    if (event.type === "final") final = event;
  }

  assert.equal(sawPriorTurn, true);
  assert.equal(final.text, "second answer");
  assert.equal(runtime.sessionState.messages.some((message) => /first answer/.test(message.content)), true);
});

test("explicit path grants allow broad reads but not cross-root writes", async () => {
  const workspace = await tempWorkspace();
  const other = await tempWorkspace();
  await writeFile(path.join(other, "README.md"), "# Granted\n", "utf8");
  const grant = { root: other, read: true, write: false, source: "explicit-path", createdAt: new Date().toISOString() };
  const runtime = await ToolRuntime.create(workspace, {
    permissionMode: "workspace-write",
    readPolicy: "explicit-path-broad",
    workspaceGrants: [grant],
  });

  const read = await runtime.execute("read_file", { path: path.join(other, "README.md") });
  const write = await runtime.execute("write_file", { path: path.join(other, "owned.txt"), content: "no\n" });

  assert.equal(read.ok, true);
  assert.match(read.output, /Granted/);
  assert.equal(write.ok, false);
  assert.match(write.output, /escapes workspace/i);
  assert.equal(existsSync(path.join(other, "owned.txt")), false);
});

test("provider tool loop batches parallel-safe calls and preserves tool message order", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(workspace, "b.txt"), "bravo\n", "utf8");
  let calls = 0;
  const provider = {
    kind: "parallel-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "need files",
          toolCalls: [
            { id: "read_a", name: "read_file", input: { path: "a.txt" } },
            { id: "read_b", name: "read_file", input: { path: "b.txt" } },
          ],
        };
      }
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      assert.match(toolMessages[0]?.content ?? "", /alpha/);
      assert.match(toolMessages[1]?.content ?? "", /bravo/);
      return { text: "final answer" };
    },
  };
  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe" });
  const events = [];
  const result = await runProviderToolLoop({
    goal: "inspect files",
    systemPrompt: "system",
    context: { workspace, goal: "inspect files", messages: [], memories: [], files: [], budget: { maxChars: 0, usedChars: 0 } },
    tools: defaultTools(),
    agents: defaultAgents(),
    messages: [],
    provider,
    engine,
    mode: "chat",
    onEvent(event) {
      events.push(event.type);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.response.text, "final answer");
  assert.equal(result.toolCallCount, 2);
  assert.deepEqual(events, ["assistant", "tool_start", "tool_start", "tool_result", "tool_result", "assistant", "final"]);
});

test("agent orchestrator passes scoped tool metadata to provider", async () => {
  const workspace = await tempWorkspace();
  let captured;
  const provider = {
    kind: "capture",
    async complete(request) {
      captured = request;
      return { text: "review complete" };
    },
  };
  const agents = defaultAgents();
  const reviewer = agents.find((agent) => agent.id === "reviewer");
  const orchestrator = new AgentOrchestrator(provider, agents);
  const report = await orchestrator.spawn({
    agent: reviewer,
    prompt: "review this change",
    context: {
      workspace,
      goal: "agent tool scope",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  });
  const toolNames = captured.tools.map((tool) => tool.name);

  assert.equal(report.status, "completed");
  assert.deepEqual(toolNames, reviewer.tools);
  assert.equal(toolNames.includes("write_file"), false);
  assert.deepEqual(report.metadata.tools, reviewer.tools);
  assert.equal(typeof report.metadata.transcriptPath, "string");
  assert.equal(existsSync(report.metadata.transcriptPath), true);
});

test("agent orchestrator runs bounded scoped tool calls before completion", async () => {
  const workspace = await tempWorkspace();
  const executed = [];
  let calls = 0;
  const provider = {
    kind: "agent-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "need README",
          toolCalls: [{ id: "readme", name: "read_file", input: { path: "README.md" } }],
        };
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && /README context/.test(message.content)), true);
      return { text: "agent done" };
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const orchestrator = new AgentOrchestrator(provider, agents, defaultTools(), async (name, input) => {
    executed.push({ name, input });
    return { callId: "readme", ok: true, output: "README context" };
  });
  const report = await orchestrator.spawn({
    agent: researcher,
    prompt: "inspect repo",
    context: {
      workspace,
      goal: "agent loop",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  });

  assert.equal(report.status, "completed");
  assert.equal(report.summary, "agent done");
  assert.equal(calls, 2);
  assert.deepEqual(executed.map((item) => item.name), ["read_file"]);
  assert.equal(report.messages.some((message) => message.role === "tool" && /README context/.test(message.content)), true);
});

test("agent orchestrator executes inline scoped tool syntax before completion", async () => {
  const workspace = await tempWorkspace();
  const executed = [];
  let calls = 0;
  const provider = {
    kind: "agent-inline-loop",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return { text: 'Need repo context. read_file({"path":"README.md"}):' };
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && /README context/.test(message.content)), true);
      return { text: "agent inline done" };
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const orchestrator = new AgentOrchestrator(provider, agents, defaultTools(), async (name, input) => {
    executed.push({ name, input });
    return { callId: "readme", ok: true, output: "README context" };
  });
  const report = await orchestrator.spawn({
    agent: researcher,
    prompt: "inspect repo",
    context: {
      workspace,
      goal: "agent inline loop",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  });

  assert.equal(report.status, "completed");
  assert.equal(report.summary, "agent inline done");
  assert.equal(calls, 2);
  assert.deepEqual(executed.map((item) => item.name), ["read_file"]);
});

test("agent orchestrator denies out-of-scope tools without invoking executor", async () => {
  const workspace = await tempWorkspace();
  let executorCalls = 0;
  let calls = 0;
  const provider = {
    kind: "agent-deny",
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "try write",
          toolCalls: [{ id: "write", name: "write_file", input: { path: "x.txt", content: "x" } }],
        };
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && /not allowed/.test(message.content)), true);
      return { text: "denied and finished" };
    },
  };
  const agents = defaultAgents();
  const reviewer = agents.find((agent) => agent.id === "reviewer");
  const orchestrator = new AgentOrchestrator(provider, agents, defaultTools(), async () => {
    executorCalls += 1;
    return { callId: "unexpected", ok: true, output: "unexpected" };
  });
  const report = await orchestrator.spawn({
    agent: reviewer,
    prompt: "review safely",
    context: {
      workspace,
      goal: "agent deny",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  });

  assert.equal(report.status, "completed");
  assert.equal(report.summary, "denied and finished");
  assert.equal(executorCalls, 0);
  assert.equal(report.messages.some((message) => message.role === "tool" && /not allowed/.test(message.content)), true);
});

test("agent orchestrator persists interventions and cancellation transcripts", async () => {
  const workspace = await tempWorkspace();
  let release;
  const provider = {
    kind: "slow",
    async complete() {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { text: "late completion" };
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const orchestrator = new AgentOrchestrator(provider, agents);
  const running = await orchestrator.spawn({
    agent: researcher,
    prompt: "map this",
    context: {
      workspace,
      goal: "agent cancel",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  }, true);

  await orchestrator.sendInput(running.id, "pause after current read");
  const cancelled = await orchestrator.cancel(running.id, "stop now");
  release();
  const waited = await orchestrator.wait(running.id);
  const transcript = JSON.parse(await readFile(cancelled.metadata.transcriptPath, "utf8"));

  assert.equal(cancelled.status, "cancelled");
  assert.equal(waited.status, "cancelled");
  assert.equal(transcript.status, "cancelled");
  assert.match(transcript.messages.map((message) => message.content).join("\n"), /pause after current read/);
  assert.match(transcript.messages.map((message) => message.content).join("\n"), /stop now/);
});

test("agent orchestrator writes durable completion notifications", async () => {
  const workspace = await tempWorkspace();
  const provider = {
    kind: "notify",
    async complete() {
      return { text: "background done" };
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const orchestrator = new AgentOrchestrator(provider, agents);
  const running = await orchestrator.spawn({
    agent: researcher,
    prompt: "notify me",
    context: {
      workspace,
      goal: "agent notify",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  }, true);
  const completed = await orchestrator.wait(running.id);
  const notifications = await AgentOrchestrator.listNotifications(workspace);

  assert.equal(completed.status, "completed");
  assert.equal(notifications[0].runId, running.id);
  assert.equal(notifications[0].summary, "background done");
  assert.equal(notifications[0].background, true);
});

test("agent cancellation aborts provider requests through AbortSignal", async () => {
  const workspace = await tempWorkspace();
  let sawAbort = false;
  const provider = {
    kind: "abort-aware",
    async complete(_request, options) {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const orchestrator = new AgentOrchestrator(provider, agents);
  const running = await orchestrator.spawn({
    agent: researcher,
    prompt: "map this",
    context: {
      workspace,
      goal: "agent abort",
      messages: [],
      memories: [],
      files: [],
      budget: { maxChars: 1000, usedChars: 0 },
    },
    messages: [],
  }, true);

  await orchestrator.cancel(running.id, "stop provider");
  const waited = await orchestrator.wait(running.id);

  assert.equal(sawAbort, true);
  assert.equal(waited.status, "cancelled");
  assert.match(waited.summary, /stop provider/);
});

test("model providers use text completion for subagent requests instead of plan JSON", async () => {
  const calls = [];
  const fakeClient = {
    async completeText(input, instructions) {
      calls.push({ kind: "text", input, instructions });
      return "subagent result";
    },
    async createUpgradePlan() {
      calls.push({ kind: "plan" });
      return { text: "plan result" };
    },
  };
  const agents = defaultAgents();
  const researcher = agents.find((agent) => agent.id === "researcher");
  const provider = new OpenAIOAuthProvider(fakeClient);
  const response = await provider.complete({
    goal: "inspect harness",
    systemPrompt: researcher.systemPrompt,
    context: {
      workspace: "D:\\Crix",
      goal: "inspect harness",
      messages: [],
      memories: [],
      files: [{ path: "README.md", summary: "harness docs" }],
      budget: { maxChars: 1000, usedChars: 100 },
    },
    tools: [],
    agents,
    messages: [{ id: "msg_test", role: "user", content: "inspect harness", createdAt: new Date().toISOString() }],
  });
  assert.equal(response.text, "subagent result");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "text");
  assert.match(calls[0].instructions, /Researcher subagent/);
  assert.match(calls[0].input, /Do not return an UpgradePlan JSON object/);
});

test("safety policy denies external state in every mode", () => {
  for (const mode of ["ask", "auto-safe", "workspace-write", "danger-full-access"]) {
    assert.equal(new SafetyPolicy(mode).evaluateSafety("external-state").allowed, false);
  }
});


