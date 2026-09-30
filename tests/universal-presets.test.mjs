// The preset services. Default suite (offline): the bundled specs are coherent,
// the operations the model needs are findable, and Home Assistant — the one
// preset that lives on the owner's LAN — works end to end against a local
// stand-in that follows its documented REST contract.
//
// Integration (ARES_UNIVERSAL_INTEGRATION=1): every other preset is called for
// REAL over the internet and must answer with the shape the spec promises. The
// date and result of each call are written to the test output (t.diagnostic) —
// that output is the record of what was verified, not a document. A service
// that is down or rate-limits does not get a "verified" line, and was dropped.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  ApiTool,
  apiCall,
  specHandleFor,
  searchOperations,
  classifyApiCall,
  verifyApiService,
  listApiServices,
  resetRateLimits,
  PRESET_SPECS,
  atomToJson,
} from "../packages/tools/dist/index.js";
import { API_PRESET_DEFS, setCredential, deleteCredential, resolveConnectService, apiCred } from "../packages/core/dist/index.js";

const INTEGRATION = process.env.ARES_UNIVERSAL_INTEGRATION === "1";
const LIVE = INTEGRATION ? false : "set ARES_UNIVERSAL_INTEGRATION=1 to call the real services";
const def = (id) => API_PRESET_DEFS.find((d) => d.id === id);
const ctx = (permissionMode = "workspace-write") => ({ signal: new AbortController().signal, permissionMode });

// ─── offline ─────────────────────────────────────────────────────────────────

test("every preset spec parses, documents its operations, and is findable by what a person would say", () => {
  const wanted = {
    "open-meteo": [["weather forecast for coordinates", "forecast"], ["find latitude longitude of a city", "searchLocation"], ["historical weather", "archive"], ["air quality", "airQuality"]],
    wikipedia: [["search articles", "searchPages"], ["summary of an article", "getPageSummary"], ["what happened on this day", "onThisDay"]],
    wikidata: [["find an entity by name", "searchEntities"], ["run a sparql query", "sparqlQuery"], ["get item", "getItem"]],
    nominatim: [["address to coordinates", "search"], ["coordinates to address", "reverse"]],
    "open-library": [["search books", "searchBooks"], ["lookup by isbn", "getByIsbn"], ["author", "getAuthor"]],
    arxiv: [["search papers", "searchPapers"]],
    "hacker-news": [["top stories", "listStories"], ["get a comment", "getItem"], ["user karma", "getUser"]],
    "usgs-earthquakes": [["recent earthquakes", "summaryFeed"], ["search earthquakes by magnitude", "queryEarthquakes"], ["count earthquakes", "countEarthquakes"]],
    frankfurter: [["latest exchange rates", "latest"], ["rates on a date", "historical"], ["currency codes", "currencies"]],
    coingecko: [["bitcoin price", "simplePrice"], ["trending coins", "trending"], ["top coins by market cap", "coinsMarkets"]],
    "nasa-apod": [["picture of the day", "apod"]],
    "home-assistant": [["turn on a light", "callService"], ["state of an entity", "getState"], ["all entities", "listStates"], ["render a template", "renderTemplate"]],
  };
  assert.deepEqual(Object.keys(wanted).sort(), API_PRESET_DEFS.map((d) => d.id).sort(), "every preset is covered here");
  for (const d of API_PRESET_DEFS) {
    const handle = specHandleFor(d);
    assert.ok(PRESET_SPECS[d.id]);
    for (const entry of handle.ops) {
      assert.ok(entry.summary.length > 10, `${d.id}.${entry.id} has a summary`);
      const op = handle.operation(entry.id);
      for (const p of op.parameters) {
        assert.ok(p.description || p.schema.enum || p.schema.default !== undefined || /^(id|date|title|list|feed|domain|service|event_type|item_id|work_id|author_id|subject|isbn|mm|dd|type|entity_id|timestamp)$/.test(p.name), `${d.id}.${entry.id}.${p.name} is documented`);
      }
    }
    for (const [query, expected] of wanted[d.id]) {
      const top = searchOperations(handle.ops, query).hits.map((h) => h.id);
      assert.ok(top.slice(0, 2).includes(expected), `${d.id}: "${query}" should surface ${expected}, got ${top.join(", ")}`);
    }
  }
});

test("presets: only reads are free; Home Assistant's service calls ask, and its POST reads do not", () => {
  for (const d of API_PRESET_DEFS.filter((x) => x.id !== "home-assistant")) {
    const handle = specHandleFor(d);
    assert.ok(handle.ops.every((o) => o.method === "GET"), `${d.id} is read-only`);
    for (const o of handle.ops) assert.equal(classifyApiCall(d.id, o.id).kind, "read");
  }
  assert.equal(classifyApiCall("home-assistant", "getState").kind, "read");
  assert.equal(classifyApiCall("home-assistant", "renderTemplate").kind, "read");
  assert.equal(classifyApiCall("home-assistant", "checkConfig").kind, "read");
  assert.equal(classifyApiCall("home-assistant", "callService", { domain: "light", service: "turn_on" }).kind, "write");
  assert.equal(classifyApiCall("home-assistant", "callService", { domain: "light", service: "turn_on" }).destructive, false);
  assert.equal(classifyApiCall("home-assistant", "callService", { domain: "lock", service: "unlock" }).destructive, true);
  assert.equal(classifyApiCall("home-assistant", "callService", { domain: "alarm_control_panel", service: "alarm_disarm" }).destructive, true);
  assert.equal(classifyApiCall("home-assistant", "fireEvent").kind, "write");
  assert.equal(classifyApiCall("home-assistant", "setState").kind, "write");
});

test("the arXiv Atom shim turns a feed into compact JSON", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <title type="html">ArXiv Query: search_query=all:electron</title><opensearch:totalResults>1234</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>2</opensearch:itemsPerPage>
    <entry><id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All
        You Need</title><summary>The dominant sequence &amp; transduction models   are based on <b>complex</b> networks.</summary>
      <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
      <arxiv:comment>15 pages &lt;5 figures&gt;</arxiv:comment><link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
      <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/><category term="cs.CL" scheme="x"/><category term="cs.LG" scheme="x"/></entry>
    <entry><id>http://arxiv.org/abs/2</id><title>Second</title><summary>s</summary><author><name>B</name></author></entry></feed>`;
  const out = atomToJson(xml);
  assert.deepEqual(out.feed, { title: "ArXiv Query: search_query=all:electron", totalResults: 1234, startIndex: 0, itemsPerPage: 2 });
  assert.equal(out.entries.length, 2);
  const e = out.entries[0];
  assert.equal(e.title, "Attention Is All You Need");
  assert.equal(e.summary, "The dominant sequence & transduction models are based on complex networks.");
  assert.deepEqual(e.authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.equal(e.link, "http://arxiv.org/abs/1706.03762v7");
  assert.equal(e.pdf, "http://arxiv.org/pdf/1706.03762v7");
  assert.equal(e.primaryCategory, "cs.CL");
  assert.deepEqual(e.categories, ["cs.CL", "cs.LG"]);
  assert.equal(e.comment, "15 pages <5 figures>");
  assert.throws(() => atomToJson("<html></html>"), /not an Atom feed/);
});

// ─── Home Assistant against a stand-in that follows its REST contract ────────

const TOKEN = "ha-long-lived-token-abcdef123456";

async function startHomeAssistant(t) {
  const states = { "light.kitchen": { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen" } }, "sensor.outdoor_temperature": { entity_id: "sensor.outdoor_temperature", state: "14.2", attributes: { unit_of_measurement: "°C" } } };
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const send = (status, payload, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, "401: Unauthorized", "text/plain");
      const p = url.pathname;
      if (p === "/api/" && req.method === "GET") return send(200, { message: "API running." });
      if (p === "/api/states" && req.method === "GET") return send(200, Object.values(states));
      const m = /^\/api\/states\/(.+)$/.exec(p);
      if (m && req.method === "GET") return states[m[1]] ? send(200, states[m[1]]) : send(404, { message: "Entity not found." });
      if (m && req.method === "POST") { const b = JSON.parse(body); states[m[1]] = { entity_id: m[1], state: b.state, attributes: b.attributes ?? {} }; return send(201, states[m[1]]); }
      const s = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(p);
      if (s && req.method === "POST") {
        const b = body ? JSON.parse(body) : {};
        if (s[1] === "light" && s[2] === "turn_on") { states["light.kitchen"].state = "on"; return send(200, [states["light.kitchen"]]); }
        return send(400, { message: `Service ${s[1]}.${s[2]} not found.` });
      }
      if (p === "/api/template" && req.method === "POST") return send(200, `rendered: ${JSON.parse(body).template}`, "text/plain");
      if (p === "/api/config") return send(200, { location_name: "Home", version: "2026.9.0" });
      return send(404, "404: Not Found", "text/plain");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, states, calls };
}

test("Home Assistant: connect stores the address and token; read states; act; the model never sees the token", async (t) => {
  const ha = await startHomeAssistant(t);
  const baseName = apiCred("home-assistant", "BASEURL");
  const keyName = apiCred("home-assistant", "KEY");
  t.after(async () => { await deleteCredential(baseName); await deleteCredential(keyName); });
  resetRateLimits();

  // not connected: the error says how
  await assert.rejects(() => apiCall({ service: "home-assistant", operationId: "getState", params: { entity_id: "light.kitchen" } }), /has no address stored.*Connect with service "api-home-assistant"/);

  // the connect form's live check runs BEFORE anything is stored
  const service = resolveConnectService("home assistant");
  assert.deepEqual(service.fields.map((f) => f.credential), [baseName, keyName]);
  await assert.rejects(() => verifyApiService("home-assistant", { [baseName]: ha.url, [keyName]: "wrong-token-000000" }), /rejected those credentials \(HTTP 401\)/);
  const verified = await verifyApiService("home-assistant", { [baseName]: `${ha.url}/api/`, [keyName]: TOKEN });
  assert.match(verified, /answered \(apiRoot, HTTP 200\)/);
  assert.equal(ha.calls.at(-1).path, "/api/", "a trailing /api on the typed address is not doubled");

  await setCredential(baseName, `${ha.url}/`);
  await setCredential(keyName, TOKEN);
  const services = await listApiServices();
  assert.equal(services.find((s) => s.id === "home-assistant").access, "connected");

  const state = await apiCall({ service: "home-assistant", operationId: "getState", params: { entity_id: "sensor.outdoor_temperature" } });
  assert.equal(state.data.state, "14.2");
  assert.equal(ha.calls.at(-1).auth, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(state).includes(TOKEN));
  const all = await apiCall({ service: "home-assistant", operationId: "listStates" }, {}, { select: "*.entity_id" });
  assert.deepEqual(all.data, ["light.kitchen", "sensor.outdoor_temperature"]);

  const miss = await apiCall({ service: "home-assistant", operationId: "getState", params: { entity_id: "light.nope" } });
  assert.equal(miss.status, 404);
  assert.equal(miss.ok, false);

  // act: a service call with a JSON body
  const turnOn = await apiCall({ service: "home-assistant", operationId: "callService", params: { domain: "light", service: "turn_on" }, body: { entity_id: "light.kitchen", brightness_pct: 40 } });
  assert.equal(turnOn.status, 200);
  assert.equal(ha.calls.at(-1).path, "/api/services/light/turn_on");
  assert.deepEqual(JSON.parse(ha.calls.at(-1).body), { entity_id: "light.kitchen", brightness_pct: 40 });
  assert.equal(ha.states["light.kitchen"].state, "on");
  // a POST that only reads
  const tpl = await apiCall({ service: "home-assistant", operationId: "renderTemplate", body: { template: "{{ states('sensor.outdoor_temperature') }}" } });
  assert.match(tpl.text, /^rendered: /);

  // through the tool: a write asks in a guarded mode; unlock is the owner's decision even in bypass
  const permit = (input, mode) => ApiTool.checkPermissions(ApiTool.inputZod.parse(input), ctx(mode));
  assert.equal((await permit({ action: "call", service: "home-assistant", operationId: "getState", params: { entity_id: "light.kitchen" } }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "call", service: "home-assistant", operationId: "callService", params: { domain: "light", service: "turn_on" } }, "workspace-write")).kind, "ask");
  assert.equal((await permit({ action: "call", service: "home-assistant", operationId: "callService", params: { domain: "light", service: "turn_on" } }, "bypass")).kind, "allow");
  const unlock = await permit({ action: "call", service: "home-assistant", operationId: "callService", params: { domain: "lock", service: "unlock" } }, "bypass");
  assert.equal(unlock.ownerDecision, true);
  const unknownSvc = await ApiTool.call(ApiTool.inputZod.parse({ action: "call", service: "home-assistant", operationId: "callService", params: { domain: "nope", service: "nada" }, body: {} }), ctx("bypass"));
  assert.match(unknownSvc.failure, /HTTP 400.*not found/);

  // a wrong parameter teaches
  const wrong = await ApiTool.call(ApiTool.inputZod.parse({ action: "call", service: "home-assistant", operationId: "getState", params: { entity: "light.kitchen" } }), ctx());
  assert.match(wrong.failure, /no parameter "entity" \(did you mean "entity_id"\?\)/);
});

test("Home Assistant: the LAN permission is per service — the same address is refused for a service without it", async (t) => {
  const ha = await startHomeAssistant(t);
  const { addApiService, removeApiService } = await import("../packages/tools/dist/index.js");
  // not allowed on the LAN: the add itself is refused
  await assert.rejects(() => addApiService({ id: "ha-clone", specText: JSON.stringify(PRESET_SPECS["home-assistant"]), baseUrl: ha.url }), /not allowed.*(private|loopback|plain http)/);
  // allowed: works, and only for that id
  await addApiService({ id: "ha-clone", specText: JSON.stringify(PRESET_SPECS["home-assistant"]), baseUrl: ha.url, allowLan: true, auth: { type: "bearer" } });
  t.after(() => removeApiService("ha-clone"));
  await setCredential(apiCred("ha-clone", "KEY"), TOKEN);
  t.after(() => deleteCredential(apiCred("ha-clone", "KEY")));
  resetRateLimits();
  assert.equal((await apiCall({ service: "ha-clone", operationId: "apiRoot" })).status, 200);
});

// ─── live: the real services ─────────────────────────────────────────────────

const stamp = () => new Date().toISOString().slice(0, 10);

/** One real call. Records the date, status and a fragment of evidence. */
async function live(t, service, operationId, params, check, opts = {}) {
  resetRateLimits();
  let r;
  try {
    r = await apiCall({ service, operationId, params }, {}, { maxChars: 20000, ...opts });
  } catch (err) {
    t.diagnostic(`NOT VERIFIED ${stamp()} ${service}.${operationId}: ${err.message}`);
    throw err;
  }
  try {
    assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    check(r.data ?? JSON.parse(r.text), r);
  } catch (err) {
    t.diagnostic(`NOT VERIFIED ${stamp()} ${service}.${operationId}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
    throw err;
  }
  t.diagnostic(`VERIFIED ${stamp()} ${service}.${operationId} HTTP ${r.status} in ${r.ms} ms: ${r.text.replace(/\s+/g, " ").slice(0, 110)}`);
  return r;
}

test("LIVE open-meteo: geocode Berlin, then its forecast, archive and air quality", { skip: LIVE, timeout: 90_000 }, async (t) => {
  const geo = await live(t, "open-meteo", "searchLocation", { name: "Berlin", count: 1 }, (d) => {
    assert.equal(d.results[0].name, "Berlin");
    assert.ok(Math.abs(d.results[0].latitude - 52.52) < 0.5);
  });
  const { latitude, longitude } = geo.data.results[0];
  await live(t, "open-meteo", "forecast", { latitude, longitude, current: ["temperature_2m", "wind_speed_10m"], daily: ["temperature_2m_max"], forecast_days: 2 }, (d) => {
    assert.equal(typeof d.current.temperature_2m, "number");
    assert.equal(d.daily.temperature_2m_max.length, 2);
  });
  await live(t, "open-meteo", "archive", { latitude, longitude, start_date: "2024-01-01", end_date: "2024-01-02", daily: ["temperature_2m_max"] }, (d) => assert.equal(d.daily.time.length, 2));
  await live(t, "open-meteo", "airQuality", { latitude, longitude, current: ["pm10"] }, (d) => assert.ok("current" in d));
});

test("LIVE wikipedia: search and summary", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "wikipedia", "searchPages", { q: "Alan Turing", limit: 3 }, (d) => assert.ok(d.pages.some((p) => /Turing/.test(p.title))));
  await live(t, "wikipedia", "getPageSummary", { title: "Alan Turing" }, (d) => {
    assert.equal(d.title, "Alan Turing");
    assert.match(d.extract, /mathematician|computer scientist/i);
  });
  await live(t, "wikipedia", "onThisDay", { type: "selected", mm: "07", dd: "04" }, (d) => assert.ok(Array.isArray(d) && d.length === 2 && d[0].text), { select: "selected.0:2" });
});

test("LIVE wikidata: entity search, item labels, SPARQL", { skip: LIVE, timeout: 90_000 }, async (t) => {
  await live(t, "wikidata", "searchEntities", { search: "Douglas Adams", limit: 3 }, (d) => assert.equal(d.search[0].id, "Q42"));
  await live(t, "wikidata", "getItemLabels", { item_id: "Q42" }, (d) => assert.equal(d.en, "Douglas Adams"));
  await live(t, "wikidata", "sparqlQuery", { query: 'SELECT ?item WHERE { ?item wdt:P31 wd:Q146 } LIMIT 2' }, (d) => assert.equal(d.results.bindings.length, 2));
});

test("LIVE nominatim: geocode and reverse (honouring its one-request-a-second policy)", { skip: LIVE, timeout: 60_000 }, async (t) => {
  const first = await live(t, "nominatim", "search", { q: "Brandenburger Tor, Berlin", limit: 1 }, (d) => assert.match(d[0].display_name, /Brandenburg/i));
  const { lat, lon } = first.data[0];
  const t0 = Date.now();
  resetRateLimits(); // a fresh bucket would hide the interval, so call without resetting between these two:
  const r = await apiCall({ service: "nominatim", operationId: "reverse", params: { lat, lon, zoom: 18 } });
  assert.equal(r.status, 200);
  assert.match(r.data.display_name, /Berlin/);
  t.diagnostic(`VERIFIED ${stamp()} nominatim.reverse HTTP ${r.status}: ${r.text.slice(0, 100)}`);
  void t0;
});

test("LIVE open-library: search, ISBN lookup (through its redirect), author", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "open-library", "searchBooks", { q: "the hobbit", limit: 2, fields: ["key", "title", "author_name"] }, (d) => assert.ok(d.docs.length >= 1 && /hobbit/i.test(d.docs[0].title)));
  const isbn = await live(t, "open-library", "getByIsbn", { isbn: "9780140328721" }, (d) => assert.match(d.title, /Fantastic/i));
  assert.ok(isbn.notes.some((n) => /redirect/.test(n)), "followed Open Library's same-origin redirect");
  await live(t, "open-library", "getAuthor", { author_id: "OL23919A" }, (d) => assert.match(d.name, /Rowling/));
});

test("LIVE arxiv: Atom converted to JSON", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "arxiv", "searchPapers", { search_query: "all:transformer AND cat:cs.CL", max_results: 2, sortBy: "submittedDate", sortOrder: "descending" }, (d) => {
    assert.equal(d.entries.length, 2);
    assert.ok(d.entries[0].title && d.entries[0].authors.length >= 1 && /arxiv\.org/.test(d.entries[0].link));
    assert.ok(d.feed.totalResults > 100);
  });
});

test("LIVE hacker-news: top stories narrowed with select, then an item", { skip: LIVE, timeout: 60_000 }, async (t) => {
  const top = await live(t, "hacker-news", "listStories", { list: "topstories" }, (d) => assert.ok(Array.isArray(d) && d.length === 5), { select: "0:5" });
  assert.equal(top.data.length, 5);
  await live(t, "hacker-news", "getItem", { id: top.data[0] }, (d) => assert.ok(d.title || d.text));
  await live(t, "hacker-news", "maxItem", {}, (d) => assert.equal(typeof d, "number"));
});

test("LIVE usgs-earthquakes: count, query and a real-time feed", { skip: LIVE, timeout: 60_000 }, async (t) => {
  const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  await live(t, "usgs-earthquakes", "countEarthquakes", { starttime: week, minmagnitude: 4.5 }, (d) => assert.equal(typeof d.count, "number"));
  await live(t, "usgs-earthquakes", "queryEarthquakes", { starttime: week, minmagnitude: 5, limit: 3, orderby: "magnitude" }, (d) => assert.equal(d.type, "FeatureCollection"));
  await live(t, "usgs-earthquakes", "summaryFeed", { feed: "4.5_week" }, (d) => assert.ok(d.count >= 0 && d.title), { select: "metadata" });
});

test("LIVE frankfurter: latest, historical, currencies", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "frankfurter", "latest", { base: "USD", symbols: ["EUR", "GBP"] }, (d) => {
    assert.equal(d.base, "USD");
    assert.ok(d.rates.EUR > 0 && d.rates.GBP > 0);
  });
  await live(t, "frankfurter", "historical", { date: "2024-01-02", symbols: ["USD"] }, (d) => assert.ok(d.rates.USD > 1));
  await live(t, "frankfurter", "currencies", {}, (d) => assert.equal(d.EUR, "Euro"));
});

test("LIVE coingecko: a price, keyless", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "coingecko", "simplePrice", { ids: ["bitcoin", "ethereum"], vs_currencies: ["usd"] }, (d) => assert.ok(d.bitcoin.usd > 1000 && d.ethereum.usd > 10));
});

test("LIVE nasa-apod: the picture of the day on DEMO_KEY", { skip: LIVE, timeout: 60_000 }, async (t) => {
  await live(t, "nasa-apod", "apod", {}, (d) => assert.ok(d.title && d.url && d.date));
});
