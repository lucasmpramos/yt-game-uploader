@echo off
rem Opens GameUploader in a Windows Terminal tab. run.bat keeps it alive (auto-restart on crash).
rem Note: Windows Terminal needs "cmd.exe" spelled out here - a bare "cmd" is silently ignored.
rem For auto-start with Windows, put a copy in shell:startup with absolute paths.
start "" wt.exe -d "%~dp0" --title GameUploader cmd.exe /c "%~dp0run.bat"
