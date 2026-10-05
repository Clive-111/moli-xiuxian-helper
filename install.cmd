@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/
  pause
  exit /b 1
)
set "npm_config_cache=%~dp0work\npm-cache"
set "TEMP=%~dp0work\tmp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
call npm ci
if errorlevel 1 (
  echo Installation failed. Read the error above.
  pause
  exit /b 1
)
echo Installed. Chrome is the default browser. Run start.cmd and open http://localhost:7081
pause
