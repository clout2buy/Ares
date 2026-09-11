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
//   * runs commands CONCURRENTLY
//
// That last one is a bug fix, not a nicety. The one-time connector's loop is
// `recv -> handle -> recv`, strictly sequential, so while a 30-second exec runs
// every other request sits unserviced in the socket buffer while the server's
// own timers expire. In the field that produced a run of failures at 20.6s,
// 20.3s, 20.6s — the screenshot timeout — and the diagnosis "reads time out,
// writes land". Here the receive loop never blocks on work: commands are
// started, tracked, and reaped as they finish.
//
// PowerShell 5.1 has no async/await and runspace pools are a large amount of
// fragile machinery for this, so the loop is an explicit event loop: a receive
// with a short timeout, then a sweep of in-flight processes. Same effect, far
// less to go wrong.

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

# Receive with a TIMEOUT. This is what makes the loop non-blocking: the old
# connector blocked forever here, which is why a long exec starved every other
# request until the server timed it out.
function Receive-Json($Ws, [int]$TimeoutMs) {
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
  } catch [OperationCanceledException] {
    return $null                      # nothing waiting — normal, not an error
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

function Start-Exec([string]$ReqId, [string]$Command, [int]$TimeoutMs) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/d /s /c "' + $Command + '"'
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

# ─── screen capture ────────────────────────────────────────────────────────
function Get-ScreenPng {
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
      $reply = Receive-Json $ws 30000
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
      $sp = Receive-Json $ws 30000
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
      $ready = Receive-Json $ws 30000
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
      $cmd = Receive-Json $ws 250
      if ($cmd -eq 'CLOSED') { break }
      if ($null -ne $cmd) {
        switch ($cmd.type) {
          'ping' { Send-Json $ws @{ type = 'pong' } }
          'exec' {
            $t = if ($cmd.timeoutMs) { [int]$cmd.timeoutMs } else { 30000 }
            $immediate = Start-Exec ([string]$cmd.reqId) ([string]$cmd.command) $t
            if ($immediate) {
              Send-Json $ws @{ type = 'exec_result'; reqId = $cmd.reqId; output = $immediate.output; exitCode = $immediate.exitCode }
            }
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
