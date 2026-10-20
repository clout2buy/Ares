// The page driver (owner, 2026-10-20: "it needs to not do it inside its own
// hidden browser"): a served page carries a driver that long-polls its own
// server, so Ares acts in the copy the owner is looking at. Here a fake page
// polls like the real script does and answers the commands.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serveLocalTarget, stopPreviewServers, waitForDrivablePage, drivePage, drivableRoots } from "../packages/cli/dist/entry/previewServer.js";
import { createServedPageBrowser } from "../packages/cli/dist/entry/servedPageBrowser.js";

test("a served page carries the driver; commands reach the open copy and its answers come back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-drive-"));
  t.after(async () => { await stopPreviewServers(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><html><head><title>Game</title></head><body><canvas></canvas></body></html>");
  const served = await serveLocalTarget(path.join(dir, "index.html"));
  assert.ok(served);

  const sensor = await (await fetch(`${served.origin}/__ares/forge-sensor.js`)).text();
  assert.match(sensor, /__aresPageDriver/, "the driver ships with the sensor every served page loads");
  assert.equal(await waitForDrivablePage(served.root, 0), null, "nothing is drivable before a page opens");

  // A fake page: poll, run, reply — the same wire as pageDriverSource.ts.
  let running = true;
  const seen = [];
  const page = (async () => {
    while (running) {
      const res = await fetch(`${served.origin}/__ares/drive?page=p1&url=${encodeURIComponent(served.url)}`).catch(() => null);
      if (!res || res.status !== 200) continue;
      const cmd = await res.json();
      seen.push(cmd.op);
      const reply = cmd.op === "state" ? { id: cmd.id, ok: true, value: { url: served.url, title: "Game" } }
        : cmd.op === "press" ? { id: cmd.id, ok: true, value: true }
        : { id: cmd.id, ok: false, error: `no ${cmd.op} here` };
      await fetch(`${served.origin}/__ares/drive?page=p1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) });
    }
  })();
  t.after(() => { running = false; });

  const open = await waitForDrivablePage(served.root, 3000);
  assert.equal(open?.id, "p1");
  assert.equal((await drivableRoots())[0]?.root, served.root);

  const br = createServedPageBrowser(served.root, served.origin, open);
  assert.equal(br.strategy, `page:${served.origin}`);
  assert.deepEqual(await br.state(), { url: served.url, title: "Game" });
  await br.press("w", { holdMs: 50 });
  await assert.rejects(() => br.clickByText("Start"), /no clickText here/, "a page-side failure comes back as the error");
  assert.deepEqual(seen, ["state", "press", "clickText"]);
  await assert.rejects(() => br.navigate("https://example.com/"), /outside the served folder/);

  await assert.rejects(() => drivePage(served.root, "gone", "state"), /no longer open/);
  running = false;
  await stopPreviewServers();
  await page.catch(() => undefined);
});

test("a page named relative to the workspace, with a query, is served (not refused as 'not local')", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-rel-"));
  t.after(async () => { await stopPreviewServers(); await rm(dir, { recursive: true, force: true }); });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "voxel-world"));
  await writeFile(path.join(dir, "voxel-world", "index.html"), "<!doctype html><title>V</title>");
  const served = await serveLocalTarget("voxel-world/index.html?seed=1337", { cwd: dir });
  assert.ok(served, "served");
  assert.match(served.url, /\/index\.html\?seed=1337$/);
  assert.equal(await serveLocalTarget("voxel-world/index.html"), null, "no workspace given: not guessed");
  assert.equal(await serveLocalTarget("example.com/page", { cwd: dir }), null, "a bare domain is not a local path");
});

test("a reload mid-command: the old copy says bye, the command runs on the new copy instead of timing out", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-reload-"));
  t.after(async () => { await stopPreviewServers(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>R</title>");
  const served = await serveLocalTarget(path.join(dir, "index.html"));
  const poll = (id) => fetch(`${served.origin}/__ares/drive?page=${id}&url=${encodeURIComponent(served.url)}`);
  const reply = (id, body) => fetch(`${served.origin}/__ares/drive?page=${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // p1 takes the command, then reloads (bye) without answering.
  const first = poll("p1");
  const open = await waitForDrivablePage(served.root, 3000);
  const br = createServedPageBrowser(served.root, served.origin, open);
  const result = br.state();
  const cmd = await (await first).json();
  assert.equal(cmd.op, "state");
  await fetch(`${served.origin}/__ares/drive?page=p1&bye=1`, { method: "POST" });

  // p2 is the reloaded copy: it gets the command again and answers.
  let running = true;
  t.after(() => { running = false; });
  (async () => {
    while (running) {
      const res = await poll("p2").catch(() => null);
      if (!res || res.status !== 200) continue;
      const c = await res.json();
      await reply("p2", { id: c.id, ok: true, value: { url: served.url, title: "after reload" } });
    }
  })();
  const t0 = Date.now();
  assert.deepEqual(await result, { url: served.url, title: "after reload" });
  assert.ok(Date.now() - t0 < 8000, "no 30s wait on the gone copy");
  running = false;
});

test("the loopback address of a page Ares serves maps back to its folder", async (t) => {
  const { servedForUrl } = await import("../packages/cli/dist/entry/previewServer.js");
  const dir = await mkdtemp(path.join(tmpdir(), "ares-origin-"));
  t.after(async () => { await stopPreviewServers(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>O</title>");
  const served = await serveLocalTarget(path.join(dir, "index.html"));
  const hit = await servedForUrl(`${served.origin}/index.html?seed=2`);
  assert.equal(hit?.root, served.root);
  assert.equal(await servedForUrl("http://127.0.0.1:1/x"), null);
});

test("a page address from before a restart still opens: same folder, same port", async (t) => {
  const { servedForUrl } = await import("../packages/cli/dist/entry/previewServer.js");
  const dir = await mkdtemp(path.join(tmpdir(), "ares-port-"));
  const home = await mkdtemp(path.join(tmpdir(), "ares-port-home-"));
  const prevHome = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(async () => {
    await stopPreviewServers();
    if (prevHome === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>P</title>");
  const before = await serveLocalTarget(path.join(dir, "index.html"));
  await stopPreviewServers(); // the daemon restarts
  const again = await servedForUrl(`${before.url}?seed=9`);
  assert.equal(again?.root, before.root, "the old address finds its folder");
  assert.equal(again?.origin, before.origin, "on the same port");
  assert.equal((await fetch(`${again.origin}/index.html`)).status, 200);
});
