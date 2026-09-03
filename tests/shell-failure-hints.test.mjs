// classifyShellFailure: a bare "exited with code N" gets a one-line `hint`
// naming the trap that caused it. 72 of 79 PowerShell failures last month
// surfaced with no diagnosis at all; the signature table is unit-tested here,
// plus one real Windows PowerShell 5.1 run of `a && b` (skipped off win32).

import test from "node:test";
import assert from "node:assert/strict";

import { classifyShellFailure, shellFlavorOf, powerShellDialect, runShell } from "../packages/tools/dist/index.js";

test("exit 0 never hints, even with scary stderr", () => {
  assert.equal(classifyShellFailure(0, "", "The token '&&' is not a valid statement separator", "powershell"), null);
});

test("PowerShell 5.1 `&&` parser error → use ; or if ($?)", () => {
  const stderr = "At line:1 char:3\n+ a && b\n+   ~~\nThe token '&&' is not a valid statement separator in this version.\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n";
  const hint = classifyShellFailure(1, "", stderr, "powershell");
  assert.match(hint, /PowerShell 5\.1/);
  assert.match(hint, /`;`/);
  assert.match(hint, /if \(\$\?\)/);
});

test("`||` separator error is caught by the same rule", () => {
  const hint = classifyShellFailure(1, "", "The token '||' is not a valid statement separator in this version.", "powershell");
  assert.match(hint, /PowerShell 5\.1/);
});

test("cmdlet not recognized → not on PATH (Get-Command on PowerShell, which on bash)", () => {
  const ps = classifyShellFailure(1, "", "foo : The term 'foo' is not recognized as the name of a cmdlet, function, script file, or operable program.", "powershell");
  assert.match(ps, /not on PATH/);
  assert.match(ps, /Get-Command/);
  const sh = classifyShellFailure(127, "", "bash: foo: command not found", "bash");
  assert.match(sh, /not on PATH/);
  assert.match(sh, /which/);
});

test("Cannot find path / ENOENT → path does not exist; check cwd", () => {
  assert.match(classifyShellFailure(1, "", "Get-Content : Cannot find path 'C:\\nope\\x.txt' because it does not exist.", "powershell"), /path does not exist/);
  assert.match(classifyShellFailure(1, "Error: ENOENT: no such file or directory, open 'x'", "", "bash"), /check `cwd`/);
});

test("positional parameter cannot be found → quote the path", () => {
  const hint = classifyShellFailure(1, "", "Set-Location : A positional parameter cannot be found that accepts argument 'Workspace'.", "powershell");
  assert.match(hint, /quote the path/);
});

test("EACCES / Access is denied → permission; locked or elevated", () => {
  assert.match(classifyShellFailure(1, "", "Remove-Item : Access to the path 'x' is denied.\nAccess is denied", "powershell"), /permission problem/);
  assert.match(classifyShellFailure(1, "", "EACCES: permission denied, open '/etc/x'", "bash"), /locked|elevation/);
});

test("ETIMEDOUT / timed out → raise timeout or run_in_background", () => {
  assert.match(classifyShellFailure(1, "", "connect ETIMEDOUT 1.2.3.4:443", "bash"), /run_in_background/);
  assert.match(classifyShellFailure(1, "request timed out", "", "pwsh"), /timeout/);
});

test("unterminated string / missing closing → quoting error, here-string vs heredoc by shell", () => {
  const ps = classifyShellFailure(1, "", "The string is missing the terminator: \".", "powershell");
  assert.match(ps, /quoting error/);
  assert.match(ps, /here-string/);
  const sh = classifyShellFailure(2, "", "bash: -c: line 1: unexpected EOF while looking for matching `\"'", "bash");
  assert.match(sh, /quoting error/);
  assert.match(sh, /heredoc/);
});

test("NativeCommandError → drop 2>&1 on native exes", () => {
  assert.match(classifyShellFailure(1, "", "git : warning: LF will be replaced by CRLF\n    + CategoryInfo          : NotSpecified: (:String) [], RemoteException\n    + FullyQualifiedErrorId : NativeCommandError", "powershell"), /2>&1/);
});

test("generic ParserError on 5.1 gets the dialect checklist; unknown output gets no hint", () => {
  assert.match(classifyShellFailure(1, "", "+ CategoryInfo : ParserError: (:) [], ParseException", "powershell"), /5\.1 parse error/);
  assert.equal(classifyShellFailure(1, "some tool failed for its own reasons", "", "bash"), null);
});

test("only the last ~40 lines are scanned", () => {
  const noise = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const early = "The token '&&' is not a valid statement separator\n" + noise;
  assert.equal(classifyShellFailure(1, "", early, "powershell"), null, "signature buried 60 lines up is ignored");
  const late = noise + "\nThe token '&&' is not a valid statement separator";
  assert.match(classifyShellFailure(1, "", late, "powershell"), /5\.1/);
});

test("shellFlavorOf + powerShellDialect derive the dialect from the program path", () => {
  assert.equal(shellFlavorOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
  assert.equal(shellFlavorOf("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
  assert.equal(shellFlavorOf("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
  assert.equal(shellFlavorOf("/bin/sh"), "bash");
  assert.equal(shellFlavorOf("cmd.exe"), "cmd");
  assert.match(powerShellDialect("powershell"), /5\.1/);
  assert.match(powerShellDialect("pwsh"), /7\+/);
  assert.equal(powerShellDialect("bash"), undefined);
});

test("real powershell.exe run of `a && b` yields the 5.1 hint on the result", { skip: process.platform !== "win32" ? "win32 only" : false }, async () => {
  const r = await runShell(
    "powershell",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "a && b"],
    process.cwd(),
    30_000,
    new AbortController().signal,
  );
  assert.equal(r.shell, "powershell");
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.hint, `expected a hint; stderr was: ${r.stderr}`);
  assert.match(r.hint, /PowerShell 5\.1/);
});
