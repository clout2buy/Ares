// The paired-device connector for Windows.
//
// Pure PowerShell 5.1 / .NET so a machine needs nothing installed — the same
// reason the one-time connector is PowerShell, but this one is built to live
// forever instead of ten minutes:
//
//   * stores a credential and re-authenticates across reboots
//   * finds home again when the address changes (rendezvous ladder)
//   * proves the SERVER is really its owner before obeying anything
//   * never gives up reconnecting
//   * starts exec commands async so a long one doesn't stall the loop
//
// A CORRECTION lives here, learned in a live test. The first cut chased the
// one-time connector's 20s-timeout bug (a long exec starving other requests)
// by polling ReceiveAsync with a 250ms cancellation timeout so it could reap
// finished jobs between frames. But in .NET, CANCELLING a WebSocket ReceiveAsync
// ABORTS the socket -- it cannot be reused -- so the socket died on the first
// idle tick and the connector reconnected forever (30 cycles in the field,
// spamming the owner). The receive is now a BLOCKING ReceiveAsync
// (CancellationToken.None), which keeps the socket healthy. Exec still runs
// async via the Jobs dict, so a long command doesn't block the loop; finished
// jobs are reaped whenever a frame arrives, and the server's 30s heartbeat
// guarantees that happens at least that often even when idle. Full
// fire-and-forget concurrency (a process-exit callback that sends results the
// instant they finish) is the right next step, but it needs real device
// testing before it ships -- stability first.

/**
 * The connector protocol version this build of Ares ships.
 *
 * BUMP THIS whenever DEVICE_PS1 gains or changes an op. Every device reports
 * the version it is running at attach time, so the server can (a) fail a call
 * fast with "that device's connector is too old" instead of hanging until the
 * request times out, and (b) offer the owner a one-click update. A device in
 * the field is only as capable as the script on its disk; the version is how
 * Ares knows which script that is.
 *
 *   1 — exec, input, screenshot, getfile, putfile, notify (v0.51)
 *   2 — + fetch (HTTP from the device's own network position), self-update
 *       with hash verification and on-device rollback, heartbeat file,
 *       explicit "unsupported op" replies instead of silence.
 */
export const DEVICE_CONNECTOR_VERSION = 2;

/** Ops v2 understands. Sent at attach so the server never has to guess. */
export const DEVICE_CONNECTOR_CAPS = [
  "exec", "input", "screenshot", "getfile", "putfile", "notify", "fetch", "update",
] as const;

export interface DeviceConnectorOptions {
  /** Enrollment token — only used on the very first run. */
  token: string;
  /** WebSocket URL to try first; later runs prefer the cached address. */
  wsUrl: string;
  /** HTTP origin of the same server, for the rendezvous ladder. */
  baseUrl: string;
  /** UDP port the owner's discovery responder listens on. */
  discoveryPort: number;
  /** Where the credential and cached address live. */
  stateDir?: string;
}

export const DEFAULT_DEVICE_STATE_DIR = "$env:ProgramData\\Ares\\remote";

export function buildDeviceConnectorPs1(opts: DeviceConnectorOptions): string {
  const stateDir = opts.stateDir ?? DEFAULT_DEVICE_STATE_DIR;
  return DEVICE_PS1.replace(/__ARES_TOKEN__/g, opts.token)
    .replace(/__ARES_WS_URL__/g, opts.wsUrl)
    .replace(/__ARES_BASE_URL__/g, opts.baseUrl)
    .replace(/__ARES_DISCOVERY_PORT__/g, String(opts.discoveryPort))
    .replace(/__ARES_CONNECTOR_VERSION__/g, String(DEVICE_CONNECTOR_VERSION))
    .replace(/__ARES_STATE_DIR__/g, stateDir);
}

/**
 * The elevated PowerShell that updates a v1 connector — one that predates the
 * `update` op and so can only be reached through exec + putfile.
 *
 * Runs through exec_on_pc's `powershell -Command "<this>"`, which escapes
 * double quotes on the way in, so this script uses SINGLE quotes only and
 * spells the relaunch as a file rather than a nested quoted command line.
 * Everything it does, the v2 in-connector path also does: verify the hash,
 * parse before trusting, keep the outgoing script, then restart detached (the
 * restart kills the connector running this, so a child process would die too).
 */
/** A PowerShell single-quoted literal (the only quote style safe in transit). */
function psQuote(line: string): string {
  return `'${line.replace(/'/g, "''")}'`;
}

/**
 * The relaunch-and-verify script the v1 bootstrap leaves behind.
 *
 * v1 connectors have no rollback of their own, and the first push to a machine
 * is exactly the one that cannot be recovered remotely if it fails — so the
 * bootstrap arms the same watchdog the v2 path uses. It works because the
 * script being installed is v2, which writes a heartbeat as soon as it
 * attaches: no fresh heartbeat inside two minutes means the new connector
 * never came home, and the old one goes back.
 */
const V1_WATCHDOG_LINES = [
  "$dir = 'C:\\ProgramData\\Ares\\remote'",
  "$cur = Join-Path $dir 'ares-remote.ps1'",
  "$prev = Join-Path $dir 'ares-remote.prev.ps1'",
  "$hb = Join-Path $dir 'heartbeat.txt'",
  "$log = Join-Path $dir 'update.log'",
  "$mark = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
  "Start-Sleep -Seconds 3",
  "try { Stop-ScheduledTask -TaskName AresRemoteConnector } catch {}",
  "Start-Sleep -Seconds 2",
  "try { Start-ScheduledTask -TaskName AresRemoteConnector } catch {}",
  "$ok = $false",
  "for ($i = 0; $i -lt 120; $i++) { Start-Sleep -Seconds 1; try { $h = Get-Content $hb -Raw | ConvertFrom-Json; if ($h.at -ge $mark) { $ok = $true; break } } catch {} }",
  "if ($ok) { Add-Content -Path $log -Value ((Get-Date -Format u) + ' bootstrap update verified - new connector attached'); exit 0 }",
  "Add-Content -Path $log -Value ((Get-Date -Format u) + ' bootstrap update did not attach in 120s - rolling back')",
  "try { Copy-Item $prev $cur -Force } catch {}",
  "try { Stop-ScheduledTask -TaskName AresRemoteConnector } catch {}",
  "Start-Sleep -Seconds 2",
  "try { Start-ScheduledTask -TaskName AresRemoteConnector } catch {}",
];

export function buildV1UpdateScript(sha256: string, stateDir = "C:\\ProgramData\\Ares\\remote"): string {
  return [
    "$ErrorActionPreference='Stop'",
    `$dir='${stateDir}'`,
    "$new=Join-Path $dir 'ares-remote.new.ps1'",
    "$cur=Join-Path $dir 'ares-remote.ps1'",
    "$prev=Join-Path $dir 'ares-remote.prev.ps1'",
    `$want='${sha256}'`,
    "$got=(Get-FileHash $new -Algorithm SHA256).Hash.ToLower()",
    "if ($got -ne $want) { throw ('hash mismatch: ' + $got) }",
    "$text=[IO.File]::ReadAllText($new)",
    "[void][ScriptBlock]::Create($text)",
    "if ($text -notmatch 'Ares Remote') { throw 'not an Ares connector' }",
    "if (Test-Path $cur) { Copy-Item $cur $prev -Force }",
    "Copy-Item $new $cur -Force",
    "Remove-Item $new -Force -ErrorAction SilentlyContinue",
    "$relaunchFile=Join-Path $dir 'ares-relaunch.ps1'",
    `$lines=@(${V1_WATCHDOG_LINES.map(psQuote).join(", ")})`,
    "Set-Content -Path $relaunchFile -Value $lines -Encoding UTF8",
    "$ps=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$relaunchFile)",
    "Write-Output 'staged'",
  ].join("; ");
}

const DEVICE_PS1 = String.raw`
# Ares Remote — paired device connector.
# Installed to run at boot. Keep it running; it reconnects on its own.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$StateDir  = "__ARES_STATE_DIR__"
$CredFile  = Join-Path $StateDir 'device.json'
$Token     = '__ARES_TOKEN__'
$SeedWs    = '__ARES_WS_URL__'
$SeedBase  = '__ARES_BASE_URL__'
$DiscoPort = __ARES_DISCOVERY_PORT__
$ConnectorVersion = __ARES_CONNECTOR_VERSION__
$TaskName  = 'AresRemoteConnector'

# Where this script lives, so it can replace itself. $PSCommandPath is the file
# the task actually launched — never assume the conventional path, because a
# hand-installed connector may live somewhere else entirely.
$SelfPath  = $PSCommandPath
if (-not $SelfPath) { $SelfPath = Join-Path $StateDir 'ares-remote.ps1' }
$HeartFile = Join-Path $StateDir 'heartbeat.txt'
$PrevFile  = Join-Path $StateDir 'ares-remote.prev.ps1'

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }

function Write-Log([string]$m) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
}

# Proof of life on DISK, not just on the wire. An update's rollback watchdog
# runs in a separate process with no socket of its own, so this file is the
# only way it can tell "the new connector came up and attached" from "the new
# connector is broken and nothing is talking to home any more".
function Write-Heartbeat {
  try {
    $payload = @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); version = $ConnectorVersion; pid = $PID } | ConvertTo-Json -Compress
    Set-Content -Path $HeartFile -Value $payload -Encoding UTF8 -Force
  } catch { }
}

# ─── crypto: HMAC-SHA256, direction-bound (see remoteDeviceCrypto.ts) ───────
function Get-Proof([string]$Key, [string]$Nonce, [string]$Label) {
  $h = New-Object System.Security.Cryptography.HMACSHA256
  $h.Key = [Text.Encoding]::UTF8.GetBytes($Key)
  # Concatenated rather than interpolated, and the reason is a trap worth
  # naming: this script lives inside a String.raw template literal. Backticks
  # terminate it, and dollar-brace is still expanded by JS even in String.raw.
  # So neither PowerShell escaping spelling can appear anywhere in this file --
  # not in code, and not in a comment either. Concatenation survives both.
  $mac = $h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Label + ':' + $Nonce))
  $h.Dispose()
  return (($mac | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-Nonce {
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b) -replace '\+','-' -replace '/','_' -replace '=','')
}

# Constant-time-ish compare. PowerShell string equality is short-circuiting, so
# compare every character: this guards a proof, and a timing oracle on it is a
# way to forge one.
function Test-ProofEqual([string]$A, [string]$B) {
  if ($null -eq $A -or $null -eq $B) { return $false }
  if ($A.Length -ne $B.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $A.Length; $i++) { $diff = $diff -bor ([int][char]$A[$i] -bxor [int][char]$B[$i]) }
  return ($diff -eq 0)
}

# ─── credential storage ────────────────────────────────────────────────────
function Get-Credential-Stored {
  if (-not (Test-Path $CredFile)) { return $null }
  try { return (Get-Content $CredFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Save-Credential($Cred) {
  $tmp = "$CredFile.tmp"
  $Cred | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force $tmp $CredFile
  # The credential is a permanent elevated key to this machine: keep it to
  # Administrators + SYSTEM rather than whatever the parent directory allows.
  try {
    $acl = Get-Acl $CredFile
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
    foreach ($who in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow')))
    }
    Set-Acl -Path $CredFile -AclObject $acl
  } catch { Write-Log "warning: could not tighten permissions on the credential file" }
}

# ─── rendezvous ladder ─────────────────────────────────────────────────────
# A permanently installed connector cannot have an address baked in: a quick
# tunnel returns on a new random hostname every restart and a LAN IP moves on
# DHCP. Cheapest rung first.
function Find-Home($Cred) {
  $candidates = @()
  if ($Cred -and $Cred.lastWsUrl) { $candidates += $Cred.lastWsUrl }   # 1. last known good

  # 2. LAN discovery. Probe EVERY interface's broadcast address: the global
  #    255.255.255.255 leaves via one interface of the kernel's choosing, and a
  #    box with VirtualBox/Hyper-V/WSL adapters has several that face nothing.
  if ($Cred -and $Cred.deviceId) {
    try {
      $probe = [Text.Encoding]::UTF8.GetBytes((@{ magic = 'ares-remote-discover/1'; deviceId = $Cred.deviceId } | ConvertTo-Json -Compress))
      $udp = New-Object Net.Sockets.UdpClient
      $udp.EnableBroadcast = $true
      $udp.Client.ReceiveTimeout = 1500
      $targets = @('255.255.255.255')
      foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($n.OperationalStatus -ne 'Up') { continue }
        foreach ($a in $n.GetIPProperties().UnicastAddresses) {
          if ($a.Address.AddressFamily -ne 'InterNetwork') { continue }
          if ($a.Address.ToString().StartsWith('127.')) { continue }
          try {
            $ipb = $a.Address.GetAddressBytes()
            $mb = $a.IPv4Mask.GetAddressBytes()
            $bc = 0..3 | ForEach-Object { $ipb[$_] -bor (255 -bxor $mb[$_]) }
            $targets += ($bc -join '.')
          } catch { }
        }
      }
      foreach ($t in ($targets | Select-Object -Unique)) {
        try { [void]$udp.Send($probe, $probe.Length, $t, $DiscoPort) } catch { }
      }
      $ep = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
      try {
        $raw = $udp.Receive([ref]$ep)
        $ans = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
        if ($ans.magic -eq 'ares-remote-here/1' -and $ans.baseUrl) {
          $candidates += (($ans.baseUrl -replace '^http', 'ws') + '/ws')
        }
      } catch { }
      $udp.Close()
    } catch { }
  }

  $candidates += (($SeedBase -replace '^http', 'ws') + '/ws')   # 3. the address we were installed with
  if ($SeedWs) { $candidates += $SeedWs }
  return ($candidates | Where-Object { $_ } | Select-Object -Unique)
}

# ─── websocket helpers ─────────────────────────────────────────────────────
function Send-Json($Ws, $Obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Compress -Depth 10))
  $seg = [ArraySegment[byte]]::new($bytes)
  $Ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

# BLOCKING receive. A hard-won correction: the first cut cancelled ReceiveAsync
# on a 250ms timer to poll for finished jobs, but in .NET cancelling a WebSocket
# ReceiveAsync ABORTS the socket -- it cannot be reused. So the socket died on
# the first idle tick, the loop exited, and the connector reconnected forever
# (30 reconnect cycles in a field test, spamming the owner's notifications).
# ReceiveAsync with CancellationToken.None blocks until a frame arrives and
# leaves the socket healthy. The server's 30s heartbeat guarantees the loop
# wakes at least that often even when idle, which is when finished jobs are
# reaped. A long exec no longer starves the loop because exec runs async (the
# Jobs dict) -- we start it and return to the receive immediately.
function Receive-Json($Ws) {
  $buf = New-Object byte[] 65536
  $ms = New-Object IO.MemoryStream
  try {
    do {
      $seg = [ArraySegment[byte]]::new($buf)
      $r = $Ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($r.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { return 'CLOSED' }
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
  } catch {
    return 'CLOSED'
  }
  if ($ms.Length -eq 0) { return $null }
  try { return ([Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json) } catch { return $null }
}

# Timed receive for the HANDSHAKE only. Here aborting the socket on timeout is
# fine: a handshake that stalls means the server is wrong or gone, and we tear
# the socket down and reconnect anyway -- so the abort that breaks the steady
# state is harmless during setup.
function Receive-JsonTimeout($Ws, [int]$TimeoutMs) {
  $cts = New-Object Threading.CancellationTokenSource($TimeoutMs)
  $buf = New-Object byte[] 65536
  $ms = New-Object IO.MemoryStream
  try {
    do {
      $seg = [ArraySegment[byte]]::new($buf)
      $r = $Ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
      if ($r.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { return 'CLOSED' }
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
  } catch {
    return 'CLOSED'
  } finally { $cts.Dispose() }
  if ($ms.Length -eq 0) { return $null }
  try { return ([Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json) } catch { return $null }
}

# ─── concurrent command execution ──────────────────────────────────────────
# Each exec is a Process started and then LEFT ALONE. The loop sweeps for
# finished ones. Nothing blocks the receive path, so a slow command can no
# longer starve a screenshot or a file read.
$script:Jobs = @{}

function Start-Exec([string]$ReqId, [string]$Command, [int]$TimeoutMs, [string]$Shell) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  # cmd (default) or powershell. PowerShell lets Ares run real cmdlets remotely
  # (Get-Service, Get-Process, etc.) instead of only cmd builtins, and removes
  # the shell-dialect guessing that produced pasted-cmd-into-PowerShell errors.
  if ($Shell -eq 'powershell') {
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' + '"' + ($Command -replace '"', '\"') + '"'
  } else {
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/d /s /c "' + $Command + '"'
  }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $p = New-Object Diagnostics.Process
  $p.StartInfo = $psi
  try { [void]$p.Start() } catch {
    return @{ done = $true; output = "Could not start: $($_.Exception.Message)"; exitCode = -1 }
  }
  # Read both pipes asynchronously from the start: a command that fills the
  # stderr buffer deadlocks if nobody is draining it.
  $script:Jobs[$ReqId] = @{
    proc = $p
    out = $p.StandardOutput.ReadToEndAsync()
    err = $p.StandardError.ReadToEndAsync()
    deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $TimeoutMs))
  }
  return $null
}

function Reap-Jobs($Ws) {
  if ($script:Jobs.Count -eq 0) { return }
  foreach ($reqId in @($script:Jobs.Keys)) {
    $j = $script:Jobs[$reqId]
    $timedOut = (Get-Date) -gt $j.deadline
    if ($j.proc.HasExited -or $timedOut) {
      if ($timedOut -and -not $j.proc.HasExited) {
        try { $j.proc.Kill() } catch { }
        Send-Json $Ws @{ type = 'exec_result'; reqId = $reqId; output = 'Command timed out.'; exitCode = -1 }
      } else {
        $out = ''
        try { $out = $j.out.Result + $j.err.Result } catch { }
        Send-Json $Ws @{ type = 'exec_result'; reqId = $reqId; output = [string]$out; exitCode = [int]$j.proc.ExitCode }
      }
      try { $j.proc.Dispose() } catch { }
      $script:Jobs.Remove($reqId)
    }
  }
}

# ─── input injection (mouse + keyboard) ────────────────────────────────────
# The remote mirror of AgentComputer: Ares can now DRIVE the desktop, not just
# see it. Uses user32 SetCursorPos + mouse_event (simpler and multi-monitor-safe
# in raw pixels, no SendInput normalization) and WinForms SendKeys for text.
# The C# is a single-quoted here-string so nothing in it is expanded, and it
# contains no backtick or dollar-brace (which would break the generating template).
$script:InputReady = $false
function Ensure-Input {
  if ($script:InputReady) { return $true }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    if (-not ([System.Management.Automation.PSTypeName]'AresInput').Type) {
      Add-Type -Namespace '' -Name 'AresInput' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.IntPtr dwExtraInfo);
'@ -ErrorAction Stop
    }
    $script:InputReady = $true
    return $true
  } catch {
    return $false
  }
}

function Invoke-Input($cmd) {
  # Session 0 has NO DESKTOP. A boot-triggered task runs there even as the right
  # user, so SetCursorPos succeeds and moves nothing — the worst possible
  # outcome, an ok:true that did not happen. Refuse loudly instead, and say what
  # to change (an AtLogOn/Interactive task runs in the real desktop session).
  if (-not [Environment]::UserInteractive) {
    return @{ ok = $false; error = 'no interactive desktop: this connector is running in Windows session 0 (a boot task), where no screen or cursor exists. Re-install it as an interactive (AtLogOn) task to control the GUI.' }
  }
  if (-not (Ensure-Input)) { return @{ ok = $false; error = 'input injection unavailable on this desktop' } }
  $LEFTDOWN = 0x0002; $LEFTUP = 0x0004; $RIGHTDOWN = 0x0008; $RIGHTUP = 0x0010
  $MIDDLEDOWN = 0x0020; $MIDDLEUP = 0x0040; $WHEEL = 0x0800
  try {
    switch ([string]$cmd.kind) {
      'move'  { [void][AresInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y) }
      'click' {
        [void][AresInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
        Start-Sleep -Milliseconds 20
        $btn = [string]$cmd.button
        if ($btn -eq 'right') { [AresInput]::mouse_event($RIGHTDOWN,0,0,0,[IntPtr]::Zero); [AresInput]::mouse_event($RIGHTUP,0,0,0,[IntPtr]::Zero) }
        elseif ($btn -eq 'middle') { [AresInput]::mouse_event($MIDDLEDOWN,0,0,0,[IntPtr]::Zero); [AresInput]::mouse_event($MIDDLEUP,0,0,0,[IntPtr]::Zero) }
        else {
          [AresInput]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); [AresInput]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero)
          if ($cmd.double) { Start-Sleep -Milliseconds 40; [AresInput]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); [AresInput]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero) }
        }
      }
      'drag'  {
        [void][AresInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y); Start-Sleep -Milliseconds 30
        [AresInput]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40
        [void][AresInput]::SetCursorPos([int]$cmd.x2, [int]$cmd.y2); Start-Sleep -Milliseconds 40
        [AresInput]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero)
      }
      'scroll' { $amt = if ($cmd.amount) { [int]$cmd.amount } else { 120 }; [AresInput]::mouse_event($WHEEL,0,0,$amt,[IntPtr]::Zero) }
      'type'  { [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$cmd.text))) }
      'key'   { [System.Windows.Forms.SendKeys]::SendWait([string]$cmd.keys) }  # SendKeys notation, e.g. {ENTER} ^c %{F4}
      default { return @{ ok = $false; error = 'unknown input kind: ' + [string]$cmd.kind } }
    }
    return @{ ok = $true }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

# Literal text must not be read as SendKeys control chars (+ ^ % ~ ( ) { } [ ]).
function Escape-SendKeys([string]$t) {
  if ($null -eq $t) { return '' }
  $sb = New-Object Text.StringBuilder
  foreach ($ch in $t.ToCharArray()) {
    if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$sb.Append('{').Append($ch).Append('}') }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

# ─── screen capture ────────────────────────────────────────────────────────
function Get-ScreenPng {
  # Same session-0 trap as input: CopyFromScreen in session 0 returns a black
  # rectangle rather than failing, so a caller would "see" a screen that is not
  # the user's. Say so instead of shipping a convincing lie.
  if (-not [Environment]::UserInteractive) {
    return @{ ok = $false; error = 'no interactive desktop: this connector runs in Windows session 0 (a boot task), so there is no screen to capture. Re-install it as an interactive (AtLogOn) task to see the desktop.' }
  }
  try {
    Add-Type -AssemblyName System.Drawing, System.Windows.Forms -ErrorAction Stop
    $b = [Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object Drawing.Bitmap($b.Width, $b.Height)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $data = [Convert]::ToBase64String($ms.ToArray())
    $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
    return @{ ok = $true; data = $data }
  } catch {
    # Running at boot with no interactive desktop is the usual cause — there is
    # genuinely nothing to photograph until someone logs in.
    return @{ ok = $false; error = "screen capture unavailable: $($_.Exception.Message)" }
  }
}

# ─── HTTP from HERE ────────────────────────────────────────────────────────
# The single most useful thing a remote machine can do that its owner cannot:
# reach the services bound to ITS localhost. A dashboard on 127.0.0.1:8090, a
# Docker socket proxy, an internal host behind this machine's VPN — all of it
# is one hop away from the connector and unreachable from the owner's desk.
#
# Async, through a Tasks table reaped by the main loop, for the same reason
# exec is: a 30s fetch must not stall heartbeats and starve every other
# request. HttpClient's default completion option buffers the whole body, so
# one completed task is a finished response — no second blocking read.
$script:Fetches = @{}

function Start-Fetch([string]$ReqId, $cmd) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    try { $handler.UseCookies = $false } catch { }
    $client = New-Object Net.Http.HttpClient($handler)
    $ms = if ($cmd.timeoutMs) { [int]$cmd.timeoutMs } else { 30000 }
    $client.Timeout = [TimeSpan]::FromMilliseconds([Math]::Max(1000, $ms))
    $method = New-Object Net.Http.HttpMethod(([string]$cmd.method).ToUpper())
    $req = New-Object Net.Http.HttpRequestMessage($method, [string]$cmd.url)
    if ($cmd.bodyBase64) {
      $bytes = [Convert]::FromBase64String([string]$cmd.bodyBase64)
      $req.Content = New-Object Net.Http.ByteArrayContent(@(,$bytes))
    }
    if ($cmd.headers) {
      foreach ($p in $cmd.headers.PSObject.Properties) {
        $name = [string]$p.Name; $value = [string]$p.Value
        # Content-* headers belong to the body, not the request, and .NET
        # refuses them on the wrong collection rather than ignoring them.
        if ($name -match '^(?i)content-') {
          if ($null -eq $req.Content) { $req.Content = New-Object Net.Http.ByteArrayContent(@(,([byte[]]@()))) }
          try { [void]$req.Content.Headers.TryAddWithoutValidation($name, $value) } catch { }
        } else {
          try { [void]$req.Headers.TryAddWithoutValidation($name, $value) } catch { }
        }
      }
    }
    $script:Fetches[$ReqId] = @{
      task = $client.SendAsync($req)
      client = $client
      deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $ms) + 5000)
    }
    return $null
  } catch {
    return @{ error = $_.Exception.Message }
  }
}

function Reap-Fetches($Ws) {
  if ($script:Fetches.Count -eq 0) { return }
  foreach ($reqId in @($script:Fetches.Keys)) {
    $f = $script:Fetches[$reqId]
    $timedOut = (Get-Date) -gt $f.deadline
    if (-not ($f.task.IsCompleted -or $timedOut)) { continue }
    try {
      if ($timedOut -and -not $f.task.IsCompleted) {
        Send-Json $Ws @{ type = 'fetch_result'; reqId = $reqId; error = 'request timed out' }
      } elseif ($f.task.IsFaulted) {
        $ex = $f.task.Exception
        $m = if ($ex -and $ex.GetBaseException()) { $ex.GetBaseException().Message } else { 'request failed' }
        Send-Json $Ws @{ type = 'fetch_result'; reqId = $reqId; error = [string]$m }
      } else {
        $resp = $f.task.Result
        $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $hdrs = @{}
        foreach ($h in $resp.Headers) { $hdrs[$h.Key] = ($h.Value -join ', ') }
        foreach ($h in $resp.Content.Headers) { $hdrs[$h.Key] = ($h.Value -join ', ') }
        Send-Json $Ws @{
          type = 'fetch_result'; reqId = $reqId
          status = [int]$resp.StatusCode
          headers = $hdrs
          dataBase64 = [Convert]::ToBase64String($bytes)
          size = $bytes.Length
        }
        try { $resp.Dispose() } catch { }
      }
    } catch {
      Send-Json $Ws @{ type = 'fetch_result'; reqId = $reqId; error = $_.Exception.Message }
    }
    try { $f.client.Dispose() } catch { }
    $script:Fetches.Remove($reqId)
  }
}

# ─── self-update ───────────────────────────────────────────────────────────
# Ares can replace THIS SCRIPT with a newer one, so a capability gap in the
# field is a push away instead of a re-install. Three things make that safe
# enough to do to a machine you cannot walk over to:
#
#   1. The bytes are verified against a SHA-256 the server sent separately,
#      and parsed (never executed) before they are allowed to become the
#      connector. A truncated transfer cannot brick the device.
#   2. The outgoing script is kept as ares-remote.prev.ps1.
#   3. A WATCHDOG is armed BEFORE the swap, in its own process. It restarts the
#      task, then waits for the new connector to write a fresh heartbeat. If
#      that never lands, it puts the previous script back and restarts again.
#      The rollback has to live on the device: if the new script cannot attach,
#      there is no channel left for the owner to fix it through.
function Invoke-SelfUpdate($cmd) {
  try {
    if (-not $cmd.scriptBase64) { return @{ ok = $false; error = 'no script in update' } }
    $bytes = [Convert]::FromBase64String([string]$cmd.scriptBase64)
    if ($bytes.Length -lt 4000) { return @{ ok = $false; error = 'refusing update: script is implausibly small (' + $bytes.Length + ' bytes)' } }

    $sha = [Security.Cryptography.SHA256]::Create()
    $got = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    $sha.Dispose()
    $want = ([string]$cmd.sha256).ToLower()
    if ($want -and $got -ne $want) { return @{ ok = $false; error = 'refusing update: hash mismatch (got ' + $got + ')' } }

    $newFile = Join-Path $StateDir 'ares-remote.new.ps1'
    [IO.File]::WriteAllBytes($newFile, $bytes)

    # Parse, do not run. [ScriptBlock]::Create compiles and throws on a syntax
    # error without executing a single statement.
    $text = [IO.File]::ReadAllText($newFile)
    try { [void][ScriptBlock]::Create($text) }
    catch { return @{ ok = $false; error = 'refusing update: new script does not parse (' + $_.Exception.Message + ')' } }
    if ($text -notmatch 'Ares Remote') { return @{ ok = $false; error = 'refusing update: this does not look like an Ares connector' } }

    Copy-Item -Path $SelfPath -Destination $PrevFile -Force

    # Arm the watchdog before swapping, so a crash between here and the restart
    # still gets rolled back.
    $wd = Join-Path $StateDir 'ares-update-watchdog.ps1'
    $wdBody = @'
param([string]$StateDir, [string]$SelfPath, [string]$PrevFile, [string]$HeartFile, [string]$TaskName, [int]$OldPid)
$ErrorActionPreference = 'SilentlyContinue'
function Log([string]$m) { Add-Content -Path (Join-Path $StateDir 'update.log') -Value ((Get-Date -Format 'u') + ' ' + $m) }
function Restart-Connector {
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; return $true } catch { }
  try {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', $SelfPath) -WindowStyle Hidden
    return $true
  } catch { return $false }
}
# Let the outgoing process finish exiting; the task will not start a second
# instance while the first is still running.
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}
$mark = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Log ('restarting connector after update (old pid ' + $OldPid + ')')
[void](Restart-Connector)
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Get-Content $HeartFile -Raw | ConvertFrom-Json
    if ($h.at -ge $mark) { $ok = $true; break }
  } catch { }
}
if ($ok) { Log 'update verified: new connector attached'; exit 0 }
Log 'update FAILED to attach within 120s - rolling back'
try {
  Copy-Item -Path $PrevFile -Destination $SelfPath -Force
  Get-Process -Id $OldPid -ErrorAction SilentlyContinue | Out-Null
  [void](Restart-Connector)
  Log 'rolled back to previous connector'
} catch { Log ('rollback failed: ' + $_.Exception.Message) }
'@
    Set-Content -Path $wd -Value $wdBody -Encoding UTF8 -Force

    Copy-Item -Path $newFile -Destination $SelfPath -Force
    Remove-Item -Path $newFile -Force -ErrorAction SilentlyContinue

    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', $wd,
      '-StateDir', $StateDir, '-SelfPath', $SelfPath, '-PrevFile', $PrevFile,
      '-HeartFile', $HeartFile, '-TaskName', $TaskName, '-OldPid', $PID
    )
    return @{ ok = $true; version = [int]$cmd.version; path = $SelfPath }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

# ─── the connection ────────────────────────────────────────────────────────
function Connect-Once($Cred, [string]$WsUrl) {
  $ws = New-Object Net.WebSockets.ClientWebSocket
  $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  try {
    $ws.ConnectAsync([Uri]$WsUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  } catch {
    try { $ws.Dispose() } catch { }
    return @{ ok = $false; retry = $true }
  }

  try {
    if (-not $Cred) {
      # First run: trade the one-time link for a permanent credential.
      Send-Json $ws @{
        type = 'enroll'; token = $Token
        hostname = $env:COMPUTERNAME; os = 'Windows'; username = $env:USERNAME
        elevated = (Test-IsElevated)
        connectorVersion = $ConnectorVersion
      }
      $reply = Receive-JsonTimeout $ws 30000
      if ($null -eq $reply -or $reply -eq 'CLOSED' -or $reply.type -ne 'enrolled') {
        $why = if ($reply -and $reply.message) { $reply.message } else { 'no response' }
        Write-Log "pairing failed: $why"
        try { $ws.Dispose() } catch { }
        # A refused pairing link never becomes valid by waiting.
        return @{ ok = $false; retry = $false }
      }
      $Cred = [pscustomobject]@{
        deviceId = $reply.deviceId; deviceSecret = $reply.deviceSecret
        serverKey = $reply.serverKey; name = $reply.name; lastWsUrl = $WsUrl
      }
      Save-Credential $Cred
      Write-Log "paired as '$($reply.name)'"
    } else {
      # Every later run: mutual proof. We verify the SERVER before obeying it.
      $myNonce = New-Nonce
      Send-Json $ws @{ type = 'device_hello'; deviceId = $Cred.deviceId; nonce = $myNonce }
      $sp = Receive-JsonTimeout $ws 30000
      if ($null -eq $sp -or $sp -eq 'CLOSED') { try { $ws.Dispose() } catch { }; return @{ ok = $false; retry = $true } }
      if ($sp.type -ne 'server_proof') {
        Write-Log "refused: $($sp.message)"
        try { $ws.Dispose() } catch { }
        return @{ ok = $false; retry = (-not $sp.fatal) }
      }
      $expect = Get-Proof $Cred.serverKey $myNonce 'server'
      if (-not (Test-ProofEqual $expect $sp.proof)) {
        # Something answered that is NOT our owner. Do not authenticate to it,
        # and do not run anything it says. On an elevated connector this check
        # is the difference between a service and a remote root shell.
        Write-Log 'SERVER PROOF FAILED — refusing to attach'
        try { $ws.Dispose() } catch { }
        return @{ ok = $false; retry = $true }
      }
      Send-Json $ws @{ type = 'device_auth'; proof = (Get-Proof $Cred.deviceSecret $sp.nonce 'device'); connectorVersion = $ConnectorVersion; username = $env:USERNAME }
      $ready = Receive-JsonTimeout $ws 30000
      if ($null -eq $ready -or $ready -eq 'CLOSED' -or $ready.type -ne 'device_ready') {
        $why = if ($ready -and $ready.message) { $ready.message } else { 'no response' }
        Write-Log "attach refused: $why"
        try { $ws.Dispose() } catch { }
        return @{ ok = $false; retry = (-not ($ready -and $ready.fatal)) }
      }
      if ($Cred.lastWsUrl -ne $WsUrl) {
        $Cred | Add-Member -NotePropertyName lastWsUrl -NotePropertyValue $WsUrl -Force
        Save-Credential $Cred
      }
      Write-Log "attached as '$($ready.name)'"
    }
    # Attached: from here the update watchdog can see this connector is alive.
    Write-Heartbeat

    # ── event loop ──
    # Receive with a short timeout, then sweep finished commands. Neither half
    # can starve the other, which is the whole fix.
    while ($ws.State -eq 'Open') {
      $cmd = Receive-Json $ws
      if ($cmd -eq 'CLOSED') { break }
      if ($null -ne $cmd) {
        switch ($cmd.type) {
          'ping' { Send-Json $ws @{ type = 'pong' }; Write-Heartbeat }
          'exec' {
            $t = if ($cmd.timeoutMs) { [int]$cmd.timeoutMs } else { 30000 }
            $immediate = Start-Exec ([string]$cmd.reqId) ([string]$cmd.command) $t ([string]$cmd.shell)
            if ($immediate) {
              Send-Json $ws @{ type = 'exec_result'; reqId = $cmd.reqId; output = $immediate.output; exitCode = $immediate.exitCode }
            }
          }
          'input' {
            $r = Invoke-Input $cmd
            if ($r.ok) { Send-Json $ws @{ type = 'input_result'; reqId = $cmd.reqId; ok = $true } }
            else { Send-Json $ws @{ type = 'input_result'; reqId = $cmd.reqId; ok = $false; error = $r.error } }
          }
          'screenshot' {
            $shot = Get-ScreenPng
            if ($shot.ok) { Send-Json $ws @{ type = 'screenshot_result'; reqId = $cmd.reqId; dataBase64 = $shot.data } }
            else { Send-Json $ws @{ type = 'screenshot_result'; reqId = $cmd.reqId; error = $shot.error } }
          }
          'getfile' {
            try {
              $bytes = [IO.File]::ReadAllBytes($cmd.path)
              Send-Json $ws @{ type = 'getfile_result'; reqId = $cmd.reqId; dataBase64 = [Convert]::ToBase64String($bytes); size = $bytes.Length }
            } catch { Send-Json $ws @{ type = 'getfile_result'; reqId = $cmd.reqId; error = $_.Exception.Message } }
          }
          'putfile' {
            try {
              $dir = Split-Path $cmd.path
              if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
              [IO.File]::WriteAllBytes($cmd.path, [Convert]::FromBase64String($cmd.dataBase64))
              Send-Json $ws @{ type = 'putfile_result'; reqId = $cmd.reqId; bytes = ([Convert]::FromBase64String($cmd.dataBase64)).Length }
            } catch { Send-Json $ws @{ type = 'putfile_result'; reqId = $cmd.reqId; error = $_.Exception.Message } }
          }
          'fetch' {
            $err = Start-Fetch ([string]$cmd.reqId) $cmd
            if ($err) { Send-Json $ws @{ type = 'fetch_result'; reqId = $cmd.reqId; error = $err.error } }
          }
          'update' {
            $r = Invoke-SelfUpdate $cmd
            Send-Json $ws @{ type = 'update_result'; reqId = $cmd.reqId; ok = $r.ok; error = $r.error; version = $r.version; path = $r.path }
            if ($r.ok) {
              # The watchdog owns the restart from here. Exit cleanly so the
              # task is free to start the new script; if it never attaches, the
              # watchdog puts the old one back.
              Write-Log ('updated to connector v' + [string]$cmd.version + ' - restarting')
              Start-Sleep -Milliseconds 400
              try { $ws.Dispose() } catch { }
              exit 0
            }
          }
          'bye' { Write-Log 'owner closed the link'; try { $ws.Dispose() } catch { }; return @{ ok = $true; retry = $true } }
          default {
            # Silence here reads as a hung device. Name the gap instead: the
            # owner's Ares is newer than this script, and can push the fix.
            if ($cmd.reqId) {
              Send-Json $ws @{
                type = ([string]$cmd.type + '_result'); reqId = $cmd.reqId
                error = ("this device's connector (v" + $ConnectorVersion + ") does not support '" + [string]$cmd.type + "' - update it with RemotePC update_agent")
              }
            }
          }
        }
      }
      Reap-Jobs $ws
      Reap-Fetches $ws
    }
  } catch {
    Write-Log "connection error: $($_.Exception.Message)"
  }
  try { $ws.Dispose() } catch { }
  return @{ ok = $true; retry = $true }
}

function Test-IsElevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# ─── forever ───────────────────────────────────────────────────────────────
# No deadline. The one-time connector gives up after 12 hours, which is correct
# for helping a friend once and wrong for a machine the owner expects to be
# reachable whenever it is powered on.
Write-Log "Ares Remote v$ConnectorVersion starting (elevated=$(Test-IsElevated)) from $SelfPath"
$backoff = 2
while ($true) {
  $cred = Get-Credential-Stored
  $tried = $false
  foreach ($url in (Find-Home $cred)) {
    $tried = $true
    Write-Log "connecting: $url"
    $r = Connect-Once $cred $url
    if (-not $r.retry) { Write-Log 'stopping (refused permanently)'; exit 1 }
    if ($r.ok) { $backoff = 2; break }
  }
  if (-not $tried) { Write-Log 'no address to try' }
  # Jitter so a fleet of devices coming back from a network outage does not
  # arrive in lockstep.
  $sleep = [Math]::Min(60, $backoff) + (Get-Random -Minimum 0 -Maximum 3)
  Write-Log ('reconnecting in ' + $sleep + 's')
  Start-Sleep -Seconds $sleep
  $backoff = [Math]::Min(60, $backoff * 2)
}
`;
