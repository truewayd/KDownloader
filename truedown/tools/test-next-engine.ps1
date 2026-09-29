param([string]$EnginePath = "")

$ErrorActionPreference = "Stop"
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw "NEXT acceptance currently targets Windows x64"
}
$version = '2.8.3'
$expectedHash = '08afaf2a44811d38e7ce538da719ab06d6925bcaad1231ee7b92c497f58e5aac'
$temporaryRoot = $null
if ($EnginePath) { $EnginePath = [IO.Path]::GetFullPath($EnginePath) }
$saved = @{}
foreach ($key in @('TRUEDOWN_INTEGRATION', 'TRUEDOWN_ARIA2_PATH', 'TRUEDOWN_ARIA2_NEXT_VERSION')) {
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
  go test ./internal/downloader -count=1 -timeout=5m
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
