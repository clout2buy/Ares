// The Forge's native view (owner, 2026-10-20: "never a screenshot again…
// every site can load in ares preview, I can actually log in on its
// preview"). The desktop lays a real browser over the Forge panel and starts
// the daemon with ARES_FORGE_CDP_URL; the Browser tool attaches to THAT page.
//
// Pinned here:
//   1. With the endpoint set, the Browser tool attaches to it (attach-only,
//      that exact endpoint) and streams NO frames — the owner sees the page
//      itself, not pictures of it.
//   2. The first call wakes the view (a blank Forge page) and waits for it.
//   3. Every target it reports is marked driven, so the Forge shows the page
//      Ares navigated instead of loading it a second time.
//   4. If the view never comes up the call still works, and SAYS the owner
//      can't see that page.
//   5. Without the endpoint (CLI, garrison, phone) nothing changes.
//   6. End to end on a real Chromium with a DevTools port: Ares's preview
//      lands in that very browser.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBrowserTool } from "../packages/cli/dist/entry/browserBridge.js";
import { forgeCdpUrl, forgeViewUp } from "../packages/cli/dist/entry/forgeView.js";

const fakeBrowser = (strategy, log) => ({
  name: "fake",
  strategy,
  async state() { return { url: log.url ?? "https://site.test/", title: "page" }; },
  async close() { log.closed = (log.closed ?? 0) + 1; },
  async navigate(url) { log.url = url; return { url, title: "page" }; },
  async accessibilityTree() { return []; },
  async fillByLabel() {},
  async clickByRole() {},
  async screenshot() { return { format: "png", bytes: "" }; },
});

/** A stand-in DevTools endpoint that starts answering after `delayMs`. */
async function endpoint(delayMs = 0) {
  const born = Date.now();
  const server = createServer((req, res) => {
    if (req.url === "/json/version" && Date.now() - born >= delayMs) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    res.writeHead(503); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("forgeView helpers: endpoint from the env, and a wait that gives up", async () => {
  assert.equal(forgeCdpUrl({ ARES_FORGE_CDP_URL: " http://127.0.0.1:9333/ " }), "http://127.0.0.1:9333");
  assert.equal(forgeCdpUrl({}), "");
  assert.equal(await forgeViewUp("", 1000), false);
  const ep = await endpoint(400);
  try {
    assert.equal(await forgeViewUp(ep.url, 0), false, "not up yet");
    assert.equal(await forgeViewUp(ep.url, 3000), true, "comes up within the wait");
  } finally { await ep.close(); }
});

test("on the desktop the Browser tool wakes the Forge view, attaches to it, and streams no frames", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-view-"));
  const ep = await endpoint(500); // the view appears a moment after the Forge is told to show it
  const calls = [];
  const log = {};
  const events = [];
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async (opts) => { calls.push(opts); return fakeBrowser(`cdp:${opts.cdpUrl}`, log); });
  try {
    await withEnv({ ARES_FORGE_CDP_URL: ep.url }, async () => {
      const ctx = { signal: new AbortController().signal, emitProgress: (e) => events.push(e) };
      const opened = await tool.call({ action: "state" }, ctx);
      assert.equal(opened.output.note, undefined, "no fallback note");
      assert.deepEqual(events[0], { kind: "browser_target", url: "about:blank", title: "", mode: "project", driven: true }, "wakes the view first");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cdpUrl, ep.url, "attaches to the Forge view's endpoint");
      assert.equal(calls[0].attachOnly, true, "never launches a different browser in its place");
      assert.equal(calls[0].onFrame, undefined, "no frame stream of the page the owner already sees");
      const target = events.filter((e) => e.kind === "browser_target").at(-1);
      assert.equal(target.driven, true, "the Forge shows what Ares navigated instead of loading it again");
      // later calls reuse the attached view, no second wake
      events.length = 0;
      await tool.call({ action: "state" }, ctx);
      assert.equal(calls.length, 1);
      assert.ok(!events.some((e) => e.url === "about:blank"));
      assert.ok(!events.some((e) => e.kind === "browser_frame"));
    });
  } finally {
    await ep.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("if the Forge view never comes up the call still works and says the owner can't see it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-view-"));
  const calls = [];
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async (opts) => { calls.push(opts); return fakeBrowser("launch:chrome", {}); });
  try {
    await withEnv({ ARES_FORGE_CDP_URL: "http://127.0.0.1:9", ARES_FORGE_VIEW_WAIT_MS: "300" }, async () => {
      const out = await tool.call({ action: "state" }, { signal: new AbortController().signal, emitProgress: () => undefined });
      assert.match(out.output.note, /Forge view did not come up .* the owner cannot see or use this page/);
      assert.equal(typeof calls[0].onFrame, "function", "the background browser still streams to the panel");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without the desktop endpoint nothing changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-view-"));
  const calls = [];
  const events = [];
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async (opts) => { calls.push(opts); return fakeBrowser("launch:chrome", {}); });
  try {
    await withEnv({ ARES_FORGE_CDP_URL: "" }, async () => {
      await tool.call({ action: "state" }, { signal: new AbortController().signal, emitProgress: (e) => events.push(e) });
      assert.notEqual(calls[0].attachOnly, true);
      assert.ok(!events.some((e) => e.url === "about:blank"));
      assert.ok(!events.some((e) => e.driven));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("end to end: Ares's preview lands in the very browser behind the endpoint", async (t) => {
  let pw;
  try { pw = await import("../packages/connectors/node_modules/playwright/index.mjs"); } catch { t.skip("playwright not installed"); return; }
  const port = 9400 + Math.floor(Math.random() * 400);
  let chromium;
  const args = [`--remote-debugging-port=${port}`];
  try { chromium = await pw.chromium.launch({ args }); }
  catch {
    try { chromium = await pw.chromium.launch({ args, executablePath: "/opt/pw-browsers/chromium" }); } catch { t.skip("no Chromium here"); return; }
  }
  const forgePage = await (await chromium.newContext()).newPage(); // the "Forge view"
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Stick Fight</title><h1>lobby</h1>"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/game.html`;
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-view-"));
  const events = [];
  const tool = makeBrowserTool({ browserFilmstripRoot: root });
  try {
    await withEnv({ ARES_FORGE_CDP_URL: `http://127.0.0.1:${port}`, ARES_BROWSER_CDP_DISCOVERY: "0", ARES_BROWSER_SCREENCAST: "1" }, async () => {
      const out = await tool.call({ action: "preview", url: siteUrl }, { signal: new AbortController().signal, emitProgress: (e) => events.push(e) });
      assert.equal(out.output.status, "ok");
      assert.equal(out.output.note, undefined);
      assert.equal(forgePage.url(), siteUrl, "the page the owner sees is the page Ares opened");
      assert.equal(await forgePage.title(), "Stick Fight");
      assert.ok(!events.some((e) => e.kind === "browser_frame"), "no frame stream");
      const target = events.filter((e) => e.kind === "browser_target").at(-1);
      assert.equal(target.url, siteUrl);
      assert.equal(target.driven, true);
      await tool.call({ action: "close" }, { signal: new AbortController().signal });
      assert.equal(forgePage.isClosed(), false, "closing Ares's connection leaves the Forge view open");
    });
  } finally {
    await chromium.close();
    site.closeAllConnections?.();
    site.close();
    await rm(root, { recursive: true, force: true });
  }
});
