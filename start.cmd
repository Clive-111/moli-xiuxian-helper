@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer first.
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo Run install.cmd first.
  pause
  exit /b 1
)
echo Open the control URL printed below. Default: http://localhost:7081
node src\main.js
pause
