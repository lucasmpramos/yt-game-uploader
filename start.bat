@echo off
rem Opens GameUploader in a Windows Terminal tab. run.bat keeps it alive (auto-restart on crash).
rem For auto-start with Windows, put a copy in shell:startup with the absolute path below.
start "" wt.exe -d "%~dp0" --title GameUploader cmd /c run.bat
