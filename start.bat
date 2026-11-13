@echo off
cd /d "%~dp0"
title Content Agent Board

rem --no-browser : start the server only, do not open the browser
rem               (used by the auto-start shortcut in shell:startup)
set "OPEN_BROWSER=1"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER=0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js first.
  if "%OPEN_BROWSER%"=="1" pause
  exit /b 1
)

rem If the dev server is already running, do not start a second instance.
powershell -NoProfile -Command "if((Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)){exit 0}else{exit 1}"
if errorlevel 1 goto :port_free

echo Dev server is already running.
if "%OPEN_BROWSER%"=="1" (
  echo Opening browser...
  start "" http://localhost:3000
)
exit /b 0

:port_free
if not exist node_modules (
  echo Installing dependencies, this may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    if "%OPEN_BROWSER%"=="1" pause
    exit /b 1
  )
)

echo Starting dev server...
if "%OPEN_BROWSER%"=="0" goto :run_server

rem Poll port 3000 in background, open the browser once it responds.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='http://localhost:3000'; for($i=0;$i -lt 90;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process $u; break } }catch{}; Start-Sleep -Milliseconds 1000 }"

:run_server
npm run dev
echo.
echo Dev server stopped.
if "%OPEN_BROWSER%"=="1" pause
