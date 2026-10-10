// "Connect my bank" through Plaid, and one normalized money pipeline.
//
// Pins: "bank" resolves to the Plaid card; the one-time setup form proves the
// owner's keys before storing them; the Hosted Link request shape; completion
// by polling, by the redirect and by the webhook — each exchanging the public
// token Plaid's /link/token/get returned (never one from an unsigned hint),
// once; access tokens never reach tool output; update mode for a bank that
// needs a fresh login; the Bank tool's Plaid calls (sync cursor persisted,
// liabilities, investments, items with the Trial count, remove_item gated);
// ITEM_LOGIN_REQUIRED and 429 sentences; and the provider-agnostic analytics
// (normalizers, recurring detection, spending summary, new-charges cursor).
// Every external service is stubbed at globalThis.fetch.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONNECT_SERVICES, resolveConnectService, isServiceConnected, getCredential, setCredential, deleteCredential } from "../packages/core/dist/index.js";
import {
  BankTool,
  clearBankCache,
  detectRecurring,
  spendingSummary,
  newCharges,
  normalizePlaidAccount,
  normalizePlaidTransaction,
  normalizeSimplefinAccount,
  normalizeSimplefinTransaction,
  merchantKey,
} from "../packages/tools/dist/index.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import { listPhoneConnections } from "../packages/cli/dist/phoneConnections.js";
import { classifyToolRequest } from "../packages/cli/dist/policyGate.js";

const ctx = () => ({ signal: new AbortController().signal, permissionMode: "bypass" });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PLAID = "https://production.plaid.com";
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

const REAL_FETCH = globalThis.fetch;

/** Route every Plaid call by endpoint; records {path, body}. */
function plaidStub(t, routes) {
  const real = REAL_FETCH;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    if (url.startsWith("http://127.0.0.1")) return real(input, init);
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const call = { host: u.origin, path: u.pathname, body };
    calls.push(call);
    const route = routes[u.pathname];
    if (!route) throw new Error(`unexpected ${url}`);
    return route(body, calls);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-plaid-"));
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

async function presetKeys(home) {
  await setCredential("PLAID_CLIENT_ID", "cid-123", { home });
  await setCredential("PLAID_SECRET", "sec-456", { home });
  await setCredential("PLAID_ENV", "production", { home });
}

const LINK_OK = {
  link_sessions: [
    {
      link_session_id: "ls-1",
      finished_at: "2026-09-23T10:00:00Z",
      results: {
        item_add_results: [{ public_token: "public-prod-1", institution: { name: "Chase", institution_id: "ins_56" }, accounts: [{ id: "a1" }, { id: "a2" }] }],
      },
    },
  ],
};

// ── registry ────────────────────────────────────────────────────────────────

test("'connect my bank' is the Plaid card; SimpleFIN stays the alternative", async (t) => {
  for (const asked of ["bank", "my bank", "connect my bank", "bank balance", "my subscriptions", "spending", "credit card", "investments", "plaid"]) {
    assert.equal(resolveConnectService(asked)?.id, "plaid", asked);
  }
  const plaid = resolveConnectService("plaid");
  assert.equal(plaid.kind, "api-key", "no new ConnectKind — the phone's card and list keep working");
  assert.equal(plaid.domain, "plaid.com");
  assert.match(plaid.blurb, /10 bank connections/);
  assert.equal(resolveConnectService("simplefin").id, "simplefin");
  assert.equal(resolveConnectService("plaid dashboard").id, "plaid-dashboard", "the dashboard MCP moved off the bank's id");
  assert.equal(CONNECT_SERVICES.filter((s) => s.id === "plaid").length, 1);
  assert.equal(resolveConnectService("plaid:add").id, "plaid:add");
  assert.equal(resolveConnectService("plaid:update:item-Ab_1").id, "plaid:update:item-Ab_1", "item id case preserved");

  const home = await tempHome(t);
  assert.equal(await isServiceConnected(plaid, home), false);
  await presetKeys(home);
  assert.equal(await isServiceConnected(plaid, home), false, "keys alone are not a linked bank");
  await setCredential("PLAID_ITEMS", "[]", { home });
  assert.equal(await isServiceConnected(plaid, home), false, "an empty list is not connected");
  await setCredential("PLAID_ITEMS", JSON.stringify([{ item_id: "i1", access_token: "access-x", institution_name: "Chase", added_at: "2026-09-01" }]), { home });
  assert.equal(await isServiceConnected(plaid, home), true);
  assert.equal(await isServiceConnected(resolveConnectService("plaid:add"), home), false, "adding another bank always starts a flow");

  const listed = (await listPhoneConnections(home)).find((s) => s.id === "plaid");
  assert.deepEqual({ domain: listed.domain, category: listed.category, connected: listed.connected, kind: listed.kind }, { domain: "plaid.com", category: "money", connected: true, kind: "api-key" });
});

// ── stage A: the one-time setup form ────────────────────────────────────────

test("first connect: the setup form proves the keys, stores them, and goes straight to Plaid's Hosted Link", async (t) => {
  const home = await tempHome(t);
  let keysOk = false;
  const calls = plaidStub(t, {
    "/institutions/get": () => (keysOk ? json({ institutions: [{ name: "Chase" }], total: 1 }) : json({ error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid client_id or secret provided" }, 400)),
    "/link/token/create": () => json({ link_token: "link-prod-1", expiration: "2026-09-23T14:00:00Z", hosted_link_url: "https://hosted.plaid.com/link/lp1" }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 60_000 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("connect my bank"));
  assert.equal(prompt.kind, "api-key");
  assert.match(prompt.instructions, /One-time setup/);
  assert.equal(calls.length, 0, "no keys → no Plaid call yet");

  const form = await fetch(base + localPath(prompt.url));
  const html = await form.text();
  assert.equal(form.status, 200);
  assert.match(html, /dashboard\.plaid\.com/);
  assert.match(html, /name="PLAID_CLIENT_ID"/);
  assert.match(html, /name="PLAID_SECRET"/);
  assert.match(html, /<select id="PLAID_ENV" name="PLAID_ENV"[^>]*>[\s\S]*value="production" selected[\s\S]*value="sandbox"/);
  assert.match(html, /https:\/\/ares\.test\/connect\/plaid-done/, "the completion address to allow-list is shown");

  const bad = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ PLAID_CLIENT_ID: "cid-123", PLAID_SECRET: "wrong", PLAID_ENV: "production" }), redirect: "manual" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /doesn&#39;t recognise those keys for production/);
  assert.equal(await getCredential("PLAID_SECRET", { home }), undefined, "unproven keys are not stored");

  keysOk = true;
  const good = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ PLAID_CLIENT_ID: "cid-123", PLAID_SECRET: "sec-456", PLAID_ENV: "production" }), redirect: "manual" });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "https://hosted.plaid.com/link/lp1");
  assert.equal(await getCredential("PLAID_CLIENT_ID", { home }), "cid-123");
  assert.equal(await getCredential("PLAID_SECRET", { home }), "sec-456");
  assert.equal(await getCredential("PLAID_ENV", { home }), "production");

  const verify = calls.find((c) => c.path === "/institutions/get" && c.body.secret === "sec-456");
  assert.equal(verify.host, PLAID);
  assert.deepEqual({ count: verify.body.count, offset: verify.body.offset, country_codes: verify.body.country_codes }, { count: 1, offset: 0, country_codes: ["US"] });

  const create = calls.find((c) => c.path === "/link/token/create").body;
  assert.equal(create.client_id, "cid-123");
  assert.equal(create.client_name, "Ares");
  assert.deepEqual(create.user, { client_user_id: "ares-owner" });
  assert.deepEqual(create.products, ["transactions"]);
  assert.deepEqual(create.additional_consented_products, ["liabilities", "investments"], "consent only — not billed until used, never blocks Link");
  assert.equal(create.optional_products, undefined);
  assert.deepEqual(create.country_codes, ["US", "CA"]);
  assert.equal(create.language, "en");
  assert.deepEqual(create.hosted_link, { completion_redirect_uri: "https://ares.test/connect/plaid-done", url_lifetime_seconds: 1800 });
  assert.equal(create.webhook, "https://ares.test/connect/plaid-webhook");
  assert.equal(create.access_token, undefined);
});

test("sandbox keys talk to sandbox.plaid.com", async (t) => {
  const home = await tempHome(t);
  const calls = plaidStub(t, {
    "/institutions/get": () => json({ institutions: [], total: 0 }),
    "/link/token/create": () => json({ link_token: "link-sandbox-1", hosted_link_url: "https://hosted.plaid.com/link/ls1" }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 60_000 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("plaid"));
  await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", PLAID_ENV: "sandbox" }), redirect: "manual" });
  assert.ok(calls.length >= 2 && calls.every((c) => c.host === "https://sandbox.plaid.com"));
});

// ── stage B: completion ─────────────────────────────────────────────────────

test("keys already set: one tap; polling /link/token/get finishes it and the public token is exchanged once", async (t) => {
  const home = await tempHome(t);
  await presetKeys(home);
  let polls = 0;
  const calls = plaidStub(t, {
    "/link/token/create": () => json({ link_token: "link-prod-2", hosted_link_url: "https://hosted.plaid.com/link/lp2" }),
    "/link/token/get": (body) => {
      assert.equal(body.link_token, "link-prod-2");
      polls += 1;
      return json(polls < 2 ? { link_sessions: [{ link_session_id: "ls-1", started_at: "2026-09-23T10:00:00Z" }] } : LINK_OK);
    },
    "/item/public_token/exchange": (body) => {
      assert.equal(body.public_token, "public-prod-1");
      return json({ access_token: "access-prod-SECRET", item_id: "item-chase" });
    },
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 20 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("bank"));
  assert.match(prompt.instructions, /Pick your bank in Plaid/);
  assert.ok(calls.some((c) => c.path === "/link/token/create"), "the session is minted at start, so a Plaid refusal reaches the agent");
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  const land = await fetch(base + localPath(prompt.url), { redirect: "manual" });
  assert.equal(land.status, 302);
  assert.equal(land.headers.get("location"), "https://hosted.plaid.com/link/lp2");
  const outcome = await waiting;
  assert.deepEqual(outcome, { ok: true, detail: "Connected Chase (2 accounts)." });
  assert.equal(calls.filter((c) => c.path === "/item/public_token/exchange").length, 1);
  const items = JSON.parse(await getCredential("PLAID_ITEMS", { home }));
  assert.equal(items.length, 1);
  assert.deepEqual({ item_id: items[0].item_id, access_token: items[0].access_token, institution_name: items[0].institution_name }, { item_id: "item-chase", access_token: "access-prod-SECRET", institution_name: "Chase" });
  assert.equal(await isServiceConnected(resolveConnectService("plaid"), home), true);
  assert.doesNotMatch(JSON.stringify(outcome), /access-prod/);
  // Polling stops once settled.
  const after = polls;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(polls, after);
});

test("the completion redirect settles the flow without waiting for a poll", async (t) => {
  const home = await tempHome(t);
  await presetKeys(home);
  const calls = plaidStub(t, {
    "/link/token/create": () => json({ link_token: "link-prod-3", hosted_link_url: "https://hosted.plaid.com/link/lp3" }),
    "/link/token/get": () => json(LINK_OK),
    "/item/public_token/exchange": () => json({ access_token: "access-prod-3", item_id: "item-3" }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 600_000 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("plaid"));
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  await fetch(base + localPath(prompt.url), { redirect: "manual" });
  const done = await fetch(`${base}/connect/plaid-done`);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Bank connected[\s\S]*go back to Ares/i);
  assert.equal((await waiting).ok, true);
  assert.equal(calls.filter((c) => c.path === "/item/public_token/exchange").length, 1);
});

test("the webhook is only a hint: its public_tokens are ignored, /link/token/get is asked", async (t) => {
  const home = await tempHome(t);
  await presetKeys(home);
  const calls = plaidStub(t, {
    "/link/token/create": () => json({ link_token: "link-prod-4", hosted_link_url: "https://hosted.plaid.com/link/lp4" }),
    "/link/token/get": () => json(LINK_OK),
    "/item/public_token/exchange": (body) => json({ access_token: "access-prod-4", item_id: `item-for-${body.public_token}` }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 600_000 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("plaid"));
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  const res = await fetch(`${base}/connect/plaid-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "SUCCESS", link_token: "link-prod-4", public_tokens: ["public-FORGED"] }),
  });
  assert.equal(res.status, 200);
  assert.equal((await waiting).ok, true);
  const exchanged = calls.filter((c) => c.path === "/item/public_token/exchange").map((c) => c.body.public_token);
  assert.deepEqual(exchanged, ["public-prod-1"]);
  // A webhook for no known session changes nothing and still answers 200.
  const stray = await fetch(`${base}/connect/plaid-webhook`, { method: "POST", body: JSON.stringify({ webhook_code: "SESSION_FINISHED", link_token: "link-other" }) });
  assert.equal(stray.status, 200);
});

test("the owner closing Plaid fails the flow with a sentence", async (t) => {
  const home = await tempHome(t);
  await presetKeys(home);
  plaidStub(t, {
    "/link/token/create": () => json({ link_token: "link-prod-5", hosted_link_url: "https://hosted.plaid.com/link/lp5" }),
    "/link/token/get": () => json({ link_sessions: [{ link_session_id: "ls", finished_at: "2026-09-23T10:00:00Z", exit: { error: null, metadata: { status: "requires_credentials" } } }] }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 20 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("plaid"));
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  await fetch(base + localPath(prompt.url), { redirect: "manual" });
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /closed Plaid without linking/);
  assert.equal(await getCredential("PLAID_ITEMS", { home }), undefined);
});

test("update mode: plaid:update:<item_id> re-authenticates the same Item — access_token, no products, nothing exchanged", async (t) => {
  const home = await tempHome(t);
  await presetKeys(home);
  await setCredential("PLAID_ITEMS", JSON.stringify([{ item_id: "item-chase", access_token: "access-prod-OLD", institution_name: "Chase", added_at: "2026-09-01" }]), { home });
  const calls = plaidStub(t, {
    "/link/token/create": () => json({ link_token: "link-prod-6", hosted_link_url: "https://hosted.plaid.com/link/lp6" }),
    "/link/token/get": () => json({ link_sessions: [{ link_session_id: "ls", finished_at: "2026-09-23T10:00:00Z", results: { item_add_results: [] } }] }),
  });
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home, plaidPollMs: 20 });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("plaid:update:item-chase"));
  assert.match(prompt.instructions, /Sign in to your bank again/);
  const create = calls.find((c) => c.path === "/link/token/create").body;
  assert.equal(create.access_token, "access-prod-OLD");
  assert.equal(create.products, undefined, "update mode omits products");
  assert.equal(create.webhook, undefined);
  assert.ok(create.hosted_link);
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 10_000 });
  await fetch(base + localPath(prompt.url), { redirect: "manual" });
  const outcome = await waiting;
  assert.deepEqual(outcome, { ok: true, detail: "Reconnected Chase — Ares can read it again." });
  assert.ok(!calls.some((c) => c.path === "/item/public_token/exchange"));
  await assert.rejects(() => hub.start(resolveConnectService("plaid:update:nope")), /no linked bank has item_id nope/);
});

// ── the Bank tool on Plaid ──────────────────────────────────────────────────

async function linkBanks(t, items) {
  const home = process.env.ARES_HOME;
  await presetKeys(home);
  await setCredential("PLAID_ITEMS", JSON.stringify(items), { home });
  clearBankCache();
  t.after(async () => {
    for (const name of ["PLAID_ITEMS", "PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"]) await deleteCredential(name, { home });
    await fsp.rm(path.join(home, "plaid"), { recursive: true, force: true });
    await fsp.rm(path.join(home, "bank"), { recursive: true, force: true });
    clearBankCache();
  });
  return home;
}

const CHASE = { item_id: "item-chase", access_token: "access-prod-CHASE", institution_name: "Chase", added_at: "2026-09-01T00:00:00Z" };
const AMEX = { item_id: "item-amex", access_token: "access-prod-AMEX", institution_name: "Amex", added_at: "2026-09-02T00:00:00Z" };

const plaidAccounts = (item) => ({
  accounts: item === "access-prod-AMEX"
    ? [{ account_id: "amex-1", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card", balances: { current: 410.25, available: 9589.75, iso_currency_code: "USD" } }]
    : [{ account_id: "chk-1", name: "Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 1200.5, available: 1100.5, iso_currency_code: "USD" } }],
});

const ptx = (id, daysAgo, amount, name, extra = {}) => ({ transaction_id: id, account_id: "chk-1", date: iso(daysAgo), amount, name, pending: false, ...extra });

test("Bank on Plaid: balances from /accounts/get, normalized, and no access token anywhere in the output", async (t) => {
  await linkBanks(t, [CHASE, AMEX]);
  const calls = plaidStub(t, { "/accounts/get": (body) => json(plaidAccounts(body.access_token)) });
  const result = await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.equal(result.failure, undefined, result.output.message);
  assert.equal(result.output.provider, "plaid");
  assert.deepEqual(calls.map((c) => [c.path, c.body.access_token]), [["/accounts/get", "access-prod-CHASE"], ["/accounts/get", "access-prod-AMEX"]]);
  const amex = result.output.accounts.find((a) => a.id === "amex-1");
  assert.equal(amex.balance, -410.25, "what's owed on a card is negative, like SimpleFIN");
  assert.equal(amex.institution, "Amex");
  assert.doesNotMatch(JSON.stringify(result), /access-prod/);
  // Cached: a second question makes no new call.
  await BankTool.call(BankTool.inputZod.parse({ action: "balances" }), ctx());
  assert.equal(calls.length, 2);
  // live asks /accounts/balance/get (billed per call) and bypasses the cache.
  plaidStub(t, { "/accounts/balance/get": (body) => json(plaidAccounts(body.access_token)) });
  const live = await BankTool.call(BankTool.inputZod.parse({ action: "accounts", live: true }), ctx());
  assert.equal(live.failure, undefined, live.output.message);
});

test("Bank on Plaid: /transactions/sync pages, persists the cursor (never the token), applies removals", async (t) => {
  const home = await linkBanks(t, [CHASE]);
  let round = 0;
  const calls = plaidStub(t, {
    "/accounts/get": (body) => json(plaidAccounts(body.access_token)),
    "/transactions/sync": (body) => {
      if (round === 0) {
        if (!body.cursor) return json({ added: [ptx("t1", 3, 15.49, "NETFLIX.COM", { merchant_name: "Netflix", personal_finance_category: { primary: "ENTERTAINMENT" } })], modified: [], removed: [], next_cursor: "c1", has_more: true, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
        assert.equal(body.cursor, "c1");
        return json({ added: [ptx("t2", 1, 42.1, "TRADER JOE'S #552"), ptx("t3", 2, -2500, "ACME PAYROLL")], modified: [], removed: [], next_cursor: "c2", has_more: false });
      }
      assert.equal(body.cursor, "c2", "the next sync starts from the stored cursor");
      return json({ added: [], modified: [], removed: [{ transaction_id: "t2" }], next_cursor: "c3", has_more: false });
    },
  });
  const first = await BankTool.call(BankTool.inputZod.parse({ action: "transactions", days: 30 }), ctx());
  assert.equal(first.failure, undefined, first.output.message);
  assert.equal(calls.filter((c) => c.path === "/transactions/sync").length, 2);
  assert.equal(calls.find((c) => c.path === "/transactions/sync").body.count, 500);
  const byId = Object.fromEntries(first.output.transactions.map((x) => [x.id, x]));
  assert.equal(byId.t1.amount, -15.49, "Plaid's positive outflow becomes negative");
  assert.equal(byId.t1.category, "Entertainment");
  assert.equal(byId.t1.merchant, "Netflix");
  assert.equal(byId.t3.amount, 2500);
  const store = await fsp.readFile(path.join(home, "plaid", "item-chase.json"), "utf8");
  assert.equal(JSON.parse(store).cursor, "c2");
  assert.doesNotMatch(store, /access-prod/, "the sync store never holds the token");

  round = 1;
  const second = await BankTool.call(BankTool.inputZod.parse({ action: "transactions", days: 30, refresh: true }), ctx());
  assert.deepEqual(second.output.transactions.map((x) => x.id).sort(), ["t1", "t3"]);
  assert.equal(JSON.parse(await fsp.readFile(path.join(home, "plaid", "item-chase.json"), "utf8")).cursor, "c3");

  const q = await BankTool.call(BankTool.inputZod.parse({ action: "transactions", days: 30, query: "netflix" }), ctx());
  assert.deepEqual(q.output.transactions.map((x) => x.id), ["t1"]);
});

test("Bank on Plaid: a mutation mid-pagination restarts from the first cursor", async (t) => {
  await linkBanks(t, [CHASE]);
  let n = 0;
  const calls = plaidStub(t, {
    "/accounts/get": (body) => json(plaidAccounts(body.access_token)),
    "/transactions/sync": (body) => {
      n += 1;
      if (n === 1) return json({ added: [ptx("x1", 1, 5, "A")], modified: [], removed: [], next_cursor: "p1", has_more: true });
      if (n === 2) return json({ error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "mutated" }, 400);
      return json({ added: [ptx("x1", 1, 5, "A")], modified: [], removed: [], next_cursor: "p9", has_more: false });
    },
  });
  const result = await BankTool.call(BankTool.inputZod.parse({ action: "transactions" }), ctx());
  assert.equal(result.failure, undefined, result.output.message);
  const syncs = calls.filter((c) => c.path === "/transactions/sync").map((c) => c.body.cursor ?? "");
  assert.deepEqual(syncs, ["", "p1", ""]);
});

test("ITEM_LOGIN_REQUIRED names the update-mode Connect; a 429 is a hard stop with no retry", async (t) => {
  await linkBanks(t, [CHASE]);
  let calls = plaidStub(t, { "/accounts/get": () => json({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed" }, 400) });
  const login = await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.ok(login.failure);
  assert.match(login.output.message, /Chase needs the owner to sign in again[\s\S]*Connect with service "plaid:update:item-chase"/);
  assert.doesNotMatch(JSON.stringify(login), /access-prod/);

  clearBankCache();
  calls = plaidStub(t, { "/accounts/get": () => json({ error_type: "RATE_LIMIT_EXCEEDED", error_code: "ACCOUNTS_LIMIT", error_message: "rate limit exceeded" }, 429) });
  const limited = await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.ok(limited.failure);
  assert.match(limited.output.message, /rate limit[\s\S]*do not retry/i);
  assert.equal(calls.length, 1, "no retry loop");
});

test("one bank failing is a warning; the others still answer", async (t) => {
  await linkBanks(t, [CHASE, AMEX]);
  plaidStub(t, {
    "/accounts/get": (body) =>
      body.access_token === "access-prod-AMEX" ? json({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" }, 400) : json(plaidAccounts(body.access_token)),
  });
  const result = await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.equal(result.failure, undefined);
  assert.equal(result.output.accounts.length, 1);
  assert.match(result.output.warnings[0], /plaid:update:item-amex/);
});

test("liabilities and investments: Plaid-only, summarized per bank", async (t) => {
  await linkBanks(t, [AMEX]);
  const calls = plaidStub(t, {
    "/liabilities/get": () =>
      json({
        accounts: [{ account_id: "amex-1", name: "Platinum", mask: "1005", balances: { current: 410.25 } }],
        liabilities: { credit: [{ account_id: "amex-1", aprs: [{ apr_percentage: 24.99, apr_type: "purchase_apr" }], last_statement_balance: 380, minimum_payment_amount: 40, next_payment_due_date: "2026-10-10", is_overdue: false }], student: null, mortgage: null },
      }),
    "/investments/holdings/get": () =>
      json({
        accounts: [{ account_id: "inv-1", name: "Brokerage" }],
        holdings: [
          { account_id: "inv-1", security_id: "s1", quantity: 10, institution_value: 2300, institution_price: 230, cost_basis: 1800, iso_currency_code: "USD" },
          { account_id: "inv-1", security_id: "s2", quantity: 5, institution_value: 500, institution_price: 100, cost_basis: null, iso_currency_code: "USD" },
        ],
        securities: [{ security_id: "s1", name: "Apple Inc.", ticker_symbol: "AAPL", type: "equity" }, { security_id: "s2", name: "Vanguard Total", ticker_symbol: "VTI", type: "etf" }],
      }),
  });
  const lib = await BankTool.call(BankTool.inputZod.parse({ action: "liabilities" }), ctx());
  assert.equal(lib.failure, undefined, lib.output.message);
  assert.deepEqual(lib.output.liabilities[0], { kind: "credit", account: "Amex Platinum …1005", owed: 410.25, last_statement_balance: 380, minimum_payment: 40, next_due: "2026-10-10", apr: 24.99, overdue: false });
  assert.equal(calls[0].body.access_token, "access-prod-AMEX");
  const inv = await BankTool.call(BankTool.inputZod.parse({ action: "investments" }), ctx());
  assert.equal(inv.output.holdings[0].ticker, "AAPL");
  assert.match(inv.output.message, /2 holdings, 2800\.00 total/);
  assert.doesNotMatch(JSON.stringify([lib, inv]), /access-prod/);
});

test("items shows the Trial count; remove_item asks, is gated, and revokes at Plaid", async (t) => {
  const home = await linkBanks(t, [CHASE, AMEX]);
  const calls = plaidStub(t, { "/item/remove": () => json({ request_id: "r" }) });
  const items = await BankTool.call(BankTool.inputZod.parse({ action: "items" }), ctx());
  assert.deepEqual(items.output.items.map((i) => Object.keys(i).sort()), [["added_at", "institution", "item_id"], ["added_at", "institution", "item_id"]]);
  assert.match(items.output.message, /Plaid Trial: 2 of 10 connections used/);
  assert.match(items.output.message, /does NOT free a slot/);

  const ask = await BankTool.checkPermissions(BankTool.inputZod.parse({ action: "remove_item", item_id: "item-amex" }), ctx());
  assert.equal(ask.kind, "ask");
  assert.match(ask.prompt, /Disconnect Amex/);
  assert.equal(classifyToolRequest({ toolName: "Bank", input: { action: "remove_item", item_id: "item-amex" }, reason: "" }), "credential_or_secret");
  assert.equal(classifyToolRequest({ toolName: "Bank", input: { action: "accounts" }, reason: "" }), null);
  assert.equal((await BankTool.checkPermissions(BankTool.inputZod.parse({ action: "recurring" }), ctx())).kind, "allow");

  const removed = await BankTool.call(BankTool.inputZod.parse({ action: "remove_item", item_id: "item-amex" }), ctx());
  assert.equal(removed.failure, undefined, removed.output.message);
  assert.equal(calls[0].path, "/item/remove");
  assert.equal(calls[0].body.access_token, "access-prod-AMEX");
  assert.deepEqual(JSON.parse(await getCredential("PLAID_ITEMS", { home })).map((i) => i.item_id), ["item-chase"]);
  await BankTool.call(BankTool.inputZod.parse({ action: "remove_item", item_id: "item-chase" }), ctx());
  assert.equal(await getCredential("PLAID_ITEMS", { home }), undefined, "the last bank gone → not connected");
  assert.equal(await isServiceConnected(resolveConnectService("plaid"), home), false);
});

test("Plaid-only actions on SimpleFIN say to connect Plaid", async (t) => {
  const prior = process.env.SIMPLEFIN_ACCESS_URL;
  process.env.SIMPLEFIN_ACCESS_URL = "https://u:p@bridge.example.org/simplefin";
  t.after(() => (prior === undefined ? delete process.env.SIMPLEFIN_ACCESS_URL : (process.env.SIMPLEFIN_ACCESS_URL = prior)));
  const result = await BankTool.call(BankTool.inputZod.parse({ action: "liabilities" }), ctx());
  assert.ok(result.failure);
  assert.match(result.output.message, /Connect with service "plaid"/);
});

// ── one pipeline: normalizers + analytics ───────────────────────────────────

test("both providers normalize to the same shape and sign", () => {
  const sf = normalizeSimplefinTransaction({ id: "A1" }, { id: "s1", posted: 1790100000, amount: "-42.10", description: "Grocer", payee: "Grocer Co" });
  const pl = normalizePlaidTransaction({ transaction_id: "p1", account_id: "A2", date: "2026-09-20", amount: 42.1, name: "Grocer", merchant_name: "Grocer Co", personal_finance_category: { primary: "FOOD_AND_DRINK" }, pending: true });
  assert.deepEqual(Object.keys(sf).sort(), ["accountId", "amount", "date", "description", "id", "merchant"]);
  assert.equal(sf.amount, -42.1);
  assert.equal(pl.amount, -42.1, "money out is negative for both");
  assert.equal(pl.category, "Food and drink");
  assert.equal(pl.pending, true);
  const sa = normalizeSimplefinAccount({ id: "A1", name: "Card", currency: "USD", balance: "-300.00", "available-balance": "700", _institution: "Bank" });
  const pa = normalizePlaidAccount({ account_id: "A2", name: "Card", type: "credit", balances: { current: 300, available: 700, iso_currency_code: "USD" } }, { item_id: "i", institution_name: "Bank" });
  assert.equal(sa.balance, -300);
  assert.equal(pa.balance, -300);
  assert.deepEqual([sa.provider, pa.provider], ["simplefin", "plaid"]);
});

function series() {
  const out = [];
  // Netflix, monthly, same amount — described the SimpleFIN way.
  for (const [i, d] of [5, 35, 66, 96].entries()) out.push({ id: `nf${i}`, accountId: "A", date: iso(d), amount: -15.49, description: "NETFLIX.COM 866-579-7172 CA" });
  // The gym, weekly.
  for (let w = 0; w < 8; w++) out.push({ id: `gym${w}`, accountId: "A", date: iso(2 + w * 7), amount: -10, description: `PLANET FITNESS #1234` });
  // Groceries: frequent, same store, but amounts all over the place.
  for (const [i, [d, a]] of [[1, 45.12], [4, 88.3], [9, 23.1], [12, 61.75], [19, 102.4], [23, 38.9], [30, 71.2]].entries())
    out.push({ id: `tj${i}`, accountId: "A", date: iso(d), amount: -a, description: "TRADER JOE'S #552" });
  // Salary (money in) and a one-off.
  out.push({ id: "pay1", accountId: "A", date: iso(14), amount: 2500, description: "ACME PAYROLL" });
  out.push({ id: "tv", accountId: "A", date: iso(40), amount: -899, description: "BEST BUY 00123" });
  return out;
}

test("recurring: Netflix monthly and the gym weekly are found; noisy groceries and one-offs are not", () => {
  const found = detectRecurring(series());
  const byName = Object.fromEntries(found.map((r) => [r.merchant.toLowerCase(), r]));
  assert.deepEqual(Object.keys(byName).sort(), ["netflix ca", "planet fitness"]);
  const nf = byName["netflix ca"];
  assert.deepEqual({ amount: nf.amount, cadence: nf.cadence, count: nf.count, lastDate: nf.lastDate, active: nf.active, category: nf.category }, { amount: 15.49, cadence: "monthly", count: 4, lastDate: iso(5), active: true, category: "Subscriptions" });
  const next = new Date(`${nf.lastDate}T00:00:00Z`);
  assert.ok(Date.parse(nf.nextExpected) - next.getTime() >= 28 * DAY && Date.parse(nf.nextExpected) - next.getTime() <= 31 * DAY);
  const gym = byName["planet fitness"];
  assert.deepEqual({ cadence: gym.cadence, amount: gym.amount, count: gym.count, category: gym.category }, { cadence: "weekly", amount: 10, count: 8, category: "Health and fitness" });
  assert.equal(merchantKey({ description: "NETFLIX.COM 866-579-7172 CA" }), merchantKey({ description: "Netflix.com 866-579-7172 CA" }));

  // A subscription whose price changed by more than 10% isn't one steady charge.
  const hike = [{ id: "a", accountId: "A", date: iso(40), amount: -10, description: "Spotify" }, { id: "b", accountId: "A", date: iso(10), amount: -13, description: "Spotify" }];
  assert.equal(detectRecurring(hike).length, 0);
  // Two weekly-spaced charges are not enough to call weekly.
  assert.equal(detectRecurring(series().filter((t) => !t.id.startsWith("nf")).filter((t) => !["gym2", "gym3", "gym4", "gym5", "gym6", "gym7"].includes(t.id))).length, 0);
});

test("spending summary: posted money out by category and merchant; transfers and pending left out", () => {
  const txs = [
    { id: "1", accountId: "A", date: iso(1), amount: -50, description: "WHOLE FOODS MKT" },
    { id: "2", accountId: "A", date: iso(2), amount: -30, description: "Whole Foods Mkt" },
    { id: "3", accountId: "A", date: iso(3), amount: -20, description: "Blue Bottle", category: "Food and drink" },
    { id: "4", accountId: "A", date: iso(4), amount: 1000, description: "ACME PAYROLL" },
    { id: "5", accountId: "A", date: iso(5), amount: -500, description: "Online transfer to savings" },
    { id: "6", accountId: "A", date: iso(1), amount: -10, description: "Pending thing", pending: true },
    { id: "7", accountId: "A", date: iso(60), amount: -99, description: "Old" },
    { id: "8", accountId: "A", date: iso(6), amount: 500, description: "Transfer from checking", category: "Transfer in" },
  ];
  const s = spendingSummary(txs, 30);
  assert.deepEqual({ spent: s.spent, income: s.income, net: s.net }, { spent: 100, income: 1000, net: 900 });
  assert.deepEqual(s.byCategory, [
    { category: "Groceries", total: 80, count: 2, share: 80 },
    { category: "Food and drink", total: 20, count: 1, share: 20 },
  ]);
  assert.deepEqual(s.topMerchants[0], { merchant: "Whole Foods Mkt", total: 80, count: 2 });
});

test("new_charges: the first call is a baseline, then only unseen money out — late-posted ones too", () => {
  const a = { id: "a", accountId: "A", date: iso(1), amount: -12, description: "Coffee" };
  const b = { id: "b", accountId: "A", date: iso(10), amount: -80, description: "Old charge" };
  const inflow = { id: "in", accountId: "A", date: iso(0), amount: 100, description: "Refund" };
  const first = newCharges([a, b, inflow], null);
  assert.deepEqual(first.charges.map((t) => t.id), ["a"], "first run: just the last two days");
  assert.deepEqual(Object.keys(first.cursor.seen).sort(), ["a", "b"]);

  const c = { id: "c", accountId: "A", date: iso(0), amount: -9.99, description: "New sub" };
  const late = { id: "late", accountId: "A", date: iso(5), amount: -40, description: "Posted late" };
  const pend = { id: "p", accountId: "A", date: iso(0), amount: -5, description: "Pending", pending: true };
  const second = newCharges([a, b, c, late, pend, inflow], first.cursor);
  assert.deepEqual(second.charges.map((t) => t.id), ["c", "late"]);
  assert.deepEqual(newCharges([a, b, c, late, inflow], second.cursor).charges, []);
  const since = newCharges([a, b], null, { since: iso(30) });
  assert.deepEqual(since.charges.map((t) => t.id), ["a", "b"]);
});

test("Bank new_charges on SimpleFIN moves a cursor (unless peek), and one cached request serves several questions", async (t) => {
  const home = process.env.ARES_HOME;
  const prior = process.env.SIMPLEFIN_ACCESS_URL;
  process.env.SIMPLEFIN_ACCESS_URL = "https://u:p@bridge.example.org/simplefin";
  clearBankCache();
  t.after(async () => {
    if (prior === undefined) delete process.env.SIMPLEFIN_ACCESS_URL;
    else process.env.SIMPLEFIN_ACCESS_URL = prior;
    await fsp.rm(path.join(home, "bank"), { recursive: true, force: true });
    clearBankCache();
  });
  const sec = (d) => Math.floor((Date.now() - d * DAY) / 1000);
  let txs = [{ id: "t1", posted: sec(1), amount: "-12.00", description: "Coffee" }];
  const real = REAL_FETCH;
  let hits = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.ok(url.startsWith("https://bridge.example.org/simplefin/accounts?"));
    hits += 1;
    const q = new URL(url).searchParams;
    assert.equal(q.get("pending"), "1");
    assert.ok(Number(q.get("start-date")) <= sec(89), "one request asks for the whole 90-day window");
    return json({ accounts: [{ id: "A1", name: "Checking", currency: "USD", balance: "100", transactions: txs }] });
  };
  t.after(() => (globalThis.fetch = real));

  const first = await BankTool.call(BankTool.inputZod.parse({ action: "new_charges" }), ctx());
  assert.equal(first.output.provider, "simplefin");
  assert.deepEqual(first.output.charges.map((c) => c.id), ["t1"]);
  await BankTool.call(BankTool.inputZod.parse({ action: "spending_summary" }), ctx());
  await BankTool.call(BankTool.inputZod.parse({ action: "recurring" }), ctx());
  await BankTool.call(BankTool.inputZod.parse({ action: "accounts" }), ctx());
  assert.equal(hits, 1, "cached — SimpleFIN asks for ≤24 requests a day");

  txs = [...txs, { id: "t2", posted: sec(0), amount: "-30.00", description: "Gas" }];
  const peek = await BankTool.call(BankTool.inputZod.parse({ action: "new_charges", refresh: true, peek: true }), ctx());
  assert.deepEqual(peek.output.charges.map((c) => c.id), ["t2"]);
  const again = await BankTool.call(BankTool.inputZod.parse({ action: "new_charges" }), ctx());
  assert.deepEqual(again.output.charges.map((c) => c.id), ["t2"], "peek did not move the cursor");
  const none = await BankTool.call(BankTool.inputZod.parse({ action: "new_charges" }), ctx());
  assert.deepEqual(none.output.charges, []);
  assert.match(none.output.message, /No new charges since the last check/);

  // The daily budget: past 24 requests, the last snapshot is served with a warning.
  const stamps = Array.from({ length: 24 }, () => Date.now());
  await fsp.writeFile(path.join(home, "bank", "simplefin-requests.json"), JSON.stringify({ at: stamps }));
  const capped = await BankTool.call(BankTool.inputZod.parse({ action: "accounts", refresh: true }), ctx());
  assert.equal(capped.failure, undefined);
  assert.match(capped.output.message, /24 requests a day/);
  assert.equal(hits, 2, "no request past the budget");
});
