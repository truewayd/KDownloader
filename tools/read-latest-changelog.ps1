param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("KDownloader", "TrueDown")]
  [string]$Product,
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

$productDirectoryName = $Product.ToLowerInvariant()
$productDirectoryPath = Join-Path $directoryPath $productDirectoryName
if (-not (Test-Path -LiteralPath $productDirectoryPath -PathType Container)) {
  throw "$Product changelog directory does not exist: $productDirectoryPath"
}

$latest = Get-ChildItem -LiteralPath $productDirectoryPath -File -Filter "*.md" |
  Where-Object {
    $_.BaseName -match "^\d{4}-\d{2}-\d{2}-\d{3}-.+"
  } |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $latest) {
  throw "No dated $Product changelog file found in $productDirectoryPath"
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
