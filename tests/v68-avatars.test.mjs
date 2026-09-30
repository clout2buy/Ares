// Agent avatars — the phone's picture store (/gateway/avatars, /gateway/avatar/<id>).
//
// Pinned here:
//   1. The contract: list/probe, GET with ETag/304, PUT raw or JSON data URI,
//      DELETE both verbs, exact error codes.
//   2. The bytes decide: type is sniffed (JPEG/PNG/WebP magic), never taken from
//      the client; SVG/GIF/HTML/empty/garbled are refused; one file per agent.
//   3. The 2 MiB cap is exact, enforced while reading, and the server keeps
//      answering after a huge upload.
//   4. Ids cannot escape <home>/phone/avatars; files are 0600 in a 0700 dir.
//   5. The index survives a restart and skips junk.
//   6. Personas carry the avatar version (the default "ares" too), drop the
//      picture on delete, and "ares" edits now say where the picture goes.
//   7. All of it through a real RemoteAgentServer behind its bearer check.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AvatarStore, AVATAR_MAX_BYTES, createAvatarsApi, detectImage, handleAvatarsApi } from "../packages/cli/dist/phoneAvatars.js";

const MAX = 2 * 1024 * 1024;

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-avatars-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

// ── fixtures: the smallest byte strings that carry each magic ────────────────

const pad = (head, total, fill) => Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length), fill)]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_HEAD = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP")]);
const jpeg = (total = 64, fill = 0x11) => pad(JPEG_HEAD, total, fill);
const png = (total = 64, fill = 0x22) => pad(PNG_HEAD, total, fill);
const webp = (total = 64, fill = 0x33) => pad(WEBP_HEAD, total, fill);
const versionOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const dataUri = (bytes, type = "image/jpeg") => `data:${type};base64,${bytes.toString("base64")}`;

// ── a real http server around the handler, hit with raw paths ────────────────

/** `known` is mutable: tests add ids the way the garrison's persona store would. */
async function serve(t, home, { known = ["ares", "p_bob"], now, log } = {}) {
  const knownIds = new Set(known);
  const store = new AvatarStore(home, now ? { now } : {});
  await store.load();
  const lines = [];
  const deps = { store, known: (id) => knownIds.has(id), log: (line) => { lines.push(line); log?.(line); } };
  const closedReads = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handleAvatarsApi(req, res, url, deps))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  const opened = { count: 0 };
  server.on("connection", (sock) => {
    opened.count++;
    sock.once("close", () => closedReads.push(sock.bytesRead));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  return { port, store, known: knownIds, deps, lines, closedReads, opened, call: (method, route, opts) => request(port, method, route, opts) };
}

/** node:http on purpose: fetch() normalizes `..` and %2e out of the path before
 *  it leaves the client, and these tests are about what the SERVER does with them. */
function request(port, method, route, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: { ...(payload ? { "content-length": payload.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(parts);
        let json;
        if (String(res.headers["content-type"] ?? "").startsWith("application/json") && buf.length) json = JSON.parse(buf.toString("utf8"));
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const put = (srv, id, bytes, headers = { "content-type": "application/octet-stream" }) => srv.call("PUT", `/gateway/avatar/${id}`, { headers, body: bytes });
const putJson = (srv, id, image) => srv.call("PUT", `/gateway/avatar/${id}`, { headers: { "content-type": "application/json" }, body: { image } });

/** Every file under home, relative and slash-separated. */
async function filesUnder(home) {
  const names = await fs.readdir(home, { recursive: true }).catch(() => []);
  const out = [];
  for (const n of names) if ((await fs.stat(path.join(home, n))).isFile()) out.push(n.split(path.sep).join("/"));
  return out.sort();
}

// ── detection ────────────────────────────────────────────────────────────────

test("detectImage: JPEG, PNG and WebP by magic, nothing else", () => {
  assert.deepEqual(detectImage(jpeg()), { ext: "jpg", contentType: "image/jpeg" });
  assert.deepEqual(detectImage(png()), { ext: "png", contentType: "image/png" });
  assert.deepEqual(detectImage(webp()), { ext: "webp", contentType: "image/webp" });
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from([0xff, 0xd8]),
    PNG_HEAD.subarray(0, 7),
    Buffer.from("RIFF"),
    Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WAVE")]),
    Buffer.from("GIF89a" + "x".repeat(20)),
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    Buffer.from("<!doctype html><title>x</title>"),
    Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(8)]),
  ]) assert.equal(detectImage(bad), null, bad.subarray(0, 12).toString("latin1"));
});

// ── the contract ─────────────────────────────────────────────────────────────

test("avatars: empty list is also the capability probe", async (t) => {
  const srv = await serve(t, await tempHome(t));
  const res = await srv.call("GET", "/gateway/avatars");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { max: 2097152, types: ["image/jpeg", "image/png", "image/webp"], avatars: [] });
  assert.equal(AVATAR_MAX_BYTES, 2097152);
  assert.equal((await srv.call("GET", "/gateway/avatars/")).status, 200, "trailing slash");
  const wrong = await srv.call("POST", "/gateway/avatars", { body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "GET");
  assert.equal(wrong.json.code, "method_not_allowed");
  // Not ours: the bare path and unrelated siblings fall through to the router's 404.
  assert.equal((await srv.call("GET", "/gateway/avatar")).json.code, undefined);
  assert.equal((await srv.call("GET", "/gateway/avatarsx")).json.code, undefined);
});

test("avatars: PUT raw JPEG, GET it back byte for byte with cache headers and 304", async (t) => {
  const now = () => new Date("2026-09-30T12:00:00.000Z");
  const srv = await serve(t, await tempHome(t), { now });
  const image = jpeg(5000, 0x42);

  const saved = await put(srv, "ares", image, { "content-type": "image/jpeg" });
  assert.equal(saved.status, 200, saved.buf.toString());
  assert.deepEqual(saved.json, {
    avatar: { id: "ares", contentType: "image/jpeg", bytes: 5000, version: versionOf(image), updatedAt: "2026-09-30T12:00:00.000Z" },
  });
  assert.match(saved.json.avatar.version, /^[0-9a-f]{16}$/);

  const got = await srv.call("GET", "/gateway/avatar/ares");
  assert.equal(got.status, 200);
  assert.ok(got.buf.equals(image), "identical bytes");
  assert.equal(got.headers["content-type"], "image/jpeg");
  assert.equal(got.headers["content-length"], String(image.length));
  assert.equal(got.headers.etag, `"${versionOf(image)}"`);
  assert.equal(got.headers["cache-control"], "private, no-cache");
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.equal(got.headers["content-security-policy"], "default-src 'none'; sandbox");

  for (const inm of [`"${versionOf(image)}"`, `W/"${versionOf(image)}"`, `"zzz", "${versionOf(image)}"`, "*"]) {
    const cached = await srv.call("GET", "/gateway/avatar/ares", { headers: { "if-none-match": inm } });
    assert.equal(cached.status, 304, inm);
    assert.equal(cached.buf.length, 0);
    assert.equal(cached.headers.etag, `"${versionOf(image)}"`);
  }
  assert.equal((await srv.call("GET", "/gateway/avatar/ares", { headers: { "if-none-match": '"stale"' } })).status, 200);

  const list = await srv.call("GET", "/gateway/avatars");
  assert.deepEqual(list.json.avatars, [saved.json.avatar]);

  // A new picture is a new version, so the old ETag stops matching.
  const other = jpeg(5000, 0x43);
  assert.equal((await put(srv, "ares", other)).status, 200);
  assert.equal((await srv.call("GET", "/gateway/avatar/ares", { headers: { "if-none-match": `"${versionOf(image)}"` } })).status, 200);
});

test("avatars: GET with nothing stored is 404 no_avatar (not the router's bare 404)", async (t) => {
  const srv = await serve(t, await tempHome(t));
  const res = await srv.call("GET", "/gateway/avatar/ares");
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "no_avatar");
  assert.equal(typeof res.json.error, "string");
  assert.equal((await srv.call("GET", "/gateway/avatar/never-heard-of-it")).json.code, "no_avatar", "GET does not care whether the agent exists");
});

test("avatars: PUT as a JSON data URI, bare base64, and POST as an alias", async (t) => {
  const srv = await serve(t, await tempHome(t));
  const a = png(300);
  const viaUri = await putJson(srv, "ares", dataUri(a, "image/png"));
  assert.equal(viaUri.status, 200, viaUri.buf.toString());
  assert.equal(viaUri.json.avatar.contentType, "image/png");
  assert.equal(viaUri.json.avatar.bytes, 300);
  assert.ok((await srv.call("GET", "/gateway/avatar/ares")).buf.equals(a));

  const b = webp(400);
  const bare = await putJson(srv, "p_bob", b.toString("base64"));
  assert.equal(bare.status, 200, bare.buf.toString());
  assert.equal(bare.json.avatar.contentType, "image/webp");

  // The declared type in the data URI is ignored: JPEG bytes labelled png are jpeg.
  const c = jpeg(200);
  const lied = await putJson(srv, "ares", dataUri(c, "image/png"));
  assert.equal(lied.json.avatar.contentType, "image/jpeg");

  // Whitespace inside the base64 (line-wrapped encoders) is tolerated; charset on the type too.
  const wrapped = c.toString("base64").replace(/(.{40})/g, "$1\r\n");
  const wrappedRes = await srv.call("PUT", "/gateway/avatar/ares", { headers: { "content-type": "application/json; charset=utf-8" }, body: { image: wrapped } });
  assert.equal(wrappedRes.status, 200, wrappedRes.buf.toString());

  const post = await srv.call("POST", "/gateway/avatar/ares", { headers: { "content-type": "image/png" }, body: png(90) });
  assert.equal(post.status, 200);
  assert.equal(post.json.avatar.bytes, 90);
});

test("avatars: the client's type, filename and disposition are ignored; the bytes decide", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const image = jpeg(777);
  const res = await put(srv, "ares", image, {
    "content-type": "image/png",
    "content-disposition": 'attachment; filename="../../evil.svg"',
    "x-filename": "evil.html",
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.avatar.contentType, "image/jpeg");
  assert.deepEqual(await filesUnder(home), ["phone/avatars/ares.jpg"]);
  assert.equal((await srv.call("GET", "/gateway/avatar/ares")).headers["content-type"], "image/jpeg");

  // Any content-type that isn't application/json is taken as the raw image...
  assert.equal((await put(srv, "ares", png(50), { "content-type": "text/html" })).json.avatar.contentType, "image/png");
  assert.equal((await put(srv, "ares", webp(50), {})).json.avatar.contentType, "image/webp", "no content-type at all");
  assert.equal((await put(srv, "ares", jpeg(50), { "content-type": "application/x-www-form-urlencoded" })).status, 200, "what URLSession stamps on a body");
  // ...and a JSON label on raw bytes is a bad image, not a guess.
  const confused = await put(srv, "ares", jpeg(50), { "content-type": "application/json" });
  assert.equal(confused.status, 400);
  assert.equal(confused.json.code, "bad_image");
});

test("avatars: anything that isn't JPEG, PNG or WebP is refused and stores nothing", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  const gif = Buffer.from("GIF89a" + "\u0001\u0000\u0001\u0000".repeat(8), "latin1");
  const html = Buffer.from("<!doctype html><script>alert(1)</script>");
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
  const refused = {
    svg, gif, html, heic,
    empty: Buffer.alloc(0),
    "truncated jpeg": Buffer.from([0xff, 0xd8]),
    "truncated png": PNG_HEAD.subarray(0, 5),
    "truncated webp": Buffer.from("RIFF\u0010\u0000\u0000\u0000WEB", "latin1"),
    "wav in a riff": Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WAVEfmt ")]),
    "jpeg magic not at the start": Buffer.concat([Buffer.from("x"), jpeg()]),
  };
  for (const [name, bytes] of Object.entries(refused)) {
    const raw = await put(srv, "ares", bytes, { "content-type": "image/jpeg" });
    assert.equal(raw.status, 415, `${name} (raw): ${raw.buf.toString().slice(0, 100)}`);
    assert.equal(raw.json.code, "unsupported_type", name);
    if (bytes.length) {
      const viaJson = await putJson(srv, "ares", dataUri(bytes, "image/jpeg"));
      assert.equal(viaJson.status, 415, `${name} (json)`);
      assert.equal(viaJson.json.code, "unsupported_type", name);
    }
  }
  // base64 that is not base64, and JSON that is not the shape.
  const garbled = {
    "not base64": "not base64!!",
    "empty string": "",
    "only a prefix": "data:image/png;base64,",
    "one stray char": "A",
    "padding in the middle": "AAAA=AAA",
    "url-safe alphabet": "_-_-_-_-",
    "data uri without base64": "data:image/png,%89PNG",
  };
  for (const [name, image] of Object.entries(garbled)) {
    const res = await putJson(srv, "ares", image);
    assert.equal(res.status, 400, name);
    assert.equal(res.json.code, "bad_image", name);
  }
  for (const body of ["{not json", JSON.stringify({}), JSON.stringify({ image: 42 }), JSON.stringify(["x"]), JSON.stringify({ image: null })]) {
    const res = await srv.call("PUT", "/gateway/avatar/ares", { headers: { "content-type": "application/json" }, body });
    assert.equal(res.status, 400, body);
    assert.equal(res.json.code, "bad_image", body);
  }
  assert.deepEqual((await srv.call("GET", "/gateway/avatars")).json.avatars, []);
  assert.deepEqual(await filesUnder(home), [], "nothing was written for any of them");
});

// ── the cap ──────────────────────────────────────────────────────────────────

test("avatars: the 2 MiB cap is exact, raw and JSON, and a refused upload changes nothing", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const atCap = jpeg(MAX, 0x61);
  const okRaw = await put(srv, "ares", atCap, { "content-type": "image/jpeg" });
  assert.equal(okRaw.status, 200, okRaw.buf.toString().slice(0, 200));
  assert.equal(okRaw.json.avatar.bytes, MAX);
  assert.ok((await srv.call("GET", "/gateway/avatar/ares")).buf.equals(atCap));

  let stored = versionOf(atCap);
  for (const [name, send] of [
    ["raw", (bytes) => put(srv, "ares", bytes, { "content-type": "image/jpeg" })],
    ["json", (bytes) => putJson(srv, "ares", dataUri(bytes))],
  ]) {
    const over = await send(jpeg(MAX + 1, 0x62));
    assert.equal(over.status, 413, `${name}: ${over.buf.toString().slice(0, 200)}`);
    assert.equal(over.json.code, "too_large", name);
    assert.equal((await srv.call("GET", "/gateway/avatars")).json.avatars[0].version, stored, `${name}: the stored one is untouched`);
    const fill = name === "raw" ? 0x63 : 0x64;
    const exact = await send(jpeg(MAX, fill));
    assert.equal(exact.status, 200, `${name} at the cap: ${exact.buf.toString().slice(0, 200)}`);
    assert.equal(exact.json.avatar.bytes, MAX);
    stored = versionOf(jpeg(MAX, fill));
    assert.equal(exact.json.avatar.version, stored);
  }
  // Oversize is decided on size, before the bytes are judged: a huge non-image is 413, not 415.
  const hugeJunk = await put(srv, "ares", Buffer.alloc(MAX + 1, 0x41), { "content-type": "image/jpeg" });
  assert.equal(hugeJunk.status, 413);
  assert.deepEqual(await filesUnder(home), ["phone/avatars/ares.jpg"]);
});

test("avatars: a far-too-big upload is cut off without buffering it, and the server keeps answering", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);

  // Comfortably oversize: drained (never kept) so the client reads a clean 413.
  const three = await put(srv, "ares", jpeg(3 * 1024 * 1024), { "content-type": "image/jpeg" });
  assert.equal(three.status, 413);
  assert.equal(three.json.code, "too_large");
  // Same without a Content-Length (chunked), where the size is only known by counting.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "PUT", path: "/gateway/avatar/ares", headers: { "content-type": "image/jpeg" } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.on("error", reject);
    const block = jpeg(1024 * 1024);
    req.write(block);
    req.write(block);
    req.write(block);
    req.end();
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.json.code, "too_large");

  // Absurdly oversize: 96 MiB offered; the server must stop reading long before that.
  const TOTAL = 96 * 1024 * 1024;
  const settle = async (n) => {
    const t0 = Date.now();
    while (srv.closedReads.length < n && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  };
  await settle(srv.opened.count);
  const before = srv.closedReads.length;
  const outcome = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "PUT", path: "/gateway/avatar/ares", headers: { "content-type": "image/jpeg" } });
    const block = jpeg(256 * 1024);
    let sent = 0;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ ...v, sent }); } };
    req.on("response", (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => done({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
      res.on("error", (err) => done({ error: err.code }));
    });
    req.on("error", (err) => done({ error: err.code }));
    const pump = () => {
      while (sent < TOTAL) {
        sent += block.length;
        if (!req.write(block)) { req.once("drain", pump); return; }
      }
      req.end();
    };
    pump();
  });
  // The client either read the 413 or had the connection cut under it; both are fine.
  if (outcome.status !== undefined) assert.equal(outcome.status, 413);
  else assert.ok(["ECONNRESET", "EPIPE", "ECONNABORTED"].includes(outcome.error), `unexpected client error ${outcome.error}`);
  assert.ok(outcome.sent < TOTAL, "the client could not push all of it");
  await settle(before + 1);
  assert.equal(srv.closedReads.length, before + 1, "the connection was closed");
  const readByServer = srv.closedReads.at(-1);
  assert.ok(readByServer < 32 * 1024 * 1024, `the server read ${readByServer} of ${TOTAL} bytes`);

  // Still alive, still correct.
  assert.equal((await srv.call("GET", "/gateway/avatars")).status, 200);
  const fine = await put(srv, "ares", jpeg(2000));
  assert.equal(fine.status, 200);
  assert.equal(fine.json.avatar.bytes, 2000);
  assert.deepEqual(await filesUnder(home), ["phone/avatars/ares.jpg"]);
});

// ── ids ──────────────────────────────────────────────────────────────────────

test("avatars: ids that could reach outside the store are refused before anything happens", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const badIds = [
    "a%2Fb",
    "a%5Cb",
    "..%2F..%2Fetc%2Fpasswd",
    ".hidden",
    "a.b",
    "a%2eb",
    "-lead",
    "_lead",
    "a%00b",
    "a%20b",
    "%zz",
    "x".repeat(65),
    "%F0%9F%98%80",
    "ares.jpg",
  ];
  for (const id of badIds) {
    for (const [method, route, opts] of [
      ["GET", `/gateway/avatar/${id}`],
      ["PUT", `/gateway/avatar/${id}`, { body: jpeg() }],
      ["DELETE", `/gateway/avatar/${id}`],
      ["POST", `/gateway/avatar/${id}/delete`, { body: {} }],
    ]) {
      const res = await srv.call(method, route, opts);
      assert.equal(res.status, 400, `${method} ${id}: ${res.buf.toString().slice(0, 100)}`);
      assert.equal(res.json.code, "bad_id", `${method} ${id}`);
    }
  }
  // Slashes and emptiness: a malformed id, not a missing endpoint.
  for (const route of ["/gateway/avatar/a/b", "/gateway/avatar/a/b/c", "/gateway/avatar/", "/gateway/avatar//", "/gateway/avatar/a/delete/x"]) {
    const res = await srv.call("PUT", route, { body: jpeg() });
    assert.equal(res.status, 400, route);
    assert.equal(res.json.code, "bad_id", route);
  }
  // `..` segments never reach the handler: the URL parser resolves them first.
  for (const route of ["/gateway/avatar/../x", "/gateway/avatar/%2e%2e", "/gateway/avatar/%2e%2e/%2e%2e/etc", "/gateway/avatar/%2e/delete"]) {
    const res = await srv.call("PUT", route, { body: jpeg() });
    assert.ok(res.status >= 400 && res.status < 500, `${route} -> ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  assert.deepEqual(await filesUnder(home), []);
  assert.deepEqual(await fs.readdir(home), [], "not even the directory was created");

  // The length limit is exact.
  const sixtyFour = "a".repeat(64);
  srv.known.add(sixtyFour);
  assert.equal((await put(srv, sixtyFour, jpeg())).status, 200);
  assert.equal((await put(srv, `Z${"-_".repeat(31)}9`, jpeg())).json.code, "unknown_agent", "a valid shape still needs a known agent");
  assert.deepEqual(await filesUnder(home), [`phone/avatars/${sixtyFour}.jpg`]);
});

test("avatars: only a known agent can get a picture; 'ares' always can", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const res = await put(srv, "p_nope", jpeg());
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "unknown_agent");
  assert.equal(res.json.error, "unknown agent: p_nope");
  const long = await put(srv, "q".repeat(60), jpeg());
  assert.equal(long.json.error, `unknown agent: ${"q".repeat(40)}`, "the id in the message is cut to 40");
  assert.deepEqual(await filesUnder(home), []);

  assert.equal((await put(srv, "ares", jpeg())).status, 200);
  assert.equal((await put(srv, "p_bob", png())).status, 200);
  srv.known.delete("p_bob");
  assert.equal((await put(srv, "p_bob", png())).json.code, "unknown_agent");
  // An existing picture of a forgotten agent can still be read and removed.
  assert.equal((await srv.call("GET", "/gateway/avatar/p_bob")).status, 200);
  assert.deepEqual((await srv.call("DELETE", "/gateway/avatar/p_bob")).json, { ok: true, removed: true });
});

test("avatars: other methods on a route we own are 405 with Allow", async (t) => {
  const srv = await serve(t, await tempHome(t));
  for (const method of ["PATCH", "HEAD", "OPTIONS"]) {
    const res = await srv.call(method, "/gateway/avatar/ares");
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, "GET, PUT, POST, DELETE");
  }
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await srv.call(method, "/gateway/avatar/ares/delete");
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, "POST");
  }
  for (const method of ["PUT", "DELETE"]) assert.equal((await srv.call(method, "/gateway/avatars")).status, 405, method);
});

// ── storage ──────────────────────────────────────────────────────────────────

test("avatars: one file per agent; a new type replaces the old file", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const dir = path.join(home, "phone", "avatars");
  await put(srv, "ares", jpeg(100));
  assert.deepEqual(await fs.readdir(dir), ["ares.jpg"]);
  await put(srv, "ares", png(100));
  assert.deepEqual(await fs.readdir(dir), ["ares.png"], "jpg replaced by png");
  await put(srv, "ares", webp(100));
  assert.deepEqual(await fs.readdir(dir), ["ares.webp"]);
  await put(srv, "ares", webp(120, 0x44));
  assert.deepEqual(await fs.readdir(dir), ["ares.webp"], "same type overwritten in place");
  await put(srv, "p_bob", jpeg(100));
  assert.deepEqual((await fs.readdir(dir)).sort(), ["ares.webp", "p_bob.jpg"]);

  const list = (await srv.call("GET", "/gateway/avatars")).json.avatars;
  assert.deepEqual(list.map((a) => [a.id, a.contentType]), [["ares", "image/webp"], ["p_bob", "image/jpeg"]]);
  const got = await srv.call("GET", "/gateway/avatar/ares");
  assert.equal(got.headers["content-type"], "image/webp");
  assert.ok(got.buf.equals(webp(120, 0x44)));
});

test("avatars: files live only under <home>/phone/avatars, private, written atomically", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  await put(srv, "ares", jpeg(100));
  await put(srv, "p_bob", png(100));
  await putJson(srv, "ares", dataUri(webp(100)));
  assert.deepEqual(await filesUnder(home), ["phone/avatars/ares.webp", "phone/avatars/p_bob.png"], "no tmp leftovers, nothing elsewhere");
  if (process.platform !== "win32") {
    const dir = path.join(home, "phone", "avatars");
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dir, "ares.webp"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(dir, "p_bob.png"))).mode & 0o777, 0o600);
  }
});

test("avatars: DELETE and POST .../delete are idempotent", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  await put(srv, "ares", jpeg(100));
  await put(srv, "p_bob", png(100));

  assert.deepEqual((await srv.call("DELETE", "/gateway/avatar/ares")).json, { ok: true, removed: true });
  assert.equal((await srv.call("GET", "/gateway/avatar/ares")).json.code, "no_avatar");
  assert.deepEqual((await srv.call("DELETE", "/gateway/avatar/ares")).json, { ok: true, removed: false }, "already gone");
  assert.deepEqual((await srv.call("DELETE", "/gateway/avatar/p_nobody")).json, { ok: true, removed: false }, "never existed");

  assert.deepEqual((await srv.call("POST", "/gateway/avatar/p_bob/delete", { body: {} })).json, { ok: true, removed: true });
  assert.deepEqual((await srv.call("POST", "/gateway/avatar/p_bob/delete", { body: {} })).json, { ok: true, removed: false });
  assert.deepEqual((await srv.call("POST", "/gateway/avatar/p_bob/delete/")).json, { ok: true, removed: false }, "trailing slash");
  assert.deepEqual(await filesUnder(home), []);
  assert.deepEqual((await srv.call("GET", "/gateway/avatars")).json.avatars, []);
});

test("avatars: the index survives a restart and skips what it cannot trust", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home, { now: () => new Date("2026-09-30T08:00:00.000Z") });
  const a = jpeg(1234, 0x01);
  const b = png(4321, 0x02);
  await put(srv, "ares", a);
  await put(srv, "p_bob", b);
  const before = (await srv.call("GET", "/gateway/avatars")).json.avatars;

  const dir = path.join(home, "phone", "avatars");
  // Junk a restart must ignore (or sweep), never serve.
  await fs.writeFile(path.join(dir, "junk.jpg"), "not a jpeg");
  await fs.writeFile(path.join(dir, "evil.svg"), "<svg/>");
  await fs.writeFile(path.join(dir, "mismatch.png"), jpeg(50));
  await fs.writeFile(path.join(dir, "empty.png"), "");
  await fs.writeFile(path.join(dir, "big.png"), png(MAX + 1));
  await fs.writeFile(path.join(dir, ".p_bob.deadbeef.tmp"), "half a write");
  await fs.writeFile(path.join(dir, "notes.txt"), "hi");
  await fs.mkdir(path.join(dir, "dir.png"));
  await fs.writeFile(path.join(dir, ".hidden.png"), png());

  const fresh = new AvatarStore(home);
  await fresh.load();
  assert.deepEqual(fresh.list().map(({ updatedAt, ...rest }) => rest), before.map(({ updatedAt, ...rest }) => rest));
  for (const row of fresh.list()) assert.match(row.updatedAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(fresh.version("ares"), versionOf(a), "sync after load");
  assert.equal(fresh.version("p_bob"), versionOf(b));
  assert.equal(fresh.version("junk"), undefined);
  assert.equal(fresh.version("mismatch"), undefined);
  assert.equal(fresh.version("big"), undefined);
  assert.ok((await fresh.read("ares")).bytes.equals(a));
  assert.equal(await fresh.read("junk"), undefined);
  await assert.rejects(fs.access(path.join(dir, ".p_bob.deadbeef.tmp")), "stale tmp swept");

  // A second server over the same home (the actual restart) answers the same.
  const srv2 = await serve(t, home);
  assert.ok((await srv2.call("GET", "/gateway/avatar/p_bob")).buf.equals(b));
  assert.deepEqual((await srv2.call("GET", "/gateway/avatars")).json.avatars.map((x) => x.id), ["ares", "p_bob"]);

  // Two files for one agent (a crash between write and cleanup): the newer wins.
  const both = await tempHome(t);
  const d2 = path.join(both, "phone", "avatars");
  await fs.mkdir(d2, { recursive: true });
  await fs.writeFile(path.join(d2, "ares.jpg"), jpeg(80));
  await fs.writeFile(path.join(d2, "ares.png"), png(80));
  await fs.utimes(path.join(d2, "ares.jpg"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const store = new AvatarStore(both);
  await store.load();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].contentType, "image/png");
  await store.put("ares", jpeg(81));
  assert.deepEqual(await fs.readdir(d2), ["ares.jpg"], "the next write leaves exactly one");
});

test("avatars: concurrent writes to one agent leave one consistent picture", async (t) => {
  const home = await tempHome(t);
  const srv = await serve(t, home);
  const images = [jpeg(500, 1), png(500, 2), webp(500, 3), jpeg(500, 4), png(500, 5), webp(500, 6)];
  const results = await Promise.all(images.map((img) => put(srv, "ares", img)));
  assert.ok(results.every((r) => r.status === 200));
  const files = await fs.readdir(path.join(home, "phone", "avatars"));
  assert.equal(files.length, 1, files.join(","));
  const got = await srv.call("GET", "/gateway/avatar/ares");
  assert.equal(got.status, 200);
  assert.equal((await srv.call("GET", "/gateway/avatars")).json.avatars[0].version, versionOf(got.buf), "the listed version describes the stored bytes");
  assert.ok(images.some((img) => img.equals(got.buf)));
});

test("avatars: a failing store answers 500 {code:internal}, never throws into the server", async (t) => {
  const lines = [];
  const store = {
    list: () => { throw new Error("disk on fire"); },
    meta: () => undefined,
    read: async () => undefined,
    put: async () => { throw new Error("disk on fire"); },
    remove: async () => false,
  };
  const server = http.createServer(async (req, res) => { await handleAvatarsApi(req, res, new URL(req.url, "http://x"), { store, known: () => true, log: (l) => lines.push(l) }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const { port } = server.address();
  const a = await request(port, "GET", "/gateway/avatars");
  assert.equal(a.status, 500);
  assert.equal(a.json.code, "internal");
  const b = await request(port, "PUT", "/gateway/avatar/ares", { body: jpeg() });
  assert.equal(b.status, 500);
  assert.equal(b.json.error, "internal error", "the cause stays in the log, not on the wire");
  assert.ok(lines.some((l) => /disk on fire/.test(l)));
});

// ── personas ─────────────────────────────────────────────────────────────────

async function personaServer(t, home, { onRemoved, failOnRemoved = false } = {}) {
  const { handlePersonasApi } = await import("../packages/cli/dist/phonePersonas.js");
  const { PersonaStore } = await import("../packages/cli/dist/personas.js");
  const avatars = new AvatarStore(home);
  await avatars.load();
  const store = new PersonaStore(home);
  const logs = [];
  let seq = 0;
  const personaDeps = {
    store,
    providers: () => ["deepseek"],
    models: async () => [{ id: "deepseek-flash" }],
    reasoningLevels: () => ["low", "high"],
    defaultPersona: async () => ({ provider: "deepseek", model: "deepseek-flash", reasoningLevel: "high", sessionId: "sess_default" }),
    createSession: async () => `sess_p${++seq}`,
    archiveSession: async () => {},
    busy: () => false,
    lastMessage: async () => undefined,
    apply: async () => {},
    kickoff: () => {},
    avatarVersion: (id) => avatars.version(id),
    onRemoved: async (id) => {
      onRemoved?.(id);
      if (failOnRemoved) throw new Error("disk on fire");
      await avatars.remove(id);
    },
    log: (l) => logs.push(l),
  };
  const avatarDeps = { store: avatars, known: (id) => id === "ares" || store.get(id) !== undefined };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (await handleAvatarsApi(req, res, url, avatarDeps)) return;
    if (await handlePersonasApi(req, res, url, personaDeps)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  return { avatars, logs, call: (method, route, opts) => request(port, method, route, opts) };
}

const BOB = { name: "Bob", provider: "deepseek", model: "deepseek-flash", instructions: "Suggest dinners I can cook in 20 minutes." };
const asJson = (body) => ({ headers: { "content-type": "application/json" }, body });

test("personas carry the avatar version, including the default, and lose it with the persona", async (t) => {
  const home = await tempHome(t);
  const removed = [];
  const srv = await personaServer(t, home, { onRemoved: (id) => removed.push(id) });

  const empty = (await srv.call("GET", "/gateway/personas")).json.personas;
  assert.equal(empty.length, 1);
  assert.equal("avatar" in empty[0], false, "no picture, no field");
  assert.deepEqual(empty[0], { id: "ares", name: "Ares", provider: "deepseek", model: "deepseek-flash", reasoningLevel: "high", instructions: "", sessionId: "sess_default", busy: false });

  const created = await srv.call("POST", "/gateway/personas", asJson(BOB));
  assert.equal(created.status, 200, created.buf.toString());
  const bob = created.json.persona;
  assert.equal("avatar" in bob, false);

  const aresPic = jpeg(900, 0x10);
  const bobPic = png(900, 0x20);
  assert.equal((await srv.call("PUT", "/gateway/avatar/ares", { headers: { "content-type": "image/jpeg" }, body: aresPic })).status, 200);
  assert.equal((await srv.call("PUT", `/gateway/avatar/${bob.id}`, { headers: { "content-type": "image/png" }, body: bobPic })).status, 200, "a real persona id is a known agent");

  const listed = (await srv.call("GET", "/gateway/personas")).json.personas;
  assert.equal(listed[0].id, "ares");
  assert.equal(listed[0].avatar, versionOf(aresPic));
  assert.equal(listed[1].avatar, versionOf(bobPic));
  // Everything else about the shape is as before.
  assert.deepEqual(Object.keys(listed[1]).sort(), ["avatar", "busy", "id", "instructions", "model", "name", "provider", "sessionId"]);

  // An edit keeps it; a new picture changes the version the list reports.
  const edited = await srv.call("POST", `/gateway/personas/${bob.id}`, asJson({ name: "Robert" }));
  assert.equal(edited.json.persona.avatar, versionOf(bobPic));
  await srv.call("PUT", `/gateway/avatar/${bob.id}`, { body: png(901, 0x21) });
  assert.equal((await srv.call("GET", "/gateway/personas")).json.personas[1].avatar, versionOf(png(901, 0x21)));

  // Delete the persona: its picture goes with it; "ares" keeps hers.
  const del = await srv.call("POST", `/gateway/personas/${bob.id}/delete`, asJson({}));
  assert.deepEqual(del.json, { ok: true });
  assert.deepEqual(removed, [bob.id]);
  assert.equal((await srv.call("GET", `/gateway/avatar/${bob.id}`)).json.code, "no_avatar");
  assert.deepEqual((await srv.call("GET", "/gateway/avatars")).json.avatars.map((a) => a.id), ["ares"]);
  assert.deepEqual((await filesUnder(home)).filter((f) => f.startsWith("phone/")), ["phone/avatars/ares.jpg"]);
  assert.equal((await srv.call("GET", "/gateway/personas")).json.personas[0].avatar, versionOf(aresPic));
  assert.equal((await srv.call("PUT", `/gateway/avatar/${bob.id}`, { body: png() })).json.code, "unknown_agent", "a deleted persona can't get a new picture");
});

test("a cleanup failure never fails the persona delete", async (t) => {
  const home = await tempHome(t);
  const srv = await personaServer(t, home, { failOnRemoved: true });
  const bob = (await srv.call("POST", "/gateway/personas", asJson(BOB))).json.persona;
  const del = await srv.call("POST", `/gateway/personas/${bob.id}/delete`, asJson({}));
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true });
  assert.ok(srv.logs.some((l) => l.includes(`cleanup for ${bob.id} failed`) && l.includes("disk on fire")), srv.logs.join("\n"));
  assert.deepEqual((await srv.call("GET", "/gateway/personas")).json.personas.map((p) => p.id), ["ares"]);
});

test("editing the default agent says where its picture goes; the rest of that route is unchanged", async (t) => {
  const srv = await personaServer(t, await tempHome(t));
  const edit = await srv.call("POST", "/gateway/personas/ares", asJson({ name: "Zeus" }));
  assert.equal(edit.status, 400);
  assert.deepEqual(edit.json, { error: "Ares's own name, brain and instructions are set on the box. Its picture is PUT /gateway/avatar/ares." });
  assert.equal((await srv.call("POST", "/gateway/personas/ares", asJson({}))).status, 400);
  // Delete of "ares" is as before: there is no such persona to delete.
  assert.equal((await srv.call("POST", "/gateway/personas/ares/delete", asJson({}))).status, 404);
  assert.equal((await srv.call("POST", "/gateway/personas/p_missing", asJson({ name: "x" }))).status, 404);
  assert.equal((await srv.call("GET", "/gateway/personas/ares")).status, 404);
});

test("a box with no avatar wiring still serves personas exactly as before", async (t) => {
  const home = await tempHome(t);
  const { handlePersonasApi } = await import("../packages/cli/dist/phonePersonas.js");
  const { PersonaStore } = await import("../packages/cli/dist/personas.js");
  const store = new PersonaStore(home);
  const deps = {
    store,
    providers: () => ["deepseek"],
    models: async () => [{ id: "deepseek-flash" }],
    reasoningLevels: () => ["low"],
    defaultPersona: async () => ({ provider: "deepseek", model: "deepseek-flash" }),
    createSession: async () => "sess_p1",
    archiveSession: async () => {},
    busy: () => false,
    lastMessage: async () => undefined,
    apply: async () => {},
    kickoff: () => {},
  };
  const server = http.createServer(async (req, res) => { await handlePersonasApi(req, res, new URL(req.url, "http://x"), deps); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const { port } = server.address();
  const created = await request(port, "POST", "/gateway/personas", asJson(BOB));
  assert.equal(created.status, 200);
  assert.equal("avatar" in created.json.persona, false);
  assert.equal((await request(port, "POST", `/gateway/personas/${created.json.persona.id}/delete`, asJson({}))).status, 200);
});

// ── through the real server ──────────────────────────────────────────────────

test("a real RemoteAgentServer: owner bearer required, PUT and DELETE reach the hook, big uploads survive", async (t) => {
  const { RemoteAgentServer } = await import("../packages/cli/dist/remoteAgentServer.js");
  const home = await tempHome(t);
  const store = new AvatarStore(home);
  await store.load();
  const seen = [];
  const server = new RemoteAgentServer({
    port: 0,
    host: "127.0.0.1",
    tunnelMode: "none",
    home,
    controlToken: "tok",
    phoneApi: {
      avatars: createAvatarsApi({ store, known: (id) => id === "ares" || id === "p_bob", log: (l) => seen.push(l) }),
    },
  });
  await server.start();
  t.after(() => server.close());
  const call = (method, route, opts = {}) => request(server.port, method, route, opts);
  const auth = { authorization: "Bearer tok" };

  // No token, wrong token: nothing is revealed and nothing is written.
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Bearer " }]) {
    const list = await call("GET", "/gateway/avatars", { headers });
    assert.equal(list.status, 401, JSON.stringify(headers));
    assert.deepEqual(list.json, { error: "unauthorized" });
    const write = await call("PUT", "/gateway/avatar/ares", { headers: { ...headers, "content-type": "image/jpeg" }, body: jpeg() });
    assert.equal(write.status, 401, JSON.stringify(headers));
    assert.equal((await call("GET", "/gateway/avatar/ares", { headers })).status, 401);
    assert.equal((await call("DELETE", "/gateway/avatar/ares", { headers })).status, 401);
    assert.equal((await call("POST", "/gateway/avatar/ares/delete", { headers, body: {} })).status, 401);
  }
  assert.deepEqual(await filesUnder(home), []);

  // With the token every verb gets through /gateway/* to the hook.
  const list = await call("GET", "/gateway/avatars", { headers: auth });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { max: MAX, types: ["image/jpeg", "image/png", "image/webp"], avatars: [] });

  const pic = jpeg(3000, 0x5a);
  const saved = await call("PUT", "/gateway/avatar/ares", { headers: { ...auth, "content-type": "image/jpeg" }, body: pic });
  assert.equal(saved.status, 200, saved.buf.toString());
  assert.equal(saved.json.avatar.version, versionOf(pic));
  const got = await call("GET", "/gateway/avatar/ares", { headers: auth });
  assert.ok(got.buf.equals(pic));
  assert.equal(got.headers.etag, `"${versionOf(pic)}"`);
  assert.equal((await call("GET", "/gateway/avatar/ares", { headers: { ...auth, "if-none-match": got.headers.etag } })).status, 304);

  // About 1 MB of image as a JSON data URI (~1.4 MB on the wire), the app's usual shape.
  const big = png(1024 * 1024, 0x6b);
  const viaJson = await call("PUT", "/gateway/avatar/p_bob", { headers: { ...auth, "content-type": "application/json" }, body: { image: dataUri(big, "image/png") } });
  assert.equal(viaJson.status, 200, viaJson.buf.toString().slice(0, 200));
  assert.equal(viaJson.json.avatar.bytes, big.length);
  assert.ok((await call("GET", "/gateway/avatar/p_bob", { headers: auth })).buf.equals(big));

  // Exactly at the cap as JSON (~2.8 MB on the wire): nothing in front of the route cuts it.
  const atCap = jpeg(MAX, 0x6c);
  const capJson = await call("PUT", "/gateway/avatar/p_bob", { headers: { ...auth, "content-type": "application/json" }, body: { image: dataUri(atCap) } });
  assert.equal(capJson.status, 200, capJson.buf.toString().slice(0, 200));
  assert.equal(capJson.json.avatar.bytes, MAX);
  assert.ok((await call("GET", "/gateway/avatar/p_bob", { headers: auth })).buf.equals(atCap));

  // Unknown agent and oversize come back as coded errors, and the server carries on.
  assert.equal((await call("PUT", "/gateway/avatar/p_who", { headers: auth, body: pic })).json.code, "unknown_agent");
  const over = await call("PUT", "/gateway/avatar/ares", { headers: { ...auth, "content-type": "image/jpeg" }, body: jpeg(MAX + 1) });
  assert.equal(over.status, 413);
  assert.equal(over.json.code, "too_large");
  const overJson = await call("PUT", "/gateway/avatar/ares", { headers: { ...auth, "content-type": "application/json" }, body: { image: dataUri(jpeg(MAX + 1)) } });
  assert.equal(overJson.status, 413);
  assert.equal((await call("GET", "/gateway/avatar/ares", { headers: auth })).headers.etag, `"${versionOf(pic)}"`, "untouched by the refused uploads");
  assert.equal((await call("GET", "/gateway/health")).status, 200, "the server still answers");

  // Both delete verbs.
  assert.deepEqual((await call("DELETE", "/gateway/avatar/ares", { headers: auth })).json, { ok: true, removed: true });
  assert.deepEqual((await call("POST", "/gateway/avatar/p_bob/delete", { headers: auth, body: {} })).json, { ok: true, removed: true });
  assert.deepEqual((await call("DELETE", "/gateway/avatar/ares", { headers: auth })).json, { ok: true, removed: false });
  assert.deepEqual(await filesUnder(home), []);

  // An older box (no avatars hook) 404s the probe with no code: that is what the app keys on.
  await server.close();
  const bare = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", home, controlToken: "tok", phoneApi: {} });
  await bare.start();
  t.after(() => bare.close());
  const old = await request(bare.port, "GET", "/gateway/avatars", { headers: auth });
  assert.equal(old.status, 404);
  assert.equal(old.json.code, undefined);
});
