// Pinned-model failover — a pin survives the night, the TURN survives the
// provider. Field data: 42/188 turns died last month on provider stream
// errors while the pinned model was "respected" into losing the message.
// Contract under test (entry/pinnedFailover.ts + the daemon ladder it feeds):
//   (a) one same-provider retry after a transient network failure;
//   (b) then a walk down the backup chain with a visible route_resolved
//       carrying reason:"failover" + from/to;
//   (c) the pin is restored for the next turn;
//   image turns never fail over onto a blind model; ARES_PINNED_FAILOVER=0
//   restores the old die-in-place behaviour; a stopped local Ollama is one
//   clear non-retriable line, not five retries.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Session } from "../packages/core/dist/index.js";
import {
  DEFAULT_BACKUP_CHAIN,
  backupChain,
  decidePinnedFailover,
  isTransientNetworkFailure,
  pinnedFailoverEnabled,
} from "../packages/cli/dist/entry/pinnedFailover.js";
import { classifyLocalProviderDown, withLocalProviderDiagnosis } from "../packages/cli/dist/entry/localProviderDiagnosis.js";
import { chatContextBudget, isProviderFatalError } from "../packages/cli/dist/entry/sessionFactory.js";
import { providerFamilyForSelection } from "../packages/cli/dist/entry/providers.js";

// ─── fakes ─────────────────────────────────────────────────────────────

/** A provider whose behaviour per call is scripted: "ok" answers, anything
 *  else is yielded as a non-retriable error event (the shape the engine
 *  surfaces to the daemon after its own S1 ladder is exhausted). */
function fakeProvider(name, script) {
  const calls = [];
  return {
    name,
    calls,
    async *stream(req) {
      const step = script.length > calls.length ? script[calls.length] : script[script.length - 1];
      calls.push(req);
      if (step !== "ok") {
        yield { type: "error", error: { code: step.code, message: step.message, retriable: false } };
        return;
      }
      yield { type: "text_delta", text: `${name} says ok` };
      yield {
        type: "message_done",
        message: { id: `m_${calls.length}`, role: "assistant", content: [{ type: "text", text: `${name} says ok` }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function selection(provider, family, model) {
  return { provider, model, source: `explicit:${family}`, family };
}

function mkSession(sel, content = []) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-pinned-failover-"));
  return new Session({ workspace, provider: sel.provider, model: sel.model, systemPrompt: "s", tools: [], initialMessages: [] });
}

/**
 * The daemon's failover ladder, reduced to its decision spine so it runs
 * in-process against a REAL Session with fake providers. Mirrors daemon.ts:
 * stream the turn → on a fatal provider error consult decidePinnedFailover →
 * retry (resumeTurn on the same provider) / switch (setProvider + resumeTurn)
 * / stop → and restore the pin in `finally`.
 */
async function runPinnedTurn(state, goal, opts) {
  const events = [];
  const turn = { status: "completed", fatal: null };
  const streamOnce = async (gen) => {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "turn_end" && ev.status) turn.status = ev.status;
      if (ev.type === "error" && isProviderFatalError(ev.error)) turn.fatal = `${ev.error.code}: ${ev.error.message}`.slice(0, 200);
    }
  };
  const tried = new Set();
  let deaths = 0;
  let restore = null;
  try {
    await streamOnce(state.session.sendContent(goal, {}));
    let hops = 0;
    while (turn.status === "failed" && turn.fatal && hops < 4) {
      hops++;
      if (!pinnedFailoverEnabled(opts.env ?? process.env)) break;
      deaths++;
      const decision = await decidePinnedFailover({
        current: state.selection,
        fatal: turn.fatal,
        attempt: deaths,
        hasImages: goal.some((b) => b.type === "image"),
        dead: opts.dead ?? new Set(),
        tried,
        chain: opts.chain ?? DEFAULT_BACKUP_CHAIN,
        resolve: opts.resolve,
      });
      events.push({ type: "decision", ...decision });
      if (decision.action === "retry") {
        turn.status = "completed";
        turn.fatal = null;
        await streamOnce(state.session.resumeTurn());
        continue;
      }
      if (decision.action === "stop") break;
      const failedFamily = providerFamilyForSelection(state.selection);
      tried.add(failedFamily);
      tried.add(providerFamilyForSelection(decision.selection));
      restore ??= state.selection;
      await state.session.setProvider(decision.selection.provider, decision.selection.model, { contextBudgetTokens: chatContextBudget(decision.selection) });
      state.selection = decision.selection;
      events.push({ type: "route_resolved", model: decision.selection.model, provider: providerFamilyForSelection(decision.selection), source: "assigned", reason: decision.reason, from: decision.from, to: decision.to, reasons: decision.reasons, restoresPin: true });
      turn.status = "completed";
      turn.fatal = null;
      await streamOnce(state.session.resumeTurn());
    }
  } finally {
    if (restore && state.selection !== restore) {
      await state.session.setProvider(restore.provider, restore.model, { contextBudgetTokens: chatContextBudget(restore) });
      state.selection = restore;
    }
  }
  return { events, status: turn.status, fatal: turn.fatal };
}

const FETCH_FAILED = { code: "ollama_throw", message: "fetch failed" };
const text = (t) => [{ type: "text", text: t }];

// ─── classification + config ───────────────────────────────────────────

test("transient network failures retry; auth, 404 and 'not running' do not", () => {
  assert.equal(isTransientNetworkFailure("ollama_throw: fetch failed"), true);
  assert.equal(isTransientNetworkFailure("provider_throw: read ECONNRESET"), true);
  assert.equal(isTransientNetworkFailure("stream_stall: no output for 90s"), true);
  assert.equal(isTransientNetworkFailure("http_401: unauthorized"), false);
  assert.equal(isTransientNetworkFailure("http_404: model not found"), false);
  assert.equal(isTransientNetworkFailure("provider_not_running: Ollama is not running at http://127.0.0.1:11434; start it or pick another provider"), false);
  assert.equal(isTransientNetworkFailure(null), false);
});

test("backup chain: ui.json routing.backup wins, env is second, Auto ranking is the default, unknown ids drop", () => {
  assert.deepEqual(backupChain(null, {}), [...DEFAULT_BACKUP_CHAIN]);
  assert.deepEqual(backupChain({ routing: { backup: ["deepseek", "bogus", "Ollama", "deepseek"] } }, {}), ["deepseek", "ollama"]);
  assert.deepEqual(backupChain({ routing: {} }, { ARES_ROUTING_BACKUP: "openrouter, anthropic" }), ["openrouter", "anthropic"]);
  assert.deepEqual(backupChain({ routing: { backup: ["kimi"] } }, { ARES_ROUTING_BACKUP: "openrouter" }), ["kimi"]);
  assert.equal(pinnedFailoverEnabled({}), true);
  assert.equal(pinnedFailoverEnabled({ ARES_PINNED_FAILOVER: "0" }), false);
});

test("the ladder: 401 skips the same-provider retry; the gateway never fails over; a preflight-rejecting backup is skipped", async () => {
  const anthropic = fakeProvider("anthropic", ["ok"]);
  const pin = selection(fakeProvider("deepseek", []), "deepseek", "deepseek-v4-pro");
  const resolve = async (family) => {
    if (family === "anthropic") return selection(anthropic, "anthropic", "claude-fable-5");
    throw new Error(`${family} not configured`);
  };
  const auth = await decidePinnedFailover({ current: pin, fatal: "http_401: unauthorized", attempt: 1, hasImages: false, dead: new Set(), tried: new Set(), chain: ["openrouter", "anthropic"], resolve });
  assert.equal(auth.action, "switch");
  assert.equal(auth.to, "anthropic/claude-fable-5");
  assert.equal(auth.reason, "failover");
  assert.ok(auth.reasons.some((r) => /skipped openrouter/.test(r)), `skips are cited: ${auth.reasons}`);

  const gateway = await decidePinnedFailover({ current: selection(fakeProvider("anthropic", []), "ares", "ares-internal"), fatal: "http_402: out of credits", attempt: 1, hasImages: false, dead: new Set(), tried: new Set(), chain: ["anthropic"], resolve });
  assert.equal(gateway.action, "stop");

  const rejected = await decidePinnedFailover({ current: pin, fatal: "http_404: not found", attempt: 1, hasImages: false, dead: new Set(), tried: new Set(), chain: ["anthropic"], resolve, preflight: async () => { throw new Error("key expired"); } });
  assert.equal(rejected.action, "stop");
  assert.match(rejected.reason, /key expired/);

  const dead = await decidePinnedFailover({ current: pin, fatal: "http_404: not found", attempt: 1, hasImages: false, dead: new Set(["anthropic"]), tried: new Set(), chain: ["anthropic"], resolve });
  assert.equal(dead.action, "stop");
  assert.match(dead.reason, /retired/);
});

// ─── the full turn, on a real Session ──────────────────────────────────

test("pinned provider dies on fetch failed → one retry → backup finishes the turn → pin is back next turn", { timeout: 30_000 }, async () => {
  // Turn 1: ollama fails twice (initial + the one retry). Turn 2: ollama is healthy.
  const ollama = fakeProvider("ollama-cloud:reasoner", [FETCH_FAILED, FETCH_FAILED, "ok"]);
  const anthropic = fakeProvider("anthropic", ["ok"]);
  const pin = selection(ollama, "ollama", "qwen3:8b");
  const state = { selection: pin, session: mkSession(pin) };
  const resolve = async (family) => {
    if (family === "anthropic") return selection(anthropic, "anthropic", "claude-fable-5");
    throw new Error(`${family} not configured`);
  };

  const first = await runPinnedTurn(state, text("hello"), { resolve, chain: ["anthropic", "deepseek"] });
  assert.equal(first.status, "completed", `turn 1 completes via the backup: ${JSON.stringify(first.events.filter((e) => e.type === "error" || e.type === "decision"))}`);
  assert.equal(ollama.calls.length, 2, "exactly one same-provider retry on the pin");
  assert.equal(anthropic.calls.length, 1, "the backup ran the turn once");
  const decisions = first.events.filter((e) => e.type === "decision").map((e) => e.action);
  assert.deepEqual(decisions, ["retry", "switch"]);
  const routed = first.events.find((e) => e.type === "route_resolved");
  assert.ok(routed, "a visible route_resolved was emitted");
  assert.equal(routed.reason, "failover");
  assert.equal(routed.from, "ollama/qwen3:8b");
  assert.equal(routed.to, "anthropic/claude-fable-5");
  assert.equal(routed.restoresPin, true);
  assert.ok(routed.reasons.some((r) => /fetch failed/.test(r)), "the cause is cited in reasons");
  assert.ok(first.events.some((e) => e.type === "text_delta" && /anthropic says ok/.test(e.text)), "the backup's answer streamed");
  // (c) the pin is restored, not overwritten.
  assert.equal(state.selection, pin);

  const second = await runPinnedTurn(state, text("again"), { resolve, chain: ["anthropic"] });
  assert.equal(second.status, "completed");
  assert.equal(ollama.calls.length, 3, "turn 2 tried the pin first");
  assert.equal(anthropic.calls.length, 1, "the backup was not consulted once the pin was healthy");
  assert.equal(second.events.filter((e) => e.type === "decision").length, 0);
});

test("an image turn never fails over onto a blind model", { timeout: 30_000 }, async () => {
  const ollama = fakeProvider("ollama-cloud:reasoner", [{ code: "http_404", message: "model not found" }]);
  const deepseek = fakeProvider("deepseek", ["ok"]);
  const anthropic = fakeProvider("anthropic", ["ok"]);
  const pin = selection(ollama, "ollama", "qwen3:8b");
  const resolve = async (family) => {
    if (family === "deepseek") return selection(deepseek, "deepseek", "deepseek-v4-pro");
    if (family === "anthropic") return selection(anthropic, "anthropic", "claude-fable-5");
    throw new Error(`${family} not configured`);
  };
  const image = [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } }];

  // Blind deepseek is first in the chain — it must be skipped for anthropic.
  const state = { selection: pin, session: mkSession(pin) };
  const run = await runPinnedTurn(state, image, { resolve, chain: ["deepseek", "anthropic"] });
  assert.equal(run.status, "completed");
  assert.equal(deepseek.calls.length, 0, "the text-only backup never saw the image turn");
  assert.equal(anthropic.calls.length, 1);
  const routed = run.events.find((e) => e.type === "route_resolved");
  assert.equal(routed.to, "anthropic/claude-fable-5");
  assert.ok(routed.reasons.some((r) => /cannot see the attached image/.test(r)), `the skip is cited: ${routed.reasons}`);

  // Only blind backups configured → stop in place, the turn fails honestly.
  const ollama2 = fakeProvider("ollama-cloud:reasoner", [{ code: "http_404", message: "model not found" }]);
  const pin2 = selection(ollama2, "ollama", "qwen3:8b");
  const state2 = { selection: pin2, session: mkSession(pin2) };
  const stopped = await runPinnedTurn(state2, image, { resolve, chain: ["deepseek"] });
  assert.equal(stopped.status, "failed");
  assert.equal(deepseek.calls.length, 0);
  assert.equal(stopped.events.at(-1)?.action ?? stopped.events.filter((e) => e.type === "decision").at(-1)?.action, "stop");
  assert.equal(state2.selection, pin2);
});

test("ARES_PINNED_FAILOVER=0 restores the old behaviour: the pinned turn dies in place", { timeout: 30_000 }, async () => {
  const ollama = fakeProvider("ollama-cloud:reasoner", [FETCH_FAILED]);
  const anthropic = fakeProvider("anthropic", ["ok"]);
  const pin = selection(ollama, "ollama", "qwen3:8b");
  const state = { selection: pin, session: mkSession(pin) };
  const resolve = async () => selection(anthropic, "anthropic", "claude-fable-5");
  const run = await runPinnedTurn(state, text("hello"), { resolve, env: { ARES_PINNED_FAILOVER: "0" } });
  assert.equal(run.status, "failed");
  assert.equal(ollama.calls.length, 1, "no retry, no failover");
  assert.equal(anthropic.calls.length, 0);
  assert.equal(run.events.filter((e) => e.type === "route_resolved").length, 0);
  assert.equal(state.selection, pin);
});

// ─── "Ollama is not running" — one line, not five retries ──────────────

test("a refused loopback connection is classified as 'not running'; remote hosts and HTTP statuses are not", () => {
  const host = "http://127.0.0.1:11434";
  assert.equal(
    classifyLocalProviderDown({ message: "fetch failed" }, host),
    "Ollama is not running at http://127.0.0.1:11434; start it or pick another provider",
  );
  assert.match(classifyLocalProviderDown({ message: "fetch failed", cause: { code: "ECONNREFUSED" } }, "localhost:11434") ?? "", /is not running at localhost:11434/);
  assert.match(classifyLocalProviderDown("connect ECONNREFUSED 127.0.0.1:1234", "http://localhost:1234/v1", "LM Studio") ?? "", /^LM Studio is not running/);
  assert.equal(classifyLocalProviderDown({ message: "fetch failed" }, "https://ollama.com"), null, "a remote fetch failure keeps its own message");
  assert.equal(classifyLocalProviderDown({ code: "http_500", message: "Ollama returned 500: boom" }, host), null);
  assert.equal(classifyLocalProviderDown({ message: "model \"x\" not found" }, host), null);
  assert.equal(isProviderFatalError({ code: "provider_not_running", message: "Ollama is not running at http://127.0.0.1:11434; start it or pick another provider" }), true, "the daemon treats it as a failover trigger");
});

test("withLocalProviderDiagnosis: the engine sees ONE non-retriable error line instead of the retry ladder", { timeout: 30_000 }, async () => {
  let calls = 0;
  const raw = {
    name: "ollama-cloud:reasoner",
    async *stream() {
      calls++;
      // Exactly what the ollama adapter yields for a stopped server: retriable.
      yield { type: "error", error: { code: "ollama_throw", message: "fetch failed", retriable: true } };
    },
  };
  const wrapped = withLocalProviderDiagnosis(raw, "http://127.0.0.1:11434", "Ollama");
  assert.equal(wrapped.name, raw.name, "the adapter name survives for family resolution");
  const sel = selection(wrapped, "ollama", "qwen3:8b");
  const session = mkSession(sel);
  const started = Date.now();
  const events = [];
  for await (const ev of session.send("hi")) events.push(ev);
  const errors = events.filter((e) => e.type === "error");
  assert.equal(calls, 1, "no retries: the error is non-retriable");
  assert.ok(Date.now() - started < 5_000, "no backoff was waited out");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "provider_not_running");
  assert.equal(errors[0].error.message, "Ollama is not running at http://127.0.0.1:11434; start it or pick another provider");
  assert.equal(errors[0].error.retriable, false);
  assert.equal(events.at(-1).type, "turn_end");
  assert.equal(events.at(-1).status, "failed");
  // Remote hosts are returned unwrapped — nothing to diagnose there.
  assert.equal(withLocalProviderDiagnosis(raw, "https://ollama.com"), raw);
});
