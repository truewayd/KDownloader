param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("KDownloader", "TrueDown")]
  [string]$Product,
  [string]$ChangelogDirectory = "changelog",
  [string]$OutputFile = "release-notes.md"
)

$ErrorActionPreference = "Stop"

function Assert-NoReparseTraversal([string]$Path, [string]$Label) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $current = $root
  foreach ($segment in $fullPath.Substring($root.Length) -split '[\\/]') {
    if (-not $segment) { continue }
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) { break }
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not traverse a symbolic link or junction: $current"
    }
  }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$directoryPath = if ([System.IO.Path]::IsPathRooted($ChangelogDirectory)) {
  [System.IO.Path]::GetFullPath($ChangelogDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ChangelogDirectory))
}

Assert-NoReparseTraversal $directoryPath "Changelog directory"
if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
  throw "Changelog directory does not exist: $directoryPath"
}

$productDirectoryName = $Product.ToLowerInvariant()
$productDirectoryPath = Join-Path $directoryPath $productDirectoryName
Assert-NoReparseTraversal $productDirectoryPath "$Product changelog directory"
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
Assert-NoReparseTraversal $latest.FullName "$Product changelog file"

$outputPath = if ([System.IO.Path]::IsPathRooted($OutputFile)) {
  [System.IO.Path]::GetFullPath($OutputFile)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputFile))
}

$outputDirectory = Split-Path -Parent $outputPath
Assert-NoReparseTraversal $outputDirectory "Release-notes output directory"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Assert-NoReparseTraversal $outputDirectory "Release-notes output directory"
if (Test-Path -LiteralPath $outputPath) {
  Assert-NoReparseTraversal $outputPath "Release-notes output"
}
Copy-Item -LiteralPath $latest.FullName -Destination $outputPath -Force
Write-Output $latest.FullName
