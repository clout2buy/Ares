// An in-test OAuth 2.x authorization server (and a tiny MCP resource behind it).
//
// It implements just enough of the real protocols to prove the engine against
// something that BEHAVES like a vendor: RFC 8414 / 9728 discovery, RFC 7591
// registration (optionally with a redirect allowlist, like Vercel), PKCE S256,
// single-use authorization codes, refresh-token ROTATION with reuse detection,
// RFC 8628 device authorization (authorization_pending / slow_down / denied /
// expired), RFC 7009 revocation, userinfo, and Client ID Metadata Documents.
// Everything it issues is recorded in `issued` so tests can assert no secret
// ever leaks into a log, a phone response or the on-disk vault.

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rid = (p) => `${p}_${randomBytes(12).toString("hex")}`;

export async function startMockAuthServer(opts = {}) {
  const o = {
    dcr: true,
    /** null = accept any https/loopback redirect; array = allowlisted prefixes. */
    redirectAllowlist: null,
    device: true,
    revocation: true,
    cimd: false,
    rotate: true,
    accessTtl: 3600,
    /** A pre-registered client (no DCR): { id, secret? } */
    fixedClient: null,
    issParam: true,
    ...opts,
  };
  const state = {
    clients: new Map(), // id -> { redirectUris, secret?, authMethod }
    codes: new Map(), // code -> { clientId, redirectUri, challenge, scope, resource, used }
    access: new Map(), // token -> { clientId, scope, revoked }
    refresh: new Map(), // token -> { clientId, scope, active, family }
    devices: new Map(), // device_code -> { clientId, userCode, status, polls, lastPoll, expiresAt }
    families: new Map(), // family -> revoked
    issued: [], // every secret ever handed out (tokens, codes, client secrets)
    requests: [], // { method, path, body } for assertions about what hit the server
    slowDownOnce: false,
    deviceExpiresIn: 900,
    deviceInterval: 5,
  };
  if (o.fixedClient) state.clients.set(o.fixedClient.id, { redirectUris: null, secret: o.fixedClient.secret, authMethod: o.fixedClient.secret ? "client_secret_post" : "none" });

  let origin = "";
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const note = (value) => { state.issued.push(value); return value; };

  function clientAuth(req, form) {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    let via = secret ? "post" : "none";
    const auth = req.headers.authorization;
    if (auth?.startsWith("Basic ")) {
      const [u, p] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
      id = decodeURIComponent(u.replace(/\+/g, " "));
      secret = decodeURIComponent((p ?? "").replace(/\+/g, " "));
      via = "basic";
    }
    return { id, secret, via };
  }

  async function resolveClient(id) {
    const known = state.clients.get(id);
    if (known) return known;
    if (o.cimd && /^https?:\/\//.test(id ?? "")) {
      try {
        const doc = await (await fetch(id)).json();
        if (doc.client_id === id && Array.isArray(doc.redirect_uris)) {
          const c = { redirectUris: doc.redirect_uris, authMethod: "none", cimd: true };
          state.clients.set(id, c);
          return c;
        }
      } catch { /* fall through */ }
    }
    return null;
  }

  function issueTokens(clientId, scope, family, withRefresh = true) {
    const access = note(rid("at"));
    state.access.set(access, { clientId, scope, revoked: false });
    const body = { access_token: access, token_type: "Bearer", expires_in: o.accessTtl, ...(scope ? { scope } : {}) };
    if (withRefresh) {
      const rt = note(rid("rt"));
      state.refresh.set(rt, { clientId, scope, active: true, family: family ?? rid("fam") });
      body.refresh_token = rt;
    }
    return body;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin || "http://x");
    const bodyText = req.method === "POST" ? await readBody(req) : "";
    state.requests.push({ method: req.method, path: url.pathname, body: bodyText });
    const form = new URLSearchParams(req.headers["content-type"]?.includes("json") ? "" : bodyText);

    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(o.dcr ? { registration_endpoint: `${origin}/register` } : {}),
        ...(o.device ? { device_authorization_endpoint: `${origin}/device_authorization` } : {}),
        ...(o.revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
        userinfo_endpoint: `${origin}/userinfo`,
        scopes_supported: ["read", "write"],
        grant_types_supported: ["authorization_code", "refresh_token", ...(o.device ? ["urn:ietf:params:oauth:grant-type:device_code"] : [])],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        ...(o.issParam ? { authorization_response_iss_parameter_supported: true } : {}),
        ...(o.cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(bodyText || "{}");
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (o.redirectAllowlist && !uris.every((u) => o.redirectAllowlist.some((p) => u.startsWith(p)))) {
        return json(res, 400, { error: "invalid_redirect_uri", error_description: "The provided redirect URIs are not approved for use by this authorization server." });
      }
      const id = rid("cl");
      state.clients.set(id, { redirectUris: uris, authMethod: "none" });
      return json(res, 201, { client_id: id, token_endpoint_auth_method: "none", redirect_uris: uris, grant_types: body.grant_types, client_name: body.client_name });
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      const client = await resolveClient(q.get("client_id"));
      if (!client) return json(res, 400, { error: "invalid_client" });
      const redirect = q.get("redirect_uri");
      if (client.redirectUris && !client.redirectUris.includes(redirect)) return json(res, 400, { error: "invalid_redirect_uri" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
      const target = new URL(redirect);
      if (q.get("deny") === "1" || o.deny) {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("state", q.get("state"));
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      const code = note(rid("code"));
      state.codes.set(code, { clientId: q.get("client_id"), redirectUri: redirect, challenge: q.get("code_challenge"), scope: q.get("scope") ?? "", resource: q.get("resource") ?? "", used: false });
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.get("state"));
      if (o.issParam) target.searchParams.set("iss", origin);
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (url.pathname === "/device_authorization" && req.method === "POST") {
      const { id } = clientAuth(req, form);
      if (!state.clients.has(id)) return json(res, 400, { error: "invalid_client" });
      const deviceCode = note(rid("dc"));
      const userCode = "WDJB-MJHT";
      state.devices.set(deviceCode, { clientId: id, userCode, status: "pending", polls: 0, lastPoll: 0, expiresAt: Date.now() + state.deviceExpiresIn * 1000, scope: form.get("scope") ?? "" });
      return json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=${userCode}`,
        expires_in: state.deviceExpiresIn,
        interval: state.deviceInterval,
      });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const ct = req.headers["content-type"] ?? "";
      const f = ct.includes("json") ? new URLSearchParams(Object.entries(JSON.parse(bodyText || "{}"))) : form;
      const { id, secret } = clientAuth(req, f);
      const client = await resolveClient(id);
      if (!client) return json(res, 401, { error: "invalid_client" });
      if (client.secret && client.secret !== secret) return json(res, 401, { error: "invalid_client", error_description: "bad client secret" });
      const grant = f.get("grant_type");
      if (grant === "authorization_code") {
        const rec = state.codes.get(f.get("code") ?? "");
        if (!rec || rec.clientId !== id) return json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
        if (rec.used) return json(res, 400, { error: "invalid_grant", error_description: "code already used" });
        rec.used = true;
        if (rec.redirectUri !== f.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        const challenge = b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest());
        if (challenge !== rec.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return json(res, 200, issueTokens(id, rec.scope));
      }
      if (grant === "refresh_token") {
        const rt = state.refresh.get(f.get("refresh_token") ?? "");
        if (!rt || rt.clientId !== id) return json(res, 400, { error: "invalid_grant" });
        if (!rt.active || state.families.get(rt.family)) {
          // reuse of a rotated token: revoke the whole family (OAuth 2.1 §4.3.1)
          state.families.set(rt.family, true);
          return json(res, 400, { error: "invalid_grant", error_description: "refresh token reuse detected" });
        }
        if (o.rotate) {
          rt.active = false;
          return json(res, 200, issueTokens(id, rt.scope, rt.family));
        }
        return json(res, 200, issueTokens(id, rt.scope, rt.family, false));
      }
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        const d = state.devices.get(f.get("device_code") ?? "");
        if (!d || d.clientId !== id) return json(res, 400, { error: "invalid_grant" });
        d.polls += 1;
        if (state.slowDownOnce) { state.slowDownOnce = false; return json(res, 400, { error: "slow_down" }); }
        if (Date.now() > d.expiresAt) return json(res, 400, { error: "expired_token" });
        if (d.status === "denied") return json(res, 400, { error: "access_denied" });
        if (d.status === "pending") return json(res, 400, { error: "authorization_pending" });
        return json(res, 200, issueTokens(id, d.scope));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const { id } = clientAuth(req, form);
      if (!(await resolveClient(id))) return json(res, 401, { error: "invalid_client" });
      const t = form.get("token");
      if (state.access.has(t)) state.access.get(t).revoked = true;
      if (state.refresh.has(t)) {
        const r = state.refresh.get(t);
        r.active = false;
        state.families.set(r.family, true);
        for (const [at, a] of state.access) if (a.clientId === r.clientId) a.revoked = true;
      }
      return json(res, 200, {});
    }
    if (url.pathname === "/userinfo") {
      const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const a = state.access.get(t);
      if (!a || a.revoked) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { email: "owner@example.com", name: "The Owner", sub: "u1" });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const a = state.access.get(t);
      if (!a || a.revoked) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`, "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_token" }));
      }
      const rpc = JSON.parse(bodyText || "{}");
      if (rpc.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "ping" }, { name: "list" }] } });
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    state,
    options: o,
    mcpUrl: `${origin}/mcp`,
    /** Play the owner: open the authorize URL, approve, return the redirect URL the browser would follow. */
    async consent(authorizeUrl, { deny = false } = {}) {
      const u = new URL(authorizeUrl);
      if (deny) u.searchParams.set("deny", "1");
      const res = await fetch(u, { redirect: "manual" });
      if (res.status !== 302) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
      return res.headers.get("location");
    },
    approveDevice(userCode = "WDJB-MJHT") {
      for (const d of state.devices.values()) if (d.userCode === userCode && d.status === "pending") d.status = "approved";
    },
    denyDevice(userCode = "WDJB-MJHT") {
      for (const d of state.devices.values()) if (d.userCode === userCode) d.status = "denied";
    },
    expireAccessTokens() { for (const a of state.access.values()) a.revoked = true; },
    /** Every secret the server handed out, for leak assertions. */
    secrets() { return [...state.issued]; },
    close() { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  };
}
