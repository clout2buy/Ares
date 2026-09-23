// Nothing may run forever.
//
// Every freeze this daemon has had was one shape: a tool promise that could
// never settle, with nothing above it willing to give up.
//   2026-09-18  a checkpoint awaited its own anchor
//   2026-09-21  a background `docker exec` orphaned holding the stdout pipe
//   2026-09-22  the SAME orphan, on the foreground path, which had been missed
// Each was fixed where it happened, and each time a different hole was left.
//
// withWatchdog already races every tool call against a deadline, so a BOUNDED
// tool cannot wedge a turn however broken its internals are. The hole was the
// opt-out: `watchdogTimeoutMs: 0` meant "no deadline at all", and it was set on
// exactly the tools that can hang — shells, remote exec, sub-agents. These
// tests pin the rule that replaces it: 0 means "no fixed number is right",
// never "unbounded".

import test from "node:test";
import assert from "node:assert/strict";

import { shellWatchdogFor, SHELL_BACKGROUND_WATCHDOG_MS, SHELL_MAX_TIMEOUT_MS, SHELL_DEFAULT_TIMEOUT_MS } from "../packages/tools/dist/_shared.js";
import { BashTool, PowerShellTool } from "../packages/tools/dist/index.js";

test("a shell's deadline comes from the timeout it actually asked for", () => {
  assert.equal(shellWatchdogFor({ timeout: 120_000 }), 140_000, "the default 120s command gets 140s");
  assert.equal(shellWatchdogFor({ timeout: 5_000 }), 25_000, "a quick command is not given ten minutes");
  assert.equal(shellWatchdogFor({}), SHELL_DEFAULT_TIMEOUT_MS + 20_000, "no timeout given means the schema default");
});

test("the grace covers what runShell does after its own timer fires", () => {
  // SIGTERM, escalate to SIGKILL at 2s, force-settle at 5s. The engine's
  // deadline must sit clear of all of it, or it fires on healthy teardown and
  // masks the tool's own (better) error.
  assert.ok(shellWatchdogFor({ timeout: 1_000 }) - 1_000 >= 15_000, "comfortably past the 5s force-settle");
});

test("a background shell is held to the handoff, not the work", () => {
  // It returns a shell_id immediately; the command keeps running under the
  // supervisor. Holding it to the command's timeout would be meaningless.
  assert.equal(shellWatchdogFor({ run_in_background: true, timeout: 600_000 }), SHELL_BACKGROUND_WATCHDOG_MS);
});

test("an absurd timeout cannot buy an absurd deadline", () => {
  const huge = shellWatchdogFor({ timeout: 999_999_999 });
  assert.equal(huge, SHELL_MAX_TIMEOUT_MS + 20_000, "clamped to the schema's own maximum first");
  assert.ok(huge < 15 * 60_000, "and still under the turn watchdog, so a hung tool never kills the turn");
});

test("the production command that wedged a turn now has a finite deadline", () => {
  // 2026-09-22 15:55: `docker exec -i doingbot python3 - <<'PY'`, no timeout
  // given, so the 120s default. Its own kill failed to settle and the turn sat
  // for 18 minutes. The engine would now have given up at 140s.
  const deadline = shellWatchdogFor({ command: "docker exec -i doingbot python3 - <<'PY'\nimport time\ntime.sleep(300)\nPY" });
  assert.equal(deadline, 140_000);
  assert.ok(deadline < 1_080_018, "against the 18 minutes it actually took");
});

test("both shells carry the derived deadline, not an opt-out", () => {
  for (const tool of [BashTool, PowerShellTool]) {
    assert.equal(typeof tool.schema.watchdogFor, "function", `${tool.schema.name} derives its deadline`);
    assert.equal(tool.schema.watchdogFor({ timeout: 30_000 }), 50_000);
    assert.equal(tool.schema.watchdogFor({ run_in_background: true }), SHELL_BACKGROUND_WATCHDOG_MS);
  }
});

test("no tool ships with an unbounded deadline", async () => {
  const tools = await import("../packages/tools/dist/index.js");
  const ceiling = 13 * 60_000;
  const offenders = [];
  for (const value of Object.values(tools)) {
    const schema = value?.schema;
    if (!schema || typeof schema.name !== "string") continue;
    // 0 is allowed ONLY as "no fixed number is right" — the engine then applies
    // the ceiling, or the tool derives its own. What must never exist again is
    // a tool that can run without any deadline at all.
    const derived = schema.watchdogFor?.({});
    const effective = derived && derived > 0 ? derived
      : schema.watchdogTimeoutMs === 0 ? ceiling
      : schema.watchdogTimeoutMs;
    if (effective !== undefined && !(effective > 0 && effective <= ceiling)) {
      offenders.push(`${schema.name}=${effective}`);
    }
  }
  assert.deepEqual(offenders, [], "every tool settles inside the ceiling");
});
