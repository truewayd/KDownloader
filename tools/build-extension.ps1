param(
  [string]$OutputDirectory = "dist/KDownloader"
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "dist"))
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}

$distPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputPath.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be inside $distRoot"
}

$runtimePaths = @(
  "_locales",
  "background",
  "content",
  "icons",
  "injected",
  "popup",
  "shared",
  "content.css",
  "manifest.json",
  "settings.css",
  "settings.html",
  "settings.js"
)

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

foreach ($runtimePath in $runtimePaths) {
  $sourcePath = Join-Path $repoRoot $runtimePath
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing runtime path: $runtimePath"
  }

  $files = if ((Get-Item -LiteralPath $sourcePath).PSIsContainer) {
    Get-ChildItem -LiteralPath $sourcePath -Recurse -File
  } else {
    Get-Item -LiteralPath $sourcePath
  }

  foreach ($file in $files) {
    $relativePath = [System.IO.Path]::GetRelativePath($repoRoot, $file.FullName)
    $parts = $relativePath -split '[\\/]'
    $hasReservedPart = $parts | Where-Object { $_ -like '_*' -and $_ -ne '_locales' }
    $isPythonArtifact = $file.Extension -in @('.py', '.pyc', '.pyo')
    if ($hasReservedPart -or $isPythonArtifact) {
      continue
    }

    $destination = Join-Path $outputPath $relativePath
    $destinationDirectory = Split-Path $destination -Parent
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }
}

$forbidden = Get-ChildItem -LiteralPath $outputPath -Recurse -Force | Where-Object {
  ($_.Name -like '_*' -and $_.Name -ne '_locales') -or
  (-not $_.PSIsContainer -and $_.Extension -in @('.py', '.pyc', '.pyo'))
}
if ($forbidden) {
  throw "Build output contains a reserved or Python temporary path: $($forbidden[0].FullName)"
}
if (-not (Test-Path -LiteralPath (Join-Path $outputPath "manifest.json"))) {
  throw "Build output is missing manifest.json"
}

Write-Output $outputPath
