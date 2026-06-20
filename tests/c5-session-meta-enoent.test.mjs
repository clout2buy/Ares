// C5 — model_switch / setProvider must not ENOENT on a session whose dir isn't
// on disk yet (regression for: "model_switch: ENOENT … \sessions\sess_…\meta.json").
//
// A session constructed with sessionMeta (resumed/desktop-opened) starts with
// metaWritten=true on the ASSUMPTION its dir exists. When it doesn't (model_switch
// fires before the first turn, or it's opened in a fresh workspace), setProvider's
// writeFile(metaPath) used to ENOENT because ensureSessionDir skipped the mkdir.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session, MockEchoProvider } from "../packages/core/dist/index.js";

test("C5: setProvider on a resumed session with no on-disk dir creates it instead of ENOENT", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-metaenoent-"));
  const sessionId = "sess_resume_nodir";
  // Resumed-session shape: sessionMeta provided => metaWritten=true, but nothing
  // has been written to disk in this workspace (the dir does NOT exist).
  const session = new Session({
    workspace: ws,
    provider: new MockEchoProvider(),
    model: "mock-echo",
    systemPrompt: "t",
    tools: [],
    sessionMeta: {
      id: sessionId,
      workspace: ws,
      provider: { name: "mock-echo", model: "mock-echo" },
      createdAt: new Date().toISOString(),
    },
  });

  const metaPath = path.join(ws, ".ares", "sessions", sessionId, "meta.json");
  assert.equal(existsSync(metaPath), false, "precondition: dir/meta.json not on disk");

  // This is what model_switch does — must NOT throw ENOENT now.
  await session.setProvider(new MockEchoProvider(), "mock-echo");

  assert.equal(existsSync(metaPath), true, "setProvider created the session dir + meta.json");
});
