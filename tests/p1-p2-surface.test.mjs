// P1/P2 surface smoke tests: high-leverage tools and core runtime pieces.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LspTool,
  SkillsListTool,
  SkillReadTool,
  MemoryTool,
} from "../packages/tools/dist/index.js";
import {
  HookManager,
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  diffWorkspaceCheckpointUnified,
  restoreWorkspaceCheckpoint,
  buildPromptCacheKey,
  loadStartupReminders,
} from "../packages/core/dist/index.js";

async function makeTmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-p1p2-"));
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

test("LSP: static fallback finds definitions and references", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "src", "math.ts");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "export function add(a: number, b: number) { return a + b; }\nconst x = add(1, 2);\n", "utf8");
  const c = ctx(tmp);

  const def = await LspTool.call(
    { action: "go_to_definition", file_path: file, line: 2, character: 11, max_results: 10 },
    c,
  );
  assert.equal(def.output.symbol, "add");
  assert.equal(def.output.locations[0].line, 1);

  const refs = await LspTool.call(
    { action: "go_to_references", file_path: file, line: 2, character: 11, max_results: 10 },
    c,
  );
  assert.ok(refs.output.locations.length >= 2);
});

test("SkillsList/SkillRead: discovers project skills", async () => {
  const tmp = await makeTmp();
  const skillDir = path.join(tmp, ".ares", "skills", "ship-it");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\ndescription: Release checklist\n---\n# Ship It\n\nRun checks.\n",
    "utf8",
  );

  const list = await SkillsListTool.call({ query: "release" }, ctx(tmp));
  assert.equal(list.output.skills.length, 1);
  assert.equal(list.output.skills[0].name, "ship-it");

  const read = await SkillReadTool.call({ name: "ship-it" }, ctx(tmp));
  assert.match(read.output.content, /Run checks/);
});

test("HookManager: failing PreToolUse blocks execution and queues reminder", async () => {
  const tmp = await makeTmp();
  await fs.mkdir(path.join(tmp, ".ares"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".ares", "hooks.json"),
    JSON.stringify({
      hooks: [{ event: "PreToolUse", matcher: "Bash(git *)", command: "node -e \"process.exit(2)\"" }],
    }),
    "utf8",
  );
  const hooks = await HookManager.load(tmp);
  const result = await hooks.run({ event: "PreToolUse", toolName: "Bash", input: { command: "git status" }, workspace: tmp });
  assert.equal(result.blocked, true);
  assert.equal(hooks.drainReminders().length, 1);
});

test("checkpoints: create, diff, and restore workspace snapshot", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "app.txt");
  await fs.writeFile(file, "one\n", "utf8");
  const checkpoint = await createWorkspaceCheckpoint({ workspace: tmp, sessionId: "sess_test", turnSeq: 1 });

  await fs.writeFile(file, "two\n", "utf8");
  await fs.writeFile(path.join(tmp, "new.txt"), "new\n", "utf8");
  const diff = await diffWorkspaceCheckpoint(tmp, checkpoint.id);
  assert.deepEqual(diff.modified, ["app.txt"]);
  assert.deepEqual(diff.added, ["new.txt"]);

  const restored = await restoreWorkspaceCheckpoint(tmp, checkpoint.id);
  assert.equal(restored.restored, 1);
  assert.equal(await fs.readFile(file, "utf8"), "one\n");
  await assert.rejects(fs.stat(path.join(tmp, "new.txt")), /ENOENT/);
});

test("checkpoints: unified diff shows changed lines", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "app.txt");
  await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");
  const checkpoint = await createWorkspaceCheckpoint({ workspace: tmp, sessionId: "sess_test", turnSeq: 1 });
  await fs.writeFile(file, "one\nTWO\nthree\n", "utf8");

  const diff = await diffWorkspaceCheckpointUnified(tmp, checkpoint.id, [file]);
  assert.equal(diff.truncated, false);
  assert.deepEqual(diff.files, ["app.txt"]);
  assert.match(diff.diff, /-two/);
  assert.match(diff.diff, /\+TWO/);
});

test("Memory: add and search persists project memory", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  await MemoryTool.call(
    {
      action: "add",
      scope: "project",
      category: "Preferences",
      content: "Use pnpm for scripts.",
      tags: ["tooling"],
      limit: 20,
    },
    c,
  );
  const result = await MemoryTool.call(
    {
      action: "search",
      scope: "project",
      category: "General",
      query: "pnpm",
      tags: [],
      limit: 20,
    },
    c,
  );
  assert.equal(result.output.items.length, 1);
  assert.match(await fs.readFile(path.join(tmp, ".ares", "memory.md"), "utf8"), /Use pnpm/);
});

test("startup context loads ARES.md as instructions", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "ARES.md"), "Project rule: use biome.\n", "utf8");
  const reminders = await loadStartupReminders(tmp);
  assert.ok(reminders.some((r) => r.source === "instructions" && r.text.includes("use biome")));
});

test("CRIX.md is no longer a convention file — the old name is fully retired", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "CRIX.md"), "Project rule: use biome.\n", "utf8");
  const reminders = await loadStartupReminders(tmp);
  assert.ok(!reminders.some((r) => r.source === "instructions" && r.text.includes("use biome")));
});

test("prompt cache key is stable for identical system + tool schemas", () => {
  const req = {
    system: "same",
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
  };
  assert.deepEqual(buildPromptCacheKey(req), buildPromptCacheKey(req));
  assert.notEqual(buildPromptCacheKey(req).key, buildPromptCacheKey({ ...req, system: "different" }).key);
});
