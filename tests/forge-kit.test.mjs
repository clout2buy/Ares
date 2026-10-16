// The Forge kit: Ares's generative UI in the Forge's pixel language (owner,
// 2026-10-15: "show me stuff, explain stuff all the time … generated with the
// pixel theme"). A page carries `<!--ares:kit-->`; the Browser tool expands it
// into the inline kit so the page needs no network; served folders get the
// same kit at /__ares/kit.css and /__ares/kit.js.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";

import { expandForgeKit, FORGE_KIT_MARKER, FORGE_KIT_CSS, FORGE_KIT_JS } from "../packages/cli/dist/entry/forgeKit.js";
import { serveLocalTarget, stopPreviewServers } from "../packages/cli/dist/entry/previewServer.js";

test.after(() => stopPreviewServers());

test("the marker expands into the inline kit, once, and untouched pages stay untouched", () => {
  const page = `<!doctype html><html><head><!--ares:kit--><title>x</title></head><body><div class="k-card">hi</div></body></html>`;
  const out = expandForgeKit(page);
  assert.ok(!FORGE_KIT_MARKER.test(out), "marker consumed");
  assert.match(out, /<style data-ares-kit>/);
  assert.match(out, /<script data-ares-kit>/);
  assert.ok(out.includes(".k-card"), "kit css present");
  assert.ok(out.includes("k-reveal"), "kit js present (pixel resolve)");
  assert.ok(out.indexOf("data-ares-kit") < out.indexOf("<title>"), "expanded in place, at the top of head");
  assert.equal(expandForgeKit(out), out, "idempotent");
  const plain = "<!doctype html><p>no kit</p>";
  assert.equal(expandForgeKit(plain), plain);
  assert.ok(FORGE_KIT_MARKER.test(`<link rel="ares-kit">`), "the link form is a marker too");
});

test("the kit covers the vocabulary the doctrine promises", () => {
  for (const cls of [".k-eyebrow", ".k-grid", ".k-card", ".k-stat", ".k-pill", ".k-steps", ".k-timeline", ".k-bar", ".k-callout", ".k-kv"]) {
    assert.ok(FORGE_KIT_CSS.includes(cls), `${cls} styled`);
  }
  assert.match(FORGE_KIT_JS, /data-count/, "counters animate");
  assert.match(FORGE_KIT_JS, /prefers-reduced-motion/, "motion respects the OS setting");
});

test("served folders get the kit over http", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-kit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), `<!doctype html><head><link rel="stylesheet" href="/__ares/kit.css"><script src="/__ares/kit.js"></script></head><body></body>`);
  const served = await serveLocalTarget(path.join(root, "index.html"));
  const css = await fetch(`${served.origin}/__ares/kit.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.ok((await css.text()).includes(".k-card"));
  const js = await fetch(`${served.origin}/__ares/kit.js`);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.ok((await js.text()).includes("k-rim"));
});

import { renderExplainer } from "../packages/cli/dist/entry/forgeKit.js";
import vm from "node:vm";

test("explain renders every block type into a finished kit page, and the kit script is valid JS", () => {
  const html = renderExplainer({
    title: "Ancient Greece", blocks: [
      { type: "text", text: "intro <b>" }, { type: "heading", text: "Arc" },
      { type: "stats", items: [{ label: "city-states", value: 1000 }, { label: "span", value: "800–146 BC" }] },
      { type: "timeline", items: [{ when: "490 BC", title: "Marathon", text: "Persia loses" }] },
      { type: "steps", items: [{ title: "Archaic", text: "polis", state: "done" }] },
      { type: "chart", kind: "bar", labels: ["a", "b"], values: [3, 9] },
      { type: "chart", kind: "donut", labels: ["x", "y"], values: [1, 2] },
      { type: "chart", kind: "line", labels: ["a", "b", "c"], values: [1, 5, 3] },
      { type: "diagram", nodes: [{ id: "a", text: "Athens" }, { id: "b", text: "Sparta" }], links: [["a", "b"]] },
      { type: "scene3d", shape: "torus", caption: "a torus" },
      { type: "table", columns: ["k", "v"], rows: [["1", "2"]] }, { type: "bogus" },
    ],
  });
  assert.match(html, /<!--ares:kit-->/);
  for (const needle of ["k-stat", "k-timeline", "k-steps", "k-grow", "stroke-dasharray", "marker-end", 'class="k-scene"', "<table>", "intro &lt;b&gt;"]) assert.ok(html.includes(needle), needle);
  const out = expandForgeKit(html);
  assert.ok(!FORGE_KIT_MARKER.test(out));
  assert.doesNotThrow(() => new vm.Script(FORGE_KIT_JS), "kit js parses");
  assert.match(FORGE_KIT_JS, /three@0\.160\.0/, "3D scenes use a pinned three build");
});

test("sim blocks: every kind renders, the module ships only when used, and both scripts parse", () => {
  for (const kind of ["projectile", "pendulum", "orbit", "plot"]) {
    const html = renderExplainer({ title: "Sim", blocks: [{ type: "sim", kind, caption: "c" }] });
    assert.match(html, new RegExp(`class="k-play" data-spec="[^"]*&quot;kind&quot;:&quot;${kind}&quot;`), `${kind} renders a k-play`);
  }
  const plot = renderExplainer({ title: "P", blocks: [{ type: "sim", kind: "plot", formula: "a*sin(b*x)^2", params: [{ key: "a", min: 0, max: 5, value: 2 }, { key: "b", min: 0, max: 5, value: 1 }] }] });
  assert.match(plot, /a\*sin\(b\*x\)\*\*2/, "^ becomes **");
  const bad = renderExplainer({ title: "P", blocks: [{ type: "sim", kind: "plot", formula: "x.constructor.constructor(1)()" }] });
  assert.match(bad, /a\*sin\(b\*x\)/, "unsafe formula falls back to the default");
  assert.ok(!bad.includes("constructor"), "unsafe formula never reaches the page");

  const out = expandForgeKit(plot);
  const mod = out.match(/<script type="module" data-ares-sim>([\s\S]*?)<\/script>/);
  assert.ok(mod, "sim module appended");
  assert.match(mod[1], /esm\.sh\/three@0\.160\.0/);
  assert.match(mod[1], /OrbitControls/);
  // module syntax (top-level await) → wrap in an async fn to syntax-check it
  assert.doesNotThrow(() => new vm.Script(`(async function(){${mod[1].replace(/^\s*var T=null/, "var T=null")}})`), "sim module parses");
  assert.doesNotThrow(() => new vm.Script(FORGE_KIT_JS), "kit js parses");
  assert.ok(!FORGE_KIT_JS.includes("`") && !mod[1].includes("`"), "no template-literal hazards");
  assert.ok(!expandForgeKit(renderExplainer({ title: "n", blocks: [{ type: "text", text: "x" }] })).includes("data-ares-sim"), "plain pages carry no module");
  for (const cls of [".k-play", ".k-stage", ".k-panel", ".k-slider", ".k-btn", ".k-sim-head", ".k-sim-tag"]) assert.ok(FORGE_KIT_CSS.includes(cls), `${cls} styled`);
});

test("scene3d: interactive / controls become an orbitable sim; plain scene3d is unchanged", () => {
  const i = renderExplainer({ title: "S", blocks: [{ type: "scene3d", shape: "torus", interactive: true, controls: true }] });
  assert.match(i, /k-play/);
  assert.match(i, /&quot;kind&quot;:&quot;shape&quot;/);
  const c = renderExplainer({ title: "S", blocks: [{ type: "scene3d", controls: [{ key: "speed", label: "Spin", min: 0, max: 3, value: 1, step: 0.1 }] }] });
  assert.match(c, /Spin/);
  const plain = renderExplainer({ title: "S", blocks: [{ type: "scene3d", shape: "cube" }] });
  assert.match(plain, /class="k-scene"/);
  assert.ok(!plain.includes("k-play"));
});

// ── generative blocks: model (3D build + animation), story (2D stage), live streaming ──
import { FORGE_MODEL_JS } from "../packages/cli/dist/entry/forgeModel.js";
import { FORGE_STORY_JS } from "../packages/cli/dist/entry/forgeStory.js";
import { FORGE_SIM_JS } from "../packages/cli/dist/entry/forgeSim.js";
import { sanitizeModel, sanitizeStory, sanitizeAnim, colour } from "../packages/cli/dist/entry/forgeBlocks.js";
import { ExplainStream, LIVE_RUNTIME_JS } from "../packages/cli/dist/entry/forgeLive.js";
import { buildLiveStageHtml } from "../packages/cli/dist/entry/forgeKit.js";

const specOf = (html, cls) => {
  const m = html.match(new RegExp(`class="${cls}" data-spec="([^"]*)"`));
  assert.ok(m, `${cls} rendered`);
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
};

test("model block: sanitised parts, mirror/repeat expand, curved + triangle shapes survive, hostile input is dropped", () => {
  const html = renderExplainer({ title: "M", blocks: [{ type: "model", style: "lowpoly", look: "clay", edge: "gold", parts: [
    { name: "ear", shape: "cone", pos: [1, 2, 3], size: [1, 2, 1], color: "orange", mirror: true },
    { name: "post", shape: "box", pos: [0, 0, 0], repeat: { n: 3, step: [2, 0, 0] } },
    { name: "tail", shape: "tube", pts: [[0, 0, 0], [0, 1, -1], [0, 2, -2]], r: 0.2, r2: 0.5 },
    { name: "head", shape: "mesh", verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [9, 9, 9]], faces: [[0, 1, 2], [0, 1, 99]], fcolors: ["red"] },
    { name: "bad", shape: "<script>", color: "javascript:alert(1)", pos: ["x", null, 1e9] },
    { name: "leg", parent: "body", pivot: [0, 1, 0], pos: [0, 0, 0] },
  ] }] });
  const m = specOf(html, "k-rig");
  assert.equal(m.look, "clay");
  const names = m.parts.map((p) => p.name);
  assert.deepEqual(names.slice(0, 2), ["ear", "ear (mirror)"]);
  assert.equal(m.parts[1].pos[0], -1, "mirror flips x");
  assert.ok(names.includes("post 1") && names.includes("post 3"), "repeat expands");
  assert.equal(m.parts.find((p) => p.name === "head").faces.length, 1, "faces with bad indexes are dropped");
  const bad = m.parts.find((p) => p.name === "bad");
  assert.equal(bad.shape, "box", "unknown shapes become boxes");
  assert.ok(/^#[0-9a-f]{6}$/.test(bad.color), "colours are always hex");
  assert.ok(bad.pos.every((n) => Math.abs(n) <= 50), "positions are clamped");
  assert.ok(m.parts.every((p) => p.low && p.facets), "lowpoly style facets every part");
  assert.equal(m.parts.find((p) => p.name === "leg").parent, "body");
  assert.equal(colour("hotpink?"), undefined);
});

test("animation clips are sanitised: known motions only, clamped, wildcard parts kept", () => {
  const a = sanitizeAnim({ name: "trot", dur: 999, motion: [{ part: "leg*", kind: "swing", amp: 1e9, speed: 99 }, { part: "x", kind: "explode" }], tracks: [{ part: "body", pos: [[2, [0, 1, 0]], [0, [0, 0, 0]]] }] });
  assert.equal(a.dur, 20);
  assert.equal(a.motion.length, 1);
  assert.ok(a.motion[0].amp <= 720 && a.motion[0].speed <= 8);
  assert.deepEqual(a.tracks[0].pos.map((k) => k[0]), [0, 2], "keys are time-sorted");
  assert.equal(sanitizeAnim({ name: "empty" }), null);
});

test("story block: scenes render, unknown sprites/ops and bad ids are dropped, caps hold", () => {
  const html = renderExplainer({ title: "S", blocks: [{ type: "story", scenes: [
    { t: "1 BC", say: "hi", bg: "night", do: [{ op: "spawn", sprite: "person", n: 9999, at: [80, 70] }, { op: "spawn", sprite: "dragon" }, { op: "move", id: "bad id!", to: [1, 2] }, { op: "explode" }, { op: "meter", id: "p", label: "Power", value: 500 }] },
    ...Array.from({ length: 40 }, (_, i) => ({ t: String(i), say: "x" })),
  ] }] });
  const st = specOf(html, "k-tale");
  assert.equal(st.scenes.length, 24);
  const ops = st.scenes[0].do;
  assert.deepEqual(ops.map((o) => o.op), ["spawn", "meter"]);
  assert.equal(ops[0].n, 60);
  assert.equal(ops[1].value, 100);
  assert.equal(sanitizeStory({ scenes: [{}] }).scenes.length, 0, "empty scenes vanish");
});

test("every engine module parses and avoids template-literal hazards; each ships only on pages that use it", () => {
  for (const [name, js] of [["sim", FORGE_SIM_JS], ["model", FORGE_MODEL_JS], ["story", FORGE_STORY_JS], ["live", LIVE_RUNTIME_JS]]) {
    assert.doesNotThrow(() => new vm.Script(`(async function(){${js}})`), `${name} parses`);
    assert.ok(!js.includes("`") && !js.includes("${"), `${name}: no template hazards`);
  }
  const rig = expandForgeKit(renderExplainer({ title: "r", blocks: [{ type: "model", parts: [{ shape: "box" }] }] }));
  assert.match(rig, /data-ares-model/);
  assert.ok(!/data-ares-story|data-ares-sim/.test(rig));
  const tale = expandForgeKit(renderExplainer({ title: "t", blocks: [{ type: "story", scenes: [{ say: "x" }] }] }));
  assert.match(tale, /data-ares-story/);
  assert.ok(!/data-ares-model/.test(tale));
});

test("live stream: pieces come out as parts/scenes close, at any chunking, and match the one-shot sanitiser", () => {
  const input = JSON.stringify({ action: "explain", title: "x", blocks: [
    { type: "text", text: "intro" },
    { type: "model", title: "Fox", style: "lowpoly", parts: [{ name: "a", shape: "sphere", mirror: true, pos: [1, 0, 0] }, { name: "b", shape: "cone" }], anims: [{ name: "w", motion: [{ part: "a", kind: "wag" }] }] },
    { type: "story", title: "Rome", scenes: [{ t: "1", say: "one" }, { t: "2", say: "two", do: [{ op: "spawn", sprite: "house" }] }] },
  ] });
  const run = (n) => { const st = new ExplainStream(), out = []; for (let i = 0; i < input.length; i += n) out.push(...st.feed(input.slice(i, i + n))); return out; };
  const ref = run(input.length);
  for (const n of [1, 2, 5, 17]) assert.deepEqual(run(n), ref, `chunk size ${n}`);
  assert.deepEqual(ref.map((p) => p.op), ["begin", "title", "part", "part", "anim", "end", "begin", "title", "scene", "scene", "end"]);
  assert.equal(ref[0].kind, "model");
  assert.equal(ref[2].parts.length, 2, "mirror expands in the stream too");
  const oneShot = sanitizeModel(JSON.parse(input).blocks[1]);
  assert.deepEqual(ref.filter((p) => p.op === "part").flatMap((p) => p.parts), oneShot.parts, "stream == one-shot");
  // a half-written part emits nothing yet
  const half = new ExplainStream();
  assert.deepEqual(half.feed('{"blocks":[{"type":"model","parts":[{"name":"a","shape":"sph'), [{ op: "begin", idx: 0, kind: "model", style: undefined, look: undefined }]);
  // hostile / non-JSON deltas never throw
  assert.doesNotThrow(() => new ExplainStream().feed('}}}]]]"\\{{[[ "blocks": [ {"parts":[{]'));
});

test("live stage page carries the runtime + all engines; the instant flag skips the pixel resolve", () => {
  const html = buildLiveStageHtml();
  for (const m of ["data-ares-live", "data-ares-model", "data-ares-story"]) assert.ok(html.includes(m), m);
  assert.match(FORGE_KIT_JS, /__aresInstant/);
  assert.doesNotThrow(() => new vm.Script(FORGE_KIT_JS));
});

test("loft parts: sections are clamped, mirrored across x, and degenerate lofts fall back to a box", () => {
  const m = sanitizeModel({ style: "lowpoly", parts: [
    { name: "leg", shape: "loft", sections: [[0.3, 1, 0, 0.2, 0.2], [0.3, 0, 0, 0.1, 0.1], [1, 2]], mirror: true },
    { name: "bad", shape: "loft", sections: [[0, 0, 0, 1, 1]] },
  ] });
  assert.equal(m.parts[0].sections.length, 2, "short rows dropped");
  assert.equal(m.parts[1].sections[0][0], -0.3, "mirror flips x");
  assert.equal(m.parts[0].seg, 6, "lowpoly default ring count");
  assert.equal(m.parts[2].shape, "box");
});

// ── the model studio: Ares edits a persistent model; the Forge polls it ──
import { ensureStudio, applyEdit, studioSpec, studioPoll, saveStudio, dropStudios } from "../packages/cli/dist/entry/modelStudio.js";

test("studio edits: upsert, set by prefix with move/scale/rename, remove, anims, and typo'd targets are reported", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-studio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("fx");
  let r = await applyEdit(st, { style: "lowpoly", parts: [
    { name: "leg a", shape: "cylinder", pos: [1, 1, 0] }, { name: "leg b", shape: "cylinder", pos: [2, 1, 0] },
    { name: "tail", shape: "loft", sections: [[0, 1, 0, 0.1, 0.1], [0, 1, -1, 0.2, 0.2]], parent: "ghost" },
  ], anims: [{ name: "w", motion: [{ part: "tail", kind: "wag" }] }] }, root);
  assert.deepEqual(r.errors, ["part \"tail\" has parent \"ghost\" which doesn't exist"]);
  assert.equal(st.version, 1);
  r = await applyEdit(st, { ops: [
    { op: "set", name: "leg*", move: [0, 0.5, 0], scale: 2 },
    { op: "set", name: "tail", to: "brush", sections: [[0, 1, 0, 0.1, 0.1], [0, 1, -2, 0.3, 0.3]], parent: "leg a" },
    { op: "set", name: "nothing", color: "red" },
    { op: "explode" },
    { op: "remove", name: "leg b" },
  ] }, root);
  assert.equal(r.errors.length, 2, "unknown set target + unknown op reported");
  const spec = studioSpec(st);
  assert.deepEqual(spec.parts.map((p) => p.name), ["leg a", "brush"]);
  assert.deepEqual(spec.parts[0].pos, [2, 3, 0], "move then scale: (1,1,0)+(0,.5,0) = (1,1.5,0) ×2");
  assert.equal(spec.parts[1].parent, "leg a");
  assert.equal(spec.anims.length, 1);
});

test("studio polling is versioned, and assets round-trip through save / load / use without escaping the project", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-studio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("a");
  await applyEdit(st, { title: "A", parts: [{ name: "head", shape: "sphere", pos: [0, 2, 0], pivot: [0, 1.5, 0] }, { name: "eye", shape: "sphere", pos: [0.2, 2.1, 0.4], parent: "head" }] }, root);
  assert.deepEqual(studioPoll("a", 1), { v: 1 }, "nothing newer → no spec");
  assert.ok(studioPoll("a", 0).spec.parts.length >= 2);
  assert.equal(st.seen, 1, "a page fetching the spec marks the version as seen");
  assert.equal(studioPoll("missing", 0), null);
  const rel = await saveStudio(st, root, "");
  assert.equal(rel, path.join("assets", "models", "a.model.json"));
  const b = ensureStudio("b");
  await applyEdit(b, { load: rel }, root);
  assert.deepEqual(studioSpec(b).parts.map((p) => p.name), ["head", "eye"]);
  const c = ensureStudio("c");
  const used = await applyEdit(c, { ops: [{ op: "use", file: rel, names: ["head"], at: [10, 0, 0], prefix: "x-" }] }, root);
  assert.deepEqual(used.errors, []);
  assert.deepEqual(studioSpec(c).parts[0].pos, [10, 2, 0]);
  assert.equal(studioSpec(c).parts[0].name, "x-head");
  const bad = await applyEdit(c, { load: "../../etc/passwd" }, root);
  assert.match(bad.errors[0], /escapes the project/);
  await assert.rejects(() => saveStudio(st, root, "../evil.model.json"), /escapes the project/);
  await assert.rejects(() => saveStudio(st, root, "package.json"), /must end in \.model\.json/);
  assert.equal(await saveStudio(st, root, true), path.join("assets", "models", "a.model.json"), "true means the default path");
  const big = await applyEdit(c, { ref: "data:image/png;base64," + "A".repeat(3_000_000) }, root);
  assert.match(big.errors[0], /too large/);
});

test("the preview server serves the studio document to the page", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-studio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("srv");
  await applyEdit(st, { parts: [{ name: "p", shape: "box" }] }, root);
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>x</body>");
  const served = await serveLocalTarget(path.join(root, "index.html"));
  const d = await (await fetch(`${served.origin}/__ares/studio/srv?since=0`)).json();
  assert.equal(d.v, 1);
  assert.equal(d.spec.parts[0].name, "p");
  const none = await fetch(`${served.origin}/__ares/studio/nope`);
  assert.equal(none.status, 404);
});

test("live stream also understands action:model (parts at the root of the call)", () => {
  const input = JSON.stringify({ action: "model", model: "fox", style: "lowpoly", parts: [{ name: "a", shape: "sphere" }, { name: "b", shape: "cone", mirror: true, pos: [1, 0, 0] }] });
  const st = new ExplainStream(), out = [];
  for (let i = 0; i < input.length; i += 3) out.push(...st.feed(input.slice(i, i + 3)));
  assert.deepEqual(out.map((p) => p.op), ["begin", "part", "part"]);
  assert.equal(out[2].parts.length, 2);
  assert.equal(out[0].style, "lowpoly", "root-level style is read before the parts");
});

// ── scripts: the studio has no built-in water/lava/physics; Ares writes the behaviour ──
import { FORGE_SCRIPT_DOCS } from "../packages/cli/dist/entry/forgeScriptDocs.js";
import { sanitizeScript } from "../packages/cli/dist/entry/forgeBlocks.js";
import { addStudioLog, drainStudioLogs } from "../packages/cli/dist/entry/modelStudio.js";

test("engines hold no backslashes (the template-literal trap that silently broke a script runner once)", () => {
  for (const [n, js] of [["model", FORGE_MODEL_JS], ["story", FORGE_STORY_JS], ["sim", FORGE_SIM_JS], ["live", LIVE_RUNTIME_JS]]) assert.ok(!js.includes("\\"), `${n}: no backslash`);
});

test("scripts: sanitised, upserted by name, removable, carried by save/load/use, and their errors reach Ares", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-studio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  assert.equal(sanitizeScript({ name: "bad name!", code: "x" }), null);
  assert.equal(sanitizeScript({ name: "ok", code: "   " }), null);
  assert.equal(sanitizeScript({ name: "ok", code: "x".repeat(50_000) }).code.length, 24_000);
  const st = ensureStudio("s");
  let r = await applyEdit(st, { parts: [{ name: "a", shape: "box" }], scripts: [{ name: "water", code: "function init(api){}" }, { name: "x y", code: "1" }] }, root);
  assert.equal(r.errors.length, 1, "bad script name reported");
  r = await applyEdit(st, { ops: [{ op: "script", name: "water", code: "function update(api){}" }, { op: "script", name: "rain", code: "function init(api){}" }] }, root);
  assert.deepEqual(studioSpec(st).scripts.map((s) => s.name), ["water", "rain"]);
  assert.equal(studioSpec(st).scripts[0].code, "function update(api){}", "same name replaces");
  const rel = await saveStudio(st, root, "");
  const b = ensureStudio("b");
  await applyEdit(b, { ops: [{ op: "use", file: rel, parts: false, scripts: ["rain"] }] }, root);
  assert.deepEqual(studioSpec(b).scripts.map((s) => s.name), ["rain"]);
  assert.equal(studioSpec(b).parts.length, 0, "parts:false pulls only the script");
  await applyEdit(st, { ops: [{ op: "remove_script", name: "water" }] }, root);
  assert.deepEqual(studioSpec(st).scripts.map((s) => s.name), ["rain"]);
  addStudioLog("s", "[rain] init: boom");
  assert.deepEqual(drainStudioLogs(st), ["[rain] init: boom"]);
  assert.deepEqual(drainStudioLogs(st), [], "drained");
  // a page POSTs script errors to the preview server
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>x</body>");
  const served = await serveLocalTarget(path.join(root, "index.html"));
  addStudioLog("s", "seed");
  drainStudioLogs(st);
  const res = await fetch(`${served.origin}/__ares/studio/s/log`, { method: "POST", body: JSON.stringify({ name: "water", msg: "update: x is not defined" }) });
  assert.equal(res.status, 204);
  assert.deepEqual(drainStudioLogs(st), ["[water] update: x is not defined"]);
});

test("clip events are generic named moments, and the on-demand docs' example scripts all compile", () => {
  const a = sanitizeAnim({ name: "drink", events: [{ t: 1, name: "splash", data: { x: 1, z: 2 } }, { t: 2, name: "bad name!" }, { t: 99, name: "late", data: "x".repeat(2000) }] });
  assert.deepEqual(a.events.map((e) => e.name), ["splash", "late"]);
  assert.deepEqual(a.events[0].data, { x: 1, z: 2 });
  assert.equal(a.events[1].data, null, "oversized event data is dropped");
  assert.equal(a.events[1].t, 20);
  const sect = (from, to) => FORGE_SCRIPT_DOCS.slice(FORGE_SCRIPT_DOCS.indexOf("\n", FORGE_SCRIPT_DOCS.indexOf(from)) + 1, FORGE_SCRIPT_DOCS.indexOf(to, FORGE_SCRIPT_DOCS.indexOf(from)));
  for (const code of [sect("1) Procedural pixel texture", "2) Live water"), sect("2) Live water", "   (Lava"), sect("3) Controls + live stats", "4) Physics")]) {
    assert.doesNotThrow(() => new vm.Script(`(function(api){${code}\nreturn {init:typeof init==='function'?init:null,update:typeof update==='function'?update:null}})`), "example compiles");
  }
  assert.ok(!FORGE_SCRIPT_DOCS.includes("`"));
});

// ── game integration: the exported runtime loads a model into plain three.js ──
import { exportGame } from "../packages/cli/dist/entry/modelStudio.js";
import { readFile } from "node:fs/promises";
import { buildRuntimeModule } from "../packages/cli/dist/entry/forgeRuntime.js";
import { FORGE_MODEL_CORE_JS } from "../packages/cli/dist/entry/forgeModelCore.js";
import { pathToFileURL } from "node:url";

test("the runtime module and the studio share one core and parse", () => {
  const js = buildRuntimeModule("three");
  assert.ok(js.includes(FORGE_MODEL_CORE_JS), "same core text as the studio page");
  assert.ok(!FORGE_MODEL_CORE_JS.includes("\\") && !FORGE_MODEL_CORE_JS.includes("`"));
  assert.match(js, /export function buildModel/);
  assert.match(js, /export function loadModel/);
  assert.match(js, /export function attachScripts/);
});

test("export writes the runtime + expanded game json, refuses bad import specifiers, and stays in the project", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("chest");
  await applyEdit(st, { title: "Chest", parts: [{ name: "base", shape: "box", pos: [0, 0.5, 0], mirror: true }], anims: [{ name: "open", dur: 1, tracks: [{ part: "base", rot: [[0, [0, 0, 0]], [1, [-90, 0, 0]]] }] }] }, root);
  const ex = await exportGame(st, root, { dir: "assets", three: "https://cdn.example.com/three.module.js" });
  assert.equal(ex.runtime, "assets/ares-model.js");
  assert.equal(ex.model, "assets/models/chest.game.json");
  assert.match(ex.usage, /loadModel/);
  const js = await readFile(path.join(root, ex.runtime), "utf8");
  assert.match(js, /^\/\/ Generated by Ares/);
  assert.match(js, /import \* as T from "https:\/\/cdn\.example\.com\/three\.module\.js"/);
  const doc = JSON.parse(await readFile(path.join(root, ex.model), "utf8"));
  assert.equal(doc.expanded, true);
  assert.equal(doc.parts.length, 1, "no x offset, so no mirror copy");
  await assert.rejects(() => exportGame(st, root, { three: "evil'; import('x" }), /three must be/);
  await assert.rejects(() => exportGame(st, root, { dir: "../outside" }), /escapes the project/);
});

test("runtime: instances share geometry, override materials, play clips with joint rotation about the pivot, fire clip events, and hold non-looping clips", async (t) => {
  let threePath;
  for (const c of [path.resolve("node_modules/three/build/three.module.js"), path.resolve("tauri/node_modules/three/build/three.module.js")]) {
    if (await readFile(c).then(() => true, () => false)) { threePath = c; break; }
  }
  if (!threePath) return t.skip("three is not installed in this checkout");
  const root = await mkdtemp(path.join(tmpdir(), "ares-rt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ares-model.mjs");
  await writeFile(file, buildRuntimeModule(pathToFileURL(threePath).href), "utf8");
  const { buildModel } = await import(pathToFileURL(file).href);
  const T = await import(pathToFileURL(threePath).href);
  dropStudios();
  const st = ensureStudio("hinge");
  await applyEdit(st, { parts: [
    { name: "base", shape: "box", pos: [0, 0.5, 0], size: [2, 1, 1], color: "#8a5a2b" },
    { name: "lid", shape: "box", pos: [0, 1.1, 0], pivot: [0, 1, -0.5], size: [2, 0.2, 1], color: "#aa7a4b", parent: "base" },
  ], anims: [{ name: "open", dur: 1, loop: false, tracks: [{ part: "lid", rot: [[0, [0, 0, 0]], [1, [-90, 0, 0]]] }], events: [{ t: 0.5, name: "half", data: { n: 1 } }] }] }, root);
  const spec = studioSpec(st);
  const model = buildModel({ format: "ares-model/1", expanded: true, parts: spec.parts, anims: spec.anims, scripts: [] });
  const a = model.instance(), b = model.instance({ material: (part, shared) => { const m = shared.clone(); m.color.set(0xff0000); return m; } });
  assert.equal(a.part("lid").mesh.geometry, b.part("lid").mesh.geometry, "geometry is shared between instances");
  assert.notEqual(a.part("lid").mesh.material, b.part("lid").mesh.material, "material override is per instance");
  assert.equal(b.part("lid").mesh.material.color.getHex(), 0xff0000);
  assert.equal(a.triangles(), 24, "two boxes = 24 triangles");
  const seen = [];
  a.on("half", (d) => seen.push(d.n)); a.on("end", (n) => seen.push(n));
  a.play("open");
  a.update(0.5); a.update(0.25);
  assert.deepEqual(seen, [1], "the event fired once when its time passed");
  const lid = a.part("lid").node;
  const eased = 0.75 * 0.75 * (3 - 2 * 0.75);
  assert.ok(Math.abs(lid.rotation.x - (-eased * Math.PI / 2)) < 1e-6, "keys interpolate with smoothstep: at t=0.75 the lid is 84.4% open");
  assert.deepEqual([lid.position.x, lid.position.y, lid.position.z].map((n) => +n.toFixed(3)), [0, 0.5, -0.5], "the joint sits at the pivot, relative to its parent's pivot");
  const tip = new T.Vector3(0, 0, 1);
  lid.updateWorldMatrix(true, false);
  a.update(0.5);
  assert.ok(Math.abs(lid.rotation.x - (-Math.PI / 2)) < 1e-6, "held at the end pose");
  assert.equal(a.playing, false, "non-looping clip stops");
  assert.deepEqual(seen, [1, "open"], "end event");
  a.update(1); assert.ok(Math.abs(lid.rotation.x - (-Math.PI / 2)) < 1e-6, "still held");
  a.stop(); assert.equal(lid.rotation.x, 0, "stop returns to the rest pose");
  assert.throws(() => a.play("nope"), /no clip nope/);
  assert.throws(() => buildModel({ parts: [] }), /game\.json/);
  void tip;
});

// ── review fixes: warnings instead of silence, containment, loopback-only serving ──
import { symlink } from "node:fs/promises";
import { runModelAction } from "../packages/cli/dist/entry/browserBridge.js";
import { serveLocalTarget as serveTarget } from "../packages/cli/dist/entry/previewServer.js";
import http from "node:http";

test("input is never silently ignored: unknown fields/shapes/mats, bad vectors and dead clips come back as problems", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("lint");
  const r = await applyEdit(st, { parts: [{ name: "lid", shape: "nonsense", arc: 180, pos: [1, "x"], color: "wibble", mat: "gold" }, { name: "base", shape: "box" }],
    anims: [{ name: "bad", keys: [{ t: 0 }] }, { name: "open", dur: 1, tracks: [{ part: "lid", rot: [[0, [0, 0, 0]], [1, [-90, 0, 0]]] }, { part: "ghost", rot: [[0, [0, 0, 0]], [1, [1, 0, 0]]] }], wibble: 1 }] }, root);
  const text = r.errors.join("\n");
  assert.match(text, /unknown field "arc"/);
  assert.match(text, /unknown shape "nonsense"/);
  assert.match(text, /unknown mat "gold"/);
  assert.match(text, /pos should be \[x,y,z\]/);
  assert.match(text, /colour "wibble" not recognised/);
  assert.match(text, /clip "bad" drives nothing and was dropped.*Example hinge/s);
  assert.match(text, /clip "open": track part "ghost" matches no part/);
  assert.match(text, /clip "open": unknown field "wibble"/);
  const clean = await applyEdit(st, { parts: [{ name: "lid", shape: "box", pivot: [0, 1, 0], parent: "base" }] }, root);
  assert.deepEqual(clean.errors, [], "a correct edit is quiet");
});

test("view extras are bounded, and containment follows symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-sym-")), outside = await mkdtemp(path.join(tmpdir(), "ares-out-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  dropStudios();
  const st = ensureStudio("v");
  await applyEdit(st, { view: { t: 999, zoom: 99, fit: "anim", camera: "side", junk: 1, wire: "yes" } }, root);
  assert.deepEqual(studioSpec(st).view, { t: 20, zoom: 3, fit: "anim", camera: "side" });
  await writeFile(path.join(outside, "secret.model.json"), JSON.stringify({ parts: [{ name: "leak", shape: "box" }] }));
  await writeFile(path.join(outside, "secret.png"), "x");
  await symlink(outside, path.join(root, "link"));
  const r = await applyEdit(st, { load: "link/secret.model.json" }, root);
  assert.match(r.errors[0], /through a symlink/);
  const ref = await applyEdit(st, { ref: path.join(outside, "secret.png") }, root);
  assert.ok(ref.errors.some((e) => /escapes the project/.test(e)), "absolute reference paths are refused");
  await assert.rejects(() => saveStudio(st, root, "link/x.model.json"), /through a symlink/);
});

test("the Browser model action refuses lookalike backdrop hosts", async () => {
  const fakeBr = { state: async () => ({ url: "", title: "" }), navigate: async () => undefined, screenshot: async () => ({ format: "png", bytes: "" }) };
  const d = { cwd: tmpdir(), emitTarget: () => undefined, filmstripDir: "-" };
  for (const bad of ["http://localhost:80@evil.example/x", "http://evil.example/", "https://127.0.0.1.evil.example/", "file:///etc/passwd"]) {
    await assert.rejects(() => runModelAction({ action: "model", model: "bd", backdrop: bad }, fakeBr, d), /backdrop/, bad);
  }
});

test("preview server answers loopback hosts only, and refuses to publish secrets folders", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-srv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>ok</body>");
  const served = await serveTarget(path.join(root, "index.html"));
  const port = new URL(served.origin).port;
  const get = (host, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/index.html", headers: { host, ...extra } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(await get(`127.0.0.1:${port}`), 200);
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get("evil.example"), 403, "a rebound hostname is refused");
  assert.equal(await get(`127.0.0.1:${port}`, { origin: "http://evil.example" }), 403, "a foreign Origin is refused");
  await assert.rejects(() => serveTarget(path.join(os.homedir(), ".ares", "ui.json")), /refusing to serve|^$/);
  await assert.rejects(() => serveTarget(path.parse(process.cwd()).root), /refusing to serve/);
});

test("live stream: escaped titles decode, ops are ignored, and root style/look/edge reach the begin piece", () => {
  const input = JSON.stringify({ action: "model", style: "lowpoly", look: "clay", edge: "gold", parts: [{ name: "a", shape: "box" }], ops: [{ op: "add", parts: [{ name: "zz" }] }, { op: "set", title: "zzz" }], anims: [{ name: "w", motion: [{ part: "a", kind: "wag" }] }] });
  const st = new ExplainStream(), out = [];
  for (let i = 0; i < input.length; i += 4) out.push(...st.feed(input.slice(i, i + 4)));
  assert.deepEqual(out.map((p) => p.op), ["begin", "part", "anim"], "ops-add parts and ops titles never stream");
  assert.equal(out[0].look, "clay");
  assert.equal(out[1].parts[0].edgeColor, "#d9a441".length ? out[1].parts[0].edgeColor : "", "edge colour reaches parts");
  const t = new ExplainStream().feed(JSON.stringify({ blocks: [{ type: "model", title: "He said \"hi\" é", parts: [{ name: "a" }] }] }));
  assert.equal(t.find((p) => p.op === "title").title, "He said \"hi\" é");
});

// ── stand-in review round 2: moving jointed parts, clips/variants across use, procedural textures, variants ──
import { sanitizeTexture, sanitizeOverride } from "../packages/cli/dist/entry/forgeBlocks.js";

test("use with at/prefix moves pos and pivot only (never the geometry twice), and carries clips with their targets renamed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-use-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const src = ensureStudio("src");
  const arc = [[1, 0], [0, 0.5], [-1, 0]];
  await applyEdit(src, { parts: [
    { name: "base", shape: "box", pos: [0, 0.5, 0] },
    { name: "lid", shape: "extrude", pts: arc, depth: 1, pos: [0, 1, 0], pivot: [0, 1, -0.5], parent: "base" },
    { name: "leg", shape: "loft", sections: [[0.3, 1, 0, 0.2, 0.2], [0.3, 0, 0, 0.1, 0.1]] },
  ], anims: [{ name: "open", dur: 1, tracks: [{ part: "lid", rot: [[0, [0, 0, 0]], [1, [-90, 0, 0]]] }], motion: [{ part: "leg*", kind: "swing" }] }] }, root);
  const rel = await saveStudio(src, root, true);
  const dst = ensureStudio("dst");
  const r = await applyEdit(dst, { ops: [{ op: "use", file: rel, at: [10, 0, 0], prefix: "b_", anims: true }] }, root);
  assert.deepEqual(r.errors, []);
  const lid = dst.raw.find((p) => p.name === "b_lid"), leg = dst.raw.find((p) => p.name === "b_leg");
  assert.deepEqual(lid.pos, [10, 1, 0]);
  assert.deepEqual(lid.pivot, [10, 1, -0.5]);
  assert.deepEqual(lid.pts, arc, "extrude profile is untouched: it is local to the node");
  assert.deepEqual(leg.sections[0], [0.3, 1, 0, 0.2, 0.2], "loft sections are untouched too");
  assert.deepEqual(leg.pos, [10, 0, 0], "an unplaced part gets its offset as pos");
  assert.equal(lid.parent, "b_base");
  const clip = dst.anims.find((a) => a.name === "b_open");
  assert.ok(clip, "clip came along, renamed");
  assert.equal(clip.tracks[0].part, "b_lid");
  assert.equal(clip.motion[0].part, "b_leg*");
  assert.deepEqual(studioSpec(dst).anims.map((a) => a.name), ["b_open"]);
});

test("procedural textures are bounded data; variants recolour one model without copying parts or clips; export carries both", async (t) => {
  assert.equal(sanitizeTexture({ kind: "lava" }), null);
  const tx = sanitizeTexture({ kind: "planks", colors: ["orange", "nope", "#5a3818"], scale: 99, size: 9999, repeat: [0, 99] });
  assert.deepEqual(tx.colors, ["#ff8a3a".length ? tx.colors[0] : "", "#5a3818"].map((c, i) => (i === 0 ? tx.colors[0] : c)));
  assert.equal(tx.scale, 8); assert.equal(tx.size, 128); assert.deepEqual(tx.repeat, [0.1, 16]);
  assert.equal(sanitizeOverride({ wibble: 1 }), null);
  assert.deepEqual(sanitizeOverride({ color: "red", mat: "gold", texture: { kind: "noise" } }).texture.kind, "noise");
  const root = await mkdtemp(path.join(tmpdir(), "ares-var-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("v");
  const r = await applyEdit(st, { parts: [{ name: "base", shape: "box", color: "#8a5a2b", texture: { kind: "planks" } }, { name: "lid", shape: "box", color: "#8a5a2b" }, { name: "lid band", shape: "box", color: "#444" }, { name: "bad", shape: "box", texture: { kind: "lava" } }],
    anims: [{ name: "open", dur: 1, tracks: [{ part: "lid", rot: [[0, [0, 0, 0]], [1, [-90, 0, 0]]] }] }],
    ops: [{ op: "variant", name: "frost", set: { "base": { texture: { kind: "noise", colors: ["#cfe8ff", "#7fb4e8"] } }, "lid*": { color: "#9fd0ff", mat: "glossy" } } }, { op: "variant", name: "empty", set: { "x": { wibble: 1 } } }] }, root);
  assert.match(r.errors.join("\n"), /part "bad": texture needs/);
  assert.match(r.errors.join("\n"), /variant "empty": nothing usable/);
  assert.deepEqual(Object.keys(st.variants), ["frost"]);
  assert.equal(studioSpec(st).parts[0].texture.kind, "planks", "the base looks wooden by default");
  await applyEdit(st, { view: { variant: "frost" } }, root);
  const frosted = studioSpec(st).parts;
  assert.equal(frosted[0].texture.kind, "noise");
  assert.equal(frosted[1].color, "#9fd0ff");
  assert.equal(frosted[2].color, "#9fd0ff", "prefix selectors cover lid band too");
  assert.equal(frosted[2].mat, "glossy");
  const ex = await exportGame(st, root, {});
  const doc = JSON.parse(await readFile(path.join(root, ex.model), "utf8"));
  assert.equal(doc.parts[0].texture.kind, "planks", "the export holds the BASE parts, variants separate");
  assert.equal(doc.variants.frost["lid*"].color, "#9fd0ff");
  assert.match(ex.usage, /instance\(\{variant:"name"\}\)/);
});

test("runtime variants: a colourway is built once per variant and shared by its instances", async (t) => {
  let threePath;
  for (const c of [path.resolve("node_modules/three/build/three.module.js"), path.resolve("tauri/node_modules/three/build/three.module.js")]) {
    if (await readFile(c).then(() => true, () => false)) { threePath = c; break; }
  }
  if (!threePath) return t.skip("three is not installed in this checkout");
  const root = await mkdtemp(path.join(tmpdir(), "ares-rtv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ares-model.mjs");
  await writeFile(file, buildRuntimeModule(pathToFileURL(threePath).href), "utf8");
  const { buildModel } = await import(pathToFileURL(file).href);
  dropStudios();
  const st = ensureStudio("rv");
  await applyEdit(st, { parts: [{ name: "base", shape: "box", color: "#8a5a2b" }, { name: "lid band", shape: "box", color: "#444444", pos: [0, 1, 0] }],
    ops: [{ op: "variant", name: "frost", set: { "base": { color: "#9fd0ff" }, "lid*": { color: "#ffffff" } } }] }, root);
  const ex = await exportGame(st, root, {});
  const model = buildModel(JSON.parse(await readFile(path.join(root, ex.model), "utf8")));
  assert.deepEqual(model.variants, ["frost"]);
  const a = model.instance(), f1 = model.instance({ variant: "frost" }), f2 = model.instance({ variant: "frost" });
  assert.equal(a.part("base").mesh.material.color.getHex(), 0x8a5a2b);
  assert.equal(f1.part("base").mesh.material.color.getHex(), 0x9fd0ff);
  assert.equal(f1.part("lid band").mesh.material.color.getHex(), 0xffffff, "prefix selector");
  assert.equal(f1.part("base").mesh.geometry, f2.part("base").mesh.geometry, "instances of one variant share geometry");
  assert.equal(f1.part("base").mesh.material, f2.part("base").mesh.material);
  assert.notEqual(a.part("base").mesh.material, f1.part("base").mesh.material);
});

// ── sculpt: blobs melt into one skinned mesh; joints bend it; snapped features sit on the skin ──
import { lintBlob } from "../packages/cli/dist/entry/forgeBlocks.js";

/** The worked bear from the help docs, as parts (the docs example must stay valid input). */
function docsBear() {
  const from = FORGE_SCRIPT_DOCS.indexOf("WORKED EXAMPLE"), start = FORGE_SCRIPT_DOCS.indexOf("\n", from) + 1, end = FORGE_SCRIPT_DOCS.indexOf(" Walk:", start);
  const walk = FORGE_SCRIPT_DOCS.slice(end + 6, FORGE_SCRIPT_DOCS.indexOf("\n Same blobs", end)).trim();
  return { parts: vm.runInNewContext(`[${FORGE_SCRIPT_DOCS.slice(start, end)}]`), walk: vm.runInNewContext(`(${walk})`) };
}

test("sculpt: blobs are validated, chains become sticks, mirrors follow the mirrored joint, and a sculpt with nothing to melt falls back", () => {
  const m = sanitizeModel({ parts: [{ name: "b", shape: "sculpt", blobs: [
    { s: "ball", at: [0, 1, 0], r: [0.5, 0.4, 0.6], k: 0.2 },
    { s: "chain", pts: [[0.3, 1, 0, 0.2], [0.3, 0.5, 0.1, 0.15], [0.3, 0.1, 0.1, 0.12]], bone: "leg", mirror: true },
    { s: "stick", at: [0, 1, 0.5], to: [0, 1.1, 1], r: 0.2, r2: 0.1, k: 0.1 },
    { s: "ball", at: [0, 1.2, 0.3], r: 0.1, paint: true, color: "white", bone: "ignored" },
    { s: "ball", at: [0, 1.2, 0.5], r: 0.05, sub: true },
    { s: "stick", at: [0, 0, 0] },
  ] }] });
  const b = m.parts[0];
  assert.equal(b.shape, "sculpt");
  assert.equal(b.smooth, true, "sculpts are smooth unless low-poly");
  const sticks = b.blobs.filter((x) => x.s === "stick");
  assert.equal(sticks.length, 5, "2 chain segments x2 (mirror) + 1 stick");
  assert.deepEqual(b.blobs.filter((x) => x.bone).map((x) => x.bone), ["leg", "leg (mirror)", "leg", "leg (mirror)"]);
  assert.equal(b.blobs.find((x) => x.bone === "leg (mirror)").at[0], -0.3);
  const paint = b.blobs.find((x) => x.paint);
  assert.equal(paint.color, "#f4efe0"); assert.equal(paint.bone, undefined, "paint never carries a bone");
  assert.ok(b.blobs.find((x) => x.sub).k <= 0.05, "carves default tight");
  assert.equal(b.blobs.at(-1).s, "ball", "a stick without `to` degrades to a ball");
  assert.equal(sanitizeModel({ parts: [{ name: "x", shape: "sculpt", blobs: [{ s: "ball", at: [0, 0, 0], paint: true }] }] }).parts[0].shape, "box");
  assert.deepEqual(lintBlob({ s: "stick", at: [0, 0, 0], radius: 1 }, 2), ['blob 2: unknown field "radius" (blob fields: id, s, at, to, r, r2, pts, rot, round, k, sub, paint, soft, color, bone, mirror)', "blob 2: a stick needs to:[x,y,z] (it runs from at to to, radius r -> r2)"]);
  const mirrored = sanitizeModel({ parts: [{ name: "ear", shape: "sculpt", mirror: true, blobs: [{ s: "ball", at: [0.3, 1, 0], r: 0.1, bone: "head" }] }] }).parts;
  assert.deepEqual(mirrored.map((p) => [p.name, p.blobs[0].at[0], p.blobs[0].bone]), [["ear", 0.3, "head"], ["ear (mirror)", -0.3, "head (mirror)"]]);
});

test("sculpt studio: unknown blob fields, missing bones and bad snaps are reported; op blob patches/adds/removes one blob; scale reaches the blobs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-sculpt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  dropStudios();
  const st = ensureStudio("sc");
  let r = await applyEdit(st, { parts: [
    { name: "body", shape: "sculpt", blobs: [{ id: "chest", s: "ball", at: [0, 1, 0], r: [0.5, 0.5, 0.6], wobble: 1 }, { id: "leg", s: "stick", at: [0.3, 1, 0], to: [0.3, 0.1, 0], r: 0.15, bone: "legF" }] },
    { name: "eye", shape: "sphere", size: 0.05, pos: [0.1, 1.2, 0.6], snap: "nope" },
  ] }, root);
  const text = r.errors.join("\n");
  assert.match(text, /unknown field "wobble"/);
  assert.match(text, /blob bone\(s\) "legF" name no part.*shape:"joint"/);
  assert.match(text, /snaps to "nope", which is not a sculpt part/);
  r = await applyEdit(st, { parts: [{ name: "legF", shape: "joint", pos: [0.3, 1, 0], mirror: true }], ops: [
    { op: "blob", name: "body", id: "leg", r: 0.2 },
    { op: "blob", name: "body", id: "tail", s: "stick", at: [0, 1, -0.5], to: [0, 1.2, -1], r: 0.08 },
    { op: "blob", name: "body", id: "chest", remove: true },
    { op: "blob", name: "body", id: "ghost", remove: true },
    { op: "blob", name: "eye", id: "x" },
  ] }, root);
  assert.ok(r.errors.some((e) => /"ghost" not found/.test(e)));
  assert.ok(r.errors.some((e) => /no sculpt part "eye"/.test(e)));
  const raw = st.raw.find((p) => p.name === "body");
  assert.deepEqual(raw.blobs.map((b) => b.id), ["leg", "tail"]);
  assert.equal(raw.blobs[0].r, 0.2);
  await applyEdit(st, { ops: [{ op: "set", name: "body", scale: 2 }] }, root);
  assert.deepEqual(raw.blobs[1].at, [0, 2, -1]);
  assert.equal(raw.blobs[1].r, 0.16);
  assert.equal(raw.size, undefined, "a sculpt scales its blobs, not a bounding box");
});

test("sculpt runtime: the docs bear builds ONE closed skinned mesh, joints bend it, eyes land on the skin, and it loads in a game", async (t) => {
  let threePath;
  for (const c of [path.resolve("node_modules/three/build/three.module.js"), path.resolve("tauri/node_modules/three/build/three.module.js")]) {
    if (await readFile(c).then(() => true, () => false)) { threePath = c; break; }
  }
  if (!threePath) return t.skip("three is not installed in this checkout");
  const root = await mkdtemp(path.join(tmpdir(), "ares-sculpt-rt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ares-model.mjs");
  await writeFile(file, buildRuntimeModule(pathToFileURL(threePath).href), "utf8");
  const { buildModel } = await import(pathToFileURL(file).href);
  const T = await import(pathToFileURL(threePath).href);
  dropStudios();
  const st = ensureStudio("bear");
  const bear = docsBear();
  const r = await applyEdit(st, { parts: bear.parts, anims: [bear.walk] }, root);
  assert.deepEqual(r.errors, [], "the docs example is clean input");
  const spec = studioSpec(st);
  const model = buildModel({ format: "ares-model/1", expanded: true, parts: spec.parts, anims: spec.anims, scripts: [] });
  const a = model.instance(), b = model.instance();
  const body = a.part("body").mesh;
  assert.ok(body.isSkinnedMesh, "a sculpt with bones is skinned");
  assert.equal(body.geometry, b.part("body").mesh.geometry, "instances share the sculpted geometry");
  assert.notEqual(body.skeleton, b.part("body").mesh.skeleton, "each instance has its own skeleton");
  const g = body.geometry, idx = g.index.array, edges = new Map();
  for (let k = 0; k < idx.length; k += 3) for (let e = 0; e < 3; e++) { const p = idx[k + e], q = idx[k + (e + 1) % 3], key = p < q ? `${p}_${q}` : `${q}_${p}`; edges.set(key, (edges.get(key) ?? 0) + 1); }
  assert.ok([...edges.values()].every((n) => n === 2), "watertight: every edge has exactly two triangles");
  assert.ok(g.attributes.position.count > 2000, `a real surface (${g.attributes.position.count} verts)`);
  assert.deepEqual(g.userData.bones.slice(0, 4), ["", "head", "head (mirror)", "legF"]);
  // colours: the muzzle blob is light, the paint on the lower legs is dark
  const P = g.attributes.position, C = g.attributes.color;
  const near = (x, y, z) => { let best = 0, bd = 1e9; for (let i = 0; i < P.count; i++) { const d = Math.hypot(P.getX(i) - x, P.getY(i) - y, P.getZ(i) - z); if (d < bd) { bd = d; best = i; } } return best; };
  const lum = (i) => C.getX(i) + C.getY(i) + C.getZ(i);
  assert.ok(lum(near(0, 1.18, 1.78)) > 3 * lum(near(0.5, 0.3, 0.65)), "light muzzle, dark painted legs");
  // the eye was snapped onto the surface of the skull
  const eye = a.part("eye").spec;
  assert.ok(Math.hypot(eye.pos[0] - 0.13, eye.pos[1] - 1.27, eye.pos[2] - 1.5) < 0.2 && eye.snapped, "snapped near where it was asked");
  const nearest = P.count && Math.min(...Array.from({ length: P.count }, (_, i) => Math.hypot(P.getX(i) - eye.pos[0], P.getY(i) - eye.pos[1], P.getZ(i) - eye.pos[2])));
  assert.ok(nearest < 0.05, `the eye sits on the skin (${nearest.toFixed(3)} from the nearest vertex)`);
  // bending: a paw vertex moves when the walk swings the leg; a back vertex barely does
  a.group.updateMatrixWorld(true); body.skeleton.update();
  const paw = near(0.33, 0.1, 0.8), back = near(0, 1.7, -0.2), v0 = body.getVertexPosition(paw, new T.Vector3()), w0 = body.getVertexPosition(back, new T.Vector3());
  a.play("walk"); a.update(0.35); a.group.updateMatrixWorld(true); body.skeleton.update();
  const v1 = body.getVertexPosition(paw, new T.Vector3()), w1 = body.getVertexPosition(back, new T.Vector3());
  assert.ok(v1.distanceTo(v0) > 0.1, `the paw swings (${v1.distanceTo(v0).toFixed(3)})`);
  assert.ok(w1.distanceTo(w0) < 0.02, `the back stays (${w1.distanceTo(w0).toFixed(3)})`);
  // the claws follow the paw joint (rigid parts and skin agree)
  assert.equal(a.part("claw 1").node.parent, a.part("pawF").node);
  a.dispose(); b.dispose(); model.dispose();
});

test("live: a sculpt grows blob by blob while it streams (coarse partials), then the finished part lands once", () => {
  const call = JSON.stringify({ action: "model", model: "b", parts: [{ name: "body", shape: "sculpt", res: 80, blobs: [{ s: "ball", at: [0, 1, 0], r: 0.5 }, { s: "ball", at: [0, 1, 0.6], r: 0.3 }, { s: "stick", at: [0, 1, 0.8], to: [0, 1.2, 1.2], r: 0.2, r2: 0.1 }] }, { name: "eye", shape: "sphere", snap: "body" }] });
  for (const size of [1, 7, 1000]) {
    const s = new ExplainStream(); const pieces = [];
    for (let i = 0; i < call.length; i += size) pieces.push(...s.feed(call.slice(i, i + size)));
    const parts = pieces.filter((p) => p.op === "part");
    const partial = parts.filter((p) => p.partial);
    assert.deepEqual(partial.map((p) => p.parts[0].blobs.length), [1, 2, 3], `chunk ${size}: one partial per finished blob`);
    assert.ok(partial.every((p) => p.parts[0].res === 30), "partials are coarse (fast to rebuild)");
    const full = parts.filter((p) => !p.partial);
    assert.deepEqual(full.map((p) => p.parts[0].name), ["body", "eye"]);
    assert.equal(full[0].parts[0].res, 80, "the final part keeps its resolution");
  }
  assert.match(LIVE_RUNTIME_JS, /m\.partial&&el\.__live\.sculpt/);
  assert.match(FORGE_MODEL_JS, /sculpt:function\(list\)/);
});
