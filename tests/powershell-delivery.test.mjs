// PowerShell reliability (roadmap move 1; 356 field failures, the largest
// class being quoting mangled on the way into -Command). This box has no
// PowerShell, so these pin the pure logic the Windows run depends on.

import test from "node:test";
import assert from "node:assert/strict";
import { powerShellInvocation, POWERSHELL_ENCODED_MAX_CHARS, powerShellErrorLocation } from "../packages/tools/dist/index.js";

const SCRIPT = "C:/ws/.ares/shell-output/s/run.ps1";

test("a plain one-liner still goes as -Command, unchanged", () => {
  const inv = powerShellInvocation("Get-ChildItem -Name", SCRIPT);
  assert.deepEqual(inv.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem -Name"]);
  assert.equal(inv.script, undefined);
});

test("multi-line or double-quoted commands go as -EncodedCommand (UTF-16LE base64), exactly round-tripping", () => {
  for (const command of [
    'Write-Output "hello world"',
    "$a = 1\n$b = 2\n$a + $b",
    "$x = @'\nline \"one\"\n'@\nWrite-Output $x",
    'Set-Content -Path "Ares Workspace\\é.txt" -Value "ünïcode" -Encoding utf8',
  ]) {
    const inv = powerShellInvocation(command, SCRIPT);
    const at = inv.args.indexOf("-EncodedCommand");
    assert.ok(at > 0, `expected -EncodedCommand for ${JSON.stringify(command)}`);
    assert.equal(inv.args.includes("-Command"), false);
    assert.equal(Buffer.from(inv.args[at + 1], "base64").toString("utf16le"), command);
    assert.equal(inv.script, undefined);
  }
});

test("a script too long for a Windows command line spills to a BOM'd .ps1 run with -File", () => {
  const long = Array.from({ length: 400 }, (_, i) => `Write-Output "line ${i} ${"x".repeat(30)}"`).join("\n");
  assert.ok(long.length > POWERSHELL_ENCODED_MAX_CHARS);
  const inv = powerShellInvocation(long, SCRIPT);
  assert.deepEqual(inv.args.slice(-2), ["-File", SCRIPT]);
  assert.ok(inv.args.includes("Bypass"));
  assert.equal(inv.script.path, SCRIPT);
  assert.equal(inv.script.content, `\uFEFF${long}`);
  // Encoded form must fit a 32,767-char command line at the threshold.
  const atLimit = "\"".repeat(POWERSHELL_ENCODED_MAX_CHARS);
  const encoded = powerShellInvocation(atLimit, SCRIPT).args.at(-1);
  assert.ok(encoded.length < 32_000, `encoded length ${encoded.length}`);
});

test("a PowerShell error location is quoted back with the offending line", () => {
  const command = "$a = 1\nif ($a -eq 1) {\n  Write-Output 'x' &&\n}";
  const stderr = "At line:3 char:19\n+   Write-Output 'x' &&\n+                   ~~\nThe token '&&' is not a valid statement separator in this version.\n    + CategoryInfo          : ParserError";
  assert.equal(
    powerShellErrorLocation(command, stderr),
    "error at line 3, char 19 of your script: `Write-Output 'x' &&`",
  );
  assert.equal(powerShellErrorLocation(command, "no location here"), null);
  assert.equal(powerShellErrorLocation(command, "At line:42 char:1"), null, "a line outside the script is not ours");
});

test("ARES_PS_ENCODED=0 restores plain -Command delivery", () => {
  const prev = process.env.ARES_PS_ENCODED;
  process.env.ARES_PS_ENCODED = "0";
  try {
    const inv = powerShellInvocation('Write-Output "a"\nWrite-Output "b"', SCRIPT);
    assert.equal(inv.args.at(-2), "-Command");
  } finally {
    if (prev === undefined) delete process.env.ARES_PS_ENCODED; else process.env.ARES_PS_ENCODED = prev;
  }
});
