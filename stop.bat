@echo off
rem Stops the running ZeroCode (background process). Keeps auto-start and config.
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"

echo.
pause
