# CI-only oracle: reuse available tools, otherwise cache a verified fixed build.
# FFmpeg lists Gyan among its Windows build providers: https://ffmpeg.org/download.html
$ErrorActionPreference = 'Stop'
if ((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)) { return }
if (-not $env:RUNNER_TOOL_CACHE) { throw 'RUNNER_TOOL_CACHE is required for the CI media oracle' }

$oracleVersion = '9.0.2'
$oracleHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$oracleRoot = Join-Path $env:RUNNER_TOOL_CACHE "truedown-ffmpeg/$oracleVersion"
$oracleZip = Join-Path $oracleRoot 'essentials.zip'
$oracleBin = Join-Path $oracleRoot "ffmpeg-$oracleVersion-essentials_build/bin"
New-Item -ItemType Directory -Force -Path $oracleRoot | Out-Null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    if (-not (Test-Path -LiteralPath $oracleZip) -or (Get-FileHash -LiteralPath $oracleZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oracleHash) {
      Invoke-WebRequest -Uri "https://github.com/GyanD/codexffmpeg/releases/download/$oracleVersion/ffmpeg-$oracleVersion-essentials_build.zip" -OutFile $oracleZip -TimeoutSec 120
    }
    if ((Get-FileHash -LiteralPath $oracleZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oracleHash) {
      throw 'FFmpeg archive checksum mismatch'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $oracleBin 'ffmpeg.exe')) -or -not (Test-Path -LiteralPath (Join-Path $oracleBin 'ffprobe.exe'))) {
      Expand-Archive -LiteralPath $oracleZip -DestinationPath $oracleRoot -Force
    }
    foreach ($oracleName in @('ffmpeg', 'ffprobe')) {
      $oracleExecutable = Join-Path $oracleBin "$oracleName.exe"
      if (-not (Test-Path -LiteralPath $oracleExecutable -PathType Leaf)) { throw "$oracleName was not extracted" }
      $oracleOutput = & $oracleExecutable -version 2>&1
      if ($LASTEXITCODE -ne 0 -or ($oracleOutput -join "`n") -notmatch "^$oracleName version $([regex]::Escape($oracleVersion))\b") {
        throw "$oracleName failed its version check"
      }
    }
    $env:PATH = "$oracleBin;$env:PATH"
    if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value $oracleBin }
    return
  } catch {
    if ($attempt -eq 3) { throw "Failed to prepare FFmpeg and ffprobe after 3 attempts: $($_.Exception.Message)" }
    Start-Sleep -Seconds (5 * $attempt)
  }
}
