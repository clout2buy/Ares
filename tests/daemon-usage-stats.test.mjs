// The usage_stats scan that used to OOM the daemon.
//
// Field origin: exit-134 with ONE resident session and a 314MB events.jsonl
// (109 legacy compaction events up to 14MB apiece). The HELM polls usage_stats
// every 5 seconds, and the scan did readFile(events.jsonl, "utf8") — a ~630MB
// UTF-16 string per poll, overlapping the previous poll still parsing, until a
// mid-spike allocation aborted V8 at the 4GB ceiling.
//
// The scan now streams in bounded chunks and caches per-file aggregates by
// byte offset (the log is append-only), so a poll re-reads only what was
// appended. These tests pin the aggregation semantics and the incremental
// behaviour — including that appended events land without a full rescan.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { daemonUsageStats } from "../packages/cli/dist/entry/daemon/usageStats.js";

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-usage-"));
  mkdirSync(path.join(workspace, ".ares", "sessions"), { recursive: true });
  return workspace;
}

function makeSession(workspace, id, { provider = "anthropic", model = "claude-opus-5" } = {}) {
  const dir = path.join(workspace, ".ares", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, workspace, provider: { name: provider, model } }) + "\n",
    "utf8",
  );
  return path.join(dir, "events.jsonl");
}

const turnEnd = (tokensIn, tokensOut, extra = {}) =>
  JSON.stringify({
    ts: new Date("2026-08-24T12:00:00Z").toISOString(),
    seq: 1,
    event: { type: "turn_end", usage: { inputTokens: tokensIn, outputTokens: tokensOut, cacheReadTokens: 0, modelCalls: 1 }, ...extra },
  }) + "\n";

const auxUsage = (tokensIn, tokensOut) =>
  JSON.stringify({
    ts: new Date("2026-08-24T12:00:00Z").toISOString(),
    seq: 2,
    event: { type: "auxiliary_usage", usage: { inputTokens: tokensIn, outputTokens: tokensOut } },
  }) + "\n";

// A legacy-style fat compaction event: a multi-MB single line the scan must
// skip WITHOUT JSON-parsing (the substring gate) and without holding the file.
const fatCompaction = () =>
  JSON.stringify({
    ts: new Date("2026-08-24T11:00:00Z").toISOString(),
    seq: 3,
    event: { type: "compaction", messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] }] },
  }) + "\n";

test("aggregates turn_end and auxiliary usage across sessions", async () => {
  const workspace = makeWorkspace();
  try {
    const a = makeSession(workspace, "sess_a");
    writeFileSync(a, turnEnd(100, 50) + fatCompaction() + auxUsage(7, 3), "utf8");
    const b = makeSession(workspace, "sess_b", { provider: "openai-responses", model: "gpt-5.6-sol" });
    writeFileSync(b, turnEnd(1000, 500), "utf8");

    const stats = await daemonUsageStats(workspace, 14);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.tokensIn, 1107);
    assert.equal(stats.tokensOut, 553);
    assert.equal(stats.auxiliaryTokensIn, 7);
    assert.equal(stats.auxiliaryTokensOut, 3);
    assert.equal(stats.apiCalls, 3);
    const providers = new Map(stats.providers.map((p) => [p.provider, p]));
    assert.equal(providers.get("anthropic")?.tokensIn, 107);
    assert.equal(providers.get("openai-responses")?.tokensIn, 1000);
    assert.equal(stats.daily.length, 1);
    assert.equal(stats.daily[0].in, 1107);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("appended events are folded in on the next scan (append-only cache)", async () => {
  const workspace = makeWorkspace();
  try {
    const file = makeSession(workspace, "sess_grow");
    writeFileSync(file, turnEnd(10, 5), "utf8");
    const first = await daemonUsageStats(workspace, 14);
    assert.equal(first.tokensIn, 10);

    appendFileSync(file, turnEnd(90, 45), "utf8");
    const second = await daemonUsageStats(workspace, 14);
    assert.equal(second.tokensIn, 100, "the appended turn_end must be counted");
    assert.equal(second.tokensOut, 50);
    assert.equal(second.apiCalls, 2);

    // A third scan with nothing appended must not double-count.
    const third = await daemonUsageStats(workspace, 14);
    assert.equal(third.tokensIn, 100);
    assert.equal(third.apiCalls, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a truncated (re-created) log resets its cached aggregate", async () => {
  const workspace = makeWorkspace();
  try {
    const file = makeSession(workspace, "sess_reset");
    writeFileSync(file, turnEnd(500, 200) + turnEnd(500, 200), "utf8");
    const before = await daemonUsageStats(workspace, 14);
    assert.equal(before.tokensIn, 1000);

    writeFileSync(file, turnEnd(1, 1), "utf8"); // smaller than the cached offset
    const after = await daemonUsageStats(workspace, 14);
    assert.equal(after.tokensIn, 1, "shrunk file must trigger a full rescan");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a trailing partial line (write in flight) is deferred, not dropped", async () => {
  const workspace = makeWorkspace();
  try {
    const file = makeSession(workspace, "sess_partial");
    const complete = turnEnd(10, 5);
    const partial = turnEnd(90, 45).trimEnd(); // no newline yet — writer mid-flush
    writeFileSync(file, complete + partial, "utf8");
    const first = await daemonUsageStats(workspace, 14);
    assert.equal(first.tokensIn, 10, "the unterminated line must not be counted yet");

    appendFileSync(file, "\n", "utf8"); // the flush completes
    const second = await daemonUsageStats(workspace, 14);
    assert.equal(second.tokensIn, 100, "the completed line is folded exactly once");
    assert.equal(second.apiCalls, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("concurrent scans for the same window coalesce onto one promise", async () => {
  const workspace = makeWorkspace();
  try {
    const file = makeSession(workspace, "sess_coalesce");
    writeFileSync(file, turnEnd(42, 24), "utf8");
    const p1 = daemonUsageStats(workspace, 14);
    const p2 = daemonUsageStats(workspace, 14);
    assert.equal(p1, p2, "an in-flight scan must be shared, not stacked");
    const stats = await p1;
    assert.equal(stats.tokensIn, 42);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a deleted session's cache entry is dropped", async () => {
  const workspace = makeWorkspace();
  try {
    makeSession(workspace, "sess_keep");
    const keep = path.join(workspace, ".ares", "sessions", "sess_keep", "events.jsonl");
    writeFileSync(keep, turnEnd(5, 5), "utf8");
    const gone = makeSession(workspace, "sess_gone");
    writeFileSync(gone, turnEnd(1000, 1000), "utf8");
    const before = await daemonUsageStats(workspace, 14);
    assert.equal(before.tokensIn, 1005);

    rmSync(path.dirname(gone), { recursive: true, force: true });
    const after = await daemonUsageStats(workspace, 14);
    assert.equal(after.tokensIn, 5, "deleted sessions must vanish from the rollup");
    assert.equal(after.sessions, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
