// The phone's Goals tab and Artifacts | Media library.
// Goals are the owner's life goals (not Operator missions); the library lists
// only what /gateway/file will actually serve.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalsTool } from "../packages/tools/dist/index.js";
import { handleLibraryApi, listArtifacts } from "../packages/cli/dist/phoneLibrary.js";

async function tmp(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a goal is added, updated, listed on the tab, and closed from the phone", async (t) => {
  const home = await tmp(t, "ares-goals-");
  const prev = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = prev; });
  const signal = new AbortController().signal;
  const added = await GoalsTool.call({ action: "add", title: "Save $500 a month", category: "finance", target: "$6,000 by Dec 31", next_check_in: "2026-10-01" }, { signal });
  const id = added.output.goal.id;
  await GoalsTool.call({ action: "update", id, progress: 0.25, note: "On track" }, { signal });

  const server = http.createServer((req, res) => {
    void handleLibraryApi(req, res, new URL(req.url, "http://x"), { roots: [], servable: () => true, home }).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { goals } = await (await fetch(`${base}/gateway/goals`)).json();
  assert.equal(goals[0].title, "Save $500 a month");
  assert.equal(goals[0].progress, 0.25);
  assert.equal(goals[0].nextCheckIn, "2026-10-01T00:00:00.000Z");
  assert.equal((await fetch(`${base}/gateway/goals/close`, { method: "POST", body: JSON.stringify({ id }) })).status, 200);
  const after = await (await fetch(`${base}/gateway/goals`)).json();
  assert.equal(after.goals[0].status, "done");
  assert.equal((await fetch(`${base}/gateway/goals/close`, { method: "POST", body: JSON.stringify({ id: "nope" }) })).status, 404);
});

test("the library lists what Ares made, newest first, and nothing the file server would refuse", async (t) => {
  const root = await tmp(t, "ares-lib-");
  await fsp.mkdir(path.join(root, "media", "2026-09-23"), { recursive: true });
  await fsp.mkdir(path.join(root, "node_modules", "x"), { recursive: true });
  await fsp.mkdir(path.join(root, "secret"), { recursive: true });
  await fsp.writeFile(path.join(root, "media", "2026-09-23", "cat.png"), "png");
  await fsp.writeFile(path.join(root, "dashboard.html"), "<h1>hi</h1>");
  await fsp.writeFile(path.join(root, "README.md"), "# repo");
  await fsp.writeFile(path.join(root, "node_modules", "x", "page.html"), "x");
  await fsp.writeFile(path.join(root, "secret", "leak.html"), "x");
  await fsp.writeFile(path.join(root, "empty.pdf"), "");
  const later = new Date(Date.now() + 5000);
  await fsp.utimes(path.join(root, "dashboard.html"), later, later);
  const items = await listArtifacts({ roots: [[root, 3]], servable: (p) => !p.includes(`${path.sep}secret${path.sep}`) });
  assert.deepEqual(items.map((i) => i.name), ["dashboard.html", "cat.png"]);
  assert.equal(items[0].kind, "page");
  assert.equal(items[1].kind, "image");
});
