# AGENTS.md - Dual-Agent Studio AI Agent Guidelines & Architecture Manual

> **Universal 100% Autonomous Dual-Agent Orchestration Studio & Web Cockpit**  
> **Default Author Tag**: `shuyongqiang`  
> **Target Environment**: Windows (PowerShell 7.0+ / Node.js 18.0+)  
> **Network Environment**: Local Proxy `http://127.0.0.1:10809` (HTTP / HTTPS)

---

## 1. Project Overview & Philosophy

**Dual-Agent Studio** is a workspace-agnostic, zero-external-dependency orchestration cockpit and autonomous development-review engine. It pairs a **Developer Agent** (Claude Code, GitHub Copilot CLI, Aider, Antigravity) with an independent **Reviewer Agent** (GitHub Copilot CLI, Claude, etc.) through automated test verification gates, requirement alignment discussions, and multi-round self-healing feedback loops.

### Key Architectural Tenets:
1. **Zero External Runtime Dependencies**: The backend runs entirely on Node.js built-in standard libraries (`http`, `fs`, `path`, `os`, `child_process`) without `npm install` requirements.
2. **Workspace-Agnostic**: The studio can target any external codebase without polluting the target repo root. Runtime state (discussion records, default mailbox, implementation plan) lives under `.ai-workspace/` (plus optional `.ai-sop/`). Never write `IMPLEMENTATION_PLAN.md` or `requirement-discussion.json` at the target root.
3. **Fail-Fast Rigor**: External agent CLI failures, syntax crashes, or test gate failures must halt or self-heal immediately—never allow false-positive "APPROVED" verdicts on broken runs.
4. **Session Isolation**: Developer and Reviewer maintain independent, persistent session UUIDs to enable continuous contextual memory across iterative rounds.

---

## 2. Codebase Layout & Directory Map

```text
d:\project\dual-agent-studio\
├── server.js                   # Lightweight HTTP + Server-Sent Events (SSE) backend server
├── start.bat                   # Windows batch launcher (launches server and opens default browser)
├── start.ps1                   # PowerShell 7 startup script with proxy configuration
├── models-config.json          # Provider catalog, model presets, and reasoning effort schemas
├── projects.json               # Persistent list of recently accessed workspace paths
├── package.json                # Project metadata & npm test script bindings
├── AGENTS.md                   # This instruction and architecture document for AI Agents
├── README.md                   # User-facing manual and quickstart guide
├── engine/
│   ├── orchestrator.ps1        # Core PowerShell Autonomous Loop Orchestrator engine
│   └── browse-folder.ps1       # Native Windows folder picker dialog bridge
├── lib/
│   └── studio-core.js          # Pure helpers: mailbox, sessions, diff, proxy, provider command builders
├── public/                     # Modern dark-themed web cockpit (Pure Vanilla JS/CSS)
│   ├── index.html              # Cockpit layout: Workspace, Config, Discussion, Cockpit, Logs
│   ├── app.js                  # Reactive state machine, SSE log listener, diff parser, model picker
│   └── style.css               # Styling, animations, badge pill components, and syntax theme
├── scripts/
│   └── run-all-tests.ps1       # Helper test runner script
└── tests/
    └── orchestrator.tests.ps1  # Automated test suite covering all orchestrator execution modes
```

---

## 3. Core Components & Technical Details

### 3.1 Backend Server (`server.js`)
- **Port**: Default `3700` (configurable via `PORT` env).
- **REST Endpoints**:
  - `GET /api/status?workspace=...`: Returns current running state, process PID, and latest `mailbox` state.
  - `POST /api/start`: Spawns `pwsh -File engine/orchestrator.ps1` with `-TaskPromptFile` (never a huge `-TaskPrompt` argv). If the process exits while mailbox status is still `WAITING_DEV` or `WAITING_REVIEW`, the server auto-respawns the loop (unless the user clicked Stop).
  - `POST /api/stop`: Gracefully terminates the running PowerShell orchestrator process tree.
  - `POST /api/discuss`: Runs multi-round collaborative requirements analysis between Dev and Reviewer before execution. Persists to `.ai-workspace/requirement-discussion.json` (legacy root file is still readable).
  - `GET /api/diff?workspace=...`: Per-file 256KB / total 64k safe git diff (skips lockfiles, binaries, `node_modules`, mailbox JSON).
  - `GET /api/projects` & `POST /api/projects`: Reads/writes recent workspace history in `projects.json`.
  - `POST /api/detect-workspace`: Auto-detects project stack (Maven, Gradle, npm, Go, Cargo, Python, etc.) and infers default test gate commands.
  - `GET /api/models`: Serves `models-config.json` for frontend model/reasoning dropdowns.
  - `GET /api/events`: SSE event stream transmitting real-time stdout/stderr/system logs to web clients.
  - `GET /api/logs`: JSON snapshot of in-memory logs (used on page refresh / SSE reconnect).
  - `POST /api/browse-folder`: Launches native Windows folder selection dialog via `engine/browse-folder.ps1`.

### 3.2 Orchestrator Engine (`engine/orchestrator.ps1`)
- Drives the multi-round iterative loop:
  1. **Phase 1 (Dev Turn)**: Invokes Dev Provider (`Invoke-DevTurn`) with initial prompt or previous review feedback.
  2. **Phase 2 (Test Gate Verification)**: Executes `-VerifyCommand` (e.g., `.\gradlew test` or `npm test`). If failed, triggers local self-healing retries.
  3. **Phase 3 (Reviewer Turn)**: Collects `git diff HEAD` and invokes Reviewer Agent (`Invoke-ReviewerTurn`) for architectural and security review. Reviewer **must check CLI exit code before** parsing JSON — a crashed CLI that printed an `APPROVED` blob is `REVIEWER_EXECUTION_FAILED`, never a false pass.
  4. **Phase 4 (Verdict & Decision Gate)**: If `APPROVED`, optionally runs auto-commit; if `REJECTED`, auto-advances to the next round; if max rounds exceeded, halts with `REJECTED_MAX_ROUNDS`.
  5. **Exception Interception**: Catches CLI crashes or uncaught exceptions, records `status = "FAILED"`, persists `$mailbox.error`, and terminates cleanly.

### 3.3 Mailbox State Protocol (`review-mailbox.json`)
Default path is `.ai-sop/review-mailbox.json` if present, otherwise `.ai-workspace/specs/features/<Feature>/review-mailbox.json`. The orchestrator and frontend communicate via this state mailbox JSON file:
```json
{
  "schemaVersion": "1.0",
  "feature": "FeatureName",
  "round": 1,
  "maxRounds": 3,
  "status": "APPROVED",
  "error": "",
  "devAgent": "CLAUDE",
  "reviewerAgent": "COPILOT",
  "devSessionId": "1112735a-d270-4a18-bb38-1a6ba5f73112",
  "reviewSessionId": "f36c90de-7c4b-4e3f-9939-9a21e0942926",
  "updatedAt": "2026-08-28T17:00:00.000Z",
  "currentDevSubmission": {
    "summary": "Round 1 changes implemented.",
    "testGateStatus": "PASS"
  },
  "currentReviewVerdict": {
    "verdict": "APPROVED",
    "highestSeverity": "NONE",
    "summary": "Code satisfies all requirements.",
    "issues": [],
    "nextPromptForDev": ""
  },
  "history": []
}
```

**Status Enum**: `INITIALIZED` | `WAITING_DEV` | `WAITING_REVIEW` | `APPROVED` | `REJECTED_MAX_ROUNDS` | `FAILED`

---

## 4. Critical Windows & CLI Invocation Rules for Agents

When extending or maintaining this project, AI agents **MUST** follow these Windows-specific execution rules:

### 4.0 Proxy Inheritance (Engine Must Not Hardcode 10809)
- Launchers (`start.ps1` / `restart.ps1` / `start.bat`) default `http_proxy`/`https_proxy` to `http://127.0.0.1:10809` when unset.
- Set `DUAL_AGENT_NO_PROXY=1` to skip launcher injection.
- `engine/orchestrator-lib.ps1` and `server.js` only inherit ambient `http_proxy` / `HTTPS_PROXY` / `DUAL_AGENT_PROXY` — they must never inject a hardcoded 10809 fallback.

### 4.1 Multi-Line Prompt Passing to CLI Agents (Never Use `-p` with Quotes)
- **Problem**: In Windows PowerShell and `cmd.exe`, passing multi-line strings containing newlines and double quotes via `-p "<text>"` causes npm wrapper scripts (`copilot.ps1`, `claude.cmd`) to truncate arguments at the first newline, triggering `error: option '-p, --prompt <text>' argument missing`.
- **Rule**: Always pass prompts via standard input (Pipeline / Stdin) or temp files. This includes Antigravity: use `--print` **without** putting `$Prompt` on argv (`--print $Prompt` hits the Windows ~32K CreateProcess limit).
  ```powershell
  # Recommended for PowerShell:
  $Prompt | & $copilotCmd.Source @argsList
  # Antigravity:
  $Prompt | & agy --dangerously-skip-permissions --print-timeout 25m --print

  # Recommended for Node.js child_process:
  Get-Content -Raw -LiteralPath '$safeTmp' | & copilot -s --allow-all
  ```

### 4.2 PowerShell `$LASTEXITCODE` Fail-Fast Check
- External CLI commands (like `& claude` or `& copilot`) do **NOT** throw PowerShell exceptions when they exit with non-zero exit codes.
- **Rule**: Always check `$LASTEXITCODE` immediately after any external command execution:
  ```powershell
  if ($LASTEXITCODE -ne 0) {
      throw "DEV_AGENT_EXECUTION_FAILED: CLI exited with error code $LASTEXITCODE."
  }
  ```

### 4.3 Safe String Interpolation in PowerShell
- In double-quoted PowerShell strings, never use `$var:` without wrapping in `$($var):`, because `$var:` is parsed as a namespace scope prefix (e.g. `$global:`).
  - ❌ Incorrect: `"Error code $code: $msg"`
  - ✅ Correct: `"Error code $($code): $msg"`

### 4.4 Session IDs are Copilot-only at the CLI
Studio still generates and persists `devSessionId` / `reviewSessionId` in the mailbox for every engine. **Only GitHub Copilot CLI** receives `--session-id`. Cursor / Codex / Claude / Pi / Antigravity ignore the field today; the cockpit must not imply they resume chat.

---

## 5. Development & Testing Workflow

### 5.1 Running Automated Unit & Integration Tests
Before submitting any changes, execute the test suite:
```powershell
# In PowerShell:
pwsh -NoProfile -File ./tests/orchestrator.tests.ps1

# Or via npm:
npm test
```
The test suite validates:
1. Basic single-round approval workflow (`mock` dev & reviewer).
2. Multi-round rejection self-healing loop leading to round 2 approval.
3. Max-round limit enforcement (`REJECTED_MAX_ROUNDS`).
4. Test gate failure handling & self-healing retry limits (`TEST_GATE_SELF_HEAL_EXCEEDED`).
5. Markdown-fenced JSON review output extraction.
6. Independent Dev & Reviewer session ID preservation.
7. Agent CLI crash fail-fast handling and `FAILED` mailbox state transition.
8. Live CLI stdout streaming (line callbacks fire before process exit).
9. `-TaskPromptFile` loading and default mailbox isolation under `.ai-workspace/`.
10. Engine proxy inherit (no hardcoded 10809) and safe `/api/diff` budgets.
11. Cursor Agent / Codex exec / Pi print-mode builders; missing CLIs throw `PROVIDER_UNAVAILABLE`.
12. Local CSP (no Google Fonts) and `lib/studio-core.js` helper extraction.
13. Reviewer JSON is ignored when CLI exit code ≠ 0 (no false `APPROVED`).
14. Discussion turns fail-fast on non-zero process exit; Copilot discussion PATH-checks like other engines.
15. Antigravity `--print` is flag-only (prompt on stdin); discussion reviewer sandboxes match the coding loop (`--mode ask` / `read-only` / restricted Pi tools).

### 5.2 Server Process Management
- If modifying `server.js`, restart the node process so that changes take effect immediately:
  ```powershell
  # Check and stop existing instance on port 3700:
  Get-NetTCPConnection -LocalPort 3700 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
  
  # Start server:
  node server.js
  ```

### 5.3 Git Commits & Proxy Rules
- Always use the proxy when interacting with remote git repositories:
  ```powershell
  $env:http_proxy="http://127.0.0.1:10809"
  $env:https_proxy="http://127.0.0.1:10809"
  git add -A
  git commit -m "feat/fix(scope): clear description"
  git push
  ```
