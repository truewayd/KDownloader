param([Parameter(Mandatory=$true)][int]$RootProcessId,[Parameter(Mandatory=$true)][string]$OutputDirectory,[int]$Seconds=45)
$ErrorActionPreference='Stop'
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $taskOutput -PathType Container)) { throw 'Run directory must already exist.' }
$rows=[Collections.Generic.List[object]]::new()
$timer=[Diagnostics.Stopwatch]::StartNew()
$family=[Collections.Generic.HashSet[int]]::new()
$family.Add($RootProcessId) | Out-Null
$nextInventory=0
$previousCpu=$null
$previousTime=0
$gpuError=$null
while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
    if ($timer.Elapsed.TotalSeconds -ge $nextInventory) {
        $all=Get-CimInstance Win32_Process
        do {
            $added=$false
            foreach ($item in $all) { if ($family.Contains([int]$item.ParentProcessId) -and $family.Add([int]$item.ProcessId)) { $added=$true } }
        } while ($added)
        $nextInventory=$timer.Elapsed.TotalSeconds+5
    }
    $processes=@(Get-Process -Id @($family) -ErrorAction SilentlyContinue)
    if (-not ($processes | Where-Object Id -eq $RootProcessId)) { break }
    $cpu=($processes | Measure-Object CPU -Sum).Sum
    $now=$timer.Elapsed.TotalSeconds
    $cpuCore=if ($null -ne $previousCpu -and $now -gt $previousTime) {100*($cpu-$previousCpu)/($now-$previousTime)} else {$null}
    $previousCpu=$cpu
    $previousTime=$now
    $gpuSum=$null
    $gpuMax=$null
    try {
        $gpu=@((Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples | Where-Object {
            $_.InstanceName -match '^pid_(\d+)_' -and $family.Contains([int]$Matches[1])
        })
        if ($gpu.Count) { $gpuSum=($gpu | Measure-Object CookedValue -Sum).Sum; $gpuMax=($gpu | Measure-Object CookedValue -Maximum).Maximum }
    } catch { $gpuError=$_.Exception.Message }
    $rows.Add([pscustomobject]@{seconds=[Math]::Round($now,3);processCount=$processes.Count;cpuCorePercent=$cpuCore;cpuSeconds=$cpu;privateBytes=($processes|Measure-Object PrivateMemorySize64 -Sum).Sum;workingSetBytes=($processes|Measure-Object WorkingSet64 -Sum).Sum;gpuEngineSumPercent=$gpuSum;gpuEngineMaxPercent=$gpuMax})
    $rows | Export-Csv -LiteralPath (Join-Path $taskOutput 'resources.csv') -NoTypeInformation
    Start-Sleep -Milliseconds 900
}
@{scope='Prototype and any discovered descendants; native revision has no browser; DWM excluded';cpu='100% equals one logical core; process startup may affect early samples';gpu='Sum/max of process GPU engine counters, not total GPU saturation; null is unavailable';gpuError=$gpuError;logicalProcessors=[Environment]::ProcessorCount;durationSeconds=$timer.Elapsed.TotalSeconds} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutput 'resource-method.json')
