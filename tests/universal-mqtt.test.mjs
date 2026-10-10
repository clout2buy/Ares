// The Mqtt tool. Default suite: an in-process fake broker speaking real MQTT
// 3.1.1 on 127.0.0.1 (deterministic, offline). Integration: a throwaway
// Mosquitto container (anonymous, password and TLS listeners) — skipped unless
// ARES_UNIVERSAL_INTEGRATION=1 and Docker works.

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MqttTool,
  MqttClient,
  parseMqttUrl,
  validateTopicName,
  validateTopicFilter,
  previewPayload,
  publishNeedsOwnerDecision,
  NetBlockedError,
} from "../packages/tools/dist/index.js";
import { setCredential, deleteCredential } from "../packages/core/dist/index.js";
import { classifyToolRequest } from "../packages/cli/dist/policyGate.js";
import { UNIVERSAL_VERIFIERS } from "../packages/cli/dist/connectVerifiersApi.js";

const ctx = (permissionMode = "workspace-write") => ({ signal: new AbortController().signal, permissionMode });
const tool = (input, mode) => MqttTool.call(MqttTool.inputZod.parse(input), ctx(mode));

// ─── a small real MQTT broker ────────────────────────────────────────────────

function matches(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

const utf = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s) >> 8, Buffer.byteLength(s) & 255]), Buffer.from(s)]);
function enc(type, flags, body) {
  const len = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    len.push(d);
  } while (n > 0);
  return Buffer.concat([Buffer.from([(type << 4) | flags]), Buffer.from(len), body]);
}

async function startBroker(t, { user, pass, deny = [], maxPacketBytes } = {}) {
  const retained = new Map();
  const clients = new Set();
  const log = { connects: [], publishes: [] };
  const server = net.createServer((socket) => {
    const me = { socket, subs: [] };
    clients.add(me);
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let mult = 1, len = 0, i = 1, b;
        do {
          if (i >= buf.length) return;
          b = buf[i++];
          len += (b & 127) * mult;
          mult *= 128;
        } while (b & 128);
        if (buf.length < i + len) return;
        const header = buf[0];
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        const type = header >> 4;
        if (type === 1) {
          let p = 2 + body.readUInt16BE(0) + 1; // protocol name + level
          const flags = body[p];
          p += 1 + 2;
          const cid = body.subarray(p + 2, p + 2 + body.readUInt16BE(p)).toString();
          p += 2 + body.readUInt16BE(p);
          let u, w;
          if (flags & 0x80) { const l = body.readUInt16BE(p); u = body.subarray(p + 2, p + 2 + l).toString(); p += 2 + l; }
          if (flags & 0x40) { const l = body.readUInt16BE(p); w = body.subarray(p + 2, p + 2 + l).toString(); p += 2 + l; }
          log.connects.push({ cid, u, w });
          const ok = !user || (u === user && w === pass);
          socket.write(enc(2, 0, Buffer.from([0, ok ? 0 : 4])));
          if (!ok) socket.end();
        } else if (type === 8) {
          const id = body.readUInt16BE(0);
          let p = 2;
          const granted = [];
          const filters = [];
          while (p < body.length) {
            const l = body.readUInt16BE(p);
            const filter = body.subarray(p + 2, p + 2 + l).toString();
            p += 2 + l + 1;
            const refused = deny.some((d) => filter.startsWith(d));
            granted.push(refused ? 0x80 : 1);
            if (!refused) { me.subs.push(filter); filters.push(filter); }
          }
          socket.write(enc(9, 0, Buffer.concat([Buffer.from([id >> 8, id & 255]), Buffer.from(granted)])));
          for (const [topic, payload] of retained) if (filters.some((f) => matches(f, topic))) socket.write(enc(3, 1, Buffer.concat([utf(topic), payload])));
        } else if (type === 3) {
          const qos = (header >> 1) & 3;
          const retain = header & 1;
          const tl = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tl).toString();
          let p = 2 + tl;
          let id = 0;
          if (qos) { id = body.readUInt16BE(p); p += 2; }
          const payload = body.subarray(p);
          log.publishes.push({ topic, payload: payload.toString(), qos, retain: !!retain });
          if (qos === 1) socket.write(enc(4, 0, Buffer.from([id >> 8, id & 255])));
          if (retain) payload.length ? retained.set(topic, Buffer.from(payload)) : retained.delete(topic);
          for (const c of clients) if (c.subs.some((f) => matches(f, topic))) c.socket.write(enc(3, 0, Buffer.concat([utf(topic), payload])));
        } else if (type === 12) socket.write(Buffer.from([0xd0, 0]));
        else if (type === 14) socket.end();
      }
    });
    socket.on("close", () => clients.delete(me));
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { for (const c of clients) c.socket.destroy(); server.close(r); }));
  const port = server.address().port;
  return {
    port,
    url: `mqtt://${user ? `${user}:${pass}@` : ""}127.0.0.1:${port}`,
    log,
    retained,
    /** Send a raw message to every matching subscriber, as if another client published it. */
    inject(topic, payload, retain = false) {
      const body = Buffer.concat([utf(topic), Buffer.from(payload)]);
      if (retain) retained.set(topic, Buffer.from(payload));
      for (const c of clients) if (c.subs.some((f) => matches(f, topic))) c.socket.write(enc(3, 0, body));
    },
    sendRaw(bytes) {
      for (const c of clients) c.socket.write(bytes);
    },
  };
}

async function useBroker(t, broker) {
  await setCredential("MQTT_URL", broker.url);
  t.after(() => deleteCredential("MQTT_URL"));
}

// ─── pure pieces ─────────────────────────────────────────────────────────────

test("broker URLs, topic names, filters and payload previews", () => {
  assert.deepEqual(parseMqttUrl("mqtt://user:p%40ss@10.0.0.5"), { host: "10.0.0.5", port: 1883, tls: false, insecureTls: false, username: "user", password: "p@ss" });
  assert.deepEqual(parseMqttUrl("mqtts://broker.lan:8884?insecure=1"), { host: "broker.lan", port: 8884, tls: true, insecureTls: true });
  assert.equal(parseMqttUrl("mqtts://b.example").port, 8883);
  assert.throws(() => parseMqttUrl("http://x"), /unsupported broker scheme/);
  assert.throws(() => parseMqttUrl("not a url"), /not valid/);
  assert.equal(validateTopicName("home/kitchen/light"), null);
  assert.match(validateTopicName("home/+/light"), /wildcards/);
  assert.match(validateTopicName("home/#"), /wildcards/);
  assert.match(validateTopicName("$SYS/broker/load"), /belong to the broker/);
  assert.match(validateTopicName(""), /required/);
  assert.equal(validateTopicFilter("home/+/temp"), null);
  assert.equal(validateTopicFilter("#"), null);
  assert.equal(validateTopicFilter("a/b/#"), null);
  assert.match(validateTopicFilter("a/#/b"), /last level/);
  assert.match(validateTopicFilter("a/b+/c"), /whole level/);
  assert.equal(previewPayload(Buffer.from('{"a":1}')), '{"a":1}');
  assert.match(previewPayload(Buffer.from([0xff, 0xfe, 0x00, 0x01])), /^base64:/);
  assert.ok(previewPayload(Buffer.from("x".repeat(5000))).length <= 2001);
  assert.ok(publishNeedsOwnerDecision("home/front-door/lock", "LOCK"));
  assert.ok(publishNeedsOwnerDecision("alarm/panel", "ARM"));
  assert.ok(publishNeedsOwnerDecision("zigbee2mqtt/garage/set", "OPEN"));
  assert.ok(publishNeedsOwnerDecision("home/x", "", true), "clearing a retained message");
  assert.equal(publishNeedsOwnerDecision("home/kitchen/light/set", "ON"), null);
  assert.equal(publishNeedsOwnerDecision("home/blockade/x", "1"), null, "a word inside a word is not a match");
});

// ─── the tool against the fake broker ────────────────────────────────────────

test("not connected points at Connect; status connects", async (t) => {
  await deleteCredential("MQTT_URL");
  const none = await tool({ action: "status" });
  assert.match(none.failure, /Connect with service "mqtt"/);
  const broker = await startBroker(t);
  await useBroker(t, broker);
  const ok = await tool({ action: "status" });
  assert.equal(ok.failure, undefined);
  assert.match(ok.output.message, /Connected to mqtt:\/\/127\.0\.0\.1:/);
  assert.ok(!JSON.stringify(ok.output).includes("@"), "no credentials in the output");
});

test("subscribe collects live messages up to the cap and then stops early", async (t) => {
  const broker = await startBroker(t);
  await useBroker(t, broker);
  const listening = tool({ action: "subscribe", topic: "home/+/temp", seconds: 5, max_messages: 2 });
  await new Promise((r) => setTimeout(r, 250));
  broker.inject("home/kitchen/temp", "21.5");
  broker.inject("home/other/humidity", "40"); // does not match
  broker.inject("home/garage/temp", JSON.stringify({ c: 12 }));
  broker.inject("home/attic/temp", "30"); // over max_messages
  const t0 = Date.now();
  const r = await listening;
  assert.ok(Date.now() - t0 < 2000, "returned as soon as max_messages arrived");
  assert.equal(r.failure, undefined, r.output.message);
  assert.deepEqual(r.output.messages.map((m) => [m.topic, m.payload]), [["home/kitchen/temp", "21.5"], ["home/garage/temp", '{"c":12}']]);
  assert.equal(r.output.messages[0].retained, false);

  const quiet = await tool({ action: "subscribe", topic: "nothing/here", seconds: 1 });
  assert.match(quiet.output.message, /Nothing arrived on nothing\/here in 1s/);
});

test("retained returns the last known values and only those", async (t) => {
  const broker = await startBroker(t);
  await useBroker(t, broker);
  broker.retained.set("status/door", Buffer.from("closed"));
  broker.retained.set("status/window", Buffer.from("open"));
  broker.retained.set("other/x", Buffer.from("1"));
  const r = await tool({ action: "retained", topic: "status/#" });
  assert.deepEqual(r.output.messages.map((m) => [m.topic, m.payload, m.retained]).sort(), [["status/door", "closed", true], ["status/window", "open", true]]);
  const none = await tool({ action: "retained", topic: "absent/#" });
  assert.match(none.output.message, /No retained messages under absent\/#/);
});

test("tree snapshots the topics under a filter with counts, previews and caps", async (t) => {
  const broker = await startBroker(t);
  await useBroker(t, broker);
  broker.retained.set("z2m/lamp", Buffer.from('{"state":"ON"}'));
  const walking = tool({ action: "tree", topic: "z2m/#", seconds: 1, max_topics: 3 });
  await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 6; i++) broker.inject(`z2m/sensor${i}`, String(i));
  broker.inject("z2m/sensor0", "again");
  broker.inject("$SYS/broker/load", "9");
  const r = await walking;
  assert.equal(r.output.topics.length, 3, "capped at max_topics");
  assert.match(r.output.message, /7 topics seen under z2m\/#.*4 more topics not shown/);
  const lamp = r.output.topics.find((x) => x.topic === "z2m/lamp");
  assert.equal(lamp.retained, true);
  assert.equal(lamp.last, '{"state":"ON"}');
  const again = await tool({ action: "tree", topic: "z2m/#", seconds: 1, max_topics: 50 });
  assert.ok(!again.output.topics.some((x) => x.topic.startsWith("$SYS")));
});

test("publish sends QoS 0/1, retained or not, and refuses wildcards and $SYS", async (t) => {
  const broker = await startBroker(t);
  await useBroker(t, broker);
  const a = await tool({ action: "publish", topic: "home/kitchen/light/set", payload: "ON" });
  assert.match(a.output.message, /Published 2 bytes to home\/kitchen\/light\/set\./);
  const b = await tool({ action: "publish", topic: "home/status", payload: { a: 1, b: [true] }, retain: true, qos: 1 });
  assert.match(b.output.message, /\(retained\)/);
  assert.deepEqual(broker.log.publishes.map((p) => [p.topic, p.payload, p.qos, p.retain]), [
    ["home/kitchen/light/set", "ON", 0, false],
    ["home/status", '{"a":1,"b":[true]}', 1, true],
  ]);
  assert.match((await tool({ action: "publish", topic: "home/#", payload: "x" })).failure, /wildcards/);
  assert.match((await tool({ action: "publish", topic: "$SYS/x", payload: "x" })).failure, /belong to the broker/);
  assert.match((await tool({ action: "publish", payload: "x" })).failure, /topic is required/);
  assert.match((await tool({ action: "publish", topic: "t", payload: "x".repeat(300_000) })).failure, /larger than 256 KB/);
  assert.match((await tool({ action: "subscribe", topic: "a/#/b" })).failure, /last level/);
  assert.match((await tool({ action: "subscribe" })).failure, /needs topic/);
});

test("publish gating: asks in guarded modes; lock/alarm topics and clearing a retained message are the owner's decision", async () => {
  const permit = (input, mode) => MqttTool.checkPermissions(MqttTool.inputZod.parse(input), ctx(mode));
  assert.equal((await permit({ action: "subscribe", topic: "a/#" }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "tree" }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "publish", topic: "home/lamp/set", payload: "ON" }, "workspace-write")).kind, "ask", "generic ask for a write");
  assert.equal((await permit({ action: "publish", topic: "home/lamp/set", payload: "ON" }, "bypass")).kind, "allow");
  assert.equal((await permit({ action: "publish", topic: "home/lamp/set", payload: "ON" }, "plan")).kind, "deny");
  const lock = await permit({ action: "publish", topic: "home/front/lock/set", payload: "UNLOCK" }, "bypass");
  assert.equal(lock.kind, "ask");
  assert.equal(lock.ownerDecision, true);
  const wipe = await permit({ action: "publish", topic: "home/state", retain: true }, "bypass");
  assert.equal(wipe.ownerDecision, true);
  assert.equal(classifyToolRequest({ toolName: "Mqtt", reason: "", input: { action: "publish", topic: "x" } }), "browser_submit");
  assert.equal(classifyToolRequest({ toolName: "Mqtt", reason: "", input: { action: "subscribe", topic: "x" } }), null);
});

test("wrong password, refused subscriptions and hostile brokers fail with sentences, never hangs", async (t) => {
  const broker = await startBroker(t, { user: "ares", pass: "right", deny: ["secret/"] });
  await setCredential("MQTT_URL", `mqtt://ares:wrong@127.0.0.1:${broker.port}`);
  t.after(() => deleteCredential("MQTT_URL"));
  const bad = await tool({ action: "status" });
  assert.match(bad.failure, /username or password is wrong/);
  assert.ok(!bad.failure.includes("wrong@"), "the URL is not echoed");

  await setCredential("MQTT_URL", `mqtt://ares:right@127.0.0.1:${broker.port}`);
  assert.equal((await tool({ action: "status" })).failure, undefined);
  assert.equal(broker.log.connects.at(-1).u, "ares");
  assert.match((await tool({ action: "subscribe", topic: "secret/stuff", seconds: 1 })).failure, /refused the subscription to secret\/stuff/);

  // a broker that sends an absurd packet is cut off
  const listening = tool({ action: "subscribe", topic: "x/y", seconds: 5 });
  await new Promise((r) => setTimeout(r, 250));
  broker.sendRaw(Buffer.from([0x30, 0xff, 0xff, 0xff, 0x7f])); // remaining length ~268 MB
  const r = await listening;
  assert.match(r.failure, /-byte packet|closed the connection/);

  // nothing listening
  await setCredential("MQTT_URL", "mqtt://127.0.0.1:1");
  assert.match((await tool({ action: "status" })).failure, /ECONNREFUSED|could not reach/);
});

test("the network guard applies to brokers too: metadata and link-local are never reachable", async (t) => {
  await assert.rejects(() => MqttClient.connect({ host: "169.254.169.254", port: 1883, tls: false, insecureTls: false }), (e) => e instanceof NetBlockedError && /metadata/.test(e.message));
  await assert.rejects(() => MqttClient.connect({ host: "169.254.1.1", port: 1883, tls: false, insecureTls: false }), /link-local/);
  await assert.rejects(() => MqttClient.connect({ host: "metadata.google.internal", port: 1883, tls: false, insecureTls: false }), /metadata/);
  await assert.rejects(() => MqttClient.connect({ host: "rebind.example.com", port: 1883, tls: false, insecureTls: false, resolver: async () => [{ address: "169.254.169.254", family: 4 }] }), /metadata/);
  await setCredential("MQTT_URL", "mqtt://169.254.169.254:1883");
  t.after(() => deleteCredential("MQTT_URL"));
  assert.match((await tool({ action: "status" })).failure, /metadata/);
});

test("the connect form's verifier says hello to the broker", async (t) => {
  const broker = await startBroker(t, { user: "u", pass: "p" });
  const ok = await UNIVERSAL_VERIFIERS.mqtt({ MQTT_URL: `mqtt://u:p@127.0.0.1:${broker.port}` }, new AbortController().signal);
  assert.match(ok, /Connected to the broker at 127\.0\.0\.1/);
  await assert.rejects(() => UNIVERSAL_VERIFIERS.mqtt({ MQTT_URL: `mqtt://u:nope@127.0.0.1:${broker.port}` }, new AbortController().signal), /username or password is wrong/);
});

// ─── a real Mosquitto ────────────────────────────────────────────────────────

function dockerOk() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const INTEGRATION = process.env.ARES_UNIVERSAL_INTEGRATION === "1";
const SKIP = !INTEGRATION ? "set ARES_UNIVERSAL_INTEGRATION=1 to run against a real Mosquitto" : !dockerOk() ? "Docker is not available" : false;

test("real Mosquitto: anonymous, password and TLS listeners; publish, retain, subscribe, tree", { skip: SKIP, timeout: 240_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-mosq-"));
  const name = `ares-uni-mosquitto-${process.pid}`;
  t.after(async () => {
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" }); } catch { /* already gone */ }
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe", cwd: dir }).toString();
  // a CA and a server certificate for 127.0.0.1
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=ares-test-ca"]);
  sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1"]);
  await fsp.writeFile(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
  sh("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "ext.cnf"]);
  await fsp.writeFile(
    path.join(dir, "mosquitto.conf"),
    [
      "persistence false",
      "per_listener_settings true",
      "listener 1883",
      "allow_anonymous false",
      "password_file /mosquitto/config/passwd",
      "listener 1884",
      "allow_anonymous true",
      "listener 8883",
      "allow_anonymous true",
      "cafile /mosquitto/config/ca.crt",
      "certfile /mosquitto/config/server.crt",
      "keyfile /mosquitto/config/server.key",
      "",
    ].join("\n"),
  );
  await fsp.writeFile(path.join(dir, "passwd"), "");
  execFileSync("docker", ["run", "--rm", "-v", `${dir}:/c`, "eclipse-mosquitto:2", "mosquitto_passwd", "-b", "/c/passwd", "ares", "s3cret pass"], { stdio: "pipe", timeout: 180_000 });
  await fsp.chmod(dir, 0o755);
  for (const f of await fsp.readdir(dir)) await fsp.chmod(path.join(dir, f), 0o644);
  execFileSync("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1::1883", "-p", "127.0.0.1::1884", "-p", "127.0.0.1::8883", "-v", `${dir}:/mosquitto/config:ro`, "eclipse-mosquitto:2"], { stdio: "pipe", timeout: 60_000 });
  const portOf = (p) => Number(execFileSync("docker", ["port", name, `${p}/tcp`]).toString().trim().split(/\s+/)[0].split(":").pop());
  const ports = { auth: portOf(1883), anon: portOf(1884), tls: portOf(8883) };
  // wait for the broker
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      (await MqttClient.connect({ host: "127.0.0.1", port: ports.anon, tls: false, insecureTls: false, connectTimeoutMs: 1500 })).close();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(up, `Mosquitto did not come up: ${execFileSync("docker", ["logs", name]).toString().slice(-400)}`);
  t.after(() => deleteCredential("MQTT_URL"));

  await t.test("anonymous listener: publish retained, read it back, see live messages and the tree", async () => {
    await setCredential("MQTT_URL", `mqtt://127.0.0.1:${ports.anon}`);
    assert.match((await tool({ action: "status" })).output.message, /Connected/);
    assert.equal((await tool({ action: "publish", topic: "ares/test/state", payload: { on: true }, retain: true, qos: 1 })).failure, undefined);
    const retained = await tool({ action: "retained", topic: "ares/test/#", seconds: 2 });
    assert.deepEqual(retained.output.messages.map((m) => [m.topic, m.payload, m.retained]), [["ares/test/state", '{"on":true}', true]]);
    const live = tool({ action: "subscribe", topic: "ares/live/+", seconds: 6, max_messages: 2 });
    await new Promise((r) => setTimeout(r, 600));
    await tool({ action: "publish", topic: "ares/live/a", payload: "one" });
    await tool({ action: "publish", topic: "ares/live/b", payload: "two", qos: 1 });
    const got = await live;
    assert.deepEqual(got.output.messages.map((m) => m.payload), ["one", "two"]);
    const tree = await tool({ action: "tree", topic: "ares/#", seconds: 2 });
    assert.ok(tree.output.topics.some((x) => x.topic === "ares/test/state" && x.retained));
    // clearing the retained message
    await tool({ action: "publish", topic: "ares/test/state", payload: "", retain: true });
    assert.match((await tool({ action: "retained", topic: "ares/test/#", seconds: 2 })).output.message, /No retained messages/);
    t.diagnostic(`mosquitto anonymous listener OK (${new Date().toISOString()})`);
  });

  await t.test("password listener: a password with a space works; wrong and missing credentials are refused", async () => {
    await setCredential("MQTT_URL", `mqtt://ares:${encodeURIComponent("s3cret pass")}@127.0.0.1:${ports.auth}`);
    assert.match((await tool({ action: "status" })).output.message, /Connected/);
    await setCredential("MQTT_URL", `mqtt://ares:nope@127.0.0.1:${ports.auth}`);
    assert.match((await tool({ action: "status" })).failure, /username or password is wrong|not authorised/);
    await setCredential("MQTT_URL", `mqtt://127.0.0.1:${ports.auth}`);
    assert.match((await tool({ action: "status" })).failure, /not authorised|wrong|closed the connection/);
    t.diagnostic("mosquitto password listener OK");
  });

  await t.test("TLS listener: a self-signed broker is refused unless the owner says insecure=1", async () => {
    await setCredential("MQTT_URL", `mqtts://127.0.0.1:${ports.tls}`);
    const strict = await tool({ action: "status" });
    assert.match(strict.failure, /self.signed|unable to verify|certificate/i);
    await setCredential("MQTT_URL", `mqtts://127.0.0.1:${ports.tls}?insecure=1`);
    assert.match((await tool({ action: "status" })).output.message, /Connected to mqtts:\/\/127\.0\.0\.1/);
    assert.equal((await tool({ action: "publish", topic: "ares/tls/x", payload: "hello", qos: 1 })).failure, undefined);
    t.diagnostic("mosquitto TLS listener OK");
  });
});
