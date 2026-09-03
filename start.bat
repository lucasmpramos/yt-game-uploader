@echo off
rem Starts GameUploader: a hidden background process (watcher, uploads, tray icon) that opens the
rem terminal UI in its own Windows Terminal window. If it is already running, this just opens the window.
rem "Start with Windows" in the tray menu installs a launcher in shell:startup.
wscript.exe "%~dp0daemon.vbs"
