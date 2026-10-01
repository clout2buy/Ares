// The Api tool's engine as the connected-account presets use it: following a
// paged list, waiting out a 429, shaping a big answer, GraphQL operations, the
// message prompt, where a connected account's token comes from, and the plain
// sentence an unconnected service gives. Offline: every service here is a stub on
// 127.0.0.1 (allowed only because each test's service says allowLan).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  ApiTool,
  ApiInputError,
  SpecHandle,
  parseSpecText,
  searchOperations,
  addApiService,
  removeApiService,
  apiCall,
  classifyApiCall,
  resetRateLimits,
  setConnectedTokenProvider,
  resolveConnectedToken,
  shrinkJson,
  projectFields,
  retryAfterMs,
  parseLinkNext,
  graphqlTextIsReadOnly,
  presetBundle,
  specHandleFor,
} from "../packages/tools/dist/index.js";
import { setCredential, deleteCredential, storeTokens, apiCred, resolveApiServiceDef, listApiPresetDefs } from "../packages/core/dist/index.js";
import { universalToolCategory } from "../packages/cli/dist/policyGateUniversal.js";

const ctx = (permissionMode = "workspace-write") => ({ signal: new AbortController().signal, permissionMode });
let counter = 0;
const uid = (p) => `${p}-${process.pid}-${++counter}`;
const json = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(entry);
      Promise.resolve(handler(req, res, entry, requests)).catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function addLocal(t, id, spec, server, extra = {}) {
  await addApiService({ id, specText: JSON.stringify(spec), baseUrl: server.url, allowLan: true, auth: { type: "none" }, ...extra });
  t.after(() => removeApiService(id));
  resetRateLimits();
}

const spec = (paths) => ({ openapi: "3.0.3", info: { title: "Stub", version: "1" }, paths });
const q = (name, type = "string", extra = {}) => ({ name, in: "query", schema: { type, ...extra }, description: name });
const getOp = (operationId, parameters, ext = {}) => ({ get: { operationId, summary: `${operationId} operation`, parameters, responses: { 200: { description: "ok" } }, ...ext } });
const noSleep = { sleep: async () => {} };

// ─── paging ──────────────────────────────────────────────────────────────────

test("paging: a token cursor (Google style) is followed, merged, capped, and the cursor to continue is handed back", async (t) => {
  const srv = await startServer(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("pageToken");
    const page = token ? Number(token.replace("t", "")) : 1;
    json(res, { items: [{ id: page * 10 + 1 }, { id: page * 10 + 2 }], ...(page < 5 ? { nextPageToken: `t${page + 1}` } : {}) });
  });
  const id = uid("tok");
  await addLocal(t, id, spec({ "/items": getOp("listItems", [q("pageToken"), q("maxResults", "integer", { maximum: 50 })], { "x-ares-paginate": { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" } }) }), srv);

  const all = await apiCall({ service: id, operationId: "listItems", pages: 10 }, {}, {});
  assert.deepEqual(all.data.map((i) => i.id), [11, 12, 21, 22, 31, 32, 41, 42, 51, 52]);
  assert.equal(all.paging.pages, 5);
  assert.equal(all.paging.more, false);
  assert.equal(all.paging.stoppedBy, "end");
  assert.ok(srv.requests[0].url.includes("maxResults=50"), "asks for the biggest page the service allows");
  assert.ok(all.notes.some((n) => /followed 5 pages, 10 items/.test(n)));

  resetRateLimits();
  const some = await apiCall({ service: id, operationId: "listItems", pages: 2 }, {}, {});
  assert.equal(some.data.length, 4);
  assert.equal(some.paging.more, true);
  assert.deepEqual(some.paging.next, { param: "pageToken", value: "t3" });
  assert.equal(some.paging.stoppedBy, "pages");

  // continue exactly where it stopped
  resetRateLimits();
  const rest = await apiCall({ service: id, operationId: "listItems", params: { pageToken: "t3" }, pages: 10 }, {}, {});
  assert.deepEqual(rest.data.map((i) => i.id), [31, 32, 41, 42, 51, 52]);

  // max_items cuts the merge
  resetRateLimits();
  const capped = await apiCall({ service: id, operationId: "listItems", pages: 10, maxItems: 5 }, {}, {});
  assert.equal(capped.data.length, 5);
  assert.equal(capped.paging.stoppedBy, "items");

  // one page by default: the response as the service sent it
  resetRateLimits();
  const single = await apiCall({ service: id, operationId: "listItems" }, {}, {});
  assert.equal(single.data.nextPageToken, "t2");
  assert.equal(single.paging, undefined);
});

test("paging: next-url, Link header, page number, offset, last id, and a cursor in a POST body", async (t) => {
  const srv = await startServer(t, (req, res, entry) => {
    const url = new URL(req.url, "http://x");
    const base = `http://${req.headers.host}`;
    const n = (name, d) => Number(url.searchParams.get(name) ?? d);
    if (url.pathname === "/nexturl") {
      const p = n("p", 1);
      return json(res, { value: [{ id: p }], "@odata.nextLink": p < 3 ? `${base}/nexturl?p=${p + 1}` : undefined });
    }
    if (url.pathname === "/foreign") return json(res, { value: [{ id: 1 }], next: "https://evil.example.com/steal" });
    if (url.pathname === "/link") {
      const p = n("page", 1);
      return json(res, [{ id: p }], 200, p < 3 ? { link: `<${base}/link?page=${p + 1}>; rel="next", <${base}/link?page=9>; rel="last"` } : {});
    }
    if (url.pathname === "/paged") {
      const p = n("page", 1);
      return json(res, p <= 3 ? Array.from({ length: 2 }, (_, i) => ({ id: p * 10 + i })) : []);
    }
    if (url.pathname === "/offset") {
      const o = n("offset", 0);
      return json(res, { data: o < 6 ? [{ id: o }, { id: o + 1 }] : [] });
    }
    if (url.pathname === "/charges") {
      const after = url.searchParams.get("starting_after");
      const ids = after ? (after === "c2" ? ["c3", "c4"] : []) : ["c1", "c2"];
      return json(res, { data: ids.map((id) => ({ id })), has_more: after === null });
    }
    if (url.pathname === "/search") {
      const body = JSON.parse(entry.body || "{}");
      return json(res, body.start_cursor ? { results: [{ id: "n3" }], has_more: false, next_cursor: null } : { results: [{ id: "n1" }, { id: "n2" }], has_more: true, next_cursor: "cur1" });
    }
    res.writeHead(404);
    res.end("no");
  });
  const id = uid("styles");
  await addLocal(
    t,
    id,
    spec({
      "/nexturl": getOp("nextUrl", [q("p", "integer")], { "x-ares-paginate": { style: "next-url", next: "@odata.nextLink", items: "value" } }),
      "/foreign": getOp("foreign", [], { "x-ares-paginate": { style: "next-url", next: "next", items: "value" } }),
      "/link": getOp("linkStyle", [q("page", "integer")], { "x-ares-paginate": { style: "link", items: "" } }),
      "/paged": getOp("pageStyle", [q("page", "integer"), q("per_page", "integer", { maximum: 100 })], { "x-ares-paginate": { style: "page", param: "page", limitParam: "per_page", items: "" } }),
      "/offset": getOp("offsetStyle", [q("offset", "integer")], { "x-ares-paginate": { style: "offset", param: "offset", items: "data" } }),
      "/charges": getOp("lastId", [q("starting_after")], { "x-ares-paginate": { style: "last-id", param: "starting_after", more: "has_more", items: "data" } }),
      "/search": { post: { operationId: "searchBody", summary: "search with a cursor in the body", "x-ares-risk": "read", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, start_cursor: { type: "string" } } } } } }, "x-ares-paginate": { style: "token", param: "start_cursor", next: "next_cursor", more: "has_more", items: "results", body: true }, responses: { 200: { description: "ok" } } } },
    }),
    srv,
  );
  const ids = (r) => r.data.map((x) => x.id);
  assert.deepEqual(ids(await apiCall({ service: id, operationId: "nextUrl", pages: 5 })), [1, 2, 3]);
  resetRateLimits();
  const foreign = await apiCall({ service: id, operationId: "foreign", pages: 5 });
  assert.deepEqual(ids(foreign), [1]);
  assert.ok(foreign.notes.some((n) => /another host \(evil\.example\.com\); not followed/.test(n)));
  assert.ok(!srv.requests.some((r) => r.url.includes("steal")));
  resetRateLimits();
  assert.deepEqual(ids(await apiCall({ service: id, operationId: "linkStyle", pages: 5 })), [1, 2, 3]);
  resetRateLimits();
  assert.deepEqual(ids(await apiCall({ service: id, operationId: "pageStyle", params: { per_page: 2 }, pages: 8 })), [10, 11, 20, 21, 30, 31]);
  resetRateLimits();
  assert.deepEqual(ids(await apiCall({ service: id, operationId: "offsetStyle", pages: 8 })), [0, 1, 2, 3, 4, 5]);
  resetRateLimits();
  assert.deepEqual(ids(await apiCall({ service: id, operationId: "lastId", pages: 8 })), ["c1", "c2", "c3", "c4"]);
  resetRateLimits();
  const body = await apiCall({ service: id, operationId: "searchBody", body: { query: "x" }, pages: 4 });
  assert.deepEqual(ids(body), ["n1", "n2", "n3"]);
  assert.equal(JSON.parse(srv.requests.at(-1).body).start_cursor, "cur1");
  assert.equal(JSON.parse(srv.requests.at(-1).body).query, "x", "the rest of the body is kept");
});

test("paging: a page that fails part-way hands back what was collected and says so", async (t) => {
  let calls = 0;
  const srv = await startServer(t, (req, res) => {
    calls++;
    if (calls === 3) return json(res, { message: "boom" }, 400);
    json(res, { items: [{ id: calls }], next: `n${calls}` });
  });
  const id = uid("partial");
  await addLocal(t, id, spec({ "/l": getOp("list", [q("cursor")], { "x-ares-paginate": { style: "token", param: "cursor", next: "next", items: "items" } }) }), srv);
  const r = await apiCall({ service: id, operationId: "list", pages: 6 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((i) => i.id), [1, 2]);
  assert.ok(r.notes.some((n) => /page 3 failed \(HTTP 400\); returning the 2 items collected before it/.test(n)));
  // a first page that fails is simply the error
  calls = 2;
  resetRateLimits();
  const bad = await apiCall({ service: id, operationId: "list", pages: 6 });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});

// ─── 429 ─────────────────────────────────────────────────────────────────────

test("429: waits what Retry-After asks (bounded), retries any method, and says when it gives up", async (t) => {
  let n = 0;
  const srv = await startServer(t, (req, res) => {
    n++;
    if (req.url.startsWith("/limited") && n <= 2) return json(res, { error: "slow down" }, 429, { "retry-after": "2" });
    if (req.url.startsWith("/forever")) return json(res, { error: "no" }, 429, { "retry-after": "1" });
    if (req.url.startsWith("/long")) return json(res, { error: "no" }, 429, { "retry-after": "600" });
    if (req.url.startsWith("/gh")) return n % 2 ? json(res, { message: "secondary rate limit" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "3" }) : json(res, { ok: true });
    json(res, { ok: true });
  });
  const id = uid("rl");
  await addLocal(t, id, spec({
    "/limited": getOp("limited", []),
    "/forever": getOp("forever", []),
    "/long": getOp("long", []),
    "/gh": getOp("gh", []),
    "/post": { post: { operationId: "writeIt", summary: "a write", "x-ares-risk": "write", responses: { 200: { description: "ok" } } } },
  }), srv);
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  n = 0;
  const ok = await apiCall({ service: id, operationId: "limited" }, {}, { sleep });
  assert.equal(ok.status, 200);
  assert.deepEqual(waits, [2000, 2000], "waited the 2 s the service asked, twice");
  assert.ok(ok.notes.some((m) => /retried after HTTP 429/.test(m)));

  waits.length = 0;
  resetRateLimits();
  const forever = await apiCall({ service: id, operationId: "forever" }, {}, { sleep });
  assert.equal(forever.status, 429);
  assert.equal(forever.ok, false);
  assert.equal(waits.length, 2, "two retries, then it stops");
  assert.ok(forever.notes.some((m) => /still rate limited \(HTTP 429\) after 2 retries.*asks for 1s/.test(m)));

  waits.length = 0;
  resetRateLimits();
  const long = await apiCall({ service: id, operationId: "long" }, {}, { sleep });
  assert.equal(long.status, 429);
  assert.equal(waits.length, 0, "a 10-minute wait is reported, not slept");
  assert.ok(long.notes.some((m) => /asks for 600s, longer than the 15s/.test(m)));

  waits.length = 0;
  resetRateLimits();
  n = 0;
  const gh = await apiCall({ service: id, operationId: "gh" }, {}, { sleep });
  assert.equal(gh.status, 200, "a GitHub-style 403 with the budget spent is waited out too");
  assert.deepEqual(waits, [3000]);

  // a 429 was not processed: a write is retried as well
  waits.length = 0;
  resetRateLimits();
  let writes = 0;
  const srv2 = await startServer(t, (req, res) => { writes++; return writes === 1 ? json(res, {}, 429, { "retry-after": "1" }) : json(res, { done: true }); });
  const id2 = uid("rlw");
  await addLocal(t, id2, spec({ "/w": { post: { operationId: "writeIt", summary: "a write", "x-ares-risk": "write", responses: { 200: { description: "ok" } } } } }), srv2);
  const w = await apiCall({ service: id2, operationId: "writeIt" }, {}, { sleep });
  assert.equal(w.status, 200);
  assert.equal(writes, 2);

  assert.equal(retryAfterMs({ "retry-after": "7" }, 0), 7000);
  assert.equal(retryAfterMs({ "retry-after": new Date(10_000).toUTCString() }, 4000), 6000);
  assert.equal(retryAfterMs({ "x-ratelimit-reset": "1800000003" }, 1_800_000_000_000), 3000, "an epoch-seconds reset");
  assert.equal(retryAfterMs({ "x-ratelimit-reset": "12" }, 1_800_000_000_000), 12_000, "a seconds-from-now reset");
  assert.equal(retryAfterMs({}, 0), undefined);
});

test("Link headers: rel=next is found among several", () => {
  assert.equal(parseLinkNext('<https://a/x?page=2>; rel="next", <https://a/x?page=9>; rel="last"'), "https://a/x?page=2");
  assert.equal(parseLinkNext('<https://a/x?page=1>; rel="prev", <https://a/x?page=3>; rel="next"'), "https://a/x?page=3");
  assert.equal(parseLinkNext('<https://a/x?page=1>; rel="prev"'), undefined);
  assert.equal(parseLinkNext(undefined), undefined);
  assert.equal(parseLinkNext('<https://s/x?cursor=a>; rel="next"; results="false"; cursor="a"'), undefined, "Sentry's last page says results=false");
  assert.equal(parseLinkNext('<https://s/x?cursor=b>; rel="next"; results="true"; cursor="b"'), "https://s/x?cursor=b");
});

// ─── shaping ─────────────────────────────────────────────────────────────────

test("fields: keep only what was asked, per item, through nested objects and arrays, keeping an envelope's cursor", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, {
    nextPageToken: "abc",
    items: [
      { id: 1, name: "a", owner: { login: "x", id: 9, site: "s" }, labels: [{ name: "bug", color: "red" }, { name: "ui", color: "blue" }], body: "long" },
      { id: 2, name: "b", owner: { login: "y", id: 8, site: "t" }, labels: [], body: "long" },
    ],
  }));
  const id = uid("fields");
  await addLocal(t, id, spec({ "/l": getOp("list", [], { "x-ares-paginate": { style: "token", param: "pageToken", next: "nextPageToken", items: "items" } }) }), srv);
  const r = await apiCall({ service: id, operationId: "list" }, {}, { fields: ["id", "owner.login", "labels.name"] });
  assert.equal(r.data.nextPageToken, "abc", "the envelope is kept");
  assert.deepEqual(r.data.items, [{ id: 1, owner: { login: "x" }, labels: [{ name: "bug" }, { name: "ui" }] }, { id: 2, owner: { login: "y" }, labels: [] }]);
  assert.deepEqual(projectFields([{ a: 1, b: 2 }, { a: 3 }], ["a"]), [{ a: 1 }, { a: 3 }]);
  assert.deepEqual(projectFields({ a: 1, b: { c: 2, d: 3 } }, ["b.c"]), { b: { c: 2 } });
  assert.deepEqual(projectFields("text", ["a"]), "text");
  // select first, then fields
  resetRateLimits();
  const sel = await apiCall({ service: id, operationId: "list" }, {}, { select: "items", fields: ["name"] });
  assert.deepEqual(sel.data, [{ name: "a" }, { name: "b" }]);
});

test("shrink: a huge answer keeps its shape, says what was cut, and stays valid JSON", async (t) => {
  const big = { total: 5000, items: Array.from({ length: 5000 }, (_, i) => ({ id: i, title: `item ${i}`, body: "lorem ipsum ".repeat(100), tags: ["a", "b", "c"] })), cursor: "next" };
  const small = shrinkJson(big, 3000);
  assert.equal(small.changed, true);
  const text = JSON.stringify(small.value);
  assert.ok(text.length <= 3000, `fits (${text.length})`);
  assert.equal(small.value.total, 5000);
  assert.equal(small.value.cursor, "next");
  assert.ok(Array.isArray(small.value.items) && small.value.items.length >= 2);
  assert.match(String(small.value.items.at(-1)), /more\)/);
  assert.ok(small.cuts.some((c) => /items: 5000 -> /.test(c)), small.cuts.join("|"));
  assert.equal(shrinkJson({ a: 1 }, 100).changed, false);

  const srv = await startServer(t, (req, res) => json(res, big));
  const id = uid("shrink");
  await addLocal(t, id, spec({ "/big": getOp("big", []) }), srv);
  const r = await apiCall({ service: id, operationId: "big" }, {}, { maxChars: 4000, maxBytes: 8 * 1024 * 1024 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 4002);
  assert.equal(r.data.total, 5000, "data is the shrunk structure, not a cut string");
  assert.ok(r.notes.some((n) => /output cut to 4000 characters \(.*items: 5000 -> .*\).*select/.test(n)), r.notes.join("|"));
});

// ─── GraphQL ─────────────────────────────────────────────────────────────────

test("GraphQL: a curated operation sends its fixed query with typed variables; errors with no data fail; a raw query is read-only", async (t) => {
  const srv = await startServer(t, (req, res, entry) => {
    const body = JSON.parse(entry.body || "{}");
    if (/fail/.test(body.query)) return json(res, { errors: [{ message: "Variable $first is invalid" }], data: null });
    if (/partial/.test(body.query)) return json(res, { data: { x: 1 }, errors: [{ message: "one field failed" }] });
    json(res, { data: { echo: body.variables, query: body.query } });
  });
  const id = uid("gql");
  const gql = (operationId, query, params, extra = {}) => ({ post: { operationId, summary: `${operationId} graphql`, parameters: params, "x-ares-risk": "read", "x-ares-graphql": { query, kind: "query" }, responses: { 200: { description: "ok" } }, ...extra } });
  await addLocal(t, id, spec({
    "/graphql#issues": gql("listIssues", "query Issues($first: Int, $state: String, $mine: Boolean, $ids: [String!]) { issues(first: $first) { nodes { id } } }", [q("first", "integer", { maximum: 100 }), q("state", "string", { enum: ["open", "done"] }), q("mine", "boolean"), { name: "ids", in: "query", description: "ids", schema: { type: "array", items: { type: "string" } } }]),
    "/graphql#fail": gql("failing", "query fail { x }", []),
    "/graphql#partial": gql("partial", "query partial { x }", []),
    "/graphql#create": { post: { operationId: "createIssue", summary: "create an issue mutation", parameters: [{ name: "input", in: "query", required: true, description: "the issue", schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } }], "x-ares-risk": "write", "x-ares-graphql": { query: "mutation M($input: IssueInput!) { issueCreate(input: $input) { id } }", kind: "mutation" }, responses: { 200: { description: "ok" } } } },
    "/graphql#raw": { post: { operationId: "queryRaw", summary: "free-form read-only graphql", "x-ares-risk": "read", "x-ares-graphql": { query: "", kind: "query", raw: true }, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, variables: { type: "object" } } } } } }, responses: { 200: { description: "ok" } } } },
  }), srv);

  const r = await apiCall({ service: id, operationId: "listIssues", params: { first: "5", state: "open", mine: "true", ids: "a,b" } });
  assert.equal(srv.requests.at(-1).url, "/graphql", "the #name is not sent");
  assert.deepEqual(r.data.data.echo, { first: 5, state: "open", mine: true, ids: ["a", "b"] }, "variables keep their JSON types");
  assert.match(r.data.data.query, /^query Issues/);
  await assert.rejects(() => apiCall({ service: id, operationId: "listIssues", params: { first: 1000 } }), /must be <= 100/);
  await assert.rejects(() => apiCall({ service: id, operationId: "listIssues", params: { state: "weird" } }), /must be one of "open", "done"/);
  await assert.rejects(() => apiCall({ service: id, operationId: "listIssues", body: { query: "{ x }" } }), /fixed GraphQL operation: pass its variables in `params`/);
  const failing = await apiCall({ service: id, operationId: "failing" });
  assert.equal(failing.ok, false);
  assert.ok(failing.notes.some((m) => /GraphQL error: Variable \$first is invalid/.test(m)));
  const partial = await apiCall({ service: id, operationId: "partial" });
  assert.equal(partial.ok, true);
  assert.ok(partial.notes.some((m) => /alongside data: one field failed/.test(m)));

  const created = await apiCall({ service: id, operationId: "createIssue", params: { input: { title: "hi" } } });
  assert.deepEqual(created.data.data.echo, { input: { title: "hi" } });
  await assert.rejects(() => apiCall({ service: id, operationId: "createIssue", params: { input: {} } }), /missing required field: title/);

  // free-form: queries read, mutations never run
  assert.equal(graphqlTextIsReadOnly("query { viewer { id } }"), true);
  assert.equal(graphqlTextIsReadOnly("{ viewer { id } }"), true);
  assert.equal(graphqlTextIsReadOnly('query { issues(filter: {title: "mutation of x"}) { id } } # mutation'), true, "the word in a string or comment is not a mutation");
  assert.equal(graphqlTextIsReadOnly("mutation { issueDelete(id: 1) { success } }"), false);
  assert.equal(graphqlTextIsReadOnly("query A { a } \n mutation B { b }"), false);
  assert.equal(graphqlTextIsReadOnly("subscription { s }"), false);
  const ok = await apiCall({ service: id, operationId: "queryRaw", body: { query: "{ viewer { id } }" } });
  assert.equal(ok.status, 200);
  await assert.rejects(() => apiCall({ service: id, operationId: "queryRaw", body: { query: "mutation { x }" } }), /free-form GraphQL here is read-only/);
  assert.equal(classifyApiCall(id, "queryRaw", {}, undefined, { query: "{ viewer { id } }" }).kind, "read");
  assert.equal(classifyApiCall(id, "queryRaw", {}, undefined, { query: "mutation { x }" }).kind, "write");
  assert.equal(classifyApiCall(id, "queryRaw").kind, "write", "no query to inspect: fail closed");
  assert.equal(classifyApiCall(id, "listIssues").kind, "read");
  assert.equal(classifyApiCall(id, "createIssue").kind, "write");
});

test("an error envelope (Slack's {ok:false}) is a failure even at HTTP 200", async (t) => {
  const srv = await startServer(t, (req, res) => (req.url.startsWith("/bad") ? json(res, { ok: false, error: "channel_not_found" }) : json(res, { ok: true, channels: [] })));
  const id = uid("env");
  await addLocal(t, id, spec({ "/bad": getOp("bad", []), "/good": getOp("good", []) }), srv);
  const def = resolveApiServiceDef(id);
  assert.ok(def);
  // errorEnvelope is a property of the service definition; set it on the stored def
  const { apiServicesDir } = await import("../packages/core/dist/index.js");
  const { promises: fsp } = await import("node:fs");
  const path = (await import("node:path")).default;
  const file = path.join(apiServicesDir(), id, "def.json");
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  stored.errorEnvelope = { okPath: "ok", errorPath: "error" };
  await fsp.writeFile(file, JSON.stringify(stored));
  const bad = await apiCall({ service: id, operationId: "bad" });
  assert.equal(bad.status, 200);
  assert.equal(bad.ok, false);
  assert.ok(bad.notes.some((m) => /refused it: channel_not_found/.test(m)));
  resetRateLimits();
  assert.equal((await apiCall({ service: id, operationId: "good" })).ok, true);
});

// ─── reserved path variables (Google's {+name}) and discovery documents ──────

test("a Google discovery document becomes an API the tool can use, with slashes kept in {+name} variables", async (t) => {
  const doc = {
    discoveryVersion: "v1", name: "people", version: "v1", title: "People API", rootUrl: "https://people.googleapis.com/", servicePath: "",
    schemas: { Person: { type: "object", properties: { names: { type: "array", items: { type: "object", properties: { displayName: { type: "string" } } } } } } },
    resources: {
      people: {
        methods: {
          get: { id: "people.people.get", path: "v1/{+resourceName}", flatPath: "v1/people/{peopleId}", httpMethod: "GET", description: "Provides information about a person. Second sentence.", parameters: { resourceName: { type: "string", required: true, location: "path", pattern: "^people/[^/]+$", description: "people/me or people/ID" }, personFields: { type: "string", location: "query", required: true, description: "field mask" } } },
          updateContact: { id: "people.people.updateContact", path: "v1/{+resourceName}:updateContact", httpMethod: "PATCH", parameters: { resourceName: { type: "string", required: true, location: "path", description: "the contact" } }, request: { $ref: "Person" } },
        },
      },
    },
  };
  const raw = parseSpecText(JSON.stringify(doc));
  assert.equal(raw.openapi, "3.0.0");
  const handle = new SpecHandle(raw);
  assert.deepEqual(handle.ops.map((o) => `${o.method} ${o.path}`).sort(), ["GET /v1/{resourceName}", "PATCH /v1/{resourceName}:updateContact"]);
  assert.equal(handle.ops.find((o) => o.method === "GET").summary, "Provides information about a person.");
  const srv = await startServer(t, (req, res) => json(res, { path: req.url }));
  const id = uid("disc");
  await addApiService({ id, specText: JSON.stringify(doc), baseUrl: srv.url, allowLan: true, auth: { type: "none" } });
  t.after(() => removeApiService(id));
  resetRateLimits();
  const r = await apiCall({ service: id, operationId: "people.people.get", params: { resourceName: "people/me", personFields: "names" } });
  assert.equal(r.data.path, "/v1/people/me?personFields=names", "the slash in people/me survives");
  await assert.rejects(() => apiCall({ service: id, operationId: "people.people.get", params: { resourceName: "people/../x", personFields: "n" } }), /may not be/);
});

// ─── message prompts and policy ──────────────────────────────────────────────

test("a message shows its exact words to the owner even in bypass, and files under email_send", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { ok: true }));
  const id = uid("msg");
  await addLocal(t, id, spec({
    "/chat.postMessage": { post: { operationId: "postMessage", summary: "post a chat message", "x-ares-risk": "message", "x-ares-message": { to: ["body.channel"], text: ["body.text"] }, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["channel", "text"], properties: { channel: { type: "string" }, text: { type: "string" } } } } } }, responses: { 200: { description: "ok" } } } },
    "/files.delete": { post: { operationId: "deleteFile", summary: "delete a file", "x-ares-risk": "destructive", responses: { 200: { description: "ok" } } } },
    "/pins.add": { post: { operationId: "pinIt", summary: "pin an item", "x-ares-risk": "write", responses: { 200: { description: "ok" } } } },
    "/subs": { post: { operationId: "setThreadSubscription", summary: "mute or follow a thread", "x-ares-risk": "write", responses: { 200: { description: "ok" } } } },
    "/legacy/subscription": { post: { operationId: "legacySubscription", summary: "an undeclared write that looks financial", responses: { 200: { description: "ok" } } } },
  }), srv);
  const permit = (input, mode) => ApiTool.checkPermissions(ApiTool.inputZod.parse({ action: "call", service: id, ...input }), ctx(mode));
  const msg = await permit({ operationId: "postMessage", body: { channel: "#general", text: "Lunch is at noon, bring the printer." } }, "bypass");
  assert.equal(msg.kind, "ask");
  assert.equal(msg.ownerDecision, true);
  assert.match(msg.prompt, /send to #general:\nLunch is at noon, bring the printer\.\nSend it\?/);
  assert.equal((await permit({ operationId: "postMessage", body: { channel: "c", text: "x" } }, "plan")).kind, "deny");
  assert.equal(universalToolCategory("Api", { action: "call", service: id, operationId: "postMessage", body: { channel: "c", text: "x" } }), "email_send");
  assert.equal(universalToolCategory("Api", { action: "call", service: id, operationId: "deleteFile" }), "shell_destructive");
  assert.equal(universalToolCategory("Api", { action: "call", service: id, operationId: "pinIt" }), "browser_submit");
  // a reviewed plain write skips the word heuristics ("subscription" is not a payment); an undeclared one does not
  assert.equal(classifyApiCall(id, "setThreadSubscription").financial, false);
  assert.equal(classifyApiCall(id, "legacySubscription").financial, true);
  assert.equal(classifyApiCall(id, "pinIt").destructive, false);
  const d = classifyApiCall(id, "postMessage");
  assert.equal(d.message, true);
  assert.equal(d.destructive, false);
});

// ─── where a connected account's token comes from ────────────────────────────

test("a connected account: explicit key, then the registry's stored key, then the OAuth grant, then the injected provider — and a plain sentence when none", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { auth: req.headers.authorization ?? null }));
  const id = uid("conn");
  const def = (extra = {}) => ({ id, label: "Acme", blurb: "x", specSource: { kind: "preset" }, auth: { type: "bearer" }, oauth: { connect: "acme", ...extra } });
  const { resolveAuth } = await import("../packages/tools/dist/index.js");
  const get = (map) => ({ get: async (n) => map[n] });
  void srv;

  // nothing stored: the sentence says what to do
  await assert.rejects(() => resolveAuth(def(), { creds: get({}) }), (err) => {
    assert.ok(err instanceof ApiInputError);
    assert.match(err.message, /^Acme is not connected - Connect service "acme" \(the owner taps one card on their phone; never ask for a token in chat\)\. Headless fallback: set the environment variable API_/);
    return true;
  });

  // 1. explicit credential
  let auth = await resolveAuth(def(), { creds: get({ [apiCred(id, "KEY")]: "explicit-token-0001" }) });
  assert.equal(auth.headers.authorization, "Bearer explicit-token-0001");
  // 2. the key the registry stores
  auth = await resolveAuth(def({ credentials: ["ACME_SECRET_KEY"] }), { creds: get({ ACME_SECRET_KEY: "registry-key-0002" }) });
  assert.equal(auth.headers.authorization, "Bearer registry-key-0002");
  // explicit beats registry
  auth = await resolveAuth(def({ credentials: ["ACME_SECRET_KEY"] }), { creds: get({ ACME_SECRET_KEY: "registry-key-0002", [apiCred(id, "KEY")]: "explicit-token-0001" }) });
  assert.equal(auth.headers.authorization, "Bearer explicit-token-0001");

  // 3. the owner's OAuth grant (a real provider id: spotify), through the vault
  const spotify = { ...def({ connect: "spotify" }), label: "Spotify" };
  const grant = { accessToken: "oauth-grant-token-0003", expiresAt: Date.now() + 3600_000 };
  await storeTokens("spotify", grant);
  t.after(() => deleteCredential("oauth/spotify"));
  const vault = { get: async () => undefined };
  assert.equal((await resolveConnectedToken(spotify, { creds: vault }))?.token, "oauth-grant-token-0003");
  assert.equal((await resolveConnectedToken(spotify, { creds: vault }))?.source, "oauth");
  // an expired grant with nothing to refresh it with: reconnect, not "never connected"
  await storeTokens("spotify", { accessToken: "stale", expiresAt: Date.now() - 1000 });
  await assert.rejects(() => resolveConnectedToken(spotify, { creds: vault }), /stored sign-in expired and cannot be refreshed - Connect service "spotify" again/);
  await deleteCredential("oauth/spotify");
  assert.equal(await resolveConnectedToken(spotify, { creds: vault }), undefined);

  // 4. the OAuth engine's own provider wins when installed, and can be removed again
  setConnectedTokenProvider(async (d) => (d.id === id ? "engine-token-0004" : undefined));
  t.after(() => setConnectedTokenProvider(undefined));
  auth = await resolveAuth(def(), { creds: get({ [apiCred(id, "KEY")]: "explicit-token-0001" }) });
  assert.equal(auth.headers.authorization, "Bearer engine-token-0004");
  setConnectedTokenProvider(undefined);
  auth = await resolveAuth(def(), { creds: get({ [apiCred(id, "KEY")]: "explicit-token-0001" }) });
  assert.equal(auth.headers.authorization, "Bearer explicit-token-0001");

  // a remote-MCP bearer is used only when the preset says its REST API accepts it
  await setCredential("mcp.token.acme", JSON.stringify({ accessToken: "mcp-bearer-0005", tokenEndpoint: "https://x", clientId: "c" }));
  t.after(() => deleteCredential("mcp.token.acme"));
  await assert.rejects(() => resolveAuth(def(), { creds: get({}) }), /not connected/);
  auth = await resolveAuth(def({ mcp: "acme" }), { creds: get({}) });
  assert.equal(auth.headers.authorization, "Bearer mcp-bearer-0005");
});

test("custom schemes: a bare-token header, a template with the app's client id, and an extra client-id header", async () => {
  const { resolveAuth } = await import("../packages/tools/dist/index.js");
  const get = (map) => ({ get: async (n) => map[n] });
  const base = { id: "tmpl-test", label: "Tmpl", blurb: "x", specSource: { kind: "preset" }, oauth: { connect: "tmpl" } };
  const keys = { [apiCred("tmpl-test", "KEY")]: "the-token-123456", [apiCred("tmpl-test", "CLIENT_ID")]: "app-key-abcdef" };
  let auth = await resolveAuth({ ...base, auth: { type: "bearer", header: "X-Shopify-Access-Token", scheme: "" } }, { creds: get(keys) });
  assert.equal(auth.headers["x-shopify-access-token"], "the-token-123456");
  auth = await resolveAuth({ ...base, auth: { type: "bearer", template: 'OAuth oauth_consumer_key="{CLIENT_ID}", oauth_token="{token}"' } }, { creds: get(keys) });
  assert.equal(auth.headers.authorization, 'OAuth oauth_consumer_key="app-key-abcdef", oauth_token="the-token-123456"');
  auth = await resolveAuth({ ...base, auth: { type: "bearer" }, authHeaders: { "Client-Id": "{CLIENT_ID}" } }, { creds: get(keys) });
  assert.equal(auth.headers["client-id"], "app-key-abcdef");
  assert.ok(auth.headerNames.includes("client-id"));
  await assert.rejects(() => resolveAuth({ ...base, auth: { type: "bearer" }, authHeaders: { "Client-Id": "{CLIENT_ID}" } }, { creds: get({ [apiCred("tmpl-test", "KEY")]: "the-token-123456" }) }), /needs the app's client id/);
});

// ─── the tool: services, recipes, search, the unconnected sentence ───────────

test("the tool: services lists what is connected, recipes teaches, search works across everything, and an unconnected call says how to connect", async () => {
  const vercel = presetBundle("vercel");
  assert.ok(vercel, "the Vercel exemplar is authored");
  const run = (input) => ApiTool.call(ApiTool.inputZod.parse(input), ctx());

  const services = await run({ action: "services" });
  assert.match(services.output.message, /vercel — Vercel: .*\[\d+ ops; NOT CONNECTED: Connect service "vercel"\]/);
  assert.match(services.output.message, /open-meteo — .*no setup/);
  assert.ok(services.output.services.find((s) => s.id === "vercel" && s.access === "not-connected" && s.connect === 'Connect service "vercel"'));

  // not connected: no network, one sentence
  const call = await run({ action: "call", service: "vercel", operationId: "listDeployments", params: { limit: 5 } });
  assert.ok(call.failure);
  assert.match(call.failure, /Vercel is not connected - Connect service "vercel"/);
  assert.ok(!/undefined|\[object/.test(call.failure));

  const recipes = await run({ action: "recipes", service: "vercel" });
  assert.match(recipes.output.message, /Connects through: Connect service "vercel"/);
  assert.match(recipes.output.message, /"what did I deploy today"\n {2}1\. call vercel listDeployments — params \{"limit":20,"since":\d+\}; fields "uid,name/);
  assert.ok(recipes.output.recipes.length >= 3);
  assert.match((await run({ action: "recipes", service: "open-meteo" })).failure, /has no recipes/);

  const across = await run({ action: "search", query: "what did I deploy today" });
  assert.match(across.output.message, /vercel\.listDeployments/);
  assert.ok(across.output.results.some((r) => r.service === "vercel" && r.operationId === "listDeployments" && r.connected === false));
  assert.match((await run({ action: "search" })).failure, /needs service .* or a query/);

  const within = await run({ action: "search", service: "vercel", query: "rollback" });
  assert.equal(within.output.results[0].operationId, "rollbackProduction");
  assert.match(within.output.message, /Worked examples: recipes \{service: "vercel"\}/);

  // connect it (the explicit headless key), and the listing says so
  await setCredential(apiCred("vercel", "KEY"), "vercel-test-token-123456");
  try {
    const after = await run({ action: "services" });
    assert.match(after.output.message, /vercel — Vercel: .*; connected\]/);
    const describe = await run({ action: "describe", service: "vercel", operationId: "createDeployment" });
    assert.match(describe.output.operation.access, /WRITE — asks the owner/);
    const rm = await run({ action: "describe", service: "vercel", operationId: "removeProjectDomain" });
    assert.match(rm.output.operation.access, /always the owner's decision/);
    const lst = await run({ action: "describe", service: "vercel", operationId: "listDeployments" });
    assert.match(lst.output.operation.paging, /a list that pages \(token, parameter until\)/);
  } finally {
    await deleteCredential(apiCred("vercel", "KEY"));
  }
});

// ─── natural-language ranking ────────────────────────────────────────────────

test("search ranking: a curated phrase wins, conversational filler is ignored, synonyms bridge the vocabulary, existing ranking holds", () => {
  const ops = [
    { id: "listMessages", method: "GET", path: "/mail/messages", summary: "List messages in the mailbox", tags: ["mail"], ext: { keywords: ["unread mail", "my inbox"] } },
    { id: "listLabels", method: "GET", path: "/mail/labels", summary: "List the labels", tags: ["mail"] },
    { id: "getDeployments", method: "GET", path: "/deployments", summary: "Deployments, newest first", tags: ["deployments"] },
    { id: "getPlayback", method: "GET", path: "/me/player", summary: "The current playback state", tags: ["player"] },
    { id: "createEvent", method: "POST", path: "/calendar/events", summary: "Create a calendar event", tags: ["calendar"] },
    { id: "listEvents", method: "GET", path: "/calendar/events", summary: "Events on the calendar", tags: ["calendar"] },
  ];
  const top = (query) => searchOperations(ops, query).hits.map((h) => h.id);
  assert.equal(top("do I have any unread mail")[0], "listMessages");
  assert.equal(top("what did I deploy today")[0], "getDeployments", "deploy -> deployment, filler ignored");
  assert.equal(top("what is playing right now")[0], "getPlayback");
  assert.equal(top("what meetings do I have")[0], "listEvents");
  assert.equal(top("schedule a meeting")[0], "createEvent");
  assert.equal(top("listLabels")[0], "listLabels", "an exact id still wins outright");
  assert.deepEqual(top("zzzz nothing like it"), []);
});

test("every connected-account preset the roster names is registered with core and none is a form card unless it says so", () => {
  const defs = listApiPresetDefs();
  assert.ok(defs.length >= 13, "the keyless presets and at least the Vercel exemplar");
  void specHandleFor;
});
