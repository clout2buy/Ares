// The intro cinematic — a pure function of tick. Assert each phase lands at the
// right frame, plus the small-terminal fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { frame, strip } from "./helpers.mjs";
import { h } from "./helpers.mjs";

import { SLATE } from "../../dist/ui/theme.js";
import { IntroScreen, introRevealCols, INTRO_TOTAL_TICKS } from "../../dist/ui/IntroScreen.js";
import { LOGO_WIDTH } from "../../dist/ui/Logo.js";

const big = (tick) => strip(frame(h(IntroScreen, { theme: SLATE, tick, width: 80, height: 24 })));

test("intro: wordmark wipes on left→right, full by ~tick 16", () => {
  assert.equal(introRevealCols(0), 0, "nothing at tick 0");
  assert.ok(introRevealCols(20) >= LOGO_WIDTH, "fully revealed by tick 20");
  const t0 = big(0);
  assert.doesNotMatch(t0, /█/, "no block art at tick 0");
  const t20 = big(20);
  assert.match(t20, /█/, "block art present once revealed");
});

test("intro: rule at >14, tagline at >18, skip-hint after 12", () => {
  assert.doesNotMatch(big(10), /the agent that ships/, "tagline hidden early");
  assert.doesNotMatch(big(10), /─{40}/, "rule hidden early");
  const late = big(20);
  assert.match(late, /─{40}/, "rule shows after 14");
  assert.match(late, /the agent that ships/, "tagline shows after 18");
  // skip hint blinks (cursorOn phase) — on at ticks 16-19, off at 12-15/20-23.
  assert.match(big(16), /press any key/, "skip hint on during its blink-on phase");
  assert.doesNotMatch(big(20), /press any key/, "skip hint off during its blink-off phase");
});

test("intro: small terminal falls back to a centered ARES", () => {
  const small = strip(frame(h(IntroScreen, { theme: SLATE, tick: 20, width: 30, height: 8 })));
  assert.match(small, /ARES/);
  assert.doesNotMatch(small, /█/, "no big art in the fallback");
});

test("intro: total-ticks budget is sane", () => {
  assert.ok(INTRO_TOTAL_TICKS >= 30 && INTRO_TOTAL_TICKS <= 60);
});
