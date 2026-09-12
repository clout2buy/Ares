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
    .replace(/__ARES_STATE_DIR__/g, stateDir);
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

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }

function Write-Log([string]$m) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
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
      Send-Json $ws @{ type = 'device_auth'; proof = (Get-Proof $Cred.deviceSecret $sp.nonce 'device') }
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

    # ── event loop ──
    # Receive with a short timeout, then sweep finished commands. Neither half
    # can starve the other, which is the whole fix.
    while ($ws.State -eq 'Open') {
      $cmd = Receive-Json $ws
      if ($cmd -eq 'CLOSED') { break }
      if ($null -ne $cmd) {
        switch ($cmd.type) {
          'ping' { Send-Json $ws @{ type = 'pong' } }
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
          'bye' { Write-Log 'owner closed the link'; try { $ws.Dispose() } catch { }; return @{ ok = $true; retry = $true } }
        }
      }
      Reap-Jobs $ws
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
Write-Log "Ares Remote starting (elevated=$(Test-IsElevated))"
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
