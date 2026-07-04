// Phase 2 — the MCP OAuth handshake (generic, no per-server config). Drives the
// pure protocol helpers with a mocked fetch: metadata discovery (RFC 9728 →
// 8414), dynamic client registration (RFC 7591), PKCE (RFC 7636), and the
// authorization-code token exchange (RFC 8707 resource binding).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  generatePkce,
  discoverMcpAuth,
  registerMcpClient,
  buildMcpAuthorizeUrl,
  exchangeMcpCode,
} from "../packages/core/dist/index.js";

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

test("generatePkce derives an S256 challenge from the verifier", () => {
  const { verifier, challenge, method } = generatePkce("test_verifier_value");
  const expected = createHash("sha256").update("test_verifier_value").digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(method, "S256");
  assert.equal(challenge, expected);
  assert.equal(verifier, "test_verifier_value");
});

test("discoverMcpAuth follows protected-resource → auth-server metadata", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return jsonOk({ resource: "https://mcp.example", authorization_servers: ["https://auth.example"] });
    }
    if (url === "https://auth.example/.well-known/oauth-authorization-server") {
      return jsonOk({
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        scopes_supported: ["read", "write"],
      });
    }
    return notFound();
  };
  const as = await discoverMcpAuth("https://mcp.example/rpc", { fetchImpl });
  assert.equal(as.authorizationEndpoint, "https://auth.example/authorize");
  assert.equal(as.tokenEndpoint, "https://auth.example/token");
  assert.equal(as.registrationEndpoint, "https://auth.example/register");
  assert.deepEqual(as.scopesSupported, ["read", "write"]);
  assert.equal(as.resource, "https://mcp.example");
});

test("discoverMcpAuth falls back to the MCP origin's well-known when no PRM", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://mcp.example/.well-known/oauth-authorization-server") {
      return jsonOk({ authorization_endpoint: "https://mcp.example/authorize", token_endpoint: "https://mcp.example/token" });
    }
    return notFound();
  };
  const as = await discoverMcpAuth("https://mcp.example/rpc", { fetchImpl });
  assert.equal(as.tokenEndpoint, "https://mcp.example/token");
  assert.equal(as.resource, "https://mcp.example"); // defaulted to origin
});

test("discoverMcpAuth throws a readable error when nothing is discoverable", async () => {
  await assert.rejects(() => discoverMcpAuth("https://mcp.example/rpc", { fetchImpl: async () => notFound() }), /No OAuth metadata/);
});

test("registerMcpClient posts a public-client DCR and returns the client_id", async () => {
  let sentBody;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return jsonOk({ client_id: "dyn-123" });
  };
  const reg = await registerMcpClient("https://auth.example/register", "http://localhost:53691/oauth/callback", { fetchImpl });
  assert.equal(reg.clientId, "dyn-123");
  assert.equal(sentBody.token_endpoint_auth_method, "none");
  assert.deepEqual(sentBody.redirect_uris, ["http://localhost:53691/oauth/callback"]);
  assert.ok(sentBody.grant_types.includes("authorization_code"));
});

test("buildMcpAuthorizeUrl sets PKCE + resource params", () => {
  const url = new URL(buildMcpAuthorizeUrl({
    authorizationEndpoint: "https://auth.example/authorize",
    clientId: "dyn-123",
    redirectUri: "http://localhost:53691/oauth/callback",
    challenge: "chal",
    state: "st",
    scopes: ["read"],
    resource: "https://mcp.example",
  }));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.example");
  assert.equal(url.searchParams.get("scope"), "read");
});

test("exchangeMcpCode swaps code+verifier for tokens with a computed expiry", async () => {
  let sentForm;
  const fetchImpl = async (url, init) => {
    sentForm = new URLSearchParams(init.body);
    return jsonOk({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" });
  };
  const tok = await exchangeMcpCode(
    { tokenEndpoint: "https://auth.example/token", clientId: "dyn-123", code: "abc", verifier: "ver", redirectUri: "http://localhost:53691/oauth/callback", resource: "https://mcp.example" },
    { fetchImpl, now: () => 1_000_000 },
  );
  assert.equal(tok.accessToken, "at");
  assert.equal(tok.refreshToken, "rt");
  assert.equal(tok.expiresAt, 1_000_000 + 3600 * 1000);
  assert.equal(sentForm.get("code_verifier"), "ver");
  assert.equal(sentForm.get("grant_type"), "authorization_code");
  assert.equal(sentForm.get("resource"), "https://mcp.example");
});

test("exchangeMcpCode surfaces the server's error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "expired code" }) });
  await assert.rejects(
    () => exchangeMcpCode({ tokenEndpoint: "https://auth.example/token", clientId: "x", code: "c", verifier: "v", redirectUri: "r", resource: "https://mcp.example" }, { fetchImpl }),
    /expired code/,
  );
});
