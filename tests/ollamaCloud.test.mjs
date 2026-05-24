import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultTools, OllamaCloudAuthStore, OllamaCloudClient, OllamaCloudProvider, resolveOllamaModel } from "../packages/core/dist/index.js";

async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), "crix-ollama-cloud-"));
}

function startServer(handler) {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        await handler(request, Buffer.concat(chunks).toString("utf8"), response);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.stack : String(error));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function withEnv(values, action) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Ollama model aliases resolve to cloud models", () => {
  assert.equal(resolveOllamaModel(), "qwen3-coder");
  assert.equal(resolveOllamaModel("deepseek-v4-pro"), "deepseek-v4-pro:cloud");
  assert.equal(resolveOllamaModel("kimi-k2.6"), "kimi-k2.6:cloud");
  assert.equal(resolveOllamaModel("glm-5.1"), "glm-5.1:cloud");
  assert.equal(resolveOllamaModel("custom:cloud"), "custom:cloud");
});

test("Ollama defaults to local host without login", async () => {
  await withEnv(
    {
      OLLAMA_HOST: undefined,
      OLLAMA_CLOUD_HOST: undefined,
      OLLAMA_API_KEY: undefined,
      CRIX_OLLAMA_MODEL: undefined,
      OLLAMA_CLOUD_MODEL: undefined,
    },
    async () => {
      const store = new OllamaCloudAuthStore(await tempHome());
      const status = await store.status();

      assert.equal(status.configured, true);
      assert.equal(status.source, "local-default");
      assert.equal(status.host, "http://127.0.0.1:11434");
      assert.equal(status.model, "qwen3-coder");
      assert.equal(await store.getApiKey(), undefined);
    },
  );
});

test("Ollama normalizes bind addresses to a local client URL", async () => {
  await withEnv(
    {
      OLLAMA_HOST: "0.0.0.0",
      OLLAMA_CLOUD_HOST: undefined,
      OLLAMA_API_KEY: undefined,
    },
    async () => {
      const store = new OllamaCloudAuthStore(await tempHome());
      const status = await store.status();
      assert.equal(status.host, "http://127.0.0.1:11434");
    },
  );
});

test("Ollama optional API key store redacts status and persists model", async () => {
  const store = new OllamaCloudAuthStore(await tempHome());
  await store.saveApiKey("ollama-test-key-123456", "kimi-k2.6");
  const status = await store.status();

  assert.equal(status.configured, true);
  assert.equal(status.source, "file");
  assert.equal(status.model, "kimi-k2.6:cloud");
  assert.equal(status.tokenPreview, "ollama...3456");
  assert.equal(await store.getApiKey(), "ollama-test-key-123456");
});

test("Ollama provider sends bearer token to cloud chat API and parses UpgradePlan JSON", async () => {
  const expectedPlan = {
    goal: "upgrade crix",
    summary: "ollama plan",
    steps: [],
    verification: [{ program: "pnpm", args: ["test"], timeoutMs: 120000 }],
  };
  const home = await tempHome();
  const store = new OllamaCloudAuthStore(home);
  await store.saveApiKey("ollama-test-key-123456", "deepseek-v4-pro");

  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/api/chat");
    assert.equal(request.headers.authorization, "Bearer ollama-test-key-123456");
    const payload = JSON.parse(body);
    assert.equal(payload.model, "deepseek-v4-pro:cloud");
    assert.equal(payload.stream, false);
    assert.match(payload.messages.at(-1).content, /upgrade crix/);
    json(response, 200, { message: { content: JSON.stringify(expectedPlan) } });
  });

  try {
    const provider = new OllamaCloudProvider(new OllamaCloudClient({ authStore: store, host: server.url, model: "deepseek-v4-pro" }));
    const result = await provider.complete({
      goal: "upgrade crix",
      systemPrompt: "system",
      context: {
        workspace: "D:/Crix",
        goal: "upgrade crix",
        messages: [],
        memories: [],
        files: [],
        budget: { maxChars: 100, usedChars: 0 },
      },
      tools: [],
      agents: [],
      messages: [],
    });

    assert.equal(result.plan?.goal, expectedPlan.goal);
    assert.equal(result.plan?.summary, expectedPlan.summary);
    assert.deepEqual(result.plan?.steps, []);
    assert.equal(result.plan?.verification[0]?.program, "pnpm");
  } finally {
    await server.close();
  }
});

test("Ollama provider sends native chat tools and parses native tool calls", async () => {
  const store = new OllamaCloudAuthStore(await tempHome());
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/api/chat");
    const payload = JSON.parse(body);
    assert.equal(payload.tools.some((tool) => tool.type === "function" && tool.function.name === "read_file"), true);
    json(response, 200, {
      message: {
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "README.md" } } },
        ],
      },
    });
  });

  try {
    const provider = new OllamaCloudProvider(new OllamaCloudClient({ authStore: store, host: server.url, model: "qwen3-coder" }));
    const result = await provider.complete({
      goal: "inspect repo",
      systemPrompt: "system",
      context: {
        workspace: "D:/Crix",
        goal: "inspect repo",
        messages: [],
        memories: [],
        files: [],
        budget: { maxChars: 100, usedChars: 0 },
      },
      tools: defaultTools().filter((tool) => tool.name === "read_file"),
      agents: [],
      messages: [],
    });

    assert.equal(result.toolCalls?.[0]?.name, "read_file");
    assert.deepEqual(result.toolCalls?.[0]?.input, { path: "README.md" });
  } finally {
    await server.close();
  }
});

test("Ollama local chat sends no auth header and can list local models", async () => {
  const store = new OllamaCloudAuthStore(await tempHome());
  const server = await startServer((request, body, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/api/tags") {
      json(response, 200, { models: [{ name: "qwen3-coder" }, { model: "devstral" }] });
      return;
    }
    assert.equal(request.url, "/api/chat");
    const payload = JSON.parse(body);
    assert.equal(payload.model, "qwen3-coder");
    assert.equal(payload.stream, false);
    json(response, 200, { message: { content: "local ok" } });
  });

  try {
    const client = new OllamaCloudClient({ authStore: store, host: server.url, model: "qwen3-coder" });
    assert.equal(await client.completeText("hello"), "local ok");
    assert.deepEqual(await client.listModels(), ["qwen3-coder", "devstral"]);
  } finally {
    await server.close();
  }
});

test("Ollama chat streaming emits NDJSON deltas", async () => {
  const store = new OllamaCloudAuthStore(await tempHome());
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/api/chat");
    const payload = JSON.parse(body);
    assert.equal(payload.model, "qwen3-coder");
    assert.equal(payload.stream, true);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ message: { content: "live" }, done: false })}\n`);
    setTimeout(() => {
      response.end(`${JSON.stringify({ message: { content: " stream" }, done: true })}\n`);
    }, 20);
  });

  try {
    const client = new OllamaCloudClient({ authStore: store, host: server.url, model: "qwen3-coder" });
    const deltas = [];
    const result = await client.streamCompleteText("hello", (delta) => deltas.push(delta));
    assert.deepEqual(deltas, ["live", " stream"]);
    assert.equal(result, "live stream");
  } finally {
    await server.close();
  }
});

test("Ollama cloud alias without reachable local proxy gives actionable setup error", async () => {
  const store = new OllamaCloudAuthStore(await tempHome());
  const client = new OllamaCloudClient({
    authStore: store,
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    },
    host: "http://127.0.0.1:11434",
    model: "kimi-k2.6:cloud",
  });

  await assert.rejects(
    () => client.completeText("hello"),
    /choose an installed local model/,
  );
});
