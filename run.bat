@echo off
rem Runs ZeroCode in this window (Ctrl+C to stop). Use install.bat to run it in the background instead.
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo Node.js 18+ not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :fail
)

echo Building...
call npm run build || goto :fail

node dist\index.js
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
