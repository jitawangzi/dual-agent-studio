#requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'orchestrator-lib.ps1')
try {
    $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -AsHashtable
    $arguments = @{
        Provider = $request['provider']; Prompt = $request['prompt']; WorkspaceRoot = $request['workspaceRoot']
        Model = $request['model']; ReasoningEffort = $request['reasoningEffort']; SessionId = $request['sessionId']
        Role = $request['role']
    }
    if ($request['sessionDirectory']) { $arguments.SessionDirectory = $request['sessionDirectory'] }
    $answer = Invoke-AgentText @arguments
    [IO.File]::WriteAllText($OutputPath, [string]$answer, [Text.UTF8Encoding]::new($false))
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
