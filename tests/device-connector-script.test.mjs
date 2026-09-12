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
  assert.match(SCRIPT, /'ping' \{ Send-Json \$ws @\{ type = 'pong' \} \}/);
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
