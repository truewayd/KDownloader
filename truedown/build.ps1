param(
  [string]$OutputDirectory = "dist/TrueDown",
  [string]$Version = "dev",
  [long]$BuildNumber = 0,
  [string]$Commit = "unknown"
)

$ErrorActionPreference = "Stop"
if ($Version -notmatch '^(dev|truedown-build-[1-9][0-9]*)$') {
  throw "Version must be dev or truedown-build-N"
}
if ($BuildNumber -lt 0) {
  throw "BuildNumber must not be negative"
}
if ($Version -ne "dev" -and $Version -ne "truedown-build-$BuildNumber") {
  throw "Version and BuildNumber must identify the same release"
}
if ($Commit -notmatch '^(unknown|[0-9a-fA-F]{7,40})$') {
  throw "Commit must be unknown or a 7-40 character Git commit"
}
$projectRoot = $PSScriptRoot
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist"))
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $projectRoot $OutputDirectory
}
$dist = [System.IO.Path]::GetFullPath($outputPath)
$distPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $dist.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be inside $distRoot"
}
$exe = Join-Path $dist "TrueDown.exe"
$aria = Join-Path $projectRoot "aria2\aria2c.exe"

if (Test-Path -LiteralPath $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Write-Host "Building..."
Push-Location $projectRoot
try {
  $ldflags = "-s -w -X main.version=$Version -X main.buildNumber=$BuildNumber -X main.commit=$Commit"
  go build -trimpath -ldflags $ldflags -o $exe .
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item -Force $aria "$dist\aria2c.exe"
Copy-Item -Force (Join-Path $projectRoot "ARIA2_COPYING") "$dist\ARIA2_COPYING"
Copy-Item -Force (Join-Path $projectRoot "THIRD_PARTY_NOTICES.md") "$dist\THIRD_PARTY_NOTICES.md"
Write-Host "Build OK -> $dist\"
