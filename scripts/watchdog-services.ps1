$ErrorActionPreference = 'Continue'

$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$watchdogLog = Join-Path $logDir 'watchdog.log'
$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, 'Local\ThiefBookServicesWatchdog', [ref]$createdNew)

if (-not $createdNew) { exit 0 }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-WatchdogLog([string]$message) {
  Add-Content -LiteralPath $watchdogLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

function Test-SupervisorRunning([string]$scriptName) {
  $match = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Name -notin @('powershell.exe', 'pwsh.exe')) { return $false }
    $commandLine = [string]$_.CommandLine
    return $commandLine -match "(?i)-File\s+(?:`"[^`"]*\\)?$([regex]::Escape($scriptName))`"?(?:\s|$)"
  } | Select-Object -First 1
  return [bool]$match
}

function Start-Supervisor([string]$scriptName) {
  $scriptPath = Join-Path $PSScriptRoot $scriptName
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-WatchdogLog "missing supervisor: $scriptPath"
    return
  }

  Write-WatchdogLog "starting missing supervisor: $scriptName"
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"") `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}

Write-WatchdogLog "watchdog started pid=$PID"
while ($true) {
  foreach ($scriptName in @('supervise-server.ps1', 'supervise-tunnel.ps1')) {
    if (-not (Test-SupervisorRunning $scriptName)) {
      Start-Supervisor $scriptName
    }
  }
  Start-Sleep -Seconds 15
}
