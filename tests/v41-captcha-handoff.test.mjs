// Verifies the CAPTCHA / human-verification handoff:
//   1. detectChallenge classifies reCAPTCHA / hCaptcha / Cloudflare / generic,
//      and returns null on a clean page.
//   2. The Gate prompt is concrete (names the URL).
//   3. The browser's navigate() hands off to the human handler when a wall is
//      hit, re-checks after "solved", and proceeds on "skip" — and never calls
//      the handler on a clean page.

import test from "node:test";
import assert from "node:assert/strict";

import { detectChallenge, challengePrompt, runChallengeHandoff } from "../packages/connectors/dist/index.js";

// ── 1. detection ─────────────────────────────────────────────────────────────

test("detectChallenge: classifies the major walls and clears clean pages", () => {
  assert.equal(detectChallenge({ url: "https://x.io", title: "Home", html: "<h1>welcome</h1>" }), null);

  assert.equal(
    detectChallenge({ url: "https://x.io", html: '<div class="g-recaptcha"></div>' })?.kind,
    "recaptcha",
  );
  assert.equal(
    detectChallenge({ url: "https://x.io", html: '<div class="h-captcha" data-sitekey="x"></div>' })?.kind,
    "hcaptcha",
  );
  assert.equal(
    detectChallenge({ url: "https://x.io", title: "Just a moment...", html: "cf-chl-bypass" })?.kind,
    "cloudflare",
  );
  assert.equal(
    detectChallenge({ url: "https://x.io", html: "Please verify you are human to continue" })?.kind,
    "generic",
  );
});

test("detectChallenge: Cloudflare wins even when it embeds a captcha widget", () => {
  const info = detectChallenge({
    url: "https://shop.io",
    title: "Just a moment...",
    html: '<div class="g-recaptcha"></div><script src="/cdn-cgi/challenge-platform/x"></script>',
  });
  assert.equal(info?.kind, "cloudflare");
});

test("challengePrompt: names the URL and is actionable", () => {
  const prompt = challengePrompt({ kind: "recaptcha", url: "https://shop.io/checkout", reason: "A reCAPTCHA must be solved" });
  assert.match(prompt, /shop\.io\/checkout/);
  assert.match(prompt, /approve to continue/i);
});

// ── 3. the real handoff loop (runChallengeHandoff) ───────────────────────────

/** A page surface that starts walled and clears after the human "solves" it. */
function scriptedSurface(htmls) {
  let i = 0;
  return {
    getSurface: async () => ({ url: "https://shop.io/checkout", title: "Checkout", html: htmls[Math.min(i, htmls.length - 1)] }),
    settle: async () => { i++; }, // each re-check advances to the next scripted page
  };
}

test("handoff: walled → human solves → re-check clears → 'solved'", async () => {
  const surface = scriptedSurface(['<div class="g-recaptcha"></div>', "<h1>order complete</h1>"]);
  const calls = [];
  const result = await runChallengeHandoff({
    getSurface: surface.getSurface,
    settle: surface.settle,
    onChallenge: async (info) => { calls.push(info.kind); return "solved"; },
  });
  assert.equal(result, "solved");
  assert.deepEqual(calls, ["recaptcha"], "the human was asked exactly once");
});

test("handoff: a clean page never calls the handler ('clear')", async () => {
  let called = false;
  const result = await runChallengeHandoff({
    getSurface: async () => ({ url: "https://x.io", title: "Home", html: "<h1>hi</h1>" }),
    onChallenge: async () => { called = true; return "solved"; },
  });
  assert.equal(result, "clear");
  assert.equal(called, false);
});

test("handoff: human 'skip' gives up the page immediately", async () => {
  let settles = 0;
  const result = await runChallengeHandoff({
    getSurface: async () => ({ url: "https://x.io", html: "Please verify you are human" }),
    settle: async () => { settles++; },
    onChallenge: async () => "skip",
  });
  assert.equal(result, "skip");
  assert.equal(settles, 0, "no settle/re-check after a skip");
});

test("handoff: a stubborn wall that stays up doesn't loop forever (bounded rounds)", async () => {
  let asks = 0;
  const result = await runChallengeHandoff({
    getSurface: async () => ({ url: "https://x.io", html: '<div class="h-captcha"></div>' }),
    settle: async () => {},
    onChallenge: async () => { asks++; return "solved"; },
    maxRounds: 2,
  });
  assert.equal(result, "solved");
  assert.equal(asks, 2, "bounded to maxRounds, not infinite");
});
