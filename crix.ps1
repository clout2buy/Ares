[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command = "cli",

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
    Invoke-Pnpm build
    & node "packages\cli\dist\index.js" @Args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Show-Help {
    Write-Host "Crix TypeScript runner"
    Write-Host ""
    Write-Host "Use from D:\Crix:"
    Write-Host "  .\crix.bat            Launch interactive TUI with provider/model picker"
    Write-Host "  .\launch-crix.bat     Double-click launcher for the interactive TUI"
    Write-Host "  .\crix.bat help       Show commands"
    Write-Host "  .\crix.bat dry        Dry-run the sample plan"
    Write-Host "  .\crix.bat apply      Apply the sample plan"
    Write-Host "  .\crix.bat test       Run TypeScript tests"
    Write-Host "  .\crix.bat check      Type-check packages"
    Write-Host "  .\crix.bat verify     Full TS + Java verification"
    Write-Host "  .\crix.bat java       Build/probe Java worker"
    Write-Host "  .\crix.bat login      OpenAI ChatGPT OAuth device-code login"
    Write-Host "  .\crix.bat ollama use kimi-k2.6:cloud  Pick Ollama Cloud model"
    Write-Host "  .\crix.bat ollama models               Show Ollama Cloud suggestions"
    Write-Host "  .\crix.bat upgrade    Run a generic project-improvement goal"
    Write-Host "  .\crix.bat ask ""text"" Ask GPT from the CLI"
    Write-Host "  .\crix.bat prompt --summary  Inspect prompt pack"
    Write-Host "  .\crix.bat tools             Inspect functional tool catalog"
    Write-Host "  .\crix.bat tool run read_file --path README.md"
    Write-Host "  .\crix.bat skills --full     Inspect skill processes"
    Write-Host "  .\crix.bat memory add ""text"" --tag tag"
    Write-Host "  .\crix.bat doctor     Show runtime/provider status"
    Write-Host ""
}

switch ($Command.ToLowerInvariant()) {
    "" { Show-Help }
    "help" { Show-Help }
    "h" { Show-Help }
    "login" { Invoke-CrixTs login @Rest }
    "logout" { Invoke-CrixTs logout @Rest }
    "status" { Invoke-CrixTs status @Rest }
    "upgrade" { Invoke-CrixTs upgrade @Rest }
    "install" { Invoke-Pnpm install }
    "build" { Ensure-NodeModules; Invoke-Pnpm build }
    "check" { Ensure-NodeModules; Invoke-Pnpm check }
    "test" { Ensure-NodeModules; Invoke-Pnpm test }
    "verify" { Ensure-NodeModules; Invoke-Pnpm verify }
    "java" { Ensure-NodeModules; Invoke-Pnpm "java:build"; Invoke-CrixTs java @Rest }
    "dry" { Invoke-CrixTs dry @Rest }
    "apply" { Invoke-CrixTs apply @Rest }
    "doctor" { Invoke-CrixTs doctor @Rest }
    "inspect" { Invoke-CrixTs inspect @Rest }
    "memory" { Invoke-CrixTs memory @Rest }
    "auth" { Invoke-CrixTs auth @Rest }
    "ollama" { Invoke-CrixTs ollama @Rest }
    "ask" { Invoke-CrixTs ask @Rest }
    "prompt" { Invoke-CrixTs prompt @Rest }
    "tools" { Invoke-CrixTs tools @Rest }
    "tool" { Invoke-CrixTs tool @Rest }
    "skills" { Invoke-CrixTs skills @Rest }
    "plan" { Invoke-CrixTs plan @Rest }
    "rollback" { Invoke-CrixTs rollback @Rest }
    "--" { Invoke-CrixTs @Rest }
    default { Invoke-CrixTs $Command @Rest }
}

