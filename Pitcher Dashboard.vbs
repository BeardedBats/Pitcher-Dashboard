Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
batPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\start-dashboard.bat"
WshShell.Run Chr(34) & batPath & Chr(34), 0, False
