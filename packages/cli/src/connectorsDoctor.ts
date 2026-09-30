// `ares connectors doctor` — prove every connector path, don't assume it.
//
// Inventory: the remote MCP catalog, the local stdio catalog, servers the
// owner configured, the connect-hub services (OAuth-app, API-key, browser
// sign-in), the keyless upstreams the built-in tools depend on, the channel
// and remote-PC connectors, and the built-in tools themselves (each inherits
// the verdict of what it stands on).
//
// Every check is a REAL probe with a deadline:
//   mcp-remote     initialize + tools/list over HTTP, or the SSE stream; a 401
//                  with OAuth metadata counts as alive (credential gate)
//   mcp-stdio      spawn the exact command in an isolated scratch env, run the
//                  MCP handshake, count tools
//   api-key        the hub's own verifier, fed a fake credential: a typed
//                  "doesn't recognise that key" proves the endpoint is alive
//                  and the gate is correct
//   oauth-app      token + authorize endpoints answer a bogus request the way
//                  a live OAuth server does
//   upstreams      the same URL the tool calls, validated for shape
//
// Verdicts: working | works-needs-credentials | degraded | broken |
// unverifiable. Evidence (command, status, latency, first error line) rides in
// the JSON; everything passes through secret scrubbing before it leaves here.
// The harness bounds parallelism per lane, gives every check a hard deadline
// and always cleans up its scratch directory and child processes.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CONNECT_SERVICES,
  MCP_CATALOG,
  MCP_STDIO_CATALOG,
  OAUTH_PROVIDERS,
  binaryOnPath,
  getMcpCallCredentials,
  getCredential,
  renderStdioArgs,
  renderStaticEnv,
  type ConnectService,
  type McpCatalogEntry,
  type McpStdioEntry,
} from "@ares/core";
import { listMcpServers, duckDuckGoImages, type McpServerConfig } from "@ares/tools";
import { findInstalledChromium } from "@ares/connectors";
import { DEFAULT_VERIFIERS } from "./connectHub.js";
import { DEVICE_CONNECTOR_VERSION, buildDeviceConnectorPs1 } from "./remoteDeviceConnector.js";
import { buildPowerShellAgent, buildPythonAgent } from "./remoteAgentServer.js";
import {
  probeRemoteMcp,
  probeStdioServer,
  scrubSecrets,
  type RemoteProbeResult,
  type StdioProbeResult,
} from "./mcpProbe.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Verdict = "working" | "works-needs-credentials" | "degraded" | "broken" | "unverifiable";

export type InventoryKind =
  | "mcp-remote"
  | "mcp-stdio"
  | "mcp-configured"
  | "oauth-app"
  | "api-key"
  | "browser-session"
  | "upstream"
  | "channel"
  | "remote-pc"
  | "runtime"
  | "tool";

export type FreeLabel = "free" | "free-tier" | "needs-account" | "metered" | "paid" | "n/a";

export interface InventoryEntry {
  id: string;
  name: string;
  kind: InventoryKind;
  /** Where the entry is defined (file or registry). */
  source: string;
  /** How it is launched / reached. */
  launch: { transport: string; command?: string; args?: string[]; url?: string };
  /** How it authenticates. */
  auth: "none" | "oauth" | "api-key" | "owner-app" | "browser-login" | "pairing" | "mixed";
  needsCredentials: boolean;
  free: FreeLabel;
  /** Names of the credentials it collects (never values). */
  credentialFields?: string[];
  /** For kind "tool": the ids whose verdict it stands on. */
  dependsOn?: string[];
  dependsMode?: "all" | "any";
}

export interface CheckEvidence {
  command?: string;
  url?: string;
  status?: number;
  latencyMs?: number;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  protocolVersion?: string;
  framing?: string;
  initializeMs?: number;
  firstError?: string;
  stderrTail?: string;
  stdoutNoiseLines?: number;
  oauth?: unknown;
  wwwAuthenticate?: string;
  note?: string;
  [k: string]: unknown;
}

export interface CheckResult extends InventoryEntry {
  verdict: Verdict;
  reason: string;
  evidence: CheckEvidence;
  durationMs: number;
}

export interface DoctorReport {
  schema: "ares.connectors.doctor/1";
  generatedAt: string;
  offline: boolean;
  host: { platform: string; node: string; runtimes: Record<string, boolean> };
  totals: { total: number; byVerdict: Record<Verdict, number>; byKind: Record<string, Record<Verdict, number>> };
  results: CheckResult[];
}

export interface DoctorOptions {
  only?: string[];
  kinds?: InventoryKind[];
  offline?: boolean;
  /** Per-check deadline for network checks (ms). */
  timeoutMs?: number;
  /** Per-check deadline for stdio launches (ms) — cold npx downloads are slow. */
  stdioTimeoutMs?: number;
  concurrency?: number;
  stdioConcurrency?: number;
  home?: string;
  /** Include servers the owner already configured (default true). */
  includeConfigured?: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Where scratch dirs live (default os.tmpdir()). */
  scratchParent?: string;
  /** Test seam: replace the catalogs. */
  catalogs?: { remote?: McpCatalogEntry[]; stdio?: McpStdioEntry[]; services?: ConnectService[] };
  /** Progress callback (CLI). */
  onResult?: (r: CheckResult) => void;
}

const EMPTY_VERDICTS = (): Record<Verdict, number> => ({ working: 0, "works-needs-credentials": 0, degraded: 0, broken: 0, unverifiable: 0 });
const VERDICT_RANK: Record<Verdict, number> = { working: 0, "works-needs-credentials": 1, unverifiable: 2, degraded: 3, broken: 4 };

// ─── Classification (pure, unit-tested) ──────────────────────────────────────

const RE_NOT_FOUND = /E404|404 Not Found|is not in (?:this|the) registry|No matching version found|could not be found on PyPI|No solution found when resolving|not found in the package registry|package .{1,80} (?:was )?not found|Failed to (?:fetch|download).*404/i;
const RE_NODE_VERSION = /Unsupported engine|engine "node"|requires (?:a )?node|ERR_REQUIRE_ESM|Node\.js v\d+.* (?:not supported|required)|SyntaxError: Unexpected (?:token|identifier)|is not a function.*node:/i;
const RE_MODULE = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ModuleNotFoundError|No module named/i;
const RE_PROMPT = /\(y\/n\)|\[y\/N\]|press enter|ok to proceed\?|are you sure|enter (?:your|a) /i;
const RE_CRED = /(missing|required|not set|not provided|must (?:be set|provide|supply)|please (?:set|provide|export)|no .{0,30}(?:found|provided|supplied)|unauthori[sz]ed|invalid.{0,20}(?:token|key|credential)|authenticat|api[_ -]?key|access[_ -]?token|credential|password|environment variable|env(?:ironment)? var)/i;
const RE_MUST_ARG = /(?:usage:|expected|provide (?:at least )?one|specify|must specify|requires? (?:a |an |the )?(?:dir|path|arg|url|repo|database))/i;

function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errLine = lines.find((l) => /error|fatal|failed|cannot|not found|missing|required|exception|invalid/i.test(l));
  return (errLine ?? lines[lines.length - 1] ?? "").slice(0, 300);
}

export interface StdioClassifyContext {
  /** Does this server need a secret to do real work? */
  needsCredentials: boolean;
  /** Did the harness inject placeholder credentials? */
  injectedPlaceholders?: boolean;
  timeoutMs: number;
}

export function classifyStdioProbe(p: StdioProbeResult, ctx: StdioClassifyContext): { verdict: Verdict; reason: string } {
  if (p.ok) {
    if ((p.toolCount ?? 0) === 0) return { verdict: "degraded", reason: "launches and answers initialize, but tools/list is empty" };
    const noise = p.stdoutNoiseLines ? ` (tolerated ${p.stdoutNoiseLines} non-protocol stdout lines)` : "";
    return ctx.needsCredentials
      ? { verdict: "works-needs-credentials", reason: `launches and lists ${p.toolCount} tools; real calls need the owner's credential${noise}` }
      : { verdict: "working", reason: `handshake ok, ${p.toolCount} tools in ${p.latencyMs}ms${noise}` };
  }
  const blob = `${p.error ?? ""}\n${p.stderrTail}`;
  const line = firstErrorLine(p.stderrTail) || firstErrorLine(p.error ?? "");
  if (p.failure === "spawn-error") return { verdict: "broken", reason: p.error ?? "could not spawn" };
  if (RE_NOT_FOUND.test(blob)) return { verdict: "broken", reason: `package not found in its registry (renamed or removed): ${line}` };
  if (RE_NODE_VERSION.test(blob)) return { verdict: "broken", reason: `runtime/version incompatibility: ${line}` };
  if (RE_MODULE.test(blob)) return { verdict: "broken", reason: `broken package (missing module): ${line}` };
  if (ctx.needsCredentials && p.failure !== "timeout" && p.failure !== "no-response" && RE_CRED.test(blob)) {
    return { verdict: "works-needs-credentials", reason: `starts and refuses without a valid credential (clear error): ${line}` };
  }
  if (p.failure === "timeout" || p.failure === "no-response") {
    if (RE_PROMPT.test(blob)) return { verdict: "broken", reason: `blocks on an interactive prompt: ${line}` };
    return { verdict: "broken", reason: `no handshake within ${Math.round(ctx.timeoutMs / 1000)}s (hangs or waits on stdin)${line ? `: ${line}` : ""}` };
  }
  if (ctx.needsCredentials && RE_MUST_ARG.test(blob) === false && p.failure === "exited" && /token|key|auth/i.test(blob)) {
    return { verdict: "works-needs-credentials", reason: `exits asking for credentials: ${line}` };
  }
  return { verdict: "broken", reason: `${p.failure === "exited" ? `crashes at startup (exit ${p.exitCode ?? p.exitSignal})` : p.failure ?? "failed"}: ${line || p.error || "no output"}` };
}

export interface RemoteClassifyContext {
  auth: "none" | "oauth" | "key";
}

export function classifyRemoteProbe(p: RemoteProbeResult, ctx: RemoteClassifyContext): { verdict: Verdict; reason: string } {
  switch (p.kind) {
    case "ok":
      return { verdict: ctx.auth === "none" ? "working" : "working", reason: `answers without credentials: ${p.toolCount} tools in ${p.latencyMs}ms${ctx.auth !== "none" ? " (catalog says auth — verify the label)" : ""}` };
    case "sse-open":
      return { verdict: ctx.auth === "none" ? "working" : "works-needs-credentials", reason: `legacy SSE stream opens (${p.latencyMs}ms)` };
    case "auth-required": {
      if (ctx.auth === "none") return { verdict: "broken", reason: `catalog says no auth but the server answered HTTP ${p.status}; it now demands credentials` };
      const o = p.oauth;
      if (ctx.auth === "oauth") {
        if (o && !o.resourceMetadata && !p.wwwAuthenticate) return { verdict: "degraded", reason: `HTTP ${p.status} but no OAuth discovery (no WWW-Authenticate, no protected-resource metadata)` };
        if (o && o.authorizationServer && o.registrationEndpoint === false) return { verdict: "degraded", reason: "OAuth server has no dynamic client registration; one-tap connect will fall back to a pasted token" };
        return { verdict: "works-needs-credentials", reason: `alive: HTTP ${p.status}${o?.resourceMetadata ? ", OAuth metadata resolves" : ""}${o?.registrationEndpoint ? ", dynamic registration available" : ""}` };
      }
      return { verdict: "works-needs-credentials", reason: `alive: HTTP ${p.status}, key required` };
    }
    case "not-found":
      return { verdict: "broken", reason: `endpoint gone: HTTP ${p.status} (moved or retired)` };
    case "server-error":
      return { verdict: "degraded", reason: `upstream error HTTP ${p.status}` };
    case "network":
      return { verdict: "broken", reason: `unreachable: ${p.error}` };
    case "timeout":
      return { verdict: "degraded", reason: `no answer within the deadline (${p.error ?? "timeout"})` };
    case "protocol":
      return { verdict: "degraded", reason: `answers but is not a working MCP endpoint: ${p.error ?? `HTTP ${p.status}`}` };
  }
}

export interface HttpProbe {
  status?: number;
  ms: number;
  text: string;
  error?: string;
  errKind?: "network" | "timeout";
  contentType?: string;
}

/** Map a verifier's thrown message to a verdict (fake credential was used). */
export function classifyVerifierError(message: string): { verdict: Verdict; reason: string } {
  const m = message;
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|getaddrinfo|network|timed out|timeout|aborted|certificate|TLS/i.test(m)) return { verdict: "broken", reason: `endpoint unreachable: ${m.slice(0, 200)}` };
  if (/HTTP (?:404|410)\b/.test(m)) return { verdict: "broken", reason: `endpoint gone: ${m.slice(0, 200)}` };
  if (/HTTP 5\d\d\b/.test(m)) return { verdict: "degraded", reason: `upstream error: ${m.slice(0, 200)}` };
  if (/recogni[sz]e|accept|don't match|do not match|invalid|rejected|unauthori[sz]ed|starts with|can't use|not valid|setup token|access url|must be/i.test(m)) {
    return { verdict: "works-needs-credentials", reason: `endpoint alive; credential gate correct ("${m.slice(0, 140)}")` };
  }
  if (/HTTP 4\d\d\b/.test(m)) return { verdict: "works-needs-credentials", reason: `endpoint alive; rejected the fake credential (${m.slice(0, 120)})` };
  return { verdict: "degraded", reason: `verifier failed in an unclassified way: ${m.slice(0, 200)}` };
}

/** Worst verdict wins (used for "all"); best for "any". */
export function combineVerdicts(verdicts: Verdict[], mode: "all" | "any"): Verdict {
  if (verdicts.length === 0) return "unverifiable";
  const sorted = [...verdicts].sort((a, b) => VERDICT_RANK[a] - VERDICT_RANK[b]);
  return mode === "any" ? sorted[0]! : sorted[sorted.length - 1]!;
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function httpProbe(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; fetchImpl?: DoctorOptions["fetchImpl"]; redirect?: RequestRedirect; retry?: boolean },
): Promise<HttpProbe> {
  const f = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const attempt = async (): Promise<HttpProbe> => {
    const t0 = Date.now();
    try {
      const res = await f(url, {
        method: opts.method ?? "GET",
        headers: { "user-agent": "ares-connectors-doctor/1 (+https://doingteam.com)", accept: "*/*", ...(opts.headers ?? {}) },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        redirect: opts.redirect ?? "follow",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = (await res.text().catch(() => "")).slice(0, 4_000_000);
      return { status: res.status, ms: Date.now() - t0, text, contentType: res.headers.get("content-type") ?? "" };
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string };
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      const code = e?.cause?.code;
      return { ms: Date.now() - t0, text: "", errKind: timeout ? "timeout" : "network", error: timeout ? "timed out" : code ? `${code}${e.cause?.message ? `: ${e.cause.message}` : ""}` : (e?.message ?? String(err)) };
    }
  };
  let r = await attempt();
  // One retry for the failures that are often transient.
  if (opts.retry !== false && (r.errKind || (r.status !== undefined && (r.status >= 500 || r.status === 429)))) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await attempt();
  }
  return r;
}

function asJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ─── Inventory ───────────────────────────────────────────────────────────────

/** Honest cost labels for the services whose cost is not "just an account". */
const SERVICE_COST: Record<string, FreeLabel> = {
  twilio: "paid",
  "stripe-key": "free-tier",
  resend: "free-tier",
  openai: "paid",
  gemini: "free-tier",
  "google-places": "free-tier",
  google: "free",
  outlook: "free",
  spotify: "free",
  tessie: "paid",
  ticketmaster: "free",
  flightaware: "metered",
  duffel: "metered",
  withings: "free",
  tailscale: "free",
  plaid: "free-tier",
  simplefin: "paid",
  zapier: "free-tier",
  firecrawl: "free-tier",
  exa: "free-tier",
  tavily: "free-tier",
  perplexity: "paid",
  render: "free-tier",
};

const MCP_REMOTE_PAID = new Set(["perplexity"]);

function remoteEntry(e: McpCatalogEntry): InventoryEntry {
  return {
    id: e.id,
    name: e.name,
    kind: "mcp-remote",
    source: "core/mcpCatalog.ts",
    launch: { transport: e.transport === "auto" ? "http" : e.transport, url: e.url },
    auth: e.auth === "oauth" ? "oauth" : e.auth === "key" ? "api-key" : "none",
    needsCredentials: e.auth !== "none",
    free: e.auth === "none" ? "free" : (SERVICE_COST[e.id] ?? (MCP_REMOTE_PAID.has(e.id) ? "paid" : "needs-account")),
  };
}

function stdioEntry(e: McpStdioEntry): InventoryEntry {
  return {
    id: `stdio:${e.id}`,
    name: e.name,
    kind: "mcp-stdio",
    source: "core/mcpStdioCatalog.ts",
    launch: { transport: "stdio", command: e.command, args: e.args },
    auth: e.cost === "free" ? "none" : "api-key",
    needsCredentials: e.cost !== "free",
    free: e.cost,
    credentialFields: (e.fields ?? []).map((f) => ("env" in f.target ? f.target.env : `arg:${f.target.arg}`)),
  };
}

function serviceEntry(s: ConnectService): InventoryEntry | null {
  if (s.kind === "mcp-oauth" || s.kind === "mcp-key") return null; // covered by the MCP catalog
  if (MCP_STDIO_CATALOG.some((e) => e.id === s.id)) return null; // covered by the stdio catalog
  const kind: InventoryKind = s.kind === "oauth-app" ? "oauth-app" : s.kind === "browser" ? "browser-session" : "api-key";
  return {
    id: s.id,
    name: s.label,
    kind,
    source: s.id.startsWith("site:") ? "adhoc" : "core/connectServices.ts",
    launch: { transport: kind === "oauth-app" ? "oauth2" : kind === "browser-session" ? "live-browser" : "https-api", ...(s.loginUrl ? { url: s.loginUrl } : s.mcpUrl ? { url: s.mcpUrl } : {}) },
    auth: kind === "oauth-app" ? "owner-app" : kind === "browser-session" ? "browser-login" : s.id === "hue" ? "pairing" : "api-key",
    needsCredentials: true,
    free: SERVICE_COST[s.id] ?? (kind === "browser-session" ? "needs-account" : "needs-account"),
    credentialFields: (s.fields ?? []).map((f) => f.credential),
  };
}

interface UpstreamSpec {
  id: string;
  name: string;
  url: string;
  free: FreeLabel;
  auth: "none" | "api-key";
  run(ctx: { timeoutMs: number; fetchImpl?: DoctorOptions["fetchImpl"] }): Promise<{ verdict: Verdict; reason: string; evidence: CheckEvidence }>;
}

function liveness(
  id: string,
  name: string,
  url: string,
  o: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    free: FreeLabel;
    auth: "none" | "api-key";
    /** keyless: validate the body for `working`; credentialed: statuses that prove the gate */
    validate?: (p: HttpProbe) => string | null;
    aliveStatuses?: number[];
  },
): UpstreamSpec {
  return {
    id,
    name,
    url,
    free: o.free,
    auth: o.auth,
    async run(ctx) {
      const p = await httpProbe(url, { method: o.method, headers: o.headers, body: o.body, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
      const ev: CheckEvidence = { url, status: p.status, latencyMs: p.ms };
      if (p.error) return { verdict: p.errKind === "timeout" ? "degraded" : "broken", reason: p.errKind === "timeout" ? "timed out twice" : `unreachable: ${p.error}`, evidence: { ...ev, firstError: p.error } };
      if (p.status === 404 || p.status === 410) return { verdict: "broken", reason: `endpoint gone: HTTP ${p.status}`, evidence: { ...ev, firstError: `HTTP ${p.status}` } };
      if (p.status! >= 500) return { verdict: "degraded", reason: `upstream error HTTP ${p.status}`, evidence: { ...ev, firstError: `HTTP ${p.status}` } };
      if (p.status === 429) return { verdict: "degraded", reason: "rate-limited (HTTP 429) — alive but throttled", evidence: ev };
      if (o.auth === "api-key") {
        const alive = o.aliveStatuses ? o.aliveStatuses.includes(p.status!) : p.status! >= 400 && p.status! < 500;
        if (alive) return { verdict: "works-needs-credentials", reason: `alive: HTTP ${p.status} to a fake credential`, evidence: ev };
        if (p.status! < 400) return { verdict: "degraded", reason: `accepted a request with no credential (HTTP ${p.status})`, evidence: ev };
        return { verdict: "degraded", reason: `unexpected HTTP ${p.status}`, evidence: { ...ev, firstError: p.text.slice(0, 160) } };
      }
      const why = o.validate ? o.validate(p) : p.status! < 400 ? null : `HTTP ${p.status}`;
      if (why) return { verdict: p.status! < 400 ? "degraded" : "broken", reason: `answers but ${why}`, evidence: { ...ev, firstError: p.text.slice(0, 160) } };
      return { verdict: "working", reason: `HTTP ${p.status} in ${p.ms}ms, response shape valid`, evidence: ev };
    },
  };
}

function upstreamSpecs(): UpstreamSpec[] {
  return [
    liveness("upstream:wttr", "wttr.in weather (Weather tool)", "https://wttr.in/London?format=j1", {
      free: "free",
      auth: "none",
      headers: { accept: "application/json", "user-agent": "Ares/0.3" },
      validate: (p) => ((asJson(p.text) as { current_condition?: unknown[] } | undefined)?.current_condition ? null : "no current_condition in the JSON"),
    }),
    liveness("upstream:nominatim", "OpenStreetMap Nominatim (Places tool)", "https://nominatim.openstreetmap.org/search?q=London&format=json&limit=1", {
      free: "free",
      auth: "none",
      headers: { "user-agent": "Ares/1.0 (doingbox)" },
      validate: (p) => (Array.isArray(asJson(p.text)) && (asJson(p.text) as unknown[]).length > 0 ? null : "empty or non-JSON result"),
    }),
    liveness("upstream:overpass", "Overpass API (Places tool)", "https://overpass-api.de/api/interpreter", {
      free: "free",
      auth: "none",
      // POST, exactly as Places.ts calls it (GET is rate-limited harder).
      method: "POST",
      headers: { "user-agent": "Ares/1.0 (doingbox)", "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ data: "[out:json][timeout:10];node(1);out;" }).toString(),
      validate: (p) => ((asJson(p.text) as { elements?: unknown } | undefined)?.elements !== undefined ? null : "no elements[] in the JSON"),
    }),
    liveness("upstream:ddg-html", "DuckDuckGo HTML search (WebSearch fallback)", "https://html.duckduckgo.com/html/?q=ares+agent", {
      free: "free",
      auth: "none",
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html" },
      validate: (p) => (/result__a|result__snippet|class="result/.test(p.text) ? null : /anomaly|captcha|bot/i.test(p.text) ? "served a bot challenge instead of results" : "no results markup"),
    }),
    {
      id: "upstream:ddg-images",
      name: "DuckDuckGo images (ImageSearch tool)",
      url: "https://duckduckgo.com/i.js",
      free: "free",
      auth: "none",
      async run(ctx) {
        const t0 = Date.now();
        try {
          const r = await duckDuckGoImages("cat", AbortSignal.timeout(ctx.timeoutMs));
          return r.length > 0
            ? { verdict: "working", reason: `${r.length} image results via the tool's own code path`, evidence: { latencyMs: Date.now() - t0, toolCount: r.length } }
            : { verdict: "degraded", reason: "tool code ran but returned no images", evidence: { latencyMs: Date.now() - t0 } };
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          return { verdict: /vqd|returned (?:403|418|429)/.test(m) ? "degraded" : "broken", reason: `DDG image scrape failed: ${m.slice(0, 200)}`, evidence: { latencyMs: Date.now() - t0, firstError: m.slice(0, 200) } };
        }
      },
    },
    liveness("upstream:hue-discovery", "Hue bridge discovery service", "https://discovery.meethue.com/", {
      free: "free",
      auth: "none",
      validate: (p) => (Array.isArray(asJson(p.text)) ? null : "not a JSON array"),
    }),
    liveness("channel:telegram", "Telegram Bot API", "https://api.telegram.org/bot000000000:doctor-invalid-token/getMe", {
      free: "free",
      auth: "api-key",
      aliveStatuses: [401, 404],
    }),
    liveness("upstream:plaid", "Plaid API (Bank tool)", "https://production.plaid.com/institutions/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "doctor", secret: "doctor", count: 1, offset: 0, country_codes: ["US"] }),
      free: "free-tier",
      auth: "api-key",
      aliveStatuses: [400, 401],
    }),
    liveness("upstream:brave", "Brave Search API (WebSearch/ImageSearch key path)", "https://api.search.brave.com/res/v1/web/search?q=test", {
      headers: { accept: "application/json", "x-subscription-token": "doctor-invalid-key" },
      free: "free-tier",
      auth: "api-key",
      aliveStatuses: [401, 403, 422],
    }),
    liveness("upstream:tavily", "Tavily Search API (WebSearch key path)", "https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer doctor-invalid-key" },
      body: JSON.stringify({ query: "test" }),
      free: "free-tier",
      auth: "api-key",
      aliveStatuses: [400, 401, 403, 422],
    }),
    liveness("upstream:openrouter", "OpenRouter (Imagine fallback)", "https://openrouter.ai/api/v1/models", {
      free: "free",
      auth: "none",
      headers: { accept: "application/json" },
      validate: (p) => (Array.isArray((asJson(p.text) as { data?: unknown } | undefined)?.data) ? null : "no data[] in the JSON"),
    }),
  ];
}

// ─── Tool inventory (each tool stands on upstream checks) ────────────────────

interface ToolSpec {
  name: string;
  file: string;
  dependsOn: string[];
  mode?: "all" | "any";
  free: FreeLabel;
  auth: InventoryEntry["auth"];
}

const TOOLS: ToolSpec[] = [
  { name: "Gmail", file: "Gmail.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleCalendar", file: "GoogleCalendar.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleDrive", file: "GoogleDrive.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleDocs", file: "GoogleDocs.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleSheets", file: "GoogleSheets.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleSlides", file: "GoogleSlides.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleForms", file: "GoogleForms.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleTasks", file: "GoogleTasks.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "GoogleContacts", file: "GoogleContacts.ts", dependsOn: ["google"], free: "free", auth: "owner-app" },
  { name: "Outlook", file: "Outlook.ts", dependsOn: ["outlook"], free: "free", auth: "owner-app" },
  { name: "Spotify", file: "Spotify.ts", dependsOn: ["spotify"], free: "free", auth: "owner-app" },
  { name: "Hue", file: "Hue.ts", dependsOn: ["hue", "upstream:hue-discovery"], free: "free", auth: "pairing" },
  { name: "Tesla", file: "Tesla.ts", dependsOn: ["tessie"], free: "paid", auth: "api-key" },
  { name: "Tickets", file: "Tickets.ts", dependsOn: ["ticketmaster"], free: "free", auth: "api-key" },
  { name: "FlightStatus", file: "FlightStatus.ts", dependsOn: ["flightaware"], free: "metered", auth: "api-key" },
  { name: "FlightBooking", file: "FlightBooking.ts", dependsOn: ["duffel"], free: "metered", auth: "api-key" },
  { name: "Withings", file: "Withings.ts", dependsOn: ["withings"], free: "free", auth: "owner-app" },
  { name: "Tailscale", file: "Tailscale.ts", dependsOn: ["tailscale"], free: "free", auth: "api-key" },
  { name: "Bank", file: "Bank.ts", dependsOn: ["upstream:plaid", "simplefin"], mode: "any", free: "free-tier", auth: "mixed" },
  { name: "Weather", file: "Weather.ts", dependsOn: ["upstream:wttr"], free: "free", auth: "none" },
  { name: "Places", file: "Places.ts", dependsOn: ["upstream:nominatim", "upstream:overpass"], free: "free", auth: "none" },
  { name: "Imagine", file: "Imagine.ts", dependsOn: ["openai", "gemini", "upstream:openrouter"], mode: "any", free: "free-tier", auth: "api-key" },
  { name: "Stripe", file: "Stripe.ts", dependsOn: ["stripe-key"], free: "free-tier", auth: "api-key" },
  { name: "Email", file: "Email.ts", dependsOn: ["resend"], free: "free-tier", auth: "api-key" },
  { name: "Phone", file: "Phone.ts", dependsOn: ["twilio"], free: "paid", auth: "api-key" },
  { name: "Deploy", file: "Deploy.ts", dependsOn: ["runtime:node-npx"], free: "free-tier", auth: "api-key" },
  { name: "Telegram", file: "Telegram.ts", dependsOn: ["channel:telegram"], free: "free", auth: "api-key" },
  { name: "RemotePC", file: "RemotePC.ts", dependsOn: ["remote-pc:windows", "remote-pc:unix"], mode: "any", free: "free", auth: "pairing" },
  { name: "ImageSearch", file: "ImageSearch.ts", dependsOn: ["upstream:ddg-images", "upstream:brave"], mode: "any", free: "free", auth: "none" },
  { name: "WebSearch", file: "WebSearch.ts", dependsOn: ["upstream:ddg-html", "upstream:brave", "upstream:tavily"], mode: "any", free: "free", auth: "none" },
];


// ─── Catalog lint (pure) ─────────────────────────────────────────────────────

/** Static sanity checks over the catalogs. Returns human-readable problems. */
export function lintCatalogs(c: { remote: McpCatalogEntry[]; stdio: McpStdioEntry[]; services: ConnectService[] } = { remote: MCP_CATALOG, stdio: MCP_STDIO_CATALOG, services: CONNECT_SERVICES }): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const s of c.services) {
    if (seen.has(s.id)) problems.push(`duplicate connect-service id "${s.id}" (${seen.get(s.id)} and ${s.kind})`);
    seen.set(s.id, s.kind);
    if (!s.label || !s.blurb || !s.howToUse) problems.push(`service "${s.id}" is missing label/blurb/howToUse`);
    if (!s.keywords.length && s.kind !== "browser") problems.push(`service "${s.id}" has no keywords (the agent cannot resolve it)`);
  }
  for (const e of c.remote) {
    try {
      const u = new URL(e.url);
      if (u.protocol !== "https:") problems.push(`remote "${e.id}" is not https`);
    } catch {
      problems.push(`remote "${e.id}" has an invalid url`);
    }
    if (e.auth === "key" && !e.keyUrl) problems.push(`remote "${e.id}" needs a key but has no keyUrl`);
    if (!e.keywords.length) problems.push(`remote "${e.id}" has no keywords`);
  }
  for (const e of c.stdio) {
    const names = new Set<string>();
    for (const f of e.fields ?? []) {
      if (names.has(f.name)) problems.push(`stdio "${e.id}" repeats field "${f.name}"`);
      names.add(f.name);
      if ("env" in f.target && !/^[A-Z][A-Z0-9_]*$/.test(f.target.env)) problems.push(`stdio "${e.id}" env name "${f.target.env}" is not UPPER_SNAKE`);
      if (!f.probe) problems.push(`stdio "${e.id}" field "${f.name}" has no probe value for the doctor`);
    }
    for (const a of e.args) {
      const m = /^\{([a-z0-9-]+)\}$/i.exec(a);
      if (m && m[1] !== "scratch" && !(e.fields ?? []).some((f) => "arg" in f.target && f.target.arg === m[1])) problems.push(`stdio "${e.id}" arg {${m[1]}} has no matching field`);
    }
    for (const f of e.fields ?? []) {
      if ("arg" in f.target && !e.args.includes(`{${f.target.arg}}`)) problems.push(`stdio "${e.id}" field "${f.name}" targets arg {${f.target.arg}} that the args never use`);
    }
    if (e.cost !== "free" && !e.docs && !e.keyUrl) problems.push(`stdio "${e.id}" is not free but names no docs/keyUrl`);
    if (e.runtime !== "docker" && e.runtime !== e.command && !(e.runtime === "npx" && e.command === "npx")) problems.push(`stdio "${e.id}" runtime ${e.runtime} does not match command ${e.command}`);
  }
  return problems;
}

// ─── Planning ────────────────────────────────────────────────────────────────

type Lane = "net" | "stdio" | "local";

interface Planned {
  entry: InventoryEntry;
  lane: Lane;
  /** Does it need the network (skipped under --offline)? */
  network: boolean;
  run(ctx: RunCtx): Promise<{ verdict: Verdict; reason: string; evidence: CheckEvidence }>;
}

interface RunCtx {
  timeoutMs: number;
  stdioTimeoutMs: number;
  scratchRoot: string;
  home: string;
  fetchImpl?: DoctorOptions["fetchImpl"];
  secrets: Set<string>;
}

const PLACEHOLDER_CRED = "doctor-invalid-credential-0000000000";
const FAKE_BY_CREDENTIAL: Record<string, string> = {
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TAILSCALE_API_KEY: "tskey-api-doctorinvalid-0000000000",
  DUFFEL_ACCESS_TOKEN: "duffel_test_doctor_invalid_0000000000",
  STRIPE_SECRET_KEY: "sk_test_doctorinvalid0000000000",
  OPENAI_API_KEY: "sk-doctor-invalid-0000000000000000",
  SIMPLEFIN_SETUP_TOKEN: Buffer.from("https://beta-bridge.simplefin.org/simplefin/claim/doctor-invalid").toString("base64"),
};

function scratchFor(ctx: RunCtx, id: string): Promise<string> {
  return fs.mkdtemp(path.join(ctx.scratchRoot, `${id.replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}-`));
}

function renderProbeValue(template: string, scratch: string): string {
  return template.replace(/\{scratch\}/g, scratch);
}

async function planStdioCatalog(e: McpStdioEntry): Promise<Planned> {
  const inv = stdioEntry(e);
  return {
    entry: inv,
    lane: "stdio",
    network: true,
    async run(ctx) {
      if (!binaryOnPath(e.command)) {
        return { verdict: "unverifiable", reason: `runtime "${e.command}" is not installed on this host, so it cannot be launched here (the hub hides this entry on such hosts)`, evidence: { command: `${e.command} ${e.args.join(" ")}`, note: "runtime-missing" } };
      }
      const scratch = await scratchFor(ctx, e.id);
      try {
        // Materialise probe values: dirs/files the server insists on.
        const argValues: Record<string, string> = {};
        const env: Record<string, string> = renderStaticEnv(e, { aresHome: scratch, scratch });
        if (Object.keys(env).length) await fs.mkdir(path.join(scratch, "mcp-data"), { recursive: true });
        const injected: string[] = [];
        for (const f of e.fields ?? []) {
          const v = renderProbeValue(f.probe, scratch);
          if ("arg" in f.target) {
            argValues[f.target.arg] = v;
            if (!f.secret && /files|vault|repo|\.db$/.test(v)) {
              if (e.id === "git") {
                await fs.mkdir(v, { recursive: true });
                await runQuiet("git", ["init", "-q"], v);
              } else if (!v.endsWith(".db")) await fs.mkdir(v, { recursive: true });
            }
          } else {
            env[f.target.env] = v;
            if (f.secret) injected.push(v);
          }
        }
        const args = renderStdioArgs(e, argValues, scratch);
        const timeoutMs = Math.max(ctx.stdioTimeoutMs, e.coldStartMs ?? 0);
        const probe = await probeStdioServer({ command: e.command, args, env }, {
          scratchDir: scratch,
          timeoutMs,
          secrets: [...injected, ...ctx.secrets],
          inheritEnv: ["npm_config_cache", "UV_CACHE_DIR", "PIP_CACHE_DIR", "DOCKER_HOST", "PLAYWRIGHT_BROWSERS_PATH"],
        });
        const needsCred = inv.needsCredentials;
        const { verdict, reason } = classifyStdioProbe(probe, { needsCredentials: needsCred, injectedPlaceholders: injected.length > 0, timeoutMs });
        return { verdict, reason, evidence: stdioEvidence(e.command, args, probe, injected) };
      } finally {
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function stdioEvidence(command: string, args: string[], p: StdioProbeResult, redact: string[]): CheckEvidence {
  return {
    command: scrubSecrets(`${command} ${args.join(" ")}`, redact),
    latencyMs: p.latencyMs,
    initializeMs: p.initializeMs,
    toolCount: p.toolCount,
    toolNames: p.toolNames?.slice(0, 40),
    serverName: p.serverName,
    protocolVersion: p.protocolVersion,
    framing: p.framing,
    stdoutNoiseLines: p.stdoutNoiseLines,
    ...(p.ok ? {} : { firstError: firstErrorLine(`${p.stderrTail}\n${p.error ?? ""}`), stage: p.stage, failure: p.failure, exitCode: p.exitCode }),
    ...(p.ok ? {} : { stderrTail: p.stderrTail.slice(-600) }),
  };
}

function runQuiet(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, stdio: "ignore" });
    c.on("error", () => resolve());
    c.on("close", () => resolve());
  });
}

function planRemoteCatalog(e: McpCatalogEntry): Planned {
  return {
    entry: remoteEntry(e),
    lane: "net",
    network: true,
    async run(ctx) {
      let p = await probeRemoteMcp(e.url, { transport: e.transport, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
      if (p.kind === "timeout" || p.kind === "network" || p.kind === "server-error") {
        await new Promise((r) => setTimeout(r, 1500));
        p = await probeRemoteMcp(e.url, { transport: e.transport, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
      }
      const c = classifyRemoteProbe(p, { auth: e.auth });
      return {
        ...c,
        evidence: {
          url: e.url,
          status: p.status,
          latencyMs: p.latencyMs,
          toolCount: p.toolCount,
          serverName: p.serverName,
          wwwAuthenticate: p.wwwAuthenticate,
          oauth: p.oauth,
          transport: e.transport,
          probe: p.kind,
          ...(p.error ? { firstError: p.error } : {}),
        },
      };
    },
  };
}

function planService(s: ConnectService): Planned | null {
  const inv = serviceEntry(s);
  if (!inv) return null;
  if (s.kind === "oauth-app") {
    const provider = s.oauthProvider ? OAUTH_PROVIDERS[s.oauthProvider] : undefined;
    return {
      entry: { ...inv, launch: { ...inv.launch, url: provider?.tokenUrl } },
      lane: "net",
      network: true,
      async run(ctx) {
        if (!provider) return { verdict: "broken", reason: `no OAuth provider "${s.oauthProvider}" registered for ${s.id}`, evidence: {} };
        const tok = await httpProbe(provider.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "authorization_code", code: "doctor-invalid", client_id: "doctor-invalid", client_secret: "doctor-invalid", redirect_uri: "http://127.0.0.1/cb" }).toString(),
          timeoutMs: ctx.timeoutMs,
          fetchImpl: ctx.fetchImpl,
        });
        const auth = await httpProbe(provider.authorizeUrl, { method: "GET", redirect: "manual", timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
        const ev: CheckEvidence = { url: provider.tokenUrl, status: tok.status, latencyMs: tok.ms, authorize: { url: provider.authorizeUrl, status: auth.status } };
        const dead = (p: HttpProbe) => Boolean(p.error) || p.status === 404 || p.status === 410 || (p.status ?? 0) >= 500;
        if (dead(tok)) return { verdict: tok.errKind === "timeout" || (tok.status ?? 0) >= 500 ? "degraded" : "broken", reason: `token endpoint ${tok.error ?? `HTTP ${tok.status}`}`, evidence: { ...ev, firstError: tok.error ?? `HTTP ${tok.status}` } };
        if (dead(auth)) return { verdict: auth.errKind === "timeout" || (auth.status ?? 0) >= 500 ? "degraded" : "broken", reason: `authorize endpoint ${auth.error ?? `HTTP ${auth.status}`}`, evidence: { ...ev, firstError: auth.error ?? `HTTP ${auth.status}` } };
        return { verdict: "works-needs-credentials", reason: `token endpoint answers a bogus grant (HTTP ${tok.status}), authorize endpoint alive (HTTP ${auth.status}); needs the owner's registered app`, evidence: ev };
      },
    };
  }
  if (s.kind === "browser") {
    return {
      entry: inv,
      lane: "net",
      network: true,
      async run(ctx) {
        const url = s.loginUrl ?? `https://${s.domain}/`;
        const p = await httpProbe(url, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html" } });
        const ev: CheckEvidence = { url: url.slice(0, 120), status: p.status, latencyMs: p.ms };
        if (p.error) return { verdict: p.errKind === "timeout" ? "degraded" : "broken", reason: `sign-in page unreachable: ${p.error}`, evidence: { ...ev, firstError: p.error } };
        if (p.status === 404 || p.status === 410) return { verdict: "broken", reason: `sign-in URL gone: HTTP ${p.status}`, evidence: ev };
        if ((p.status ?? 0) >= 500) return { verdict: "degraded", reason: `site error HTTP ${p.status}`, evidence: ev };
        return { verdict: "works-needs-credentials", reason: `sign-in page reachable (HTTP ${p.status}); the live-browser flow needs the owner to sign in${[403, 429].includes(p.status ?? 0) ? " (site serves a bot wall to plain HTTP; a real browser is what Ares uses)" : ""}`, evidence: ev };
      },
    };
  }
  // api-key
  const verify = DEFAULT_VERIFIERS[s.id];
  const fields = s.fields ?? [];
  return {
    entry: inv,
    lane: "net",
    network: true,
    async run(ctx) {
      if (s.id === "hue") {
        return { verdict: "unverifiable", reason: "pairing needs a Hue bridge on the LAN and the link button; only the discovery service is probed (upstream:hue-discovery)", evidence: { note: "lan-hardware" } };
      }
      if (s.id === "plaid") {
        return { verdict: "unverifiable", reason: "Hosted Link needs the owner's Plaid keys and a bank login; the API host is probed under upstream:plaid", evidence: { note: "see upstream:plaid" } };
      }
      if (!verify) return { verdict: "unverifiable", reason: "no key verifier is registered for this service", evidence: {} };
      const values: Record<string, string> = {};
      for (const f of fields) values[f.credential] = FAKE_BY_CREDENTIAL[f.credential] ?? PLACEHOLDER_CRED;
      const t0 = Date.now();
      const secrets = [...Object.values(values), ...ctx.secrets];
      try {
        await verify(values, AbortSignal.timeout(ctx.timeoutMs));
        return { verdict: "degraded", reason: "the verifier ACCEPTED a fake credential (or only checked its format) — it cannot prove a real key works", evidence: { latencyMs: Date.now() - t0 } };
      } catch (err) {
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
        let c = classifyVerifierError(msg);
        // The verifier's own network errors surface as "fetch failed"; retry once.
        if (c.verdict === "broken" || c.verdict === "degraded") {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            await verify(values, AbortSignal.timeout(ctx.timeoutMs));
          } catch (err2) {
            c = classifyVerifierError(scrubSecrets(err2 instanceof Error ? err2.message : String(err2), secrets));
          }
        }
        return { verdict: c.verdict, reason: c.reason, evidence: { latencyMs: Date.now() - t0, firstError: msg.slice(0, 200) } };
      }
    },
  };
}

function planUpstream(u: UpstreamSpec): Planned {
  return {
    entry: {
      id: u.id,
      name: u.name,
      kind: u.id.startsWith("channel:") ? "channel" : "upstream",
      source: "packages/tools",
      launch: { transport: "https-api", url: u.url },
      auth: u.auth === "none" ? "none" : "api-key",
      needsCredentials: u.auth !== "none",
      free: u.free,
    },
    lane: "net",
    network: true,
    run: (ctx) => u.run({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }),
  };
}

function planLocal(): Planned[] {
  const out: Planned[] = [];
  out.push({
    entry: { id: "catalog:lint", name: "Catalog consistency (ids, urls, field wiring)", kind: "runtime", source: "core catalogs", launch: { transport: "local" }, auth: "none", needsCredentials: false, free: "n/a" },
    lane: "local",
    network: false,
    async run() {
      const problems = lintCatalogs();
      return problems.length ? { verdict: "broken", reason: `${problems.length} catalog problem(s): ${problems.slice(0, 3).join("; ")}`, evidence: { problems: problems.slice(0, 40) } } : { verdict: "working", reason: "all catalog entries are well-formed", evidence: {} };
    },
  });
  out.push({
    entry: { id: "runtime:node-npx", name: "Node + npx (stdio servers, Deploy tool)", kind: "runtime", source: "host", launch: { transport: "local" }, auth: "none", needsCredentials: false, free: "n/a" },
    lane: "local",
    network: false,
    async run() {
      const npx = binaryOnPath("npx");
      return npx ? { verdict: "working", reason: `node ${process.version}, npx on PATH`, evidence: { note: process.version } } : { verdict: "broken", reason: "npx is not on PATH: every npx-launched connector fails", evidence: {} };
    },
  });
  out.push({
    entry: { id: "runtime:uvx", name: "uv / uvx (Python stdio servers)", kind: "runtime", source: "host", launch: { transport: "local" }, auth: "none", needsCredentials: false, free: "n/a" },
    lane: "local",
    network: false,
    async run() {
      return binaryOnPath("uvx") ? { verdict: "working", reason: "uvx on PATH", evidence: {} } : { verdict: "unverifiable", reason: "uvx not installed here; Python-based stdio entries are hidden from the hub on this host (install uv to enable them)", evidence: {} };
    },
  });
  out.push({
    entry: { id: "runtime:browser", name: "Chromium for live sign-in (Connect browser flow)", kind: "runtime", source: "@ares/connectors", launch: { transport: "local" }, auth: "none", needsCredentials: false, free: "n/a" },
    lane: "local",
    network: false,
    async run() {
      const found = await Promise.resolve(findInstalledChromium()).catch(() => undefined);
      return found ? { verdict: "working", reason: "a Chromium is installed for browser sign-in flows", evidence: { note: String(found).slice(0, 120) } } : { verdict: "degraded", reason: "no Chromium installed: browser sign-in connectors (DoorDash, Instagram…) cannot start a live session here", evidence: {} };
    },
  });
  out.push({
    entry: { id: "remote-pc:windows", name: "Remote PC connector (Windows PowerShell)", kind: "remote-pc", source: "cli/remoteDeviceConnector.ts", launch: { transport: "websocket" }, auth: "pairing", needsCredentials: true, free: "free" },
    lane: "local",
    network: false,
    async run(ctx) {
      const ps1 = buildDeviceConnectorPs1({ token: "doctor-token", wsUrl: "wss://example.invalid/ws", baseUrl: "https://example.invalid", discoveryPort: 41234 });
      const legacy = buildPowerShellAgent("doctor-token", "wss://example.invalid/ws");
      const problems: string[] = [];
      for (const [label, src] of [["device connector", ps1], ["one-time connector", legacy]] as const) {
        const opens = (src.match(/\{/g) ?? []).length;
        const closes = (src.match(/\}/g) ?? []).length;
        if (opens !== closes) problems.push(`${label}: unbalanced braces (${opens}/${closes})`);
        if (src.includes("__ARES_")) problems.push(`${label}: unreplaced template placeholder`);
        if (src.length < 2000) problems.push(`${label}: suspiciously short (${src.length})`);
      }
      let parsed = "not attempted (no pwsh on this host)";
      if (binaryOnPath("pwsh")) {
        const f = path.join(ctx.scratchRoot, "connector.ps1");
        await fs.writeFile(f, ps1, "utf8");
        const r = await runCapture("pwsh", ["-NoLogo", "-NoProfile", "-Command", `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$e);if($e){$e|%{$_.Message};exit 1}`], 20_000);
        parsed = r.code === 0 ? "pwsh parser: no syntax errors" : `pwsh parser: ${r.out.slice(0, 160)}`;
        if (r.code !== 0) problems.push(parsed);
      }
      return problems.length
        ? { verdict: "broken", reason: problems.join("; "), evidence: { firstError: problems[0] } }
        : { verdict: "unverifiable", reason: `connector v${DEVICE_CONNECTOR_VERSION} script builds clean (${ps1.length} bytes, braces balanced, no stray placeholders); executing it needs a Windows device`, evidence: { note: parsed } };
    },
  });
  out.push({
    entry: { id: "remote-pc:unix", name: "Remote PC connector (Mac/Linux Python)", kind: "remote-pc", source: "cli/remoteAgentServer.ts", launch: { transport: "websocket", command: "python3" }, auth: "pairing", needsCredentials: true, free: "free" },
    lane: "local",
    network: false,
    async run(ctx) {
      const py = buildPythonAgent("doctor-token", "wss://example.invalid/ws");
      if (!binaryOnPath("python3")) return { verdict: "unverifiable", reason: "python3 not installed here, cannot compile-check", evidence: {} };
      const f = path.join(ctx.scratchRoot, "agent.py");
      await fs.writeFile(f, py, "utf8");
      const r = await runCapture("python3", ["-c", `import ast,sys;ast.parse(open(sys.argv[1]).read())`, f], 20_000);
      return r.code === 0
        ? { verdict: "working", reason: `connector script compiles under ${(await runCapture("python3", ["--version"], 5000)).out.trim()} (pure stdlib)`, evidence: { note: `${py.length} bytes` } }
        : { verdict: "broken", reason: `python syntax error: ${r.out.slice(0, 200)}`, evidence: { firstError: r.out.slice(0, 200) } };
    },
  });
  return out;
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const t = setTimeout(() => { if (!done) { c.kill("SIGKILL"); } }, timeoutMs);
    c.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    c.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    c.on("error", (e) => { done = true; clearTimeout(t); resolve({ code: -1, out: e.message }); });
    c.on("close", (code) => { done = true; clearTimeout(t); resolve({ code, out }); });
  });
}

/** Servers the owner already configured: probe exactly as configured. */
export async function probeConfiguredServer(
  name: string,
  cfg: McpServerConfig,
  o: { home?: string; scratchDir: string; timeoutMs: number; fetchImpl?: DoctorOptions["fetchImpl"] },
): Promise<{ verdict: Verdict; reason: string; evidence: CheckEvidence; toolCount?: number; latencyMs: number }> {
  const t0 = Date.now();
  if ("url" in cfg && typeof (cfg as { url?: string }).url === "string") {
    const remote = cfg as { url: string; transport?: "http" | "sse" | "auto"; oauth?: boolean; vault?: boolean };
    const creds = await getMcpCallCredentials(name, o.home).catch(() => ({ bearer: null as string | null, headers: {} as Record<string, string> }));
    const p = await probeRemoteMcp(remote.url, { transport: remote.transport ?? "auto", bearer: creds.bearer ?? undefined, headers: creds.headers, timeoutMs: o.timeoutMs, fetchImpl: o.fetchImpl, discoverOAuth: false });
    const base: CheckEvidence = { url: remote.url, status: p.status, latencyMs: p.latencyMs, toolCount: p.toolCount, ...(p.error ? { firstError: p.error } : {}) };
    if (p.kind === "ok" || p.kind === "sse-open") return { verdict: "working", reason: p.kind === "ok" ? `live: ${p.toolCount} tools` : "live: SSE stream opens", evidence: base, toolCount: p.toolCount, latencyMs: Date.now() - t0 };
    if (p.kind === "auth-required") return { verdict: "broken", reason: creds.bearer ? `the server rejected the stored token (HTTP ${p.status}) — reconnect it` : "no stored credential — connect it again", evidence: base, latencyMs: Date.now() - t0 };
    const c = classifyRemoteProbe(p, { auth: "oauth" });
    return { ...c, evidence: base, latencyMs: Date.now() - t0 };
  }
  const stdio = cfg as { command: string; args?: string[]; env?: Record<string, string>; envVault?: Record<string, string>; cwd?: string };
  const env: Record<string, string> = { ...(stdio.env ?? {}) };
  const secrets: string[] = [];
  for (const [envName, credName] of Object.entries(stdio.envVault ?? {})) {
    const v = await getCredential(credName, { home: o.home }).catch(() => undefined);
    if (v) { env[envName] = v; secrets.push(v); }
  }
  const args: string[] = [];
  for (const a of stdio.args ?? []) {
    const m = /^\$\{VAULT:([^}]+)\}$/.exec(a);
    if (!m) { args.push(a); continue; }
    const v = await getCredential(m[1]!, { home: o.home }).catch(() => undefined);
    if (!v) return { verdict: "broken", reason: `a credential this server needs is missing from the vault (${m[1]})`, evidence: {}, latencyMs: Date.now() - t0 };
    args.push(v);
    secrets.push(v);
  }
  const probe = await probeStdioServer({ command: stdio.command, args, env, cwd: stdio.cwd }, {
    scratchDir: o.scratchDir,
    timeoutMs: o.timeoutMs,
    secrets,
    keepHome: true,
    inheritEnv: ["npm_config_cache", "UV_CACHE_DIR", "DOCKER_HOST", "KUBECONFIG"],
  });
  const c = classifyStdioProbe(probe, { needsCredentials: false, timeoutMs: o.timeoutMs });
  return { ...c, evidence: stdioEvidence(stdio.command, args, probe, secrets), toolCount: probe.toolCount, latencyMs: Date.now() - t0 };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  peak = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

function secretLiterals(): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASS$/i.test(k)) out.add(v);
  }
  return out;
}

/** Final barrier: no string in the report may carry a secret. */
export function scrubReport<T>(value: T, secrets: Iterable<string> = []): T {
  const list = [...secrets];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubSecrets(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export async function buildPlan(opts: DoctorOptions = {}): Promise<Planned[]> {
  const remote = opts.catalogs?.remote ?? MCP_CATALOG;
  const stdio = opts.catalogs?.stdio ?? MCP_STDIO_CATALOG;
  const services = opts.catalogs?.services ?? CONNECT_SERVICES;
  const plan: Planned[] = [];
  for (const e of remote) plan.push(planRemoteCatalog(e));
  for (const e of stdio) plan.push(await planStdioCatalog(e));
  for (const s of services) {
    const p = planService(s);
    if (p) plan.push(p);
  }
  for (const u of upstreamSpecs()) plan.push(planUpstream(u));
  plan.push(...planLocal());
  if (opts.includeConfigured !== false) {
    const configured = await listMcpServers(os.tmpdir(), false).catch(() => ({} as Record<string, McpServerConfig>));
    for (const [name, cfg] of Object.entries(configured)) {
      const isUrl = "url" in cfg;
      plan.push({
        entry: {
          id: `configured:${name}`,
          name: `${name} (configured)`,
          kind: "mcp-configured",
          source: "~/.ares/mcp*.json",
          launch: isUrl ? { transport: "http", url: (cfg as { url: string }).url } : { transport: "stdio", command: (cfg as { command: string }).command, args: (cfg as { args?: string[] }).args },
          auth: isUrl ? "oauth" : "none",
          needsCredentials: false,
          free: "n/a",
        },
        lane: isUrl ? "net" : "stdio",
        network: isUrl,
        async run(ctx) {
          const scratch = await scratchFor(ctx, `cfg-${name}`);
          try {
            const r = await probeConfiguredServer(name, cfg, { home: opts.home, scratchDir: scratch, timeoutMs: isUrl ? ctx.timeoutMs : ctx.stdioTimeoutMs, fetchImpl: ctx.fetchImpl });
            return { verdict: r.verdict, reason: r.reason, evidence: r.evidence };
          } finally {
            await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
          }
        },
      });
    }
  }
  return plan;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport & { peak: { net: number; stdio: number } }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const stdioTimeoutMs = opts.stdioTimeoutMs ?? 90_000;
  const net = new Semaphore(Math.max(1, opts.concurrency ?? 8));
  const stdio = new Semaphore(Math.max(1, opts.stdioConcurrency ?? 3));
  const scratchRoot = await fs.mkdtemp(path.join(opts.scratchParent ?? os.tmpdir(), "ares-doctor-"));
  // Shared caches so a cold npx/uv download is paid once per run, not per check.
  const caches = { npm_config_cache: path.join(scratchRoot, "npm-cache"), UV_CACHE_DIR: path.join(scratchRoot, "uv-cache") };
  const prevEnv = { npm: process.env.npm_config_cache, uv: process.env.UV_CACHE_DIR };
  process.env.npm_config_cache = process.env.ARES_DOCTOR_REAL_CACHE === "1" ? (prevEnv.npm ?? caches.npm_config_cache) : caches.npm_config_cache;
  process.env.UV_CACHE_DIR = process.env.ARES_DOCTOR_REAL_CACHE === "1" ? (prevEnv.uv ?? caches.UV_CACHE_DIR) : caches.UV_CACHE_DIR;
  const secrets = secretLiterals();
  const ctx: RunCtx = { timeoutMs, stdioTimeoutMs, scratchRoot, home: opts.home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), fetchImpl: opts.fetchImpl, secrets };

  try {
    let plan = await buildPlan(opts);
    // Tools derive their verdicts from what they stand on, so keep the whole
    // plan for derivation and filter only what is executed/reported.
    const only = opts.only?.length ? new Set(opts.only.map((s) => s.toLowerCase())) : undefined;
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
    const selected = (id: string, kind: InventoryKind): boolean => (!only || only.has(id.toLowerCase()) || only.has(id.toLowerCase().replace(/^[a-z-]+:/, ""))) && (!kinds || kinds.has(kind));
    plan = plan.filter((p) => selected(p.entry.id, p.entry.kind));

    const results: CheckResult[] = [];
    await Promise.all(
      plan.map(async (p) => {
        const lane = p.lane === "stdio" ? stdio : p.lane === "net" ? net : null;
        const exec = async (): Promise<CheckResult> => {
          const t0 = Date.now();
          if (opts.offline && p.network) {
            return { ...p.entry, verdict: "unverifiable", reason: "offline mode: network checks skipped", evidence: {}, durationMs: 0 };
          }
          const guardMs = (p.lane === "stdio" ? Math.max(stdioTimeoutMs, 120_000) : timeoutMs * 4) + 15_000;
          let guard: ReturnType<typeof setTimeout> | undefined;
          try {
            const out = await Promise.race([
              p.run(ctx),
              new Promise<never>((_, rej) => { guard = setTimeout(() => rej(new Error(`check exceeded its ${Math.round(guardMs / 1000)}s hard deadline`)), guardMs); guard.unref?.(); }),
            ]);
            return { ...p.entry, ...out, durationMs: Date.now() - t0 };
          } catch (err) {
            return { ...p.entry, verdict: "broken", reason: `check crashed: ${scrubSecrets(err instanceof Error ? err.message : String(err), secrets)}`, evidence: {}, durationMs: Date.now() - t0 };
          } finally {
            if (guard) clearTimeout(guard);
          }
        };
        const r = lane ? await lane.run(exec) : await exec();
        results.push(r);
        opts.onResult?.(r);
      }),
    );

    // Tools: derived verdicts (only when not filtered away).
    const byId = new Map(results.map((r) => [r.id, r]));
    if (!only && !kinds) {
      for (const t of TOOLS) {
        const deps = t.dependsOn.map((d) => byId.get(d)).filter((x): x is CheckResult => Boolean(x));
        const verdict = combineVerdicts(deps.map((d) => d.verdict), t.mode ?? "all");
        const worst = deps.find((d) => d.verdict === verdict) ?? deps[0];
        results.push({
          id: `tool:${t.name}`,
          name: t.name,
          kind: "tool",
          source: `packages/tools/src/${t.file}`,
          launch: { transport: "in-process" },
          auth: t.auth,
          needsCredentials: t.auth !== "none",
          free: t.free,
          dependsOn: t.dependsOn,
          dependsMode: t.mode ?? "all",
          verdict,
          reason: worst ? `stands on ${worst.id}: ${worst.reason}` : "no upstream check ran",
          evidence: { dependsOn: t.dependsOn, upstream: deps.map((d) => ({ id: d.id, verdict: d.verdict })) },
          durationMs: 0,
        });
      }
    }

    results.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
    const byVerdict = EMPTY_VERDICTS();
    const byKind: Record<string, Record<Verdict, number>> = {};
    for (const r of results) {
      byVerdict[r.verdict]++;
      (byKind[r.kind] ??= EMPTY_VERDICTS())[r.verdict]++;
    }
    const report: DoctorReport = {
      schema: "ares.connectors.doctor/1",
      generatedAt: new Date().toISOString(),
      offline: Boolean(opts.offline),
      host: {
        platform: `${process.platform}-${os.arch()}`,
        node: process.version,
        runtimes: Object.fromEntries(["npx", "uvx", "docker", "python3", "git", "pwsh"].map((b) => [b, binaryOnPath(b)])),
      },
      totals: { total: results.length, byVerdict, byKind },
      results,
    };
    return { ...scrubReport(report, secrets), peak: { net: net.peak, stdio: stdio.peak } };
  } finally {
    if (prevEnv.npm === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = prevEnv.npm;
    if (prevEnv.uv === undefined) delete process.env.UV_CACHE_DIR; else process.env.UV_CACHE_DIR = prevEnv.uv;
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The full inventory without running any check. */
export async function listInventory(opts: DoctorOptions = {}): Promise<InventoryEntry[]> {
  const plan = await buildPlan(opts);
  const inv = plan.map((p) => p.entry);
  for (const t of TOOLS) {
    inv.push({ id: `tool:${t.name}`, name: t.name, kind: "tool", source: `packages/tools/src/${t.file}`, launch: { transport: "in-process" }, auth: t.auth, needsCredentials: t.auth !== "none", free: t.free, dependsOn: t.dependsOn, dependsMode: t.mode ?? "all" });
  }
  return inv;
}

// ─── CLI rendering ───────────────────────────────────────────────────────────

const ICON: Record<Verdict, string> = { working: "OK  ", "works-needs-credentials": "KEY ", degraded: "WARN", broken: "FAIL", unverifiable: "??  " };

export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Connector doctor — ${report.generatedAt} (${report.host.platform}, node ${report.host.node}${report.offline ? ", OFFLINE" : ""})`);
  lines.push(`runtimes: ${Object.entries(report.host.runtimes).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(" ")}`);
  lines.push("");
  for (const r of report.results) {
    lines.push(`${ICON[r.verdict]} ${r.kind.padEnd(15)} ${r.id.padEnd(34)} ${r.verdict.padEnd(24)} ${r.reason.slice(0, 140)}`);
  }
  lines.push("");
  const t = report.totals.byVerdict;
  lines.push(`total ${report.totals.total}: ${t.working} working, ${t["works-needs-credentials"]} need credentials, ${t.degraded} degraded, ${t.broken} broken, ${t.unverifiable} unverifiable`);
  return lines.join("\n") + "\n";
}
