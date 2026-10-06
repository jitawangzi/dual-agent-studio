# Shared provider contract for discussion, implementation and review.
# Prompts always use stdin or a UTF-8 file, never a quoted command-line prompt.
function Invoke-AgentText {
    param(
        [Parameter(Mandatory)][string]$Provider, [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$WorkspaceRoot, [string]$Role = 'dev',
        [string]$Model, [string]$ReasoningEffort, [string]$SessionId,
        [string]$SessionDirectory = (Join-Path $PSScriptRoot '../.studio/sessions')
    )
    $providerName = $Provider.ToLowerInvariant()
    $readOnly = $Role -ne 'dev'
    if ($providerName -eq 'mock') {
        if ($Role -eq 'plan-investigate') {
            $sampleFile = Get-ChildItem -LiteralPath $WorkspaceRoot -File | Select-Object -First 1
            if (-not $sampleFile) { throw 'MOCK_INVESTIGATION_REQUIRES_FILE' }
            return (@{summary='Mock：仅枚举文件，不代表真实工程调查';observations=@(@{file=$sampleFile.Name;evidence='文件存在；Mock 未分析实现'});constraints=@('Mock 仅测试流程');questions=@('请确认这是流程演示，还是需要真实模型分析？')} | ConvertTo-Json -Depth 8 -Compress)
        }
        if ($Role -eq 'plan-propose') { return '{"summary":"Mock 方案演示","questions":[],"proposals":[{"title":"补充回归测试（演示）","approach":"由真实 Agent 调查后确定测试范围","benefits":"展示人工决策流程","risks":"Mock 未分析代码，不能作为真实实施依据","acceptance":[{"criterion":"真实 Agent 明确测试范围","verification":"人工核对源码证据和测试结果"}],"outOfScope":["未经调查的代码改动"]}]}' }
        if ($Role -eq 'plan-challenge') {
            $proposalLine = [regex]::Match($Prompt, '(?m)^Other proposals: (.+)$').Groups[1].Value
            $otherProposals = $proposalLine | ConvertFrom-Json
            $mockReviews = @($otherProposals | ForEach-Object { @{proposalId=$_.id;position='NEEDS_INFO';reason='Mock 未评估真实可行性，请调用真实模型'} })
            return (@{reviews=$mockReviews;questions=@()} | ConvertTo-Json -Depth 8 -Compress)
        }
        if ($Role -eq 'verify-finding') { return '{"verdict":"INSUFFICIENT_EVIDENCE","summary":"Mock verification only","evidence":"Mock does not inspect source","steps":["Use a real verifier to inspect source and reproduce"],"expected":"Real source evidence","actual":"No actual model verification","limitations":"Mock cannot establish whether the finding is valid","executionQuote":""}' }
        if ($Role -eq 'audit') { return '{"summary":"Mock audit: workflow verification only","scopeComplete":true,"coverage":["Mock scope; no real code review"],"findings":[]}' }
        if ($Role -eq 'review') {
            $criteriaLine = [regex]::Match($Prompt, '(?m)^Structured acceptance criteria: (.+)$').Groups[1].Value
            if ($criteriaLine) {
                $criteria = @($criteriaLine | ConvertFrom-Json)
                if ($criteria.Count -gt 0) {
                    return (@{verdict='NEEDS_DECISION';summary='Mock cannot verify real acceptance criteria';scopeComplete=$false;acceptanceComplete=$false;coverage=@('Mock workflow only');issues=@();verifications=@();acceptanceChecks=@($criteria | ForEach-Object { @{id=$_.id;result='BLOCKED';evidence='Mock does not inspect source or verify requirements'} })} | ConvertTo-Json -Depth 8 -Compress)
                }
            }
            return '{"verdict":"APPROVED","highestSeverity":"NONE","summary":"Mock review","scopeComplete":true,"acceptanceComplete":true,"coverage":["Mock scope"],"issues":[],"verifications":[],"nextPromptForDev":""}'
        }
        if ($Role -eq 'dev') { return '{"summary":"Mock implementation","needsDecision":false,"fixes":[]}' }
        return "Mock discussion. Inspect the project, compare options, and obtain human approval.`n[VERDICT: CONSENSUS_REACHED]"
    }
    $names = switch ($providerName) {
        'claude' { @('claude.exe', 'claude', 'claude.ps1', 'claude.cmd') }
        'copilot' { @('copilot', 'copilot.ps1', 'copilot.cmd') }
        'codex' { @('codex', 'codex.ps1', 'codex.cmd') }
        'antigravity' { @('agy', 'agy.exe') }
        'aider' { @('aider', 'aider.exe', 'aider.ps1', 'aider.cmd') }
        'pi' { @('pi', 'pi.ps1', 'pi.cmd') }
        'cursor' { @('agent', 'agent.exe', 'agent.ps1', 'agent.cmd') }
        default { throw "UNSUPPORTED_PROVIDER: $Provider" }
    }
    $command = Get-Command $names -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw "PROVIDER_UNAVAILABLE: $Provider CLI is not installed." }
    $sessionKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$WorkspaceRoot|$providerName|$SessionId|$Role")))
    [void][IO.Directory]::CreateDirectory($SessionDirectory)
    $sessionFile = Join-Path $SessionDirectory "$sessionKey.json"
    $nativeSession = $null
    if (Test-Path -LiteralPath $sessionFile) { $nativeSession = Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json }
    $arguments = @(); $envMap = @{}; $stdin = $Prompt
    $promptFile = $null; $lastMessageFile = $null
    try {
        switch ($providerName) {
            'claude' {
                $arguments = @('--print', '--dangerously-skip-permissions')
                if ($Model) { $arguments += @('--model', $Model) }
                if ($ReasoningEffort -in @('low','medium','high','xhigh','max')) { $arguments += @('--effort', $ReasoningEffort) }
                elseif ($ReasoningEffort -match '^\d+$') { $envMap['MAX_THINKING_TOKENS'] = $ReasoningEffort }
                elseif ($ReasoningEffort -in @('off', 'none')) { $envMap['MAX_THINKING_TOKENS'] = '0' }
                if ($SessionId) {
                    if ($nativeSession) { $arguments += @('--resume', $nativeSession.id) }
                    else { $arguments += @('--session-id', $SessionId) }
                }
                if ($readOnly) { $arguments += @('--tools', 'Read,Glob,Grep', '--strict-mcp-config') }
            }
            'copilot' {
                $arguments = @('-s', '--allow-all')
                if ($SessionId) { $arguments += "--session-id=$SessionId" }
                if ($Model) { $arguments += @('--model', $Model) }
                $effort = Format-CopilotReasoningEffort $ReasoningEffort
                if ($effort) { $arguments += @('--reasoning-effort', $effort) }
                if ($readOnly) { $arguments += @('--deny-tool', 'write', '--deny-tool', 'shell', '--available-tools', 'view', 'grep', 'glob') }
            }
            'codex' {
                $arguments = @('exec')
                if ($nativeSession) { $arguments += @('resume', $nativeSession.id) }
                $arguments += @('--json', '--skip-git-repo-check', '-c', 'approval_policy="never"')
                $sandbox = if ($readOnly) { 'read-only' } else { 'workspace-write' }
                $arguments += @('-c', "sandbox_mode=`"$sandbox`"")
                if ($Role -in @('audit','verify-finding') -or $Role -like 'plan-*') {
                    # Sandbox policy does not restrict MCP/app tools. Disable them for this
                    # invocation only; never rewrite the user's global CLI configuration.
                    $readOnlyOverrides = @('-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.in_app_browser=false', '-c', 'features.skill_mcp_dependency_install=false')
                    $inventory = Invoke-CliWithTimeout -ExecutablePath $command.Source -Arguments (@('mcp', 'list', '--json') + $readOnlyOverrides) -StdinText '' -WorkingDirectory $WorkspaceRoot -EnvironmentVariables $envMap -RoleName 'Audit MCP inventory' -TimeoutSeconds 60
                    if ($inventory.ExitCode -ne 0) { throw 'READ_ONLY_CONFIG_FAILED: Cannot enumerate Codex MCP servers.' }
                    $servers = ConvertFrom-Json -InputObject $inventory.Stdout -AsHashtable -NoEnumerate
                    if ($servers -isnot [array]) { throw 'READ_ONLY_CONFIG_FAILED: Invalid Codex MCP inventory.' }
                    foreach ($server in $servers) {
                        if ($server['name'] -notmatch '^[A-Za-z0-9_-]+$') { throw 'READ_ONLY_CONFIG_FAILED: Unsupported MCP server identifier.' }
                        $arguments += @('-c', "mcp_servers.$($server['name']).enabled=false")
                    }
                    $arguments += $readOnlyOverrides
                }
                if ($Model) { $arguments += @('--model', $Model) }
                $effort = Format-CopilotReasoningEffort $ReasoningEffort
                if ($effort) { $arguments += @('-c', "model_reasoning_effort=`"$effort`"") }
                $lastMessageFile = [IO.Path]::GetTempFileName()
                $arguments += @('--output-last-message', $lastMessageFile, '-')
            }
            'aider' {
                $promptFile = [IO.Path]::GetTempFileName()
                [IO.File]::WriteAllText($promptFile, $Prompt, [Text.UTF8Encoding]::new($false))
                $arguments = @('--message-file', $promptFile, '--yes-always', '--no-auto-commits')
                if ($Model) { $arguments += @('--model', $Model) }
                if ($readOnly) { $arguments += @('--chat-mode', 'ask') }
                $stdin = ''
            }
            'antigravity' {
                $arguments = @('--dangerously-skip-permissions', '--print-timeout', '25m', '--print', '')
                if ($Model) { $arguments += @('--model', $Model) }
                $effort = Format-AgyReasoningEffort $ReasoningEffort
                if ($effort) { $arguments += @('--effort', $effort) }
                if ($readOnly) { $arguments += @('--mode', 'plan') }
            }
            'pi' {
                $arguments = @('--print', '--session', (Join-Path $SessionDirectory "$sessionKey.pi.jsonl"))
                if ($Model) { $arguments += @('--model', $Model) }
                $effort = Format-CopilotReasoningEffort $ReasoningEffort
                if ($effort -eq 'none') { $effort = 'off' }
                if ($effort) { $arguments += @('--thinking', $effort) }
                if ($readOnly) { $arguments += @('--tools', 'read,grep,find,ls') }
            }
            'cursor' {
                $arguments = @('--print')
                if ($Model) { $arguments += @('--model', $Model) }
            }
        }
        $result = Invoke-CliWithTimeout -ExecutablePath $command.Source -Arguments $arguments -StdinText $stdin -WorkingDirectory $WorkspaceRoot -EnvironmentVariables $envMap -RoleName "$Role ($Provider)"
        # Check exit status BEFORE accepting even syntactically valid JSON.
        if ($result.ExitCode -ne 0) { throw "AGENT_EXECUTION_FAILED: $Provider exited $($result.ExitCode): $($result.Stderr)" }
        $answer = $result.Stdout.Trim()
        if ($providerName -eq 'codex') {
            $answer = [IO.File]::ReadAllText($lastMessageFile).Trim()
            foreach ($line in ($result.Stdout -split "`n")) {
                try {
                    $event = $line | ConvertFrom-Json -AsHashtable
                    if ($event.type -eq 'thread.started' -and $event.thread_id) {
                        Write-MailboxState -MailboxPath $sessionFile -StateObj @{ id = $event.thread_id }
                    }
                } catch { }
            }
        }
        if ($providerName -eq 'claude' -and $SessionId) { Write-MailboxState -MailboxPath $sessionFile -StateObj @{ id = $SessionId } }
        if ([string]::IsNullOrWhiteSpace($answer)) { throw "AGENT_OUTPUT_EMPTY: $Provider returned no answer." }
        return $answer
    } finally {
        foreach ($temporary in @($promptFile, $lastMessageFile)) {
            if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
}
