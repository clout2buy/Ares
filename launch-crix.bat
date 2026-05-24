@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Crix Coding Harness

echo Starting Crix coding harness...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crix.ps1" cli %*
set "CRIX_EXIT=%ERRORLEVEL%"

echo.
if "%CRIX_EXIT%"=="0" (
  echo Crix closed.
) else (
  echo Crix exited with code %CRIX_EXIT%.
)
echo Press any key to close this window...
pause >nul
exit /b %CRIX_EXIT%
