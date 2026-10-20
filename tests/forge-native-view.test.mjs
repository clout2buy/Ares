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
import { cliRuntimeContext } from "../packages/cli/dist/entry/runtime.js";
import { claimForge, forgeCdpUrl, forgeViewUp, resetForgeHolder } from "../packages/cli/dist/entry/forgeView.js";

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

test("the instructions never offer a screenshot or a 'can't open' in place of the live page", async () => {
  const { toolDoctrineFor } = await import("../packages/cli/dist/entry/prompt/index.js");
  const { makeOpenTool } = await import("../packages/cli/dist/entry/openTool.js");
  const desc = makeBrowserTool({ browserFilmstripRoot: tmpdir() }).schema.description;
  assert.doesNotMatch(desc, /may block the Forge|iframe sign-in/);
  assert.match(desc, /every site loads there/);
  assert.match(desc, /never with a screenshot, a local copy or "I can't open it"/);
  const doctrine = toolDoctrineFor(["Browser"]);
  assert.match(doctrine, /The Forge is the owner's side panel, a real browser/);
  assert.match(doctrine, /never a screenshot/);
  assert.match(doctrine, /Work in the Forge like a person at the keyboard/);
  assert.match(doctrine, /`network` first/);
  assert.match(JSON.stringify(makeBrowserTool({ browserFilmstripRoot: tmpdir() }).schema.inputJsonSchema), /'network' = devtools for the page/);
  assert.doesNotMatch(makeOpenTool().schema.description, /those are pictures/);
});

test("one chat drives the Forge at a time; the next may take it once the first goes quiet", async () => {
  resetForgeHolder();
  const env = { ARES_FORGE_HOLD_MS: "1000" };
  assert.equal(claimForge("chat-a", 0, env), true);
  assert.equal(claimForge("chat-a", 500, env), true, "the holder keeps it");
  assert.equal(claimForge("chat-b", 900, env), false, "another chat waits");
  assert.equal(claimForge("chat-b", 2000, env), true, "after the hold lapses it may take it");
  assert.equal(claimForge("chat-a", 2100, env), false);

  // through the tool: chat B runs in the background browser and says why
  resetForgeHolder();
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-view-"));
  const ep = await endpoint(0);
  const calls = [];
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async (opts) => { calls.push(opts); return fakeBrowser(opts.cdpUrl ? `cdp:${opts.cdpUrl}` : "launch:chrome", {}); });
  try {
    await withEnv({ ARES_FORGE_CDP_URL: ep.url }, async () => {
      const a = await tool.call({ action: "state" }, { sessionId: "chat-a", signal: new AbortController().signal, emitProgress: () => undefined });
      assert.equal(a.output.note, undefined);
      assert.equal(calls.at(-1).cdpUrl, ep.url);
      const b = await tool.call({ action: "state" }, { sessionId: "chat-b", signal: new AbortController().signal, emitProgress: () => undefined });
      assert.match(b.output.note, /Forge is in use by another chat/);
      assert.notEqual(calls.at(-1).cdpUrl, ep.url);
    });
  } finally {
    resetForgeHolder();
    await ep.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("end to end: Ares plays a canvas game in the Forge, waits for the page, reads the wire, and knows what's on screen", async (t) => {
  let pw;
  try { pw = await import("../packages/connectors/node_modules/playwright/index.mjs"); } catch { t.skip("playwright not installed"); return; }
  const { WebSocketServer } = await import("../packages/cli/node_modules/ws/wrapper.mjs");
  const { forgeScreenNote, resetForgeScreenNotes } = await import("../packages/cli/dist/entry/forgeView.js");
  const port = 9800 + Math.floor(Math.random() * 150);
  const args = [`--remote-debugging-port=${port}`];
  let chromium;
  try { chromium = await pw.chromium.launch({ args }); }
  catch {
    try { chromium = await pw.chromium.launch({ args, executablePath: "/opt/pw-browsers/chromium" }); } catch { t.skip("no Chromium here"); return; }
  }
  await (await chromium.newContext({ viewport: { width: 800, height: 600 } })).newPage(); // the "Forge view"
  // a relay with the stick-fight bug: answers with a BINARY frame, then says the game is full
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Stick Fight</title><body style="margin:0"><canvas id=c width=800 height=600></canvas><div id=lobby>loading</div><script>
      window.log = [];
      addEventListener("keydown", (e) => log.push("down:" + e.key));
      addEventListener("keyup", (e) => log.push("up:" + e.key));
      c.addEventListener("click", (e) => log.push("click:" + e.clientX + "," + e.clientY));
      c.addEventListener("mousedown", (e) => log.push("press:" + e.clientX + "," + e.clientY));
      c.addEventListener("mouseup", (e) => log.push("release:" + e.clientX + "," + e.clientY));
      setTimeout(() => { document.getElementById("lobby").textContent = "Player 2 joined"; }, 900);
      const ws = new WebSocket("ws://" + location.host + "/relay/ABCD");
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello" }));
    </script>`);
  });
  const wss = new WebSocketServer({ server: site });
  wss.on("connection", (ws) => ws.on("message", (m) => { ws.send(Buffer.from(m)); setTimeout(() => ws.close(4409, "game ABCD is full"), 150); }));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${site.address().port}/game.html`;
  const root = await mkdtemp(path.join(tmpdir(), "ares-forge-play-"));
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: root, home: root }));
  const asked = [];
  // the owner's approval card (guarded mode gates clicks — canvas clicks included)
  const ctx = { sessionId: "chat-play", signal: new AbortController().signal, emitProgress: () => undefined, requestPermission: async (r) => { asked.push(r); return "allow_once"; } };
  resetForgeHolder();
  resetForgeScreenNotes();
  try {
    await withEnv({ ARES_FORGE_CDP_URL: `http://127.0.0.1:${port}`, ARES_BROWSER_CDP_DISCOVERY: "0" }, async () => {
      await tool.call({ action: "preview", url }, ctx);
      // the turn-start line: what the owner has on screen, once per change
      const note = await forgeScreenNote("chat-play");
      assert.match(note, /The Forge .* showing the page titled "Stick Fight" \(quoted from the site\) at http:\/\/127\.0\.0\.1:\d+\/game\.html/);
      assert.equal(await forgeScreenNote("chat-play"), null, "not repeated while nothing changed");

      // one act = a whole play-through: hold a key, tap another, click and drag on the canvas
      const played = await tool.call({ action: "act", steps: [
        { action: "press", keys: "ArrowRight", holdMs: 200 },
        { action: "press", keys: "Space", repeat: 2 },
        { action: "click_at", x: 120, y: 140 },
        { action: "drag", x: 200, y: 200, toX: 320, toY: 260 },
      ] }, ctx);
      assert.equal(played.output.status, "committed", JSON.stringify(played.output));
      const log = (await tool.call({ action: "eval", js: "window.log" }, ctx)).output.result;
      assert.deepEqual(log.filter((e) => /ArrowRight/.test(e)), ["down:ArrowRight", "up:ArrowRight"], "a real held key, down then up");
      assert.equal(log.filter((e) => e === "down: ").length, 2, "Space tapped twice");
      assert.ok(log.includes("click:120,140"), `clicked at the exact spot: ${log}`);
      assert.ok(log.includes("press:200,200") && log.includes("release:320,260"), "dragged from → to");
      assert.equal(played.images?.length, 1, "one look at the end, not one per step");
      assert.equal(asked.length, 1, "one approval for the whole batch (it has canvas clicks), not one per step");
      // game keys alone don't need the card
      asked.length = 0;
      const keysOnly = await tool.call({ action: "press", keys: "ArrowLeft", repeat: 3 }, ctx);
      assert.equal(keysOnly.output.status, "committed");
      assert.equal(asked.length, 0, "arrow keys move a game; no approval card");

      // the owner's turn: wait for the page to change, then carry on
      const waited = await tool.call({ action: "wait", text: "Player 2 joined", timeoutSec: 5 }, ctx);
      assert.equal(waited.output.status, "committed");
      assert.equal(waited.output.result.completed[0].result.met, true);
      await assert.rejects(tool.call({ action: "wait", text: "never appears", timeoutSec: 1 }, ctx), /waited 1s and the page never showed "never appears"/);

      // devtools for the wire: the binary frame and (after a reload with close
      // codes on) the close code are named
      let net = await tool.call({ action: "network" }, ctx);
      assert.match(net.output.note, /BINARY frame/);
      await tool.call({ action: "open", url }, ctx);
      await new Promise((r) => setTimeout(r, 600));
      net = await tool.call({ action: "network" }, ctx);
      const sock = net.output.result.sockets.at(-1);
      assert.equal(sock.close?.code, 4409);
      assert.equal(sock.close?.reason, "game ABCD is full");
      assert.ok(sock.last.some((f) => f.dir === "out" && f.type === "text"));
      assert.ok(sock.last.some((f) => f.dir === "in" && f.type === "binary"));
      assert.match(net.output.note, /closed 4409 "game ABCD is full"/);
    });
  } finally {
    resetForgeHolder();
    await tool.call({ action: "close" }, ctx).catch(() => undefined);
    await chromium.close();
    wss.close();
    site.closeAllConnections?.();
    site.close();
    await rm(root, { recursive: true, force: true });
  }
});
