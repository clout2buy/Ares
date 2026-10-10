import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createInstancesApi } from "../packages/cli/dist/phoneInstances.js";

function fakeBox({ supported = true } = {}) {
  const metas = [];
  const box = {
    metas,
    calls: [],
    gate: null,
    async preflight() {
      if (!supported) throw new Error("Docker is not installed on this host");
    },
    async list() {
      return metas.map((m) => ({ name: m.name }));
    },
    async status(name) {
      const m = metas.find((x) => x.name === name);
      if (!m) throw new Error(`no instance named ${name}`);
      return { active: "active", healthy: true, provider: "anthropic", model: "claude-opus-5-5", createdAt: "2026-09-30T00:00:00Z", ...m };
    },
    async create(opts) {
      box.calls.push(["create", opts.name, opts.purpose, opts.model]);
      await box.gate;
      if (box.failWith) throw new Error(box.failWith);
      metas.push({ name: opts.name, purpose: opts.purpose, url: `https://${opts.name}-ares.example.com` });
      return box.status(opts.name);
    },
    async systemctl(action, name) {
      box.calls.push([action, name]);
      const m = metas.find((x) => x.name === name);
      if (!m) throw new Error(`no instance named ${name}`);
      m.active = action === "stop" ? "inactive" : "active";
      return box.status(name);
    },
    async remove(name, purge) {
      box.calls.push(["remove", name, purge]);
      const i = metas.findIndex((x) => x.name === name);
      if (i < 0) throw new Error(`no instance named ${name}`);
      metas.splice(i, 1);
      return `removed ${name}; its home is kept`;
    },
    async pair(name) {
      const m = metas.find((x) => x.name === name);
      if (!m) throw new Error(`no instance named ${name}`);
      return m.url ? { link: `ares://pair?url=wss%3A%2F%2F${name}&token=t&name=${name}`, url: m.url, tokenPath: "/x" } : { tokenPath: "/x" };
    },
  };
  return box;
}

async function serve(box) {
  const handle = createInstancesApi(box, () => {});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handle(req, res, url))) {
      res.writeHead(418).end("not mine");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)), base };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

test("an unsupported host (no Docker/sudo) says so, and refuses to act", async () => {
  const s = await serve(fakeBox({ supported: false }));
  try {
    const list = await s.call("GET", "/gateway/instances");
    assert.equal(list.status, 200);
    assert.equal(list.body.supported, false);
    assert.match(list.body.reason, /Docker/);
    assert.deepEqual(list.body.instances, []);
    assert.equal((await s.call("POST", "/gateway/instances", { name: "scout" })).status, 409);
    assert.equal((await s.call("POST", "/gateway/instances/scout/stop")).status, 409);
  } finally { await s.close(); }
});

test("list maps systemd + health onto running / starting / stopped", async () => {
  const box = fakeBox();
  box.metas.push({ name: "a-one" }, { name: "b-two", healthy: false }, { name: "c-three", active: "inactive", healthy: false });
  const s = await serve(box);
  try {
    const { body } = await s.call("GET", "/gateway/instances");
    assert.equal(body.supported, true);
    assert.deepEqual(body.instances.map((i) => [i.name, i.state]), [["a-one", "running"], ["b-two", "starting"], ["c-three", "stopped"]]);
  } finally { await s.close(); }
});

test("create validates, answers 202 at once, and shows 'creating' until it lands", async () => {
  const box = fakeBox();
  let release;
  box.gate = new Promise((r) => { release = r; });
  const s = await serve(box);
  try {
    assert.equal((await s.call("POST", "/gateway/instances", { name: "Bad_Name" })).status, 400);
    assert.equal((await s.call("POST", "/gateway/instances", {})).status, 400);

    const made = await s.call("POST", "/gateway/instances", { name: "scout", purpose: "watches the boards", model: "claude-opus-5-5" });
    assert.equal(made.status, 202);
    assert.deepEqual(made.body, { name: "scout", state: "creating" });
    assert.deepEqual(box.calls[0], ["create", "scout", "watches the boards", "claude-opus-5-5"]);

    const during = await s.call("GET", "/gateway/instances");
    assert.deepEqual(during.body.instances.map((i) => [i.name, i.state]), [["scout", "creating"]]);
    assert.equal((await s.call("POST", "/gateway/instances", { name: "other" })).status, 409, "one deploy at a time");

    release();
    await tick();
    const after = await s.call("GET", "/gateway/instances");
    assert.deepEqual(after.body.instances.map((i) => [i.name, i.state]), [["scout", "running"]]);
    assert.equal((await s.call("POST", "/gateway/instances", { name: "scout" })).status, 409, "no duplicates");
  } finally { await s.close(); }
});

test("a failed deploy is reported, and does not lock the name", async () => {
  const box = fakeBox();
  box.failWith = "no free port pair";
  const s = await serve(box);
  try {
    assert.equal((await s.call("POST", "/gateway/instances", { name: "scout" })).status, 202);
    await tick();
    const failed = (await s.call("GET", "/gateway/instances")).body.instances[0];
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /no free port pair/);
    box.failWith = null;
    assert.equal((await s.call("POST", "/gateway/instances", { name: "scout" })).status, 202, "retry allowed");
    await tick();
    assert.equal((await s.call("GET", "/gateway/instances")).body.instances[0].state, "running");
  } finally { await s.close(); }
});

test("start / stop / restart / remove / pair hit the box; remove never purges", async () => {
  const box = fakeBox();
  box.metas.push({ name: "scout", url: "https://scout-ares.example.com" }, { name: "local-only" });
  const s = await serve(box);
  try {
    assert.equal((await s.call("POST", "/gateway/instances/scout/stop")).body.instance.state, "stopped");
    assert.equal((await s.call("POST", "/gateway/instances/scout/start")).body.instance.state, "running");
    assert.equal((await s.call("POST", "/gateway/instances/scout/restart")).status, 200);
    const pair = await s.call("GET", "/gateway/instances/scout/pair");
    assert.match(pair.body.link, /^ares:\/\/pair\?/);
    assert.equal(pair.body.url, "https://scout-ares.example.com");
    const noUrl = await s.call("GET", "/gateway/instances/local-only/pair");
    assert.equal(noUrl.status, 409);
    const removed = await s.call("POST", "/gateway/instances/scout/remove");
    assert.equal(removed.status, 200);
    assert.deepEqual(box.calls.find((c) => c[0] === "remove"), ["remove", "scout", false]);
  } finally { await s.close(); }
});

test("unknown instance, hostile names, wrong methods and foreign paths", async () => {
  const s = await serve(fakeBox());
  try {
    assert.equal((await s.call("POST", "/gateway/instances/ghost/stop")).status, 404);
    assert.equal((await s.call("POST", "/gateway/instances/..%2Fetc/stop")).status, 404);
    assert.equal((await s.call("POST", "/gateway/instances/Bad_Name/stop")).status, 404);
    assert.equal((await s.call("GET", "/gateway/instances/scout/stop")).status, 405);
    assert.equal((await s.call("DELETE", "/gateway/instances")).status, 405);
    assert.equal((await s.call("GET", "/gateway/other")).status, 418, "not claimed");
  } finally { await s.close(); }
});
