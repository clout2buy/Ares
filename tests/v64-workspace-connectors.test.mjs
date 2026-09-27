// Muse-parity connectors: all of Google Workspace on the one "google"
// connection, Outlook through Microsoft Graph, Gmail at Gmail-app parity,
// one-time codes that never reach the model, and the phone's Connections API.
//
// Nothing here talks to Google or Microsoft: fetch is stubbed and every
// assertion is on the request Ares WOULD send (URL, method, body) — checked
// against the providers' published API shapes — or on what it refuses to do.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// The vault resolves its home lazily, so pointing it at a temp dir here —
// before any call — keeps every token and key this file writes out of ~/.ares.
const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-v64-"));
process.env.ARES_HOME = HOME;
test.after(() => fsp.rm(HOME, { recursive: true, force: true }));

const core = await import("../packages/core/dist/index.js");
const tools = await import("../packages/tools/dist/index.js");
const { classifyToolRequest, remoteAutonomyDecision, gateToolPermission } = await import("../packages/cli/dist/policyGate.js");
const { RemoteAgentServer } = await import("../packages/cli/dist/remoteAgentServer.js");

const {
  OAUTH_PROVIDERS, buildAuthorizeUrl, exchangeCodeForTokens, refreshTokens, storeTokens,
  resolveConnectService, CONNECT_SERVICES, serviceDomain, setConnectBroker, setCredential, getCredential,
  browserSessionFile, loadTokens, describeSecretHandle, redeemSecretHandle,
} = core;
const {
  GmailTool, GoogleDriveTool, GoogleDocsTool, GoogleSheetsTool, GoogleSlidesTool, GoogleFormsTool, GoogleTasksTool,
  GoogleContactsTool, OutlookTool, DEFAULT_TOOLS, oneTimeCode, planUnsubscribe, buildRfc2822,
} = tools;

const GOOGLE_OAUTH = OAUTH_PROVIDERS.google;
const CTX = { permissionMode: "workspace-write", signal: new AbortController().signal };

await storeTokens("google", { accessToken: "g-token", expiresAt: Date.now() + 3_600_000 });
await storeTokens("microsoft", { accessToken: "ms-token", expiresAt: Date.now() + 3_600_000 });

const REAL_FETCH = globalThis.fetch;

/** Stub global fetch with an ordered list of [matcher, response] routes. */
function stubFetch(t, routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    for (const [match, respond] of routes) {
      if (typeof match === "string" ? u.includes(match) : match.test(u)) {
        const out = typeof respond === "function" ? respond(u, init) : respond;
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${u}` } }), { status: 404 });
  };
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return calls;
}

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");

// ── scopes, providers, registry ────────────────────────────────────────────

test("one Google consent covers all of Workspace", () => {
  const want = ["drive", "documents", "spreadsheets", "presentations", "forms.body", "forms.responses.readonly", "tasks", "contacts", "gmail.modify", "gmail.send", "calendar"];
  for (const scope of want) assert.ok(GOOGLE_OAUTH.scopes.includes(`https://www.googleapis.com/auth/${scope}`), scope);
  const url = new URL(buildAuthorizeUrl(GOOGLE_OAUTH, { clientId: "cid", redirectUri: "https://ares.test/oauth/callback", state: "s" }));
  assert.match(url.searchParams.get("scope"), /auth\/drive /);
  assert.equal(url.searchParams.get("access_type"), "offline");
});

test("Microsoft is a classic oauth-app provider on the v2 common endpoint", async () => {
  const ms = OAUTH_PROVIDERS.microsoft;
  assert.equal(ms.authorizeUrl, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(ms.tokenUrl, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
  for (const s of ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "Contacts.ReadWrite"]) assert.ok(ms.scopes.includes(s), s);
  const url = new URL(buildAuthorizeUrl(ms, { clientId: "app-id", redirectUri: "https://ares.test/oauth/callback", state: "st" }));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite");
  assert.equal(url.searchParams.get("prompt"), "select_account");

  // Token redemption + refresh: form-encoded, client_secret in the body
  // (client_secret_post), rotated refresh tokens kept.
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push({ u, body: new URLSearchParams(init.body), type: init.headers["content-type"] });
    const rotated = seen.length === 1 ? "rt-1" : "rt-2";
    return new Response(JSON.stringify({ access_token: `at-${seen.length}`, refresh_token: rotated, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
  };
  const first = await exchangeCodeForTokens(ms, { code: "c0de", clientId: "app-id", clientSecret: "s3cret", redirectUri: "https://ares.test/oauth/callback" }, { fetchImpl });
  assert.equal(seen[0].u, ms.tokenUrl);
  assert.equal(seen[0].type, "application/x-www-form-urlencoded");
  assert.equal(seen[0].body.get("grant_type"), "authorization_code");
  assert.equal(seen[0].body.get("client_secret"), "s3cret");
  assert.equal(seen[0].body.get("redirect_uri"), "https://ares.test/oauth/callback");
  const next = await refreshTokens(ms, { refreshToken: first.refreshToken, clientId: "app-id", clientSecret: "s3cret" }, { fetchImpl }, first);
  assert.equal(seen[1].body.get("grant_type"), "refresh_token");
  assert.equal(next.refreshToken, "rt-2", "Microsoft rotates refresh tokens — keep the newest");
});

test("the registry: one Google card for all of Workspace, and Outlook", () => {
  const cases = {
    gmail: "google", "check my email": "google", "google drive": "google", "google sheets": "google",
    "google docs": "google", "google forms": "google", "google tasks": "google",
    outlook: "outlook", hotmail: "outlook", "check my outlook email": "outlook", "office 365": "outlook",
  };
  for (const [asked, id] of Object.entries(cases)) assert.equal(resolveConnectService(asked)?.id, id, asked);
  const google = CONNECT_SERVICES.find((s) => s.id === "google");
  assert.equal(google.label, "Google");
  for (const product of ["Gmail", "Calendar", "Drive", "Docs", "Sheets", "Slides", "Forms", "Tasks", "Contacts"]) assert.match(google.blurb, new RegExp(product));
  const setup = google.appSetup.steps.join(" ");
  for (const api of ["Gmail API", "Google Calendar API", "Google Drive API", "Google Docs API", "Google Sheets API", "Google Slides API", "Google Forms API", "Google Tasks API", "People API"]) assert.ok(setup.includes(api), api);
  const outlook = CONNECT_SERVICES.find((s) => s.id === "outlook");
  assert.equal(outlook.kind, "oauth-app");
  assert.equal(outlook.oauthProvider, "microsoft");
  assert.match(outlook.appSetup.steps.join(" "), /personal Microsoft accounts/);
  assert.match(outlook.appSetup.steps.join(" "), /Web/);
  assert.equal(serviceDomain(outlook), "outlook.live.com");
});

test("the new tools are registered and deferred, never core", () => {
  const names = DEFAULT_TOOLS.map((tool) => tool.schema.name);
  for (const n of ["GoogleDrive", "GoogleDocs", "GoogleSheets", "GoogleSlides", "GoogleForms", "GoogleTasks", "GoogleContacts", "Outlook"]) {
    assert.ok(names.includes(n), n);
    assert.equal(core.isCoreToolName(n), false, `${n} must stay deferred`);
  }
});

// ── Gmail ────────────────────────────────────────────────────────────────

test("send asks with the exact recipient, subject and body; the MIME is safe", async (t) => {
  const decision = await GmailTool.checkPermissions({ action: "send", to: "sam@example.com", subject: "Dinner", body: "7pm at Nopa?" }, CTX);
  assert.equal(decision.kind, "ask");
  assert.match(decision.prompt, /To: sam@example\.com/);
  assert.match(decision.prompt, /Subject: Dinner/);
  assert.match(decision.prompt, /7pm at Nopa\?/);

  const calls = stubFetch(t, [["/messages/send", { id: "m1", threadId: "t1" }]]);
  await GmailTool.call({ action: "send", to: "sam@example.com", subject: "Café\r\nBcc: evil@x.com", body: "hi" }, CTX);
  assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(calls[0].headers.Authorization, "Bearer g-token");
  const raw = decodeRaw(JSON.parse(calls[0].body).raw);
  assert.doesNotMatch(raw, /^Bcc:/m, "a subject can't inject headers");
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, "non-ASCII subjects are RFC 2047 encoded");
});

test("reply threads (In-Reply-To, References, threadId) and the ask names the real recipient", async (t) => {
  const original = {
    id: "orig", threadId: "thr-9",
    payload: { headers: [
      { name: "From", value: "Dana <dana@acme.com>" },
      { name: "To", value: "me@gmail.com, lee@acme.com" },
      { name: "Subject", value: "Q3 plan" },
      { name: "Message-ID", value: "<abc@mail.acme.com>" },
      { name: "References", value: "<zero@mail.acme.com>" },
    ] },
  };
  const calls = stubFetch(t, [
    ["/messages/orig?format=metadata", original],
    ["/profile", { emailAddress: "me@gmail.com" }],
    ["/messages/send", { id: "r1", threadId: "thr-9" }],
  ]);
  const decision = await GmailTool.checkPermissions({ action: "reply", message_id: "orig", body: "Sounds good.", reply_all: true }, CTX);
  assert.match(decision.prompt, /To: Dana <dana@acme\.com>/);
  assert.match(decision.prompt, /Cc: lee@acme\.com/);
  assert.match(decision.prompt, /Subject: Re: Q3 plan/);
  assert.match(decision.prompt, /Sounds good\./);

  await GmailTool.call({ action: "reply", message_id: "orig", body: "Sounds good.", reply_all: true }, CTX);
  const send = calls.find((c) => c.url.endsWith("/messages/send"));
  const payload = JSON.parse(send.body);
  assert.equal(payload.threadId, "thr-9");
  const raw = decodeRaw(payload.raw);
  assert.match(raw, /^In-Reply-To: <abc@mail\.acme\.com>/m);
  assert.match(raw, /^References: <zero@mail\.acme\.com> <abc@mail\.acme\.com>/m);
  assert.match(raw, /^Cc: lee@acme\.com/m, "reply-all drops the owner's own address");
});

test("draft, forward, labels, archive, trash hit the right endpoints", async (t) => {
  const full = { id: "m7", threadId: "t7", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "Invoice" }, { name: "Date", value: "Tue" }, { name: "To", value: "me@gmail.com" }], body: { data: b64url("Amount due: $40") } } };
  const calls = stubFetch(t, [
    ["/drafts", { id: "d1" }],
    ["/messages/m7?format=full", full],
    ["/messages/send", { id: "f1" }],
    ["/labels", { labels: [{ id: "Label_5", name: "Receipts" }, { id: "INBOX", name: "INBOX" }] }],
    ["/modify", {}],
    ["/trash", {}],
  ]);
  await GmailTool.call({ action: "draft", to: "x@y.com", subject: "Hi", body: "draft body" }, CTX);
  assert.ok(calls.at(-1).url.endsWith("/users/me/drafts"));
  assert.match(decodeRaw(JSON.parse(calls.at(-1).body).message.raw), /draft body/);

  await GmailTool.call({ action: "forward", message_id: "m7", to: "acct@firm.com", body: "FYI" }, CTX);
  const fwd = decodeRaw(JSON.parse(calls.at(-1).body).raw);
  assert.match(fwd, /^Subject: Fwd: Invoice/m);
  assert.match(fwd, /FYI[\s\S]*Forwarded message[\s\S]*Amount due: \$40/);

  await GmailTool.call({ action: "add_labels", message_id: "m7", labels: ["receipts"] }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { addLabelIds: ["Label_5"] });
  await GmailTool.call({ action: "archive", message_id: "m7" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { removeLabelIds: ["INBOX"] });
  await GmailTool.call({ action: "trash", message_id: "m7" }, CTX);
  assert.ok(calls.at(-1).url.endsWith("/messages/m7/trash"));
  assert.equal(calls.at(-1).method, "POST");
});

test("unsubscribe: RFC 8058 one-click POST only when offered, else mailto, else the link", async (t) => {
  assert.deepEqual(planUnsubscribe("<mailto:u@list.com?subject=stop>, <https://list.com/u/1>", "List-Unsubscribe=One-Click"), { method: "one-click", target: "https://list.com/u/1" });
  const mailto = planUnsubscribe("<mailto:u@list.com?subject=stop>, <https://list.com/u/1>", "");
  assert.equal(mailto.method, "mailto");
  assert.equal(mailto.mailto.subject, "stop");
  assert.equal(planUnsubscribe("<https://list.com/u/1>", "").method, "link", "a bare link might need a human — never hit blind");
  assert.equal(planUnsubscribe("", "").method, "none");

  const calls = stubFetch(t, [
    ["/messages/n1?format=metadata", { id: "n1", payload: { headers: [
      { name: "From", value: "News <news@shop.com>" },
      { name: "List-Unsubscribe", value: "<https://shop.com/unsub?u=9>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ] } }],
    ["https://shop.com/unsub", new Response("", { status: 200 })],
  ]);
  const ask = await GmailTool.checkPermissions({ action: "unsubscribe", message_id: "n1" }, CTX);
  assert.equal(ask.kind, "ask");
  assert.match(ask.prompt, /News <news@shop\.com>/);
  await GmailTool.call({ action: "unsubscribe", message_id: "n1" }, CTX);
  const post = calls.find((c) => c.url.startsWith("https://shop.com/unsub"));
  assert.equal(post.method, "POST");
  assert.equal(post.body, "List-Unsubscribe=One-Click");
  assert.equal(post.headers.Authorization, undefined, "the Google token never goes to a sender's server");
});

// ── one-time codes ─────────────────────────────────────────────────────────

const { extractCodes, htmlToText, matchesMaskedRecipient, authenticatedFor, registrableDomain } = oneTimeCode;

test("code extraction on real-shaped mail", () => {
  const doordash = "Hi Crix,\n\nYour DoorDash verification code is: 482913\n\nThis code will expire in 10 minutes. If you didn't request it, you can ignore this email.\n\nDoorDash, 303 2nd Street, Suite 800, San Francisco, CA 94107";
  assert.deepEqual(extractCodes(doordash), ["482913"]);
  assert.deepEqual(extractCodes("G-583920 is your Google verification code."), ["583920"]);
  const amazonHtml = '<html><head><style>.x{color:#FF0000}</style></head><body><p>To verify your identity, please use the following code:</p><p style="font-size:24px"><b>731 904</b></p><p>Amazon takes your account security very seriously. Amazon will never email you and ask you to disclose or verify your Amazon password.</p><p>© 2026 Amazon.com</p></body></html>';
  assert.deepEqual(extractCodes(htmlToText(amazonHtml)), ["731904"]);
  assert.deepEqual(extractCodes("Your Uber code is 5821. Never share this code with anyone."), ["5821"]);
  assert.deepEqual(extractCodes("Your login code: 7QK2XM\nIt expires soon."), ["7QK2XM"]);
  assert.deepEqual(extractCodes("Welcome back! Use promo code SAVE20 on your order #99887766. Total $1234.50"), [], "promo codes, order numbers and prices are not sign-in codes");
  assert.deepEqual(extractCodes("Call us at 1-855-973-1040 about your verification."), [], "phone numbers are not codes");
  assert.deepEqual(extractCodes("Your code is 111222. Or use backup code 333444."), ["111222", "333444"], "two codes are reported, so the caller can refuse");
});

test("recipient masks, sender auth, domains", () => {
  assert.ok(matchesMaskedRecipient("crix@gmail.com", "c•••@gmail.com"));
  assert.ok(matchesMaskedRecipient("crix@gmail.com", "c***x@g***.com"));
  assert.ok(!matchesMaskedRecipient("bob@gmail.com", "c•••@gmail.com"));
  assert.ok(!matchesMaskedRecipient("crix@yahoo.com", "c•••@gmail.com"));
  assert.ok(matchesMaskedRecipient("crix@gmail.com", "crix@gmail.com"));
  const pass = "mx.google.com; dkim=pass header.i=@doordash.com header.s=s1; spf=pass smtp.mailfrom=bounce.doordash.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=doordash.com";
  assert.ok(authenticatedFor([pass], "doordash.com"));
  assert.ok(!authenticatedFor(["mx.google.com; dkim=fail header.i=@doordash.com; spf=pass; dmarc=fail header.from=doordash.com"], "doordash.com"));
  assert.ok(!authenticatedFor(["mx.google.com; spf=pass smtp.mailfrom=doordash.com"], "doordash.com"), "SPF alone doesn't authenticate the From");
  assert.equal(registrableDomain("https://identity.doordash.com"), "doordash.com");
  assert.equal(registrableDomain("www.amazon.co.uk"), "amazon.co.uk");
});

const AUTH_OK = (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass; dmarc=pass (p=REJECT) header.from=${d}`;

function mail(id, { from, to = "crix@gmail.com", body, subject = "Your code", auth, ageMs = 60_000 }) {
  const domain = /@([^>]+)>?$/.exec(from)[1];
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.now() - ageMs),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
        { name: "Authentication-Results", value: auth ?? AUTH_OK(domain) },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64url(body) } }],
    },
  };
}

function inbox(t, messages) {
  return stubFetch(t, [
    [/\/messages\?/, { messages: messages.map((m) => ({ id: m.id })) }],
    [/\/messages\/[^/?]+\?format=full/, (u) => messages.find((m) => u.includes(`/messages/${m.id}?`))],
  ]);
}

const CHALLENGE = { action: "find_code", site: "https://www.doordash.com", step: "sign-in", channel: "email", recipient_masked: "c•••@gmail.com" };

test("find_code: one authenticated match → a site-bound single-use handle, never the code", async (t) => {
  const calls = inbox(t, [mail("a1", { from: "DoorDash <no-reply@doordash.com>", body: "Your DoorDash verification code is 482913. It expires in 10 minutes." })]);
  const ask = await GmailTool.checkPermissions(CHALLENGE, CTX);
  assert.equal(ask.kind, "ask");
  assert.match(ask.prompt, /sign-in code https:\/\/www\.doordash\.com emailed to c•••@gmail\.com/);

  const result = await GmailTool.call(CHALLENGE, CTX);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("482913"), "the code must never be in the tool result");
  const { handle, sender, receivedAt, site } = result.output.code;
  assert.match(handle, /^sec_/);
  assert.equal(site, "https://www.doordash.com");
  assert.match(sender, /doordash\.com/);
  assert.ok(Date.parse(receivedAt));

  const q = new URL(calls[0].url).searchParams.get("q");
  assert.match(q, /^from:doordash\.com after:\d+$/, "scoped to the site's sender and the time window");
  const after = Number(/after:(\d+)/.exec(q)[1]);
  assert.ok(Math.abs(Date.now() / 1000 - 600 - after) < 5, "default window is 10 minutes");
  assert.ok(calls.some((c) => c.url.includes("/messages/a1?format=full")), "the message was opened");

  assert.equal(describeSecretHandle(handle).purpose, "sign-in code");
  assert.throws(() => redeemSecretHandle(handle, { site: "https://evil.example" }), /SITE_MISMATCH/);
  assert.equal(redeemSecretHandle(handle, { site: "https://www.doordash.com" }), "482913");
  assert.throws(() => redeemSecretHandle(handle, { site: "https://www.doordash.com" }), /INVALID/, "single use");
});

test("find_code fails closed: forged, look-alike, wrong recipient, stale, subject-only, ambiguous", async (t) => {
  const scenarios = {
    forged: [mail("f", { from: "DoorDash <no-reply@doordash.com>", body: "Your verification code is 111111", auth: "mx.google.com; dkim=fail; spf=softfail; dmarc=fail header.from=doordash.com" })],
    lookalike: [mail("l", { from: "DoorDash <help@doordash-support.com>", body: "Your verification code is 222222" })],
    wrongRecipient: [mail("w", { from: "DoorDash <no-reply@doordash.com>", to: "bob@gmail.com", body: "Your verification code is 333333" })],
    stale: [mail("s", { from: "DoorDash <no-reply@doordash.com>", body: "Your verification code is 444444", ageMs: 20 * 60_000 })],
    subjectOnly: [mail("j", { from: "DoorDash <no-reply@doordash.com>", subject: "555555 is your code", body: "Enter the code from the subject line." })],
    ambiguous: [
      mail("x1", { from: "DoorDash <no-reply@doordash.com>", body: "Your verification code is 666666" }),
      mail("x2", { from: "DoorDash <no-reply@doordash.com>", body: "Your verification code is 777777", ageMs: 30_000 }),
    ],
  };
  for (const [name, messages] of Object.entries(scenarios)) {
    const tt = { after: (fn) => t.after(fn) };
    inbox(tt, messages);
    const result = await GmailTool.call(CHALLENGE, CTX);
    assert.equal(result.output.code, undefined, name);
    assert.match(result.failure, /no unambiguous code; stop and ask the owner/, name);
    for (const m of messages) {
      const code = /\d{6}/.exec(Buffer.from(m.payload.parts[0].body.data, "base64url").toString())?.[0];
      if (code) assert.ok(!JSON.stringify(result).includes(code), `${name}: no code leaks into a failure`);
    }
  }
});

test("find_code refuses without the challenge's facts, before touching mail", async (t) => {
  const calls = stubFetch(t, []);
  const base = { ...CHALLENGE };
  for (const drop of ["site", "step", "channel", "recipient_masked"]) {
    const input = { ...base };
    delete input[drop];
    const r = await GmailTool.call(input, CTX);
    assert.match(r.failure, new RegExp(`refused: missing ${drop}`));
  }
  assert.match((await GmailTool.call({ ...base, site: "http://www.doordash.com" }, CTX)).failure, /https origin/);
  assert.match((await GmailTool.call({ ...base, site: "https://www.doordash.com/login?next=1" }, CTX)).failure, /https origin/);
  assert.match((await GmailTool.call({ ...base, channel: "sms" }, CTX)).failure, /only email/);
  assert.equal(calls.length, 0, "a refused lookup never reads the inbox");
  assert.throws(() => GmailTool.inputZod.parse({ ...base, within_minutes: 60 }), "the window can't be widened past 15 minutes");
});

// ── Workspace request shapes ───────────────────────────────────────────────

test("Drive: search query, export of natives, multipart create, gated share", async (t) => {
  const calls = stubFetch(t, [
    [/\/drive\/v3\/files\?q=/, { files: [{ id: "f1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }] }],
    [/\/files\/f1\/export/, new Response("a,b\n1,2", { status: 200 })],
    [/\/drive\/v3\/files\/f1\?fields/, { id: "f1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }],
    [/upload\/drive\/v3\/files\?uploadType=multipart/, { id: "n1", name: "Notes", mimeType: "application/vnd.google-apps.document" }],
    [/\/permissions/, { id: "p1" }],
  ]);
  await GoogleDriveTool.call({ action: "search", query: "Q3 budget's" }, CTX);
  assert.equal(new URL(calls[0].url).searchParams.get("q"), "(name contains 'Q3 budget\\'s' or fullText contains 'Q3 budget\\'s') and trashed = false");
  const read = await GoogleDriveTool.call({ action: "read", file_id: "f1" }, CTX);
  assert.ok(calls.some((c) => c.url.includes("/files/f1/export?mimeType=text%2Fcsv")), "Sheets export as CSV");
  assert.equal(read.output.text, "a,b\n1,2");
  await GoogleDriveTool.call({ action: "create_file", name: "Notes", content: "hello", kind: "doc" }, CTX);
  const up = calls.at(-1);
  assert.match(up.headers["Content-Type"], /^multipart\/related; boundary=/);
  assert.match(up.body, /"mimeType":"application\/vnd.google-apps.document"/);
  assert.match(up.body, /Content-Type: text\/plain\r\n\r\nhello/);

  const ask = await GoogleDriveTool.checkPermissions({ action: "share", file_id: "f1", email: "sam@x.com", role: "writer" }, CTX);
  assert.equal(ask.kind, "ask");
  assert.match(ask.prompt, /sam@x\.com as writer/);
  await GoogleDriveTool.call({ action: "share", file_id: "f1", email: "sam@x.com", role: "writer" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { type: "user", role: "writer", emailAddress: "sam@x.com" });
  assert.equal((await GoogleDriveTool.checkPermissions({ action: "delete", file_id: "f1" }, CTX)).kind, "ask");
});

test("Docs, Sheets, Slides, Forms, Tasks, Contacts build the documented requests", async (t) => {
  const calls = stubFetch(t, [
    ["docs.googleapis.com/v1/documents/d1:batchUpdate", { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] }],
    ["sheets.googleapis.com/v4/spreadsheets/s1/values/Sheet1!A1%3AC1:append", { updates: { updatedRange: "Sheet1!A5:C5", updatedRows: 1 } }],
    ["slides.googleapis.com/v1/presentations/p1:batchUpdate", {}],
    ["forms.googleapis.com/v1/forms/fm1:batchUpdate", {}],
    ["forms.googleapis.com/v1/forms/fm1:setPublishSettings", {}],
    ["forms.googleapis.com/v1/forms/fm1", { formId: "fm1", info: { title: "RSVP" }, items: [{ title: "Name" }], responderUri: "https://docs.google.com/forms/d/e/x/viewform" }],
    ["tasks.googleapis.com/tasks/v1/lists/%40default/tasks", { id: "tk1", title: "Milk" }],
    ["people.googleapis.com/v1/people:createContact", { resourceName: "people/c1", names: [{ displayName: "Sam Lee" }] }],
  ]);
  const replaced = await GoogleDocsTool.call({ action: "replace", document_id: "d1", find: "TBD", text: "Friday" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body).requests[0], { replaceAllText: { containsText: { text: "TBD", matchCase: true }, replaceText: "Friday" } });
  assert.equal(replaced.output.replaced, 2);
  await GoogleDocsTool.call({ action: "append", document_id: "d1", text: "\nP.S." }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body).requests[0], { insertText: { endOfSegmentLocation: {}, text: "\nP.S." } });

  await GoogleSheetsTool.call({ action: "append", spreadsheet_id: "s1", range: "Sheet1!A1:C1", values: [["2026-09-23", "Coffee", 4.5]] }, CTX);
  assert.match(calls.at(-1).url, /:append\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS$/);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { majorDimension: "ROWS", values: [["2026-09-23", "Coffee", 4.5]] });

  await GoogleSlidesTool.call({ action: "add_slide", presentation_id: "p1", title: "Plan", body: "One\nTwo" }, CTX);
  const [create, title, body] = JSON.parse(calls.at(-1).body).requests;
  assert.equal(create.createSlide.slideLayoutReference.predefinedLayout, "TITLE_AND_BODY");
  assert.deepEqual(create.createSlide.placeholderIdMappings.map((m) => m.layoutPlaceholder.type), ["TITLE", "BODY"]);
  assert.equal(title.insertText.objectId, create.createSlide.placeholderIdMappings[0].objectId);
  assert.equal(body.insertText.text, "One\nTwo");

  await GoogleFormsTool.call({ action: "add_questions", form_id: "fm1", questions: [{ title: "Coming?", type: "multiple_choice", options: ["Yes", "No"], required: true }] }, CTX);
  const item = JSON.parse(calls.at(-1).body).requests[0].createItem;
  assert.equal(item.location.index, 1, "appended after the existing item");
  assert.deepEqual(item.item.questionItem.question, { required: true, choiceQuestion: { type: "RADIO", options: [{ value: "Yes" }, { value: "No" }] } });
  assert.equal((await GoogleFormsTool.checkPermissions({ action: "publish", form_id: "fm1" }, CTX)).kind, "ask");
  await GoogleFormsTool.call({ action: "publish", form_id: "fm1" }, CTX);
  const publish = calls.find((c) => c.url.endsWith(":setPublishSettings"));
  assert.deepEqual(JSON.parse(publish.body), { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } }, updateMask: "publishState" });

  await GoogleTasksTool.call({ action: "add", title: "Milk", due: "2026-09-24" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { title: "Milk", due: "2026-09-24T00:00:00.000Z" });

  await GoogleContactsTool.call({ action: "create", given_name: "Sam", family_name: "Lee", phone: "+1 555 0100" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { names: [{ givenName: "Sam", familyName: "Lee" }], phoneNumbers: [{ value: "+1 555 0100" }] });
  for (const c of calls) assert.equal(c.headers.Authorization, "Bearer g-token");
});

// ── Outlook ────────────────────────────────────────────────────────────────

test("Outlook speaks Microsoft Graph with the Microsoft token", async (t) => {
  const calls = stubFetch(t, [
    ["/me/sendMail", new Response(null, { status: 202 })],
    ["/me/messages/m1/reply", new Response(null, { status: 202 })],
    [/\/me\/messages\/m1\?/, { id: "m1", subject: "Lunch", from: { emailAddress: { name: "Ann", address: "ann@contoso.com" } }, toRecipients: [{ emailAddress: { address: "me@outlook.com" } }] }],
    ["/me/messages/m1/forward", new Response(null, { status: 202 })],
    ["/me/events", { id: "e1", webLink: "https://outlook.live.com/e1" }],
    [/\/me\/messages\?\$search=/, { value: [] }],
  ]);
  const ask = await OutlookTool.checkPermissions({ action: "send", to: "ann@contoso.com", subject: "Lunch", body: "Noon?" }, CTX);
  assert.match(ask.prompt, /To: ann@contoso\.com[\s\S]*Subject: Lunch[\s\S]*Noon\?/);
  await OutlookTool.call({ action: "send", to: "ann@contoso.com, bo@contoso.com", subject: "Lunch", body: "Noon?" }, CTX);
  assert.equal(calls[0].url, "https://graph.microsoft.com/v1.0/me/sendMail");
  assert.equal(calls[0].headers.Authorization, "Bearer ms-token");
  assert.deepEqual(JSON.parse(calls[0].body), {
    message: { subject: "Lunch", body: { contentType: "Text", content: "Noon?" }, toRecipients: [{ emailAddress: { address: "ann@contoso.com" } }, { emailAddress: { address: "bo@contoso.com" } }] },
    saveToSentItems: true,
  });

  const replyAsk = await OutlookTool.checkPermissions({ action: "reply", message_id: "m1", body: "Yes!" }, CTX);
  assert.match(replyAsk.prompt, /To: Ann <ann@contoso\.com>[\s\S]*RE: Lunch[\s\S]*Yes!/);
  await OutlookTool.call({ action: "reply", message_id: "m1", body: "Yes!" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { comment: "Yes!" });
  await OutlookTool.call({ action: "forward", message_id: "m1", to: "cy@x.com", body: "see below" }, CTX);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { comment: "see below", toRecipients: [{ emailAddress: { address: "cy@x.com" } }] });

  await OutlookTool.call({ action: "create_event", title: "Standup", start: "2026-09-24T09:00:00-07:00", attendees: ["ann@contoso.com"] }, CTX);
  const ev = JSON.parse(calls.at(-1).body);
  assert.deepEqual(ev.start, { dateTime: "2026-09-24T16:00:00", timeZone: "UTC" });
  assert.deepEqual(ev.end, { dateTime: "2026-09-24T17:00:00", timeZone: "UTC" });
  assert.deepEqual(ev.attendees, [{ emailAddress: { address: "ann@contoso.com" }, type: "required" }]);

  await OutlookTool.call({ action: "search", query: "invoice" }, CTX);
  assert.match(calls.at(-1).url, /\/me\/messages\?\$search=%22invoice%22&\$top=10/, "literal $-params, quoted search");
});

// ── the gate ───────────────────────────────────────────────────────────────

test("remote autonomy: everything outward asks, private edits run", () => {
  const req = (toolName, action) => ({ toolName, input: { action }, reason: "" });
  const asks = [["Gmail", "send"], ["Gmail", "reply"], ["Gmail", "forward"], ["Gmail", "unsubscribe"], ["Gmail", "trash"], ["Gmail", "find_code"],
    ["Outlook", "send"], ["Outlook", "reply"], ["Outlook", "forward"], ["Outlook", "create_event"],
    ["GoogleDrive", "share"], ["GoogleDrive", "delete"], ["GoogleDrive", "trash"], ["GoogleForms", "publish"]];
  for (const [tool, action] of asks) assert.equal(remoteAutonomyDecision(req(tool, action)), "ask", `${tool} ${action}`);
  const free = [["Gmail", "draft"], ["Gmail", "archive"], ["Gmail", "add_labels"], ["Gmail", "search"], ["GoogleDocs", "replace"],
    ["GoogleSheets", "append"], ["GoogleTasks", "add"], ["GoogleContacts", "create"], ["GoogleDrive", "read"], ["Outlook", "draft"]];
  for (const [tool, action] of free) assert.equal(remoteAutonomyDecision(req(tool, action)), "allow", `${tool} ${action}`);
  assert.equal(classifyToolRequest(req("Gmail", "find_code")), "credential_or_secret");
  assert.equal(gateToolPermission(req("Gmail", "find_code"), { attended: false }).kind, "deny", "never with nobody watching");
  assert.equal(gateToolPermission(req("Gmail", "send"), { attended: false }).kind, "deny");
});

// ── the phone's Connections API ────────────────────────────────────────────

async function server(t) {
  const s = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok" });
  await s.start();
  t.after(() => s.close());
  const base = `http://127.0.0.1:${s.port}`;
  const call = (method, p, body, token = "tok") =>
    fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return call;
}

test("GET /gateway/connections lists every registered service with its state", async (t) => {
  const call = await server(t);
  assert.equal((await call("GET", "/gateway/connections", undefined, "wrong")).status, 401, "bearer-guarded");
  const res = await call("GET", "/gateway/connections");
  assert.equal(res.status, 200);
  const { services } = await res.json();
  const google = services.find((s) => s.id === "google");
  assert.deepEqual(Object.keys(google).sort(), ["blurb", "category", "connected", "domain", "id", "kind", "label"]);
  assert.equal(google.connected, true, "the google token stored above");
  assert.equal(google.label, "Google");
  assert.equal(services.find((s) => s.id === "outlook").connected, true);
  assert.equal(services.find((s) => s.id === "doordash").connected, false);
  assert.equal(services.find((s) => s.id === "stripe").category, "payments");
  assert.ok(!services.some((s) => s.id.startsWith("site:")));
  assert.equal(services.length, CONNECT_SERVICES.length);
});

test("POST /gateway/connections/start hands the broker's link back; 404 / 503 otherwise", async (t) => {
  const call = await server(t);
  assert.equal((await call("POST", "/gateway/connections/start", { service: "outlook" })).status, 503, "no broker installed");
  const started = [];
  setConnectBroker({
    async start(service, opts) {
      started.push({ id: service.id, reason: opts?.reason });
      return { flowId: "flow-1", service: service.id, label: service.label, kind: service.kind, url: "https://ares.test/connect/flow-1", instructions: "Tap to sign in." };
    },
    async wait() { return { ok: true, detail: "" }; },
  });
  t.after(() => setConnectBroker(null));
  const res = await call("POST", "/gateway/connections/start", { service: "outlook" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, "https://ares.test/connect/flow-1");
  assert.equal(body.flowId, "flow-1");
  assert.equal(body.kind, "oauth-app");
  assert.equal(started[0].id, "outlook");
  assert.equal((await call("POST", "/gateway/connections/start", { service: "definitely not a thing" })).status, 404);
  assert.equal((await call("POST", "/gateway/connections/start", {})).status, 400);
});

test("POST /gateway/connections/disconnect removes what each kind stored", async (t) => {
  const call = await server(t);
  // oauth-app: tokens go, the registered app stays (reconnect is one tap).
  await setCredential("SPOTIFY_OAUTH_CLIENT_ID", "cid");
  await storeTokens("spotify", { accessToken: "sp" });
  let res = await call("POST", "/gateway/connections/disconnect", { service: "spotify" });
  assert.deepEqual(await res.json(), { ok: true, service: "spotify", connected: false, removed: true });
  assert.equal(await loadTokens("spotify"), undefined);
  assert.equal(await getCredential("SPOTIFY_OAUTH_CLIENT_ID"), "cid");
  // api-key: every field.
  await setCredential("TWILIO_ACCOUNT_SID", "AC1");
  await setCredential("TWILIO_AUTH_TOKEN", "tok");
  res = await call("POST", "/gateway/connections/disconnect", { service: "twilio" });
  assert.equal((await res.json()).removed, true);
  assert.equal(await getCredential("TWILIO_AUTH_TOKEN"), undefined);
  // browser: the saved session file.
  const file = browserSessionFile("doordash");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, "{}");
  res = await call("POST", "/gateway/connections/disconnect", { service: "doordash" });
  assert.equal((await res.json()).connected, false);
  await assert.rejects(fsp.access(file));
  // mcp: the registry entry.
  await fsp.writeFile(path.join(HOME, "mcp-remote.json"), JSON.stringify({ servers: { linear: { url: "https://mcp.linear.app/mcp", oauth: true } } }));
  res = await call("POST", "/gateway/connections/disconnect", { service: "linear" });
  assert.equal((await res.json()).removed, true);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(HOME, "mcp-remote.json"), "utf8")).servers, {});

  assert.equal((await call("POST", "/gateway/connections/disconnect", { service: "nope nope" })).status, 404);
  assert.equal((await call("POST", "/gateway/connections/disconnect", { service: "spotify" }, "bad")).status, 401);
});

test("the Gmail message builder is exported for the app's previews", () => {
  const raw = decodeRaw(buildRfc2822({ to: "a@b.com", subject: "Hi", body: "x", inReplyTo: "<1@b>", references: "<1@b>" }));
  assert.match(raw, /^In-Reply-To: <1@b>$/m);
  assert.match(raw, /\r\n\r\nx$/);
});
