@echo off
title Dual-Agent Studio
echo ================================================================
echo  Starting Dual-Agent Studio Web Cockpit...
echo ================================================================
start http://localhost:3700
node "%~dp0server.js"
pause