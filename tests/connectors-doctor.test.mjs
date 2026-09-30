// The connector doctor, its probes, the stdio-client framing fix, the stdio
// catalog and the health monitor — against FAKE servers only (no network, no
// third-party packages). Pins:
//   1. probeStdioServer: clean handshake (ndjson + legacy Content-Length),
//      stdout noise tolerated, crash / hang / garbage / stdin-prompt /
//      missing-credential / npm-404 / zero-tools / exits-mid-handshake, and
//      server-initiated requests answered;
//   2. timeouts are enforced and the child is REAPED;
//   3. classification (stdio, remote, verifier errors, combine);
//   4. runDoctor: bounded parallelism, offline mode, report shape, secrets
//      never appear in the JSON;
//   5. the real stdio client (@ares/tools Mcp) speaks NDJSON — the bug that
//      made every stdio connector hang — plus envVault / ${VAULT:} / minimal env;
//   6. stdio catalog: lint, install (no secrets on disk), uninstall, hub service shape;
//   7. health: states, min-age gating, change callback, monitor scheduling,
//      kill switch.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  probeStdioServer,
  probeRemoteMcp,
  scrubSecrets,
} from "../packages/cli/dist/mcpProbe.js";
import {
  classifyStdioProbe,
  classifyRemoteProbe,
  classifyVerifierError,
  combineVerdicts,
  lintCatalogs,
  runDoctor,
  listInventory,
  scrubReport,
} from "../packages/cli/dist/connectorsDoctor.js";
import {
  connectorHealth,
  connectorHealthAll,
  healthFilePath,
  readHealthFile,
  runConnectorHealthCheck,
  startConnectorHealthMonitor,
  stateForVerdict,
} from "../packages/cli/dist/connectorHealth.js";
import { stdioVerifier } from "../packages/cli/dist/connectVerifiersStdio.js";
import {
  MCP_STDIO_CATALOG,
  MCP_CATALOG,
  CONNECT_SERVICES,
  installStdioConnector,
  uninstallStdioConnector,
  stdioConnectService,
  stdioMarkerCredential,
  stdioFieldCredential,
  resolveStdioValues,
  renderStdioArgs,
  stdioEntryById,
  setCredential,
} from "../packages/core/dist/index.js";
import { listMcpServerToolsFull } from "../packages/tools/dist/index.js";

// ─── Fake MCP server ─────────────────────────────────────────────────────────

const FAKE = `
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
const rest = process.argv.slice(3);
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const cl = mode === "ok-cl";
const send = (msg) => {
  const text = JSON.stringify({ jsonrpc: "2.0", ...msg });
  if (cl) process.stdout.write("Content-Length: " + Buffer.byteLength(text) + "\\r\\n\\r\\n" + text);
  else process.stdout.write(text + "\\n");
};
if (mode === "crash") { console.error("boom: Segmentation fault (core dumped)"); process.exit(1); }
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "garbage") { process.stdout.write("this is not json\\n<<<<>>>>\\nlistening on :8080\\n"); setInterval(() => {}, 1000); }
else if (mode === "prompt") { console.error("Enter your API key: "); process.stdin.resume(); }
else if (mode === "nocred") { console.error("Error: API_KEY environment variable is required"); process.exit(2); }
else if (mode === "e404") { console.error("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/@gone/pkg - Not found"); process.exit(1); }
else if (mode === "leak") { console.error("fatal: token " + (process.env.SECRET_TOKEN || "none") + " rejected by upstream"); process.exit(1); }
else if (mode === "nodever") { console.error("error: Unsupported engine { required: { node: '>=99' } }"); process.exit(1); }
if (["ok","ok-cl","noisy","empty","ping","paged","exit-mid","slowok","envdump","fail-tools","argdump"].includes(mode)) {
  if (mode === "noisy") { console.log("=== Fake server v1 starting ==="); console.log("[info] ready"); }
  let buf = Buffer.alloc(0);
  const handle = (m) => {
    if (m.method === "initialize") {
      const reply = () => send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "9.9" } } });
      if (mode === "slowok") setTimeout(reply, 400); else reply();
      return;
    }
    if (m.method === "tools/list") {
      if (mode === "exit-mid") process.exit(3);
      if (mode === "fail-tools") return send({ id: m.id, error: { code: -32000, message: "tool registry unavailable" } });
      if (mode === "empty") return send({ id: m.id, result: { tools: [] } });
      if (mode === "paged") return send({ id: m.id, result: m.params && m.params.cursor ? { tools: [{ name: "p2" }] } : { tools: [{ name: "p1a" }, { name: "p1b" }], nextCursor: "c2" } });
      if (mode === "envdump") return send({ id: m.id, result: { tools: [
        { name: "env:" + (process.env.FAKE_TOKEN || "unset") },
        { name: "parent:" + (process.env.ARES_TEST_PARENT_SECRET ? "visible" : "hidden") },
        { name: "arg:" + (rest[0] || "none") },
      ] } });
      if (mode === "argdump") return send({ id: m.id, result: { tools: [{ name: "arg:" + (rest[0] || "none") }] } });
      if (mode === "ping") { if (pingAnswered) return send({ id: m.id, result: { tools: [{ name: "after-ping" }] } }); pendingToolsId = m.id; return; }
      return send({ id: m.id, result: { tools: [{ name: "alpha", description: "a" }, { name: "beta", description: "b" }] } });
    }
  };
  let pingAnswered = false, pendingToolsId = null;
  if (mode === "ping") send({ id: 900, method: "ping" });
  const onFrame = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; }
    if (mode === "ping" && m.id === 900 && !m.method) { pingAnswered = true; if (pendingToolsId !== null) send({ id: pendingToolsId, result: { tools: [{ name: "after-ping" }] } }); return; }
    handle(m); };
  process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const head = buf.subarray(0, 15).toString("latin1");
      if (/^content-length:/i.test(head)) {
        const he = buf.indexOf("\\r\\n\\r\\n"); if (he < 0) return;
        const len = Number(/Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, he).toString())[1]);
        if (buf.length < he + 4 + len) return;
        const body = buf.subarray(he + 4, he + 4 + len).toString(); buf = buf.subarray(he + 4 + len); onFrame(body); continue;
      }
      const nl = buf.indexOf(10); if (nl < 0) return;
      const line = buf.subarray(0, nl).toString().trim(); buf = buf.subarray(nl + 1); if (line.startsWith("{")) onFrame(line);
    }
  });
}
`;

const root = mkdtempSync(path.join(os.tmpdir(), "ares-doctor-test-"));
const fakePath = path.join(root, "fake-mcp.mjs");
writeFileSync(fakePath, FAKE);
process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

let scratchSeq = 0;
function scratch() {
  const d = path.join(root, `s${++scratchSeq}`);
  mkdirSync(d, { recursive: true });
  return d;
}
const probe = (mode, extra = {}, opts = {}) =>
  probeStdioServer({ command: "node", args: [fakePath, mode, ...(extra.args ?? [])], env: extra.env }, { scratchDir: scratch(), timeoutMs: 6000, ...opts });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── 1. probeStdioServer ─────────────────────────────────────────────────────

test("clean NDJSON server: handshake, tool names, latency, framing", async () => {
  const r = await probe("ok");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.toolCount, 2);
  assert.deepEqual(r.toolNames, ["alpha", "beta"]);
  assert.equal(r.serverName, "fake");
  assert.equal(r.framing, "ndjson");
  assert.ok(r.latencyMs >= 0 && r.initializeMs >= 0);
});

test("legacy Content-Length server still works", async () => {
  const r = await probe("ok-cl");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.framing, "content-length");
  assert.equal(r.toolCount, 2);
});

test("stdout noise is tolerated and counted", async () => {
  const r = await probe("noisy");
  assert.equal(r.ok, true);
  assert.ok(r.stdoutNoiseLines >= 2, `noise lines: ${r.stdoutNoiseLines}`);
});

test("paged tools/list is followed to the end", async () => {
  const r = await probe("paged");
  assert.equal(r.ok, true);
  assert.deepEqual(r.toolNames, ["p1a", "p1b", "p2"]);
});

test("server-initiated ping is answered (server would otherwise block)", async () => {
  const r = await probe("ping");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.toolNames, ["after-ping"]);
});

test("crash at startup: exited, stderr captured", async () => {
  const r = await probe("crash");
  assert.equal(r.ok, false);
  assert.equal(r.failure, "exited");
  assert.equal(r.exitCode, 1);
  assert.match(r.stderrTail, /Segmentation fault/);
  assert.equal(classifyStdioProbe(r, { needsCredentials: false, timeoutMs: 6000 }).verdict, "broken");
});

test("exits between initialize and tools/list", async () => {
  const r = await probe("exit-mid");
  assert.equal(r.ok, false);
  assert.equal(r.failure, "exited");
  assert.equal(r.exitCode, 3);
});

test("tools/list error is an rpc failure", async () => {
  const r = await probe("fail-tools");
  assert.equal(r.ok, false);
  assert.equal(r.failure, "rpc-error");
  assert.match(r.error, /tool registry unavailable/);
});

test("missing command is a clear spawn error", async () => {
  const r = await probeStdioServer({ command: "definitely-not-a-real-binary-xyz", args: [] }, { scratchDir: scratch(), timeoutMs: 4000 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, "spawn-error");
  assert.match(r.error, /command not found/);
});

test("hang: enforced timeout, no reply, child reaped", async () => {
  const pidFile = path.join(root, "hang.pid");
  const t0 = Date.now();
  const r = await probe("hang", { env: { FAKE_PID_FILE: pidFile } }, { timeoutMs: 900 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, "no-response");
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  await sleep(1800);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(alive(pid), false, "the hung server was killed");
});

test("garbage-only stdout never produces a handshake", async () => {
  const r = await probe("garbage", {}, { timeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.ok(r.stdoutNoiseLines >= 2);
});

test("a server that demands stdin input is classified as blocking on a prompt", async () => {
  const r = await probe("prompt", {}, { timeoutMs: 700 });
  assert.equal(r.ok, false);
  const c = classifyStdioProbe(r, { needsCredentials: false, timeoutMs: 700 });
  assert.equal(c.verdict, "broken");
  assert.match(c.reason, /interactive prompt/);
});

test("exit non-zero with a missing-credential message", async () => {
  const r = await probe("nocred");
  assert.equal(r.ok, false);
  const gated = classifyStdioProbe(r, { needsCredentials: true, timeoutMs: 6000 });
  assert.equal(gated.verdict, "works-needs-credentials");
  assert.match(gated.reason, /API_KEY/);
  // the same crash from a server that claims to need nothing is a real failure
  assert.equal(classifyStdioProbe(r, { needsCredentials: false, timeoutMs: 6000 }).verdict, "broken");
});

test("npm 404 and node-version errors are named, not generic crashes", async () => {
  const a = classifyStdioProbe(await probe("e404"), { needsCredentials: false, timeoutMs: 6000 });
  assert.equal(a.verdict, "broken");
  assert.match(a.reason, /package not found/);
  const b = classifyStdioProbe(await probe("nodever"), { needsCredentials: false, timeoutMs: 6000 });
  assert.equal(b.verdict, "broken");
  assert.match(b.reason, /version/);
});

test("zero tools is degraded, real tools are working / works-needs-credentials", async () => {
  const empty = classifyStdioProbe(await probe("empty"), { needsCredentials: false, timeoutMs: 6000 });
  assert.equal(empty.verdict, "degraded");
  const ok = await probe("ok");
  assert.equal(classifyStdioProbe(ok, { needsCredentials: false, timeoutMs: 6000 }).verdict, "working");
  assert.equal(classifyStdioProbe(ok, { needsCredentials: true, timeoutMs: 6000 }).verdict, "works-needs-credentials");
});

test("the probe environment is isolated: HOME points into the scratch dir", async () => {
  const dir = scratch();
  process.env.ARES_TEST_PARENT_SECRET = "must-not-leak-1234";
  const r = await probeStdioServer(
    { command: "node", args: ["-e", `console.error("HOME=" + process.env.HOME + " PARENT=" + (process.env.ARES_TEST_PARENT_SECRET||"none")); process.exit(1)`] },
    { scratchDir: dir, timeoutMs: 4000 },
  );
  delete process.env.ARES_TEST_PARENT_SECRET;
  assert.ok(r.stderrTail.includes(`HOME=${path.join(dir, "home")}`), r.stderrTail);
  assert.ok(r.stderrTail.includes("PARENT=none"));
});

// ─── 2. scrubbing ────────────────────────────────────────────────────────────

test("scrubSecrets redacts token shapes, query secrets, userinfo and literals", () => {
  const raw = [
    "Authorization: Bearer abcdefghijklmnop1234",
    "key sk-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz0123 and xoxb-1234567890-abcdef",
    "https://x.test/cb?api_key=SuperSecretValue&ok=1",
    "postgresql://admin:hunter2pass@db.internal:5432/app",
    "custom literal my-very-own-secret here",
  ].join("\n");
  const out = scrubSecrets(raw, ["my-very-own-secret"]);
  for (const leaked of ["abcdefghijklmnop1234", "sk-abcdefghijklmnopqrstu", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdef", "SuperSecretValue", "hunter2pass", "my-very-own-secret"]) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}\n${out}`);
  }
  assert.ok(out.includes("ok=1"));
  assert.ok(out.includes("@db.internal"));
});

test("scrubReport walks nested values", () => {
  const out = scrubReport({ a: ["Bearer zzzzzzzzzzzzzzzz"], b: { c: "tok-literal-value-99" } }, ["tok-literal-value-99"]);
  assert.ok(!JSON.stringify(out).includes("zzzzzzzzzzzzzzzz"));
  assert.ok(!JSON.stringify(out).includes("tok-literal-value-99"));
});

// ─── 3. classification ───────────────────────────────────────────────────────

test("classifyRemoteProbe", () => {
  const c = (p, auth) => classifyRemoteProbe({ latencyMs: 5, ...p }, { auth }).verdict;
  assert.equal(c({ kind: "ok", toolCount: 3 }, "none"), "working");
  assert.equal(c({ kind: "auth-required", status: 401, wwwAuthenticate: "Bearer", oauth: { resourceMetadata: true, registrationEndpoint: true } }, "oauth"), "works-needs-credentials");
  assert.equal(c({ kind: "auth-required", status: 401 }, "none"), "broken");
  assert.equal(c({ kind: "auth-required", status: 401, oauth: { resourceMetadata: true, authorizationServer: "https://as", registrationEndpoint: false } }, "oauth"), "degraded");
  assert.equal(c({ kind: "auth-required", status: 401, oauth: { resourceMetadata: false } }, "oauth"), "degraded");
  assert.equal(c({ kind: "auth-required", status: 401 }, "key"), "works-needs-credentials");
  assert.equal(c({ kind: "not-found", status: 404 }, "none"), "broken");
  assert.equal(c({ kind: "network", error: "ENOTFOUND" }, "oauth"), "broken");
  assert.equal(c({ kind: "server-error", status: 503 }, "oauth"), "degraded");
  assert.equal(c({ kind: "timeout" }, "oauth"), "degraded");
  assert.equal(c({ kind: "protocol", status: 200 }, "none"), "degraded");
  assert.equal(c({ kind: "sse-open" }, "oauth"), "works-needs-credentials");
});

test("classifyVerifierError: alive+gate vs dead vs flaky", () => {
  assert.equal(classifyVerifierError("Tessie doesn't recognise that key").verdict, "works-needs-credentials");
  assert.equal(classifyVerifierError("the SID and token don't match").verdict, "works-needs-credentials");
  assert.equal(classifyVerifierError("Twilio answered HTTP 404").verdict, "broken");
  assert.equal(classifyVerifierError("fetch failed").verdict, "broken");
  assert.equal(classifyVerifierError("Duffel answered HTTP 503").verdict, "degraded");
  assert.equal(classifyVerifierError("Foo answered HTTP 418").verdict, "works-needs-credentials");
  assert.equal(classifyVerifierError("kaboom").verdict, "degraded");
});

test("combineVerdicts: all = worst, any = best", () => {
  assert.equal(combineVerdicts(["working", "broken"], "all"), "broken");
  assert.equal(combineVerdicts(["working", "broken"], "any"), "working");
  assert.equal(combineVerdicts(["works-needs-credentials", "degraded"], "all"), "degraded");
  assert.equal(combineVerdicts([], "all"), "unverifiable");
});

// ─── probeRemoteMcp with a fake fetch ────────────────────────────────────────

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("probeRemoteMcp: open server, 401 with OAuth metadata, 404, network error", async () => {
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://open.example/mcp") {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "open" } } });
      if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
      return new Response("", { status: 202 });
    }
    if (u === "https://oauth.example/mcp") return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://oauth.example/.well-known/oauth-protected-resource"' } });
    if (u === "https://oauth.example/.well-known/oauth-protected-resource") return json({ resource: "https://oauth.example/mcp", authorization_servers: ["https://auth.example"] });
    if (u === "https://auth.example/.well-known/oauth-authorization-server") return json({ registration_endpoint: "https://auth.example/register", code_challenge_methods_supported: ["S256"] });
    if (u === "https://gone.example/mcp") return new Response("nope", { status: 404 });
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND down.example" } });
  };
  const open = await probeRemoteMcp("https://open.example/mcp", { fetchImpl });
  assert.equal(open.kind, "ok");
  assert.equal(open.toolCount, 3);
  assert.equal(open.serverName, "open");
  const oauth = await probeRemoteMcp("https://oauth.example/mcp", { fetchImpl });
  assert.equal(oauth.kind, "auth-required");
  assert.equal(oauth.oauth.resourceMetadata, true);
  assert.equal(oauth.oauth.registrationEndpoint, true);
  assert.equal(oauth.oauth.pkce, true);
  assert.equal((await probeRemoteMcp("https://gone.example/mcp", { fetchImpl })).kind, "not-found");
  const down = await probeRemoteMcp("https://down.example/mcp", { fetchImpl });
  assert.equal(down.kind, "network");
  assert.match(down.error, /ENOTFOUND/);
});

test("probeRemoteMcp: a 405 on POST falls back to the SSE stream", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") return new Response("", { status: 405 });
    return new Response("event: endpoint\ndata: /messages?x=1\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const r = await probeRemoteMcp("https://sse.example/sse", { fetchImpl, transport: "auto" });
  assert.equal(r.kind, "sse-open");
});

// ─── 4. runDoctor ────────────────────────────────────────────────────────────

function stdioEntry(id, mode, extra = {}) {
  return {
    id,
    name: `Fake ${id}`,
    category: "dev",
    blurb: "fake",
    keywords: [id],
    runtime: "npx",
    command: "node",
    args: [fakePath, mode, ...(extra.args ?? [])],
    cost: "free",
    ...extra.entry,
  };
}

test("runDoctor: report shape, verdict counts, evidence, per-kind totals", async () => {
  const report = await runDoctor({
    kinds: ["mcp-stdio"],
    includeConfigured: false,
    stdioTimeoutMs: 2500,
    scratchParent: root,
    catalogs: {
      remote: [],
      services: [],
      stdio: [
        stdioEntry("good", "ok"),
        stdioEntry("crashy", "crash"),
        stdioEntry("hangy", "hang"),
        stdioEntry("keyed", "nocred", { entry: { cost: "free-tier", fields: [{ name: "k", label: "Key", target: { env: "API_KEY" }, secret: true, probe: "placeholder-key-0000000" }] } }),
        stdioEntry("norun", "ok", { entry: { command: "no-such-runtime-binary-zz" } }),
      ],
    },
  });
  assert.equal(report.schema, "ares.connectors.doctor/1");
  assert.equal(report.offline, false);
  assert.equal(report.totals.total, 5);
  const v = Object.fromEntries(report.results.map((r) => [r.id, r.verdict]));
  assert.deepEqual(v, {
    "stdio:crashy": "broken",
    "stdio:good": "working",
    "stdio:hangy": "broken",
    "stdio:keyed": "works-needs-credentials",
    "stdio:norun": "unverifiable",
  });
  assert.deepEqual(report.totals.byVerdict, { working: 1, "works-needs-credentials": 1, degraded: 0, broken: 2, unverifiable: 1 });
  assert.equal(report.totals.byKind["mcp-stdio"].broken, 2);
  const good = report.results.find((r) => r.id === "stdio:good");
  assert.equal(good.evidence.toolCount, 2);
  assert.match(good.evidence.command, /fake-mcp\.mjs ok/);
  assert.ok(good.durationMs >= 0 && typeof good.free === "string" && good.kind === "mcp-stdio");
  const crash = report.results.find((r) => r.id === "stdio:crashy");
  assert.match(crash.evidence.firstError, /Segmentation fault/);
  assert.ok(report.host.runtimes.git !== undefined);
  // the whole report is plain JSON
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test("runDoctor: stdio parallelism never exceeds the bound (and does reach it)", async () => {
  const entries = Array.from({ length: 6 }, (_, i) => stdioEntry(`slow${i}`, "slowok"));
  const report = await runDoctor({ kinds: ["mcp-stdio"], includeConfigured: false, stdioConcurrency: 2, stdioTimeoutMs: 8000, scratchParent: root, catalogs: { remote: [], services: [], stdio: entries } });
  assert.equal(report.results.every((r) => r.verdict === "working"), true);
  assert.equal(report.peak.stdio, 2);
});

test("runDoctor: network parallelism is bounded too", async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(30);
    active--;
    return new Response("nope", { status: 404 });
  };
  const remote = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, url: `https://r${i}.example/mcp`, auth: "none", transport: "http", category: "dev", blurb: "x", keywords: ["x"] }));
  const report = await runDoctor({ kinds: ["mcp-remote"], includeConfigured: false, concurrency: 3, fetchImpl, scratchParent: root, catalogs: { remote, stdio: [], services: [] } });
  assert.equal(report.totals.total, 10);
  assert.ok(report.results.every((r) => r.verdict === "broken"));
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.ok(peak >= 2, `peak ${peak} (never ran in parallel)`);
});

test("runDoctor: remote classification end to end with a fake fetch; --only filters", async () => {
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://good.example")) {
      const m = JSON.parse(init.body ?? "{}").method;
      return m === "tools/list" ? json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t" }] } }) : json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "g" } } });
    }
    if (u.startsWith("https://gated.example")) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } });
    return new Response("", { status: 404 });
  };
  const remote = [
    { id: "good", name: "Good", url: "https://good.example/mcp", auth: "none", transport: "http", category: "dev", blurb: "x", keywords: ["x"] },
    { id: "gated", name: "Gated", url: "https://gated.example/mcp", auth: "key", transport: "http", category: "dev", blurb: "x", keywords: ["x"], keyUrl: "https://k" },
    { id: "moved", name: "Moved", url: "https://moved.example/mcp", auth: "oauth", transport: "http", category: "dev", blurb: "x", keywords: ["x"] },
  ];
  const all = await runDoctor({ kinds: ["mcp-remote"], includeConfigured: false, fetchImpl, scratchParent: root, catalogs: { remote, stdio: [], services: [] } });
  const v = Object.fromEntries(all.results.map((r) => [r.id, r.verdict]));
  assert.deepEqual(v, { gated: "works-needs-credentials", good: "working", moved: "broken" });
  const one = await runDoctor({ only: ["gated"], kinds: ["mcp-remote"], includeConfigured: false, fetchImpl, scratchParent: root, catalogs: { remote, stdio: [], services: [] } });
  assert.deepEqual(one.results.map((r) => r.id), ["gated"]);
});

test("runDoctor --offline never touches the network", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("", { status: 200 }); };
  const remote = [{ id: "x", name: "X", url: "https://x.example/mcp", auth: "none", transport: "http", category: "dev", blurb: "x", keywords: ["x"] }];
  const report = await runDoctor({ offline: true, kinds: ["mcp-remote", "mcp-stdio"], includeConfigured: false, fetchImpl, scratchParent: root, catalogs: { remote, stdio: [stdioEntry("s", "ok")], services: [] } });
  assert.equal(calls, 0);
  assert.equal(report.offline, true);
  assert.ok(report.results.every((r) => r.verdict === "unverifiable" && /offline/.test(r.reason)));
});

test("runDoctor never lets a secret reach the report, even one a server prints", async () => {
  const secret = "sk-probe-secret-abcdef1234567890";
  const report = await runDoctor({
    kinds: ["mcp-stdio"],
    includeConfigured: false,
    stdioTimeoutMs: 3000,
    scratchParent: root,
    catalogs: {
      remote: [],
      services: [],
      stdio: [stdioEntry("leaky", "leak", { entry: { cost: "free-tier", fields: [{ name: "t", label: "Token", target: { env: "SECRET_TOKEN" }, secret: true, probe: secret }] } })],
    },
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes(secret), "secret leaked into the report");
  assert.ok(text.includes("[redacted]"));
  assert.equal(report.results[0].verdict, "works-needs-credentials");
});

test("runDoctor removes its scratch directory", async () => {
  const parent = path.join(root, "scratch-parent");
  mkdirSync(parent, { recursive: true });
  await runDoctor({ kinds: ["mcp-stdio"], includeConfigured: false, scratchParent: parent, catalogs: { remote: [], services: [], stdio: [stdioEntry("good", "ok")] } });
  assert.deepEqual(readdirSafe(parent), []);
});

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

test("inventory lists every kind with free/auth labels (no probes run)", async () => {
  const inv = await listInventory({ includeConfigured: false });
  const kinds = new Set(inv.map((e) => e.kind));
  for (const k of ["mcp-remote", "mcp-stdio", "oauth-app", "api-key", "browser-session", "upstream", "channel", "remote-pc", "runtime", "tool"]) assert.ok(kinds.has(k), `missing kind ${k}`);
  assert.ok(inv.length > 120);
  assert.equal(new Set(inv.map((e) => e.id)).size, inv.length, "inventory ids are unique");
  for (const e of inv) {
    assert.ok(e.id && e.name && e.kind && e.free && e.auth && e.launch?.transport, `bad entry ${JSON.stringify(e)}`);
    assert.equal(typeof e.needsCredentials, "boolean");
  }
  const tool = inv.find((e) => e.id === "tool:Gmail");
  assert.deepEqual(tool.dependsOn, ["google"]);
});

// ─── 5. The real stdio client speaks NDJSON (the framing bug) ────────────────

async function withHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-doctor-home-"));
  const prev = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("Mcp stdio client: talks NDJSON to a standard server and lists its tools", async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { fake: { command: "node", args: [fakePath, "noisy"] } } }));
    const tools = await listMcpServerToolsFull(home, "fake", 8000);
    assert.deepEqual(tools.map((t) => t.name), ["alpha", "beta"]);
  });
});

test("Mcp stdio client: still works against a legacy Content-Length server", async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { legacy: { command: "node", args: [fakePath, "ok-cl"] } } }));
    const tools = await listMcpServerToolsFull(home, "legacy", 8000);
    assert.equal(tools.length, 2);
  });
});

test("Mcp stdio client: a server that dies mid-handshake fails fast with its reason", async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { dying: { command: "node", args: [fakePath, "crash"] } } }));
    const t0 = Date.now();
    await assert.rejects(listMcpServerToolsFull(home, "dying", 15000), /exited|Segmentation/);
    assert.ok(Date.now() - t0 < 8000, "did not wait out the 15s timeout");
  });
});

test("Mcp stdio client: catalog servers get a minimal env, vault env and vault args", async () => {
  await withHome(async (home) => {
    await setCredential("mcp.stdio.fake.token", "vault-held-token-777");
    await setCredential("mcp.stdio.fake.dir", "/from/the/vault");
    process.env.ARES_TEST_PARENT_SECRET = "parent-secret-9999";
    try {
      writeFileSync(path.join(home, "mcp.json"), JSON.stringify({
        servers: {
          fake: { command: "node", args: [fakePath, "envdump", "${VAULT:mcp.stdio.fake.dir}"], envVault: { FAKE_TOKEN: "mcp.stdio.fake.token" }, stdioCatalog: "fake" },
          handwritten: { command: "node", args: [fakePath, "envdump", "plain"] },
        },
      }));
      const cat = (await listMcpServerToolsFull(home, "fake", 8000)).map((t) => t.name);
      assert.deepEqual(cat, ["env:vault-held-token-777", "parent:hidden", "arg:/from/the/vault"]);
      // hand-authored entries keep the historical full environment
      const hand = (await listMcpServerToolsFull(home, "handwritten", 8000)).map((t) => t.name);
      assert.ok(hand.includes("parent:visible"));
    } finally {
      delete process.env.ARES_TEST_PARENT_SECRET;
    }
  });
});

test("Mcp stdio client: a missing vault arg is a clear error, not a blind launch", async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { fake: { command: "node", args: [fakePath, "argdump", "${VAULT:mcp.stdio.nothing.here}"], stdioCatalog: "fake" } } }));
    await assert.rejects(listMcpServerToolsFull(home, "fake", 5000), /missing from the vault/);
  });
});

// ─── 6. The stdio catalog ────────────────────────────────────────────────────

test("the shipped catalogs pass the lint and ids are unique across the hub", () => {
  assert.deepEqual(lintCatalogs(), []);
  const ids = CONNECT_SERVICES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(MCP_STDIO_CATALOG.length >= 20);
});

test("lintCatalogs flags broken entries", () => {
  const bad = lintCatalogs({
    remote: [{ id: "k", name: "K", url: "http://plain.example", auth: "key", transport: "http", category: "dev", blurb: "b", keywords: [] }],
    stdio: [{ id: "s", name: "S", category: "dev", blurb: "b", keywords: ["s"], runtime: "npx", command: "npx", args: ["-y", "x", "{nope}"], cost: "free-tier" }],
    services: [{ id: "a", label: "A", kind: "api-key", blurb: "b", keywords: ["a"], howToUse: "h" }, { id: "a", label: "A", kind: "api-key", blurb: "b", keywords: ["a"], howToUse: "h" }],
  });
  const text = bad.join("\n");
  assert.match(text, /not https/);
  assert.match(text, /no keyUrl/);
  assert.match(text, /no keywords/);
  assert.match(text, /\{nope\} has no matching field/);
  assert.match(text, /duplicate connect-service id "a"/);
  assert.match(text, /not free but names no docs/);
});

test("stdio catalog: free/needs-key labels are accurate for known entries", () => {
  assert.equal(stdioEntryById("filesystem").cost, "free");
  assert.equal(stdioEntryById("memory").cost, "free");
  assert.equal(stdioEntryById("duckduckgo").cost, "free");
  assert.equal(stdioEntryById("brave-search").cost, "free-tier");
  assert.equal(stdioEntryById("slack-bot").cost, "needs-account");
  for (const e of MCP_STDIO_CATALOG) {
    for (const f of e.fields ?? []) {
      if ("env" in f.target && /TOKEN|KEY|SECRET|CONNECTION/.test(f.target.env)) assert.equal(f.secret, true, `${e.id}.${f.name} holds a secret but is not marked secret`);
    }
  }
});

test("renderStdioArgs + resolveStdioValues split secrets from literals", () => {
  const pg = stdioEntryById("postgres");
  assert.deepEqual(renderStdioArgs(pg, { url: "postgresql://u:p@h/db" }), ["-y", "@modelcontextprotocol/server-postgres", "postgresql://u:p@h/db"]);
  const slack = stdioEntryById("slack-bot");
  const r = resolveStdioValues(slack, { token: "xoxb-1", team: "T1" });
  assert.deepEqual(r.envVault, { SLACK_BOT_TOKEN: "mcp.stdio.slack-bot.token" });
  assert.deepEqual(r.env, { SLACK_TEAM_ID: "T1" });
  assert.deepEqual(resolveStdioValues(slack, { token: "" }).missing, ["Bot token", "Team ID"]);
});

test("installStdioConnector writes no secret to mcp.json; uninstall removes only catalog entries", async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { mine: { command: "node", args: ["x.js"] } } }));
    const slack = stdioEntryById("slack-bot");
    await installStdioConnector(slack, { token: "xoxb-very-secret-token", team: "T999" }, home);
    const pg = stdioEntryById("postgres");
    await installStdioConnector(pg, { url: "postgresql://admin:hunter2@db/app" }, home);
    const raw = readFileSync(path.join(home, "mcp.json"), "utf8");
    assert.ok(!raw.includes("xoxb-very-secret-token"), "token on disk");
    assert.ok(!raw.includes("hunter2"), "connection string on disk");
    const doc = JSON.parse(raw);
    assert.deepEqual(doc.servers.mine, { command: "node", args: ["x.js"] }, "other entries untouched");
    assert.equal(doc.servers["slack-bot"].env.SLACK_TEAM_ID, "T999");
    assert.equal(doc.servers["slack-bot"].envVault.SLACK_BOT_TOKEN, "mcp.stdio.slack-bot.token");
    assert.equal(doc.servers.postgres.args[2], "${VAULT:mcp.stdio.postgres.url}");
    assert.equal(doc.servers.postgres.stdioCatalog, "postgres");
    assert.equal(await uninstallStdioConnector("postgres", home), true);
    assert.equal(await uninstallStdioConnector("mine", home), false, "hand-authored entries are not catalog entries");
    assert.equal(await uninstallStdioConnector("postgres", home), false);
    const after = JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8"));
    assert.ok(after.servers.mine && after.servers["slack-bot"] && !after.servers.postgres);
  });
});

test("stdioConnectService: one secure form (or one tap), marker credential, honest cost", () => {
  const s = stdioConnectService(stdioEntryById("slack-bot"));
  assert.equal(s.kind, "api-key");
  assert.deepEqual(s.fields.map((f) => f.credential), ["mcp.stdio.slack-bot.token", "mcp.stdio.slack-bot.team"]);
  assert.equal(s.fields[0].secret, true);
  assert.deepEqual(s.stores, [stdioMarkerCredential("slack-bot")]);
  assert.match(s.blurb, /existing account/);
  const free = stdioConnectService(stdioEntryById("memory"));
  assert.equal(free.fields, undefined);
  assert.match(free.formHint, /Tap Connect/);
  assert.match(free.blurb, /no account/);
});

test("hub verifier: launches the server, registers it, stores the marker; failure throws", async () => {
  await withHome(async (home) => {
    const entry = {
      id: "fake-good", name: "Fake good", category: "dev", blurb: "b", keywords: ["fg"], runtime: "npx", command: "node",
      args: [fakePath, "ok", "{dir}"], cost: "free",
      fields: [{ name: "dir", label: "Folder", target: { arg: "dir" }, probe: "{scratch}/d" }],
    };
    const verify = stdioVerifier(entry, home);
    const dir = mkdtempSync(path.join(os.tmpdir(), "ares-verify-dir-"));
    const out = await verify({ [stdioFieldCredential(entry, entry.fields[0])]: dir }, AbortSignal.timeout(20000));
    assert.match(out.detail, /2 tools/);
    assert.ok(out.store[stdioMarkerCredential("fake-good")]);
    assert.equal(out.store[stdioFieldCredential(entry, entry.fields[0])], dir);
    const doc = JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8"));
    assert.equal(doc.servers["fake-good"].args[2], dir);
    // missing field
    await assert.rejects(verify({}, AbortSignal.timeout(2000)), /required/);
    // a relative path is refused
    await assert.rejects(verify({ [stdioFieldCredential(entry, entry.fields[0])]: "relative/dir" }, AbortSignal.timeout(2000)), /absolute path/);
    // a server that crashes is not registered
    const bad = { ...entry, id: "fake-bad", args: [fakePath, "crash", "{dir}"] };
    await assert.rejects(stdioVerifier(bad, home)({ [stdioFieldCredential(bad, bad.fields[0])]: dir }, AbortSignal.timeout(20000)), /didn't start/);
    assert.ok(!JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8")).servers["fake-bad"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── 7. Health ───────────────────────────────────────────────────────────────

test("stateForVerdict", () => {
  assert.equal(stateForVerdict("working"), "green");
  assert.equal(stateForVerdict("works-needs-credentials"), "green");
  assert.equal(stateForVerdict("degraded"), "amber");
  assert.equal(stateForVerdict("broken"), "red");
  assert.equal(stateForVerdict("unverifiable"), "grey");
});

test("health: only connected+enabled servers are checked; file, states, min-age gating, change events", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-health-home-"));
  try {
    const cfg = (modes) => ({
      servers: {
        good: { command: "node", args: [fakePath, modes.good] },
        bad: { command: "node", args: [fakePath, "crash"] },
        paused: { command: "node", args: [fakePath, "ok"], enabled: false },
      },
    });
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify(cfg({ good: "ok" })));
    assert.equal((await connectorHealth("good", { home })).state, "grey", "never checked yet");

    const changes = [];
    const file = await runConnectorHealthCheck({ home, force: true, stdioTimeoutMs: 6000, onChange: (id, from, to) => changes.push(`${id}:${from}->${to}`) });
    assert.deepEqual(Object.keys(file.servers).sort(), ["bad", "good"], "the paused server was not spawned");
    assert.ok(existsSync(healthFilePath(home)));
    assert.equal(file.lastRun.checked, 2);

    const good = await connectorHealth("good", { home });
    assert.equal(good.state, "green");
    assert.equal(good.verdict, "working");
    assert.match(good.detail, /Live: 2 tools/);
    assert.equal(good.stale, false);
    const bad = await connectorHealth("bad", { home });
    assert.equal(bad.state, "red");
    assert.match(bad.detail, /^Broken:/);
    assert.deepEqual(changes.sort(), ["bad:grey->red", "good:grey->green"]);

    // a second, non-forced run inside the min age window spawns nothing
    const again = await runConnectorHealthCheck({ home, stdioTimeoutMs: 6000 });
    assert.equal(again.lastRun.checked, 0);
    assert.equal(again.lastRun.skipped, 2);

    // good starts crashing: consecutive failures count up and a change event fires
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { good: { command: "node", args: [fakePath, "crash"] }, bad: { command: "node", args: [fakePath, "crash"] } } }));
    const changes2 = [];
    const after = await runConnectorHealthCheck({ home, force: true, stdioTimeoutMs: 6000, onChange: (id, from, to) => changes2.push(`${id}:${from}->${to}`) });
    assert.deepEqual(changes2, ["good:green->red"]);
    assert.equal(after.servers.bad.consecutiveFailures, 2);
    assert.ok(after.servers.good.lastOkAt, "remembers when it last worked");

    // a server no longer connected loses its dot
    writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ servers: { good: { command: "node", args: [fakePath, "ok"] } } }));
    const pruned = await runConnectorHealthCheck({ home, force: true, stdioTimeoutMs: 6000 });
    assert.deepEqual(Object.keys(pruned.servers), ["good"]);
    assert.equal((await connectorHealthAll({ home })).good.state, "green");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("health: stale records are flagged; unreadable file reads as empty", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-health-stale-"));
  try {
    mkdirSync(path.join(home, "telemetry"), { recursive: true });
    writeFileSync(healthFilePath(home), "{not json");
    assert.equal((await readHealthFile(home)).schema, 1);
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    writeFileSync(healthFilePath(home), JSON.stringify({ schema: 1, updatedAt: old, servers: { s: { id: "s", kind: "mcp-connected", verdict: "working", reason: "ok", checkedAt: old, consecutiveFailures: 0 } }, services: {} }));
    const h = await connectorHealth("s", { home });
    assert.equal(h.state, "green");
    assert.equal(h.stale, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("health monitor: jittered schedule, reschedules after a run, kill switch", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-health-mon-"));
  try {
    const scheduled = [];
    const mon = startConnectorHealthMonitor({
      home,
      intervalMs: 1000,
      jitter: 0.1,
      random: () => 1, // +10%
      initialDelayMs: 5,
      setTimeoutFn: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
      clearTimeoutFn: () => {},
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 5);
    scheduled[0].fn();
    for (let i = 0; i < 100 && scheduled.length < 2; i++) await sleep(20);
    assert.equal(scheduled.length, 2, "rescheduled after the run");
    assert.equal(scheduled[1].ms, 1100, "interval +10% jitter");
    assert.ok(existsSync(healthFilePath(home)), "wrote the health file even with nothing connected");
    mon.stop();

    // owner busy: defers ten minutes, does not run
    const sched2 = [];
    startConnectorHealthMonitor({ home, initialDelayMs: 1, skipWhen: () => true, setTimeoutFn: (fn, ms) => { sched2.push({ fn, ms }); return 1; }, clearTimeoutFn: () => {} });
    sched2[0].fn();
    assert.equal(sched2[1].ms, 10 * 60_000);

    // kill switch
    process.env.ARES_CONNECTOR_HEALTH = "0";
    try {
      const sched3 = [];
      const off = startConnectorHealthMonitor({ home, setTimeoutFn: (fn, ms) => { sched3.push(ms); return 1; } });
      assert.equal(sched3.length, 0);
      off.stop();
    } finally {
      delete process.env.ARES_CONNECTOR_HEALTH;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
