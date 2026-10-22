param(
  [string]$EnginePath = "",
  [string]$FFmpegPath = "",
  [string]$Version = ''
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw "NEXT acceptance currently targets Windows x64"
}
$reviewedNext = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../internal/systemupdate/next-release.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $reviewedNext.version }
$expectedHashes = @{
  '3.0.2' = 'caa69e8ed4bdb2138b1b577f15ea9adecdf7c8230c6c3bb05c7c955383029de3'
  '3.0.0' = 'edf8d987abb3055f34b09a190b4d533950a186ddae9013b9fb83948ee3a5f438'
  '2.8.3' = '08afaf2a44811d38e7ce538da719ab06d6925bcaad1231ee7b92c497f58e5aac'
}
$expectedHashes[$reviewedNext.version] = $reviewedNext.windows.amd64
if (-not $expectedHashes.ContainsKey($Version)) { throw 'Select the reviewed NEXT version or a pinned regression version' }
$expectedHash = $expectedHashes[$Version]
if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw 'Invalid reviewed NEXT SHA-256' }
$temporaryRoot = $null
if ($EnginePath) { $EnginePath = [IO.Path]::GetFullPath($EnginePath) }
$saved = @{}
foreach ($key in @('TRUEDOWN_INTEGRATION', 'TRUEDOWN_ARIA2_PATH', 'TRUEDOWN_ARIA2_NEXT_VERSION', 'TRUEDOWN_FFMPEG_PATH')) {
  $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  if (-not $EnginePath) {
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('truedown-next-test-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $EnginePath = Join-Path $temporaryRoot 'aria2-next.exe'
    Invoke-WebRequest -Uri "https://github.com/AnInsomniacy/aria2-next/releases/download/v$version/aria2-next-$version-windows-x86_64.exe" -OutFile $EnginePath -TimeoutSec 120
  }
  $EnginePath = [IO.Path]::GetFullPath($EnginePath)
  if ((Get-FileHash -LiteralPath $EnginePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw "NEXT test engine SHA-256 does not match the reviewed release"
  }
  $env:TRUEDOWN_INTEGRATION = '1'
  $env:TRUEDOWN_ARIA2_PATH = $EnginePath
  $env:TRUEDOWN_ARIA2_NEXT_VERSION = $version
  if ($FFmpegPath) { $env:TRUEDOWN_FFMPEG_PATH = [IO.Path]::GetFullPath($FFmpegPath) }
  if ([version]$version -ge [version]'3.0.0' -and -not $env:TRUEDOWN_FFMPEG_PATH -and -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'NEXT 3 media acceptance requires developer FFmpeg and ffprobe; pass -FFmpegPath'
  }
  node tools/prepare-mega-module.mjs
  if ($LASTEXITCODE -ne 0) { throw "MEGA baseline preparation failed" }
  go test ./internal/downloader ./internal/systemupdate ./internal/api -count=1 -timeout=5m
  if ($LASTEXITCODE -ne 0) { throw "NEXT acceptance failed" }
} finally {
  foreach ($key in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
  }
  Pop-Location
  if ($temporaryRoot) {
    if (Test-Path -LiteralPath $EnginePath) { Remove-Item -LiteralPath $EnginePath -Force }
    Remove-Item -LiteralPath $temporaryRoot
  }
}
