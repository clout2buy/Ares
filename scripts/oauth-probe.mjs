#!/usr/bin/env node
// Live OAuth discovery probe: the evidence behind docs/CONNECTIONS-OAUTH.md.
//
//   node scripts/oauth-probe.mjs [--only id,id] [--out tests/fixtures/oauth/mcp] [--concurrency 6]
//
// For every remote MCP server in the catalog (plus a few extra endpoints the
// product cares about) it does what a spec-compliant client does and saves
// what the vendor answered, VERBATIM, so tests can parse the saved fixture
// without touching the network:
//
//   1. unauthenticated MCP `initialize` POST  -> 401 + WWW-Authenticate
//      (RFC 9728 resource_metadata hint), or 200 (open server)
//   2. protected-resource metadata (RFC 9728)  -> authorization_servers
//   3. authorization-server metadata (RFC 8414, then OIDC discovery)
//
// What it NEVER does: POST to a registration endpoint, create a client,
// sign in, or send any credential. Reading discovery documents only.
// The product's runtime does dynamic registration when the owner taps
// Connect; whether a vendor ACCEPTS the Ares redirect cannot be proven by
// reading metadata (Vercel advertises DCR yet allowlists redirect URIs), and
// the matrix says so (acceptance stays UNVERIFIED unless a note says tested).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const outDir = path.resolve(flag("out", "tests/fixtures/oauth/mcp"));
const only = (flag("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const concurrency = Number(flag("concurrency", "6")) || 6;
const TIMEOUT = 15_000;

// Endpoints that are not (yet) catalog rows but are in the product's plan.
const EXTRA_MCP = {
  "github-mcp": "https://api.githubcopilot.com/mcp/",
  "slack-mcp": "https://mcp.slack.com/mcp",
  "atlassian-mcp-http": "https://mcp.atlassian.com/v1/mcp",
  "sentry-mcp-http": "https://mcp.sentry.dev/mcp",
  "notion-mcp": "https://mcp.notion.com/mcp",
  "stripe-mcp": "https://mcp.stripe.com",
  "shopify-storefront-mcp": "https://shopify.dev/mcp",
  "pagerduty-mcp": "https://mcp.pagerduty.com/mcp",
  "zoom-mcp": "https://mcp.zoom.us/mcp",
  "salesforce-mcp": "https://api.salesforce.com/platform/mcp/v1",
  "xero-mcp": "https://mcp.xero.com/mcp",
  "intuit-mcp": "https://mcp.intuit.com/mcp",
};

async function http(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
  return res;
}

async function getJson(url) {
  try {
    const res = await http(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { url, status: res.status, body: null };
    const text = await res.text();
    try {
      return { url, status: res.status, body: JSON.parse(text) };
    } catch {
      return { url, status: res.status, body: null };
    }
  } catch (err) {
    return { url, status: 0, body: null, error: String(err?.message ?? err).slice(0, 120) };
  }
}

function wellKnown(base, kind) {
  let u;
  try { u = new URL(base); } catch { return []; }
  const p = u.pathname.replace(/\/+$/, "");
  const out = [];
  if (p && p !== "/") out.push(`${u.origin}/.well-known/${kind}${p}`);
  out.push(`${u.origin}/.well-known/${kind}`);
  return out;
}

export async function probeMcp(id, mcpUrl) {
  const result = { id, mcpUrl, probedAt: new Date().toISOString(), initialize: null, prm: null, as: null };
  // 1. unauthenticated initialize
  let hinted = null;
  try {
    const res = await http(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ares-oauth-probe", version: "1" } } }),
    });
    const www = res.headers.get("www-authenticate");
    result.initialize = { status: res.status, wwwAuthenticate: www ?? null, contentType: res.headers.get("content-type") ?? null };
    const m = www && /resource_metadata="?([^",\s]+)"?/i.exec(www);
    if (m) hinted = m[1];
    try { await res.arrayBuffer(); } catch { /* ignore */ }
  } catch (err) {
    result.initialize = { status: 0, error: String(err?.message ?? err).slice(0, 120) };
  }
  // SSE-only endpoints answer GET, not POST.
  if (result.initialize.status !== 401 && result.initialize.status !== 200) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8_000);
      const res = await fetch(mcpUrl, { headers: { accept: "text/event-stream" }, redirect: "manual", signal: ctl.signal });
      clearTimeout(timer);
      const www = res.headers.get("www-authenticate");
      result.initializeGet = { status: res.status, wwwAuthenticate: www ?? null };
      const m = www && /resource_metadata="?([^",\s]+)"?/i.exec(www);
      if (m && !hinted) hinted = m[1];
      try { ctl.abort(); } catch { /* ignore */ }
    } catch (err) {
      result.initializeGet = { status: 0, error: String(err?.message ?? err).slice(0, 120) };
    }
  }
  // 2. protected-resource metadata
  const prmUrls = [...(hinted ? [hinted] : []), ...wellKnown(mcpUrl, "oauth-protected-resource")];
  for (const url of prmUrls) {
    const got = await getJson(url);
    if (got.body && typeof got.body === "object") { result.prm = got; break; }
  }
  // 3. authorization-server metadata: advertised issuers first, then the MCP origin
  const issuers = Array.isArray(result.prm?.body?.authorization_servers) ? result.prm.body.authorization_servers : [];
  const origin = new URL(mcpUrl).origin;
  for (const issuer of [...issuers, origin]) {
    const urls = [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration"), `${new URL(issuer).origin}/.well-known/openid-configuration`];
    for (const url of urls) {
      const got = await getJson(url);
      if (got.body && typeof got.body.authorization_endpoint === "string") { result.as = { ...got, issuerQueried: issuer }; break; }
    }
    if (result.as) break;
  }
  return result;
}

async function pool(items, size, work) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) results.push(await work(item));
  }));
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const core = await import(pathToFileURL(path.resolve("packages/core/dist/index.js")).href);
  const targets = [
    ...core.MCP_CATALOG.filter((e) => e.auth !== "none").map((e) => ({ id: e.id, url: e.url })),
    ...Object.entries(EXTRA_MCP).map(([id, url]) => ({ id, url })),
  ].filter((t) => !only.length || only.includes(t.id));
  await mkdir(outDir, { recursive: true });
  const rows = await pool(targets, concurrency, async (t) => {
    const r = await probeMcp(t.id, t.url);
    await writeFile(path.join(outDir, `${t.id}.json`), JSON.stringify(r, null, 2) + "\n");
    const s = r.as?.body;
    process.stdout.write(
      `${t.id.padEnd(26)} init=${String(r.initialize?.status ?? "-").padEnd(4)} prm=${r.prm ? "y" : "n"} as=${s ? "y" : "n"} dcr=${s?.registration_endpoint ? "y" : "n"} device=${s?.device_authorization_endpoint ? "y" : "n"} revoke=${s?.revocation_endpoint ? "y" : "n"}\n`,
    );
    return r;
  });
  process.stdout.write(`${rows.length} servers probed -> ${outDir}\n`);
}
