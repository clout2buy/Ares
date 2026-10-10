// Connect {service:"provider:<id>"}: an agent asks for a provider sign-in and
// the owner gets an in-app card, never a raw OAuth link and a "paste the code".
// Real RemoteAgentServer + the broker's mock CLIs (tests/_mockLoginCli.mjs):
// the card is emitted, an already-signed-in provider answers at once, the call
// never waits, the session is woken when the phone completes the sign-in, and
// no URL, code or token ever appears in the tool result.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createProvidersApi } from "../packages/cli/dist/phoneProviders.js";
import { createProviderSignInHost } from "../packages/cli/dist/providerSignInHost.js";
import { setProviderSignInHost, getProviderSignInHost } from "../packages/core/dist/index.js";
import { ConnectTool } from "../packages/tools/dist/index.js";
import { MOCK_CLI_SOURCE } from "./_mockLoginCli.mjs";

const TOKEN = "tok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
}

async function rig(t) {
  const dir = await fs.mkdtemp(path.join(os.homedir(), "ares-provconn-test-"));
  const bins = path.join(dir, "bin");
  await fs.mkdir(bins);
  for (const n of ["claude", "codex"]) await fs.writeFile(path.join(bins, n), MOCK_CLI_SOURCE, { mode: 0o755 });
  const api = createProvidersApi({ home: process.env.ARES_HOME, serviceHome: dir, bins: { "claude-code": path.join(bins, "claude"), codex: path.join(bins, "codex") }, startTimeoutMs: 8000 });
  const woken = [];
  const host = createProviderSignInHost(api, { wake: async (sessionId, text) => { woken.push({ sessionId, text }); }, pollMs: 100 });
  setProviderSignInHost(host);
  const srv = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: TOKEN, phoneApi: { providers: api } });
  await srv.start();
  const origin = `http://127.0.0.1:${srv.port}`;
  t.after(async () => {
    host.close();
    setProviderSignInHost(null);
    api.close();
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const call = async (method, p, body) => {
    const res = await fetch(origin + p, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const events = [];
  const connect = (input, sessionId = "sess_1") =>
    ConnectTool.call({ action: "connect", ...input }, { sessionId, workspace: dir, signal: new AbortController().signal, emitProgress: (d) => events.push(d) });
  return { dir, call, connect, events, woken, api };
}

const redirectFor = (authorizeUrl) => {
  const u = new URL(authorizeUrl);
  const r = new URL(u.searchParams.get("redirect_uri"));
  return `${r.origin}${r.pathname}?code=AUTHCODE123456&state=${u.searchParams.get("state")}`;
};

const writeCodexCred = async (dir) => {
  await fs.mkdir(path.join(dir, ".codex"), { recursive: true });
  await fs.writeFile(path.join(dir, ".codex", "auth.json"), JSON.stringify({ claudeAiOauth: { accessToken: "FAKE", expiresAt: Date.now() + 1e6 } }));
};

test("signed out: one card, no url, the call returns at once and the tool text has no link or code", async (t) => {
  const r = await rig(t);
  const t0 = Date.now();
  const res = await r.connect({ service: "provider:claude-code", reason: "to start a Claude Code remote chat" });
  assert.ok(Date.now() - t0 < 3000, "non-blocking: nothing waited for the owner");
  assert.equal(res.failure, undefined);
  assert.equal(res.output.pending, true);
  assert.equal(res.output.connected, false);
  const card = r.events.find((e) => e.kind === "connect_request");
  assert.ok(card, "a card was emitted");
  assert.equal(card.service, "provider:claude-code");
  assert.equal(card.providerId, "claude-code");
  assert.equal(card.label, "Claude Code");
  assert.equal(card.mode, "provider");
  assert.equal(card.method, "loopback");
  assert.equal(card.reason, "to start a Claude Code remote chat");
  assert.equal(card.url, undefined, "the card carries no URL: the app runs its own sign-in");
  assert.ok(!/https?:\/\//.test(JSON.stringify([res, r.events])), "no link in the tool result or card");
  assert.match(res.output.message, /Never print a login link or ask for a code/);
});

test("already signed in: answers immediately with the account and emits no card", async (t) => {
  const r = await rig(t);
  await fs.mkdir(path.join(r.dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(r.dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS", expiresAt: Date.now() + 1e6 } }));
  const res = await r.connect({ service: "provider:claude-code" });
  assert.equal(res.output.connected, true);
  assert.equal(res.output.account, "owner@example.com");
  assert.match(res.output.message, /already signed in as owner@example\.com/);
  assert.equal(r.events.length, 0);
  assert.ok(!/FAKE-/.test(JSON.stringify(res)));
});

test("the owner signs in on the phone; the session that asked is woken, once", async (t) => {
  const r = await rig(t);
  await r.connect({ service: "provider:claude-code" }, "sess_gandalf");
  assert.equal(r.woken.length, 0, "nothing yet");
  // the phone: the broker login the app starts for this card, completed through the real server
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(start.body.state, "open");
  assert.equal(r.woken.length, 0);
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: redirectFor(start.body.url) });
  assert.equal(done.body.state, "signed_in");
  assert.ok(await until(() => r.woken.length === 1), "the agent was resumed");
  assert.equal(r.woken[0].sessionId, "sess_gandalf");
  assert.match(r.woken[0].text, /Claude Code sign-in card/);
  assert.match(r.woken[0].text, /Carry on/);
  assert.ok(!/AUTHCODE|https?:/.test(r.woken[0].text), "no code or link in the wake note");
  await sleep(400);
  assert.equal(r.woken.length, 1, "woken exactly once");
  // the card flips: a connect_result follows the request
  assert.ok(r.events.some((e) => e.kind === "connect_result" && e.ok === true && e.flowId === r.events[0].flowId));
});

test("a sign-in made some other way (the Providers screen) also wakes the agent", async (t) => {
  const r = await rig(t);
  await r.connect({ service: "provider:codex" }, "sess_a");
  await writeCodexCred(r.dir);
  assert.ok(await until(() => r.woken.length === 1));
  assert.equal(r.woken[0].sessionId, "sess_a");
});

test("two sessions asking for the same provider are each woken", async (t) => {
  const r = await rig(t);
  await r.connect({ service: "provider:codex" }, "sess_a");
  await r.connect({ service: "provider:codex" }, "sess_b");
  await writeCodexCred(r.dir);
  assert.ok(await until(() => r.woken.length === 2));
  assert.deepEqual(r.woken.map((w) => w.sessionId).sort(), ["sess_a", "sess_b"]);
});

test("a provider that is not installed is reported, not carded; unknown ids and no broker fail plainly", async (t) => {
  const r = await rig(t);
  const kimi = await r.connect({ service: "provider:kimi-cli" });
  assert.ok(kimi.failure);
  assert.match(kimi.failure, /not installed/);
  assert.equal(r.events.length, 0);
  const bad = await r.connect({ service: "provider:skynet" });
  assert.match(bad.failure, /Unknown provider/);
  setProviderSignInHost(null);
  assert.equal(getProviderSignInHost(), null);
  const none = await r.connect({ service: "provider:claude-code" });
  assert.match(none.failure, /no provider sign-in broker/);
});

test("Ares's own logins are cards too (ares-anthropic is loopback, ares-kimi is device)", async (t) => {
  const r = await rig(t);
  const a = await r.connect({ service: "provider:ares-anthropic" });
  assert.equal(a.output.pending, true);
  assert.equal(r.events.at(-1).method, "loopback");
  const k = await r.connect({ service: "provider:ares-kimi" });
  assert.equal(k.output.pending, true);
  assert.equal(r.events.at(-1).method, "device");
});

test("the tool description tells the agent this is THE way to ask, and never to print links", () => {
  assert.match(ConnectTool.schema.description, /provider:<id>/);
  assert.match(ConnectTool.schema.description, /never print OAuth links/i);
});
