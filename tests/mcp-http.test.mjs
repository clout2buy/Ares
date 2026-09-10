// Phase 1 — remote MCP over Streamable HTTP. Drives HttpMcpClient with a mock
// fetch: asserts the initialize handshake, session-id capture + echo, JSON and
// SSE response parsing, bearer auth, and error surfacing.

import test from "node:test";
import assert from "node:assert/strict";
import { HttpMcpClient } from "../packages/tools/dist/index.js";

function jsonRes(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: async () => JSON.stringify(body),
  };
}
function sseRes(body, headers = {}) {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream", ...headers }),
    text: async () => payload,
  };
}

test("initialize captures + echoes the session id and sends the bearer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (JSON.parse(init.body).method === "initialize") {
      return jsonRes({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "sess-42" });
    }
    return jsonRes({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  };
  const client = new HttpMcpClient("https://mcp.example/rpc", { Authorization: "Bearer tok" }, fetchImpl);
  await client.initialize();
  const result = await client.request("tools/list", {});
  assert.deepEqual(result, { ok: true });

  // Every request carried the bearer.
  assert.ok(calls.every((c) => c.init.headers.Authorization === "Bearer tok"));
  // The tools/list request (after init returned a session id) echoed it.
  const listCall = calls.find((c) => JSON.parse(c.init.body).method === "tools/list");
  assert.equal(listCall.init.headers["mcp-session-id"], "sess-42");
});

test("parses an SSE-framed JSON-RPC response", async () => {
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: {} });
    return sseRes({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }] } });
  };
  const client = new HttpMcpClient("https://mcp.example/rpc", {}, fetchImpl);
  await client.initialize();
  const result = await client.request("tools/list", {});
  assert.deepEqual(result, { tools: [{ name: "search" }] });
});

test("surfaces a JSON-RPC error and an auth rejection", async () => {
  const errClient = new HttpMcpClient("https://mcp.example/rpc", {}, async () =>
    jsonRes({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }),
  );
  await assert.rejects(() => errClient.request("tools/call", {}), /boom/);

  const authClient = new HttpMcpClient("https://mcp.example/rpc", {}, async () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    text: async () => "",
  }));
  await assert.rejects(() => authClient.request("tools/list", {}), /rejected (auth|the connection)/);
});
