param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$PackageDirectory
)
$ErrorActionPreference = "Stop"
# NSIS writes product registration; run only on the disposable hosted runner.
if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "Installer acceptance requires a disposable GitHub-hosted runner"
}
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$packagePath = (Resolve-Path -LiteralPath $PackageDirectory).Path
$root = Join-Path $env:RUNNER_TEMP ("truedown-installer-" + [guid]::NewGuid().ToString("N"))
$destination = Join-Path $root "Application With Spaces"
[System.IO.Directory]::CreateDirectory($destination) | Out-Null

function Invoke-Setup([string]$Executable, [string]$Arguments) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) {
    $process.Kill()
    throw "Installer lifecycle timed out"
  }
  if ($process.ExitCode -ne 0) { throw "Installer lifecycle failed: $($process.ExitCode)" }
}

function Assert-InstalledFiles {
  foreach ($file in Get-ChildItem -LiteralPath $packagePath -File) {
    $installed = Join-Path $destination $file.Name
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or
        (Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
      throw "Installed payload differs: $($file.Name)"
    }
  }
}

# The actual NSIS update mode must produce only transaction-owned files.
$stage = Join-Path $root "Update Stage With Spaces"
Invoke-Setup $installerPath "/S /UPDATE /TRUEDOWN-STAGE /D=$stage"
$updateFiles = @("TrueDown.exe", "truedown-core.exe", "truedown-cli.exe", "THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt")
$actual = @(Get-ChildItem -LiteralPath $stage -File)
if ($actual.Count -ne $updateFiles.Count) { throw "Unexpected installer update payload" }
foreach ($name in $updateFiles) {
  if ((Get-FileHash -LiteralPath (Join-Path $stage $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $packagePath $name)).Hash) {
    throw "Installer update payload differs: $name"
  }
}

# NSIS requires /D to be last and unquoted, including paths containing spaces.
Invoke-Setup $installerPath "/S /D=$destination"
Assert-InstalledFiles
$sentinel = Join-Path $destination "user-data-preserved.txt"
[System.IO.File]::WriteAllText($sentinel, "preserve")
Invoke-Setup $installerPath "/S /D=$destination"
Assert-InstalledFiles
node (Join-Path $PSScriptRoot "../desktop/tests/package-smoke.mjs") (Join-Path $destination "TrueDown.exe")
if ($LASTEXITCODE -ne 0) { throw "Installed application smoke test failed" }

Invoke-Setup (Join-Path $destination "uninstall.exe") "/S _?=$destination"
foreach ($file in Get-ChildItem -LiteralPath $packagePath -File) {
  if (Test-Path -LiteralPath (Join-Path $destination $file.Name)) {
    throw "Uninstall left a packaged file: $($file.Name)"
  }
}
if ([System.IO.File]::ReadAllText($sentinel) -ne "preserve") {
  throw "Installer lifecycle removed user data"
}
Write-Host "Installer install, reinstall, native startup and uninstall passed"
