@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4317 in your browser after the server starts.
if not exist node_modules\ws\package.json (
  echo Installing the locked local audio transport dependency from npm...
  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Please check the network and run npm ci --ignore-scripts.
    pause
    exit /b 1
  )
)
echo Press Ctrl+C to stop.
node src\main.js
if errorlevel 1 pause
