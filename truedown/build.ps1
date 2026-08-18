param(
  [string]$OutputDirectory = "dist/TrueDown"
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$dist = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$exe = Join-Path $dist "TrueDown.exe"
$aria = Join-Path $projectRoot "aria2\aria2c.exe"

New-Item -ItemType Directory -Force -Path $dist | Out-Null

Write-Host "Building..."
Push-Location $projectRoot
try {
  go build -o $exe .
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item -Force $aria "$dist\aria2c.exe"
Copy-Item -Force (Join-Path $projectRoot "THIRD_PARTY_NOTICES.md") "$dist\THIRD_PARTY_NOTICES.md"
Write-Host "Build OK -> $dist\"
