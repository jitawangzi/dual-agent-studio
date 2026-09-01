#requires -Version 7.0
Write-Host "Starting Dual-Agent Studio..." -ForegroundColor Cyan

if ($env:DUAL_AGENT_NO_PROXY -eq "1") {
    Write-Host "Proxy injection skipped (DUAL_AGENT_NO_PROXY=1)." -ForegroundColor Gray
} elseif ([string]::IsNullOrWhiteSpace($env:http_proxy)) {
    $env:http_proxy = "http://127.0.0.1:10809"
    $env:https_proxy = "http://127.0.0.1:10809"
    Write-Host "Proxy configured: $env:http_proxy" -ForegroundColor Gray
} else {
    Write-Host "Proxy configured: $env:http_proxy" -ForegroundColor Gray
}

# Clean up any existing process listening on port 3700
Get-NetTCPConnection -LocalPort 3700 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    if ($_ -gt 0) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

Start-Process "http://localhost:3700"
node --watch (Join-Path $PSScriptRoot "server.js")