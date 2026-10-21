// Browser devtools / profile — the Console + Performance tabs for the page
// Ares is driving (owner, 2026-10-21: "development console should be
// available to ares for its embedded browser like dev tools? traces").
//
//   1. devtools returns the uncaught error WITH its stack, console errors,
//      the 404, fps and page metrics; Ares's own /__ares/ traffic is left out.
//   2. profile names the hot function by file:line with its share of time.
//   3. Both are observe-only and refuse politely where there is no CDP page.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBrowserTool } from "../packages/cli/dist/entry/browserBridge.js";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

const SLOW = `<!doctype html><html><head><meta charset="utf-8"><title>slow</title></head><body><canvas id="c" width="200" height="100"></canvas><script>
function hotSpin(n) { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i); return x; }
function frame() { hotSpin(400000); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
setTimeout(() => { throw new Error("boom from slow"); }, 200);
console.error("an error log");
fetch("/missing.json").catch(() => {});
</script></body></html>`;

test("devtools and profile read the page like a person at the Console and Performance tabs", async (t) => {
  let pw;
  try { pw = await import("../packages/connectors/node_modules/playwright/index.mjs"); } catch { t.skip("playwright not installed"); return; }
  const port = 9400 + Math.floor(Math.random() * 400);
  let chromium;
  const args = [`--remote-debugging-port=${port}`];
  try { chromium = await pw.chromium.launch({ args }); }
  catch {
    try { chromium = await pw.chromium.launch({ args, executablePath: "/opt/pw-browsers/chromium" }); } catch { t.skip("no Chromium here"); return; }
  }
  await (await chromium.newContext()).newPage();
  const root = await mkdtemp(path.join(tmpdir(), "ares-devtools-"));
  const site = path.join(root, "site");
  await writeFile(path.join(root, "slow.html"), SLOW).catch(() => undefined);
  await rm(site, { recursive: true, force: true });
  const tool = makeBrowserTool({ browserFilmstripRoot: path.join(root, "strip") });
  const sig = { signal: new AbortController().signal, emitProgress: () => undefined };
  try {
    await withEnv({ ARES_FORGE_CDP_URL: `http://127.0.0.1:${port}`, ARES_BROWSER_CDP_DISCOVERY: "0", ARES_BROWSER_SCREENCAST: "0" }, async () => {
      const open = await tool.call({ action: "preview", url: path.join(root, "slow.html") }, sig);
      assert.equal(open.output.status, "ok");
      await new Promise((r) => setTimeout(r, 800));

      const dev = await tool.call({ action: "devtools" }, sig);
      const r = dev.output.result;
      assert.ok(r.errors.some((e) => e.message.includes("boom from slow") && /slow\.html/.test(e.stack ?? "")), `uncaught error with a stack: ${JSON.stringify(r.errors)}`);
      assert.ok(r.console.some((e) => e.text === "an error log"), "console.error is there");
      assert.ok(r.httpErrors.some((e) => e.url.endsWith("/missing.json") && e.status === 404), `the 404: ${JSON.stringify(r.httpErrors)}`);
      assert.ok(!r.failedRequests.some((f) => f.url.includes("/__ares/")), "Ares's own sensor traffic is not reported as the page's failure");
      assert.ok(!r.console.some((e) => e.text.includes("/__ares/")));
      assert.equal(typeof r.metrics.jsHeapMb, "number");
      assert.ok(r.metrics.domNodes > 0);
      assert.match(dev.output.note, /uncaught error/);
      assert.match(dev.display, /1 error/);

      const prof = await tool.call({ action: "profile", ms: 1200 }, sig);
      const top = prof.output.result.top;
      assert.equal(top[0].fn, "hotSpin", `hot function first: ${JSON.stringify(top.slice(0, 3))}`);
      assert.match(top[0].where, /slow\.html:2$/);
      assert.ok(top[0].pct > 1, `a share of time: ${top[0].pct}%`); // headless Chromium throttles rAF, so the share is small there
      assert.ok(prof.output.result.sampledMs >= 1000);
      assert.match(prof.display, /hotSpin/);
    });
  } finally {
    await tool.call({ action: "close" }, sig).catch(() => undefined);
    await chromium.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the schema teaches devtools and profile", () => {
  const schema = JSON.stringify(makeBrowserTool({ browserFilmstripRoot: tmpdir() }).schema.inputJsonSchema);
  assert.match(schema, /'devtools' = the Console \+ Performance tabs in one call/);
  assert.match(schema, /'profile' = a CPU profile/);
});
