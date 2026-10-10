// Approving from the lock screen: what a banner may offer, what it may say, and
// the HTTP route that answers it. The classifier and the redaction are pure and
// tested as tables; the route is exercised through the real RemoteAgentServer
// over a real SessionManager and a real ApprovalQueue, so the bearer gate, the
// pending list, the idempotency and the "open the app" wall are the production ones.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, ApprovalQueue } from "../packages/garrison/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import {
  classifyApproval,
  classifyStaged,
  approvalSummary,
  approvalLine,
  redactSecrets,
  permissionApprovalId,
  stagedApprovalId,
  parseApprovalId,
  listApprovals,
  respondToApproval,
  createApprovalsApi,
} from "../packages/cli/dist/phoneApprovals.js";
import { PhoneNotifier, PhonePush, APPROVAL_CATEGORY, APPROVAL_STRICT_CATEGORY } from "../packages/cli/dist/phonePush.js";

const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };
const say = (text) => ({ type: "text_delta", text });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await tick(5);
  }
}

// ── the classifier ────────────────────────────────────────────────────────

const gate = (toolName, input, extra = {}) => classifyApproval({ toolName, input, reason: "", ...extra }).gate;

test("classifier: ordinary work gets Allow once, the dangerous few do not", () => {
  // Quick: the owner can say yes from the lock screen.
  assert.equal(gate("Write", { file_path: "/work/app/src/index.ts" }), "quick");
  assert.equal(gate("Edit", { file_path: "/work/app/README.md" }), "quick");
  assert.equal(gate("Bash", { command: "npm test" }), "quick");
  assert.equal(gate("Bash", { command: "ls -la" }), "quick");
  assert.equal(gate("Bash", { command: "git commit -m wip" }), "quick");
  assert.equal(gate("Browser", { action: "navigate", url: "https://example.com" }), "quick");
  assert.equal(gate("SomeBrandNewTool", { anything: 1 }), "quick", "an unclassified tool is benign by the policy table");

  // Strict: Deny and Open only.
  assert.equal(gate("Bash", { command: "rm -rf /home/me/project" }), "strict", "destructive shell");
  assert.equal(gate("Bash", { command: "git push origin main" }), "strict", "git push");
  assert.equal(gate("Bash", { command: "cat ~/.ares/vault/keys" }), "strict", "reading the credential vault");
  assert.equal(gate("Checkout", { merchant: "x", total: 12.5 }), "strict", "money");
  assert.equal(gate("Stripe", { action: "refund" }), "strict", "money");
  assert.equal(gate("Email", { to: "a@b.c", body: "hi" }), "strict", "outbound mail");
  assert.equal(gate("Gmail", { action: "send" }), "strict", "outbound mail");
  assert.equal(gate("Deploy", { target: "prod" }), "strict", "publishing");
  assert.equal(gate("ComputerUse", { action: "click" }), "strict", "driving the real desktop");
  assert.equal(gate("Browser", { action: "login", site: "bank.example" }), "strict", "a vault login");
  assert.equal(gate("Browser", { action: "click", selector: "#buy-now" }, { reason: "Click Buy to submit the order" }), "strict", "a browser submit");
  assert.equal(gate("Phone", { action: "buy_number" }), "strict", "billing the owner");
  assert.equal(gate("mcp_stripe_create_refund", {}), "strict", "an MCP money mover");
  assert.equal(gate("ExitPlanMode", {}), "strict", "the plan crossing is the owner's");
  assert.equal(gate("Write", { file_path: "/home/me/.ares/vault/credentials.json" }), "strict", "a file tool pointed at the vault");
});

test("classifier: a per-call owner decision is strict whatever the tool says", () => {
  assert.equal(gate("Read", { file_path: "/tmp/a" }, { ownerDecision: true }), "strict");
  const c = classifyApproval({ toolName: "Browser", input: { action: "fill_secret" }, reason: "", ownerDecision: true });
  assert.equal(c.gate, "strict");
  assert.equal(c.risk, "high");
});

test("classifier: a credential signal in the reason makes it strict; garbage input fails toward the app", () => {
  assert.equal(gate("Bash", { command: "echo hi" }, { reason: "needs your API key to continue" }), "strict");
  assert.equal(gate("Bash", null), "quick", "no input is not itself dangerous");
  const weird = classifyApproval({ toolName: "Gmail", input: { get action() { throw new Error("boom"); } }, reason: undefined });
  assert.equal(weird.gate, "strict", "a classifier that throws must not hand out an Allow button");
});

test("classifier: risk grades", () => {
  assert.equal(classifyApproval({ toolName: "Read", input: {}, reason: "" }).risk, "low");
  assert.equal(classifyApproval({ toolName: "Bash", input: { command: "make build" }, reason: "" }).risk, "medium");
  assert.equal(classifyApproval({ toolName: "Bash", input: { command: "rm -rf x" }, reason: "" }).risk, "high");
});

test("staged effects: recoverable and ordinary is quick; irreversible or sensitive is strict", () => {
  assert.equal(classifyStaged({ kind: "operator.watcher-execution", domain: "operator", irreversibility: "recoverable" }).gate, "quick");
  assert.equal(classifyStaged({ kind: "browser.submit", domain: "browser", irreversibility: "irreversible" }).gate, "strict");
  assert.equal(classifyStaged({ kind: "send", domain: "email", irreversibility: "recoverable" }).gate, "strict");
  assert.equal(classifyStaged({ kind: "charge", domain: "spend", irreversibility: "reversible" }).gate, "strict");
  assert.equal(classifyStaged({ kind: "x", domain: "mystery", irreversibility: "irreversible" }).gate, "strict");
});

// ── what the banner says ──────────────────────────────────────────────────

test("summary: tool and target, one short line", () => {
  const s = approvalSummary("Bash", { command: "npm   test\n --silent" });
  assert.deepEqual(s, { tool: "Bash", target: "npm test --silent" });
  assert.equal(approvalLine(s), "Bash — npm test --silent");
  assert.equal(approvalLine({ tool: "Bash", target: "" }), "Bash");
  assert.equal(approvalSummary("Write", { file_path: "/a/b.ts" }).target, "/a/b.ts");
  const long = approvalSummary("Bash", { command: "echo " + "x ".repeat(200) });
  assert.ok(long.target.length <= 80, "clipped");
  assert.ok(long.target.endsWith("…"));
  assert.equal(approvalSummary("a".repeat(100), {}).tool.length, 40, "the tool name is clipped too");
});

test("summary: nothing that looks like a secret reaches a lock screen", () => {
  const cases = [
    'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://api.example.com/v1',
    "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz && run",
    "git clone https://user:hunter2hunter2@github.com/o/r.git",
    "psql --password=hunter2 -h db",
    "node app.js --token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "echo aws AKIAABCDEFGHIJKLMNOP",
    "curl https://example.com/hook?key=abc123def456ghi789&sig=zzzzzzzz",
    "TOKEN=abc123 npm run deploy",
    "echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "echo 0123456789abcdef0123456789abcdef0123456789abcdef",
  ];
  for (const command of cases) {
    const { target } = approvalSummary("Bash", { command });
    for (const leak of ["abcdef1234567890abcdef", "sk-abcdefghijklmnop", "hunter2", "ghp_abcdefghijkl", "AKIAABCDEFGHIJKLMNOP", "abc123def456", "eyJhbGciOiJIUzI1NiJ9", "0123456789abcdef0123456789abcdef", "abc123 "]) {
      assert.ok(!target.includes(leak), `leaked ${leak} from: ${command} -> ${target}`);
    }
  }
  // The shape of an ordinary command survives.
  assert.match(approvalSummary("Bash", { command: "curl https://example.com/hook?key=abc123def456ghi789" }).target, /^curl https:\/\/example\.com\/hook\?…$/);
});

test("summary: a credential, a purchase and an owner decision show the tool and nothing else", () => {
  assert.equal(approvalSummary("Bash", { command: "cat ~/.ares/vault/x" }, classifyApproval({ toolName: "Bash", input: { command: "cat ~/.ares/vault/x" }, reason: "" })).target, "");
  const co = { merchant: "acme", url: "https://shop.example/checkout?cart=1" };
  assert.equal(approvalSummary("Checkout", co, classifyApproval({ toolName: "Checkout", input: co, reason: "" })).target, "");
  assert.equal(approvalSummary("Browser", { url: "https://x.example" }, classifyApproval({ toolName: "Browser", input: { action: "fill_secret" }, reason: "", ownerDecision: true })).target, "");
});

test("redactSecrets leaves ordinary text alone", () => {
  assert.equal(redactSecrets("npm run build -- --watch"), "npm run build -- --watch");
  assert.equal(redactSecrets("/home/me/project/src/index.ts"), "/home/me/project/src/index.ts");
});

// ── ids ───────────────────────────────────────────────────────────────────

test("approval ids round-trip, including ids with colons", () => {
  assert.deepEqual(parseApprovalId(permissionApprovalId("sess_1", "perm_a")), { kind: "permission", sessionId: "sess_1", requestId: "perm_a" });
  assert.deepEqual(parseApprovalId(permissionApprovalId("sess:odd", "perm_a")), { kind: "permission", sessionId: "sess:odd", requestId: "perm_a" });
  assert.deepEqual(parseApprovalId(stagedApprovalId("watcher:w1:abc")), { kind: "staged", approvalId: "watcher:w1:abc" });
  for (const bad of [undefined, null, 5, "", "perm:", "perm:onlyone", "perm::x", "stg:", "other:1:2"]) assert.equal(parseApprovalId(bad), null, String(bad));
});

// ── respondToApproval, with fakes ─────────────────────────────────────────

function fakeHost() {
  const pending = [];
  const outcomes = new Map();
  const answered = [];
  const stagedPending = [];
  const stagedOutcomes = new Map();
  const stagedAnswered = [];
  const deps = {
    sessions: {
      pendingPermissionList: () => pending.slice(),
      permissionOutcome: (s, r) => outcomes.get(`${s}|${r}`),
      respondPermission: (s, r, d) => {
        const i = pending.findIndex((p) => p.sessionId === s && p.requestId === r);
        if (i < 0) return false;
        pending.splice(i, 1);
        outcomes.set(`${s}|${r}`, { decision: d, by: "owner", at: 1 });
        answered.push([s, r, d]);
        return true;
      },
    },
    staged: {
      pending: () => stagedPending.slice(),
      outcome: (id) => stagedOutcomes.get(id),
      respond: (d) => {
        const i = stagedPending.findIndex((p) => p.id === d.approvalId);
        if (i < 0) throw new Error("no pending approval");
        stagedPending.splice(i, 1);
        stagedOutcomes.set(d.approvalId, { verb: d.verb, by: "owner", at: 2 });
        stagedAnswered.push(d);
      },
    },
    agentName: (s) => (s === "sess_a" ? "Builder Bob" : "Ares"),
    onResolved: (info) => resolved.push(info),
    log: () => {},
  };
  const resolved = [];
  const ask = (sessionId, requestId, toolName, input, extra = {}) =>
    pending.push({ sessionId, requestId, toolName, input, reason: "", ownerDecision: false, createdAt: 10, expiresAt: 310, ...extra });
  return { deps, ask, answered, resolved, stagedPending, stagedAnswered, outcomes };
}

test("respond: Allow once on a quick request applies, names the tool, and tells the widgets", async () => {
  const h = fakeHost();
  h.ask("sess_a", "perm_1", "Bash", { command: "npm test" });
  const r = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", "perm_1"), decision: "allow_once", via: "notification" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "applied");
  assert.equal(r.body.decision, "allow_once");
  assert.equal(r.body.agent, "Builder Bob");
  assert.equal(r.body.tool, "Bash");
  assert.equal(r.body.target, "npm test");
  assert.deepEqual(h.answered, [["sess_a", "perm_1", "allow_once"]]);
  assert.equal(h.resolved.length, 1);
});

test("respond: a double tap is the same answer, once", async () => {
  const h = fakeHost();
  h.ask("sess_a", "perm_1", "Bash", { command: "npm test" });
  const body = { id: permissionApprovalId("sess_a", "perm_1"), decision: "allow_once", via: "notification" };
  const [one, two] = await Promise.all([respondToApproval(h.deps, body), respondToApproval(h.deps, body)]);
  const results = [one.body.result, two.body.result].sort();
  assert.deepEqual(results, ["already_resolved", "applied"]);
  assert.equal(h.answered.length, 1, "the engine heard it once");
  const again = await respondToApproval(h.deps, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.result, "already_resolved");
  assert.equal(again.body.decision, "allow_once", "it says what was decided, so the phone can show it");
});

test("respond: answered somewhere else (the app, another phone) is already_resolved, not an error", async () => {
  const h = fakeHost();
  h.deps.sessions.permissionOutcome = () => ({ decision: "deny", by: "owner", at: 5 });
  const r = await respondToApproval(h.deps, { sessionId: "sess_a", requestId: "perm_9", decision: "allow_once" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "already_resolved");
  assert.equal(r.body.decision, "deny");
});

test("respond: unknown or forgotten is not_found", async () => {
  const h = fakeHost();
  const r = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", "nope"), decision: "deny" });
  assert.equal(r.status, 404);
  assert.equal(r.body.result, "not_found");
  const staged = await respondToApproval(h.deps, { id: stagedApprovalId("nope"), decision: "deny" });
  assert.equal(staged.status, 404);
});

test("respond: strict requests refuse Allow from a notification but accept Deny", async () => {
  const h = fakeHost();
  h.ask("sess_a", "perm_money", "Checkout", { total: 40 });
  h.ask("sess_a", "perm_owner", "Read", { file_path: "/x" }, { ownerDecision: true });
  h.ask("sess_a", "perm_rm", "Bash", { command: "rm -rf build" });
  for (const requestId of ["perm_money", "perm_owner", "perm_rm"]) {
    for (const via of ["notification", "widget", "watch", undefined, "nonsense"]) {
      const r = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", requestId), decision: "allow_once", ...(via ? { via } : {}) });
      assert.equal(r.status, 403, `${requestId} via ${via}`);
      assert.equal(r.body.result, "needs_app");
    }
  }
  assert.equal(h.answered.length, 0, "nothing was allowed");
  const deny = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", "perm_money"), decision: "deny", via: "notification" });
  assert.equal(deny.status, 200);
  assert.equal(deny.body.result, "applied");
  assert.equal(deny.body.target, "", "the lock-screen result for a purchase carries no target");
  // From the app itself the owner may allow it.
  const fromApp = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", "perm_rm"), decision: "allow_once", via: "app" });
  assert.equal(fromApp.body.result, "applied");
});

test("respond: validation", async () => {
  const h = fakeHost();
  h.ask("sess_a", "p1", "Bash", { command: "ls" });
  for (const body of [{}, { id: "p1", decision: "allow_once" }, { id: permissionApprovalId("sess_a", "p1") }, { id: permissionApprovalId("sess_a", "p1"), decision: "allow_always" }, { id: permissionApprovalId("sess_a", "p1"), decision: "maybe" }, { sessionId: "sess_a", decision: "deny" }]) {
    const r = await respondToApproval(h.deps, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(h.answered.length, 0);
});

test("respond: a lost race between the list and the answer is already_resolved", async () => {
  const h = fakeHost();
  h.ask("sess_a", "p1", "Bash", { command: "ls" });
  h.deps.sessions.respondPermission = () => false;
  const r = await respondToApproval(h.deps, { id: permissionApprovalId("sess_a", "p1"), decision: "deny" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "already_resolved");
});

test("respond: staged effects follow the same rules", async () => {
  const h = fakeHost();
  h.stagedPending.push({ id: "watcher:w1:abc", kind: "operator.watcher-execution", domain: "operator", irreversibility: "recoverable", reason: "Watcher tripped: disk 91%" });
  h.stagedPending.push({ id: "submit:1", kind: "browser.submit", domain: "browser", irreversibility: "irreversible", reason: "Submit the order form" });
  const rows = listApprovals(h.deps);
  assert.deepEqual(rows.map((x) => [x.kind, x.gate]), [["staged", "quick"], ["staged", "strict"]]);

  const strict = await respondToApproval(h.deps, { id: stagedApprovalId("submit:1"), decision: "allow_once", via: "notification" });
  assert.equal(strict.status, 403);
  const quick = await respondToApproval(h.deps, { id: stagedApprovalId("watcher:w1:abc"), decision: "allow_once", via: "notification" });
  assert.equal(quick.body.result, "applied");
  assert.equal(h.stagedAnswered[0].verb, "allow_once");
  const again = await respondToApproval(h.deps, { id: stagedApprovalId("watcher:w1:abc"), decision: "allow_once", via: "notification" });
  assert.equal(again.body.result, "already_resolved");
});

test("list: rows carry no secrets and a gate the app can read", () => {
  const h = fakeHost();
  h.ask("sess_a", "p1", "Bash", { command: "deploy --token sk-abcdefghijklmnopqrstuvwxyz" });
  h.ask("sess_a", "p2", "Checkout", { total: 12 });
  const rows = listApprovals(h.deps);
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes("sk-abcdefghijkl"));
  assert.deepEqual(rows.map((r) => [r.tool, r.gate, r.agent]), [["Bash", "quick", "Builder Bob"], ["Checkout", "strict", "Builder Bob"]]);
  assert.equal(rows[1].target, "");
});

// ── the real thing: SessionManager + ApprovalQueue + RemoteAgentServer ────

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-approvals-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return home;
}

/** Real SessionManager whose scripted turn asks for a permission and reports the answer. */
function scriptedSessions(home, ask, permissionTimeoutMs = 60_000) {
  const holder = { decisions: [] };
  const sessions = new SessionManager({
    home,
    permissionTimeoutMs,
    factory: ({ signal, requestPermission }) => ({
      engine: {
        appendUserMessageContent() {},
        hydrate() {},
        history: () => [],
        streamTurn: async function* () {
          const request = await ask({ requestPermission, signal, holder });
          holder.decisions.push(request);
          yield say(`decision:${request}`);
          yield TURN_END;
        },
      },
      providerName: "fake",
      model: "fake",
      workspace: home,
    }),
  });
  return { sessions, holder };
}

async function serve(t, sessions, staged) {
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok",
    phoneApi: { notify: createApprovalsApi({ sessions, staged, agentName: () => "Bob", log: () => {} }) },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return call;
}

test("through the real server: list, answer from a notification, double tap, late tap", async (t) => {
  const home = await tempHome(t);
  const { sessions, holder } = scriptedSessions(home, ({ requestPermission }) =>
    requestPermission({ id: "perm_real", toolName: "Bash", input: { command: "npm test" }, reason: "run the tests" }));
  const call = await serve(t, sessions);
  const { id } = sessions.create({ surface: "mobile", title: "Fix tests" });
  void sessions.send(id, "go").catch(() => {});

  const listed = await waitFor(async () => {
    const r = await call("GET", "/gateway/approvals");
    return r.body?.count === 1 ? r : null;
  }, "the prompt appears in the list");
  assert.equal(listed.body.approvals[0].tool, "Bash");
  assert.equal(listed.body.approvals[0].target, "npm test");
  assert.equal(listed.body.approvals[0].gate, "quick");
  assert.equal(listed.body.approvals[0].agent, "Bob");
  const approvalId = listed.body.approvals[0].id;

  const first = await call("POST", "/gateway/approvals/respond", { id: approvalId, decision: "allow_once", via: "notification" });
  assert.equal(first.status, 200);
  assert.equal(first.body.result, "applied");
  await waitFor(() => holder.decisions.length === 1, "the engine heard the answer");
  assert.deepEqual(holder.decisions, ["allow_once"]);

  const second = await call("POST", "/gateway/approvals/respond", { id: approvalId, decision: "deny", via: "notification" });
  assert.equal(second.status, 200);
  assert.equal(second.body.result, "already_resolved");
  assert.equal(second.body.decision, "allow_once", "the late Deny does not rewrite history");
  assert.equal((await call("GET", "/gateway/approvals")).body.count, 0);
});

test("through the real server: a strict prompt cannot be allowed from a notification, only denied", async (t) => {
  const home = await tempHome(t);
  const { sessions, holder } = scriptedSessions(home, ({ requestPermission }) =>
    requestPermission({ id: "perm_money", toolName: "Checkout", input: { total: 99 }, reason: "buy it", ownerDecision: true }));
  const call = await serve(t, sessions);
  const { id } = sessions.create({ surface: "mobile" });
  void sessions.send(id, "go").catch(() => {});
  const approvalId = (await waitFor(async () => (await call("GET", "/gateway/approvals")).body?.approvals?.[0], "listed")).id;

  const allow = await call("POST", "/gateway/approvals/respond", { id: approvalId, decision: "allow_once", via: "notification" });
  assert.equal(allow.status, 403);
  assert.equal(allow.body.result, "needs_app");
  assert.equal(holder.decisions.length, 0, "still waiting on the owner");

  const deny = await call("POST", "/gateway/approvals/respond", { id: approvalId, decision: "deny", via: "notification" });
  assert.equal(deny.body.result, "applied");
  await waitFor(() => holder.decisions.length === 1, "denied");
  assert.deepEqual(holder.decisions, ["deny"]);
});

test("through the real server: a timed-out prompt reads as already_resolved with its outcome; an abandoned one leaves the list", async (t) => {
  const home = await tempHome(t);
  const controller = new AbortController();
  let n = 0;
  const { sessions } = scriptedSessions(home, ({ requestPermission }) => {
    n += 1;
    return requestPermission({ id: `perm_t${n}`, toolName: "Write", input: { file_path: "/w/a.ts" }, reason: "", ...(n === 2 ? { signal: controller.signal } : {}) });
    // Long enough that a loaded machine's first poll still sees the prompt (120ms flaked
    // under the full suite on Windows), short enough to time out inside waitFor's 3s.
  }, 1000);
  const call = await serve(t, sessions);

  const a = sessions.create({ surface: "mobile" });
  void sessions.send(a.id, "go").catch(() => {});
  const id1 = (await waitFor(async () => (await call("GET", "/gateway/approvals")).body?.approvals?.[0], "first listed")).id;
  await waitFor(async () => (await call("GET", "/gateway/approvals")).body?.count === 0, "it timed out (safe deny)");
  const late = await call("POST", "/gateway/approvals/respond", { id: id1, decision: "allow_once", via: "notification" });
  assert.equal(late.body.result, "already_resolved");
  assert.equal(late.body.decision, "deny");
  assert.equal(late.body.by, "timeout");

  const b = sessions.create({ surface: "mobile" });
  void sessions.send(b.id, "go").catch(() => {});
  await waitFor(async () => (await call("GET", "/gateway/approvals")).body?.count === 1, "second listed");
  controller.abort();
  await waitFor(async () => (await call("GET", "/gateway/approvals")).body?.count === 0, "abandoned prompt left the list at once");
});

test("through the real server: staged effects are listed and answered", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scriptedSessions(home, async () => "deny");
  const queue = new ApprovalQueue({ approver: "owner" });
  const call = await serve(t, sessions, queue);
  const decision = queue.requestApproval({ id: "watcher:w:1", kind: "operator.watcher-execution", domain: "operator", irreversibility: "recoverable", reason: "Disk is 91% full; clear the cache?" });
  const rows = (await call("GET", "/gateway/approvals")).body.approvals;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "staged");
  assert.equal(rows[0].gate, "quick");
  const r = await call("POST", "/gateway/approvals/respond", { id: rows[0].id, decision: "allow_once", via: "notification" });
  assert.equal(r.body.result, "applied");
  assert.equal((await decision).verb, "allow_once");
  const again = await call("POST", "/gateway/approvals/respond", { id: rows[0].id, decision: "allow_once", via: "notification" });
  assert.equal(again.body.result, "already_resolved");
});

test("the routes keep the bearer gate, the method rules and the body cap", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scriptedSessions(home, async () => "deny");
  const call = await serve(t, sessions);
  assert.equal((await call("GET", "/gateway/approvals", undefined, null)).status, 401);
  assert.equal((await call("POST", "/gateway/approvals/respond", { id: "x", decision: "deny" }, "guest-tok")).status, 401);
  assert.equal((await call("PUT", "/gateway/approvals")).status, 405);
  assert.equal((await call("GET", "/gateway/approvals/respond")).status, 405);
  assert.equal((await call("GET", "/gateway/approvals/other")).status, 404);
  assert.equal((await call("POST", "/gateway/approvals/respond", "not json{")).status, 400);
  assert.equal((await call("POST", "/gateway/approvals/respond", { id: "x".repeat(5000), decision: "deny" })).status, 413);
});

// ── the banner: category, payload, no secrets ─────────────────────────────

function notifierWith(observers = []) {
  const sent = [];
  const notifier = new PhoneNotifier({
    gatewayUrl: "ws://127.0.0.1:1",
    token: "t",
    push: { send: async (m) => { sent.push(m); return { sent: 1, failed: 0 }; } },
    agentName: () => "Bob",
    isMobileSession: () => true,
    observers,
  });
  return { notifier, sent };
}

const buildAps = (message) => {
  const req = PhonePush.buildRequest({ keyPath: "", keyId: "K", teamId: "T", bundleId: "com.doingteam.ares" }, "tok", "jwt", message, "alert");
  return JSON.parse(req.body);
};

test("banner: a quick prompt carries the Allow/Deny/Open category and the ids to answer it", () => {
  const { notifier, sent } = notifierWith();
  notifier.handleEvent("sess_a", { type: "permission_request", id: "perm_1", toolName: "Bash", input: { command: "npm test" }, reason: "" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Bob needs permission");
  assert.equal(sent[0].body, "Bash — npm test");
  assert.deepEqual(sent[0].data, { kind: "permission", sessionId: "sess_a", requestId: "perm_1", approvalId: "perm:sess_a:perm_1", gate: "quick", tool: "Bash", target: "npm test" });
  const body = buildAps(sent[0]);
  assert.equal(body.aps.category, APPROVAL_CATEGORY);
  assert.equal(body.aps["thread-id"], "sess_a");
  assert.equal(body.approvalId, "perm:sess_a:perm_1");
});

test("banner: a strict prompt gets the Deny/Open category and hides what it must", () => {
  const { notifier, sent } = notifierWith();
  notifier.handleEvent("sess_a", { type: "permission_request", id: "perm_2", toolName: "Checkout", input: { merchant: "acme", total: 300 }, reason: "", ownerDecision: true });
  notifier.handleEvent("sess_a", { type: "permission_request", id: "perm_3", toolName: "Bash", input: { command: "rm -rf ./build --token sk-abcdefghijklmnopqrstuv" }, reason: "" });
  assert.equal(sent[0].body, "Checkout");
  assert.equal(sent[0].data.gate, "strict");
  assert.equal(buildAps(sent[0]).aps.category, APPROVAL_STRICT_CATEGORY);
  assert.equal(sent[1].data.gate, "strict");
  assert.ok(!JSON.stringify(sent[1]).includes("sk-abcdefghijkl"), "no secret in the banner or the payload");
  assert.equal(buildAps(sent[1]).aps.category, APPROVAL_STRICT_CATEGORY);
});

test("banner: the garrison's origin rides along so a phone paired to several knows whose approval it is", () => {
  const sent = [];
  const notifier = new PhoneNotifier({
    gatewayUrl: "ws://127.0.0.1:1", token: "t",
    push: { send: async (m) => { sent.push(m); return { sent: 1, failed: 0 }; } },
    originOf: () => "https://ares.example.com",
  });
  notifier.handleEvent("s", { type: "permission_request", id: "p1", toolName: "Read", input: {}, reason: "" });
  notifier.handleStaged({ id: "x", kind: "k", domain: "d", irreversibility: "recoverable", reason: "r" });
  assert.equal(sent[0].data.origin, "https://ares.example.com");
  assert.equal(sent[1].data.origin, "https://ares.example.com");
  const bare = new PhoneNotifier({ gatewayUrl: "ws://127.0.0.1:1", token: "t", push: { send: async (m) => { sent.push(m); return { sent: 1, failed: 0 }; } }, originOf: () => { throw new Error("tunnel down"); } });
  bare.handleEvent("s", { type: "permission_request", id: "p2", toolName: "Read", input: {}, reason: "" });
  assert.equal(sent[2].data.origin, undefined, "a throwing origin never stops the banner");
});

test("banner: a payload without a gate (an older server, a hand-built push) cannot offer Allow", () => {
  const body = buildAps({ title: "t", body: "b", data: { kind: "permission", sessionId: "s", requestId: "r" } });
  assert.equal(body.aps.category, APPROVAL_STRICT_CATEGORY);
});

test("banner: other pushes keep their own categories", () => {
  assert.equal(buildAps({ title: "t", body: "b", data: { kind: "persona_message", sessionId: "s" } }).aps.category, "ARES_TEXT_REPLY");
  assert.equal(buildAps({ title: "t", body: "b", data: { kind: "device_wake" } }).aps.category, "ARES_DEVICE_WAKE");
  assert.equal(buildAps({ title: "t", body: "b", data: { kind: "turn_end", sessionId: "s" } }).aps.category, undefined);
});

test("banner: a staged approval pushes once, however many times the gateway replays it", () => {
  const seen = [];
  const { notifier, sent } = notifierWith([{ onStagedApproval: (s) => seen.push(s.id) }]);
  const staged = { id: "submit:1", kind: "browser.submit", domain: "browser", irreversibility: "irreversible", reason: "Submit the order form at https://shop.example/pay?card=4111111111111111" };
  notifier.handleStaged(staged);
  notifier.handleStaged(staged);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, "approval");
  assert.equal(sent[0].data.approvalId, "stg:submit:1");
  assert.equal(sent[0].data.gate, "strict");
  assert.ok(!sent[0].body.includes("4111111111111111"));
  assert.equal(buildAps(sent[0]).aps.category, APPROVAL_STRICT_CATEGORY);
  assert.deepEqual(seen, ["submit:1", "submit:1"], "observers still follow every frame");
});

test("banner: observers see every event and a throwing one never stops the push", () => {
  const events = [];
  const { notifier, sent } = notifierWith([{ onSessionEvent: () => { throw new Error("boom"); } }, { onSessionEvent: (s, e) => events.push(e.type) }]);
  notifier.handleEvent("s", { type: "turn_start" });
  notifier.handleEvent("s", { type: "permission_request", id: "p", toolName: "Read", input: {}, reason: "" });
  assert.deepEqual(events, ["turn_start", "permission_request"]);
  assert.equal(sent.length, 1);
});
