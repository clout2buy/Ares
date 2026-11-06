// Extensions: the ledger, the sandboxed runner, the manifest scan, mounting
// into a belt through the plugin kernel, Introspect and Harness
// (docs/CREATOR-MODE-DESIGN.md Layers 2 and 3).

import test from "node:test";
process.env.ARES_GENUI = "1";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExtensionTool,
  HarnessTool,
  IntrospectTool,
  adaptToolForEngine,
  listExtensions,
  manifestProblems,
  readExtension,
  runForgedTool,
  saveExtension,
  scanToolSource,
  setExtensionHost,
  toolNameOf,
} from "../packages/tools/dist/index.js";
import { PluginHost } from "../packages/plugins/dist/index.js";
import { ForgedTools } from "../packages/cli/dist/entry/forgedTools.js";

const tmp = (p) => mkdtemp(path.join(os.tmpdir(), p));

const ADD = `module.exports = { async call(input, ares) { ares.log("adding"); return { sum: Number(input.a) + Number(input.b) }; } };`;
const READER = `module.exports = { async call(input, ares) { const text = await ares.readFile(input.path); return { lines: text.split("\\n").length }; } };`;
const FETCHER = `module.exports = { async call(input, ares) { const r = await ares.fetch("https://example.com/x"); return r.status; } };`;
const CALLER = `module.exports = { async call(input, ares) { return ares.call("Weather", { city: input.city }); } };`;

test("scan: the source's reach must fit the manifest", () => {
  assert.deepEqual(scanToolSource(ADD), []);
  assert.deepEqual(manifestProblems(ADD, { readRoots: [], writeRoots: [], hosts: [], tools: [] }), []);
  assert.match(manifestProblems(READER, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /readRoots/);
  assert.deepEqual(manifestProblems(READER, { readRoots: ["."], writeRoots: [], hosts: [], tools: [] }), []);
  assert.match(manifestProblems(FETCHER, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /hosts/);
  assert.match(manifestProblems(CALLER, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /ares.call\("Weather"\)/);
  assert.match(manifestProblems(`const fs = require("fs"); module.exports = { call() { return 1; } };`, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /require/);
  assert.match(manifestProblems(`module.exports = { call() { return process.env; } };`, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /process/);
  assert.match(manifestProblems(`module.exports = { async call() { return fetch("https://x"); } };`, { readRoots: [], writeRoots: [], hosts: [], tools: [] })[0], /ares.fetch/);
});

test("runner: a module runs in a worker with only its capabilities", async () => {
  const workspace = await tmp("ares-forged-ws-");
  await writeFile(path.join(workspace, "a.txt"), "1\n2\n3");
  await mkdir(path.join(workspace, "secret"));
  await writeFile(path.join(workspace, "secret", "k.txt"), "nope");
  const none = { readRoots: [], writeRoots: [], hosts: [], tools: [] };
  const add = await runForgedTool({ source: ADD, input: { a: 2, b: 3 }, workspace, capabilities: none });
  assert.equal(add.ok, true);
  assert.deepEqual(add.output, { sum: 5 });
  assert.deepEqual(add.logs, ["adding"]);
  const read = await runForgedTool({ source: READER, input: { path: "a.txt" }, workspace, capabilities: { ...none, readRoots: ["."] } });
  assert.deepEqual(read.output, { lines: 3 });
  const outside = await runForgedTool({ source: READER, input: { path: "secret/k.txt" }, workspace, capabilities: { ...none, readRoots: ["public"] } });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /outside the manifest's readRoots/);
  const traversal = await runForgedTool({ source: READER, input: { path: "../a.txt" }, workspace: path.join(workspace, "secret"), capabilities: { ...none, readRoots: ["."] } });
  assert.equal(traversal.ok, false);
  const noHost = await runForgedTool({ source: FETCHER, input: {}, workspace, capabilities: { ...none, hosts: ["api.other.com"] } });
  assert.match(noHost.error, /not in the manifest's hosts/);
  const called = await runForgedTool({ source: CALLER, input: { city: "Austin" }, workspace, capabilities: { ...none, tools: ["Weather"] }, callTool: async (tool, input) => ({ tool, input, temp: 21 }) });
  assert.deepEqual(called.output, { tool: "Weather", input: { city: "Austin" }, temp: 21 });
  const uncalled = await runForgedTool({ source: CALLER, input: { city: "Austin" }, workspace, capabilities: none, callTool: async () => 1 });
  assert.match(uncalled.error, /not in the manifest's tools/);
  const escape = await runForgedTool({ source: `module.exports = { call() { return typeof require + "/" + typeof process; } };`, input: {}, workspace, capabilities: none });
  assert.equal(escape.output, "undefined/undefined", "no require, no process inside the context");
  const hang = await runForgedTool({ source: `module.exports = { call() { return new Promise(() => {}); } };`, input: {}, workspace, capabilities: none, timeoutMs: 300 });
  assert.match(hang.error, /ran past/);
});

test("ledger + Extension tool: draft refuses an over-reaching source, try runs, mount is an owner decision, kernel mount/unmount splices the belt", async () => {
  const home = await tmp("ares-ext-home-");
  process.env.ARES_HOME = home;
  const workspace = await tmp("ares-ext-ws-");
  const asks = [];
  const ctx = (permissionMode = "bypass") => ({ workspace, sessionId: "s1", signal: new AbortController().signal, permissionMode, fileReadStamps: new Map(), async requestPermission(req) { asks.push(req); return "allow_once"; } });
  const tool = adaptToolForEngine(ExtensionTool, (b) => b);

  const over = await tool.call({ action: "draft", name: "reader", kind: "tool", description: "counts lines", input_schema: { type: "object", properties: { path: { type: "string" } } }, source: READER }, ctx());
  assert.match(over.failure ?? "", /readRoots/);
  assert.equal((await listExtensions(home)).length, 0);

  const drafted = await tool.call({ action: "draft", name: "adder", kind: "tool", title: "Adder", description: "adds two numbers", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }, source: ADD }, ctx());
  assert.equal(drafted.output.revision, 1);
  assert.equal(asks.length, 0, "drafting asks nobody");
  const tried = await tool.call({ action: "try", name: "adder", input: { a: 1, b: 1 } }, ctx());
  assert.deepEqual(tried.output.output, { sum: 2 });

  const routed = await tool.call({ action: "draft", name: "w", kind: "watcher", source: "x" }, ctx());
  assert.match(routed.failure ?? "", /Remind/);

  // A belt with a kernel behind it.
  const host = new PluginHost();
  const belt = [];
  const catalog = [];
  const forged = new ForgedTools({
    host, workspace, home,
    belts: () => [belt],
    enrich: (b) => ({ ...b, permissionMode: "bypass", fileReadStamps: new Map() }),
    catalog: { add: (name, description) => catalog.push({ name, description }), remove: (name) => { const i = catalog.findIndex((d) => d.name === name); if (i >= 0) catalog.splice(i, 1); } },
  });
  const mounted = await tool.call({ action: "mount", name: "adder" }, ctx());
  assert.equal(asks.length, 0, "a tool that can reach nothing just mounts");
  assert.match(mounted.output.message, /ForgedAdder/);
  assert.equal(belt.length, 1);
  assert.equal(belt[0].schema.name, "ForgedAdder");
  assert.deepEqual(belt[0].schema.inputJsonSchema, { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } });
  assert.equal(catalog[0].name, "ForgedAdder");
  assert.equal(host.statusOf("tool:adder")?.state, "active");
  const ran = await belt[0].call({ a: 20, b: 22 }, ctx());
  assert.deepEqual(ran.output, { sum: 42 });

  // A new revision while mounted swaps the running tool; a fresh belt joins.
  await tool.call({ action: "draft", name: "adder", kind: "tool", title: "Adder", description: "adds, now times two", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }, source: `module.exports = { call(i) { return { sum: 2 * (i.a + i.b) }; } };` }, ctx());
  assert.deepEqual((await belt[0].call({ a: 1, b: 1 }, ctx())).output, { sum: 4 });
  const belt2 = [];
  forged.attach(belt2);
  assert.equal(belt2.length, 1);

  const unmounted = await tool.call({ action: "unmount", name: "adder" }, ctx());
  assert.match(unmounted.output.message, /out of the belt/);
  assert.equal(belt.length, 0, "unmount is the inverse of mount");
  assert.equal(belt2.length, 0);
  assert.equal(catalog.length, 0);
  assert.equal(host.statusOf("tool:adder"), undefined);
  assert.equal((await readExtension("adder", home)).manifest.revision, 2, "the ledger keeps it");

  const kept = await tool.call({ action: "keep", name: "adder" }, ctx());
  assert.equal(kept.output.state, "kept");
  await forged.remountKept();
  assert.equal(belt.length, 1, "kept tools remount at boot");
  await host.dispose();
  setExtensionHost(null);

  // skills: draft + mount installs a SKILL.md where the catalog looks
  const skill = await tool.call({ action: "draft", name: "release-notes", kind: "skill", title: "Release notes", description: "how to write them", source: "# Release notes\n\nList what changed, newest first." }, ctx());
  assert.equal(skill.output.revision, 1);
  const installed = await tool.call({ action: "mount", name: "release-notes" }, ctx());
  assert.equal(asks.length, 1, "installing a skill asks once");
  const text = await readFile(path.join(home, "skills", "release-notes", "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: release-notes/);
  assert.match(installed.output.message, /installed/);
});

test("Introspect reads the belt and the roster; Harness files a proposal the Maintainer's collector reads", async () => {
  const home = await tmp("ares-intro-home-");
  process.env.ARES_HOME = home;
  const belt = [
    { schema: { name: "Read", description: "read a file", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe" } },
    { schema: { name: "Weather", description: "the weather", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe" } },
    { schema: { name: "mcp_github_list_issues", description: "issues", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe" } },
  ];
  const ctx = {
    workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map(),
    deferredTools: { loaded: () => ["Weather"] },
    introspect: { tools: () => belt, isCore: (n) => n === "Read", plugins: () => ({ plugins: [{ name: "maintenance:heap-watch", state: "active", waitingOn: [] }], recentMaintenance: [] }) },
  };
  const introspect = adaptToolForEngine(IntrospectTool, (b) => b);
  const tools = await introspect.call({ action: "tools" }, ctx);
  assert.deepEqual(tools.output.totals, { tools: 3, core: 1, deferred: 1, mcp: 1, corePromptChars: tools.output.tools.find((t) => t.name === "Read").promptChars, loadedPromptChars: tools.output.tools.find((t) => t.name === "Weather").promptChars });
  assert.equal(tools.output.tools.find((t) => t.name === "Weather").loaded, true);
  const connectors = await introspect.call({ action: "connectors" }, ctx);
  assert.deepEqual(connectors.output.connectors, [{ server: "github", tools: ["list_issues"] }]);
  const plugins = await introspect.call({ action: "plugins" }, ctx);
  assert.match(plugins.output.message, /heap-watch: active/);

  const asks = [];
  const harness = adaptToolForEngine(HarnessTool, (b) => b);
  const hctx = { ...ctx, permissionMode: "bypass", async requestPermission(req) { asks.push(req); return "allow_once"; } };
  const status = await harness.call({ action: "status" }, hctx);
  assert.equal(status.output.wired, false);
  const filed = await harness.call({ action: "propose", title: "Surface cards flicker on theme change", summary: "Switching theme reloads every card. Expected: tokens are posted, not rebuilt.", evidence: ["tauri/src/surfaces/SurfaceHost.tsx"] }, hctx);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ownerDecision, true);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /ask you before anything deploys/);
  const doc = JSON.parse(await readFile(filed.output.file, "utf8"));
  assert.equal(doc.source, "harness");
  assert.match(doc.description, /^Surface cards flicker/);
  assert.ok(filed.output.file.includes(path.join(home, "bug-reports")));
});

test("Harness apply boots a real runtime in a throwaway home before staging it; a broken one changes nothing", async (t) => {
  const runtime = path.resolve("tauri/src-tauri/runtime");
  const exists = await readFile(path.join(runtime, "cli", "ares-cli.mjs"), "utf8").then(() => true, () => false);
  if (!exists) { t.skip("no packaged runtime"); return; }
  const home = await tmp("ares-apply-");
  process.env.ARES_HOME = home;
  process.env.ARES_DESKTOP_VERSION = "9.9.9";
  const ctx = { workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission() { return "allow_once"; } };
  const harness = adaptToolForEngine(HarnessTool, (b) => b);
  const bad = await tmp("ares-bad-rt-");
  await mkdir(path.join(bad, "bin"));
  await mkdir(path.join(bad, "cli"));
  await writeFile(path.join(bad, "bin", process.platform === "win32" ? "node.exe" : "node"), "x");
  await writeFile(path.join(bad, "cli", "ares-cli.mjs"), "x");
  const refused = await harness.call({ action: "apply", runtime_dir: bad }, ctx);
  assert.match(refused.failure ?? "", /did not boot|nothing changed/);
  const staged = await harness.call({ action: "apply", runtime_dir: runtime, title: "test" }, ctx);
  assert.equal(staged.failure, undefined, staged.failure);
  assert.equal(await readFile(path.join(home, "runtime-next", ".version"), "utf8"), "9.9.9");
  assert.ok(await readFile(path.join(home, "runtime-next", ".ready"), "utf8"));
  delete process.env.ARES_DESKTOP_VERSION;
});
