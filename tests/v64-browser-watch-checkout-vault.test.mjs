// Watch or take over the browser, approve the exact total, and log in without
// ever seeing the password.
//
// Three promises Ares makes on the phone, pinned here:
//   1. "You can watch or take over anytime." Every browser gets ONE
//      /watch/<token> link; watching never blocks Ares; taking over makes the
//      owner the single controller — Browser actions wait, then learn exactly
//      what changed before they may act again.
//   2. "You approve the exact total before anything is charged." Checkout
//      review is an owner decision (never auto-approved, never "always"), and
//      the Browser refuses a Place order click without an approved review
//      whose total is still on the page.
//   3. "I can't see or repeat the values." Browser login / fill_secret put a
//      vault value into the page after a fresh approval naming the exact
//      origin; the value never appears in any output, display, progress or
//      error — not even when the model evals the password field afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-v64-"));
process.env.ARES_HOME = HOME;
process.env.ARES_BROWSER_PACE_MS = "120";
test.after(() => fsp.rm(HOME, { recursive: true, force: true }));

const { getCredential, setCredential, mintSecretHandle, resolveConnectService, isServiceConnected, readAudit } = await import("../packages/core/dist/index.js");
const { CheckoutTool, adaptToolForEngine, approvedCheckout, recordCheckoutApproval, looksLikeOrderSubmission, parseAmount } = await import("../packages/tools/dist/index.js");
const { makeBrowserTool } = await import("../packages/cli/dist/entry/browserBridge.js");
const { cliRuntimeContext } = await import("../packages/cli/dist/entry/runtime.js");
const { BrowserWatchHub, setBrowserWatchHub, describeHandback } = await import("../packages/cli/dist/browserWatch.js");
const { SecretFingerprints } = await import("../packages/cli/dist/browserSecrets.js");
const { ConnectHub } = await import("../packages/cli/dist/connectHub.js");
const { classifyToolRequest, remoteAutonomyDecision } = await import("../packages/cli/dist/policyGate.js");
const { decidePermission } = await import("../packages/cli/dist/permissionPolicy.js");
const { describePermissionInput, renderPermissionPrompt } = await import("../packages/channels/dist/telegram/prompts.js");
const { CORE_TOOL_NAMES } = await import("../packages/core/dist/queryEngine.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Playwright-ish page the watch view drives. */
function fakePlaywrightPage(state) {
  return {
    url: () => state.url,
    title: async () => state.title,
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    viewportSize: () => ({ width: 1000, height: 500 }),
    context: () => ({ cookies: async () => Array.from({ length: state.cookies }, () => ({})) }),
    evaluate: async () => state.fields.map((f) => ({ ...f, value: f.type === "password" && f.value ? "•••" : f.value })),
    mouse: { click: async (x, y) => state.actions.push(["click", Math.round(x), Math.round(y)]), wheel: async (_x, dy) => state.actions.push(["wheel", dy]) },
    keyboard: { type: async (text) => state.actions.push(["type", text]), press: async (key) => state.actions.push(["press", key]) },
    goBack: async () => state.actions.push(["back"]),
    reload: async () => state.actions.push(["reload"]),
    goto: async (url) => state.actions.push(["goto", url]),
  };
}

/** A BrowserConnector over that page, recording what Ares did. */
function fakeConnector(state) {
  const page = fakePlaywrightPage(state);
  return {
    name: "fake",
    strategy: "launch:fake",
    livePage: () => page,
    async state() { return { url: state.url, title: state.title }; },
    async close() { state.actions.push(["closed"]); },
    async navigate(url) { state.url = url; return { url, title: state.title }; },
    async accessibilityTree() { return state.tree ?? []; },
    async fillByLabel() {},
    async clickByRole(role, name) { state.agent.push(["click", role, name]); },
    async clickByText(query) { state.agent.push(["click_text", query]); },
    async screenshot() { return { format: "png", bytes: "AA==" }; },
    async evaluate(js) { state.agent.push(["eval", js]); return state.evalResult ?? state.pageText ?? ""; },
    async consoleLogs() { return state.console ?? []; },
    async fillSecret(target, value) {
      if (state.failFill) throw new Error(`locator.fill: could not type "${value}" into ${target.selector ?? target.label}`);
      if (target.selector && state.missing?.some((m) => target.selector.includes(m))) throw new Error(`no field matches ${target.selector}`);
      state.filled.push([target.selector ?? target.label, value]);
    },
    async submitForm() { state.agent.push(["submit"]); return true; },
  };
}

function newState(url = "https://www.example.com/login") {
  return { url, title: "Sign in", cookies: 1, fields: [{ name: "email", type: "email", value: "" }, { name: "password", type: "password", value: "" }], actions: [], agent: [], filled: [] };
}

async function serve(t, hub) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void hub.handle(req, res, url).then((handled) => { if (!handled && !res.headersSent) { res.writeHead(404); res.end(); } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const localPath = (url) => new URL(url).pathname;

function engineBrowser(state, extra = {}) {
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: HOME, home: HOME }), async () => fakeConnector(state));
  return adaptToolForEngine(tool, (base) => ({ ...base, permissionMode: "bypass", fileReadStamps: new Map(), ...extra }));
}

function ctxFor(sessionId, opts = {}) {
  const asked = [];
  const progress = [];
  let seq = 0;
  return {
    asked,
    progress,
    ctx: () => ({
      workspace: HOME,
      sessionId,
      toolUseId: `tu_${++seq}`,
      signal: opts.signal ?? new AbortController().signal,
      emitProgress: (data) => progress.push(data),
      requestPermission: async (request) => { asked.push(request); return typeof opts.answer === "function" ? opts.answer(request) : opts.answer ?? "allow_once"; },
      ...(opts.pauseWatchdog ? { pauseWatchdog: opts.pauseWatchdog } : {}),
    }),
  };
}

// ── 1. watch / take over ─────────────────────────────────────────────────────

test("a watch link streams one page; the owner can only drive it after Take over, and hand back with a diff", async (t) => {
  const hub = new BrowserWatchHub({ publicUrl: () => "https://ares.test", home: HOME });
  assert.equal(new BrowserWatchHub({ publicUrl: () => undefined }).open({ page: () => undefined, label: "x" }), null, "no public origin → no link");
  const base = await serve(t, hub);
  const state = newState("https://www.doordash.com/cart");
  const page = fakePlaywrightPage(state);
  const watch = hub.open({ page: () => page, label: "doordash.com", conversationId: "conv-1" });
  assert.match(watch.url, /^https:\/\/ares\.test\/watch\/[A-Za-z0-9_-]{30,}$/);
  const at = localPath(watch.url);

  const viewer = await fetch(base + at);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.headers.get("cache-control"), "no-store");
  const html = await viewer.text();
  assert.match(html, /Take over/);
  assert.match(html, /Hand back to Ares/);

  const frame = await fetch(`${base}${at}/frame`);
  assert.equal(frame.headers.get("content-type"), "image/jpeg");
  assert.equal(frame.headers.get("x-controller"), "ares");
  assert.equal(decodeURIComponent(frame.headers.get("x-page-url")), "https://www.doordash.com/cart");

  // Watching never blocks Ares, and the watcher can't touch the page.
  assert.deepEqual(await watch.waitForControl({ signal: new AbortController().signal, timeoutMs: 1000 }), { waited: false });
  const post = (sub, body) => fetch(`${base}${at}/${sub}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  assert.equal((await post("input", { type: "tap", x: 0.5, y: 0.5 })).status, 409);
  assert.deepEqual(state.actions, []);

  const take = await post("take");
  assert.equal(take.status, 200);
  assert.equal((await take.json()).controller, "owner");
  const waiting = watch.waitForControl({ signal: new AbortController().signal, timeoutMs: 5000 });
  assert.equal((await post("input", { type: "tap", x: 0.5, y: 0.2 })).status, 200);
  await post("input", { type: "key", key: "Control+W" });
  await post("input", { type: "type", text: "no onions" });
  await post("input", { type: "goto", url: "javascript:alert(1)" });
  assert.deepEqual(state.actions, [["click", 500, 100], ["type", "no onions"]], "same whitelist as the sign-in browser, on this page's viewport");

  // The owner changes things, then hands back.
  state.url = "https://www.doordash.com/checkout";
  state.cookies = 3;
  state.fields = [{ name: "instructions", type: "text", value: "no onions" }, { name: "password", type: "password", value: "hunter22" }];
  assert.equal((await post("handback")).status, 200);
  const outcome = await waiting;
  assert.equal(outcome.outcome, "handed_back");
  assert.match(outcome.notice.note, /url changed from https:\/\/www\.doordash\.com\/cart to https:\/\/www\.doordash\.com\/checkout/);
  assert.match(outcome.notice.note, /instructions \(new\)/);
  assert.match(outcome.notice.note, /re-read the page/i);
  assert.doesNotMatch(JSON.stringify(outcome.notice), /hunter22/, "password fields are masked in snapshots");
  assert.equal((await post("input", { type: "tap", x: 0.1, y: 0.1 })).status, 409, "Ares holds it again");

  // Bounded and abortable.
  await watch.takeOver();
  assert.deepEqual(await watch.waitForControl({ signal: new AbortController().signal, timeoutMs: 20 }), { waited: true, outcome: "timeout" });
  const stop = new AbortController();
  const aborted = watch.waitForControl({ signal: stop.signal, timeoutMs: 5000 });
  stop.abort();
  await assert.rejects(aborted, /stopped/);

  // A closed browser's link ends; a made-up one never existed.
  watch.end();
  assert.equal((await fetch(`${base}${at}/frame`)).status, 410);
  assert.match(await (await fetch(base + at)).text(), /Browser closed/);
  assert.equal((await fetch(`${base}/watch/${"x".repeat(32)}`)).status, 404);

  await sleep(30); // audit appends are fire-and-forget
  const audit = await readAudit({ home: HOME, limit: 2000 });
  const windows = audit.filter((e) => e.params?.browserSession === watch.sessionId);
  assert.ok(windows.some((e) => e.actor === "owner" && e.action === "browser.control.start" && e.target === "https://www.doordash.com/cart"));
  const ended = windows.find((e) => e.actor === "owner" && e.action === "browser.control.end" && e.result === "handed back to Ares");
  assert.equal(ended.params.urlAtStart, "https://www.doordash.com/cart");
  assert.equal(ended.params.urlAtEnd, "https://www.doordash.com/checkout");
  assert.ok(ended.params.from && ended.params.to && ended.sessionId === "conv-1");
});

test("the Browser tool announces its watch link once, waits while the owner drives, and never acts on a page it hasn't re-read", async (t) => {
  const hub = new BrowserWatchHub({ publicUrl: () => "https://ares.test", home: HOME });
  setBrowserWatchHub(hub);
  t.after(() => setBrowserWatchHub(null));
  const state = newState("https://www.doordash.com/store/chipotle");
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: HOME, home: HOME }), async () => fakeConnector(state));
  const progress = [];
  let paused = 0;
  let released = 0;
  const ctx = () => ({
    sessionId: "conv-2",
    signal: new AbortController().signal,
    emitProgress: (data) => progress.push(data),
    requestPermission: async () => "allow_once",
    pauseWatchdog: () => { paused += 1; return () => { released += 1; }; },
  });

  await tool.call({ action: "state" }, ctx());
  await tool.call({ action: "state" }, ctx());
  const live = progress.filter((p) => p.kind === "browser_live");
  assert.equal(live.length, 1, "once per browser session");
  assert.equal(live[0].state, "active");
  assert.equal(live[0].label, "doordash.com");
  assert.match(live[0].url, /^https:\/\/ares\.test\/watch\//);
  assert.ok(live[0].sessionId);
  const watch = hub.get(live[0].url.split("/").pop());

  await watch.takeOver();
  let settled = false;
  const queued = tool.call({ action: "click_text", query: "Add to order" }, ctx()).then((r) => { settled = true; return r; });
  await sleep(60);
  assert.equal(settled, false, "Ares waits while the owner has the page");
  assert.equal(paused, 1, "the wait is off the watchdog clock");
  assert.ok(progress.some((p) => p.kind === "browser_control" && p.controller === "owner"));
  state.url = "https://www.doordash.com/checkout";
  await watch.handBack();
  const result = await queued;
  assert.equal(result.output.status, "owner_handed_back");
  assert.equal(result.output.ownerTookOver, true);
  assert.match(result.output.note, /^ACTION NOT PERFORMED — The owner took over and handed back\. The url changed/);
  assert.deepEqual(state.agent.filter((a) => a[0] === "click_text"), [], "the queued click never ran against the new page");
  assert.equal(released, 1);

  // A handback between calls still reaches the next result; a look is allowed.
  await watch.takeOver();
  await watch.handBack();
  const look = await tool.call({ action: "state" }, ctx());
  assert.equal(look.output.status, "ok");
  assert.equal(look.output.ownerTookOver, true);
  assert.match(look.output.note, /Re-read the page/);
  const next = await tool.call({ action: "state" }, ctx());
  assert.equal(next.output.ownerTookOver, undefined, "the notice is delivered once");

  // Bounded: the owner never hands back.
  process.env.ARES_BROWSER_TAKEOVER_WAIT_MS = "40";
  t.after(() => { delete process.env.ARES_BROWSER_TAKEOVER_WAIT_MS; });
  await watch.takeOver();
  const stuck = await tool.call({ action: "click_text", query: "Add to order" }, ctx());
  assert.equal(stuck.output.status, "owner_has_control");
  assert.match(stuck.output.note, /ACTION NOT PERFORMED/);
  await watch.handBack();

  await tool.call({ action: "close" }, ctx());
  const ended = progress.filter((p) => p.kind === "browser_live" && p.state === "ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].sessionId, live[0].sessionId);
  assert.equal(watch.ended, true);
});

test("no garrison hub (plain CLI) → the Browser emits no watch link", async () => {
  setBrowserWatchHub(null);
  const state = newState();
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: HOME, home: HOME }), async () => fakeConnector(state));
  const progress = [];
  await tool.call({ action: "state" }, { sessionId: "s", signal: new AbortController().signal, emitProgress: (d) => progress.push(d) });
  assert.equal(progress.filter((p) => p.kind === "browser_live").length, 0);
});

test("the handback note names what changed", () => {
  const before = { url: "https://a.test/1", title: "One", cookies: 1, fields: [{ name: "q", type: "text", value: "" }], at: "" };
  const after = { url: "https://a.test/1", title: "One", cookies: 1, fields: [{ name: "q", type: "text", value: "tacos" }], at: "" };
  assert.match(describeHandback(before, after), /url is unchanged.*q: "" → "tacos".*Re-read/);
});

// ── 2. checkout review ───────────────────────────────────────────────────────

const RECEIPT = {
  action: "review",
  merchant: "Chipotle via DoorDash",
  items: [{ name: "Burrito Bowl", quantity: 2, price: "$21.90" }, { name: "Chips & Guac", price: "$4.95" }],
  subtotal: "$26.85",
  fees: "$3.99",
  tax: "$2.41",
  tip: "$4.00",
  total: "$37.25",
  paymentMethod: "Visa ••4242",
  deliveryTo: "12 Main St",
};

test("Checkout review is an owner decision carrying the receipt, never answered by an 'always'", async () => {
  const engine = adaptToolForEngine(CheckoutTool, (base) => ({ ...base, permissionMode: "bypass", fileReadStamps: new Map() }));
  const { asked, ctx } = ctxFor("checkout-1", { answer: "allow_always" });
  const approved = await engine.call(RECEIPT, ctx());
  assert.equal(asked.length, 1, "even in bypass/YOLO the owner is asked");
  assert.equal(asked[0].toolName, "Checkout");
  assert.equal(asked[0].ownerDecision, true);
  assert.equal(asked[0].input.total, "$37.25", "the permission request's input IS the receipt");
  assert.equal(asked[0].input.items.length, 2);
  assert.equal(approved.output.approved, true);
  assert.equal(approved.output.total, "$37.25");
  assert.match(approved.output.message, /exactly this order/);
  assert.equal(approvedCheckout("checkout-1").total, "$37.25");

  await engine.call(RECEIPT, ctx());
  assert.equal(asked.length, 2, "'always' was honoured as once — the next checkout asks again");

  const { ctx: denyCtx } = ctxFor("checkout-2", { answer: "deny" });
  await assert.rejects(engine.call(RECEIPT, denyCtx()), (err) => err.name === "PermissionDeniedError");
  assert.equal(approvedCheckout("checkout-2"), null, "a declined review buys nothing");

  // Workspace-write mode's generic prompt must not stand in for the receipt.
  const guarded = adaptToolForEngine(CheckoutTool, (base) => ({ ...base, permissionMode: "workspace-write", fileReadStamps: new Map() }));
  const { asked: guardedAsked, ctx: guardedCtx } = ctxFor("checkout-3");
  await guarded.call(RECEIPT, guardedCtx());
  assert.match(guardedAsked[0].reason, /Approve \$37\.25 at Chipotle via DoorDash/);
  assert.equal(guardedAsked[0].ownerDecision, true);
  assert.ok(CORE_TOOL_NAMES.includes("Checkout"), "not hidden behind ToolSearch");
});

test("Checkout is classified as a purchase and reaches the owner on every surface", () => {
  const request = { toolName: "Checkout", input: RECEIPT, reason: "Approve $37.25 at Chipotle via DoorDash?", ownerDecision: true };
  assert.equal(classifyToolRequest(request), "payment_or_purchase");
  assert.equal(remoteAutonomyDecision(request), "ask");
  assert.equal(decidePermission(request, { mode: "free" }), "ask", "YOLO does not answer it");
  assert.equal(remoteAutonomyDecision({ toolName: "Weather", input: {}, reason: "", ownerDecision: true }), "ask");
  assert.equal(classifyToolRequest({ toolName: "Browser", input: { action: "login" }, reason: "Fill your saved example.com username" }), "credential_or_secret");

  const detail = describePermissionInput(RECEIPT);
  assert.match(detail, /Chipotle via DoorDash/);
  assert.match(detail, /2× Burrito Bowl — \$21\.90/);
  assert.match(detail, /Tip: \$4\.00/);
  assert.match(detail, /TOTAL: \$37\.25/);
  assert.match(detail, /Visa ••4242/);
  const prompt = renderPermissionPrompt({ toolName: "Checkout", reason: request.reason, detail });
  assert.match(prompt, /pay this exact total, once/);
  assert.doesNotMatch(prompt, /stop asking for this tool/);
});

test("placing an order in the Browser needs an approved review whose total is still on the page", async () => {
  const state = newState("https://www.doordash.com/checkout");
  const browser = engineBrowser(state);
  const { ctx } = ctxFor("order-1");

  const blocked = await browser.call({ action: "click_text", query: "Place Order" }, ctx());
  assert.equal(blocked.output.status, "checkout_review_required");
  assert.match(blocked.output.note, /ACTION NOT PERFORMED.*Checkout \{action:"review"\}/);
  assert.deepEqual(state.agent.filter((a) => a[0] === "click_text"), []);

  const act = await browser.call({ action: "act", steps: [{ action: "click", role: "button", name: "Place order" }] }, ctx());
  assert.equal(act.output.status, "checkout_review_required", "an act step is no way around it");

  // Shopping is free: adding to the order, going to checkout.
  await browser.call({ action: "click_text", query: "Add to order" }, ctx());
  assert.deepEqual(state.agent.filter((a) => a[0] === "click_text").map((a) => a[1]), ["Add to order"]);

  recordCheckoutApproval("order-1", { merchant: "Chipotle", total: "$37.25" });
  state.pageText = "Subtotal $26.85 … Total $41.10";
  const grew = await browser.call({ action: "click_text", query: "Place Order" }, ctx());
  assert.equal(grew.output.status, "checkout_total_mismatch");

  state.pageText = "Order total\n$37.25\nPlace Order";
  const placed = await browser.call({ action: "click_text", query: "Place Order" }, ctx());
  assert.equal(placed.output.status, "committed");
  assert.equal(approvedCheckout("order-1"), null, "one review buys one order");
  const again = await browser.call({ action: "click_text", query: "Place Order", allowRepeat: true }, ctx());
  assert.equal(again.output.status, "checkout_review_required");
});

test("what counts as placing an order", () => {
  for (const yes of ["Place order", "Place your order", "Pay now", "Buy now", "Confirm and pay", "Submit order", "Complete purchase", "Book now", "Continue and pay"]) {
    assert.equal(looksLikeOrderSubmission(yes), true, yes);
  }
  for (const no of ["Add to order", "Proceed to checkout", "Checkout", "View cart", "Submit", "Confirm", "Order history", "Track order", "Sign in", undefined]) {
    assert.equal(looksLikeOrderSubmission(no), false, String(no));
  }
  assert.equal(parseAmount("$1,234.50"), 1234.5);
  assert.equal(parseAmount("1.234,50 €"), 1234.5);
  assert.equal(parseAmount("USD 23"), 23);
});

// ── 3. vault logins and secret handles ───────────────────────────────────────

const USERNAME = "owner.person@example.com";
const PASSWORD = "Hunter2-Correct-Horse!";

test("login: 'login:<domain>' is a secure two-field form stored in the vault", async (t) => {
  const service = resolveConnectService("login:https://www.Example.com/signin");
  assert.equal(service.id, "login:example.com");
  assert.equal(service.kind, "api-key");
  assert.deepEqual(service.fields.map((f) => [f.credential, Boolean(f.secret)]), [["login.example.com.username", false], ["login.example.com.password", true]]);
  assert.equal(resolveConnectService("login:amazon.com").id, "login:amazon.com", "not swallowed by the Amazon session flow");
  assert.equal(await isServiceConnected(service, HOME), false);

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-v64-hub-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const hub = new ConnectHub({ publicUrl: () => "https://ares.test", home });
  const base = await serve(t, hub);
  const prompt = await hub.start(resolveConnectService("login:shop.test"));
  const html = await (await fetch(base + localPath(prompt.url))).text();
  assert.match(html, /name="login\.shop\.test\.username" type="text"/);
  assert.match(html, /name="login\.shop\.test\.password" type="password"/);
  assert.match(html, /can&#39;t see or repeat it|can't see or repeat it/);
  const waiting = hub.wait(prompt.flowId, { signal: new AbortController().signal, timeoutMs: 5_000 });
  const saved = await fetch(base + localPath(prompt.url), { method: "POST", body: new URLSearchParams({ "login.shop.test.username": "me@shop.test", "login.shop.test.password": "pw-1234" }) });
  assert.equal(saved.status, 200);
  assert.equal((await waiting).ok, true);
  assert.equal(await getCredential("login.shop.test.password", { home }), "pw-1234");
});

test("Browser login fills the saved login after an approval naming the origin, and never leaks it", async () => {
  await setCredential("login.example.com.username", USERNAME, { home: HOME });
  await setCredential("login.example.com.password", PASSWORD, { home: HOME });
  assert.equal(await isServiceConnected(resolveConnectService("login:example.com"), HOME), true);
  const state = newState("https://www.example.com/login?next=%2Fhome");
  const browser = engineBrowser(state);
  const { asked, progress, ctx } = ctxFor("login-1", { answer: "allow_always" });
  await browser.call({ action: "open", url: state.url }, ctx());

  const result = await browser.call({ action: "login", submit: true }, ctx());
  // After sign-in the page greets the owner by name — page text Ares reads next.
  state.title = `Welcome back ${USERNAME}`;
  await browser.call({ action: "state" }, ctx());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].ownerDecision, true);
  assert.equal(asked[0].reason, "Fill your saved example.com username and password on https://www.example.com/login and sign in?");
  assert.deepEqual(state.filled.map(([sel]) => sel.includes("password") ? "password" : "username"), ["username", "password"]);
  assert.deepEqual(state.filled.map(([, v]) => v), [USERNAME, PASSWORD], "the trusted layer typed the real values");
  assert.equal(result.output.status, "filled");
  assert.deepEqual(result.output.result.filled, ["username", "password"]);
  assert.equal(result.output.result.submitted, true);

  const leaks = (value) => JSON.stringify(value).includes(PASSWORD) || JSON.stringify(value).includes(USERNAME);
  assert.equal(leaks(result), false, "not in output or display");
  assert.equal(leaks(asked), false, "not in the approval");
  assert.equal(leaks(progress), false, "not in progress events");

  // Page-derived text in LATER calls: the model evals the password field.
  state.evalResult = { password: PASSWORD, user: USERNAME };
  const probe = await browser.call({ action: "eval", js: "document.querySelector('[type=password]').value" }, ctx());
  assert.equal(leaks(probe), false);
  assert.match(JSON.stringify(probe.output.result), /•••/);
  state.console = [{ type: "log", text: `debug pw=${encodeURIComponent(PASSWORD)}`, at: "" }];
  assert.equal(leaks(await browser.call({ action: "console" }, ctx())), false);
  assert.doesNotMatch(JSON.stringify(await browser.call({ action: "console" }, ctx())), new RegExp(encodeURIComponent(PASSWORD).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // A past approval doesn't carry over: the next login asks again.
  await browser.call({ action: "login" }, ctx());
  assert.equal(asked.length, 2);

  // An error from the page never carries the value.
  state.failFill = true;
  await assert.rejects(browser.call({ action: "login" }, ctx()), (err) => !err.message.includes(PASSWORD) && !err.message.includes(USERNAME));
  state.failFill = false;

  await sleep(30);
  const audit = JSON.stringify(await readAudit({ home: HOME, limit: 2000 }));
  assert.match(audit, /"action":"browser\.login","target":"https:\/\/www\.example\.com"/);
  assert.equal(audit.includes(PASSWORD) || audit.includes(USERNAME), false, "nor in the audit log");
});

test("Browser login fails closed: nothing saved, not https, or the page moved after approval", async () => {
  const other = newState("https://shop.other.test/login");
  const browser = engineBrowser(other);
  const { asked, ctx } = ctxFor("login-2");
  await browser.call({ action: "open", url: other.url }, ctx());
  await assert.rejects(browser.call({ action: "login" }, ctx()), /No saved login for shop\.other\.test.*login:shop\.other\.test/);
  assert.equal(asked.length, 0, "nothing to approve");

  const plain = newState("http://www.example.com/login");
  const httpBrowser = engineBrowser(plain);
  await httpBrowser.call({ action: "open", url: plain.url }, ctx());
  await assert.rejects(httpBrowser.call({ action: "login" }, ctx()), /non-https/);
  assert.deepEqual(plain.filled, []);

  // Approved on example.com, but a redirect lands elsewhere before the fill.
  const moving = newState("https://www.example.com/login");
  const movingBrowser = engineBrowser(moving);
  const { ctx: movingCtx } = ctxFor("login-3", { answer: () => { moving.url = "https://evil.example.net/login"; return "allow_once"; } });
  await movingBrowser.call({ action: "open", url: moving.url }, ctxFor("login-3").ctx());
  await assert.rejects(movingBrowser.call({ action: "login" }, movingCtx()), /not filled — the page is now https:\/\/evil\.example\.net/);
  assert.deepEqual(moving.filled, []);
});

test("fill_secret redeems a site-bound handle after approval; a foreign or spent handle fails closed", async () => {
  const CODE = "83719264";
  const state = newState("https://accounts.example.com/verify");
  const browser = engineBrowser(state);
  const { asked, progress, ctx } = ctxFor("secret-1");
  await browser.call({ action: "open", url: state.url }, ctx());

  const handle = mintSecretHandle(CODE, { site: "example.com", purpose: "sign-in code" });
  const result = await browser.call({ action: "fill_secret", handle, selector: "#code" }, ctx());
  assert.equal(asked[0].reason, "Fill your example.com sign-in code on https://accounts.example.com/verify?");
  assert.equal(asked[0].ownerDecision, true);
  assert.deepEqual(state.filled, [["#code", CODE]]);
  assert.equal(result.output.status, "filled");
  assert.equal(JSON.stringify([result, asked, progress]).includes(CODE), false);

  await assert.rejects(browser.call({ action: "fill_secret", handle, selector: "#code" }, ctx()), /unknown or expired/, "single-use");
  const foreign = mintSecretHandle("55501234", { site: "bank.test", purpose: "sign-in code" });
  await assert.rejects(browser.call({ action: "fill_secret", handle: foreign, selector: "#code" }, ctx()), /is for bank\.test.*Refusing/);
  assert.equal(state.filled.length, 1);
});

test("fingerprints mask a secret anywhere in text without keeping it", () => {
  const prints = new SecretFingerprints();
  prints.add("s3cret-value");
  assert.equal(prints.redact("a s3cret-value b s3cret-value"), "a ••• b •••");
  assert.equal(prints.redact(`q=${encodeURIComponent("s3cret-value")}`), "q=•••");
  assert.equal(prints.redact("nothing here"), "nothing here");
  assert.doesNotMatch(JSON.stringify(prints), /s3cret/);
});
