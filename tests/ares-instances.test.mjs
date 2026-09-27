import test from "node:test";
import assert from "node:assert/strict";
import {
  addIngress,
  domainFromPublicUrl,
  pairLink,
  parseListeningPorts,
  pickPorts,
  removeIngress,
  renderEnvFile,
  renderIdentity,
  renderUnit,
  validateInstanceName,
} from "../packages/tools/dist/aresInstances.js";
import { InstancesTool } from "../packages/tools/dist/Instances.js";
import { classifyToolRequest } from "../packages/cli/dist/policyGate.js";

const meta = {
  name: "scout",
  purpose: "watches the job boards",
  provider: "anthropic",
  model: "claude-opus-5-5",
  wsPort: 17431,
  httpPort: 17432,
  hostname: "scout-ares.example.com",
  image: "ares-instance:latest",
  limits: { memory: "4g", cpus: "2", pids: 512 },
  guarded: false,
  createdAt: "2026-09-27T00:00:00.000Z",
  createdBy: "Rook",
};

const TUNNEL = `tunnel: 1234
ingress:
  - hostname: ares.example.com
    service: http://localhost:7422
  - hostname: "*.example.com"
    service: http://localhost:8088
  - service: http_status:404
`;

test("instance names are dns- and unit-safe", () => {
  assert.equal(validateInstanceName("scout"), null);
  assert.equal(validateInstanceName("job-bot-2"), null);
  for (const bad of ["", "a", "Scout", "2fast", "bad_name", "trailing-", "x".repeat(31), "../etc"]) {
    assert.ok(validateInstanceName(bad), `${bad} should be rejected`);
  }
});

test("ports: skip anything taken, pairs stay adjacent", () => {
  assert.deepEqual(pickPorts(new Set()), { wsPort: 17431, httpPort: 17432 });
  assert.deepEqual(pickPorts(new Set([17432])), { wsPort: 17433, httpPort: 17434 });
  const ss = "LISTEN 0 511 127.0.0.1:17431 0.0.0.0:*\nLISTEN 0 4096 [::]:22 [::]:*\nLISTEN 0 4096 *:8081 *:*\n";
  assert.deepEqual([...parseListeningPorts(ss)].sort((a, b) => a - b), [22, 8081, 17431]);
});

test("unit runs a locked-down container on localhost-only ports", () => {
  const unit = renderUnit(meta, { root: "/home/me/ares-instances", user: "me" });
  for (const needle of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=4g",
    "-p 127.0.0.1:17431:7421 -p 127.0.0.1:17432:7422",
    "--env-file=/home/me/ares-instances/scout/instance.env",
    "-v /home/me/ares-instances/scout/data:/data:rw",
    "ares-instance:latest --provider anthropic --model claude-opus-5-5",
    "User=me",
    "Restart=always",
  ]) assert.ok(unit.includes(needle), `unit missing ${needle}`);
  assert.doesNotMatch(unit, /docker\.sock/);
});

test("env file carries the public URL and refuses injection", () => {
  const env = renderEnvFile(meta, { DEEPSEEK_API_KEY: "k" }, "America/New_York");
  assert.match(env, /^ARES_REMOTE_PUBLIC_URL=https:\/\/scout-ares\.example\.com$/m);
  assert.match(env, /^ARES_GARRISON_HOST=0\.0\.0\.0$/m);
  assert.match(env, /^DEEPSEEK_API_KEY=k$/m);
  assert.throws(() => renderEnvFile(meta, { "bad key": "x" }));
  assert.throws(() => renderEnvFile(meta, { OK: "one\nARES_HOME=/" }));
});

test("identity names the instance, its parent and its purpose", () => {
  const identity = renderIdentity(meta, "Rook", "doingbox");
  assert.match(identity, /^- Name: Scout$/m);
  assert.match(identity, /Spawned by: Rook on doingbox/);
  assert.match(identity, /watches the job boards/);
});

test("ingress goes above the wildcard and comes back out cleanly", () => {
  const added = addIngress(TUNNEL, "scout", "scout-ares.example.com", 17432);
  const lines = added.split("\n");
  const rule = lines.findIndex((l) => l.includes("scout-ares.example.com"));
  const wildcard = lines.findIndex((l) => l.includes('"*.example.com"'));
  assert.ok(rule > 0 && rule < wildcard, "rule must precede the wildcard");
  assert.equal(lines[rule + 1], "    service: http://127.0.0.1:17432");
  assert.throws(() => addIngress(added, "scout", "scout-ares.example.com", 17432), /already/);
  assert.equal(removeIngress(added, "scout"), TUNNEL);
  assert.equal(removeIngress(TUNNEL, "missing"), TUNNEL);
});

test("pair link matches the phone app's ares://pair format", () => {
  const link = new URL(pairLink("scout-ares.example.com", "tok en", "scout"));
  assert.equal(link.protocol, "ares:");
  const params = new URLSearchParams(link.search);
  assert.equal(params.get("url"), "wss://scout-ares.example.com/gateway");
  assert.equal(params.get("token"), "tok en");
  assert.equal(params.get("name"), "scout");
  assert.equal(domainFromPublicUrl("https://ares.mistiqueai.com"), "mistiqueai.com");
  assert.equal(domainFromPublicUrl("https://localhost:7422"), undefined);
});

test("the tool asks before removing, and a purge needs the owner", async () => {
  const ctx = { permissionMode: "bypass" };
  assert.deepEqual(await InstancesTool.checkPermissions({ action: "list" }, ctx), { kind: "allow" });
  assert.deepEqual(await InstancesTool.checkPermissions({ action: "create", name: "scout" }, ctx), { kind: "allow" });
  assert.equal((await InstancesTool.checkPermissions({ action: "pair_link", name: "scout" }, ctx)).kind, "ask");
  assert.equal((await InstancesTool.checkPermissions({ action: "remove", name: "scout" }, ctx)).kind, "ask");
  const purge = await InstancesTool.checkPermissions({ action: "remove", name: "scout", purge: true }, ctx);
  assert.equal(purge.kind, "ask");
  assert.equal(purge.ownerDecision, true);
  assert.equal((await InstancesTool.checkPermissions({ action: "create", name: "scout" }, { permissionMode: "plan" })).kind, "deny");
});

test("policy gate: reads free, pairing is a secret, purge is destructive", () => {
  const req = (input) => ({ toolName: "Instances", reason: "", input });
  assert.equal(classifyToolRequest(req({ action: "list" })), null);
  assert.equal(classifyToolRequest(req({ action: "create", name: "scout" })), "shell_mutating");
  assert.equal(classifyToolRequest(req({ action: "pair_link", name: "scout" })), "credential_or_secret");
  assert.equal(classifyToolRequest(req({ action: "remove", name: "scout" })), "shell_mutating");
  assert.equal(classifyToolRequest(req({ action: "remove", name: "scout", purge: true })), "shell_destructive");
});
