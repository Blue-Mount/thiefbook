Option Explicit

Dim shell, fileSystem, scriptDir, watchdogPath

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
watchdogPath = fileSystem.BuildPath(scriptDir, "watchdog-services.ps1")

If Not fileSystem.FileExists(watchdogPath) Then WScript.Quit 2

shell.CurrentDirectory = scriptDir
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & watchdogPath & """", 0, False
WScript.Quit 0
