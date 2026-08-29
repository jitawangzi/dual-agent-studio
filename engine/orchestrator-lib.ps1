#requires -Version 7.0

<#
.SYNOPSIS
    Core reusable library for Dual-Agent Studio Orchestrator.
.DESCRIPTION
    Provides thread-safe CLI process management, extension routing, stream-based Git diff extraction,
    error summary extraction, reasoning effort mapping, and atomic mailbox state management.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-CliWithTimeout {
    param(
        [Parameter(Mandatory=$true)][string]$ExecutablePath,
        [Parameter(Mandatory=$false)][string[]]$Arguments = @(),
        [Parameter(Mandatory=$false)][string]$StdinText = "",
        [Parameter(Mandatory=$false)][string]$WorkingDirectory = $PWD.Path,
        [Parameter(Mandatory=$false)][hashtable]$EnvironmentVariables = @{},
        [Parameter(Mandatory=$false)][int]$TimeoutSeconds = 600,
        [Parameter(Mandatory=$false)][string]$RoleName = "CLI"
    )

    $pinfo = [System.Diagnostics.ProcessStartInfo]::new()
    $pinfo.WorkingDirectory = $WorkingDirectory
    $pinfo.UseShellExecute = $false
    $pinfo.RedirectStandardInput = $true
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $pinfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $pinfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $pinfo.CreateNoWindow = $true

    # 1. Windows Extension Routing
    $ext = [System.IO.Path]::GetExtension($ExecutablePath).ToLowerInvariant()
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
        if ($ext -in @(".cmd", ".bat")) {
            $pinfo.FileName = "cmd.exe"
            $pinfo.ArgumentList.Add("/d")
            $pinfo.ArgumentList.Add("/c")
            $pinfo.ArgumentList.Add($ExecutablePath)
            foreach ($arg in $Arguments) { $pinfo.ArgumentList.Add($arg) }
        } elseif ($ext -eq ".ps1") {
            $pinfo.FileName = "pwsh.exe"
            $pinfo.ArgumentList.Add("-NoProfile")
            $pinfo.ArgumentList.Add("-File")
            $pinfo.ArgumentList.Add($ExecutablePath)
            foreach ($arg in $Arguments) { $pinfo.ArgumentList.Add($arg) }
        } else {
            $pinfo.FileName = $ExecutablePath
            foreach ($arg in $Arguments) { $pinfo.ArgumentList.Add($arg) }
        }
    } else {
        $pinfo.FileName = $ExecutablePath
        foreach ($arg in $Arguments) { $pinfo.ArgumentList.Add($arg) }
    }

    # 2. Environment Variables Injection & Proxy Guarantee
    $proxy = if ($env:http_proxy) { $env:http_proxy } else { "http://127.0.0.1:10809" }
    foreach ($pk in @("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "grpc_proxy", "GRPC_PROXY")) {
        $pinfo.EnvironmentVariables[$pk] = $proxy
    }
    foreach ($k in $EnvironmentVariables.Keys) {
        $pinfo.EnvironmentVariables[$k] = [string]$EnvironmentVariables[$k]
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $pinfo

    [void]$process.Start()

    # 3. Read stdout and stderr asynchronously via Task (safe from Runspace threading issues)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    # 4. UTF-8 Stdin Pipeline Input
    if (-not [string]::IsNullOrEmpty($StdinText)) {
        try {
            $process.StandardInput.Write($StdinText)
            $process.StandardInput.Flush()
        } catch {}
    }
    try { $process.StandardInput.Close() } catch {}

    # 5. Process Timeout Watchdog & Tree Kill
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        $pidToKill = $process.Id
        Write-Warning "[$RoleName] Execution exceeded timeout of $TimeoutSeconds seconds. Terminating process tree (PID $pidToKill)..."
        try {
            if ($IsWindows -or $env:OS -eq "Windows_NT") {
                & taskkill.exe /F /T /PID $pidToKill 2>&1 | Out-Null
            } else {
                $process.Kill($true)
            }
        } catch {}

        try {
            [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), 1000)
        } catch {}
        try { $stdoutTask.Dispose() } catch {}
        try { $stderrTask.Dispose() } catch {}
        try { $process.Dispose() } catch {}

        throw "EXECUTION_TIMEOUT: $RoleName CLI timed out after $TimeoutSeconds seconds."
    }

    [System.Threading.Tasks.Task]::WaitAll($stdoutTask, $stderrTask)
    $exitCode = $process.ExitCode
    $stdoutStr = $stdoutTask.Result
    $stderrStr = $stderrTask.Result
    try { $stdoutTask.Dispose() } catch {}
    try { $stderrTask.Dispose() } catch {}
    try { $process.Dispose() } catch {}

    if (-not [string]::IsNullOrEmpty($stdoutStr)) {
        Write-Host $stdoutStr.TrimEnd() -ForegroundColor Gray
    }
    if (-not [string]::IsNullOrEmpty($stderrStr)) {
        Write-Host $stderrStr.TrimEnd() -ForegroundColor DarkGray
    }

    return [ordered]@{
        ExitCode = $exitCode
        Stdout = $stdoutStr
        Stderr = $stderrStr
        Combined = ($stdoutStr + "`n" + $stderrStr).Trim()
    }
}

function Format-CopilotReasoningEffort {
    param([string]$effort)
    if ([string]::IsNullOrWhiteSpace($effort)) { return $null }
    $lower = $effort.Trim().ToLowerInvariant()
    switch ($lower) {
        { $_ -in @("none", "off", "disable", "disabled", "false") } { return "none" }
        { $_ -in @("minimal", "min") } { return "minimal" }
        { $_ -in @("low", "fast", "2048", "4096") } { return "low" }
        { $_ -in @("medium", "med", "8192", "16384") } { return "medium" }
        { $_ -in @("high", "think", "deepthink", "24576", "32768") } { return "high" }
        { $_ -in @("xhigh", "extra-high") } { return "xhigh" }
        { $_ -in @("max", "64000", "65536") } { return "max" }
        default {
            if ($lower -in @("none", "minimal", "low", "medium", "high", "xhigh", "max")) {
                return $lower
            }
            return "high"
        }
    }
}

function Format-AgyReasoningEffort {
    param([string]$effort)
    if ([string]::IsNullOrWhiteSpace($effort)) { return "" }
    $lower = $effort.Trim().ToLowerInvariant()
    switch ($lower) {
        { $_ -in @("none", "off", "disable", "disabled", "false", "0") } { return "" }
        { $_ -in @("low", "minimal", "min", "fast", "2048", "4096") } { return "low" }
        { $_ -in @("medium", "med", "8192", "16384") } { return "medium" }
        { $_ -in @("high", "max", "xhigh", "think", "deepthink", "24576", "32768", "64000", "65536") } { return "high" }
        default {
            if ($lower -in @("low", "medium", "high")) { return $lower }
            return "high"
        }
    }
}

function Format-ClaudeModel {
    param([string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { return "" }
    $m = $Model.ToLowerInvariant().Trim()
    if ($m -match "3-7-sonnet" -or $m -match "3.7-sonnet" -or $m -match "sonnet-5" -or $m -match "sonnet-4" -or $m -match "sonnet") {
        return "sonnet"
    }
    if ($m -match "opus") { return "opus" }
    if ($m -match "haiku") { return "haiku" }
    return $Model
}

function Get-ClaudeExecutable {
    $nativeCandidates = @(
        "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe",
        "$env:LOCALAPPDATA\Programs\claude\claude.exe",
        "$env:USERPROFILE\.claude\bin\claude.exe"
    )
    foreach ($cand in $nativeCandidates) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    $claudeCmd = Get-Command "claude.exe", "claude", "claude.cmd", "claude.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($claudeCmd) { return $claudeCmd.Source }
    return $null
}

function Sanitize-SessionId {
    param([string]$SessionId)
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return $null }
    $trimmed = $SessionId.Trim()
    if ($trimmed -match '^[a-zA-Z0-9_-]{8,64}$') {
        return $trimmed
    }
    $cleaned = ($trimmed -replace '[^a-zA-Z0-9_-]', '')
    if ($cleaned.Length -ge 8) {
        if ($cleaned.Length -gt 64) { $cleaned = $cleaned.Substring(0, 64) }
        return $cleaned
    }
    return $null
}

function Resolve-EffectiveSessionId {
    param(
        [Parameter(Mandatory=$false)][string]$ExplicitId = "",
        [Parameter(Mandatory=$false)][string]$MailboxPath = "",
        [Parameter(Mandatory=$false)][string]$WorkspaceRoot = "",
        [Parameter(Mandatory=$false)][string]$Feature = "",
        [Parameter(Mandatory=$false)][string]$RoleName = "dev",
        [Parameter(Mandatory=$false)][switch]$ForceNew,
        [Parameter(Mandatory=$false)][switch]$AutoBind = $true
    )

    # 1. Explicit ID takes precedence if not forced new
    if (-not $ForceNew -and -not [string]::IsNullOrWhiteSpace($ExplicitId)) {
        $sanitized = Sanitize-SessionId $ExplicitId
        if (-not [string]::IsNullOrWhiteSpace($sanitized)) {
            return $sanitized
        }
    }

    # 2. Multi-tier resolution: Mailbox > requirement-discussion.json
    $isAutoBind = if ($AutoBind -is [System.Management.Automation.SwitchParameter]) { $AutoBind.IsPresent } else { [bool]$AutoBind }
    if (-not $ForceNew -and $isAutoBind) {
        # Check Mailbox
        if (-not [string]::IsNullOrWhiteSpace($MailboxPath) -and (Test-Path -LiteralPath $MailboxPath)) {
            try {
                $raw = [System.IO.File]::ReadAllText($MailboxPath, [System.Text.Encoding]::UTF8)
                $mb = $raw | ConvertFrom-Json
                $cand = if ($RoleName -eq "dev") { $mb.devSessionId } else {
                    if ($mb.reviewSessionId) { $mb.reviewSessionId } else { $mb.reviewerSessionId }
                }
                if (-not [string]::IsNullOrWhiteSpace($cand)) {
                    $cleanCand = Sanitize-SessionId $cand
                    if (-not [string]::IsNullOrWhiteSpace($cleanCand)) {
                        return $cleanCand
                    }
                }
            } catch {}
        }

        # Check Feature & Root Discussion
        if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot) -and (Test-Path -LiteralPath $WorkspaceRoot)) {
            if (-not [string]::IsNullOrWhiteSpace($Feature)) {
                $featDiscPath = Join-Path $WorkspaceRoot ".ai-workspace\specs\features\$Feature\discussion-history.json"
                if (Test-Path -LiteralPath $featDiscPath) {
                    try {
                        $fRaw = [System.IO.File]::ReadAllText($featDiscPath, [System.Text.Encoding]::UTF8)
                        $fDisc = $fRaw | ConvertFrom-Json
                        $cand = if ($RoleName -eq "dev") { $fDisc.devSessionId } else { $fDisc.reviewSessionId }
                        if (-not [string]::IsNullOrWhiteSpace($cand)) {
                            $cleanCand = Sanitize-SessionId $cand
                            if (-not [string]::IsNullOrWhiteSpace($cleanCand)) {
                                return $cleanCand
                            }
                        }
                    } catch {}
                }
            }

            $discPath = Join-Path $WorkspaceRoot "requirement-discussion.json"
            if (Test-Path -LiteralPath $discPath) {
                try {
                    $discRaw = [System.IO.File]::ReadAllText($discPath, [System.Text.Encoding]::UTF8)
                    $disc = $discRaw | ConvertFrom-Json
                    $cand = if ($RoleName -eq "dev") { $disc.devSessionId } else { $disc.reviewSessionId }
                    if (-not [string]::IsNullOrWhiteSpace($cand)) {
                        $cleanCand = Sanitize-SessionId $cand
                        if (-not [string]::IsNullOrWhiteSpace($cleanCand)) {
                            return $cleanCand
                        }
                    }
                } catch {}
            }
        }
    }

    # 3. Fallback to fresh UUIDv4
    return [guid]::NewGuid().ToString()
}

function Extract-JsonFromText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }

    $candidates = @()

    # 1. Try markdown code block extraction ```json ... ```
    if ($Text -match '(?ms)```(?:json)?\s*(\{\s*".*?"\s*:.*?\})\s*```') {
        $candidates += $Matches[1]
    }

    # 2. Try outer { ... } extraction
    if ($Text -match '(?ms)(\{.*\})') {
        $candidates += $Matches[1]
    }

    # 3. Direct JSON candidate
    $candidates += $Text

    foreach ($cand in $candidates) {
        try {
            $parsed = $cand | ConvertFrom-Json
            if ($null -ne $parsed -and $null -ne $parsed.PSObject.Properties['verdict'] -and -not [string]::IsNullOrWhiteSpace($parsed.verdict)) {
                $normVerdict = [string]$parsed.verdict.ToString().Trim().ToUpperInvariant()
                if ($normVerdict -in @("APPROVED", "REJECTED")) {
                    $parsed.verdict = $normVerdict
                    return $parsed
                }
            }
        } catch {}
    }

    return $null
}

function Extract-TestFailureSummary {
    param(
        [Parameter(Mandatory=$false)][string]$TestOutput = "",
        [Parameter(Mandatory=$false)][int]$MaxChars = 8192
    )

    if ([string]::IsNullOrWhiteSpace($TestOutput)) {
        return "Test gate failed with no console output."
    }

    $lines = $TestOutput -split "\r?\n"
    $interestingKeywords = @(
        'FAIL', 'FAILED', 'FAILURE', 'Error:', 'Exception', 'Assert', 'AssertionError',
        'StackTrace', 'Stack trace:', 'at ', 'Caused by:', 'SyntaxError', 'TypeError',
        'ReferenceError', 'NullReferenceException', 'BUILD FAILED', 'FAILURES!!!', 'ERR!'
    )

    $selectedIndices = [System.Collections.Generic.HashSet[int]]::new()
    for ($i = 0; $i -lt $lines.Length; $i++) {
        $lineText = $lines[$i]
        $matched = $false
        foreach ($kw in $interestingKeywords) {
            if ($lineText.IndexOf($kw, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $matched = $true
                break
            }
        }
        if ($matched) {
            $start = [Math]::Max(0, $i - 3)
            $end = [Math]::Min($lines.Length - 1, $i + 3)
            for ($k = $start; $k -le $end; $k++) {
                [void]$selectedIndices.Add($k)
            }
        }
    }

    $summaryBuilder = [System.Text.StringBuilder]::new()
    if ($selectedIndices.Count -gt 0) {
        $sortedIndices = $selectedIndices | Sort-Object
        $lastIdx = -2
        foreach ($idx in $sortedIndices) {
            if ($idx -gt ($lastIdx + 1) -and $lastIdx -ge 0) {
                [void]$summaryBuilder.AppendLine("...")
            }
            [void]$summaryBuilder.AppendLine($lines[$idx])
            $lastIdx = $idx
            if ($summaryBuilder.Length -ge $MaxChars) { break }
        }
    } else {
        $count = [Math]::Min(50, $lines.Length)
        for ($i = 0; $i -lt $count; $i++) {
            [void]$summaryBuilder.AppendLine($lines[$i])
            if ($summaryBuilder.Length -ge $MaxChars) { break }
        }
    }

    $res = $summaryBuilder.ToString().Trim()
    if ($res.Length -gt $MaxChars) {
        $res = $res.Substring(0, $MaxChars) + "`n... [Test error output truncated to $MaxChars chars]"
    }
    return $res
}

function Get-SafeWorkspaceDiff {
    param(
        [Parameter(Mandatory=$true)][string]$WorkspacePath,
        [Parameter(Mandatory=$false)][int]$MaxTotalChars = 64000,
        [Parameter(Mandatory=$false)][int]$MaxFileBytes = 262144
    )

    $diffOutput = [System.Text.StringBuilder]::new()
    $blacklistPatterns = @(
        '\.lock$', 'package-lock\.json$', 'pnpm-lock\.yaml$',
        '\.jar$', '\.exe$', '\.dll$', '\.png$', '\.jpg$', '\.jpeg$', '\.gif$', '\.ico$',
        'node_modules[\\/]', '\.git[\\/]', 'build[\\/]', 'target[\\/]', 'dist[\\/]',
        'review-mailbox\.json$', 'projects\.json$', '\.log$', '\.tmp$'
    )

    Push-Location $WorkspacePath
    try {
        # Check if workspace is a git repo
        [void](git rev-parse --is-inside-work-tree 2>&1)
        if ($LASTEXITCODE -ne 0) {
            return "[Workspace is not a git repository or has no version control initialized. Diff inspection skipped.]"
        }

        # Check if HEAD exists (first commit created)
        $hasHead = $false
        [void](git rev-parse --verify HEAD 2>&1)
        if ($LASTEXITCODE -eq 0) { $hasHead = $true }

        # 1. Tracked Changes - File by File Stream using standard line output (avoiding NUL truncation)
        if ($hasHead) {
            $changedFilesRaw = git diff --name-only HEAD 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($changedFilesRaw)) {
                $filesList = $changedFilesRaw -split "\r?\n"
                foreach ($relFile in $filesList) {
                    $relFile = $relFile.Trim()
                    if ([string]::IsNullOrWhiteSpace($relFile)) { continue }
                    $normalized = $relFile.Replace('\', '/')

                    $isBlacklisted = $false
                    foreach ($p in $blacklistPatterns) {
                        if ($normalized -match $p) { $isBlacklisted = $true; break }
                    }
                    if ($isBlacklisted) { continue }

                    $fullPath = Join-Path $WorkspacePath $relFile
                    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
                        $item = Get-Item -LiteralPath $fullPath
                        if ($item.Length -gt $MaxFileBytes) {
                            [void]$diffOutput.AppendLine("`n=== Tracked File: $relFile (Size: $($item.Length) bytes) - Exceeded 256KB limit, diff skipped ===")
                            continue
                        }
                    } else {
                        # File deleted or moved; check size in HEAD via git cat-file -s
                        $headSizeRaw = git cat-file -s "HEAD:$normalized" 2>&1 | Out-String
                        if ($LASTEXITCODE -eq 0 -and [int64]::TryParse($headSizeRaw.Trim(), [ref]$null)) {
                            $headSize = [int64]$headSizeRaw.Trim()
                            if ($headSize -gt $MaxFileBytes) {
                                [void]$diffOutput.AppendLine("`n=== Tracked File: $relFile (Deleted from HEAD, Size: $headSize bytes) - Exceeded 256KB limit, diff skipped ===")
                                continue
                            }
                        }
                    }

                    $fileDiff = git diff HEAD -- $relFile 2>&1 | Out-String
                    if (-not [string]::IsNullOrWhiteSpace($fileDiff)) {
                        if ($fileDiff.Length -gt $MaxFileBytes) {
                            [void]$diffOutput.AppendLine("`n=== Tracked File: $relFile (Diff size: $($fileDiff.Length) chars) - Exceeded 256KB limit, diff skipped ===")
                        } else {
                            [void]$diffOutput.AppendLine($fileDiff)
                        }
                    }

                    if ($diffOutput.Length -ge $MaxTotalChars) { break }
                }
            }
        }

        # 2. Untracked Files - File by File Stream
        if ($diffOutput.Length -lt $MaxTotalChars) {
            $untrackedStat = git status --porcelain -uall 2>&1 | Out-String -Stream
            foreach ($uLine in $untrackedStat) {
                if ($uLine.Trim() -match '^\?\?\s+(.*)$') {
                    $uPath = $Matches[1].Trim().Trim('"')
                    $normalizedU = $uPath.Replace('\', '/')

                    $isBlacklisted = $false
                    foreach ($p in $blacklistPatterns) {
                        if ($normalizedU -match $p) { $isBlacklisted = $true; break }
                    }
                    if ($isBlacklisted) { continue }

                    $fullUPath = Join-Path $WorkspacePath $uPath
                    if (Test-Path -LiteralPath $fullUPath -PathType Leaf) {
                        $item = Get-Item -LiteralPath $fullUPath
                        if ($item.Length -gt $MaxFileBytes) {
                            [void]$diffOutput.AppendLine("`n=== Untracked File: $uPath (Size: $($item.Length) bytes) - Exceeded 256KB limit, skipped ===")
                        } else {
                            try {
                                $content = [System.IO.File]::ReadAllText($fullUPath, [System.Text.Encoding]::UTF8)
                                [void]$diffOutput.AppendLine("`n=== Untracked File: $uPath ===`n$content")
                            } catch {}
                        }
                    }
                }
                if ($diffOutput.Length -ge $MaxTotalChars) { break }
            }
        }
    } finally {
        Pop-Location
    }

    $finalStr = $diffOutput.ToString()
    if ($finalStr.Length -gt $MaxTotalChars) {
        $finalStr = $finalStr.Substring(0, $MaxTotalChars) + "`n`n[WARNING: Git diff truncated at $MaxTotalChars characters to protect Reviewer context window. Remaining changes omitted.]"
    }

    return $finalStr
}

function Write-MailboxState {
    param(
        [Parameter(Mandatory=$true)][string]$MailboxPath,
        [Parameter(Mandatory=$true)][object]$StateObj
    )
    $parent = Split-Path -Parent $MailboxPath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = $StateObj | ConvertTo-Json -Depth 100
    $tmp = $MailboxPath + ".tmp_" + [guid]::NewGuid().ToString("N")
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($tmp, $MailboxPath, $true)
}

function Read-MailboxState {
    param(
        [Parameter(Mandatory=$true)][string]$MailboxPath
    )
    if (-not (Test-Path -LiteralPath $MailboxPath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($MailboxPath, [System.Text.Encoding]::UTF8)
    return ($raw | ConvertFrom-Json -Depth 100)
}

function Invoke-DevTurn {
    param(
        [Parameter(Mandatory=$true)][string]$Provider,
        [Parameter(Mandatory=$true)][string]$Prompt,
        [Parameter(Mandatory=$false)][int]$Round = 1,
        [Parameter(Mandatory=$false)][string]$SessionId,
        [Parameter(Mandatory=$false)][string]$Model,
        [Parameter(Mandatory=$false)][string]$ReasoningEffort,
        [Parameter(Mandatory=$false)][scriptblock]$CustomHook,
        [Parameter(Mandatory=$true)][string]$WorkspaceRoot
    )

    Write-Host "`n🛠️ [Round $Round] Waking Developer Agent (Provider: $Provider)..." -ForegroundColor Yellow

    if ($null -ne $CustomHook) {
        & $CustomHook -Prompt $Prompt -Round $Round -Model $Model -ReasoningEffort $ReasoningEffort
        return
    }

    switch ($Provider.ToLowerInvariant()) {
        "aider" {
            $aiderCmd = Get-Command "aider", "aider.cmd", "aider.ps1", "aider.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $aiderCmd) { throw "PROVIDER_UNAVAILABLE: Aider CLI is not found in PATH." }
            
            $tmpPromptFile = [System.IO.Path]::GetTempFileName()
            try {
                [System.IO.File]::WriteAllText($tmpPromptFile, $Prompt, [System.Text.UTF8Encoding]::new($false))
                $argsList = @("--message-file", $tmpPromptFile, "--yes-always", "--no-auto-commits")
                if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }

                $res = Invoke-CliWithTimeout -ExecutablePath $aiderCmd.Source -Arguments $argsList -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Aider)"
                if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Aider CLI exited with code $($res.ExitCode)." }
            } finally {
                if (Test-Path -LiteralPath $tmpPromptFile) { Remove-Item -LiteralPath $tmpPromptFile -Force -ErrorAction SilentlyContinue }
            }
        }
        "copilot" {
            $copilotCmd = Get-Command "copilot", "copilot.cmd", "copilot.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $copilotCmd) { throw "PROVIDER_UNAVAILABLE: GitHub Copilot CLI is not found in PATH." }
            
            $argsList = @("--allow-all")
            if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $argsList += "--session-id=$SessionId" }
            if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
            $copilotEffort = Format-CopilotReasoningEffort $ReasoningEffort
            if (-not [string]::IsNullOrWhiteSpace($copilotEffort) -and $copilotEffort -ne "none") { $argsList += @("--reasoning-effort", $copilotEffort) }

            $res = Invoke-CliWithTimeout -ExecutablePath $copilotCmd.Source -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Copilot)"
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Copilot CLI exited with code $($res.ExitCode)." }
        }
        "claude" {
            $claudeExe = Get-ClaudeExecutable
            if (-not $claudeExe) { throw "PROVIDER_UNAVAILABLE: Claude Code CLI is not found in PATH." }

            $argsList = @("--print", "--dangerously-skip-permissions")
            $cModel = Format-ClaudeModel $Model
            if (-not [string]::IsNullOrWhiteSpace($cModel)) { $argsList += @("--model", $cModel) }
            $envMap = @{}
            if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
                $envMap["MAX_THINKING_TOKENS"] = switch ($ReasoningEffort.ToLowerInvariant()) {
                    "high" { "16384" }; "max" { "64000" }; "medium" { "8192" }; "low" { "2048" }; "off" { "0" }; default { $ReasoningEffort }
                }
            }

            $res = Invoke-CliWithTimeout -ExecutablePath $claudeExe -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -EnvironmentVariables $envMap -RoleName "Dev (Claude)"
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Claude CLI exited with code $($res.ExitCode)." }
        }
        "antigravity" {
            $agyCmd = Get-Command "agy", "agy.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $agyCmd) { throw "PROVIDER_UNAVAILABLE: Antigravity CLI ('agy') is not found in PATH." }
            
            $argsList = @("--dangerously-skip-permissions")
            if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
            $agyEffort = Format-AgyReasoningEffort $ReasoningEffort
            if ([string]::IsNullOrWhiteSpace($agyEffort) -and ($Model -match "gemini-3.7" -or [string]::IsNullOrWhiteSpace($Model))) {
                $agyEffort = "high"
            }
            if (-not [string]::IsNullOrWhiteSpace($agyEffort)) { $argsList += @("--effort", $agyEffort) }
            $argsList += @("--print", $Prompt)

            $maxAttempts = 3
            for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
                $res = Invoke-CliWithTimeout -ExecutablePath $agyCmd.Source -Arguments $argsList -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Antigravity)"
                if ($res.ExitCode -eq 0) { break }

                $isTransient = ($res.Combined -match "timeout waiting for response" -or $res.Combined -match "Eligibility check failed" -or $res.Combined -match "EOF" -or $res.Combined -match "handshake")
                if ($isTransient -and $attempt -lt $maxAttempts) {
                    Write-Host "⚠️ Transient network glitch from Antigravity ($($res.Combined.Trim())). Retrying attempt $($attempt + 1)/$maxAttempts in 3 seconds..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 3
                } else {
                    break
                }
            }
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Antigravity CLI exited with code $($res.ExitCode): $($res.Combined)" }
        }
        "cursor" {
            $cursorCmd = Get-Command "cursor", "cursor.cmd", "cursor.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cursorCmd) {
                $res = Invoke-CliWithTimeout -ExecutablePath $cursorCmd.Source -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Cursor)"
                if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Cursor CLI exited with code $($res.ExitCode)." }
            } else {
                Write-Host "[CURSOR] Dispatched instruction to Cursor workspace: $Prompt" -ForegroundColor Gray
            }
        }
        "codex" {
            $codexCmd = Get-Command "codex", "codex.cmd", "codex.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($codexCmd) {
                $res = Invoke-CliWithTimeout -ExecutablePath $codexCmd.Source -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Codex)"
                if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Codex CLI exited with code $($res.ExitCode)." }
            } else {
                Write-Host "[CODEX] Dispatched instruction: $Prompt" -ForegroundColor Gray
            }
        }
        "pi" {
            $piCmd = Get-Command "pi", "pi.cmd", "pi.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($piCmd) {
                $res = Invoke-CliWithTimeout -ExecutablePath $piCmd.Source -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Pi)"
                if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Pi CLI exited with code $($res.ExitCode)." }
            } else {
                Write-Host "[PI AGENT] Executing prompt: $Prompt" -ForegroundColor Gray
            }
        }
        "mock" {
            Write-Host "[MOCK DEV] Simulating code changes in $WorkspaceRoot for prompt: $Prompt" -ForegroundColor Gray
        }
        default {
            throw "UNSUPPORTED_DEV_PROVIDER: Unsupported DevProvider '$Provider'."
        }
    }
}

function Invoke-ReviewerTurn {
    param(
        [Parameter(Mandatory=$true)][string]$Provider,
        [Parameter(Mandatory=$true)][string]$OriginalTask,
        [Parameter(Mandatory=$false)][string]$GitDiff = "",
        [Parameter(Mandatory=$false)][int]$Round = 1,
        [Parameter(Mandatory=$false)][string]$SessionId,
        [Parameter(Mandatory=$false)][string]$Model,
        [Parameter(Mandatory=$false)][string]$ReasoningEffort,
        [Parameter(Mandatory=$false)][scriptblock]$CustomHook,
        [Parameter(Mandatory=$true)][string]$WorkspaceRoot
    )

    Write-Host "`n🔍 [Round $Round] Waking Reviewer Agent (Provider: $Provider)..." -ForegroundColor Magenta

    if ($null -ne $CustomHook) {
        $result = & $CustomHook -OriginalTask $OriginalTask -GitDiff $GitDiff -Round $Round -Model $Model -ReasoningEffort $ReasoningEffort
        return $result
    }

    $systemInstruction = @"
You are an independent Senior Software Architect and Security/Logic Auditor.
Workspace: $WorkspaceRoot
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
            $argsList = @("-s", "--allow-all")
            if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $argsList += "--session-id=$SessionId" }
            if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
            $copilotEffort = Format-CopilotReasoningEffort $ReasoningEffort
            if (-not [string]::IsNullOrWhiteSpace($copilotEffort) -and $copilotEffort -ne "none") { $argsList += @("--reasoning-effort", $copilotEffort) }

            $res = Invoke-CliWithTimeout -ExecutablePath $copilotCmd.Source -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Copilot)"
            $jsonObj = Extract-JsonFromText -Text $res.Combined
            if ($null -ne $jsonObj) { return $jsonObj }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: GitHub Copilot CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: GitHub Copilot CLI returned non-JSON review output: $($res.Combined)"
        }
        { $_ -in @("claude", "claude_code") } {
            $claudeExe = Get-ClaudeExecutable
            if (-not $claudeExe) { throw "PROVIDER_UNAVAILABLE: Claude CLI is not available in PATH." }
            
            $argsList = @("--print", "--dangerously-skip-permissions")
            $cModel = Format-ClaudeModel $Model
            if (-not [string]::IsNullOrWhiteSpace($cModel)) { $argsList += @("--model", $cModel) }
            $envMap = @{}
            if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
                $envMap["MAX_THINKING_TOKENS"] = switch ($ReasoningEffort.ToLowerInvariant()) {
                    "high" { "16384" }; "max" { "64000" }; "medium" { "8192" }; "low" { "2048" }; "off" { "0" }; default { $ReasoningEffort }
                }
            }

            $res = Invoke-CliWithTimeout -ExecutablePath $claudeExe -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -EnvironmentVariables $envMap -RoleName "Reviewer (Claude)"
            $jsonObj = Extract-JsonFromText -Text $res.Combined
            if ($null -ne $jsonObj) { return $jsonObj }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: Claude CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: Claude CLI returned non-JSON review output: $($res.Combined)"
        }
        "antigravity" {
            $agyCmd = Get-Command "agy", "agy.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $agyCmd) { throw "PROVIDER_UNAVAILABLE: Antigravity CLI ('agy') is not found in PATH." }
            
            $argsList = @("--dangerously-skip-permissions")
            if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
            $agyEffort = Format-AgyReasoningEffort $ReasoningEffort
            if ([string]::IsNullOrWhiteSpace($agyEffort) -and ($Model -match "gemini-3.7" -or [string]::IsNullOrWhiteSpace($Model))) {
                $agyEffort = "high"
            }
            if (-not [string]::IsNullOrWhiteSpace($agyEffort)) { $argsList += @("--effort", $agyEffort) }
            $argsList += @("--print", $systemInstruction)

            $maxAttempts = 3
            for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
                $res = Invoke-CliWithTimeout -ExecutablePath $agyCmd.Source -Arguments $argsList -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Antigravity)"
                $jsonObj = Extract-JsonFromText -Text $res.Combined
                if ($null -ne $jsonObj) { return $jsonObj }

                $isTransient = ($res.Combined -match "timeout waiting for response" -or $res.Combined -match "Eligibility check failed" -or $res.Combined -match "EOF" -or $res.Combined -match "handshake")
                if ($isTransient -and $attempt -lt $maxAttempts) {
                    Write-Host "⚠️ Transient network glitch from Antigravity ($($res.Combined.Trim())). Retrying attempt $($attempt + 1)/$maxAttempts in 3 seconds..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 3
                } else {
                    break
                }
            }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: Antigravity CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: Antigravity CLI returned non-JSON review output: $($res.Combined)"
        }
        "cursor" {
            $cursorCmd = Get-Command "cursor", "cursor.cmd", "cursor.ps1", "cursor.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cursorCmd) { throw "PROVIDER_UNAVAILABLE: Cursor CLI is not found in PATH." }

            $res = Invoke-CliWithTimeout -ExecutablePath $cursorCmd.Source -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Cursor)"
            $jsonObj = Extract-JsonFromText -Text $res.Combined
            if ($null -ne $jsonObj) { return $jsonObj }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: Cursor CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: Cursor CLI returned non-JSON review output: $($res.Combined)"
        }
        "codex" {
            $codexCmd = Get-Command "codex", "codex.cmd", "codex.ps1", "codex.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $codexCmd) { throw "PROVIDER_UNAVAILABLE: Codex CLI is not found in PATH." }

            $res = Invoke-CliWithTimeout -ExecutablePath $codexCmd.Source -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Codex)"
            $jsonObj = Extract-JsonFromText -Text $res.Combined
            if ($null -ne $jsonObj) { return $jsonObj }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: Codex CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: Codex CLI returned non-JSON review output: $($res.Combined)"
        }
        "pi" {
            $piCmd = Get-Command "pi", "pi.cmd", "pi.ps1", "pi.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $piCmd) { throw "PROVIDER_UNAVAILABLE: Pi CLI is not found in PATH." }

            $res = Invoke-CliWithTimeout -ExecutablePath $piCmd.Source -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Pi)"
            $jsonObj = Extract-JsonFromText -Text $res.Combined
            if ($null -ne $jsonObj) { return $jsonObj }
            if ($res.ExitCode -ne 0) { throw "REVIEWER_EXECUTION_FAILED: Pi CLI failed with exit code $($res.ExitCode): $($res.Combined)" }
            throw "PROVIDER_OUTPUT_INVALID: Pi CLI returned non-JSON review output: $($res.Combined)"
        }
        default {
            throw "UNSUPPORTED_REVIEWER_PROVIDER: Provider '$Provider' is not configured for automatic review execution. Provide -ReviewerCustomHook or use -ReviewProvider 'mock'."
        }
    }
}
