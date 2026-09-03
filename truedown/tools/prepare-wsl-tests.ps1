$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = Join-Path $projectRoot "dist"
$outputRoot = Join-Path $distRoot "wsl2"
$testRoot = Join-Path $outputRoot "tests"

foreach ($path in @($distRoot, $outputRoot, $testRoot)) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "WSL2 test output must be a regular directory: $path"
    }
  } else {
    New-Item -ItemType Directory -Path $path | Out-Null
  }
}

$outputs = @(
  @{ Package = "."; Path = (Join-Path $outputRoot "TrueDown") },
  @{ Package = "."; Path = (Join-Path $testRoot "truedown.test"); Test = $true },
  @{ Package = "./internal/api"; Path = (Join-Path $testRoot "api.test"); Test = $true },
  @{ Package = "./internal/applog"; Path = (Join-Path $testRoot "applog.test"); Test = $true },
  @{ Package = "./internal/downloader"; Path = (Join-Path $testRoot "downloader.test"); Test = $true },
  @{ Package = "./internal/safefile"; Path = (Join-Path $testRoot "safefile.test"); Test = $true },
  @{ Package = "./internal/systemupdate"; Path = (Join-Path $testRoot "systemupdate.test"); Test = $true }
)

foreach ($output in $outputs) {
  if (Test-Path -LiteralPath $output.Path) {
    $item = Get-Item -LiteralPath $output.Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to replace unsafe WSL2 test output: $($output.Path)"
    }
  }
}

$previousCgo = $env:CGO_ENABLED
$previousGoos = $env:GOOS
$previousGoarch = $env:GOARCH
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "linux"
  $env:GOARCH = "amd64"
  Push-Location $projectRoot
  try {
    foreach ($output in $outputs) {
      if ($output.Test) {
        & go test -c -o $output.Path $output.Package
      } else {
        & go build -trimpath -o $output.Path $output.Package
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to build Linux output for $($output.Package)"
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:CGO_ENABLED = $previousCgo
  $env:GOOS = $previousGoos
  $env:GOARCH = $previousGoarch
}

Write-Output "WSL2 binary: $($outputs[0].Path)"
Write-Output "WSL2 tests: $testRoot"
