param(
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedManifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  Join-Path $repoRoot "manifest.json"
} elseif ([System.IO.Path]::IsPathRooted($ManifestPath)) {
  [System.IO.Path]::GetFullPath($ManifestPath)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ManifestPath))
}

if (-not (Test-Path -LiteralPath $resolvedManifestPath -PathType Leaf)) {
  throw "Extension manifest does not exist: $resolvedManifestPath"
}

$manifestItem = Get-Item -LiteralPath $resolvedManifestPath -Force
if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Extension manifest must not be a symbolic link or reparse point: $resolvedManifestPath"
}

try {
  $manifest = Get-Content -LiteralPath $resolvedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  throw "Extension manifest is not valid JSON: $($_.Exception.Message)"
}

$version = if ($null -eq $manifest.version) { "" } else { [string]$manifest.version }
if ($version -notmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$') {
  throw "KDownloader version must use exactly MAJOR.MINOR.PATCH with numeric Chrome-compatible components"
}

$components = @($version.Split('.') | ForEach-Object { [int]$_ })
if (($components | Where-Object { $_ -gt 65535 }).Count -gt 0) {
  throw "KDownloader version components must not exceed 65535"
}
if (($components | Measure-Object -Sum).Sum -eq 0) {
  throw "KDownloader version must not be all zero"
}

Write-Output $version
