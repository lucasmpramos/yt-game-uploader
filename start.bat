@echo off
rem Opens GameUploader in its own Windows Terminal window (-w GameUploader, so hiding it to the tray
rem never touches your other terminal tabs). run.bat keeps it alive (auto-restart on crash).
rem Note: Windows Terminal needs "cmd.exe" spelled out here - a bare "cmd" is silently ignored.
rem "Start with Windows" in the tray menu installs a copy of this into shell:startup.
start "" wt.exe -w GameUploader -d "%~dp0" --title GameUploader cmd.exe /c "%~dp0run.bat"
