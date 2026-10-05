@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\setup.ps1"
if errorlevel 1 (
  echo Setup failed. Existing containers were not stopped.
)
pause
