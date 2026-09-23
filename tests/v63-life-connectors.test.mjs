// Home, car, travel, health and money — the "life" connectors.
//
// Parity with the consumer assistants: Hue lights paired over the LAN, a
// Tesla through Tessie, Ticketmaster, FlightAware, Duffel, Withings,
// Tailscale and bank balances through SimpleFIN. These tests pin what each
// tool actually sends (every service is stubbed at globalThis.fetch), that
// anything risky asks the owner AND classifies so the phone/unattended gate
// holds it, the zero-field Hue pairing form, the SimpleFIN one-shot claim, and
// the Withings OAuth quirks.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONNECT_SERVICES,
  MCP_CATALOG,
  resolveConnectService,
  isServiceConnected,
  getCredential,
  setCredential,
  deleteCredential,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  WITHINGS_OAUTH,
  OAUTH_PROVIDERS,
} from "../packages/core/dist/index.js";
import {
  HueTool,
  TeslaTool,
  TicketsTool,
  FlightStatusTool,
  FlightBookingTool,
  WithingsTool,
  TailscaleTool,
  BankTool,
  clearBankCache,
  hexToXy,
  hueStateBody,
  simplefinClaimUrl,
  relevantFlight,
  DEFAULT_TOOLS,
} from "../packages/tools/dist/index.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import { classifyToolRequest, remoteAutonomyDecision, gateToolPermission } from "../packages/cli/dist/policyGate.js";
import { toolDoctrineFor } from "../packages/cli/dist/entry/prompt/index.js";
import { CORE_TOOL_NAMES } from "../packages/core/dist/queryEngine.js";

// bypass: the tool's OWN asks must hold even when the session auto-allows.
const ctx = () => ({ signal: new AbortController().signal, permissionMode: "bypass" });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route every non-loopback fetch to `handler`, recording what was sent. */
function stubFetch(t, handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    if (url.startsWith("http://127.0.0.1")) return real(input, init);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, method: init.method ?? "GET", headers, body: init.body, redirect: init.redirect };
    calls.push(call);
    return handler(call, calls);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

function withEnv(t, vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-life-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

async function serve(t, hub) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    void hub.handle(req, res, url).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const localPath = (url) => new URL(url).pathname;

// ── registry ────────────────────────────────────────────────────────────────

test("what the owner says resolves to the life connectors", () => {
  const cases = {
    "philips hue": ["hue", "api-key"],
    "turn off the lights": ["hue", "api-key"],
    tesla: ["tessie", "api-key"],
    ticketmaster: ["ticketmaster", "api-key"],
    "flight status": ["flightaware", "api-key"],
    "book a flight": ["duffel", "api-key"],
    withings: ["withings", "oauth-app"],
    tailscale: ["tailscale", "api-key"],
    "bank balance": ["plaid", "api-key"],
    simplefin: ["simplefin", "api-key"],
    peloton: ["peloton", "browser"],
    granola: ["granola", "mcp-oauth"],
    printify: ["printify", "mcp-oauth"],
  };
  for (const [asked, [id, kind]] of Object.entries(cases)) {
    const service = resolveConnectService(asked);
    assert.ok(service, `"${asked}" resolved to nothing`);
    assert.equal(service.id, id, `"${asked}"`);
    assert.equal(service.kind, kind, `"${asked}"`);
  }
  assert.equal(resolveConnectService("peloton").domain, "onepeloton.com");
  assert.equal(resolveConnectService("withings").oauthProvider, "withings");
  assert.ok(OAUTH_PROVIDERS.withings, "the Withings provider is registered");
  for (const id of ["hue", "tessie", "ticketmaster", "flightaware", "duffel", "tailscale", "simplefin", "withings"]) {
    const s = CONNECT_SERVICES.find((x) => x.id === id);
    assert.ok(s.domain && s.blurb && s.keywords.length, `${id} carries domain, blurb and keywords for its card`);
  }
  assert.match(resolveConnectService("flightaware").blurb, /bill|meter/i, "AeroAPI's cost is on the card");
  assert.match(resolveConnectService("simplefin").blurb, /Plaid/, "the Plaid vs SimpleFIN choice is explained");
});

test("catalog URLs that moved are fixed", () => {
  const url = (id) => MCP_CATALOG.find((e) => e.id === id).url;
  assert.equal(url("calendly"), "https://mcp.calendly.com");
  assert.equal(url("granola"), "https://mcp.granola.ai/mcp");
  assert.equal(url("printify"), "https://mcp.printify.com/mcp");
  assert.equal(url("perplexity"), "https://api.perplexity.ai/mcp");
  for (const id of ["cloudflare-docs", "cloudflare-bindings", "cloudflare-observability"]) assert.doesNotMatch(url(id), /\/sse$/, `${id}: the /sse endpoint answers 410 Gone`);
  assert.equal(MCP_CATALOG.find((e) => e.id === "semgrep").auth, "oauth", "Semgrep now requires sign-in");
});

test("a service connected through `stores` is judged by what was stored, not the form", async (t) => {
  const home = await tempHome(t);
  const hue = resolveConnectService("hue");
  assert.deepEqual(hue.fields, []);
  assert.equal(await isServiceConnected(hue, home), false, "zero fields is not 'connected'");
  await setCredential("HUE_BRIDGE_IP", "192.168.1.50", { home });
  assert.equal(await isServiceConnected(hue, home), false);
  await setCredential("HUE_USERNAME", "user-1", { home });
  assert.equal(await isServiceConnected(hue, home), true);
});

test("the new tools are deferred, and the doctrine names them", () => {
  const names = DEFAULT_TOOLS.map((tool) => tool.schema.name);
  for (const name of ["Hue", "Tesla", "Tickets", "FlightStatus", "FlightBooking", "Withings", "Tailscale", "Bank"]) {
    assert.ok(names.includes(name), `${name} is registered`);
    assert.ok(!CORE_TOOL_NAMES.includes(name), `${name} is deferred, not core`);
  }
  assert.match(toolDoctrineFor(["Connect"]), /Hue.*Tesla.*Bank/s);
});

// ── Hue: zero-field pairing ─────────────────────────────────────────────────

function fakeBridge({ pressAfter = 1 } = {}) {
  let posts = 0;
  return (call) => {
    if (call.url === "https://discovery.meethue.com/") return json([{ id: "001788fffe0a1b2c", internalipaddress: "192.168.1.50", port: 443 }]);
    if (call.url === "http://192.168.1.50/api/0/config") return json({ name: "Hue Bridge", bridgeid: "001788FFFE0A1B2C", modelid: "BSB002" });
    if (call.url === "http://192.168.1.50/api" && call.method === "POST") {
      posts += 1;
      assert.deepEqual(JSON.parse(call.body), { devicetype: "ares#doingbox" });
      if (posts <= pressAfter) return json([{ error: { type: 101, address: "", description: "link button not pressed" } }]);
      return json([{ success: { username: "hue-user-xyz" } }]);
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
}

test("Hue pairs from a form with no fields: press the button, tap Connect, the bridge's username is stored", async (t) => {
  const home = await tempHome(t);
  stubFetch(t, fakeBridge({ pressAfter: 1 }));
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("hue"));
  assert.match(prompt.instructions, /Press the round button/);
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 30_000 });

  const form = await (await fetch(base + localPath(prompt.url))).text();
  assert.match(form, /Press the round button on top of your Hue bridge/);
  assert.doesNotMatch(form, /<input/, "nothing to type");

  const res = await fetch(base + localPath(prompt.url), { method: "POST", body: "" });
  assert.equal(res.status, 200);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /Paired with Hue bridge 001788fffe0a1b2c at 192\.168\.1\.50/);
  assert.equal(await getCredential("HUE_BRIDGE_IP", { home }), "192.168.1.50");
  assert.equal(await getCredential("HUE_USERNAME", { home }), "hue-user-xyz");
  assert.equal(await getCredential("HUE_BRIDGE_ID", { home }), "001788fffe0a1b2c");
  assert.equal(await isServiceConnected(resolveConnectService("hue"), home), true);
});

test("Hue pairing without the button press says so and stores nothing", async (t) => {
  const home = await tempHome(t);
  withEnv(t, { ARES_HUE_PAIR_WINDOW_MS: "0" });
  stubFetch(t, fakeBridge({ pressAfter: 99 }));
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("hue"));
  const res = await fetch(base + localPath(prompt.url), { method: "POST", body: "" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /link button/);
  assert.equal(await getCredential("HUE_USERNAME", { home }), undefined);
});

test("Hue turns a room on at a brightness and colour; hex becomes CIE xy", async (t) => {
  withEnv(t, { HUE_BRIDGE_IP: "192.168.1.50", HUE_USERNAME: "u1" });
  const calls = stubFetch(t, (call) => {
    if (call.url === "http://192.168.1.50/api/u1/groups") return json({ 1: { name: "Living room", type: "Room", lights: ["1", "2"], state: { any_on: false } }, 2: { name: "Entertainment", type: "Entertainment", lights: [] } });
    if (call.url === "http://192.168.1.50/api/u1/groups/1/action") return json([{ success: {} }]);
    throw new Error(`unexpected ${call.url}`);
  });
  const result = await HueTool.call(HueTool.inputZod.parse({ action: "set", target: "living room", brightness: 50, color: "red" }), ctx());
  assert.equal(result.failure, undefined, result.output.message);
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.url, "http://192.168.1.50/api/u1/groups/1/action");
  assert.deepEqual(JSON.parse(put.body), { on: true, bri: 127, xy: [0.7006, 0.2993] });
  assert.deepEqual(hexToXy("#000000"), [0.3227, 0.329]);
  assert.equal(hexToXy("not a colour"), null);
  assert.deepEqual(hueStateBody({ brightness: 0 }), { on: false });
  assert.ok("error" in hueStateBody({}));
});

test("Hue without a paired bridge points at Connect", async () => {
  const result = await HueTool.call(HueTool.inputZod.parse({ action: "lights" }), ctx());
  assert.ok(result.failure);
  assert.match(result.output.message, /Connect with service "hue"/);
});

// ── Tesla (Tessie) ──────────────────────────────────────────────────────────

test("Tesla commands go to Tessie with the token; unlock and friends ask, lock and climate don't", async (t) => {
  withEnv(t, { TESSIE_API_TOKEN: "tess-tok" });
  const calls = stubFetch(t, (call) => {
    if (call.url === "https://api.tessie.com/vehicles?only_active=true") return json({ results: [{ vin: "5YJ3E1EA7KF000001", last_state: { display_name: "Blue" } }] });
    if (call.url.startsWith("https://api.tessie.com/5YJ3E1EA7KF000001/command/")) return json({ result: true });
    throw new Error(`unexpected ${call.url}`);
  });
  const lock = await TeslaTool.call(TeslaTool.inputZod.parse({ action: "lock" }), ctx());
  assert.equal(lock.failure, undefined, lock.output.message);
  const sent = calls.at(-1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "https://api.tessie.com/5YJ3E1EA7KF000001/command/lock?wait_for_completion=true");
  assert.equal(sent.headers.authorization, "Bearer tess-tok");

  await TeslaTool.call(TeslaTool.inputZod.parse({ action: "charge_limit", vin: "5yj3e1ea7kf000001", percent: 80 }), ctx());
  assert.equal(calls.at(-1).url, "https://api.tessie.com/5YJ3E1EA7KF000001/command/set_charge_limit?wait_for_completion=true&percent=80");
  await TeslaTool.call(TeslaTool.inputZod.parse({ action: "trunk", vin: "5YJ3E1EA7KF000001" }), ctx());
  assert.match(calls.at(-1).url, /\/command\/activate_rear_trunk\?/);

  for (const action of ["unlock", "remote_start", "trunk", "frunk", "honk", "flash"]) {
    const decision = await TeslaTool.checkPermissions(TeslaTool.inputZod.parse({ action }), ctx());
    assert.equal(decision.kind, "ask", action);
    assert.equal(classifyToolRequest({ toolName: "Tesla", input: { action }, reason: "" }), "browser_submit", action);
    assert.equal(remoteAutonomyDecision({ toolName: "Tesla", input: { action }, reason: "" }), "ask", action);
    assert.equal(gateToolPermission({ toolName: "Tesla", input: { action }, reason: "" }, { attended: false }).kind, "deny", `${action} never runs unattended`);
  }
  for (const action of ["lock", "climate_on", "charge_start", "state"]) {
    assert.equal((await TeslaTool.checkPermissions(TeslaTool.inputZod.parse({ action }), ctx())).kind, "allow", action);
    assert.equal(classifyToolRequest({ toolName: "Tesla", input: { action }, reason: "" }), null, action);
  }
});

// ── Ticketmaster ────────────────────────────────────────────────────────────

test("Tickets searches Discovery by keyword, city and dates, and says it can't buy", async (t) => {
  withEnv(t, { TICKETMASTER_API_KEY: "tm-key" });
  const calls = stubFetch(t, () =>
    json({ _embedded: { events: [{ id: "G5v", name: "Phish", url: "https://www.ticketmaster.com/event/G5v", dates: { start: { localDate: "2026-10-03", localTime: "19:30:00" } }, _embedded: { venues: [{ name: "MSG", city: { name: "New York" } }] }, priceRanges: [{ min: 55, max: 150, currency: "USD" }] }] } }),
  );
  const result = await TicketsTool.call(TicketsTool.inputZod.parse({ action: "search", keyword: "phish", city: "New York", start_date: "2026-10-01", end_date: "2026-10-31" }), ctx());
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://app.ticketmaster.com/discovery/v2/events.json");
  assert.equal(url.searchParams.get("apikey"), "tm-key");
  assert.equal(url.searchParams.get("keyword"), "phish");
  assert.equal(url.searchParams.get("city"), "New York");
  assert.equal(url.searchParams.get("startDateTime"), "2026-10-01T00:00:00Z");
  assert.equal(url.searchParams.get("endDateTime"), "2026-10-31T23:59:59Z");
  assert.equal(result.output.events[0].venue, "MSG");
  assert.match(result.output.message, /can't buy/);
  assert.equal(classifyToolRequest({ toolName: "Tickets", input: { action: "search" }, reason: "" }), null);
});

// ── FlightAware ─────────────────────────────────────────────────────────────

test("FlightStatus sends the AeroAPI key as x-apikey and picks the flight in the air", async (t) => {
  withEnv(t, { FLIGHTAWARE_API_KEY: "fa-key" });
  const calls = stubFetch(t, (call) => {
    if (call.url.includes("/flights/UA123")) {
      return json({ flights: [
        { ident: "UAL123", ident_iata: "UA123", status: "Scheduled", scheduled_out: "2026-09-30T10:00:00Z", origin: { code_iata: "SFO" }, destination: { code_iata: "EWR" } },
        { ident: "UAL123", ident_iata: "UA123", status: "En Route / On Time", progress_percent: 40, scheduled_out: "2026-09-23T10:00:00Z", origin: { code_iata: "SFO" }, destination: { code_iata: "EWR" }, gate_origin: "F12" },
      ] });
    }
    return json({ arrivals: [{ ident_iata: "DL1", status: "Arrived", origin: { code_iata: "ATL" }, destination: { code_iata: "SFO" } }] });
  });
  const result = await FlightStatusTool.call(FlightStatusTool.inputZod.parse({ action: "flight", ident: "ua 123" }), ctx());
  assert.equal(calls[0].url, "https://aeroapi.flightaware.com/aeroapi/flights/UA123?max_pages=1");
  assert.equal(calls[0].headers["x-apikey"], "fa-key");
  assert.match(result.output.message, /UA123 SFO→EWR: En Route/);
  await FlightStatusTool.call(FlightStatusTool.inputZod.parse({ action: "arrivals", airport: "ksfo" }), ctx());
  assert.equal(calls[1].url, "https://aeroapi.flightaware.com/aeroapi/airports/KSFO/flights/arrivals?max_pages=1");
  const now = Date.parse("2026-09-23T12:00:00Z");
  assert.equal(relevantFlight([{ scheduled_out: "2026-09-20T10:00:00Z" }, { scheduled_out: "2026-09-25T10:00:00Z" }], now).scheduled_out, "2026-09-25T10:00:00Z", "next departure over a past one");
});

// ── Duffel ──────────────────────────────────────────────────────────────────

function duffelStub(t, prices) {
  let offerReads = 0;
  return stubFetch(t, (call) => {
    if (call.url.startsWith("https://api.duffel.com/air/offer_requests")) {
      return json({ data: { offers: [
        { id: "off_2", total_amount: "310.00", total_currency: "USD", owner: { name: "Delta" }, slices: [] },
        { id: "off_1", total_amount: "199.00", total_currency: "USD", owner: { name: "Duffel Airways" }, slices: [{ segments: [{ origin: { iata_code: "JFK" }, destination: { iata_code: "LHR" }, departing_at: "2026-11-02T18:00:00", marketing_carrier: { iata_code: "ZZ" }, marketing_carrier_flight_number: "101" }] }] },
      ] } }, 201);
    }
    if (call.url === "https://api.duffel.com/air/offers/off_1") {
      const price = prices[Math.min(offerReads++, prices.length - 1)];
      return json({ data: { id: "off_1", total_amount: price, total_currency: "USD", owner: { name: "Duffel Airways" }, passengers: [{ id: "pas_A" }], slices: [] } });
    }
    if (call.url === "https://api.duffel.com/air/orders") return json({ data: { id: "ord_1", booking_reference: "ABC123", total_amount: "199.00", total_currency: "USD" } }, 201);
    throw new Error(`unexpected ${call.url}`);
  });
}

const traveller = { given_name: "Crix", family_name: "Doe", born_on: "1990-01-01", gender: "m", title: "mr", email: "c@example.com", phone_number: "+14155550123" };

test("FlightBooking searches with Duffel-Version v2 and books only at the price the owner saw", async (t) => {
  withEnv(t, { DUFFEL_ACCESS_TOKEN: "duffel_test_abc" });
  const calls = duffelStub(t, ["199.00"]);
  const search = await FlightBookingTool.call(FlightBookingTool.inputZod.parse({ action: "search", slices: [{ origin: "jfk", destination: "lhr", departure_date: "2026-11-02" }], adults: 1, children_ages: [7], cabin_class: "economy" }), ctx());
  assert.equal(calls[0].headers["duffel-version"], "v2");
  assert.equal(calls[0].headers.authorization, "Bearer duffel_test_abc");
  assert.deepEqual(JSON.parse(calls[0].body), { data: { slices: [{ origin: "JFK", destination: "LHR", departure_date: "2026-11-02" }], passengers: [{ type: "adult" }, { age: 7 }], cabin_class: "economy" } });
  assert.equal(search.output.offers[0].id, "off_1", "cheapest first");
  assert.equal(search.output.mode, "test");
  assert.match(search.output.message, /TEST mode/);

  const book = FlightBookingTool.inputZod.parse({ action: "book", offer_id: "off_1", passengers: [traveller] });
  const refused = await FlightBookingTool.call(book, ctx());
  assert.ok(refused.failure, "no approval prompt seen → no purchase");
  assert.match(refused.output.message, /hasn't approved a price/);

  const ask = await FlightBookingTool.checkPermissions(book, ctx());
  assert.equal(ask.kind, "ask");
  assert.match(ask.prompt, /199\.00 USD/);
  assert.match(ask.prompt, /TEST mode/);
  const booked = await FlightBookingTool.call(book, ctx());
  assert.equal(booked.failure, undefined, booked.output.message);
  const order = JSON.parse(calls.find((c) => c.url === "https://api.duffel.com/air/orders").body);
  assert.deepEqual(order.data.payments, [{ type: "balance", amount: "199.00", currency: "USD" }]);
  assert.equal(order.data.passengers[0].id, "pas_A", "the offer's passenger id is attached");
  assert.equal(order.data.type, "instant");
  assert.match(booked.output.message, /ABC123/);

  assert.equal(classifyToolRequest({ toolName: "FlightBooking", input: { action: "book" }, reason: "" }), "payment_or_purchase");
  assert.equal(classifyToolRequest({ toolName: "FlightBooking", input: { action: "search" }, reason: "" }), null);
  assert.equal(gateToolPermission({ toolName: "FlightBooking", input: { action: "book" }, reason: "" }, { attended: false }).kind, "deny");
});

test("FlightBooking stops when Duffel re-prices between the approval and the order", async (t) => {
  withEnv(t, { DUFFEL_ACCESS_TOKEN: "duffel_live_xyz" });
  const calls = duffelStub(t, ["199.00", "240.00"]);
  const book = FlightBookingTool.inputZod.parse({ action: "book", offer_id: "off_1", passengers: [traveller] });
  const ask = await FlightBookingTool.checkPermissions(book, ctx());
  assert.match(ask.prompt, /charged to your Duffel balance/);
  const result = await FlightBookingTool.call(book, ctx());
  assert.ok(result.failure);
  assert.match(result.output.message, /changed from 199\.00 USD to 240\.00 USD/);
  assert.ok(!calls.some((c) => c.url.endsWith("/air/orders")), "no order was placed");
});

// ── Tailscale ───────────────────────────────────────────────────────────────

test("Tailscale finds a device by name and authorizes it only after asking", async (t) => {
  withEnv(t, { TAILSCALE_API_KEY: "tskey-api-k" });
  const calls = stubFetch(t, (call) => {
    if (call.url === "https://api.tailscale.com/api/v2/tailnet/-/devices") return json({ devices: [{ nodeId: "nX1", name: "laptop.tail1234.ts.net", hostname: "laptop", os: "macOS", authorized: false, addresses: ["100.64.0.2"] }] });
    if (call.url === "https://api.tailscale.com/api/v2/device/nX1/authorized") return json({});
    throw new Error(`unexpected ${call.url}`);
  });
  const input = TailscaleTool.inputZod.parse({ action: "authorize", device: "laptop" });
  assert.equal((await TailscaleTool.checkPermissions(input, ctx())).kind, "ask");
  const result = await TailscaleTool.call(input, ctx());
  assert.equal(result.failure, undefined, result.output.message);
  const post = calls.at(-1);
  assert.equal(post.method, "POST");
  assert.deepEqual(JSON.parse(post.body), { authorized: true });
  assert.equal(post.headers.authorization, "Bearer tskey-api-k");
  assert.equal(classifyToolRequest({ toolName: "Tailscale", input: { action: "expire" }, reason: "" }), "credential_or_secret");
  assert.equal(classifyToolRequest({ toolName: "Tailscale", input: { action: "devices" }, reason: "" }), null);
});

// ── SimpleFIN ───────────────────────────────────────────────────────────────

const CLAIM = "https://bridge.example.org/simplefin/claim/TOKEN123";
const SETUP = Buffer.from(CLAIM).toString("base64");
const ACCESS = "https://user9:pa%24s@bridge.example.org/simplefin";

function simplefinStub(t, { claimStatus = 200 } = {}) {
  return stubFetch(t, (call) => {
    if (call.url === CLAIM) {
      assert.equal(call.method, "POST");
      assert.equal(call.redirect, "manual", "a redirected claim must not be followed as a GET");
      return new Response(claimStatus === 200 ? ACCESS : "Forbidden", { status: claimStatus });
    }
    if (call.url.startsWith("https://bridge.example.org/simplefin/accounts?")) {
      assert.equal(call.headers.authorization, `Basic ${Buffer.from("user9:pa$s").toString("base64")}`);
      return json({
        errlist: [{ code: "con.auth", msg: "Reconnect <b>My Bank</b>" }],
        connections: [{ conn_id: "C1", org_name: "My Bank" }],
        accounts: [{ id: "A1", name: "Checking", conn_id: "C1", currency: "USD", balance: "1200.50", "available-balance": "1100.50", "balance-date": 1790208000, transactions: [{ id: "t1", posted: Math.floor(Date.now() / 1000) - 86_400, amount: "-42.10", description: "Grocer" }] }],
      });
    }
    throw new Error(`unexpected ${call.url}`);
  });
}

test("SimpleFIN: the hub claims the Setup Token and stores only the Access URL", async (t) => {
  const home = await tempHome(t);
  const calls = simplefinStub(t);
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("simplefin"));
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  const res = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ SIMPLEFIN_SETUP_TOKEN: SETUP }) });
  assert.equal(res.status, 200);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /1 account/);
  assert.equal(await getCredential("SIMPLEFIN_ACCESS_URL", { home }), ACCESS);
  assert.equal(await getCredential("SIMPLEFIN_SETUP_TOKEN", { home }), undefined, "the spent token is never stored");
  assert.equal(await isServiceConnected(resolveConnectService("simplefin"), home), true);
  assert.ok(calls.some((c) => c.url.includes("balances-only=1")));
});

test("SimpleFIN: an already-claimed token warns it may be compromised", async (t) => {
  const home = await tempHome(t);
  simplefinStub(t, { claimStatus: 403 });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("simplefin"));
  const res = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ SIMPLEFIN_SETUP_TOKEN: SETUP }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already claimed[\s\S]*disable it/);
  assert.equal(await getCredential("SIMPLEFIN_ACCESS_URL", { home }), undefined);
  assert.throws(() => simplefinClaimUrl(Buffer.from("http://insecure.example/claim").toString("base64")), /https/);
  assert.throws(() => simplefinClaimUrl("not base64 at all!!"), /Setup Token/);
});

test("Bank reads balances and transactions read-only, sanitizing bank messages", async (t) => {
  withEnv(t, { SIMPLEFIN_ACCESS_URL: ACCESS, ARES_BANK_CACHE_MS: "0" });
  clearBankCache();
  t.after(() => fsp.rm(path.join(process.env.ARES_HOME, "bank"), { recursive: true, force: true }));
  const calls = simplefinStub(t);
  const accounts = await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.equal(accounts.failure, undefined, accounts.output.message);
  // The normalized record (bankAnalytics.ts), the same shape Plaid produces.
  assert.deepEqual(accounts.output.accounts[0], { id: "A1", provider: "simplefin", name: "Checking", institution: "My Bank", currency: "USD", balance: 1200.5, available: 1100.5 });
  assert.deepEqual(accounts.output.warnings, ["Reconnect My Bank"], "markup stripped from bank errors");
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get("version"), "2");
  assert.equal(q.get("pending"), "1", "one request carries balances AND the 90-day window, then is cached");
  assert.ok(!calls[0].url.includes("user9"), "credentials never ride in the URL");

  const tx = await BankTool.call(BankTool.inputZod.parse({ action: "transactions", days: 90 }), ctx());
  assert.equal(tx.output.transactions[0].amount, -42.1);
  assert.equal(tx.output.transactions[0].accountId, "A1");
  assert.equal(classifyToolRequest({ toolName: "Bank", input: { action: "transactions" }, reason: "" }), null);
});

// ── Withings ────────────────────────────────────────────────────────────────

test("Withings OAuth: comma scopes, action=requesttoken on every token call, the {status, body} envelope", async () => {
  const authorize = new URL(buildAuthorizeUrl(WITHINGS_OAUTH, { clientId: "cid", redirectUri: "https://ares.test/oauth/callback", state: "s" }));
  assert.equal(authorize.origin + authorize.pathname, "https://account.withings.com/oauth2_user/authorize2");
  assert.equal(authorize.searchParams.get("scope"), "user.info,user.metrics,user.activity");

  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return json({ status: 0, body: { userid: 42, access_token: "at-1", refresh_token: "rt-1", expires_in: 10800, scope: "user.metrics", token_type: "Bearer" } });
  };
  const tokens = await exchangeCodeForTokens(WITHINGS_OAUTH, { code: "c0de", clientId: "cid", clientSecret: "sec", redirectUri: "https://ares.test/oauth/callback" }, { fetchImpl, now: () => 1_000 });
  assert.equal(sent[0].url, "https://wbsapi.withings.net/v2/oauth2");
  assert.equal(sent[0].form.action, "requesttoken");
  assert.equal(sent[0].form.grant_type, "authorization_code");
  assert.equal(sent[0].form.code, "c0de");
  assert.equal(tokens.accessToken, "at-1");
  assert.equal(tokens.refreshToken, "rt-1");
  assert.equal(tokens.expiresAt, 1_000 + 10_800_000);

  await refreshTokens(WITHINGS_OAUTH, { refreshToken: "rt-1", clientId: "cid", clientSecret: "sec" }, { fetchImpl });
  assert.equal(sent[1].form.action, "requesttoken", "the refresh carries the action too");
  assert.equal(sent[1].form.grant_type, "refresh_token");

  const failing = async () => json({ status: 503, error: "Invalid Params: invalid code" });
  await assert.rejects(() => exchangeCodeForTokens(WITHINGS_OAUTH, { code: "x", clientId: "cid", clientSecret: "sec", redirectUri: "r" }, { fetchImpl: failing }), /invalid code/, "a 200 with a non-zero status is an error, not an empty token");

  // Other providers are untouched: space-separated scopes, no extra params.
  assert.match(buildAuthorizeUrl(OAUTH_PROVIDERS.spotify, { clientId: "c", redirectUri: "r", state: "s" }), /scope=user-read-playback-state\+/);
});

test("Withings measurements decode value × 10^unit from getmeas", async (t) => {
  const home = process.env.ARES_HOME;
  await setCredential("oauth/withings", JSON.stringify({ accessToken: "at-9", expiresAt: Date.now() + 3_600_000 }), { home });
  t.after(() => deleteCredential("oauth/withings", { home }));
  const calls = stubFetch(t, () => json({ status: 0, body: { measuregrps: [{ date: 1790200000, measures: [{ value: 7215, type: 1, unit: -2 }, { value: 182, type: 6, unit: -1 }] }] } }));
  const result = await WithingsTool.call(WithingsTool.inputZod.parse({ action: "measurements", days: 7 }), ctx());
  assert.equal(result.failure, undefined, result.output.message);
  assert.equal(calls[0].url, "https://wbsapi.withings.net/measure");
  assert.equal(calls[0].headers.authorization, "Bearer at-9");
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get("action"), "getmeas");
  assert.equal(form.get("category"), "1");
  assert.equal(result.output.measurements[0].weight, 72.15);
  assert.equal(result.output.measurements[0].fat_ratio, 18.2);
  assert.match(result.output.message, /Latest weight 72\.15 kg, fat 18\.2%/);
});

// ── every life tool without its connection points at Connect ────────────────

test("each life tool, unconnected, names the Connect service to call", async () => {
  const cases = [
    [TeslaTool, { action: "state" }, "tessie"],
    [TicketsTool, { action: "search" }, "ticketmaster"],
    [FlightStatusTool, { action: "flight", ident: "UA1" }, "flightaware"],
    [FlightBookingTool, { action: "search" }, "duffel"],
    [TailscaleTool, { action: "devices" }, "tailscale"],
    [BankTool, { action: "accounts" }, "simplefin"],
  ];
  for (const [tool, input, service] of cases) {
    const result = await tool.call(tool.inputZod.parse(input), ctx());
    assert.ok(result.failure, tool.schema.name);
    assert.match(result.output.message, new RegExp(`Connect with service "${service}"`), tool.schema.name);
  }
  const withings = await WithingsTool.call(WithingsTool.inputZod.parse({ action: "sleep" }), ctx());
  assert.ok(withings.failure);
  assert.match(withings.output.message, /service "withings"/);
});
