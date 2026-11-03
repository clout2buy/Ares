// Turns that end with no reply at all (field logs Sep 20 - Nov 2: 63 failed
// owner turns at modelCalls:0). Four causes, one guarantee:
//
//   1. Anthropic's 400 "You're out of extra usage" retired nothing: the pin
//      was restored each turn and died again 0.7s later (31x in one chat).
//      Usage exhaustion is now a family-retiring death, like a dead key.
//   2. The OAuth client-version gate ("Claude Code 2.1.251 does not support
//      this model; version 2.1.280 or newer") killed fresh chats: the
//      required version is adopted, persisted, and the request retried.
//   3. DeepSeek's "content[].thinking must be passed back": the cure dropped
//      `thinking`, the tactical branch put it back, and the turn died.
//   4. A local hf.co/... Ollama id routed to Anthropic 404'd: a pair that
//      cannot work is corrected at route time.
//   And: no owner turn ends with no reply AND no plain reason.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");

// Every module below reads ARES_HOME at call time; keep them off ~/.ares.
const HOME = mkdtempSync(path.join(os.tmpdir(), "ares-nosilent-home-"));
process.env.ARES_HOME = HOME;

const {
  AnthropicProvider,
  anthropicClientVersion,
  requiredClientVersionFromError,
  resetAnthropicClientVersionCache,
} = await import("../packages/core/dist/index.js");
const { isRetiringProviderDeath, isUsageDeath, describeUsageDeath, noReplyNotice } = await import("../packages/cli/dist/entry/providerDeath.js");
const { correctedProviderForModel, modelOwnerFamily, selectProvider, providerFamilyForSelection } = await import("../packages/cli/dist/entry/providers.js");

const EXTRA_USAGE = 'http_400: Anthropic returned 400: {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}';

function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
const OK_SSE = [
  sse("message_start", { message: { id: "msg_ok", usage: { input_tokens: 1, output_tokens: 0 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  sse("message_stop", {}),
].join("");
const okResponse = () => new Response(OK_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
const user = (text) => ({ id: "u1", role: "user", content: [{ type: "text", text }], createdAt: "now" });

test("usage exhaustion retires the family like a dead key; congestion and bad payloads do not", () => {
  assert.equal(isRetiringProviderDeath(EXTRA_USAGE), true, "out of extra usage");
  assert.equal(isRetiringProviderDeath("plan_limit: Your Claude Max plan's 5-hour limit is used up. It resets at 5:50 PM."), true);
  assert.equal(isRetiringProviderDeath("http_401: Anthropic returned 401: invalid x-api-key"), true, "auth deaths still retire");
  assert.equal(isRetiringProviderDeath("http_429: rate limit exceeded"), false, "a rate limit is weather, not death");
  assert.equal(isRetiringProviderDeath("http_400: prompt is too long"), false);
  assert.equal(isUsageDeath(EXTRA_USAGE), true);
  assert.equal(describeUsageDeath("anthropic", EXTRA_USAGE), "Claude says your plan's extra usage is out");
  assert.equal(
    describeUsageDeath("anthropic", "plan_limit: Your Claude Max plan's 5-hour limit is used up. It resets at 5:50 PM."),
    "Claude says your Claude Max plan's 5-hour limit is used up",
  );
  assert.match(noReplyNotice("x"), /^No brain could answer: x\. Your message is back in the draft/);
});

test("version gate: the required client version is parsed, adopted, persisted, and the request retried once", async () => {
  assert.equal(requiredClientVersionFromError("Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required"), "2.1.280");
  assert.equal(requiredClientVersionFromError("You're out of extra usage"), null);
  const previous = process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
  process.env.ARES_ANTHROPIC_OAUTH_TOKEN = "oauth-token";
  resetAnthropicClientVersionCache();
  const agents = [];
  try {
    const provider = new AnthropicProvider({
      endpointUrl: "http://x",
      fetchImpl: async (_url, init) => {
        agents.push(init.headers["User-Agent"]);
        if (agents.length === 1) {
          return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.251 does not support this model; version 9.9.999 or newer is required"}}', { status: 400 });
        }
        return okResponse();
      },
    });
    const events = [];
    for await (const e of provider.stream({ model: "claude-opus-5-5", system: "s", messages: [user("hi")], tools: [] })) events.push(e);
    assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events.filter((e) => e.type === "error")));
    assert.equal(agents.length, 2, "one retry");
    assert.equal(agents[1], "claude-cli/9.9.999");
    const saved = JSON.parse(readFileSync(path.join(HOME, "anthropic-client.json"), "utf8"));
    assert.equal(saved.version, "9.9.999", "persisted for the next boot");
    resetAnthropicClientVersionCache();
    assert.equal(anthropicClientVersion(), "9.9.999", "read back after a restart");
  } finally {
    rmSync(path.join(HOME, "anthropic-client.json"), { force: true });
    resetAnthropicClientVersionCache();
    if (previous === undefined) delete process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
    else process.env.ARES_ANTHROPIC_OAUTH_TOKEN = previous;
  }
});

test("DeepSeek passback 400 heals: history thinking stripped and thinking explicitly disabled", async () => {
  const bodies = [];
  const provider = new AnthropicProvider({
    apiKey: "ds-key",
    endpointUrl: "http://deepseek",
    dialect: "deepseek",
    // DeepSeek: thinking is on unless it says disabled; an assistant tool turn
    // without its reasoning cannot be replayed in thinking mode.
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const off = body.thinking?.type === "disabled";
      const history = JSON.stringify(body.messages);
      if (!off || history.includes('"thinking"')) {
        return new Response('{"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}', { status: 400 });
      }
      return okResponse();
    },
  });
  const events = [];
  for await (const e of provider.stream({
    model: "deepseek-flash",
    system: "s",
    reasoningLevel: "high",
    reasoningPhase: "routine",
    messages: [
      user("run it"),
      { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], createdAt: "now" },
      { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], createdAt: "now" },
    ],
    tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
  })) events.push(e);
  assert.ok(!events.some((e) => e.type === "error"), `healed: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);
  assert.ok(bodies.length <= 4, `bounded retries (${bodies.length})`);
  assert.deepEqual(bodies.at(-1).thinking, { type: "disabled" });
});

test("a model id that belongs to another provider is corrected at route time, never sent", async () => {
  assert.equal(modelOwnerFamily("hf.co/HauhauCS/Qwen3.6-35B-A3B:Q4_K_M"), "ollama");
  assert.equal(modelOwnerFamily("qwen3:8b"), "ollama");
  assert.equal(modelOwnerFamily("claude-opus-5-5"), "anthropic");
  assert.equal(modelOwnerFamily("anthropic/claude-opus-5-5"), null, "aggregator ids are not owned");
  assert.equal(correctedProviderForModel("anthropic", "hf.co/HauhauCS/Qwen3.6-35B-A3B:Q4_K_M"), "ollama");
  assert.equal(correctedProviderForModel("anthropic", "claude-opus-5-5"), null);
  assert.equal(correctedProviderForModel("openrouter", "claude-opus-5-5"), null, "aggregators carry anyone's ids");
  assert.equal(correctedProviderForModel("deepseek", "claude-haiku-5-5"), "anthropic");
  assert.equal(correctedProviderForModel("ollama", "glm-5.2"), null);

  const hf = await selectProvider(new Map([["provider", "anthropic"], ["model", "hf.co/HauhauCS/Qwen3.6-35B-A3B:Q4_K_M"]]));
  assert.equal(providerFamilyForSelection(hf), "ollama");
  assert.equal(hf.model, "hf.co/HauhauCS/Qwen3.6-35B-A3B:Q4_K_M");
  const unknown = await selectProvider(new Map([["provider", "anthropic"], ["model", "glm-5.2"]]));
  assert.equal(providerFamilyForSelection(unknown), "anthropic");
  assert.match(unknown.model, /claude/i, "an id Anthropic cannot serve falls back to its default");
  const fine = await selectProvider(new Map([["provider", "anthropic"], ["model", "claude-opus-5-5"]]));
  assert.equal(fine.model, "claude-opus-5-5");
});

async function loadFold() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-nosilent-fold-"));
  const outfile = path.join(tmp, "fold-event.mjs");
  await esbuild({
    entryPoints: [path.join(REPO, "tauri", "src", "state", "foldEvent.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
  });
  const { foldEvent } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  return { foldEvent, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test("desktop: the daemon's plain reason is shown, the message goes back, and the notice is not doubled", async () => {
  const { foldEvent, cleanup } = await loadFold();
  try {
    let s = {
      id: "s", title: "t", items: [{ kind: "user", key: "u1", inputId: "in_1", text: "sup homie lets build a game" }],
      busy: true, workflowMode: "build", tokensIn: 0, cacheReadTokens: 0, tokensOut: 0, todos: [], steerQueued: 0,
    };
    s = foldEvent(s, { type: "turn_end", status: "failed", usage: { inputTokens: 0, outputTokens: 0 } });
    s = foldEvent(s, { type: "system_reminder_injected", source: "instructions", text: noReplyNotice("Claude says your plan's extra usage is out, and no backup could take the turn") });
    s = foldEvent(s, { type: "turn_settled", inputId: "in_1", continuing: false });
    const notices = s.items.filter((i) => i.kind === "notice");
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.match(notices[0].text, /^No brain could answer: Claude says your plan's extra usage is out/);
    assert.equal(s.recoverableDrafts?.[0]?.text, "sup homie lets build a game", "handed back to the composer");

    let t = { ...s, items: [{ kind: "user", key: "u2", inputId: "in_2", text: "hi" }], recoverableDrafts: [] };
    t = foldEvent(t, { type: "system_reminder_injected", source: "instructions", text: "Claude says your plan's extra usage is out; running on deepseek/deepseek-flash instead." });
    assert.ok(t.items.some((i) => i.kind === "notice" && /^Claude says your plan's extra usage is out/.test(i.text)), "the switch note is visible");
  } finally {
    cleanup();
  }
});

test("daemon: a turn that dies with no reply always ends with one plain reason", async (t) => {
  try { await access(ENTRY); } catch { t.skip("packages/cli/dist not built — run pnpm build"); return; }
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-nosilent-daemon-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-nosilent-ws-"));
  const child = spawn(process.execPath, [ENTRY, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, ARES_PROVIDER: "mock", ARES_MODEL: "mock-default" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const events = () => stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const waitFor = async (pred, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(0, 400)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  const ready = await waitFor((e) => e.type === "daemon_ready" || e.type === "ready", 90_000);
  assert.ok(ready, `daemon ready. stderr: ${stderr.slice(0, 600)}`);

  const reasonsFor = (sid) => events().filter((e) => e.sessionId === sid && e.type === "system_reminder_injected" && /No brain could answer|says your/.test(e.text ?? ""));
  // The owner-visible reasons the desktop shows (its allowlist, foldEvent.ts).
  const visibleFor = (sid) => events().filter((e) => e.sessionId === sid && e.type === "system_reminder_injected" && /^(?:Pinned provider|No brain could answer)/.test(e.text ?? ""));
  const trail = (sid) => JSON.stringify(events().filter((e) => e.sessionId === sid).map((e) => [e.type, e.text ?? e.error?.message ?? e.status]));

  // A 400 the ladder never treated as a provider death: before, only the
  // raw JSON error was left on screen.
  send({ type: "send", goal: "__mock_bad_request__", sessionId: "sess_bad" });
  assert.ok(await waitFor((e) => e.type === "turn_settled" && e.sessionId === "sess_bad"), "the failed turn settled");
  const r0 = reasonsFor("sess_bad");
  assert.equal(r0.length, 1, `exactly one plain reason: ${trail("sess_bad")}`);
  assert.match(r0[0].text, /^No brain could answer: mock\/mock-echo failed \(Anthropic returned 400/);

  // A provider death the ladder already explains is not explained twice.
  send({ type: "send", goal: "__mock_fail_provider__", sessionId: "sess_fail" });
  assert.ok(await waitFor((e) => e.type === "turn_settled" && e.sessionId === "sess_fail"), "the failed turn settled");
  assert.equal(visibleFor("sess_fail").length, 1, `one visible reason: ${trail("sess_fail")}`);

  // Usage exhaustion, said in plain words.
  send({ type: "send", goal: "__mock_extra_usage__", sessionId: "sess_usage" });
  const settled2 = await waitFor((e) => e.type === "turn_settled" && e.sessionId === "sess_usage");
  assert.ok(settled2, "the usage-dead turn settled");
  const r2 = reasonsFor("sess_usage");
  assert.equal(r2.length, 1, JSON.stringify(r2));
  assert.match(r2[0].text, /^No brain could answer: .*says your plan's extra usage is out/);

  // A model that "completes" with no text and no tool call, through the nudge:
  // before, the chat showed only "Delivered".
  send({ type: "send", goal: "__mock_empty_reply__", sessionId: "sess_empty" });
  assert.ok(await waitFor((e) => e.type === "turn_settled" && e.sessionId === "sess_empty"), "the empty turn settled");
  const empty = events().filter((e) => e.sessionId === "sess_empty" && e.type === "system_reminder_injected" && /finished without writing anything back/.test(e.text ?? ""));
  assert.equal(empty.length, 1, `one plain line for an empty reply: ${trail("sess_empty")}`);
  assert.ok(existsSync(home));
});
