# Run by the NSIS installer (POSTINSTALL) to put `ares` on the user's PATH using
# the self-contained runtime that ships inside the .exe — no system Node, no repo.
# The desktop app and this CLI share the same agent + encrypted ~/.ares vault.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $InstallDir
)

$ErrorActionPreference = "Stop"

$node = Join-Path $InstallDir "runtime\bin\node.exe"
$cli  = Join-Path $InstallDir "runtime\cli\ares-cli.mjs"
$BinDir = Join-Path $env:LOCALAPPDATA "Ares\bin"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
# Shim points at the bundled node + bundled CLI (absolute paths, fully portable).
Set-Content -Path (Join-Path $BinDir "ares.cmd") -Encoding ascii -Force `
    -Value "@`"$node`" `"$cli`" %*"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ -ne "" })
if ($parts -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $BinDir) -join ";"), "User")
}
