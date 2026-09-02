param(
  [string]$OutputDirectory = "dist/TrueDown",
  [string]$Version = "dev",
  [long]$BuildNumber = 0,
  [string]$Commit = "unknown"
)

$ErrorActionPreference = "Stop"

function Test-ReparsePoint {
  param([System.IO.FileSystemInfo]$Item)
  return ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-NoReparsePath {
  param(
    [string]$Root,
    [string]$Path
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $candidatePath = [System.IO.Path]::GetFullPath($Path)
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if ($candidatePath -ne $rootPath -and -not $candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path must remain inside $rootPath"
  }
  $current = $rootPath
  $relative = [System.IO.Path]::GetRelativePath($rootPath, $candidatePath)
  $segments = $relative.Split(
    [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
    [System.StringSplitOptions]::RemoveEmptyEntries
  )
  # The repository root is the caller's trusted boundary. Reject only reparse
  # points below it so a checkout hosted in a junction remains buildable.
  $paths = @()
  foreach ($segment in $segments) {
    if ($segment -eq ".") { continue }
    $current = Join-Path $current $segment
    $paths += $current
  }
  foreach ($candidate in $paths) {
    if (-not (Test-Path -LiteralPath $candidate)) { break }
    $item = Get-Item -LiteralPath $candidate -Force
    if (Test-ReparsePoint $item) {
      throw "Refusing to traverse reparse point: $candidate"
    }
  }
}

function Assert-NoReparseTree {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  if (Test-ReparsePoint $item) {
    throw "Refusing to remove reparse point: $Path"
  }
  if (-not $item.PSIsContainer) { return }
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
    if (Test-ReparsePoint $child) {
      throw "Refusing to remove a tree containing reparse point: $($child.FullName)"
    }
    if ($child.PSIsContainer) {
      Assert-NoReparseTree $child.FullName
    }
  }
}

function Assert-RegularSourceFile {
  param(
    [string]$Root,
    [string]$Path
  )
  Assert-NoReparsePath -Root $Root -Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or (Test-ReparsePoint $item)) {
    throw "Build source must be a regular file: $Path"
  }
}

function Assert-BuildInputs {
  param([string]$Root)
  foreach ($source in Get-ChildItem -LiteralPath $Root -Force -File -Filter "*.go") {
    Assert-RegularSourceFile -Root $Root -Path $source.FullName
  }
  foreach ($resourceName in @("resource_windows_amd64.syso", "windows\truedown.ico", "windows\truedown.manifest")) {
    Assert-RegularSourceFile -Root $Root -Path (Join-Path $Root $resourceName)
  }
  foreach ($manifestName in @("go.mod", "go.sum")) {
    $manifest = Join-Path $Root $manifestName
    if (Test-Path -LiteralPath $manifest) {
      Assert-RegularSourceFile -Root $Root -Path $manifest
    }
  }
  foreach ($treeName in @("internal", "web", "windows")) {
    $tree = Join-Path $Root $treeName
    Assert-NoReparsePath -Root $Root -Path $tree
    Assert-NoReparseTree $tree
  }
}

function Assert-ExecutableIcon {
  param(
    [string]$Executable,
    [string]$ExpectedIcon
  )

  Add-Type -AssemblyName System.Drawing
  $actual = [System.Drawing.Icon]::ExtractAssociatedIcon($Executable)
  if ($null -eq $actual) {
    throw "Built executable does not contain a Windows icon"
  }
  $expected = [System.Drawing.Icon]::new($ExpectedIcon, 32, 32)
  try {
    $actualBitmap = $actual.ToBitmap()
    $expectedBitmap = $expected.ToBitmap()
    try {
      if ($actualBitmap.Width -ne $expectedBitmap.Width -or $actualBitmap.Height -ne $expectedBitmap.Height) {
        throw "Built executable icon dimensions do not match the source icon"
      }
      for ($y = 0; $y -lt $expectedBitmap.Height; $y++) {
        for ($x = 0; $x -lt $expectedBitmap.Width; $x++) {
          if ($actualBitmap.GetPixel($x, $y).ToArgb() -ne $expectedBitmap.GetPixel($x, $y).ToArgb()) {
            throw "Built executable icon does not match the source icon"
          }
        }
      }
    } finally {
      $actualBitmap.Dispose()
      $expectedBitmap.Dispose()
    }
  } finally {
    $actual.Dispose()
    $expected.Dispose()
  }
}

function Assert-ExecutableDPIManifest {
  param(
    [string]$Executable,
    [string]$ExpectedManifest
  )

  if (-not ("TrueDownWindowsResourceReader" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TrueDownWindowsResourceReader {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SizeofResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LockResource(IntPtr resourceData);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeLibrary(IntPtr module);
}
'@
  }

  # Load as data and as an image resource so no executable code runs.
  $module = [TrueDownWindowsResourceReader]::LoadLibraryExW($Executable, [IntPtr]::Zero, 0x22)
  if ($module -eq [IntPtr]::Zero) {
    throw "Unable to inspect the built executable manifest"
  }
  try {
    $resource = [TrueDownWindowsResourceReader]::FindResourceW($module, [IntPtr]1, [IntPtr]24)
    if ($resource -eq [IntPtr]::Zero) {
      throw "Built executable does not contain application manifest resource 1"
    }
    $size = [TrueDownWindowsResourceReader]::SizeofResource($module, $resource)
    $loaded = [TrueDownWindowsResourceReader]::LoadResource($module, $resource)
    $pointer = [TrueDownWindowsResourceReader]::LockResource($loaded)
    if ($size -eq 0 -or $loaded -eq [IntPtr]::Zero -or $pointer -eq [IntPtr]::Zero) {
      throw "Built executable contains an unreadable application manifest"
    }
    $bytes = [byte[]]::new($size)
    [System.Runtime.InteropServices.Marshal]::Copy($pointer, $bytes, 0, $bytes.Length)
    $actual = [System.Text.Encoding]::UTF8.GetString($bytes).Trim([char]0).Replace("`r`n", "`n").Trim()
    $expected = [System.IO.File]::ReadAllText($ExpectedManifest, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n").Trim()
    if ($actual -ne $expected) {
      throw "Built executable DPI manifest does not match the reviewed source manifest"
    }
  } finally {
    [TrueDownWindowsResourceReader]::FreeLibrary($module) | Out-Null
  }
}

function Assert-WindowsGUISubsystem {
  param([string]$Executable)

  $stream = [System.IO.File]::OpenRead($Executable)
  $reader = [System.IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 256) {
      throw "Built executable is too small to contain a PE header"
    }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset + 96 -gt $stream.Length) {
      throw "Built executable has an invalid PE header offset"
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "Built executable is missing the PE signature"
    }
    $stream.Position = $peOffset + 24 + 68
    if ($reader.ReadUInt16() -ne 2) {
      throw "Built executable must use the Windows GUI subsystem"
    }
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Remove-TreeSafely {
  param(
    [string]$Root,
    [string]$Path
  )
  Assert-NoReparsePath -Root $Root -Path $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Assert-NoReparseTree $Path

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $parent = [System.IO.Path]::GetDirectoryName($fullPath)
  $quarantine = Join-Path $parent (".truedown-clean-" + [System.Guid]::NewGuid().ToString("N"))
  [System.IO.Directory]::Move($fullPath, $quarantine)
  try {
    Assert-NoReparsePath -Root $Root -Path $quarantine
    Assert-NoReparseTree $quarantine
    Remove-Item -LiteralPath $quarantine -Recurse -Force
  } catch {
    if ((Test-Path -LiteralPath $quarantine) -and -not (Test-Path -LiteralPath $fullPath)) {
      [System.IO.Directory]::Move($quarantine, $fullPath)
    }
    throw
  }
}

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
$syncComponents = Join-Path $projectRoot "..\tools\sync-ui-components.ps1"
& $syncComponents -Check | Out-Null
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
$aria = Join-Path $projectRoot "aria2\aria2c.exe"
$icon = Join-Path $projectRoot "windows\truedown.ico"
$appManifest = Join-Path $projectRoot "windows\truedown.manifest"
$copySources = @(
  @{ Source = $aria; Name = "aria2c.exe" },
  @{ Source = (Join-Path $projectRoot "ARIA2_COPYING"); Name = "ARIA2_COPYING" },
  @{ Source = (Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"); Name = "THIRD_PARTY_NOTICES.md" }
)

Assert-NoReparsePath -Root $projectRoot -Path $dist
Assert-BuildInputs -Root $projectRoot
foreach ($entry in $copySources) {
  Assert-RegularSourceFile -Root $projectRoot -Path $entry.Source
}

Remove-TreeSafely -Root $projectRoot -Path $dist
$stagingParent = [System.IO.Path]::GetDirectoryName($dist)
[System.IO.Directory]::CreateDirectory($stagingParent) | Out-Null
Assert-NoReparsePath -Root $projectRoot -Path $stagingParent
$staging = Join-Path $stagingParent (".truedown-build-" + [System.Guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($staging) | Out-Null
try {
  Assert-NoReparsePath -Root $projectRoot -Path $staging
  $exe = Join-Path $staging "TrueDown.exe"
  Write-Host "Building..."
  Push-Location $projectRoot
  try {
    $ldflags = "-H windowsgui -s -w -X main.version=$Version -X main.buildNumber=$BuildNumber -X main.commit=$Commit"
    go build -trimpath -ldflags $ldflags -o $exe .
    $buildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($buildExitCode -ne 0) { exit $buildExitCode }
  Assert-WindowsGUISubsystem -Executable $exe
  Assert-ExecutableIcon -Executable $exe -ExpectedIcon $icon
  Assert-ExecutableDPIManifest -Executable $exe -ExpectedManifest $appManifest

  Assert-NoReparsePath -Root $projectRoot -Path $staging
  foreach ($entry in $copySources) {
    Assert-RegularSourceFile -Root $projectRoot -Path $entry.Source
    [System.IO.File]::Copy($entry.Source, (Join-Path $staging $entry.Name), $false)
  }
  Assert-NoReparseTree $staging
  if (Test-Path -LiteralPath $dist) {
    throw "Output directory appeared while the build was staged: $dist"
  }
  [System.IO.Directory]::Move($staging, $dist)
  Assert-NoReparsePath -Root $projectRoot -Path $dist
  Assert-NoReparseTree $dist
  $staging = $null
} finally {
  if ($null -ne $staging -and (Test-Path -LiteralPath $staging)) {
    Remove-TreeSafely -Root $projectRoot -Path $staging
  }
}
Write-Host "Build OK -> $dist\"
