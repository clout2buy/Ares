# Run by the NSIS uninstaller (POSTUNINSTALL) to remove the `ares` PATH shim.
# Leaves the user's ~/.ares config + encrypted vault untouched.

[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"

$BinDir = Join-Path $env:LOCALAPPDATA "Ares\bin"
if (Test-Path -LiteralPath $BinDir) { Remove-Item -LiteralPath $BinDir -Recurse -Force }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ -ne "" -and $_ -ne $BinDir })
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
