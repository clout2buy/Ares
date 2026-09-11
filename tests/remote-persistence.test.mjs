// Boot persistence for a paired device.
//
// The owner is turning a laptop into a database box: Ares must reach it the
// moment it powers on, with credentials high enough to administer it, whether
// or not anyone has logged in since the reboot. That rules out the per-user
// flavours of autostart — an AtLogOn task, a LaunchAgent, a `systemd --user`
// unit — which all wait for a login and die at logout.
//
// These tests mostly guard against the per-user variants creeping back in,
// because both flavours LOOK like "run it automatically" and only one of them
// gives you a machine that answers at 4am with nobody sitting at it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  windowsInstallScript,
  windowsUninstallScript,
  macLaunchDaemonPlist,
  macInstallScript,
  linuxSystemdUnit,
  linuxInstallScript,
  installScriptFor,
  persistenceConsentSummary,
  DEFAULT_SERVICE_NAME,
} from "../packages/cli/dist/remotePersistence.js";

const OPTS = {
  runtime: "C:\\Python312\\python.exe",
  scriptPath: "C:\\ProgramData\\Ares\\ares-connect.py",
  deviceId: "dev_1234567890abcdef",
};
const NIX = {
  runtime: "/usr/bin/python3",
  scriptPath: "/opt/ares/ares-connect.py",
  deviceId: "dev_1234567890abcdef",
};

// --- windows ---------------------------------------------------------------
// The owner's requirement is "it needs to execute how I would". SYSTEM has more
// local privilege but is a DIFFERENT USER: no profile, no mapped drives, no
// per-user PATH, no user DPAPI. Defaulting to it would mean commands behaving
// differently under Ares than when pasted by hand -- the exact confusion the
// feature exists to remove. So: the owner's account, at RunLevel Highest.

test("windows: boot trigger, not logon", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /New-ScheduledTaskTrigger -AtStartup/);
  assert.ok(!/-AtLogOn/.test(s), "AtLogOn would mean unreachable until someone signs in");
});

test("windows: defaults to the OWNER'S account, elevated -- not SYSTEM", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /-RunLevel Highest/, "still elevated");
  assert.match(s, /\$env:USERNAME/, "runs as the owner");
  assert.ok(!/S-1-5-18/.test(s), "SYSTEM is a different user and would break fidelity");
});

test("windows: the default logon keeps NETWORK credentials", () => {
  // S4U would silently lose mapped drives and UNC paths.
  const s = windowsInstallScript(OPTS);
  assert.match(s, /Get-Credential/);
  assert.match(s, /-Password \$cred\.GetNetworkCredential\(\)\.Password/);
  assert.ok(!/-LogonType S4U/.test(s), "the default must not be the credential-less token");
});

test("windows: the password is prompted for, never embedded in the script", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /Get-Credential -UserName \$me/, "prompted interactively");
  assert.match(s, /never sent anywhere|never sees it/i, "and the script says so");
});

test("windows: s4u is available, and states its own limitation in the script", () => {
  const s = windowsInstallScript({ ...OPTS, windowsLogon: "s4u" });
  assert.match(s, /-LogonType S4U/);
  assert.match(s, /-RunLevel Highest/);
  assert.ok(!/Get-Credential/.test(s), "s4u stores no password");
  assert.match(s, /NO NETWORK CREDENTIALS/, "the caveat is in the script the owner reads");
});

test("windows: system is still available when a headless account is wanted", () => {
  const s = windowsInstallScript({ ...OPTS, runAs: "system" });
  assert.match(s, /-UserId 'S-1-5-18'/);
  assert.match(s, /-LogonType ServiceAccount/);
  assert.ok(!/Get-Credential/.test(s), "SYSTEM needs no password");
});

test("windows: refuses to run unelevated instead of failing halfway", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /IsInRole/);
  assert.match(s, /ADMIN PowerShell/);
});

test("windows: battery defaults are overridden -- the appliance IS a laptop", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /-AllowStartIfOnBatteries/);
  assert.match(s, /-DontStopIfGoingOnBatteries/);
});

test("windows: restarts on failure and never times out", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /-RestartCount 999/);
  assert.match(s, /-ExecutionTimeLimit \(New-TimeSpan -Seconds 0\)/, "0 = no limit");
  assert.match(s, /-StartWhenAvailable/);
});

test("windows: a re-install replaces cleanly rather than erroring on a duplicate", () => {
  const s = windowsInstallScript(OPTS);
  assert.match(s, /Get-ScheduledTask -TaskName \$name/);
  assert.match(s, /Unregister-ScheduledTask/);
});

test("windows: uninstall removes exactly the task we made, and tolerates absence", () => {
  const s = windowsUninstallScript(OPTS);
  assert.match(s, new RegExp(DEFAULT_SERVICE_NAME));
  assert.match(s, /Unregister-ScheduledTask/);
  assert.match(s, /Not installed/, "running it twice must not be an error");
});

// ─── macos ─────────────────────────────────────────────────────────────────

test("macos: a LaunchDaemon, never a LaunchAgent", () => {
  const s = macInstallScript(NIX);
  assert.match(s, /\/Library\/LaunchDaemons\//);
  assert.ok(!/LaunchAgents/.test(s), "a LaunchAgent only exists inside a logged-in GUI session");
});

test("macos: loads at boot and is kept alive", () => {
  const plist = macLaunchDaemonPlist(NIX);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("macos: ownership and mode are set — launchd refuses a writable daemon", () => {
  const s = macInstallScript(NIX);
  assert.match(s, /chown root:wheel/);
  assert.match(s, /chmod 644/);
});

test("macos: insists on root", () => {
  assert.match(macInstallScript(NIX), /id -u.*-eq 0|run with sudo/s);
});

test("macos: plist is well-formed enough to parse as XML", () => {
  const plist = macLaunchDaemonPlist(NIX);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<\/plist>$/);
  // Every <dict> opened is closed — a malformed plist is silently ignored by launchd.
  assert.equal((plist.match(/<dict>/g) || []).length, (plist.match(/<\/dict>/g) || []).length);
  assert.equal((plist.match(/<array>/g) || []).length, (plist.match(/<\/array>/g) || []).length);
});

// ─── linux ─────────────────────────────────────────────────────────────────

test("linux: a system unit wanted by multi-user, not a --user unit", () => {
  const unit = linuxSystemdUnit(NIX);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /User=root/);
  const install = linuxInstallScript(NIX);
  assert.match(install, /\/etc\/systemd\/system\//);
  assert.ok(!/--user/.test(install), "a --user unit needs a login session");
});

test("linux: waits for the network so the first resolve is not doomed", () => {
  const unit = linuxSystemdUnit(NIX);
  assert.match(unit, /After=network-online\.target/);
  assert.match(unit, /Wants=network-online\.target/);
});

test("linux: restarts forever — systemd's start limit would give up permanently", () => {
  const unit = linuxSystemdUnit(NIX);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /StartLimitIntervalSec=0/);
});

test("linux: enables AND starts, so the first run needs no reboot", () => {
  assert.match(linuxInstallScript(NIX), /systemctl enable --now/);
  assert.match(linuxInstallScript(NIX), /systemctl daemon-reload/);
});

// ─── shared ────────────────────────────────────────────────────────────────

test("every target names the device, so two installs are tellable apart", () => {
  for (const [target, o] of [["windows", OPTS], ["macos", NIX], ["linux", NIX]]) {
    assert.match(installScriptFor(target, o), /dev_1234567890abcdef/, `${target} mentions the device`);
  }
});

test("the consent summary tells the truth about WHICH account, per choice", () => {
  const asUser = persistenceConsentSummary("windows", OPTS);
  assert.match(asUser, /your own account, elevated/);
  assert.match(asUser, /WITHOUT anyone logging in/);
  assert.match(asUser, /never seen by Ares/, "password handling is stated up front");
  assert.match(asUser, /unpair/, "the owner must be told the off switch");

  const asSystem = persistenceConsentSummary("windows", { ...OPTS, runAs: "system" });
  assert.match(asSystem, /NOT your user/, "the fidelity cost must be stated, not buried");
  assert.match(asSystem, /no mapped drives/);

  const s4u = persistenceConsentSummary("windows", { ...OPTS, windowsLogon: "s4u" });
  assert.match(s4u, /NO network credentials/i);

  for (const target of ["macos", "linux"]) {
    const s = persistenceConsentSummary(target, NIX);
    assert.match(s, /root/);
    assert.match(s, /WITHOUT anyone logging in/);
  }
});

test("no install script silently executes itself — they are text for the owner to run", () => {
  // The whole design is that Ares never acquires permanent elevated persistence
  // on its own; the owner pastes it knowingly.
  for (const [target, o] of [["windows", OPTS], ["macos", NIX], ["linux", NIX]]) {
    assert.equal(typeof installScriptFor(target, o), "string", `${target} returns a script, not an action`);
  }
});
