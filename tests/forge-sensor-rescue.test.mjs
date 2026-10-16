// The Forge sensor and bare-import rescue (owner, 2026-10-15): "Ares should
// auto see everything in the Forge — spot errors and bugs as I test", and a
// page that imports `three` bare should just work in the Forge.
//
//   1. Every served HTML page carries the sensor script; the sensor endpoint
//      serves it; a telemetry POST reaches the sink as a HUD event tagged with
//      the session that opened the folder, and as a model reminder.
//   2. A page with bare imports and no import map gets one injected: from a
//      nearby node_modules when present, else a pinned CDN. A page that has
//      its own import map is left alone.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serveLocalTarget, setForgeSink, stopPreviewServers, bareImportsIn } from "../packages/cli/dist/entry/previewServer.js";

const MODULE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>
<script type="module">
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { init } from '/preview/_kit/model.js'
import { tiny } from "./local.js"
console.log(THREE, OrbitControls, init, tiny)
</script></body></html>`;

async function project(html = MODULE_PAGE) {
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-sensor-"));
  await writeFile(path.join(root, "index.html"), html);
  return root;
}

test.after(() => { setForgeSink(null); return stopPreviewServers(); });

test("bareImportsIn finds bare packages in module scripts and ignores relative, absolute and URL imports", () => {
  assert.deepEqual(bareImportsIn(MODULE_PAGE), ["three"]);
  assert.deepEqual(bareImportsIn(`<script type="module">import x from "@scope/pkg/sub"; import y from "https://esm.sh/z"; import("lodash")</script>`), ["@scope/pkg", "lodash"]);
  assert.deepEqual(bareImportsIn(`<script>import a from "three"</script>`), [], "a classic script is not a module");
});

test("served HTML carries the sensor and an injected CDN import map; the sensor script is served", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const served = await serveLocalTarget(path.join(root, "index.html"), { sessionId: "sess_forge_1" });
  assert.ok(served);
  const html = await (await fetch(served.url)).text();
  assert.match(html, /<script src="\/__ares\/forge-sensor\.js"><\/script>/, "sensor tag injected");
  assert.ok(html.indexOf("forge-sensor.js") < html.indexOf("<title>"), "injected at the top of <head>, before the page's own scripts");
  const mapMatch = html.match(/<script type="importmap">(.*?)<\/script>/s);
  assert.ok(mapMatch, "an import map was injected");
  const map = JSON.parse(mapMatch[1]);
  assert.equal(map.imports.three, "https://esm.sh/three");
  assert.equal(map.imports["three/addons/"], "https://esm.sh/three/examples/jsm/");
  assert.equal(map.imports["./local.js"], undefined, "relative imports are not mapped");

  const sensor = await fetch(`${served.origin}/__ares/forge-sensor.js`);
  assert.equal(sensor.status, 200);
  assert.match(sensor.headers.get("content-type") ?? "", /javascript/);
  const src = await sensor.text();
  assert.match(src, /unhandledrejection/);
  assert.match(src, /requestAnimationFrame/);
  assert.match(src, /__ares\/telemetry/);

  const again = await serveLocalTarget(path.join(root, "index.html"));
  assert.ok(again?.rescue, "the rescue decision is readable after the page was served once");
  assert.equal(again.rescue.source, "cdn");
});

test("a nearby node_modules wins over the CDN and is served under /__ares/nm/", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const three = path.join(root, "node_modules", "three");
  await mkdir(path.join(three, "build"), { recursive: true });
  await mkdir(path.join(three, "examples", "jsm", "controls"), { recursive: true });
  await writeFile(path.join(three, "package.json"), JSON.stringify({ name: "three", module: "./build/three.module.js", main: "./build/three.cjs" }));
  await writeFile(path.join(three, "build", "three.module.js"), "export const REVISION = 'local';");
  await writeFile(path.join(three, "examples", "jsm", "controls", "OrbitControls.js"), "export class OrbitControls {}");
  const served = await serveLocalTarget(path.join(root, "index.html"));
  assert.ok(served);
  const html = await (await fetch(served.url)).text();
  const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)[1]);
  assert.equal(map.imports.three, "/__ares/nm/three/build/three.module.js");
  assert.equal(map.imports["three/addons/"], "/__ares/nm/three/examples/jsm/");
  const mod = await fetch(`${served.origin}/__ares/nm/three/build/three.module.js`);
  assert.equal(mod.status, 200);
  assert.match(await mod.text(), /REVISION = 'local'/);
  const escape = await fetch(`${served.origin}/__ares/nm/../index.html`);
  assert.notEqual(escape.status, 200, "node_modules serving cannot escape node_modules");
});

test("a page with its own import map is left alone (sensor still injected)", async (t) => {
  const root = await project(`<!doctype html><head><script type="importmap">{"imports":{"three":"./vendor/three.js"}}</script></head><body><script type="module">import * as T from 'three'</script></body>`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const served = await serveLocalTarget(path.join(root, "index.html"));
  const html = await (await fetch(served.url)).text();
  assert.equal((html.match(/type="importmap"/g) ?? []).length, 1, "no second import map");
  assert.match(html, /forge-sensor\.js/);
  assert.equal((await serveLocalTarget(path.join(root, "index.html")))?.rescue, undefined);
});

test("telemetry POSTs reach the sink as a tagged HUD event and a model reminder", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const reminders = [];
  setForgeSink({
    event: (sessionId, payload) => events.push({ sessionId, payload }),
    remind: (sessionId, text, key) => reminders.push({ sessionId, text, key }),
  });
  const served = await serveLocalTarget(path.join(root, "index.html"), { sessionId: "sess_forge_2" });
  const res = await fetch(`${served.origin}/__ares/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: served.url, at: Date.now(), items: [
      { kind: "error", text: "Failed to resolve module specifier \"three\"", where: "index.html:4:1" },
      { kind: "warn", text: "THREE.WebGLRenderer: something deprecated" },
      { kind: "fps", fps: 12, longestMs: 180 },
      { kind: "load", ms: 410 },
    ] }),
  });
  assert.equal(res.status, 204);
  const hud = events.find((e) => e.payload.type === "forge_telemetry");
  assert.ok(hud, "a forge_telemetry HUD event was emitted");
  assert.equal(hud.sessionId, "sess_forge_2", "tagged with the session that opened the folder");
  assert.equal(hud.payload.errorCount, 1);
  assert.equal(hud.payload.warningCount, 1);
  assert.equal(hud.payload.fps, 12);
  assert.equal(hud.payload.loadMs, 410);
  assert.match(hud.payload.errors[0], /module specifier "three" \(index\.html:4:1\)/);

  await new Promise((r) => setTimeout(r, 1900));
  assert.equal(reminders.length, 1, "errors are batched into one reminder");
  assert.equal(reminders[0].sessionId, "sess_forge_2");
  assert.match(reminders[0].text, /Forge sensor/);
  assert.match(reminders[0].text, /ERROR Failed to resolve module specifier/);
  assert.match(reminders[0].text, /warn THREE\.WebGLRenderer/);
  assert.match(reminders[0].key, /^forge-sensor:/);
});
