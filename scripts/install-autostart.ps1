$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$services = @(
  @{
    TaskName = 'ThiefBook Server'
    Script = 'supervise-server.ps1'
    Description = 'Resilient ThiefBook local web and sync server on port 8787'
  }
)

foreach ($service in $services) {
  $scriptPath = Join-Path $PSScriptRoot $service.Script
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Supervisor script was not found: $scriptPath"
  }

  # Keep the long-lived supervisor attached to Task Scheduler. If it exits,
  # Windows can detect the failure and apply RestartOnFailure.
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $projectRoot
  Register-ScheduledTask -TaskName $service.TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description $service.Description -Force | Out-Null
  Enable-ScheduledTask -TaskName $service.TaskName | Out-Null
  Start-ScheduledTask -TaskName $service.TaskName
  Write-Host "Installed and started scheduled task: $($service.TaskName)"
}

# devtunnel authentication requires the signed-in desktop session. Start a
# persistent watchdog from the Startup folder; it owns and relaunches both
# supervisors while the user is logged in.
$tunnelTask = Get-ScheduledTask -TaskName 'ThiefBook Public Tunnel' -ErrorAction SilentlyContinue
if ($tunnelTask) {
  Stop-ScheduledTask -TaskName 'ThiefBook Public Tunnel' -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName 'ThiefBook Public Tunnel' | Out-Null
}

$launcher = Join-Path $PSScriptRoot 'start-services-hidden.vbs'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ThiefBook Services.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startupShortcut)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Start the resilient ThiefBook services watchdog after sign-in'
$shortcut.Save()

Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
  -Name 'ThiefBookPublicTunnel' -ErrorAction SilentlyContinue
Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$launcher`"" -WindowStyle Hidden

Write-Host "Installed desktop-session watchdog: $startupShortcut"
Write-Host 'Services will start automatically after user sign-in.'
