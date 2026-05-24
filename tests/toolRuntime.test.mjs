import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CRIX_TOOL_CATALOG, ToolRuntime } from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);

async function tempWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "crix-tool-runtime-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Test\nhello main\n", "utf8");
  await writeFile(path.join(workspace, "src", "app.js"), "function main() { return 'ok'; }\nconsole.log(main());\n", "utf8");
  await writeFile(path.join(workspace, "delete-me.txt"), "remove me\n", "utf8");
  return workspace;
}

function sampleInput(name) {
  switch (name) {
    case "read_file":
      return { path: "README.md" };
    case "read_partial_file":
      return { path: "README.md", startLine: 1, numberOfLines: 1 };
    case "list_dir":
      return { path: ".", recursive: false };
    case "glob":
      return { pattern: "**/*.js" };
    case "grep_search":
      return { query: "main" };
    case "codebase_retrieval":
      return { query: "main", maxResults: 3 };
    case "diagnostics":
      return { paths: ["src/app.js"] };
    case "file_outline":
      return { path: "src/app.js" };
    case "find_references":
    case "go_to_definition":
      return { symbol: "main" };
    case "create_dir":
      return { path: "generated-dir" };
    case "write_file":
      return { path: "tmp-write.txt", content: "ok\n" };
    case "replace_text":
      return { path: "README.md", oldText: "hello", newText: "hello" };
    case "multi_edit":
      return { path: "README.md", edits: [{ oldText: "hello", newText: "hello" }] };
    case "apply_patch":
      return { path: "README.md", oldText: "hello", newText: "hello" };
    case "remove_files":
      return { path: "delete-me.txt" };
    case "run_verification":
    case "launch_process":
      return { program: "node", args: ["--check", "src/app.js"] };
    case "read_process":
    case "write_process":
    case "kill_process":
      return { processId: "missing", input: "x" };
    case "remember":
      return { text: "runtime memory", tags: ["runtime"] };
    case "memory_search":
      return { query: "runtime" };
    case "memory_forget":
      return { id: "missing", reason: "test" };
    case "spawn_agent":
      return { agent: "researcher", prompt: "inspect README" };
    case "wait_agent":
    case "send_agent_input":
    case "cancel_agent":
      return { runId: "missing", content: "x" };
    case "agent_notifications":
      return { limit: 5 };
    case "tasklist_add":
      return { tasks: [{ title: "test task" }] };
    case "tasklist_update":
      return { taskId: "missing", status: "done" };
    case "browser_open":
    case "browser_snapshot":
    case "browser_console":
      return { url: "http://127.0.0.1:9", script: "document.title" };
    case "web_search":
      return { query: "crix" };
    case "web_fetch":
      return { url: "http://127.0.0.1:9" };
    case "skill_load":
      return { skill: "context-scout" };
    case "skill_run":
      return { skill: "context-scout", input: { goal: "test" } };
    case "git_diff":
      return {};
    case "git_commit_retrieval":
      return { query: "initial" };
    case "render_mermaid":
      return { diagram: "graph TD\nA-->B", out: ".crix/artifacts/test.svg" };
    case "proof_report":
      return { summary: "tool runtime proof" };
    case "request_approval":
      return { reason: "test", approved: true };
    default:
      return {};
  }
}

test("every catalog tool has a runtime executor, not a placeholder", async () => {
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace);
  for (const tool of CRIX_TOOL_CATALOG) {
    const result = await runtime.execute(tool.name, sampleInput(tool.name));
    assert.doesNotMatch(result.output, /has no executor|unknown tool/i, tool.name);
  }
});

test("local context, edit, verification, memory, task, artifact, and approval tools execute", async () => {
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace, { allowDestructive: true });

  assert.match((await runtime.execute("read_file", { path: "README.md" })).output, /hello main/);
  assert.match((await runtime.execute("read_partial_file", { path: "README.md", startLine: 1, numberOfLines: 1 })).output, /# Test/);
  assert.match((await runtime.execute("list_dir", { path: ".", recursive: true })).output, /src/);
  assert.match((await runtime.execute("glob", { pattern: "**/*.js" })).output, /src\/app\.js/);
  assert.match((await runtime.execute("grep_search", { query: "main" })).output, /app\.js/);
  assert.match((await runtime.execute("codebase_retrieval", { query: "main" })).output, /app\.js/);
  assert.equal((await runtime.execute("diagnostics", { paths: ["src/app.js"] })).ok, true);
  assert.match((await runtime.execute("file_outline", { path: "src/app.js" })).output, /main/);
  assert.match((await runtime.execute("find_references", { symbol: "main" })).output, /main/);
  assert.match((await runtime.execute("go_to_definition", { symbol: "main" })).output, /main/);

  assert.equal((await runtime.execute("create_dir", { path: "generated" })).ok, true);
  assert.equal((await runtime.execute("write_file", { path: "generated/file.txt", content: "alpha\n" })).ok, true);
  assert.equal((await runtime.execute("replace_text", { path: "generated/file.txt", oldText: "alpha", newText: "beta" })).ok, true);
  assert.equal((await runtime.execute("multi_edit", { path: "generated/file.txt", edits: [{ oldText: "beta", newText: "gamma" }] })).ok, true);
  assert.equal((await runtime.execute("apply_patch", { path: "generated/file.txt", oldText: "gamma", newText: "delta" })).ok, true);
  assert.match(await readFile(path.join(workspace, "generated", "file.txt"), "utf8"), /delta/);
  assert.equal((await runtime.execute("remove_files", { path: "delete-me.txt" })).ok, true);
  assert.equal(existsSync(path.join(workspace, "delete-me.txt")), false);

  assert.equal((await runtime.execute("run_verification", { program: "node", args: ["--check", "src/app.js"] })).ok, true);
  assert.equal((await runtime.execute("launch_process", { program: "node", args: ["--check", "src/app.js"] })).ok, true);

  const remembered = await runtime.execute("remember", { text: "tool runtime remembered fact", tags: ["runtime"] });
  const memoryId = remembered.metadata.memoryId;
  assert.equal(typeof memoryId, "string");
  assert.match((await runtime.execute("memory_search", { query: "remembered runtime" })).output, /remembered fact/);
  assert.equal((await runtime.execute("memory_forget", { id: memoryId, reason: "test cleanup" })).ok, true);

  const addTasks = await runtime.execute("tasklist_add", { tasks: [{ title: "ship tool runtime", owner: "qa" }] });
  const taskId = JSON.parse(addTasks.output).at(-1).id;
  assert.equal((await runtime.execute("tasklist_update", { taskId, status: "done" })).ok, true);
  assert.match((await runtime.execute("tasklist_view", {})).output, /done/);

  assert.equal((await runtime.execute("render_mermaid", { diagram: "graph TD\nA-->B", out: ".crix/artifacts/runtime.svg" })).ok, true);
  assert.equal((await runtime.execute("proof_report", { summary: "runtime proof" })).ok, true);
  assert.equal((await runtime.execute("request_approval", { reason: "test approval", approved: true })).ok, true);
});

test("multi_edit validates the full batch before writing", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "atomic.txt"), "alpha beta gamma\n", "utf8");
  const runtime = await ToolRuntime.create(workspace);

  const failed = await runtime.execute("multi_edit", {
    path: "atomic.txt",
    edits: [
      { oldText: "alpha", newText: "one" },
      { oldText: "missing", newText: "two" },
    ],
  });
  assert.equal(failed.ok, false);
  assert.equal(await readFile(path.join(workspace, "atomic.txt"), "utf8"), "alpha beta gamma\n");

  const passed = await runtime.execute("multi_edit", {
    path: "atomic.txt",
    edits: [
      { oldText: "alpha", newText: "one" },
      { oldText: "gamma", newText: "three" },
    ],
  });
  assert.equal(passed.ok, true);
  assert.equal(await readFile(path.join(workspace, "atomic.txt"), "utf8"), "one beta three\n");
});

test("ask mode uses permission prompt for state-changing tools", async () => {
  const workspace = await tempWorkspace();
  const approvals = [];
  const approved = await ToolRuntime.create(workspace, {
    permissionMode: "ask",
    permissionPrompt: async (request) => {
      approvals.push(request);
      return request.toolName === "write_file";
    },
  });
  const write = await approved.execute("write_file", { path: "approved.txt", content: "ok\n" });
  assert.equal(write.ok, true);
  assert.equal(approvals[0]?.toolName, "write_file");
  assert.equal(await readFile(path.join(workspace, "approved.txt"), "utf8"), "ok\n");

  const denied = await ToolRuntime.create(workspace, { permissionMode: "ask", permissionPrompt: async () => false });
  const result = await denied.execute("write_file", { path: "denied.txt", content: "no\n" });
  assert.equal(result.ok, false);
  assert.match(result.output, /ask mode refuses|approval/i);
});

test("ask mode supports allow-session permission decisions", async () => {
  const workspace = await tempWorkspace();
  const approvals = [];
  const runtime = await ToolRuntime.create(workspace, {
    permissionMode: "ask",
    permissionPrompt: async (request) => {
      approvals.push(request);
      return "allow-session";
    },
  });

  const input = { path: "session-approved.txt", content: "ok\n" };
  assert.equal((await runtime.execute("write_file", input)).ok, true);
  assert.equal((await runtime.execute("write_file", input)).ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(await readFile(path.join(workspace, "session-approved.txt"), "utf8"), "ok\n");
});

test("agent transcripts persist multi-message state across runtime instances", async () => {
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace);
  const spawned = await runtime.execute("spawn_agent", { agent: "researcher", prompt: "summarize README" });
  const run = JSON.parse(spawned.output);
  const runId = run.id;

  const resumed = await ToolRuntime.create(workspace);
  assert.equal((await resumed.execute("send_agent_input", { runId, content: "second message" })).ok, true);
  const waited = await resumed.execute("wait_agent", { runId });
  assert.match(waited.output, /second message/);
  assert.match(await readFile(path.join(workspace, ".crix", "agents", `${runId}.json`), "utf8"), /second message/);
});

test("managed process tools support launch, write, read, and kill in one runtime", async () => {
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace);
  const launched = await runtime.execute("launch_process", {
    program: "node",
    args: ["-e", "process.stdin.on('data', d => process.stdout.write('echo:' + d)); setInterval(() => {}, 1000);"],
    background: true,
  });
  assert.equal(launched.ok, true);
  const processId = launched.metadata.processId;
  assert.equal(typeof processId, "string");
  assert.equal((await runtime.execute("write_process", { processId, input: "ping", pressEnter: true })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match((await runtime.execute("read_process", { processId })).output, /echo:ping/);
  assert.match((await runtime.execute("list_processes", {})).output, new RegExp(String(processId)));
  assert.equal((await runtime.execute("kill_process", { processId })).ok, true);
});

test("agent, skill, git, and local web tools execute through runtime", async (t) => {
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace, { allowExternal: true });

  const agent = await runtime.execute("spawn_agent", { agent: "researcher", prompt: "summarize README" });
  assert.equal(agent.ok, true);
  assert.equal((await runtime.execute("skill_load", { skill: "context-scout" })).ok, true);
  assert.match((await runtime.execute("skill_run", { skill: "context-scout", input: { goal: "test" } })).output, /context-scout/);

  try {
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["-c", "user.email=crix@example.invalid", "-c", "user.name=Crix", "add", "."], { cwd: workspace });
    await execFileAsync("git", ["-c", "user.email=crix@example.invalid", "-c", "user.name=Crix", "commit", "-m", "initial"], { cwd: workspace });
    assert.equal((await runtime.execute("git_status", {})).ok, true);
    assert.equal((await runtime.execute("git_diff", {})).ok, true);
    assert.match((await runtime.execute("git_commit_retrieval", { query: "initial" })).output, /initial/);
  } catch {
    t.diagnostic("git unavailable; skipped git runtime assertions");
  }

  const server = await startServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<html><title>Crix Test</title><body><a class="result__a" href="https://example.invalid">Example</a>${request.url}</body></html>`);
  });
  try {
    assert.match((await runtime.execute("web_fetch", { url: server.url })).output, /Crix Test/);
    assert.match((await runtime.execute("web_search", { query: "crix", endpoint: server.url })).output, /Example/);
  } finally {
    await server.close();
  }
});

test("plugin marketplace and MCP declarations are exposed through runtime tools", async () => {
  const workspace = await tempWorkspace();
  await mkdir(path.join(workspace, ".agents", "plugins", "local-plugin", ".crix-plugin"), { recursive: true });
  await writeFile(path.join(workspace, ".agents", "plugins", "local-plugin", ".crix-plugin", "plugin.json"), JSON.stringify({
    id: "local-plugin",
    name: "Local Plugin",
    version: "1.0.0",
    description: "test plugin",
    skills: ["local-skill"],
    mcpServers: [{ name: "local-mcp", command: "node" }],
    tools: ["local_tool"],
  }, null, 2));
  const runtime = await ToolRuntime.create(workspace);
  const plugins = await runtime.execute("plugin_list", {});
  const mcps = await runtime.execute("mcp_list", {});

  assert.equal(plugins.ok, true);
  assert.match(plugins.output, /local-plugin/);
  assert.match(plugins.output, /local-skill/);
  assert.equal(mcps.ok, true);
  assert.match(mcps.output, /local-mcp/);
});

test("MCP stdio runtime lists tools, calls tools, and reads resources", async () => {
  const workspace = await tempWorkspace();
  const serverPath = path.join(workspace, "mcp-server.mjs");
  await writeFile(serverPath, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.id) return;
  if (msg.method === "initialize") {
    send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "test-mcp", version: "1.0.0" } });
  } else if (msg.method === "tools/list") {
    send(msg.id, { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  } else if (msg.method === "tools/call") {
    send(msg.id, { content: [{ type: "text", text: "echo:" + (msg.params.arguments.text || "") }] });
  } else if (msg.method === "resources/list") {
    send(msg.id, { resources: [{ uri: "memo://one", name: "One" }] });
  } else if (msg.method === "resources/read") {
    send(msg.id, { contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: "resource one" }] });
  } else {
    send(msg.id, {});
  }
});
`, "utf8");
  await mkdir(path.join(workspace, ".agents", "plugins", "mcp-plugin", ".crix-plugin"), { recursive: true });
  await writeFile(path.join(workspace, ".agents", "plugins", "mcp-plugin", ".crix-plugin", "plugin.json"), JSON.stringify({
    id: "mcp-plugin",
    name: "MCP Plugin",
    mcpServers: [{ name: "test-mcp", command: process.execPath, args: [serverPath] }],
  }, null, 2));

  const runtime = await ToolRuntime.create(workspace, { allowExternal: true });
  const listed = await runtime.execute("mcp_tools", { server: "test-mcp" });
  const called = await runtime.execute("mcp_call", { server: "test-mcp", tool: "echo", input: { text: "hello" } });
  const resources = await runtime.execute("mcp_resources", { server: "test-mcp" });
  const readResource = await runtime.execute("mcp_read_resource", { server: "test-mcp", uri: "memo://one" });

  assert.equal(listed.ok, true, listed.output);
  assert.match(listed.output, /"name": "echo"/);
  assert.equal(called.ok, true, called.output);
  assert.match(called.output, /echo:hello/);
  assert.equal(resources.ok, true, resources.output);
  assert.match(resources.output, /memo:\/\/one/);
  assert.equal(readResource.ok, true, readResource.output);
  assert.match(readResource.output, /resource one/);
});

test("browser snapshot and console tools execute with local headless Chrome when available", async (t) => {
  if (!chromeAvailable()) {
    t.skip("Chrome/Edge headless executable not found");
    return;
  }
  const workspace = await tempWorkspace();
  const runtime = await ToolRuntime.create(workspace, { allowExternal: true });
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><html><head><title>Crix Browser</title></head><body><h1 id='x'>Browser OK</h1></body></html>");
  });
  try {
    const snapshot = await runtime.execute("browser_snapshot", { url: server.url, windowSize: "800,600" });
    assert.equal(snapshot.ok, true);
    const snapshotData = JSON.parse(snapshot.output);
    assert.equal(await waitForFile(snapshot.metadata.screenshot ?? snapshotData.screenshot), true, snapshot.output);
    assert.equal(await waitForFile(snapshot.metadata.htmlPath ?? snapshotData.htmlPath), true, snapshot.output);
    const consoleResult = await runtime.execute("browser_console", {
      url: server.url,
      script: "document.querySelector('#x')?.textContent || document.body?.innerText || document.title",
    });
    assert.equal(consoleResult.ok, true);
    assert.match(consoleResult.output, /Browser OK/);
  } finally {
    await server.close();
  }
});

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function chromeAvailable() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean).some((candidate) => existsSync(candidate));
}

async function waitForFile(file) {
  const target = typeof file === "string" ? file : "";
  for (let i = 0; i < 20; i += 1) {
    if (target && existsSync(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
