param([switch]$Apply)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-log-maintenance.ps1')
$logRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'thiefbook\logs')).TrimEnd('\')
$supervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'supervise-server.ps1'))
$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object -First 1
$serverProcessId = $listener.OwningProcess
if (-not (Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 5).ok) {
  throw 'The existing server is not healthy; repair stopped without changing processes or files.'
}

$processes = @(Get-CimInstance Win32_Process)
$supervisors = @($processes | Where-Object {
  if ($_.Name -notin @('powershell.exe', 'pwsh.exe') -or $_.ProcessId -eq $PID) { return $false }
  $fileMatch = [regex]::Match([string]$_.CommandLine, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
  if (-not $fileMatch.Success) { return $false }
  $fileArgument = if ($fileMatch.Groups[1].Success) { $fileMatch.Groups[1].Value } else { $fileMatch.Groups[2].Value }
  try {
    return [string]::Equals([IO.Path]::GetFullPath($fileArgument), $supervisorPath, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
})
$activePrefixes = @($processes | Where-Object { $_.Name -in @('node.exe', 'devtunnel.exe') } | ForEach-Object {
  $component = if ($_.Name -eq 'node.exe') { 'server' } else { 'tunnel' }
  "$component-run-$($_.CreationDate.ToString('yyyyMMdd-HHmmss'))"
})
$snapshot = @(Get-ChildItem -LiteralPath $logRoot -File)
$duplicates = @($snapshot | Where-Object { $_.Name -match '^server-run-\d{8}-\d{6}\.err\.log$' } | Where-Object {
  if ($_.Name.Substring(0, 26) -in $activePrefixes) { return $false }
  try { $content = [IO.File]::ReadAllText($_.FullName) } catch { return $false }
  return $content -match 'EADDRINUSE' -and $content -match 'port: 8787' -and $content -notmatch 'TTS error:'
} | Sort-Object Name)
$diagnosticPrefixes = @()
if ($duplicates.Count) {
  $diagnosticPrefixes += $duplicates[0].Name.Substring(0, 26)
  $diagnosticPrefixes += @($duplicates | Select-Object -Last 2 | ForEach-Object { $_.Name.Substring(0, 26) })
}
$protectedPrefixes = @($activePrefixes + $diagnosticPrefixes)
$summary = [ordered]@{
  RecordedAt = Get-Date -Format o
  Mode = if ($Apply) { 'apply' } else { 'preview' }
  ServerPid = $serverProcessId
  SupervisorPids = @($supervisors.ProcessId)
  BeforeFiles = $snapshot.Count
  DuplicateFailures = $duplicates.Count
  FirstDuplicate = if ($duplicates.Count) { $duplicates[0].Name } else { $null }
  LastDuplicate = if ($duplicates.Count) { $duplicates[-1].Name } else { $null }
  ServerRunsByDate = @($snapshot | Where-Object { $_.Name -match '^server-run-\d{8}-\d{6}\.(out|err)\.log$' } |
    Group-Object { $_.Name.Substring(11, 8) } | Sort-Object Name | Select-Object Name, Count)
  TunnelRunsByDate = @($snapshot | Where-Object { $_.Name -match '^tunnel-run-\d{8}-\d{6}\.(out|err)\.log$' } |
    Group-Object { $_.Name.Substring(11, 8) } | Sort-Object Name | Select-Object Name, Count)
  ProtectedPrefixes = $protectedPrefixes
}
if (-not $Apply) {
  $summary | ConvertTo-Json -Depth 5
  Write-Host 'Preview only. Use -Apply to reload the server supervisor and remove redundant/old run logs.'
  exit 0
}

$auditPath = Join-Path $logRoot ("cleanup-audit-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $auditPath -Encoding UTF8
foreach ($supervisor in $supervisors) {
  # Only reload the exact supervisor script; leave the serving node and tunnel alive.
  Stop-Process -Id $supervisor.ProcessId -Force
}
$replacement = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisorPath`"") `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
if ((Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object -First 1).OwningProcess -ne $serverProcessId) {
  throw 'The serving process changed unexpectedly; log deletion was not started.'
}

$removedDuplicates = 0
foreach ($errorFile in $duplicates) {
  $runPrefix = $errorFile.Name.Substring(0, 26)
  if ($runPrefix -in $protectedPrefixes) { continue }
  foreach ($streamKind in @('err', 'out')) {
    $candidatePath = [IO.Path]::GetFullPath((Join-Path $logRoot "$runPrefix.$streamKind.log"))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($candidatePath), $logRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Cleanup path escaped the service log directory: $candidatePath"
    }
    if (-not (Test-Path -LiteralPath $candidatePath)) { continue }
    if ($streamKind -eq 'out') {
      try { $lines = @([IO.File]::ReadAllLines($candidatePath) | Where-Object { $_.Trim().Length }) } catch { continue }
      if ($lines.Count -gt 2) { continue }
    }
    try { Remove-Item -LiteralPath $candidatePath -Force; $removedDuplicates++ } catch {}
  }
}
$removedOld = Remove-ServiceRunLogs -Directory $logRoot -KeepRuns 10 -KeepDays 14 -ProtectedPrefixes $protectedPrefixes
$summary['RemovedDuplicateFiles'] = $removedDuplicates
$summary['RemovedOldFiles'] = $removedOld
$summary['AfterFiles'] = @(Get-ChildItem -LiteralPath $logRoot -File).Count
$summary['LocalHealthy'] = (Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 5).ok
$summary['ReplacementSupervisorPid'] = $replacement.Id
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $auditPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 5
Write-Host "Audit saved: $auditPath"
