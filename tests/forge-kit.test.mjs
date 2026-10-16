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
