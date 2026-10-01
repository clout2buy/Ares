// The OAuth truth matrix stays honest: every service has a class and a path,
// no class a-d service asks for a pasted token, and every LIVE-VERIFIED claim
// is backed by a saved discovery document that this test parses (no network).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_STDIO_CATALOG, MCP_CATALOG, CONNECT_SERVICES, OAUTH_MATRIX, discoveryFactsFrom, matrixFor, planConnect, summarizeMatrix, parseAuthServerMetadata } from "../packages/core/dist/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "oauth");
const readFix = (rel) => JSON.parse(readFileSync(path.join(FIX, rel), "utf8"));
const STATIC = CONNECT_SERVICES.filter((s) => !s.id.startsWith("site:") && !s.id.startsWith("api-") && s.id !== "mqtt");

test("every registry service has a class and a path", () => {
  const missing = STATIC.filter((s) => !matrixFor(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `services with no matrix row: ${missing.join(", ")}`);
  for (const e of OAUTH_MATRIX) {
    assert.ok("abcdefn".includes(e.class), e.id);
    assert.ok(e.flow, `${e.id} has no flow`);
    assert.ok(e.ownerSetup, `${e.id} has no ownerSetup`);
    if (e.registry === "excluded") assert.ok(e.excludedReason, `${e.id} excluded without a reason`);
  }
  // rows that claim to be registry services exist there, and vice versa for added ones
  for (const e of OAUTH_MATRIX.filter((x) => x.registry === "existing" || x.registry === "added")) assert.ok(CONNECT_SERVICES.some((s) => s.id === e.id) || MCP_STDIO_CATALOG.some((c) => c.id === e.id) || MCP_CATALOG.some((c) => c.id === e.id && c.auth === "none"), `${e.id} is in the matrix but not the registry`);
  assert.ok(new Set(OAUTH_MATRIX.map((e) => e.id)).size === OAUTH_MATRIX.length, "duplicate matrix ids");
});

test("no service with a real OAuth path (class a-d) asks for a pasted token; class e/n is labelled key fields; class f is honest", () => {
  const bad = [];
  for (const s of STATIC) {
    const e = matrixFor(s.id);
    const plan = planConnect(s, {});
    if ("abcd".includes(e.class)) {
      if (s.kind === "api-key" || s.kind === "mcp-key") bad.push(`${s.id}: class ${e.class} but kind ${s.kind}`);
      if (plan.start === "fields" || plan.auth === "key") bad.push(`${s.id}: class ${e.class} plans a key form`);
      if (e.class !== "f" && !["open", "device", "setup", "unsupported"].includes(plan.start)) bad.push(`${s.id}: odd start ${plan.start}`);
    }
    if (e.class === "e" || e.class === "n") {
      if (!(s.kind === "api-key" || s.kind === "mcp-key")) bad.push(`${s.id}: class ${e.class} but kind ${s.kind}`);
      assert.equal(plan.auth, "key");
    }
    if (e.class === "f") assert.ok(plan.start === "unsupported", `${s.id} must be unsupported`);
    if (plan.start === "setup") assert.ok(plan.setupFields.some((f) => f.key === "client_id"), `${s.id} setup has no client_id field`);
  }
  assert.deepEqual(bad, []);
});

test("LIVE-VERIFIED rows are backed by saved discovery documents that parse and say what the row says", () => {
  let live = 0;
  for (const e of OAUTH_MATRIX) {
    if (e.verification !== "LIVE-VERIFIED") continue;
    live += 1;
    assert.ok(e.fixtures.length > 0, `${e.id} claims LIVE with no fixture`);
    let best = null;
    for (const rel of e.fixtures) {
      assert.ok(existsSync(path.join(FIX, rel)), `${e.id}: missing fixture ${rel}`);
      const j = readFix(rel);
      const as = rel.startsWith("mcp/") ? j.as?.body : j;
      const facts = discoveryFactsFrom(as);
      if (facts && (!best || Object.values(facts).filter(Boolean).length > Object.values(best).filter(Boolean).length)) best = facts;
    }
    assert.ok(best, `${e.id}: no fixture holds an authorization-server document`);
    assert.deepEqual(e.facts, best, `${e.id}: declared facts differ from the fixture`);
    if (e.class === "a" && e.flow === "mcp-dcr") assert.ok(best.dcr || best.cimd, `${e.id}: class a needs a registration endpoint (or CIMD) in its discovery document`);
    if (e.class === "b" && best.dcr) assert.ok(e.allowlist || e.selfServe === false || e.loopback, `${e.id}: class b with DCR must explain the allowlist`);
    if (e.class === "d" && e.flow === "device") assert.ok(best.device || e.endpoints.device, `${e.id}: class d needs a device endpoint`);
    // the engine's own parser agrees the document is usable
    const first = e.fixtures.map(readFix).map((j) => (j.as ? j.as.body : j)).find((j) => discoveryFactsFrom(j));
    assert.ok(parseAuthServerMetadata(first), `${e.id}: the engine cannot parse its own fixture`);
  }
  assert.ok(live >= 60, `expected a substantial live-verified set, got ${live}`);
});

test("the matrix summary is internally consistent and mock/unverified rows never claim a fixture they lack", () => {
  const sum = summarizeMatrix();
  assert.equal(sum.total, OAUTH_MATRIX.length);
  assert.equal(Object.values(sum.byClass).reduce((a, b) => a + b, 0), sum.total);
  assert.equal(Object.values(sum.byVerification).reduce((a, b) => a + b, 0), sum.total);
  for (const e of OAUTH_MATRIX) if (e.verification !== "LIVE-VERIFIED") assert.ok(!e.facts, `${e.id} has facts but is not LIVE`);
});

test("the services the owner named are OAuth, not tokens", () => {
  for (const id of ["github", "vercel", "instagram", "google", "outlook", "slack", "linear", "notion", "stripe", "supabase"]) {
    const s = CONNECT_SERVICES.find((x) => x.id === id);
    assert.ok(s, id);
    assert.ok(s.kind === "mcp-oauth" || s.kind === "oauth-app", `${id} is ${s.kind}`);
  }
  assert.equal(matrixFor("github").class, "d");
  assert.equal(matrixFor("vercel").allowlist, true);
  assert.equal(CONNECT_SERVICES.find((s) => s.id === "instagram").kind, "oauth-app");
  assert.ok(CONNECT_SERVICES.find((s) => s.id === "instagram").browserFallback, "the browser session is only an experimental fallback");
});
