param(
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$Version = '0.2.0'
)
$ErrorActionPreference = 'Stop'
$moduleRoot = $PSScriptRoot
$coreRoot = [IO.Path]::GetFullPath((Join-Path $moduleRoot '../..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $coreRoot '..'))
$outputRoot = Join-Path $repositoryRoot "dist/modules/mega/$Version"
$savedGoos = $env:GOOS
$savedGoarch = $env:GOARCH
$savedCgo = $env:CGO_ENABLED
$originalLocation = Get-Location
try {
    Set-Location $coreRoot
    $env:CGO_ENABLED = '0'
    $goRoot = (& go env GOROOT).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to locate Go license' }
    foreach ($target in @('windows/amd64','linux/amd64','linux/arm64','darwin/arm64')) {
        $env:GOOS, $env:GOARCH = $target.Split('/')
        $directory = Join-Path $outputRoot ($target.Replace('/','-'))
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
        $entry = if ($env:GOOS -eq 'windows') { 'truedown-mega.exe' } else { 'truedown-mega' }
        $executable = Join-Path $directory $entry
        & go build -trimpath -ldflags "-s -w -X main.version=$Version" -o $executable ./modules/mega
        if ($LASTEXITCODE -ne 0) { throw "Module build failed for $target" }
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination (Join-Path $directory 'LICENSE')
        Copy-Item -LiteralPath (Join-Path $goRoot 'LICENSE') -Destination (Join-Path $directory 'GO-LICENSE')
        $files = foreach ($name in @($entry,'LICENSE','GO-LICENSE')) {
            $path = Join-Path $directory $name
            @{ name = $name; size = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
        $manifest = @{
            schemaVersion = 1; id = 'mega'; version = $Version
            os = $env:GOOS; arch = $env:GOARCH; protocol = 1
            entry = $entry; developmentOnly = $true; files = @($files)
        }
        [IO.File]::WriteAllText((Join-Path $directory 'module.json'), ($manifest | ConvertTo-Json -Depth 5) + "`n")
        Write-Output "Built development module: $directory"
    }
} finally {
    $env:GOOS = $savedGoos
    $env:GOARCH = $savedGoarch
    $env:CGO_ENABLED = $savedCgo
    Set-Location $originalLocation
}
