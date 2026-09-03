@echo off
rem Runs GameUploader and restarts it if it crashes (or asks for a restart).
rem   run.bat            standalone (UI + everything in this window)
rem   run.bat --daemon   background process (no UI; opens the terminal UI + tray icon itself)
rem   exit code 0 = quit (Ctrl+C / tray Quit)  -> stop
rem   exit code 3 = [R] restart requested      -> restart immediately
rem   anything else = crash                    -> restart after 5 seconds
cd /d "%~dp0"
title gu-daemon
set GAMEUPLOADER_LOOP=1
:loop
node index.js %*
if "%errorlevel%"=="0" exit /b 0
if "%errorlevel%"=="3" goto loop
echo.
echo GameUploader stopped unexpectedly (exit code %errorlevel%). Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
