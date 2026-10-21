@echo off
setlocal enabledelayedexpansion
title AutoCut Studio - Local Automatic Video Editor

cd /d "%~dp0"

echo.
echo  ==========================================================
echo    AutoCut Studio  ^|  Local Automatic Video Editor
echo  ==========================================================
echo.

REM --- locate node ---
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  echo  [ERROR] Node.js was not found on your PATH.
  echo          Install Node.js 20+ from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
echo  [ok] Node.js !NODE_VER!

REM --- check vendor ffmpeg ---
if exist "vendor\ffmpeg.exe" (
  echo  [ok] FFmpeg found in vendor\
) else (
  echo  [..] FFmpeg not vendored yet - running setup...
  call npm run setup:ffmpeg
)

REM --- install deps if needed ---
if not exist "node_modules\express" (
  echo  [..] Installing dependencies - first run only...
  call npm install --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo  [ERROR] Dependency installation failed.
    echo.
    pause
    exit /b 1
  )
)

REM --- port check: reuse a running instance, otherwise report clearly ---
set "PORT=3210"
set "URL=http://127.0.0.1:%PORT%"

REM If an AutoCut Studio server is already running, just open the browser.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%URL%/api/health' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL%==0 (
  echo  [ok] AutoCut Studio is already running.
  echo.
  start "" "%URL%"
  echo  Browser opened. This window can be closed.
  timeout /t 3 >nul
  exit /b 0
)

REM The port is taken by something else. Report it and exit instead of killing
REM an unrelated process.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
if %ERRORLEVEL%==1 (
  echo  [ERROR] Port %PORT% is in use by another program.
  echo          Close it, or start the server on a different port:
  echo              set PORT=3211 ^&^& node server\index.js
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting AutoCut Studio...
echo  Open your browser at:  %URL%
echo.
echo  (Press Ctrl+C in this window to stop the server.)
echo  ==========================================================
echo.

start "" "%URL%"

node server\index.js

echo.
echo  AutoCut Studio has stopped.
pause
