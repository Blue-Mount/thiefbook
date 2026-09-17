$ErrorActionPreference = 'Continue'

$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ThiefBook Services.lnk'
$checks = @(
  @{ Name = 'local'; Url = 'http://127.0.0.1:8787/api/health' },
  @{ Name = 'public'; Url = 'https://vjqm1hqc-8787.jpe1.devtunnels.ms/api/health' }
)

$processes = Get-CimInstance Win32_Process
$components = @(
  [pscustomobject]@{
    Component = 'server'
    Supervisor = if ($processes.CommandLine -match 'supervise-server\.ps1') { 'RUNNING' } else { 'STOPPED' }
    Autostart = if (Test-Path -LiteralPath $startupShortcut) { 'INSTALLED' } else { 'MISSING' }
  },
  [pscustomobject]@{
    Component = 'tunnel'
    Supervisor = if ($processes.CommandLine -match 'supervise-tunnel\.ps1') { 'RUNNING' } else { 'STOPPED' }
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
