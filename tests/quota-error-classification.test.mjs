// Running out of credit is not a bad request, and it is not permanent.
//
// Field report: "the credits shit broke but other chats [work] and it's back to
// my usage, it's a bug." The transcript shows:
//
//   Anthropic returned 400: {"type":"error","error":{"type":
//   "invalid_request_error","message":"You're out of extra usage. Add more at
//   claude.ai/settings/usage and keep going."}}
//   failed · 372ms · 0 calls · claude-opus-5 (anthropic)
//
// Anthropic reports exhaustion as a 400 invalid_request_error. Ares assumed 400
// meant "the payload was wrong" -- normally right, here exactly wrong -- which
// produced two opposite bugs from one root:
//
//   isProviderFatalError   returned FALSE  -> no failover, turn died, 0 calls
//   isPermanentRecoveryPoison returned TRUE -> recovered input durably cancelled
//
// So the turn died instantly AND stayed dead after the balance came back, while
// freshly started chats worked fine.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isQuotaOrBillingError,
  isProviderFatalError,
  isPermanentRecoveryPoison,
} from "../packages/cli/dist/entry/sessionFactory.js";

/** The exact message from the field transcript. */
const ANTHROPIC_EXHAUSTED =
  "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";

test("the real Anthropic exhaustion message is recognised as a quota stop", () => {
  assert.equal(isQuotaOrBillingError(ANTHROPIC_EXHAUSTED), true);
});

test("quota exhaustion is FATAL, so failover actually fires", () => {
  // Previously the 400 guard dismissed it as a payload problem and the turn
  // died with zero model calls instead of moving to another provider.
  assert.equal(
    isProviderFatalError({ code: "http_400", message: ANTHROPIC_EXHAUSTED }),
    true,
  );
});

test("quota exhaustion is NOT permanent — it comes back", () => {
  assert.equal(isPermanentRecoveryPoison(`http_400 ${ANTHROPIC_EXHAUSTED}`), false);
  assert.equal(
    isPermanentRecoveryPoison(`400 invalid_request_error ${ANTHROPIC_EXHAUSTED}`),
    false,
    "both `400` and `invalid_request` used to match — neither may win over quota",
  );
});

test("other providers' exhaustion wording is covered too", () => {
  for (const msg of [
    "Your credit balance is too low to access the Anthropic API",
    "You exceeded your current quota, please check your plan and billing details",
    "insufficient_quota",
    "insufficient balance",
    "Payment Required",
  ]) {
    assert.equal(isQuotaOrBillingError(msg), true, `should match: ${msg}`);
    assert.equal(isPermanentRecoveryPoison(`400 ${msg}`), false, `recoverable: ${msg}`);
  }
});

// ─── the guards this must not trample ──────────────────────────────────────

test("a genuine context-length 400 is still NOT fatal — failover would reship it", () => {
  // The original 400 guard exists for good reason: the same oversized prompt
  // 400s identically on the next provider. That behaviour must survive.
  for (const msg of [
    "prompt is too long: 210000 tokens > 200000 maximum",
    "maximum context length exceeded",
    "input length exceeds context_length",
  ]) {
    assert.equal(isProviderFatalError({ code: "http_400", message: msg }), false, `not fatal: ${msg}`);
    assert.equal(isQuotaOrBillingError(msg), false, `not a quota error: ${msg}`);
  }
});

test("rate limits are not promoted to fatal — congestion clears on its own", () => {
  // A 429 is transient; abandoning the provider would drop one about to work.
  assert.equal(isQuotaOrBillingError("rate_limit_error: rate limit exceeded"), false);
  assert.equal(isQuotaOrBillingError("Number of requests has exceeded your rate limit"), false);
});

test("a rate-limit message mentioning quota still reads as a rate limit", () => {
  assert.equal(
    isQuotaOrBillingError("rate limit reached for quota group gpt-4"),
    false,
    "rate-limit wording wins, so retry keeps its value",
  );
});

test("genuinely permanent failures stay permanent", () => {
  // The poison list exists because a session whose model no longer exists
  // failed recovery every boot for three weeks. Quota must not soften that.
  assert.equal(isPermanentRecoveryPoison("404 not_found_error model: gpt-5.6-sol does not exist"), true);
  assert.equal(isPermanentRecoveryPoison("401 invalid_api_key"), true);
  assert.equal(isPermanentRecoveryPoison("403 forbidden"), true);
});

test("auth failures are still fatal, and still permanent", () => {
  assert.equal(isProviderFatalError({ code: "http_401", message: "unauthorized" }), true);
  assert.equal(isPermanentRecoveryPoison("http_401 unauthorized"), true);
});

test("402 out-of-balance keeps working the way it already did", () => {
  // It arrived with the right status code all along; this change must not
  // disturb it, and it must now ALSO be recoverable rather than poison.
  assert.equal(isProviderFatalError({ code: "http_402", message: "insufficient balance" }), true);
  assert.equal(isPermanentRecoveryPoison("http_402 insufficient balance"), false);
});
