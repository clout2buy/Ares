// GenUI is the owner's switch: off, nothing that changes Ares can run, in any
// permission mode, and what exists keeps working; on, the tools are simply
// present and every turn carries the how.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EditTool,
  ExtensionTool,
  HarnessTool,
  IntrospectTool,
  ModulesTool,
  ShellTool,
  SurfaceTool,
  WriteTool,
  adaptToolForEngine,
  createSurface,
  genuiBriefing,
  genuiEnabled,
  genuiNow,
  isAresSource,
  setGenui,
  setUiMap,
} from "../packages/tools/dist/index.js";
import { loadedDeferredToolNames } from "../packages/cli/dist/entry/engineTools.js";

const PAGE = `<main data-ares-region="m">x</main>`;

async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ares-genui-"));
  process.env.ARES_HOME = dir;
  delete process.env.ARES_GENUI;
  return dir;
}

const ctx = (workspace) => ({ workspace, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission() { return "allow_once"; } });
const run = (tool, input, dir) => adaptToolForEngine(tool, (b) => b).call(input, ctx(dir));

test("the switch persists and defaults to off", async () => {
  const dir = await home();
  assert.equal(genuiEnabled(), false);
  setGenui(true, dir);
  assert.equal(genuiEnabled(), true);
  setGenui(false, dir);
  assert.equal(genuiEnabled(), false);
});

test("off: nothing that changes Ares runs, even in bypass mode, and it says to click GenUI", async () => {
  const dir = await home();
  const blocked = [
    [ShellTool, { action: "set", css: ".a{}" }],
    [SurfaceTool, { action: "create", name: "nope", html: PAGE }],
    [SurfaceTool, { action: "mutate", name: "x", base_revision: 1, mutations: [{ op: "set_title", title: "t" }] }],
    [ExtensionTool, { action: "draft", name: "nope", source: "x" }],
    [ExtensionTool, { action: "mount", name: "nope" }],
    [ModulesTool, { action: "import", path: dir }],
    [ModulesTool, { action: "promote", name: "n", names: ["a"] }],
    [HarnessTool, { action: "apply" }],
    [HarnessTool, { action: "propose", title: "t", summary: "s" }],
  ];
  for (const [tool, input] of blocked) {
    await assert.rejects(run(tool, input, dir), /GenUI is off/, `${tool.schema.name} ${input.action}`);
  }
});

test("off: what exists keeps working", async () => {
  const dir = await home();
  await createSurface({ name: "live", title: "Live", placement: "card", document: { html: PAGE }, feeds: [], actions: [] }, dir);
  assert.equal((await run(SurfaceTool, { action: "list" }, dir)).output.surfaces.length, 1);
  assert.match((await run(SurfaceTool, { action: "post", name: "live", payload: 1 }, dir)).output.message, /Posted/);
  assert.equal((await run(SurfaceTool, { action: "mutate", name: "live", base_revision: 1, mutations: [{ op: "post", payload: 2 }] }, dir)).output.revision, 1);
  assert.ok((await run(ShellTool, { action: "show" }, dir)).output.layout);
  assert.ok((await run(ModulesTool, { action: "list" }, dir)).output.modules);
  assert.equal((await run(HarnessTool, { action: "status" }, dir)).output.wired, false);
});

test("off: Edit and Write refuse an Ares checkout but touch other projects normally", async () => {
  const dir = await home();
  const repo = await mkdtemp(path.join(os.tmpdir(), "ares-checkout-"));
  await mkdir(path.join(repo, "packages", "protocol"), { recursive: true });
  await mkdir(path.join(repo, "tauri", "src-tauri"), { recursive: true });
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "packages", "protocol", "package.json"), "{}");
  await writeFile(path.join(repo, "src", "a.ts"), "x");
  assert.equal(isAresSource(path.join(repo, "src", "a.ts"), repo), true);
  assert.equal(isAresSource(path.join(dir, "a.ts"), dir), false);
  await assert.rejects(run(WriteTool, { file_path: path.join(repo, "src", "b.ts"), content: "y" }, repo), /GenUI is off/);
  await assert.rejects(run(EditTool, { file_path: path.join(repo, "src", "a.ts"), old_string: "x", new_string: "y" }, repo), /GenUI is off/);
  await run(WriteTool, { file_path: path.join(dir, "fine.txt"), content: "ok" }, dir);
});

test("on: the same calls run, the tools need no search, and the briefing has the recipes", async () => {
  const dir = await home();
  setGenui(true, dir);
  const made = await run(SurfaceTool, { action: "create", name: "panel", placement: "slot:side.left", html: PAGE }, dir);
  assert.equal(made.output.revision, 1);
  const set = await run(ShellTool, { action: "set", nav: [{ id: "chat" }, { id: "box", label: "Modules", icon: "grid", menu: ["*"] }] }, dir);
  assert.equal(set.output.layout.nav[1].menu[0], "*");
  assert.match((await run(ShellTool, { action: "go", target: "surface:panel" }, dir)).output.message, /Went to/);
  assert.ok(loadedDeferredToolNames("no-such-session").includes("Shell"));
  setUiMap([".rail"], { styles: [".rail bg rgb(255, 255, 255)"], vars: { "--bg": "#fff" }, state: "view chat, Forge closed" });
  const now = await genuiNow();
  assert.match(now, /panel "panel" \(slot:side\.left, r1\)/, "every turn names what exists");
  assert.match(now, /view chat/);
  assert.match(genuiBriefing(now), /^On screen:/);
  const styles = await run(IntrospectTool, { action: "styles" }, dir);
  assert.deepEqual(styles.output.styles, [".rail bg rgb(255, 255, 255)"]);
  assert.match(genuiBriefing(), /never edit Ares source/);
  assert.match(genuiBriefing(), /side\.left/);
  setGenui(false, dir);
  assert.equal(loadedDeferredToolNames("no-such-session").includes("Shell"), false);
});

test("on: a Browser preview is refused so the Forge stays closed; off, it passes", async () => {
  const dir = await home();
  const calls = [];
  const browser = {
    schema: { name: "Browser", description: "b", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe" },
    inputZod: { safeParse: (x) => ({ success: true, data: x }) },
    effectiveSafety: () => "read-only",
    async checkPermissions() { return { kind: "allow" }; },
    async call(input) { calls.push(input.action); return { output: "ok" }; },
    activityDescription: () => "b",
  };
  setGenui(true, dir);
  await assert.rejects(run(browser, { action: "preview", html: "x" }, dir), /do not preview/);
  await run(browser, { action: "navigate", url: "https://example.com" }, dir);
  setGenui(false, dir);
  await run(browser, { action: "preview", html: "x" }, dir);
  assert.deepEqual(calls, ["navigate", "preview"]);
});

// Every new chat lost its loaded tools: the briefing said Shell and Surface were
// loaded while the model was not sent them, and weaker models went file hunting.
test("a new chat and a resumed chat both get their loaded tools", () => {
  const factory = readFileSync(new URL("../packages/cli/src/entry/sessionFactory.ts", import.meta.url), "utf8");
  assert.equal(factory.split('const deferredHolder = { id: "" }').length, 3);
  assert.equal(factory.split("deferredHolder.id = session.meta.id").length, 3);
});

test("the briefing sends Ares to its tools, not its files, and asks before it builds", () => {
  assert.match(genuiBriefing(), /do not look for its code/);
  assert.match(genuiBriefing(), /Ask before you build/);
  assert.match(genuiBriefing(), /Never pick a default/);
});

test("a model with no vision is told what it really gets", () => {
  assert.match(genuiBriefing(), /You can see/);
  assert.match(genuiBriefing("", false), /cannot view images/);
  assert.doesNotMatch(genuiBriefing("", false), /You can see/);
});

test("what an agent builds never flashes", () => {
  assert.match(genuiBriefing(), /Nothing you build ever flashes/);
});

test("the button shows what was saved, never a click that the agent did not take", () => {
  const app = readFileSync(new URL("../tauri/src/App.tsx", import.meta.url), "utf8");
  const toggle = app.slice(app.indexOf("const toggleGenui = useCallback"), app.indexOf("const onGenuiState = useCallback"));
  // The dev bridge has no daemon to answer, so it alone flips locally.
  assert.doesNotMatch(toggle.replace("if (!native) setGenui(next);", ""), /\bsetGenui\(next\)/, "no optimistic flip on the desktop");
  assert.match(toggle, /needs the agent running/);
  const daemon = readFileSync(new URL("../packages/cli/src/entry/daemon/surfaces.ts", import.meta.url), "utf8");
  assert.match(daemon.slice(daemon.indexOf('case "genui_set"')), /enabled: genuiEnabled\(this\.options\.home\)/, "the answer is read back from disk");
});
