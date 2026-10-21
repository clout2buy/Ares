// A force-Stopped turn whose generator never unwinds kept heartbeating its
// session run lease forever; the session rebuilt in its place then waited on
// that lease with no limit, so every later turn in the chat sat silent until
// it was Stopped too. Two guards: a disposed session stops renewing (the lease
// then expires and is taken over), and a lease wait is bounded.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RunLeaseCoordinator, SessionKernelStore, LeaseHeldError } from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

test("a wedged holder fails the next turn's lease wait instead of hanging it, and shutdown frees the lease", async () => {
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "chat", workspaceKey: "/ws" });
    const wedged = new RunLeaseCoordinator({ store, ownerId: "wedged", leaseTtlMs: 400, heartbeatIntervalMs: 100 });
    const replacement = new RunLeaseCoordinator({ store, ownerId: "replacement", leaseTtlMs: 400, heartbeatIntervalMs: 100 });
    await wedged.acquire("chat");

    // The zombie keeps renewing: without a bound this wait never ends.
    const started = Date.now();
    await assert.rejects(
      replacement.acquire("chat", { waitForLease: true, maxWaitMs: 900 }),
      (error) => error instanceof LeaseHeldError,
    );
    assert.ok(Date.now() - started < 3_000, "the bounded wait gives up");

    // Abandoning the wedged session stops its heartbeat; the lease expires and
    // the replacement takes it over within about one TTL.
    await wedged.shutdown(new Error("abandoned"));
    const lease = await replacement.acquire("chat", { waitForLease: true, maxWaitMs: 5_000 });
    assert.equal(lease.context.ownerId, "replacement");
    lease.release({ executionState: "completed", workOutcome: "verified", error: null });
    await replacement.shutdown();
  } finally {
    store.close();
  }
});
