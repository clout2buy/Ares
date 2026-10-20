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
