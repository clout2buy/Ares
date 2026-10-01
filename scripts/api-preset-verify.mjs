#!/usr/bin/env node
// Verifies the connected-account presets against the real world, WITHOUT credentials.
//
//   node scripts/api-preset-verify.mjs spec  [ids...] [--json FILE]   cross-check every curated operation against the vendor's own spec
//   node scripts/api-preset-verify.mjs probe [ids...] [--json FILE]   one unauthenticated request per service: does the host answer 401/403 the way it should?
//   node scripts/api-preset-verify.mjs all   [ids...] [--json FILE] [--md FILE]
//
// Levels it reports (one per service; what it could and could NOT show):
//   SPEC-FETCHED            the vendor's machine-readable spec was fetched TODAY and every curated
//                           method + path (and every parameter name) was found in it
//   ENDPOINT-REACHABLE-401  the service's host answered an unauthenticated authenticated-read with
//                           401/403 and an error body: the host, path and auth scheme are real
//   UNVERIFIED              neither; the operations come from documentation only
// A service can carry both (SPEC-FETCHED + ENDPOINT-REACHABLE-401). Requests go through the same
// network guard the Api tool uses. Run it from a machine that can reach the internet (doingbox).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const tools = await import(new URL("../packages/tools/dist/index.js", import.meta.url).href);
const { PRESET_BUNDLES, SpecHandle, parseSpecText, safeFetch, buildRequest } = tools;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const jsonOut = flag("json");
const mdOut = flag("md");
const cacheDir = flag("cache") ?? path.join(os.tmpdir(), "ares-preset-verify");
const [mode, ...wanted] = args;
if (!["spec", "probe", "all"].includes(mode ?? "")) {
  console.error("usage: api-preset-verify.mjs spec|probe|all [ids...] [--json FILE] [--md FILE]");
  process.exit(2);
}
const bundles = PRESET_BUNDLES.filter((b) => !wanted.length || wanted.includes(b.id));
const today = new Date().toISOString().slice(0, 10);
mkdirSync(cacheDir, { recursive: true });

const UA = "AresPresetVerify/1.0 (+https://github.com/clout2buy/ares)";

async function fetchText(url, timeoutMs = 90_000) {
  const file = path.join(cacheDir, `${createHash("sha1").update(url).digest("hex").slice(0, 14)}-${today}.txt`);
  if (existsSync(file)) return { status: 200, text: readFileSync(file, "utf8"), cached: true };
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json, application/yaml, text/plain, */*" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (res.ok) writeFileSync(file, text);
  return { status: res.status, text, cached: false };
}

const norm = (p) => p.replace(/\{[^}]*\}/g, "{}").replace(/#.*$/, "").replace(/\/+$/, "");

// ─── spec cross-check ────────────────────────────────────────────────────────

/** Root fields of a GraphQL curated query/mutation, e.g. `query X { issues(first: 5) { ...` -> issues. */
function graphqlRoot(query) {
  const m = /\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(query.replace(/^[^{]*\{/, "{"));
  return m?.[1];
}

async function checkSpec(bundle) {
  const out = { id: bundle.id, kind: bundle.source.kind, specUrl: bundle.source.specUrl ?? null, ops: 0, found: 0, missing: [], unknownParams: [], status: null, level: "UNVERIFIED", note: "" };
  const handle = new SpecHandle(bundle.spec);
  out.ops = handle.ops.length;
  if (!bundle.source.specUrl || !["vendor-openapi", "discovery", "graphql-schema"].includes(bundle.source.kind)) {
    out.note = "no machine-readable spec; operations curated from the documentation";
    return out;
  }
  let fetched;
  try {
    fetched = await fetchText(bundle.source.specUrl);
  } catch (err) {
    out.note = `fetch failed: ${err.message}`;
    return out;
  }
  out.status = fetched.status;
  if (fetched.status !== 200) {
    out.note = `spec URL answered HTTP ${fetched.status}`;
    return out;
  }
  if (bundle.source.kind === "graphql-schema") {
    const schema = fetched.text;
    const rootFields = (type) => {
      const m = new RegExp(`type\\s+${type}\\s*(?:implements[^{]*)?\\{([\\s\\S]*?)\\n\\}`, "m").exec(schema);
      return new Set([...(m?.[1] ?? "").matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/gm)].map((x) => x[1]));
    };
    const q = rootFields("Query");
    const mu = rootFields("Mutation");
    for (const op of handle.ops) {
      const gql = op.ext?.graphql;
      if (!gql || gql.raw) {
        out.found++;
        continue;
      }
      const root = graphqlRoot(gql.query);
      const set = gql.kind === "mutation" ? mu : q;
      if (root && set.has(root)) out.found++;
      else out.missing.push(`${gql.kind} ${op.id}: root field ${root ?? "?"} not in the schema`);
    }
    if (!out.missing.length) out.level = "SPEC-FETCHED";
    out.note = `GraphQL schema (${(schema.length / 1024).toFixed(0)} KB); ${q.size} query and ${mu.size} mutation root fields`;
    return out;
  }
  let vendor;
  try {
    vendor = new SpecHandle(parseSpecText(fetched.text));
  } catch (err) {
    out.note = `the vendor spec did not parse: ${err.message}`;
    return out;
  }
  const vendorServerPath = (() => {
    try {
      const s = vendor.meta.servers[0];
      return s ? new URL(s).pathname.replace(/\/$/, "") : "";
    } catch {
      return "";
    }
  })();
  const ourBasePath = (() => {
    try {
      return new URL(bundle.def.baseUrl ?? "https://x.invalid").pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  })();
  const index = new Map();
  for (const v of vendor.ops) index.set(`${v.method} ${norm(vendorServerPath + v.path)}`, v);
  for (const v of vendor.ops) if (!index.has(`${v.method} ${norm(v.path)}`)) index.set(`${v.method} ${norm(v.path)}`, v);
  for (const op of handle.ops) {
    const resolved = handle.operation(op.id);
    const declared = bundle.spec.paths[op.path]?.[op.method.toLowerCase()];
    const vendorKey = typeof declared?.["x-ares-vendor"] === "string" ? declared["x-ares-vendor"] : `${op.method} ${op.path}`;
    const [vm, ...vp] = vendorKey.split(" ");
    const candidates = [`${vm} ${norm(ourBasePath + vp.join(" "))}`, `${vm} ${norm(vp.join(" "))}`];
    const hit = candidates.map((k) => index.get(k)).find(Boolean);
    if (!hit) {
      out.missing.push(`${op.method} ${op.path} (${op.id})`);
      continue;
    }
    out.found++;
    const vOp = vendor.operation(hit.id);
    const vNames = new Set(vOp.parameters.map((p) => p.name.toLowerCase()));
    for (const p of resolved.parameters) {
      if (vNames.has(p.name.toLowerCase())) continue;
      // path variables are positional: only the number and place matter, not the name
      if (p.in === "path") continue;
      // a vendor that documents no parameters at all (free-form query) cannot be checked
      if (vOp.parameters.length === 0) continue;
      out.unknownParams.push(`${op.id}.${p.name}`);
    }
  }
  out.level = out.missing.length === 0 ? "SPEC-FETCHED" : "UNVERIFIED";
  out.note = `${vendor.meta.title} ${vendor.meta.apiVersion}, ${vendor.ops.length} operations in the vendor spec`;
  return out;
}

// ─── endpoint probe ──────────────────────────────────────────────────────────

async function probe(bundle) {
  const out = { id: bundle.id, host: null, url: null, status: null, level: "UNVERIFIED", shape: "", docsStatus: null, specStatus: null, note: "" };
  const def = bundle.def;
  const handle = new SpecHandle(bundle.spec);
  const verify = handle.operation(def.verifyOperationId);
  if (!verify) {
    out.note = "verifyOperationId is not an operation";
    return out;
  }
  const base = def.baseUrl ?? "https://example.invalid";
  const params = {};
  for (const p of verify.parameters) if (p.required && p.schema.default === undefined) params[p.name] = p.schema.type === "integer" || p.schema.type === "number" ? 1 : "example";
  let built;
  try {
    built = buildRequest({ def, op: verify, baseUrl: base, params, auth: { headers: {}, query: [], cookies: [], secrets: [], headerNames: [], queryNames: [] } });
  } catch (err) {
    out.note = `could not build the probe request: ${err.message}`;
    return out;
  }
  out.url = built.displayUrl;
  try {
    out.host = new URL(built.url).host;
  } catch {
    // ignore
  }
  if (!def.baseUrl) {
    out.note = "per-tenant host (the owner supplies it): nothing to probe";
    return out;
  }
  try {
    const body = verify.method === "GET" ? undefined : "{}";
    const res = await safeFetch(built.url, { method: verify.method, headers: { ...built.headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}), allowLan: false, timeoutMs: 25_000, maxBytes: 64 * 1024 });
    out.status = res.status;
    const text = res.body.toString("utf8").replace(/\s+/g, " ").slice(0, 160);
    const www = res.headers["www-authenticate"] ? ` www-authenticate: ${res.headers["www-authenticate"].slice(0, 80)};` : "";
    out.shape = `${res.headers["content-type"] ?? "?"};${www} ${text}`.trim();
    if (res.status === 401 || res.status === 403) out.level = "ENDPOINT-REACHABLE-401";
    else if (res.status === 400 || res.status === 404 || res.status === 405 || res.status === 422) out.level = "ENDPOINT-REACHABLE-" + res.status;
    else if (res.status >= 200 && res.status < 300) out.level = "ENDPOINT-REACHABLE-" + res.status;
    else out.level = "ENDPOINT-ODD-" + res.status;
  } catch (err) {
    out.note = `request failed: ${err.message}`;
    out.level = "UNREACHABLE";
  }
  try {
    const docs = await fetch(bundle.source.docsUrl, { method: "GET", headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    out.docsStatus = docs.status;
  } catch (err) {
    out.docsStatus = `error: ${err.message}`;
  }
  return out;
}

// ─── run ─────────────────────────────────────────────────────────────────────

const results = [];
for (const bundle of bundles) {
  const row = { id: bundle.id, label: bundle.def.label, connect: bundle.def.oauth?.connect ?? `api-${bundle.id}` };
  if (mode === "spec" || mode === "all") row.spec = await checkSpec(bundle).catch((e) => ({ id: bundle.id, level: "UNVERIFIED", note: `check crashed: ${e.message}`, missing: [], unknownParams: [] }));
  if (mode === "probe" || mode === "all") row.probe = await probe(bundle).catch((e) => ({ id: bundle.id, level: "UNVERIFIED", note: `probe crashed: ${e.message}` }));
  results.push(row);
  const s = row.spec;
  const p = row.probe;
  console.log(
    `${bundle.id.padEnd(16)} ${s ? `${s.level.padEnd(13)} ${s.found}/${s.ops} ops${s.missing.length ? ` MISSING ${s.missing.length}` : ""}${s.unknownParams.length ? ` unknownParams ${s.unknownParams.length}` : ""}` : "".padEnd(24)}  ${p ? `${p.level} ${p.status ?? ""} ${p.host ?? ""}` : ""}`,
  );
  if (s?.missing.length) for (const m of s.missing.slice(0, 12)) console.log(`    missing: ${m}`);
  if (s?.unknownParams.length) for (const m of s.unknownParams.slice(0, 8)) console.log(`    unknown param: ${m}`);
}

const report = { date: today, host: os.hostname(), node: process.version, results };
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(`\n${results.length} services checked on ${today} from ${os.hostname()}`);
void mdOut;
