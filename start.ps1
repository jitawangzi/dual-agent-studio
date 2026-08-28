#requires -Version 7.0
Write-Host "Starting Dual-Agent Studio..." -ForegroundColor Cyan

if ([string]::IsNullOrWhiteSpace($env:http_proxy)) { $env:http_proxy = "http://127.0.0.1:10809" }
if ([string]::IsNullOrWhiteSpace($env:https_proxy)) { $env:https_proxy = "http://127.0.0.1:10809" }
Write-Host "Proxy configured: $env:http_proxy" -ForegroundColor Gray

Start-Process "http://localhost:3700"
node (Join-Path $PSScriptRoot "server.js")