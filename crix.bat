@echo off
setlocal EnableExtensions
set "CRIX_CALLER_CWD=%CD%"
cd /d "%~dp0"
title Crix Provider Launcher
set "CRIX_PAUSE="
if "%~1"=="" set "CRIX_PAUSE=1"
if /I "%~1"=="cli" set "CRIX_PAUSE=1"
if /I "%~1"=="shell" set "CRIX_PAUSE=1"
where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell is required to launch Crix.
  echo Install PowerShell or run: pnpm crix -- help
  pause >nul
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crix.ps1" %*
set "CRIX_EXIT=%ERRORLEVEL%"
if not "%CRIX_EXIT%"=="0" set "CRIX_PAUSE=1"
if defined CRIX_PAUSE (
  echo.
  echo Press any key to close Crix...
  pause >nul
)
exit /b %CRIX_EXIT%
