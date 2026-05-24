[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command = "chat",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest = @()
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Args)
    & pnpm @Args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Ensure-NodeModules {
    if (!(Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
        Invoke-Pnpm install
    }
}

function Invoke-CrixTs {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Args)
    Ensure-NodeModules
    Invoke-Pnpm --silent build
    & node "packages\cli\dist\entry.js" @Args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Show-Help {
    Ensure-NodeModules
    Invoke-Pnpm --silent build
    & node "packages\cli\dist\entry.js" help
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ""
    Write-Host "Launcher examples:"
    Write-Host "  .\crix.bat"
    Write-Host "  .\crix.bat doctor"
    Write-Host "  .\crix.bat login"
    Write-Host "  .\crix.bat game"
    Write-Host "  .\crix.bat run --provider openai --model gpt-5.5 --goal ""flex some tools"""
    Write-Host ""
}

function Open-MarioGame {
    $Game = Join-Path $Root "demos\mario-game.html"
    if (!(Test-Path -LiteralPath $Game)) {
        Write-Error "Mario game not found at $Game"
        exit 1
    }
    Start-Process -FilePath $Game
    Write-Host "Opened $Game"
}

switch ($Command.ToLowerInvariant()) {
    "" { Invoke-CrixTs chat @Rest }
    "chat" { Invoke-CrixTs chat @Rest }
    "cli" { Invoke-CrixTs chat @Rest }
    "shell" { Invoke-CrixTs chat @Rest }
    "help" { Show-Help }
    "h" { Show-Help }
    "--help" { Show-Help }
    "-h" { Show-Help }
    "login" { Invoke-CrixTs login @Rest }
    "install" { Invoke-Pnpm install }
    "build" { Ensure-NodeModules; Invoke-Pnpm build }
    "check" { Ensure-NodeModules; Invoke-Pnpm check }
    "test" { Ensure-NodeModules; Invoke-Pnpm test }
    "verify" { Ensure-NodeModules; Invoke-Pnpm verify }
    "game" { Open-MarioGame }
    "doctor" { Invoke-CrixTs doctor @Rest }
    "run" { Invoke-CrixTs run @Rest }
    "mock" { Invoke-CrixTs run --provider mock --goal (($Rest -join " ").Trim()) }
    "openai" { Invoke-CrixTs run --provider openai @Rest }
    "ollama" { Invoke-CrixTs run --provider ollama @Rest }
    "--" { Invoke-CrixTs @Rest }
    default { Invoke-CrixTs $Command @Rest }
}

