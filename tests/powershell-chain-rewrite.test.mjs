// PowerShell `&&`/`||` on Windows PowerShell 5.1 (field window Sep 20 - Nov 2:
// PowerShell was the most-failing tool, 13 parse errors from bash-isms). The
// command is rewritten by a small tokenizer before it reaches powershell.exe
// 5.1; strings, here-strings, comments and parentheses are left alone. The
// Windows cases run the REAL powershell.exe.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  rewritePowerShellChains,
  chainRewriteFor,
  powerShellParseMessage,
  decodeClixml,
  PowerShellTool,
} from "../packages/tools/dist/index.js";

const rw = (c) => rewritePowerShellChains(c).command;

test("a && b and a || b become 5.1 statements", () => {
  assert.equal(rw("npm run build && npm test"), "npm run build; if ($?) { npm test }");
  assert.equal(rw("Test-Path x || New-Item x"), "Test-Path x; if (-not $?) { New-Item x }");
  assert.equal(rw("a && b && c"), "a; if ($?) { b; if ($?) { c } }");
});

test("a mixed chain is left-associative through a flag", () => {
  assert.equal(
    rw("a && b || c"),
    "a; $__aresOk = $?; if ($__aresOk) { b; $__aresOk = $? }; if (-not $__aresOk) { c; $__aresOk = $? }",
  );
});

test("operators inside strings, here-strings, comments and parentheses do not move", () => {
  for (const c of [
    "Write-Output 'a && b'",
    'Write-Output "a || b"',
    "Write-Output 'it''s && fine'",
    "$x = @'\na && b\n'@\nWrite-Output $x",
    "Get-Date # later: a && b",
    "<# a && b #> Get-Date",
    "Write-Output ${env:A&&B}",
    "Get-ChildItem",
  ]) {
    const r = rewritePowerShellChains(c);
    assert.equal(r.changed, false, c);
    assert.equal(r.command, c);
  }
  // Plain parentheses cannot hold a statement list in 5.1: left for PowerShell to report.
  assert.equal(rewritePowerShellChains("(a && b)").changed, false);
});

test("statements, blocks, subexpressions and lines are handled separately; line count is kept", () => {
  assert.equal(rw("cd src; a && b; c"), "cd src; a; if ($?) { b }; c");
  assert.equal(rw("if ($y) { a && b }"), "if ($y) { a; if ($?) { b } }");
  assert.equal(rw('Write-Output "$(a && b)"'), 'Write-Output "$(a; if ($?) { b })"');
  const multi = "a && b\nWrite-Output 'x && y'\nc || d";
  const out = rw(multi);
  assert.equal(out, "a; if ($?) { b }\nWrite-Output 'x && y'\nc; if (-not $?) { d }");
  assert.equal(out.split("\n").length, multi.split("\n").length);
  // A newline after the operator continues the chain (pwsh 7 accepts it).
  assert.equal(rw("a &&\n  b"), "a; if ($?) {\n  b }");
});

test("unbalanced input is passed through untouched for PowerShell to report", () => {
  const c = "Write-Output 'oops && b";
  assert.deepEqual(rewritePowerShellChains(c), { command: c, changed: false });
});

test("only Windows PowerShell 5.1 is rewritten; pwsh 7 and the env opt-out are not", () => {
  assert.equal(chainRewriteFor("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "a && b").changed, true);
  assert.equal(chainRewriteFor("C:/Program Files/PowerShell/7/pwsh.exe", "a && b").changed, false);
  process.env.ARES_PS_CHAIN_REWRITE = "0";
  try {
    assert.equal(chainRewriteFor("powershell.exe", "a && b").changed, false);
  } finally {
    delete process.env.ARES_PS_CHAIN_REWRITE;
  }
});

test("the parser's sentence is pulled out of a 5.1 ParserError record", () => {
  const record = [
    "At line:1 char:8",
    "+ echo a && echo b",
    "+        ~~",
    "The token '&&' is not a valid statement separator in this version.",
    "    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException",
  ].join("\r\n");
  assert.equal(powerShellParseMessage(record), "The token '&&' is not a valid statement separator in this version.");
  assert.equal(powerShellParseMessage("Get-Item : Cannot find path 'x'\nAt line:1 char:1"), null);
});

test("CLIXML error streams (5.1 + -EncodedCommand) decode to plain text", () => {
  const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>x</T></TN></Obj><S S="Error">At line:2 char:9_x000D__x000A_</S><S S="Error">The token \'&amp;&amp;\' is not valid._x000D__x000A_</S></Objs>';
  assert.equal(decodeClixml(raw), "At line:2 char:9\r\nThe token '&&' is not valid.");
  assert.equal(decodeClixml("plain error"), "plain error");
});

// ── Real powershell.exe ───────────────────────────────────────────────────────

const ctx = (workspace) => ({
  workspace,
  sessionId: "sess_ps_chain",
  signal: new AbortController().signal,
  permissionMode: "workspace-write",
  fileReadStamps: new Map(),
});

const onWindows = process.platform === "win32";

test("real PowerShell: && runs the second command only on success", { skip: !onWindows }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-ps-chain-"));
  const ok = await PowerShellTool.call({ command: "Write-Output first && Write-Output second", description: "t", timeout: 60000 }, ctx(tmp));
  assert.equal(ok.failure, undefined, ok.display);
  assert.match(ok.output.stdout, /first\s+second/);

  const skip = await PowerShellTool.call(
    { command: "Get-Item 'definitely-missing-file' && Write-Output should-not-run", description: "t", timeout: 60000 },
    ctx(tmp),
  );
  assert.doesNotMatch(skip.output.stdout, /should-not-run/);

  const fallback = await PowerShellTool.call(
    { command: "Get-Item 'definitely-missing-file' || Write-Output fallback-ran", description: "t", timeout: 60000 },
    ctx(tmp),
  );
  assert.match(fallback.output.stdout, /fallback-ran/);

  const mixed = await PowerShellTool.call(
    { command: "Write-Output \"a && b\"\ncmd /c exit 3 && Write-Output no || Write-Output yes", description: "t", timeout: 60000 },
    ctx(tmp),
  );
  assert.match(mixed.output.stdout, /a && b/);
  assert.match(mixed.output.stdout, /yes/);
  assert.doesNotMatch(mixed.output.stdout, /\bno\b/);
  if (/5\.1/.test(ok.output.dialect)) assert.match(ok.output.chainRewrite, /rewritten for Windows PowerShell 5\.1/);
});

test("real PowerShell: a parse error that remains is returned with the parser sentence and the offending line", { skip: !onWindows }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-ps-chain-"));
  const r = await PowerShellTool.call(
    { command: "Write-Output ok\n$x = (1 && 2)", description: "t", timeout: 60000 },
    ctx(tmp),
  );
  if (/5\.1/.test(r.output.dialect)) {
    // 5.1: `&&` inside parentheses is not a statement chain, so it survives
    // the rewrite and the parser still refuses it.
    assert.ok(r.failure, "still fails");
    assert.doesNotMatch(r.output.stderr, /CLIXML|_x000D_|&amp;/, "the error stream reaches the model as text, not CLIXML");
    assert.match(r.failure, /PowerShell refused to parse the command: .*&&/);
    assert.match(r.failure, /error at line 2, char \d+ of your script: `\$x = \(1 && 2\)`/);
    return;
  }
  // pwsh 7 (CI runners have it): `(1 && 2)` is valid there, so use a line that
  // no PowerShell parses.
  const broken = await PowerShellTool.call(
    { command: "Write-Output ok\n$x = (1 +)", description: "t", timeout: 60000 },
    ctx(tmp),
  );
  assert.ok(broken.failure, "a real parse error still fails on pwsh 7");
  assert.doesNotMatch(broken.output.stderr, /CLIXML|_x000D_|&amp;/, "the error stream reaches the model as text, not CLIXML");
});
