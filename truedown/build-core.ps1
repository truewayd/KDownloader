$ErrorActionPreference = "Stop"
# Development packages only. The legacy release updater does not own these binaries.
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ".."))
$outputRoot = Join-Path $projectRoot "dist/core"
foreach ($directory in @((Join-Path $projectRoot "dist"), $outputRoot)) {
  if (Test-Path -LiteralPath $directory) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Output must be a regular directory: $directory"
    }
  } else {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
}
& (Join-Path $repositoryRoot "tools/sync-ui-components.ps1") -Check
$outputNames = @("truedown-core.exe", "truedown-cli.exe", "aria2c.exe", "ARIA2_COPYING", "THIRD_PARTY_NOTICES.md")
foreach ($name in $outputNames) {
  $path = Join-Path $outputRoot $name
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing unsafe output: $path"
    }
  }
}
Push-Location $projectRoot
try {
  & go build -trimpath -o (Join-Path $outputRoot "truedown-core.exe") ./cmd/truedown-core
  if ($LASTEXITCODE -ne 0) { throw "Core build failed" }
  # Windows paths are case-insensitive: truedown.exe would collide with TrueDown.exe.
  & go build -trimpath -o (Join-Path $outputRoot "truedown-cli.exe") ./cmd/truedown
  if ($LASTEXITCODE -ne 0) { throw "CLI build failed" }
  Copy-Item -LiteralPath (Join-Path $projectRoot "aria2/aria2c.exe") -Destination (Join-Path $outputRoot "aria2c.exe") -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot "ARIA2_COPYING") -Destination (Join-Path $outputRoot "ARIA2_COPYING") -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot "THIRD_PARTY_NOTICES.md") -Destination $outputRoot -Force
} finally {
  Pop-Location
}
Write-Output "Core and CLI: $outputRoot"
