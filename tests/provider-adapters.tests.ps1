#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../engine/orchestrator-lib.ps1')
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('studio-adapter-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testDir)
try {
    function Get-Command { [CmdletBinding()] param([string[]]$Name) return [pscustomobject]@{ Source = 'fake-agent.exe' } }
    function Invoke-CliWithTimeout {
        param($ExecutablePath, $Arguments, $StdinText, $WorkingDirectory, $EnvironmentVariables, $RoleName)
        if ($StdinText -ne "Line one`n`"quoted`" line two") { throw 'Multiline prompt was changed' }
        return @{ ExitCode = 7; Stdout = '{"verdict":"APPROVED"}'; Stderr = 'CLI crashed' }
    }
    $failed = $false
    try {
        Invoke-AgentText -Provider copilot -Prompt "Line one`n`"quoted`" line two" -WorkspaceRoot $testDir -SessionDirectory $testDir -Role review
    } catch { $failed = $_.Exception.Message -match 'AGENT_EXECUTION_FAILED' }
    if (-not $failed) { throw 'A crashed CLI emitting APPROVED must never be accepted' }
    function Invoke-CliWithTimeout {
        param($ExecutablePath, $Arguments, $StdinText, $WorkingDirectory, $EnvironmentVariables, $RoleName)
        if ($Arguments -notcontains '--available-tools') { throw 'Audit must filter the complete tool surface, including MCP tools' }
        $toolIndex = [Array]::IndexOf($Arguments, '--available-tools')
        if ($Arguments[$toolIndex + 1] -ne 'view' -or $Arguments[$toolIndex + 2] -ne 'grep' -or $Arguments[$toolIndex + 3] -ne 'glob') { throw 'Audit must offer read-only source inspection tools' }
        return @{ ExitCode = 0; Stdout = '{"summary":"read-only"}'; Stderr = '' }
    }
    $null = Invoke-AgentText -Provider copilot -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role audit
    $null = Invoke-AgentText -Provider copilot -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role verify-finding
    $null = Invoke-AgentText -Provider copilot -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role plan-propose
    function Invoke-CliWithTimeout {
        param($ExecutablePath, $Arguments, $StdinText, $WorkingDirectory, $EnvironmentVariables, $RoleName)
        if ($Arguments -notcontains '--strict-mcp-config') { throw 'Claude audit must exclude configured MCP tools' }
        return @{ ExitCode = 0; Stdout = '{"summary":"read-only"}'; Stderr = '' }
    }
    $null = Invoke-AgentText -Provider claude -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role audit
    $null = Invoke-AgentText -Provider claude -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role verify-finding
    $null = Invoke-AgentText -Provider claude -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role plan-challenge
    $script:listedMcp = $false
    function Invoke-CliWithTimeout {
        param($ExecutablePath, $Arguments, $StdinText, $WorkingDirectory, $EnvironmentVariables, $RoleName)
        if ($Arguments[0] -eq 'mcp') {
            if ($Arguments -notcontains 'features.plugins=false' -or $Arguments -notcontains 'features.apps=false') { throw 'Inventory must exclude plugin-injected MCP entries before per-server overrides' }
            $script:listedMcp = $true
            return @{ ExitCode = 0; Stdout = '[{"name":"filesystem","enabled":true}]'; Stderr = '' }
        }
        if (-not $script:listedMcp -or $Arguments -notcontains 'mcp_servers.filesystem.enabled=false' -or $Arguments -notcontains 'features.apps=false' -or $Arguments -notcontains 'features.plugins=false' -or $Arguments -notcontains 'features.in_app_browser=false') { throw 'Codex audit must disable discovered MCP servers and app/plugin/browser tools' }
        $outputIndex = [Array]::IndexOf($Arguments, '--output-last-message')
        [IO.File]::WriteAllText($Arguments[$outputIndex + 1], '{"summary":"read-only"}')
        return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
    }
    $null = Invoke-AgentText -Provider codex -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role audit
    $script:listedMcp = $false
    $null = Invoke-AgentText -Provider codex -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role verify-finding
    $script:listedMcp = $false
    $null = Invoke-AgentText -Provider codex -Prompt 'Inspect only' -WorkspaceRoot $testDir -SessionDirectory $testDir -Role plan-investigate
    Write-Host 'Provider failure and multiline stdin tests passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($testDir)
    if ([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetTempPath().TrimEnd('\','/')) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
