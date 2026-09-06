#!/usr/bin/env node
// The `ares` front door: a tiny supervisor that runs the real CLI (entry.js) as
// a child and, whatever happens to it, hands the terminal back intact.
//
// Why: a V8 fatal (out-of-memory, a native abort) skips every JS cleanup hook,
// so a crash inside the TUI used to leave the terminal in the alternate screen
// with mouse tracking armed — every click spewed escape codes into the prompt.
// The child can't fix that from inside a dead process; a parent can. This file
// imports nothing heavy on purpose, so it adds nothing to startup.
//
// Signals: Ctrl+C reaches the child through the shared console; the parent
// ignores it and simply waits, then mirrors the child's exit code.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "entry.js");
const isTTY = Boolean(process.stdout.isTTY);

/** Leave the alternate screen, disarm mouse tracking, show the cursor. Every
 *  sequence is a no-op when the terminal is already in that state. */
function restoreTerminal(): void {
  if (!isTTY) return;
  try {
    process.stdout.write("\u001b[?1002l\u001b[?1006l\u001b[?1000l\u001b[?1049l\u001b[?25h");
  } catch {
    /* stdout gone — nothing to restore */
  }
}

const child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ARES_SUPERVISED: "1" },
  windowsHide: true,
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    /* the child sees the same console signal; wait for it to exit */
  });
}

child.on("error", (err) => {
  restoreTerminal();
  process.stderr.write(`ares: could not start ${entry}: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  restoreTerminal();
  const oom = code === 134 || signal === "SIGABRT";
  if (oom) {
    process.stderr.write(
      "\nares crashed: the JavaScript heap ran out of memory (see the V8 report above).\n" +
        "The terminal has been restored. Start `ares` again to resume the session.\n",
    );
  } else if (signal) {
    process.stderr.write(`\nares exited on ${signal}; the terminal has been restored.\n`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
