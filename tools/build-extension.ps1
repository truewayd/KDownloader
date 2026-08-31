param(
  [string]$OutputDirectory = "dist/KDownloader",
  [Nullable[int]]$BuildNumber = $null
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$versionReader = Join-Path $PSScriptRoot "read-extension-version.ps1"
$baseVersion = & $versionReader -ManifestPath (Join-Path $repoRoot "manifest.json")
if ($baseVersion -is [array] -or [string]::IsNullOrWhiteSpace([string]$baseVersion)) {
  throw "Unable to determine one KDownloader product version"
}
$baseVersion = [string]$baseVersion
if ($null -ne $BuildNumber -and ($BuildNumber -lt 1 -or $BuildNumber -gt 65535)) {
  throw "BuildNumber must be between 1 and 65535"
}
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

function Test-ReparsePoint {
  param([System.IO.FileSystemInfo]$Item)

  return ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-NoReparsePointInPath {
  param(
    [string]$Path,
    [string]$Boundary
  )

  $current = [System.IO.Path]::GetFullPath($Path)
  $boundaryPath = [System.IO.Path]::GetFullPath($Boundary)
  while (-not $current.Equals($boundaryPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (Test-ReparsePoint $item) {
        throw "Build path must not contain a symbolic link or junction: $current"
      }
    }

    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Build path escaped repository boundary: $Path"
    }
    $current = $parent
  }
}

function Assert-NoReparsePointInTree {
  param([string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (Test-ReparsePoint $item) {
    throw "Refusing to remove a tree containing a symbolic link or junction: $Path"
  }
  if (-not $item.PSIsContainer) { return }
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
    if (Test-ReparsePoint $child) {
      throw "Refusing to remove a tree containing a symbolic link or junction: $($child.FullName)"
    }
    if ($child.PSIsContainer) {
      Assert-NoReparsePointInTree -Path $child.FullName
    }
  }
}

function Move-ExistingPathToQuarantine {
  param(
    [string]$Path,
    [string]$Boundary,
    [string]$QuarantineRoot
  )

  Assert-NoReparsePointInPath -Path $Path -Boundary $Boundary
  if (-not (Test-Path -LiteralPath $Path)) { return $null }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $fullPath -Force
  if (Test-ReparsePoint $item) {
    throw "Refusing to move a symbolic link or junction: $fullPath"
  }
  if ($item.PSIsContainer) {
    Assert-NoReparsePointInTree -Path $fullPath
  }

  $quarantine = Join-Path $QuarantineRoot (".kdownloader-clean-" + [System.Guid]::NewGuid().ToString("N"))
  if ($item.PSIsContainer) {
    [System.IO.Directory]::Move($fullPath, $quarantine)
  } else {
    [System.IO.File]::Move($fullPath, $quarantine)
  }

  try {
    Assert-NoReparsePointInPath -Path $quarantine -Boundary $Boundary
    $movedItem = Get-Item -LiteralPath $quarantine -Force
    if (Test-ReparsePoint $movedItem) {
      throw "Refusing to clean a quarantined symbolic link or junction: $quarantine"
    }
    if ($movedItem.PSIsContainer) {
      Assert-NoReparsePointInTree -Path $quarantine
    }
  } catch {
    if ((Test-Path -LiteralPath $quarantine) -and -not (Test-Path -LiteralPath $fullPath)) {
      if ($item.PSIsContainer) {
        [System.IO.Directory]::Move($quarantine, $fullPath)
      } else {
        [System.IO.File]::Move($quarantine, $fullPath)
      }
    }
    throw
  }

  return [pscustomobject]@{
    Path = $quarantine
    IsDirectory = [bool]$item.PSIsContainer
    OriginalPath = $fullPath
  }
}

function Restore-QuarantinedPath {
  param([object]$Quarantine)

  if ($null -eq $Quarantine -or -not (Test-Path -LiteralPath $Quarantine.Path)) { return }
  if (Test-Path -LiteralPath $Quarantine.OriginalPath) {
    throw "Cannot restore previous build because the output path reappeared: $($Quarantine.OriginalPath)"
  }
  if ($Quarantine.IsDirectory) {
    [System.IO.Directory]::Move($Quarantine.Path, $Quarantine.OriginalPath)
  } else {
    [System.IO.File]::Move($Quarantine.Path, $Quarantine.OriginalPath)
  }
}

function Remove-IsolatedPathSafely {
  param(
    [string]$Path,
    [string]$Boundary
  )

  Assert-NoReparsePointInPath -Path $Path -Boundary $Boundary
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (Test-ReparsePoint $item) {
    throw "Refusing to remove a symbolic link or junction: $Path"
  }
  if ($item.PSIsContainer) {
    Assert-NoReparsePointInTree -Path $Path
    Remove-Item -LiteralPath $Path -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
}

Assert-NoReparsePointInPath -Path $outputPath -Boundary $repoRoot
if (Test-Path -LiteralPath $outputPath) {
  $existingOutput = Get-Item -LiteralPath $outputPath -Force
  if (Test-ReparsePoint $existingOutput) {
    throw "Build path must not contain a symbolic link or junction: $outputPath"
  }
  if ($existingOutput.PSIsContainer) {
    Assert-NoReparsePointInTree -Path $outputPath
  }
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

$outputParent = [System.IO.Path]::GetDirectoryName($outputPath)
[System.IO.Directory]::CreateDirectory($distRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($outputParent) | Out-Null
Assert-NoReparsePointInPath -Path $distRoot -Boundary $repoRoot
Assert-NoReparsePointInPath -Path $outputParent -Boundary $repoRoot

$stagingPath = Join-Path $distRoot (".kdownloader-build-" + [System.Guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($stagingPath) | Out-Null
$quarantine = $null
try {
  Assert-NoReparsePointInPath -Path $stagingPath -Boundary $repoRoot
  $stagingPrefix = $stagingPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

  foreach ($runtimePath in $runtimePaths) {
    $sourcePath = Join-Path $repoRoot $runtimePath
    if (-not (Test-Path -LiteralPath $sourcePath)) {
      throw "Missing runtime path: $runtimePath"
    }

    $sourceItem = Get-Item -LiteralPath $sourcePath -Force
    $sourceEntries = if ($sourceItem.PSIsContainer) {
      @($sourceItem) + @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force)
    } else {
      @($sourceItem)
    }
    $sourceReparsePoint = $sourceEntries | Where-Object { Test-ReparsePoint $_ } | Select-Object -First 1
    if ($sourceReparsePoint) {
      throw "Runtime sources must not contain symbolic links or junctions: $($sourceReparsePoint.FullName)"
    }
    $files = $sourceEntries | Where-Object { -not $_.PSIsContainer }

    foreach ($file in $files) {
      if (Test-ReparsePoint (Get-Item -LiteralPath $file.FullName -Force)) {
        throw "Runtime sources must not contain symbolic links or junctions: $($file.FullName)"
      }
      $relativePath = [System.IO.Path]::GetRelativePath($repoRoot, $file.FullName)
      $parts = $relativePath -split '[\\/]'
      $hasReservedPart = $parts | Where-Object { $_ -like '_*' -and $_ -ne '_locales' }
      $isPythonArtifact = $file.Extension -in @('.py', '.pyc', '.pyo')
      if ($hasReservedPart -or $isPythonArtifact) {
        continue
      }

      $destination = [System.IO.Path]::GetFullPath((Join-Path $stagingPath $relativePath))
      if (-not $destination.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime path escaped build output: $relativePath"
      }
      $destinationDirectory = Split-Path $destination -Parent
      [System.IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
      [System.IO.File]::Copy($file.FullName, $destination, $false)
    }
  }

  $forbidden = Get-ChildItem -LiteralPath $stagingPath -Recurse -Force | Where-Object {
    ($_.Name -like '_*' -and $_.Name -ne '_locales') -or
    (-not $_.PSIsContainer -and $_.Extension -in @('.py', '.pyc', '.pyo'))
  }
  if ($forbidden) {
    throw "Build output contains a reserved or Python temporary path: $($forbidden[0].FullName)"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $stagingPath "manifest.json"))) {
    throw "Build output is missing manifest.json"
  }
  if ($null -ne $BuildNumber) {
    $stagedManifestPath = Join-Path $stagingPath "manifest.json"
    $stagedManifest = Get-Content -LiteralPath $stagedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stagedManifest.version = "$baseVersion.$BuildNumber"
    $stagedManifest | Add-Member -NotePropertyName "version_name" -NotePropertyValue "$baseVersion (build $BuildNumber)" -Force
    $stagedManifestJson = $stagedManifest | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText(
      $stagedManifestPath,
      $stagedManifestJson + [System.Environment]::NewLine,
      [System.Text.UTF8Encoding]::new($false)
    )
  }
  Assert-NoReparsePointInTree -Path $stagingPath

  $quarantine = Move-ExistingPathToQuarantine -Path $outputPath -Boundary $repoRoot -QuarantineRoot $distRoot
  try {
    Assert-NoReparsePointInPath -Path $stagingPath -Boundary $repoRoot
    Assert-NoReparsePointInTree -Path $stagingPath
    Assert-NoReparsePointInPath -Path $outputPath -Boundary $repoRoot
    if (Test-Path -LiteralPath $outputPath) {
      throw "Output directory appeared while the build was staged: $outputPath"
    }
    [System.IO.Directory]::Move($stagingPath, $outputPath)
    $stagingPath = $null
  } catch {
    Restore-QuarantinedPath -Quarantine $quarantine
    $quarantine = $null
    throw
  }

  if ($null -ne $quarantine) {
    Remove-IsolatedPathSafely -Path $quarantine.Path -Boundary $repoRoot
    $quarantine = $null
  }
} finally {
  if ($null -ne $stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
    Remove-IsolatedPathSafely -Path $stagingPath -Boundary $repoRoot
  }
}

Write-Output $outputPath
