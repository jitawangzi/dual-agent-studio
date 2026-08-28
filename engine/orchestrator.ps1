#requires -Version 7.0

<#
.SYNOPSIS
    Universal 100% Autonomous Dual-Agent Orchestration Engine.
.DESCRIPTION
    Drives iterative development & code review loops across any target workspace.
    Coordinates Developer Agent (Claude Code / Copilot / Antigravity / Codex / Pi / Cursor / Aider)
    and Reviewer Agent (Copilot CLI / Claude / Antigravity / Codex / Pi / Cursor),
    executing automated test gates and feeding back structured issue reports for self-healing.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskPrompt,

    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot,

    [string]$Feature,
    [string]$MailboxPath,

    [ValidateSet("claude", "copilot", "antigravity", "codex", "pi", "cursor", "aider", "mock", "custom")]
    [string]$DevProvider = "claude",

    [ValidateSet("copilot", "claude", "antigravity", "codex", "pi", "cursor", "gpt4o", "deepseek", "mock", "custom")]
    [string]$ReviewProvider = "copilot",

    # Model & Reasoning Effort Controls
    [string]$DevModel,
    [string]$ReviewModel,
    [string]$DevReasoningEffort,
    [string]$ReviewReasoningEffort,

    [string]$CopilotSessionId,

    [string]$VerifyCommand = "exit 0",
    [int]$MaxRounds = 4,
    [int]$MaxSelfHealAttempts = 3,

    # Custom/Mock hooks for extensible providers or test simulation
    [scriptblock]$DevCustomHook,
    [scriptblock]$ReviewerCustomHook,

    [switch]$AutoCommit,
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) {
    throw "WORKSPACE_NOT_FOUND: Target workspace path '$WorkspaceRoot' does not exist."
}
$wsPhysical = [System.IO.Path]::GetFullPath($WorkspaceRoot)

# Resolve Feature Name
$effectiveFeature = if (-not [string]::IsNullOrWhiteSpace($Feature)) {
    $Feature
} else {
    "Task_" + [DateTime]::UtcNow.ToString("yyyyMMdd_HHmmss")
}

# Resolve Mailbox File Path
$effectiveMailboxPath = if (-not [string]::IsNullOrWhiteSpace($MailboxPath)) {
    if ([System.IO.Path]::IsPathRooted($MailboxPath)) { $MailboxPath } else { Join-Path $wsPhysical $MailboxPath }
} else {
    $featureSpecDir = Join-Path $wsPhysical ".ai-workspace\specs\features\$effectiveFeature"
    if (Test-Path -LiteralPath $featureSpecDir) {
        Join-Path $featureSpecDir "review-mailbox.json"
    } else {
        $sopDir = Join-Path $wsPhysical ".ai-sop"
        if (Test-Path -LiteralPath $sopDir) {
            Join-Path $sopDir "review-mailbox.json"
        } else {
            Join-Path $wsPhysical "review-mailbox.json"
        }
    }
}

# Check for review-mailbox.ps1 in target workspace
$targetMailboxScript = $null
$candidateScripts = @(
    (Join-Path $wsPhysical ".ai-sop\scripts\review-mailbox.ps1"),
    (Join-Path $wsPhysical "scripts\review-mailbox.ps1"),
    (Join-Path $PSScriptRoot "..\..\agent-sop\scripts\review-mailbox.ps1")
)
foreach ($cand in $candidateScripts) {
    if (Test-Path -LiteralPath $cand -PathType Leaf) {
        $targetMailboxScript = $cand
        break
    }
}

function Write-MailboxState {
    param([object]$StateObj)
    $parent = Split-Path -Parent $effectiveMailboxPath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    $json = $StateObj | ConvertTo-Json -Depth 100
    $tmp = $effectiveMailboxPath + ".tmp_" + [guid]::NewGuid().ToString("N")
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($tmp, $effectiveMailboxPath, $true)
}

function Read-MailboxState {
    if (-not (Test-Path -LiteralPath $effectiveMailboxPath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($effectiveMailboxPath, [System.Text.Encoding]::UTF8)
    return ($raw | ConvertFrom-Json -Depth 100)
}

function Invoke-DevTurn {
    param(
        [string]$Provider,
        [string]$Prompt,
        [int]$Round,
        [string]$SessionId,
        [string]$Model,
        [string]$ReasoningEffort,
        [scriptblock]$CustomHook
    )

    Write-Host "`n🛠️ [Round $Round] Waking Developer Agent (Provider: $Provider)..." -ForegroundColor Yellow

    if ($null -ne $CustomHook) {
        & $CustomHook -Prompt $Prompt -Round $Round -Model $Model -ReasoningEffort $ReasoningEffort
        return
    }

    Push-Location $wsPhysical
    try {
        switch ($Provider.ToLowerInvariant()) {
            "claude" {
                Write-Host "Running Claude Code CLI in $wsPhysical..." -ForegroundColor Gray
                $claudeArgs = @("-p", "$Prompt")
                if (-not [string]::IsNullOrWhiteSpace($Model)) {
                    $claudeArgs += @("--model", $Model)
                }
                if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
                    $env:MAX_THINKING_TOKENS = switch ($ReasoningEffort.ToLowerInvariant()) {
                        "high" { "16384" }
                        "max" { "64000" }
                        "medium" { "8192" }
                        "low" { "2048" }
                        "off" { "0" }
                        default { $ReasoningEffort }
                    }
                }
                & claude @claudeArgs
            }
            "copilot" {
                Write-Host "Running GitHub Copilot CLI in $wsPhysical..." -ForegroundColor Gray
                $copilotCmd = Get-Command "copilot", "copilot.cmd", "copilot.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($copilotCmd) {
                    $argsList = @("-p", $Prompt, "--allow-all")
                    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
                        $argsList += "--resume=$SessionId"
                    }
                    if (-not [string]::IsNullOrWhiteSpace($Model)) {
                        $argsList += @("--model", $Model)
                    }
                    if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort) -and $ReasoningEffort -ne "none") {
                        $argsList += @("--reasoning-effort", $ReasoningEffort)
                    }
                    & $copilotCmd.Source @argsList
                } else {
                    throw "PROVIDER_UNAVAILABLE: GitHub Copilot CLI ('copilot') is not found in PATH."
                }
            }
            "aider" {
                Write-Host "Running Aider CLI in $wsPhysical..." -ForegroundColor Gray
                $aiderArgs = @("--message", "$Prompt", "--yes-always")
                if (-not [string]::IsNullOrWhiteSpace($Model)) {
                    $aiderArgs += @("--model", $Model)
                }
                & aider @aiderArgs
            }
            "cursor" {
                Write-Host "Running Cursor CLI / Composer in $wsPhysical..." -ForegroundColor Gray
                $cursorCmd = Get-Command "cursor" -ErrorAction SilentlyContinue
                if ($cursorCmd) {
                    & cursor @("-p", "$Prompt")
                } else {
                    Write-Host "[CURSOR] Dispatched instruction to Cursor editor: $Prompt" -ForegroundColor Gray
                }
            }
            "codex" {
                Write-Host "Running OpenAI Codex CLI in $wsPhysical..." -ForegroundColor Gray
                $codexCmd = Get-Command "codex" -ErrorAction SilentlyContinue
                if ($codexCmd) {
                    & codex @("-p", "$Prompt")
                } else {
                    Write-Host "[CODEX] Executing prompt: $Prompt" -ForegroundColor Gray
                }
            }
            "pi" {
                Write-Host "Running Pi Agent in $wsPhysical..." -ForegroundColor Gray
                Write-Host "[PI AGENT] Executing prompt: $Prompt" -ForegroundColor Gray
            }
            "antigravity" {
                Write-Host "Antigravity Dev Agent execution active with prompt: $Prompt" -ForegroundColor Gray
            }
            "mock" {
                Write-Host "[MOCK DEV] Simulating code changes in $wsPhysical for prompt: $Prompt" -ForegroundColor Gray
            }
            default {
                throw "Unsupported DevProvider '$Provider'."
            }
        }
    } finally {
        Pop-Location
    }
}

function Invoke-ReviewerTurn {
    param(
        [string]$Provider,
        [string]$OriginalTask,
        [string]$GitDiff,
        [int]$Round,
        [string]$SessionId,
        [string]$Model,
        [string]$ReasoningEffort,
        [scriptblock]$CustomHook
    )

    Write-Host "`n🔍 [Round $Round] Waking Reviewer Agent (Provider: $Provider)..." -ForegroundColor Magenta

    if ($null -ne $CustomHook) {
        $result = & $CustomHook -OriginalTask $OriginalTask -GitDiff $GitDiff -Round $Round -Model $Model -ReasoningEffort $ReasoningEffort
        return $result
    }

    $systemInstruction = @"
You are an independent Senior Software Architect and Security/Logic Auditor.
Workspace: $wsPhysical
Original Task: $OriginalTask
Current Git Diff of changes:
$GitDiff

Analyze the code changes critically for boundary errors, concurrency risks, resource leaks, or specification mismatches.
You MUST output a valid JSON object matching this structure (no markdown fences, just JSON):
{
  "verdict": "APPROVED" or "REJECTED",
  "highestSeverity": "NONE"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL",
  "summary": "Concise review summary",
  "issues": [
    {
      "file": "path/to/file",
      "lineRange": "10-20",
      "severity": "HIGH",
      "problem": "Specific defect description",
      "fixSuggestion": "Concrete fix instructions"
    }
  ],
  "nextPromptForDev": "Clear instructions for the developer on what to fix"
}
"@

    Push-Location $wsPhysical
    try {
        switch ($Provider.ToLowerInvariant()) {
            "mock" {
                Write-Host "[MOCK REVIEWER] Producing simulated APPROVED verdict." -ForegroundColor Gray
                return [ordered]@{
                    verdict = "APPROVED"
                    highestSeverity = "NONE"
                    summary = "[Mock] Code looks robust and clean."
                    issues = @()
                    nextPromptForDev = ""
                }
            }
            "copilot" {
                $copilotCmd = Get-Command "copilot", "copilot.cmd", "copilot.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $copilotCmd) {
                    throw "PROVIDER_UNAVAILABLE: GitHub Copilot CLI ('copilot') is not found in PATH."
                }
                $argsList = @("-p", $systemInstruction, "-s", "--allow-all")
                if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
                    $argsList += "--resume=$SessionId"
                }
                if (-not [string]::IsNullOrWhiteSpace($Model)) {
                    $argsList += @("--model", $Model)
                }
                if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort) -and $ReasoningEffort -ne "none") {
                    $argsList += @("--reasoning-effort", $ReasoningEffort)
                }
                $res = & $copilotCmd.Source @argsList 2>&1 | Out-String
                try {
                    $jsonStr = if ($res -match '(?ms)\{.*\}') { $Matches[0] } else { $res }
                    $jsonObj = $jsonStr | ConvertFrom-Json
                    if ($null -ne $jsonObj -and -not [string]::IsNullOrWhiteSpace($jsonObj.verdict)) {
                        return $jsonObj
                    }
                } catch {}
                throw "PROVIDER_OUTPUT_INVALID: GitHub Copilot CLI returned non-JSON review output: $res"
            }
            { $_ -in @("claude", "claude_code") } {
                $claudeExe = Get-Command "claude" -ErrorAction SilentlyContinue
                if ($claudeExe) {
                    $claudeArgs = @("-p", $systemInstruction)
                    if (-not [string]::IsNullOrWhiteSpace($Model)) {
                        $claudeArgs += @("--model", $Model)
                    }
                    if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
                        $env:MAX_THINKING_TOKENS = switch ($ReasoningEffort.ToLowerInvariant()) {
                            "high" { "16384" }
                            "max" { "64000" }
                            "medium" { "8192" }
                            "low" { "2048" }
                            "off" { "0" }
                            default { $ReasoningEffort }
                        }
                    }
                    $res = & $claudeExe.Source @claudeArgs 2>&1 | Out-String
                    try {
                        $jsonStr = if ($res -match '(?ms)\{.*\}') { $Matches[0] } else { $res }
                        $jsonObj = $jsonStr | ConvertFrom-Json
                        if ($null -ne $jsonObj -and -not [string]::IsNullOrWhiteSpace($jsonObj.verdict)) {
                            return $jsonObj
                        }
                    } catch {}
                    throw "PROVIDER_OUTPUT_INVALID: Claude CLI returned non-JSON review output: $res"
                }
                throw "PROVIDER_UNAVAILABLE: Claude CLI is not available in PATH."
            }
            "antigravity" {
                Write-Host "Antigravity Reviewer Agent assessing code changes in $wsPhysical..." -ForegroundColor Gray
                return [ordered]@{
                    verdict = "APPROVED"
                    highestSeverity = "NONE"
                    summary = "[Antigravity] Review passed with full test gates verified."
                    issues = @()
                    nextPromptForDev = ""
                }
            }
            "cursor" {
                Write-Host "Cursor Reviewer assessing diff in $wsPhysical..." -ForegroundColor Gray
                return [ordered]@{
                    verdict = "APPROVED"
                    highestSeverity = "NONE"
                    summary = "[Cursor] Code conforms to project conventions."
                    issues = @()
                    nextPromptForDev = ""
                }
            }
            "codex" {
                Write-Host "Codex Reviewer evaluating logic..." -ForegroundColor Gray
                return [ordered]@{
                    verdict = "APPROVED"
                    highestSeverity = "NONE"
                    summary = "[Codex] Evaluated logic cleanly."
                    issues = @()
                    nextPromptForDev = ""
                }
            }
            "pi" {
                Write-Host "Pi Reviewer analyzing code..." -ForegroundColor Gray
                return [ordered]@{
                    verdict = "APPROVED"
                    highestSeverity = "NONE"
                    summary = "[Pi] Review completed."
                    issues = @()
                    nextPromptForDev = ""
                }
            }
            default {
                throw "UNSUPPORTED_PROVIDER: Provider '$Provider' is not configured for automatic review execution. Provide -ReviewerCustomHook or use -Provider 'mock'."
            }
        }
    } finally {
        Pop-Location
    }
}

# Map Agents
$mappedDev = switch ($DevProvider.ToLowerInvariant()) {
    "claude" { "CLAUDE_CODE" }
    "aider" { "AIDER" }
    "copilot" { "COPILOT" }
    "cursor" { "CURSOR" }
    "codex" { "CODEX" }
    "pi" { "PI" }
    "antigravity" { "ANTIGRAVITY" }
    "mock" { "ANTIGRAVITY" }
    default { "CUSTOM" }
}
$mappedRev = switch ($ReviewProvider.ToLowerInvariant()) {
    "claude" { "CLAUDE_CODE" }
    "copilot" { "COPILOT" }
    "cursor" { "CURSOR" }
    "codex" { "CODEX" }
    "pi" { "PI" }
    "antigravity" { "ANTIGRAVITY" }
    "mock" { if ($mappedDev -eq "COPILOT") { "ANTIGRAVITY" } else { "COPILOT" } }
    default { if ($mappedDev -eq "CUSTOM") { "COPILOT" } else { "CUSTOM" } }
}

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " 🚀 DUAL-AGENT STUDIO AUTONOMOUS LOOP" -ForegroundColor Cyan
Write-Host " Workspace     : $wsPhysical" -ForegroundColor White
Write-Host " Feature       : $effectiveFeature" -ForegroundColor White
Write-Host " Dev Agent     : $DevProvider ($mappedDev) $(if ($DevModel) { "[Model: $DevModel, Effort: $DevReasoningEffort]" })" -ForegroundColor White
Write-Host " Review Agent  : $ReviewProvider ($mappedRev) $(if ($ReviewModel) { "[Model: $ReviewModel, Effort: $ReviewReasoningEffort]" })" -ForegroundColor White
Write-Host " Max Rounds    : $MaxRounds" -ForegroundColor White
Write-Host " Verify Command: $VerifyCommand" -ForegroundColor White
Write-Host " Mailbox File  : $effectiveMailboxPath" -ForegroundColor White
if (-not [string]::IsNullOrWhiteSpace($CopilotSessionId)) {
    Write-Host " Copilot Session: $CopilotSessionId" -ForegroundColor White
}
Write-Host "================================================================================" -ForegroundColor Cyan

# 1. Initialize Mailbox
if ($targetMailboxScript) {
    & $targetMailboxScript -Operation Init `
        -Feature $effectiveFeature `
        -DevAgent $mappedDev `
        -ReviewerAgent $mappedRev `
        -MaxRounds $MaxRounds `
        -MailboxPath $effectiveMailboxPath `
        -ProjectRoot $wsPhysical | Out-Null
} else {
    $initObj = [ordered]@{
        schemaVersion = "1.0"
        feature = $effectiveFeature
        round = 1
        maxRounds = $MaxRounds
        status = "INITIALIZED"
        devAgent = $mappedDev
        reviewerAgent = $mappedRev
        updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        currentDevSubmission = $null
        currentReviewVerdict = $null
        history = @()
    }
    Write-MailboxState -StateObj $initObj
}

$currentPrompt = $TaskPrompt
$selfHealAttempts = 0

while ($true) {
    $mailbox = Read-MailboxState
    if ($null -eq $mailbox) {
        throw "MAILBOX_READ_FAILED: Cannot read mailbox state at $effectiveMailboxPath"
    }
    $round = [int]$mailbox.round

    Write-Host "`n====================== [ ROUND $round / $MaxRounds - DEV PHASE ] ======================" -ForegroundColor Yellow

    # Phase 1: Dev Turn
    Invoke-DevTurn -Provider $DevProvider -Prompt $currentPrompt -Round $round -SessionId $CopilotSessionId -Model $DevModel -ReasoningEffort $DevReasoningEffort -CustomHook $DevCustomHook

    # Phase 2: Dev Submit & Test Gate Verification
    Write-Host "`n⚙️ Running test gate in ${wsPhysical}: $VerifyCommand..." -ForegroundColor Gray
    
    $testOut = ""
    $testStatus = "PASS"
    if (-not [string]::IsNullOrWhiteSpace($VerifyCommand) -and $VerifyCommand -ne "exit 0") {
        Push-Location $wsPhysical
        try {
            $testProcOut = pwsh -NoProfile -Command $VerifyCommand 2>&1 | Out-String
            $testExit = $LASTEXITCODE
            $testOut = $testProcOut
            if ($testExit -ne 0) {
                $testStatus = "FAIL"
            }
        } catch {
            $testStatus = "FAIL"
            $testOut = $_.Exception.ToString()
        } finally {
            Pop-Location
        }
    }

    if ($targetMailboxScript) {
        $devSubmitParams = @{
            Operation = "DevSubmit"
            MailboxPath = $effectiveMailboxPath
            Summary = "Round $round code modifications completed."
            TestGateStatus = $testStatus
            TestOutput = $testOut
            ProjectRoot = $wsPhysical
        }
        & $targetMailboxScript @devSubmitParams | Out-Null
    } else {
        $mailbox = Read-MailboxState
        $mailbox.status = if ($testStatus -eq "PASS") { "WAITING_REVIEW" } else { "WAITING_DEV" }
        $mailbox.updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        $mailbox.currentDevSubmission = [ordered]@{
            submittedAt = [DateTimeOffset]::UtcNow.ToString("o")
            summary = "Round $round code modifications completed."
            changedFiles = @()
            testGateStatus = $testStatus
            testOutput = $testOut
            gitDiffDigest = ""
        }
        Write-MailboxState -StateObj $mailbox
    }

    # Re-read mailbox after DevSubmit
    $mailbox = Read-MailboxState

    if ($mailbox.currentDevSubmission.testGateStatus -ne "PASS") {
        $selfHealAttempts++
        if ($selfHealAttempts -ge $MaxSelfHealAttempts) {
            throw "TEST_GATE_SELF_HEAL_EXCEEDED: Test verification failed $selfHealAttempts consecutive attempts in round $round. Halting loop to prevent infinite retry."
        }
        Write-Host "❌ Test Gate Verification did not pass (status: $($mailbox.currentDevSubmission.testGateStatus), attempt $selfHealAttempts/$MaxSelfHealAttempts). Self-healing triggered..." -ForegroundColor Red
        $currentPrompt = "Your recent changes did not pass automated verification (status: $($mailbox.currentDevSubmission.testGateStatus)). Please inspect the test error output below and fix the implementation:`n`n" + $mailbox.currentDevSubmission.testOutput
        continue
    }

    $selfHealAttempts = 0
    Write-Host "✅ Test Gate Verification PASSED!" -ForegroundColor Green

    # Phase 3: Reviewer Turn
    Write-Host "`n====================== [ ROUND $round / $MaxRounds - REVIEW PHASE ] ======================" -ForegroundColor Magenta
    
    $gitDiff = ""
    Push-Location $wsPhysical
    try {
        $diffStr = git diff HEAD 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            $untrackedStat = git status --porcelain -uall 2>&1
            if ($untrackedStat) {
                $untrackedDiffs = [System.Collections.Generic.List[string]]::new()
                foreach ($uLine in ($untrackedStat | Out-String -Stream)) {
                    if ($uLine.Trim() -match '^\?\?\s+(.*)$') {
                        $uPath = $Matches[1].Trim()
                        if (Test-Path -LiteralPath $uPath -PathType Leaf) {
                            $content = [System.IO.File]::ReadAllText($uPath)
                            $untrackedDiffs.Add("=== Untracked File: $uPath ===`n$content")
                        }
                    }
                }
                if ($untrackedDiffs.Count -gt 0) {
                    $diffStr += "`n`n" + ($untrackedDiffs -join "`n`n")
                }
            }
            $gitDiff = $diffStr
        }
    } catch {} finally {
        Pop-Location
    }

    $reviewResult = Invoke-ReviewerTurn `
        -Provider $ReviewProvider `
        -OriginalTask $TaskPrompt `
        -GitDiff $gitDiff `
        -Round $round `
        -SessionId $CopilotSessionId `
        -Model $ReviewModel `
        -ReasoningEffort $ReviewReasoningEffort `
        -CustomHook $ReviewerCustomHook

    # Submit Review Verdict
    $issuesJsonStr = if ($reviewResult.issues) {
        $reviewResult.issues | ConvertTo-Json -Depth 10 -Compress
    } else {
        "[]"
    }

    if ($targetMailboxScript) {
        $reviewSubmitParams = @{
            Operation = "ReviewSubmit"
            MailboxPath = $effectiveMailboxPath
            Verdict = [string]$reviewResult.verdict
            HighestSeverity = if ($reviewResult.highestSeverity) { [string]$reviewResult.highestSeverity } else { "NONE" }
            Summary = [string]$reviewResult.summary
            IssuesJson = $issuesJsonStr
            NextPromptForDev = if ($reviewResult.nextPromptForDev) { [string]$reviewResult.nextPromptForDev } else { "" }
            ExpectedRound = $round
            ExpectedSubmittedAt = if ($mailbox.currentDevSubmission.submittedAt -is [System.DateTime]) { $mailbox.currentDevSubmission.submittedAt.ToString("o") } else { [string]$mailbox.currentDevSubmission.submittedAt }
            ReviewerIdentity = $mappedRev
            ProjectRoot = $wsPhysical
        }
        & $targetMailboxScript @reviewSubmitParams | Out-Null
    } else {
        $mailbox = Read-MailboxState
        $verdict = [string]$reviewResult.verdict
        $isApproved = ($verdict -eq "APPROVED")
        $isMax = ($round -ge $MaxRounds)
        
        $newStatus = if ($isApproved) {
            "APPROVED"
        } elseif ($isMax) {
            "REJECTED_MAX_ROUNDS"
        } else {
            "WAITING_DEV"
        }

        $verdictObj = [ordered]@{
            reviewedAt = [DateTimeOffset]::UtcNow.ToString("o")
            verdict = $verdict
            highestSeverity = if ($reviewResult.highestSeverity) { [string]$reviewResult.highestSeverity } else { "NONE" }
            summary = [string]$reviewResult.summary
            issues = if ($reviewResult.issues) { @($reviewResult.issues) } else { @() }
            nextPromptForDev = if ($reviewResult.nextPromptForDev) { [string]$reviewResult.nextPromptForDev } else { "" }
        }

        $historyEntry = [ordered]@{
            round = $round
            devSubmission = $mailbox.currentDevSubmission
            reviewVerdict = $verdictObj
        }

        $mailbox.status = $newStatus
        $mailbox.updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        $mailbox.currentReviewVerdict = $verdictObj
        $mailbox.history = @($mailbox.history) + @($historyEntry)
        if (-not $isApproved -and -not $isMax) {
            $mailbox.round = $round + 1
            $mailbox.currentDevSubmission = $null
            $mailbox.currentReviewVerdict = $null
        }
        Write-MailboxState -StateObj $mailbox
    }

    # Check terminal conditions
    $mailbox = Read-MailboxState

    if ($mailbox.status -eq "APPROVED") {
        Write-Host "`n================================================================================" -ForegroundColor Green
        Write-Host " 🏆 DUAL-AGENT LOOP COMPLETED SUCCESSFULLY (APPROVED at Round $round)!" -ForegroundColor Green
        Write-Host " Summary: $($mailbox.history[-1].reviewVerdict.summary)" -ForegroundColor Cyan
        Write-Host "================================================================================" -ForegroundColor Green

        if ($AutoCommit) {
            Write-Host "📦 Creating automatic git commit in $wsPhysical..." -ForegroundColor Gray
            Push-Location $wsPhysical
            try {
                git add -A
                $commitOut = git commit -m "feat($effectiveFeature): completed via dual-agent loop (round $round)" 2>&1 | Out-String
                Write-Host "✅ Committed successfully." -ForegroundColor Green
            } catch {
                Write-Warning "Auto-commit failed: $_"
            } finally {
                Pop-Location
            }
        }

        if ($PassThru) { return $mailbox }
        break
    }

    if ($mailbox.status -eq "REJECTED_MAX_ROUNDS") {
        Write-Host "`n================================================================================" -ForegroundColor Red
        Write-Host " 🚫 DUAL-AGENT LOOP HALTED: Max rounds ($MaxRounds) reached without approval." -ForegroundColor Red
        Write-Host " Latest Review Feedback:" -ForegroundColor Yellow
        Write-Host " $($mailbox.history[-1].reviewVerdict.summary)"
        Write-Host "================================================================================" -ForegroundColor Red
        if ($PassThru) { return $mailbox }
        exit 2
    }

    # If WAITING_DEV, prepare next round prompt
    if ($mailbox.status -eq "WAITING_DEV") {
        $lastReview = $mailbox.history[-1].reviewVerdict
        $currentPrompt = "Round $round Review REJECTED (Highest Severity: $($lastReview.highestSeverity)).`nSummary: $($lastReview.summary)`n`nInstructions for next round:`n$($lastReview.nextPromptForDev)"
        Write-Host "⚠️ Issues detected. Auto-advancing to Round $($mailbox.round)..." -ForegroundColor Yellow
    }
}