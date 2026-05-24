$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = Join-Path $Root "src\main\java"
$Out = Join-Path $Root "build\classes"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Files = @(Get-ChildItem -LiteralPath $Src -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($Files.Count -eq 0) { throw "No Java files found" }
& javac -source 8 -target 8 -encoding UTF-8 -d $Out $Files
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Java worker built: $Out"
