@echo off
setlocal EnableExtensions
set "ARES_CALLER_CWD=%CD%"
cd /d "%~dp0"
title Ares Provider Launcher
set "ARES_PAUSE="
if "%~1"=="" set "ARES_PAUSE=1"
if /I "%~1"=="cli" set "ARES_PAUSE=1"
if /I "%~1"=="shell" set "ARES_PAUSE=1"
where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell is required to launch Ares.
  echo Install PowerShell or run: pnpm ares -- help
  pause >nul
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ares.ps1" %*
set "ARES_EXIT=%ERRORLEVEL%"
if not "%ARES_EXIT%"=="0" set "ARES_PAUSE=1"
if defined ARES_PAUSE (
  echo.
  echo Press any key to close Ares...
  pause >nul
)
exit /b %ARES_EXIT%
