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

/**
 * Which account the connector runs as.
 *
 * - "user"   the owner's own account, elevated. Commands then behave the way
 *            they do when the owner runs them by hand: same profile, same
 *            mapped drives, same PATH, same DPAPI-protected secrets.
 * - "system" the machine account. Maximum local privilege, but a DIFFERENT
 *            user: no user profile, no mapped drives, no user DPAPI. Right for
 *            a headless service, wrong when the point is fidelity.
 *
 * Unix does not need this distinction: the daemon runs as root and root can
 * become the owner trivially (su - owner -c), so it gets both.
 */
export type RunAsAccount = "user" | "system";

/**
 * How Windows logs the task's user on at boot.
 *
 * - "password" full fidelity, including NETWORK credentials. Windows stores the
 *              password in LSA at registration; the owner types it into their
 *              own elevated prompt and it never reaches Ares.
 * - "s4u"      no password stored, but the resulting token has NO network
 *              credentials: shares, DPAPI-protected secrets and anything
 *              needing outbound auth fail in ways that look nothing like what
 *              the owner sees when running the same command by hand.
 */
export type WindowsLogon = "password" | "s4u";

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
  /** Defaults to "user": fidelity beats privilege when the owner asked for
   *  commands that behave the way theirs do. */
  runAs?: RunAsAccount;
  /** Windows only. Defaults to "password" — the only option that keeps network
   *  credentials, which is most of what "run it how I would" means. */
  windowsLogon?: WindowsLogon;
  /** Unix only: the account commands should run as. The daemon itself stays
   *  root (so it can administer the box); this is who `exec` impersonates. */
  runAsUser?: string;
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
 * start"). A boot-triggered task gets what is needed with no wrapper: starts at
 * boot with no login, elevated, restarts on failure.
 *
 * WHICH ACCOUNT is the load-bearing decision. SYSTEM has the most local
 * privilege but is a DIFFERENT USER: no user profile, no mapped drives, no
 * per-user PATH, no access to the owner's DPAPI-protected secrets. A command
 * would then behave differently under Ares than when the owner pastes it by
 * hand -- which is precisely the confusion this feature exists to remove. So
 * the default is the owner's own account at RunLevel Highest: elevated AND
 * faithful.
 *
 * Built from cmdlets rather than task XML on purpose: schtasks /XML wants
 * UTF-16, and getting a BOM wrong here is a trap this codebase has been bitten
 * by more than once.
 */
export function windowsInstallScript(opts: PersistenceOptions): string {
  const name = serviceName(opts);
  const log = opts.logPath ?? "$env:ProgramData\\Ares\\connector.log";
  const runAs = opts.runAs ?? "user";
  const logon = opts.windowsLogon ?? "password";
  const asSystem = runAs === "system";

  const head = [
    `# Ares remote connector -- install as a boot-time task (${asSystem ? "SYSTEM" : "your account, elevated"}).`,
    "# Run this ONCE in an elevated PowerShell. Read it before you do.",
    "$ErrorActionPreference = 'Stop'",
    "",
    "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {",
    "  throw 'Run this in an ADMIN PowerShell -- registering a boot task needs elevation.'",
    "}",
    "",
    `$name = '${name}'`,
    `$runtime = '${opts.runtime}'`,
    `$script = '${opts.scriptPath}'`,
    `$log = "${log}"`,
    "New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null",
    "",
    "# -u forces unbuffered output so the log is useful while the thing is",
    "# running, not only after it exits.",
    "$action = New-ScheduledTaskAction -Execute $runtime -Argument \"-u `\"$script`\"\"",
    "",
    "# AtStartup, NOT AtLogOn: the box must be reachable before anyone logs in.",
    "$trigger = New-ScheduledTaskTrigger -AtStartup",
    "",
    "# A database box is mains-powered and expected to stay up: the battery",
    "# defaults would stop the task on a laptop, which is exactly this hardware.",
    "# ExecutionTimeLimit 0 = never time out; the default would kill it outright.",
    "$settings = New-ScheduledTaskSettingsSet " +
      "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
      "-StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) " +
      "-ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew",
    "",
    "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {",
    "  Unregister-ScheduledTask -TaskName $name -Confirm:$false",
    "}",
    "",
  ];

  const systemTail = [
    "# S-1-5-18 is SYSTEM: maximum local privilege, but NOT your user context.",
    "$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger " +
      "-Principal $principal -Settings $settings | Out-Null",
  ];

  const s4uTail = [
    "# S4U: runs as you at boot with no stored password -- but the token it gets",
    "# has NO NETWORK CREDENTIALS. Mapped drives, UNC paths and anything needing",
    "# outbound auth will fail here while working fine when you run it by hand.",
    "$me = \"$env:USERDOMAIN\\$env:USERNAME\"",
    "$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger " +
      "-Principal $principal -Settings $settings | Out-Null",
  ];

  const passwordTail = [
    "# Runs as YOU, elevated, at boot without login -- the only combination that",
    "# also keeps network credentials, so commands behave the way they do when",
    "# you run them yourself.",
    "#",
    "# Windows stores this password in LSA at registration. You type it into",
    "# your own elevated prompt; Ares never sees it and it is never sent",
    "# anywhere. If this account has no password (or is a Microsoft account",
    "# with none set), use the s4u variant instead and accept the network",
    "# caveat it prints.",
    "$me = \"$env:USERDOMAIN\\$env:USERNAME\"",
    "$cred = Get-Credential -UserName $me -Message 'Password for the account the connector runs as'",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger " +
      "-Settings $settings -User $cred.UserName " +
      "-Password $cred.GetNetworkCredential().Password -RunLevel Highest | Out-Null",
  ];

  const tail = asSystem ? systemTail : logon === "s4u" ? s4uTail : passwordTail;

  return [
    ...head,
    ...tail,
    "Start-ScheduledTask -TaskName $name",
    "",
    `Write-Host 'Installed. Device ${opts.deviceId} connects at every boot, as ` +
      `${asSystem ? "SYSTEM" : "your account"}, elevated.'`,
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
    // root can become the owner trivially, so unix gets privilege AND fidelity;
    // the connector runs a command as the owner via their login shell when the
    // device is configured that way. Windows has no cheap equivalent, which is
    // why it has to choose an account up front.
    `echo "Commands run as root; ARES_RUN_AS=${opts.runAsUser ?? "$SUDO_USER"} makes them run as that user instead."`,
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
  const runAs = opts.runAs ?? "user";
  const logon = opts.windowsLogon ?? "password";
  const who =
    target === "windows"
      ? runAs === "system"
        ? "SYSTEM (the machine account, NOT your user)"
        : "your own account, elevated"
      : "root";
  const how =
    target === "windows"
      ? `a scheduled task named ${serviceName(opts)}, triggered at startup`
      : target === "macos"
        ? "a LaunchDaemon in /Library/LaunchDaemons"
        : `a systemd unit ${serviceName(opts)}.service`;

  const lines = [
    `This installs ${how}.`,
    `It starts at boot WITHOUT anyone logging in, runs as ${who}, and restarts if it stops.`,
    "From then on Ares can run commands on this machine, elevated, whenever the machine is powered on.",
  ];
  if (target === "windows" && runAs === "user" && logon === "password") {
    lines.push(
      "You will be asked for your Windows password. It is stored by Windows in LSA at registration — " +
        "typed into your own elevated prompt, never sent anywhere, and never seen by Ares.",
    );
  }
  if (target === "windows" && runAs === "user" && logon === "s4u") {
    lines.push(
      "No password is stored, but the task's token has NO network credentials: mapped drives and UNC " +
        "paths will fail under Ares while working when you run the same command by hand.",
    );
  }
  if (target === "windows" && runAs === "system") {
    lines.push(
      "SYSTEM is a different user from you: no user profile, no mapped drives, no per-user PATH, and no " +
        "access to your DPAPI-protected secrets. Commands may behave differently than when you run them.",
    );
  }
  lines.push(
    `Undo it with the uninstall script, or by unpairing device ${opts.deviceId} (which revokes the credential immediately).`,
  );
  return lines.join("\n");
}
