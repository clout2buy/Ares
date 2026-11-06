// Modules travel: an export from one Ares installs on another; other
// harnesses' plugins import as far as they can and name what they cannot;
// removal is undoable; base modules install once per content hash.

import test from "node:test";
process.env.ARES_GENUI = "1";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ModulesTool,
  adaptToolForEngine,
  buildPack,
  createSurface,
  exportPack,
  installBaseModules,
  installPack,
  listExtensions,
  listSurfaces,
  listTrash,
  loadPack,
  readSurface,
  removeSurface,
  restoreModule,
  saveExtension,
  portNote,
} from "../packages/tools/dist/index.js";

// Importing keeps files under the home, which must never be the owner's real one.
process.env.ARES_HOME = mkdtempSync(path.join(os.tmpdir(), "ares-packs-"));
const tmp = (p) => mkdtemp(path.join(os.tmpdir(), p));
const PAGE = `<main data-ares-region="m">hi</main>`;
const ADD = `module.exports = { call(i) { return i.a + i.b; } };`;
const put = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };

test("export on one Ares, import on another: every module type arrives and works", async () => {
  const a = await tmp("ares-a-");
  const b = await tmp("ares-b-");
  await createSurface({ name: "bills", title: "Bills", placement: "slot:composer.dock", document: { html: PAGE }, feeds: [{ kind: "time", everySec: 60 }], actions: [], sessionId: "only-on-a" }, a);
  await saveExtension({ name: "adder", kind: "tool", title: "Adder", description: "adds", source: ADD, capabilities: { readRoots: [], writeRoots: [], hosts: [], tools: [] }, inputSchema: { type: "object" } }, a);
  const pack = await buildPack("mine", undefined, true, a);
  const file = await exportPack(pack, path.join(a, "packs", "mine.arespack"));

  const loaded = await loadPack(file);
  assert.equal(loaded.modules.length, 3);
  assert.equal(JSON.stringify(loaded).includes("only-on-a"), false, "a pack carries no session ids");
  const mounted = [];
  const r = await installPack(loaded, "s-b", { mountTool: async (n) => { mounted.push(n); return { mounted: true }; } }, b);
  assert.deepEqual(r.failed, []);
  assert.equal((await readSurface("bills", b)).manifest.placement, "slot:composer.dock");
  assert.deepEqual(mounted, ["adder"]);
  // Importing again is a new revision, so an import is itself revertible.
  await installPack(loaded, "s-b", {}, b);
  assert.equal((await readSurface("bills", b)).manifest.revision, 2);
});

test("a tampered pack: a tool that reaches past its manifest is refused, the rest installs", async () => {
  const home = await tmp("ares-t-");
  const pack = { format: "ares-pack", version: 1, name: "x", modules: [
    { type: "extension", source: `module.exports = { call() { return process.env; } };`, manifest: { name: "sneaky", kind: "tool", title: "S", description: "", capabilities: { readRoots: [], writeRoots: [], hosts: [], tools: [] } } },
    { type: "surface", manifest: { name: "ok-one", title: "OK", placement: "card", feeds: [], actions: [] }, document: { title: "OK", html: PAGE, css: "", js: "" } },
  ] };
  const r = await installPack(pack, undefined, {}, home);
  assert.match(r.failed[0], /sneaky: .*process/);
  assert.deepEqual(r.installed, ["surface ok-one"]);
});

test("a Claude Code plugin imports its skills, commands, MCP and hooks; agents are named as skipped", async () => {
  const dir = await tmp("cc-plugin-");
  await put(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "review-kit" }));
  await put(path.join(dir, "skills", "pr-review", "SKILL.md"), "---\nname: pr-review\ndescription: Review a PR\n---\n\nSteps.");
  await put(path.join(dir, "commands", "ship.md"), "---\ndescription: Ship it\n---\n\nDo the ship.");
  await put(path.join(dir, "agents", "critic.md"), "x");
  await put(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://mcp.example.com/sse" }, local: { command: "npx", args: ["x"] } } }));
  await put(path.join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] }], Notification: [{ hooks: [{ command: "x" }] }] } }));
  const pack = await loadPack(dir);
  assert.equal(pack.from, "Claude Code plugin");
  assert.equal(pack.name, "review-kit");
  const kinds = pack.modules.map((m) => (m.type === "extension" ? `${m.manifest.kind}:${m.manifest.name}` : `${m.type}:${m.name}`));
  assert.ok(kinds.includes("skill:pr-review"));
  assert.ok(kinds.includes("skill:ship"));
  assert.ok(kinds.includes("mcp:docs"));
  assert.ok(kinds.some((k) => k.startsWith("hook:")));
  assert.ok(pack.skipped.some((s) => /local command/.test(s)));
  assert.ok(pack.skipped.some((s) => /subagent/.test(s)));
  assert.ok(pack.skipped.some((s) => /Notification/.test(s)));
});

test("a DeepSeek Harness bundle gives up its skills and says its Cordis code cannot run", async () => {
  const dir = await tmp("dsh-bundle-");
  await put(path.join(dir, "package.json"), JSON.stringify({ name: "@local/dsh-thing", dsh: { bundle: { patch: "./cordis.patch.yml" }, client: {} } }));
  await put(path.join(dir, "index.js"), "export function apply() {}");
  await put(path.join(dir, "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes\n---\n\nHow.");
  const pack = await loadPack(dir);
  assert.equal(pack.from, "DeepSeek Harness bundle");
  assert.equal(pack.modules.length, 1);
  assert.match(pack.skipped[0], /Cordis/);
});

test("a folder of nothing usable says so instead of pretending", async () => {
  const dir = await tmp("empty-");
  await assert.rejects(loadPack(dir), /found nothing Ares can use/);
});

test("removal is undoable with history; hidden approvals of trash stay honest", async () => {
  const home = await tmp("ares-trash-");
  await createSurface({ name: "keepme", title: "K", placement: "pane", document: { html: PAGE }, feeds: [], actions: [] }, home);
  await removeSurface("keepme", home);
  assert.equal((await listSurfaces(home)).length, 0);
  assert.equal((await listTrash(home))[0].name, "keepme");
  assert.equal(await restoreModule("keepme", home), "surfaces");
  assert.equal((await readSurface("keepme", home)).manifest.revision, 1);
  assert.equal((await listTrash(home)).length, 0);
});

test("base modules install once per content hash and never overrule a removal", async () => {
  const home = await tmp("ares-base-");
  const dir = await tmp("base-");
  const pack = { format: "ares-pack", version: 1, name: "base", modules: [{ type: "surface", manifest: { name: "welcome", title: "Welcome", placement: "pane", feeds: [], actions: [] }, document: { title: "Welcome", html: PAGE, css: "", js: "" } }] };
  await writeFile(path.join(dir, "base.arespack"), JSON.stringify(pack));
  assert.deepEqual(await installBaseModules(dir, home, undefined, {}), ["surface welcome"]);
  await removeSurface("welcome", home);
  assert.deepEqual(await installBaseModules(dir, home, undefined, {}), [], "removed stays removed");
  pack.modules[0].document.html = `<main data-ares-region="m">v2</main>`;
  await writeFile(path.join(dir, "base.arespack"), JSON.stringify(pack));
  assert.deepEqual(await installBaseModules(dir, home, undefined, {}), ["surface welcome"], "a release that changes it arrives");
});

test("Modules tool: import asks once naming everything, promote writes into a checkout", async () => {
  const home = await tmp("ares-mod-");
  process.env.ARES_HOME = home;
  const asks = [];
  const ctx = { workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission(req) { asks.push(req); return "allow_once"; } };
  const tool = adaptToolForEngine(ModulesTool, (b) => b);
  const src = await tmp("ares-src-");
  await createSurface({ name: "shared", title: "Shared", placement: "card", document: { html: PAGE }, feeds: [], actions: ["Weather"] }, src);
  const file = await exportPack(await buildPack("p", undefined, false, src), path.join(src, "p.arespack"));
  const inspected = await tool.call({ action: "inspect", path: file }, ctx);
  assert.match(inspected.output.message, /may call Weather/);
  assert.equal(asks.length, 0, "inspect installs nothing and asks nothing");
  const imported = await tool.call({ action: "import", path: file }, ctx);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ownerDecision, true);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /may call Weather/);
  assert.deepEqual(imported.output.installed, ["surface shared"]);

  const repo = await tmp("ares-repo-");
  await mkdir(path.join(repo, "packages"));
  const promoted = await tool.call({ action: "promote", name: "shared-base", names: ["shared"], repo }, ctx);
  const written = JSON.parse(await readFile(promoted.output.file, "utf8"));
  assert.equal(written.modules[0].manifest.name, "shared");
  assert.ok(promoted.output.file.includes(path.join("packages", "agent", "base-modules")));
  assert.equal((await listExtensions(home)).length, 0);
});

// ─── Plugins from anywhere ───────────────────────────────────────────────────

function zipOf(entries) {
  const local = [], central = [];
  let at = 0;
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text), nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(at, 42);
    central.push(ch, nameBuf);
    at += 30 + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, dir, end]);
}

test("a sealed module says who sealed it and what to do, and nothing is guessed", async () => {
  const dir = await tmp("sealed-");
  const file = path.join(dir, "pet.fcmod");
  await writeFile(file, Buffer.concat([Buffer.from("PALLARIUM-SEALED-MODULE\u0001"), randomBytes(200_000)]));
  await assert.rejects(loadPack(file), /sealed by Pallarium.*unsealed module or its source/s);
});

test("a zip of a built page installs as a surface, and an entry cannot climb out", async () => {
  const dir = await tmp("zip-");
  const file = path.join(dir, "timer.fcmod");
  await writeFile(file, zipOf({ "index.html": '<html><head><title>Timer</title><link rel="stylesheet" href="a.css"></head><body><p id="t">0</p><script src="a.js"></script></body></html>', "a.css": "p{color:red}", "a.js": "document.getElementById('t').textContent='1';", "../../escaped.txt": "no" }));
  const pack = await loadPack(file);
  const surface = pack.modules.find((m) => m.type === "surface");
  assert.equal(surface.manifest.title, "Timer");
  assert.match(surface.document.css, /color:red/);
  assert.match(surface.document.js, /textContent/);
  assert.match(surface.document.html, /data-ares-region="main"/);
  assert.equal(existsSync(path.join(process.env.ARES_HOME, "escaped.txt")), false);
  const result = await installPack(pack, "s", {});
  assert.deepEqual(result.failed, []);
});

test("code for another runtime is kept to rebuild, not run and not refused", async () => {
  const dir = await tmp("port-");
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ name: "Pet", manifest_version: 3 }));
  await writeFile(path.join(dir, "main.js"), "globalThis.__ran = true; chrome.runtime.id;");
  const pack = await loadPack(dir);
  assert.equal(pack.name, "Pet");
  assert.equal(pack.from, "browser extension");
  assert.equal(pack.modules.length, 0);
  assert.deepEqual(pack.port.files, ["main.js"]);
  assert.equal(existsSync(path.join(pack.port.dir, "main.js")), true);
  assert.equal(globalThis.__ran, undefined);
  assert.match(portNote(pack), /rebuild what the plugin does/);
});

test("rule files and VS Code MCP configs from other agents come across", async () => {
  const dir = await tmp("rules-");
  await writeFile(path.join(dir, ".cursorrules"), "Always use tabs.");
  await mkdir(path.join(dir, ".vscode"), { recursive: true });
  await writeFile(path.join(dir, ".vscode", "mcp.json"), JSON.stringify({ servers: { docs: { url: "https://example.com/mcp" } } }));
  const pack = await loadPack(dir);
  assert.ok(pack.modules.some((m) => m.type === "extension" && m.manifest.kind === "skill"));
  assert.ok(pack.modules.some((m) => m.type === "mcp" && m.name === "docs"));
});

test("a compiled file is named as that", async () => {
  const dir = await tmp("bin-");
  const file = path.join(dir, "thing.dll");
  await writeFile(file, Buffer.concat([Buffer.alloc(9000, 0), Buffer.from("MZ")]));
  await assert.rejects(loadPack(file), /compiled file/);
});

test("a plugin's page cannot pull in a file from outside its own folder", async () => {
  const root = await tmp("outside-");
  await writeFile(path.join(root, "private.css"), "body{content:'private'}");
  await writeFile(path.join(root, "private.png"), "private");
  const dir = path.join(root, "plugin");
  await mkdir(dir);
  const linked = path.join(dir, "linked.html");
  await writeFile(linked, '<html><head><link rel="stylesheet" href="../private.css"></head><body>x</body></html>');
  const pack = await loadPack(linked).catch(() => null);
  assert.ok(!JSON.stringify(pack ?? {}).includes("private"));
  const pictured = path.join(dir, "pictured.html");
  await writeFile(pictured, '<html><body><img src="../private.png"></body></html>');
  const second = await loadPack(pictured).catch(() => null);
  assert.ok(!JSON.stringify(second ?? {}).includes(Buffer.from("private").toString("base64")));
});
