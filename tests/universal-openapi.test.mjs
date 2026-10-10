// The universal Api connector — spec parsing, search, request building, auth,
// the network guard, write gating, redaction and limits. Offline and
// deterministic: every "service" here is a server on 127.0.0.1 (allowed only
// because each test's service says allowLan) or a stub resolver.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  ApiTool,
  ApiInputError,
  SpecHandle,
  parseSpecText,
  searchOperations,
  suggestAuth,
  classifyAddress,
  assertUrlAllowed,
  safeFetch,
  buildRequest,
  resolveAuth,
  redactText,
  redactTokens,
  visibleHeaders,
  resetRateLimits,
  clearOAuthCache,
  addApiService,
  removeApiService,
  apiCall,
  classifyApiCall,
  listApiServices,
  verifyApiService,
  specHandleFor,
} from "../packages/tools/dist/index.js";
import {
  CONNECT_SERVICES,
  resolveConnectService,
  setCredential,
  getCredential,
  apiServicesDir,
  API_PRESET_DEFS,
  isServiceConnected,
} from "../packages/core/dist/index.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import { classifyToolRequest, remoteAutonomyDecision } from "../packages/cli/dist/policyGate.js";
import { listPhoneConnections, disconnectService } from "../packages/cli/dist/phoneConnections.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const ctx = (permissionMode = "workspace-write") => ({ signal: new AbortController().signal, permissionMode });

/** A throwaway HTTP server on 127.0.0.1 that records what it is sent. */
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
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, requests };
}

const json = (res, body, status = 200, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
};

let counter = 0;
const uid = (p) => `${p}-${process.pid}-${++counter}`;

async function addLocal(t, id, spec, server, extra = {}) {
  const res = await addApiService({ id, specText: typeof spec === "string" ? spec : JSON.stringify(spec), baseUrl: server.url, allowLan: true, ...extra });
  t.after(() => removeApiService(id));
  return res;
}

const PETS = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1" },
  servers: [{ url: "https://pets.example.com/v1" }],
  security: [{ key: [] }],
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 }, description: "page size" } },
    schemas: {
      Pet: { allOf: [{ $ref: "#/components/schemas/NewPet" }, { type: "object", required: ["id"], properties: { id: { type: "integer" } } }] },
      NewPet: { type: "object", required: ["name"], properties: { name: { type: "string", description: "the name" }, tag: { type: "string", enum: ["dog", "cat"] }, owner: { $ref: "#/components/schemas/Owner" } } },
      Owner: { type: "object", properties: { name: { type: "string" }, pets: { type: "array", items: { $ref: "#/components/schemas/Pet" } }, parent: { $ref: "#/components/schemas/Owner" } } },
    },
  },
  paths: {
    "/pets": {
      parameters: [{ $ref: "#/components/parameters/Limit" }],
      get: { operationId: "listPets", summary: "List all pets", tags: ["pets"], parameters: [{ name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } }], responses: { 200: { description: "ok" } } },
      post: { operationId: "createPet", summary: "Create a pet", tags: ["pets"], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } } }, responses: { 201: { description: "created" } } },
    },
    "/pets/{petId}": {
      get: { operationId: "getPet", summary: "Info for a specific pet", tags: ["pets"], parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }, { name: "X-Trace", in: "header", schema: { type: "string" } }, { name: "session", in: "cookie", schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } } },
      delete: { operationId: "deletePet", summary: "Delete a pet", tags: ["pets"], parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }], responses: { 204: { description: "gone" } } },
    },
    "/owners": { get: { summary: "List the owners", responses: { 200: { description: "ok" } } } },
    "/owners/{id}/pets": { get: { summary: "Pets of an owner", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: {} } },
    "/x-ignored": { "x-internal": true },
  },
};

// ─── spec parsing ────────────────────────────────────────────────────────────

test("a spec is JSON or YAML, and the error says what was wrong", () => {
  assert.equal(parseSpecText(JSON.stringify(PETS)).info.title, "Pets");
  const yaml = "openapi: 3.0.0\ninfo:\n  title: Yaml API\n  version: '1'\npaths:\n  /a:\n    get:\n      operationId: getA\n      responses:\n        '200':\n          description: ok\n";
  const handle = new SpecHandle(parseSpecText(yaml));
  assert.equal(handle.meta.title, "Yaml API");
  assert.deepEqual(handle.ops.map((o) => o.id), ["getA"]);
  assert.throws(() => parseSpecText(""), /empty/);
  assert.throws(() => parseSpecText("{not json"), /JSON but does not parse/);
  assert.throws(() => parseSpecText("a: [1, 2"), /neither JSON nor valid YAML/);
  assert.throws(() => new SpecHandle({ hello: "world" }), /not an OpenAPI/);
  assert.throws(() => new SpecHandle({ openapi: "4.0.0", paths: {} }), /unsupported OpenAPI version/);
  assert.throws(() => new SpecHandle({ openapi: "3.0.0" }), /no "paths"/);
});

test("OpenAPI 3.0: ids, path-level params, $ref, allOf, recursion and external refs", () => {
  const handle = new SpecHandle(PETS);
  assert.equal(handle.meta.flavor, "openapi3");
  assert.equal(handle.meta.operationCount, 6);
  const ids = handle.ops.map((o) => o.id);
  assert.ok(ids.includes("listPets") && ids.includes("deletePet"));
  // operations without an operationId get a stable synthesized one
  assert.ok(ids.includes("get_owners"), ids.join());
  assert.ok(ids.includes("get_owners_by_id_pets"), ids.join());

  const list = handle.operation("listPets");
  assert.deepEqual(list.parameters.map((p) => p.name).sort(), ["limit", "tags"], "the path-level $ref parameter is merged in");
  assert.equal(list.parameters.find((p) => p.name === "limit").schema.maximum, 100);

  const create = handle.operation("createPet");
  assert.equal(create.body.required, true);
  assert.equal(create.body.contentType, "application/json");
  assert.deepEqual(create.body.schema.required, ["name"]);
  assert.deepEqual(create.body.schema.properties.tag.enum, ["dog", "cat"]);
  // Owner -> pets -> Pet -> owner ... is cut, not infinite
  assert.ok(JSON.stringify(create.body.schema).length < 6000);

  // allOf merges properties and required
  const get = handle.operation("getPet");
  const pet = get.responses.find((r) => r.status === "200");
  assert.ok(pet);
  const petSchema = handle.raw.components.schemas.Pet;
  assert.ok(petSchema.allOf);
  assert.equal(get.parameters.find((p) => p.name === "petId").required, true);

  // an external $ref is never followed
  const ext = new SpecHandle({ openapi: "3.0.0", info: { title: "x", version: "1" }, paths: { "/a": { post: { operationId: "a", requestBody: { content: { "application/json": { schema: { $ref: "https://evil.example/schema.json" } } } }, responses: {} } } } });
  assert.match(JSON.stringify(ext.operation("a").body.schema), /external reference/);
});

test("OpenAPI 3.1: type arrays, nullable, const, examples", () => {
  const handle = new SpecHandle({
    openapi: "3.1.0",
    info: { title: "v31", version: "1", description: "three-one" },
    servers: [{ url: "https://{region}.example.com/{base}", variables: { region: { default: "eu" }, base: { default: "v2" } } }],
    paths: {
      "/t": {
        post: {
          operationId: "t",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { n: { type: ["string", "null"] }, kind: { const: "a" }, list: { type: "array", items: { type: "integer" }, examples: [[1]] } } } } } },
          responses: {},
        },
      },
    },
    webhooks: { ignored: { post: { operationId: "hook" } } },
  });
  assert.deepEqual(handle.meta.servers, ["https://eu.example.com/v2"]);
  assert.equal(handle.ops.length, 1, "webhooks are not callable operations");
  const s = handle.operation("t").body.schema;
  assert.equal(s.properties.n.type, "string");
  assert.equal(s.properties.n.nullable, true);
  assert.deepEqual(s.properties.kind.enum, ["a"]);
});

test("Swagger 2.0: servers from host/basePath, body and formData params, collectionFormat", () => {
  const handle = new SpecHandle({
    swagger: "2.0",
    info: { title: "Old", version: "1" },
    host: "api.old.example",
    basePath: "/v3",
    schemes: ["http", "https"],
    consumes: ["application/json"],
    definitions: { Thing: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    paths: {
      "/things": {
        get: { operationId: "listThings", parameters: [{ name: "ids", in: "query", type: "array", items: { type: "integer" }, collectionFormat: "pipes" }], responses: {} },
        post: { operationId: "makeThing", parameters: [{ name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Thing" } }], responses: {} },
      },
      "/upload": { post: { operationId: "upload", consumes: ["application/x-www-form-urlencoded"], parameters: [{ name: "title", in: "formData", type: "string", required: true }, { name: "n", in: "formData", type: "integer" }], responses: {} } },
    },
  });
  assert.equal(handle.meta.flavor, "swagger2");
  assert.deepEqual(handle.meta.servers, ["https://api.old.example/v3"]);
  assert.equal(handle.operation("listThings").parameters[0].collectionFormat, "pipes");
  const make = handle.operation("makeThing");
  assert.equal(make.body.required, true);
  assert.deepEqual(make.body.schema.required, ["name"]);
  const up = handle.operation("upload");
  assert.equal(up.body.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(up.body.schema.required, ["title"]);
  assert.equal(up.body.schema.properties.n.type, "integer");
});

test("suggestAuth reads the spec's security schemes", () => {
  const raw = {
    openapi: "3.0.0",
    components: {
      securitySchemes: {
        a: { type: "apiKey", in: "query", name: "api_key" },
        b: { type: "http", scheme: "bearer" },
        c: { type: "http", scheme: "basic" },
        d: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://auth.example/token", scopes: { read: "r", write: "w" } } } },
      },
    },
  };
  const s = suggestAuth(raw);
  assert.deepEqual(s.map((x) => x.type), ["apiKey", "bearer", "basic", "oauth2cc"]);
  assert.equal(s[0].name, "api_key");
  assert.equal(s[3].tokenUrl, "https://auth.example/token");
});

// ─── search ──────────────────────────────────────────────────────────────────

const SHOP = new SpecHandle({
  openapi: "3.0.0",
  info: { title: "Shop", version: "1" },
  paths: {
    "/customers": { get: { operationId: "listCustomers", summary: "List all customers", tags: ["customers"] }, post: { operationId: "createCustomer", summary: "Create a customer", tags: ["customers"] } },
    "/customers/{id}": { get: { operationId: "getCustomer", summary: "Retrieve a customer", tags: ["customers"] }, delete: { operationId: "deleteCustomer", summary: "Delete a customer", tags: ["customers"] } },
    "/invoices": { get: { operationId: "listInvoices", summary: "List invoices", tags: ["billing"] }, post: { operationId: "createInvoice", summary: "Create an invoice for a customer", tags: ["billing"] } },
    "/invoices/{id}/send": { post: { operationId: "sendInvoice", summary: "Email an invoice to the customer", tags: ["billing"] } },
    "/refunds": { post: { operationId: "createRefund", summary: "Refund a payment", tags: ["billing"] } },
    "/legacy/customers": { get: { operationId: "oldListCustomers", summary: "List customers (old)", deprecated: true, tags: ["customers"] } },
  },
});

test("search ranks the operation that means what was asked for", () => {
  const top = (q, opts) => searchOperations(SHOP.ops, q, opts).hits.map((h) => h.id);
  assert.equal(top("create invoice")[0], "createInvoice");
  assert.equal(top("list customers")[0], "listCustomers");
  assert.ok(top("list customers").indexOf("listCustomers") < top("list customers").indexOf("oldListCustomers"), "deprecated ranks lower");
  assert.equal(top("send an email")[0], "sendInvoice");
  assert.equal(top("refund")[0], "createRefund");
  assert.equal(top("getCustomer")[0], "getCustomer", "an exact operationId wins");
  assert.equal(top("customer")[0] === "deleteCustomer", false);
  assert.deepEqual(top("zzzz nothing"), []);
  assert.deepEqual(top("customers", { method: "delete" }), ["deleteCustomer"]);
  assert.ok(top("", { tag: "billing" }).every((id) => /nvoice|efund/.test(id)));
  const browse = searchOperations(SHOP.ops, "", { limit: 3 });
  assert.equal(browse.hits.length, 3);
  assert.equal(browse.total, SHOP.ops.length);
});

test("a big spec indexes fast and searches fast", () => {
  const paths = {};
  for (let i = 0; i < 1500; i++) {
    paths[`/resource${i}/{id}`] = {
      get: { operationId: `getResource${i}`, summary: `Fetch resource number ${i}`, tags: [`group${i % 40}`], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
      put: { operationId: `updateResource${i}`, summary: `Update resource ${i}`, requestBody: { content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } } } },
    };
  }
  paths["/special/widgets"] = { post: { operationId: "assembleWidget", summary: "Assemble a widget from parts" } };
  const raw = { openapi: "3.0.0", info: { title: "Big", version: "1" }, paths };
  const t0 = Date.now();
  const handle = new SpecHandle(raw);
  const built = Date.now() - t0;
  assert.equal(handle.ops.length, 3001);
  assert.ok(built < 3000, `indexing took ${built} ms`);
  const t1 = Date.now();
  const hit = searchOperations(handle.ops, "assemble widget");
  assert.equal(hit.hits[0].id, "assembleWidget");
  assert.ok(Date.now() - t1 < 500);
  assert.equal(handle.operation("updateResource1234").body.schema.properties.a.type, "string");
});

// ─── request building ────────────────────────────────────────────────────────

function built(spec, opId, params, body, defOver = {}, authOver) {
  const handle = new SpecHandle(spec);
  const op = handle.operation(opId);
  const def = { id: "t", label: "T", blurb: "", specSource: { kind: "inline" }, auth: { type: "none" }, ...defOver };
  return buildRequest({
    def,
    op,
    baseUrl: def.baseUrl ?? "https://api.example.com/v1",
    params,
    body,
    auth: authOver ?? { headers: {}, query: [], cookies: [], secrets: [], headerNames: [], queryNames: [] },
  });
}

test("buildRequest: path, query, header and cookie parameters", () => {
  const r = built(PETS, "getPet", { petId: "a b/c", "X-Trace": "t1", session: "s=1" });
  assert.equal(r.method, "GET");
  assert.equal(r.url, "https://api.example.com/v1/pets/a%20b%2Fc");
  assert.equal(r.headers["x-trace"], "t1");
  assert.equal(r.headers.cookie, "session=s=1");

  const l = built(PETS, "listPets", { limit: "25", tags: ["a", "b c"] });
  assert.equal(l.url, "https://api.example.com/v1/pets?limit=25&tags=a&tags=b%20c", "arrays explode by default in form style");
  const csv = built({ ...PETS, paths: { "/q": { get: { operationId: "q", parameters: [{ name: "ids", in: "query", explode: false, schema: { type: "array", items: { type: "integer" } } }] } } } }, "q", { ids: [1, 2, 3] });
  assert.equal(csv.url, "https://api.example.com/v1/q?ids=1%2C2%2C3");
  const pipe = built({ swagger: "2.0", info: { title: "s", version: "1" }, host: "h.example", paths: { "/q": { get: { operationId: "q", parameters: [{ name: "ids", in: "query", type: "array", items: { type: "string" }, collectionFormat: "pipes" }] } } } }, "q", { ids: ["a", "b"] });
  assert.equal(pipe.url, "https://api.example.com/v1/q?ids=a%7Cb");
});

test("buildRequest: an undeclared or traversing value is refused with a teaching message", () => {
  assert.throws(() => built(PETS, "getPet", { petId: ".." }), /may not be/);
  assert.throws(() => built(PETS, "getPet", { petId: "." }), /may not be/);
  assert.throws(() => built(PETS, "getPet", {}), /missing required parameter: petId \(path, string, required\)/);
  assert.throws(() => built(PETS, "getPet", { petId: "1", petID: "2", bogus: 1 }), /no parameter .*bogus/);
  try {
    built(PETS, "listPets", { limt: 5 });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof ApiInputError);
    assert.match(err.message, /did you mean "limit"/);
    assert.match(err.message, /Its parameters: limit \(query, integer/);
  }
  assert.throws(() => built(PETS, "listPets", { limit: "lots" }), /"limit" must be an integer/);
  assert.throws(() => built(PETS, "listPets", { limit: 1000 }), /must be <= 100/);
  assert.throws(() => built(PETS, "listPets", { limit: 5 }, { a: 1 }), /does not take a body/);
  // the model passing body fields as params is pointed at `body`
  assert.throws(() => built(PETS, "createPet", { name: "Rex" }, undefined), /Put request-body fields in `body`/);
});

test("buildRequest: JSON, form and multipart bodies; required body and fields", () => {
  const r = built(PETS, "createPet", {}, { name: "Rex", tag: "dog" });
  assert.equal(r.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(r.body), { name: "Rex", tag: "dog" });
  assert.deepEqual(JSON.parse(built(PETS, "createPet", {}, '{"name":"Str"}').body), { name: "Str" }, "a JSON string is parsed");
  assert.throws(() => built(PETS, "createPet", {}, "not json"), /does not parse/);
  assert.throws(() => built(PETS, "createPet", {}, undefined), /needs a request body.*Shape:/);
  assert.throws(() => built(PETS, "createPet", {}, { tag: "dog" }), /missing required field: name/);

  const formSpec = {
    openapi: "3.0.0",
    info: { title: "f", version: "1" },
    paths: {
      "/f": { post: { operationId: "f", requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { a: { type: "string" }, b: { type: "array", items: { type: "string" } } } } } } } } },
      "/m": { post: { operationId: "m", requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } } } },
    },
  };
  const form = built(formSpec, "f", {}, { a: "x y", b: ["1", "2"] });
  assert.equal(form.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(form.body, "a=x+y&b=1&b=2");
  const multi = built(formSpec, "m", {}, { a: "1", b: { k: 1 } });
  assert.match(multi.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(multi.body.toString(), /name="a"\r\n\r\n1/);
  assert.match(multi.body.toString(), /name="b"\r\n\r\n\{"k":1\}/);
  assert.equal(built(formSpec, "f", {}, "a=1&b=2").body, "a=1&b=2", "a ready-made form string passes through");
});

test("buildRequest: an operation's own server is used only when its origin is on the service's allowlist", () => {
  const spec = { openapi: "3.0.0", info: { title: "m", version: "1" }, paths: { "/geo": { get: { operationId: "geo", servers: [{ url: "https://geo.example.com" }], responses: {} } }, "/evil": { get: { operationId: "evil", servers: [{ url: "https://evil.example.org" }], responses: {} } } } };
  assert.equal(built(spec, "geo", {}, undefined, { extraOrigins: ["https://geo.example.com"] }).url, "https://geo.example.com/geo");
  assert.equal(built(spec, "geo", {}, undefined, {}).url, "https://api.example.com/v1/geo", "not allowlisted: the base URL wins");
  assert.equal(built(spec, "evil", {}, undefined, { extraOrigins: ["https://geo.example.com"] }).url, "https://api.example.com/v1/evil");
});

// ─── auth ────────────────────────────────────────────────────────────────────

const KEYED = { openapi: "3.0.0", info: { title: "k", version: "1" }, paths: { "/ping": { get: { operationId: "ping", parameters: [{ name: "api_key", in: "query", schema: { type: "string" } }], responses: { 200: { description: "ok" } } } }, "/me": { get: { operationId: "me", responses: {} } } } };

async function echoServer(t) {
  return startServer(t, (req, res, entry) => json(res, { path: req.url, headers: entry.headers }));
}

test("auth: apiKey in header, query and cookie; bearer with a custom header and scheme; basic; none", async (t) => {
  const srv = await echoServer(t);
  const cases = [
    { auth: { type: "apiKey", in: "header", name: "X-Api-Key" }, secret: "sk-header-key-123456", check: (r) => assert.equal(r.headers["x-api-key"], "sk-header-key-123456") },
    { auth: { type: "apiKey", in: "query", name: "api_key" }, secret: "query-key-abcdef", check: (r) => assert.match(r.url, /api_key=query-key-abcdef/) },
    { auth: { type: "apiKey", in: "cookie", name: "sid" }, secret: "cookie-secret-xyz", check: (r) => assert.match(r.headers.cookie, /sid=cookie-secret-xyz/) },
    { auth: { type: "bearer" }, secret: "tok_bearer_123456", check: (r) => assert.equal(r.headers.authorization, "Bearer tok_bearer_123456") },
    { auth: { type: "bearer", header: "X-Token", scheme: "Token" }, secret: "tok_custom_123456", check: (r) => assert.equal(r.headers["x-token"], "Token tok_custom_123456") },
  ];
  for (const c of cases) {
    const id = uid("auth");
    await addLocal(t, id, KEYED, srv, { auth: c.auth });
    await setCredential(`API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`, c.secret);
    const r = await apiCall({ service: id, operationId: "ping" });
    assert.equal(r.status, 200);
    c.check(srv.requests.at(-1)); // what the SERVER received
    assert.ok(!JSON.stringify(r).includes(c.secret), `the secret never comes back out, even echoed by the server: ${c.auth.type}`);
  }
  // basic
  const basic = uid("basic");
  await addLocal(t, basic, KEYED, srv, { auth: { type: "basic" } });
  const pfx = `API_${basic.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  await setCredential(`${pfx}_USER`, "alice");
  await setCredential(`${pfx}_PASS`, "s3cret-pass");
  const b = await apiCall({ service: basic, operationId: "me" });
  assert.equal(srv.requests.at(-1).headers.authorization, `Basic ${Buffer.from("alice:s3cret-pass").toString("base64")}`);
  assert.ok(!JSON.stringify(b).includes("s3cret-pass"));
  // none
  const none = uid("none");
  await addLocal(t, none, KEYED, srv, { auth: { type: "none" } });
  const n = await apiCall({ service: none, operationId: "me" });
  assert.equal(srv.requests.at(-1).headers.authorization, undefined);
  assert.equal(n.status, 200);
});

test("auth: a missing credential says how to connect it; an optional key degrades; the model cannot supply the key param", async (t) => {
  const srv = await echoServer(t);
  const id = uid("nokey");
  await addLocal(t, id, KEYED, srv, { auth: { type: "apiKey", in: "query", name: "api_key" } });
  await assert.rejects(() => apiCall({ service: id, operationId: "ping" }), (e) => e instanceof ApiInputError && new RegExp(`Connect with service "api-${id}"`).test(e.message) && /never in chat/.test(e.message));
  const opt = uid("optkey");
  await addLocal(t, opt, KEYED, srv, { auth: { type: "apiKey", in: "query", name: "api_key", optional: true } });
  const r = await apiCall({ service: opt, operationId: "ping" });
  assert.equal(r.status, 200);
  // a model passing the auth param itself is ignored, not sent
  await setCredential(`API_${opt.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`, "real-key-123456");
  const r2 = await apiCall({ service: opt, operationId: "ping", params: { api_key: "model-invented" } });
  assert.match(srv.requests.at(-1).url, /api_key=real-key-123456/);
  assert.doesNotMatch(srv.requests.at(-1).url, /model-invented/);
  assert.equal(r2.status, 200);
});

test("auth: OAuth2 client-credentials fetches a token once and caches it until it expires", async (t) => {
  clearOAuthCache();
  let tokens = 0;
  const srv = await startServer(t, (req, res, entry) => {
    if (req.url === "/token") {
      tokens++;
      assert.equal(entry.headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
      assert.match(entry.body, /grant_type=client_credentials/);
      assert.match(entry.body, /scope=read/);
      return json(res, { access_token: `at-${tokens}-abcdefgh`, expires_in: 3600 });
    }
    return json(res, { seen: entry.headers.authorization });
  });
  const id = uid("oauth");
  await addLocal(t, id, KEYED, srv, { auth: { type: "oauth2cc", tokenUrl: `${srv.url}/token`, scope: "read" } });
  const pfx = `API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  await assert.rejects(() => apiCall({ service: id, operationId: "me" }), /no client id\/secret stored/);
  await setCredential(`${pfx}_CLIENT_ID`, "cid");
  await setCredential(`${pfx}_CLIENT_SECRET`, "csecret");
  const a = await apiCall({ service: id, operationId: "me" });
  const b = await apiCall({ service: id, operationId: "me" });
  const metCalls = srv.requests.filter((r) => r.url === "/me");
  assert.equal(metCalls.length, 2);
  assert.ok(metCalls.every((r) => r.headers.authorization === "Bearer at-1-abcdefgh"));
  assert.equal(b.status, 200);
  assert.equal(tokens, 1, "the token is cached");
  assert.ok(!JSON.stringify(a).includes("at-1-abcdefgh"));
  // a refused token request teaches
  clearOAuthCache();
  await setCredential(`${pfx}_CLIENT_SECRET`, "wrong");
  const bad = await startServer(t, (req, res) => json(res, { error: "invalid_client" }, 401));
  const id2 = uid("oauth");
  await addLocal(t, id2, KEYED, srv, { auth: { type: "oauth2cc", tokenUrl: `${bad.url}/token` } });
  const pfx2 = `API_${id2.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  await setCredential(`${pfx2}_CLIENT_ID`, "cid");
  await setCredential(`${pfx2}_CLIENT_SECRET`, "nope");
  await assert.rejects(() => apiCall({ service: id2, operationId: "me" }), /token endpoint refused the client credentials \(HTTP 401\)/);
});

// ─── the network guard ───────────────────────────────────────────────────────

test("classifyAddress: metadata and link-local always, LAN classes by name, IPv4-in-IPv6 unwrapped", () => {
  const table = {
    "8.8.8.8": "public",
    "93.184.216.34": "public",
    "127.0.0.1": "loopback",
    "127.255.255.254": "loopback",
    "10.1.2.3": "private",
    "172.16.0.1": "private",
    "172.31.255.255": "private",
    "172.32.0.1": "public",
    "192.168.1.41": "private",
    "100.64.0.1": "private",
    "169.254.169.254": "metadata",
    "169.254.1.1": "linklocal",
    "100.100.100.200": "metadata",
    "168.63.129.16": "metadata",
    "0.0.0.0": "unspecified",
    "224.0.0.1": "multicast",
    "255.255.255.255": "reserved",
    "192.0.2.1": "reserved",
    "::1": "loopback",
    "::": "unspecified",
    "fe80::1": "linklocal",
    "fd00:ec2::254": "metadata",
    "fd12:3456::1": "private",
    "ff02::1": "multicast",
    "2001:db8::1": "reserved",
    "2606:4700:4700::1111": "public",
    "::ffff:127.0.0.1": "loopback",
    "::ffff:169.254.169.254": "metadata",
    "::ffff:8.8.8.8": "public",
    "64:ff9b::a9fe:a9fe": "metadata",
    "2002:a9fe:a9fe::1": "metadata",
    "2002:0808:0808::1": "public",
  };
  for (const [ip, want] of Object.entries(table)) assert.equal(classifyAddress(ip), want, ip);
  assert.equal(classifyAddress("not-an-ip"), "reserved");
});

test("assertUrlAllowed: scheme, userinfo, metadata names, literal and obfuscated IPs", () => {
  const strict = { allowLan: false };
  const lan = { allowLan: true };
  const ok = (u, p) => assert.doesNotThrow(() => assertUrlAllowed(new URL(u), p), u);
  const no = (u, p, re) => assert.throws(() => assertUrlAllowed(new URL(u), p), re, u);
  ok("https://api.example.com/x", strict);
  no("http://api.example.com/x", strict, /plain http/);
  no("file:///etc/passwd", strict, /only http\(s\)/);
  no("ftp://example.com/", strict, /only http\(s\)/);
  no("https://user:pw@example.com/", strict, /embedded credentials/);
  no("https://169.254.169.254/latest/meta-data", strict, /metadata/);
  no("https://169.254.169.254/latest/meta-data", lan, /metadata/);
  no("http://169.254.169.254/", lan, /metadata/);
  no("https://metadata.google.internal/", lan, /metadata/);
  no("https://[fd00:ec2::254]/", lan, /metadata/);
  no("https://[::ffff:169.254.169.254]/", lan, /metadata/);
  no("http://0251.0376.0251.0376/", lan, /metadata/); // octal form: the URL parser normalises it
  no("http://2852039166/", lan, /metadata/); // decimal form
  no("http://0xA9FEA9FE/", lan, /metadata/); // hex form
  no("https://127.0.0.1/", strict, /loopback/);
  no("https://localhost/", strict, /loopback/);
  no("https://foo.localhost/", strict, /loopback/);
  no("https://10.0.0.5/", strict, /private/);
  ok("http://192.168.1.41:8123/api", lan);
  ok("https://192.168.1.41/", lan);
  no("http://8.8.8.8/", lan, /plain http to a public address/);
  no("https://224.0.0.1/", lan, /multicast/);
});

test("safeFetch: a public-looking name that resolves to a private address is refused (DNS rebinding)", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { reached: true }));
  const rebind = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(() => safeFetch(`https://rebind.example.com:${srv.port}/`, { allowLan: false, resolver: rebind }), /private\/loopback/);
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
  await assert.rejects(() => safeFetch("https://mixed.example.com/", { allowLan: false, resolver: mixed }), /private\/loopback/, "one bad answer fails the lot");
  const meta = async () => [{ address: "169.254.169.254", family: 4 }];
  await assert.rejects(() => safeFetch("https://meta.example.com/", { allowLan: true, resolver: meta }), /metadata/, "LAN permission never covers metadata");
  const none = async () => [];
  await assert.rejects(() => safeFetch("https://gone.example.com/", { allowLan: false, resolver: none }), /did not resolve/);
});

test("safeFetch: the address that was validated is the address that is used — one resolution, one connection", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { reached: true }));
  let lookups = 0;
  const resolver = async () => {
    lookups++;
    return [{ address: "127.0.0.1", family: 4 }];
  };
  const r = await safeFetch(`http://lan.test:${srv.port}/ok`, { allowLan: true, resolver });
  assert.equal(r.status, 200);
  assert.equal(lookups, 1);
  // plain http to a name that resolves PUBLIC is refused even with allowLan
  await assert.rejects(() => safeFetch("http://pub.example.com/", { allowLan: true, resolver: async () => [{ address: "93.184.216.34", family: 4 }] }), /plain http to pub.example.com/);
});

test("safeFetch: redirects are re-checked — to metadata, to a private host, across origins with credentials, and for writes", async (t) => {
  const target = await startServer(t, (req, res, entry) => json(res, { auth: entry.headers.authorization ?? null, cookie: entry.headers.cookie ?? null, xkey: entry.headers["x-api-key"] ?? null, url: req.url }));
  const resolver = async (host) => {
    if (host === "a.test" || host === "b.test") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected lookup ${host}`);
  };
  const origin = await startServer(t, (req, res) => {
    if (req.url.split("?")[0] === "/to-b") { res.writeHead(302, { location: `http://b.test:${target.port}/landed?api_key=K&keep=1` }); return res.end(); }
    if (req.url.split("?")[0] === "/to-meta") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
    if (req.url.split("?")[0] === "/to-private") { res.writeHead(302, { location: "http://10.9.9.9/admin" }); return res.end(); }
    if (req.url.split("?")[0] === "/same") { res.writeHead(302, { location: "/landed-same" }); return res.end(); }
    if (req.url.split("?")[0] === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (req.url.split("?")[0] === "/to-get") { res.writeHead(303, { location: `/landed-same` }); return res.end(); }
    return json(res, { url: req.url, method: req.method });
  });
  const base = `http://a.test:${origin.port}`;
  const common = { allowLan: true, resolver, credentialHeaders: ["x-api-key"], credentialQuery: ["api_key"] };
  const creds = { authorization: "Bearer topsecret", cookie: "sid=1", "x-api-key": "K" };

  // cross-origin: every credential is dropped, the innocent query parameter stays
  const cross = await safeFetch(`${base}/to-b?api_key=K`, { ...common, headers: creds });
  const seen = JSON.parse(cross.body.toString());
  assert.ok("auth" in seen, `landed on the wrong server: ${cross.body.toString()} via ${cross.finalUrl}`);
  assert.equal(seen.auth, null);
  assert.equal(seen.cookie, null);
  assert.equal(seen.xkey, null);
  assert.equal(seen.url, "/landed?keep=1", "the credential query parameter was stripped");
  assert.equal(cross.redirects.length, 1);

  // same origin: credentials survive
  const same = await safeFetch(`${base}/same`, { ...common, headers: creds });
  assert.equal(same.status, 200);

  await assert.rejects(() => safeFetch(`${base}/to-meta`, { ...common, headers: creds }), /metadata/);
  await assert.rejects(() => safeFetch(`${base}/to-private`, { allowLan: false, resolver, headers: {} }), /private|plain http/);
  await assert.rejects(() => safeFetch(`${base}/to-b`, { ...common, method: "POST", body: "x", headers: creds }), /cross-origin redirect .* for a POST/);
  await assert.rejects(() => safeFetch(`${base}/loop`, { ...common, headers: {} }), /too many redirects/);
  // 303 turns a POST into a GET with no body
  const afterPost = await safeFetch(`${base}/to-get`, { ...common, method: "POST", body: "payload", headers: { "content-type": "text/plain" } });
  assert.equal(JSON.parse(afterPost.body.toString()).method, "GET");
});

test("safeFetch: size cap, compressed bodies, and timeouts", async (t) => {
  const big = "x".repeat(200_000);
  const srv = await startServer(t, (req, res) => {
    if (req.url === "/big") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(big); }
    if (req.url === "/gzip") { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); return res.end(zlib.gzipSync(JSON.stringify({ hello: "world" }))); }
    if (req.url === "/bomb") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); return res.end(zlib.gzipSync(Buffer.alloc(5_000_000, 97))); }
    if (req.url === "/hang") return; // never answers
    res.end("ok");
  });
  const opts = { allowLan: true };
  const r = await safeFetch(`${srv.url}/big`, { ...opts, maxBytes: 50_000 });
  assert.equal(r.truncated, true);
  assert.ok(r.body.length <= 50_000);
  const z = await safeFetch(`${srv.url}/gzip`, opts);
  assert.deepEqual(JSON.parse(z.body.toString()), { hello: "world" });
  await assert.rejects(() => safeFetch(`${srv.url}/bomb`, { ...opts, maxBytes: 100_000 }), /could not decode the gzip response/);
  const t0 = Date.now();
  await assert.rejects(() => safeFetch(`${srv.url}/hang`, { ...opts, timeoutMs: 300 }), /timed out/);
  assert.ok(Date.now() - t0 < 3000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => safeFetch(`${srv.url}/hang`, { ...opts, signal: ac.signal, timeoutMs: 5000 }), /cancelled/);
});

// ─── end to end through the tool ─────────────────────────────────────────────

test("the Api tool: services, search, describe, call — and errors that teach", async (t) => {
  const srv = await startServer(t, (req, res, entry) => {
    if (req.url.startsWith("/pets/missing")) return json(res, { message: "no such pet" }, 404);
    if (req.method === "POST") return json(res, { created: JSON.parse(entry.body) }, 201);
    return json(res, { pets: [{ id: 1, name: "Rex" }, { id: 2, name: "Tom" }], echo: req.url });
  });
  const id = uid("pets");
  const added = await addLocal(t, id, PETS, srv, { auth: { type: "none" } });
  assert.equal(added.operations, 6);

  const call = (input) => ApiTool.call(ApiTool.inputZod.parse(input), ctx());

  const services = await call({ action: "services" });
  assert.ok(services.output.services.some((s) => s.id === id && s.preset === false && s.operations === 6));
  assert.ok(services.output.services.some((s) => s.id === "open-meteo" && s.access === "no-key"));
  assert.ok(services.output.services.some((s) => s.id === "home-assistant" && s.access === "not-connected" && /api-home-assistant/.test(s.connect)));

  const search = await call({ action: "search", service: id, query: "create pet" });
  assert.equal(search.output.results[0].operationId, "createPet");
  assert.equal(search.output.results[0].method, "POST");

  const describe = await call({ action: "describe", service: id, operationId: "createPet" });
  assert.match(describe.output.operation.access, /WRITE — asks the owner/);
  assert.equal(describe.output.operation.body.required, true);
  assert.deepEqual(describe.output.operation.body.schema.required, ["name"]);
  const describeDelete = await call({ action: "describe", service: id, operationId: "deletePet" });
  assert.match(describeDelete.output.operation.access, /always the owner's decision/);
  const describeGet = await call({ action: "describe", service: id, operationId: "listPets" });
  assert.match(describeGet.output.operation.access, /read/);

  const listed = await call({ action: "call", service: id, operationId: "listPets", params: { limit: 2 } });
  assert.equal(listed.failure, undefined);
  assert.equal(listed.output.status, 200);
  assert.equal(listed.output.data.pets.length, 2);
  assert.match(listed.output.data.echo, /^\/pets\?limit=2/);

  const narrowed = await call({ action: "call", service: id, operationId: "listPets", select: "pets.*.name" });
  assert.deepEqual(narrowed.output.data, ["Rex", "Tom"]);
  const sliced = await call({ action: "call", service: id, operationId: "listPets", select: "pets.0:1" });
  assert.deepEqual(sliced.output.data.map((p) => p.id), [1]);

  const created = await call({ action: "call", service: id, operationId: "createPet", body: { name: "Fido" } });
  assert.equal(created.output.status, 201);
  assert.deepEqual(srv.requests.at(-1).body, '{"name":"Fido"}');

  const missing = await call({ action: "call", service: id, operationId: "getPet", params: { petId: "missing" } });
  assert.match(missing.failure, /HTTP 404/);
  assert.equal(missing.output.status, 404);

  // errors that teach
  const noParam = await call({ action: "call", service: id, operationId: "getPet", params: {} });
  assert.match(noParam.failure, /missing required parameter: petId/);
  const wrongOp = await call({ action: "call", service: id, operationId: "listPet" });
  assert.match(wrongOp.failure, /has no operation "listPet".*Closest: listPets/);
  const wrongService = await call({ action: "call", service: "nope", operationId: "x" });
  assert.match(wrongService.failure, /no service "nope"\. Known services: open-meteo/);
  assert.match((await call({ action: "call", service: id })).failure, /needs operationId/);
  assert.match((await call({ action: "search" })).failure, /needs service/);
});

test("the Api tool: add validates, refuses preset ids and dangerous bases, and removes", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, {}));
  const call = (input) => ApiTool.call(ApiTool.inputZod.parse(input), ctx());
  assert.match((await call({ action: "add", service: "open-meteo", spec: JSON.stringify(PETS), base_url: "https://x.example.com" })).failure, /built-in preset id/);
  assert.match((await call({ action: "add", service: "Bad_ID", spec: "{}" })).failure, /lowercase/);
  assert.match((await call({ action: "add", service: uid("m"), spec: "hello: world", base_url: "https://x.example.com" })).failure, /not a usable OpenAPI spec/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "http://169.254.169.254/" })).failure, /not allowed.*metadata|metadata/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "http://127.0.0.1:9/" })).failure, /not allowed/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "https://x.example.com", insecure_tls: true })).failure, /only allowed together with allow_lan/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "https://x.example.com", auth: { type: "apiKey" } })).failure, /needs `in`/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "https://x.example.com", headers: { Authorization: "Bearer abc" } })).failure, /may not carry credentials/);
  assert.match((await call({ action: "add", service: uid("m"), spec: JSON.stringify(PETS), base_url: "https://x.example.com", headers: { "X-Api-Key": "abc" } })).failure, /may not carry credentials/);
  assert.match((await call({ action: "add", service: uid("m"), spec_url: "http://169.254.169.254/openapi.json" })).failure, /blocked by the network guard/);
  assert.match((await call({ action: "add", service: uid("m"), spec_url: "file:///etc/passwd" })).failure, /blocked by the network guard/);
  // a spec can be fetched from a URL (LAN allowed for this one) and its auth is taken from the spec
  const specSrv = await startServer(t, (req, res) => json(res, PETS));
  const id = uid("fromurl");
  const ok = await call({ action: "add", service: id, spec_url: `${specSrv.url}/openapi.json`, base_url: srv.url, allow_lan: true });
  t.after(() => removeApiService(id));
  assert.equal(ok.failure, undefined, ok.output.message);
  assert.match(ok.output.message, /authentication: apiKey \(from the spec: key: API key in header "X-Api-Key"\)/);
  assert.match(ok.output.message, new RegExp(`Connect with service "api-${id}"`));
  const refreshed = await call({ action: "refresh", service: id });
  assert.match(refreshed.output.message, /6 operations/);
  assert.match((await call({ action: "remove", service: id })).output.message, /Removed/);
  assert.match((await call({ action: "remove", service: "open-meteo" })).failure, /built-in preset/);
});

// ─── gating ──────────────────────────────────────────────────────────────────

const RISKY = {
  openapi: "3.0.0",
  info: { title: "Risky", version: "1" },
  paths: {
    "/items": { get: { operationId: "listItems", responses: {} }, post: { operationId: "createItem", responses: {} } },
    "/items/{id}": { delete: { operationId: "removeItem", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: {} }, put: { operationId: "updateItem", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: {} } },
    "/payments/{id}/refund": { post: { operationId: "refundPayment", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: {} } },
    "/search": { post: { operationId: "searchItems", responses: {} } },
    "/services/{domain}/{service}": { post: { operationId: "callService", parameters: [{ name: "domain", in: "path", required: true, schema: { type: "string" } }, { name: "service", in: "path", required: true, schema: { type: "string" } }], responses: {} } },
    "/danger/reset-database": { post: { operationId: "resetDatabase", responses: {} } },
  },
};

test("writes ask; DELETE and destructive or financial-looking operations are always the owner's decision", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { ok: true }));
  const id = uid("risky");
  await addLocal(t, id, RISKY, srv, { readOperationIds: ["searchItems"] });
  const kind = (op, params) => classifyApiCall(id, op, params);
  assert.equal(kind("listItems").kind, "read");
  assert.equal(kind("searchItems").kind, "read", "a declared read-only POST runs freely");
  assert.deepEqual([kind("createItem").kind, kind("createItem").destructive, kind("createItem").financial], ["write", false, false]);
  assert.equal(kind("updateItem").destructive, false);
  assert.equal(kind("removeItem").destructive, true);
  assert.equal(kind("refundPayment").financial, true);
  assert.equal(kind("resetDatabase").destructive, true);
  assert.equal(kind("callService", { domain: "light", service: "turn_on" }).destructive, false);
  assert.equal(kind("callService", { domain: "lock", service: "unlock" }).destructive, true);
  assert.equal(kind("callService", { domain: "homeassistant", service: "restart" }).destructive, true);
  assert.equal(classifyApiCall("no-such", "x").kind, "unknown");
  assert.equal(classifyApiCall(id, "no-such-op").kind, "unknown");

  const permit = (input, mode) => ApiTool.checkPermissions(ApiTool.inputZod.parse(input), ctx(mode));
  // reads: always allowed, in every mode
  assert.equal((await permit({ action: "call", service: id, operationId: "listItems" }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "search", service: id, query: "x" }, "workspace-write")).kind, "allow");
  assert.equal((await permit({ action: "call", service: id, operationId: "searchItems" }, "workspace-write")).kind, "allow");
  // an ordinary write asks in a guarded mode, runs in bypass ("free"), and is denied while planning
  assert.equal((await permit({ action: "call", service: id, operationId: "createItem", body: {} }, "workspace-write")).kind, "ask");
  assert.equal((await permit({ action: "call", service: id, operationId: "createItem", body: {} }, "bypass")).kind, "allow");
  assert.equal((await permit({ action: "call", service: id, operationId: "createItem", body: {} }, "plan")).kind, "deny");
  // DELETE / destructive / financial: the owner's decision even in bypass
  for (const op of ["removeItem", "refundPayment", "resetDatabase"]) {
    const d = await permit({ action: "call", service: id, operationId: op, params: { id: "1" } }, "bypass");
    assert.equal(d.kind, "ask", op);
    assert.equal(d.ownerDecision, true, op);
  }
  const unlock = await permit({ action: "call", service: id, operationId: "callService", params: { domain: "lock", service: "unlock" } }, "bypass");
  assert.equal(unlock.ownerDecision, true);
  // adding a LAN service is the owner's decision
  const lan = await permit({ action: "add", service: "x-home", spec: "{}", allow_lan: true, base_url: "http://192.168.1.2" }, "bypass");
  assert.equal(lan.ownerDecision, true);
  // changing what Ares may reach is configuration: it asks even in bypass (not an owner-only decision unless LAN)
  assert.equal((await permit({ action: "add", service: "x-web", spec: "{}" }, "bypass")).kind, "ask");
  assert.equal((await permit({ action: "add", service: "x-web", spec: "{}" }, "workspace-write")).kind, "ask");
  assert.equal((await permit({ action: "add", service: "x-web", spec: "{}" }, "plan")).kind, "deny");

  // and the structured gate makes it stick on the phone / unattended loop
  const cat = (input) => classifyToolRequest({ toolName: "Api", reason: "", input: { action: "call", service: id, ...input } });
  assert.equal(cat({ operationId: "listItems" }), null);
  assert.equal(cat({ operationId: "searchItems" }), null);
  assert.equal(cat({ operationId: "createItem" }), "browser_submit");
  assert.equal(cat({ operationId: "removeItem" }), "shell_destructive");
  assert.equal(cat({ operationId: "refundPayment" }), "payment_or_purchase");
  assert.equal(classifyToolRequest({ toolName: "Api", reason: "", input: { action: "add", service: "x" } }), "credential_or_secret");
  assert.equal(classifyToolRequest({ toolName: "Api", reason: "", input: { action: "search", service: id } }), null);
  assert.equal(remoteAutonomyDecision({ toolName: "Api", reason: "", input: { action: "call", service: id, operationId: "createItem" } }), "ask");
  assert.equal(remoteAutonomyDecision({ toolName: "Api", reason: "", input: { action: "call", service: id, operationId: "listItems" } }), "allow");
});

// ─── redaction and limits ────────────────────────────────────────────────────

test("secrets never come back: echoed headers, echoed bodies, displayed URLs, the audit log", async (t) => {
  const SECRET = "live-key-ABCDEF123456";
  const srv = await startServer(t, (req, res, entry) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "sid=abc123; HttpOnly",
      "x-debug-token": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz",
      "x-ratelimit-remaining": "41",
      "x-secret-echo": entry.headers["x-api-key"] ?? "none",
      etag: "W/\"abc\"",
    });
    res.end(JSON.stringify({ youSent: entry.headers["x-api-key"], also: `key=${entry.headers["x-api-key"]}`, nested: { echoed: [entry.headers["x-api-key"]] } }));
  });
  const id = uid("leaky");
  await addLocal(t, id, KEYED, srv, { auth: { type: "apiKey", in: "header", name: "X-Api-Key" } });
  await setCredential(`API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`, SECRET);
  const r = await apiCall({ service: id, operationId: "me" });
  const everything = JSON.stringify(r);
  assert.ok(!everything.includes(SECRET), "the key is not in the result");
  assert.match(everything, /\[redacted\]/);
  assert.equal(r.headers["set-cookie"], "[redacted]");
  assert.equal(r.headers["x-ratelimit-remaining"], "41", "useful headers are kept");
  assert.equal(r.headers["x-debug-token"], undefined, "unknown headers are not echoed");
  assert.equal(r.headers["x-secret-echo"], undefined);
  assert.equal(r.data.youSent, "[redacted]");

  // a query-string key is masked in the URL shown
  const q = uid("qkey");
  await addLocal(t, q, KEYED, srv, { auth: { type: "apiKey", in: "query", name: "api_key" } });
  await setCredential(`API_${q.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`, SECRET);
  const r2 = await apiCall({ service: q, operationId: "me" });
  assert.match(r2.url, /api_key=\*\*\*/);
  assert.ok(!r2.url.includes(SECRET));
  // and never in the audit log
  const audit = await fsp.readFile(path.join(apiServicesDir(), "audit.jsonl"), "utf8");
  assert.ok(!audit.includes(SECRET));
  assert.match(audit, new RegExp(`"service":"${q}"`));

  // the pure helpers
  assert.equal(redactText("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"]), "a [redacted] b [redacted]");
  assert.equal(redactText("tiny", ["ab"]), "tiny", "a too-short secret is not used as a needle");
  for (const token of ["Bearer abcdefghijkl", "sk_live_abcdefghijklmnopqrstuv", "ghp_abcdefghijklmnopqrstuvwxyz", "AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-abc", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl"]) {
    assert.match(redactTokens(`x ${token} y`), /\[redacted-token\]/, token);
  }
  assert.deepEqual(visibleHeaders({ authorization: "Bearer zzzzzzzzzz", "content-type": "text/plain", "x-foo": "1", link: "<https://a>; rel=next" }, []), { authorization: "[redacted]", "content-type": "text/plain", link: "<https://a>; rel=next" });
});

test("limits: output cap, response cap, rate limit and minimum interval", async (t) => {
  const srv = await startServer(t, (req, res) => {
    if (req.url === "/big") return json(res, { items: Array.from({ length: 5000 }, (_, i) => ({ i, label: "x".repeat(20) })) });
    if (req.url === "/huge") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("y".repeat(3_000_000)); }
    return json(res, { ok: true });
  });
  const spec = { openapi: "3.0.0", info: { title: "l", version: "1" }, paths: { "/big": { get: { operationId: "big", responses: {} } }, "/huge": { get: { operationId: "huge", responses: {} } }, "/ok": { get: { operationId: "ok", responses: {} } } } };
  const id = uid("limits");
  await addLocal(t, id, spec, srv, { auth: { type: "none" }, ratePerMin: 4 });
  resetRateLimits();
  const r = await apiCall({ service: id, operationId: "big" }, {}, { maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1002);
  assert.ok(r.notes.some((n) => /output cut to 1000 characters.*select/.test(n)));
  const h = await apiCall({ service: id, operationId: "huge" }, {}, { maxBytes: 100_000 });
  assert.equal(h.truncated, true);
  assert.ok(h.notes.some((n) => /exceeded 98 KB/.test(n) || /exceeded/.test(n)));
  await apiCall({ service: id, operationId: "ok" });
  await apiCall({ service: id, operationId: "ok" });
  await assert.rejects(() => apiCall({ service: id, operationId: "ok" }), /rate-limited to 4 calls a minute/);

  const spaced = uid("spaced");
  await addLocal(t, spaced, spec, srv, { auth: { type: "none" } });
  // minIntervalMs is a service property; set it on the stored def
  const defFile = path.join(apiServicesDir(), spaced, "def.json");
  const def = JSON.parse(await fsp.readFile(defFile, "utf8"));
  def.minIntervalMs = 250;
  await fsp.writeFile(defFile, JSON.stringify(def));
  resetRateLimits();
  const t0 = Date.now();
  await apiCall({ service: spaced, operationId: "ok" });
  await apiCall({ service: spaced, operationId: "ok" });
  assert.ok(Date.now() - t0 >= 240, "the second call waited out the interval");
});

// ─── the phone: Connections list, secure form, live verifier ─────────────────

test("a service that needs a key appears in Connections, resolves by name, and its form verifies the key live", async (t) => {
  const srv = await startServer(t, (req, res, entry) => {
    if (entry.headers["x-api-key"] === "good-key-123456") return json(res, { me: "alice" });
    return json(res, { error: "bad key" }, 401);
  });
  const id = uid("crm");
  await addLocal(t, id, KEYED, srv, { auth: { type: "apiKey", in: "header", name: "X-Api-Key" } });
  const connectId = `api-${id}`;
  const service = resolveConnectService(connectId);
  assert.ok(service, "resolves by its api- id");
  assert.equal(service.kind, "api-key");
  assert.equal(service.fields[0].secret, true);
  assert.equal(service.fields[0].credential, `API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`);
  assert.ok(CONNECT_SERVICES.some((s) => s.id === connectId), "registered, so the phone's list shows it");
  // presets that need something are registered from the start
  assert.ok(CONNECT_SERVICES.some((s) => s.id === "api-home-assistant" && s.fields.length === 2));
  assert.equal(resolveConnectService("home assistant").id, "api-home-assistant");
  assert.equal(resolveConnectService("mqtt").id, "mqtt");
  assert.equal(await isServiceConnected(service), false);

  const hub = new ConnectHub({ publicUrl: () => "https://ares.test" });
  const hubServer = http.createServer((req, res) => {
    void hub.handle(req, res, new URL(req.url, "http://localhost")).then((handled) => { if (!handled && !res.headersSent) { res.writeHead(404); res.end(); } });
  });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => hubServer.close(r)));
  const base = `http://127.0.0.1:${hubServer.address().port}`;
  const prompt = await hub.start(service);
  const flowPath = new URL(prompt.url).pathname;
  const formHtml = await (await fetch(base + flowPath)).text();
  assert.match(formHtml, /type="password"/);

  const bad = await fetch(base + flowPath, { method: "POST", body: new URLSearchParams({ [service.fields[0].credential]: "wrong-key-000000" }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /rejected those credentials \(HTTP 401\)/);
  assert.equal(await getCredential(service.fields[0].credential), undefined, "nothing stored for a rejected key");

  const good = await fetch(base + flowPath, { method: "POST", body: new URLSearchParams({ [service.fields[0].credential]: "good-key-123456" }) });
  assert.equal(good.status, 200);
  assert.equal(await getCredential(service.fields[0].credential), "good-key-123456");
  assert.equal(await isServiceConnected(service), true);

  // verifyApiService directly: a 5xx is refused, an unreachable spec-less service is tolerated
  await assert.rejects(() => verifyApiService(id, { [service.fields[0].credential]: "nope-nope-000" }), /rejected those credentials/);
  assert.match(await verifyApiService(id, { [service.fields[0].credential]: "good-key-123456" }), /answered/);
});

test("preset definitions are coherent: every preset has a spec, a real verify operation, and sane limits", () => {
  for (const def of API_PRESET_DEFS) {
    const handle = specHandleFor(def);
    assert.ok(handle.ops.length >= 1, def.id);
    if (def.verifyOperationId) assert.ok(handle.has(def.verifyOperationId), `${def.id}: verifyOperationId ${def.verifyOperationId}`);
    for (const id of def.readOperationIds ?? []) assert.ok(handle.has(id), `${def.id}: read op ${id}`);
    assert.ok(def.baseUrl || def.baseUrlField, `${def.id} has somewhere to call`);
    if (def.baseUrl) assert.match(def.baseUrl, /^https:\/\//, `${def.id} is https`);
    assert.ok((def.ratePerMin ?? 60) <= 120);
  }
  assert.equal(API_PRESET_DEFS.find((d) => d.id === "nominatim").minIntervalMs >= 1000, true, "Nominatim's one-request-a-second policy is built in");
  assert.ok(/AresAgent/.test(API_PRESET_DEFS.find((d) => d.id === "nominatim").headers["user-agent"]), "Nominatim and Wikimedia require an identifying User-Agent");
});

test("the Connections screen lists Api services, and disconnect forgets their credentials", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, {}));
  const id = uid("listed");
  await addLocal(t, id, KEYED, srv, { auth: { type: "bearer" } });
  const list = await listPhoneConnections();
  const mine = list.find((s) => s.id === `api-${id}`);
  assert.ok(mine, "a service added by the tool is on the phone's list");
  assert.equal(mine.kind, "api-key");
  assert.equal(mine.connected, false);
  assert.ok(list.some((s) => s.id === "api-home-assistant" && s.connected === false));
  assert.ok(list.some((s) => s.id === "mqtt"));
  const cred = `API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
  await setCredential(cred, "tok_listed_123456");
  assert.equal((await listPhoneConnections()).find((s) => s.id === `api-${id}`).connected, true);
  assert.equal(await disconnectService(resolveConnectService(`api-${id}`)), true);
  assert.equal(await getCredential(cred), undefined);
  assert.equal((await listPhoneConnections()).find((s) => s.id === `api-${id}`).connected, false);
});

test("a name that resolves to a private address is refused at call time, through the whole tool path", async (t) => {
  const srv = await startServer(t, (req, res) => json(res, { reached: true }));
  const id = uid("rebind");
  await addApiService({ id, specText: JSON.stringify(KEYED), baseUrl: "https://rebind.example.com", auth: { type: "none" } });
  t.after(() => removeApiService(id));
  const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(() => apiCall({ service: id, operationId: "me" }, { resolver }), (e) => e instanceof ApiInputError && /blocked by the network guard: rebind\.example\.com -> 127\.0\.0\.1 is a private\/loopback/.test(e.message));
  assert.equal(srv.requests.length, 0, "nothing was sent");
  const audit = await fsp.readFile(path.join(apiServicesDir(), "audit.jsonl"), "utf8");
  assert.match(audit, new RegExp(`"service":"${id}".*"error":"rebind`));
});
