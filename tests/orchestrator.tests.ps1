#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$StudioRoot = Split-Path -Parent $PSScriptRoot
$OrchestratorScript = Join-Path $StudioRoot "engine\orchestrator.ps1"

$OrchestratorLib = Join-Path $StudioRoot "engine\orchestrator-lib.ps1"
. $OrchestratorLib

$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("studio-orchestrator-tests-" + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($TestRoot) | Out-Null

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -cne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

try {
    Write-Host "Running Dual-Agent Studio Standalone Orchestrator & Library Tests..." -ForegroundColor Cyan

    # --- Section A: Direct Unit Tests for orchestrator-lib.ps1 ---
    Write-Host "Verifying orchestrator-lib.ps1 unit functions..." -ForegroundColor Cyan

    # A1. Format-CopilotReasoningEffort
    Assert-Equal (Format-CopilotReasoningEffort "high") "high" "Copilot high effort"
    Assert-Equal (Format-CopilotReasoningEffort "64000") "max" "Copilot max effort mapping"
    Assert-Equal (Format-CopilotReasoningEffort "off") "none" "Copilot off effort mapping"
    Assert-Equal (Format-CopilotReasoningEffort $null) $null "Copilot null effort"

    # A2. Format-AgyReasoningEffort
    Assert-Equal (Format-AgyReasoningEffort "high") "high" "Agy high effort"
    Assert-Equal (Format-AgyReasoningEffort "max") "high" "Agy max mapped to high"
    Assert-Equal (Format-AgyReasoningEffort "off") "" "Agy off mapped to empty"

    # A2.1 Format-ClaudeModel
    Assert-Equal (Format-ClaudeModel "claude-3-7-sonnet-20250219") "sonnet" "Claude 3.7 mapped to sonnet"
    Assert-Equal (Format-ClaudeModel "claude-sonnet-5") "sonnet" "Claude Sonnet 5 mapped to sonnet"
    Assert-Equal (Format-ClaudeModel "claude-opus-5") "opus" "Claude Opus 5 mapped to opus"
    Assert-Equal (Format-ClaudeModel "") "" "Empty model preserved"

    # A3. Extract-TestFailureSummary (8192 chars limit & keyword matching)
    $longLog = (1..500 | ForEach-Object { "Normal line $_" }) -join "`n"
    $longLog += "`nFAILED: AssertionError in module TestA line 42`n"
    $longLog += (501..1000 | ForEach-Object { "Normal line $_" }) -join "`n"
    $failureSummary = Extract-TestFailureSummary -TestOutput $longLog -MaxChars 8192
    Assert-True ($failureSummary.Length -le 8250) "Extract-TestFailureSummary should not exceed max characters"
    Assert-True ($failureSummary.Contains("FAILED: AssertionError in module TestA")) "Extract-TestFailureSummary must capture failed assertion line"

    # A4. Extract-JsonFromText
    $fencedJson = @(
        'Here is review:',
        '```json',
        '{',
        '  "verdict": "APPROVED",',
        '  "highestSeverity": "NONE",',
        '  "summary": "Looks great"',
        '}',
        '```'
    ) -join "`n"
    $parsedFenced = Extract-JsonFromText -Text $fencedJson
    $actualVerdict = [string]$parsedFenced.verdict
    Assert-Equal $actualVerdict "APPROVED" "Extract-JsonFromText markdown fenced json"

    # A5. Write-MailboxState and Read-MailboxState (explicit -MailboxPath)
    $testMbPath = Join-Path $TestRoot "direct_mb.json"
    $directMbObj = [ordered]@{ round = 1; status = "INITIALIZED"; devSessionId = "session-test" }
    Write-MailboxState -MailboxPath $testMbPath -StateObj $directMbObj
    $readDirectMb = Read-MailboxState -MailboxPath $testMbPath
    Assert-Equal $readDirectMb.status "INITIALIZED" "Direct Read-MailboxState must match written state"
    Assert-Equal $readDirectMb.devSessionId "session-test" "Direct Read-MailboxState must preserve session ID"

    # A6. Get-SafeWorkspaceDiff on a temporary git repository (256KB limits & 64,000 char budget)
    $gitRepoPath = Join-Path $TestRoot "git-repo-test"
    [System.IO.Directory]::CreateDirectory($gitRepoPath) | Out-Null
    Push-Location $gitRepoPath
    try {
        git init -q
        git config user.name "TestBot"
        git config user.email "testbot@example.com"

        # Commit an initial file and a large file (> 256KB)
        [System.IO.File]::WriteAllText((Join-Path $gitRepoPath "init.txt"), "Initial content`n", [System.Text.Encoding]::UTF8)
        $largeInitialContent = "A" * 300000
        [System.IO.File]::WriteAllText((Join-Path $gitRepoPath "large-to-delete.txt"), $largeInitialContent, [System.Text.Encoding]::UTF8)
        git add -A
        git commit -m "initial commit" -q

        # Modify init.txt
        [System.IO.File]::AppendAllText((Join-Path $gitRepoPath "init.txt"), "Modified line`n", [System.Text.Encoding]::UTF8)

        # Delete large file from working directory (git cat-file -s HEAD should detect >256KB and skip)
        Remove-Item (Join-Path $gitRepoPath "large-to-delete.txt") -Force

        # Create an untracked large file (>256KB)
        [System.IO.File]::WriteAllText((Join-Path $gitRepoPath "untracked-large.txt"), ("B" * 300000), [System.Text.Encoding]::UTF8)

        # Create an untracked small file
        [System.IO.File]::WriteAllText((Join-Path $gitRepoPath "untracked-small.txt"), "Small untracked content", [System.Text.Encoding]::UTF8)

        $diffRes = Get-SafeWorkspaceDiff -WorkspacePath $gitRepoPath -MaxTotalChars 64000 -MaxFileBytes 262144

        Assert-True ($diffRes.Contains("init.txt")) "Diff must include tracked modified file init.txt"
        Assert-True ($diffRes.Contains("Exceeded 256KB limit, diff skipped")) "Diff must skip deleted large file based on git cat-file -s check"
        Assert-True ($diffRes.Contains("untracked-large.txt (Size:") -and $diffRes.Contains("Exceeded 256KB limit, skipped")) "Diff must skip untracked large file"
        Assert-True ($diffRes.Contains("untracked-small.txt") -and $diffRes.Contains("Small untracked content")) "Diff must include small untracked file"
        Assert-True ($diffRes.Length -le 65000) "Diff length must strictly honor 64000 limit"
    } finally {
        Pop-Location
    }

    # A7. Sanitize-SessionId (8-64 chars, valid chars, stripping invalid, truncating long)
    Assert-Equal (Sanitize-SessionId "valid-session_123") "valid-session_123" "Valid session ID should remain unchanged"
    Assert-Equal (Sanitize-SessionId "abc!@#def$%^123") "abcdef123" "Invalid characters should be stripped"
    Assert-Equal (Sanitize-SessionId "short") $null "Session ID under 8 characters should return null"
    $over64 = "a" * 80
    $sanitizedOver64 = Sanitize-SessionId $over64
    Assert-Equal $sanitizedOver64.Length 64 "Session ID over 64 characters should be truncated to 64"
    Assert-Equal (Sanitize-SessionId $null) $null "Null session ID should return null"

    # A7.1 Get-ObjectPropertyValue must read both PSCustomObject and OrderedDictionary keys
    $orderedVerdict = [ordered]@{ verdict = "APPROVED"; summary = "ok" }
    Assert-Equal ([string](Get-ObjectPropertyValue -Object $orderedVerdict -Name "verdict" -Default "")) "APPROVED" "OrderedDictionary verdict must be readable"
    $customVerdict = [pscustomobject]@{ verdict = "REJECTED" }
    Assert-Equal ([string](Get-ObjectPropertyValue -Object $customVerdict -Name "verdict" -Default "")) "REJECTED" "PSCustomObject verdict must be readable"
    Assert-Equal ([string](Get-ObjectPropertyValue -Object $null -Name "verdict" -Default "NONE")) "NONE" "Null object should return default"

    # A7.2 Get-StudioProxyUrl inherits ambient env and never hardcodes 10809
    $proxyKeys = @("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "DUAL_AGENT_PROXY", "ALL_PROXY", "all_proxy")
    $savedProxy = @{}
    foreach ($k in $proxyKeys) { $savedProxy[$k] = [Environment]::GetEnvironmentVariable($k) }
    try {
        foreach ($k in $proxyKeys) { [Environment]::SetEnvironmentVariable($k, $null) }
        Assert-True ([string]::IsNullOrWhiteSpace((Get-StudioProxyUrl))) "Get-StudioProxyUrl must be empty when no proxy env is set"
        [Environment]::SetEnvironmentVariable("DUAL_AGENT_PROXY", "http://127.0.0.1:9")
        Assert-Equal (Get-StudioProxyUrl) "http://127.0.0.1:9" "Get-StudioProxyUrl should read DUAL_AGENT_PROXY"
    } finally {
        foreach ($k in $proxyKeys) { [Environment]::SetEnvironmentVariable($k, $savedProxy[$k]) }
    }

    # A7.3 Invoke-CliWithTimeout must emit stdout lines live (not after process exit)
    $streamScript = Join-Path $TestRoot "stream-echo.ps1"
    @(
        '[Console]::Out.WriteLine("STREAM_LINE_ONE")'
        '[Console]::Out.Flush()'
        'Start-Sleep -Milliseconds 600'
        '[Console]::Out.WriteLine("STREAM_LINE_TWO")'
        '[Console]::Out.Flush()'
    ) | Set-Content -LiteralPath $streamScript -Encoding utf8
    $script:streamHits = [System.Collections.Generic.List[object]]::new()
    $pwshExe = Join-Path $PSHOME "pwsh"
    if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = "pwsh" }
    $streamRes = Invoke-CliWithTimeout -ExecutablePath $pwshExe -Arguments @("-NoProfile", "-File", $streamScript) -TimeoutSeconds 15 -OnStdOutLine {
        param($line)
        if ($line -match "STREAM_LINE_") {
            $script:streamHits.Add([pscustomobject]@{ Line = $line.Trim(); At = [DateTime]::UtcNow })
        }
    }
    Assert-Equal $streamRes.ExitCode 0 "Streaming echo script must exit 0"
    Assert-True ($streamRes.Stdout.Contains("STREAM_LINE_ONE") -and $streamRes.Stdout.Contains("STREAM_LINE_TWO")) "Combined stdout must capture both live lines"
    Assert-True ($script:streamHits.Count -ge 2) "OnStdOutLine must fire for both streamed lines"
    $deltaMs = ($script:streamHits[1].At - $script:streamHits[0].At).TotalMilliseconds
    Assert-True ($deltaMs -ge 300) "Live streaming must deliver LINE_ONE before LINE_TWO sleep completes (delta=$deltaMs ms)"

    # A8. Resolve-EffectiveSessionId (Multi-tier resolution: Explicit > Mailbox > Feature Discussion > Root Discussion > UUID)
    $sessTestDir = Join-Path $TestRoot "sess-resolve-test"
    [System.IO.Directory]::CreateDirectory($sessTestDir) | Out-Null

    # A8a. Clean dir -> generated UUID
    $cleanDevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -RoleName "dev" -AutoBind
    Assert-True (-not [string]::IsNullOrWhiteSpace($cleanDevId) -and $cleanDevId.Length -ge 8) "Clean dir should generate fresh UUID"

    # A8b. Root requirement-discussion.json present -> resolves from root discussion
    $rootDiscJson = [ordered]@{ devSessionId = "disc-root-dev-123"; reviewSessionId = "disc-root-rev-456" } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $sessTestDir "requirement-discussion.json"), $rootDiscJson, [System.Text.Encoding]::UTF8)
    $discDevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -RoleName "dev" -AutoBind
    $discRevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -RoleName "review" -AutoBind
    Assert-Equal $discDevId "disc-root-dev-123" "Should resolve devSessionId from root discussion"
    Assert-Equal $discRevId "disc-root-rev-456" "Should resolve reviewSessionId from root discussion"

    # A8b.1 Isolated .ai-workspace discussion takes precedence over the legacy root file
    $aiWsDir = Join-Path $sessTestDir ".ai-workspace"
    [System.IO.Directory]::CreateDirectory($aiWsDir) | Out-Null
    $isoDiscJson = [ordered]@{ devSessionId = "iso-disc-dev-321"; reviewSessionId = "iso-disc-rev-654" } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $aiWsDir "requirement-discussion.json"), $isoDiscJson, [System.Text.Encoding]::UTF8)
    $isoDevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -RoleName "dev" -AutoBind
    $isoRevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -RoleName "review" -AutoBind
    Assert-Equal $isoDevId "iso-disc-dev-321" "Isolated .ai-workspace discussion must take precedence over root discussion"
    Assert-Equal $isoRevId "iso-disc-rev-654" "Isolated .ai-workspace discussion must take precedence over root discussion"

    # A8c. Feature discussion-history.json present -> Feature discussion > Root discussion
    $featDir = Join-Path $sessTestDir ".ai-workspace\specs\features\feat_test"
    [System.IO.Directory]::CreateDirectory($featDir) | Out-Null
    $featDiscJson = [ordered]@{ devSessionId = "feat-disc-dev-789"; reviewSessionId = "feat-disc-rev-012" } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $featDir "discussion-history.json"), $featDiscJson, [System.Text.Encoding]::UTF8)
    $fDiscDevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -Feature "feat_test" -RoleName "dev" -AutoBind
    $fDiscRevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -Feature "feat_test" -RoleName "review" -AutoBind
    Assert-Equal $fDiscDevId "feat-disc-dev-789" "Feature discussion should take precedence over root discussion"
    Assert-Equal $fDiscRevId "feat-disc-rev-012" "Feature discussion should take precedence over root discussion"

    # A8d. Mailbox present -> Mailbox > Discussion
    $mbTestPath = Join-Path $sessTestDir "review-mailbox.json"
    $mbJson = [ordered]@{ devSessionId = "mb-active-dev-999"; reviewSessionId = "mb-active-rev-888" } | ConvertTo-Json
    [System.IO.File]::WriteAllText($mbTestPath, $mbJson, [System.Text.Encoding]::UTF8)
    $mbDevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -Feature "feat_test" -MailboxPath $mbTestPath -RoleName "dev" -AutoBind
    $mbRevId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -Feature "feat_test" -MailboxPath $mbTestPath -RoleName "review" -AutoBind
    Assert-Equal $mbDevId "mb-active-dev-999" "Mailbox should take precedence over discussion"
    Assert-Equal $mbRevId "mb-active-rev-888" "Mailbox should take precedence over discussion"

    # A8e. Explicit ID passed -> Explicit > Mailbox
    $expDevId = Resolve-EffectiveSessionId -ExplicitId "explicit-dev-111" -WorkspaceRoot $sessTestDir -MailboxPath $mbTestPath -RoleName "dev" -AutoBind
    Assert-Equal $expDevId "explicit-dev-111" "Explicit ID should take precedence over Mailbox"

    # A8f. ForceNew: $true -> Ignores explicit/mailbox/discussion and generates new UUID
    $forcedId = Resolve-EffectiveSessionId -ExplicitId "explicit-dev-111" -WorkspaceRoot $sessTestDir -MailboxPath $mbTestPath -RoleName "dev" -ForceNew -AutoBind
    Assert-True ($forcedId -ne "explicit-dev-111" -and $forcedId -ne "mb-active-dev-999" -and $forcedId.Length -ge 8) "ForceNew should generate new UUID"

    # A8g. AutoBind: $false -> Does not read mailbox or discussion
    $noAutoBindId = Resolve-EffectiveSessionId -WorkspaceRoot $sessTestDir -MailboxPath $mbTestPath -RoleName "dev" -AutoBind:$false
    Assert-True ($noAutoBindId -ne "mb-active-dev-999" -and $noAutoBindId.Length -ge 8) "AutoBind:false should not read mailbox"

    Write-Host "✅ Direct unit tests for orchestrator-lib.ps1 passed!" -ForegroundColor Green

    # --- Section B: Integration Loop Tests ---
    Write-Host "Verifying autonomous loop integration flows..." -ForegroundColor Cyan

    # 1. Test Single Round Approval
    $mb1 = Join-Path $TestRoot "mb1.json"
    $res1 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Implement fast token cache" `
        -Feature "FeatureFastCache" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "Write-Host 'Test OK'; exit 0" `
        -MaxRounds 3 `
        -MailboxPath $mb1 `
        -PassThru

    Assert-Equal $res1.status "APPROVED" "Single round should result in APPROVED"
    Assert-Equal $res1.round 1 "Should complete in round 1"
    Assert-Equal $res1.history.Count 1 "History should have 1 round"
    Assert-True (-not [string]::IsNullOrWhiteSpace($res1.devSessionId)) "devSessionId should be auto-generated"
    Assert-True (-not [string]::IsNullOrWhiteSpace($res1.reviewSessionId)) "reviewSessionId should be auto-generated"

    # 2. Test Multi-Round Feedback Loop (Round 1 REJECT -> Round 2 APPROVE)
    $mb2 = Join-Path $TestRoot "mb2.json"
    $customReviewerHook = {
        param($OriginalTask, $GitDiff, $Round)
        if ($Round -eq 1) {
            return [ordered]@{
                verdict = "REJECTED"
                highestSeverity = "HIGH"
                summary = "Missing null check in token validator"
                issues = @(
                    [ordered]@{
                        file = "token.ps1"
                        lineRange = "10"
                        severity = "HIGH"
                        problem = "Null token causes crash"
                        fixSuggestion = "Add null assertion"
                    }
                )
                nextPromptForDev = "Please add null validation in token.ps1"
            }
        } else {
            return [ordered]@{
                verdict = "APPROVED"
                highestSeverity = "NONE"
                summary = "Null check is in place and verified."
                issues = @()
                nextPromptForDev = ""
            }
        }
    }

    $res2 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Implement token validation" `
        -Feature "FeatureTokenValidation" `
        -DevProvider "mock" `
        -ReviewProvider "custom" `
        -ReviewerCustomHook $customReviewerHook `
        -VerifyCommand "exit 0" `
        -MaxRounds 3 `
        -MailboxPath $mb2 `
        -PassThru

    Assert-Equal $res2.status "APPROVED" "Multi-round should eventually result in APPROVED"
    Assert-Equal $res2.round 2 "Should complete in round 2"
    Assert-Equal $res2.history.Count 2 "History should contain both round 1 and round 2"
    Assert-Equal $res2.history[0].reviewVerdict.verdict "REJECTED" "Round 1 verdict was REJECTED"
    Assert-Equal $res2.history[1].reviewVerdict.verdict "APPROVED" "Round 2 verdict was APPROVED"

    # 3. Test Max Rounds Reached (Halt & Escalate)
    $mb3 = Join-Path $TestRoot "mb3.json"
    $alwaysRejectHook = {
        param($OriginalTask, $GitDiff, $Round)
        return [ordered]@{
            verdict = "REJECTED"
            highestSeverity = "CRITICAL"
            summary = "Always buggy"
            issues = @()
            nextPromptForDev = "Fix it"
        }
    }

    $failedLoop = $false
    try {
        & $OrchestratorScript `
            -WorkspaceRoot $TestRoot `
            -TaskPrompt "Complex Task" `
            -Feature "FeatureComplex" `
            -DevProvider "mock" `
            -ReviewProvider "custom" `
            -ReviewerCustomHook $alwaysRejectHook `
            -VerifyCommand "exit 0" `
            -MaxRounds 2 `
            -MailboxPath $mb3 | Out-Null
    } catch {
        $failedLoop = $true
    }

    $raw3 = [System.IO.File]::ReadAllText($mb3, [System.Text.Encoding]::UTF8)
    $data3 = ConvertFrom-Json $raw3
    Assert-Equal $data3.status "REJECTED_MAX_ROUNDS" "Should set status to REJECTED_MAX_ROUNDS upon reaching limit"

    # 4. Test Self-Heal Limit Exceeded on failing verify command
    $mb4 = Join-Path $TestRoot "mb4.json"
    $selfHealExceeded = $false
    try {
        & $OrchestratorScript `
            -WorkspaceRoot $TestRoot `
            -TaskPrompt "Task With Failing Test" `
            -Feature "FeatureFailingTest" `
            -DevProvider "mock" `
            -ReviewProvider "mock" `
            -VerifyCommand "exit 1" `
            -MaxRounds 3 `
            -MaxSelfHealAttempts 2 `
            -MailboxPath $mb4 | Out-Null
    } catch {
        if ($_.Exception.Message -match "TEST_GATE_SELF_HEAL_EXCEEDED") {
            $selfHealExceeded = $true
        }
    }
    Assert-True $selfHealExceeded "Failing verify command must throw TEST_GATE_SELF_HEAL_EXCEEDED when retry limit is exceeded"

    # 5. Test Markdown-wrapped JSON response from Reviewer
    $mb5 = Join-Path $TestRoot "mb5.json"
    $markdownReviewerHook = {
        param($OriginalTask, $GitDiff, $Round)
        $rawMarkdownOutput = @(
            "Here is my review output for round $Round :",
            '```json',
            '{',
            '  "verdict": "APPROVED",',
            '  "highestSeverity": "NONE",',
            '  "summary": "Verified all constraints in markdown wrapper.",',
            '  "issues": [],',
            '  "nextPromptForDev": ""',
            '}',
            '```'
        ) -join "`n"
        return (Extract-JsonFromText -Text $rawMarkdownOutput)
    }

    $res5 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Markdown Reviewer Task" `
        -Feature "FeatureMarkdownReview" `
        -DevProvider "mock" `
        -ReviewProvider "custom" `
        -ReviewerCustomHook $markdownReviewerHook `
        -VerifyCommand "exit 0" `
        -MaxRounds 2 `
        -MailboxPath $mb5 `
        -PassThru

    Assert-Equal $res5.status "APPROVED" "Markdown-fenced JSON review output should parse successfully and result in APPROVED"
    Assert-Equal $res5.history[0].reviewVerdict.summary "Verified all constraints in markdown wrapper." "Review verdict summary should match"

    # 6. Test Explicit Dev and Reviewer Session IDs
    $mb6 = Join-Path $TestRoot "mb6.json"
    $res6 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Custom Session Task" `
        -Feature "FeatureCustomSession" `
        -DevSessionId "dev-custom-session-123" `
        -ReviewSessionId "review-custom-session-456" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -MailboxPath $mb6 `
        -PassThru

    Assert-Equal $res6.devSessionId "dev-custom-session-123" "Dev session ID should preserve custom input"
    Assert-Equal $res6.reviewSessionId "review-custom-session-456" "Review session ID should preserve custom input"

    # 7. Test Dev Agent Execution Failure (Should Halt & Mark FAILED)
    $mb7 = Join-Path $TestRoot "mb7.json"
    $devFailHook = {
        param($Prompt, $Round)
        throw 'SIMULATED_DEV_FAILURE: Authentication expired or CLI crash'
    }

    $failedCaught = $false
    try {
        & $OrchestratorScript `
            -WorkspaceRoot $TestRoot `
            -TaskPrompt "Failing Dev Task" `
            -Feature "FeatureDevFail" `
            -DevProvider "mock" `
            -DevCustomHook $devFailHook `
            -ReviewProvider "mock" `
            -VerifyCommand "exit 0" `
            -MaxRounds 2 `
            -MailboxPath $mb7 | Out-Null
    } catch {
        $failedCaught = $true
    }

    Assert-True $failedCaught "Dev agent execution failure must halt loop and throw"
    $raw7 = [System.IO.File]::ReadAllText($mb7, [System.Text.Encoding]::UTF8)
    $data7 = ConvertFrom-Json $raw7
    Assert-Equal $data7.status "FAILED" "Mailbox status must be set to FAILED upon dev agent crash"
    # 8. Test -ForceNewSessions with pre-existing discussion/mailbox
    $mb8 = Join-Path $TestRoot "mb8.json"
    $preExistingDisc = [ordered]@{ devSessionId = "old-disc-dev-111"; reviewSessionId = "old-disc-rev-222" } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $TestRoot "requirement-discussion.json"), $preExistingDisc, [System.Text.Encoding]::UTF8)

    $res8 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Force New Session Task" `
        -Feature "FeatureForceNew" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -MailboxPath $mb8 `
        -ForceNewSessions `
        -PassThru

    Assert-Equal $res8.status "APPROVED" "ForceNewSessions loop should complete APPROVED"
    Assert-True ($res8.devSessionId -ne "old-disc-dev-111" -and $res8.devSessionId.Length -ge 8) "ForceNewSessions should generate new devSessionId"
    Assert-True ($res8.reviewSessionId -ne "old-disc-rev-222" -and $res8.reviewSessionId.Length -ge 8) "ForceNewSessions should generate new reviewSessionId"
    Assert-True ($res8.devSessionId -ne $res8.reviewSessionId) "Dev and review session IDs must be distinct"

    # 9. Test AutoBind from requirement-discussion.json when session IDs are omitted
    $mb9 = Join-Path $TestRoot "mb9.json"
    $res9 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "AutoBind Session Task" `
        -Feature "FeatureAutoBind" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -MailboxPath $mb9 `
        -PassThru

    Assert-Equal $res9.status "APPROVED" "AutoBind loop should complete APPROVED"
    Assert-Equal $res9.devSessionId "old-disc-dev-111" "AutoBind should read devSessionId from requirement-discussion.json"
    Assert-Equal $res9.reviewSessionId "old-disc-rev-222" "AutoBind should read reviewSessionId from requirement-discussion.json"

    # 10. Test Mailbox > Discussion priority during orchestrator integration loop with -AutoBindSession
    $mb10 = Join-Path $TestRoot "mb10.json"
    $mb10Data = [ordered]@{
        schemaVersion = "1.0"
        feature = "FeatureMailboxPriority"
        devSessionId = "mb-priority-dev-888"
        reviewSessionId = "mb-priority-rev-999"
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($mb10, $mb10Data, [System.Text.Encoding]::UTF8)

    $res10 = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Mailbox Priority Task" `
        -Feature "FeatureMailboxPriority" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -MailboxPath $mb10 `
        -AutoBindSession `
        -PassThru

    Assert-Equal $res10.status "APPROVED" "Mailbox priority loop should complete APPROVED"
    Assert-Equal $res10.devSessionId "mb-priority-dev-888" "Mailbox devSessionId must take precedence over discussion"
    Assert-Equal $res10.reviewSessionId "mb-priority-rev-999" "Mailbox reviewSessionId must take precedence over discussion"

    # 11. Isolated mailbox script `exit 0` must not stop the autonomous multi-round loop
    $sopWs = Join-Path $TestRoot "sop-exit-workspace"
    [System.IO.Directory]::CreateDirectory((Join-Path $sopWs "scripts")) | Out-Null
    $mbScript = Join-Path $sopWs "scripts\review-mailbox.ps1"
    $mbScriptBody = @'
param(
    [string]$Operation,
    [string]$Feature,
    [string]$DevAgent,
    [string]$ReviewerAgent,
    [int]$MaxRounds = 4,
    [string]$MailboxPath,
    [string]$ProjectRoot,
    [string]$Summary,
    [string]$TestGateStatus,
    [string]$TestOutput,
    [string]$Verdict,
    [string]$HighestSeverity,
    [string]$IssuesJson,
    [string]$NextPromptForDev,
    [int]$ExpectedRound,
    [string]$ExpectedSubmittedAt,
    [string]$ReviewerIdentity
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($MailboxPath)) { $MailboxPath = Join-Path $ProjectRoot "review-mailbox.json" }

function Read-Mb { if (Test-Path -LiteralPath $MailboxPath) { return (Get-Content -Raw -LiteralPath $MailboxPath | ConvertFrom-Json -Depth 100) } ; return $null }
function Write-Mb($obj) { $obj.updatedAt = [DateTimeOffset]::UtcNow.ToString("o"); [System.IO.File]::WriteAllText($MailboxPath, ($obj | ConvertTo-Json -Depth 100), [System.Text.UTF8Encoding]::new($false)) }

switch ($Operation) {
    "Init" {
        $existing = Read-Mb
        if ($existing -and $existing.status -in @("WAITING_DEV","WAITING_REVIEW")) { exit 0 }
        Write-Mb ([ordered]@{
            schemaVersion = "1.0"; feature = $Feature; round = 1; maxRounds = $MaxRounds
            status = "INITIALIZED"; error = ""; devAgent = $DevAgent; reviewerAgent = $ReviewerAgent
            currentDevSubmission = $null; currentReviewVerdict = $null; history = @()
        })
        exit 0
    }
    "DevSubmit" {
        $mb = Read-Mb
        $mb.status = if ($TestGateStatus -eq "PASS") { "WAITING_REVIEW" } else { "WAITING_DEV" }
        $mb.currentDevSubmission = [ordered]@{
            submittedAt = [DateTimeOffset]::UtcNow.ToString("o")
            summary = $Summary
            testGateStatus = $TestGateStatus
            testOutput = $TestOutput
        }
        Write-Mb $mb
        exit 0
    }
    "ReviewSubmit" {
        $mb = Read-Mb
        $round = [int]$mb.round
        $isApproved = ($Verdict -eq "APPROVED")
        $isMax = ($round -ge [int]$mb.maxRounds)
        $verdictObj = [ordered]@{
            reviewedAt = [DateTimeOffset]::UtcNow.ToString("o")
            verdict = $Verdict
            highestSeverity = $HighestSeverity
            summary = $Summary
            issues = @()
            nextPromptForDev = $NextPromptForDev
        }
        $mb.currentReviewVerdict = $verdictObj
        $hist = @($mb.history)
        $mb.history = $hist + @([ordered]@{ round = $round; devSubmission = $mb.currentDevSubmission; reviewVerdict = $verdictObj })
        if ($isApproved) { $mb.status = "APPROVED" }
        elseif ($isMax) { $mb.status = "REJECTED_MAX_ROUNDS" }
        else {
            $mb.status = "WAITING_DEV"
            $mb.round = $round + 1
            $mb.currentDevSubmission = $null
            $mb.currentReviewVerdict = $null
        }
        Write-Mb $mb
        exit 0
    }
}
exit 0
'@
    [System.IO.File]::WriteAllText($mbScript, $mbScriptBody, [System.Text.UTF8Encoding]::new($false))

    $mb11sop = Join-Path $sopWs "review-mailbox.json"
    $sopRejectThenApprove = {
        param($OriginalTask, $GitDiff, $Round)
        if ($Round -eq 1) {
            return [ordered]@{
                verdict = "REJECTED"
                highestSeverity = "HIGH"
                summary = "Mailbox-script round 1 rejected"
                issues = @()
                nextPromptForDev = "Fix the isolated mailbox-script path"
            }
        }
        return [ordered]@{
            verdict = "APPROVED"
            highestSeverity = "NONE"
            summary = "Mailbox-script round 2 approved"
            issues = @()
            nextPromptForDev = ""
        }
    }

    $resSop = & $OrchestratorScript `
        -WorkspaceRoot $sopWs `
        -TaskPrompt "Survive mailbox script exit" `
        -Feature "FeatureMailboxExit" `
        -DevProvider "mock" `
        -ReviewProvider "custom" `
        -ReviewerCustomHook $sopRejectThenApprove `
        -VerifyCommand "exit 0" `
        -MaxRounds 3 `
        -MailboxPath $mb11sop `
        -PassThru

    Assert-Equal $resSop.status "APPROVED" "Mailbox script that calls exit 0 must not halt the parent multi-round loop"
    Assert-Equal $resSop.round 2 "Isolated mailbox script loop should auto-advance to round 2"
    Assert-Equal $resSop.history.Count 2 "Isolated mailbox script loop should record both rounds"

    # 12. Resume WAITING_REVIEW without re-running Dev (process died after DevSubmit)
    $mbResumeReview = Join-Path $TestRoot "mb-resume-review.json"
    $resumeReviewState = [ordered]@{
        schemaVersion = "1.0"
        feature = "FeatureResumeReview"
        round = 1
        maxRounds = 3
        status = "WAITING_REVIEW"
        error = ""
        devAgent = "ANTIGRAVITY"
        reviewerAgent = "COPILOT"
        currentDevSubmission = [ordered]@{
            submittedAt = [DateTimeOffset]::UtcNow.ToString("o")
            summary = "Pre-seeded submission"
            testGateStatus = "PASS"
            testOutput = ""
        }
        currentReviewVerdict = $null
        history = @()
        updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
    Write-MailboxState -MailboxPath $mbResumeReview -StateObj $resumeReviewState

    $resumeDevHook = {
        param($Prompt, $Round)
        throw "DEV_SHOULD_NOT_RUN_WHEN_RESUMING_WAITING_REVIEW"
    }
    $resumeReviewHook = {
        param($OriginalTask, $GitDiff, $Round)
        return [ordered]@{
            verdict = "APPROVED"
            highestSeverity = "NONE"
            summary = "Resumed review approved"
            issues = @()
            nextPromptForDev = ""
        }
    }

    $resResumeReview = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPrompt "Resume review phase" `
        -Feature "FeatureResumeReview" `
        -DevProvider "mock" `
        -DevCustomHook $resumeDevHook `
        -ReviewProvider "custom" `
        -ReviewerCustomHook $resumeReviewHook `
        -VerifyCommand "exit 0" `
        -MaxRounds 3 `
        -MailboxPath $mbResumeReview `
        -PassThru

    Assert-Equal $resResumeReview.status "APPROVED" "WAITING_REVIEW resume should complete review without a manual restart"
    Assert-Equal $resResumeReview.round 1 "WAITING_REVIEW resume should stay on round 1"

    # 13. Helper unit tests for resume kind and next-round prompt
    $resumeKindDev = Get-MailboxResumeKind -Mailbox ([pscustomobject]@{ feature = "F"; status = "WAITING_DEV"; round = 2 }) -ExpectedFeature "F"
    $resumeKindReview = Get-MailboxResumeKind -Mailbox ([pscustomobject]@{ feature = "F"; status = "WAITING_REVIEW"; round = 1 }) -ExpectedFeature "F"
    $resumeKindNone = Get-MailboxResumeKind -Mailbox ([pscustomobject]@{ feature = "Other"; status = "WAITING_DEV"; round = 2 }) -ExpectedFeature "F"
    Assert-Equal $resumeKindDev "dev" "WAITING_DEV should resume in dev phase"
    Assert-Equal $resumeKindReview "review" "WAITING_REVIEW should resume in review phase"
    Assert-Equal $resumeKindNone "none" "Mismatched feature must not resume"

    $promptObj = [pscustomobject]@{
        history = @([pscustomobject]@{
            reviewVerdict = [pscustomobject]@{
                highestSeverity = "HIGH"
                summary = "Need a guard"
                nextPromptForDev = "Add the null check"
            }
        })
    }
    $nextPrompt = Get-NextRoundDevPrompt -Mailbox $promptObj -CompletedRound 1
    Assert-True ($nextPrompt.Contains("Add the null check")) "Next-round prompt must include reviewer instructions"
    Assert-True ($nextPrompt.Contains("HIGH")) "Next-round prompt must include severity"

    # 14. Test Prevent Fake Approval: Invalid Review Verdicts Must Throw
    $mb11 = Join-Path $TestRoot "mb11.json"
    $invalidVerdictHook = {
        param($OriginalTask, $GitDiff, $Round)
        return [ordered]@{
            verdict = "MAYBE_OK"
            highestSeverity = "NONE"
            summary = "Not sure"
            issues = @()
            nextPromptForDev = ""
        }
    }
    $invalidVerdictCaught = $false
    try {
        & $OrchestratorScript `
            -WorkspaceRoot $TestRoot `
            -TaskPrompt "Invalid Verdict Task" `
            -Feature "FeatureInvalidVerdict" `
            -DevProvider "mock" `
            -ReviewProvider "custom" `
            -ReviewerCustomHook $invalidVerdictHook `
            -VerifyCommand "exit 0" `
            -MaxRounds 1 `
            -MailboxPath $mb11 | Out-Null
    } catch {
        if ($_.Exception.Message -match "INVALID_REVIEW_VERDICT") {
            $invalidVerdictCaught = $true
        }
    }
    Assert-True $invalidVerdictCaught "Reviewer returning non-APPROVED/non-REJECTED verdict must be rejected with INVALID_REVIEW_VERDICT"

    # 15. TaskPromptFile must load the prompt and complete a mock round
    $mbPromptFile = Join-Path $TestRoot "mb-prompt-file.json"
    $promptFile = Join-Path $TestRoot "task-prompt-file.txt"
    [System.IO.File]::WriteAllText($promptFile, "Prompt delivered via TaskPromptFile for FeaturePromptFile", [System.Text.UTF8Encoding]::new($false))
    $resPromptFile = & $OrchestratorScript `
        -WorkspaceRoot $TestRoot `
        -TaskPromptFile $promptFile `
        -Feature "FeaturePromptFile" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -MailboxPath $mbPromptFile `
        -PassThru
    Assert-Equal $resPromptFile.status "APPROVED" "TaskPromptFile loop should complete APPROVED"

    $missingPromptCaught = $false
    try {
        & $OrchestratorScript -WorkspaceRoot $TestRoot -DevProvider "mock" -ReviewProvider "mock" | Out-Null
    } catch {
        if ($_.Exception.Message -match "TASK_PROMPT_REQUIRED") { $missingPromptCaught = $true }
    }
    Assert-True $missingPromptCaught "Missing TaskPrompt and TaskPromptFile must throw TASK_PROMPT_REQUIRED"

    $missingFileCaught = $false
    try {
        & $OrchestratorScript -WorkspaceRoot $TestRoot -TaskPromptFile (Join-Path $TestRoot "no-such-prompt.txt") -DevProvider "mock" -ReviewProvider "mock" | Out-Null
    } catch {
        if ($_.Exception.Message -match "TASK_PROMPT_FILE_NOT_FOUND") { $missingFileCaught = $true }
    }
    Assert-True $missingFileCaught "Missing TaskPromptFile path must throw TASK_PROMPT_FILE_NOT_FOUND"

    # 16. Default mailbox path must live under .ai-workspace, not the target repo root
    $defaultMbWs = Join-Path $TestRoot "default-mb-ws"
    [System.IO.Directory]::CreateDirectory($defaultMbWs) | Out-Null
    $resDefaultMb = & $OrchestratorScript `
        -WorkspaceRoot $defaultMbWs `
        -TaskPrompt "Default mailbox isolation task" `
        -Feature "FeatureDefaultMb" `
        -DevProvider "mock" `
        -ReviewProvider "mock" `
        -VerifyCommand "exit 0" `
        -MaxRounds 1 `
        -PassThru
    Assert-Equal $resDefaultMb.status "APPROVED" "Default mailbox loop should complete APPROVED"
    $expectedDefaultMb = Join-Path $defaultMbWs ".ai-workspace\specs\features\FeatureDefaultMb\review-mailbox.json"
    Assert-True (Test-Path -LiteralPath $expectedDefaultMb) "Default mailbox must be written under .ai-workspace/specs/features/<Feature>/"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $defaultMbWs "review-mailbox.json"))) "Default mailbox must not pollute the target repo root"

    # Clean up test discussion file
    if (Test-Path -LiteralPath (Join-Path $TestRoot "requirement-discussion.json")) {
        Remove-Item -LiteralPath (Join-Path $TestRoot "requirement-discussion.json") -Force
    }

    Write-Host "All Dual-Agent Studio orchestrator tests passed successfully." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}