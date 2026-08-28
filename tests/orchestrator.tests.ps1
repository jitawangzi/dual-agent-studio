#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$StudioRoot = Split-Path -Parent $PSScriptRoot
$OrchestratorScript = Join-Path $StudioRoot "engine\orchestrator.ps1"

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
    Write-Host "Running Dual-Agent Studio Standalone Orchestrator Tests..." -ForegroundColor Cyan

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
        $rawMarkdownOutput = @"
Here is my review output for round $($Round):
```json
{
  "verdict": "APPROVED",
  "highestSeverity": "NONE",
  "summary": "Verified all constraints in markdown wrapper.",
  "issues": [],
  "nextPromptForDev": ""
}
```
All clear!
"@
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
    Assert-True ($data7.error -match "SIMULATED_DEV_FAILURE") "Mailbox error property must record the failure message"

    Write-Host "All Dual-Agent Studio orchestrator tests passed successfully." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}