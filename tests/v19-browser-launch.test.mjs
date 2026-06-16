// Verifies the browser launch-strategy ordering — the fallback chain that makes
// the packaged Playwright actually start a browser on a real machine instead of
// demanding `playwright install`: detected exe → Edge channel → Chrome channel →
// bundled Chromium. Pure ordering logic, no browser needed.

import test from "node:test";
import assert from "node:assert/strict";

import { browserLaunchAttempts } from "../packages/connectors/dist/index.js";

test("launch attempts: detected executable comes first (best fingerprint)", () => {
  const attempts = browserLaunchAttempts("C:/Edge/msedge.exe");
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts[0].options, { executablePath: "C:/Edge/msedge.exe" });
  assert.deepEqual(
    attempts.slice(1).map((a) => a.options),
    [{ channel: "msedge" }, { channel: "chrome" }, {}],
  );
});

test("launch attempts: no detected exe falls back to channels then bundled", () => {
  const attempts = browserLaunchAttempts(undefined);
  assert.equal(attempts.length, 3, "no executable attempt when none detected");
  assert.deepEqual(
    attempts.map((a) => a.options),
    [{ channel: "msedge" }, { channel: "chrome" }, {}],
  );
});

test("launch attempts: the last resort is bundled Chromium (empty options)", () => {
  for (const exe of ["C:/x/chrome.exe", undefined]) {
    const attempts = browserLaunchAttempts(exe);
    assert.deepEqual(attempts.at(-1).options, {}, "bundled Chromium is always the floor");
  }
});

test("launch attempts: every attempt carries a human label for diagnostics", () => {
  for (const a of browserLaunchAttempts("C:/Edge/msedge.exe")) {
    assert.ok(typeof a.label === "string" && a.label.length > 0);
  }
});
