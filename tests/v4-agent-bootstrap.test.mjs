import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  completeBootstrap,
  ensureAgentScaffold,
  loadAgentSystemContext,
  workspaceToolsPath,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "crix-v4-bootstrap-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("V4 V1: ensureAgentScaffold creates bootstrap and workspace TOOLS.md without identity", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { build: "tsc", verify: "tsc --noEmit" } }), "utf8");
  await fs.writeFile(path.join(workspace, "pnpm-lock.yaml"), "", "utf8");

  const state = await ensureAgentScaffold({ home, workspace });

  assert.equal(state.required, true);
  assert.match(await fs.readFile(path.join(home, "BOOTSTRAP.md"), "utf8"), /I just came online/);
  assert.match(await fs.readFile(workspaceToolsPath(workspace), "utf8"), /pnpm verify/);
});

test("V4 V1: completeBootstrap writes identity files atomically and deletes BOOTSTRAP.md", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  await ensureAgentScaffold({ home, workspace });

  const state = await completeBootstrap(
    {
      userName: "Clout",
      userTimezone: "America/New_York",
      languages: "TypeScript",
      style: "direct",
      conventions: "pnpm, verify",
      agentName: "Crix",
      creature: "coding daemon",
      vibe: "direct",
      emoji: "*",
      bornAt: new Date("2026-05-28T00:00:00.000Z"),
    },
    { home, workspace },
  );

  assert.equal(state.required, false);
  await assert.rejects(fs.stat(path.join(home, "BOOTSTRAP.md")), /ENOENT/);
  assert.match(await fs.readFile(path.join(home, "IDENTITY.md"), "utf8"), /Name: Crix/);
  assert.match(await fs.readFile(path.join(home, "SOUL.md"), "utf8"), /Skip filler words/);
  assert.match(await fs.readFile(path.join(home, "USER.md"), "utf8"), /Clout/);
});

test("V4 V1: agent context loads identity-first mind files without core importing agent", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  await completeBootstrap(
    {
      userName: "Clout",
      agentName: "Crix",
      creature: "coding daemon",
      vibe: "careful",
      emoji: "*",
    },
    { home, workspace },
  );

  const context = await loadAgentSystemContext({ home, workspace, includeMemory: true });
  assert.equal(context.bootstrapRequired, false);
  assert.deepEqual(context.blocks.slice(0, 3).map((block) => block.label), ["identity", "soul", "user"]);
  assert.match(context.systemText, /Loaded identity/);
});

