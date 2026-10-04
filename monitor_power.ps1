param(
    [int]$DurationSeconds = 28800,
    [int]$IntervalSeconds = 10,
    [string]$OutputPath = (Join-Path $PSScriptRoot 'power-monitor.csv')
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$startedAt = Get-Date
$endsAt = $startedAt.AddSeconds($DurationSeconds)

'timestamp,cpu_package_w,cpu_cores_w,gpu_w,gpu_util_pct,gpu_temp_c,cpu_plus_gpu_w,status' |
    Set-Content -LiteralPath $OutputPath -Encoding utf8

while ((Get-Date) -lt $endsAt) {
    $sampleTime = Get-Date
    $cpuPackageW = $null
    $cpuCoresW = $null
    $gpuW = $null
    $gpuUtil = $null
    $gpuTemp = $null
    $status = 'ok'

    try {
        $counterSamples = (Get-Counter '\Energy Meter(*)\Power').CounterSamples
        $package = $counterSamples | Where-Object InstanceName -EQ 'rapl_package0_pkg' | Select-Object -First 1
        $cores = $counterSamples | Where-Object InstanceName -EQ 'rapl_package0_pp0' | Select-Object -First 1
        if ($package) { $cpuPackageW = [double]$package.CookedValue / 1000.0 }
        if ($cores) { $cpuCoresW = [double]$cores.CookedValue / 1000.0 }
    } catch {
        $status = 'cpu_sensor_error'
    }

    try {
        $gpuLine = & nvidia-smi --query-gpu=power.draw,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null |
            Select-Object -First 1
        if ($gpuLine) {
            $gpuFields = $gpuLine -split ',' | ForEach-Object { $_.Trim() }
            $gpuW = [double]::Parse($gpuFields[0], $culture)
            $gpuUtil = [double]::Parse($gpuFields[1], $culture)
            $gpuTemp = [double]::Parse($gpuFields[2], $culture)
        }
    } catch {
        $status = if ($status -eq 'ok') { 'gpu_sensor_error' } else { 'cpu_and_gpu_sensor_error' }
    }

    $totalW = if ($null -ne $cpuPackageW -and $null -ne $gpuW) { $cpuPackageW + $gpuW } else { $null }
    $values = @(
        $sampleTime.ToString('o'),
        $(if ($null -ne $cpuPackageW) { $cpuPackageW.ToString('F3', $culture) } else { '' }),
        $(if ($null -ne $cpuCoresW) { $cpuCoresW.ToString('F3', $culture) } else { '' }),
        $(if ($null -ne $gpuW) { $gpuW.ToString('F3', $culture) } else { '' }),
        $(if ($null -ne $gpuUtil) { $gpuUtil.ToString('F1', $culture) } else { '' }),
        $(if ($null -ne $gpuTemp) { $gpuTemp.ToString('F1', $culture) } else { '' }),
        $(if ($null -ne $totalW) { $totalW.ToString('F3', $culture) } else { '' }),
        $status
    )
    ($values -join ',') | Add-Content -LiteralPath $OutputPath -Encoding utf8

    $remaining = ($endsAt - (Get-Date)).TotalSeconds
    if ($remaining -gt 0) {
        Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, [Math]::Ceiling($remaining)))
    }
}

$rows = Import-Csv -LiteralPath $OutputPath
$valid = @($rows | Where-Object { $_.cpu_plus_gpu_w -ne '' })
$summaryPath = [IO.Path]::ChangeExtension($OutputPath, '.summary.txt')
if ($valid.Count -gt 0) {
    $values = @($valid | ForEach-Object { [double]::Parse($_.cpu_plus_gpu_w, $culture) })
    $averageW = ($values | Measure-Object -Average).Average
    $minimumW = ($values | Measure-Object -Minimum).Minimum
    $maximumW = ($values | Measure-Object -Maximum).Maximum
    $energyKWh = $averageW * (($valid.Count * $IntervalSeconds) / 3600.0) / 1000.0
    @(
        "started_at=$($startedAt.ToString('o'))"
        "ended_at=$((Get-Date).ToString('o'))"
        "samples=$($valid.Count)"
        "average_cpu_plus_gpu_w=$($averageW.ToString('F3', $culture))"
        "minimum_cpu_plus_gpu_w=$($minimumW.ToString('F3', $culture))"
        "maximum_cpu_plus_gpu_w=$($maximumW.ToString('F3', $culture))"
        "estimated_cpu_plus_gpu_kwh=$($energyKWh.ToString('F6', $culture))"
    ) | Set-Content -LiteralPath $summaryPath -Encoding utf8
} else {
    "No valid CPU+GPU samples were collected." | Set-Content -LiteralPath $summaryPath -Encoding utf8
}
