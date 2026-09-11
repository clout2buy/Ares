// Boot persistence for a paired device.
//
// Two very different things get called "run it automatically", and picking the
// wrong one is the difference between a machine Ares can always reach and a
// machine Ares can reach only while somebody is logged in:
//
//   per-user  — Scheduled Task AtLogOn / LaunchAgent / systemd --user.
//               Starts after login, runs as that user, dies at logout. Right
//               for a person's own laptop that they sit in front of.
//
//   system    — Scheduled Task AtStartup as SYSTEM / LaunchDaemon / a system
//               systemd unit. Starts at boot with no login, runs elevated,
//               survives logout. Right for an APPLIANCE.
//
// This module generates the system flavour, because the case it was built for
// is a laptop being turned into a database box: reachable the moment it powers
// on, with credentials high enough to administer it, whether or not anyone has
// ever logged in since the reboot.
//
// Nothing here executes anything. It emits scripts the OWNER runs once,
// knowingly, with elevation. Silently acquiring permanent SYSTEM persistence on
// a machine is not a thing an agent should do on its own recognisance, and an
// install the owner pasted is an install they can read first.

export type PersistenceTarget = "windows" | "macos" | "linux";

export interface PersistenceOptions {
  /** Task/service name. Also what the uninstall script looks for. */
  serviceName?: string;
  /** Absolute path to the runtime that runs the connector (python3, node, …). */
  runtime: string;
  /** Absolute path to the installed connector script. */
  scriptPath: string;
  /** Device id, for logging and so an operator can tell two installs apart. */
  deviceId: string;
  /** Where the connector should write its own log. */
  logPath?: string;
}

export const DEFAULT_SERVICE_NAME = "AresRemoteConnector";

function serviceName(opts: PersistenceOptions): string {
  return opts.serviceName ?? DEFAULT_SERVICE_NAME;
}

/**
 * Windows: a Scheduled Task, not a Service.
 *
 * A real Service would need an SCM-aware wrapper binary (a plain script exits
 * immediately from the SCM's point of view and gets killed as "failed to
 * start"). A boot-triggered task as S-1-5-18 gets the same three properties
 * with no wrapper: starts at boot with no login, runs as SYSTEM, restarts on
 * failure.
 *
 * Built from cmdlets rather than a task XML on purpose: schtasks /XML wants
 * UTF-16, and getting a BOM wrong here is a trap this codebase has been bitten
 * by more than once.
 */
export function windowsInstallScript(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  const log = opts.logPath ?? "$env:ProgramData\\Ares\\connector.log";
  return [
    "# Ares remote connector — install as a boot-time SYSTEM task.",
    "# Run this ONCE in an elevated PowerShell. Read it before you do.",
    "$ErrorActionPreference = 'Stop'",
    "",
    "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {",
    "  throw 'Run this in an ADMIN PowerShell — registering a SYSTEM task needs elevation.'",
    "}",
    "",
    `$name = '${name}'`,
    `$runtime = '${opts.runtime}'`,
    `$script = '${opts.scriptPath}'`,
    `$log = "${log}"`,
    "New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null",
    "",
    "# -u forces unbuffered output so the log is useful while the thing is running,",
    "# not only after it exits.",
    "$action = New-ScheduledTaskAction -Execute $runtime -Argument \"-u `\"$script`\"\"",
    "",
    "# AtStartup, NOT AtLogOn: the box must be reachable before anyone logs in.",
    "$trigger = New-ScheduledTaskTrigger -AtStartup",
    "",
    "# S-1-5-18 is SYSTEM. RunLevel Highest so it can actually administer the machine.",
    "$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest",
    "",
    "# A database box is mains-powered and expected to stay up: the battery",
    "# defaults would stop the task on a laptop, which is exactly this hardware.",
    "$settings = New-ScheduledTaskSettingsSet " +
      "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
      "-StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) " +
      "-ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew",
    "",
    "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {",
    "  Unregister-ScheduledTask -TaskName $name -Confirm:$false",
    "}",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger " +
      "-Principal $principal -Settings $settings | Out-Null",
    "Start-ScheduledTask -TaskName $name",
    "",
    `Write-Host 'Installed. Device ${opts.deviceId} will connect at every boot, as SYSTEM.'`,
    "Write-Host \"Log: $log\"",
  ].join("\n");
}

export function windowsUninstallScript(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${name}'`,
    "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {",
    "  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
    "  Unregister-ScheduledTask -TaskName $name -Confirm:$false",
    "  Write-Host 'Removed.'",
    "} else { Write-Host 'Not installed.' }",
  ].join("\n");
}

/**
 * macOS: a LaunchDaemon in /Library/LaunchDaemons — NOT a LaunchAgent.
 *
 * A LaunchAgent runs in a user's GUI session: it does not exist until someone
 * logs in and it dies when they log out. A LaunchDaemon is started by launchd
 * at boot and runs as root.
 */
export function macLaunchDaemonPlist(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  const label = `com.ares.${name.toLowerCase()}`;
  const log = opts.logPath ?? "/var/log/ares-connector.log";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${opts.runtime}</string>`,
    "    <string>-u</string>",
    `    <string>${opts.scriptPath}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <!-- Restart forever: the connector exiting for any reason means the box",
    "       is unreachable, which is the one state it must not sit in. -->",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${log}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${log}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n");
}

export function macInstallScript(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  const label = `com.ares.${name.toLowerCase()}`;
  const plist = `/Library/LaunchDaemons/${label}.plist`;
  return [
    "#!/bin/sh",
    "# Ares remote connector — install as a boot-time root LaunchDaemon.",
    "# Run ONCE with sudo. Read it first.",
    "set -e",
    '[ "$(id -u)" -eq 0 ] || { echo "run with sudo — a LaunchDaemon is root-owned"; exit 1; }',
    `cat > '${plist}' <<'ARES_PLIST'`,
    macLaunchDaemonPlist(opts),
    "ARES_PLIST",
    // launchd refuses to load a daemon that is group- or world-writable.
    `chown root:wheel '${plist}'`,
    `chmod 644 '${plist}'`,
    `launchctl unload '${plist}' 2>/dev/null || true`,
    `launchctl load -w '${plist}'`,
    `echo "Installed. Device ${opts.deviceId} will connect at every boot, as root."`,
  ].join("\n");
}

/**
 * Linux: a SYSTEM unit, not `systemd --user`.
 *
 * A --user unit needs the user's session bus and (without lingering enabled)
 * only exists while they are logged in.
 */
export function linuxSystemdUnit(opts: PersistenceOptions): string {
  return [
    "[Unit]",
    `Description=Ares remote connector (${opts.deviceId})`,
    // Without this the connector races the network at boot, fails its first
    // resolve, and burns backoff before anything could have worked.
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${opts.runtime} -u ${opts.scriptPath}`,
    "Restart=always",
    "RestartSec=5",
    "User=root",
    // The connector has its own backoff; systemd's default start-limit would
    // give up permanently after a few restarts and leave the box unreachable.
    "StartLimitIntervalSec=0",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
}

export function linuxInstallScript(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  const unit = `/etc/systemd/system/${name}.service`;
  return [
    "#!/bin/sh",
    "# Ares remote connector — install as a boot-time root systemd unit.",
    "# Run ONCE with sudo. Read it first.",
    "set -e",
    '[ "$(id -u)" -eq 0 ] || { echo "run with sudo — a system unit is root-owned"; exit 1; }',
    `cat > '${unit}' <<'ARES_UNIT'`,
    linuxSystemdUnit(opts),
    "ARES_UNIT",
    "systemctl daemon-reload",
    `systemctl enable --now '${name}.service'`,
    `echo "Installed. Device ${opts.deviceId} will connect at every boot, as root."`,
  ].join("\n");
}

export function installScriptFor(target: PersistenceTarget, opts: PersistenceOptions): string {
  if (target === "windows") return windowsInstallScript(opts);
  if (target === "macos") return macInstallScript(opts);
  return linuxInstallScript(opts);
}

/** What the owner is actually agreeing to. Shown before the script, every time:
 *  permanent boot-time root on a machine is not a detail to bury in a diff. */
export function persistenceConsentSummary(target: PersistenceTarget, opts: PersistenceOptions): string {
  const who = target === "windows" ? "SYSTEM" : "root";
  const how =
    target === "windows"
      ? `a scheduled task named ${serviceName(opts)}, triggered at startup`
      : target === "macos"
        ? `a LaunchDaemon in /Library/LaunchDaemons`
        : `a systemd unit ${serviceName(opts)}.service`;
  return [
    `This installs ${how}.`,
    `It starts at boot WITHOUT anyone logging in, runs as ${who}, and restarts if it stops.`,
    `From then on Ares can run commands on this machine, elevated, whenever the machine is powered on.`,
    `Undo it with the uninstall script, or by unpairing device ${opts.deviceId} (which revokes the credential immediately).`,
  ].join("\n");
}
