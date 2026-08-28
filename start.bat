@echo off
title Dual-Agent Studio
echo ================================================================
echo  Starting Dual-Agent Studio Web Cockpit...
echo ================================================================

REM Proxy configuration for AI Engines & Git
if "%http_proxy%"=="" set http_proxy=http://127.0.0.1:10809
if "%https_proxy%"=="" set https_proxy=http://127.0.0.1:10809
echo  Proxy configured: %http_proxy%

start http://localhost:3700
node "%~dp0server.js"
pause