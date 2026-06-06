$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$venvPython = Join-Path $root ".crix\voice-venv\Scripts\python.exe"
$python = if (Test-Path $venvPython) { $venvPython } else { "python" }

Push-Location $root
try {
  & $python "voice_service\server.py" @args
} finally {
  Pop-Location
}
