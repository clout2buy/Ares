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
