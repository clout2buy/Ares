// Session.rewindTo — files AND conversation.
//
// /undo restored files but left the model holding a history in which it had
// already made (and been told about) the edits that just vanished from disk.
// rewindTo cuts history to just BEFORE the assistant message carrying the
// checkpointed tool_use — an assistant boundary, so tool_use/tool_result
// pairing stays valid — restores the workspace, drops read stamps for the
// restored files, and persists the projection change like compaction does.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Session,
  listWorkspaceCheckpoints,
  loadSessionSnapshot,
  openWorkspaceSessionKernel,
  projectMessagesFromKernel,
  resetGitCheckpointCache,
} from "../packages/core/dist/index.js";

/** Provider script: turn 1 puts v1, turn 2 puts v2, turn 3 (post-rewind) just talks. */
function scriptedProvider(file) {
  let call = 0;
  const scripts = [
    { tool: { file, content: "v1" } },
    { text: "wrote v1" },
    { tool: { file, content: "v2" } },
    { text: "wrote v2" },
    { text: "continuing after rewind" },
  ];
  return {
    name: "rewind-scripted",
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tool_${call}`;
        yield { type: "tool_use_start", id, name: "Put" };
        yield { type: "tool_use_input_done", id, input: script.tool };
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: [{ type: "tool_use", id, name: "Put", input: script.tool }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text };
      yield {
        type: "message_done",
        message: { id: `m_${call}`, role: "assistant", content: [{ type: "text", text: script.text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

const putTool = {
  schema: { name: "Put", description: "write a file", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
  async call(input) {
    writeFileSync(input.file, input.content, "utf8");
    return { output: "written", touchedFiles: [input.file] };
  },
};

async function drain(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function assertPairing(messages) {
  for (let i = 0; i < messages.length; i++) {
    const uses = messages[i].content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    assert.ok(next && next.role === "user", `tool_use in message ${i} must be followed by a user message`);
    for (const use of uses) {
      assert.ok(next.content.some((b) => b.type === "tool_result" && b.tool_use_id === use.id), `dangling tool_use ${use.id}`);
    }
  }
}

function makeGitWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-rewind-"));
  execFileSync("git", ["init", "-q"], { cwd: ws, windowsHide: true });
  writeFileSync(path.join(ws, ".gitignore"), ".ares/\n", "utf8");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws, windowsHide: true });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: ws, windowsHide: true });
  resetGitCheckpointCache();
  return ws;
}

async function runScenario({ ws, sessionId, kernel }) {
  const file = path.join(ws, "a.txt");
  writeFileSync(file, "v0", "utf8");
  const fileReadStamps = new Map([[file, { mtimeMs: 1, size: 2 }]]);
  const trimmed = [];
  const session = new Session({
    workspace: ws,
    sessionId,
    provider: scriptedProvider(file),
    model: "m",
    systemPrompt: "s",
    tools: [putTool],
    maxTurns: 4,
    fileReadStamps,
    onHistoryTrimmed: (dropped) => trimmed.push(...dropped),
    ...(kernel ? { sessionKernel: kernel } : {}),
  });
  const observed = [];
  session.observeEvents((event) => observed.push(event));

  await drain(session.send("write v1"));
  await drain(session.send("write v2"));
  assert.equal(readFileSync(file, "utf8"), "v2");
  const historyBefore = session.history();
  assert.equal(historyBefore.length, 8, "user, assistant(tool), tool_result, assistant(text) × 2 turns");

  const own = (await listWorkspaceCheckpoints(ws)).filter((cp) => cp.sessionId === sessionId);
  assert.equal(own.length, 2, "one pre-tool checkpoint per Put");
  const second = own[0]; // newest first: before turn 2's Put
  assert.equal(second.toolUseId, "tool_3");
  assert.equal(second.messageIndex, 5, "anchor = the assistant message carrying tool_3");

  const result = await session.rewindTo(second.id);
  assert.equal(readFileSync(file, "utf8"), "v1", "workspace back to before turn 2's edit");
  assert.equal(result.conversationRewound, true);
  assert.equal(result.droppedMessages, 3, "assistant(tool_3), tool_result, assistant(text) dropped");
  assert.deepEqual(result.files, ["a.txt"]);

  const history = session.history();
  assert.equal(history.length, 5, "cut just before the assistant message with tool_3");
  assert.equal(history[4].role, "user", "the turn-2 prompt survives; its answer is gone");
  assert.ok(!history.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === "tool_3")));
  assertPairing(history);
  assert.equal(fileReadStamps.has(file), false, "read stamp for the restored file dropped");
  assert.equal(trimmed.length, 3, "host trim callback saw the dropped messages");
  const rewound = observed.find((e) => e.type === "rewound");
  assert.ok(rewound, "observers get a rewound event");
  assert.deepEqual(rewound.files, ["a.txt"]);

  // The next turn continues cleanly on the truncated history.
  const events = await drain(session.send("carry on"));
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  const after = session.history();
  assert.equal(after.length, 7);
  assertPairing(after);
  assert.equal(after.at(-1).content[0].text, "continuing after rewind");
  return { session, after };
}

test("rewindTo (git layer, legacy rollout): files restored, history cut at an assistant boundary, replay matches", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  const ws = makeGitWorkspace();
  try {
    const { after } = await runScenario({ ws, sessionId: "sess_rewind_git" });
    const snapshot = await loadSessionSnapshot(ws, "sess_rewind_git");
    assert.equal(snapshot.messages.length, after.length, "rollout replay honours the rewound projection");
    assert.ok(!snapshot.messages.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === "tool_3")));
    assertPairing(snapshot.messages);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rewindTo (blob layer, kernel-backed): a context-rewind epoch makes restart hydrate the cut history", async () => {
  process.env.ARES_CHECKPOINT_GIT = "0";
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-rewind-blob-"));
  const kernel = await openWorkspaceSessionKernel(ws);
  try {
    const { session, after } = await runScenario({ ws, sessionId: "sess_rewind_kernel", kernel });
    const epochs = kernel.listContextEpochs("sess_rewind_kernel");
    assert.ok(epochs.some((e) => e.reason === "context-rewind"), "rewind persisted as a canonical epoch");
    const projected = projectMessagesFromKernel(kernel, "sess_rewind_kernel");
    assert.equal(projected.length, after.length);
    assert.ok(!projected.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === "tool_3")));
    assertPairing(projected);
    assert.equal(session.history().length, after.length);
  } finally {
    delete process.env.ARES_CHECKPOINT_GIT;
    kernel.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
