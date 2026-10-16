// "Open it in the Forge" for a project folder means HOSTING it. A file://
// preview breaks any page with <script type="module">, an import map, a
// root-relative asset or a relative fetch — the runestone session rendered a
// grey page that way (2026-10-15). Browser preview/open now serves a local
// file's folder on 127.0.0.1 and opens the http URL; the Forge embeds it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { serveFolder, serveLocalTarget, stopPreviewServers } from "../packages/cli/dist/entry/previewServer.js";

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "ares-preview-srv-"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><script type=\"module\" src=\"./app.js\"></script>");
  await writeFile(path.join(root, "app.js"), "export const ok = 1;");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "pic.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(path.dirname(root), "outside-" + path.basename(root) + ".txt"), "secret");
  return root;
}

test.after(() => stopPreviewServers());

test("a local index.html is served from its folder on loopback with the right types", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const served = await serveLocalTarget(pathToFileURL(path.join(root, "index.html")).href);
  assert.ok(served, "a file:// URL is a local target");
  assert.match(served.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(served.url, `${served.origin}/index.html`);
  assert.equal(served.root, root);

  const html = await fetch(served.url);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  const js = await fetch(`${served.origin}/app.js`);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await js.text(), "export const ok = 1;");
  const png = await fetch(`${served.origin}/assets/pic.png`);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.headers.get("cache-control"), "no-store");
});

test("a bare absolute path works too, a folder serves its index, and the same root reuses one server", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const byPath = await serveLocalTarget(path.join(root, "index.html"));
  const byDir = await serveLocalTarget(root);
  assert.ok(byPath && byDir);
  assert.equal(byPath.origin, byDir.origin, "one server per folder root");
  assert.equal(byDir.url, `${byDir.origin}/`);
  const res = await fetch(byDir.url);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /type="module"/);
  const again = await serveFolder(root);
  assert.equal(again.origin, byPath.origin);
});

test("nothing outside the folder is reachable; missing files are 404", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const served = await serveFolder(root);
  const traversal = await fetch(`${served.origin}/../outside-${path.basename(root)}.txt`);
  assert.notEqual(traversal.status, 200, "path traversal never reads outside root");
  const encoded = await fetch(`${served.origin}/..%2F..%2Fwindows%2Fwin.ini`);
  assert.notEqual(encoded.status, 200);
  const missing = await fetch(`${served.origin}/preview/_kit/model.js`);
  assert.equal(missing.status, 404, "an import the folder does not contain is a plain 404 the page can report");
  const post = await fetch(served.origin + "/index.html", { method: "POST" });
  assert.equal(post.status, 405);
});

test("non-local targets are left alone", async () => {
  assert.equal(await serveLocalTarget("http://localhost:1420/"), null);
  assert.equal(await serveLocalTarget("https://example.com/x"), null);
  assert.equal(await serveLocalTarget("about:blank"), null);
  assert.equal(await serveLocalTarget("data:text/html,hi"), null);
  assert.equal(await serveLocalTarget(path.join(tmpdir(), "does-not-exist-" + Date.now(), "index.html")), null, "a missing file is not served");
});
