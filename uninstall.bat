@echo off
rem Stops the background ZeroCode and removes its Startup shortcut. Config in data\ is kept.
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
powershell -NoProfile -Command ^
  "$l = [Environment]::GetFolderPath('Startup') + '\ZeroCode.lnk'; if (Test-Path $l) { Remove-Item $l; 'Removed auto-start.' } else { 'No auto-start entry found.' }"

echo.
pause
