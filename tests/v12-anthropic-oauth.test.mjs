import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearAnthropicTokens,
  finishAnthropicLogin,
  loadAnthropicTokens,
  resolveAnthropicAccessToken,
  startAnthropicLogin,
} from "../packages/core/dist/index.js";

const sandbox = await mkdtemp(path.join(os.tmpdir(), "ares-anthropic-oauth-"));
process.env.ARES_HOME = path.join(sandbox, "ares");

test.after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test("Anthropic OAuth mirrors the working Crypt loopback PKCE flow", () => {
  const challenge = startAnthropicLogin();
  const url = new URL(challenge.authorizeUrl);

  assert.equal(url.origin, "https://claude.ai");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:53692/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code"), "true");
  assert.ok(challenge.pkceVerifier.length >= 43, "verifier must be at least 43 chars");
  assert.equal(challenge.state, challenge.pkceVerifier, "Claude Code uses the verifier as state");
  assert.equal(challenge.port, 53692);
  const scope = url.searchParams.get("scope") ?? "";
  assert.ok(scope.includes("user:inference"), "scope must include user:inference");
  assert.ok(scope.includes("user:profile"), "scope must include user:profile");
  assert.ok(scope.includes("user:sessions:claude_code"));
  assert.ok(scope.includes("user:mcp_servers"));
  assert.ok(scope.includes("user:file_upload"));
});

test("Anthropic OAuth challenge produces a unique state and verifier each call", () => {
  const a = startAnthropicLogin();
  const b = startAnthropicLogin();
  assert.notEqual(a.state, b.state, "state must be unique per challenge");
  assert.notEqual(a.pkceVerifier, b.pkceVerifier, "verifier must be unique per challenge");
});

test("manual Claude OAuth completion sends Crypt-compatible token payload", async () => {
  const challenge = startAnthropicLogin();
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const result = await finishAnthropicLogin(
    `https://localhost/callback?code=auth-code&state=${challenge.state}`,
    challenge.pkceVerifier,
    challenge.state,
    fetchImpl,
  );

  assert.equal(result.accessToken, "access");
  assert.equal(request.url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(request.body.state, challenge.pkceVerifier);
  assert.equal(request.body.code_verifier, challenge.pkceVerifier);
  assert.equal(request.body.redirect_uri, "http://localhost:53692/callback");
  assert.match(request.init.headers["User-Agent"], /^claude-cli\//);
});

test("manual Claude OAuth completion rejects a mismatched state", async () => {
  const challenge = startAnthropicLogin();
  await assert.rejects(
    finishAnthropicLogin("auth-code#wrong-state", challenge.pkceVerifier, challenge.state),
    /state mismatch/i,
  );
});

test("Ares does not import credentials owned by Claude Code or Crypt", async () => {
  // resolveAnthropicAccessToken() deliberately honours these two env vars, so a
  // machine that exports them (doingbox does, via ~/.profile) short-circuits
  // before any file is read and this assertion fails for the wrong reason.
  // This test is about FILE imports only, so it scrubs its own inputs.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
  await clearAnthropicTokens();
  await writeFile(path.join(sandbox, "claude-credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:profile"],
    },
  }));
  await writeFile(path.join(sandbox, "crypt-auth.json"), JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "crypt-access",
      refresh: "crypt-refresh",
      expires: Date.now() + 7_200_000,
    },
  }));

  const tokens = await loadAnthropicTokens();
  assert.equal(tokens, null);
  assert.equal(await resolveAnthropicAccessToken(), null);
});

async function writeExpiredTokens(refreshToken) {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(process.env.ARES_HOME, { recursive: true });
  await writeFile(path.join(process.env.ARES_HOME, "anthropic-oauth.json"), JSON.stringify({
    accessToken: "old-access",
    refreshToken,
    expiresAt: Date.now() - 1_000,
  }));
}

test("concurrent streams on an expired token share ONE refresh exchange", async () => {
  await writeExpiredTokens("rotating-refresh");
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated", expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const tokens = await Promise.all([
    resolveAnthropicAccessToken(fetchImpl),
    resolveAnthropicAccessToken(fetchImpl),
    resolveAnthropicAccessToken(fetchImpl),
  ]);
  assert.deepEqual(tokens, ["fresh-access", "fresh-access", "fresh-access"]);
  assert.equal(posts, 1, "a rotating refresh token is presented once, not once per caller");
});

test("a token endpoint that never answers fails the refresh in seconds instead of holding the turn", async () => {
  await writeExpiredTokens("hung-refresh");
  process.env.ARES_ANTHROPIC_REFRESH_TIMEOUT_MS = "600";
  try {
    // Ignores the abort signal on purpose: the deadline must not depend on it.
    const fetchImpl = () => new Promise(() => {});
    const started = Date.now();
    const token = await resolveAnthropicAccessToken(fetchImpl);
    assert.equal(token, null, "a failed refresh reads as signed-out, which the stream reports as no_auth");
    assert.ok(Date.now() - started < 3_000, `refresh gave up after ${Date.now() - started}ms`);
  } finally {
    delete process.env.ARES_ANTHROPIC_REFRESH_TIMEOUT_MS;
  }
});
