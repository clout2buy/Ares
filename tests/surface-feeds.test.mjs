// Feeds and surface-originated calls (docs/CREATOR-MODE-DESIGN.md).
//
// A feed posts without a model turn; a tool feed may only run read-only
// tools and never asks; an ares.call runs the belt's adapted tool through a
// permission prompt the owning chat sees as a card. Pinned against fakes so
// the cadence rules and the gate are exact, not "it seemed to work live".

import test from "node:test";
process.env.ARES_GENUI = "1";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SurfaceFeeds, runGatedTool } from "../packages/cli/dist/entry/daemon/surfaceFeeds.js";
import { surfaceIntentGoal } from "../packages/cli/dist/entry/daemon/surfaces.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTool(name, safety, impl, extra = {}) {
  return {
    schema: { name, description: name, inputJsonSchema: { type: "object" }, safety, concurrency: "parallel-safe" },
    ...extra,
    async call(input, ctx) {
      return impl(input, ctx);
    },
  };
}

function manifest(over = {}) {
  return { name: "m", title: "M", placement: "rail", revision: 1, state: "trial", feeds: [], actions: [], sessionId: "s1", createdAt: 0, updatedAt: 0, ...over };
}

test("time and file feeds post without any model turn; removed feeds stop", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-feeds-"));
  const file = path.join(workspace, "notes.txt");
  await writeFile(file, "one");
  const posts = [];
  const feeds = new SurfaceFeeds({ post: (name, payload) => posts.push({ name, payload }), workspace, toolsFor: () => [], emit: () => undefined, tickMs: 10 });
  feeds.reconcile(manifest({ feeds: [{ kind: "time", everySec: 5 }, { kind: "file", path: "notes.txt" }, { kind: "file", path: "../outside.txt" }] }));
  await sleep(200);
  const ticks = posts.filter((p) => p.payload.feed === "time");
  assert.ok(ticks.length >= 2, `clock ticked (${ticks.length})`);
  const first = posts.find((p) => p.payload.feed === "file" && p.payload.path === "notes.txt");
  assert.equal(first.payload.data, "one");
  const outside = posts.find((p) => p.payload.path === "../outside.txt");
  assert.equal(outside.payload.error, "outside the workspace");
  await writeFile(file, "two");
  await sleep(400);
  assert.ok(posts.some((p) => p.payload.feed === "file" && p.payload.data === "two"), "a change is posted");
  // Dropping the time feed stops the clock.
  feeds.reconcile(manifest({ feeds: [{ kind: "file", path: "notes.txt" }] }));
  const before = posts.filter((p) => p.payload.feed === "time").length;
  await sleep(150);
  assert.equal(posts.filter((p) => p.payload.feed === "time").length, before);
  feeds.dispose();
});

test("tool feeds run read-only tools only, and never ask", async () => {
  const posts = [];
  let asked = 0;
  const tools = [
    fakeTool("Weather", "read-only", async (input) => ({ output: { city: input.city, temp: 21 } })),
    fakeTool("Email", "external-state", async () => ({ output: "sent" })),
    fakeTool("Asker", "read-only", async (input, ctx) => { asked += 1; const d = await ctx.requestPermission({ toolName: "Asker", input, reason: "?" }); return { output: d }; }),
  ];
  const feeds = new SurfaceFeeds({ post: (name, payload) => posts.push(payload), workspace: ".", toolsFor: () => tools, emit: () => undefined, tickMs: 10 });
  feeds.reconcile(manifest({ feeds: [
    { kind: "tool", tool: "Weather", input: { city: "Austin" }, everySec: 30 },
    { kind: "tool", tool: "Email", everySec: 30 },
    { kind: "tool", tool: "Asker", everySec: 30 },
    { kind: "tool", tool: "Nope", everySec: 30 },
  ] }));
  await sleep(120);
  const weather = posts.find((p) => p.tool === "Weather");
  assert.deepEqual(weather.data, { city: "Austin", temp: 21 });
  assert.match(posts.find((p) => p.tool === "Email").error, /read-only/);
  assert.equal(posts.find((p) => p.tool === "Asker").data, "deny", "a feed's ask is denied, not shown");
  assert.match(posts.find((p) => p.tool === "Nope").error, /no tool named/);
  feeds.dispose();
});

test("session feeds forward the owning session's events as status and events", () => {
  const posts = [];
  const feeds = new SurfaceFeeds({ post: (name, payload) => posts.push(payload), workspace: ".", toolsFor: () => [], emit: () => undefined, tickMs: 10 });
  feeds.reconcile(manifest({ feeds: [{ kind: "session.status" }, { kind: "session.events" }] }));
  feeds.observe("s1", { type: "turn_start" });
  feeds.observe("s1", { type: "text_delta", text: "x" });
  feeds.observe("s1", { type: "tool_start", name: "Read", image: "AAAA" });
  feeds.observe("other", { type: "turn_start" });
  feeds.observe("s1", { type: "turn_end", status: "completed" });
  const status = posts.filter((p) => p.feed === "session.status").map((p) => p.data.status);
  assert.deepEqual(status, ["thinking", "using Read", "idle"]);
  const events = posts.filter((p) => p.feed === "session.events").map((p) => p.data.type);
  assert.deepEqual(events, ["turn_start", "tool_start", "turn_end"], "deltas are not forwarded, other sessions are not forwarded");
  assert.equal(posts.find((p) => p.data?.type === "tool_start").data.image, undefined, "frames are stripped");
  feeds.dispose();
});

test("a surface call runs through the gate: the chat sees the card, the answer decides", async () => {
  const emitted = [];
  const tools = [
    fakeTool("Pay", "external-state", async (input, ctx) => {
      const decision = await ctx.requestPermission({ toolName: "Pay", input, reason: `Pay ${input.amount}?`, ownerDecision: true });
      if (decision === "deny") return { output: { message: "declined" }, failure: "declined" };
      return { output: { paid: input.amount } };
    }),
  ];
  const allow = await runGatedTool({
    sessionId: "s1", tool: "Pay", input: { amount: 5 }, workspace: ".", tools, mode: "call",
    requestPermission: async (req) => { assert.ok(req.id.startsWith("perm_surface_")); return "allow_once"; },
    emit: (sid, payload) => emitted.push({ sid, payload }),
  });
  assert.equal(allow.ok, true);
  assert.deepEqual(allow.output, { paid: 5 });
  assert.equal(emitted[0].payload.type, "permission_request");
  assert.equal(emitted[0].sid, "s1");
  assert.equal(emitted[0].payload.ownerDecision, true);
  assert.equal(emitted[1].payload.type, "permission_response");
  assert.equal(emitted[1].payload.decision, "allow_once");

  const deny = await runGatedTool({ sessionId: "s1", tool: "Pay", input: { amount: 5 }, workspace: ".", tools, mode: "call", requestPermission: async () => "deny", emit: () => undefined });
  assert.equal(deny.ok, false);
  assert.equal(deny.error, "declined");

  const noPrompt = await runGatedTool({ sessionId: "s1", tool: "Pay", input: { amount: 5 }, workspace: ".", tools, mode: "call", emit: () => undefined });
  assert.equal(noPrompt.ok, false, "without a prompt channel an ask is a deny");
});

test("the intent goal frames an in-surface action as INHABIT", () => {
  const goal = surfaceIntentGoal({ name: "bills", title: "Bills", revision: 3, placement: "rail", text: "mark rent paid", faults: ["x is undefined"] });
  assert.match(goal, /^\[SURFACE INTENT · bills · revision 3 · rail\]/);
  assert.match(goal, /base_revision 3/);
  assert.match(goal, /Never rebuild/);
  assert.match(goal, /x is undefined/);
});

test("what people build stays: a faulting revision falls back, a first revision is never deleted", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { createSurface, mutateSurface, readSurface } = await import("../packages/tools/dist/index.js");
  const { SurfaceWiring } = await import("../packages/cli/dist/entry/daemon/surfaces.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-fault-"));
  const emitted = [];
  const wiring = new SurfaceWiring({ emit: (sid, p) => emitted.push({ sid, p }), deliver: () => undefined, home, workspace: home, toolsFor: () => [], tickMs: 10 });
  const page = `<main data-ares-region="m">x</main>`;
  await createSurface({ name: "shaky", title: "Shaky", placement: "card", document: { html: page }, feeds: [], actions: [], sessionId: "s9" }, home);
  await createSurface({ name: "first", title: "First", placement: "card", document: { html: page }, feeds: [], actions: [], sessionId: "s9" }, home);
  await mutateSurface("shaky", 1, [{ op: "set_title", title: "Broken" }], undefined, home);
  for (let i = 0; i < 3; i += 1) await wiring.handle({ type: "surface_fault", surface: "shaky", text: `boom ${i}` });
  for (let i = 0; i < 3; i += 1) await wiring.handle({ type: "surface_fault", surface: "first", text: `boom ${i}` });
  await sleep(50);
  const shaky = await readSurface("shaky", home);
  assert.equal(shaky.manifest.revision, 3, "the fallback is a new revision");
  assert.equal(shaky.document.title, "Shaky");
  assert.match(emitted.find((e) => e.p.type === "surface_notice").p.text, /faulted three times/);
  assert.ok(await readSurface("first", home), "a first revision stays");
  assert.ok(!emitted.some((e) => e.p.type === "surface_removed"));
  wiring.dispose();
});

test("mutate revisions carry their region ops so screens can morph; offers ask as owner decisions", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { createSurface, mutateSurface, surfaceBus, SurfaceTool, adaptToolForEngine } = await import("../packages/tools/dist/index.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-morph-"));
  const seen = [];
  const off = surfaceBus.subscribe((e) => seen.push(e));
  await createSurface({ name: "mo", title: "Mo", placement: "card", document: { html: `<main data-ares-region="m"><p data-ares-region="p">a</p></main>` }, feeds: [], actions: [] }, home);
  await mutateSurface("mo", 1, [{ op: "replace_region", target: "p", html: "b" }, { op: "post", payload: 1 }], undefined, home);
  const rev = seen.find((e) => e.type === "surface_revision" && e.origin === "mutate");
  assert.deepEqual(rev.mutations, [{ op: "replace_region", target: "p", html: "b" }]);
  assert.equal(seen.find((e) => e.origin === "create").mutations, undefined);
  off();

  process.env.ARES_HOME = home;
  const asks = [];
  const tool = adaptToolForEngine(SurfaceTool, (b) => b);
  const ctx = { workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission(req) { asks.push(req); return "allow_once"; } };
  const offered = await tool.call({ action: "offer", name: "bills", title: "Bills", placement: "rail", brief: "Shows this month's bills and lets you tick them off.", feeds: [{ kind: "time", everySec: 60 }] }, ctx);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ownerDecision, true);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /tick them off/);
  assert.match(offered.output.message, /Make it/);
  // The create that follows the accepted offer does not ask again.
  await tool.call({ action: "create", name: "bills", title: "Bills", placement: "rail", html: `<main data-ares-region="m">x</main>`, feeds: [{ kind: "time", everySec: 60 }] }, ctx);
  assert.equal(asks.length, 1);
});
