@echo off
chcp 65001 >nul
cd /d "%~dp0"
node -v >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 24，然后重新双击此文件。
  pause
  exit /b 1
)
node scripts\acceptance.js %*
set "acceptance_exit=%errorlevel%"
pause
exit /b %acceptance_exit%
