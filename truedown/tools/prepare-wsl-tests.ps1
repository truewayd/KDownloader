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
  @{ Package = "./modules/mega"; Path = (Join-Path $projectRoot "internal/modulebundle/assets/mega-linux-amd64.bin"); Module = 'mega' },
  @{ Package = "./modules/mediafire"; Path = (Join-Path $projectRoot "internal/modulebundle/assets/mediafire-linux-amd64.bin"); Module = 'mediafire' },
  @{ Package = "./cmd/truedown-core"; Path = (Join-Path $outputRoot "truedown-core") },
  @{ Package = "./cmd/truedown"; Path = (Join-Path $outputRoot "truedown-cli") },
  @{ Package = "./internal/app"; Path = (Join-Path $testRoot "truedown.test"); Test = $true },
  @{ Package = "./internal/api"; Path = (Join-Path $testRoot "api.test"); Test = $true },
  @{ Package = "./internal/applog"; Path = (Join-Path $testRoot "applog.test"); Test = $true },
  @{ Package = "./internal/cli"; Path = (Join-Path $testRoot "cli.test"); Test = $true },
  @{ Package = "./internal/client"; Path = (Join-Path $testRoot "client.test"); Test = $true },
  @{ Package = "./internal/desktopbridge"; Path = (Join-Path $testRoot "desktopbridge.test"); Test = $true },
  @{ Package = "./internal/profile"; Path = (Join-Path $testRoot "profile.test"); Test = $true },
  @{ Package = "./internal/protocol"; Path = (Join-Path $testRoot "protocol.test"); Test = $true },
  @{ Package = "./internal/downloader"; Path = (Join-Path $testRoot "downloader.test"); Test = $true },
  @{ Package = "./internal/safefile"; Path = (Join-Path $testRoot "safefile.test"); Test = $true },
  @{ Package = "./internal/systemupdate"; Path = (Join-Path $testRoot "systemupdate.test"); Test = $true },
  @{ Package = "./internal/updatecache"; Path = (Join-Path $testRoot "updatecache.test"); Test = $true },
  @{ Package = "./internal/modulehost"; Path = (Join-Path $testRoot "modulehost.test"); Test = $true },
  @{ Package = "./internal/netproxy"; Path = (Join-Path $testRoot "netproxy.test"); Test = $true },
  @{ Package = "./modules/mega"; Path = (Join-Path $testRoot "mega-module.test"); Test = $true },
  @{ Package = "./modules/mega/internal/mega"; Path = (Join-Path $testRoot "mega-crypto.test"); Test = $true },
  @{ Package = "./modules/mediafire"; Path = (Join-Path $testRoot "mediafire-module.test"); Test = $true },
  @{ Package = "./modules/mediafire/internal/mediafire"; Path = (Join-Path $testRoot "mediafire-resolver.test"); Test = $true }
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
      } elseif ($output.Module) {
        $baseline = Get-Content -LiteralPath (Join-Path $projectRoot "internal/downloader/module_baselines/$($output.Module).json") -Raw | ConvertFrom-Json
        if ($baseline.id -ne $output.Module -or $baseline.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid module baseline version' }
        & go build -trimpath -ldflags "-s -w -X main.version=$($baseline.version)" -o $output.Path $output.Package
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

Write-Output "WSL2 binary: $(Join-Path $outputRoot 'truedown-core')"
Write-Output "WSL2 tests: $testRoot"
