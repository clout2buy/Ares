// Building and running one call against a service described by an OpenAPI spec.
//
// buildRequest turns (operation, params, body, credentials) into a concrete
// HTTP request and refuses — with a message that teaches the model what is
// missing or wrong — anything that does not fit the spec. executeCall sends it
// through the network guard (netGuard.ts), applies the service's rate limit,
// caps and summarises the answer, and scrubs every secret from what comes back.

import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { getCredential, apiCred, apiServicesDir, clientIdName, getProviderConfig, type ApiServiceDef } from "@ares/core";
import { safeFetch, NetBlockedError, type Resolver } from "./netGuard.js";
import type { JsonObject, ResolvedOperation, ResolvedParam } from "./spec.js";
import { atomToJson } from "./atom.js";
import { ApiInputError, type CredentialSource } from "./errors.js";
import { projectFields, selectPath, shrinkJson } from "./shape.js";
import { notConnectedMessage, resolveConnectedToken } from "./connectedToken.js";

export { ApiInputError, type CredentialSource } from "./errors.js";

export function vaultCredentials(home?: string): CredentialSource {
  return { get: (name) => getCredential(name, home ? { home } : {}) };
}

// ─── Parameters ──────────────────────────────────────────────────────────────

const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect",
  "authorization", "proxy-authorization", "x-forwarded-for", "x-forwarded-host", "forwarded",
]);

function describeParam(p: ResolvedParam): string {
  const t = typeof p.schema.type === "string" ? p.schema.type : "string";
  const extra = Array.isArray(p.schema.enum) ? `; one of ${p.schema.enum.slice(0, 12).map((v: unknown) => JSON.stringify(v)).join(", ")}` : "";
  return `${p.name} (${p.in}, ${t}${p.required ? ", required" : ""}${extra})${p.description ? ` — ${p.description.slice(0, 120)}` : ""}`;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

function nearest(name: string, options: string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { n: string; d: number } | undefined;
  for (const o of options) {
    const d = o.toLowerCase() === lower ? 0 : editDistance(lower, o.toLowerCase());
    if (d <= Math.max(2, Math.floor(o.length / 3)) && (!best || d < best.d)) best = { n: o, d };
  }
  return best?.n;
}

function coerceScalar(p: ResolvedParam, value: unknown, schema: JsonObject): string {
  const type = typeof schema.type === "string" ? schema.type.split("|")[0] : undefined;
  let text: string;
  if (type === "integer" || type === "number") {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw new ApiInputError(`parameter "${p.name}" must be ${type === "integer" ? "an integer" : "a number"} (got ${JSON.stringify(value)})`);
    if (typeof schema.minimum === "number" && n < schema.minimum) throw new ApiInputError(`parameter "${p.name}" must be >= ${schema.minimum} (got ${n})`);
    if (typeof schema.maximum === "number" && n > schema.maximum) throw new ApiInputError(`parameter "${p.name}" must be <= ${schema.maximum} (got ${n})`);
    text = String(n);
  } else if (type === "boolean") {
    if (value === true || value === "true") text = "true";
    else if (value === false || value === "false") text = "false";
    else throw new ApiInputError(`parameter "${p.name}" must be true or false (got ${JSON.stringify(value)})`);
  } else {
    if (value !== null && typeof value === "object") throw new ApiInputError(`parameter "${p.name}" must be a single text value, not ${Array.isArray(value) ? "a list" : "an object"}`);
    text = String(value);
  }
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.map((v: unknown) => String(v)).includes(text)) {
    throw new ApiInputError(`parameter "${p.name}" must be one of ${schema.enum.slice(0, 20).map((v: unknown) => JSON.stringify(v)).join(", ")} (got ${JSON.stringify(text)})`);
  }
  return text;
}

type Serialized = { kind: "single"; values: string[]; joiner: string } | { kind: "pairs"; pairs: Array<[string, string]> };

function serializeParam(p: ResolvedParam, value: unknown): Serialized {
  const schema = p.schema;
  const type = typeof schema.type === "string" ? schema.type.split("|")[0] : undefined;
  if (type === "array" || Array.isArray(value)) {
    let list: unknown[];
    if (Array.isArray(value)) list = value;
    else if (typeof value === "string") list = value.split(",").map((s) => s.trim()).filter(Boolean);
    else list = [value];
    const itemSchema: JsonObject = schema.items && typeof schema.items === "object" ? schema.items : {};
    const values = list.map((item) => coerceScalar(p, item, itemSchema));
    const cf = p.collectionFormat;
    const style = p.style ?? (cf === "ssv" ? "spaceDelimited" : cf === "pipes" ? "pipeDelimited" : cf === "tsv" ? "tabDelimited" : "form");
    const explode = p.explode ?? (cf === "multi" || (cf === undefined && style === "form"));
    const joiner = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : style === "tabDelimited" ? "\t" : ",";
    if (explode && (style === "form" || p.in === "query")) return { kind: "pairs", pairs: values.map((v) => [p.name, v] as [string, string]) };
    return { kind: "single", values, joiner };
  }
  if (type === "object" || (value !== null && typeof value === "object")) {
    if (value === null || typeof value !== "object") throw new ApiInputError(`parameter "${p.name}" must be an object`);
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string]);
    if ((p.explode ?? true) && (p.style ?? "form") === "form") return { kind: "pairs", pairs: entries };
    return { kind: "single", values: entries.flat(), joiner: "," };
  }
  return { kind: "single", values: [coerceScalar(p, value, schema)], joiner: "," };
}

// ─── Auth ────────────────────────────────────────────────────────────────────

interface OAuthCached {
  token: string;
  expiresAt: number;
}
const oauthCache = new Map<string, OAuthCached>();

export function clearOAuthCache(): void {
  oauthCache.clear();
}

export interface AuthMaterial {
  headers: Record<string, string>;
  query: Array<[string, string]>;
  cookies: Array<[string, string]>;
  secrets: string[];
  /** Names (lowercase headers / query params) that carry credentials. */
  headerNames: string[];
  queryNames: string[];
}

export interface CallEnv {
  creds: CredentialSource;
  resolver?: Resolver;
  signal?: AbortSignal;
  now?: () => number;
  /** The Ares home the vault lives in (a connected account's OAuth grant is read from it). */
  home?: string;
}

function notConnected(def: ApiServiceDef, what: string): ApiInputError {
  if (def.oauth) return new ApiInputError(notConnectedMessage(def));
  return new ApiInputError(
    `${def.label} has no ${what} stored. Connect it first: call Connect with service "api-${def.id}" (the owner enters it in a secure form on their phone — never in chat). ` +
      `Headless fallback: set the environment variable ${apiCred(def.id, "KEY")}.`,
  );
}

async function fetchOAuthToken(def: ApiServiceDef, env: CallEnv, baseAllowLan: boolean): Promise<string> {
  if (def.auth.type !== "oauth2cc") throw new Error("not an oauth2 service");
  const cached = oauthCache.get(def.id);
  const now = (env.now ?? Date.now)();
  if (cached && cached.expiresAt - 30_000 > now) return cached.token;
  const id = await env.creds.get(apiCred(def.id, "CLIENT_ID"));
  const secret = await env.creds.get(apiCred(def.id, "CLIENT_SECRET"));
  if (!id || !secret) throw notConnected(def, "client id/secret");
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(def.auth.scope ? { scope: def.auth.scope } : {}) });
  const res = await safeFetch(def.auth.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: form.toString(),
    allowLan: baseAllowLan,
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
    ...(env.resolver ? { resolver: env.resolver } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  });
  let json: any = {};
  try {
    json = JSON.parse(res.body.toString("utf8"));
  } catch {
    // fall through
  }
  if (res.status < 200 || res.status >= 300 || typeof json.access_token !== "string") {
    throw new ApiInputError(`${def.label}: the token endpoint refused the client credentials (HTTP ${res.status}). Check the client id and secret.`);
  }
  const ttl = Number(json.expires_in);
  oauthCache.set(def.id, { token: json.access_token, expiresAt: now + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 300_000) });
  return json.access_token;
}

/** The OAuth app's public client id (Twitch Client-Id, Trello's key): the service's own, else the connected provider's. */
async function clientIdFor(def: ApiServiceDef, env: CallEnv): Promise<string | undefined> {
  const own = await env.creds.get(apiCred(def.id, "CLIENT_ID"));
  if (own) return own;
  const cfg = getProviderConfig((def.oauth?.provider ?? def.oauth?.connect ?? "").toLowerCase());
  return cfg ? env.creds.get(clientIdName(cfg)) : undefined;
}

/** The credential the service's apiKey/bearer recipe uses: the connected account's, or the explicit one. */
async function storedToken(def: ApiServiceDef, env: CallEnv): Promise<string | undefined> {
  if (def.oauth) return (await resolveConnectedToken(def, { creds: env.creds, ...(env.home ? { home: env.home } : {}), ...(env.now ? { now: env.now } : {}) }))?.token;
  return env.creds.get(apiCred(def.id, "KEY"));
}

async function resolveAuthMain(def: ApiServiceDef, env: CallEnv): Promise<AuthMaterial> {
  const out: AuthMaterial = { headers: {}, query: [], cookies: [], secrets: [], headerNames: [], queryNames: [] };
  const auth = def.auth;
  switch (auth.type) {
    case "none":
      return out;
    case "apiKey": {
      const stored = await storedToken(def, env);
      const value = stored ?? auth.defaultValue;
      if (!value) {
        if (auth.optional) return out;
        throw notConnected(def, "API key");
      }
      // A service's own public demo key (DEMO_KEY) is not a secret worth scrubbing.
      if (stored) out.secrets.push(stored);
      if (auth.in === "header") {
        out.headers[auth.name.toLowerCase()] = value;
        out.headerNames.push(auth.name.toLowerCase());
      } else if (auth.in === "query") {
        out.query.push([auth.name, value]);
        out.queryNames.push(auth.name);
      } else {
        out.cookies.push([auth.name, value]);
        out.headerNames.push("cookie");
      }
      return out;
    }
    case "bearer": {
      const token = await storedToken(def, env);
      if (!token) {
        if (auth.optional) return out;
        throw notConnected(def, "access token");
      }
      out.secrets.push(token);
      const header = (auth.header ?? "authorization").toLowerCase();
      if (auth.template) {
        const clientId = auth.template.includes("{CLIENT_ID}") ? await clientIdFor(def, env) : undefined;
        if (auth.template.includes("{CLIENT_ID}") && !clientId) throw new ApiInputError(`${def.label} needs the app's client id (${apiCred(def.id, "CLIENT_ID")}) as well as the token - reconnect it${def.oauth ? ` (Connect service "${def.oauth.connect}")` : ""}.`);
        out.headers[header] = auth.template.split("{token}").join(token).split("{CLIENT_ID}").join(clientId ?? "");
      } else {
        out.headers[header] = `${auth.scheme ?? "Bearer"} ${token}`.trim();
      }
      out.headerNames.push(header);
      return out;
    }
    case "basic": {
      const user = await env.creds.get(apiCred(def.id, "USER"));
      const pass = await env.creds.get(apiCred(def.id, "PASS"));
      if (!user || !pass) throw notConnected(def, "username/password");
      out.secrets.push(pass, Buffer.from(`${user}:${pass}`).toString("base64"));
      out.headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      out.headerNames.push("authorization");
      return out;
    }
    case "oauth2cc": {
      const token = await fetchOAuthToken(def, env, def.allowLan === true);
      out.secrets.push(token);
      out.headers.authorization = `Bearer ${token}`;
      out.headerNames.push("authorization");
      return out;
    }
  }
}

export async function resolveAuth(def: ApiServiceDef, env: CallEnv): Promise<AuthMaterial> {
  const out = await resolveAuthMain(def, env);
  // Extra credential-bearing headers (Twitch wants Client-Id beside the token).
  for (const [name, template] of Object.entries(def.authHeaders ?? {})) {
    let value = template;
    if (template.includes("{CLIENT_ID}")) {
      const clientId = await clientIdFor(def, env);
      if (!clientId) throw new ApiInputError(`${def.label} needs the app's client id (${apiCred(def.id, "CLIENT_ID")}) - reconnect it${def.oauth ? ` (Connect service "${def.oauth.connect}")` : ""}.`);
      value = template.split("{CLIENT_ID}").join(clientId);
    }
    out.headers[name.toLowerCase()] = value;
    out.headerNames.push(name.toLowerCase());
  }
  return out;
}

// ─── Request building ────────────────────────────────────────────────────────

export interface BuildInput {
  def: ApiServiceDef;
  op: ResolvedOperation;
  baseUrl: string;
  params: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
  auth: AuthMaterial;
}

export interface BuiltRequest {
  method: string;
  url: string;
  /** Same URL with credential query values masked — the only form ever shown. */
  displayUrl: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  notes: string[];
}

function baseFor(def: ApiServiceDef, op: ResolvedOperation, baseUrl: string): string {
  const origin = (u: string): string | null => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };
  const allowed = new Set([origin(baseUrl), ...(def.extraOrigins ?? []).map(origin)].filter((o): o is string => Boolean(o)));
  for (const server of op.servers) {
    const o = /^https?:\/\//i.test(server) ? origin(server) : null;
    if (o && allowed.has(o) && o !== origin(baseUrl)) return server.replace(/\/+$/, "");
  }
  return baseUrl.replace(/\/+$/, "");
}

function multipartBody(fields: Record<string, unknown>): { body: Buffer; contentType: string } {
  const boundary = `----ares${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name.replace(/"/g, "%22")}"\r\n\r\n${text}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function buildRequest(input: BuildInput): BuiltRequest {
  const { def, op, auth } = input;
  const notes: string[] = [];
  const authKeyIn = def.auth.type === "apiKey" ? def.auth.in : undefined;
  const authKeyName = def.auth.type === "apiKey" ? def.auth.name.toLowerCase() : undefined;
  const isAuthManaged = (p: ResolvedParam) =>
    (p.in === "header" && (p.name.toLowerCase() === "authorization" || (authKeyIn === "header" && p.name.toLowerCase() === authKeyName))) ||
    (p.in === "query" && authKeyIn === "query" && p.name.toLowerCase() === authKeyName) ||
    (p.in === "cookie" && authKeyIn === "cookie" && p.name.toLowerCase() === authKeyName);
  const declared = op.parameters.filter((p) => !isAuthManaged(p));

  // ── match the model's params to the declared ones ──
  const supplied = new Map<string, unknown>();
  const given = input.params ?? {};
  const unknown: string[] = [];
  const byName = new Map<string, ResolvedParam[]>();
  for (const p of declared) byName.set(p.name.toLowerCase(), [...(byName.get(p.name.toLowerCase()) ?? []), p]);
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined || value === null || value === "") continue;
    let param: ResolvedParam | undefined;
    const dot = key.indexOf(".");
    const qualified = dot > 0 && ["path", "query", "header", "cookie"].includes(key.slice(0, dot)) ? { loc: key.slice(0, dot), name: key.slice(dot + 1) } : null;
    const candidates = byName.get(key.toLowerCase());
    if (candidates?.length === 1) param = candidates[0];
    else if (candidates && candidates.length > 1) throw new ApiInputError(`parameter "${key}" exists in more than one place (${candidates.map((c) => c.in).join(", ")}); write it as "${candidates[0]!.in}.${key}"`);
    else if (qualified) param = declared.find((p) => p.in === qualified.loc && p.name.toLowerCase() === qualified.name.toLowerCase());
    if (!param) {
      if (isAuthManagedName(op, key, def)) continue; // the model tried to pass the auth param itself; auth handles it
      unknown.push(key);
      continue;
    }
    supplied.set(`${param.in}:${param.name}`, value);
  }
  if (unknown.length) {
    const hints = unknown.map((k) => {
      const near = nearest(k, declared.map((p) => p.name));
      return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
    });
    throw new ApiInputError(
      `${op.id} has no parameter ${hints.join(", ")}. ` +
        (declared.length ? `Its parameters: ${declared.map(describeParam).join("; ")}.` : "It takes no parameters.") +
        (op.body ? " Put request-body fields in `body`, not `params`." : ""),
    );
  }

  // ── required + defaults ──
  const missing: ResolvedParam[] = [];
  for (const p of declared) {
    const key = `${p.in}:${p.name}`;
    if (supplied.has(key)) continue;
    if (p.required) {
      if (p.schema.default !== undefined) supplied.set(key, p.schema.default);
      else missing.push(p);
    }
  }
  if (missing.length) {
    throw new ApiInputError(
      `${op.id} is missing required ${missing.length === 1 ? "parameter" : "parameters"}: ${missing.map(describeParam).join("; ")}. ` +
        `Pass them in \`params\`, e.g. {"${missing[0]!.name}": ...}.`,
    );
  }

  // ── path ──
  // Curated GraphQL operations share one endpoint; their path carries a "#name" so each is its own operation.
  let pathText = op.path.replace(/#.*$/, "");
  const graphql = op.ext?.graphql && !op.ext.graphql.raw ? op.ext.graphql : undefined;
  const variables: Record<string, unknown> = {};
  const queryPairs: Array<[string, string]> = [];
  const headers: Record<string, string> = {};
  const cookies: Array<[string, string]> = [];
  for (const p of declared) {
    const key = `${p.in}:${p.name}`;
    if (!supplied.has(key)) continue;
    const value = supplied.get(key);
    if (graphql) {
      variables[p.name] = typedVariable(p, value);
      continue;
    }
    const ser = serializeParam(p, value);
    if (p.in === "path") {
      const flat = ser.kind === "single" ? ser.values : ser.pairs.map(([, v]) => v);
      for (const v of flat) for (const part of p.reserved ? v.split("/") : [v]) if (part === "." || part === "..") throw new ApiInputError(`path parameter "${p.name}" may not be "." or ".."`);
      const enc = p.reserved ? (v: string) => v.split("/").map(encodeURIComponent).join("/") : encodeURIComponent;
      const joined = ser.kind === "single" ? ser.values.map(enc).join(",") : flat.map(enc).join(",");
      pathText = pathText.split(`{${p.name}}`).join(joined);
    } else if (p.in === "query") {
      if (ser.kind === "pairs") queryPairs.push(...ser.pairs);
      else queryPairs.push([p.name, ser.values.join(ser.joiner)]);
    } else if (p.in === "header") {
      const name = p.name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(name)) continue;
      headers[name] = ser.kind === "single" ? ser.values.join(ser.joiner) : ser.pairs.map(([k, v]) => `${k},${v}`).join(",");
    } else {
      cookies.push([p.name, ser.kind === "single" ? ser.values.join(ser.joiner) : ser.pairs.map(([, v]) => v).join(",")]);
    }
  }
  const leftover = pathText.match(/\{([^}]+)\}/);
  if (leftover) throw new ApiInputError(`the path still contains {${leftover[1]}} — pass a path parameter named "${leftover[1]}"`);

  // ── body ──
  let bodyOut: string | Buffer | undefined;
  let contentType: string | undefined;
  if (graphql) {
    if (input.body !== undefined && input.body !== null && input.body !== "") throw new ApiInputError(`${op.id} is a fixed GraphQL operation: pass its variables in \`params\`, not a body.`);
    bodyOut = JSON.stringify({ query: graphql.query, variables });
    contentType = "application/json";
  } else if (input.body !== undefined && input.body !== null && input.body !== "") {
    if (op.method === "GET" || op.method === "HEAD") throw new ApiInputError(`${op.id} is a ${op.method}; it does not take a body. Use \`params\`.`);
    if (!op.body) notes.push("this operation declares no request body in the spec; sent anyway");
    contentType = input.contentType ?? op.body?.contentType ?? "application/json";
    if (op.body && input.contentType && !op.body.contentTypes.some((t) => t.split(";")[0]!.trim().toLowerCase() === input.contentType!.split(";")[0]!.trim().toLowerCase())) {
      throw new ApiInputError(`${op.id} accepts ${op.body.contentTypes.join(", ")} (not ${input.contentType})`);
    }
    const mime = contentType.split(";")[0]!.trim().toLowerCase();
    let payload = input.body;
    if (/json/.test(mime)) {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          throw new ApiInputError("`body` must be a JSON object/array (or a string containing valid JSON); this string does not parse");
        }
      }
      checkRequiredProps(op, payload);
      if (op.ext?.graphql?.raw) assertReadOnlyGraphql(payload);
      bodyOut = JSON.stringify(payload);
    } else if (mime === "application/x-www-form-urlencoded") {
      if (typeof payload === "string") bodyOut = payload;
      else {
        checkRequiredProps(op, payload);
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) for (const item of v) form.append(k, String(item));
          else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        bodyOut = form.toString();
      }
    } else if (mime === "multipart/form-data") {
      if (typeof payload === "string") throw new ApiInputError("multipart/form-data needs `body` as an object of text fields (file uploads are not supported)");
      checkRequiredProps(op, payload);
      const m = multipartBody(payload as Record<string, unknown>);
      bodyOut = m.body;
      contentType = m.contentType;
    } else {
      bodyOut = typeof payload === "string" ? payload : JSON.stringify(payload);
    }
  } else if (op.body?.required) {
    throw new ApiInputError(
      `${op.id} needs a request body (${op.body.contentType}). Shape: ${JSON.stringify(op.body.schema).slice(0, 1200)}. Pass it as \`body\`.`,
    );
  }

  // ── assemble ──
  const base = baseFor(def, op, input.baseUrl);
  for (const [k, v] of auth.query) {
    if (!queryPairs.some(([name]) => name === k)) queryPairs.push([k, v]);
  }
  const queryText = queryPairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const fullPath = pathText.startsWith("/") ? pathText : `/${pathText}`;
  const url = `${base}${fullPath}${queryText ? `?${queryText}` : ""}`;
  const maskedNames = new Set(auth.queryNames.map((n) => n.toLowerCase()));
  const displayQuery = queryPairs.map(([k, v]) => `${encodeURIComponent(k)}=${maskedNames.has(k.toLowerCase()) ? "***" : encodeURIComponent(v)}`).join("&");
  const displayUrl = `${base}${fullPath}${displayQuery ? `?${displayQuery}` : ""}`;

  const allCookies = [...cookies, ...auth.cookies];
  const finalHeaders: Record<string, string> = {
    accept: "application/json, application/xml;q=0.8, text/*;q=0.6, */*;q=0.3",
    ...(def.headers ? Object.fromEntries(Object.entries(def.headers).map(([k, v]) => [k.toLowerCase(), v])) : {}),
    ...headers,
    ...auth.headers,
    ...(allCookies.length ? { cookie: allCookies.map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
  };
  if (!finalHeaders["user-agent"]) finalHeaders["user-agent"] = "AresAgent/1.0 (personal assistant)";
  return { method: op.method, url, displayUrl, headers: finalHeaders, ...(bodyOut !== undefined ? { body: bodyOut } : {}), notes };
}

/** A GraphQL variable keeps its JSON type: numbers stay numbers, booleans booleans, lists lists. */
function typedVariable(p: ResolvedParam, value: unknown): unknown {
  const schema = p.schema;
  const type = typeof schema.type === "string" ? schema.type.split("|")[0] : undefined;
  if (type === "object") {
    let obj = value;
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch {
        throw new ApiInputError(`parameter "${p.name}" must be an object`);
      }
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new ApiInputError(`parameter "${p.name}" must be an object`);
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const missing = required.filter((k) => (obj as Record<string, unknown>)[k] === undefined);
    if (missing.length) throw new ApiInputError(`parameter "${p.name}" is missing required ${missing.length === 1 ? "field" : "fields"}: ${missing.join(", ")}`);
    return obj;
  }
  if (type === "array") {
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : [value];
    const itemSchema: JsonObject = schema.items && typeof schema.items === "object" ? schema.items : {};
    return list.map((item) => typedScalar(p, item, itemSchema));
  }
  return typedScalar(p, value, schema);
}

function typedScalar(p: ResolvedParam, value: unknown, schema: JsonObject): unknown {
  const type = typeof schema.type === "string" ? schema.type.split("|")[0] : undefined;
  const text = coerceScalar(p, value, schema); // validates type, range and enum
  if (type === "integer" || type === "number") return Number(text);
  if (type === "boolean") return text === "true";
  return text;
}

/** Free-form GraphQL here may only read: no mutation or subscription operation. */
export function graphqlTextIsReadOnly(query: string): boolean {
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, " ");
  return !/(^|[}\s;])(mutation|subscription)\b/i.test(stripped);
}

function assertReadOnlyGraphql(payload: unknown): void {
  const query = payload && typeof payload === "object" ? (payload as Record<string, unknown>).query : undefined;
  if (typeof query !== "string" || !query.trim()) throw new ApiInputError('`body` needs {"query": "...", "variables": {...}}');
  if (!graphqlTextIsReadOnly(query)) throw new ApiInputError("free-form GraphQL here is read-only: a mutation or subscription is refused. Use the named mutation operations (search for them), which ask the owner first.");
}

function isAuthManagedName(op: ResolvedOperation, key: string, def: ApiServiceDef): boolean {
  const lower = key.toLowerCase();
  if (lower === "authorization") return true;
  return def.auth.type === "apiKey" && def.auth.name.toLowerCase() === lower;
}

function checkRequiredProps(op: ResolvedOperation, payload: unknown): void {
  const schema = op.body?.schema;
  if (!schema || typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((k) => (payload as Record<string, unknown>)[k] === undefined);
  if (missing.length) {
    throw new ApiInputError(`the request body is missing required ${missing.length === 1 ? "field" : "fields"}: ${missing.join(", ")}. Body shape: ${JSON.stringify(schema).slice(0, 1000)}`);
  }
}

// ─── Redaction ───────────────────────────────────────────────────────────────

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-cg-demo-api-key|x-cg-pro-api-key|x-csrf-token)$/i;
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
];

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function redactTokens(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted-token]");
  return out;
}

const KEEP_HEADERS = new Set([
  "content-type", "content-length", "content-encoding", "date", "etag", "last-modified", "cache-control", "retry-after", "link", "location", "allow", "server",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-rate-limit-limit", "x-rate-limit-remaining", "x-rate-limit-reset", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
  "x-request-id", "x-total-count", "x-next-page", "x-page", "x-per-page",
]);

/** Response headers worth showing, with anything credential-shaped scrubbed. */
export function visibleHeaders(headers: Record<string, string>, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SECRET_HEADER.test(lower)) {
      out[lower] = "[redacted]";
      continue;
    }
    if (!KEEP_HEADERS.has(lower) && !/^x-ratelimit|^ratelimit/.test(lower)) continue;
    out[lower] = redactTokens(redactText(value, secrets)).slice(0, 300);
  }
  return out;
}

// ─── Rate limit + audit ──────────────────────────────────────────────────────

interface Bucket {
  stamps: number[];
  last: number;
}
const buckets = new Map<string, Bucket>();

export function resetRateLimits(): void {
  buckets.clear();
}

/** Wait (briefly) for the service's interval, or refuse with how long to wait. */
export async function takeRateSlot(def: ApiServiceDef, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const bucket = buckets.get(def.id) ?? { stamps: [], last: 0 };
  buckets.set(def.id, bucket);
  const perMin = def.ratePerMin ?? 60;
  const t0 = now();
  bucket.stamps = bucket.stamps.filter((s) => t0 - s < 60_000);
  if (bucket.stamps.length >= perMin) {
    const wait = 60_000 - (t0 - bucket.stamps[0]!);
    throw new ApiInputError(`${def.label} is rate-limited to ${perMin} calls a minute and that budget is spent. Retry in about ${Math.ceil(wait / 1000)}s, and batch or narrow what you ask for.`);
  }
  const gap = def.minIntervalMs ?? 0;
  if (gap > 0 && bucket.last) {
    const wait = bucket.last + gap - t0;
    if (wait > 0) {
      if (wait > 5_000) throw new ApiInputError(`${def.label} allows one call every ${Math.round(gap / 1000)}s; retry in ${Math.ceil(wait / 1000)}s.`);
      await sleep(wait);
    }
  }
  bucket.last = now();
  bucket.stamps.push(bucket.last);
}

export interface AuditEntry {
  ts: string;
  service: string;
  operation: string;
  method: string;
  host: string;
  status?: number;
  ms?: number;
  bytes?: number;
  error?: string;
  paramNames?: string[];
  write?: boolean;
}

export async function appendAudit(entry: AuditEntry, home?: string): Promise<void> {
  try {
    const dir = apiServicesDir(home);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "audit.jsonl");
    try {
      const s = await stat(file);
      if (s.size > 2 * 1024 * 1024) await rename(file, `${file}.1`);
    } catch {
      // no file yet
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // auditing must never break a call
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  maxChars?: number;
  select?: string;
  /** Keep only these dotted fields of each item ("id", "name", "owner.login"). */
  fields?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  home?: string;
  /** Pause before the one retry of a read that got a 5xx (default 700 ms). */
  retryDelayMs?: number;
  /** Longest Retry-After honoured after a 429 (default 15 s); a longer one is reported, not waited out. */
  maxRetryWaitMs?: number;
  /** Retries after a 429 (default 2). */
  maxRetries429?: number;
  /** Sleep, injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PagingInfo {
  pages: number;
  items: number;
  /** The service has more beyond what was fetched. */
  more: boolean;
  /** Pass this in `params` to continue where this call stopped. */
  next?: { param: string; value: string | number };
  stoppedBy: "end" | "pages" | "items" | "error";
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  method: string;
  url: string;
  contentType: string;
  headers: Record<string, string>;
  /** The body as shown to the model: compact JSON (possibly narrowed by `select`) or text. */
  text: string;
  /** The parsed body when it is JSON (shrunk to fit when it was too big) — use this instead of `text`. */
  data?: unknown;
  truncated: boolean;
  bytes: number;
  ms: number;
  notes: string[];
  paging?: PagingInfo;
}

function parseBody(contentType: string, buf: Buffer, def: ApiServiceDef, notes: string[]): { body: unknown; text: string } {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (/^(image|audio|video)\//.test(mime) || mime === "application/octet-stream" || mime === "application/pdf" || mime === "application/zip") {
    return { body: undefined, text: `(binary ${mime}, ${buf.length} bytes — not shown)` };
  }
  const text = buf.toString("utf8");
  if (def.transform === "atom" && /xml|atom/.test(mime)) {
    try {
      const converted = atomToJson(text);
      notes.push("Atom XML converted to JSON");
      return { body: converted, text: JSON.stringify(converted) };
    } catch {
      // fall through to raw text
    }
  }
  if (/json/.test(mime) || /^\s*[{[]/.test(text)) {
    try {
      const body = JSON.parse(text) as unknown;
      return { body, text };
    } catch {
      // not JSON after all
    }
  }
  return { body: undefined, text };
}

/** One fetched page, before it is shaped for the model. Its headers are the raw ones: never shown as is. */
export interface PageResult {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  wireTruncated: boolean;
  bytes: number;
  ms: number;
  notes: string[];
  /** HTTP 200 whose body says it failed (Slack {ok:false}, GraphQL errors with no data). */
  softError?: string;
  /** The Link header's rel="next" URL. */
  linkNext?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRateLimited(res: { status: number; headers: Record<string, string> }): boolean {
  if (res.status === 429) return true;
  // GitHub's primary/secondary limits answer 403 with the budget spent.
  return res.status === 403 && res.headers["x-ratelimit-remaining"] === "0" && Boolean(res.headers["retry-after"] ?? res.headers["x-ratelimit-reset"]);
}

/** How long the service asks to wait, in ms (Retry-After seconds or date; x-ratelimit-reset epoch or delta). */
export function retryAfterMs(headers: Record<string, string>, nowMs: number): number | undefined {
  const ra = headers["retry-after"];
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.ceil(Number(ra) * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  const reset = headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"] ?? headers["x-rate-limit-reset"];
  if (reset && /^\d+$/.test(reset.trim())) {
    const n = Number(reset);
    return n > 1e9 ? Math.max(0, n * 1000 - nowMs) : n * 1000;
  }
  return undefined;
}

export function parseLinkNext(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(/,\s*(?=<)/)) {
    const m = /<([^>]+)>\s*;(.*)/.exec(part);
    if (m && /rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?/i.test(m[2]!)) return m[1];
  }
  return undefined;
}

function firstGraphqlError(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown })?.errors;
  if (!Array.isArray(errors) || !errors.length) return undefined;
  const first = errors[0] as { message?: unknown };
  return typeof first?.message === "string" ? first.message.slice(0, 300) : "GraphQL error";
}

/**
 * One guarded request, end to end: rate slot, the call, a patient retry on 429
 * (any method — a 429 was not processed), one retry of a read after a 5xx, the
 * audit line. Returns the page before any shaping.
 */
export async function fetchPage(def: ApiServiceDef, op: ResolvedOperation, built: BuiltRequest, auth: AuthMaterial, env: CallEnv, opts: ExecuteOptions = {}): Promise<PageResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  await takeRateSlot(def, now);
  const started = now();
  let host = "";
  try {
    host = new URL(built.url).host;
  } catch {
    // buildRequest produced the URL; a bad one is caught by safeFetch below
  }
  const audit: AuditEntry = { ts: new Date(started).toISOString(), service: def.id, operation: op.id, method: built.method, host, ...(op.method !== "GET" && op.method !== "HEAD" ? { write: true } : {}) };
  try {
    const send = () =>
      safeFetch(built.url, {
        method: built.method,
        headers: built.headers,
        ...(built.body !== undefined ? { body: built.body } : {}),
        allowLan: def.allowLan === true,
        timeoutMs: opts.timeoutMs ?? 20_000,
        maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
        credentialHeaders: auth.headerNames,
        credentialQuery: auth.queryNames,
        insecureTls: def.insecureTls === true,
        ...(env.resolver ? { resolver: env.resolver } : {}),
        ...(env.signal ? { signal: env.signal } : {}),
      });
    let res = await send();
    const notes = [...built.notes];
    // Rate limited: wait what the service asks (bounded) and try again.
    const maxRetries = opts.maxRetries429 ?? 2;
    const maxWait = opts.maxRetryWaitMs ?? 15_000;
    let retries = 0;
    while (isRateLimited(res) && !env.signal?.aborted) {
      const asked = retryAfterMs(res.headers, now());
      const wait = Math.max(asked ?? 1000 * 2 ** retries, 250);
      if (retries >= maxRetries) {
        notes.push(`still rate limited (HTTP ${res.status}) after ${retries} retr${retries === 1 ? "y" : "ies"}${asked !== undefined ? `; the service asks for ${Math.ceil(asked / 1000)}s` : ""} - slow down and try again later`);
        break;
      }
      if (wait > maxWait) {
        notes.push(`rate limited (HTTP ${res.status}): the service asks for ${Math.ceil(wait / 1000)}s, longer than the ${Math.round(maxWait / 1000)}s this call will wait - try again after that`);
        break;
      }
      await sleep(wait);
      await takeRateSlot(def, now);
      res = await send();
      retries++;
      notes.push(`waited ${Math.max(1, Math.round(wait / 1000))}s (Retry-After) and retried after HTTP 429`);
    }
    // A read that hit a server hiccup is safe to repeat once (never a write: it might have happened).
    if ((built.method === "GET" || built.method === "HEAD") && [500, 502, 503, 504].includes(res.status) && !env.signal?.aborted) {
      const first = res.status;
      await sleep(opts.retryDelayMs ?? 700);
      await takeRateSlot(def, now);
      res = await send();
      notes.push(`retried once after HTTP ${first}`);
    }
    const ms = now() - started;
    const contentType = res.headers["content-type"] ?? "";
    if (res.redirects.length) notes.push(`followed ${res.redirects.length} redirect(s)`);
    const parsed = parseBody(contentType, res.body, def, notes);
    let softError: string | undefined;
    if (parsed.body !== undefined && typeof parsed.body === "object" && parsed.body !== null) {
      const envelope = def.errorEnvelope;
      if (envelope && (parsed.body as Record<string, unknown>)[envelope.okPath] === false) {
        const detail = (parsed.body as Record<string, unknown>)[envelope.errorPath];
        softError = `${def.label} refused it: ${typeof detail === "string" ? detail : "ok was false"}`;
      }
      if (op.ext?.graphql || /graphql/i.test(op.path)) {
        const message = firstGraphqlError(parsed.body);
        if (message) {
          const hasData = (parsed.body as { data?: unknown }).data !== null && (parsed.body as { data?: unknown }).data !== undefined;
          if (hasData) notes.push(`GraphQL returned an error alongside data: ${message}`);
          else softError = `GraphQL error: ${message}`;
        }
      }
    }
    audit.status = res.status;
    audit.ms = ms;
    audit.bytes = res.body.length;
    await appendAudit(audit, opts.home);
    const linkNext = parseLinkNext(res.headers.link);
    return {
      status: res.status,
      contentType,
      headers: res.headers,
      body: parsed.body,
      text: parsed.text,
      wireTruncated: res.truncated,
      bytes: res.body.length,
      ms,
      notes,
      ...(softError ? { softError } : {}),
      ...(linkNext ? { linkNext } : {}),
    };
  } catch (err) {
    audit.error = redactText(err instanceof Error ? err.message : String(err), auth.secrets).slice(0, 200);
    audit.ms = now() - started;
    await appendAudit(audit, opts.home);
    if (err instanceof NetBlockedError) throw new ApiInputError(`blocked by the network guard: ${err.message}`);
    throw err;
  }
}

/**
 * Shape the page(s) for the model: select a part, keep chosen fields, redact,
 * and when it is still too big shrink it structurally (never mid-value).
 * `body` is the parsed body (for several pages: the merged items).
 */
export function renderResult(
  def: ApiServiceDef,
  op: ResolvedOperation,
  built: BuiltRequest,
  auth: AuthMaterial,
  last: PageResult,
  body: unknown,
  notesIn: string[],
  opts: ExecuteOptions,
  extra: { bytes?: number; ms?: number; paging?: PagingInfo } = {},
): ApiCallResult {
  void def;
  const notes = [...notesIn];
  let value = body;
  let text = last.text;
  if (opts.select && value !== undefined) {
    const picked = selectPath(value, opts.select);
    if (picked === undefined) notes.push(`select "${opts.select}" matched nothing; showing the whole response`);
    else {
      value = picked;
      text = typeof picked === "string" ? picked : JSON.stringify(picked);
    }
  }
  if (opts.fields?.length && value !== undefined && value !== null && typeof value === "object") {
    value = projectFields(value, opts.fields, opts.select ? undefined : op.ext?.paginate?.items);
    text = JSON.stringify(value);
  }
  const maxChars = Math.min(Math.max(opts.maxChars ?? 12_000, 500), 60_000);
  let truncated = last.wireTruncated;
  let shown: string;
  let data: unknown;
  const cutNote = (detail: string) =>
    `output cut to ${maxChars} characters${detail} — narrow the request (limit/fields) or pass \`select\` (a dotted path such as "results.0.name" or "items.*.id"; "items.20:40" slices)`;
  if (value !== undefined && value !== null && typeof value === "object") {
    let json = JSON.stringify(value);
    let shrunk: unknown = value;
    if (json.length > maxChars) {
      const s = shrinkJson(value, maxChars);
      shrunk = s.value;
      json = JSON.stringify(s.value);
      truncated = true;
      notes.push(cutNote(s.cuts.length ? ` (${s.cuts.join("; ")})` : ""));
      if (json.length > maxChars) {
        json = `${json.slice(0, maxChars)}…`;
        shrunk = undefined;
      }
    }
    shown = redactText(json, auth.secrets);
    if (shrunk !== undefined) {
      if (shown === json) data = shrunk;
      else {
        try {
          data = JSON.parse(shown);
        } catch {
          data = undefined;
        }
      }
    }
  } else {
    const plain = value !== undefined && typeof value !== "string" ? JSON.stringify(value) : typeof value === "string" ? value : text;
    shown = redactText(plain, auth.secrets);
    if (shown.length > maxChars) {
      shown = `${shown.slice(0, maxChars)}…`;
      truncated = true;
      notes.push(cutNote(""));
    }
  }
  if (last.wireTruncated) notes.push(`the response exceeded ${Math.round((opts.maxBytes ?? 2 * 1024 * 1024) / 1024)} KB and was cut`);
  const ok = last.status >= 200 && last.status < 300 && !last.softError;
  if (last.softError) notes.push(last.softError);
  return {
    ok,
    status: last.status,
    method: built.method,
    url: built.displayUrl,
    contentType: last.contentType,
    headers: visibleHeaders(last.headers, auth.secrets),
    text: shown,
    ...(data !== undefined ? { data } : {}),
    truncated,
    bytes: extra.bytes ?? last.bytes,
    ms: extra.ms ?? last.ms,
    notes,
    ...(extra.paging ? { paging: extra.paging } : {}),
  };
}

export async function executeCall(def: ApiServiceDef, op: ResolvedOperation, built: BuiltRequest, auth: AuthMaterial, env: CallEnv, opts: ExecuteOptions = {}): Promise<ApiCallResult> {
  const page = await fetchPage(def, op, built, auth, env, opts);
  return renderResult(def, op, built, auth, page, page.body, page.notes, opts);
}
