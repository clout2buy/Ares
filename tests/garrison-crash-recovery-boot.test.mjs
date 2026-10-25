// Garrison restart after a kill mid-turn (issues #29, #30, #31, #18, #19).
//
// What the gateway must do at boot, before any Core Session exists:
//   - a runner lease held by a DEAD pid is expired now, not ~30s from now,
//     so the first turn after a restart does not wait out a ghost (#30);
//   - an interrupted input is replayed a bounded number of times and then
//     marked failed, with each replay announced (#29);
//   - a 'pending'/'unverified' outcome with nothing in the mutation ledger is
//     not verification debt (#31) — a chat-only session must not end every
//     later turn needs_verification and pay a second provider call forever.
// Plus the gateway door: a retried inputId whose turn already settled still
// gets a turn_end (#29 D), and session.create refuses a bogus workspace or a
// provider this garrison cannot run (#18/#19).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Session, SessionKernelStore, LeaseHeldError, loadChildVerificationDebt, workspaceSessionKernelPath, openWorkspaceSessionKernel } from "../packages/core/dist/index.js";
import { GarrisonServer, SessionManager, ensureToken } from "../packages/garrison/dist/index.js";
import { expireDeadOwnerLeases, retireExhaustedOrphans, ownerPidOf, MAX_DETACHED_REPLAYS } from "../packages/cli/dist/entry/garrisonRecovery.js";
import { garrisonVerificationDebt } from "../packages/cli/dist/entry/garrisonCmd.js";

const wsModule = await import("ws").catch(() => import("../packages/garrison/node_modules/ws/wrapper.mjs"));
const WebSocket = wsModule.default ?? wsModule.WebSocket;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await tick(5);
  }
}

async function tempKernel(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-boot-"));
  const kernelPath = path.join(dir, "kernel.sqlite");
  const kernel = await SessionKernelStore.open({ filename: kernelPath });
  t.after(async () => {
    kernel.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return { dir, kernelPath, kernel };
}

test("a lease held by a dead pid is expired at boot and taken over immediately", async (t) => {
  const { kernel, kernelPath } = await tempKernel(t);
  const { id } = kernel.createSession({});
  const deadOwner = "session_runner_999999_dead-boot";
  const lease = kernel.acquireRunnerLease(id, deadOwner);
  assert.ok(lease.expiresAtMs > Date.now(), "the ghost lease looks live to the store");
  assert.equal(ownerPidOf(deadOwner), 999999);

  // Alive holder: untouched, and the store still refuses a stranger.
  const lines = [];
  assert.deepEqual(await expireDeadOwnerLeases(kernel, { kernelPath, pidAlive: () => true, log: (l) => lines.push(l) }), []);
  assert.throws(() => kernel.acquireRunnerLease(id, `session_runner_${process.pid}_new`), LeaseHeldError);

  // Dead holder: expired now; the next acquire runs the store's own recovery.
  assert.deepEqual(await expireDeadOwnerLeases(kernel, { kernelPath, pidAlive: () => false, log: (l) => lines.push(l) }), [id]);
  assert.ok(lines.some((l) => l.includes("dead pid 999999")), "the takeover is announced");
  const taken = kernel.acquireRunnerLease(id, `session_runner_${process.pid}_new`);
  assert.notEqual(taken.ownerId, deadOwner);
  assert.equal(kernel.getRunnerLease(id)?.ownerId, taken.ownerId);
});

test("an orphan input is replayed a bounded number of times, announced, then marked failed", async (t) => {
  const { kernel } = await tempKernel(t);
  const { id } = kernel.createSession({});
  const admit = (inputId) => kernel.admitInput({ id: inputId, sessionId: id, idempotencyKey: inputId, delivery: "queue", payload: { content: [{ type: "text", text: inputId }] } });
  admit("fresh");
  admit("doomed");
  const fence = kernel.acquireRunnerLease(id, `session_runner_${process.pid}_t`);
  for (let i = 0; i < MAX_DETACHED_REPLAYS; i++) kernel.appendEvent(fence, "input.detached_recovery_started", { inputId: "doomed" });
  kernel.appendEvent(fence, "input.detached_recovery_started", { inputId: "fresh" });
  kernel.releaseRunnerLease(fence, { executionState: "interrupted", workOutcome: "unverified" });

  const lines = [];
  const plan = retireExhaustedOrphans(kernel, { log: (l) => lines.push(l) });
  assert.deepEqual(plan.replaying, [{ sessionId: id, inputId: "fresh", attempt: 2, maxAttempts: MAX_DETACHED_REPLAYS }]);
  assert.deepEqual(plan.retired, [{ sessionId: id, inputId: "doomed", attempts: MAX_DETACHED_REPLAYS }]);
  assert.equal(kernel.getInput("doomed")?.state, "cancelled", "an exhausted input is terminal, not replayed again");
  assert.equal(kernel.getInput("fresh")?.state, "admitted", "an input with attempts left is left for the drain");
  assert.ok(lines.some((l) => /replaying interrupted input fresh on .*\(attempt 2 of 2\)/.test(l)), `announced: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => l.includes("doomed") && l.includes("marked failed")), `retirement announced: ${lines.join(" | ")}`);
});

test("a 'pending' outcome with nothing in the mutation ledger is not verification debt", async (t) => {
  const { kernel, dir } = await tempKernel(t);
  const { id } = kernel.createSession({});
  kernel.admitInput({ id: "in1", sessionId: id, idempotencyKey: "in1", delivery: "queue", payload: { content: [] } });
  assert.equal(kernel.getSession(id)?.workOutcome, "pending", "admission marks the session pending");
  const loaded = await loadChildVerificationDebt(kernel, dir, id);
  assert.equal(loaded.required, true, "the shared loader still reads pending as debt (fail-closed)");
  const gated = garrisonVerificationDebt(kernel, id, loaded);
  assert.equal(gated.required, false);
  // Real debt (a touched file) passes through untouched.
  const real = { required: true, touchedFiles: [path.join(dir, "a.ts")], scopeComplete: true };
  assert.equal(garrisonVerificationDebt(kernel, id, real), real);
});

// ── the gateway door ────────────────────────────────────────────────────────

function replyProvider() {
  let calls = 0;
  return {
    name: "boot-provider",
    calls: () => calls,
    async *stream() {
      calls += 1;
      yield {
        type: "message_done",
        message: { id: `reply_${calls}`, role: "assistant", content: [{ type: "text", text: `reply ${calls}` }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
  }
  static async open(url, token) {
    const ws = new WebSocket(url);
    const c = new Client(ws);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    c.send({ type: "hello", token, client: "test", proto: 1 });
    await waitFor(() => c.frames.some((f) => f.type === "welcome"), "welcome");
    return c;
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  of(type) { return this.frames.filter((f) => f.type === type); }
  events(type) { return this.frames.filter((f) => f.type === "event" && f.event.type === type); }
  kill() { this.ws.terminate(); }
}

async function bootGateway(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-door-"));
  const kernel = await openWorkspaceSessionKernel(home);
  const provider = replyProvider();
  const sessions = new SessionManager({
    home,
    sessionKernel: kernel,
    factory: ({ sessionId, model, signal, requestPermission, initialMessages, initialEventCount, workspace }) => ({
      session: new Session({
        workspace: workspace ?? home,
        provider,
        model: model ?? "mock",
        systemPrompt: "boot test",
        tools: [],
        signal,
        requestPermission,
        sessionId,
        initialMessages,
        initialSeq: initialEventCount,
        telemetryDir: path.join(home, "telemetry"),
        sessionRegistryHome: home,
        sessionKernel: kernel,
      }),
      providerName: provider.name,
      model: model ?? "mock",
      workspace: workspace ?? home,
    }),
  });
  const server = new GarrisonServer({ home, sessions, port: 0, providers: () => ["mock", "mock-echo"] });
  const { port } = await server.start();
  const token = await ensureToken(home);
  const client = await Client.open(`ws://127.0.0.1:${port}`, token);
  t.after(async () => {
    client.kill();
    await sessions.flush();
    await server.close();
    kernel.close();
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });
  return { home, client, provider, kernelPath: workspaceSessionKernelPath(home) };
}

test("session.create refuses a non-string, missing or non-directory workspace and an unknown provider", async (t) => {
  const { home, client } = await bootGateway(t);
  const file = path.join(home, "not-a-dir.txt");
  await fs.writeFile(file, "x");
  const probes = [
    [{ workspace: {} }, /workspace must be a string/],
    [{ workspace: path.join(home, "definitely", "not", "here") }, /workspace is not a directory/],
    [{ workspace: file }, /workspace is not a directory/],
    [{ provider: 5 }, /provider must be a string/],
    [{ provider: "not-a-provider" }, /provider "not-a-provider" is not available on this garrison \(running mock, mock-echo\)/],
  ];
  for (const [fields, expected] of probes) {
    const before = client.of("error").length;
    client.send({ type: "session.create", ...fields });
    await waitFor(() => client.of("error").length > before, `error for ${JSON.stringify(fields)}`);
    const err = client.of("error").at(-1);
    assert.match(String(err.error ?? err.message ?? JSON.stringify(err)), expected);
    assert.doesNotMatch(JSON.stringify(err), /ERR_INVALID_ARG_TYPE|ENOTDIR|EACCES/, "no Node internals leak");
  }
  assert.equal(client.of("session.created").length, 0, "none of the probes made a zombie session");
  assert.equal((await fs.stat(path.join(home, "definitely")).catch(() => null)), null, "a typo'd workspace was not created");

  // The happy path still works, including a provider this garrison runs.
  client.send({ type: "session.create", workspace: home, provider: "mock" });
  await waitFor(() => client.of("session.created").length === 1, "created");
});

test("a retried inputId whose turn already settled still gets a turn_end", async (t) => {
  const { client, provider } = await bootGateway(t);
  client.send({ type: "session.create" });
  const { session } = await waitFor(() => client.of("session.created")[0], "created");
  client.send({ type: "session.send", sessionId: session.id, text: "hello", inputId: "retry-me" });
  await waitFor(() => client.events("turn_end").length === 1, "first turn_end");
  assert.equal(provider.calls(), 1);

  // The documented recovery path after an ambiguous disconnect: same inputId.
  client.send({ type: "session.send", sessionId: session.id, text: "hello", inputId: "retry-me" });
  await waitFor(() => client.of("send.ack").filter((f) => f.duplicate === true).length === 1, "duplicate ack");
  const end = await waitFor(() => client.events("turn_end")[1], "the retry terminates with a turn_end");
  assert.equal(end.event.status, "completed");
  assert.deepEqual(end.event.usage, { inputTokens: 0, outputTokens: 0 }, "nothing ran again");
  assert.equal(provider.calls(), 1, "the retry did not call the provider");
});
