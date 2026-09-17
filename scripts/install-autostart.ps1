$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $PSScriptRoot 'start-services-hidden.vbs'
$shortcutPath = Join-Path $startupDir 'ThiefBook Services.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = 'Start the resilient thiefBook server and public tunnel'
$shortcut.Save()

Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$launcher`"" -WindowStyle Hidden
Write-Host "Installed startup shortcut: $shortcutPath"
