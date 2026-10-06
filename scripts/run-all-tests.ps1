#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    npm test
    $testExitCode = $LASTEXITCODE
    if ($testExitCode -ne 0) { exit $testExitCode }
} finally { Pop-Location }
