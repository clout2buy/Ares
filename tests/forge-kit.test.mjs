// The Forge kit: Ares's generative UI in the Forge's pixel language (owner,
// 2026-10-15: "show me stuff, explain stuff all the time … generated with the
// pixel theme"). A page carries `<!--ares:kit-->`; the Browser tool expands it
// into the inline kit so the page needs no network; served folders get the
// same kit at /__ares/kit.css and /__ares/kit.js.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  await assert.rejects(() => saveStudio(st, root, "../evil.json"), /escapes the project/);
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
  assert.equal(out[0].style, undefined, "style after parts isn't known yet; parts are sanitised with what is");
});
