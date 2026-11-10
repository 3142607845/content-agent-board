@echo off
cd /d "%~dp0"
title Content Agent Board

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js first.
  pause
  exit /b 1
)

rem If the dev server is already running, just open the browser.
powershell -NoProfile -Command "if((Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo Dev server is already running, opening browser...
  start "" http://localhost:3000
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies, this may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo Starting dev server...
rem Poll port 3000 in background, open the browser once it responds.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='http://localhost:3000'; for($i=0;$i -lt 90;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process $u; break } }catch{}; Start-Sleep -Milliseconds 1000 }"

npm run dev
echo.
echo Dev server stopped.
pause
