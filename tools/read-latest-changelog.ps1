param(
  [string]$ChangelogDirectory = "changelog",
  [string]$OutputFile = "release-notes.md"
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$directoryPath = if ([System.IO.Path]::IsPathRooted($ChangelogDirectory)) {
  [System.IO.Path]::GetFullPath($ChangelogDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ChangelogDirectory))
}

if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
  throw "Changelog directory does not exist: $directoryPath"
}

$latest = Get-ChildItem -LiteralPath $directoryPath -File -Filter "*.md" |
  Where-Object {
    $_.Name -notin @("README.md", "CHANGELOG.md") -and
    $_.BaseName -match "^\d{4}-\d{2}-\d{2}-\d{3}-"
  } |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $latest) {
  throw "No dated changelog file found in $directoryPath"
}

$outputPath = if ([System.IO.Path]::IsPathRooted($OutputFile)) {
  [System.IO.Path]::GetFullPath($OutputFile)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputFile))
}

$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Copy-Item -LiteralPath $latest.FullName -Destination $outputPath -Force
Write-Output $latest.FullName
