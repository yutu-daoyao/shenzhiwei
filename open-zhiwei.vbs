Option Explicit
Dim shell, files, root, script, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
script = files.BuildPath(root, "scripts\open-zhiwei.ps1")
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """"
shell.Run command, 0, False
