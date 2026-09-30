// The Api service manager: which services exist (presets + the owner's own),
// their parsed specs, adding/removing, classifying a call as read or write,
// the live check the connect form runs, and the one-call entry point.

import { statSync } from "node:fs";
import path from "node:path";
import {
  API_PRESET_DEFS,
  apiConnectId,
  apiConnectService,
  apiCred,
  apiPresetDef,
  apiServiceDir,
  getCredential,
  listApiServiceDefs,
  readApiServiceSpecText,
  registerConnectService,
  removeApiServiceFiles,
  resolveApiServiceDef,
  saveApiServiceDef,
  saveApiServiceSpec,
  unregisterConnectService,
  validateApiId,
  type ApiAuth,
  type ApiServiceDef,
} from "@ares/core";
import { assertUrlAllowed, safeFetch, NetBlockedError, type Resolver } from "./netGuard.js";
import {
  SpecHandle,
  SpecError,
  parseSpecText,
  searchOperations,
  suggestAuth,
  tokenize,
  type AuthSuggestion,
  type ResolvedOperation,
} from "./spec.js";
import { PRESET_SPECS } from "./presets.js";
import {
  ApiInputError,
  buildRequest,
  executeCall,
  resolveAuth,
  vaultCredentials,
  type ApiCallResult,
  type CredentialSource,
  type ExecuteOptions,
} from "./call.js";

export interface ServiceEnv {
  home?: string;
  creds?: CredentialSource;
  resolver?: Resolver;
  signal?: AbortSignal;
}

// ─── Spec handles ────────────────────────────────────────────────────────────

const handleCache = new Map<string, { key: string; handle: SpecHandle }>();
const MAX_CACHED = 8;

function remember(id: string, key: string, handle: SpecHandle): SpecHandle {
  handleCache.set(id, { key, handle });
  while (handleCache.size > MAX_CACHED) handleCache.delete(handleCache.keys().next().value as string);
  return handle;
}

/** The parsed spec of a service (sync, cached). Throws ApiInputError when there is none. */
export function specHandleFor(def: ApiServiceDef, home?: string): SpecHandle {
  if (def.specSource.kind === "preset") {
    const cached = handleCache.get(def.id);
    if (cached?.key === "preset") return cached.handle;
    const raw = PRESET_SPECS[def.id];
    if (!raw) throw new ApiInputError(`preset ${def.id} has no bundled spec`);
    return remember(def.id, "preset", new SpecHandle(raw));
  }
  const file = path.join(apiServiceDir(def.id, home), "spec.json");
  let key: string;
  try {
    const s = statSync(file);
    key = `${s.size}:${s.mtimeMs}`;
  } catch {
    throw new ApiInputError(`service ${def.id} has no stored spec. Re-add it with Api add (spec_url or spec).`);
  }
  const cached = handleCache.get(def.id);
  if (cached?.key === key) return cached.handle;
  const text = readApiServiceSpecText(def.id, home);
  if (!text) throw new ApiInputError(`service ${def.id} has no stored spec. Re-add it with Api add (spec_url or spec).`);
  try {
    return remember(def.id, key, new SpecHandle(parseSpecText(text)));
  } catch (err) {
    throw new ApiInputError(`the stored spec for ${def.id} no longer parses: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function dropCachedHandle(id: string): void {
  handleCache.delete(id);
}

// ─── Listing ─────────────────────────────────────────────────────────────────

export interface ServiceSummary {
  id: string;
  label: string;
  blurb: string;
  preset: boolean;
  operations: number;
  /** "none" needs nothing; "connected"/"not-connected" for credentialed services. */
  access: "no-key" | "optional-key" | "connected" | "not-connected";
  lan?: boolean;
  connect?: string;
}

async function accessOf(def: ApiServiceDef, home?: string): Promise<ServiceSummary["access"]> {
  const get = (name: string) => getCredential(name, home ? { home } : {});
  const needsBase = Boolean(def.baseUrlField);
  if (needsBase && !(await get(apiCred(def.id, "BASEURL")))) return "not-connected";
  switch (def.auth.type) {
    case "none":
      return needsBase ? "connected" : "no-key";
    case "apiKey":
    case "bearer": {
      const has = Boolean(await get(apiCred(def.id, "KEY")));
      if (has) return "connected";
      return def.auth.optional ? "optional-key" : "not-connected";
    }
    case "basic":
      return (await get(apiCred(def.id, "USER"))) && (await get(apiCred(def.id, "PASS"))) ? "connected" : "not-connected";
    case "oauth2cc":
      return (await get(apiCred(def.id, "CLIENT_ID"))) && (await get(apiCred(def.id, "CLIENT_SECRET"))) ? "connected" : "not-connected";
  }
}

export async function listServices(home?: string): Promise<ServiceSummary[]> {
  const defs = [...API_PRESET_DEFS, ...listApiServiceDefs(home)];
  const out: ServiceSummary[] = [];
  for (const def of defs) {
    let operations = 0;
    try {
      operations = specHandleFor(def, home).ops.length;
    } catch {
      // a broken stored spec still lists, with 0 operations
    }
    const access = await accessOf(def, home);
    out.push({
      id: def.id,
      label: def.label,
      blurb: def.blurb,
      preset: def.specSource.kind === "preset",
      operations,
      access,
      ...(def.allowLan ? { lan: true } : {}),
      ...(access === "not-connected" || access === "optional-key" ? { connect: `Connect service "${apiConnectId(def.id)}"` } : {}),
    });
  }
  return out;
}

// ─── Adding ──────────────────────────────────────────────────────────────────

export interface AddServiceInput {
  id: string;
  label?: string;
  specUrl?: string;
  specText?: string;
  baseUrl?: string;
  /** "ask": have the owner type the base URL into the connect form. */
  baseUrlFromOwner?: boolean;
  auth?: ApiAuth;
  allowLan?: boolean;
  insecureTls?: boolean;
  headers?: Record<string, string>;
  ratePerMin?: number;
  minIntervalMs?: number;
  verifyOperationId?: string;
  readOperationIds?: string[];
}

export interface AddServiceResult {
  def: ApiServiceDef;
  title: string;
  operations: number;
  specVersion: string;
  suggestions: AuthSuggestion[];
  notes: string[];
}

export async function fetchSpecText(url: string, env: ServiceEnv, allowLan: boolean): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiInputError(`spec_url is not a valid URL: ${url.slice(0, 120)}`);
  }
  try {
    assertUrlAllowed(parsed, { allowLan });
    const res = await safeFetch(parsed.href, {
      headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*;q=0.5" },
      allowLan,
      timeoutMs: 30_000,
      maxBytes: 16 * 1024 * 1024,
      ...(env.resolver ? { resolver: env.resolver } : {}),
      ...(env.signal ? { signal: env.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) throw new ApiInputError(`fetching the spec answered HTTP ${res.status}`);
    if (res.truncated) throw new ApiInputError("the spec is larger than 16 MB; pass a trimmed copy as `spec`");
    return res.body.toString("utf8");
  } catch (err) {
    if (err instanceof NetBlockedError) throw new ApiInputError(`spec_url blocked by the network guard: ${err.message}`);
    throw err;
  }
}

export async function addService(input: AddServiceInput, env: ServiceEnv = {}): Promise<AddServiceResult> {
  const idError = validateApiId(input.id);
  if (idError) throw new ApiInputError(`service: ${idError}`);
  if (apiPresetDef(input.id)) throw new ApiInputError(`"${input.id}" is a built-in preset id; pick another name for your own service`);
  if (!input.specUrl && !input.specText) throw new ApiInputError("Api add needs `spec_url` (an OpenAPI/Swagger URL) or `spec` (the JSON/YAML text)");
  if (input.specUrl && input.specText) throw new ApiInputError("pass `spec_url` or `spec`, not both");
  const notes: string[] = [];
  const text = input.specText ?? (await fetchSpecText(input.specUrl!, env, input.allowLan === true));
  let handle: SpecHandle;
  let raw;
  try {
    raw = parseSpecText(text);
    handle = new SpecHandle(raw);
  } catch (err) {
    if (err instanceof SpecError) throw new ApiInputError(`that is not a usable OpenAPI spec: ${err.message}`);
    throw err;
  }
  if (handle.meta.operationCount === 0) throw new ApiInputError("the spec has no operations");

  // Base URL: the owner's, else the spec's first server (resolved against the spec URL when relative).
  let baseUrl = input.baseUrl?.trim();
  if (!baseUrl && !input.baseUrlFromOwner) {
    const first = handle.meta.servers[0];
    if (first && /^https?:\/\//i.test(first)) baseUrl = first;
    else if (first && input.specUrl) baseUrl = new URL(first, input.specUrl).href;
    if (!baseUrl) throw new ApiInputError("the spec names no absolute server URL; pass `base_url` (e.g. https://api.example.com/v1)");
    notes.push(`base URL taken from the spec: ${baseUrl}`);
  }
  if (baseUrl) {
    try {
      assertUrlAllowed(new URL(baseUrl), { allowLan: input.allowLan === true });
    } catch (err) {
      throw new ApiInputError(`base_url is not allowed: ${err instanceof Error ? err.message : String(err)}`);
    }
    baseUrl = baseUrl.replace(/\/+$/, "");
  }

  const suggestions = suggestAuth(raw);
  let auth: ApiAuth | undefined = input.auth;
  if (!auth) {
    const s = suggestions[0];
    if (s?.type === "apiKey" && s.in && s.name) auth = { type: "apiKey", in: s.in, name: s.name };
    else if (s?.type === "bearer") auth = { type: "bearer" };
    else if (s?.type === "basic") auth = { type: "basic" };
    else if (s?.type === "oauth2cc" && s.tokenUrl) auth = { type: "oauth2cc", tokenUrl: s.tokenUrl, ...(s.scope ? { scope: s.scope } : {}) };
    else auth = { type: "none" };
    notes.push(`authentication: ${auth.type}${s ? ` (from the spec: ${s.note})` : " (the spec declares none; pass `auth` if the service needs a key)"}`);
  }
  if (auth.type === "oauth2cc") {
    try {
      assertUrlAllowed(new URL(auth.tokenUrl), { allowLan: input.allowLan === true });
    } catch (err) {
      throw new ApiInputError(`auth.token_url is not allowed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (input.verifyOperationId && !handle.has(input.verifyOperationId)) throw new ApiInputError(`verify_operation "${input.verifyOperationId}" is not an operation of this spec`);
  for (const id of input.readOperationIds ?? []) if (!handle.has(id)) throw new ApiInputError(`read_operation "${id}" is not an operation of this spec`);
  for (const name of Object.keys(input.headers ?? {})) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name) || /key|token|secret|auth|passw/i.test(name)) {
      throw new ApiInputError(`\`headers\` are stored in plain text and may not carry credentials ("${name}"). Use \`auth\` for the credential recipe; the owner enters the secret in the secure form (Connect service "api-${input.id}").`);
    }
  }
  if (input.insecureTls && !input.allowLan) throw new ApiInputError("insecure_tls is only allowed together with allow_lan");

  const def: ApiServiceDef = {
    id: input.id,
    label: input.label?.trim() || handle.meta.title,
    blurb: handle.meta.description || `${handle.meta.title} (${handle.meta.operationCount} operations)`,
    specSource: input.specUrl ? { kind: "url", url: input.specUrl } : { kind: "inline" },
    ...(baseUrl ? { baseUrl } : {}),
    ...(input.baseUrlFromOwner && !baseUrl ? { baseUrlField: { label: `${input.label ?? input.id} address`, placeholder: "https://…", help: "The address the API lives at." } } : {}),
    auth,
    ...(input.allowLan ? { allowLan: true } : {}),
    ...(input.insecureTls ? { insecureTls: true } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.ratePerMin ? { ratePerMin: input.ratePerMin } : {}),
    ...(input.minIntervalMs ? { minIntervalMs: input.minIntervalMs } : {}),
    ...(input.verifyOperationId ? { verifyOperationId: input.verifyOperationId } : {}),
    ...(input.readOperationIds?.length ? { readOperationIds: input.readOperationIds } : {}),
  };
  saveApiServiceDef(def, env.home);
  saveApiServiceSpec(def.id, JSON.stringify(raw), env.home);
  dropCachedHandle(def.id);
  const connect = apiConnectService(def);
  if (connect) registerConnectService(connect);
  return { def, title: handle.meta.title, operations: handle.meta.operationCount, specVersion: `${handle.meta.flavor} ${handle.meta.version}`, suggestions, notes };
}

export function removeService(id: string, home?: string): boolean {
  if (apiPresetDef(id)) throw new ApiInputError(`"${id}" is a built-in preset; it cannot be removed`);
  const removed = removeApiServiceFiles(id, home);
  dropCachedHandle(id);
  unregisterConnectService(apiConnectId(id));
  return removed;
}

/** Register every credentialed service the owner added, so the phone lists them. */
export function syncApiConnectServices(home?: string): number {
  let n = 0;
  for (const def of listApiServiceDefs(home)) {
    const s = apiConnectService(def);
    if (s) {
      registerConnectService(s);
      n++;
    }
  }
  return n;
}

// ─── Read / write classification ─────────────────────────────────────────────

const DESTRUCTIVE_WORDS = new Set([
  "delete", "remove", "destroy", "purge", "wipe", "erase", "drop", "truncate", "revoke", "terminate", "deactivate", "disable",
  "reset", "restart", "reboot", "shutdown", "unlock", "disarm", "format", "cancel", "close", "archive",
]);
const FINANCIAL_WORDS = new Set([
  "refund", "charge", "payment", "pay", "payout", "transfer", "withdraw", "withdrawal", "deposit", "purchase", "buy", "checkout",
  "invoice", "subscription", "subscribe", "billing", "order", "wire", "tip", "donate", "donation", "trade", "swap", "transaction", "payin",
]);

export interface CallClass {
  /** read: GET/HEAD/OPTIONS or a declared read-only POST. unknown: service/operation not found (the call will fail without effect). */
  kind: "read" | "write" | "unknown";
  method?: string;
  path?: string;
  destructive: boolean;
  financial: boolean;
  reason?: string;
}

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** Home Assistant style service calls: the domain+service in the params is what decides. */
function serviceCallWords(params: Record<string, unknown> | undefined): string[] {
  if (!params) return [];
  const words: string[] = [];
  for (const key of ["domain", "service"]) if (typeof params[key] === "string") words.push(...tokenize(String(params[key])));
  return words;
}

export function classifyApiCall(serviceId: string, operationId: string, params?: Record<string, unknown>, home?: string): CallClass {
  let def: ApiServiceDef | null;
  try {
    def = resolveApiServiceDef(serviceId, home);
  } catch {
    def = null;
  }
  if (!def) return { kind: "unknown", destructive: false, financial: false };
  let op: ResolvedOperation | null = null;
  try {
    const handle = specHandleFor(def, home);
    const entry = handle.ops.find((o) => o.id === operationId);
    if (entry) op = { method: entry.method, path: entry.path, id: entry.id } as ResolvedOperation;
  } catch {
    return { kind: "unknown", destructive: false, financial: false };
  }
  if (!op) return { kind: "unknown", destructive: false, financial: false };
  const method = op.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || def.readOperationIds?.includes(op.id)) {
    return { kind: "read", method, path: op.path, destructive: false, financial: false };
  }
  const words = [...tokenize(`${op.id} ${op.path.replace(/\{[^}]*\}/g, " ")}`), ...serviceCallWords(params)].map(stem);
  const destructiveHit = words.find((w) => DESTRUCTIVE_WORDS.has(w));
  const financialHit = words.find((w) => FINANCIAL_WORDS.has(w));
  const destructive = method === "DELETE" || destructiveHit !== undefined;
  const financial = financialHit !== undefined;
  return {
    kind: "write",
    method,
    path: op.path,
    destructive,
    financial,
    ...(financial ? { reason: `looks financial ("${financialHit}")` } : destructive ? { reason: method === "DELETE" ? "a DELETE" : `looks destructive ("${destructiveHit}")` } : {}),
  };
}

// ─── One call, end to end ────────────────────────────────────────────────────

export function normalizeBaseUrl(raw: string, def: ApiServiceDef, handle: SpecHandle): string {
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) text = `${def.allowLan ? "http" : "https"}://${text}`;
  text = text.replace(/\/+$/, "");
  if (/\/api$/.test(text) && handle.ops.length && handle.ops.every((o) => o.path.startsWith("/api"))) text = text.slice(0, -4);
  return text;
}

export async function resolveBaseUrl(def: ApiServiceDef, handle: SpecHandle, creds: CredentialSource): Promise<string> {
  if (def.baseUrl) return def.baseUrl.replace(/\/+$/, "");
  const stored = await creds.get(apiCred(def.id, "BASEURL"));
  if (!stored) {
    throw new ApiInputError(
      `${def.label} has no address stored. Connect it first: call Connect with service "${apiConnectId(def.id)}" (the owner types the address into a secure form on their phone).`,
    );
  }
  return normalizeBaseUrl(stored, def, handle);
}

export interface ApiCallInput {
  service: string;
  operationId: string;
  params?: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
}

export async function apiCall(input: ApiCallInput, env: ServiceEnv = {}, opts: ExecuteOptions = {}): Promise<ApiCallResult & { operation: ResolvedOperation }> {
  const def = resolveApiServiceDef(input.service, env.home);
  if (!def) throw new ApiInputError(unknownServiceMessage(input.service, env.home));
  const handle = specHandleFor(def, env.home);
  const op = handle.operation(input.operationId);
  if (!op) throw new ApiInputError(unknownOperationMessage(def, handle, input.operationId));
  const creds = env.creds ?? vaultCredentials(env.home);
  const callEnv = { creds, ...(env.resolver ? { resolver: env.resolver } : {}), ...(env.signal ? { signal: env.signal } : {}) };
  const baseUrl = await resolveBaseUrl(def, handle, creds);
  const auth = await resolveAuth(def, callEnv);
  const built = buildRequest({ def, op, baseUrl, params: input.params ?? {}, body: input.body, contentType: input.contentType, auth });
  const result = await executeCall(def, op, built, auth, callEnv, { home: env.home, ...opts });
  return { ...result, operation: op };
}

export function unknownServiceMessage(id: string, home?: string): string {
  const all = [...API_PRESET_DEFS, ...listApiServiceDefs(home)].map((d) => d.id);
  const near = all.find((s) => s.includes(id.toLowerCase()) || id.toLowerCase().includes(s));
  return `no service "${id}". Known services: ${all.join(", ")}.${near ? ` Did you mean "${near}"?` : ""} Add your own with Api add.`;
}

export function unknownOperationMessage(def: ApiServiceDef, handle: SpecHandle, opId: string): string {
  const { hits } = searchOperations(handle.ops, opId, { limit: 3 });
  return `${def.id} has no operation "${opId}".${hits.length ? ` Closest: ${hits.map((h) => h.id).join(", ")}.` : ""} Use Api search to find the operationId.`;
}


// ─── The connect form's live check ───────────────────────────────────────────

const AUTO_VERIFY_HINT = /^(me|user|whoami|account|status|ping|health|info|self|profile|version|root|config|meta|organization|org)$/;

function pickVerifyOperation(def: ApiServiceDef, handle: SpecHandle): { id: string; explicit: boolean } | null {
  if (def.verifyOperationId && handle.has(def.verifyOperationId)) return { id: def.verifyOperationId, explicit: true };
  let best: { id: string; score: number } | null = null;
  for (const entry of handle.ops) {
    if (entry.method !== "GET" || /\{[^}]+\}/.test(entry.path)) continue;
    const op = handle.operation(entry.id);
    if (!op || op.parameters.some((p) => p.required && p.schema.default === undefined)) continue;
    const tokens = tokenize(entry.path);
    let score = 1;
    if (tokens.some((t) => AUTO_VERIFY_HINT.test(t))) score += 5;
    score -= Math.min(tokens.length, 4) * 0.2;
    if (!best || score > best.score) best = { id: entry.id, score };
  }
  return best ? { id: best.id, explicit: false } : null;
}

/** What the phone's connect form runs before it stores anything: one read-only
 *  call with the typed values. Throws with a sentence for the form when the
 *  service rejects them. */
export async function verifyApiService(serviceId: string, values: Record<string, string>, env: ServiceEnv = {}): Promise<string> {
  const def = resolveApiServiceDef(serviceId, env.home);
  if (!def) throw new Error(`unknown service ${serviceId}`);
  const handle = specHandleFor(def, env.home);
  const vault = env.creds ?? vaultCredentials(env.home);
  const typed: CredentialSource = { get: async (name) => values[name]?.trim() || (await vault.get(name)) };
  const pick = pickVerifyOperation(def, handle);
  if (!pick) return "Saved. The spec has no parameter-free read call to test it with.";
  try {
    const result = await apiCall({ service: def.id, operationId: pick.id }, { ...env, creds: typed });
    if (result.status === 401 || result.status === 403) throw new Error(`${def.label} rejected those credentials (HTTP ${result.status})`);
    if (result.status >= 500) throw new Error(`${def.label} answered HTTP ${result.status}`);
    if (!result.ok) {
      if (pick.explicit) throw new Error(`${def.label} answered HTTP ${result.status} to its check call`);
      return `Saved. ${def.label} is reachable (its check call answered HTTP ${result.status}, not an authentication failure).`;
    }
    return `${def.label} answered (${pick.id}, HTTP ${result.status}).`;
  } catch (err) {
    if (err instanceof ApiInputError) throw new Error(err.message);
    throw err;
  }
}
