// /gateway/file streams: HTTP Range (206/416), HEAD, abort cleanup, no
// buffering, the broadened type table, and the page sandbox.
//
// AVPlayer will not start a progressive mp4 against a server that answers 200
// with the whole body and no Accept-Ranges — so the phone could never play a
// video Ares made. These tests go through a real RemoteAgentServer.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { ARTIFACT_TYPES, PAGE_CSP, MAX_FILE_BYTES, parseRange, mayServe } from "../packages/cli/dist/phoneFile.js";
import { listArtifacts, kindOfExtension } from "../packages/cli/dist/phoneLibrary.js";


/** An absolute path spelled as a URL path, the way the phone builds it:
 *  POSIX as-is, Windows "C:\a\b" as "/C:/a/b" (the server strips the slash). */
const urlPath = (p) => (/^[A-Za-z]:[\\/]/.test(p) ? "/" + p.replaceAll("\\", "/") : p);

const SIZE = 5 * 1024 * 1024;
const AUTH = { authorization: "Bearer tok" };

/** Deterministic, position-dependent bytes so a wrong offset is always visible. */
function pattern(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 8) + (i >> 16)) & 255;
  return b;
}

async function tmp(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A server whose artifact roots are the Ares home and a separate workspace. */
async function world(t, { nestWorkspace = false } = {}) {
  const home = await tmp(t, "ares-range-home-");
  const work = nestWorkspace ? path.join(home, "workspace") : await tmp(t, "ares-range-work-");
  await fsp.mkdir(work, { recursive: true });
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", home,
    phoneApi: { artifactRoots: [home, work] },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const url = (p) => `${base}/gateway/file?path=${encodeURIComponent(p)}`;
  const get = (p, headers = {}, method = "GET") => fetch(url(p), { method, headers: { ...AUTH, ...headers } });
  return { home, work, server, base, url, get };
}

async function bytesOf(res) {
  return Buffer.from(await res.arrayBuffer());
}

test("a full GET is 200, streamed from the file, and advertises Accept-Ranges", async (t) => {
  const w = await world(t);
  const data = pattern(SIZE);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, data);
  const res = await w.get(file);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-length"), String(SIZE));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("last-modified"));
  assert.match(res.headers.get("etag"), /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok((await bytesOf(res)).equals(data), "every byte, in order");
});

test("Range: first, middle and last byte come back as 206 with exact bytes", async (t) => {
  const w = await world(t);
  const data = pattern(SIZE);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, data);
  const cases = [
    ["bytes=0-0", 0, 0],
    ["bytes=0-1023", 0, 1023],
    ["bytes=1000000-1999999", 1_000_000, 1_999_999],
    [`bytes=${SIZE - 1}-${SIZE - 1}`, SIZE - 1, SIZE - 1],
    [`bytes=${SIZE - 10}-${SIZE - 1}`, SIZE - 10, SIZE - 1],
  ];
  for (const [header, start, end] of cases) {
    const res = await w.get(file, { range: header });
    assert.equal(res.status, 206, header);
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${SIZE}`, header);
    assert.equal(res.headers.get("content-length"), String(end - start + 1), header);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.ok((await bytesOf(res)).equals(data.subarray(start, end + 1)), `bytes for ${header}`);
  }
});

test("Range: a suffix range is the last n bytes; one longer than the file is all of it", async (t) => {
  const w = await world(t);
  const data = pattern(SIZE);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, data);
  const tail = await w.get(file, { range: "bytes=-1024" });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), `bytes ${SIZE - 1024}-${SIZE - 1}/${SIZE}`);
  assert.ok((await bytesOf(tail)).equals(data.subarray(SIZE - 1024)));

  const huge = await w.get(file, { range: `bytes=-${SIZE * 4}` });
  assert.equal(huge.status, 206);
  assert.equal(huge.headers.get("content-range"), `bytes 0-${SIZE - 1}/${SIZE}`);
  assert.ok((await bytesOf(huge)).equals(data));
});

test("Range: open-ended and over-long ends are served from start to the last byte", async (t) => {
  const w = await world(t);
  const data = pattern(SIZE);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, data);
  const open = await w.get(file, { range: `bytes=${SIZE - 500}-` });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("content-range"), `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
  assert.ok((await bytesOf(open)).equals(data.subarray(SIZE - 500)));

  const zero = await w.get(file, { range: "bytes=0-" });
  assert.equal(zero.status, 206, "AVPlayer's opening probe: bytes=0-");
  assert.equal(zero.headers.get("content-range"), `bytes 0-${SIZE - 1}/${SIZE}`);
  assert.ok((await bytesOf(zero)).equals(data));

  const clamped = await w.get(file, { range: `bytes=${SIZE - 100}-${SIZE * 3}` });
  assert.equal(clamped.status, 206);
  assert.equal(clamped.headers.get("content-range"), `bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`);
  assert.ok((await bytesOf(clamped)).equals(data.subarray(SIZE - 100)));
});

test("Range: an unsatisfiable range is 416 with the size, and leaks no bytes", async (t) => {
  const w = await world(t);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, pattern(SIZE));
  for (const header of [`bytes=${SIZE}-`, `bytes=${SIZE + 10}-${SIZE + 20}`, "bytes=99999999999-", "bytes=-0"]) {
    const res = await w.get(file, { range: header });
    assert.equal(res.status, 416, header);
    assert.equal(res.headers.get("content-range"), `bytes */${SIZE}`, header);
    assert.ok(!res.headers.get("content-type").startsWith("video/"), "an error body, not file bytes");
    await res.arrayBuffer();
  }
  // An empty file can satisfy no byte range, but a plain GET of it is fine.
  const empty = path.join(w.work, "empty.mp4");
  await fsp.writeFile(empty, "");
  assert.equal((await w.get(empty, { range: "bytes=0-" })).status, 416);
  const whole = await w.get(empty);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), "0");
});

test("Range: a header the RFC says to ignore is ignored — the whole file, 200", async (t) => {
  const w = await world(t);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, pattern(SIZE));
  for (const header of ["bytes=abc", "items=0-5", "bytes=5-2", "bytes=0-1,5-6", "bytes=", "bytes=-", "bytes", "garbage", "bytes=1.5-3", "bytes=0-99999999999999999999"]) {
    const res = await w.get(file, { range: header });
    assert.equal(res.status, 200, `ignored: ${header}`);
    assert.equal(res.headers.get("content-length"), String(SIZE), header);
    assert.equal(res.headers.get("content-range"), null, header);
    await res.body.cancel();
  }
});

test("If-Range: the range is honoured while the validator matches, dropped once it does not", async (t) => {
  const w = await world(t);
  const data = pattern(SIZE);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, data);
  const first = await w.get(file, { range: "bytes=0-9" });
  const etag = first.headers.get("etag");
  const lastModified = first.headers.get("last-modified");
  await first.arrayBuffer();

  const fresh = await w.get(file, { range: "bytes=10-19", "if-range": etag });
  assert.equal(fresh.status, 206);
  assert.ok((await bytesOf(fresh)).equals(data.subarray(10, 20)));
  const freshDate = await w.get(file, { range: "bytes=10-19", "if-range": lastModified });
  assert.equal(freshDate.status, 206);
  await freshDate.arrayBuffer();

  const stale = await w.get(file, { range: "bytes=10-19", "if-range": '"not-the-etag"' });
  assert.equal(stale.status, 200, "a stale partial copy is replaced by the whole current file");
  assert.equal(stale.headers.get("content-length"), String(SIZE));
  await stale.body.cancel();
});

test("HEAD answers exactly what GET would, with no body", async (t) => {
  const w = await world(t);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, pattern(SIZE));

  const head = await w.get(file, {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(SIZE));
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal((await bytesOf(head)).length, 0);

  const ranged = await w.get(file, { range: "bytes=100-199" }, "HEAD");
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 100-199/${SIZE}`);
  assert.equal(ranged.headers.get("content-length"), "100");
  assert.equal((await bytesOf(ranged)).length, 0);

  const unsat = await w.get(file, { range: `bytes=${SIZE}-` }, "HEAD");
  assert.equal(unsat.status, 416);

  const missing = await w.get(path.join(w.work, "nope.mp4"), {}, "HEAD");
  assert.equal(missing.status, 404);
  assert.equal((await bytesOf(missing)).length, 0);

  // /shot is the image-only alias; HEAD goes through the same gate.
  const png = path.join(w.work, "a.png");
  await fsp.writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const shot = await fetch(`${w.base}/gateway/shot?path=${encodeURIComponent(png)}`, { method: "HEAD", headers: AUTH });
  assert.equal(shot.status, 200);
  const notImage = await fetch(`${w.base}/gateway/shot?path=${encodeURIComponent(file)}`, { method: "HEAD", headers: AUTH });
  assert.equal(notImage.status, 404, "/shot stays image-only");
});

test("no bearer, or the wrong one, is 401 on GET, HEAD and ranged requests", async (t) => {
  const w = await world(t);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, pattern(1024));
  for (const method of ["GET", "HEAD"]) {
    for (const headers of [{}, { range: "bytes=0-9" }, { authorization: "Bearer wrong" }, { authorization: "Basic tok" }]) {
      const res = await fetch(w.url(file), { method, headers });
      assert.equal(res.status, 401, `${method} ${JSON.stringify(headers)}`);
      await res.arrayBuffer();
    }
  }
  const pathStyle = await fetch(`${w.base}/gateway/file${urlPath(file)}`);
  assert.equal(pathStyle.status, 401, "the path-in-URL spelling needs the bearer too");
});

test("containment is unchanged: outside the roots, traversal, symlinks and secrets are all refused", async (t) => {
  const w = await world(t);
  const outside = await tmp(t, "ares-range-outside-");
  await fsp.writeFile(path.join(outside, "secret.mp4"), "SECRET VIDEO");
  await fsp.writeFile(path.join(w.work, "ok.mp4"), "fine");
  await fsp.writeFile(path.join(w.home, "auth.json"), '{"token":"sk-live"}');
  await fsp.writeFile(path.join(w.work, "deploy.key"), "KEY");
  await fsp.mkdir(path.join(w.work, ".git"), { recursive: true });
  await fsp.writeFile(path.join(w.work, ".git", "config.json"), "{}");
  await fsp.mkdir(path.join(w.work, "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(w.work, "node_modules", "x.mp4"), "x");
  await fsp.symlink(path.join(outside, "secret.mp4"), path.join(w.work, "bait.mp4"));
  await fsp.symlink(outside, path.join(w.work, "linkdir"));
  await fsp.symlink(path.join(w.home, "auth.json"), path.join(w.work, "bait.png"));
  await fsp.symlink(path.join(w.work, "ok.mp4"), path.join(w.work, "alias.mp4"));
  await fsp.mkdir(path.join(w.work, "dir.mp4"));

  const refused = [
    path.join(outside, "secret.mp4"),
    path.join(w.work, "bait.mp4"),                 // symlink out of the roots
    path.join(w.work, "linkdir", "secret.mp4"),    // symlinked directory out of the roots
    path.join(w.work, "bait.png"),                 // symlink INTO the home at a restricted file
    `${w.work}/../x.mp4`,                          // raw traversal, not pre-normalised by path.join
    `${w.work}/../${path.basename(outside)}/secret.mp4`,
    path.join(w.home, "auth.json"),                // restricted kind in the home proper
    path.join(w.work, "deploy.key"),
    path.join(w.work, ".git", "config.json"),
    path.join(w.work, "node_modules", "x.mp4"),
    path.join(w.work, "dir.mp4"),                  // a directory is not a file
    path.join(w.work, "missing.mp4"),
    "/etc/passwd",
    "/etc/hosts",
    "",
  ];
  for (const p of refused) {
    for (const extra of [{}, { range: "bytes=0-3" }]) {
      const res = await w.get(p, extra);
      assert.equal(res.status, 404, `refused: ${JSON.stringify(p)} ${JSON.stringify(extra)}`);
      assert.equal((await res.text()).includes("SECRET"), false);
    }
  }
  const alias = await w.get(path.join(w.work, "alias.mp4"));
  assert.equal(alias.status, 200, "a symlink that stays inside the roots still works");
  assert.equal(await alias.text(), "fine");
  const ranged = await w.get(path.join(w.work, "ok.mp4"), { range: "bytes=1-2" });
  assert.equal(await ranged.text(), "in");
});

test("the same refusals hold for the path-in-URL spelling", async (t) => {
  const w = await world(t);
  const outside = await tmp(t, "ares-range-outside-");
  await fsp.writeFile(path.join(outside, "secret.mp4"), "SECRET VIDEO");
  await fsp.writeFile(path.join(w.work, "ok.mp4"), "fine");
  await fsp.symlink(path.join(outside, "secret.mp4"), path.join(w.work, "bait.mp4"));
  const at = (raw, headers = {}) => fetch(`${w.base}/gateway/file${urlPath(raw)}`, { headers: { ...AUTH, ...headers } });

  const ok = await at(`${w.work}/ok.mp4`, { range: "bytes=1-2" });
  assert.equal(ok.status, 206);
  assert.equal(await ok.text(), "in");

  const refused = [
    `${outside}/secret.mp4`,
    `${w.work}/bait.mp4`,
    `${w.work}/../${path.basename(outside)}/secret.mp4`,
    `${w.work}/%2e%2e/${path.basename(outside)}/secret.mp4`,
    `${w.work}/..%2f${path.basename(outside)}%2fsecret.mp4`,
    `/etc/passwd`,
    `${w.work}/ok.mp4%00.png`,
    `${w.work}/%ZZ.mp4`,
    `${w.home}/auth.json`,
  ];
  for (const raw of refused) {
    const res = await at(raw);
    assert.equal(res.status, 404, `refused ${raw}`);
    assert.equal((await res.text()).includes("SECRET"), false);
  }
});

test("a made page finds its sibling picture at the path-shaped URL", async (t) => {
  const w = await world(t);
  await fsp.mkdir(path.join(w.work, "site", "img"), { recursive: true });
  await fsp.writeFile(path.join(w.work, "site", "index.html"), '<img src="img/cat.png"><video src="../clip.mp4"></video>');
  await fsp.writeFile(path.join(w.work, "site", "img", "cat.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await fsp.writeFile(path.join(w.work, "clip.mp4"), "video");
  const page = `${w.base}/gateway/file${urlPath(w.work).split("/").map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/")}/site/index.html`;
  const res = await fetch(page, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  // Exactly what a browser does with the relative references in that page:
  for (const [ref, expect] of [["img/cat.png", "image/png"], ["../clip.mp4", "video/mp4"]]) {
    const sibling = await fetch(new URL(ref, page), { headers: AUTH });
    assert.equal(sibling.status, 200, ref);
    assert.equal(sibling.headers.get("content-type"), expect, ref);
    await sibling.arrayBuffer();
  }
});

test("the page sandbox: siblings may load, nothing may leave", async (t) => {
  const w = await world(t);
  await fsp.writeFile(path.join(w.work, "page.html"), "<script>1</script>");
  await fsp.writeFile(path.join(w.work, "art.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fsp.writeFile(path.join(w.work, "a.png"), "png");

  for (const name of ["page.html", "art.svg"]) {
    const res = await w.get(path.join(w.work, name));
    assert.equal(res.status, 200, name);
    const csp = res.headers.get("content-security-policy");
    assert.equal(csp, PAGE_CSP, `${name} is boxed by PAGE_CSP`);
    await res.arrayBuffer();
  }
  const png = await w.get(path.join(w.work, "a.png"));
  assert.equal(png.headers.get("content-security-policy"), null, "CSP is for documents, not images");
  await png.arrayBuffer();

  // The string itself — the contract the phone's viewer relies on.
  const directives = Object.fromEntries(PAGE_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...vals]) => [name, vals]));
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["img-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(directives["media-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(directives["connect-src"], ["'none'"], "no fetch / XHR / WebSocket / beacon");
  assert.deepEqual(directives["script-src"], ["'unsafe-inline'", "'unsafe-eval'"], "inline only: a sibling .js can never run");
  assert.deepEqual(directives["style-src"], ["'unsafe-inline'"]);
  assert.deepEqual(directives["font-src"], ["data:"]);
  assert.equal(directives["frame-src"], undefined, "frames fall back to default-src 'none'");
  assert.equal(directives["object-src"], undefined, "objects fall back to default-src 'none'");
  assert.doesNotMatch(PAGE_CSP, /https?:|\*|wss?:/, "no network origin anywhere");
});

test("the new types are served with the right content types, and code is text, never script", async (t) => {
  const w = await world(t);
  const expected = {
    mov: "video/quicktime", m4v: "video/x-m4v", "3gp": "video/3gpp", webm: "video/webm", mp4: "video/mp4",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", caf: "audio/x-caf",
    flac: "audio/flac", ogg: "audio/ogg", mp3: "audio/mpeg",
    heic: "image/heic", avif: "image/avif", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff",
    json: "application/json; charset=utf-8", log: "text/plain; charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    glb: "model/gltf-binary", gltf: "model/gltf+json", zip: "application/zip",
    js: "text/plain; charset=utf-8", mjs: "text/plain; charset=utf-8", ts: "text/plain; charset=utf-8", tsx: "text/plain; charset=utf-8",
    py: "text/plain; charset=utf-8", sh: "text/plain; charset=utf-8", ps1: "text/plain; charset=utf-8", css: "text/plain; charset=utf-8",
    xml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8", rs: "text/plain; charset=utf-8", swift: "text/plain; charset=utf-8",
  };
  for (const [ext, type] of Object.entries(expected)) {
    const file = path.join(w.work, `thing.${ext}`);
    await fsp.writeFile(file, "x");
    const res = await w.get(file);
    assert.equal(res.status, 200, ext);
    assert.equal(res.headers.get("content-type"), type, ext);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", ext);
    assert.equal(res.headers.get("content-security-policy"), null, `${ext} is not a document`);
    await res.arrayBuffer();
  }
  // Nothing in the table can execute in a webview except the boxed pages.
  for (const [ext, type] of Object.entries(ARTIFACT_TYPES)) {
    if (type.startsWith("text/html")) { assert.ok(ext === ".html" || ext === ".htm"); continue; }
    if (ext === ".svg") continue; // a document too, and boxed by PAGE_CSP (asserted above)
    assert.doesNotMatch(type, /javascript|ecmascript|x-sh|x-python|xhtml|\bxml\b/, `${ext} must not be served as something a viewer runs`);
  }
  assert.equal(ARTIFACT_TYPES[".js"], "text/plain; charset=utf-8");
  // What was never servable still is not.
  for (const ext of ["exe", "dll", "so", "sqlite", "db", "env", "pem", "p8", "key", "bin", "dmg", "apk", "docm"]) {
    const file = path.join(w.work, `thing.${ext}`);
    await fsp.writeFile(file, "x");
    assert.equal((await w.get(file)).status, 404, ext);
  }
});

test("data, code and archives do not leave the Ares home proper — only what Ares made there does", async (t) => {
  const w = await world(t);
  for (const d of ["forge", "media/2026-09-30", "telemetry", "oauth"]) await fsp.mkdir(path.join(w.home, d), { recursive: true });
  const put = (p, body = "x") => fsp.writeFile(path.join(w.home, p), body);
  await put("auth.json", '{"access_token":"x"}');
  await put("kimi-auth.json");
  await put("settings.json");
  await put("oauth/google.json");
  await put("telemetry/events.log");
  await put("backup.zip");
  await put("hook.sh");
  await put("forge/report.json");
  await put("forge/tool.py");
  await put("forge/notes.txt");
  await put("media/2026-09-30/clip.mov");
  await put("media/2026-09-30/meta.json");
  await fsp.writeFile(path.join(w.work, "data.json"), "{}");
  await fsp.writeFile(path.join(w.work, "run.log"), "log");
  await fsp.writeFile(path.join(w.work, "app.ts"), "export {}");

  const status = async (p) => (await w.get(p)).status;
  for (const p of ["auth.json", "kimi-auth.json", "settings.json", "oauth/google.json", "telemetry/events.log", "backup.zip", "hook.sh"]) {
    assert.equal(await status(path.join(w.home, p)), 404, `home proper: ${p}`);
  }
  for (const p of ["forge/report.json", "forge/tool.py", "forge/notes.txt", "media/2026-09-30/clip.mov", "media/2026-09-30/meta.json"]) {
    assert.equal(await status(path.join(w.home, p)), 200, `made by Ares: ${p}`);
  }
  for (const p of ["data.json", "run.log", "app.ts"]) assert.equal(await status(path.join(w.work, p)), 200, `workspace: ${p}`);

  // Existing behaviour for looked-at types is untouched: a home-root text file still opens.
  await put("today.txt", "hello");
  assert.equal(await status(path.join(w.home, "today.txt")), 200);
});

test("a workspace kept under the home is a project; a workspace that contains the home does not expose it", async (t) => {
  const nested = await world(t, { nestWorkspace: true });
  await fsp.writeFile(path.join(nested.work, "app.js"), "1");
  await fsp.writeFile(path.join(nested.home, "auth.json"), "{}");
  assert.equal((await nested.get(path.join(nested.work, "app.js"))).status, 200);
  assert.equal((await nested.get(path.join(nested.home, "auth.json"))).status, 404);

  const parent = await tmp(t, "ares-range-parent-");
  const home = path.join(parent, ".ares");
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, "auth.json"), "{}");
  await fsp.writeFile(path.join(parent, "app.js"), "1");
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", home, phoneApi: { artifactRoots: [parent] } });
  await server.start();
  t.after(() => server.close());
  const at = (p) => fetch(`http://127.0.0.1:${server.port}/gateway/file?path=${encodeURIComponent(p)}`, { headers: AUTH });
  assert.equal((await at(path.join(parent, "app.js"))).status, 200);
  assert.equal((await at(path.join(home, "auth.json"))).status, 404, "workspace = $HOME must not open ~/.ares");
});

// ── streaming, not buffering ────────────────────────────────────────────────

const BIG = 512 * 1024 * 1024;

async function bigSparse(t, dir) {
  const file = path.join(dir, "big.mp4");
  try {
    const fh = await fsp.open(file, "w");
    await fh.truncate(BIG);
    await fh.close();
  } catch {
    t.skip("cannot create a large sparse file here");
    return null;
  }
  return file;
}

function openFdsTo(file) {
  const dir = "/proc/self/fd";
  const real = fs.realpathSync(file);
  let n = 0;
  for (const fd of fs.readdirSync(dir)) {
    try { if (fs.readlinkSync(path.join(dir, fd)) === real) n++; } catch { /* closed under us */ }
  }
  return n;
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a client that goes away mid-stream releases the file", async (t) => {
  if (process.platform !== "linux") return t.skip("needs /proc/self/fd");
  const w = await world(t);
  const file = await bigSparse(t, w.work);
  if (!file) return;
  assert.equal(openFdsTo(file), 0);

  // Several slow phones at once, so a leak is a COUNT that stays up — a single
  // abandoned stream could be closed by the garbage collector inside the wait.
  const PHONES = 4;
  const open = await Promise.all(Array.from({ length: PHONES }, () => new Promise((resolve, reject) => {
    const req = http.get(`${w.base}/gateway/file?path=${encodeURIComponent(file)}`, { headers: { ...AUTH, range: "bytes=0-" } }, (res) => resolve({ res, req }));
    req.on("error", reject);
  })));
  for (const { res } of open) {
    assert.equal(res.statusCode, 206);
    res.pause(); // a slow phone: the server's stream backs up and holds the file open
  }
  assert.equal(await until(() => openFdsTo(file) === PHONES), true, `the server holds the file once per live stream (saw ${openFdsTo(file)})`);
  for (const { res, req } of open) { res.destroy(); req.destroy(); } // the app was backgrounded
  assert.equal(await until(() => openFdsTo(file) === 0, 1500), true, `every descriptor is released once the clients are gone (${openFdsTo(file)} left)`);

  // …and the server is still perfectly good.
  const after = await w.get(file, { range: "bytes=0-9" });
  assert.equal(after.status, 206);
  assert.equal((await bytesOf(after)).length, 10);
  assert.equal(await until(() => openFdsTo(file) === 0), true);
});

test("a finished request and a HEAD/416 leave nothing open either", async (t) => {
  if (process.platform !== "linux") return t.skip("needs /proc/self/fd");
  const w = await world(t);
  const file = path.join(w.work, "clip.mp4");
  await fsp.writeFile(file, pattern(SIZE));
  await (await w.get(file)).arrayBuffer();
  await (await w.get(file, { range: "bytes=10-20" })).arrayBuffer();
  await (await w.get(file, {}, "HEAD")).arrayBuffer();
  await (await w.get(file, { range: `bytes=${SIZE}-` })).arrayBuffer();
  await (await w.get(file, { range: "bytes=1-2" }, "HEAD")).arrayBuffer();
  assert.equal(await until(() => openFdsTo(file) === 0), true);
});

test("serving a large file does not buffer it: memory is not proportional to the file", async (t) => {
  const w = await world(t);
  const file = await bigSparse(t, w.work);
  if (!file) return;
  if (global.gc) global.gc();
  const before = process.memoryUsage();
  // Ask for the whole thing, read only the first chunks, then hang up — what a
  // video scrubber does. A readFile() of 512 MiB would put ~512 MiB in RSS.
  const res = await w.get(file, { range: "bytes=0-" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), String(BIG));
  const reader = res.body.getReader();
  let got = 0;
  while (got < 1024 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
  }
  const during = process.memoryUsage();
  await reader.cancel();
  assert.ok(got >= 1024 * 1024);
  const grew = during.rss - before.rss;
  assert.ok(grew < 160 * 1024 * 1024, `RSS grew ${(grew / 1048576).toFixed(0)} MiB serving a ${BIG / 1048576} MiB file`);
  assert.ok(during.external - before.external < 160 * 1024 * 1024, "no file-sized Buffer was allocated");
});

test("the size ceiling is a clear 413, not a truncation or an out-of-memory", async (t) => {
  if (process.platform !== "linux") return t.skip("a sparse file over the ceiling needs a sparse filesystem");
  const w = await world(t);
  const file = path.join(w.work, "absurd.mp4");
  try {
    const fh = await fsp.open(file, "w");
    await fh.truncate(MAX_FILE_BYTES + 1);
    await fh.close();
  } catch {
    return t.skip("cannot create a sparse file over the ceiling here");
  }
  assert.equal(MAX_FILE_BYTES, 4 * 1024 ** 3);
  for (const method of ["GET", "HEAD"]) {
    const res = await w.get(file, { range: "bytes=0-9" }, method);
    assert.equal(res.status, 413, method);
    await res.arrayBuffer();
  }
});

test("a FIFO named like a video is refused, not waited on", { skip: process.platform === "win32" }, async (t) => {
  const w = await world(t);
  const fifo = path.join(w.work, "pipe.mp4");
  try { execFileSync("mkfifo", [fifo]); } catch { return t.skip("no mkfifo"); }
  const res = await Promise.race([
    w.get(fifo),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the open blocked on the FIFO")), 4000)),
  ]);
  assert.equal(res.status, 404);
});

// ── parseRange, in isolation ────────────────────────────────────────────────

test("parseRange follows RFC 9110 for one byte range", () => {
  assert.deepEqual(parseRange("bytes=0-0", 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange("bytes=2-500", 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange(" Bytes = 1-2 ", 10), { start: 1, end: 2 }, "unit is case-insensitive; whitespace tolerated");
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=10-12", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=-5", 0), "unsatisfiable");
  for (const ignored of [undefined, "", "bytes=", "bytes=-", "bytes=a-b", "bytes=5-2", "bytes=0-1,3-4", "pages=1-2", "0-5", "bytes=1-2-3", "bytes=-5-", "bytes=1234567890123456-"]) {
    assert.equal(parseRange(ignored, 10), null, String(ignored));
  }
});

// ── the listing ─────────────────────────────────────────────────────────────

test("every servable extension has a kind, so nothing servable is silently unlisted", () => {
  for (const ext of Object.keys(ARTIFACT_TYPES)) assert.ok(kindOfExtension(ext), `${ext} is servable but has no library kind`);
  const expected = {
    video: ["mp4", "mov", "m4v", "webm", "3gp"],
    audio: ["mp3", "m4a", "aac", "wav", "aif", "aiff", "caf", "flac", "ogg"],
    image: ["png", "jpg", "jpeg", "webp", "gif", "svg", "heic", "avif", "bmp", "tiff"],
    document: ["pdf", "md", "txt", "csv", "docx", "xlsx", "pptx"],
    page: ["html", "htm"],
    code: ["js", "ts", "py", "sh", "css"],
    data: ["json", "log"],
    model: ["glb", "gltf"],
    archive: ["zip"],
  };
  for (const [kind, exts] of Object.entries(expected)) for (const ext of exts) assert.equal(kindOfExtension(`.${ext}`), kind, ext);
});

test("the library lists the new kinds with size and mtime, and leaves a project's source out", async (t) => {
  const w = await world(t);
  const day = path.join(w.home, "media", "2026-09-30");
  await fsp.mkdir(day, { recursive: true });
  await fsp.mkdir(path.join(w.work, "src"), { recursive: true });
  await fsp.writeFile(path.join(day, "voice.m4a"), "m4a-bytes");
  await fsp.writeFile(path.join(day, "take.wav"), "wav-bytes");
  await fsp.writeFile(path.join(day, "clip.mov"), "mov-bytes");
  await fsp.writeFile(path.join(day, "photo.heic"), "heic");
  await fsp.writeFile(path.join(day, "meta.json"), '{"a":1}');
  await fsp.mkdir(path.join(w.home, "forge"), { recursive: true });
  await fsp.writeFile(path.join(w.home, "forge", "scene.glb"), "glb");
  await fsp.writeFile(path.join(w.home, "forge", "export.zip"), "zip");
  await fsp.writeFile(path.join(w.home, "forge", "tool.py"), "print(1)");
  await fsp.writeFile(path.join(w.home, "auth.json"), "{}"); // not under media/forge: never listed
  await fsp.writeFile(path.join(w.work, "index.html"), "<h1>hi</h1>");
  await fsp.writeFile(path.join(w.work, "brief.docx"), "docx");
  await fsp.writeFile(path.join(w.work, "src", "main.ts"), "export {}");
  await fsp.writeFile(path.join(w.work, "package.json"), "{}");

  const res = await fetch(`${w.base}/gateway/artifacts`, { headers: AUTH });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  for (const [name, kind] of [
    ["voice.m4a", "audio"], ["take.wav", "audio"], ["clip.mov", "video"], ["photo.heic", "image"], ["meta.json", "data"],
    ["scene.glb", "model"], ["export.zip", "archive"], ["tool.py", "code"], ["index.html", "page"], ["brief.docx", "document"],
  ]) {
    assert.equal(byName[name]?.kind, kind, name);
    assert.equal(typeof byName[name].size, "number", `${name} size`);
    assert.ok(byName[name].size > 0);
    assert.ok(!Number.isNaN(Date.parse(byName[name].modifiedAt)), `${name} modifiedAt`);
    assert.ok(path.isAbsolute(byName[name].path));
  }
  assert.equal(byName["voice.m4a"].size, 9);
  assert.equal(byName["main.ts"], undefined, "a project's source is not 'something Ares made'");
  assert.equal(byName["package.json"], undefined);
  assert.equal(byName["auth.json"], undefined, "the home proper is never listed");

  // Every listed path is one the file server will actually serve.
  for (const item of items) {
    const served = await w.get(item.path, { range: "bytes=0-0" });
    assert.ok(served.status === 206 || served.status === 416, `${item.name} listed but ${served.status}`);
    await served.arrayBuffer();
  }
});

test("listArtifacts keeps listing everything when no project roots are given", async (t) => {
  const root = await tmp(t, "ares-lib-all-");
  await fsp.writeFile(path.join(root, "a.ts"), "export {}");
  await fsp.writeFile(path.join(root, "b.wav"), "w");
  const all = await listArtifacts({ roots: [[root, 2]], servable: () => true });
  assert.deepEqual(all.map((i) => i.name).sort(), ["a.ts", "b.wav"]);
  const quiet = await listArtifacts({ roots: [[root, 2]], servable: () => true, projectRoots: [root] });
  assert.deepEqual(quiet.map((i) => i.name), ["b.wav"]);
});

test("mayServe: the rule in one place", () => {
  const roots = ["/r/home", "/r/work"];
  assert.equal(mayServe(path.resolve("/r/work/a.mov"), roots, "/r/home"), true);
  assert.equal(mayServe(path.resolve("/r/work/a.exe"), roots, "/r/home"), false);
  assert.equal(mayServe(path.resolve("/elsewhere/a.mov"), roots, "/r/home"), false);
  assert.equal(mayServe(path.resolve("/r/home/a.json"), roots, "/r/home"), false);
  assert.equal(mayServe(path.resolve("/r/home/forge/a.json"), roots, "/r/home"), true);
  assert.equal(mayServe(path.resolve("/r/home/a.mov"), roots, "/r/home"), true, "media is open everywhere under a root");
  assert.equal(mayServe(path.resolve("/r/work/.git/a.json"), roots, "/r/home"), false);
});
