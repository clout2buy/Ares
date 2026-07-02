// WebFetch JS rendering — heuristic detection of JS-gated pages, the injected
// renderer path, graceful degradation, the ARES_WEBFETCH_JS=0 knob, and the
// raw CDP client against a fake debug endpoint (no real browser).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";

import {
  makeWebFetchTool,
  htmlToText,
  looksJsGated,
  discoverCdpEndpoint,
  renderOverCdp,
} from "../packages/tools/dist/index.js";

const SPA_SHELL =
  '<!DOCTYPE html><html><head><title>App</title><script src="/static/bundle.js"></script></head>' +
  '<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>';

const CONTENT_PAGE =
  "<!DOCTYPE html><html><head><title>Docs</title><script>var x=1;</script></head><body><article>" +
  "<h1>Real documentation</h1>" +
  "<p>This page has plenty of server-rendered text content that a plain fetch can read directly. " +
  "It describes an API in detail, with examples, parameters, return values, and error semantics, " +
  "so no JavaScript rendering is ever needed to extract its meaning.</p>" +
  "</article></body></html>";

const HYDRATED_HTML =
  '<html><head><title>App</title></head><body><div id="root"><main>' +
  "<h1>Hydrated dashboard</h1><p>This content only exists after client-side JavaScript ran: " +
  "widgets, tables, and the actual text the agent was looking for in the first place.</p>" +
  "</main></div></body></html>";

function ctx() {
  return {
    workspace: process.cwd(),
    signal: new AbortController().signal,
    permissionMode: "bypass",
    fileReadStamps: new Map(),
  };
}

function input(url) {
  return { url, max_chars: 20_000, offset: 0 };
}

function stubFetch(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  return () => {
    globalThis.fetch = original;
  };
}

// ─── Heuristic ─────────────────────────────────────────────────────────

test("looksJsGated: SPA shell (empty root + noscript) is detected", () => {
  assert.equal(looksJsGated(SPA_SHELL, htmlToText(SPA_SHELL)), true);
});

test("looksJsGated: content-rich server-rendered page is not flagged", () => {
  assert.equal(looksJsGated(CONTENT_PAGE, htmlToText(CONTENT_PAGE)), false);
});

test("looksJsGated: tiny page without scripts is not flagged", () => {
  const html = "<html><body><p>hi</p></body></html>";
  assert.equal(looksJsGated(html, htmlToText(html)), false);
});

test("looksJsGated: near-zero text with heavy script markup is flagged", () => {
  const html = `<html><head><script src="/a.js"></script></head><body><div class="mount"></div>${"<!-- pad -->".repeat(200)}</body></html>`;
  assert.equal(looksJsGated(html, htmlToText(html)), true);
});

// ─── Renderer wiring in the tool ───────────────────────────────────────

test("WebFetch: JS-gated page is rendered through the injected renderer", async () => {
  const restore = stubFetch(SPA_SHELL);
  try {
    let renderedUrl = null;
    const renderer = {
      render: async (url) => {
        renderedUrl = url;
        return HYDRATED_HTML;
      },
    };
    const tool = makeWebFetchTool(undefined, renderer);
    const r = await tool.call(input("https://spa.example/app"), ctx());
    assert.equal(renderedUrl, "https://spa.example/app");
    assert.equal(r.output.jsRendered, true);
    assert.match(r.output.text, /Hydrated dashboard/);
    assert.match(r.output.note, /rendered via an attached Chromium/i);
    assert.match(r.display, /js-rendered/);
  } finally {
    restore();
  }
});

test("WebFetch: no browser available degrades to the plain fetch result with a note", async () => {
  const restore = stubFetch(SPA_SHELL);
  try {
    const renderer = {
      render: async () => {
        throw new Error("no Chromium debug endpoint reachable");
      },
    };
    const tool = makeWebFetchTool(undefined, renderer);
    const r = await tool.call(input("https://spa.example/"), ctx());
    assert.notEqual(r.output.jsRendered, true);
    assert.match(r.output.note, /JS rendering was unavailable/);
    assert.match(r.output.note, /no Chromium debug endpoint/);
    // The plain fetch text is still returned (untrusted framing + shell text).
    assert.match(r.output.text, /untrusted data/);
    assert.doesNotMatch(r.output.text, /Hydrated dashboard/);
  } finally {
    restore();
  }
});

test("WebFetch: ARES_WEBFETCH_JS=0 disables the whole path", async () => {
  const restore = stubFetch(SPA_SHELL);
  process.env.ARES_WEBFETCH_JS = "0";
  try {
    let called = 0;
    const renderer = {
      render: async () => {
        called += 1;
        return HYDRATED_HTML;
      },
    };
    const tool = makeWebFetchTool(undefined, renderer);
    const r = await tool.call(input("https://spa.example/"), ctx());
    assert.equal(called, 0);
    assert.equal(r.output.jsRendered, undefined);
    assert.equal(r.output.note, undefined);
  } finally {
    delete process.env.ARES_WEBFETCH_JS;
    restore();
  }
});

test("WebFetch: content-rich page never triggers the renderer", async () => {
  const restore = stubFetch(CONTENT_PAGE);
  try {
    let called = 0;
    const renderer = {
      render: async () => {
        called += 1;
        return HYDRATED_HTML;
      },
    };
    const tool = makeWebFetchTool(undefined, renderer);
    const r = await tool.call(input("https://docs.example/api"), ctx());
    assert.equal(called, 0);
    assert.match(r.output.text, /Real documentation/);
  } finally {
    restore();
  }
});

test("WebFetch: render that adds nothing keeps the fetch text and says so", async () => {
  const restore = stubFetch(SPA_SHELL);
  try {
    const renderer = { render: async () => "<html><body></body></html>" };
    const tool = makeWebFetchTool(undefined, renderer);
    const r = await tool.call(input("https://spa.example/"), ctx());
    assert.notEqual(r.output.jsRendered, true);
    assert.match(r.output.note, /no additional content/);
  } finally {
    restore();
  }
});

// ─── Raw CDP client against a fake debug endpoint ──────────────────────

test("renderOverCdp: drives a fake CDP endpoint end to end", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server });
  const seen = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      seen.push(msg.method);
      const reply = (result) => socket.send(JSON.stringify({ id: msg.id, result }));
      switch (msg.method) {
        case "Target.createTarget":
          reply({ targetId: "t1" });
          break;
        case "Target.attachToTarget":
          reply({ sessionId: "s1" });
          break;
        case "Page.enable":
          reply({});
          break;
        case "Page.navigate":
          reply({ frameId: "f1" });
          socket.send(JSON.stringify({ method: "Page.loadEventFired", sessionId: "s1", params: { timestamp: 1 } }));
          break;
        case "Runtime.evaluate":
          assert.equal(msg.sessionId, "s1");
          reply({ result: { type: "string", value: HYDRATED_HTML } });
          break;
        case "Target.closeTarget":
          reply({ success: true });
          break;
        default:
          reply({});
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const html = await renderOverCdp("https://spa.example/", {
      endpoint: `http://127.0.0.1:${port}`,
      settleMs: 0,
      timeoutMs: 8_000,
    });
    assert.match(html, /Hydrated dashboard/);
    assert.deepEqual(seen.slice(0, 4), ["Target.createTarget", "Target.attachToTarget", "Page.enable", "Page.navigate"]);
    assert.ok(seen.includes("Target.closeTarget"), "throwaway tab must be closed");
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("discoverCdpEndpoint: dead endpoint returns null", async () => {
  assert.equal(await discoverCdpEndpoint({ endpoint: "http://127.0.0.1:1" }), null);
});

test("renderOverCdp: no endpoint and discovery off throws a clear error", async () => {
  const savedUrl = process.env.ARES_BROWSER_CDP_URL;
  const savedDiscovery = process.env.ARES_BROWSER_CDP_DISCOVERY;
  delete process.env.ARES_BROWSER_CDP_URL;
  process.env.ARES_BROWSER_CDP_DISCOVERY = "0";
  try {
    await assert.rejects(renderOverCdp("https://spa.example/"), /no Chromium debug endpoint reachable/);
  } finally {
    if (savedUrl !== undefined) process.env.ARES_BROWSER_CDP_URL = savedUrl;
    if (savedDiscovery !== undefined) process.env.ARES_BROWSER_CDP_DISCOVERY = savedDiscovery;
    else delete process.env.ARES_BROWSER_CDP_DISCOVERY;
  }
});
