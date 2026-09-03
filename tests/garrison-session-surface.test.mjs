// Verifies surface + tenant stamps on Garrison sessions:
//   1. create({surface, tenant}) lands in <id>.meta.json and the summary, and
//      rehydrateSessions / a fresh manager restore both.
//   2. Old meta files without the fields still load (owner default).
//   3. A per-message tenant on send() upgrades an unstamped session and
//      reaches the host's beforeSend hook.
//   4. The gateway passes session.create / session.send stamps through and
//      drops malformed ones.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GarrisonServer,
  SessionManager,
  ensureToken,
  rehydrateSessions,
  normalizeSessionTenant,
  normalizeSessionSurface,
} from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";

const wsModule = await import("ws").catch(() => import("../packages/garrison/node_modules/ws/wrapper.mjs"));
const WebSocket = wsModule.default ?? wsModule.WebSocket;

function makeFactory(workspace) {
  return ({ sessionId, model, signal, requestPermission, surface, tenant }) => {
    const engine = QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: model ?? "mock", systemPrompt: "surface test", tools: [], workspace, signal, requestPermission },
      sessionId,
    );
    makeFactory.seen.push({ sessionId, surface, tenant });
    return { engine, providerName: "mock-echo", model: model ?? "mock", workspace };
  };
}
makeFactory.seen = [];

test("sessions: surface + tenant persist in meta.json, show in summaries, and survive rehydration", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-surface-"));
  const m1 = new SessionManager({ home, factory: makeFactory(home) });
  const created = m1.create({ surface: "telegram", tenant: { role: "guest", chatId: "99" } });
  assert.equal(created.surface, "telegram");
  assert.deepEqual(created.tenant, { role: "guest", chatId: "99" });
  const plain = m1.create({});
  assert.equal(plain.surface, undefined);
  assert.equal(plain.tenant, undefined);
  await m1.send(created.id, "hello from the phone");
  await m1.send(plain.id, "hello from nowhere in particular");
  await m1.flush();

  const meta = JSON.parse(await fs.readFile(path.join(home, "garrison", "sessions", `${created.id}.meta.json`), "utf8"));
  assert.equal(meta.surface, "telegram");
  assert.deepEqual(meta.tenant, { role: "guest", chatId: "99" });
  const plainMeta = JSON.parse(await fs.readFile(path.join(home, "garrison", "sessions", `${plain.id}.meta.json`), "utf8"));
  assert.ok(!("surface" in plainMeta) && !("tenant" in plainMeta), "unstamped sessions write no stamp keys");

  const prior = await rehydrateSessions(home);
  const restored = prior.find((p) => p.id === created.id);
  assert.equal(restored.surface, "telegram");
  assert.deepEqual(restored.tenant, { role: "guest", chatId: "99" });

  const m2 = new SessionManager({ home, factory: makeFactory(home) });
  const back = await m2.rehydrate();
  const again = back.find((s) => s.id === created.id);
  assert.equal(again.surface, "telegram");
  assert.deepEqual(again.tenant, { role: "guest", chatId: "99" });
  assert.deepEqual(m2.tenantOf(created.id), { role: "guest", chatId: "99" });
  assert.deepEqual(m2.tenantOf(plain.id), { role: "owner" }, "unstamped → owner");
  const factoryReq = makeFactory.seen.find((r) => r.sessionId === created.id && r.surface === "telegram");
  assert.ok(factoryReq && factoryReq.tenant.chatId === "99", "the factory request carries the stamps on rehydrate");
});

test("sessions: a legacy meta.json (no stamps) and a corrupt stamp both load as owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-surface-legacy-"));
  const dir = path.join(home, "garrison", "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sess_old.meta.json"), JSON.stringify({ id: "sess_old", title: "old", provider: "mock", model: "mock", workspace: home, createdAt: "2026-01-01T00:00:00Z" }));
  await fs.writeFile(path.join(dir, "sess_old.jsonl"), "");
  await fs.writeFile(path.join(dir, "sess_bad.meta.json"), JSON.stringify({ id: "sess_bad", title: "bad", surface: "toaster", tenant: { role: "guest" } }));
  await fs.writeFile(path.join(dir, "sess_bad.jsonl"), "");
  const prior = await rehydrateSessions(home);
  for (const p of prior) {
    assert.equal(p.surface, undefined, `${p.id}: unknown surface dropped`);
    assert.equal(p.tenant, undefined, `${p.id}: guest without chatId dropped`);
  }
  assert.equal(normalizeSessionSurface("tui"), "tui");
  assert.deepEqual(normalizeSessionTenant({ role: "guest", chatId: 99 }), { role: "guest", chatId: "99" });
  assert.deepEqual(normalizeSessionTenant({ role: "owner", chatId: "42" }), { role: "owner" });
  assert.equal(normalizeSessionTenant({ role: "admin" }), undefined);
});

test("sessions: a per-message tenant upgrades an unstamped session and reaches beforeSend", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-surface-send-"));
  const hook = [];
  const manager = new SessionManager({ home, factory: makeFactory(home), beforeSend: (ctx) => { hook.push(ctx); } });
  const created = manager.create({ surface: "telegram" });
  await manager.send(created.id, "first", { tenant: { role: "guest", chatId: "7" } });
  await manager.flush();
  assert.deepEqual(manager.tenantOf(created.id), { role: "guest", chatId: "7" });
  const meta = JSON.parse(await fs.readFile(path.join(home, "garrison", "sessions", `${created.id}.meta.json`), "utf8"));
  assert.deepEqual(meta.tenant, { role: "guest", chatId: "7" });
  assert.equal(hook.length, 1);
  assert.deepEqual(hook[0], { sessionId: created.id, text: "first", surface: "telegram", tenant: { role: "guest", chatId: "7" } });
  // No tenant on the next send → the session's stamp is what the hook sees.
  await manager.send(created.id, "second");
  assert.deepEqual(hook[1].tenant, { role: "guest", chatId: "7" });
  // A throwing hook never blocks the turn.
  const angry = new SessionManager({ home, factory: makeFactory(home), beforeSend: () => { throw new Error("nope"); } });
  const s = angry.create({});
  await angry.send(s.id, "still runs");
  await angry.flush();
});

test("gateway: session.create and session.send stamps pass through; malformed ones are dropped", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-surface-gw-"));
  const sessions = new SessionManager({ home, factory: makeFactory(home) });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const until = async (pred) => {
    const start = Date.now();
    while (!frames.some(pred)) {
      if (Date.now() - start > 8000) throw new Error(`timeout; saw ${frames.map((f) => f.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return frames.find(pred);
  };
  try {
    ws.send(JSON.stringify({ type: "hello", token, client: "t", proto: 1 }));
    await until((f) => f.type === "welcome");
    ws.send(JSON.stringify({ type: "session.create", surface: "telegram", tenant: { role: "guest", chatId: "99" } }));
    const created = await until((f) => f.type === "session.created");
    assert.equal(created.session.surface, "telegram");
    assert.deepEqual(created.session.tenant, { role: "guest", chatId: "99" });

    ws.send(JSON.stringify({ type: "session.create", surface: "fridge", tenant: "owner" }));
    const junk = await until((f) => f.type === "session.created" && f.session.id !== created.session.id);
    assert.equal(junk.session.surface, undefined, "unknown surface dropped");
    assert.equal(junk.session.tenant, undefined, "non-object tenant dropped");

    ws.send(JSON.stringify({ type: "session.send", sessionId: junk.session.id, text: "hi", tenant: { role: "guest", chatId: 5 } }));
    await until((f) => f.type === "event" && f.sessionId === junk.session.id && f.event.type === "turn_end");
    assert.deepEqual(sessions.tenantOf(junk.session.id), { role: "guest", chatId: "5" }, "send-frame tenant stamped the session");
  } finally {
    ws.close();
    await sessions.flush();
    await server.close();
  }
});
