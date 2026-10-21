// RemotePC timeout_ms is clamped, never refused (roadmap move 1, 47 field
// errors): a model asking for 300000 ms or "60" (seconds) used to get a schema
// rejection and burn a round trip. The value now reaches the server pulled
// into 1000..120000, and small numbers are read as seconds.

import test from "node:test";
import assert from "node:assert/strict";
import { RemotePCTool, clampRemoteTimeoutMs, setRemoteAgentServer } from "../packages/tools/dist/index.js";

test("clampRemoteTimeoutMs pulls any value into 1000..120000", () => {
  assert.equal(clampRemoteTimeoutMs(undefined), undefined);
  assert.equal(clampRemoteTimeoutMs(Number.NaN), undefined);
  assert.equal(clampRemoteTimeoutMs(0), undefined);
  assert.equal(clampRemoteTimeoutMs(300_000), 120_000);
  assert.equal(clampRemoteTimeoutMs(45_000), 45_000);
  assert.equal(clampRemoteTimeoutMs(60), 60_000, "60 means a minute");
  assert.equal(clampRemoteTimeoutMs(500), 1000);
  assert.equal(clampRemoteTimeoutMs(1500.4), 1500);
});

test("an out-of-range timeout_ms passes validation and reaches exec clamped", async () => {
  const seen = [];
  setRemoteAgentServer({
    listPcs: () => [{ id: "pc1", label: "box", hostname: "box", os: "windows", username: "u", ip: "1.2.3.4", connectedAt: Date.now() }],
    async exec(pcId, command, timeoutMs) {
      seen.push({ pcId, command, timeoutMs });
      return { output: "ok", exitCode: 0 };
    },
  });
  try {
    const parsed = RemotePCTool.inputZod.safeParse({ action: "exec_on_pc", pc_id: "pc1", command: "dir", timeout_ms: 600_000 });
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    const ctx = { workspace: process.cwd(), signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
    await RemotePCTool.call(parsed.data, ctx);
    await RemotePCTool.call(RemotePCTool.inputZod.parse({ action: "exec_on_pc", pc_id: "pc1", command: "dir", timeout: "90" }), ctx);
    assert.deepEqual(seen.map((s) => s.timeoutMs), [120_000, 90_000]);
  } finally {
    setRemoteAgentServer(null);
  }
});
