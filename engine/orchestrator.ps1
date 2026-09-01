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
    [Parameter(Mandatory = $false)]
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

    # Session ID Tracking & Auto-Binding
    [string]$DevSessionId,
    [string]$ReviewSessionId,
    [string]$CopilotSessionId, # Backwards compatibility alias for ReviewSessionId
    [switch]$ForceNewSessions,
    [switch]$AutoBindSession = $true,

    [string]$VerifyCommand = "exit 0",
    [int]$MaxRounds = 4,
    [int]$MaxSelfHealAttempts = 3,

    # Large prompts must travel via file — Windows CreateProcess argv is capped near 32K.
    [string]$TaskPromptFile,

    # Custom/Mock hooks for extensible providers or test simulation
    [scriptblock]$DevCustomHook,
    [scriptblock]$ReviewerCustomHook,

    [switch]$AutoCommit,
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Load Core Modular Orchestration Library before resolving prompt/proxy.
. (Join-Path $PSScriptRoot "orchestrator-lib.ps1")

if (-not [string]::IsNullOrWhiteSpace($TaskPromptFile) -and [string]::IsNullOrWhiteSpace($TaskPrompt)) {
    if (-not (Test-Path -LiteralPath $TaskPromptFile -PathType Leaf)) {
        throw "TASK_PROMPT_FILE_NOT_FOUND: Task prompt file '$TaskPromptFile' does not exist."
    }
    $TaskPrompt = [System.IO.File]::ReadAllText($TaskPromptFile, [System.Text.UTF8Encoding]::new($false))
}
if ([string]::IsNullOrWhiteSpace($TaskPrompt)) {
    throw "TASK_PROMPT_REQUIRED: Provide -TaskPrompt or -TaskPromptFile."
}

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

# Resolve Mailbox File Path — default into .ai-workspace so the target repo root stays clean.
$effectiveMailboxPath = if (-not [string]::IsNullOrWhiteSpace($MailboxPath)) {
    if ([System.IO.Path]::IsPathRooted($MailboxPath)) { $MailboxPath } else { Join-Path $wsPhysical $MailboxPath }
} elseif (Test-Path -LiteralPath (Join-Path $wsPhysical ".ai-sop\review-mailbox.json")) {
    Join-Path $wsPhysical ".ai-sop\review-mailbox.json"
} else {
    Join-Path $wsPhysical ".ai-workspace\specs\features\$effectiveFeature\review-mailbox.json"
}

# Check for review-mailbox.ps1 in target workspace
$targetMailboxScript = $null
$candidateScripts = @(
    (Join-Path $wsPhysical ".ai-sop\scripts\review-mailbox.ps1"),
    (Join-Path $wsPhysical "scripts\review-mailbox.ps1")
)
foreach ($cand in $candidateScripts) {
    if (Test-Path -LiteralPath $cand -PathType Leaf) {
        $targetMailboxScript = $cand
        break
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

# Resolve Dev and Reviewer Session IDs (Multi-tier: Explicit > Mailbox > Discussion > UUID)
$effectiveDevSessionId = Resolve-EffectiveSessionId `
    -ExplicitId $DevSessionId `
    -MailboxPath $effectiveMailboxPath `
    -WorkspaceRoot $wsPhysical `
    -Feature $effectiveFeature `
    -RoleName "dev" `
    -ForceNew:$ForceNewSessions `
    -AutoBind:$AutoBindSession

$rawReviewId = if (-not [string]::IsNullOrWhiteSpace($ReviewSessionId)) { $ReviewSessionId } else { $CopilotSessionId }
$effectiveReviewSessionId = Resolve-EffectiveSessionId `
    -ExplicitId $rawReviewId `
    -MailboxPath $effectiveMailboxPath `
    -WorkspaceRoot $wsPhysical `
    -Feature $effectiveFeature `
    -RoleName "review" `
    -ForceNew:$ForceNewSessions `
    -AutoBind:$AutoBindSession

# Dual-Agent Session Isolation: Ensure Dev and Reviewer session IDs never collide
if ($effectiveDevSessionId -eq $effectiveReviewSessionId) {
    $effectiveReviewSessionId = [guid]::NewGuid().ToString()
}

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " 🚀 DUAL-AGENT STUDIO AUTONOMOUS LOOP" -ForegroundColor Cyan
Write-Host " Workspace     : $wsPhysical" -ForegroundColor White
Write-Host " Feature       : $effectiveFeature" -ForegroundColor White
Write-Host " Dev Agent     : $DevProvider ($mappedDev) $(if ($DevModel) { "[Model: $DevModel, Effort: $DevReasoningEffort]" })" -ForegroundColor White
Write-Host " Dev Session ID: $effectiveDevSessionId" -ForegroundColor White
Write-Host " Review Agent  : $ReviewProvider ($mappedRev) $(if ($ReviewModel) { "[Model: $ReviewModel, Effort: $ReviewReasoningEffort]" })" -ForegroundColor White
Write-Host " Review Session: $effectiveReviewSessionId" -ForegroundColor White
Write-Host " Max Rounds    : $MaxRounds" -ForegroundColor White
Write-Host " Max Self-Heal : $MaxSelfHealAttempts" -ForegroundColor White
Write-Host " Verify Command: $VerifyCommand" -ForegroundColor White
Write-Host " Mailbox File  : $effectiveMailboxPath" -ForegroundColor White
Write-Host "================================================================================" -ForegroundColor Cyan

# 1. Initialize or resume Mailbox. Target SOP scripts are invoked in an isolated
# child pwsh so their `exit` cannot kill this orchestrator process.
$currentPrompt = $TaskPrompt
$skipDevPhase = $false

function Invoke-StudioMailboxOperation {
    param([hashtable]$Parameters)
    if ($targetMailboxScript) {
        [void](Invoke-MailboxScriptIsolated -ScriptPath $targetMailboxScript -Parameters $Parameters -WorkingDirectory $wsPhysical)
    }
}

$existingMb = Read-MailboxState -MailboxPath $effectiveMailboxPath
$resumeKind = Get-MailboxResumeKind -Mailbox $existingMb -ExpectedFeature $effectiveFeature

if ($resumeKind -ne "none") {
    Write-Host "🔄 Resuming existing dual-agent loop for feature '$effectiveFeature' at Round $($existingMb.round) (status=$($existingMb.status))..." -ForegroundColor Cyan
    if ($resumeKind -eq "review") {
        $skipDevPhase = $true
        $currentPrompt = $TaskPrompt
    } else {
        $sub = Get-ObjectPropertyValue -Object $existingMb -Name "currentDevSubmission" -Default $null
        $gate = [string](Get-ObjectPropertyValue -Object $sub -Name "testGateStatus" -Default "")
        if (-not [string]::IsNullOrWhiteSpace($gate) -and $gate -ne "PASS") {
            $failureSummary = Extract-TestFailureSummary -TestOutput ([string](Get-ObjectPropertyValue -Object $sub -Name "testOutput" -Default "")) -MaxChars 8192
            $currentPrompt = "Your recent changes did not pass automated verification (status: $gate). Please inspect the test error output below and fix the implementation:`n`n" + $failureSummary
        } else {
            $completedRound = [Math]::Max(1, ([int]$existingMb.round) - 1)
            $currentPrompt = Get-NextRoundDevPrompt -Mailbox $existingMb -CompletedRound $completedRound
        }
    }
} else {
    if ($targetMailboxScript) {
        Invoke-StudioMailboxOperation -Parameters @{
            Operation = "Init"
            Feature = $effectiveFeature
            DevAgent = $mappedDev
            ReviewerAgent = $mappedRev
            MaxRounds = $MaxRounds
            MailboxPath = $effectiveMailboxPath
            ProjectRoot = $wsPhysical
        }
        $mbInit = Read-MailboxState -MailboxPath $effectiveMailboxPath
        if ($null -ne $mbInit) {
            $mbInit | Add-Member -NotePropertyName "devSessionId" -NotePropertyValue $effectiveDevSessionId -Force
            $mbInit | Add-Member -NotePropertyName "reviewSessionId" -NotePropertyValue $effectiveReviewSessionId -Force
            $mbInit | Add-Member -NotePropertyName "reviewerSessionId" -NotePropertyValue $effectiveReviewSessionId -Force
            Write-MailboxState -MailboxPath $effectiveMailboxPath -StateObj $mbInit
        }
    } else {
        $initObj = [ordered]@{
            schemaVersion = "1.0"
            feature = $effectiveFeature
            round = 1
            maxRounds = $MaxRounds
            status = "INITIALIZED"
            error = ""
            devAgent = $mappedDev
            reviewerAgent = $mappedRev
            devSessionId = $effectiveDevSessionId
            reviewSessionId = $effectiveReviewSessionId
            reviewerSessionId = $effectiveReviewSessionId
            updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
            currentDevSubmission = $null
            currentReviewVerdict = $null
            history = @()
        }
        Write-MailboxState -MailboxPath $effectiveMailboxPath -StateObj $initObj
    }
    $currentPrompt = $TaskPrompt
}

$selfHealAttempts = 0

try {
    while ($true) {
        $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath
        if ($null -eq $mailbox) {
            throw "MAILBOX_READ_FAILED: Cannot read mailbox state at $effectiveMailboxPath"
        }
        $round = [int]$mailbox.round

        if ($skipDevPhase) {
            Write-Host "`n====================== [ ROUND $round / $MaxRounds - RESUME REVIEW PHASE ] ======================" -ForegroundColor Magenta
            $skipDevPhase = $false
        } else {
        Write-Host "`n====================== [ ROUND $round / $MaxRounds - DEV PHASE ] ======================" -ForegroundColor Yellow

        # Phase 1: Dev Turn
        Invoke-DevTurn -Provider $DevProvider -Prompt $currentPrompt -Round $round -SessionId $effectiveDevSessionId -Model $DevModel -ReasoningEffort $DevReasoningEffort -CustomHook $DevCustomHook -WorkspaceRoot $wsPhysical

        # Phase 2: Dev Submit & Test Gate Verification
        Write-Host "`n⚙️ Running test gate in $($wsPhysical): $VerifyCommand..." -ForegroundColor Gray
        
        $testOut = ""
        $testStatus = "PASS"
        if (-not [string]::IsNullOrWhiteSpace($VerifyCommand) -and $VerifyCommand -ne "exit 0") {
            Push-Location $wsPhysical
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                $testProcOut = & pwsh -NoProfile -Command $VerifyCommand 2>&1 | Out-String
                $testExit = $LASTEXITCODE
                if ($null -eq $testExit) { $testExit = 0 }
                $testOut = $testProcOut
                if ($testExit -ne 0) {
                    $testStatus = "FAIL"
                }
            } catch {
                $testStatus = "FAIL"
                $testOut = $_.Exception.ToString()
            } finally {
                $ErrorActionPreference = $prevEap
                Pop-Location
            }
        }

        if ($targetMailboxScript) {
            Invoke-StudioMailboxOperation -Parameters @{
                Operation = "DevSubmit"
                MailboxPath = $effectiveMailboxPath
                Summary = "Round $round code modifications completed."
                TestGateStatus = $testStatus
                TestOutput = $testOut
                ProjectRoot = $wsPhysical
            }
        } else {
            $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath
            $mailbox | Add-Member -NotePropertyName "status" -NotePropertyValue $(if ($testStatus -eq "PASS") { "WAITING_REVIEW" } else { "WAITING_DEV" }) -Force
            $mailbox | Add-Member -NotePropertyName "updatedAt" -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
            $mailbox | Add-Member -NotePropertyName "currentDevSubmission" -NotePropertyValue ([ordered]@{
                submittedAt = [DateTimeOffset]::UtcNow.ToString("o")
                summary = "Round $round code modifications completed."
                changedFiles = @()
                testGateStatus = $testStatus
                testOutput = $testOut
                gitDiffDigest = ""
            }) -Force
            Write-MailboxState -MailboxPath $effectiveMailboxPath -StateObj $mailbox
        }

        # Re-read mailbox after DevSubmit
        $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath

        $gateNow = [string](Get-ObjectPropertyValue -Object $mailbox.currentDevSubmission -Name "testGateStatus" -Default "")
        if ($gateNow -ne "PASS") {
            $selfHealAttempts++
            if ($selfHealAttempts -ge $MaxSelfHealAttempts) {
                throw "TEST_GATE_SELF_HEAL_EXCEEDED: Test verification failed $selfHealAttempts consecutive attempts in round $round. Halting loop to prevent infinite retry."
            }
            Write-Host "❌ Test Gate Verification did not pass (status: $gateNow, attempt $selfHealAttempts/$MaxSelfHealAttempts). Self-healing triggered..." -ForegroundColor Red
            
            $failureSummary = Extract-TestFailureSummary -TestOutput ([string](Get-ObjectPropertyValue -Object $mailbox.currentDevSubmission -Name "testOutput" -Default "")) -MaxChars 8192
            $currentPrompt = "Your recent changes did not pass automated verification (status: $gateNow). Please inspect the test error output below and fix the implementation:`n`n" + $failureSummary
            continue
        }

        $selfHealAttempts = 0
        Write-Host "✅ Test Gate Verification PASSED!" -ForegroundColor Green
        } # end skipDevPhase else (Dev + test gate)

        $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath

        # Phase 3: Reviewer Turn
        Write-Host "`n====================== [ ROUND $round / $MaxRounds - REVIEW PHASE ] ======================" -ForegroundColor Magenta
        
        $gitDiff = Get-SafeWorkspaceDiff -WorkspacePath $wsPhysical -MaxTotalChars 64000 -MaxFileBytes 262144

        $reviewResult = Invoke-ReviewerTurn `
            -Provider $ReviewProvider `
            -OriginalTask $TaskPrompt `
            -GitDiff $gitDiff `
            -Round $round `
            -SessionId $effectiveReviewSessionId `
            -Model $ReviewModel `
            -ReasoningEffort $ReviewReasoningEffort `
            -CustomHook $ReviewerCustomHook `
            -WorkspaceRoot $wsPhysical

        # Submit Review Verdict
        $reviewVerdict = [string](Get-ObjectPropertyValue -Object $reviewResult -Name "verdict" -Default "")
        $reviewSeverity = [string](Get-ObjectPropertyValue -Object $reviewResult -Name "highestSeverity" -Default "NONE")
        $reviewSummary = [string](Get-ObjectPropertyValue -Object $reviewResult -Name "summary" -Default "")
        $reviewNextPrompt = [string](Get-ObjectPropertyValue -Object $reviewResult -Name "nextPromptForDev" -Default "")
        $reviewIssues = Get-ObjectPropertyValue -Object $reviewResult -Name "issues" -Default @()
        $issuesJsonStr = if ($reviewIssues) {
            @($reviewIssues) | ConvertTo-Json -Depth 10 -Compress
        } else {
            "[]"
        }

        if ($targetMailboxScript) {
            $submittedAtRaw = Get-ObjectPropertyValue -Object $mailbox.currentDevSubmission -Name "submittedAt" -Default ""
            $expectedSubmittedAt = if ($submittedAtRaw -is [System.DateTime]) { $submittedAtRaw.ToString("o") } else { [string]$submittedAtRaw }
            Invoke-StudioMailboxOperation -Parameters @{
                Operation = "ReviewSubmit"
                MailboxPath = $effectiveMailboxPath
                Verdict = $reviewVerdict
                HighestSeverity = $reviewSeverity
                Summary = $reviewSummary
                IssuesJson = $issuesJsonStr
                NextPromptForDev = $reviewNextPrompt
                ExpectedRound = $round
                ExpectedSubmittedAt = $expectedSubmittedAt
                ReviewerIdentity = $mappedRev
                ProjectRoot = $wsPhysical
            }
        } else {
            $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath
            $verdict = $reviewVerdict
            if ($verdict -notin @("APPROVED", "REJECTED")) {
                throw "INVALID_REVIEW_VERDICT: Reviewer returned an invalid verdict '$verdict'. Allowed verdicts are 'APPROVED' or 'REJECTED'."
            }
            $gateStatus = [string](Get-ObjectPropertyValue -Object $mailbox.currentDevSubmission -Name "testGateStatus" -Default "")
            $isApproved = ($verdict -eq "APPROVED" -and $gateStatus -eq "PASS")
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
                highestSeverity = $reviewSeverity
                summary = $reviewSummary
                issues = if ($reviewIssues) { @($reviewIssues) } else { @() }
                nextPromptForDev = $reviewNextPrompt
            }

            $historyEntry = [ordered]@{
                round = $round
                devSubmission = $mailbox.currentDevSubmission
                reviewVerdict = $verdictObj
            }

            $existingHistory = Get-ObjectPropertyValue -Object $mailbox -Name "history" -Default @()
            $mailbox | Add-Member -NotePropertyName "status" -NotePropertyValue $newStatus -Force
            $mailbox | Add-Member -NotePropertyName "updatedAt" -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
            $mailbox | Add-Member -NotePropertyName "currentReviewVerdict" -NotePropertyValue $verdictObj -Force
            $mailbox | Add-Member -NotePropertyName "history" -NotePropertyValue (@($existingHistory) + @($historyEntry)) -Force
            if (-not $isApproved -and -not $isMax) {
                $mailbox | Add-Member -NotePropertyName "round" -NotePropertyValue ($round + 1) -Force
                $mailbox | Add-Member -NotePropertyName "currentDevSubmission" -NotePropertyValue $null -Force
                $mailbox | Add-Member -NotePropertyName "currentReviewVerdict" -NotePropertyValue $null -Force
            }
            Write-MailboxState -MailboxPath $effectiveMailboxPath -StateObj $mailbox
        }

        # Check terminal conditions
        $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath

        if ($mailbox.status -eq "APPROVED") {
            Write-Host "`n================================================================================" -ForegroundColor Green
            Write-Host " 🏆 DUAL-AGENT LOOP COMPLETED SUCCESSFULLY (APPROVED at Round $round)!" -ForegroundColor Green
            Write-Host " Summary: $reviewSummary" -ForegroundColor Cyan
            Write-Host "================================================================================" -ForegroundColor Green

            if ($AutoCommit) {
                Write-Host "📦 Creating automatic git commit in $wsPhysical..." -ForegroundColor Gray
                Push-Location $wsPhysical
                try {
                    git add -A
                    $staged = git status --porcelain 2>&1 | Out-String
                    if (-not [string]::IsNullOrWhiteSpace($staged)) {
                        $commitOut = git commit -m "feat($effectiveFeature): completed via dual-agent loop (round $round)" 2>&1 | Out-String
                        Write-Host "✅ Committed successfully: $commitOut" -ForegroundColor Green
                    } else {
                        Write-Host "ℹ️ Working tree clean, no staged changes to commit." -ForegroundColor Gray
                    }
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
            Write-Host " $reviewSummary"
            Write-Host "================================================================================" -ForegroundColor Red
            if ($PassThru) { return $mailbox }
            exit 2
        }

        # If WAITING_DEV, prepare next round prompt and immediately continue the same process.
        if ($mailbox.status -eq "WAITING_DEV") {
            $currentPrompt = Get-NextRoundDevPrompt -Mailbox $mailbox -CompletedRound $round
            Write-Host "⚠️ Issues detected. Auto-advancing to Round $($mailbox.round) without waiting for a manual start..." -ForegroundColor Yellow
            continue
        }

        Write-Host "⚠️ Unexpected mailbox status '$($mailbox.status)' after review; continuing autonomous loop." -ForegroundColor Yellow
        continue
    }
} catch {
    $errMessage = $_.Exception.Message
    Write-Host "`n================================================================================" -ForegroundColor Red
    Write-Host " 🚫 DUAL-AGENT LOOP FAILED: $errMessage" -ForegroundColor Red
    Write-Host "================================================================================" -ForegroundColor Red
    
    try {
        $mailbox = Read-MailboxState -MailboxPath $effectiveMailboxPath
        if ($null -ne $mailbox) {
            $mailbox | Add-Member -NotePropertyName "status" -NotePropertyValue "FAILED" -Force
            $mailbox | Add-Member -NotePropertyName "error" -NotePropertyValue "$errMessage" -Force
            $mailbox | Add-Member -NotePropertyName "updatedAt" -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
            Write-MailboxState -MailboxPath $effectiveMailboxPath -StateObj $mailbox
        }
    } catch {}

    if ($PassThru) { return $mailbox }
    throw $_
}
