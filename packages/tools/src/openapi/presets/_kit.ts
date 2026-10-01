// The kit every connected-account preset is written with. A preset file is ONE
// service: its definition (host, auth, rate limits), a compact curated list of
// operations, and 3-6 worked recipes. Nothing in a preset file performs I/O;
// definePreset only assembles data, so importing it can never fail a boot.
//
//   export default definePreset({
//     id: "vercel", label: "Vercel", connect: "vercel", baseUrl: "https://api.vercel.com", ...
//     ops: [ get("/v6/deployments", "listDeployments", "...", [p("limit", "query", int("..."))], { paginate: {...} }), ... ],
//     recipes: [ { ask: "what did I deploy today", steps: [{ op: "listDeployments", params: { limit: 10 } }] } ],
//   });
//
// Safety vocabulary (x-ares-risk, set on every operation that is not a plain GET):
//   read         a POST/PUT that only reads (search, query, batchGet). Runs freely.
//   write        changes data. Asks the owner.
//   message      puts words in front of other people (send, post, comment, reply). Asks, with the exact text.
//   destructive  deletes / cancels / revokes / archives. The owner's decision, even in bypass.
//   financial    moves or commits money. The owner's decision, even in bypass.
// A DELETE is always destructive. Never expose an operation that returns a secret in
// plain text (decrypted env vars, API key reveal) - leave it out.

import type { ApiAuth, ApiOAuthSource, ApiServiceDef } from "@ares/core";
import type { AresPaginate, AresRisk, JsonObject } from "../spec.js";

export type { AresPaginate, AresRisk, JsonObject };
export type Loc = "path" | "query" | "header";

export const UA = "AresAgent/1.0 (personal assistant; +https://github.com/clout2buy/ares)";

// ─── parameter and schema builders ───────────────────────────────────────────

export const str = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "string", description, ...extra });
export const num = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "number", description, ...extra });
export const int = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "integer", description, ...extra });
export const bool = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "boolean", description, ...extra });
/** A comma-separated list (style=form, explode=false). */
export const csv = (description: string): JsonObject => ({ type: "array", items: { type: "string" }, description });
/** A repeated parameter (a=1&a=2). */
export const multi = (description: string, itemType = "string"): JsonObject => ({ type: "array", items: { type: itemType }, description, "x-explode": true });
/** An object schema for a request body. */
export const obj = (description: string, properties: Record<string, JsonObject> = {}, required: string[] = []): JsonObject => ({
  type: "object",
  description,
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
});
export const arrOf = (description: string, items: JsonObject): JsonObject => ({ type: "array", description, items });

export function p(name: string, where: Loc, schema: JsonObject, required = false, extra: JsonObject = {}): JsonObject {
  const { description, "x-explode": explode, ...rest } = schema as { description?: string; "x-explode"?: boolean } & JsonObject;
  return {
    name,
    in: where,
    required: where === "path" ? true : required,
    ...(description ? { description } : {}),
    schema: rest,
    ...(rest.type === "array" ? (explode ? { style: "form", explode: true } : { style: "form", explode: false }) : {}),
    ...extra,
  };
}

export const JSON_BODY = (schema: JsonObject, required = true): JsonObject => ({ required, content: { "application/json": { schema } } });
export const FORM_BODY = (schema: JsonObject, required = true): JsonObject => ({ required, content: { "application/x-www-form-urlencoded": { schema } } });

// ─── operations ──────────────────────────────────────────────────────────────

export interface OpExtra {
  tags?: string[];
  /** Longer help shown by `describe`. */
  description?: string;
  /** The request body (use JSON_BODY / FORM_BODY). */
  body?: JsonObject;
  /** Natural phrases a person would use for this ("unread mail", "what is playing"): ranked above everything else in `search`. */
  keywords?: string[];
  /** How the list pages, so `pages` can follow it. */
  paginate?: AresPaginate;
  /** Where the recipient and the exact words are in the call input, for the owner's prompt. */
  message?: { to?: string[]; text?: string[] };
  /** An absolute server URL on one of the service's other hosts (declared in extraOrigins automatically). */
  server?: string;
  /** The vendor spec's own "METHOD /path" when it differs from ours (checked by the preset verifier). */
  vendor?: string;
  deprecated?: boolean;
}
type ReadOpExtra = OpExtra & { risk?: AresRisk };
type WriteOpExtra = OpExtra & { risk: AresRisk };

export interface OpRow {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  op: JsonObject;
}

function buildOp(operationId: string, summary: string, parameters: JsonObject[], extra: OpExtra & { risk?: AresRisk }): JsonObject {
  return {
    operationId,
    summary,
    ...(extra.description ? { description: extra.description } : {}),
    parameters,
    ...(extra.body ? { requestBody: extra.body } : {}),
    responses: { "200": { description: "OK" } },
    ...(extra.tags ? { tags: extra.tags } : {}),
    ...(extra.server ? { servers: [{ url: extra.server }] } : {}),
    ...(extra.risk ? { "x-ares-risk": extra.risk } : {}),
    ...(extra.keywords?.length ? { "x-ares-keywords": extra.keywords } : {}),
    ...(extra.paginate ? { "x-ares-paginate": extra.paginate } : {}),
    ...(extra.message ? { "x-ares-message": extra.message } : {}),
    ...(extra.vendor ? { "x-ares-vendor": extra.vendor } : {}),
    ...(extra.deprecated ? { deprecated: true } : {}),
  };
}

/** A read. (A GET that somehow changes data must say so with risk.) */
export const get = (path: string, id: string, summary: string, params: JsonObject[] = [], extra: ReadOpExtra = {}): OpRow => ({ method: "get", path, op: buildOp(id, summary, params, extra) });
/** A POST. `risk` is required: read (a POST that only reads), write, message, destructive or financial. */
export const post = (path: string, id: string, summary: string, params: JsonObject[], extra: WriteOpExtra): OpRow => ({ method: "post", path, op: buildOp(id, summary, params, extra) });
export const put = (path: string, id: string, summary: string, params: JsonObject[], extra: WriteOpExtra): OpRow => ({ method: "put", path, op: buildOp(id, summary, params, extra) });
export const patch = (path: string, id: string, summary: string, params: JsonObject[], extra: WriteOpExtra): OpRow => ({ method: "patch", path, op: buildOp(id, summary, params, extra) });
/** A DELETE is always destructive (the risk is implied). */
export const del = (path: string, id: string, summary: string, params: JsonObject[], extra: OpExtra = {}): OpRow => ({ method: "delete", path, op: buildOp(id, summary, params, { ...extra, risk: "destructive" }) });

/**
 * A curated GraphQL operation: a fixed query document, its variables declared as
 * parameters (they are sent as the GraphQL variables, not in the URL). Several
 * share one endpoint, so the row's path carries "#<id>" (stripped when sent).
 * `kind: "query"` reads; `"mutation"` needs a risk.
 */
export function gql(endpoint: string, id: string, summary: string, query: string, variables: JsonObject[], extra: ReadOpExtra & { kind?: "query" | "mutation" } = {}): OpRow {
  const kind = extra.kind ?? "query";
  const { kind: _kind, ...rest } = extra;
  void _kind;
  const risk: AresRisk | undefined = kind === "query" ? (rest.risk ?? "read") : rest.risk;
  const op = buildOp(id, summary, variables, { ...rest, ...(risk ? { risk } : {}) });
  op["x-ares-graphql"] = { query: query.replace(/\s+/g, " ").trim(), kind };
  return { method: "post", path: `${endpoint}#${id}`, op };
}

/** The free-form read-only GraphQL escape hatch (a mutation or subscription is refused when it is sent). */
export function gqlRaw(endpoint: string, id: string, summary: string, extra: OpExtra = {}): OpRow {
  const op = buildOp(id, summary, [], {
    ...extra,
    risk: "read",
    body: JSON_BODY(obj("A GraphQL request", { query: str("A GraphQL query (read-only: no mutation)"), variables: obj("Variables for the query"), operationName: str("Which operation of the document to run") }, ["query"])),
  });
  op["x-ares-graphql"] = { query: "", kind: "query", raw: true };
  return { method: "post", path: `${endpoint}#${id}`, op };
}

// ─── recipes, provenance, the preset itself ──────────────────────────────────

export interface RecipeStep {
  /** An operationId of this preset. */
  op: string;
  /** Literal example parameters: they are checked against the operation (names, types, required). */
  params?: Record<string, unknown>;
  body?: unknown;
  /** The `select` / `fields` to pass so the answer stays small. */
  select?: string;
  fields?: string;
  /** What to do with the answer, or why this step. */
  note?: string;
}
export interface Recipe {
  /** What the owner asked, in their words: "what did I deploy today". */
  ask: string;
  steps: RecipeStep[];
}

export interface PresetSource {
  kind: "vendor-openapi" | "discovery" | "graphql-schema" | "docs";
  /** The machine-readable spec this was curated from (vendor-openapi / discovery / graphql-schema). */
  specUrl?: string;
  /** The human documentation for the operations (always). */
  docsUrl: string;
  /** The day the spec or docs were fetched and the operations checked against them (YYYY-MM-DD). */
  fetchedOn: string;
  note?: string;
}

export interface PresetNotes {
  rateLimits: string;
  pagination?: string;
  auth: string;
  scopes?: string;
  gotchas?: string[];
}

export interface PresetInput {
  /** The Api service id: lowercase letters, digits, dashes. */
  id: string;
  label: string;
  blurb: string;
  /** The registry id the owner connects: the error says Connect service "<connect>". */
  connect: string;
  /** More about where the token comes from (provider when it differs, mcp, credentials, scopes). */
  oauth?: Omit<ApiOAuthSource, "connect">;
  /** No registry OAuth for this service: the standard `api-<id>` secure form collects its key (and address). */
  form?: boolean;
  baseUrl: string;
  /** Per-tenant hosts (a Shopify store): the owner types the address when connecting. Leave baseUrl as a placeholder-free default. */
  baseUrlField?: ApiServiceDef["baseUrlField"];
  extraOrigins?: string[];
  auth?: ApiAuth;
  authHeaders?: Record<string, string>;
  headers?: Record<string, string>;
  ratePerMin?: number;
  minIntervalMs?: number;
  /** A cheap authenticated read with no required parameters ("who am I"). */
  verifyOperationId: string;
  errorEnvelope?: ApiServiceDef["errorEnvelope"];
  keywords?: string[];
  domain?: string;
  howToUse?: string;
  intro?: string;
  source: PresetSource;
  notes: PresetNotes;
  ops: OpRow[];
  recipes: Recipe[];
  /** Extra "what a person says" -> operationId checks, run by the test suite against `search`. */
  searchChecks?: Array<[query: string, operationId: string]>;
}

export interface PresetBundle {
  id: string;
  connect: string;
  def: ApiServiceDef;
  spec: JsonObject;
  source: PresetSource;
  notes: PresetNotes;
  recipes: Recipe[];
  searchChecks: Array<[string, string]>;
  /** Problems found while assembling (duplicate operations ...). The test suite requires none. */
  problems: string[];
}

export function definePreset(input: PresetInput): PresetBundle {
  const problems: string[] = [];
  const paths: Record<string, JsonObject> = {};
  const seenIds = new Set<string>();
  const origins = new Set<string>(input.extraOrigins ?? []);
  for (const row of input.ops) {
    const id = String(row.op.operationId);
    if (seenIds.has(id)) problems.push(`duplicate operationId ${id}`);
    seenIds.add(id);
    paths[row.path] ??= {};
    if (paths[row.path]![row.method]) problems.push(`duplicate operation ${row.method.toUpperCase()} ${row.path}`);
    paths[row.path]![row.method] = row.op;
    const server = Array.isArray(row.op.servers) ? (row.op.servers[0]?.url as string | undefined) : undefined;
    if (server) {
      try {
        origins.add(new URL(server).origin);
      } catch {
        problems.push(`bad server URL on ${id}: ${server}`);
      }
    }
  }
  let baseOrigin = "";
  try {
    baseOrigin = new URL(input.baseUrl).origin;
  } catch {
    // a baseUrlField preset has no fixed base
  }
  origins.delete(baseOrigin);
  const spec: JsonObject = {
    openapi: "3.0.3",
    info: { title: input.label, version: "preset-1", description: input.intro ?? input.blurb },
    servers: [{ url: input.baseUrl }],
    paths,
  };
  const def: ApiServiceDef = {
    id: input.id,
    label: input.label,
    blurb: input.blurb,
    specSource: { kind: "preset" },
    ...(input.baseUrlField ? { baseUrlField: input.baseUrlField } : { baseUrl: input.baseUrl }),
    ...(origins.size ? { extraOrigins: [...origins] } : {}),
    auth: input.auth ?? { type: "bearer" },
    ...(input.form ? {} : { oauth: { connect: input.connect, ...(input.oauth ?? {}) } }),
    ...(input.authHeaders ? { authHeaders: input.authHeaders } : {}),
    headers: { "user-agent": UA, ...(input.headers ?? {}) },
    ratePerMin: input.ratePerMin ?? 60,
    ...(input.minIntervalMs ? { minIntervalMs: input.minIntervalMs } : {}),
    verifyOperationId: input.verifyOperationId,
    ...(input.errorEnvelope ? { errorEnvelope: input.errorEnvelope } : {}),
    keywords: [input.id, input.label.toLowerCase(), ...(input.keywords ?? [])],
    ...(input.domain ? { domain: input.domain } : {}),
    howToUse: input.howToUse ?? `Use the Api tool with service "${input.id}": \`recipes\` shows worked examples, \`search\` finds an operation, \`call\` runs it. Reads run freely; anything that changes data asks the owner first.`,
  };
  return { id: input.id, connect: input.connect, def, spec, source: input.source, notes: input.notes, recipes: input.recipes, searchChecks: input.searchChecks ?? [], problems };
}
