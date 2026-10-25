// Temp-dir teardown that can never fail a test whose assertions passed.
//
// On hosted Windows runners a directory the daemon just wrote (SQLite kernel,
// WAL, session files) can stay EBUSY for many seconds after the process is
// gone — Defender and the indexer scan fresh files, and a cwd handle of an
// exited process is released a beat late. The v0.66.0–v0.66.2 release gates
// each died on exactly this, in tests whose every assertion had passed, while
// the CI run on the same commit passed the same test. Cleanup is best-effort:
// retry with backoff, then WARN with whoever still holds the path, never throw.

import { rmSync } from "node:fs";
import { execSync } from "node:child_process";

export function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    let holders = "";
    if (process.platform === "win32") {
      try {
        holders = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape('${dir.replace(/'/g, "''")}') } | Select-Object ProcessId,Name,CommandLine | Format-List | Out-String -Width 400"`,
          { encoding: "utf8", timeout: 10_000, windowsHide: true },
        ).trim();
      } catch { /* diagnostics only */ }
    }
    console.warn(`[rmTemp] could not remove ${dir}: ${error?.code ?? error}${holders ? `\n[rmTemp] processes naming it:\n${holders}` : ""}`);
  }
}
