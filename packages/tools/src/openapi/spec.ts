// OpenAPI 3.0 / 3.1 and Swagger 2.0 — parsing, indexing, search and operation
// resolution. Nothing here touches the network: a spec is text in, structure out.
//
// A real spec can be megabytes and name hundreds of operations, so the work is
// split: building the INDEX (id, method, path, summary, tags) is one cheap pass,
// and an operation's parameters and body schema are resolved only when that one
// operation is described or called. Only local `#/…` $refs are followed — a
// spec must never make Ares fetch another URL.

import YAML from "yaml";

export type JsonObject = Record<string, any>;

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;
const PATH_ITEM_KEYS = new Set(["parameters", "servers", "summary", "description", "$ref"]);

export interface OpIndexEntry {
  id: string;
  method: string; // upper-case
  path: string;
  summary: string;
  tags: string[];
  deprecated?: boolean;
}

export interface SpecMeta {
  flavor: "openapi3" | "swagger2";
  version: string;
  title: string;
  description: string;
  apiVersion: string;
  servers: string[];
  operationCount: number;
}

export interface ResolvedParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: JsonObject;
  style?: string;
  explode?: boolean;
  /** Swagger 2 collectionFormat, normalised to an OAS3 style/explode pair by the builder. */
  collectionFormat?: string;
}

export interface ResolvedBody {
  required: boolean;
  contentType: string;
  contentTypes: string[];
  schema: JsonObject;
}

export interface ResolvedOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  parameters: ResolvedParam[];
  body?: ResolvedBody;
  responses: Array<{ status: string; description: string }>;
  /** Absolute server URLs this operation names itself (else the spec's). */
  servers: string[];
}

export class SpecError extends Error {}

// ─── Text in ─────────────────────────────────────────────────────────────────

/** JSON or YAML → object. The error says which it tried. */
export function parseSpecText(text: string): JsonObject {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new SpecError("the spec is empty");
  let parsed: unknown;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new SpecError(`the spec looks like JSON but does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      parsed = YAML.parse(trimmed, { maxAliasCount: 200 });
    } catch (err) {
      throw new SpecError(`the spec is neither JSON nor valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SpecError("the spec must be an object");
  return parsed as JsonObject;
}

export function detectFlavor(raw: JsonObject): { flavor: "openapi3" | "swagger2"; version: string } {
  if (typeof raw.openapi === "string" && /^3\./.test(raw.openapi)) return { flavor: "openapi3", version: raw.openapi };
  if (raw.swagger !== undefined && /^2(\.|$)/.test(String(raw.swagger))) return { flavor: "swagger2", version: String(raw.swagger) };
  if (typeof raw.openapi === "string") throw new SpecError(`unsupported OpenAPI version ${raw.openapi} (3.x and Swagger 2.0 are supported)`);
  throw new SpecError("this is not an OpenAPI/Swagger document (no \"openapi\" or \"swagger\" field)");
}

// ─── $ref ────────────────────────────────────────────────────────────────────

function pointerGet(raw: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: any = raw;
  for (const segment of ref.slice(2).split("/")) {
    const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Follow a chain of local $refs (bounded); external refs come back as a stub. */
export function deref(raw: JsonObject, node: any): any {
  let current = node;
  for (let i = 0; i < 12; i++) {
    if (!current || typeof current !== "object" || typeof current.$ref !== "string") return current;
    const ref: string = current.$ref;
    if (!ref.startsWith("#/")) return { description: `(external reference ${ref.slice(0, 80)} is not followed)` };
    const target = pointerGet(raw, ref);
    if (target === undefined) return { description: `(unresolved reference ${ref.slice(0, 80)})` };
    current = target;
  }
  return { description: "(reference chain too deep)" };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const MAX_DEPTH = 5;
const MAX_PROPS = 60;

function clip(text: unknown, n = 240): string | undefined {
  if (typeof text !== "string") return undefined;
  const one = text.replace(/\s+/g, " ").trim();
  return one ? (one.length > n ? `${one.slice(0, n - 1)}…` : one) : undefined;
}

function refName(ref: string): string {
  return decodeURIComponent(ref.split("/").pop() ?? ref);
}

/** Merge allOf members into one object schema. */
function mergeAllOf(raw: JsonObject, members: any[], depth: number, seen: Set<string>): JsonObject {
  const out: JsonObject = {};
  const properties: JsonObject = {};
  const required = new Set<string>();
  for (const member of members) {
    const part = simplifySchema(raw, member, depth, seen);
    for (const [k, v] of Object.entries(part)) {
      if (k === "properties") Object.assign(properties, v);
      else if (k === "required" && Array.isArray(v)) for (const r of v) required.add(String(r));
      else if (!(k in out)) out[k] = v;
    }
  }
  if (Object.keys(properties).length) {
    out.type ??= "object";
    out.properties = properties;
  }
  if (required.size) out.required = [...required];
  return out;
}

/** A compact, dereferenced, depth-limited view of a schema — what the model sees. */
export function simplifySchema(raw: JsonObject, schema: any, depth = 0, seen: Set<string> = new Set()): JsonObject {
  if (!schema || typeof schema !== "object") return {};
  let name: string | undefined;
  let node = schema;
  if (typeof node.$ref === "string") {
    name = refName(node.$ref);
    if (seen.has(node.$ref)) return { type: "object", description: `(recursive: ${name})` };
    seen = new Set(seen).add(node.$ref);
    node = deref(raw, node);
    // A $ref inside the target can chain.
    while (node && typeof node.$ref === "string" && !seen.has(node.$ref)) {
      seen.add(node.$ref);
      node = deref(raw, node);
    }
  }
  if (!node || typeof node !== "object") return {};
  if (depth > MAX_DEPTH) return { type: node.type ?? "object", description: `(nested${name ? ` ${name}` : ""}; describe a narrower part)` };

  if (Array.isArray(node.allOf) && node.allOf.length) {
    const merged = mergeAllOf(raw, [{ ...node, allOf: undefined }, ...node.allOf], depth + 1, seen);
    if (name) merged.title ??= name;
    return merged;
  }

  const out: JsonObject = {};
  if (name) out.title = name;
  const type = Array.isArray(node.type) ? node.type.filter((t: string) => t !== "null").join("|") || "null" : node.type;
  if (type) out.type = type;
  if (Array.isArray(node.type) && node.type.includes("null")) out.nullable = true;
  if (node.nullable === true) out.nullable = true;
  if (node.format) out.format = node.format;
  const description = clip(node.description);
  if (description) out.description = description;
  if (Array.isArray(node.enum)) out.enum = node.enum.slice(0, 40);
  if (node.const !== undefined) out.enum = [node.const];
  if (node.default !== undefined) out.default = node.default;
  if (node.example !== undefined) out.example = node.example;
  else if (Array.isArray(node.examples) && node.examples.length) out.example = node.examples[0];
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"] as const) if (node[key] !== undefined) out[key] = node[key];
  if (node.items) out.items = simplifySchema(raw, node.items, depth + 1, seen);
  if (node.properties && typeof node.properties === "object") {
    const props: JsonObject = {};
    const entries = Object.entries(node.properties);
    for (const [k, v] of entries.slice(0, MAX_PROPS)) props[k] = simplifySchema(raw, v, depth + 1, seen);
    if (entries.length > MAX_PROPS) props["…"] = { description: `${entries.length - MAX_PROPS} more properties` };
    out.properties = props;
    if (!out.type) out.type = "object";
  }
  if (Array.isArray(node.required) && node.required.length) out.required = node.required.map(String);
  if (node.additionalProperties !== undefined) {
    out.additionalProperties = typeof node.additionalProperties === "object" ? simplifySchema(raw, node.additionalProperties, depth + 1, seen) : node.additionalProperties;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(node[key])) out[key] = node[key].slice(0, 12).map((s: any) => simplifySchema(raw, s, depth + 1, seen));
  }
  return out;
}

// ─── Index ───────────────────────────────────────────────────────────────────

function slugPath(p: string): string {
  return p
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function serverUrls(raw: JsonObject, servers: any): string[] {
  const out: string[] = [];
  if (Array.isArray(servers)) {
    for (const s of servers) {
      if (!s || typeof s.url !== "string") continue;
      let url: string = s.url;
      const vars = s.variables && typeof s.variables === "object" ? s.variables : {};
      url = url.replace(/\{([^}]+)\}/g, (_m, name: string) => String(vars[name]?.default ?? ""));
      out.push(url);
    }
  }
  return out;
}

export class SpecHandle {
  readonly meta: SpecMeta;
  readonly ops: OpIndexEntry[];
  private readonly byId = new Map<string, { path: string; method: string }>();
  private readonly resolved = new Map<string, ResolvedOperation>();

  constructor(readonly raw: JsonObject) {
    const { flavor, version } = detectFlavor(raw);
    if (!raw.paths || typeof raw.paths !== "object") throw new SpecError("the spec has no \"paths\" — nothing to call");
    const ops: OpIndexEntry[] = [];
    const used = new Set<string>();
    for (const [path, rawItem] of Object.entries<any>(raw.paths)) {
      if (path.startsWith("x-")) continue;
      const item = deref(raw, rawItem);
      if (!item || typeof item !== "object") continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== "object") continue;
        let id = typeof op.operationId === "string" && op.operationId.trim() ? op.operationId.trim() : `${method}_${slugPath(path)}`;
        if (used.has(id)) {
          let n = 2;
          while (used.has(`${id}_${n}`)) n++;
          id = `${id}_${n}`;
        }
        used.add(id);
        this.byId.set(id, { path, method });
        ops.push({
          id,
          method: method.toUpperCase(),
          path,
          summary: clip(op.summary) ?? clip(op.description, 120) ?? "",
          tags: Array.isArray(op.tags) ? op.tags.map(String).slice(0, 6) : [],
          ...(op.deprecated === true ? { deprecated: true } : {}),
        });
      }
    }
    this.ops = ops;
    const info = raw.info && typeof raw.info === "object" ? raw.info : {};
    const servers = flavor === "swagger2" ? swagger2Servers(raw) : serverUrls(raw, raw.servers);
    this.meta = {
      flavor,
      version,
      title: clip(info.title, 120) ?? "untitled API",
      description: clip(info.description, 400) ?? "",
      apiVersion: String(info.version ?? ""),
      servers,
      operationCount: ops.length,
    };
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The operation with parameters and body resolved. */
  operation(id: string): ResolvedOperation | null {
    const cached = this.resolved.get(id);
    if (cached) return cached;
    const at = this.byId.get(id);
    if (!at) return null;
    const entry = this.ops.find((o) => o.id === id)!;
    const item = deref(this.raw, this.raw.paths[at.path]);
    const op = item[at.method];
    const swagger = this.meta.flavor === "swagger2";

    // Path-level parameters first; the operation's own override by name+in.
    const params = new Map<string, ResolvedParam>();
    let body: ResolvedBody | undefined;
    const formFields: JsonObject = {};
    const formRequired: string[] = [];
    const consumes: string[] = Array.isArray(op.consumes) ? op.consumes : Array.isArray(this.raw.consumes) ? this.raw.consumes : [];
    for (const rawParam of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
      const p = deref(this.raw, rawParam);
      if (!p || typeof p.name !== "string" || typeof p.in !== "string") continue;
      if (swagger && p.in === "body") {
        body = {
          required: p.required === true,
          contentType: consumes.find((c) => /json/i.test(c)) ?? consumes[0] ?? "application/json",
          contentTypes: consumes.length ? consumes : ["application/json"],
          schema: simplifySchema(this.raw, p.schema),
        };
        continue;
      }
      if (swagger && p.in === "formData") {
        formFields[p.name] = simplifySchema(this.raw, p);
        if (p.required === true) formRequired.push(p.name);
        continue;
      }
      if (p.in !== "path" && p.in !== "query" && p.in !== "header" && p.in !== "cookie") continue;
      const schema = simplifySchema(this.raw, p.schema ?? (swagger ? p : {}));
      const description = clip(p.description);
      params.set(`${p.in}:${p.name}`, {
        name: p.name,
        in: p.in,
        required: p.in === "path" ? true : p.required === true,
        ...(description ? { description } : {}),
        schema,
        ...(typeof p.style === "string" ? { style: p.style } : {}),
        ...(typeof p.explode === "boolean" ? { explode: p.explode } : {}),
        ...(typeof p.collectionFormat === "string" ? { collectionFormat: p.collectionFormat } : {}),
      });
    }

    if (swagger && Object.keys(formFields).length) {
      const multipart = consumes.find((c) => /multipart/i.test(c));
      body = {
        required: formRequired.length > 0,
        contentType: multipart ?? consumes.find((c) => /x-www-form-urlencoded/i.test(c)) ?? "application/x-www-form-urlencoded",
        contentTypes: consumes.length ? consumes : ["application/x-www-form-urlencoded"],
        schema: { type: "object", properties: formFields, ...(formRequired.length ? { required: formRequired } : {}) },
      };
    }

    if (!swagger && op.requestBody) {
      const rb = deref(this.raw, op.requestBody);
      const content: JsonObject = rb && typeof rb.content === "object" ? rb.content : {};
      const types = Object.keys(content);
      if (types.length) {
        const pick =
          types.find((t) => t === "application/json") ??
          types.find((t) => /json/i.test(t)) ??
          types.find((t) => /x-www-form-urlencoded/i.test(t)) ??
          types.find((t) => /multipart/i.test(t)) ??
          types[0]!;
        body = { required: rb.required === true, contentType: pick, contentTypes: types, schema: simplifySchema(this.raw, content[pick]?.schema) };
      } else if (rb) {
        body = { required: rb.required === true, contentType: "application/json", contentTypes: ["application/json"], schema: {} };
      }
    }

    const responses: Array<{ status: string; description: string }> = [];
    if (op.responses && typeof op.responses === "object") {
      for (const [status, rawResp] of Object.entries<any>(op.responses).slice(0, 12)) {
        const resp = deref(this.raw, rawResp);
        responses.push({ status, description: clip(resp?.description, 120) ?? "" });
      }
    }

    const ownServers = swagger ? [] : serverUrls(this.raw, op.servers ?? item.servers);
    const resolved: ResolvedOperation = {
      id,
      method: entry.method,
      path: at.path,
      summary: entry.summary,
      description: clip(op.description, 1200) ?? "",
      tags: entry.tags,
      deprecated: entry.deprecated === true,
      parameters: [...params.values()],
      ...(body ? { body } : {}),
      responses,
      servers: ownServers,
    };
    this.resolved.set(id, resolved);
    return resolved;
  }
}

function swagger2Servers(raw: JsonObject): string[] {
  const host = typeof raw.host === "string" ? raw.host : "";
  if (!host) return [];
  const schemes: string[] = Array.isArray(raw.schemes) && raw.schemes.length ? raw.schemes : ["https"];
  const scheme = schemes.includes("https") ? "https" : schemes[0]!;
  const basePath = typeof raw.basePath === "string" ? raw.basePath.replace(/\/$/, "") : "";
  return [`${scheme}://${host}${basePath}`];
}

// ─── Auth hints ──────────────────────────────────────────────────────────────

export interface AuthSuggestion {
  type: "apiKey" | "bearer" | "basic" | "oauth2cc";
  in?: "header" | "query" | "cookie";
  name?: string;
  tokenUrl?: string;
  scope?: string;
  note: string;
}

/** What the spec itself says about authentication, as the Api tool's auth recipes. */
export function suggestAuth(raw: JsonObject): AuthSuggestion[] {
  const schemes: JsonObject = (raw.components && raw.components.securitySchemes) || raw.securityDefinitions || {};
  const out: AuthSuggestion[] = [];
  for (const [name, rawScheme] of Object.entries<any>(schemes)) {
    const s = deref(raw, rawScheme);
    if (!s || typeof s !== "object") continue;
    if (s.type === "apiKey" && typeof s.name === "string" && (s.in === "header" || s.in === "query" || s.in === "cookie")) {
      out.push({ type: "apiKey", in: s.in, name: s.name, note: `${name}: API key in ${s.in} "${s.name}"` });
    } else if (s.type === "http" && /^bearer$/i.test(String(s.scheme))) {
      out.push({ type: "bearer", note: `${name}: bearer token` });
    } else if (s.type === "http" && /^basic$/i.test(String(s.scheme))) {
      out.push({ type: "basic", note: `${name}: HTTP basic` });
    } else if (s.type === "basic") {
      out.push({ type: "basic", note: `${name}: HTTP basic` });
    } else if (s.type === "oauth2") {
      const cc = s.flows?.clientCredentials;
      if (cc?.tokenUrl) out.push({ type: "oauth2cc", tokenUrl: String(cc.tokenUrl), ...(cc.scopes ? { scope: Object.keys(cc.scopes).join(" ") } : {}), note: `${name}: OAuth2 client credentials` });
      else if (s.flow === "application" && s.tokenUrl) out.push({ type: "oauth2cc", tokenUrl: String(s.tokenUrl), note: `${name}: OAuth2 client credentials` });
      else out.push({ type: "bearer", note: `${name}: OAuth2 (interactive) — give Ares an access token as a bearer token` });
    }
  }
  return out;
}

// ─── Search ──────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "by", "and", "or", "all", "me", "my", "with", "from", "is", "it", "that", "this", "as", "at", "be"]);

/** Split identifiers and prose into lowercase words (camelCase, snake, kebab, path segments). */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export interface SearchOptions {
  limit?: number;
  method?: string;
  tag?: string;
}

export interface SearchHit extends OpIndexEntry {
  score: number;
}

export function searchOperations(ops: OpIndexEntry[], query: string, opts: SearchOptions = {}): { hits: SearchHit[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const method = opts.method?.toUpperCase();
  const tag = opts.tag?.toLowerCase();
  let pool = ops;
  if (method) pool = pool.filter((o) => o.method === method);
  if (tag) pool = pool.filter((o) => o.tags.some((t) => t.toLowerCase() === tag));
  const trimmed = query.trim();
  if (!trimmed) {
    const sorted = [...pool].sort((a, b) => (a.tags[0] ?? "~").localeCompare(b.tags[0] ?? "~") || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return { hits: sorted.slice(0, limit).map((o) => ({ ...o, score: 0 })), total: pool.length };
  }
  const lowerQuery = trimmed.toLowerCase();
  let qTokens = tokenize(trimmed).map(stem);
  const meaningful = qTokens.filter((t) => !STOPWORDS.has(t));
  if (meaningful.length) qTokens = meaningful;
  const unique = [...new Set(qTokens)];
  const scored: SearchHit[] = [];
  for (const op of pool) {
    const idLower = op.id.toLowerCase();
    let score = 0;
    if (idLower === lowerQuery) score += 100;
    else if (lowerQuery.length >= 3 && !/\s/.test(lowerQuery) && idLower.includes(lowerQuery)) score += 10;
    const idTokens = tokenize(op.id).map(stem);
    const pathTokens = tokenize(op.path.replace(/\{[^}]*\}/g, " ")).map(stem);
    const sumTokens = tokenize(op.summary).map(stem);
    const tagTokens = op.tags.flatMap((t) => tokenize(t)).map(stem);
    let matched = 0;
    for (const q of unique) {
      let best = 0;
      const hit = (tokens: string[], exact: number, prefix: number, sub: number) => {
        for (const t of tokens) {
          if (t === q) best = Math.max(best, exact);
          else if (q.length >= 3 && t.startsWith(q)) best = Math.max(best, prefix);
          else if (q.length >= 4 && t.includes(q)) best = Math.max(best, sub);
        }
      };
      hit(idTokens, 6, 3, 1.5);
      hit(pathTokens, 5, 2.5, 1);
      hit(sumTokens, 4, 2, 1);
      hit(tagTokens, 3, 1.5, 0.5);
      if (best > 0) matched++;
      score += best;
    }
    if (matched === 0 && score < 10) continue;
    if (unique.length > 1) score *= 0.5 + 0.5 * (matched / unique.length);
    if (unique.length > 1 && op.summary.toLowerCase().includes(lowerQuery)) score += 3;
    if (op.deprecated) score *= 0.5;
    scored.push({ ...op, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.id.localeCompare(b.id));
  return { hits: scored.slice(0, limit), total: scored.length };
}
