#requires -Version 7.0
$testScript = Join-Path $PSScriptRoot "..\tests\orchestrator.tests.ps1"
if (Test-Path -LiteralPath $testScript) {
    pwsh -NoProfile -File $testScript
} else {
    Write-Host "No tests found in $PSScriptRoot."
    exit 0
}