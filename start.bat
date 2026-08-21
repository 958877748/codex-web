@echo off
setlocal
title Codex Web Panel
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

echo Stopping any existing instance on port 4000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4000 " ^| findstr "LISTENING"') do (
  taskkill /pid %%a /f >nul 2>&1
)

echo.
echo Starting Codex Web Panel...
echo.
node server.js

echo.
echo Server stopped. Press any key to close.
pause
