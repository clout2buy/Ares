// Field report 2026-10-26: every prompt on every agent opened with three
// error bubbles — Ollama 403 (payment past due), Anthropic 401 (invalid key),
// "No OpenRouter API key" — before DeepSeek answered. Two contracts fix it:
//
//   (1) the keyed cloud families PREFLIGHT their credential, so the failover
//       ladder skips a keyless or rejected rung instead of spending a turn on
//       it (entry/providerCredentialGate.ts + the selections in providers.ts);
//   (2) the desktop does not announce "your message is back in the draft"
//       at the engine's failed turn_end — the daemon's ladder may still rescue
//       that very turn — but at turn_settled, unless a resumed turn_start
//       voids it (tauri/src/state/foldEvent.ts).
//
// The daemon-side skip of a pin already known to be retired lives in
// daemon.ts and is exercised through decidePinnedFailover with attempt:2
// (past the same-provider retry), which is what the turn-start path calls.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

import {
  describeRetirement,
  preflightAnthropicCredential,
  preflightOpenRouterCredential,
} from "../packages/cli/dist/entry/providerCredentialGate.js";
import { decidePinnedFailover } from "../packages/cli/dist/entry/pinnedFailover.js";
import { preflightProviderSelection } from "../packages/cli/dist/entry/providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const respond = (status, body = "") => async () => new Response(body, { status, headers: { "content-type": "application/json" } });
const unreachable = async () => { throw new TypeError("fetch failed"); };

test("anthropic credential gate: missing key rejects, OAuth passes, 401 rejects with the fix named, a network blip passes", async () => {
  const missing = await preflightAnthropicCredential({ key: "", oauth: false });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No Anthropic API key/);

  const oauth = await preflightAnthropicCredential({ key: "", oauth: true });
  assert.equal(oauth.ok, true);

  let seen;
  const bad = await preflightAnthropicCredential({ key: "sk-ant-bad" }, {
    fetchImpl: async (url, init) => { seen = { url: String(url), headers: init.headers }; return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rejected the API key \(401/);
  assert.match(bad.error, /invalid x-api-key/);
  assert.match(bad.error, /Settings → API Keys/);
  assert.match(seen.url, /api\.anthropic\.com\/v1\/models/);
  assert.equal(seen.headers["x-api-key"], "sk-ant-bad");

  const good = await preflightAnthropicCredential({ key: "sk-ant-good" }, { fetchImpl: respond(200, '{"data":[]}') });
  assert.equal(good.ok, true);
  const blip = await preflightAnthropicCredential({ key: "sk-ant-good" }, { fetchImpl: unreachable });
  assert.equal(blip.ok, true, "unreachable is not unauthorized — the turn reports it");
});

test("openrouter credential gate: no key is 'not configured', 401 rejects, 200 passes", async () => {
  const none = await preflightOpenRouterCredential({ key: "" });
  assert.equal(none.ok, false);
  assert.match(none.error, /No OpenRouter API key/);
  const bad = await preflightOpenRouterCredential({ key: "sk-or-bad" }, { fetchImpl: respond(401, '{"error":{"message":"User not found."}}') });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /OpenRouter rejected the API key \(401/);
  const good = await preflightOpenRouterCredential({ key: "sk-or-good" }, { fetchImpl: respond(200, '{"data":{"limit":null}}') });
  assert.equal(good.ok, true);
});

test("the ladder skips a keyless openrouter and a 401-anthropic rung in one hop and lands on the working one", async () => {
  // The exact field scenario: pin = ollama (403 past due); chain = anthropic
  // (bad key), openrouter (no key), deepseek (fine). Before the gate the
  // ladder spent a turn on each of the first two.
  const mk = (family, preflight) => ({ provider: { name: family, stream: async function* () {} }, model: `${family}-model`, source: `explicit:${family}`, family, preflight });
  const resolve = async (family) => {
    if (family === "anthropic") return mk("anthropic", async () => ({ ok: false, error: "Anthropic rejected the API key (401: invalid x-api-key). Paste a working key under Settings → API Keys." }));
    if (family === "openrouter") return mk("openrouter", async () => ({ ok: false, error: "No OpenRouter API key. Add one under Settings → API Keys." }));
    if (family === "deepseek") return mk("deepseek", async () => ({ ok: true }));
    throw new Error(`${family} not configured`);
  };
  const decision = await decidePinnedFailover({
    current: mk("ollama"),
    fatal: 'http_403: Ollama returned 403: {"error":"your subscription payment is past due"}',
    attempt: 2,
    hasImages: false,
    dead: new Set(),
    tried: new Set(),
    chain: ["anthropic", "openrouter", "deepseek", "ollama"],
    resolve,
    preflight: (sel) => preflightProviderSelection(sel),
  });
  assert.equal(decision.action, "switch");
  assert.equal(decision.to, "deepseek/deepseek-model");
  assert.ok(decision.reasons.some((r) => /skipped anthropic \(Anthropic rejected the API key/.test(r)), decision.reasons.join(" | "));
  assert.ok(decision.reasons.some((r) => /openrouter \(No OpenRouter API key/.test(r)), decision.reasons.join(" | "));
});

test("describeRetirement reads as one short clause", () => {
  const now = Date.parse("2026-10-26T20:00:00Z");
  assert.equal(describeRetirement("http_403: past due", now - 4 * 60_000, now), "retired 4 min ago (http_403: past due)");
  assert.equal(describeRetirement("", now - 20_000, now), "retired just now");
  assert.match(describeRetirement("x".repeat(200), now - 61_000, now), /^retired 1 min ago \(x{137}…\)$/);
});

async function loadFold() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-handback-"));
  const outfile = path.join(tmp, "fold-event.mjs");
  await esbuild({
    entryPoints: [path.join(here, "..", "tauri", "src", "state", "foldEvent.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
  });
  const { foldEvent } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  return { foldEvent, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const baseSession = () => ({
  id: "s", title: "t", items: [{ kind: "user", key: "u1", inputId: "in_1", text: "run the program for me" }],
  busy: true, workflowMode: "build", tokensIn: 0, cacheReadTokens: 0, tokensOut: 0, todos: [], steerQueued: 0,
});

test("desktop: a failed turn the daemon rescues on a backup never says 'back in the draft'", async () => {
  const { foldEvent, cleanup } = await loadFold();
  try {
    let s = baseSession();
    s = foldEvent(s, { type: "error", error: { code: "http_403", message: "Ollama returned 403: past due", retriable: false } });
    s = foldEvent(s, { type: "turn_end", status: "failed", usage: { inputTokens: 0, outputTokens: 0 } });
    assert.ok(!s.items.some((i) => i.kind === "notice" && /back in the draft/.test(i.text)), "nothing announced at the engine's failed boundary");
    assert.equal((s.recoverableDrafts ?? []).length, 0, "the message is not handed back yet");
    assert.ok(s.pendingHandback, "the handback is parked");
    // the daemon's ladder resumes the turn on deepseek
    s = foldEvent(s, { type: "route_resolved", model: "deepseek-flash", provider: "deepseek", source: "assigned", reason: "failover", restoresPin: true });
    s = foldEvent(s, { type: "turn_start", turnId: "t2" });
    s = foldEvent(s, { type: "text_delta", text: "Launching it." });
    s = foldEvent(s, { type: "turn_end", status: "completed", usage: { inputTokens: 10, outputTokens: 5 } });
    s = foldEvent(s, { type: "turn_settled", inputId: "in_1", continuing: false });
    assert.equal(s.pendingHandback, undefined);
    assert.equal((s.recoverableDrafts ?? []).length, 0, "the answered message stays sent");
    assert.ok(!s.items.some((i) => i.kind === "notice" && /back in the draft/.test(i.text)));
    assert.ok(s.items.some((i) => i.kind === "assistant" && /Launching/.test(i.text)));
  } finally {
    cleanup();
  }
});

test("desktop: a failed turn nobody rescues hands the message back at turn_settled, with the auth wording", async () => {
  const { foldEvent, cleanup } = await loadFold();
  try {
    let s = baseSession();
    s = foldEvent(s, { type: "error", error: { code: "http_401", message: "invalid x-api-key", retriable: false } });
    s = foldEvent(s, { type: "turn_end", status: "failed", usage: { inputTokens: 0, outputTokens: 0 } });
    s = foldEvent(s, { type: "turn_settled", inputId: "in_1", continuing: false });
    const drafts = s.recoverableDrafts ?? [];
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].inputId, "in_1");
    assert.equal(drafts[0].text, "run the program for me");
    const notice = s.items.find((i) => i.kind === "notice" && /back in the draft/.test(i.text));
    assert.ok(notice);
    assert.match(notice.text, /failed on authentication/);
    assert.equal(s.busy, false);
  } finally {
    cleanup();
  }
});
