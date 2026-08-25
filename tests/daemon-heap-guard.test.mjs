// The exit-134 pair: watch the heap on the way up, and say something true
// about it when the process dies anyway.
//
// Field origin: external users reported "the more I use it the slower it starts
// to work", then:
//
//   The Garrison went down (exit code 134).
//   16: 00007FF63158B1EC AES_cbc_encrypt+152028
//   17: 00007FF63314C5A4 inflateValidate+40756
//   18: 00007FFFE704E957 BaseThreadInitThunk+23
//   19: 00007FFFE7A6AD6C RtlUserThreadStart+44
//
// 134 is SIGABRT — V8 aborting on the heap limit. Two holes: an OOM abort never
// runs uncaughtException (so ~/.ares/crashes was empty for exactly this crash),
// and the desktop printed the LAST four stderr lines, which in a V8 fatal dump
// are always nearest-symbol addresses with nothing to do with the cause.

import test from "node:test";
import assert from "node:assert/strict";

import { HeapGuard, readHeapSample, readHeapDiagnostics, forceCompactionGc } from "../packages/core/dist/index.js";
import { isPermanentRecoveryPoison } from "../packages/cli/dist/entry/sessionFactory.js";
import { explainDaemonExit, daemonExitMessage, meaningfulStderr } from "../packages/protocol/dist/index.js";

const MB = 1024 * 1024;
const sample = (usedMb, limitMb = 4096) => ({ usedBytes: usedMb * MB, limitBytes: limitMb * MB });

// ─── HeapGuard ────────────────────────────────────────────────────────────

test("pressure escalates with the heap and reports each crossing once", () => {
  const guard = new HeapGuard();
  let t = 0;

  const calm = guard.observe(sample(1000), (t += 15_000));
  assert.equal(calm.pressure, "ok");
  assert.equal(calm.shouldReport, false, "a healthy heap says nothing");

  const warm = guard.observe(sample(3100), (t += 15_000)); // ~76%
  assert.equal(warm.pressure, "elevated");
  assert.equal(warm.shouldReport, true, "crossing into elevated is worth saying");
  assert.equal(warm.shouldRelieve, false, "elevated warns, it does not shed");

  const again = guard.observe(sample(3120), (t += 15_000));
  assert.equal(again.changed, false);
  assert.equal(again.shouldReport, false, "the same level must not spam every sample");

  const hot = guard.observe(sample(3700), (t += 15_000)); // ~90%
  assert.equal(hot.pressure, "critical");
  assert.equal(hot.shouldRelieve, true, "critical must shed memory");
  assert.equal(hot.usedMb, 3700);
  assert.equal(hot.limitMb, 4096);
  assert.equal(hot.percent ?? Math.round(hot.ratio * 100), 90);
});

test("relief is rate-limited, and a heap that stays critical re-warns", () => {
  const guard = new HeapGuard({ cooldownMs: 60_000 });
  let t = 1_000_000;

  const first = guard.observe(sample(3800), t);
  assert.equal(first.shouldRelieve, true);

  const soon = guard.observe(sample(3810), (t += 15_000));
  assert.equal(soon.shouldRelieve, false, "shedding twice in 15s just costs rehydrations");
  assert.equal(soon.shouldReport, false);

  const later = guard.observe(sample(3820), (t += 60_000));
  assert.equal(later.shouldRelieve, true, "still critical a minute later — try again");
  assert.equal(later.shouldReport, true, "and say so: the first attempt did not help");
});

test("hysteresis keeps a reading parked on the line from flapping", () => {
  const guard = new HeapGuard({ elevatedRatio: 0.72, criticalRatio: 0.86, hysteresis: 0.05 });
  let t = 0;
  assert.equal(guard.observe(sample(2950), (t += 1000)).pressure, "elevated"); // 0.72
  // A hair below the threshold must NOT read as recovered.
  assert.equal(guard.observe(sample(2930), (t += 1000)).pressure, "elevated");
  // Well below it does.
  assert.equal(guard.observe(sample(2600), (t += 1000)).pressure, "ok");
});

test("a zero or unknown limit is inert, not a divide-by-zero panic", () => {
  const guard = new HeapGuard();
  const verdict = guard.observe({ usedBytes: 500 * MB, limitBytes: 0 }, 0);
  assert.equal(verdict.pressure, "ok");
  assert.equal(verdict.shouldRelieve, false);
  assert.equal(Number.isFinite(verdict.ratio), true);
});

test("readHeapSample reports this process against a real V8 limit", () => {
  const s = readHeapSample();
  assert.ok(s.limitBytes > 0, "V8 always has a heap limit");
  assert.ok(s.usedBytes > 0 && s.usedBytes < s.limitBytes, "a live test process is under its own ceiling");
});

test("readHeapDiagnostics names WHERE the memory sits, not just how much", () => {
  const diag = readHeapDiagnostics();
  assert.ok(diag.rssMb > 0, "a live process has resident memory");
  assert.ok(Number.isFinite(diag.externalMb) && Number.isFinite(diag.arrayBuffersMb));
  assert.ok(diag.spaces.length > 0, "V8 always has heap spaces");
  const oldSpace = diag.spaces.find((space) => space.space === "old_space");
  assert.ok(oldSpace, "old_space is where retention lives — it must be reported");
  for (const space of diag.spaces) {
    assert.ok(Number.isFinite(space.usedMb) && Number.isFinite(space.committedMb), space.space);
  }
});

test("forceCompactionGc runs only when --expose-gc defined globalThis.gc", () => {
  const original = globalThis.gc;
  try {
    if (typeof original !== "function") {
      // Ordinary test process: no gc exposed → a truthful no-op, never a throw.
      assert.equal(forceCompactionGc(), false);
    }
    let ran = 0;
    globalThis.gc = () => { ran++; };
    assert.equal(forceCompactionGc(), true);
    assert.equal(ran, 1, "the forced compaction actually invokes gc");
  } finally {
    if (typeof original === "function") globalThis.gc = original;
    else delete globalThis.gc;
  }
});

// ─── isPermanentRecoveryPoison ────────────────────────────────────────────
//
// The GameFPS regression: a recovered input whose saved model no longer exists
// died with http_404 on every daemon boot for three weeks, because the old
// inline poison regex covered 400/401/403 and not 404.

test("a 404 model-not-found death is poison — the GameFPS case verbatim", () => {
  assert.equal(
    isPermanentRecoveryPoison(
      'http_404: Anthropic returned 404: {"type":"error","error":{"type":"not_found_error","message":"model: gpt-5.6-sol"}}',
    ),
    true,
  );
});

test("the permanent 4xx family is poison", () => {
  assert.equal(isPermanentRecoveryPoison("http_400: invalid_request_error: bad payload"), true);
  assert.equal(isPermanentRecoveryPoison("provider_error: 401 unauthorized"), true);
  assert.equal(isPermanentRecoveryPoison("http_403: forbidden"), true);
  assert.equal(isPermanentRecoveryPoison("openai_error: The model `o9-preview` does not exist"), true);
  assert.equal(isPermanentRecoveryPoison("bad key: invalid api key provided"), true);
});

test("transient deaths keep their retry-next-boot value", () => {
  assert.equal(isPermanentRecoveryPoison("http_529: overloaded_error: Overloaded"), false);
  assert.equal(isPermanentRecoveryPoison("http_500: internal server error"), false);
  assert.equal(isPermanentRecoveryPoison("fetch failed: getaddrinfo ENOTFOUND api.anthropic.com"), false);
  assert.equal(isPermanentRecoveryPoison("econnrefused 127.0.0.1:11434"), false);
  assert.equal(isPermanentRecoveryPoison("http_429: rate_limit_error: slow down"), false);
});

// ─── explainDaemonExit ────────────────────────────────────────────────────

const V8_OOM_DUMP = [
  "<--- Last few GCs --->",
  "[12345:00007FF6] 412031 ms: Mark-Compact 4045.3 (4145.8) -> 4044.1 (4146.1) MB",
  "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  "----- Native stack trace -----",
  " 1: 00007FF62D074B34 v8::Message::GetIsolate+374004",
  "16: 00007FF63158B1EC AES_cbc_encrypt+152028",
  "17: 00007FF63314C5A4 inflateValidate+40756",
  "18: 00007FFFE704E957 BaseThreadInitThunk+23",
  "19: 00007FFFE7A6AD6C RtlUserThreadStart+44",
];

test("the reported crash is named as memory, not as four stack addresses", () => {
  const explained = explainDaemonExit(134, V8_OOM_DUMP);
  assert.equal(explained.cause, "oom");
  assert.match(explained.headline, /out of memory/i);
  assert.match(explained.detail, /Reached heap limit/, "the line that says why must survive");
  assert.doesNotMatch(explained.detail, /AES_cbc_encrypt|inflateValidate|RtlUserThreadStart/,
    "nearest-symbol frame noise must not be what the user reads");
});

test("exit 134 with no usable stderr is still called what it almost always is", () => {
  const explained = explainDaemonExit(134, ["18: 00007FFFE704E957 BaseThreadInitThunk+23"]);
  assert.equal(explained.cause, "oom");
  assert.match(explained.advice, /sessions/i, "and it tells the person what to do");
});

test("an internal assertion is not mislabelled as memory", () => {
  const explained = explainDaemonExit(134, [
    "node: ../src/node_http2.cc:1234: Assertion `(session) != nullptr' failed.",
    " 3: 00007FF63314C5A4 inflateValidate+40756",
  ]);
  assert.equal(explained.cause, "abort");
  assert.match(explained.detail, /Assertion/);
});

test("the OS OOM killer, clean stops, and unknown codes each read differently", () => {
  assert.equal(explainDaemonExit(137, []).cause, "oom");
  assert.equal(explainDaemonExit(143, []).cause, "clean");
  assert.equal(explainDaemonExit(0, []).cause, "clean");
  const odd = explainDaemonExit(7, ["Error: something specific went wrong"]);
  assert.equal(odd.cause, "crash");
  assert.match(odd.headline, /exit code 7/);
  assert.match(odd.detail, /something specific/);
});

test("meaningfulStderr falls back rather than showing nothing at all", () => {
  assert.deepEqual(meaningfulStderr([]), []);
  // Only frame noise available → show it rather than an empty box.
  const onlyNoise = meaningfulStderr(["18: 00007FFFE704E957 BaseThreadInitThunk+23"]);
  assert.equal(onlyNoise.length, 1);
});

test("the assembled message carries cause, evidence, advice and retry state", () => {
  const text = daemonExitMessage(134, V8_OOM_DUMP, { willRetry: true, attempt: 1, max: 3 });
  assert.match(text, /out of memory/i);
  assert.match(text, /Reached heap limit/);
  assert.match(text, /Restarting… \(attempt 1\/3\)/);
  const exhausted = daemonExitMessage(134, V8_OOM_DUMP, { willRetry: false, attempt: 3, max: 3 });
  assert.match(exhausted, /Auto-restart limit reached/);
});
