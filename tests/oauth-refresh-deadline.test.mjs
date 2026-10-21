// ChatGPT and Kimi token refreshes are single-flight: every caller awaits the
// one in-flight exchange. With no deadline, one exchange that never answered
// held every later turn on that provider forever. Same class as the Claude
// refresh fixed in 7a9bdf6.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ARES_OAUTH_REFRESH_TIMEOUT_MS = "300";
const home = mkdtempSync(path.join(os.tmpdir(), "ares-refresh-deadline-"));
process.env.ARES_HOME = home;
const { refreshOpenAIToken, refreshKimiTokens } = await import("../packages/core/dist/index.js");

const hung = () => new Promise(() => {});

test("a ChatGPT refresh that never answers gives up, and the next refresh is not stuck behind it", async () => {
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    mode: "chatgpt-oauth",
    tokens: { idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: 0 },
    profile: {},
  }));
  const started = Date.now();
  await assert.rejects(refreshOpenAIToken(hung), /timed out/);
  assert.ok(Date.now() - started < 2_000);
  const ok = async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
  const refreshed = await refreshOpenAIToken(ok);
  assert.equal(refreshed?.tokens.accessToken, "fresh");
});

test("a Kimi refresh that never answers gives up and frees the single flight", async () => {
  const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 0 };
  await assert.rejects(refreshKimiTokens(tokens, hung), /timed out/);
  const seen = [];
  const answer = async (url, init) => { seen.push(url); return new Response("{}", { status: 400 }); };
  assert.equal(await refreshKimiTokens(tokens, answer), null, "a later refresh runs its own exchange");
  assert.equal(seen.length, 1);
});
