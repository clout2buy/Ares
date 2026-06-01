import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BootstrapTool,
  SelfEvolveTool,
  ensureAgentScaffold,
  agentPaths,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "crix-v4-bootstrap-tool-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function ctx(workspace) {
  return { workspace, signal: new AbortController().signal };
}

test("Bootstrap tool writes IDENTITY/SOUL/USER to ~/.crix and deletes BOOTSTRAP.md", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  process.env.CRIX_HOME = home;
  try {
    await ensureAgentScaffold({ home, workspace });
    const paths = agentPaths(home);
    assert.ok((await fs.stat(paths.bootstrap)).isFile(), "BOOTSTRAP.md must exist before the tool runs");

    const result = await BootstrapTool.call(
      {
        user_name: "MrDoing",
        agent_name: "Rook",
        creature: "terminal familiar",
        vibe: "ruthless",
        emoji: "[R]",
        style: "blunt, no fluff, sass welcome",
        languages: "TypeScript",
      },
      ctx(workspace),
    );

    assert.equal(result.output.bootstrapRemoved, true);
    assert.equal(result.output.home, home);
    assert.match(await fs.readFile(paths.identity, "utf8"), /Name: Rook/);
    assert.match(await fs.readFile(paths.soul, "utf8"), /ruthless/);
    assert.match(await fs.readFile(paths.user, "utf8"), /MrDoing/);
    await assert.rejects(fs.stat(paths.bootstrap), /ENOENT/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("SelfEvolve append writes to a brain file and logs the change to daily memory", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  process.env.CRIX_HOME = home;
  try {
    await BootstrapTool.call(
      { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct", emoji: "*" },
      ctx(workspace),
    );

    const paths = agentPaths(home);
    const before = await fs.readFile(paths.soul, "utf8");
    const evolved = await SelfEvolveTool.call(
      { target: "soul", action: "append", text: "## Learned Rule\n- Never apologize for shipping fast.", reason: "captured user pref" },
      ctx(workspace),
    );

    assert.equal(evolved.output.target, "soul");
    const after = await fs.readFile(paths.soul, "utf8");
    assert.ok(after.length > before.length, "soul should grow after append");
    assert.match(after, /Never apologize for shipping fast/);
    assert.ok(evolved.output.loggedTo, "daily log path returned");
    assert.match(await fs.readFile(evolved.output.loggedTo, "utf8"), /self_evolve append soul/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("SelfEvolve replace_section rewrites a named heading and creates it if missing", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  process.env.CRIX_HOME = home;
  try {
    await BootstrapTool.call(
      { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct", emoji: "*" },
      ctx(workspace),
    );
    const paths = agentPaths(home);

    await SelfEvolveTool.call(
      { target: "soul", action: "replace_section", section: "Vibe (direct)", text: "- Cut filler at the source.\n- Argue when wrong." },
      ctx(workspace),
    );
    const updated = await fs.readFile(paths.soul, "utf8");
    assert.match(updated, /Cut filler at the source/);
    assert.match(updated, /Argue when wrong/);

    await SelfEvolveTool.call(
      { target: "soul", action: "replace_section", section: "Brand New Section", text: "freshly minted." },
      ctx(workspace),
    );
    const withNew = await fs.readFile(paths.soul, "utf8");
    assert.match(withNew, /## Brand New Section/);
    assert.match(withNew, /freshly minted\./);
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("SelfEvolve note action appends a timestamped daily entry", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  process.env.CRIX_HOME = home;
  try {
    await BootstrapTool.call(
      { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct", emoji: "*" },
      ctx(workspace),
    );
    const result = await SelfEvolveTool.call(
      { target: "daily", action: "note", text: "Spotted a flaky test in v3-parallel-deps." },
      ctx(workspace),
    );
    const log = await fs.readFile(result.output.filePath, "utf8");
    assert.match(log, /Spotted a flaky test/);
    assert.match(log, /T\d{2}:\d{2}/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});

test("SelfEvolve can update CAPABILITIES.md", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("crix-v4-workspace-");
  process.env.CRIX_HOME = home;
  try {
    await BootstrapTool.call(
      { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct", emoji: "*" },
      ctx(workspace),
    );
    const paths = agentPaths(home);
    const result = await SelfEvolveTool.call(
      { target: "capabilities", action: "append", text: "- can update its own capabilities ledger" },
      ctx(workspace),
    );
    assert.equal(result.output.target, "capabilities");
    assert.match(await fs.readFile(paths.capabilities, "utf8"), /capabilities ledger/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});
