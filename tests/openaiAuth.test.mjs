import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultTools, jsonSchemaForTool, OpenAIAuthStore, OpenAIResponsesClient, OpenAIOAuthProvider } from "../packages/core/dist/index.js";

async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), "crix-openai-auth-"));
}

function fakeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
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

test("native function tool schemas stay strict for nested object inputs", () => {
  const tools = new Map(defaultTools().map((tool) => [tool.name, tool]));
  for (const name of ["skill_run", "mcp_call"]) {
    const schema = jsonSchemaForTool(tools.get(name));
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.input.additionalProperties, false);
    assert.deepEqual(schema.properties.input.required, []);
  }
});

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

test("device-code OAuth login stores redacted ChatGPT auth outside the repo", async () => {
  const home = await tempHome();
  const idToken = fakeJwt({
    email: "dev@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account_123",
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "user_123",
    },
  });
  const server = await startServer((request, body, response) => {
    if (request.url === "/api/accounts/deviceauth/usercode") {
      assert.deepEqual(JSON.parse(body), { client_id: "test-client" });
      json(response, 200, { device_auth_id: "device_123", user_code: "ABCD-1234", interval: "0" });
      return;
    }
    if (request.url === "/api/accounts/deviceauth/token") {
      assert.deepEqual(JSON.parse(body), { device_auth_id: "device_123", user_code: "ABCD-1234" });
      json(response, 200, { authorization_code: "auth-code", code_challenge: "challenge", code_verifier: "verifier" });
      return;
    }
    if (request.url === "/oauth/token") {
      const params = new URLSearchParams(body);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "auth-code");
      assert.equal(params.get("code_verifier"), "verifier");
      json(response, 200, { id_token: idToken, access_token: "access-token-123456", refresh_token: "refresh-token" });
      return;
    }
    json(response, 404, { error: "not found" });
  });

  try {
    const seenCodes = [];
    const store = new OpenAIAuthStore({ home, issuer: server.url, clientId: "test-client" });
    const auth = await store.loginWithDeviceCode({ onDeviceCode: (code) => seenCodes.push(code) });
    const status = await store.status();

    assert.equal(auth.profile.email, "dev@example.com");
    assert.equal(status.configured, true);
    assert.equal(status.source, "file");
    assert.equal(status.email, "dev@example.com");
    assert.equal(status.planType, "pro");
    assert.equal(status.accountId, "account_123");
    assert.equal(status.tokenPreview, "access...3456");
    assert.equal(await store.getBearerToken(), "access-token-123456");
    assert.equal(seenCodes[0]?.verificationUrl, `${server.url}/codex/device`);
    assert.equal(await store.logout(), true);
  } finally {
    await server.close();
  }
});

test("OpenAI provider sends bearer token to Responses API and parses UpgradePlan JSON", async () => {
  const expectedPlan = {
    goal: "upgrade crix",
    summary: "model plan",
    steps: [],
    verification: [{ program: "pnpm", args: ["test"], timeoutMs: 120000 }],
  };
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer test-token");
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-5.5");
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.equal(request.headers.accept, "text/event-stream");
    assert.deepEqual(payload.text, { verbosity: "low" });
    assert.equal(payload.include[0], "reasoning.encrypted_content");
    assert.equal(payload.tool_choice, "auto");
    assert.equal(payload.parallel_tool_calls, true);
    assert.equal("max_output_tokens" in payload, false);
    assert.equal("max_tokens" in payload, false);
    assert.equal("max_completion_tokens" in payload, false);
    assert.equal("reasoning" in payload, false);
    assert.match(payload.input[0].content[0].text, /upgrade crix/);
    json(response, 200, {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(expectedPlan) }],
        },
      ],
    });
  });

  try {
    await withEnv(
      {
        CRIX_OPENAI_OAUTH_TOKEN: "test-token",
        CRIX_OPENAI_RESPONSES_URL: `${server.url}/v1/responses`,
        CRIX_OPENAI_MODEL: "gpt-5.5",
        CRIX_OPENAI_REASONING_EFFORT: undefined,
      },
      async () => {
        const provider = new OpenAIOAuthProvider();
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
        assert.deepEqual(result.plan?.verification[0]?.program, "pnpm");
        assert.deepEqual(result.plan?.verification[0]?.args, ["test"]);
        assert.deepEqual(result.plan?.verification[0]?.timeoutMs, 120000);
      },
    );
  } finally {
    await server.close();
  }
});

test("OpenAI provider sends native function tools and parses native tool calls", async () => {
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/v1/responses");
    const payload = JSON.parse(body);
    assert.equal(payload.tool_choice, "auto");
    assert.equal(payload.parallel_tool_calls, true);
    assert.equal(payload.tools.some((tool) => tool.type === "function" && tool.name === "read_file" && tool.strict === true), true);
    json(response, 200, {
      output: [
        {
          type: "function_call",
          call_id: "call_readme",
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    });
  });

  try {
    await withEnv(
      {
        CRIX_OPENAI_OAUTH_TOKEN: "test-token",
        CRIX_OPENAI_RESPONSES_URL: `${server.url}/v1/responses`,
        CRIX_OPENAI_MODEL: "gpt-5.5",
        CRIX_OPENAI_REASONING_EFFORT: undefined,
      },
      async () => {
        const provider = new OpenAIOAuthProvider();
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
        assert.equal(result.toolCalls?.[0]?.id, "call_readme");
        assert.equal(result.toolCalls?.[0]?.name, "read_file");
        assert.deepEqual(result.toolCalls?.[0]?.input, { path: "README.md" });
      },
    );
  } finally {
    await server.close();
  }
});

test("OpenAI chat parses streamed Responses text deltas", async () => {
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/v1/responses");
    const payload = JSON.parse(body);
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.equal("max_output_tokens" in payload, false);
    assert.equal("reasoning" in payload, false);
    assert.match(payload.instructions, /system prompt/);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " there" })}`,
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })}`,
      "",
    ].join("\n\n"));
  });

  try {
    await withEnv(
      {
        CRIX_OPENAI_OAUTH_TOKEN: "test-token",
        CRIX_OPENAI_RESPONSES_URL: `${server.url}/v1/responses`,
        CRIX_OPENAI_MODEL: "gpt-5.5",
        CRIX_OPENAI_REASONING_EFFORT: undefined,
      },
      async () => {
        const client = new OpenAIResponsesClient();
        assert.equal(await client.completeText("hi", "system prompt"), "hello there");
      },
    );
  } finally {
    await server.close();
  }
});

test("OpenAI chat streaming emits deltas before returning final text", async () => {
  const server = await startServer((request, body, response) => {
    assert.equal(request.url, "/v1/responses");
    const payload = JSON.parse(body);
    assert.equal(payload.stream, true);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "live" })}\n\n`);
    setTimeout(() => {
      response.end([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: " stream" })}`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })}`,
        "",
      ].join("\n\n"));
    }, 20);
  });

  try {
    await withEnv(
      {
        CRIX_OPENAI_OAUTH_TOKEN: "test-token",
        CRIX_OPENAI_RESPONSES_URL: `${server.url}/v1/responses`,
        CRIX_OPENAI_MODEL: "gpt-5.5",
        CRIX_OPENAI_REASONING_EFFORT: undefined,
      },
      async () => {
        const client = new OpenAIResponsesClient();
        const deltas = [];
        const result = await client.streamText("hi", "system prompt", (delta) => deltas.push(delta));
        assert.deepEqual(deltas, ["live", " stream"]);
        assert.equal(result, "live stream");
      },
    );
  } finally {
    await server.close();
  }
});
