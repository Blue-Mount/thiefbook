Option Explicit

Dim shell, fileSystem, scriptDir, supervisorPath

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
supervisorPath = fileSystem.BuildPath(scriptDir, "supervise-server.ps1")

If Not fileSystem.FileExists(supervisorPath) Then WScript.Quit 2

shell.CurrentDirectory = scriptDir
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & supervisorPath & """", 0, False
WScript.Quit 0
