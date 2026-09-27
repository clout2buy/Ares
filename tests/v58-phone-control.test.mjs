// The settings sheet on the phone: providers, models, the effort dial, and the
// standing permission grants.
//
// The owner could set all three from a terminal and none of them from the
// device they actually carry. These tests pin the contract the app renders
// against — including the two things that decide whether the sheet is SAFE:
// a provider that is down must read as an empty list rather than a 500, and a
// grant the owner revokes must be gone from disk, not just from memory.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { AresCommandPermissionStore } from "../packages/cli/dist/entry/permissions.js";

const auth = { authorization: "Bearer tok", "content-type": "application/json" };

/** A server wired to an in-memory cockpit, so the tests pin the HTTP contract
 *  rather than the provider registry. */
async function serve(t, control) {
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: control ? { control } : {},
  });
  await server.start();
  t.after(() => server.close());
  return `http://127.0.0.1:${server.port}`;
}

function cockpit(overrides = {}) {
  const state = { effort: "medium", rules: [{ pattern: "Bash(git push *)", effect: "allow", source: "user-global" }] };
  return {
    state,
    hooks: {
      providers: () => ["anthropic", "deepseek"],
      models: async () => [{ id: "k3", label: "Kimi K3", effortLevels: ["low", "high"] }],
      effort: () => ({ current: state.effort, levels: ["low", "medium", "high"] }),
      setEffort: async (level) => { state.effort = level; },
      permissions: () => state.rules,
      revokePermission: async (pattern) => {
        const before = state.rules.length;
        state.rules = state.rules.filter((r) => r.pattern !== pattern);
        return state.rules.length < before;
      },
      ...overrides,
    },
  };
}

test("the sheet opens with providers, the effort dial, and standing grants in one round trip", async (t) => {
  const { hooks } = cockpit();
  const base = await serve(t, hooks);
  const res = await fetch(`${base}/gateway/control`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.providers, ["anthropic", "deepseek"]);
  assert.deepEqual(body.effort, { current: "medium", levels: ["low", "medium", "high"] });
  assert.deepEqual(body.permissions, [{ pattern: "Bash(git push *)", effect: "allow", source: "user-global" }]);
  // Models cost a provider API call each, so they are NOT in the overview.
  assert.equal(body.models, undefined, "models are fetched per provider, not up front");
});

test("models come per provider, with the effort rungs that model honours", async (t) => {
  const { hooks } = cockpit();
  const base = await serve(t, hooks);
  const res = await fetch(`${base}/gateway/control/models?provider=kimi`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, "kimi");
  assert.deepEqual(body.models, [{ id: "k3", label: "Kimi K3", effortLevels: ["low", "high"] }]);
  const bare = await fetch(`${base}/gateway/control/models`, { headers: auth });
  assert.equal(bare.status, 400, "a provider is required");
});

test("a provider that is down reads as an empty list, not a failed sheet", async (t) => {
  const { hooks } = cockpit({ models: async () => { throw new Error("ECONNREFUSED 127.0.0.1:11434"); } });
  const base = await serve(t, hooks);
  const res = await fetch(`${base}/gateway/control/models?provider=ollama`, { headers: auth });
  assert.equal(res.status, 200, "the app renders 'no models', it does not show an error screen");
  const body = await res.json();
  assert.deepEqual(body.models, []);
  assert.match(body.error, /ECONNREFUSED/, "…but it still says why");
});

test("the effort dial only accepts rungs the machine actually offers", async (t) => {
  const { hooks, state } = cockpit();
  const base = await serve(t, hooks);
  const bad = await fetch(`${base}/gateway/control/effort`, { method: "POST", headers: auth, body: JSON.stringify({ level: "ludicrous" }) });
  assert.equal(bad.status, 400);
  assert.equal(state.effort, "medium", "a bogus level changes nothing");
  const ok = await fetch(`${base}/gateway/control/effort`, { method: "POST", headers: auth, body: JSON.stringify({ level: "HIGH" }) });
  assert.equal(ok.status, 200);
  assert.equal(state.effort, "high", "case-insensitive, like every other dial");
  assert.deepEqual((await ok.json()).effort, { current: "high", levels: ["low", "medium", "high"] }, "the response is the new truth");
});

test("revoking a grant answers with what is left; an unknown pattern is a 404", async (t) => {
  const { hooks } = cockpit();
  const base = await serve(t, hooks);
  const miss = await fetch(`${base}/gateway/control/permissions/revoke`, { method: "POST", headers: auth, body: JSON.stringify({ pattern: "Bash(rm *)" }) });
  assert.equal(miss.status, 404);
  const hit = await fetch(`${base}/gateway/control/permissions/revoke`, { method: "POST", headers: auth, body: JSON.stringify({ pattern: "Bash(git push *)" }) });
  assert.equal(hit.status, 200);
  assert.deepEqual((await hit.json()).permissions, [], "the sheet re-renders from the response");
});

test("the cockpit is behind the owner's token, and absent when unwired", async (t) => {
  const { hooks } = cockpit();
  const withHooks = await serve(t, hooks);
  const anon = await fetch(`${withHooks}/gateway/control`);
  assert.equal(anon.status, 401, "no token, no cockpit");

  const bare = await serve(t, null);
  for (const [method, url, body] of [
    ["GET", "/gateway/control", undefined],
    ["GET", "/gateway/control/models?provider=x", undefined],
    ["POST", "/gateway/control/effort", JSON.stringify({ level: "high" })],
    ["POST", "/gateway/control/permissions/revoke", JSON.stringify({ pattern: "x" })],
  ]) {
    const res = await fetch(`${bare}${url}`, { method, headers: auth, ...(body ? { body } : {}) });
    assert.equal(res.status, 501, `${method} ${url} says the machine exposes no control`);
  }
});

test("revoke removes an always-allow from disk, not just from this session", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-perm-"));
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-ws-"));
  t.after(() => Promise.all([fsp.rm(home, { recursive: true, force: true }), fsp.rm(workspace, { recursive: true, force: true })]));
  const context = { aresHome: home, workspace };

  const store = await AresCommandPermissionStore.load(context);
  await store.grant("Bash", "git push origin main", "always");
  const pattern = store.list()[0].pattern;
  assert.equal(store.decide("Bash", "git push origin main")?.kind, "allow");

  assert.equal(await store.revoke(pattern), true);
  assert.deepEqual(store.list(), [], "gone from this session");
  assert.equal(store.decide("Bash", "git push origin main"), null, "and it asks again");

  // The point of the whole exercise: the NEXT session must not re-inherit it.
  const reloaded = await AresCommandPermissionStore.load(context);
  assert.deepEqual([...reloaded.list()], [], "gone from disk too");

  assert.equal(await store.revoke(pattern), false, "revoking twice is not an error, just a no-op");
});

test("a project rule is the repo's to change, not the phone's", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-perm-"));
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-ws-"));
  t.after(() => Promise.all([fsp.rm(home, { recursive: true, force: true }), fsp.rm(workspace, { recursive: true, force: true })]));
  await fsp.mkdir(path.join(workspace, ".ares"), { recursive: true });
  await fsp.writeFile(
    path.join(workspace, ".ares", "command-permissions.json"),
    JSON.stringify({ rules: [{ pattern: "Bash(pnpm test)", effect: "allow" }] }),
  );
  const store = await AresCommandPermissionStore.load({ aresHome: home, workspace });
  assert.equal(store.list()[0].source, "project");
  assert.equal(await store.revoke("Bash(pnpm test)"), false, "the owner's phone cannot edit the repo's policy");
  assert.equal(store.list().length, 1, "and the rule stands");
});
