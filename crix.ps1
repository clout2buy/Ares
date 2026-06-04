[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command = "launcher",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest = @()
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CallerCwd = if ($env:CRIX_CALLER_CWD) { $env:CRIX_CALLER_CWD } else { (Get-Location).Path }
Set-Location $Root

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::Title = "Crix Provider Launcher"
} catch {
    # Host does not expose a real console. Keep going.
}

$script:Esc = [char]27

function Color {
    param(
        [string] $Text,
        [string] $Code
    )
    if ($env:NO_COLOR) { return $Text }
    return "$($script:Esc)[$Code`m$Text$($script:Esc)[0m"
}

function Terminal-Width {
    try {
        return [Math]::Max(84, [Math]::Min([Console]::WindowWidth, 120))
    } catch {
        return 100
    }
}

function Write-Rule {
    param([string] $Code = "90")
    Write-Host (Color ("-" * (Terminal-Width)) $Code)
}

function Write-CrixBanner {
    Clear-Host
    $folder = Split-Path -Leaf $Root
    $themeName = if ($env:CRIX_THEME) { $env:CRIX_THEME } else { "amber" }
    Write-Host ""
    Write-Host (Color "  CRIX" "96") -NoNewline
    Write-Host (Color "  provider launch deck" "97")
    Write-Host (Color "  GPT OAuth + Ollama Cloud model picker" "90")
    Write-Host (Color "  workspace: $Root" "90")
    Write-Rule "34"
    Write-Host (Color "  Mode" "96") -NoNewline
    Write-Host "  choose a provider, pick a model, drop straight into the full terminal UI."
    Write-Host (Color "  Theme" "96") -NoNewline
    Write-Host " $themeName  " -NoNewline
    Write-Host (Color "Project" "96") -NoNewline
    Write-Host " $folder"
    Write-Rule "34"
    Write-Host ""
}

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

function Add-WorkspaceArg {
    param([string[]] $Args)
    if (($Args -contains "--workspace") -or ($Args -contains "--cwd")) {
        return $Args
    }
    return @("--workspace", $CallerCwd) + $Args
}

function Invoke-CrixWorkspace {
    param(
        [string] $Subcommand,
        [string[]] $Args = @()
    )
    $WithWorkspace = Add-WorkspaceArg $Args
    Invoke-CrixTs $Subcommand @WithWorkspace
}

function Show-Help {
    Ensure-NodeModules
    Invoke-Pnpm --silent build
    & node "packages\cli\dist\entry.js" help
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ""
    Write-Host "Launcher examples:"
    Write-Host "  .\crix.bat"
    Write-Host "  .\crix.bat launcher"
    Write-Host "  .\crix.bat chat --provider openai --model gpt-5.5"
    Write-Host "  .\crix.bat chat --provider ollama --model qwen3-coder:480b-cloud"
    Write-Host "  .\crix.bat doctor"
    Write-Host "  .\crix.bat login"
    Write-Host "  .\crix.bat run --provider openai --model gpt-5.5 --goal ""flex some tools"""
    Write-Host ""
}

function Read-MenuChoice {
    param(
        [string] $Prompt,
        [string[]] $Allowed,
        [string] $Default = ""
    )
    while ($true) {
        $suffix = if ($Default) { " [$Default]" } else { "" }
        $raw = Read-Host "$(Color $Prompt "96")$suffix"
        if ([string]::IsNullOrWhiteSpace($raw) -and $Default) {
            return $Default
        }
        $choice = $raw.Trim().ToLowerInvariant()
        if ($Allowed -contains $choice) {
            return $choice
        }
        Write-Host (Color "  Pick one of: $($Allowed -join ', ')" "91")
    }
}

function Format-OllamaModelName {
    param([string] $Id)
    $name = $Id -replace "-cloud$", ""
    $name = $name -replace ":cloud$", ""
    $name = $name -replace ":", " "
    return $name
}

function Get-OllamaModelGroup {
    param([string] $Id)
    if ($Id -match "qwen3-coder|qwen3-next|qwen3\.5|devstral|glm-|deepseek|kimi-|minimax|gpt-oss:120b|nemotron-3-super|cogito") {
        return "engineering"
    }
    if ($Id -match "gemma|gemini|qwen3-vl|mistral|ministral") {
        return "multimodal"
    }
    if ($Id -match "20b|14b|12b|8b|4b|3b|nano|rnj") {
        return "fast"
    }
    return "general"
}

function Get-OllamaCloudModels {
    $catalogPath = Join-Path $Root "packages\core\src\providers\ollamaCloud.ts"
    $ids = @()
    if (Test-Path -LiteralPath $catalogPath) {
        $text = Get-Content -Raw -LiteralPath $catalogPath
        $start = $text.IndexOf("export const OLLAMA_CLOUD_MODELS")
        $end = $text.IndexOf("/** Sub-list filtered", [Math]::Max(0, $start))
        if ($start -ge 0 -and $end -gt $start) {
            $catalogText = $text.Substring($start, $end - $start)
            $ids = [regex]::Matches($catalogText, 'id:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
        }
    }
    if (-not $ids -or $ids.Count -eq 0) {
        $ids = @(
            "qwen3-coder:480b-cloud",
            "qwen3-coder-next:cloud",
            "qwen3.5:397b-cloud",
            "qwen3.5:cloud",
            "qwen3-next:80b-cloud",
            "deepseek-v4-pro:cloud",
            "deepseek-v4-flash:cloud",
            "deepseek-v3.2:cloud",
            "deepseek-v3.1:671b-cloud",
            "glm-5.1:cloud",
            "glm-5:cloud",
            "glm-4.7:cloud",
            "glm-4.6:cloud",
            "kimi-k2.6:cloud",
            "kimi-k2.5:cloud",
            "kimi-k2:1t-cloud",
            "kimi-k2-thinking:cloud",
            "minimax-m2.7:cloud",
            "minimax-m2.5:cloud",
            "minimax-m2.1:cloud",
            "minimax-m2:cloud",
            "gpt-oss:120b-cloud",
            "gpt-oss:20b-cloud",
            "devstral-2:123b-cloud",
            "devstral-small-2:24b-cloud",
            "mistral-large-3:675b-cloud",
            "gemini-3-flash-preview:cloud",
            "gemma4:31b-cloud",
            "gemma3:27b-cloud",
            "gemma3:12b-cloud",
            "gemma3:4b-cloud",
            "qwen3-vl:235b-cloud",
            "qwen3-vl:235b-instruct-cloud",
            "ministral-3:14b-cloud",
            "ministral-3:8b-cloud",
            "ministral-3:3b-cloud",
            "nemotron-3-super:cloud",
            "nemotron-3-nano:30b-cloud",
            "cogito-2.1:671b-cloud",
            "rnj-1:8b-cloud"
        )
    }

    $seen = @{}
    $models = @()
    foreach ($id in $ids) {
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $models += [pscustomobject]@{
            Id = $id
            Name = Format-OllamaModelName $id
            Group = Get-OllamaModelGroup $id
        }
    }
    return $models
}

function Start-CrixChat {
    param(
        [string] $Provider,
        [string] $Model
    )
    if (-not $env:CRIX_THEME) {
        $env:CRIX_THEME = "amber"
    }
    Clear-Host
    Write-Host (Color "Starting Crix" "96") -NoNewline
    Write-Host " with " -NoNewline
    Write-Host (Color $Provider "97") -NoNewline
    Write-Host " / " -NoNewline
    Write-Host (Color $Model "92")
    Write-Host (Color "Building once, then opening the terminal UI..." "90")
    Write-Host ""
    Invoke-CrixTs chat --provider $Provider --model $Model --theme $env:CRIX_THEME
}

function Show-GptPicker {
    while ($true) {
        Write-CrixBanner
        $defaultModel = if ($env:CRIX_OPENAI_MODEL) { $env:CRIX_OPENAI_MODEL } else { "gpt-5.5" }
        $models = @($defaultModel, "gpt-5.5") | Select-Object -Unique
        Write-Host (Color "GPT OAuth" "95")
        Write-Host (Color "Uses your ChatGPT OAuth login through the OpenAI Responses backend." "90")
        Write-Host ""
        for ($i = 0; $i -lt $models.Count; $i++) {
            $n = $i + 1
            Write-Host ("  [{0}] " -f $n) -NoNewline
            Write-Host (Color $models[$i] "97") -NoNewline
            if ($i -eq 0) { Write-Host (Color "  default" "90") } else { Write-Host "" }
        }
        $customChoice = $models.Count + 1
        Write-Host ("  [{0}] " -f $customChoice) -NoNewline
        Write-Host (Color "custom model" "96")
        Write-Host "  [b] back"
        Write-Host "  [q] quit"
        Write-Host ""

        $allowed = @()
        for ($i = 1; $i -le $models.Count + 1; $i++) { $allowed += "$i" }
        $allowed += @("b", "q")
        $choice = Read-MenuChoice "Choose GPT OAuth model" $allowed "1"
        if ($choice -eq "b") { return }
        if ($choice -eq "q") { exit 0 }
        if ([int]$choice -eq $customChoice) {
            $custom = (Read-Host "$(Color "Model id" "96")").Trim()
            if ($custom) {
                Start-CrixChat "openai" $custom
                return
            }
            continue
        }
        Start-CrixChat "openai" $models[[int]$choice - 1]
        return
    }
}

function Show-OllamaPicker {
    $models = Get-OllamaCloudModels
    while ($true) {
        Write-CrixBanner
        Write-Host (Color "Ollama Cloud" "92")
        Write-Host (Color "Clean names shown here; Crix launches the full cloud tag under the hood." "90")
        Write-Host ""

        $indexed = @()
        $i = 1
        foreach ($group in @("engineering", "multimodal", "fast", "general")) {
            $items = @($models | Where-Object { $_.Group -eq $group })
            if ($items.Count -eq 0) { continue }
            Write-Host (Color ("  " + $group.ToUpperInvariant()) "94")
            foreach ($m in $items) {
                $key = "{0:d2}" -f $i
                $indexed += [pscustomobject]@{ Key = $key; Model = $m }
                Write-Host ("    [{0}] " -f $key) -NoNewline
                Write-Host (Color $m.Name "97")
                $i++
            }
            Write-Host ""
        }

        Write-Host "  [c] custom Ollama model id"
        Write-Host "  [b] back"
        Write-Host "  [q] quit"
        Write-Host ""

        $allowed = @($indexed | ForEach-Object { $_.Key }) + @("c", "b", "q")
        $choice = Read-MenuChoice "Choose Ollama Cloud model" $allowed "01"
        if ($choice -eq "b") { return }
        if ($choice -eq "q") { exit 0 }
        if ($choice -eq "c") {
            $custom = (Read-Host "$(Color "Ollama model id" "96")").Trim()
            if ($custom) {
                Start-CrixChat "ollama" $custom
                return
            }
            continue
        }
        $selected = $indexed | Where-Object { $_.Key -eq $choice } | Select-Object -First 1
        if ($selected) {
            Start-CrixChat "ollama" $selected.Model.Id
            return
        }
    }
}

function Show-CrixLauncher {
    while ($true) {
        Write-CrixBanner
        Write-Host "  [1] " -NoNewline
        Write-Host (Color "GPT OAuth" "95") -NoNewline
        Write-Host "       ChatGPT OAuth provider, OpenAI Responses backend"
        Write-Host "  [2] " -NoNewline
        Write-Host (Color "Ollama Cloud" "92") -NoNewline
        Write-Host "    Pick from every current cloud model in the Ollama catalog"
        Write-Host "  [3] " -NoNewline
        Write-Host (Color "Login GPT OAuth" "96") -NoNewline
        Write-Host "  Device-code login"
        Write-Host "  [4] " -NoNewline
        Write-Host (Color "Doctor" "93") -NoNewline
        Write-Host "           Provider health and model slot check"
        Write-Host "  [5] " -NoNewline
        Write-Host (Color "Help" "97")
        Write-Host "  [q] Quit"
        Write-Host ""

        $choice = Read-MenuChoice "Choose provider" @("1", "2", "3", "4", "5", "q") "2"
        switch ($choice) {
            "1" { Show-GptPicker }
            "2" { Show-OllamaPicker }
            "3" { Invoke-CrixTs login; Read-Host "Press Enter to return" | Out-Null }
            "4" { Invoke-CrixTs doctor; Read-Host "Press Enter to return" | Out-Null }
            "5" { Show-Help; Read-Host "Press Enter to return" | Out-Null }
            "q" { return }
        }
    }
}

function Has-ProviderFlags {
    param([string[]] $Args)
    return ($Args -contains "--provider") -or ($Args -contains "--model") -or ($Args.Count -gt 0)
}

switch ($Command.ToLowerInvariant()) {
    "" { Invoke-CrixWorkspace launcher $Rest }
    "launcher" { Invoke-CrixWorkspace launcher $Rest }
    "menu" { Invoke-CrixWorkspace launcher $Rest }
    "chat" {
        if (Has-ProviderFlags $Rest) { Invoke-CrixWorkspace chat $Rest } else { Invoke-CrixWorkspace launcher $Rest }
    }
    "cli" {
        if (Has-ProviderFlags $Rest) { Invoke-CrixWorkspace chat $Rest } else { Invoke-CrixWorkspace launcher $Rest }
    }
    "shell" {
        if (Has-ProviderFlags $Rest) { Invoke-CrixWorkspace chat $Rest } else { Invoke-CrixWorkspace launcher $Rest }
    }
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
    "doctor" { Invoke-CrixWorkspace doctor $Rest }
    "run" { Invoke-CrixWorkspace run $Rest }
    "mock" { $WithWorkspace = Add-WorkspaceArg @("--goal", (($Rest -join " ").Trim())); Invoke-CrixTs run --provider mock @WithWorkspace }
    "openai" { $WithWorkspace = Add-WorkspaceArg $Rest; Invoke-CrixTs run --provider openai @WithWorkspace }
    "ollama" { $WithWorkspace = Add-WorkspaceArg $Rest; Invoke-CrixTs run --provider ollama @WithWorkspace }
    "--" { Invoke-CrixTs @Rest }
    default { Invoke-CrixWorkspace $Command $Rest }
}
