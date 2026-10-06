# 🚀 Dual-Agent Studio (双 Agent 研发协同与审查驾驶舱)

> **Dual-Agent Studio 2.9：审核闭环总览、统一待办与人工验收。**
> Windows / PowerShell 7 / Node.js 18+；后端只使用 Node.js 内置库，无需安装 npm 运行时依赖。Agent CLI 与登录需要预先准备。

**新版使用方式见 [2.0 工作流说明](docs/workflows-v2.md)。**
**2.2 新增操作和边界见 [审核准备与人工分诊](docs/version-2.2.md)。**
**2.3 新增操作和边界见 [独立验证发现与分诊筛选](docs/version-2.3.md)。**
**2.4 新增操作和边界见 [跨次问题跟踪与复查](docs/version-2.4.md)。**
**2.5 新增操作和边界见 [团队讨论与人工决策](docs/version-2.5.md)。**
**2.7 新增操作和边界见 [审核证据与覆盖范围](docs/version-2.7.md)。**
**2.8 新增操作和边界见 [审核分工与缺口补审](docs/version-2.8.md)。**
**2.9 新增操作和边界见 [审核闭环总览与人工验收](docs/version-2.9.md)。**
**后续 2.10–2.14 的路线图、实施计划与其他模型接手提示词见 [开发交接入口](docs/handoff/README.md)。**
**2.6 新增操作和边界见 [草稿恢复、局部重试与版本对比](docs/version-2.6.md)。**

- **需求讨论**：配置 2–6 位成员的角色、引擎、模型、思考强度及提示词；先调查工程，再独立提案与交叉质询。人工逐项取舍、编辑验收条件和答复问题，预览并批准后实施。
- **方案验收**：批准版本绑定源码和逐项验收条件。复核必须对每条条件提供结果与证据；业务条件不清时暂停决策。补充意见可生成新版讨论，继续运行时明确选择已批准版本。
- **并行审核**：为 1–8 位审核员分别指定引擎、模型、思考强度与提示词，最多 4 位并发；报告保留来源，人工确认问题或采纳建议后勾选修复。
- **审核准备**：检查 CLI 安装及必要参数，按需执行真实模型连通测试；团队配置可保存为全局或项目模板。
- **人工分诊**：记录复现依据、业务待确认、误报或暂缓；历史随证据保留，证据变化后重新判断。
- **独立验证发现**：单独配置验证模型与强度，检查源码证据，可执行你明确提供的复现命令；保留验证步骤、实际输出与局限，再由你分诊。
- **发现筛选**：按关键词、类别、严重程度、分诊及验证状态缩小范围，避免遗漏或误选。
- **项目问题台账**：关联历次审核和修复证据，保留重复发现、关闭后再次出现及人工判断历史；漏报不会自动关闭问题。
- **定向复查与进展**：审核导入的修复先逐项验证旧问题，再整体回归；无进展、争议或测试自愈耗尽时等待人工决策。
- **审查修复**：先审查现有工程，再修复、测试和独立复核；跨轮 Bug 台账防止漏报误关。
- **运行恢复**：运行历史、原始证据、阶段检查点持久化；中断后先重新测试和审查。
- **验收约束**：默认连续两轮无新增问题、全部旧 Bug 复核关闭、测试通过才能完成。

网页使用新版 `/api/runs` 和 `/api/audits`。下方旧版 CLI 示例与 `/api/start` 保留兼容，仍使用原 Mailbox 流程。
执行全部测试请运行 `npm test`，或 `pwsh -NoProfile -File ./scripts/run-all-tests.ps1`。

---

## 一、核心特性

- 🎯 **跨项目通用（Workspace-Agnostic）**：可指向任何本地代码仓库（如 `D:\project\agent-sop`、`D:\svn\server_new` 等），零侵入。
- 🤖 **多引擎与模型深度调优**：
  - **Dev Agent**：Claude Code CLI、GitHub Copilot CLI、Aider、Antigravity；支持自由指定模型与思考深度（Reasoning Effort / Thinking Tokens）。
  - **Reviewer Agent**：GitHub Copilot CLI（支持 Session Resume `9fa43261...`、`gpt-5.4`、`claude-3.7-sonnet`、`o3-mini`）、Claude 等。
- 📊 **可视化多轮流转时间轴（Round Timeline）**：直观展示每一轮 Dev 提交、自动化测试状态、Reviewer 审查判定（APPROVED / REJECTED）、缺陷清单与下轮自愈指令。
- 🔍 **实时 Git 变更查看器（Diff Viewer）**：无需跳出浏览器即可查看未提交变更与文件增删高亮。
- 💻 **实时日志流（Live SSE Logs）**：双 Agent 与测试门禁的实时终端控制台输出。
- 📦 **自动提交（Auto Commit）**：审查通过（APPROVED）后自动创建 Git Commit。

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
    -TaskPrompt "优化两阶段事务协调器" `
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
