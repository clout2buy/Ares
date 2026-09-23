// The Today tab: tracked commitments, the morning feed, idea cards, and the
// tools behind them (Track, Places, Imagine).
//
// These pin the contract the phone app renders (endpoint shapes), the
// robustness the feed depends on (a model's reply is never clean JSON), the
// OpenStreetMap usage policy (identifying UA, ≤1 Nominatim request/s), and
// the exact provider requests the media tool sends — all with fetch stubbed,
// nothing leaves the machine.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TrackingStore,
  TrackTool,
  overdueTrackingBlock,
  PlacesTool,
  makeThrottle,
  clearPlacesCache,
  nominatimSearchUrl,
  overpassQuery,
  googleTextSearchBody,
  mapsLink,
  geocode,
  searchPlaces,
  PLACES_USER_AGENT,
  ImagineTool,
  setImagineSpeech,
  findImageData,
  parsePodcastScript,
  stripId3,
  veoSeconds,
  DEFAULT_TOOLS,
} from "../packages/tools/dist/index.js";
import { resolveConnectService, CONNECT_SERVICES } from "../packages/core/dist/index.js";
import { CORE_TOOL_NAMES } from "../packages/core/dist/queryEngine.js";
import { runHeartbeatTick, defaultAgentConfig } from "../packages/agent/dist/index.js";
import { Scheduler } from "../packages/garrison/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createLifeApi } from "../packages/cli/dist/lifeApi.js";
import { FeedService, parseFeedEdition, feedTurnText, FEED_EDITIONS_KEPT, DEFAULT_FEED_PROMPT } from "../packages/cli/dist/lifeFeed.js";
import { IdeasService, parseIdeas, recentConversationLines, FALLBACK_IDEAS } from "../packages/cli/dist/lifeIdeas.js";
import { classifyToolRequest, remoteAutonomyDecision } from "../packages/cli/dist/policyGate.js";
import { toolDoctrineFor } from "../packages/cli/dist/entry/prompt/toolDoctrine.js";

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-life-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

/** Point ARES_HOME at a temp dir for the tools that resolve it at call time. */
async function withAresHome(t) {
  const home = await tempHome(t);
  const prior = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => {
    if (prior === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = prior;
  });
  return home;
}

function withEnv(t, vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Replace fetch with a handler; returns the recorded calls. */
function stubFetch(t, handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ctx = () => ({ signal: new AbortController().signal });

// ── Tracking store ──────────────────────────────────────────────────────────

test("tracking: open first (soonest due), recent closed after, old closed dropped", async (t) => {
  const home = await tempHome(t);
  const store = new TrackingStore(home);
  const now = new Date("2026-09-23T12:00:00Z");
  const late = await store.add({ title: "Dinner Friday", kind: "reservation", dueAt: "2026-09-26T19:00:00Z" }, now);
  const soon = await store.add({ title: "Charger delivery", kind: "delivery", dueAt: "2026-09-24T10:00:00Z" }, now);
  const undated = await store.add({ title: "Find a dentist", kind: "promise" }, now);
  const done = await store.add({ title: "Old order", kind: "order" }, new Date("2026-08-01T00:00:00Z"));
  await store.close(done.id, "done", new Date("2026-08-02T00:00:00Z")); // 52 days ago → off the phone
  const recent = await store.add({ title: "Refund", kind: "other" }, now);
  await store.close(recent.id, "cancelled", now);

  const items = await store.forPhone(now);
  assert.deepEqual(items.map((i) => i.id), [soon.id, late.id, undated.id, recent.id]);
  assert.equal(items[3].status, "cancelled");
  for (const i of items) {
    assert.ok(i.createdAt && i.updatedAt);
    assert.ok(["reservation", "delivery", "order", "reminder", "promise", "other"].includes(i.kind));
  }
  // Still on disk, just not on the phone.
  assert.equal((await store.list("done")).length, 1);
  // Atomic writes leave no temp files behind.
  assert.deepEqual((await fsp.readdir(home)).sort(), ["tracking.json"]);
});

test("tracking: concurrent writers never lose an item; bad dates are dropped", async (t) => {
  const home = await tempHome(t);
  const store = new TrackingStore(home);
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.add({ title: `item ${n}`, kind: "nonsense", dueAt: "not a date" })));
  const all = await store.list();
  assert.equal(all.length, 12);
  assert.ok(all.every((i) => i.kind === "other" && i.dueAt === undefined));
  await assert.rejects(() => store.add({ title: "   " }), /title/);
});

test("tracking: overdue items reach the heartbeat, first, so they survive the clip", async (t) => {
  const home = await tempHome(t);
  const store = new TrackingStore(home);
  await store.add({ title: "Call the plumber back", kind: "promise", dueAt: "2026-09-23T08:00:00Z" });
  await store.add({ title: "Future thing", kind: "reminder", dueAt: "2099-01-01T00:00:00Z" });
  const now = new Date("2026-09-23T12:00:00");
  const block = await overdueTrackingBlock(home, now);
  assert.match(block, /Call the plumber back/);
  assert.doesNotMatch(block, /Future thing/);
  assert.equal(await overdueTrackingBlock(await tempHome(t), now), "");

  const config = defaultAgentConfig(home);
  config.heartbeat.activeHours = { start: "00:00", end: "23:59" };
  const result = await runHeartbeatTick({ home, workspace: home, config, now });
  assert.equal(result.status, "alert");
  assert.match(result.text, /^Overdue tracked commitments/);
  assert.match(result.text, /Call the plumber back/);
});

test("Track tool: add, list, close; unknown id is a clear failure", async (t) => {
  await withAresHome(t);
  const added = await TrackTool.call({ action: "add", title: "Table at Nopa, Fri 8pm", kind: "reservation", dueAt: "2026-09-26T20:00:00-07:00", detail: "conf #A12" }, ctx());
  assert.equal(added.output.ok, true);
  const id = added.output.item.id;
  assert.match(id, /^trk_/);
  const listed = await TrackTool.call({ action: "list" }, ctx());
  assert.match(listed.output.message, /Nopa/);
  const closed = await TrackTool.call({ action: "close", id }, ctx());
  assert.equal(closed.output.item.status, "done");
  const missing = await TrackTool.call({ action: "close", id: "trk_nope" }, ctx());
  assert.ok(missing.failure);
  // Deferred (not core), registered, and the prompt tells the model to load it.
  assert.ok(DEFAULT_TOOLS.some((tool) => tool.schema.name === "Track"));
  for (const name of ["Track", "Places", "Imagine"]) assert.ok(!CORE_TOOL_NAMES.includes(name), `${name} should be deferred`);
  assert.match(toolDoctrineFor(["ToolSearch"]), /Track add/);
});

// ── Endpoints ───────────────────────────────────────────────────────────────

async function lifeServer(t, life) {
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", phoneApi: { life } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, p, body, token = "tok") =>
    fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return call;
}

test("GET /gateway/tracking and POST /gateway/tracking/close", async (t) => {
  const home = await tempHome(t);
  const store = new TrackingStore(home);
  const a = await store.add({ title: "Shoes delivery", kind: "delivery", url: "https://track.example/1" });
  const call = await lifeServer(t, createLifeApi({ home }));

  assert.equal((await call("GET", "/gateway/tracking", undefined, "wrong")).status, 401);
  const list = await (await call("GET", "/gateway/tracking")).json();
  assert.equal(list.items.length, 1);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ["createdAt", "id", "kind", "status", "title", "updatedAt", "url"]);
  assert.equal(list.items[0].status, "open");

  assert.equal((await call("POST", "/gateway/tracking/close", { id: a.id, status: "bogus" })).status, 400);
  assert.equal((await call("POST", "/gateway/tracking/close", { id: "trk_none", status: "done" })).status, 404);
  const ok = await call("POST", "/gateway/tracking/close", { id: a.id, status: "cancelled" });
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await store.list())[0].status, "cancelled");
  // Unknown routes still 404 through the life hook.
  assert.equal((await call("GET", "/gateway/nothing-here")).status, 404);
  // Without a feed/ideas service the routes say so instead of 404ing.
  assert.equal((await call("GET", "/gateway/feed")).status, 501);
});

test("feed endpoints: prompt round-trip, async refresh, edition shape", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  const feed = new FeedService({
    home,
    runTurn: async (text) => {
      seen.push(text);
      await gate;
      return 'Here it is:\n```json\n{"title":"Morning","sections":[{"heading":"AI","items":[{"title":"Model X ships","summary":"It shipped.","url":"https://example.com/x","image":"https://example.com/x.png"}]}]}\n```';
    },
  });
  const call = await lifeServer(t, createLifeApi({ home, feed }));

  const first = await (await call("GET", "/gateway/feed")).json();
  assert.deepEqual(first, { prompt: DEFAULT_FEED_PROMPT, generating: false });

  assert.equal((await call("PUT", "/gateway/feed/prompt", { prompt: "" })).status, 400);
  assert.deepEqual(await (await call("PUT", "/gateway/feed/prompt", { prompt: "Formula 1 and Lisbon" })).json(), { ok: true });
  assert.equal(await fsp.readFile(path.join(home, "feed", "prompt.txt"), "utf8"), "Formula 1 and Lisbon\n");

  assert.deepEqual(await (await call("POST", "/gateway/feed/refresh")).json(), { ok: true });
  assert.equal((await (await call("GET", "/gateway/feed")).json()).generating, true);
  // A second tap while generating must not start a second research turn.
  await call("POST", "/gateway/feed/refresh");
  release();
  await feed.generate();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Formula 1 and Lisbon/);

  const done = await (await call("GET", "/gateway/feed")).json();
  assert.equal(done.generating, false);
  assert.equal(done.prompt, "Formula 1 and Lisbon");
  assert.deepEqual(Object.keys(done.edition).sort(), ["generatedAt", "id", "sections", "title"]);
  assert.equal(done.edition.title, "Morning");
  assert.deepEqual(done.edition.sections[0].items[0], { title: "Model X ships", summary: "It shipped.", url: "https://example.com/x", image: "https://example.com/x.png" });
});

test("GET /gateway/ideas falls back to a useful static set when generation fails", async (t) => {
  const home = await tempHome(t);
  const ideas = new IdeasService({ home, complete: async () => { throw new Error("provider down"); } });
  const call = await lifeServer(t, createLifeApi({ home, ideas }));
  const body = await (await call("GET", "/gateway/ideas")).json();
  assert.ok(body.ideas.length >= 4 && body.ideas.length <= 8);
  assert.deepEqual(body.ideas, FALLBACK_IDEAS);
  for (const idea of body.ideas) assert.ok(idea.id && idea.title && idea.prompt);
});

// ── Feed parsing, retention, schedule ───────────────────────────────────────

test("feed parsing: prose, citations and fences around the JSON; caps; junk rejected", () => {
  const edition = { title: "T", sections: [{ heading: "H", items: [{ title: "a", summary: "b", url: "javascript:alert(1)", image: "not a url" }] }] };
  const parsed = parseFeedEdition(`Sources [1] and {braces} first. ${JSON.stringify(edition)} trailing words`);
  assert.deepEqual(parsed, { title: "T", sections: [{ heading: "H", items: [{ title: "a", summary: "b" }] }] });

  const huge = {
    title: "x".repeat(1_000),
    sections: Array.from({ length: 20 }, (_, s) => ({ heading: `S${s}`, items: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, summary: "s".repeat(5_000) })) })),
  };
  const capped = parseFeedEdition("```json\n" + JSON.stringify(huge) + "\n```");
  assert.equal(capped.sections.length, 8);
  assert.equal(capped.sections[0].items.length, 8);
  assert.ok(capped.title.length <= 200);
  assert.ok(capped.sections[0].items[0].summary.length <= 700);

  assert.equal(parseFeedEdition("I couldn't find anything today."), null);
  assert.equal(parseFeedEdition('{"title":"x","sections":[{"heading":"h","items":[{"title":"no summary"}]}]}'), null);
  assert.equal(parseFeedEdition(""), null);
  assert.match(feedTurnText("my brief", new Date("2026-09-23T07:00:00")), /ONLY this JSON/);
});

test("feed: keeps 14 editions, and a failed run keeps the last good one", async (t) => {
  const home = await tempHome(t);
  let reply = "no json";
  const feed = new FeedService({ home, runTurn: async () => reply });
  for (let n = 0; n < FEED_EDITIONS_KEPT + 3; n++) {
    await feed.saveEdition({ title: `E${n}`, sections: [{ heading: "h", items: [{ title: "t", summary: "s" }] }] }, new Date(Date.UTC(2026, 8, 1 + n, 7)));
  }
  const files = await fsp.readdir(path.join(home, "feed", "editions"));
  assert.equal(files.length, FEED_EDITIONS_KEPT);
  assert.equal((await feed.latestEdition()).title, `E${FEED_EDITIONS_KEPT + 2}`);

  assert.equal(await feed.generate(), null);
  assert.equal((await feed.latestEdition()).title, `E${FEED_EDITIONS_KEPT + 2}`);
  reply = '{"title":"Fresh","sections":[{"heading":"h","items":[{"title":"t","summary":"s"}]}]}';
  assert.equal((await feed.generate()).title, "Fresh");
  assert.equal((await feed.latestEdition()).title, "Fresh");
});

test("feed: the daily run is due once per local day from 07:00, even after a late start", async (t) => {
  const home = await tempHome(t);
  withEnv(t, { ARES_FEED_HOUR: undefined });
  let now = new Date(2026, 8, 23, 6, 30);
  let runs = 0;
  const feed = new FeedService({ home, now: () => now, runTurn: async () => { runs++; return '{"title":"x","sections":[{"heading":"h","items":[{"title":"t","summary":"s"}]}]}'; } });
  assert.equal(await feed.maybeRunDaily(), false); // before 07:00
  now = new Date(2026, 8, 23, 9, 15); // garrison came up late
  assert.equal(await feed.maybeRunDaily(), true);
  await feed.generate();
  assert.equal(await feed.maybeRunDaily(), false); // already ran today
  now = new Date(2026, 8, 24, 7, 1);
  assert.equal(await feed.maybeRunDaily(), true);
  await feed.generate();
  assert.equal(runs, 2);
});

test("scheduler: the feed hook is polled on its own interval", async () => {
  const timers = [];
  let fired = 0;
  const scheduler = new Scheduler({
    hooks: { feed: () => { fired++; } },
    feedCheckEveryMs: 1234,
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalFn: () => {},
    gauntletEnabled: false,
  });
  scheduler.start();
  const feedTimer = timers.find((x) => x.ms === 1234);
  assert.ok(feedTimer);
  feedTimer.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(fired, 1);
  scheduler.stop();
});

// ── Ideas ───────────────────────────────────────────────────────────────────

test("ideas: parsed from the summarize slot, cached 6h, inputs read from rollout tails", async (t) => {
  const home = await tempHome(t);
  const dir = path.join(home, "garrison", "sessions");
  await fsp.mkdir(dir, { recursive: true });
  const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
  // An owner session with a large rollout: only the tail is read.
  const filler = JSON.stringify({ ts: "x", event: { type: "text_delta", text: "y".repeat(1_000) } }) + "\n";
  await fsp.writeFile(path.join(dir, "sess_owner.jsonl"), filler.repeat(200) + JSON.stringify({ event: { type: "turn_start", turnId: "t", sessionId: "sess_owner", userMessage: userMsg("(system: phone) book the dentist for next week") } }) + "\n");
  await fsp.writeFile(path.join(dir, "sess_owner.meta.json"), JSON.stringify({ title: "Dentist" }));
  await fsp.writeFile(path.join(dir, "sess_guest.jsonl"), JSON.stringify({ event: { type: "turn_start", userMessage: userMsg("guest secret") } }) + "\n");
  await fsp.writeFile(path.join(dir, "sess_guest.meta.json"), JSON.stringify({ title: "Guest", tenant: { role: "guest", chatId: "9" } }));
  const lines = await recentConversationLines(home);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Dentist — last: book the dentist for next week/);

  await new TrackingStore(home).add({ title: "Laptop repair pickup", kind: "promise" });
  let calls = 0;
  let seenUser = "";
  const reply = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ title: `Idea ${i}`, prompt: `Do thing ${i}`, icon: "✨" })));
  let now = Date.parse("2026-09-23T08:00:00Z");
  const ideas = new IdeasService({ home, now: () => now, complete: async (_system, user) => { calls++; seenUser = user; return "```json\n" + reply + "\n```"; } });
  const first = await ideas.get();
  assert.equal(first.length, 6);
  assert.equal(first[0].prompt, "Do thing 0");
  assert.equal(first[0].icon, "✨");
  assert.match(seenUser, /Dentist/);
  assert.match(seenUser, /Laptop repair pickup/);
  assert.doesNotMatch(seenUser, /guest secret/);
  now += 60 * 60_000;
  await ideas.get();
  assert.equal(calls, 1, "served from the 6h cache");
  now += 6 * 60 * 60_000;
  await ideas.get();
  assert.equal(calls, 2);

  assert.equal(parseIdeas('[{"title":"only one","prompt":"p"}]'), null);
  assert.equal(parseIdeas("nope"), null);
  assert.equal(parseIdeas(JSON.stringify({ ideas: JSON.parse(reply) })).length, 6);
});

// ── Places ──────────────────────────────────────────────────────────────────

test("places: request construction follows the OSM usage policy", () => {
  const url = new URL(nominatimSearchUrl("Ferry Building, SF", { limit: 3 }));
  assert.equal(url.host, "nominatim.openstreetmap.org");
  assert.equal(url.searchParams.get("q"), "Ferry Building, SF");
  assert.equal(url.searchParams.get("format"), "jsonv2");
  assert.equal(url.searchParams.get("limit"), "3");
  const q = overpassQuery('coffee"; out; (', 37.79, -122.39, 800);
  assert.match(q, /around:800,37\.79,-122\.39/);
  assert.match(q, /"amenity"~"\^\(cafe\|coffee\|/);
  assert.doesNotMatch(q, /coffee";/, "quotes/regex syntax from the query are stripped");
  assert.deepEqual(googleTextSearchBody("sushi", { lat: 1, lon: 2 }, 99_999).locationBias.circle, { center: { latitude: 1, longitude: 2 }, radius: 50_000 });
  assert.equal(mapsLink("Blue Bottle", 37.1, -122.2), "https://maps.apple.com/?q=Blue%20Bottle&ll=37.1,-122.2");
  assert.match(PLACES_USER_AGENT, /^Ares\/1\.0/);
});

test("places: the throttle spaces request STARTS, even when fired in the same tick", async () => {
  let clock = 0;
  const starts = [];
  const throttle = makeThrottle(1_000, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  await Promise.all([1, 2, 3].map((n) => throttle(async () => { starts.push(clock); return n; })));
  assert.deepEqual(starts, [0, 1_000, 2_000]);
});

test("places: geocode sends the UA and caches; Google is preferred when a key exists", async (t) => {
  clearPlacesCache();
  const calls = stubFetch(t, (call) => {
    if (call.url.startsWith("https://nominatim.openstreetmap.org/search")) {
      return jsonRes([{ lat: "37.7955", lon: "-122.3937", name: "Ferry Building", display_name: "Ferry Building, San Francisco", category: "tourism", type: "attraction", extratags: { opening_hours: "Mo-Su 07:00-22:00", website: "https://ferrybuildingmarketplace.com" } }]);
    }
    if (call.url === "https://places.googleapis.com/v1/places:searchText") {
      return jsonRes({ places: [{ displayName: { text: "Blue Bottle" }, formattedAddress: "1 Ferry Bldg", location: { latitude: 37.7956, longitude: -122.3935 }, primaryType: "cafe", rating: 4.5, nationalPhoneNumber: "(510) 555-0100", regularOpeningHours: { weekdayDescriptions: ["Monday: 7 AM–7 PM"] } }] });
    }
    return jsonRes({ error: "unexpected" }, 500);
  });
  const [place] = await geocode("Ferry Building");
  assert.equal(place.name, "Ferry Building");
  assert.equal(place.openingHours, "Mo-Su 07:00-22:00");
  assert.equal(place.mapsUrl, "https://maps.apple.com/?q=Ferry%20Building&ll=37.7955,-122.3937");
  assert.equal(calls[0].init.headers["user-agent"], PLACES_USER_AGENT);
  await geocode("Ferry Building");
  assert.equal(calls.length, 1, "second lookup served from cache");

  const { places, center } = await searchPlaces("coffee", { near: "37.79,-122.39", radiusM: 500, googleKey: "gkey" });
  const google = calls.at(-1);
  assert.equal(google.init.headers["x-goog-api-key"], "gkey");
  assert.match(google.init.headers["x-goog-fieldmask"], /places\.displayName/);
  assert.equal(JSON.parse(google.init.body).textQuery, "coffee");
  assert.deepEqual(center, { lat: 37.79, lon: -122.39 });
  assert.equal(places[0].name, "Blue Bottle");
  assert.equal(places[0].source, "google");
  assert.equal(places[0].phone, "(510) 555-0100");
  assert.ok(places[0].distanceM > 0);
});

test("places: Overpass search around a point, distance-sorted", async (t) => {
  clearPlacesCache();
  withEnv(t, { GOOGLE_PLACES_API_KEY: undefined });
  await withAresHome(t);
  const calls = stubFetch(t, (call) => {
    if (call.url === "https://overpass-api.de/api/interpreter") {
      return jsonRes({ elements: [
        { type: "node", lat: 37.80, lon: -122.39, tags: { name: "Far Cafe", amenity: "cafe" } },
        { type: "way", center: { lat: 37.7901, lon: -122.3901 }, tags: { name: "Near Cafe", amenity: "cafe", "addr:housenumber": "1", "addr:street": "Main St", phone: "+1 555" } },
        { type: "node", lat: 37.79, lon: -122.39, tags: { amenity: "cafe" } },
      ] });
    }
    return jsonRes({}, 500);
  });
  const result = await PlacesTool.call({ action: "search", query: "coffee", near: "37.79,-122.39", radius_m: 2000 }, ctx());
  assert.equal(calls[0].init.method, "POST");
  assert.match(decodeURIComponent(calls[0].init.body), /around:2000,37\.79,-122\.39/);
  assert.deepEqual(result.output.places.map((p) => p.name), ["Near Cafe", "Far Cafe"]);
  assert.equal(result.output.places[0].address, "1 Main St");
  assert.equal(result.output.source, "osm");
});

// ── Imagine ─────────────────────────────────────────────────────────────────

test("imagine: OpenAI image request, saved under media/<date>/", async (t) => {
  const home = await withAresHome(t);
  withEnv(t, { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, ARES_IMAGINE_OPENAI_MODEL: undefined });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const calls = stubFetch(t, () => jsonRes({ data: [{ b64_json: png.toString("base64") }] }));
  const result = await ImagineTool.call({ action: "image", prompt: "A red fox, watercolor!", size: "1536x1024" }, ctx());
  assert.ok(!result.failure, result.output.message);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "gpt-image-2", prompt: "A red fox, watercolor!", n: 1, size: "1536x1024" });
  assert.ok(result.output.path.startsWith(path.join(home, "media")));
  assert.match(result.output.path, /a-red-fox-watercolor\.png$/);
  assert.deepEqual(await fsp.readFile(result.output.path), png);
  // Images are allowed; the permission gate leaves them alone.
  assert.deepEqual(await ImagineTool.checkPermissions({ action: "image", prompt: "x" }, { permissionMode: "workspace-write" }), { kind: "allow" });
});

test("imagine: OpenAI edit sends multipart with the source image", async (t) => {
  const home = await withAresHome(t);
  withEnv(t, { OPENAI_API_KEY: "sk-test" });
  const src = path.join(home, "in.png");
  await fsp.writeFile(src, Buffer.from("89504e47", "hex"));
  const calls = stubFetch(t, () => jsonRes({ data: [{ b64_json: "AAAA" }] }));
  const result = await ImagineTool.call({ action: "image", prompt: "make it night", edit_from: src }, ctx());
  assert.ok(!result.failure, result.output.message);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("prompt"), "make it night");
  assert.equal(form.get("image").type, "image/png");
});

test("imagine: Gemini image via Interactions, falling back to generateContent", async (t) => {
  await withAresHome(t);
  withEnv(t, { OPENAI_API_KEY: undefined, GEMINI_API_KEY: "g-key", ARES_IMAGINE_GEMINI_IMAGE_MODEL: undefined });
  const calls = stubFetch(t, (call) => {
    if (call.url.endsWith("/v1beta/interactions")) return jsonRes({ error: { message: "not found" } }, 404);
    return jsonRes({ candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: "iVBORw0K" } }] } }] });
  });
  const result = await ImagineTool.call({ action: "image", prompt: "a lighthouse", size: "1024x1536" }, ctx());
  assert.ok(!result.failure, result.output.message);
  const first = JSON.parse(calls[0].init.body);
  assert.equal(first.model, "gemini-3.1-flash-image");
  assert.equal(first.response_format.aspect_ratio, "2:3");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-key");
  assert.match(calls[1].url, /models\/gemini-2\.5-flash-image:generateContent$/);
  assert.match(result.output.path, /a-lighthouse\.png$/);
  // The Interactions shape is found too.
  assert.deepEqual(findImageData({ steps: [{ type: "model_output", content: [{ type: "text", text: "x" }, { type: "image", data: "QQ==", mime_type: "image/jpeg" }] }] }), { data: "QQ==", mimeType: "image/jpeg" });
});

test("imagine: Veo video polls the operation and downloads; video asks first", async (t) => {
  await withAresHome(t);
  withEnv(t, { GEMINI_API_KEY: "g-key", ARES_IMAGINE_POLL_MS: "0", ARES_IMAGINE_VEO_MODEL: undefined });
  let polls = 0;
  const calls = stubFetch(t, (call) => {
    if (call.url.endsWith(":predictLongRunning")) return jsonRes({ name: "models/veo/operations/op1" });
    if (call.url.endsWith("/operations/op1")) {
      polls++;
      return jsonRes(polls < 3 ? { done: false } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://files.example/v.mp4" } }] } } });
    }
    if (call.url === "https://files.example/v.mp4") return new Response(Buffer.from("mp4bytes"));
    return jsonRes({}, 500);
  });
  const result = await ImagineTool.call({ action: "video", prompt: "waves at dawn", seconds: 5 }, ctx());
  assert.ok(!result.failure, result.output.message);
  assert.match(calls[0].url, /models\/veo-3\.1-fast-generate-preview:predictLongRunning$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { instances: [{ prompt: "waves at dawn" }], parameters: { aspectRatio: "16:9", durationSeconds: "4" } });
  assert.equal(polls, 3);
  assert.equal(calls.at(-1).init.headers["x-goog-api-key"], "g-key");
  assert.match(result.output.path, /waves-at-dawn\.mp4$/);
  assert.equal(await fsp.readFile(result.output.path, "utf8"), "mp4bytes");
  assert.deepEqual([veoSeconds(3), veoSeconds(6), veoSeconds(30)], ["4", "6", "8"]);

  const decision = await ImagineTool.checkPermissions({ action: "video", prompt: "x" }, { permissionMode: "bypass" });
  assert.equal(decision.kind, "ask");
  assert.equal(classifyToolRequest({ toolName: "Imagine", input: { action: "video" }, reason: "" }), "payment_or_purchase");
  assert.equal(remoteAutonomyDecision({ toolName: "Imagine", input: { action: "video" }, reason: "" }), "ask");
  assert.equal(remoteAutonomyDecision({ toolName: "Imagine", input: { action: "image" }, reason: "" }), "allow");
});

test("imagine: no key → Connect; podcast stitches two voices without ID3 tags", async (t) => {
  await withAresHome(t);
  withEnv(t, { OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined });
  const noKey = await ImagineTool.call({ action: "image", prompt: "x" }, ctx());
  assert.ok(noKey.failure);
  assert.match(noKey.output.message, /Connect with service "openai".*"gemini"/);
  assert.match((await ImagineTool.call({ action: "video", prompt: "x" }, ctx())).output.message, /Connect with service "gemini"/);

  const spoken = [];
  const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 2]), Buffer.from("xx")]);
  setImagineSpeech(async (text, voice) => {
    spoken.push([voice, text]);
    return Buffer.concat([id3, Buffer.from(`[${voice}:${text}]`)]);
  });
  t.after(() => setImagineSpeech(null));
  const script = "A: Welcome to the show.\nB: Glad to be here.\nIt's a lovely day.\n\nA: Let's begin.";
  assert.deepEqual(parsePodcastScript(script).map((s) => s.speaker), ["A", "B", "A"]);
  const result = await ImagineTool.call({ action: "podcast", script }, ctx());
  assert.ok(!result.failure, result.output.message);
  assert.deepEqual(spoken, [
    ["en-US-GuyNeural", "Welcome to the show."],
    ["en-US-JennyNeural", "Glad to be here. It's a lovely day."],
    ["en-US-GuyNeural", "Let's begin."],
  ]);
  const audio = await fsp.readFile(result.output.path, "utf8");
  assert.equal(audio, "[en-US-GuyNeural:Welcome to the show.][en-US-JennyNeural:Glad to be here. It's a lovely day.][en-US-GuyNeural:Let's begin.]");
  assert.match(result.output.path, /\.mp3$/);
  assert.deepEqual(stripId3(Buffer.from("plain")), Buffer.from("plain"));
});

// ── Connect ─────────────────────────────────────────────────────────────────

test("connect: openai, gemini and google-places are api-key services", () => {
  for (const [asked, id, credential] of [["openai", "openai", "OPENAI_API_KEY"], ["gemini", "gemini", "GEMINI_API_KEY"], ["google places", "google-places", "GOOGLE_PLACES_API_KEY"]]) {
    const service = resolveConnectService(asked);
    assert.equal(service?.id, id, asked);
    assert.equal(service.kind, "api-key");
    assert.equal(service.fields[0].credential, credential);
  }
  assert.equal(new Set(CONNECT_SERVICES.map((s) => s.id)).size, CONNECT_SERVICES.length, "ids stay unique");
});
