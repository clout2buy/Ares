import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  installBundledSkills,
  bundledSkillsDir,
  parseCapabilityManifest,
  runSkill,
  scanCapabilityRegistry,
} from "../packages/agent/dist/index.js";

const skillSrc = path.resolve("packages/agent/skills/godot");
const tscn = await import(pathToFileURL(path.join(skillSrc, "lib", "tscn.js")).href);
const mesh = await import(pathToFileURL(path.join(skillSrc, "lib", "mesh.js")).href);
const net = await import(pathToFileURL(path.join(skillSrc, "lib", "net.js")).href);
const godot = await import(pathToFileURL(path.join(skillSrc, "lib", "godot.js")).href);
const handler = await import(pathToFileURL(path.join(skillSrc, "handler.js")).href);

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://abc123"]

[ext_resource type="Script" path="res://player.gd" id="1_p"]

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_1"]
radius = 0.4
height = 1.8

[node name="Main" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="." groups=["player", "actors"]]
script = ExtResource("1_p")
position = Vector3(0, 1, 0)

[node name="Shape" type="CollisionShape3D" parent="Player"]
shape = SubResource("CapsuleShape3D_1")

[node name="Camera3D" type="Camera3D" parent="Player"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 5)

[node name="Button" type="Button" parent="."]
text = "Go"

[connection signal="pressed" from="Button" to="." method="_on_button_pressed"]
`;

const PROJECT = `; Engine configuration file.
config_version=5

[application]

config/name="Fixture"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.3", "Forward Plus")

[physics]

common/physics_ticks_per_second=60
`;

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fixtureProject() {
  const dir = await tempDir("ares-godot-project-");
  await fs.writeFile(path.join(dir, "project.godot"), PROJECT, "utf8");
  await fs.writeFile(path.join(dir, "main.tscn"), SCENE, "utf8");
  await fs.writeFile(path.join(dir, "player.gd"), "extends CharacterBody3D\n", "utf8");
  return dir;
}

test("bundled godot provider ships a valid manifest and installs into the skills dir", async (t) => {
  const bundled = await bundledSkillsDir();
  assert.ok(bundled && bundled.endsWith("skills"), `bundled skills dir resolves (${bundled})`);
  const manifest = parseCapabilityManifest(JSON.parse(await fs.readFile(path.join(skillSrc, "capability.json"), "utf8")));
  assert.equal(manifest.id, "ares/godot");
  assert.equal(manifest.operations[manifest.healthcheck.operation].effect, "read-only");
  assert.equal(manifest.operations.run.evidence[0], "screenshot");

  const home = await tempDir("ares-godot-home-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const skillsDir = path.join(home, "skills");
  const first = await installBundledSkills(skillsDir);
  assert.equal(first.find((s) => s.name === "godot")?.action, "installed");
  const again = await installBundledSkills(skillsDir);
  assert.equal(again.find((s) => s.name === "godot")?.action, "kept", "same version is not re-copied");
  await fs.rm(path.join(skillsDir, "godot", ".ares-bundled"));
  const owned = await installBundledSkills(skillsDir);
  assert.equal(owned.find((s) => s.name === "godot")?.action, "user-owned", "an unmarked copy belongs to the user");

  const registry = await scanCapabilityRegistry({ home });
  const provider = registry.providers.find((p) => p.manifest.id === "ares/godot");
  assert.ok(provider, `registry lists ares/godot (errors: ${JSON.stringify(registry.errors)})`);
  assert.ok(provider.manifest.match.files.includes("project.godot"));
  for (const file of ["SKILL.md", "handler.js", "lib/tscn.js", "addon/ares_bridge/plugin.gd", "addon/ares_bridge/ares_runtime.gd", "references/movement.md"]) {
    assert.ok(await fs.stat(path.join(skillsDir, "godot", file)).then(() => true, () => false), `${file} installed`);
  }
});

test("tscn parser round-trips, summarizes, and edits scenes safely", () => {
  const doc = tscn.parseTscn(SCENE);
  assert.equal(doc.nodes.length, 5);
  assert.equal(tscn.serializeTscn(doc), SCENE, "untouched scene serializes byte-identical");
  const summary = tscn.summarizeTscn(doc);
  assert.equal(summary.tree.name, "Main");
  assert.equal(summary.tree.children[0].path, "Player");
  assert.equal(summary.tree.children[0].script, "res://player.gd");
  assert.equal(summary.tree.children[0].children[1].path, "Player/Camera3D");
  assert.deepEqual(summary.connections, [{ signal: "pressed", from: "Button", to: ".", method: "_on_button_pressed" }]);

  const added = tscn.addNode(doc, { parent: "Player", type: "MeshInstance3D", name: "Mesh", props: { mesh: "res://assets/generated/box.obj", visible: true, position: "Vector3(0, 0.5, 0)" } });
  assert.equal(added.path, "Player/Mesh");
  const instanced = tscn.addNode(doc, { parent: ".", type: "res://enemy.tscn", name: "Enemy", props: { position: "Vector3(3, 0, 0)" } });
  assert.equal(instanced.path, "Enemy");
  tscn.connectSignal(doc, { from: "Player", signal: "hit", to: ".", method: "_on_player_hit" });
  tscn.setProps(doc, tscn.findNode(doc, "Player"), { speed: 7.5, position: "Vector3(0, 2, 0)" });
  const out = tscn.serializeTscn(doc);
  assert.match(out, /^\[gd_scene load_steps=5 format=3 uid="uid:\/\/abc123"\]/, "load_steps recomputed for 3 ext + 1 sub");
  assert.match(out, /\[ext_resource type="ArrayMesh" path="res:\/\/assets\/generated\/box\.obj" id="2_\w+"\]/);
  assert.match(out, /\[ext_resource type="PackedScene" path="res:\/\/enemy\.tscn" id="3_\w+"\]/);
  assert.match(out, /\[node name="Mesh" type="MeshInstance3D" parent="Player"\]\nmesh = ExtResource\("2_\w+"\)\nvisible = true\nposition = Vector3\(0, 0\.5, 0\)/);
  assert.match(out, /\[node name="Enemy" parent="\." instance=ExtResource\("3_\w+"\)\]/);
  assert.match(out, /\[connection signal="hit" from="Player" to="\." method="_on_player_hit"\]/);
  assert.match(out, /position = Vector3\(0, 2, 0\)\nspeed = 7\.5/);
  const meshIndex = out.indexOf('name="Mesh"'), cameraIndex = out.indexOf('name="Camera3D"'), buttonIndex = out.indexOf('name="Button"');
  assert.ok(meshIndex > cameraIndex && meshIndex < buttonIndex, "new child inserted after the parent's last descendant");

  const reparsed = tscn.parseTscn(out);
  assert.equal(tscn.removeNode(reparsed, "Player"), 4, "removing Player drops its 3 children too");
  assert.equal(reparsed.connections.length, 1, "connections touching the removed subtree are dropped");
  assert.equal(tscn.renameNode(reparsed, "Button", "StartButton"), "StartButton");
  assert.equal(reparsed.connections[0].attrs.from, "StartButton");
  assert.deepEqual(tscn.parseVariant("Vector3(1, -2.5, 3)"), { type: "Vector3", values: [1, -2.5, 3] });
});

test("mesh generators produce closed OBJ geometry", () => {
  assert.equal(mesh.box().triangleCount, 12);
  assert.equal(mesh.cylinder({ segments: 8 }).triangleCount, 8 * 4);
  assert.equal(mesh.extrude({ polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], height: 1 }).triangleCount, 2 + 2 + 8);
  const concave = mesh.triangulate([[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]]);
  assert.equal(concave.length, 3, "ear clipping handles a concave pentagon");
  const terrain = mesh.terrain({ subdiv: 8, w: 8, d: 8, height: 2, seed: 7 });
  assert.equal(terrain.triangleCount, 8 * 8 * 2);
  const b = terrain.bounds();
  assert.ok(b.size[1] > 0 && b.size[1] <= 4, `terrain has relief within height bounds (${b.size[1]})`);
  const stairs = mesh.stairs({ steps: 4 });
  assert.equal(stairs.triangleCount, 4 * 12);
  const obj = mesh.toObj(mesh.box(), { name: "crate-col" });
  assert.match(obj, /^o crate-col$/m);
  assert.equal((obj.match(/^f /gm) ?? []).length, 12);
  assert.equal((obj.match(/^v /gm) ?? []).length, 8, "shared positions are interned");
  assert.match(mesh.terrainGdscript({ height: 3 }), /@tool\nextends MeshInstance3D[\s\S]*FastNoiseLite/);
});

test("net helpers: html→text, timed text, youtube ids, doc sections", () => {
  const text = net.htmlToText('<html><body><nav>skip</nav><main><h2>Methods</h2><p>void <code>move_and_slide</code>()<br>Moves &amp; slides.</p></main></body></html>');
  assert.match(text, /## Methods/);
  assert.match(text, /`move_and_slide`\(\)\nMoves & slides\./);
  assert.doesNotMatch(text, /skip/);
  const cues = net.parseTimedText('<transcript><text start="0.5" dur="2">hello &amp;amp; welcome</text><text start="40" dur="3">second chunk</text></transcript>');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "hello & welcome");
  assert.equal(net.transcriptToText(cues), "[0:00] hello & welcome\n[0:40] second chunk");
  assert.equal(net.youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s"), "dQw4w9WgXcQ");
  assert.equal(net.youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(net.youtubeId("nope"), null);
  const section = net.sectionOf("# CharacterBody3D\nintro\n## Methods\nbool move_and_slide()\nMoves the body.\n## Signals\n", "move_and_slide", { before: 0, after: 40 });
  assert.match(section, /^bool move_and_slide\(\)/);
});

test("engine self-provisioning resolves official release assets per platform", () => {
  const win = godot.releaseAsset("4.3", { platform: "win32" });
  assert.equal(win.asset, "Godot_v4.3-stable_win64.exe.zip");
  assert.equal(win.url, "https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_win64.exe.zip");
  assert.ok(win.exeHint.test("Godot_v4.3-stable_win64.exe"));
  assert.equal(godot.releaseAsset("v4.7.1-stable", { platform: "win32", mono: true }).asset, "Godot_v4.7.1-stable_mono_win64.zip");
  assert.equal(godot.releaseAsset("4.3", { platform: "darwin" }).asset, "Godot_v4.3-stable_macos.universal.zip");
  assert.equal(godot.releaseAsset("4.3", { platform: "linux", arch: "arm64" }).asset, "Godot_v4.3-stable_linux.arm64.zip");
  assert.equal(godot.releaseAsset("4.3", { platform: "linux", arch: "x64" }).asset, "Godot_v4.3-stable_linux.x86_64.zip");
  assert.match(godot.engineDir("C:\\home", "4.3-stable").replace(/\\/g, "/"), /C:\/home\/godot\/engine\/4\.3-stable$/);
});

test("project.godot parsing and output classification", () => {
  const project = godot.parseGodotIni(PROJECT);
  assert.equal(project.application["config/name"], '"Fixture"');
  const diag = godot.classifyOutput([
    "Godot Engine v4.3.stable.official",
    "SCRIPT ERROR: Parse Error: Identifier \"speedd\" not declared in the current scope.",
    "   at: GDScript::reload (res://player.gd:12)",
    "WARNING: The property is deprecated",
    "ERROR: Failed to load resource: res://missing.png",
    "SCRIPT ERROR: Parse Error: Identifier \"speedd\" not declared in the current scope.",
    "   at: GDScript::reload (res://player.gd:12)",
  ].join("\n"));
  assert.equal(diag.errors.length, 2, "duplicate errors collapse");
  assert.equal(diag.errors[0].file, "res://player.gd");
  assert.equal(diag.errors[0].line, 12);
  assert.equal(diag.warnings.length, 1);
  assert.equal(handler.keyCode("space"), 32);
  assert.equal(handler.keyCode("W"), 87);
  assert.equal(handler.keyCode("Escape"), 4194305);
  assert.equal(handler.keyName(4194319), "LEFT");
  assert.equal(handler.compare("3.5", ">", 3), true);
  assert.equal(handler.readProp({ velocity: "Vector3(1, -2, 3)" }, "velocity.y"), -2);
  assert.equal(handler.readProp({ is_on_floor: true }, "is_on_floor"), true);
});

test("provider runs offline through the contract runtime: health, inspect, mutate, asset", async (t) => {
  const home = await tempDir("ares-godot-run-home-");
  const project = await fixtureProject();
  t.after(() => Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(project, { recursive: true, force: true })]));
  await installBundledSkills(path.join(home, "skills"));
  const invoke = (operation, input) => runSkill({ home, name: "godot", operation, input, targetRoot: project, workspace: project, timeoutMs: 60_000 });

  const health = await invoke("health", { verify: false });
  assert.equal(health.ok, true, health.error);
  assert.equal(health.receipt.providerId, "ares/godot");
  assert.equal(health.result.project.name, "Fixture");
  assert.equal(health.result.mode, "offline");
  assert.equal(health.result.bridge.addonInstalled, false);

  const tree = await invoke("inspect", { what: "tree" });
  assert.equal(tree.ok, true, tree.error);
  assert.equal(tree.result.source, "file");
  assert.equal(tree.result.tree.children[0].path, "Player");

  const inputmap = await invoke("mutate", { ops: [{ op: "input.add", action: "jump", keys: ["SPACE"], joy_buttons: [0] }, { op: "input.add", action: "move_left", keys: ["A", "LEFT"] }] });
  assert.equal(inputmap.ok, true, inputmap.error);
  const projectText = await fs.readFile(path.join(project, "project.godot"), "utf8");
  assert.match(projectText, /\[input\]\n\njump=\{\n"deadzone": 0\.5,\n"events": \[Object\(InputEventKey,[^\n]*"physical_keycode":32[^\n]*\), Object\(InputEventJoypadButton,[^\n]*"button_index":0[^\n]*\)\]\n\}/);
  assert.match(projectText, /move_left=\{[\s\S]*"physical_keycode":65[\s\S]*"physical_keycode":4194319/);
  const actions = await invoke("inspect", { what: "inputmap" });
  assert.deepEqual(actions.result.actions.move_left, ["A", "LEFT"]);

  const mutate = await invoke("mutate", {
    scene: "res://main.tscn",
    ops: [
      { op: "node.add", parent: "Player", type: "MeshInstance3D", name: "Mesh", props: { position: "Vector3(0, 0.9, 0)" } },
      { op: "script.create", path: "res://scripts/hud.gd", content: "extends CanvasLayer\n\nfunc _on_player_hit(amount: int) -> void:\n\tprint(amount)\n" },
      { op: "node.add", parent: ".", type: "CanvasLayer", name: "HUD", script: "res://scripts/hud.gd" },
      { op: "signal.connect", from: "Player", signal: "hit", to: "HUD", method: "_on_player_hit" },
      { op: "node.set", path: "Player", props: { floor_max_angle: 0.8 } },
    ],
  });
  assert.equal(mutate.ok, true, mutate.error);
  assert.equal(mutate.touchedFiles.length, 2, "scene + new script reported as mutations");
  assert.ok(mutate.touchedFiles.every((f) => f.startsWith(project)), "mutations stay within the project");
  const sceneText = await fs.readFile(path.join(project, "main.tscn"), "utf8");
  assert.match(sceneText, /\[node name="HUD" type="CanvasLayer" parent="\."\]\nscript = ExtResource\("2_\w+"\)/);
  assert.match(sceneText, /\[connection signal="hit" from="Player" to="HUD" method="_on_player_hit"\]/);
  assert.match(sceneText, /floor_max_angle = 0\.8/);
  const node = await invoke("inspect", { what: "node", scene: "res://main.tscn", path: "Player/Mesh" });
  assert.equal(node.result.props.position, "Vector3(0, 0.9, 0)");

  const asset = await invoke("asset", { kind: "stairs", name: "Stairs", params: { steps: 3, w: 2, h: 1.5, d: 3 }, collision: "trimesh", material: { color: [0.6, 0.4, 0.2] } });
  assert.equal(asset.ok, true, asset.error);
  assert.equal(asset.result.triangles, 36);
  assert.equal(asset.result.objectName, "stairs-col");
  assert.deepEqual(asset.result.files.sort(), ["res://assets/generated/stairs.mtl", "res://assets/generated/stairs.obj"]);
  assert.equal(asset.touchedFiles.length, 2);
  const obj = await fs.readFile(path.join(project, "assets", "generated", "stairs.obj"), "utf8");
  assert.match(obj, /^mtllib stairs\.mtl$/m);

  const bad = await invoke("mutate", { scene: "res://main.tscn", ops: [{ op: "node.add", parent: "Nope", type: "Node3D" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /parent node not found: Nope/);

  const run = await invoke("run", { steps: ["wait 10"] });
  assert.equal(run.ok, false, "run refuses without the bridge addon instead of pretending");
  assert.match(run.error, /ares godot init|Godot executable not found/);
});

test("ares godot init installs the addon, enables the plugin and writes config", async (t) => {
  const home = await tempDir("ares-godot-cli-home-");
  const project = await fixtureProject();
  t.after(() => Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(project, { recursive: true, force: true })]));
  const previous = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const { godotCommand } = await import("../packages/cli/dist/entry/godotCmd.js");
    const code = await godotCommand({ command: "godot", positionals: ["init", project], flags: new Map([["port", "6600"]]) });
    assert.equal(code, 0);
  } finally {
    console.log = origLog;
    process.env.ARES_HOME = previous;
  }
  assert.ok(await fs.stat(path.join(project, "addons", "ares_bridge", "plugin.gd")).then(() => true, () => false));
  assert.ok(await fs.stat(path.join(project, "addons", "ares_bridge", "ares_runtime.gd")).then(() => true, () => false));
  const projectText = await fs.readFile(path.join(project, "project.godot"), "utf8");
  assert.match(projectText, /\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/ares_bridge\/plugin\.cfg"\)/);
  const cfg = JSON.parse(await fs.readFile(path.join(project, ".ares", "godot.json"), "utf8"));
  assert.equal(cfg.bridgePort, 6600);
  assert.equal(cfg.runtimePort, 6601);
  assert.match(await fs.readFile(path.join(project, ".gitignore"), "utf8"), /\.ares\/godot\//);
  const parsed = await godot.readProject(project);
  assert.equal(parsed.aresBridgeEnabled, true);
  assert.ok(logs.some((l) => l.includes("addon")), "init reports what it did");
});
