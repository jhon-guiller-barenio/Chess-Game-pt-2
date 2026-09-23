@echo off
cd /d "%~dp0"
title Chessroom - local server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js, then run this file again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm, then run this file again.
  pause
  exit /b 1
)
echo Installing game dependencies...
call npm install
if errorlevel 1 (
  echo Installation failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo Starting Chessroom at http://localhost:5173
echo Keep this window open while playing locally.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5173"
call npm run dev -- --host 127.0.0.1
pause
