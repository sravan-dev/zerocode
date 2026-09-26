@echo off
rem Installs ZeroCode as a background app: builds it, starts it hidden,
rem and adds a Startup shortcut so it runs at every Windows logon.
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo Node.js 18+ not found. Install it from https://nodejs.org and run this again.
  goto :fail
)

echo [1/4] Installing dependencies...
call npm install --no-audit --no-fund || goto :fail

echo [2/4] Building...
call npm run build || goto :fail

echo [3/4] Registering auto-start at logon...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\ZeroCode.lnk');" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = '\"%~dp0scripts\zerocode-hidden.vbs\"';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.Description = 'ZeroCode AI gateway';" ^
  "$s.Save()" || goto :fail

echo [4/4] Starting in background...
start "" wscript.exe "%~dp0scripts\zerocode-hidden.vbs"

powershell -NoProfile -Command ^
  "for ($i = 0; $i -lt 15; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3777/ > $null; exit 0 } catch { Start-Sleep 1 } }; exit 1"
if errorlevel 1 (
  echo.
  echo Started, but no answer on port 3777 yet. Check data\zerocode.log
) else (
  echo.
  echo ZeroCode is running in the background.
  echo   Dashboard : http://127.0.0.1:3777
)
echo   Logs      : %~dp0data\zerocode.log
echo   Remove    : uninstall.bat
echo.
pause
exit /b 0

:fail
echo.
echo Install failed.
pause
exit /b 1
