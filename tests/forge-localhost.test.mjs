// The Forge refusing the owner's own localhost (field, Oct 20 - Nov 2:
// "http://127.0.0.1:5183/ is outside the served folder" x7; owner: "open the
// forge ide at http://127.0.0.1:5183" got 5 refusals). The dev server is
// fronted at another origin, and the open then navigated to the address the
// model asked for, which the served-page connector refused. Now the asked-for
// origin is an alias of the fronted page, and any other loopback port is
// re-routed into the Forge instead of refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";

process.env.ARES_HOME ??= mkdtempSync(path.join(tmpdir(), "ares-forge-local-home-"));
import { serveLocalTarget, serveDevServer, stopPreviewServers, waitForDrivablePage } from "../packages/cli/dist/entry/previewServer.js";
import { createServedPageBrowser } from "../packages/cli/dist/entry/servedPageBrowser.js";

/** A fake open page on `served`: answers `state` with its url, like pageDriverSource. */
function fakePage(t, served, id, title) {
  let running = true;
  const seen = [];
  const loop = (async () => {
    while (running) {
      const res = await fetch(`${served.origin}/__ares/drive?page=${id}&url=${encodeURIComponent(served.url)}`).catch(() => null);
      if (!res || res.status !== 200) continue;
      const cmd = await res.json();
      seen.push(cmd.op);
      const reply = cmd.op === "state" ? { id: cmd.id, ok: true, value: { url: served.url, title } } : { id: cmd.id, ok: false, error: `no ${cmd.op}` };
      await fetch(`${served.origin}/__ares/drive?page=${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) }).catch(() => null);
    }
  })();
  return { seen, stop: async () => { running = false; await loop.catch(() => undefined); } };
}

/** Stop every fake page first, then the servers (a page still polling a
 *  closed server would spin). */
function teardown(t, pages) {
  t.after(async () => {
    const stopping = pages.map((p) => p.stop());
    await stopPreviewServers();
    await Promise.all(stopping);
  });
}

test("opening the dev server's own address drives the fronted page instead of refusing it", async (t) => {
  const dev = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><head><title>IDE</title></head><body>ide</body></html>"); });
  await new Promise((r) => dev.listen(0, "127.0.0.1", r));
  t.after(() => dev.close());
  const devUrl = `http://127.0.0.1:${dev.address().port}/`;
  const fronted = await serveDevServer(devUrl);
  assert.ok(fronted);
  teardown(t, [fakePage(t, fronted, "ide1", "IDE")]);
  const page = await waitForDrivablePage(fronted.root, 3000);
  const br = createServedPageBrowser(fronted.root, fronted.origin, page, { aliases: { [new URL(devUrl).origin]: fronted.origin } });
  const state = await br.navigate(devUrl);
  assert.equal(state.title, "IDE", "the asked-for 127.0.0.1:<port> address is the page in the Forge");
  // localhost names the same server too, once known as an alias
  const br2 = createServedPageBrowser(fronted.root, fronted.origin, page, { aliases: { [`http://localhost:${dev.address().port}`]: fronted.origin } });
  assert.equal((await br2.navigate(`http://localhost:${dev.address().port}/`)).title, "IDE");
});

test("another local port is re-routed into the Forge, not refused as outside the served folder", async (t) => {
  const a = await mkdtemp(path.join(tmpdir(), "ares-forge-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "ares-forge-b-"));
  t.after(async () => { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); });
  await writeFile(path.join(a, "index.html"), "<!doctype html><title>A</title>");
  await mkdir(b, { recursive: true });
  await writeFile(path.join(b, "index.html"), "<!doctype html><title>B</title>");
  const servedA = await serveLocalTarget(path.join(a, "index.html"));
  const servedB = await serveLocalTarget(path.join(b, "index.html"));
  teardown(t, [fakePage(t, servedA, "pa", "A"), fakePage(t, servedB, "pb", "B")]);
  const pageA = await waitForDrivablePage(servedA.root, 3000);
  const pageB = await waitForDrivablePage(servedB.root, 3000);

  const rerouted = [];
  const br = createServedPageBrowser(servedA.root, servedA.origin, pageA, {
    reroute: async (url) => { rerouted.push(url); return { root: servedB.root, origin: servedB.origin, url: servedB.url, page: pageB }; },
  });
  const state = await br.navigate("http://127.0.0.1:5183/");
  assert.deepEqual(rerouted, ["http://127.0.0.1:5183/"]);
  assert.equal(state.title, "B", "the Forge now shows (and Ares drives) the other local page");
  assert.equal(br.strategy, `page:${servedB.origin}`, "later calls continue on the new page");

  const nothing = createServedPageBrowser(servedA.root, servedA.origin, pageA, { reroute: async () => null });
  await assert.rejects(() => nothing.navigate("http://[::1]:5999/"), /Nothing is running at http:\/\/\[::1\]:5999/);
  await assert.rejects(() => nothing.navigate("https://example.com/"), /is a website, not this local page/);
});
