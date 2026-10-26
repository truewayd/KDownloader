param([Parameter(Mandatory=$true)][string]$RecordDirectory)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'target/release/composition-menu-prototype.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Build the prototype first.' }
$installRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/CompositionMenuPrototype'
$destination=Join-Path $installRoot 'CompositionMenuPrototype.exe'
$identity=Join-Path $installRoot 'installation.json'
if (Test-Path -LiteralPath $installRoot) {
    if ((Get-Item -LiteralPath $installRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing an aliased install directory.' }
    if (Test-Path -LiteralPath $destination) {
        if (-not (Test-Path -LiteralPath $identity)) { throw 'Existing executable has no prototype installation identity.' }
        if ((Get-Content -LiteralPath $identity -Raw | ConvertFrom-Json).product -ne 'composition-menu-prototype') { throw 'Installation identity mismatch.' }
        foreach ($process in @(Get-Process -Name CompositionMenuPrototype -ErrorAction SilentlyContinue)) {
            if ($process.Path -eq $destination) {
                if (-not $process.CloseMainWindow()) { throw 'Close the prototype before updating it.' }
                if (-not $process.WaitForExit(5000)) { throw 'Prototype did not close; installation stopped.' }
            }
        }
    }
} else { New-Item -ItemType Directory -Path $installRoot | Out-Null }
Copy-Item -LiteralPath $source -Destination $destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $installRoot 'README.md')
$sourceHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$installedHash=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
if ($sourceHash -ne $installedHash) { throw 'Installed file differs from the build output.' }
$programs=[Environment]::GetFolderPath('Programs')
$shortcutPath=Join-Path $programs 'Composition Menu Prototype.lnk'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath=$destination
$shortcut.WorkingDirectory=$installRoot
$shortcut.Description='Independent native menu demo using the shared TrueDown renderer.'
$shortcut.Save()
$record=[ordered]@{product='composition-menu-prototype';renderer='Direct2D/DirectWrite + Windows Composition';materials=@('Composition blur (Acrylic-style)','Solid');defaultMaterial='Composition blur (Acrylic-style)';webview=$false;installedAt=[DateTime]::UtcNow.ToString('o');executable=$destination;sha256=$installedHash;shortcut=$shortcutPath;source=$source;launched=$false;testsRun=$false}
$record | ConvertTo-Json | Set-Content -LiteralPath $identity
New-Item -ItemType Directory -Path $RecordDirectory -Force | Out-Null
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RecordDirectory 'installation.json')
$record | ConvertTo-Json
