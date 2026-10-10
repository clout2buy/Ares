// Agent-attributed pushes: mutable-content + {agentId, agentName, avatarVersion, accent}
// so the phone's Notification Service Extension can draw the agent's picture and name.
// Real APNs payloads captured through the transport seam; nothing secret rides along.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { PhonePush, PhoneNotifier, agentPayload } from "../packages/cli/dist/phonePush.js";

const CFG = { keyPath: "unused", keyId: "K", teamId: "T", bundleId: "com.doingteam.ares" };
const AGENT = { id: "rex", name: "Rex", accent: "#ff7a1a", avatarVersion: "abc123" };

async function rig(t, directory) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-pushagent-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, "k.p8");
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await fsp.writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const seen = [];
  const push = new PhonePush(path.join(dir, "p.json"), { ...CFG, keyPath }, () => {}, async (_c, req) => { seen.push(JSON.parse(req.body)); return 200; });
  await push.register({ token: "dev1", platform: "ios" });
  if (directory) push.setAgentDirectory(directory);
  return { push, seen };
}

test("buildRequest: an attributed push is mutable-content with small agent fields and a per-agent thread", () => {
  const req = PhonePush.buildRequest(CFG, "tok", "jwt", { title: "Rex", body: "hi", data: { kind: "persona_message", sessionId: "s1" }, agent: AGENT }, "alert");
  const body = JSON.parse(req.body);
  assert.equal(body.aps["mutable-content"], 1);
  assert.equal(body.aps["thread-id"], "agent-rex", "groups by agent, not by session");
  assert.equal(body.aps.alert.title, "Rex");
  assert.equal(body.agentId, "rex");
  assert.equal(body.agentName, "Rex");
  assert.equal(body.avatarVersion, "abc123");
  assert.equal(body.accent, "#ff7a1a");
  assert.equal(body.sessionId, "s1", "existing data still rides along");
  assert.ok(req.body.length < 600, "payload stays small");
  assert.equal(req.headers["apns-push-type"], "alert");
});

test("buildRequest: no agent means no mutable-content and the old thread-id", () => {
  const body = JSON.parse(PhonePush.buildRequest(CFG, "tok", "jwt", { title: "t", body: "b", data: { kind: "turn_end", sessionId: "s1" } }, "alert").body);
  assert.equal(body.aps["mutable-content"], undefined);
  assert.equal(body.aps["thread-id"], "s1");
  assert.equal(body.agentId, undefined);
});

test("agentPayload drops a bad colour and an unsafe version, never invents a picture", () => {
  assert.deepEqual(agentPayload({ id: "a", name: "  A  b ", accent: "red", avatarVersion: "../x" }), { agentId: "a", agentName: "A b" });
  assert.deepEqual(agentPayload({ id: "a", name: "A", accent: "#abc" }), { agentId: "a", agentName: "A", accent: "#abc" });
});

test("a background (silent) push is never made mutable", () => {
  const body = JSON.parse(PhonePush.buildRequest(CFG, "tok", "jwt", { title: "", body: "", data: { agentId: "rex" }, agent: AGENT }, "background").body);
  assert.equal(body.aps["mutable-content"], undefined);
  assert.equal(body.aps["content-available"], 1);
});

test("send enriches a push that only carries data.agentId (inbox, briefing, goals)", async (t) => {
  const { push, seen } = await rig(t, (id) => (id === "rex" ? AGENT : undefined));
  await push.send({ title: "Rex finished: a.pdf", body: "Done.", data: { kind: "inbox", agentId: "rex" } });
  await push.send({ title: "x", body: "y", data: { kind: "inbox", agentId: "unknown" } });
  await push.send({ title: "x", body: "y", data: { kind: "inbox", agentId: "../../etc" } });
  assert.equal(seen[0].aps["mutable-content"], 1);
  assert.equal(seen[0].avatarVersion, "abc123");
  assert.equal(seen[1].aps["mutable-content"], undefined, "unknown agent: plain banner");
  assert.equal(seen[2].aps["mutable-content"], undefined, "malformed id is not looked up");
});

test("notifier: permission, reply and failed-turn pushes carry the session's agent; staged approvals use the agent name", async (t) => {
  const { push, seen } = await rig(t);
  const wait = () => new Promise((r) => setTimeout(r, 30));
  const notifier = new PhoneNotifier({
    gatewayUrl: "ws://127.0.0.1:1",
    token: "x",
    push,
    agentName: () => "Rex",
    agentOf: (sid) => (sid === "s1" ? AGENT : undefined),
    stagedAgent: () => AGENT,
    isMobileSession: () => true,
  });
  notifier.handleEvent("s1", { type: "permission_request", id: "p1", toolName: "Bash", input: { command: "ls" }, reason: "" });
  await wait();
  assert.equal(seen[0].aps.alert.title, "Rex needs permission");
  assert.equal(seen[0].agentId, "rex");
  assert.equal(seen[0].aps["mutable-content"], 1);
  assert.equal(seen[0].aps["thread-id"], "agent-rex");
  assert.ok(!JSON.stringify(seen[0]).includes("jwt"), "no credentials in the payload");

  notifier.handleEvent("s1", { type: "turn_start" });
  notifier.handleEvent("s1", { type: "text_delta", text: "All done." });
  notifier.handleEvent("s1", { type: "turn_end", status: "ok" });
  await wait();
  assert.equal(seen[1].kind, "persona_message");
  assert.equal(seen[1].agentName, "Rex");

  notifier.handleEvent("s1", { type: "turn_start" });
  notifier.handleEvent("s1", { type: "turn_end", status: "failed" });
  await wait();
  assert.equal(seen[2].kind, "turn_end");
  assert.equal(seen[2].aps.alert.title, "Rex hit a problem");
  assert.equal(seen[2].agentId, "rex");

  notifier.handleStaged({ id: "eff1", kind: "browser.submit", domain: "x", irreversibility: "irreversible", reason: "post the form" });
  await wait();
  assert.equal(seen[3].aps.alert.title, "Rex needs approval", "no more hardcoded 'Ares needs approval' when an agent is known");
  assert.equal(seen[3].agentId, "rex");
});

test("notifier without an agent resolver keeps the old, unattributed banner", async (t) => {
  const { push, seen } = await rig(t);
  const notifier = new PhoneNotifier({ gatewayUrl: "ws://127.0.0.1:1", token: "x", push, isMobileSession: () => true });
  notifier.handleStaged({ id: "eff2", kind: "k", domain: "d", irreversibility: "irreversible", reason: "r" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen[0].aps.alert.title, "Ares needs approval");
  assert.equal(seen[0].aps["mutable-content"], undefined);
});
