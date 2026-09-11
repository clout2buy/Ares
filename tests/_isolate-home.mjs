// Test-run isolation for the Ares home.
//
// Parts of the suite exercise code that writes to the durable home, so a plain
// `pnpm test` used to leave a populated ~/.ares behind — and CREATE one on a
// clean machine (reported from a Linux end-to-end pass: 72 KB of somebody
// else's test state in the vault the product treats as sacred). The documented
// workaround was to redirect HOME by hand, which is a fine thing to know and a
// bad thing to require: the isolation belongs in the tests.
//
// Loaded via `node --import` from the `test` script, which runs it once per
// test-file process, before any test module is evaluated. A caller who sets
// ARES_HOME deliberately still wins — CI and one-off runs that want a specific
// home keep it.
//
// EVERY test invocation needs this flag, not just `pnpm test`. The CI and
// release workflows call `node --test` directly, so for a while they kept the
// old behaviour: every test file on the runner sharing one real home while
// running in parallel. Shared mutable state across concurrent test processes is
// a flakiness source whatever else it is, so those invocations pass the flag
// too. If you add a new way to run the suite, carry it across.
//
// Note HOME is NOT what to set here: on Windows os.homedir() reads USERPROFILE,
// so ARES_HOME is the only lever that works on every platform.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.ARES_HOME) {
  const home = mkdtempSync(path.join(tmpdir(), "ares-test-home-"));
  process.env.ARES_HOME = home;
  // Best-effort: the OS reclaims temp anyway, and a failed cleanup must never
  // be the reason a green test run reports failure.
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

// Paired devices are MACHINE-scoped on purpose: devices.json ignores ARES_HOME
// so that pairing from the desktop app and pairing from a CLI garrison reach
// the same registry (a device belongs to the physical machine, not to an app
// profile). That deliberate exemption means the ARES_HOME isolation above does
// NOT cover it — without this, a test that writes a device would land in the
// developer's real ~/.ares, which is the exact "72 KB of somebody else's test
// state in the vault the product treats as sacred" problem all over again.
// Same rule as ARES_HOME: a deliberate caller still wins.
if (!process.env.ARES_DEVICES_HOME) {
  const devHome = mkdtempSync(path.join(tmpdir(), "ares-test-devices-"));
  process.env.ARES_DEVICES_HOME = devHome;
  process.on("exit", () => {
    try {
      rmSync(devHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

// The Mnemosyne discovery port is a FIXED loopback port in production — that's
// how sibling processes find one server. Under --test-concurrency it becomes
// cross-test coupling: every daemon a test spawns would host-or-join the SAME
// 7433 regardless of its isolated home. Give each test-file process its own
// port; children a test spawns inherit it, so a test's daemon + CLI still
// discover each other while test files stay hermetic. A deliberate caller
// still wins, same rule as ARES_HOME.
if (!process.env.ARES_MNEMOSYNE_PORT) {
  process.env.ARES_MNEMOSYNE_PORT = String(20_000 + (process.pid % 20_000));
}
