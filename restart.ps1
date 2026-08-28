#requires -Version 7.0
Write-Host "Stopping and Restarting Dual-Agent Studio..." -ForegroundColor Cyan

# Kill existing process on port 3700
Get-NetTCPConnection -LocalPort 3700 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    if ($_ -gt 0) {
        Write-Host "Stopping process PID: $_" -ForegroundColor Yellow
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
}

if ([string]::IsNullOrWhiteSpace($env:http_proxy)) { $env:http_proxy = "http://127.0.0.1:10809" }
if ([string]::IsNullOrWhiteSpace($env:https_proxy)) { $env:https_proxy = "http://127.0.0.1:10809" }
Write-Host "Proxy configured: $env:http_proxy" -ForegroundColor Gray

Start-Process "http://localhost:3700"
node --watch (Join-Path $PSScriptRoot "server.js")
