param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourcePath = Join-Path $repoRoot "shared\components.js"
$targetPath = Join-Path $repoRoot "truedown\web\components.js"

foreach ($path in @($sourcePath, $targetPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    if ($path -eq $targetPath -and -not $Check) { continue }
    throw "Missing UI component file: $path"
  }
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "UI component file must not be a reparse point: $path"
  }
}

if ($Check) {
  $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
  $targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
  if ($sourceHash -ne $targetHash) {
    throw "TrueDown UI component mirror is stale. Run npm run ui:sync."
  }
  Write-Output $sourceHash.ToLowerInvariant()
  exit 0
}

[System.IO.File]::WriteAllBytes($targetPath, [System.IO.File]::ReadAllBytes($sourcePath))
Write-Output $targetPath
