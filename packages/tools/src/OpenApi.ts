// Api — the universal connector. Point it at any service that publishes an
// OpenAPI 3.x / Swagger 2 spec and Ares can search its operations, read one's
// parameters, and call it — without a connector being written for that service.
// A dozen free services (weather, maps, Wikipedia, Home Assistant …) ship as
// presets that work with no setup.
//
// Deliberately ONE tool with four verbs instead of a tool per operation: a spec
// can name hundreds of operations and registering them would drown the model's
// context. `search` finds, `describe` teaches, `call` does.
//
// Safety, in short (details: openapi/netGuard.ts, openapi/call.ts):
//   reads (GET/HEAD) run; writes ask the owner; DELETE and destructive- or
//   financial-looking operations are always the owner's decision; secrets live
//   only in the credential vault and are scrubbed from everything shown; the
//   network guard refuses metadata/link-local addresses always and LAN
//   addresses unless the owner allowed them for that one service.

import { z } from "zod";
import { apiConnectId, resolveApiServiceDef, type ApiAuth } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { ApiInputError } from "./openapi/call.js";
import { searchOperations, type ResolvedOperation } from "./openapi/spec.js";
import {
  addService,
  apiCall,
  classifyApiCall,
  fetchSpecText,
  listServices,
  removeService,
  specHandleFor,
  dropCachedHandle,
  unknownOperationMessage,
  unknownServiceMessage,
  syncApiConnectServices,
  type ServiceSummary,
} from "./openapi/services.js";
import { parseSpecText, SpecHandle, SpecError } from "./openapi/spec.js";
import { saveApiServiceSpec } from "@ares/core";

const authSchema = z
  .object({
    type: z.enum(["none", "apiKey", "bearer", "basic", "oauth2cc"]).describe("apiKey: a key in a header/query/cookie. bearer: Authorization: Bearer <token>. basic: username+password. oauth2cc: OAuth2 client-credentials (token_url needed)."),
    in: z.enum(["header", "query", "cookie"]).optional().describe("apiKey: where the key goes."),
    name: z.string().optional().describe("apiKey: the header/query/cookie name, e.g. X-API-Key or api_key."),
    header: z.string().optional().describe("bearer: header to use instead of Authorization."),
    scheme: z.string().optional().describe("bearer: word before the token (default Bearer)."),
    token_url: z.string().optional().describe("oauth2cc: the token endpoint."),
    scope: z.string().optional().describe("oauth2cc: scopes, space separated."),
    optional: z.boolean().optional().describe("The service works without the key (lower limits); the owner may add one later."),
  })
  .strict();

const inputSchema = z
  .object({
    action: z
      .enum(["services", "search", "describe", "call", "add", "remove", "refresh"])
      .describe(
        "services: every available service (presets work with no setup). search {service, query}: find operations. describe {service, operationId}: its parameters and body. " +
          "call {service, operationId, params, body}: run it. add: register the owner's own service from an OpenAPI spec. remove / refresh: manage one you added.",
      ),
    service: z.string().optional().describe("Service id from `services` (e.g. open-meteo, home-assistant) or the id you choose for `add` (lowercase, dashes)."),
    query: z.string().optional().describe("search: words describing what you want (\"forecast\", \"create invoice\"). Empty lists operations."),
    method: z.string().optional().describe("search: only this HTTP method."),
    tag: z.string().optional().describe("search: only this tag."),
    limit: z.number().int().min(1).max(50).optional().describe("search: how many results (default 15)."),
    operationId: z.string().optional().describe("describe/call: the operation, exactly as search shows it."),
    operation_id: z.string().optional().describe("Alias of operationId."),
    params: z.record(z.any()).optional().describe("call: path/query/header/cookie parameters by name, e.g. {\"latitude\":52.5,\"longitude\":13.4}. Arrays may be real arrays. If a name exists in two places write \"query.id\"."),
    body: z.any().optional().describe("call: the request body (object, or text for non-JSON)."),
    content_type: z.string().optional().describe("call: body media type when the operation accepts several."),
    select: z.string().optional().describe("call: keep only part of a JSON response, by dotted path: \"results.0.name\", \"items.*.id\", or a slice \"0:15\"."),
    max_chars: z.number().int().min(500).max(60000).optional().describe("call: output cap in characters (default 12000)."),
    spec_url: z.string().optional().describe("add/refresh: URL of the OpenAPI/Swagger spec (JSON or YAML)."),
    spec: z.string().optional().describe("add: the spec text itself (JSON or YAML) instead of a URL."),
    base_url: z.string().optional().describe("add: where to send calls, e.g. https://api.example.com/v1 (default: the spec's first server)."),
    base_url_from_owner: z.boolean().optional().describe("add: have the owner type the address into the secure form (for services on their own network)."),
    label: z.string().optional().describe("add: a display name."),
    auth: authSchema.optional().describe("add: how the service authenticates (default: what the spec declares). The secret itself is never passed here — the owner enters it in a secure form (Connect)."),
    allow_lan: z.boolean().optional().describe("add: permit this service on the owner's LAN / plain http / private addresses (Home Assistant, a NAS). Owner decision."),
    insecure_tls: z.boolean().optional().describe("add: accept a self-signed certificate (only with allow_lan)."),
    headers: z.record(z.string()).optional().describe("add: fixed non-secret headers (User-Agent, Accept)."),
    rate_per_min: z.number().int().min(1).max(6000).optional().describe("add: calls per minute allowed (default 60)."),
    verify_operation: z.string().optional().describe("add: an operationId the connect form may call to check the credentials (a read)."),
    read_operations: z.array(z.string()).optional().describe("add: operationIds that use POST but only read (search, GraphQL queries) — they run without asking."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface ApiOutput {
  message: string;
  services?: ServiceSummary[];
  service?: string;
  total?: number;
  results?: Array<{ operationId: string; method: string; path: string; summary: string; tags?: string[] }>;
  operation?: Record<string, unknown>;
  ok?: boolean;
  status?: number;
  method?: string;
  url?: string;
  data?: unknown;
  text?: string;
  headers?: Record<string, string>;
  truncated?: boolean;
  notes?: string[];
  ms?: number;
}

function opIdOf(input: Input): string {
  return (input.operationId ?? input.operation_id ?? "").trim();
}

function fail(message: string): ToolResult<ApiOutput> {
  return failResult<ApiOutput>(message);
}

function toAuth(a: z.infer<typeof authSchema> | undefined): ApiAuth | undefined {
  if (!a) return undefined;
  switch (a.type) {
    case "none":
      return { type: "none" };
    case "apiKey":
      if (!a.in || !a.name) throw new ApiInputError("auth apiKey needs `in` (header|query|cookie) and `name`");
      return { type: "apiKey", in: a.in, name: a.name, ...(a.optional ? { optional: true } : {}) };
    case "bearer":
      return { type: "bearer", ...(a.header ? { header: a.header } : {}), ...(a.scheme ? { scheme: a.scheme } : {}), ...(a.optional ? { optional: true } : {}) };
    case "basic":
      return { type: "basic" };
    case "oauth2cc":
      if (!a.token_url) throw new ApiInputError("auth oauth2cc needs `token_url`");
      return { type: "oauth2cc", tokenUrl: a.token_url, ...(a.scope ? { scope: a.scope } : {}) };
  }
}

const compactParam = (p: ResolvedOperation["parameters"][number]) => ({
  name: p.name,
  in: p.in,
  ...(p.required ? { required: true } : {}),
  type: Array.isArray(p.schema.enum) ? undefined : p.schema.type,
  ...(Array.isArray(p.schema.enum) ? { enum: p.schema.enum } : {}),
  ...(p.schema.type === "array" && p.schema.items?.type ? { items: p.schema.items.type } : {}),
  ...(p.schema.default !== undefined ? { default: p.schema.default } : {}),
  ...(p.description ? { description: p.description } : {}),
});

/** Keep a body schema readable: full when small, top-level only when huge. */
function boundedSchema(schema: Record<string, any>): Record<string, any> {
  if (JSON.stringify(schema).length <= 7000) return schema;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) props[k] = { ...(v.type ? { type: v.type } : {}), ...(v.description ? { description: String(v.description).slice(0, 100) } : {}) };
  return { type: schema.type, ...(schema.required ? { required: schema.required } : {}), properties: props, note: "large schema; nested fields omitted — ask for less or read the service's docs" };
}

function describeOperation(op: ResolvedOperation, cls: ReturnType<typeof classifyApiCall>): Record<string, unknown> {
  return {
    operationId: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    ...(op.description && op.description !== op.summary ? { description: op.description } : {}),
    ...(op.deprecated ? { deprecated: true } : {}),
    access: cls.kind === "write" ? (cls.destructive || cls.financial ? `WRITE — always the owner's decision (${cls.reason})` : "WRITE — asks the owner") : "read — runs freely",
    parameters: op.parameters.map(compactParam),
    ...(op.body ? { body: { required: op.body.required, contentType: op.body.contentType, ...(op.body.contentTypes.length > 1 ? { alsoAccepts: op.body.contentTypes } : {}), schema: boundedSchema(op.body.schema) } } : {}),
    responses: op.responses.map((r) => `${r.status}${r.description ? ` ${r.description}` : ""}`),
  };
}

const READ_ACTIONS = new Set(["services", "search", "describe"]);

export const ApiTool = buildTool<typeof inputSchema, ApiOutput>({
  name: "Api",
  description:
    "Universal API connector: call ANY service that publishes an OpenAPI/Swagger spec, plus ready-made free services that work with no setup " +
    "(Open-Meteo weather + geocoding, Wikipedia, Wikidata, OpenStreetMap Nominatim, Open Library, arXiv, Hacker News, USGS earthquakes, Frankfurter FX rates, CoinGecko, NASA APOD, Home Assistant). " +
    "Flow: `services` to see what exists → `search {service, query}` to find an operation → `describe {service, operationId}` if unsure of the parameters → `call {service, operationId, params, body}`. " +
    "Errors tell you exactly which parameter is missing or wrong — fix and retry. Reads run freely; anything that changes data asks the owner first. " +
    "To use a service that needs a key, call Connect with service \"api-<id>\" (secure form on the owner's phone; never ask for keys in chat). " +
    "To use a service that is not listed, `add` it from its OpenAPI spec URL. Prefer this over scraping or hand-rolled curl for any API.",
  safety: "external-state",
  dynamicSafety: (input) => {
    if (READ_ACTIONS.has(input.action)) return "read-only";
    if (input.action === "call") return classifyApiCall(input.service ?? "", opIdOf(input), input.params).kind === "write" ? "external-state" : "read-only";
    return "external-state";
  },
  ownerDecisions: true,
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 75_000,
  maxResultSizeChars: 60_000,
  activityDescription: (input) => {
    switch (input.action) {
      case "services": return "Listing API services";
      case "search": return `Searching ${input.service ?? "API"} operations`;
      case "describe": return `Reading ${input.service ?? "API"} ${opIdOf(input)}`.trim();
      case "call": return `Calling ${input.service ?? "API"} ${opIdOf(input)}`.trim();
      case "add": return `Adding API service ${input.service ?? ""}`.trim();
      case "remove": return `Removing API service ${input.service ?? ""}`.trim();
      default: return `Refreshing API service ${input.service ?? ""}`.trim();
    }
  },
  async checkPermissions(input, ctx) {
    if (READ_ACTIONS.has(input.action)) return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Api can only read in plan mode." };
    if (input.action === "call") {
      const cls = classifyApiCall(input.service ?? "", opIdOf(input), input.params);
      if (cls.kind !== "write") return { kind: "allow" };
      const summary = `${cls.method} ${input.service} ${cls.path} (${opIdOf(input)})`;
      if (cls.destructive || cls.financial) {
        const body = input.body === undefined ? "" : ` Body: ${JSON.stringify(input.body).slice(0, 300)}`;
        return { kind: "ask", prompt: `Api ${summary} — ${cls.reason}. Run it?${body}`, suggestion: "deny", ownerDecision: true };
      }
      return { kind: "allow" };
    }
    if (input.action === "add" && (input.allow_lan || input.base_url_from_owner)) {
      return { kind: "ask", prompt: `Add API service "${input.service}" with access to your local network${input.base_url ? ` at ${input.base_url}` : ""}? Ares will be able to call devices on your LAN for this service.`, suggestion: "allow_once", ownerDecision: true };
    }
    if (input.action === "add" || input.action === "remove" || input.action === "refresh") {
      return { kind: "ask", prompt: `${input.action === "add" ? `Add API service "${input.service}" from ${input.spec_url ?? "pasted spec"}` : `${input.action === "remove" ? "Remove" : "Refresh"} API service "${input.service}"`}`, suggestion: "allow_once" };
    }
    return { kind: "allow" };
  },
  async call(input: Input, ctx): Promise<ToolResult<ApiOutput>> {
    const env = { signal: ctx.signal };
    try {
      switch (input.action) {
        case "services": {
          syncApiConnectServices();
          const services = await listServices();
          const lines = services.map(
            (s) => `${s.id} — ${s.label}: ${s.blurb} [${s.operations} ops; ${s.access === "no-key" ? "no setup" : s.access === "optional-key" ? "works now, optional key" : s.access === "connected" ? "connected" : `NEEDS CONNECT: ${s.connect}`}${s.preset ? "" : "; yours"}]`,
          );
          return okResult({ services, message: lines.join("\n") }, `${services.length} API services`);
        }
        case "search": {
          const def = requireService(input);
          const handle = specHandleFor(def);
          const { hits, total } = searchOperations(handle.ops, input.query ?? "", { limit: input.limit, method: input.method, tag: input.tag });
          const results = hits.map((h) => ({ operationId: h.id, method: h.method, path: h.path, summary: h.summary, ...(h.tags.length ? { tags: h.tags } : {}) }));
          const message = results.length
            ? `${total} match${total === 1 ? "" : "es"} in ${def.label} (${handle.ops.length} operations)${total > results.length ? `, showing ${results.length}` : ""}. Next: describe or call one by operationId.`
            : `No operation in ${def.label} matches "${input.query}". Try other words, or search with an empty query to browse (${handle.ops.length} operations).`;
          return okResult({ service: def.id, total, results, message }, `${results.length} operations`);
        }
        case "describe": {
          const def = requireService(input);
          const handle = specHandleFor(def);
          const id = opIdOf(input);
          if (!id) return fail("describe needs operationId (search first).");
          const op = handle.operation(id);
          if (!op) return fail(unknownOperationMessage(def, handle, id));
          const operation = describeOperation(op, classifyApiCall(def.id, id));
          return okResult({ service: def.id, operation, message: `${op.method} ${op.path} — ${op.summary}` }, `${def.id} ${id}`);
        }
        case "call": {
          const def = requireService(input);
          const id = opIdOf(input);
          if (!id) return fail("call needs operationId (search first).");
          const r = await apiCall({ service: def.id, operationId: id, params: input.params, body: input.body, contentType: input.content_type }, env, {
            ...(input.select ? { select: input.select } : {}),
            ...(input.max_chars ? { maxChars: input.max_chars } : {}),
          });
          const head = `${r.method} ${r.url} → HTTP ${r.status} (${r.ms} ms, ${r.bytes} bytes)`;
          const out: ApiOutput = {
            ok: r.ok,
            status: r.status,
            method: r.method,
            url: r.url,
            ...(r.data !== undefined ? { data: r.data } : { text: r.text }),
            headers: r.headers,
            ...(r.truncated ? { truncated: true } : {}),
            ...(r.notes.length ? { notes: r.notes } : {}),
            ms: r.ms,
            message: head,
          };
          if (!r.ok) return { output: out, display: head.slice(0, 200), failure: `${head}: ${r.text.slice(0, 400)}` };
          return { output: out, display: head.slice(0, 200) };
        }
        case "add": {
          if (!input.service) return fail("add needs service (the id you choose, e.g. \"my-crm\").");
          const res = await addService(
            {
              id: input.service,
              label: input.label,
              specUrl: input.spec_url,
              specText: input.spec,
              baseUrl: input.base_url,
              baseUrlFromOwner: input.base_url_from_owner,
              auth: toAuth(input.auth),
              allowLan: input.allow_lan,
              insecureTls: input.insecure_tls,
              headers: input.headers,
              ratePerMin: input.rate_per_min,
              verifyOperationId: input.verify_operation,
              readOperationIds: input.read_operations,
            },
            env,
          );
          const needs = res.def.auth.type !== "none" || res.def.baseUrlField;
          const next = needs
            ? `It needs ${res.def.baseUrlField ? "an address and " : ""}${res.def.auth.type !== "none" ? "credentials" : ""}: call Connect with service "${apiConnectId(res.def.id)}" — the owner enters them in a secure form on their phone.`
            : "No credentials needed; search it now.";
          return okResult(
            { service: res.def.id, message: `Added ${res.def.label} (${res.operations} operations, ${res.specVersion}). ${res.notes.join("; ")}. ${next}` },
            `Added ${res.def.id}`,
          );
        }
        case "remove": {
          if (!input.service) return fail("remove needs service.");
          const removed = removeService(input.service);
          return okResult({ message: removed ? `Removed ${input.service}. Its stored credentials remain in the vault until disconnected from Connections.` : `No service named ${input.service} was added.` });
        }
        case "refresh": {
          const def = requireService(input);
          if (def.specSource.kind !== "url") return fail(`${def.id} was not added from a URL (${def.specSource.kind === "preset" ? "it is a bundled preset" : "pasted spec"}); use add with spec to replace it.`);
          const text = await fetchSpecText(def.specSource.url, env, def.allowLan === true);
          let handle: SpecHandle;
          try {
            const raw = parseSpecText(text);
            handle = new SpecHandle(raw);
            saveApiServiceSpec(def.id, JSON.stringify(raw));
          } catch (err) {
            return fail(`the refreshed spec is not usable: ${err instanceof SpecError ? err.message : String(err)}`);
          }
          dropCachedHandle(def.id);
          return okResult({ message: `Refreshed ${def.label}: ${handle.meta.operationCount} operations.` });
        }
      }
    } catch (err) {
      if (err instanceof ApiInputError) return fail(err.message);
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Api ${input.action} failed: ${message}`);
    }
  },
});

function requireService(input: Input) {
  if (!input.service) throw new ApiInputError(`${input.action} needs service. Call Api with action "services" to see the ids.`);
  const def = resolveApiServiceDef(input.service.trim().toLowerCase());
  if (!def) throw new ApiInputError(unknownServiceMessage(input.service));
  return def;
}
