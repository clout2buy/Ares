// What the iPhone shares (Health, Contacts, Calendar) lands on the box as a
// bounded, validated snapshot, owner-only, and the Device tool reads it back
// with its age — never presenting a stale sync as live.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleDeviceApi, normalizeDevicePayload, deviceFile } from "../packages/cli/dist/deviceSync.js";
import { DeviceTool } from "../packages/tools/dist/index.js";

async function serve(t, home) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    void handleDeviceApi(req, res, url, { home }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("health, contacts and calendar are validated to the documented shape", () => {
  const health = normalizeDevicePayload("health", { days: [{ date: "2026-09-22", steps: 8123, sleepMinutes: 412, junk: "x", workouts: [{ type: "run", start: "2026-09-22T07:00:00Z", minutes: 31 }, { nope: 1 }] }, { date: "yesterday" }] });
  assert.equal(health.count, 1);
  assert.deepEqual(health.data.days[0], { date: "2026-09-22", steps: 8123, sleepMinutes: 412, workouts: [{ type: "run", start: "2026-09-22T07:00:00Z", minutes: 31 }] });
  const contacts = normalizeDevicePayload("contacts", { contacts: [{ name: "Sam", phones: ["+1 555"], emails: [] }, { phones: ["x"] }] });
  assert.equal(contacts.count, 1);
  assert.equal(contacts.data.contacts[0].emails, undefined);
  const cal = normalizeDevicePayload("calendar", { events: [{ title: "Dentist", start: "2026-09-24T15:00:00Z" }], reminders: [{ title: "Buy milk" }, { title: "Done", completed: true }] });
  assert.equal(cal.count, 3);
});

test("sync → Device tool reads it back with its age; forget removes it", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-device-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const prev = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = prev; });
  const base = await serve(t, home);
  const signal = new AbortController().signal;

  const none = await DeviceTool.call({ action: "health", days: 7, limit: 25 }, { signal });
  assert.ok(none.failure);
  assert.match(none.output.message, /Apps → Health → Connect/);

  const soon = new Date(Date.now() + 86_400_000).toISOString();
  const post = (kind, body) => fetch(`${base}/gateway/device/${kind}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  assert.deepEqual(await post("health", { days: [{ date: "2026-09-22", steps: 9000 }] }), { ok: true, stored: 1 });
  await post("contacts", { contacts: [{ name: "Sam Lee", emails: ["sam@example.com"] }, { name: "Alex" }] });
  await post("calendar", { events: [{ title: "Dentist", start: soon }], reminders: [{ title: "Buy milk" }] });
  assert.equal((await fsp.stat(deviceFile("contacts", home))).mode & 0o077, 0, "owner-only on disk");

  const health = await DeviceTool.call({ action: "health", days: 7, limit: 25 }, { signal });
  assert.equal(health.output.items[0].steps, 9000);
  assert.match(health.output.message, /synced \d+ min ago/);
  const found = await DeviceTool.call({ action: "contacts", query: "sam", days: 7, limit: 25 }, { signal });
  assert.equal(found.output.items.length, 1);
  const events = await DeviceTool.call({ action: "calendar", days: 7, limit: 25 }, { signal });
  assert.equal(events.output.items[0].title, "Dentist");

  const status = await (await fetch(`${base}/gateway/device`)).json();
  assert.equal(status.kinds.calendar.count, 2);

  assert.deepEqual(await post("contacts/forget", {}), { ok: true });
  const gone = await DeviceTool.call({ action: "contacts", query: "sam", days: 7, limit: 25 }, { signal });
  assert.ok(gone.failure);
  assert.equal((await fetch(`${base}/gateway/device/secrets`, { method: "POST", body: "{}" })).status, 404);
});
