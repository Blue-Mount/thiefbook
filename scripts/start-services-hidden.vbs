Option Explicit

Dim shell, fileSystem, scriptDir

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)

shell.Run "wscript.exe """ & fileSystem.BuildPath(scriptDir, "start-server-hidden.vbs") & """", 0, False
shell.Run "wscript.exe """ & fileSystem.BuildPath(scriptDir, "start-tunnel-hidden.vbs") & """", 0, False
WScript.Quit 0
