import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildSystemPrompt,
  CRIX_SKILL_PROCESSES,
  CRIX_TOOL_CATALOG,
  defaultAgents,
  defaultTools,
  parseProviderJsonResponse,
} from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);

test("prompt pack includes references, tool catalog, skill processes, and safety contract", () => {
  const prompt = buildSystemPrompt({
    tools: defaultTools(),
    agents: defaultAgents(),
    mode: "plan",
    goal: "upgrade Crix tool orchestration",
  });

  assert.match(prompt, /OpenAI Codex local repo/);
  assert.match(prompt, /Friend TypeScript CLI repo/);
  assert.match(prompt, /Claude Code 2\.0 prompt archive/);
  assert.match(prompt, /System prompts and models archive/);
  assert.match(prompt, /Reference Derived Runtime Principles/);
  assert.match(prompt, /tool truthfulness/);
  assert.match(prompt, /Crix Tool Catalog/);
  assert.match(prompt, /Skill Processes/);
  assert.match(prompt, /Live TUI Controls/);
  assert.match(prompt, /provider openai, provider ollama, model qwen3-coder, agents, status/);
  assert.match(prompt, /Legacy command aliases/);
  assert.match(prompt, /Do exactly the requested coding task/);
  assert.match(prompt, /Use tasklist tools for multi-step work/);
  assert.match(prompt, /fully executable tool catalog/i);
  assert.match(prompt, /inspect, plan, patch, verify, summarize/i);
  assert.match(prompt, /Do not make purchases/);
  assert.match(prompt, /UpgradePlan JSON/);
  assert.match(prompt, /toolsmith/);
});

test("chat-mode prompt keeps harness discipline without forcing plan JSON output", () => {
  const prompt = buildSystemPrompt({
    tools: defaultTools(),
    agents: defaultAgents(),
    mode: "chat",
  });
  assert.match(prompt, /In chat mode, answer directly/i);
  assert.doesNotMatch(prompt, /return an UpgradePlan JSON object/i);
});

test("provider JSON parser accepts tool-call envelopes before final plans", () => {
  const parsed = parseProviderJsonResponse(JSON.stringify({
    text: "need README",
    toolCalls: [{ id: "read_1", name: "read_file", input: { path: "README.md" } }],
  }));

  assert.equal(parsed.text, "need README");
  assert.equal(parsed.toolCalls[0].name, "read_file");
  assert.equal(parsed.toolCalls[0].input.path, "README.md");
});

test("tool catalog tracks functional Crix capabilities", () => {
  assert.ok(CRIX_TOOL_CATALOG.length >= 30);
  assert.ok(CRIX_TOOL_CATALOG.some((tool) => tool.name === "read_file" && tool.status === "available"));
  assert.equal(CRIX_TOOL_CATALOG.every((tool) => tool.status === "available"), true);
  assert.ok(CRIX_TOOL_CATALOG.some((tool) => tool.name === "launch_process" && tool.status === "available"));
  assert.ok(CRIX_TOOL_CATALOG.some((tool) => tool.name === "browser_snapshot" && tool.process === "browser-runtime-qa"));
});

test("skill processes map reference patterns to tools and proof", () => {
  const processIds = new Set(CRIX_SKILL_PROCESSES.map((process) => process.id));
  for (const id of ["context-scout", "spec-plan-implement", "safe-edit-checkpoint", "quality-gate", "process-control", "subagent-split-review", "tasklist-control", "memory-capture", "skill-orchestration", "plugin-marketplace", "mcp-runtime", "browser-runtime-qa", "repo-state-control", "approval-gate"]) {
    assert.equal(processIds.has(id), true);
  }
  for (const tool of CRIX_TOOL_CATALOG) {
    assert.equal(processIds.has(tool.process), true, `${tool.name} references missing process ${tool.process}`);
  }
  const processControl = CRIX_SKILL_PROCESSES.find((process) => process.id === "process-control");
  assert.ok(processControl?.buildsTools.includes("launch_process"));
  assert.ok(processControl?.proof.includes("process id"));
});

test("CLI exposes prompt, tools, and skills inspection", async () => {
  const prompt = await execFileAsync("node", ["packages/cli/dist/index.js", "prompt", "--summary"], { cwd: process.cwd() });
  assert.match(prompt.stdout, /Crix prompt pack/);
  assert.match(prompt.stdout, /skill-processes:/);

  const tools = await execFileAsync("node", ["packages/cli/dist/index.js", "tools"], { cwd: process.cwd() });
  assert.match(tools.stdout, /launch_process/);

  const skills = await execFileAsync("node", ["packages/cli/dist/index.js", "skills", "process-control"], { cwd: process.cwd() });
  assert.match(skills.stdout, /Managed Process Control/);
  assert.match(skills.stdout, /launch_process/);

  const tool = await execFileAsync("node", ["packages/cli/dist/index.js", "tool", "run", "read_file", "--path", "README.md"], { cwd: process.cwd() });
  assert.match(tool.stdout, /callId/);
  assert.match(tool.stdout, /README\.md/);
});
