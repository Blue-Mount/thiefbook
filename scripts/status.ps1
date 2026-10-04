$ErrorActionPreference = 'Continue'

$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$checks = @(
  @{ Name = 'local'; Url = 'http://127.0.0.1:8787/api/health' },
  @{ Name = 'public'; Url = 'https://vjqm1hqc-8787.jpe1.devtunnels.ms/api/health' }
)

$processes = Get-CimInstance Win32_Process
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ThiefBook Services.lnk'
$scheduledTasks = @{}
foreach ($taskName in @('ThiefBook Server', 'ThiefBook Public Tunnel')) {
  $scheduledTasks[$taskName] = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function Test-SupervisorRunning([string]$scriptName) {
  return [bool]($processes | Where-Object {
    if ($_.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }

    $commandLine = [string]$_.CommandLine
    $fileMatch = [regex]::Match($commandLine, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
    if (-not $fileMatch.Success) { return $false }

    $fileArgument = if ($fileMatch.Groups[1].Success) {
      $fileMatch.Groups[1].Value
    } else {
      $fileMatch.Groups[2].Value
    }

    try {
      return [string]::Equals(
        [IO.Path]::GetFileName($fileArgument),
        $scriptName,
        [StringComparison]::OrdinalIgnoreCase
      )
    } catch [ArgumentException] {
      return $false
    }
  } | Select-Object -First 1)
}

function Get-AutostartStatus([string]$taskName) {
  $task = $scheduledTasks[$taskName]
  if (-not $task) { return 'MISSING' }
  if (-not $task.Settings.Enabled) { return 'DISABLED' }
  return 'INSTALLED'
}

$components = @(
  [pscustomobject]@{
    Component = 'server'
    Supervisor = if (Test-SupervisorRunning 'supervise-server.ps1') { 'RUNNING' } else { 'STOPPED' }
    Autostart = Get-AutostartStatus 'ThiefBook Server'
  },
  [pscustomobject]@{
    Component = 'tunnel'
    Supervisor = if (Test-SupervisorRunning 'supervise-tunnel.ps1') { 'RUNNING' } else { 'STOPPED' }
    Autostart = if (Test-Path -LiteralPath $startupShortcut) { 'INSTALLED' } else { 'MISSING' }
  }
)
$components | Format-Table -AutoSize

foreach ($check in $checks) {
  try {
    $result = Invoke-RestMethod -Uri $check.Url -TimeoutSec 15
    Write-Host ("{0,-7} OK  {1}" -f $check.Name, ($result | ConvertTo-Json -Compress)) -ForegroundColor Green
  } catch {
    Write-Host ("{0,-7} FAIL  {1}" -f $check.Name, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host "Logs: $logDir"
Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 8 Name, Length, LastWriteTime |
  Format-Table -AutoSize
