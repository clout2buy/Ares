// An SSE MCP connector dropping its stream must never crash the daemon.
//
// Field crash loop (2026-09-11): garrison died four times in six seconds with
//   unhandledRejection: MCP SSE client closed
//     at SseMcpClient.close ... at LiveMcpTools.doRefresh
// A background tool-refresh opened an SSE connector; runSse always close()s in
// its finally, even on success; close() -> failAll rejected the endpointReady
// promise (and any orphaned request) with no handler left, and the unhandled
// rejection took down the whole process — which also stopped the remote-agent
// server, so pairing links could not be minted either.
//
// This drives a real SseMcpClient against an in-process SSE server and asserts
// that the ordinary open -> use -> close lifecycle raises no unhandled
// rejection, including when the server drops the stream underneath it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { SseMcpClient } from "../packages/tools/dist/Mcp.js";

/**
 * Minimal MCP-over-SSE server. Answers the GET stream with an `endpoint`
 * event, then handles JSON-RPC POSTs. `dropAfterInitialize` closes the stream
 * mid-session to reproduce the connector-drop that triggered the crash.
 */
function startSseServer({ dropAfterInitialize = false } = {}) {
  let streamRes = null;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = `http://127.0.0.1:${server.address().port}`;
      res.write(`event: endpoint\ndata: ${base}/rpc\n\n`);
      streamRes = res;
      return;
    }
    // POST /rpc — read the body, answer by id.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") {
        reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } });
        if (dropAfterInitialize && streamRes) {
          // The connector vanishes mid-session — exactly the field trigger.
          setTimeout(() => { try { streamRes.end(); } catch {} }, 20);
        }
        return;
      }
      if (msg.method === "tools/list") { reply({ tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] }); return; }
      reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/sse` }));
  });
}

/** Fail the test if ANY unhandled rejection fires during `fn`. */
async function assertNoUnhandledRejection(fn) {
  const seen = [];
  const onRejection = (err) => seen.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    await fn();
    // Give a microtask+timer beat for a late rejection (the close/race paths
    // reject asynchronously) to surface before we judge.
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.equal(seen.length, 0, `unhandled rejection(s): ${seen.map((e) => e?.message ?? e).join("; ")}`);
}

test("open → initialize → use → close raises no unhandled rejection", async () => {
  const { server, url } = await startSseServer();
  try {
    await assertNoUnhandledRejection(async () => {
      const client = new SseMcpClient(url, {}, fetch, "fake");
      try {
        await client.open();
        await client.initialize();
        const tools = await client.request("tools/list", {});
        assert.ok(Array.isArray(tools.tools));
      } finally {
        client.close();   // the runSse finally, on the SUCCESS path
      }
    });
  } finally {
    server.close();
  }
});

test("a server that drops the stream mid-session does not crash the process", async () => {
  const { server, url } = await startSseServer({ dropAfterInitialize: true });
  try {
    await assertNoUnhandledRejection(async () => {
      const client = new SseMcpClient(url, {}, fetch, "fake");
      try {
        await client.open();
        await client.initialize();
      } catch {
        // The drop may surface as a caught error — that is fine; what must NOT
        // happen is an UNHANDLED rejection.
      } finally {
        client.close();
      }
    });
  } finally {
    server.close();
  }
});

test("closing immediately after open (before any request) is clean", async () => {
  const { server, url } = await startSseServer();
  try {
    await assertNoUnhandledRejection(async () => {
      const client = new SseMcpClient(url, {}, fetch, "fake");
      await client.open();
      client.close();   // endpointReady already resolved; close rejects it — must be swallowed
    });
  } finally {
    server.close();
  }
});

test("double close is harmless", async () => {
  const { server, url } = await startSseServer();
  try {
    await assertNoUnhandledRejection(async () => {
      const client = new SseMcpClient(url, {}, fetch, "fake");
      await client.open();
      client.close();
      client.close();
    });
  } finally {
    server.close();
  }
});
