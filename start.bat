@echo off
title Dual-Agent Studio
echo ================================================================
echo  Starting Dual-Agent Studio Web Cockpit...
echo ================================================================

REM Proxy: inherit ambient env; default 10809 unless DUAL_AGENT_NO_PROXY=1
if "%DUAL_AGENT_NO_PROXY%"=="1" (
    echo  Proxy injection skipped ^(DUAL_AGENT_NO_PROXY=1^).
) else (
    if "%http_proxy%"=="" set http_proxy=http://127.0.0.1:10809
    if "%https_proxy%"=="" set https_proxy=http://127.0.0.1:10809
    echo  Proxy configured: %http_proxy%
)

REM Clean up any stale process occupying port 3700
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3700 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

start http://localhost:3700
node --watch "%~dp0server.js"
pause