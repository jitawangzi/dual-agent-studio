#requires -Version 7.0
Write-Host "Starting Dual-Agent Studio..." -ForegroundColor Cyan
Start-Process "http://localhost:3700"
node (Join-Path $PSScriptRoot "server.js")