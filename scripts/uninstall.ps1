# Ares CLI uninstaller — removes the `ares` shims and the PATH entry that
# install.ps1 added. Leaves your ~/.ares vault/config untouched.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$BinDir = Join-Path $env:LOCALAPPDATA "Ares\bin"

if (Test-Path -LiteralPath $BinDir) {
    Remove-Item -LiteralPath $BinDir -Recurse -Force
    Write-Host "  removed shims: $BinDir" -ForegroundColor Green
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ -ne "" -and $_ -ne $BinDir })
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
Write-Host "  removed from user PATH: $BinDir" -ForegroundColor Green
Write-Host "  (your ~/.ares config + vault were left intact)" -ForegroundColor DarkGray
