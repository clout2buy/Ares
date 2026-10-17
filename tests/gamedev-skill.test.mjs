// The bundled gamedev skill: Ares's game-development handbook (architecture, physics, how real things are built,
// web / Java / engines, game feel, surgical fixes). It ships like the godot skill, is found by SkillRead, and game
// projects at the working directory point at it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installBundledSkills } from "../packages/agent/dist/index.js";
import { SkillsListTool, SkillReadTool } from "../packages/tools/dist/index.js";
import { gameStack } from "../packages/cli/dist/entry/prompt/surfaces.js";
import { buildSystemPrompt } from "../packages/cli/dist/entry/turnPipeline.js";

const DIR = path.resolve("packages/agent/skills/gamedev");

test("gamedev skill: valid frontmatter, every reference it names exists and carries the facts it promises", async () => {
  const md = await readFile(path.join(DIR, "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: gamedev\ndescription: .+\nstatus: active\nversion: \d+\n---/);
  const named = [...md.matchAll(/`references\/([a-z-]+\.md)`/g)].map((m) => m[1]);
  const present = (await readdir(path.join(DIR, "references"))).sort();
  assert.deepEqual([...new Set(named)].sort(), present, "the index names exactly the files that exist");
  const ref = async (f) => readFile(path.join(DIR, "references", f), "utf8");
  assert.match(await ref("objects.md"), /4 wheels on 2 axles/);
  assert.match(await ref("physics.md"), /Ackermann/);
  assert.match(await ref("physics.md"), /Fixed timestep/);
  assert.match(await ref("physics.md"), /never the forward axis/);
  assert.match(await ref("java.md"), /Fabric/);
  assert.match(await ref("web.md"), /importmap/);
  assert.match(md, /fix it surgically/);
  assert.match(await ref("modelling.md"), /HEAD UNITS/);
  assert.match(await ref("video.md"), /ffmpeg -framerate 30/);
  assert.doesNotMatch(md, /re-verif|verifier/i, "no verification loops: one run, one look");
  for (const f of present) assert.ok(!(await ref(f)).includes("\t"), `${f}: no tabs`);
});

test("gamedev skill: installs with the bundled skills and SkillRead finds it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-gd-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const out = await installBundledSkills(path.join(home, "skills"), { only: ["gamedev"] });
  assert.deepEqual(out.map((o) => [o.name, o.action]), [["gamedev", "installed"]]);
  const before = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = before; });
  const ctx = { workspace: home };
  const list = await SkillsListTool.call({ query: "physics" }, ctx);
  assert.ok(list.output.skills.some((s) => s.name === "gamedev"));
  const read = await SkillReadTool.call({ name: "gamedev" }, ctx);
  assert.match(read.output.content, /references\/physics\.md/);
  assert.ok(read.output.path.endsWith(path.join("gamedev", "SKILL.md")), "the path lets Ares Read the sibling references");
});

test("game projects at the working directory are recognised (and plain projects are not)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (name, files) => { const d = path.join(root, name); await mkdir(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { await mkdir(path.dirname(path.join(d, f)), { recursive: true }); await writeFile(path.join(d, f), c); } return d; };
  assert.equal(gameStack(await make("web", { "package.json": JSON.stringify({ dependencies: { three: "^0.160.0" } }) })), "web");
  assert.equal(gameStack(await make("canvas", { "index.html": "<canvas id=c></canvas>" })), "web");
  assert.equal(gameStack(await make("gdx", { "build.gradle": "api \"com.badlogicgames.gdx:gdx:$gdxVersion\"" })), "Java / LibGDX");
  assert.equal(gameStack(await make("fabric", { "build.gradle": "plugins { id 'fabric-loom' version '1.7' }" })), "Java / Minecraft");
  assert.equal(gameStack(await make("unity", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.1f1" })), "Unity");
  assert.equal(gameStack(await make("unreal", { "Racer.uproject": "{}" })), "Unreal");
  assert.equal(gameStack(await make("godot", { "project.godot": "" })), "Godot");
  assert.equal(gameStack(await make("love", { "main.lua": "", "conf.lua": "" })), "LOVE");
  assert.equal(gameStack(await make("bevy", { "Cargo.toml": "[dependencies]\nbevy = \"0.14\"" })), "Rust / Bevy");
  assert.equal(gameStack(await make("api", { "package.json": JSON.stringify({ dependencies: { express: "4" } }) })), "");
  assert.equal(gameStack(""), "");
});

test("the always-on prompt sends every game request to the handbook", () => {
  const p = buildSystemPrompt("workspace-write", undefined, { tools: ["Read", "Write", "Edit", "Bash"] });
  assert.match(p, /Games\/3D\/video: `SkillRead gamedev` first/);
  assert.doesNotMatch(p, /fix every `quality` note/, "no re-check gate in the always-on prompt");
});
