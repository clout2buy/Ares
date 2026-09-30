// Phone Hands: the DeviceBridge, its transport through the real garrison, the
// iPhone tool's permission mapping, the HTTP fallback and the push sequence.
//
// Fake sockets drive the bridge directly; one integration block goes through a
// real GarrisonServer + ws clients (control token, read token, guest session).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeviceBridge, GarrisonServer, SessionManager, ensureToken, ensureReadToken } from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider, stopAllStoppables } from "../packages/core/dist/index.js";
import {
  IPhoneTool,
  setDeviceBridge,
  effectiveDeviceRisk,
  deviceCapabilityFloor,
} from "../packages/tools/dist/index.js";
import { createDeviceApi } from "../packages/cli/dist/phoneDevice.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { PhonePush } from "../packages/cli/dist/phonePush.js";
import { classifyToolRequest, remoteAutonomyDecision, gateToolPermission } from "../packages/cli/dist/policyGate.js";

const wsModule = await import("ws").catch(() => import("../packages/garrison/node_modules/ws/wrapper.mjs"));
const WebSocket = wsModule.default ?? wsModule.WebSocket;

const cap = (id, risk = "read", extra = {}) => ({ id, enabled: true, permission: "granted", risk, description: `${id} desc`, ...extra });
const CAPS = [
  cap("device.info"),
  cap("calendar.list_events"),
  cap("calendar.create_event", "write"),
  cap("calendar.delete_event", "sensitive"),
  cap("clipboard.write", "write"),
  cap("url.open", "sensitive"),
  cap("reminders.list"),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBridge(extra = {}) {
  const audits = [];
  const state = { paused: false };
  const bridge = new DeviceBridge({
    audit: (e) => audits.push(e),
    isPaused: () => state.paused,
    ...extra,
  });
  return { bridge, audits, state };
}

function phone(bridge, { key = "c1", id = "ph1", name = "Rook phone", caps = CAPS, shortcuts } = {}) {
  const sent = [];
  const err = bridge.hello(key, (f) => sent.push(f), { device: { id, name, model: "iPhone16,2", os: "iOS 26" }, capabilities: caps, ...(shortcuts ? { shortcuts } : {}) });
  assert.equal(err, null);
  return { sent, key, id };
}

/** Wait until `fn` returns truthy. */
async function until(fn, ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await sleep(5);
  }
  throw new Error("until: timed out");
}

// ─── Registration ─────────────────────────────────────────────────────────

test("hello registers a device, sanitizes capabilities, updates live, and drops on close", () => {
  const { bridge } = makeBridge();
  const p = phone(bridge, {
    caps: [cap("device.info"), { id: "weird.thing", enabled: true, permission: "granted", risk: "nonsense", description: "x" }, { id: "BAD ID!" }, null, cap("device.info")],
    shortcuts: [{ name: "Good Morning", acceptsInput: true }, { name: "" }, { nope: 1 }],
  });
  const [d] = bridge.list();
  assert.equal(d.id, "ph1");
  assert.equal(d.connected, true);
  assert.deepEqual(d.capabilities.map((c) => c.id), ["device.info", "weird.thing"], "bad ids and duplicates are dropped");
  assert.equal(d.capabilities[1].risk, "sensitive", "an unparseable risk is the strictest one");
  assert.deepEqual(d.shortcuts, [{ name: "Good Morning", acceptsInput: true }]);

  assert.equal(bridge.capabilities(p.key, { capabilities: [cap("device.info"), cap("reminders.list")] }), null);
  assert.equal(bridge.list()[0].capabilities.length, 2, "live capability update replaces the list");
  assert.match(bridge.capabilities("nobody", { capabilities: [] }), /before device\.hello/);

  assert.equal(bridge.event(p.key, { kind: "battery", data: { level: 0.5 } }), null);
  assert.equal(bridge.recentEvents("ph1")[0].kind, "battery");

  bridge.closed(p.key);
  assert.equal(bridge.list()[0].connected, false, "closed socket = offline, but still known");
});

test("bad hello payloads are refused", () => {
  const { bridge } = makeBridge();
  assert.match(bridge.hello("c", () => {}, { device: { id: "has space!" }, capabilities: [] }), /device\.id/);
  assert.match(bridge.hello("c", () => {}, { capabilities: [] }), /device object/);
});

test("newest hello wins per device id; the superseded socket cannot answer or disconnect the new one", async () => {
  const { bridge } = makeBridge();
  const a = phone(bridge, { key: "old" });
  const inflight = bridge.invoke("ph1", "device.info", {});
  const reqId = a.sent[0].id;
  const b = phone(bridge, { key: "new" });
  const lost = await inflight;
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, "not_connected", "the old socket's in-flight call fails fast");
  assert.equal(bridge.response("old", { id: reqId, ok: true, result: 1 }), false);
  bridge.closed("old");
  assert.equal(bridge.list()[0].connected, true, "closing the stale socket leaves the new one online");
  const next = bridge.invoke("ph1", "device.info", {});
  assert.equal(b.sent.length, 1, "new requests go to the new socket");
  bridge.response("new", { id: b.sent[0].id, ok: true, result: { ok: 1 } });
  assert.equal((await next).ok, true);
});

// ─── Invoke ───────────────────────────────────────────────────────────────

test("invoke: request frame shape, success, audit entry", async () => {
  const { bridge, audits } = makeBridge();
  const p = phone(bridge);
  const pr = bridge.invoke("default", "calendar.create_event", { title: "Dentist", start: "2026-10-01T09:00:00-05:00", end: "2026-10-01T10:00:00-05:00" }, { reason: "Add 'Dentist' to your calendar", sessionId: "s1", timeoutMs: 5000 });
  const req = p.sent[0];
  assert.equal(req.type, "device.request");
  assert.equal(req.capability, "calendar.create_event");
  assert.equal(req.deadlineMs, 5000);
  assert.equal(req.reason, "Add 'Dentist' to your calendar");
  assert.match(req.id, /^dq_/);
  assert.equal(bridge.response(p.key, { id: req.id, ok: true, result: { id: "evt1" } }), true);
  const r = await pr;
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { id: "evt1" });
  assert.equal(r.device, "ph1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "iPhone.calendar.create_event");
  assert.equal(audits[0].result, "ok");
  assert.equal(audits[0].sessionId, "s1");
  assert.equal(audits[0].actor, "ares");
  assert.equal(audits[0].target, "Rook phone");
  assert.equal(bridge.pendingCount(), 0);
});

test("invoke: the phone's typed errors pass through; unknown codes become device_error", async () => {
  const { bridge } = makeBridge();
  const p = phone(bridge);
  let pr = bridge.invoke("ph1", "device.info", {});
  bridge.response(p.key, { id: p.sent.at(-1).id, ok: false, error: { code: "permission_denied", message: "Calendars off" } });
  let r = await pr;
  assert.deepEqual([r.ok, r.error.code, r.error.message], [false, "permission_denied", "Calendars off"]);
  pr = bridge.invoke("ph1", "device.info", {});
  bridge.response(p.key, { id: p.sent.at(-1).id, ok: false, error: { code: "EKErrorDomain 12", message: "boom" } });
  r = await pr;
  assert.equal(r.error.code, "device_error");
  assert.match(r.error.message, /EKErrorDomain 12: boom/);
});

test("invoke times out, and the late answer is ignored", async () => {
  const { bridge, audits } = makeBridge();
  const p = phone(bridge);
  const r = await bridge.invoke("ph1", "device.info", {}, { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "timeout");
  assert.equal(bridge.response(p.key, { id: p.sent[0].id, ok: true, result: 1 }), false, "late response ignored");
  assert.equal(audits.at(-1).result, "error: timeout");
});

test("timeouts are clamped to [1s, 120s] and the default is 25s", () => {
  const { bridge } = makeBridge();
  const p = phone(bridge);
  void bridge.invoke("ph1", "device.info", {}, { timeoutMs: 9_999_999 });
  void bridge.invoke("ph1", "device.info", {});
  void bridge.invoke("ph1", "device.info", {}, { timeoutMs: 5 });
  assert.deepEqual(p.sent.map((f) => f.deadlineMs), [120_000, 25_000, 1_000]);
  bridge.shutdown();
});

test("duplicate, unknown, malformed and foreign responses resolve nothing twice", async () => {
  const { bridge } = makeBridge();
  const a = phone(bridge, { key: "ca", id: "ph1" });
  const b = phone(bridge, { key: "cb", id: "ph2", name: "iPad" });
  const pr = bridge.invoke("ph1", "device.info", {});
  const id = a.sent[0].id;
  assert.equal(bridge.response("cb", { id, ok: true, result: "spoof" }), false, "another device cannot answer for this one");
  assert.equal(bridge.response("ca", { id: "dq_nope", ok: true }), false, "unknown id");
  assert.equal(bridge.response("ca", { id, ok: "yes" }), false, "malformed");
  assert.equal(bridge.response("ca", { id, ok: true, result: "real" }), true);
  assert.equal(bridge.response("ca", { id, ok: true, result: "dup" }), false, "duplicate");
  assert.equal((await pr).result, "real");
  void b;
});

test("capabilities the phone did not advertise, disabled, or without permission are refused BEFORE sending", async () => {
  const { bridge, audits } = makeBridge();
  const p = phone(bridge, {
    caps: [
      cap("device.info"),
      cap("reminders.create", "write", { enabled: false }),
      cap("contacts.get", "sensitive", { permission: "denied" }),
      cap("health.summary", "sensitive", { permission: "unavailable" }),
      cap("location.get", "sensitive", { permission: "undetermined" }),
    ],
  });
  const missing = await bridge.invoke("ph1", "calendar.create_event", {});
  assert.equal(missing.error.code, "capability_unavailable");
  assert.match(missing.error.message, /device\.info/, "names what IS available");
  assert.equal((await bridge.invoke("ph1", "reminders.create", {})).error.code, "disabled_by_owner");
  assert.equal((await bridge.invoke("ph1", "contacts.get", {})).error.code, "permission_denied");
  assert.equal((await bridge.invoke("ph1", "health.summary", {})).error.code, "capability_unavailable");
  assert.equal(p.sent.length, 0, "nothing was sent for any of them");
  assert.equal(audits.length, 4, "refusals are audited too");
  // undetermined is allowed through: the phone shows the iOS prompt itself.
  void bridge.invoke("ph1", "location.get", {});
  assert.equal(p.sent.length, 1);
  bridge.shutdown();
});

test("invalid args are refused; oversize args and oversize results are capped", async () => {
  const { bridge } = makeBridge();
  const p = phone(bridge);
  assert.equal((await bridge.invoke("ph1", "device.info", [1])).error.code, "invalid_args");
  assert.equal((await bridge.invoke("ph1", "BAD CAP", {})).error.code, "invalid_args");
  assert.equal((await bridge.invoke("ph1", "device.info", { blob: "x".repeat(70 * 1024) })).error.code, "invalid_args");
  const pr = bridge.invoke("ph1", "device.info", {});
  bridge.response(p.key, { id: p.sent[0].id, ok: true, result: { blob: "y".repeat(300 * 1024) } });
  const r = await pr;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "device_error");
  assert.match(r.error.message, /256KB/);
  // a result just under the cap passes
  const pr2 = bridge.invoke("ph1", "device.info", {});
  bridge.response(p.key, { id: p.sent[1].id, ok: true, result: { blob: "y".repeat(200 * 1024) } });
  assert.equal((await pr2).ok, true);
});

test("a dropped socket fails its in-flight calls fast with not_connected", async () => {
  const { bridge } = makeBridge();
  const p = phone(bridge);
  const pr = bridge.invoke("ph1", "device.info", {});
  bridge.closed(p.key);
  const r = await pr;
  assert.equal(r.error.code, "not_connected");
  assert.match(r.error.message, /disconnected/);
});

test("multiple devices: default is the newest connected; an unknown device name is not_connected", async () => {
  const { bridge } = makeBridge();
  const a = phone(bridge, { key: "ca", id: "ph1", name: "iPhone" });
  await sleep(3);
  const b = phone(bridge, { key: "cb", id: "ph2", name: "iPad" });
  void bridge.invoke("default", "device.info", {});
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent.length, 0);
  void bridge.invoke("iphone", "device.info", {}); // by name, case-insensitive
  assert.equal(a.sent.length, 1);
  const missing = await bridge.invoke("Watch", "device.info", {});
  assert.equal(missing.error.code, "not_connected");
  assert.equal(bridge.list()[0].id, "ph2", "connected, newest first");
  bridge.shutdown();
});

test("pause refuses; the kill switch cancels in-flight calls; guests are forbidden", async () => {
  const { bridge, state, audits } = makeBridge({ isOwnerSession: (id) => id !== "guest-session" });
  const p = phone(bridge);
  state.paused = true;
  assert.equal((await bridge.invoke("ph1", "device.info", {})).error.code, "paused");
  state.paused = false;
  assert.equal((await bridge.invoke("ph1", "device.info", {}, { sessionId: "guest-session" })).error.code, "forbidden");
  assert.equal(p.sent.length, 0);
  const pr = bridge.invoke("ph1", "device.info", {}, { sessionId: "owner-session" });
  await stopAllStoppables("test stop");
  const r = await pr;
  assert.equal(r.error.code, "cancelled");
  assert.equal(audits.at(-1).result, "error: cancelled");
  // abort signal
  const ac = new AbortController();
  const pr2 = bridge.invoke("ph1", "device.info", {}, { signal: ac.signal });
  ac.abort();
  assert.equal((await pr2).error.code, "cancelled");
});

test("audit entries carry no secrets: text bodies are lengths, URL queries are stripped", async () => {
  const { bridge, audits } = makeBridge();
  const p = phone(bridge);
  const a = bridge.invoke("ph1", "clipboard.write", { text: "hunter2-super-secret" }, { reason: "copy a note" });
  bridge.response(p.key, { id: p.sent[0].id, ok: true, result: {} });
  await a;
  const b = bridge.invoke("ph1", "url.open", { url: "https://example.com/reset?token=abc123&x=1" });
  bridge.response(p.key, { id: p.sent[1].id, ok: true, result: {} });
  await b;
  const dump = JSON.stringify(audits);
  assert.ok(!dump.includes("hunter2"), "clipboard text never reaches the audit trail");
  assert.ok(!dump.includes("abc123"), "URL query strings never reach the audit trail");
  assert.match(dump, /\[20 chars\]/);
  assert.match(dump, /https:\/\/example\.com\/reset/);
  assert.ok(!dump.includes("result\":{"), "results are never logged, only their size");
});

test("known devices survive a restart (and an offline device with no wake path is not_connected at once)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-device-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "device", "bridge.json");
  const one = makeBridge({ statePath });
  phone(one.bridge);
  await one.bridge.flush();
  const two = makeBridge({ statePath });
  const [d] = two.bridge.list();
  assert.equal(d.id, "ph1");
  assert.equal(d.connected, false);
  assert.equal(d.capabilities.length, CAPS.length);
  const r = await two.bridge.invoke("default", "device.info", {});
  assert.equal(r.error.code, "not_connected");
  assert.match(r.error.message, /Open the Ares app/);
});

// ─── Wake: silent push, HTTP pull, visible alert ──────────────────────────

function fakeWake({ available = true } = {}) {
  const calls = [];
  return {
    calls,
    available: async () => available,
    silent: async (info) => (calls.push(["silent", Date.now(), info]), true),
    visible: async (info) => (calls.push(["visible", Date.now(), info]), true),
  };
}

test("wake: silent push first; the phone connects and the queued request runs, no visible alert", async () => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 400, wakeWaitMs: 1500 });
  phone(bridge);
  bridge.closed("c1"); // known but offline
  const pr = bridge.invoke("default", "reminders.list", {}, { reason: "Check reminders" });
  await until(() => wake.calls.length >= 1);
  assert.equal(wake.calls[0][0], "silent");
  assert.equal(wake.calls[0][2].reason, "Check reminders");
  const sent = [];
  bridge.hello("c2", (f) => sent.push(f), { device: { id: "ph1", name: "Rook phone" }, capabilities: CAPS });
  assert.equal(sent[0].type, "device.request", "the queued request is flushed on connect");
  bridge.response("c2", { id: sent[0].id, ok: true, result: [] });
  assert.equal((await pr).ok, true);
  await sleep(450);
  assert.deepEqual(wake.calls.map((c) => c[0]), ["silent"], "no visible alert once the phone answered");
});

test("wake: the phone pulls over HTTP (at-most-once) and responds there; no visible alert", async () => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 400, wakeWaitMs: 1500 });
  phone(bridge);
  bridge.closed("c1");
  const pr = bridge.invoke("ph1", "calendar.list_events", { from: "a", to: "b" }, { reason: "Look at the week" });
  await until(() => wake.calls.length >= 1);
  assert.deepEqual(bridge.pollPending("someone-else"), [], "another device's poll sees nothing addressed to ph1");
  const [req] = bridge.pollPending("ph1");
  assert.equal(req.capability, "calendar.list_events");
  assert.equal(req.reason, "Look at the week");
  assert.ok(req.deadlineMs > 0);
  assert.deepEqual(bridge.pollPending("ph1"), [], "claimed: a second poll does not re-deliver");
  assert.equal(bridge.pollPending("ph1", { includeClaimed: true })[0].id, req.id, "includeClaimed re-lists it");
  assert.deepEqual(bridge.httpRespond({ id: "dq_unknown", ok: true }), { accepted: false });
  assert.deepEqual(bridge.httpRespond({ id: req.id, ok: true, result: [{ title: "x" }] }), { accepted: true });
  assert.deepEqual(bridge.httpRespond({ id: req.id, ok: true, result: "dup" }), { accepted: false }, "idempotent");
  const r = await pr;
  assert.deepEqual(r.result, [{ title: "x" }]);
  await sleep(450);
  assert.deepEqual(wake.calls.map((c) => c[0]), ["silent"]);
});

test("wake: silent, then visible after the grace, then not_connected with guidance", async () => {
  const wake = fakeWake();
  const { bridge, audits } = makeBridge({ wake, silentGraceMs: 150, wakeWaitMs: 500 });
  phone(bridge);
  bridge.closed("c1");
  const t0 = Date.now();
  const r = await bridge.invoke("default", "device.info", {}, { reason: "Checking your battery" });
  assert.equal(r.error.code, "not_connected");
  assert.match(r.error.message, /Open the Ares app/);
  assert.deepEqual(wake.calls.map((c) => c[0]), ["silent", "visible"], "silent first, visible second");
  assert.ok(wake.calls[1][1] - wake.calls[0][1] >= 140, "visible waits out the silent grace");
  assert.ok(Date.now() - t0 >= 450, "waits the wake window before giving up");
  assert.equal(wake.calls[1][2].reason, "Checking your battery");
  assert.equal(audits.at(-1).result, "error: not_connected");
  assert.equal(bridge.pendingCount(), 0, "the queued request does not leak");
});

test("wake: a visible alert that the phone answers over HTTP resolves the call", async () => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 100, wakeWaitMs: 1500 });
  phone(bridge);
  bridge.closed("c1");
  const pr = bridge.invoke("default", "device.info", {});
  await until(() => wake.calls.some((c) => c[0] === "visible"));
  const [req] = bridge.pollPending("ph1");
  bridge.httpRespond({ id: req.id, ok: true, result: { battery: 0.8 } });
  assert.equal((await pr).ok, true);
});

test("wake: pushes are rate-limited per device", async () => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 30, wakeWaitMs: 120, silentMinIntervalMs: 60_000, visibleMinIntervalMs: 60_000 });
  phone(bridge);
  bridge.closed("c1");
  await bridge.invoke("default", "device.info", {});
  await bridge.invoke("default", "device.info", {});
  await bridge.invoke("default", "device.info", {});
  assert.deepEqual(wake.calls.map((c) => c[0]), ["silent", "visible"], "three calls, one silent and one visible push");
});

test("wake: no registered push device means an immediate not_connected, and nothing is pushed", async () => {
  const wake = fakeWake({ available: false });
  const { bridge } = makeBridge({ wake });
  phone(bridge);
  bridge.closed("c1");
  const t0 = Date.now();
  const r = await bridge.invoke("default", "device.info", {});
  assert.equal(r.error.code, "not_connected");
  assert.ok(Date.now() - t0 < 200);
  assert.equal(wake.calls.length, 0);
});

test("wake: a queued request is still validated when the phone arrives", async () => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 300, wakeWaitMs: 1500 });
  phone(bridge);
  bridge.closed("c1");
  const pr = bridge.invoke("default", "calendar.delete_event", { id: "e1" });
  await until(() => wake.calls.length >= 1);
  const sent = [];
  bridge.hello("c2", (f) => sent.push(f), { device: { id: "ph1", name: "Rook phone" }, capabilities: [cap("calendar.delete_event", "sensitive", { enabled: false })] });
  assert.equal(sent.length, 0, "the owner switched it off while the phone was asleep");
  assert.equal((await pr).error.code, "disabled_by_owner");
});

// ─── The iPhone tool: permission mapping and output shapes ────────────────

const toolCtx = (over = {}) => ({ workspace: "/w", sessionId: "s1", signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map(), ...over });

test("risk -> permission: read allows, write asks, sensitive is a per-call owner decision", async () => {
  const { bridge } = makeBridge();
  phone(bridge, { caps: [...CAPS, cap("weird.thing", "sensitive"), cap("calendar.delete_event", "read") /* the phone lying downward */] });
  setDeviceBridge(bridge);
  try {
    const check = (input, ctx = toolCtx()) => IPhoneTool.checkPermissions({ action: "invoke", ...input }, ctx);
    assert.equal((await check({ capability: "calendar.list_events" })).kind, "allow");
    assert.equal((await check({ capability: "device.info" })).kind, "allow");

    const write = await check({ capability: "calendar.create_event", args: { title: "Dentist" }, reason: "Add Dentist to your calendar" });
    assert.equal(write.kind, "ask");
    assert.ok(!write.ownerDecision, "write rides a standing grant, it is not a per-call owner decision");
    assert.match(write.prompt, /Add Dentist to your calendar/, "the prompt names the action, not a generic one");

    const del = await check({ capability: "calendar.delete_event", args: { id: "e1" } });
    assert.equal(del.kind, "ask");
    assert.equal(del.ownerDecision, true, "our floor outranks a phone that declares delete_event as read");
    assert.equal((await check({ capability: "url.open", args: { url: "https://x.y" } })).ownerDecision, true);
    assert.equal((await check({ capability: "weird.thing" })).ownerDecision, true, "the phone's own sensitive declaration drives gating of capabilities we have never heard of");

    // Even bypass/YOLO mode cannot make a sensitive call silent.
    const bypass = await check({ capability: "calendar.delete_event" }, toolCtx({ permissionMode: "bypass" }));
    assert.equal(bypass.kind, "ask");
    assert.equal(bypass.ownerDecision, true);
    // ...and plan mode refuses everything that is not a read.
    assert.equal((await check({ capability: "calendar.create_event" }, toolCtx({ permissionMode: "plan" }))).kind, "deny");
    assert.equal((await check({ capability: "calendar.list_events" }, toolCtx({ permissionMode: "plan" }))).kind, "allow");
    assert.equal((await IPhoneTool.checkPermissions({ action: "status" }, toolCtx())).kind, "allow");
  } finally {
    setDeviceBridge(null);
  }
});

test("risk floors: the phone can raise a class, never lower a known one", () => {
  assert.equal(effectiveDeviceRisk("calendar.delete_event", "read"), "sensitive");
  assert.equal(effectiveDeviceRisk("calendar.list_events", "sensitive"), "sensitive");
  assert.equal(effectiveDeviceRisk("clipboard.read", "read"), "sensitive", "privacy-sensitive by floor");
  assert.equal(effectiveDeviceRisk("location.get", undefined), "sensitive");
  assert.equal(effectiveDeviceRisk("brand.new", "read"), "read");
  assert.equal(effectiveDeviceRisk("brand.new", "bogus"), "sensitive");
  assert.equal(effectiveDeviceRisk("brand.new", undefined), "sensitive");
  assert.equal(deviceCapabilityFloor("battery.get"), "read");
  assert.equal(deviceCapabilityFloor("sms.compose"), "write");
});

test("guest sessions are denied by the tool, and the bridge agrees", async () => {
  const { bridge } = makeBridge({ isOwnerSession: (id) => id === "owner" });
  phone(bridge);
  setDeviceBridge(bridge);
  try {
    const d = await IPhoneTool.checkPermissions({ action: "status" }, toolCtx({ sessionId: "guest" }));
    assert.equal(d.kind, "deny");
    const out = await IPhoneTool.call({ action: "invoke", capability: "device.info" }, toolCtx({ sessionId: "guest" }));
    assert.match(out.failure, /guest/);
  } finally {
    setDeviceBridge(null);
  }
});

test("policyGate: write classifies as an ask-class action, owner decisions stay owner decisions", () => {
  const req = (capability, extra = {}) => ({ toolName: "iPhone", input: { action: "invoke", capability }, reason: "Ares wants to ...", ...extra });
  assert.equal(classifyToolRequest(req("calendar.list_events")), null);
  assert.equal(classifyToolRequest(req("calendar.create_event")), "browser_submit");
  assert.equal(classifyToolRequest(req("brand.new")), "browser_submit");
  assert.equal(classifyToolRequest({ toolName: "iPhone", input: { action: "status" }, reason: "" }), null);
  assert.equal(remoteAutonomyDecision(req("calendar.create_event")), "ask", "a remote turn escalates phone writes to the owner");
  assert.equal(remoteAutonomyDecision(req("calendar.create_event"), { trustAll: true }), "allow", "ARES_TRUST_ALL pre-answers it, as for every other ask-class action");
  assert.equal(remoteAutonomyDecision(req("calendar.delete_event", { ownerDecision: true })), "ask");
  assert.equal(remoteAutonomyDecision(req("calendar.delete_event", { ownerDecision: true }), { trustAll: true }), "allow", "same rule as a vault fill; money is the only exemption");
  assert.equal(gateToolPermission(req("calendar.delete_event", { ownerDecision: true }), { attended: false }).kind, "deny", "nobody present -> refused");
  assert.equal(gateToolPermission(req("calendar.delete_event", { ownerDecision: true }), { attended: true }).kind, "ask");
});

test("tool: status / shortcuts / invoke output shapes", async () => {
  const { bridge } = makeBridge();
  const p = phone(bridge, { shortcuts: [{ name: "Good Morning", description: "lights on", acceptsInput: false }] });
  setDeviceBridge(bridge);
  try {
    const status = await IPhoneTool.call({ action: "status" }, toolCtx());
    assert.equal(status.output.devices.length, 1);
    assert.match(status.output.message, /Rook phone \(ph1\).*connected/);
    assert.match(status.output.message, /calendar\.delete_event \[sensitive; ready\]/);
    const shortcuts = await IPhoneTool.call({ action: "shortcuts" }, toolCtx());
    assert.deepEqual(shortcuts.output.shortcuts, [{ name: "Good Morning", description: "lights on", acceptsInput: false, device: "ph1" }]);

    const pr = IPhoneTool.call({ action: "invoke", capability: "calendar.list_events", args: { from: "a", to: "b" }, reason: "Look at today" }, toolCtx());
    await until(() => p.sent.length === 1);
    assert.equal(p.sent[0].reason, "Look at today");
    bridge.response(p.key, { id: p.sent[0].id, ok: true, result: [{ title: "Standup" }] });
    const ok = await pr;
    assert.equal(ok.failure, undefined);
    assert.deepEqual(ok.output.result, [{ title: "Standup" }]);
    assert.equal(ok.output.capability, "calendar.list_events");
    assert.match(ok.output.message, /calendar\.list_events ok \(\d+ms\).*Standup/);

    const bad = await IPhoneTool.call({ action: "invoke", capability: "health.summary", args: { days: 3 } }, toolCtx());
    assert.match(bad.failure, /^capability_unavailable:/);
    assert.equal(bad.output.errorCode, "capability_unavailable");

    const noArg = await IPhoneTool.call({ action: "invoke" }, toolCtx());
    assert.match(noArg.failure, /needs capability/);
  } finally {
    setDeviceBridge(null);
  }
  const off = await IPhoneTool.call({ action: "status" }, toolCtx());
  assert.match(off.failure, /garrison/, "no bridge in this process says where it lives");
});

test("tool: registered by default and kept out of leaf sub-agents", async () => {
  const { DEFAULT_TOOLS } = await import("../packages/tools/dist/index.js");
  assert.ok(DEFAULT_TOOLS.some((t) => t.schema.name === "iPhone"));
  // LEAF_NEVER_TOOLS is module-private to conductor; read the source of truth.
  const conductor = await fs.readFile(new URL("../packages/core/src/conductor.ts", import.meta.url), "utf8");
  assert.match(conductor, /LEAF_NEVER_TOOLS = new Set\(\[[^\]]*"iPhone"/);
  const tool = DEFAULT_TOOLS.find((t) => t.schema.name === "iPhone");
  assert.match(tool.schema.description, /reason/);
  assert.match(tool.schema.description, /audited/);
  assert.match(tool.schema.description, /read capabilities/);
});

// ─── PhonePush: the silent wake ───────────────────────────────────────────

test("PhonePush.sendBackground is a correct APNs background push; wake alerts are actionable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-push-bg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyPath = path.join(dir, "k.p8");
  await fs.writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const seen = [];
  const push = new PhonePush(
    path.join(dir, "phone-push.json"),
    { keyPath, keyId: "K", teamId: "T", bundleId: "com.doingteam.ares" },
    () => {},
    async (_cfg, req) => (seen.push(req), 200),
  );
  await push.register({ token: "aa11", platform: "ios" });
  assert.deepEqual(await push.sendBackground(), { sent: 1, failed: 0 });
  const bg = seen[0];
  assert.equal(bg.headers["apns-push-type"], "background");
  assert.equal(bg.headers["apns-priority"], "5");
  assert.equal(bg.headers["apns-topic"], "com.doingteam.ares");
  assert.equal(bg.headers[":path"], "/3/device/aa11");
  assert.match(bg.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const body = JSON.parse(bg.body);
  assert.deepEqual(body.aps, { "content-available": 1 }, "no alert, no sound, no badge");
  assert.equal(body.deviceWake, true);

  assert.deepEqual(await push.send({ title: "Ares needs your phone", body: "Add Dentist", data: { kind: "device_wake" }, collapseId: "device-wake" }), { sent: 1, failed: 0 });
  const alert = seen[1];
  assert.equal(alert.headers["apns-push-type"], "alert");
  assert.equal(alert.headers["apns-priority"], "10");
  assert.equal(alert.headers["apns-collapse-id"], "device-wake");
  const a = JSON.parse(alert.body);
  assert.equal(a.aps.alert.body, "Add Dentist");
  assert.equal(a.aps.category, "ARES_DEVICE_WAKE");

  // A dead token is pruned for background sends too.
  const dead = new PhonePush(path.join(dir, "dead.json"), { keyPath, keyId: "K", teamId: "T", bundleId: "b" }, () => {}, async () => 410);
  await dead.register({ token: "bb22", platform: "ios" });
  assert.deepEqual(await dead.sendBackground(), { sent: 0, failed: 1 });
  assert.equal((await dead.list()).length, 0);
});

// ─── HTTP API ─────────────────────────────────────────────────────────────

async function serveApi(bridge) {
  const handle = createDeviceApi(bridge, () => {});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handle(req, res, url))) res.writeHead(418).end("not mine");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, call };
}

test("REST: device list, health check round trip, pending/respond fallback", async (t) => {
  const { bridge } = makeBridge();
  const p = phone(bridge, { shortcuts: [{ name: "Focus" }] });
  const { server, call } = await serveApi(bridge);
  t.after(() => server.close());

  const list = await call("GET", "/gateway/device/list");
  assert.equal(list.status, 200);
  assert.equal(list.body.devices[0].id, "ph1");
  assert.equal(list.body.devices[0].connected, true);
  assert.equal(list.body.devices[0].capabilities.length, CAPS.length);
  assert.deepEqual(list.body.devices[0].shortcuts, [{ name: "Focus" }]);
  assert.ok(list.body.devices[0].lastSeenAt);

  // round trip: the fake phone answers device.info
  const pending = call("POST", "/gateway/device/test", { device: "ph1", capability: "device.info" });
  await until(() => p.sent.length === 1);
  bridge.response(p.key, { id: p.sent[0].id, ok: true, result: { name: "Rook phone", battery: 0.9 } });
  const test1 = await pending;
  assert.equal(test1.status, 200);
  assert.equal(test1.body.ok, true);
  assert.equal(test1.body.result.battery, 0.9);
  assert.equal(test1.body.device, "ph1");
  // the health check may never do anything but device.info
  assert.equal((await call("POST", "/gateway/device/test", { device: "ph1", capability: "calendar.delete_event" })).status, 400);
  // no such phone
  const none = await call("POST", "/gateway/device/test", { device: "ghost" });
  assert.equal(none.body.ok, false);
  assert.equal(none.body.error.code, "not_connected");

  // pending/respond with an offline device and a silent-push wake
  bridge.closed(p.key);
  assert.equal((await call("GET", "/gateway/device/pending")).status, 400);
  assert.deepEqual((await call("GET", "/gateway/device/pending?device=ph1")).body, { requests: [] });
  assert.equal((await call("POST", "/gateway/device/respond", { id: "x" })).status, 400);
  assert.deepEqual((await call("POST", "/gateway/device/respond", { id: "dq_none", ok: true })).body, { accepted: false });
  assert.equal((await call("DELETE", "/gateway/device/list")).status, 405);
  assert.equal((await call("GET", "/gateway/device/nothing")).status, 404);
});

test("REST: pending/respond resolves a real invoke end to end", async (t) => {
  const wake = fakeWake();
  const { bridge } = makeBridge({ wake, silentGraceMs: 500, wakeWaitMs: 2000 });
  phone(bridge);
  bridge.closed("c1");
  const { server, call } = await serveApi(bridge);
  t.after(() => server.close());
  const pr = bridge.invoke("default", "reminders.list", {}, { reason: "Read reminders" });
  await until(() => wake.calls.length >= 1);
  const got = await call("GET", "/gateway/device/pending?device=ph1");
  assert.equal(got.body.requests.length, 1);
  const r = got.body.requests[0];
  assert.deepEqual(Object.keys(r).sort(), ["args", "capability", "deadlineMs", "id", "reason"]);
  const res = await call("POST", "/gateway/device/respond", { id: r.id, ok: true, result: [{ title: "Milk" }] });
  assert.deepEqual(res.body, { accepted: true });
  assert.deepEqual((await pr).result, [{ title: "Milk" }]);
  assert.deepEqual((await call("POST", "/gateway/device/respond", { id: r.id, ok: true })).body, { accepted: false });
});

// ─── Through the real garrison server ─────────────────────────────────────

function makeFactory(workspace) {
  return ({ sessionId, model, signal, requestPermission }) => {
    const engine = QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: model ?? "mock", systemPrompt: "device test", tools: [], workspace, signal, requestPermission },
      sessionId,
    );
    return { engine, providerName: "mock-echo", model: model ?? "mock", workspace };
  };
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
    this.closed = new Promise((r) => ws.on("close", r));
  }
  static async open(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = new Client(ws);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    c.send({ type: "hello", token, client: "test", proto: 1 });
    await until(() => c.frames.some((f) => f.type === "welcome"));
    return c;
  }
  send(f) { this.ws.send(JSON.stringify(f)); }
  find(type) { return this.frames.find((f) => f.type === type); }
}

test("garrison integration: device frames route to the bridge; read tokens and guests are shut out", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-device-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessions = new SessionManager({ home, factory: makeFactory(home) });
  const audits = [];
  const bridge = new DeviceBridge({
    audit: (e) => audits.push(e),
    isPaused: () => false,
    isOwnerSession: (id) => sessions.list().some((s) => s.id === id && s.tenant?.role !== "guest"),
  });
  const server = new GarrisonServer({ home, sessions, port: 0, devices: bridge });
  const { port } = await server.start();
  t.after(() => server.close());
  const control = await ensureToken(home);
  const read = await ensureReadToken(home);

  const phoneWs = await Client.open(port, control);
  phoneWs.send({ type: "device.hello", device: { id: "ph1", name: "Rook phone" }, capabilities: CAPS, shortcuts: [{ name: "Focus" }] });
  await until(() => bridge.list().length === 1);
  assert.equal(bridge.list()[0].connected, true);

  phoneWs.send({ type: "device.capabilities", capabilities: [cap("device.info")] });
  await until(() => bridge.list()[0].capabilities.length === 1);

  // agent -> phone -> agent
  const pr = bridge.invoke("default", "device.info", {}, { reason: "ping" });
  const req = await until(() => phoneWs.find("device.request"));
  assert.equal(req.capability, "device.info");
  assert.equal(req.reason, "ping");
  // a second client (control token, not the phone) cannot answer for it
  const other = await Client.open(port, control);
  other.send({ type: "device.response", id: req.id, ok: true, result: "spoof" });
  phoneWs.send({ type: "device.response", id: req.id, ok: true, result: { name: "Rook phone" } });
  const r = await pr;
  assert.deepEqual(r.result, { name: "Rook phone" });

  // read-scope clients cannot register a device or answer for one
  const viewer = await Client.open(port, read);
  viewer.send({ type: "device.hello", device: { id: "evil", name: "Evil" }, capabilities: CAPS });
  await until(() => viewer.find("error"));
  assert.match(viewer.find("error").message, /read-only/);
  assert.equal(bridge.list().some((d) => d.id === "evil"), false);

  // a guest's session can't reach the phone even with a live device
  const guest = sessions.create({ tenant: { role: "guest", chatId: "42" } });
  const denied = await bridge.invoke("default", "device.info", {}, { sessionId: guest.id });
  assert.equal(denied.error.code, "forbidden");
  const owner = sessions.create({});
  const pr2 = bridge.invoke("default", "device.info", {}, { sessionId: owner.id });
  await until(() => phoneWs.frames.filter((f) => f.type === "device.request").length === 2);
  phoneWs.send({ type: "device.response", id: phoneWs.frames.filter((f) => f.type === "device.request")[1].id, ok: true, result: {} });
  assert.equal((await pr2).ok, true);

  // malformed hello gets an error frame, not a crash
  other.send({ type: "device.hello", device: { id: "no good" }, capabilities: [] });
  await until(() => other.find("error"));

  // closing the phone socket takes the device offline
  phoneWs.ws.close();
  await until(() => bridge.list()[0].connected === false);
  assert.ok(audits.some((a) => a.result === "error: forbidden"));

  // a garrison without a bridge refuses the frames cleanly
  const bare = new GarrisonServer({ home, sessions, port: 0 });
  const { port: bport } = await bare.start();
  t.after(() => bare.close());
  const c = await Client.open(bport, control);
  c.send({ type: "device.hello", device: { id: "x", name: "x" }, capabilities: [] });
  await until(() => c.find("error"));
  assert.match(c.find("error").message, /not wired/);
});

test("real RemoteAgentServer: bridge routes beat the synced-data handler, kinds route intact, auth enforced", async (t) => {
  const { bridge } = makeBridge();
  phone(bridge, {});
  const srv = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: { device: createDeviceApi(bridge, () => {}) },
  });
  await srv.start();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const get = (p, token = "tok") => fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get("/gateway/device/pending?device=probe", null)).status, 401);
  const pending = await get("/gateway/device/pending?device=probe");
  assert.equal(pending.status, 200);
  assert.deepEqual((await pending.json()).requests, []);
  const list = await get("/gateway/device/list");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).devices[0].id, "ph1");
  const kinds = await get("/gateway/device");
  assert.equal(kinds.status, 200);
  assert.ok((await kinds.json()).kinds);
});
