param([switch]$Run)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$cargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'Run Get-DependencyReusePlan.ps1 before installing tools.' }
# Isolated stable target; never shares mutable build artifacts with production.
& $cargo build --release --locked --offline --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir (Join-Path $PSScriptRoot 'target')
if ($LASTEXITCODE -ne 0) { throw 'Offline prototype build failed.' }
$exe = Join-Path $PSScriptRoot 'target/release/composition-menu-prototype.exe'
Write-Output $exe
if ($Run) {
    $runDir = Join-Path $repo ('work/runs/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-composition-menu')
    Start-Process -FilePath $exe -ArgumentList @('--data-dir', ('"' + $runDir + '"')) -WindowStyle Hidden
}
