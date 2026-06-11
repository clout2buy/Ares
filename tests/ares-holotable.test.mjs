// The Holotable — structural contract. The generated file must be a single
// self-contained HTML document with the hologram bones: three.js via import
// map, the procedural mech parts with assembly axes, an exploded-view slider,
// orbit controls, and the raycast HUD. It must also satisfy the gauntlet's
// holo-viewer probes (it is the reference solution).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "cli", "dist", "entry.js");

test("buildHolotableHtml: the hologram bones are all present", async () => {
  const { buildHolotableHtml } = await import("../packages/cli/dist/holotable.js");
  const html = buildHolotableHtml();

  // Self-contained document.
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  // three.js via import map, addons path for controls/loader.
  assert.match(html, /"three": "https:\/\/cdn\.jsdelivr\.net\/npm\/three@/);
  assert.match(html, /OrbitControls/);
  assert.match(html, /GLTFLoader/);
  // Exploded view: slider + state + per-part assembly axes.
  assert.match(html, /id="explode" type="range"/);
  assert.match(html, /exploded/);
  assert.match(html, /addScaledVector\(p\.axis/);
  // Hologram look: wireframe + additive glow, warroom bronze default.
  assert.match(html, /wireframe: true/);
  assert.match(html, /AdditiveBlending/);
  assert.match(html, /#c79a4e/);
  // The mech has real named parts and a raycast HUD.
  assert.match(html, /REACTOR CORE/);
  assert.match(html, /GAUNTLET/);
  assert.match(html, /Raycaster/);
  // No accidental template-literal leftovers from generation.
  assert.ok(!html.includes("${escapeHtml"), "no unrendered template fragments");
});

test("buildHolotableHtml: model mode embeds the URL; titles are escaped", async () => {
  const { buildHolotableHtml } = await import("../packages/cli/dist/holotable.js");
  const html = buildHolotableHtml({ modelUrl: "robot.glb", title: '<script>alert("x")</script>' });
  assert.match(html, /const MODEL_URL = "robot\.glb"/);
  assert.ok(!html.includes('<script>alert'), "title is HTML-escaped");
});

test("ares holo writes a file that passes the gauntlet's holo-viewer probes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-holo-"));
  const out = path.join(dir, "holo.html");
  const run = spawnSync(process.execPath, [entry, "holo", "--out", out], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ARES_HOME: dir, ARES_AGENT_ENABLED: "0", NO_COLOR: "1" },
  });
  assert.equal(run.status, 0, run.stderr);

  const html = await readFile(out, "utf8");
  // The gauntlet's structural probes for the holo-viewer task:
  for (const marker of ["three", "exploded", "input", "wireframe"]) {
    assert.ok(html.includes(marker), `gauntlet probe marker missing: ${marker}`);
  }
  await rm(dir, { recursive: true, force: true });
});
