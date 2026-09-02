param(
  [string]$BrowserPath = ""
)

$ErrorActionPreference = "Stop"

function Find-ChromiumBrowser {
  param([string]$RequestedPath)

  if ($RequestedPath) {
    if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
      throw "BrowserPath must identify a Chromium executable"
    }
    return [System.IO.Path]::GetFullPath($RequestedPath)
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "Chrome or Edge is required to rasterize the canonical TrueDown SVG"
}

function Write-MultiSizeIcon {
  param(
    [string]$SourcePng,
    [string]$Destination,
    [string]$WorkingDirectory
  )

  Add-Type -AssemblyName System.Drawing
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $images = [System.Collections.Generic.List[byte[]]]::new()
  $source = [System.Drawing.Bitmap]::FromFile($SourcePng)
  try {
    foreach ($size in $sizes) {
      $bitmap = [System.Drawing.Bitmap]::new(
        $size,
        $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
      )
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
          $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.DrawImage($source, 0, 0, $size, $size)
        } finally {
          $graphics.Dispose()
        }

        $pngPath = Join-Path $WorkingDirectory ("truedown-{0}.png" -f $size)
        $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $images.Add([System.IO.File]::ReadAllBytes($pngPath))
      } finally {
        $bitmap.Dispose()
      }
    }
  } finally {
    $source.Dispose()
  }

  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $size = $sizes[$index]
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$index].Length
    }
    foreach ($image in $images) {
      $writer.Write($image)
    }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($Destination, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceSvg = Join-Path $projectRoot "web\truedown-logo.svg"
$targetIcon = Join-Path $PSScriptRoot "truedown.ico"
$manifest = Join-Path $PSScriptRoot "truedown.manifest"
$targetResource = Join-Path $projectRoot "resource_windows_amd64.syso"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  throw "TrueDown Windows manifest is required"
}
$browser = Find-ChromiumBrowser -RequestedPath $BrowserPath
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$temporaryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $temporaryBase ("truedown-icon-" + [System.Guid]::NewGuid().ToString("N")))
)
$temporaryPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar
if (-not $temporaryRoot.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary icon directory must remain inside $temporaryBase"
}
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null

try {
  $renderedPng = Join-Path $temporaryRoot "truedown-1024.png"
  $profile = Join-Path $temporaryRoot "browser-profile"
  $sourceUrl = ([System.Uri]::new($sourceSvg)).AbsoluteUri
  $browserArguments = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--default-background-color=00000000",
    "--force-device-scale-factor=1",
    "--window-size=1024,1024",
    "--no-first-run",
    "--disable-crash-reporter",
    "--user-data-dir=$profile",
    "--screenshot=$renderedPng",
    $sourceUrl
  )
  $browserProcess = Start-Process -FilePath $browser -ArgumentList $browserArguments -Wait -PassThru -WindowStyle Hidden
  if ($browserProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $renderedPng -PathType Leaf)) {
    throw "Failed to rasterize $sourceSvg"
  }

  $stagedIcon = Join-Path $temporaryRoot "truedown.ico"
  $stagedResource = Join-Path $temporaryRoot "resource_windows_amd64.syso"
  Write-MultiSizeIcon -SourcePng $renderedPng -Destination $stagedIcon -WorkingDirectory $temporaryRoot

  Push-Location $projectRoot
  try {
    go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico $stagedIcon -manifest $manifest -o $stagedResource
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to compile the Windows icon and DPI manifest resources"
    }
  } finally {
    Pop-Location
  }

  [System.IO.File]::Copy($stagedIcon, $targetIcon, $true)
  [System.IO.File]::Copy($stagedResource, $targetResource, $true)
  Write-Host "Updated $targetIcon and $targetResource"
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    if (-not $temporaryRoot.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove temporary files outside $temporaryBase"
    }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
