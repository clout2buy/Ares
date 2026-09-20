// The generated Windows device connector.
//
// It is a PowerShell program living inside a TypeScript String.raw template, so
// nothing here can be trusted to the type checker: TypeScript compiles a
// syntactically broken script perfectly happily, and a script that cannot parse
// is a device that never connects and never says why.
//
// These tests cover the two ways that goes wrong: the template mangling the
// script on the way out, and the script disagreeing with the server about the
// handshake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { buildDeviceConnectorPs1 } from "../packages/cli/dist/remoteDeviceConnector.js";
import { proofFor } from "../packages/cli/dist/remoteDeviceCrypto.js";
import { channelKeys, sealFrame } from "../packages/cli/dist/remoteChannelCrypto.js";

const SCRIPT = buildDeviceConnectorPs1({
  token: "tok-abc123",
  wsUrl: "wss://random-name.trycloudflare.com/ws",
  baseUrl: "https://random-name.trycloudflare.com",
  discoveryPort: 7423,
});

// ─── template integrity ────────────────────────────────────────────────────

test("every placeholder is substituted", () => {
  assert.ok(!/__ARES_/.test(SCRIPT), "a leftover placeholder ships a broken script");
  assert.match(SCRIPT, /tok-abc123/);
  assert.match(SCRIPT, /random-name\.trycloudflare\.com/);
  assert.match(SCRIPT, /\$DiscoPort = 7423/);
});

test("no backtick survives into the script", () => {
  // A backtick TERMINATES the String.raw template it is generated from, so one
  // appearing here means the template was silently truncated.
  assert.ok(!SCRIPT.includes("`"), "backticks cannot exist in a String.raw template");
});

test("no JS interpolation leaked through", () => {
  // String.raw strips escapes but still expands dollar-brace, so an unescaped
  // one becomes a build error or, worse, silently substitutes a JS value.
  assert.ok(!/\$\{/.test(SCRIPT), "dollar-brace must never reach the generated script");
});

test("PowerShell's own variables DID survive", () => {
  // The flip side: over-sanitising would strip the script's real variables.
  for (const v of ["$StateDir", "$CredFile", "$Token", "$backoff"]) {
    assert.ok(SCRIPT.includes(v), `${v} must survive generation`);
  }
});

// ─── handshake interop ─────────────────────────────────────────────────────

test("the script's HMAC construction matches the server's, byte for byte", () => {
  // If these ever diverge nothing authenticates, and the symptom is a device
  // that reconnects forever. Reproduce the script's exact construction:
  //   HMACSHA256(key).ComputeHash(UTF8($Label + ':' + $Nonce)) -> lowercase hex
  const key = "test-key-abcdefghijklmnop";
  const nonce = "nonce-1234567890";
  for (const label of ["device", "server"]) {
    const asScriptDoes = createHmac("sha256", Buffer.from(key, "utf8"))
      .update(Buffer.from(`${label}:${nonce}`, "utf8"))
      .digest("hex");
    assert.equal(proofFor(key, nonce, label), asScriptDoes, `${label} proof must match`);
  }
});

test("the script concatenates rather than interpolating the MAC input", () => {
  // Both PowerShell escaping spellings are unavailable inside String.raw, so
  // this line has exactly one safe form. Guard it: an "innocent" tidy-up back
  // to interpolation breaks the build or the handshake.
  assert.match(SCRIPT, /\$Label \+ ':' \+ \$Nonce/);
});

test("proofs are direction-bound, so one side's cannot be replayed as the other's", () => {
  const p = (label) => proofFor("k", "n", label);
  assert.notEqual(p("device"), p("server"));
});

// ─── the behaviour that makes it a PAIRED device, not a one-time link ──────

test("it reconnects forever — no deadline", () => {
  assert.match(SCRIPT, /while \(\$true\)/);
  // The one-time connector gives up after 12 hours, which is right for helping
  // a friend once and wrong for a machine expected to be reachable always.
  assert.ok(!/AddHours\(12\)|AddMinutes\(10\)/.test(SCRIPT), "no give-up deadline");
});

test("backoff is capped and jittered", () => {
  assert.match(SCRIPT, /Math\]::Min\(60, \$backoff/);
  assert.match(SCRIPT, /Get-Random/, "jitter stops a fleet returning in lockstep");
});

test("a permanent refusal stops the connector instead of hammering", () => {
  assert.match(SCRIPT, /refused permanently/);
  assert.match(SCRIPT, /exit 1/);
});

test("it verifies the SERVER before obeying anything", () => {
  assert.match(SCRIPT, /SERVER PROOF FAILED/);
  assert.match(SCRIPT, /Test-ProofEqual/);
  const idx = SCRIPT.indexOf("SERVER PROOF FAILED");
  const authIdx = SCRIPT.indexOf("device_auth");
  assert.ok(idx < authIdx, "the server is checked BEFORE we authenticate to it");
});

test("v5 proves channel capability in the auth proof and requires a MACed ready", () => {
  assert.match(SCRIPT, /device:mac1/);
  assert.match(SCRIPT, /Start-AuthenticatedChannel/);
  assert.match(SCRIPT, /ready\.channel -ne 'mac1'/);
  const auth = SCRIPT.indexOf("type = 'device_auth'");
  const arm = SCRIPT.indexOf("Start-AuthenticatedChannel", auth);
  const ready = SCRIPT.indexOf("Receive-JsonTimeout", arm);
  assert.ok(auth < arm && arm < ready, "auth is plain, then keys arm BEFORE device_ready is read");
});

test("every steady-state frame uses the authenticated send/receive wrappers", () => {
  assert.match(SCRIPT, /Protect-ChannelText/);
  assert.match(SCRIPT, /Unprotect-ChannelText/);
  assert.match(SCRIPT, /channel frame failed authentication or sequence/);
  assert.match(SCRIPT, /\$script:ChannelD2SSeq\+\+/);
  assert.match(SCRIPT, /\$script:ChannelS2DSeq\+\+/);
  // PowerShell does not use backslash escaping inside single-quoted strings.
  // A literal backslash here changes both JSON and MAC-covered bytes.
  assert.ok(!SCRIPT.includes('\\"seq'), "channel framing must not emit backslash-quoted JSON");
  assert.ok(!SCRIPT.includes('\\"mac'), "channel framing must not emit backslash-quoted JSON");
  assert.match(SCRIPT, /',"seq":"'/);
  assert.match(SCRIPT, /',"mac":"'/);
});

test("a fresh enrolment reconnects before accepting commands", () => {
  const saved = SCRIPT.indexOf("Save-Credential $Cred");
  const reconnect = SCRIPT.indexOf("reconnecting on authenticated channel", saved);
  const eventLoop = SCRIPT.indexOf("# ── event loop", reconnect);
  assert.ok(saved < reconnect && reconnect < eventLoop);
  assert.match(SCRIPT.slice(reconnect, eventLoop), /return @\{ ok = \$true; retry = \$true \}/);
});

test("proof comparison is not short-circuiting", () => {
  // PowerShell's -eq on strings returns early; on a proof that is a timing
  // oracle, and a way to forge one character at a time.
  assert.match(SCRIPT, /-bor \(\[int\]\[char\]/);
});

test("the steady-state receive is BLOCKING, never a cancellation timeout", () => {
  // The load-bearing fix: cancelling a .NET WebSocket ReceiveAsync ABORTS the
  // socket, so a per-frame cancellation timeout made the connector reconnect
  // forever (30 cycles in a live test, spamming the owner). The event loop must
  // block on CancellationToken.None; only the handshake may use a timed receive
  // (where an abort-on-timeout is harmless because it tears down and reconnects).
  const evLoop = SCRIPT.slice(SCRIPT.indexOf("while ($ws.State -eq 'Open')"));
  assert.match(evLoop, /\$cmd = Receive-Json \$ws\b/, "event loop uses the blocking receive");
  assert.ok(!/\$cmd = Receive-Json \$ws \d/.test(SCRIPT), "no timeout arg on the steady-state receive");
  assert.match(SCRIPT, /CancellationToken\]::None/, "blocking receive keeps the socket alive");
  assert.match(SCRIPT, /Reap-Jobs/, "finished commands are still swept, not awaited inline");
  // The handshake keeps its timed receive — abort-on-timeout is fine there.
  assert.match(SCRIPT, /Receive-JsonTimeout \$ws 30000/, "handshake still bounded");
});

test("both output pipes are drained concurrently", () => {
  // A command that fills the stderr buffer deadlocks if only stdout is read.
  assert.match(SCRIPT, /StandardOutput\.ReadToEndAsync/);
  assert.match(SCRIPT, /StandardError\.ReadToEndAsync/);
});

test("a timed-out command is killed and reported, not leaked", () => {
  assert.match(SCRIPT, /Command timed out/);
  assert.match(SCRIPT, /\$j\.proc\.Kill\(\)/);
});

test("it answers the server's heartbeat", () => {
  assert.match(SCRIPT, /'ping' \{ Send-Json \$ws @\{ type = 'pong' \}/);
});

test("a heartbeat lands on disk too, so the update watchdog can see it is alive", () => {
  // The watchdog that rolls back a failed connector update runs in its own
  // process with no socket. A file is the only proof of life it can read.
  assert.match(SCRIPT, /'ping' \{ Send-Json \$ws @\{ type = 'pong' \}; Write-Heartbeat \}/);
  assert.match(SCRIPT, /function Write-Heartbeat/);
});

test("the credential is stored with a tightened ACL", () => {
  // It is a permanent elevated key to this machine.
  assert.match(SCRIPT, /SetAccessRuleProtection/);
  assert.match(SCRIPT, /BUILTIN\\Administrators/);
  assert.match(SCRIPT, /NT AUTHORITY\\SYSTEM/);
});

test("the credential write is atomic", () => {
  assert.match(SCRIPT, /Move-Item -Force/, "a half-written credential would orphan the device");
});

// ─── rendezvous ────────────────────────────────────────────────────────────

test("the ladder tries cached address, then LAN discovery, then the seed", () => {
  const cached = SCRIPT.indexOf("lastWsUrl");
  const disco = SCRIPT.indexOf("ares-remote-discover/1");
  const seed = SCRIPT.indexOf("$SeedBase -replace");
  assert.ok(cached > 0 && disco > cached, "discovery comes after the cached address");
  assert.ok(seed > disco, "the install-time address is the last resort");
});

test("discovery probes every interface, not just the global broadcast", () => {
  // The owner's machine has four non-internal IPv4 interfaces, three virtual.
  assert.match(SCRIPT, /GetAllNetworkInterfaces/);
  assert.match(SCRIPT, /IPv4Mask/, "subnet-directed broadcast per interface");
  assert.match(SCRIPT, /255\.255\.255\.255/, "global kept as a backstop");
});

test("loopback is not probed", () => {
  assert.match(SCRIPT, /StartsWith\('127\.'\)/);
});

test("a learned address is cached so the next boot skips discovery", () => {
  assert.match(SCRIPT, /lastWsUrl -ne \$WsUrl/);
});

// ─── link awareness ────────────────────────────────────────────────────────
//
// Field report (2026-09-13): "it took a while to boot up remote connect to u --
// make sure it auto connects when the internet is hit". The laptop powered on
// before its WiFi associated, so every attempt failed fast, the backoff climbed
// to its 60s ceiling, and the connector then served out that blind timer after
// the link was already back.

test("the loop waits for the link before spending an attempt", () => {
  assert.match(SCRIPT, /function Test-NetworkUp/);
  assert.match(SCRIPT, /GetIsNetworkAvailable/);
  assert.match(
    SCRIPT,
    /if \(-not \(Test-NetworkUp\)\) \{/,
    "the reconnect loop must gate on the link, not just sleep",
  );
});

test("waiting for the link cannot wedge the connector forever", () => {
  // GetIsNetworkAvailable can return a false negative. An unbounded wait on it
  // would strand a reachable machine, which is the exact failure this whole
  // file exists to prevent.
  assert.match(SCRIPT, /\$waited -lt 300/, "the link wait must be bounded");
});

test("a local outage does not inflate the backoff", () => {
  // The home never refused us, so the backoff learned nothing and must not
  // punish the next attempt.
  const gate = SCRIPT.indexOf("network down - waiting for link");
  const reset = SCRIPT.indexOf("$backoff = 2", gate);
  assert.ok(gate > 0, "the link gate must exist");
  assert.ok(reset > gate && reset - gate < 400, "the backoff resets after a link outage");
});

test("Test-NetworkUp fails open", () => {
  // A throwing API must never stop the connector from trying.
  assert.match(SCRIPT, /GetIsNetworkAvailable\(\) \} catch \{ return \$true \}/);
});

// ─── it actually parses ────────────────────────────────────────────────────
//
// This file's own header says a script that cannot parse is "a device that
// never connects and never says why" -- but every test above only pattern
// matches the text. TypeScript will compile a syntactically broken PowerShell
// program without a murmur. Hand it to PowerShell's real parser.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function findPowershell() {
  for (const exe of ["pwsh", "powershell"]) {
    try {
      execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        stdio: "ignore",
        timeout: 30000,
      });
      return exe;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const PS_EXE = findPowershell();

test(
  "PowerShell and Node derive identical channel keys and frame MACs",
  { skip: PS_EXE ? false : "no PowerShell on this host" },
  () => {
    const deviceSecret = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
    const serverKey = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString("base64url");
    const deviceNonce = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 3)).toString("base64url");
    const serverNonce = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString("base64url");
    const keys = channelKeys(deviceSecret, serverKey, deviceNonce, serverNonce);
    assert.ok(keys);
    const expectedWire = sealFrame(keys.d2s, 0x02, 0, '{"type":"pong"}');
    const inboundWire = sealFrame(keys.s2d, 0x01, 0, '{"type":"ping"}');
    assert.ok(inboundWire);
    const tamperedWire = inboundWire.replace('"ping"', '"pong"');

    const start = SCRIPT.indexOf("function Get-Proof");
    const end = SCRIPT.indexOf("# ─── credential storage", start);
    assert.ok(start >= 0 && end > start, "crypto block exists in generated connector");
    const cryptoBlock = SCRIPT.slice(start, end);
    const probe = [
      cryptoBlock,
      `$c = [pscustomobject]@{ deviceSecret = '${deviceSecret}'; serverKey = '${serverKey}' }`,
      `$k = Get-ChannelKeys $c '${deviceNonce}' '${serverNonce}'`,
      "(($k.s2d | ForEach-Object { $_.ToString('x2') }) -join '')",
      "(($k.d2s | ForEach-Object { $_.ToString('x2') }) -join '')",
      `[void](Start-AuthenticatedChannel $c '${deviceNonce}' '${serverNonce}')`,
      "Protect-ChannelText '{\"type\":\"pong\"}'",
      `if ((Unprotect-ChannelText '${inboundWire}') -eq '{"type":"ping","seq":"0"}') { 'GOOD_ACCEPT' } else { 'GOOD_FAIL' }`,
      "Stop-AuthenticatedChannel",
      `[void](Start-AuthenticatedChannel $c '${deviceNonce}' '${serverNonce}')`,
      `if ($null -eq (Unprotect-ChannelText '${tamperedWire}')) { 'TAMPER_REJECT' } else { 'TAMPER_ACCEPT' }`,
      "Stop-AuthenticatedChannel",
      `[void](Start-AuthenticatedChannel $c '${deviceNonce}' '${serverNonce}')`,
      `if ($null -eq (Unprotect-ChannelText '{"type":"ping"}')) { 'PLAIN_REJECT' } else { 'PLAIN_ACCEPT' }`,
    ].join("\n");
    const dir = mkdtempSync(path.join(os.tmpdir(), "ares-macinterop-"));
    const target = path.join(dir, "interop.ps1");
    writeFileSync(target, probe, "utf8");
    const out = execFileSync(
      PS_EXE,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", target],
      { encoding: "utf8", timeout: 60_000 },
    ).trim().split(/\r?\n/);
    assert.deepEqual(out, [
      keys.s2d.toString("hex"),
      keys.d2s.toString("hex"),
      expectedWire,
      "GOOD_ACCEPT",
      "TAMPER_REJECT",
      "PLAIN_REJECT",
    ]);
  },
);

const CHECKER = [
  "param([string]$Target)",
  "$errs = $null; $toks = $null",
  "[void][System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$toks, [ref]$errs)",
  "if ($errs -and $errs.Count -gt 0) {",
  "  $errs | ForEach-Object { Write-Output ('line ' + $_.Extent.StartLineNumber + ': ' + $_.Message) }",
  "  exit 1",
  "}",
  "Write-Output ('tokens=' + $toks.Count)",
  "exit 0",
].join("\n");

test(
  "the generated script parses cleanly under PowerShell's own parser",
  { skip: PS_EXE ? false : "no PowerShell on this host" },
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ares-connparse-"));
    const target = path.join(dir, "connector.ps1");
    const checker = path.join(dir, "check.ps1");
    writeFileSync(target, SCRIPT, "utf8");
    writeFileSync(checker, CHECKER, "utf8");

    let out;
    try {
      out = execFileSync(
        PS_EXE,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", checker, target],
        { encoding: "utf8", timeout: 180000 },
      );
    } catch (err) {
      assert.fail(`the connector does not parse:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
    assert.match(out, /tokens=\d+/, "the parser must report a token count");
  },
);
