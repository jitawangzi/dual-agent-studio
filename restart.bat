@echo off
title Restarting Dual-Agent Studio...
echo ================================================================
echo  Stopping and Restarting Dual-Agent Studio...
echo ================================================================

REM Kill existing process on port 3700
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3700 ^| findstr LISTENING') do (
    echo Stopping process PID: %%a
    taskkill /f /pid %%a >nul 2>&1
)

REM Proxy configuration
if "%http_proxy%"=="" set http_proxy=http://127.0.0.1:10809
if "%https_proxy%"=="" set https_proxy=http://127.0.0.1:10809

echo Starting backend server...
start http://localhost:3700
node --watch "%~dp0server.js"
pause
