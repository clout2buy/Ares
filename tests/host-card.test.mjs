// The host card: a persona/agent knows the machine it runs ON (2026-10-01: an
// agent SSH'd to a stale address and told the owner the box was offline while
// running on it). Per-session layer only, owner sessions only, <= 600 chars,
// IPs re-read at most every 60 s.

import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { hostCardBlock, hostCardFor, lanAddresses, renderHostCard, resetHostCardCache, HOST_CARD_MAX_CHARS } from "../packages/cli/dist/entry/prompt/hostCard.js";
import { sessionPromptLayers } from "../packages/cli/dist/entry/prompt/texting.js";
import { SessionManager } from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";
import { PersonaRuntime } from "../packages/cli/dist/entry/personaRuntime.js";

const nets = (ip) => () => ({
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  "br-abc": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
  eth0: [{ address: ip, family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
});
const base = { hostname: () => "doingbox", networkInterfaces: nets("192.168.1.41"), uptime: () => 90_000, version: () => "0.54.0", phoneUrl: () => "https://ares.example.com" };

test("lanAddresses keeps the LAN address and drops loopback, docker bridges and IPv6", () => {
  assert.deepEqual(lanAddresses(nets("192.168.1.41")()), ["192.168.1.41"]);
});

test("the card names the machine, its address, and the rule that stops the SSH detour", () => {
  resetHostCardCache();
  const card = hostCardBlock(base);
  assert.match(card, /^## Host card/);
  assert.match(card, /You run ON this machine: doingbox \(the box the owner calls doingbox\)/);
  assert.match(card, /192\.168\.1\.41/);
  assert.ok(!/172\.17\./.test(card), "docker bridge addresses are not the box's address");
  assert.match(card, /up 1d1h/);
  assert.match(card, /Ares 0\.54\.0/);
  assert.match(card, /ares\.example\.com/);
  assert.match(card, /Never SSH\/ping to reach this machine/);
  assert.match(card, /hostname -I/);
  assert.ok(card.length <= HOST_CARD_MAX_CHARS, `card is ${card.length} chars`);
});

test("it stays under the budget with a hostile amount of text, and the rule line survives", () => {
  const card = renderHostCard({
    hostname: "h".repeat(63), nickname: "n".repeat(40), ips: ["192.168.100.200", "10.100.100.100", "172.31.255.255"],
    os: "Linux 6.8.0-1234-generic-very-long-kernel-name", uptimeSec: 9e6, version: "0.54.0", sha: "abcdef0", service: "ares-garrison",
    cwd: "/home/someone/some/very/deep/working/directory/that/goes/on/and/on/and/on", phoneHost: "a-long-tunnel-name.example-domain.com", owner: "Mr Doing",
  });
  assert.ok(card.length <= HOST_CARD_MAX_CHARS, `card is ${card.length} chars`);
  assert.match(card, /Never SSH\/ping to reach this machine/);
});

test("IPs are cached for 60 s, then follow the network", () => {
  resetHostCardCache();
  let t = 1_000_000;
  const a = hostCardBlock({ ...base, now: () => t });
  assert.match(a, /192\.168\.1\.41/);
  t += 30_000;
  const still = hostCardBlock({ ...base, networkInterfaces: nets("192.168.1.99"), now: () => t });
  assert.match(still, /192\.168\.1\.41/, "inside the 60 s window the cached address is kept");
  t += 31_000;
  const moved = hostCardBlock({ ...base, networkInterfaces: nets("192.168.1.99"), now: () => t });
  assert.match(moved, /192\.168\.1\.99/);
  assert.ok(!/192\.168\.1\.41/.test(moved), "the stale address is gone");
});

test("owners and personas get it; a guest tenant never does", () => {
  resetHostCardCache();
  assert.match(hostCardFor({ role: "owner" }, base), /Host card/);
  assert.match(hostCardFor(undefined, base), /Host card/);
  assert.equal(hostCardFor({ role: "guest", chatId: "1" }, base), "");
});

test("the card rides the per-session layer for a persona thread and is absent when empty", () => {
  resetHostCardCache();
  const card = hostCardBlock(base);
  const withCard = sessionPromptLayers("mobile", { name: "Gandalf", instructions: "wizard things" }, card);
  assert.match(withCard, /Who you are in this thread/);
  assert.match(withCard, /## Host card/);
  assert.ok(withCard.indexOf("Host card") > withCard.indexOf("wizard things"), "after the persona's role");
  assert.equal(sessionPromptLayers("desktop", null, ""), "", "desktop sessions stay untouched");
  assert.ok(!/Host card/.test(sessionPromptLayers("mobile", { name: "G", instructions: "x" }, "")));
});

test("a real persona session and a guest session, composed the way the garrison factory does", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-hostcard-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = new PersonaRuntime({
    home,
    resolveBrain: async (provider, model) => ({ provider, model }),
    live: { setBrain: async () => {}, setReasoningLevel: () => {}, refreshPrompt: () => {} },
    catalog: { providers: () => ["deepseek"], models: async () => [{ id: "deepseek-flash" }], reasoningLevels: () => ["high"] },
    defaultBrain: () => ({ provider: "deepseek", model: "deepseek-flash" }),
    push: async () => {},
  });
  await runtime.boot();
  const seen = new Map();
  let net = "192.168.1.41";
  let clock = 5_000_000;
  const factory = (req) => {
    // exactly the garrison's composition: base + the runtime's layers + the tenant-gated card
    const system = "BASE" + runtime.promptLayers(req.sessionId, req.surface, req.personaId, hostCardFor(req.tenant, { ...base, networkInterfaces: () => nets(net)(), now: () => clock }));
    seen.set(req.sessionId, system);
    const engine = QueryEngine.forTesting({ provider: new MockEchoProvider(), model: "mock", systemPrompt: system, tools: [], workspace: home, signal: req.signal, requestPermission: req.requestPermission }, req.sessionId);
    return { engine, providerName: "mock-echo", model: "mock", workspace: home };
  };
  resetHostCardCache();
  const sessions = new SessionManager({ home, factory, personas: runtime.sessionHooks() });
  runtime.attach(sessions);
  const persona = { id: "p_gandalf01", name: "Gandalf", instructions: "wizard", provider: "deepseek", model: "deepseek-flash", sessionId: "sess_gandalf", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await runtime.store.save(persona);
  await runtime.prepareBrain(persona);
  const p = sessions.create({ surface: "mobile", tenant: { role: "owner" }, personaId: persona.id });
  const g = sessions.create({ surface: "telegram", tenant: { role: "guest", chatId: "42" } });
  assert.match(seen.get(p.id), /You run ON this machine: doingbox/);
  assert.match(seen.get(p.id), /You are Gandalf/);
  assert.doesNotMatch(seen.get(g.id), /Host card|192\.168/, "a guest never learns the box's layout");
  assert.ok(seen.get(p.id).length < 3_000);
  net = "192.168.1.77"; clock += 61_000;
  const p2 = sessions.create({ surface: "mobile", tenant: { role: "owner" }, personaId: persona.id });
  assert.match(seen.get(p2.id), /192\.168\.1\.77/, "a later session sees the new address");
});
