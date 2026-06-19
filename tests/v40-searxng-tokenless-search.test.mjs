// Verifies the tokenless SearXNG search backend — the "no API key" path:
//   1. With ARES_SEARXNG_URL set, it queries the instance and parses results.
//   2. Without a URL, it fast-fails so the fallback chain drops through cleanly.
//   3. The default chain includes SearXNG (so dropping in a URL just works).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { searxngSearch, defaultSearchChain } from "../packages/tools/dist/index.js";
import { setCredential } from "../packages/core/dist/index.js";

async function freshHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v40-"));
  process.env.ARES_HOME = home;
  delete process.env.ARES_SEARXNG_URL;
  delete process.env.SEARXNG_URL;
  return home;
}

test("searxng: queries the configured instance and parses results", async (t) => {
  const home = await freshHome();
  await setCredential("ARES_SEARXNG_URL", "http://localhost:8080", { home });

  let calledUrl = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "Curly Hair Salon — Dublin OH", url: "https://example.com/salon", content: "Natural & type-4 specialists" },
          { title: "", url: "https://skip.me" }, // missing title → dropped
        ],
      }),
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const results = await searxngSearch().search("curly hair salon dublin ohio", new AbortController().signal);
  assert.match(calledUrl, /\/search\?q=curly%20hair%20salon/);
  assert.match(calledUrl, /format=json/);
  assert.equal(results.length, 1, "rows without a title/url are dropped");
  assert.equal(results[0].title, "Curly Hair Salon — Dublin OH");
  assert.equal(results[0].url, "https://example.com/salon");
});

test("searxng: with no instance URL it fast-fails (so the chain falls through)", async () => {
  await freshHome();
  await assert.rejects(
    () => searxngSearch().search("anything", new AbortController().signal),
    /no instance URL/,
  );
});

test("searxng: the default search chain includes it", () => {
  const chain = defaultSearchChain();
  assert.match(chain.name, /SearXNG/, "default chain wires SearXNG between the premium APIs and DuckDuckGo");
});
