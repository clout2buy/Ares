// "Check my email" → a one-tap Connect card, whatever the service.
//
// Before: the Connect tool could list providers but never START a connection,
// was hidden behind ToolSearch, and the phone's "Connect" button asked the
// model to do what the tool couldn't. MCP OAuth only redirected to localhost;
// Twilio and DoorDash had no path at all. These tests pin the new contract:
// one registry resolves what the owner means, the Connect tool shows a card
// and waits for the owner, and the hub turns each kind of service into one
// link the phone can actually finish.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONNECT_SERVICES,
  resolveConnectService,
  isServiceConnected,
  setConnectBroker,
  getCredential,
  setCredential,
  browserSessionFile,
} from "../packages/core/dist/index.js";
import { ConnectTool, PhoneTool } from "../packages/tools/dist/index.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import { classifyToolRequest, mcpMoneyCategory, remoteAutonomyDecision } from "../packages/cli/dist/policyGate.js";
import { connectProgressOf } from "../packages/channels/dist/telegram/bridge.js";
import { savedSessionLoader } from "../packages/connectors/dist/index.js";
import { CORE_TOOL_NAMES } from "../packages/core/dist/queryEngine.js";

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-connect-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

// ── the registry ────────────────────────────────────────────────────────────

test("what the owner says resolves to the right kind of connection", () => {
  const cases = {
    gmail: ["google", "oauth-app"],
    "check my email": ["google", "oauth-app"],
    stripe: ["stripe", "mcp-oauth"],
    supabase: ["supabase", "mcp-oauth"],
    vercel: ["vercel", "mcp-oauth"],
    "a phone number": ["twilio", "api-key"],
    twilio: ["twilio", "api-key"],
    doordash: ["doordash", "browser"],
    "order me doordash": ["doordash", "browser"],
    "chipotle.com": ["site:chipotle.com", "browser"],
    "https://www.example.org/login": ["site:example.org", "browser"],
  };
  for (const [asked, [id, kind]] of Object.entries(cases)) {
    const service = resolveConnectService(asked);
    assert.ok(service, `"${asked}" resolved to nothing`);
    assert.equal(service.id, id, `"${asked}"`);
    assert.equal(service.kind, kind, `"${asked}"`);
  }
  assert.equal(resolveConnectService("   "), null);
  assert.equal(resolveConnectService("definitely not a thing"), null);
});

test("every service carries what its connect kind needs", () => {
  const ids = new Set();
  for (const s of CONNECT_SERVICES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.howToUse, `${s.id} tells the agent nothing after connecting`);
    if (s.kind === "mcp-oauth" || s.kind === "mcp-key") assert.match(s.mcpUrl, /^https:\/\//, s.id);
    // A zero-field form is only honest when a verifier makes what gets stored (Hue pairing).
    if (s.kind === "mcp-key" || s.kind === "api-key") assert.ok(s.fields?.length || (s.stores?.length && s.formHint), `${s.id} has no form fields`);
    if (s.kind === "oauth-app") assert.ok(s.oauthProvider && s.appSetup, s.id);
    if (s.kind === "browser") assert.match(s.loginUrl, /^https:\/\//, s.id);
  }
});

// ── the Connect tool ────────────────────────────────────────────────────────

function fakeBroker(outcome) {
  const calls = { started: [], waited: [] };
  return {
    calls,
    async start(service, opts) {
      calls.started.push({ id: service.id, reason: opts?.reason });
      return { flowId: "flow-1", service: service.id, label: service.label, kind: service.kind, url: "https://ares.test/connect/flow-1", instructions: "tap it" };
    },
    async wait(flowId, opts) {
      calls.waited.push({ flowId, timeoutMs: opts.timeoutMs });
      return outcome;
    },
  };
}

test("connect shows a card, waits for the owner, then says how to use it", async (t) => {
  const broker = fakeBroker({ ok: true, detail: "12 tools available." });
  setConnectBroker(broker);
  t.after(() => setConnectBroker(null));
  const progress = [];
  const result = await ConnectTool.call(
    { action: "connect", service: "doordash", reason: "to order dinner" },
    { signal: new AbortController().signal, emitProgress: (d) => progress.push(d) },
  );
  assert.equal(broker.calls.started[0].id, "doordash");
  assert.equal(broker.calls.started[0].reason, "to order dinner");
  assert.equal(progress[0].kind, "connect_request", "the card goes out BEFORE the wait");
  assert.equal(progress[0].url, "https://ares.test/connect/flow-1");
  assert.equal(progress.at(-1).kind, "connect_result");
  assert.equal(progress.at(-1).ok, true);
  assert.equal(result.failure, undefined);
  assert.match(result.output.message, /DoorDash is connected/);
  assert.match(result.output.message, /Browser tool/, "the agent is told how to use it");
  assert.match(result.output.message, /original request/);
});

test("a connect the owner didn't finish is a failure the agent reports, not works around", async (t) => {
  setConnectBroker(fakeBroker({ ok: false, detail: "You declined." }));
  t.after(() => setConnectBroker(null));
  const result = await ConnectTool.call({ action: "connect", service: "stripe" }, { signal: new AbortController().signal });
  assert.ok(result.failure);
  assert.match(result.output.message, /not connected: You declined/);
});

test("without a garrison there is no card to show, and the tool says so", async () => {
  setConnectBroker(null);
  const result = await ConnectTool.call({ action: "connect", service: "vercel" }, { signal: new AbortController().signal });
  assert.ok(result.failure);
  assert.match(result.output.message, /no public address/);
});

test("an unknown service is refused with a way forward", async () => {
  const result = await ConnectTool.call({ action: "connect", service: "zzzz nothing" }, { signal: new AbortController().signal });
  assert.ok(result.failure);
  assert.match(result.output.message, /services/);
});

test("Connect is a core tool — the model sees it without searching", () => {
  assert.ok(CORE_TOOL_NAMES.includes("Connect"));
});

// ── the hub ─────────────────────────────────────────────────────────────────

async function serve(t, hub) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname === "/oauth/callback" ? hub.handleCallback(req, res, url) : hub.handle(req, res, url);
    void route.then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end("not ours");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const localPath = (url) => new URL(url).pathname;

test("a key service: secure form → verified → stored → the waiting agent is released", async (t) => {
  const home = await tempHome(t);
  const seen = [];
  const hub = new ConnectHub({
    publicUrl: () => "https://ares.test",
    home,
    verifiers: {
      async twilio(values) {
        seen.push(values);
        if (values.TWILIO_AUTH_TOKEN !== "good") throw new Error("the SID and token don't match");
        return "Twilio account \"Ares\".";
      },
    },
  });
  const base = await serve(t, hub);
  const twilio = resolveConnectService("twilio");
  const prompt = await hub.start(twilio, { reason: "to get a phone number" });
  assert.equal(prompt.kind, "api-key");
  assert.match(prompt.url, /^https:\/\/ares\.test\/connect\/[A-Za-z0-9_-]{30,}$/);
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 5_000 });

  const form = await fetch(base + localPath(prompt.url));
  assert.equal(form.status, 200);
  assert.equal(form.headers.get("cache-control"), "no-store");
  const html = await form.text();
  assert.match(html, /name="TWILIO_ACCOUNT_SID"/);
  assert.match(html, /type="password"/, "the token field is masked");
  assert.match(html, /to get a phone number/);

  const sid = "AC" + "0".repeat(32);
  const bad = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "nope" }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /don&#39;t match|don't match/);
  assert.equal(await getCredential("TWILIO_AUTH_TOKEN", { home }), undefined, "a rejected key is never stored");

  const good = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "good" }) });
  assert.equal(good.status, 200);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /Twilio account/);
  assert.equal(await getCredential("TWILIO_AUTH_TOKEN", { home }), "good");
  assert.equal(await isServiceConnected(twilio, home), true);
});

test("Google's first connect walks the owner through registering the app, then goes straight to consent", async (t) => {
  const home = await tempHome(t);
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("gmail"));
  assert.match(prompt.instructions, /One-time setup/);
  const setup = await (await fetch(base + localPath(prompt.url))).text();
  assert.match(setup, /https:\/\/ares\.test\/oauth\/callback/, "the redirect URI to register is shown");
  assert.match(setup, /Publish app/, "the 7-day testing-mode trap is called out");

  const res = await fetch(base + localPath(prompt.url), {
    method: "POST",
    body: new URLSearchParams({ client_id: "cid-1", client_secret: "sec-1" }),
    redirect: "manual",
  });
  assert.equal(res.status, 303);
  const consent = new URL(res.headers.get("location"));
  assert.equal(consent.origin, "https://accounts.google.com");
  assert.equal(consent.searchParams.get("client_id"), "cid-1");
  assert.equal(consent.searchParams.get("redirect_uri"), "https://ares.test/oauth/callback");
  assert.ok(consent.searchParams.get("state").length >= 64);
  assert.equal(await getCredential("GOOGLE_OAUTH_CLIENT_SECRET", { home }), "sec-1");

  // Next time the app exists: the link goes straight to consent.
  const again = await hub.start(resolveConnectService("gmail"));
  const hop = await fetch(base + localPath(again.url), { redirect: "manual" });
  assert.equal(hop.status, 302);
  assert.match(hop.headers.get("location"), /^https:\/\/accounts\.google\.com\//);
});

test("a denied consent releases the agent with the reason; a foreign state is left for the legacy flow", async (t) => {
  const home = await tempHome(t);
  await setCredential("GOOGLE_OAUTH_CLIENT_ID", "cid", { home });
  await setCredential("GOOGLE_OAUTH_CLIENT_SECRET", "sec", { home });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("google"));
  const hop = await fetch(base + localPath(prompt.url), { redirect: "manual" });
  const state = new URL(hop.headers.get("location")).searchParams.get("state");
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 5_000 });

  const foreign = await fetch(`${base}/oauth/callback?state=someone-elses&code=x`);
  assert.equal(foreign.status, 404, "not ours → handed on, never exchanged");

  const denied = await fetch(`${base}/oauth/callback?state=${state}&error=access_denied`);
  assert.equal(denied.status, 400);
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /declined/);

  const replay = await fetch(`${base}/oauth/callback?state=${state}&code=x`);
  assert.equal(replay.status, 404, "a state is single-use");
});

test("unknown flows, stopped turns and timeouts all settle", async (t) => {
  const home = await tempHome(t);
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const missing = await fetch(`${base}/connect/${"x".repeat(32)}`);
  assert.equal(missing.status, 404);

  const prompt = await hub.start(resolveConnectService("twilio"));
  const stop = new AbortController();
  const waiting = hub.wait(prompt.flowId, { signal: stop.signal, timeoutMs: 60_000 });
  stop.abort();
  assert.match((await waiting).detail, /stopped/);

  const slow = await hub.start(resolveConnectService("twilio"));
  const timedOut = await hub.wait(slow.flowId, { signal: new AbortController().signal, timeoutMs: 30 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.detail, /didn't finish/);

  const noOrigin = new ConnectHub({ publicUrl: () => undefined, home });
  await assert.rejects(() => noOrigin.start(resolveConnectService("twilio")), /public address/);
});

test("a browser sign-in: the owner drives a live page, Done saves the session for every Ares browser", async (t) => {
  const home = await tempHome(t);
  const actions = [];
  let cookies = [];
  const fakePage = {
    context: () => ({
      addCookies: async (c) => { cookies.push(...c); },
      storageState: async () => ({ cookies: [{ name: "dd_session", value: "abc", domain: ".doordash.com", path: "/" }], origins: [] }),
    }),
    goto: async (url) => { actions.push(["goto", url]); },
    url: () => "https://www.doordash.com/consumer/login/",
    title: async () => "Sign In",
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    mouse: { click: async (x, y) => actions.push(["click", Math.round(x), Math.round(y)]), wheel: async (_x, dy) => actions.push(["wheel", dy]) },
    keyboard: { type: async (text) => actions.push(["type", text]), press: async (key) => actions.push(["press", key]) },
    goBack: async () => actions.push(["back"]),
    reload: async () => actions.push(["reload"]),
  };
  const fakePw = {
    chromium: {
      connectOverCDP: async () => { throw new Error("no cdp"); },
      launchPersistentContext: async () => ({ pages: () => [fakePage], newPage: async () => fakePage, close: async () => actions.push(["closed"]) }),
    },
  };
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, loadPlaywright: async () => fakePw });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("doordash"));
  const flowPath = localPath(prompt.url);
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 5_000 });

  const viewer = await (await fetch(base + flowPath)).text();
  assert.match(viewer, /Sign in to DoorDash/);
  assert.match(viewer, /\/frame/);

  const frame = await fetch(`${base}${flowPath}/frame`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("content-type"), "image/jpeg");
  assert.equal(decodeURIComponent(frame.headers.get("x-page-url")), "https://www.doordash.com/consumer/login/");
  assert.deepEqual(actions[0], ["goto", "https://www.doordash.com/consumer/login/"]);

  const post = (body) => fetch(`${base}${flowPath}/input`, { method: "POST", body: JSON.stringify(body) });
  await post({ type: "tap", x: 0.5, y: 0.25 });
  await post({ type: "type", text: "me@example.com" });
  await post({ type: "key", key: "Enter" });
  await post({ type: "key", key: "Control+W" });
  await post({ type: "scroll", dy: 400 });
  await post({ type: "goto", url: "javascript:alert(1)" });
  assert.deepEqual(actions.slice(1), [["click", 206, 215], ["type", "me@example.com"], ["press", "Enter"], ["wheel", 400]], "only whitelisted keys and https navigation");

  const done = await fetch(`${base}${flowPath}/done`, { method: "POST" });
  assert.equal(done.status, 200);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /session is saved/);
  const saved = JSON.parse(await fsp.readFile(browserSessionFile("doordash", home), "utf8"));
  assert.equal(saved.cookies[0].name, "dd_session");
  assert.equal((await fsp.stat(browserSessionFile("doordash", home))).mode & 0o077, 0, "session cookies are owner-only on disk");
  assert.equal(await isServiceConnected(resolveConnectService("doordash"), home), true);
  assert.ok(actions.some((a) => a[0] === "closed"), "the login browser is torn down");

  const after = await fetch(`${base}${flowPath}/frame`);
  assert.equal(after.status, 410, "a finished sign-in can't be driven again");
});

test("every browser Ares launches picks up saved sign-ins, and new ones on the next navigation", async (t) => {
  const dir = await tempHome(t);
  const added = [];
  const load = savedSessionLoader({ addCookies: async (c) => { added.push(...c); } }, dir);
  assert.equal(await load(), 0);
  await fsp.writeFile(path.join(dir, "doordash.json"), JSON.stringify({ cookies: [{ name: "a", value: "1", domain: ".doordash.com", path: "/" }] }));
  assert.equal(await load(), 1);
  assert.equal(await load(), 0, "an unchanged file is not re-applied");
  await fsp.writeFile(path.join(dir, "broken.json"), "{nope");
  assert.equal(await load(), 0, "a broken file is skipped, not fatal");
  assert.equal(added.length, 1);
});

// ── money and messages still need the owner ─────────────────────────────────

test("buying a number and money-moving MCP tools ask the owner, even on the phone", () => {
  const req = (toolName, input = {}) => ({ toolName, input, reason: "" });
  assert.equal(classifyToolRequest(req("Phone", { action: "buy_number" })), "payment_or_purchase");
  assert.equal(classifyToolRequest(req("Phone", { action: "release_number" })), "payment_or_purchase");
  assert.equal(classifyToolRequest(req("Phone", { action: "send_sms" })), "email_send");
  assert.equal(classifyToolRequest(req("Phone", { action: "search_numbers" })), null);
  assert.equal(remoteAutonomyDecision(req("Phone", { action: "buy_number" })), "ask");

  for (const name of ["mcp_stripe_create_refund", "mcp_stripe_create_payment_link", "mcp_paypal_create_invoice", "mcp_square_make_payment", "mcp_stripe_cancel_subscription"]) {
    assert.equal(mcpMoneyCategory(name), "payment_or_purchase", name);
    assert.equal(remoteAutonomyDecision(req(name)), "ask", name);
  }
  for (const name of ["mcp_stripe_list_payment_intents", "mcp_stripe_retrieve_balance", "mcp_supabase_list_tables", "mcp_vercel_get_deployment", "mcp_stripe_search_invoices"]) {
    assert.equal(mcpMoneyCategory(name), null, name);
  }
  assert.equal(classifyToolRequest(req("McpCallTool", { server: "stripe", tool: "create_refund" })), "payment_or_purchase");
  assert.equal(classifyToolRequest(req("McpCallTool", { server: "stripe", tool: "list_customers" })), null);
});

test("Phone without Twilio points the agent at Connect instead of failing blind", async () => {
  const result = await PhoneTool.call({ action: "list_numbers", country: "US", type: "Local", limit: 5 }, { signal: new AbortController().signal });
  assert.ok(result.failure);
  assert.match(result.output.message, /Connect with service "twilio"/);
});

// ── Telegram renders the card ──────────────────────────────────────────────

test("Telegram only turns a well-formed https connect request into a button", () => {
  const ok = connectProgressOf({ kind: "connect_request", flowId: "f", label: "Stripe", url: "https://ares.test/connect/f", instructions: "Sign in" });
  assert.equal(ok.kind, "connect_request");
  assert.equal(connectProgressOf({ kind: "connect_request", flowId: "f", label: "x", url: "javascript:alert(1)" }), null);
  assert.equal(connectProgressOf({ kind: "shell_output", text: "hi" }), null);
  assert.equal(connectProgressOf({ kind: "connect_result", flowId: "f", ok: true, detail: "" }).ok, true);
});
