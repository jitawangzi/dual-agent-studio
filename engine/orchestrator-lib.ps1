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

function Get-StudioProxyUrl {
    foreach ($k in @("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "DUAL_AGENT_PROXY", "ALL_PROXY", "all_proxy")) {
        $v = [Environment]::GetEnvironmentVariable($k)
        if (-not [string]::IsNullOrWhiteSpace($v)) { return $v }
    }
    return $null
}

function Apply-StudioProxyToProcessStartInfo {
    param([Parameter(Mandatory=$true)]$ProcessStartInfo)
    $proxy = Get-StudioProxyUrl
    if ([string]::IsNullOrWhiteSpace($proxy)) { return }
    foreach ($pk in @("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "grpc_proxy", "GRPC_PROXY")) {
        $ProcessStartInfo.EnvironmentVariables[$pk] = $proxy
    }
}

function Invoke-CliWithTimeout {
    param(
        [Parameter(Mandatory=$true)][string]$ExecutablePath,
        [Parameter(Mandatory=$false)][string[]]$Arguments = @(),
        [Parameter(Mandatory=$false)][string]$StdinText = "",
        [Parameter(Mandatory=$false)][string]$WorkingDirectory = $PWD.Path,
        [Parameter(Mandatory=$false)][hashtable]$EnvironmentVariables = @{},
        [Parameter(Mandatory=$false)][int]$TimeoutSeconds = 1800,
        [Parameter(Mandatory=$false)][string]$RoleName = "CLI",
        [Parameter(Mandatory=$false)][scriptblock]$OnStdOutLine,
        [Parameter(Mandatory=$false)][scriptblock]$OnStdErrLine
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

    # 2. Inherit ambient proxy only — never inject a hardcoded 10809 fallback.
    Apply-StudioProxyToProcessStartInfo -ProcessStartInfo $pinfo
    foreach ($k in $EnvironmentVariables.Keys) {
        $pinfo.EnvironmentVariables[$k] = [string]$EnvironmentVariables[$k]
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $pinfo

    [void]$process.Start()

    # 3. Live line streaming on the calling thread (Write-Host is Runspace-safe here).
    $stdoutBuilder = [System.Text.StringBuilder]::new()
    $stderrBuilder = [System.Text.StringBuilder]::new()
    $stdoutLine = [System.Text.StringBuilder]::new()
    $stderrLine = [System.Text.StringBuilder]::new()
    $stdoutChars = New-Object char[] 2048
    $stderrChars = New-Object char[] 2048
    $stdoutRead = $process.StandardOutput.ReadAsync($stdoutChars, 0, $stdoutChars.Length)
    $stderrRead = $process.StandardError.ReadAsync($stderrChars, 0, $stderrChars.Length)
    $stdoutEof = $false
    $stderrEof = $false

    function Emit-CliChunk {
        param(
            [string]$Chunk,
            [System.Text.StringBuilder]$FullBuilder,
            [System.Text.StringBuilder]$LineBuilder,
            [ConsoleColor]$Color,
            [scriptblock]$OnLine
        )
        if ([string]::IsNullOrEmpty($Chunk)) { return }
        [void]$FullBuilder.Append($Chunk)
        [void]$LineBuilder.Append($Chunk)
        while ($true) {
            $buf = $LineBuilder.ToString()
            $nl = $buf.IndexOf("`n")
            if ($nl -lt 0) { break }
            $line = $buf.Substring(0, $nl).TrimEnd("`r")
            Write-Host $line -ForegroundColor $Color
            if ($null -ne $OnLine) {
                try { & $OnLine $line } catch {}
            }
            $rest = $buf.Substring($nl + 1)
            [void]$LineBuilder.Clear()
            [void]$LineBuilder.Append($rest)
        }
    }

    function Flush-CliRemainder {
        param(
            [System.Text.StringBuilder]$LineBuilder,
            [ConsoleColor]$Color,
            [scriptblock]$OnLine
        )
        if ($LineBuilder.Length -le 0) { return }
        $line = $LineBuilder.ToString().TrimEnd("`r")
        if (-not [string]::IsNullOrEmpty($line)) {
            Write-Host $line -ForegroundColor $Color
            if ($null -ne $OnLine) {
                try { & $OnLine $line } catch {}
            }
        }
        [void]$LineBuilder.Clear()
    }

    # 4. UTF-8 Stdin Pipeline Input
    if (-not [string]::IsNullOrEmpty($StdinText)) {
        try {
            $process.StandardInput.Write($StdinText)
            $process.StandardInput.Flush()
        } catch {}
    }
    try { $process.StandardInput.Close() } catch {}

    # 5. Pump streams until exit or timeout
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    $killed = $false
    while ($true) {
        if ([DateTime]::UtcNow -ge $deadline -and -not $process.HasExited) {
            $killed = $true
            $pidToKill = $process.Id
            Write-Warning "[$RoleName] Execution exceeded timeout of $TimeoutSeconds seconds. Terminating process tree (PID $pidToKill)..."
            try {
                if ($IsWindows -or $env:OS -eq "Windows_NT") {
                    & taskkill.exe /F /T /PID $pidToKill 2>&1 | Out-Null
                } else {
                    $process.Kill($true)
                }
            } catch {}
            break
        }

        if (-not $stdoutEof -and $stdoutRead.IsCompleted) {
            $n = $stdoutRead.GetAwaiter().GetResult()
            if ($n -le 0) {
                $stdoutEof = $true
            } else {
                Emit-CliChunk -Chunk ([string]::new($stdoutChars, 0, $n)) -FullBuilder $stdoutBuilder -LineBuilder $stdoutLine -Color Gray -OnLine $OnStdOutLine
                $stdoutRead = $process.StandardOutput.ReadAsync($stdoutChars, 0, $stdoutChars.Length)
            }
        }
        if (-not $stderrEof -and $stderrRead.IsCompleted) {
            $n = $stderrRead.GetAwaiter().GetResult()
            if ($n -le 0) {
                $stderrEof = $true
            } else {
                Emit-CliChunk -Chunk ([string]::new($stderrChars, 0, $n)) -FullBuilder $stderrBuilder -LineBuilder $stderrLine -Color DarkGray -OnLine $OnStdErrLine
                $stderrRead = $process.StandardError.ReadAsync($stderrChars, 0, $stderrChars.Length)
            }
        }

        if ($process.HasExited -and $stdoutEof -and $stderrEof) { break }
        [void]$process.WaitForExit(50)
    }

    if (-not $stdoutEof) {
        try { [void]$stdoutRead.Wait(400) } catch {}
        if ($stdoutRead.IsCompleted) {
            try {
                $n = $stdoutRead.GetAwaiter().GetResult()
                if ($n -gt 0) {
                    Emit-CliChunk -Chunk ([string]::new($stdoutChars, 0, $n)) -FullBuilder $stdoutBuilder -LineBuilder $stdoutLine -Color Gray -OnLine $OnStdOutLine
                }
            } catch {}
        }
    }
    if (-not $stderrEof) {
        try { [void]$stderrRead.Wait(400) } catch {}
        if ($stderrRead.IsCompleted) {
            try {
                $n = $stderrRead.GetAwaiter().GetResult()
                if ($n -gt 0) {
                    Emit-CliChunk -Chunk ([string]::new($stderrChars, 0, $n)) -FullBuilder $stderrBuilder -LineBuilder $stderrLine -Color DarkGray -OnLine $OnStdErrLine
                }
            } catch {}
        }
    }

    Flush-CliRemainder -LineBuilder $stdoutLine -Color Gray -OnLine $OnStdOutLine
    Flush-CliRemainder -LineBuilder $stderrLine -Color DarkGray -OnLine $OnStdErrLine

    $exitCode = 0
    try { $exitCode = $process.ExitCode } catch { $exitCode = 1 }
    try { $process.Dispose() } catch {}

    $stdoutStr = $stdoutBuilder.ToString()
    $stderrStr = $stderrBuilder.ToString()

    if ($killed) {
        throw "EXECUTION_TIMEOUT: $RoleName CLI timed out after $TimeoutSeconds seconds."
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

function Get-FirstCommandPath {
    param(
        [Parameter(Mandatory=$true)][string[]]$Names,
        [string[]]$SkipBaseNames = @()
    )
    $found = @(Get-Command $Names -ErrorAction SilentlyContinue)
    foreach ($c in $found) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($c.Name).ToLowerInvariant()
        if ($SkipBaseNames -contains $base) { continue }
        if (-not [string]::IsNullOrWhiteSpace($c.Source)) { return $c.Source }
    }
    return $null
}

function Get-CursorAgentExecutable {
    return Get-FirstCommandPath -Names @("agent", "agent.exe", "agent.cmd", "cursor-agent", "cursor-agent.exe", "cursor-agent.cmd") -SkipBaseNames @("cursor")
}

function Get-CodexExecutable {
    return Get-FirstCommandPath -Names @("codex", "codex.exe", "codex.cmd", "codex.ps1")
}

function Get-PiExecutable {
    return Get-FirstCommandPath -Names @("pi", "pi.exe", "pi.cmd", "pi.ps1")
}

function Format-CodexReasoningEffort {
    param([string]$effort)
    if ([string]::IsNullOrWhiteSpace($effort)) { return $null }
    $lower = $effort.Trim().ToLowerInvariant()
    switch ($lower) {
        { $_ -in @("none", "off", "disable", "disabled", "false") } { return $null }
        { $_ -in @("low", "fast", "minimal", "min", "2048", "4096") } { return "low" }
        { $_ -in @("medium", "med", "8192", "16384") } { return "medium" }
        { $_ -in @("xhigh", "extra-high", "max", "64000", "65536") } { return "xhigh" }
        { $_ -in @("high", "think", "deepthink", "24576", "32768") } { return "high" }
        { $_ -in @("low", "medium", "high", "xhigh") } { return $lower }
        default { return "high" }
    }
}

function Format-PiThinking {
    param([string]$effort)
    if ([string]::IsNullOrWhiteSpace($effort)) { return $null }
    $lower = $effort.Trim().ToLowerInvariant()
    switch ($lower) {
        { $_ -in @("none", "off", "disable", "disabled", "false", "0") } { return "off" }
        { $_ -in @("minimal", "min") } { return "minimal" }
        { $_ -in @("low", "fast", "2048", "4096") } { return "low" }
        { $_ -in @("medium", "med", "8192", "16384") } { return "medium" }
        { $_ -in @("high", "think", "deepthink", "24576", "32768", "xhigh", "max", "64000", "65536") } { return "high" }
        { $_ -in @("off", "minimal", "low", "medium", "high", "xhigh") } { return $lower }
        default { return "high" }
    }
}

function Build-CursorAgentArgs {
    param(
        [string]$Model,
        [string]$WorkspaceRoot,
        [switch]$AskMode
    )
    $argsList = @("--print", "--trust", "--force", "--sandbox", "disabled")
    if ($AskMode) { $argsList += @("--mode", "ask") }
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $argsList += @("--workspace", $WorkspaceRoot) }
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
    return $argsList
}

function Build-CodexExecArgs {
    param(
        [string]$Model,
        [string]$ReasoningEffort,
        [ValidateSet("dev", "review")][string]$Role = "dev"
    )
    $sandbox = if ($Role -eq "review") { "read-only" } else { "workspace-write" }
    $argsList = @("exec", "--skip-git-repo-check", "-a", "never", "-s", $sandbox)
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
    $effort = Format-CodexReasoningEffort $ReasoningEffort
    if (-not [string]::IsNullOrWhiteSpace($effort)) { $argsList += @("-c", "model_reasoning_effort=$effort") }
    $argsList += "-"
    return $argsList
}

function Build-AgyPrintArgs {
    param(
        [string]$Model,
        [string]$ReasoningEffort,
        [string]$PrintTimeout = "25m"
    )
    $argsList = @("--dangerously-skip-permissions", "--print-timeout", $PrintTimeout)
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
    $agyEffort = Format-AgyReasoningEffort $ReasoningEffort
    if ([string]::IsNullOrWhiteSpace($agyEffort) -and ($Model -match "gemini-3.7" -or [string]::IsNullOrWhiteSpace($Model))) {
        $agyEffort = "high"
    }
    if (-not [string]::IsNullOrWhiteSpace($agyEffort)) { $argsList += @("--effort", $agyEffort) }
    # Prompt must stay on stdin (never `--print $Prompt`) to avoid the Windows ~32K CreateProcess limit.
    $argsList += "--print"
    return $argsList
}

function Build-PiAgentArgs {
    param(
        [string]$Model,
        [string]$ReasoningEffort,
        [switch]$ReadOnly
    )
    $argsList = @("-p")
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $argsList += @("--model", $Model) }
    $think = Format-PiThinking $ReasoningEffort
    if (-not [string]::IsNullOrWhiteSpace($think)) { $argsList += @("--thinking", $think) }
    if ($ReadOnly) { $argsList += @("--tools", "read,grep,find,ls") }
    return $argsList
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

            $discPath = Join-Path $WorkspaceRoot ".ai-workspace\requirement-discussion.json"
            if (-not (Test-Path -LiteralPath $discPath)) {
                $discPath = Join-Path $WorkspaceRoot "requirement-discussion.json"
            }
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

function Convert-ReviewerCliResult {
    param(
        [Parameter(Mandatory=$true)]$Result,
        [Parameter(Mandatory=$true)][string]$ProviderLabel
    )
    $exitCode = [int](Get-ObjectPropertyValue -Object $Result -Name "ExitCode" -Default 1)
    $combined = [string](Get-ObjectPropertyValue -Object $Result -Name "Combined" -Default "")
    # Exit code first: a crashed CLI that printed an APPROVED blob must not pass review.
    if ($exitCode -ne 0) {
        throw "REVIEWER_EXECUTION_FAILED: $($ProviderLabel) failed with exit code $($exitCode): $combined"
    }
    $jsonObj = Extract-JsonFromText -Text $combined
    if ($null -ne $jsonObj) { return $jsonObj }
    throw "PROVIDER_OUTPUT_INVALID: $($ProviderLabel) returned non-JSON review output: $combined"
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

function Get-ObjectPropertyValue {
    param(
        [Parameter(Mandatory=$false)]$Object,
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$false)]$Default = ""
    )
    if ($null -eq $Object) { return $Default }

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            $val = $Object[$Name]
            if ($null -eq $val) { return $Default }
            return $val
        }
    }

    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Get-MailboxResumeKind {
    param(
        [Parameter(Mandatory=$false)]$Mailbox,
        [Parameter(Mandatory=$false)][string]$ExpectedFeature = ""
    )
    if ($null -eq $Mailbox) { return "none" }

    $feature = [string](Get-ObjectPropertyValue -Object $Mailbox -Name "feature" -Default "")
    if (-not [string]::IsNullOrWhiteSpace($ExpectedFeature) -and -not [string]::IsNullOrWhiteSpace($feature) -and $feature -ne $ExpectedFeature) {
        return "none"
    }

    $status = [string](Get-ObjectPropertyValue -Object $Mailbox -Name "status" -Default "")
    switch ($status) {
        "WAITING_DEV" { return "dev" }
        "WAITING_REVIEW" { return "review" }
        default { return "none" }
    }
}

function Get-NextRoundDevPrompt {
    param(
        [Parameter(Mandatory=$true)]$Mailbox,
        [Parameter(Mandatory=$false)][int]$CompletedRound = 0
    )
    $lastReview = $null
    $history = Get-ObjectPropertyValue -Object $Mailbox -Name "history" -Default @()
    $histArr = @($history)
    if ($histArr.Count -gt 0) {
        $lastEntry = $histArr[-1]
        $lastReview = Get-ObjectPropertyValue -Object $lastEntry -Name "reviewVerdict" -Default $null
    }

    $sev = [string](Get-ObjectPropertyValue -Object $lastReview -Name "highestSeverity" -Default "NONE")
    $sum = [string](Get-ObjectPropertyValue -Object $lastReview -Name "summary" -Default "")
    $next = [string](Get-ObjectPropertyValue -Object $lastReview -Name "nextPromptForDev" -Default "")
    $roundLabel = if ($CompletedRound -gt 0) { $CompletedRound } else { "previous" }
    return "Round $roundLabel Review REJECTED (Highest Severity: $sev).`nSummary: $sum`n`nInstructions for next round:`n$next"
}

function Invoke-MailboxScriptIsolated {
    param(
        [Parameter(Mandatory=$true)][string]$ScriptPath,
        [Parameter(Mandatory=$true)][hashtable]$Parameters,
        [Parameter(Mandatory=$false)][string]$WorkingDirectory = $PWD.Path,
        [Parameter(Mandatory=$false)][int]$TimeoutSeconds = 120
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "MAILBOX_SCRIPT_NOT_FOUND: Target mailbox script '$ScriptPath' does not exist."
    }

    $payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ("mbx_params_" + [guid]::NewGuid().ToString("N") + ".json")
    try {
        $json = $Parameters | ConvertTo-Json -Depth 20 -Compress
        [System.IO.File]::WriteAllText($payloadPath, $json, [System.Text.UTF8Encoding]::new($false))

        $safePayload = $payloadPath.Replace("'", "''")
        $safeScript = $ScriptPath.Replace("'", "''")
        $cmd = @"
`$ErrorActionPreference = 'Stop'
`$raw = [System.IO.File]::ReadAllText('$safePayload', [System.Text.Encoding]::UTF8)
`$obj = `$raw | ConvertFrom-Json
`$ht = @{}
foreach (`$p in `$obj.PSObject.Properties) { `$ht[`$p.Name] = `$p.Value }
& '$safeScript' @ht
"@

        $pwshCmd = Get-Command "pwsh" -ErrorAction SilentlyContinue
        $pwshPath = if ($pwshCmd) { $pwshCmd.Source } else { "pwsh" }

        $res = Invoke-CliWithTimeout `
            -ExecutablePath $pwshPath `
            -Arguments @("-NoProfile", "-Command", $cmd) `
            -WorkingDirectory $WorkingDirectory `
            -RoleName "MailboxScript" `
            -TimeoutSeconds $TimeoutSeconds

        return $res
    } finally {
        if (Test-Path -LiteralPath $payloadPath) {
            Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
        }
    }
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

            $argsList = Build-AgyPrintArgs -Model $Model -ReasoningEffort $ReasoningEffort

            $maxAttempts = 3
            for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
                $res = Invoke-CliWithTimeout -ExecutablePath $agyCmd.Source -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Antigravity)" -TimeoutSeconds 1800
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
            $cursorExe = Get-CursorAgentExecutable
            if (-not $cursorExe) {
                throw "PROVIDER_UNAVAILABLE: Cursor Agent CLI ('agent' / 'cursor-agent') is not found in PATH. The GUI 'cursor' binary is not a coding-agent CLI."
            }
            $argsList = Build-CursorAgentArgs -Model $Model -WorkspaceRoot $WorkspaceRoot
            $res = Invoke-CliWithTimeout -ExecutablePath $cursorExe -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Cursor)"
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Cursor Agent CLI exited with code $($res.ExitCode)." }
        }
        "codex" {
            $codexExe = Get-CodexExecutable
            if (-not $codexExe) { throw "PROVIDER_UNAVAILABLE: OpenAI Codex CLI ('codex') is not found in PATH." }
            $argsList = Build-CodexExecArgs -Model $Model -ReasoningEffort $ReasoningEffort -Role "dev"
            $res = Invoke-CliWithTimeout -ExecutablePath $codexExe -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Codex)"
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Codex CLI exited with code $($res.ExitCode)." }
        }
        "pi" {
            $piExe = Get-PiExecutable
            if (-not $piExe) { throw "PROVIDER_UNAVAILABLE: Pi coding agent CLI ('pi') is not found in PATH." }
            $argsList = Build-PiAgentArgs -Model $Model -ReasoningEffort $ReasoningEffort
            $res = Invoke-CliWithTimeout -ExecutablePath $piExe -Arguments $argsList -StdinText $Prompt -WorkingDirectory $WorkspaceRoot -RoleName "Dev (Pi)"
            if ($res.ExitCode -ne 0) { throw "DEV_AGENT_EXECUTION_FAILED: Pi CLI exited with code $($res.ExitCode)." }
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
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "GitHub Copilot CLI")
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
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "Claude CLI")
        }
        "antigravity" {
            $agyCmd = Get-Command "agy", "agy.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $agyCmd) { throw "PROVIDER_UNAVAILABLE: Antigravity CLI ('agy') is not found in PATH." }

            $argsList = Build-AgyPrintArgs -Model $Model -ReasoningEffort $ReasoningEffort
            $maxAttempts = 3
            $res = $null
            for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
                $res = Invoke-CliWithTimeout -ExecutablePath $agyCmd.Source -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Antigravity)" -TimeoutSeconds 1800
                if ($res.ExitCode -eq 0) { break }

                $isTransient = ($res.Combined -match "timeout waiting for response" -or $res.Combined -match "Eligibility check failed" -or $res.Combined -match "EOF" -or $res.Combined -match "handshake")
                if ($isTransient -and $attempt -lt $maxAttempts) {
                    Write-Host "⚠️ Transient network glitch from Antigravity ($($res.Combined.Trim())). Retrying attempt $($attempt + 1)/$maxAttempts in 3 seconds..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 3
                } else {
                    break
                }
            }
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "Antigravity CLI")
        }
        "cursor" {
            $cursorExe = Get-CursorAgentExecutable
            if (-not $cursorExe) {
                throw "PROVIDER_UNAVAILABLE: Cursor Agent CLI ('agent' / 'cursor-agent') is not found in PATH. The GUI 'cursor' binary is not a coding-agent CLI."
            }
            $argsList = Build-CursorAgentArgs -Model $Model -WorkspaceRoot $WorkspaceRoot -AskMode
            $res = Invoke-CliWithTimeout -ExecutablePath $cursorExe -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Cursor)"
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "Cursor Agent CLI")
        }
        "codex" {
            $codexExe = Get-CodexExecutable
            if (-not $codexExe) { throw "PROVIDER_UNAVAILABLE: OpenAI Codex CLI ('codex') is not found in PATH." }
            $argsList = Build-CodexExecArgs -Model $Model -ReasoningEffort $ReasoningEffort -Role "review"
            $res = Invoke-CliWithTimeout -ExecutablePath $codexExe -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Codex)"
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "Codex CLI")
        }
        "pi" {
            $piExe = Get-PiExecutable
            if (-not $piExe) { throw "PROVIDER_UNAVAILABLE: Pi coding agent CLI ('pi') is not found in PATH." }
            $argsList = Build-PiAgentArgs -Model $Model -ReasoningEffort $ReasoningEffort -ReadOnly
            $res = Invoke-CliWithTimeout -ExecutablePath $piExe -Arguments $argsList -StdinText $systemInstruction -WorkingDirectory $WorkspaceRoot -RoleName "Reviewer (Pi)"
            return (Convert-ReviewerCliResult -Result $res -ProviderLabel "Pi CLI")
        }
        default {
            throw "UNSUPPORTED_REVIEWER_PROVIDER: Provider '$Provider' is not configured for automatic review execution. Provide -ReviewerCustomHook or use -ReviewProvider 'mock'."
        }
    }
}
