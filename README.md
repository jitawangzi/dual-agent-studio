# 🚀 Dual-Agent Studio (双 Agent 研发协同与审查驾驶舱)

> **Universal 100% Autonomous Dual-Agent Orchestrator & Web Cockpit**  
> 跨项目通用、零环境依赖的双 Agent 协同开发与代码审查驾驶舱。支持 Claude Code、GitHub Copilot CLI、Aider、Antigravity 与各类大模型无缝配合，自动执行测试门禁、闭环自愈并直观展示多轮审查报告与 Git 变更。

---

## 一、核心特性

- 🎯 **跨项目通用（Workspace-Agnostic）**：可指向任何本地代码仓库（如 `D:\project\agent-sop`、`D:\svn\server_new` 等）。讨论记录、默认 mailbox 与实施计划写入目标仓的 `.ai-workspace/`，不污染仓库根目录。
- 🤖 **多引擎与模型深度调优**：
  - **Dev Agent**：Claude Code CLI、GitHub Copilot CLI、Aider、Antigravity、**Cursor Agent CLI**（`agent` / `cursor-agent`，不是 GUI 的 `cursor`）、**OpenAI Codex CLI**（`codex exec`）、**Pi Coding Agent**（`pi -p`）。提示词一律走 stdin / 临时文件，CLI 不在 PATH 时立即失败而不是假装成功。
  - **Reviewer Agent**：同上；Codex 审查使用 `read-only` sandbox，Cursor 使用 `--mode ask`，Pi 限制为只读工具。CLI 非 0 退出即使打印了 `APPROVED` JSON 也判定失败。
  - **会话 ID**：目前只有 GitHub Copilot CLI 会把 Session ID 传给 `--session-id`；其他引擎的字段仅写入 mailbox，不会续聊。
  - **需求讨论**：审查方使用与编码闭环相同的只读沙箱；讨论进程非 0 退出立即失败，不会拿半截输出当共识。
- 📊 **可视化多轮流转时间轴（Round Timeline）**：直观展示每一轮 Dev 提交、自动化测试状态、Reviewer 审查判定（APPROVED / REJECTED）、缺陷清单与下轮自愈指令。
- 🔍 **实时 Git 变更查看器（Diff Viewer）**：无需跳出浏览器即可查看未提交变更与文件增删高亮。
- 💻 **实时日志流（Live SSE Logs）**：双 Agent 与测试门禁的实时终端控制台输出。
- 📦 **自动提交（Auto Commit）**：审查通过（APPROVED）后自动创建 Git Commit。
- ⚡ **共识后可选自动开跑**：驾驶舱勾选「需求讨论达成共识后自动进入编码闭环」即可跳过人工确认闸门。
- 🔌 **代理继承**：引擎不强制 `127.0.0.1:10809`。启动脚本在环境变量为空时才写入该默认值；设置 `DUAL_AGENT_NO_PROXY=1` 可完全跳过。

---

## 二、快速启动

### 方式 1：双击 Windows 批处理（推荐）
直接双击运行工程根目录下的：
```cmd
start.bat
```
系统将自动启动轻量后端并在默认浏览器中打开驾驶舱：`http://localhost:3700`。

### 方式 2：PowerShell 启动
```powershell
pwsh -NoProfile -File ./start.ps1
```

### 方式 3：纯 CLI 无人值守模式
如果你只需要在后台或者脚本中运行，也可以直接调用底层引擎：
```powershell
pwsh -NoProfile -File ./engine/orchestrator.ps1 `
    -WorkspaceRoot "D:\project\agent-sop" `
    -TaskPromptFile "D:\tmp\task-prompt.txt" `
    -DevProvider "claude" `
    -DevModel "claude-3-7-sonnet-20250219" `
    -DevReasoningEffort "high" `
    -ReviewProvider "copilot" `
    -ReviewModel "gpt-5.4" `
    -ReviewReasoningEffort "high" `
    -CopilotSessionId "9fa43261-d96c-430b-ac43-20e3035ec1bf" `
    -VerifyCommand "pwsh -NoProfile -File ./scripts/run-all-tests.ps1" `
    -MaxRounds 4 `
    -AutoCommit
```

---

## 三、工程结构

```text
D:\project\dual-agent-studio\
├── start.bat                   # 一键启动批处理 (自动打开浏览器)
├── start.ps1                   # PowerShell 启动脚本
├── server.js                   # 纯原生零依赖 Node.js HTTP + SSE 本地服务
├── lib\
│   └── studio-core.js          # mailbox / 会话 / Diff / 代理 / CLI 命令拼装
├── package.json                # 项目元数据
├── README.md                   # 本说明文档
├── engine\
│   └── orchestrator.ps1        # 通用双 Agent 调度编排引擎
├── public\
│   ├── index.html              # 现代深色驾驶舱前端界面
│   ├── app.js                  # 响应式前端状态机、SSE 监听器、Diff 渲染器
│   └── style.css               # 样式表与语法高亮
└── tests\
    └── orchestrator.tests.ps1  # 自动化测试套件
```

---

## 四、自动化测试

```powershell
pwsh -NoProfile -File ./tests/orchestrator.tests.ps1
```