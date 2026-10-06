#requires -Version 7.0
param([Parameter(Mandatory)][ValidateSet('codex','claude','copilot','pi')][string]$Provider)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'orchestrator-lib.ps1')
$names = if ($Provider -eq 'claude') { @('claude.exe','claude','claude.ps1','claude.cmd') } else { @($Provider,"$Provider.ps1","$Provider.cmd") }
$command = Get-Command $names -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $command) { @{ ok=$false; code='CLI_MISSING'; version=''; auth='UNKNOWN' } | ConvertTo-Json -Compress; exit 0 }
function Run-Check([string[]]$Arguments) {
    Invoke-CliWithTimeout -ExecutablePath $command.Source -Arguments $Arguments -StdinText '' -WorkingDirectory ([IO.Path]::GetTempPath()) -RoleName 'Environment check' -TimeoutSeconds 15 6>$null 3>$null
}
try {
    $version = Run-Check @('--version')
    $helpArgs = if ($Provider -eq 'codex') { @('exec','--help') } else { @('--help') }
    $help = Run-Check $helpArgs
    $required = switch ($Provider) {
        'codex' { @('--json','--config','--output-last-message','--skip-git-repo-check') }
        'claude' { @('--print','--tools','--strict-mcp-config','--model','--effort') }
        'copilot' { @('--deny-tool','--available-tools','--model','--reasoning-effort','--session-id') }
        'pi' { @('--print','--tools','--model','--thinking','--session') }
    }
    $missing = @($required | Where-Object { -not $help.Stdout.Contains($_) })
    $ok = $version.ExitCode -eq 0 -and $help.ExitCode -eq 0 -and $missing.Count -eq 0
    $auth = 'UNKNOWN'
    # Never emit raw authentication output (it may contain account information).
    if ($Provider -eq 'codex') {
        $login = Run-Check @('login','status')
        if ($login.ExitCode -eq 0) { $auth = 'CONFIGURED' }
    } elseif ($Provider -eq 'claude') {
        $login = Run-Check @('auth','status')
        if ($login.ExitCode -eq 0) { $auth = 'CONFIGURED' }
    }
    $versionText = [regex]::Match($version.Stdout, '\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?').Value
    @{ ok=$ok; code=$(if ($ok) {'LOCAL_CHECK_PASSED'} else {'CLI_INCOMPATIBLE'}); version=$versionText; auth=$auth; missing=$missing } | ConvertTo-Json -Compress
} catch {
    @{ ok=$false; code='CLI_CHECK_FAILED'; version=''; auth='UNKNOWN' } | ConvertTo-Json -Compress
}
