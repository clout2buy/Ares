// The connected-account presets (Vercel, GitHub, Google, Slack ...): one curated
// file each in packages/tools/src/openapi/presets/. Everything here is TABLE-DRIVEN
// over PRESET_BUNDLES, so a new preset is validated the moment it is on the roster:
// schema, safety classification, network guard, recipes, natural-language search,
// and — against a local stand-in — that its auth recipe puts the token where the
// vendor wants it and never lets it back out.
//
// Offline and deterministic. Whether the operations match the vendor's real spec
// is checked separately, from a machine with internet: scripts/api-preset-verify.mjs
// (results in docs/API-PRESETS.md).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  PRESET_BUNDLES,
  PRESET_ROSTER,
  presetBundle,
  SpecHandle,
  searchOperations,
  searchAllServices,
  classifyApiCall,
  buildRequest,
  resolveAuth,
  executeCall,
  specHandleFor,
  assertUrlAllowed,
  classifyAddress,
  resetRateLimits,
  ApiTool,
} from "../packages/tools/dist/index.js";
import { listApiPresetDefs, resolveApiServiceDef, validateApiId, apiCred, apiPresetDef, API_PRESET_DEFS, resolveConnectService } from "../packages/core/dist/index.js";

const TOKEN = "tok_live_abcdefghijklmnop123456";
const CLIENT_ID = "client-id-0123456789";
const ctx = (permissionMode = "workspace-write") => ({ signal: new AbortController().signal, permissionMode });

/** One subtest per preset, so a failure names the service. */
async function eachPreset(t, fn) {
  for (const bundle of PRESET_BUNDLES) await t.test(bundle.id, () => fn(bundle));
}

const handleOf = (bundle) => new SpecHandle(bundle.spec);
const requiredParams = (op) => Object.fromEntries(op.parameters.filter((p) => p.required && p.schema.default === undefined).map((p) => [p.name, p.schema.type === "integer" || p.schema.type === "number" ? 1 : p.schema.enum?.[0] ?? "example"]));

// ─── the roster ──────────────────────────────────────────────────────────────

test("roster: every authored preset is a rostered id, and the whole roster is authored", () => {
  assert.equal(new Set(PRESET_ROSTER).size, PRESET_ROSTER.length, "no id twice");
  for (const b of PRESET_BUNDLES) assert.ok(PRESET_ROSTER.includes(b.id), `${b.id} is not on the roster in presets/index.ts`);
  assert.deepEqual(PRESET_BUNDLES.map((b) => b.id).sort(), [...PRESET_ROSTER].sort(), "a roster id exports null: that service is not authored yet");
  assert.ok(PRESET_BUNDLES.length >= 1);
});

test("registration: every preset resolves through core, the built-in list is untouched, and no preset shadows another", () => {
  const builtIn = new Set(API_PRESET_DEFS.map((d) => d.id));
  const all = listApiPresetDefs().map((d) => d.id);
  assert.equal(new Set(all).size, all.length, "ids are unique across built-in and connected-account presets");
  for (const b of PRESET_BUNDLES) {
    assert.ok(!builtIn.has(b.id), `${b.id} must not collide with a keyless preset`);
    assert.equal(resolveApiServiceDef(b.id)?.id, b.id);
    assert.equal(apiPresetDef(b.id), b.def);
    assert.ok(specHandleFor(b.def).ops.length > 0);
  }
});

// ─── schema ──────────────────────────────────────────────────────────────────

const DOC_OK = /^[A-Za-z][A-Za-z0-9_.]*$/;
const STYLES = new Set(["token", "next-url", "link", "page", "offset", "last-id"]);
const RISKS = new Set(["read", "write", "message", "destructive", "financial"]);
const AUTH_TYPES = new Set(["bearer", "apiKey", "basic", "oauth2cc", "none"]);

test("schema: every preset is complete and well-formed", async (t) => {
  await eachPreset(t, (b) => {
    assert.deepEqual(b.problems, [], `assembly problems: ${b.problems.join("; ")}`);
    const { def } = b;
    assert.equal(validateApiId(def.id), null, "a valid service id");
    assert.ok(def.label.length >= 3 && def.label.length <= 60, "label");
    assert.ok(def.blurb.length >= 30 && def.blurb.length <= 320, `blurb is a sentence or two (${def.blurb.length})`);
    assert.ok(AUTH_TYPES.has(def.auth.type), "auth type");
    assert.notEqual(def.auth.type, "none", "a connected-account service authenticates");
    if (def.oauth) assert.ok(def.oauth.connect && /^[a-z0-9:-]+$/.test(def.oauth.connect), "the registry id to Connect");
    else assert.ok(def.baseUrlField || def.auth.type !== "none", "a form-connected service has fields");
    assert.ok(def.baseUrl || def.baseUrlField, "a base URL, or a field for the owner to type it");
    assert.ok(def.ratePerMin >= 1 && def.ratePerMin <= 600, "a rate limit the call layer enforces");
    assert.equal(def.specSource.kind, "preset");
    assert.ok(def.headers && def.headers["user-agent"], "a User-Agent (GitHub and Reddit refuse calls without one)");
    for (const name of Object.keys(def.headers)) assert.ok(!/authorization|cookie|token|secret|key/i.test(name), `fixed header ${name} must not carry a credential`);

    // provenance and notes
    assert.match(b.source.fetchedOn, /^2026-(09-[23]\d|10-\d\d)$/, "fetchedOn is the day the spec/docs were checked");
    assert.match(b.source.docsUrl, /^https:\/\//);
    assert.ok(["vendor-openapi", "discovery", "graphql-schema", "docs"].includes(b.source.kind));
    if (b.source.kind !== "docs") assert.match(b.source.specUrl ?? "", /^https:\/\//, "a spec-derived preset names its spec URL");
    for (const u of b.source.specUrls ?? []) assert.match(u, /^https:\/\//);
    assert.ok(b.notes.rateLimits.length > 15 && b.notes.auth.length > 15, "rate-limit and auth notes");

    // the spec
    const handle = handleOf(b);
    assert.ok(handle.ops.length >= 6, `${handle.ops.length} operations: a useful preset has at least 6`);
    assert.ok(handle.ops.length <= 260, `${handle.ops.length} operations: curate, do not mirror the whole API`);
    const ids = new Set();
    for (const entry of handle.ops) {
      assert.match(entry.id, DOC_OK, `operationId ${entry.id}`);
      assert.ok(!ids.has(entry.id), `duplicate operationId ${entry.id}`);
      ids.add(entry.id);
      assert.ok(entry.summary.length >= 12, `${entry.id} has a real summary`);
      assert.ok(entry.summary.length <= 260, `${entry.id}: summary too long`);
      const op = handle.operation(entry.id);
      const seen = new Set();
      for (const p of op.parameters) {
        assert.ok(!/^authorization$/i.test(p.name), `${entry.id} must not expose the Authorization header as a parameter`);
        assert.ok(!seen.has(`${p.in}:${p.name}`), `${entry.id}: parameter ${p.name} twice`);
        seen.add(`${p.in}:${p.name}`);
        assert.ok(p.description || p.schema.enum || p.schema.default !== undefined, `${entry.id}.${p.name} is documented`);
      }
      for (const m of op.path.matchAll(/\{([^}#]+)\}/g)) assert.ok(op.parameters.some((p) => p.in === "path" && p.name === m[1]), `${entry.id}: path variable {${m[1]}} has a parameter`);
      for (const p of op.parameters.filter((x) => x.in === "path")) assert.ok(op.path.includes(`{${p.name}}`), `${entry.id}: path parameter ${p.name} is in the path`);
      if (op.ext?.risk) assert.ok(RISKS.has(op.ext.risk), `${entry.id}: risk ${op.ext.risk}`);
      for (const k of op.ext?.keywords ?? []) assert.ok(typeof k === "string" && k.length >= 3, `${entry.id}: keyword`);
      if (op.ext?.paginate) {
        const pag = op.ext.paginate;
        assert.ok(STYLES.has(pag.style), `${entry.id}: paging style ${pag.style}`);
        assert.equal(typeof pag.items, "string", `${entry.id}: paging names the items path (\"\" for a bare array)`);
        if (pag.style === "token") assert.ok(pag.param && pag.next, `${entry.id}: token paging needs param and next`);
        if (pag.style === "next-url") assert.ok(pag.next, `${entry.id}: next-url paging needs next`);
        if (pag.style === "page" || pag.style === "offset" || pag.style === "last-id") assert.ok(pag.param, `${entry.id}: ${pag.style} paging needs param`);
        if (pag.limitParam) assert.ok(op.parameters.some((p) => p.name === pag.limitParam) || op.ext.graphql, `${entry.id}: limitParam ${pag.limitParam} is a declared parameter`);
        if (pag.param && !pag.body && !op.ext.graphql) assert.ok(op.parameters.some((p) => p.name === pag.param) || pag.style === "link" || pag.style === "next-url", `${entry.id}: paging parameter ${pag.param} is declared`);
      }
      if (op.ext?.message) assert.ok(op.ext.message.text?.length, `${entry.id}: a message operation says where its text is`);
      if (op.ext?.graphql && !op.ext.graphql.raw) assert.match(op.ext.graphql.query, /\{/, `${entry.id}: a GraphQL document`);
    }

    // the connect form's live check
    const verify = handle.operation(def.verifyOperationId);
    assert.ok(verify, `verifyOperationId ${def.verifyOperationId} is an operation`);
    assert.equal(classifyApiCall(def.id, def.verifyOperationId).kind, "read", "the verify call is a read");
    assert.deepEqual(Object.keys(requiredParams(verify)), [], "the verify call needs no parameters (the connect form calls it with none)");
  });
});

test("schema: no credential-shaped text is baked into any preset", async (t) => {
  const SECRET = /\b(sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|AKIA[0-9A-Z]{16})\b/;
  await eachPreset(t, (b) => {
    const text = JSON.stringify([b.def, b.spec, b.recipes, b.notes]);
    assert.ok(!SECRET.test(text), "a real-looking secret is in the preset");
    assert.ok(!/api[_-]?key=[A-Za-z0-9]{12,}/i.test(text), "an api key in a URL");
  });
});

// ─── network guard ───────────────────────────────────────────────────────────

test("netGuard: every host a preset can reach is a public https host", async (t) => {
  await eachPreset(t, (b) => {
    const urls = [b.def.baseUrl, ...(b.def.extraOrigins ?? [])].filter(Boolean);
    for (const row of Object.values(b.spec.paths).flatMap((item) => Object.values(item))) for (const s of row.servers ?? []) urls.push(s.url);
    assert.ok(urls.length >= (b.def.baseUrl ? 1 : 0));
    for (const raw of urls) {
      const url = new URL(raw);
      assert.equal(url.protocol, "https:", `${raw} must be https`);
      assert.doesNotThrow(() => assertUrlAllowed(url, { allowLan: false }), `${raw} must pass the network guard with the LAN closed`);
      const host = url.hostname;
      assert.ok(!/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata.*)$/i.test(host), `${host} is not a public name`);
      assert.ok(host.includes("."), `${host} is a real domain`);
      if (/^[\d.]+$/.test(host) || host.includes(":")) assert.equal(classifyAddress(host), "public", `${host} literal must be public`);
      assert.ok(!url.username && !url.password, "no credentials in a URL");
      assert.ok(!url.search, "no query string in a base URL");
    }
    // an operation may only name a host the def lists as an extra origin
    const allowed = new Set([b.def.baseUrl, ...(b.def.extraOrigins ?? [])].filter(Boolean).map((u) => new URL(u).origin));
    for (const row of Object.values(b.spec.paths).flatMap((item) => Object.values(item))) for (const s of row.servers ?? []) assert.ok(allowed.has(new URL(s.url).origin), `${s.url} is not declared in extraOrigins`);
    if (b.def.baseUrlField) assert.ok(b.def.baseUrlField.label, "a per-tenant host is typed by the owner into the secure form");
  });
});

// ─── risk classification ─────────────────────────────────────────────────────

// An id that STARTS with one of these verbs does something. It may never be classed as a read.
const WRITE_VERB = /^(create|update|delete|send|post|publish|remove|add|set|write|move|copy|insert|patch|trash|untrash|archive|unarchive|cancel|refund|revoke|upload|reply|forward|comment|follow|unfollow|like|unlike|mark|assign|invite|share|unshare|rename|restore|redeploy|rollback|promote|start|stop|pause|resume|play|skip|seek|transfer|toggle|enable|disable|connect|disconnect|subscribe|unsubscribe|submit|approve|reject|merge|close|reopen|lock|unlock|block|unblock|pin|unpin|star|unstar|edit|modify|replace|reset|clear|empty|purge|import|install|uninstall|schedule|reschedule|accept|decline|dismiss|snooze|label|unlabel|tag|untag|attach|detach|link|unlink|grant|deny|execute|run|trigger|dispatch|rerun|retry|rotate|regenerate|renew|extend|capture|charge|pay|void|batchUpdate|clone|fork|duplicate|save|unsave|queue|shuffle|repeat|volume|transferPlayback)\w*/i;
// A POST that merely reads says so in its name.
const READ_VERB = /^(search|query|list|get|fetch|find|read|lookup|batchGet|check|count|export|describe|show|view|preview|resolve|suggest|validate|verify|introspect|graphql|filter|retrieve|poll|download)/i;
const MUST_BE_DESTRUCTIVE = /^(delete|destroy|purge|revoke|terminate|wipe|erase|cancel|disconnect|deactivate|remove|trash|archive|clear|empty)/i;
const MUST_BE_FINANCIAL = /^(refund|charge|payout|purchase|buy|checkout|withdraw|deposit|pay|capture|transferFunds|createCharge|createPayment|createInvoice|createSubscription|createRefund|createPayout)/i;
const MESSAGE_ID = /^(send|reply|forward|publish|tweet|post(Message|Comment|Reply|Status|Tweet|ChatMessage)|(create|add|post)(Chat)?(Message|Comment|Reply|Status|Post|Tweet|Review))/i;

test("risk: the table of every operation is classified by method first, then by what a reviewer declared", async (t) => {
  await eachPreset(t, (b) => {
    const handle = handleOf(b);
    const counts = { read: 0, write: 0, message: 0, destructive: 0, financial: 0 };
    for (const entry of handle.ops) {
      const op = handle.operation(entry.id);
      const cls = classifyApiCall(b.id, entry.id, {}, undefined, entry.ext?.graphql?.raw ? { query: "{ viewer { id } }" } : undefined);
      assert.notEqual(cls.kind, "unknown", `${entry.id} resolves`);
      const readMethod = entry.method === "GET" || entry.method === "HEAD";
      if (cls.kind === "read") {
        counts.read++;
        // the invariant: nothing that does something is ever classed as a read
        assert.ok(!WRITE_VERB.test(entry.id) || READ_VERB.test(entry.id), `${entry.id} reads like a change but is classed as a read`);
        if (!readMethod) {
          assert.equal(entry.ext?.risk ?? "read", "read", `${entry.id}: a ${entry.method} is a read only when declared`);
          assert.ok(entry.ext?.risk === "read" || entry.ext?.graphql, `${entry.id}: a ${entry.method} read must carry x-ares-risk: read`);
          assert.ok(READ_VERB.test(entry.id), `${entry.id}: a ${entry.method} that reads must be named like a read (search/query/list/get/...)`);
        }
      } else {
        assert.equal(cls.kind, "write");
        assert.ok(entry.ext?.risk || entry.method === "DELETE", `${entry.id}: a ${entry.method} must declare its risk (x-ares-risk)`);
        if (cls.financial) counts.financial++;
        else if (cls.destructive) counts.destructive++;
        else if (cls.message) counts.message++;
        else counts.write++;
        if (entry.method === "DELETE") assert.ok(cls.destructive, `${entry.id}: a DELETE is destructive`);
      }
      if (MUST_BE_DESTRUCTIVE.test(entry.id)) assert.ok(cls.kind === "write" && (cls.destructive || cls.financial), `${entry.id} is destructive and must be the owner's decision`);
      if (MUST_BE_FINANCIAL.test(entry.id)) assert.ok(cls.kind === "write" && cls.financial, `${entry.id} moves money and must be classed financial`);
      if (MESSAGE_ID.test(entry.id) && entry.method !== "GET") assert.ok(cls.message, `${entry.id} sends words to people and must be a message (x-ares-risk: message)`);
      if (cls.message) assert.ok(op.ext.message?.text?.length, `${entry.id}: the owner's prompt needs to know where the words are`);
      if (cls.message) assert.ok(!cls.destructive && !cls.financial, `${entry.id}: a message is classed by its words`);
      // a read has no body-changing risk declared on a GET
      if (readMethod && entry.ext?.risk && entry.ext.risk !== "read") assert.equal(cls.kind, "write", `${entry.id}: a GET declared ${entry.ext.risk} is a write`);
    }
    assert.ok(counts.read > 0, "a preset has reads");
  });
});

test("risk: a write is never free, a delete is always the owner's decision, a message shows its exact text", async () => {
  const bundle = PRESET_BUNDLES[0];
  // the Vercel exemplar: redeploy asks, remove-domain is a decision
  const vercel = presetBundle("vercel");
  if (!vercel) return;
  assert.equal(classifyApiCall("vercel", "listDeployments").kind, "read");
  const redeploy = classifyApiCall("vercel", "createDeployment");
  assert.equal(redeploy.kind, "write");
  assert.equal(redeploy.destructive, false);
  assert.equal(classifyApiCall("vercel", "removeProjectDomain").destructive, true);
  assert.equal(classifyApiCall("vercel", "cancelDeployment").destructive, true);
  const permit = (input, mode) => ApiTool.checkPermissions(ApiTool.inputZod.parse(input), ctx(mode));
  assert.equal((await permit({ action: "call", service: "vercel", operationId: "listProjects" }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "call", service: "vercel", operationId: "createDeployment", body: { name: "x" } }, "plan")).kind, "deny");
  const del = await permit({ action: "call", service: "vercel", operationId: "removeProjectDomain", params: { idOrName: "a", domain: "b.com" } }, "bypass");
  assert.equal(del.ownerDecision, true, "the owner decides a delete even when everything else is bypassed");
  void bundle;
});

// ─── recipes and natural-language search ─────────────────────────────────────

test("recipes: 3 to 6 per service, every step names a real operation and passes that operation's own parameter rules", async (t) => {
  await eachPreset(t, (b) => {
    assert.ok(b.recipes.length >= 3 && b.recipes.length <= 6, `${b.recipes.length} recipes: write 3-6`);
    const handle = handleOf(b);
    const asks = new Set();
    for (const r of b.recipes) {
      assert.ok(r.ask.length >= 8 && r.ask.length <= 120, `ask: ${r.ask}`);
      assert.ok(!asks.has(r.ask), `duplicate recipe ${r.ask}`);
      asks.add(r.ask);
      assert.ok(r.steps.length >= 1 && r.steps.length <= 5, `${r.ask}: 1-5 steps`);
      for (const step of r.steps) {
        const op = handle.operation(step.op);
        assert.ok(op, `recipe "${r.ask}" names ${step.op}, which is not an operation of ${b.id}`);
        // the example parameters and body must be acceptable to the real request builder
        const def = { ...b.def };
        const auth = { headers: {}, query: [], cookies: [], secrets: [], headerNames: [], queryNames: [] };
        let built;
        assert.doesNotThrow(() => {
          built = buildRequest({ def, op, baseUrl: def.baseUrl ?? "https://tenant.example.com", params: step.params ?? {}, body: step.body, auth });
        }, `recipe "${r.ask}" step ${step.op}: parameters rejected`);
        assert.ok(built.url.startsWith("https://"));
        if (step.fields) assert.match(step.fields, /^[A-Za-z0-9_.*,\s-]+$/, "fields is a comma list of dotted names");
        if (step.select) assert.match(step.select, /^[A-Za-z0-9_.*:\[\]-]+$/, "select is a dotted path");
      }
    }
  });
});

test("search: a person's words find the right operation, within one service and across all of them", async (t) => {
  await eachPreset(t, (b) => {
    const handle = handleOf(b);
    for (const [query, expected] of b.searchChecks) {
      assert.ok(handle.has(expected), `searchCheck names ${expected}, which is not an operation`);
      const top = searchOperations(handle.ops, query).hits.map((h) => h.id);
      assert.ok(top.slice(0, 3).includes(expected), `"${query}" should surface ${expected} in the top 3, got ${top.slice(0, 5).join(", ")}`);
    }
    // a recipe's own question finds (one of) its operations
    for (const r of b.recipes) {
      const top = searchOperations(handle.ops, r.ask, { limit: 6 }).hits.map((h) => h.id);
      assert.ok(r.steps.some((s) => top.includes(s.op)), `"${r.ask}" should surface one of ${r.steps.map((s) => s.op).join(", ")}; got ${top.join(", ")}`);
    }
  });
});

test("search across services: asking in plain words lands on the right service, and says if it is connected", async () => {
  for (const b of PRESET_BUNDLES) {
    const r = b.recipes[0];
    const { hits } = await searchAllServices(r.ask, { limit: 12 });
    assert.ok(hits.some((h) => h.service === b.id), `across all services "${r.ask}" should reach ${b.id}; got ${hits.map((h) => `${h.service}.${h.operationId}`).join(", ")}`);
  }
  const { hits } = await searchAllServices("weather forecast for coordinates", { limit: 3 });
  assert.equal(hits[0].service, "open-meteo", "the keyless presets are searched too");
});

// ─── auth: the token goes where the vendor wants it, and never back out ──────

function fakeCreds(map) {
  return { get: async (name) => map[name] };
}

function expectedCredentialHeaders(def) {
  const out = {};
  const a = def.auth;
  if (a.type === "bearer") {
    const header = (a.header ?? "authorization").toLowerCase();
    out[header] = a.template ? a.template.split("{token}").join(TOKEN).split("{CLIENT_ID}").join(CLIENT_ID) : `${a.scheme ?? "Bearer"} ${TOKEN}`.trim();
  } else if (a.type === "apiKey" && a.in === "header") out[a.name.toLowerCase()] = TOKEN;
  for (const [n, tpl] of Object.entries(def.authHeaders ?? {})) out[n.toLowerCase()] = tpl.split("{CLIENT_ID}").join(CLIENT_ID);
  return out;
}

test("auth: each preset's recipe puts the connected token in exactly the header the vendor wants", async (t) => {
  await eachPreset(t, async (b) => {
    const def = b.def;
    const creds = fakeCreds({ [apiCred(def.id, "KEY")]: TOKEN, [apiCred(def.id, "CLIENT_ID")]: CLIENT_ID });
    const auth = await resolveAuth(def, { creds });
    const expected = expectedCredentialHeaders(def);
    if (def.auth.type === "apiKey" && def.auth.in === "query") assert.deepEqual(auth.query, [[def.auth.name, TOKEN]]);
    for (const [name, value] of Object.entries(expected)) assert.equal(auth.headers[name], value, `${b.id}: header ${name}`);
    assert.ok(auth.secrets.includes(TOKEN), "the token is on the scrub list");
    for (const name of Object.keys(expected)) assert.ok(auth.headerNames.includes(name), `${name} is treated as a credential header (stripped on a cross-origin redirect)`);
    // unconnected: one sentence that says how to fix it
    await assert.rejects(() => resolveAuth(def, { creds: fakeCreds({}) }), (err) => {
      if (def.oauth) {
        assert.match(err.message, /not connected - Connect service "/, `${b.id}: ${err.message}`);
        assert.match(err.message, new RegExp(`Connect service "${def.oauth.connect.replace(/[-]/g, "\\-")}"`));
      } else {
        // a form-connected preset (shopify, mailchimp, trello, cloudflare): its own secure form is the way in
        assert.match(err.message, /has no access token stored\. Connect it first: call Connect with service "/, `${b.id}: ${err.message}`);
        assert.ok(err.message.includes(`"api-${def.id}"`), `${b.id}: names its api-${def.id} form`);
      }
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
  });
});

/** A stand-in for the vendor: records what it was sent and echoes the credential back, to prove the scrubbing. */
async function startVendor(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: { authorization: req.headers.authorization, all: JSON.stringify(req.headers), url: req.url }, items: [{ id: 1 }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("auth against a local stand-in: every preset's verify call carries the credential, the answer never shows it, one scheme at a time", async (t) => {
  const vendor = await startVendor(t);
  resetRateLimits();
  await eachPreset(t, async (b) => {
    // the real definition, pointed at the stand-in (LAN allowed for this test only)
    const def = { ...b.def, baseUrl: vendor.url, baseUrlField: undefined, extraOrigins: [], allowLan: true };
    const handle = handleOf(b);
    const op = handle.operation(def.verifyOperationId);
    const creds = fakeCreds({ [apiCred(def.id, "KEY")]: TOKEN, [apiCred(def.id, "CLIENT_ID")]: CLIENT_ID });
    const auth = await resolveAuth(def, { creds });
    const built = buildRequest({ def, op, baseUrl: vendor.url, params: requiredParams(op), auth });
    resetRateLimits();
    const before = vendor.seen.length;
    const res = await executeCall(def, op, built, auth, { creds }, {});
    assert.equal(vendor.seen.length, before + 1);
    const request = vendor.seen.at(-1);
    for (const [name, value] of Object.entries(expectedCredentialHeaders(def))) assert.equal(request.headers[name], value, `${b.id}: the stand-in received ${name}`);
    if (def.auth.type === "apiKey" && def.auth.in === "query") assert.ok(request.url.includes(`${def.auth.name}=${TOKEN}`));
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(TOKEN), `${b.id}: the token came back out in the answer`);
    assert.ok(!res.url.includes(TOKEN), "nor in the URL shown");
    assert.ok(!JSON.stringify(res.headers).includes(TOKEN));
    if (res.data?.echo?.all) assert.ok(res.data.echo.all.includes("[redacted"), "the echoed credential was scrubbed");
  });
});

test("connect cards: a connected-account preset adds no form of its own; a form preset adds exactly one", () => {
  for (const b of PRESET_BUNDLES) {
    const card = resolveConnectService(`api-${b.id}`);
    if (b.def.oauth) {
      assert.ok(!card || card.id !== `api-${b.id}`, `${b.id} is connected through "${b.def.oauth.connect}", not an api-${b.id} form`);
    } else {
      assert.equal(card?.id, `api-${b.id}`, `${b.id} is connected through its own secure form`);
    }
  }
});
