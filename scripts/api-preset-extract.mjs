#!/usr/bin/env node
// Authoring aid for the connected-account presets (packages/tools/src/openapi/presets/).
// Reads a vendor spec (OpenAPI 3, Swagger 2 or a Google discovery document — a file
// or a URL) and either lists its operations or prints preset-kit code for the ones
// you pick, with the vendor's exact parameter names, types, enums and body fields.
// It prints a STARTING POINT: rename ids, tighten summaries, drop noise parameters,
// and add risk / paginate / keywords by hand.
//
//   node scripts/api-preset-extract.mjs list <spec> [--grep REGEX] [--limit N]
//   node scripts/api-preset-extract.mjs show <spec> "GET /v6/deployments" "POST /v13/deployments" ...
//   node scripts/api-preset-extract.mjs show <spec> --id listDeployments        (by vendor operationId)
//   node scripts/api-preset-extract.mjs show <spec> --grep "^GET /v1/charges"    (by "METHOD /path" regex)
//   add --cache DIR to keep downloaded specs on disk (default: os temp)
//
// Needs the tools package built (pnpm build): it uses SpecHandle from packages/tools/dist.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { SpecHandle, parseSpecText } = await import(new URL("../packages/tools/dist/index.js", import.meta.url).href);

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cacheDir = flag("cache", path.join(os.tmpdir(), "ares-spec-cache"));
const grep = flag("grep");
const byId = flag("id");
const limit = Number(flag("limit", "400"));
const [cmd, specRef, ...picks] = args;
if (!cmd || !specRef) {
  console.error("usage: api-preset-extract.mjs list|show <spec file or url> [picks...] [--grep RE] [--id operationId]");
  process.exit(2);
}

async function load(ref) {
  if (/^https?:\/\//i.test(ref)) {
    mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, createHash("sha1").update(ref).digest("hex").slice(0, 12) + ".spec");
    if (existsSync(file)) return readFileSync(file, "utf8");
    const res = await fetch(ref, { headers: { "user-agent": "AresPresetExtract/1.0" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${ref}`);
    const text = await res.text();
    writeFileSync(file, text);
    return text;
  }
  return readFileSync(ref, "utf8");
}

// ─── printing ────────────────────────────────────────────────────────────────

const lit = (v) => JSON.stringify(v);
function clip(text, n = 110) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function paramCode(p) {
  const s = p.schema ?? {};
  const desc = clip(p.description || p.name);
  const extra = {};
  if (Array.isArray(s.enum)) extra.enum = s.enum.slice(0, 20);
  if (s.default !== undefined) extra.default = s.default;
  if (typeof s.minimum === "number") extra.minimum = s.minimum;
  if (typeof s.maximum === "number") extra.maximum = s.maximum;
  const ex = Object.keys(extra).length ? `, ${lit(extra)}` : "";
  let b;
  switch ((s.type ?? "string").split("|")[0]) {
    case "integer": b = `int(${lit(desc)}${ex})`; break;
    case "number": b = `num(${lit(desc)}${ex})`; break;
    case "boolean": b = `bool(${lit(desc)}${ex})`; break;
    case "array": b = p.explode === true ? `multi(${lit(desc)}${s.items?.type && s.items.type !== "string" ? `, ${lit(s.items.type)}` : ""})` : `csv(${lit(desc)})`; break;
    default: b = `str(${lit(desc)}${ex})`;
  }
  return `p(${lit(p.name)}, ${lit(p.in)}, ${b}${p.required && p.in !== "path" ? ", true" : ""})`;
}

function compactSchema(s, depth = 0) {
  if (!s || typeof s !== "object") return {};
  const out = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = clip(s.description, 90);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice(0, 20);
  if (s.items) out.items = depth >= 3 ? { type: s.items.type ?? "object" } : compactSchema(s.items, depth + 1);
  if (s.properties) {
    out.properties = {};
    const entries = Object.entries(s.properties);
    for (const [k, v] of entries.slice(0, 40)) out.properties[k] = depth >= 3 ? { type: v.type ?? "object" } : compactSchema(v, depth + 1);
    if (entries.length > 40) out.properties["…"] = { description: `${entries.length - 40} more fields` };
  }
  if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  if (s.additionalProperties && typeof s.additionalProperties === "object") out.additionalProperties = compactSchema(s.additionalProperties, depth + 1);
  return out;
}

function opCode(handle, entry, basePathPrefix) {
  const op = handle.operation(entry.id);
  const fn = entry.method === "GET" ? "get" : entry.method === "DELETE" ? "del" : entry.method.toLowerCase();
  const params = op.parameters.map((p) => `    ${paramCode(p)},`).join("\n");
  const extras = [`vendor: ${lit(`${entry.method} ${basePathPrefix}${entry.path}`)}`];
  if (entry.tags?.length) extras.unshift(`tags: ${lit(entry.tags.slice(0, 2))}`);
  if (op.body) extras.push(`body: JSON_BODY(${lit(compactSchema(op.body.schema))}${op.body.required ? "" : ", false"})`);
  if (!["get", "del"].includes(fn)) extras.push(`risk: "write" /* read | write | message | destructive | financial */`);
  const first = (op.summary || op.description || entry.id).split(/(?<=\.)\s/)[0];
  return `  ${fn}(${lit(entry.path)}, ${lit(entry.id)}, ${lit(clip(first, 140))}, [\n${params}\n  ], { ${extras.join(", ")} }),`;
}

// ─── main ────────────────────────────────────────────────────────────────────

const text = await load(specRef);
const raw = parseSpecText(text); // converts a Google discovery document to OpenAPI
const handle = new SpecHandle(raw);
const basePrefix = (() => {
  const s = handle.meta.servers[0];
  if (!s) return "";
  try {
    const p = new URL(s).pathname.replace(/\/$/, "");
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
})();

console.error(`// ${handle.meta.title} ${handle.meta.apiVersion} (${handle.meta.flavor} ${handle.meta.version}), ${handle.ops.length} operations, server ${handle.meta.servers[0] ?? "(none)"}`);

if (cmd === "list") {
  const re = grep ? new RegExp(grep, "i") : null;
  let n = 0;
  for (const o of handle.ops) {
    const line = `${o.method} ${o.path}`;
    if (re && !re.test(`${line} ${o.id} ${o.summary} ${o.tags.join(" ")}`)) continue;
    console.log(`${line}  [${o.id}] ${clip(o.summary, 90)}`);
    if (++n >= limit) break;
  }
} else if (cmd === "show") {
  const re = grep ? new RegExp(grep, "i") : null;
  const wanted = new Set(picks.map((s) => s.trim().replace(/\s+/g, " ")));
  const chosen = handle.ops.filter((o) => (byId && o.id === byId) || wanted.has(`${o.method} ${o.path}`) || (re && re.test(`${o.method} ${o.path}`)));
  if (!chosen.length) {
    console.error("no operation matched. Use `list --grep` to see the exact `METHOD /path` strings.");
    process.exit(1);
  }
  for (const o of chosen) console.log(opCode(handle, o, basePrefix));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
void here;
