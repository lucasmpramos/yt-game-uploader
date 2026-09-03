' Starts the GameUploader background process with no visible window.
' run.bat keeps it alive (auto-restart on crash); the process itself opens the terminal UI and the tray icon.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd.exe /c """ & dir & "\run.bat"" --daemon", 0, False
