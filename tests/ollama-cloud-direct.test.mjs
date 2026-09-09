// Ollama Cloud with an API key means NO local Ollama and NO pulls. The old
// shape stored local-style ids ("glm-5.1:cloud") that ollama.com never
// lists, so a valid cloud model failed preflight as "not installed — pull
// it". And the cloud catalog was a hand-edited list, so new releases
// (glm-5.2, glm-5.3, kimi-k3) were invisible until someone edited a file.
//
//  1. One canonical plain id; the pool rewrites it per host on the wire.
//  2. Cloud-direct requests carry the key and the plain name.
//  3. The live cloud catalog (public /api/tags) is newest-first and plain.
//  4. The daemon catalog for "ollama" is live, plain, newest-first, and
//     never alphabetical; the library rows say "pull required" in their group.
//  5. Preflight against ollama.com never says "pull".
//  6. Anthropic model listing carries context windows.

import test from "node:test";
import assert from "node:assert/strict";

const {
  OllamaCloudPool,
  toCloudDirectModelId,
  toLocalCloudModelId,
  sameOllamaModel,
  isOllamaCloudHost,
  fetchOllamaCloudModels,
  resetOllamaCloudCatalogCache,
  fetchAnthropicModels,
  DEFAULT_OLLAMA_SLOTS,
  OLLAMA_CLOUD_MODELS,
} = await import("../packages/core/dist/index.js");
const { daemonModelCatalog, selectProvider } = await import("../packages/cli/dist/entry/providers.js");
const { modelContextWindow } = await import("../packages/cli/dist/entry/sessionFactory.js");

const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const TAGS = {
  models: [
    { name: "glm-5.1", modified_at: "2026-04-07T00:00:00Z", size: 1, details: { parameter_size: "355B", family: "glm" } },
    { name: "glm-5.3", modified_at: "2026-08-28T00:00:00Z", size: 1, details: { parameter_size: "400B", family: "glm" } },
    { name: "gpt-oss:120b", modified_at: "2025-08-05T00:00:00Z", size: 1, details: {} },
    { name: "kimi-k3", modified_at: "2026-07-27T00:00:00Z", size: 1, details: { family: "kimi" } },
  ],
};

test("ids: one plain name, two wire spellings", () => {
  assert.equal(toCloudDirectModelId("glm-5.1:cloud"), "glm-5.1");
  assert.equal(toCloudDirectModelId("gpt-oss:120b-cloud"), "gpt-oss:120b");
  assert.equal(toCloudDirectModelId("glm-5.3"), "glm-5.3");
  assert.equal(toLocalCloudModelId("glm-5.3"), "glm-5.3:cloud");
  assert.equal(toLocalCloudModelId("gpt-oss:120b"), "gpt-oss:120b-cloud");
  assert.equal(toLocalCloudModelId("glm-5.3:cloud"), "glm-5.3:cloud");
  assert.ok(sameOllamaModel("glm-5.1:cloud", "GLM-5.1"));
  assert.ok(!sameOllamaModel("glm-5.1", "glm-5.3"));
  assert.ok(isOllamaCloudHost("https://ollama.com"));
  assert.ok(!isOllamaCloudHost("http://127.0.0.1:11434"));
  for (const m of OLLAMA_CLOUD_MODELS) assert.doesNotMatch(m.id, /(:cloud|-cloud)$/, `${m.id} is stored plain`);
  for (const slot of Object.values(DEFAULT_OLLAMA_SLOTS)) assert.doesNotMatch(slot.model, /(:cloud|-cloud)$/);
});

test("pool: cloud-direct sends the plain name with the key; a local app gets the tag", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify(TAGS), { status: 200 });
    return new Response(ndjson([{ message: { role: "assistant", content: "ok" }, done: false }, { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 }]), { status: 200 });
  };
  const slots = { reasoner: { model: "glm-5.3:cloud" }, apply: { model: "gpt-oss:20b" }, summarize: { model: "gpt-oss:20b" } };
  const cloud = new OllamaCloudPool({ slots, host: "https://ollama.com", apiKey: "k-123", fetchImpl, useAnthropicCompat: false });
  assert.equal(cloud.cloudDirect, true);
  assert.equal(cloud.wireModelId("glm-5.3:cloud"), "glm-5.3");
  assert.equal(cloud.wireModelId("gpt-oss:120b-cloud"), "gpt-oss:120b");
  for await (const _ of cloud.provider("reasoner").stream({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], system: "s" })) { /* drain */ }
  const chat = seen.find((s) => s.url.endsWith("/api/chat"));
  assert.ok(chat, "hit ollama.com/api/chat");
  assert.equal(JSON.parse(chat.init.body).model, "glm-5.3", "plain name on the cloud wire");
  assert.equal(chat.init.headers.Authorization, "Bearer k-123");
  const health = await cloud.health();
  assert.equal(health.cloudDirect, true);
  assert.ok(cloud.hasModel(health.availableModels, "glm-5.3:cloud"), "present in either spelling");
  const tags = seen.find((s) => s.url.endsWith("/api/tags"));
  assert.equal(tags.init.headers.Authorization, "Bearer k-123", "tags probe carries the key too");

  const local = new OllamaCloudPool({ slots, host: "http://127.0.0.1:11434", fetchImpl, useAnthropicCompat: false });
  assert.equal(local.cloudDirect, false);
  assert.equal(local.wireModelId("glm-5.1"), "glm-5.1:cloud", "a known cloud model gets its local tag");
  assert.equal(local.wireModelId("gpt-oss:120b"), "gpt-oss:120b-cloud");
  assert.equal(local.wireModelId("llama3.2"), "llama3.2", "a local-only model passes through");
  assert.equal(local.wireModelId("glm-5.1:cloud"), "glm-5.1:cloud");
});

test("live cloud catalog: public, plain ids, newest first, cached", async () => {
  resetOllamaCloudCatalogCache();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://ollama.com/api/tags");
    assert.equal(init.headers.Authorization, undefined, "no key needed");
    return new Response(JSON.stringify(TAGS), { status: 200 });
  };
  const models = await fetchOllamaCloudModels({ fetchImpl, force: true });
  assert.deepEqual(models.map((m) => m.id), ["glm-5.3", "kimi-k3", "glm-5.1", "gpt-oss:120b"]);
  assert.equal(models[0].parameterSize, "400B");
  await fetchOllamaCloudModels({ fetchImpl });
  assert.equal(calls, 1, "cached for an hour");
  resetOllamaCloudCatalogCache();
});

test("daemon catalog for ollama: live, plain, newest first, library marked pull-required", async () => {
  resetOllamaCloudCatalogCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://ollama.com/api/tags") return new Response(JSON.stringify(TAGS), { status: 200 });
    if (u.startsWith("https://ollama.com/library")) {
      // one cloud entry that duplicates a live row, one local-only entry
      const html =
        `<a href="/library/glm-5.3"><span x-test-model-title title="glm-5.3"></span><p>GLM blurb</p><span x-test-capability>tools</span><span x-test-pull-count>2.1M</span><span x-test-updated>3 days ago</span></a>` +
        `<a href="/library/llama3.2"><span x-test-model-title title="llama3.2"></span><p>Llama blurb</p><span x-test-capability>tools</span><span x-test-pull-count>90M</span><span x-test-updated>1 year ago</span></a>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    delete process.env.OLLAMA_API_KEY;
    const rows = await daemonModelCatalog("ollama");
    const cloud = rows.filter((r) => r.group === "Ollama Cloud");
    assert.deepEqual(cloud.map((r) => r.id).slice(0, 4), ["glm-5.3", "kimi-k3", "glm-5.1", "gpt-oss:120b"], "cloud rows keep the cloud's newest-first order");
    for (const r of rows) assert.doesNotMatch(r.id, /(:cloud|-cloud)$/, `${r.id} is plain`);
    assert.ok(cloud.find((r) => r.id === "glm-5.1").hint.includes("GLM-5.1"), "curated hint attached to a live row");
    assert.ok(cloud.find((r) => r.id === "glm-5.3"), "a model the static list never heard of is listed");
    const llama = rows.find((r) => r.id === "llama3.2");
    if (llama) assert.match(llama.group, /pull required/);
    const ids = rows.map((r) => r.id);
    assert.notDeepEqual(ids, [...ids].sort(), "never alphabetical");
  } finally {
    globalThis.fetch = realFetch;
    resetOllamaCloudCatalogCache();
  }
});

test("preflight on ollama.com: a missing model is 'pick another', never 'pull'", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://ollama.com/api/tags") return new Response(JSON.stringify(TAGS), { status: 200 });
    if (u === "https://ollama.com/") return new Response("Ollama is running", { status: 200 });
    return new Response("nope", { status: 404 });
  };
  const prevKey = process.env.OLLAMA_API_KEY;
  const prevHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_API_KEY = "k-123";
  delete process.env.OLLAMA_HOST;
  try {
    const sel = await selectProvider(new Map([["provider", "ollama"], ["model", "does-not-exist:cloud"]]));
    assert.equal(sel.family, "ollama");
    const pre = await sel.preflight();
    assert.equal(pre.ok, false);
    assert.match(pre.error, /not on Ollama Cloud/);
    assert.doesNotMatch(pre.error, /[Pp]ull it|not installed/);
    assert.match(pre.error, /nothing needs to be pulled/);
    assert.doesNotMatch(pre.error, /Start Ollama/);
    const ok = await selectProvider(new Map([["provider", "ollama"], ["model", "glm-5.3:cloud"]]));
    assert.deepEqual(await ok.preflight(), { ok: true }, "the cloud lists glm-5.3, spelled either way");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = prevKey;
    if (prevHost !== undefined) process.env.OLLAMA_HOST = prevHost;
  }
});

test("anthropic model listing: API key path carries context windows; no auth → empty, never a throw", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=/);
    assert.equal(init.headers["x-api-key"], "sk-test");
    return new Response(
      JSON.stringify({
        data: [
          { id: "claude-newest-9", display_name: "Claude Newest 9", max_input_tokens: 2_000_000, max_tokens: 64_000, created_at: "2026-09-01T00:00:00Z", capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
          { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 0, created_at: "2026-07-24T00:00:00Z" },
        ],
      }),
      { status: 200 },
    );
  };
  const rows = await fetchAnthropicModels("sk-test", { fetchImpl });
  assert.equal(rows[0].id, "claude-newest-9", "API order (newest first) is kept");
  assert.equal(rows[0].maxInputTokens, 2_000_000);
  assert.equal(rows[0].vision, true);
  assert.equal(rows[1].maxInputTokens, undefined, "0 means unknown, not zero");
  assert.deepEqual(await fetchAnthropicModels("", { fetchImpl, oauth: false }), []);
  // the context-window table consults live figures before its regexes
  assert.equal(modelContextWindow("claude-newest-9"), 200_000, "heuristic before the catalog ran");
});

test("resolveOllamaHost: a local OLLAMA_HOST does not strand a cloud model when a key is set", async () => {
  const { resolveOllamaHost, isLocalOllamaHost } = await import("../packages/core/dist/index.js");
  assert.equal(isLocalOllamaHost("0.0.0.0"), true);
  assert.equal(isLocalOllamaHost("http://127.0.0.1:11434"), true);
  assert.equal(isLocalOllamaHost("http://10.0.0.7:11434"), false);
  // no key: env host (normalized) or the local default
  assert.equal(resolveOllamaHost({ envHost: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(resolveOllamaHost({}), "http://127.0.0.1:11434");
  // key, no env: cloud
  assert.equal(resolveOllamaHost({ apiKey: "k" }), "https://ollama.com");
  // key + LAN-sharing OLLAMA_HOST=0.0.0.0 (the owner's machine): cloud models go to the cloud
  assert.equal(resolveOllamaHost({ apiKey: "k", envHost: "0.0.0.0", model: "glm-5.1" }), "https://ollama.com");
  assert.equal(resolveOllamaHost({ apiKey: "k", envHost: "0.0.0.0", model: "deepseek-v4-pro:cloud" }), "https://ollama.com");
  assert.equal(resolveOllamaHost({ apiKey: "k", envHost: "127.0.0.1:11434", model: "brand-new", cloudModels: [{ id: "brand-new" }] }), "https://ollama.com");
  // a genuinely local-only model stays on the local app
  assert.equal(resolveOllamaHost({ apiKey: "k", envHost: "0.0.0.0", model: "llama3.2:3b" }), "http://127.0.0.1:11434");
  // an explicit remote box is honored
  assert.equal(resolveOllamaHost({ apiKey: "k", envHost: "http://10.0.0.7:11434", model: "glm-5.1" }), "http://10.0.0.7:11434");
});
