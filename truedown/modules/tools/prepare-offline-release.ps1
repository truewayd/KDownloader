param(
  [Parameter(Mandatory)][ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')][string]$Version,
  [Parameter(Mandatory)][string]$SigningKeyPath,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$GoPath = 'go'
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
$public = Join-Path $project "modules/mediafire/releases/$Version"
foreach ($candidate in @($output, $public)) {
  for ($cursor = $candidate; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe release directory: $cursor" }
    }
  }
}
if (Test-Path -LiteralPath $public) { throw 'Use a new version; public signatures are immutable' }
$required = [regex]::Match([IO.File]::ReadAllText((Join-Path $project 'go.mod')), '(?m)^go (\S+)').Groups[1].Value
$actual = & $GoPath version
if ($LASTEXITCODE -ne 0 -or $actual -notmatch "^go version go$([regex]::Escape($required)) ") { throw "Exact Go $required required" }
$seed = [IO.File]::ReadAllText([IO.Path]::GetFullPath($SigningKeyPath)).Trim()
if ($seed -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid publisher seed encoding' }
$previous = @{}
foreach ($name in @('CGO_ENABLED','GOOS','GOARCH','GOTOOLCHAIN','GOFLAGS','GOEXPERIMENT','TRUEDOWN_MODULE_SIGNING_KEY')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$repository = [IO.Path]::GetDirectoryName($project)
& git -C $repository diff --quiet HEAD -- truedown/go.mod truedown/go.sum truedown/internal/modulehost truedown/internal/netproxy truedown/modules/mediafire
if ($LASTEXITCODE -ne 0) { throw 'Commit provider and protocol source changes before signing' }
# Build canonical Git bytes, independent of Windows core.autocrlf settings.
$sourceArchive = Join-Path $output 'source.zip'
$sourceRoot = Join-Path $output 'source'
if ((Test-Path -LiteralPath $sourceArchive) -or (Test-Path -LiteralPath $sourceRoot)) { throw 'Source output already exists' }
& git -C $repository archive --format=zip --output $sourceArchive HEAD truedown/go.mod truedown/go.sum truedown/internal truedown/modules
if ($LASTEXITCODE -ne 0) { throw 'Cannot export committed source' }
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceRoot
Push-Location $project
try {
  $env:CGO_ENABLED='0'; $env:GOTOOLCHAIN='local'; $env:GOFLAGS=''; $env:GOEXPERIMENT=''
  $env:TRUEDOWN_MODULE_SIGNING_KEY=$seed
  foreach ($target in @('windows/amd64','linux/amd64','linux/arm64','darwin/arm64')) {
    $parts=$target.Split('/'); $env:GOOS=$parts[0]; $env:GOARCH=$parts[1]
    $platform="$($parts[0])-$($parts[1])"
    $binary=Join-Path $output "mediafire-$platform.bin"
    if (Test-Path -LiteralPath $binary) { throw "Release output already exists: $binary" }
    Push-Location (Join-Path $sourceRoot 'truedown')
    try {
      & $GoPath build -buildvcs=false -trimpath -ldflags "-s -w -X main.version=$Version" -o $binary ./modules/mediafire
      if ($LASTEXITCODE -ne 0) { throw "Build failed: $target" }
    } finally { Pop-Location }
    $env:GOOS=$previous.GOOS; $env:GOARCH=$previous.GOARCH
    $fixture=Join-Path $output $platform
    if (Test-Path -LiteralPath $fixture) { throw "Manifest output already exists: $fixture" }
    & $GoPath run ./modules/tools/sign sign $binary mediafire $Version $parts[0] $parts[1] $fixture
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: $target" }
    & $GoPath run ./modules/tools/sign verify $binary mediafire $Version $parts[0] $parts[1] $fixture
    if ($LASTEXITCODE -ne 0) { throw "Verification failed: $target" }
  }
  New-Item -ItemType Directory -Path $public | Out-Null
  foreach ($platform in @('windows-amd64','linux-amd64','linux-arm64','darwin-arm64')) {
    Copy-Item -LiteralPath (Join-Path $output $platform) -Destination (Join-Path $public $platform) -Recurse
  }
  Write-Output "Public signatures prepared: $public"
} finally {
  Pop-Location
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  $seed=$null
}
