# Ares CLI installer (from source) — puts `ares` on your PATH for PowerShell/cmd.
#
#   pnpm install ; pnpm run install:cli      (or)      .\scripts\install.ps1
#
# Builds if needed, drops launcher shims in %LOCALAPPDATA%\Ares\bin, and adds that
# dir to the *user* PATH (idempotent). After this, `ares` works in any NEW shell —
# same agent, same encrypted vault as the Tauri desktop app. Run uninstall.ps1 to
# undo. The packaged .exe does the equivalent via its bundled runtime (no Node or
# repo needed); this script is the from-source path for developers.

[CmdletBinding()]
param(
    # Don't build even if dist looks stale (use what's there).
    [switch] $NoBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Entry = Join-Path $Root "packages\cli\dist\entry.js"
$BinDir = Join-Path $env:LOCALAPPDATA "Ares\bin"

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "  Ares CLI installer" -ForegroundColor White
Write-Host "  workspace: $Root" -ForegroundColor DarkGray
Write-Host ""

# 1. Make sure the CLI is built.
if (-not $NoBuild -and -not (Test-Path -LiteralPath $Entry)) {
    Write-Step "Building the CLI (pnpm build)..."
    if (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
        & pnpm --dir $Root install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    }
    & pnpm --dir $Root build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
}
if (-not (Test-Path -LiteralPath $Entry)) {
    throw "CLI not built: $Entry not found. Run 'pnpm build' first (or omit -NoBuild)."
}

# 2. Resolve node (the shims call it by name; verify it's reachable now).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found on PATH. Install Node 22+ and re-run." }
Write-Ok "node: $($node.Source)"

# 3. Drop launcher shims (cmd for PowerShell/cmd, bash for git-bash).
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Set-Content -Path (Join-Path $BinDir "ares.cmd") -Encoding ascii -Force `
    -Value "@node `"$Entry`" %*"
Set-Content -Path (Join-Path $BinDir "ares") -Encoding ascii -Force `
    -Value "#!/usr/bin/env bash`nexec node `"$Entry`" `"`$@`""
Write-Ok "shims: $BinDir\ares.cmd"

# 4. Add bin dir to the user PATH (idempotent).
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ -ne "" })
if ($parts -notcontains $BinDir) {
    $newPath = (($parts + $BinDir) -join ";")
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Ok "added to user PATH: $BinDir"
} else {
    Write-Ok "already on user PATH: $BinDir"
}
# Make it usable in THIS session too.
if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

# 5. Clean up any stale hand-made shims from the pnpm global dir (one source of truth).
$pnpmDir = Join-Path $env:LOCALAPPDATA "pnpm"
foreach ($stale in @("ares", "ares.cmd", "ares.ps1")) {
    $p = Join-Path $pnpmDir $stale
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Step "removed stale shim: $p" }
}

Write-Host ""
Write-Ok "Done. Open a NEW terminal and run:  ares"
Write-Host "  Then just say: connect telegram" -ForegroundColor DarkGray
Write-Host ""
