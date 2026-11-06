// Ares's eyes on its own window: every change comes back with what is really
// on screen, a desktop that never answers does not hang a tool, and what a
// document keeps with ares.store is its own and survives.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { surfaceHtmlProblem, surfaceWebUrl, webSurfaceHtml } from "../packages/protocol/dist/index.js";
import path from "node:path";
import { SurfaceTool, refusesEmbedding, readSurface, ShellTool, answerLook, createSurface, lookAtUi, readShellLayout, readSurfaceData, setGenui, setLookRequester, withEyes, writeSurfaceData } from "../packages/tools/dist/index.js";

// Every call below uses a throwaway home: a default one is the owner's real Ares,
// and the reset at the end of a test wiped their shell on every run.
process.env.ARES_HOME = mkdtempSync(path.join(os.tmpdir(), "ares-ui-look-"));

const shot = { mediaType: "image/jpeg", data: "AAAA" };
const base = { output: { message: "done" }, display: "done" };

test("no desktop attached: the result is untouched and a look says so", async () => {
  setLookRequester(null);
  assert.equal(await withEyes(base), base);
  assert.equal(await lookAtUi(), null);
});

test("a desktop that never answers cannot hang the tool", async () => {
  setLookRequester(() => undefined);
  assert.equal(await lookAtUi(undefined, 20), null);
  setLookRequester(null);
});

test("what to do travels with the request", async () => {
  let seen;
  setLookRequester((id, surface, act) => { seen = { surface, act }; answerLook(id, { report: "ok", images: [] }); });
  const look = await lookAtUi("notes", 500, { selector: "button", text: "hi" });
  assert.equal(look.report, "ok");
  assert.deepEqual(seen, { surface: "notes", act: { selector: "button", text: "hi" } });
  setLookRequester(null);
});

test("with GenUI on, a change comes back with the picture and the report", async () => {
  setGenui(true);
  setLookRequester((id) => answerLook(id, { report: "notes: PROBLEM covered by .gate.", images: [shot] }));
  const seen = await withEyes(base, "notes");
  assert.deepEqual(seen.images, [shot]);
  assert.match(seen.output.message, /PROBLEM covered by \.gate/);
  setLookRequester(null);
  setGenui(false);
});

test("with GenUI off, nothing is captured", async () => {
  setGenui(false);
  let asked = false;
  setLookRequester(() => { asked = true; });
  assert.equal(await withEyes(base), base);
  assert.equal(asked, false);
  setLookRequester(null);
});

test("ares.store keeps a surface's data and refuses more than it can hold", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-look-"));
  await createSurface({ name: "notes", title: "Notes", placement: "free", document: { html: "<p data-ares-region=\"m\">hi</p>", css: "", js: "" }, feeds: [], actions: [] }, home);
  assert.deepEqual(await readSurfaceData("notes", home), {});
  await writeSurfaceData("notes", "text", { a: 1 }, home);
  assert.deepEqual(await readSurfaceData("notes", home), { text: { a: 1 } });
  await writeSurfaceData("notes", "text", undefined, home);
  assert.deepEqual(await readSurfaceData("notes", home), {});
  await assert.rejects(writeSurfaceData("notes", "big", "x".repeat(1_100_000), home), /1 MB/);
});

test("a fix to a look adds to it: add_css and vars never lose what is applied", async () => {
  await ShellTool.call({ action: "set", css: ".a{color:red}", vars: { "--bg": "#000" } }, {});
  await ShellTool.call({ action: "set", add_css: ".b{color:blue}", vars: { "--accent": "#00f" } }, {});
  const layout = await readShellLayout();
  assert.match(layout.css, /\.a\{color:red\}/);
  assert.match(layout.css, /\.b\{color:blue\}/);
  assert.deepEqual(layout.vars, { "--bg": "#000", "--accent": "#00f" });
  await ShellTool.call({ action: "reset" }, {});
});

test("a script that cannot parse is refused before it reaches the webview", async () => {
  const before = (await readShellLayout()).revision;
  const result = await ShellTool.call({ action: "set", script: "const a = ;" }, {});
  assert.match(result.failure, /does not parse/);
  assert.equal((await readShellLayout()).revision, before);
});

// A second webview in the main window (the Forge) makes Tauri stop counting it as
// a webview window for good. Anything still asking for one fails from then on:
// scripts silently never ran and screenshots came back empty.
test("nothing that runs after startup needs the main window to be a webview window", () => {
  const main = readFileSync(new URL("../tauri/src-tauri/src/main.rs", import.meta.url), "utf8");
  const setup = main.slice(main.indexOf(".setup(|app|"), main.indexOf(".invoke_handler("));
  assert.equal(main.split('get_webview_window("main")').length, setup.split('get_webview_window("main")').length);
  assert.doesNotMatch(main, /#\[tauri::command\]\s*(async )?fn \w+\([^)]*: tauri::WebviewWindow/);
});

test("a website is a surface of its own, and only by the front door", async () => {
  const made = await SurfaceTool.call({ action: "create", name: "site", title: "Site", placement: "free", url: "https://example.com/a?b=1", frame: { hidden: true } }, { sessionId: "s" });
  assert.equal(made.failure, undefined);
  assert.equal(surfaceWebUrl((await readSurface("site")).document.html), "https://example.com/a?b=1");
  assert.equal(surfaceHtmlProblem(webSurfaceHtml("https://example.com/")), null);
  assert.match(surfaceHtmlProblem('<iframe src="https://example.com"></iframe>'), /create the surface with url/);
  assert.match(surfaceHtmlProblem('<ares-web data-ares-region="main" src="https://a.com"></ares-web><script>x</script>'), /./, "only a whole document that is the page");
  assert.equal(surfaceWebUrl('<ares-web data-ares-region="main" src="javascript:alert(1)"></ares-web>'), null);
  const bad = await SurfaceTool.call({ action: "create", name: "bad", placement: "free", url: "file:///c:/x" }, { sessionId: "s" });
  assert.match(bad.failure, /http or https/);
});

test("a site that forbids framing is sent to a real window, not a blank panel", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const page = (headers) => async () => new Response("x", { headers });
  globalThis.fetch = page({ "x-frame-options": "SAMEORIGIN" });
  assert.equal(await refusesEmbedding("https://a.test/"), true);
  globalThis.fetch = page({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" });
  assert.equal(await refusesEmbedding("https://a.test/"), true);
  globalThis.fetch = page({ "content-security-policy": "frame-ancestors *" });
  assert.equal(await refusesEmbedding("https://a.test/"), false);
  globalThis.fetch = page({});
  assert.equal(await refusesEmbedding("https://a.test/"), false);
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await refusesEmbedding("https://a.test/"), false);
  globalThis.fetch = page({ "x-frame-options": "DENY" });
  const refused = await SurfaceTool.call({ action: "create", name: "framed", placement: "free", url: "https://a.test/" }, { sessionId: "s" });
  assert.match(refused.failure, /placement window/);
  const windowed = await SurfaceTool.call({ action: "create", name: "framed", placement: "window", url: "https://a.test/" }, { sessionId: "s" });
  assert.equal(windowed.failure, undefined);
});
