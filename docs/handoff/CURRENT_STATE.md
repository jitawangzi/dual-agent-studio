# 当前实现与已知边界

核对时间：2026-10-06。工程目录 `D:\project\dual-agent-studio`，交付分支 `codex/parallel-audit`。最初整理交接时基于 `ee89f714eedde4e99285a94513c619d1fd67ed1e` 且实现尚未提交；用户随后授权把2.9源码、测试及交接包统一提交。接手请使用该交付分支的版本提交，不要把最初基线SHA或远程默认main当成2.9快照。远程main的其他更新尚未合并到本交付分支。

## 用户真正要的工作流

1. 用户有优化方向但不一定能完整描述需求，多名 Agent 先调查和讨论，由用户最终决定方案。
2. 多名审核员并行查 Bug、实现方式和设计问题；每名审核员可配置模型、思考强度、提示词和范围。
3. 发现问题后人工分诊，一个 Agent 修复，另一个 Agent 独立验证；多轮继续直到满足明确条件。
4. 不能把执行成功、模型声称完成、没有再次提到问题，误当成审核或修复完成。
5. 用户愿意长期维护工具，但在意额度；不要默认调用昂贵模型、开很多子 Agent 或自动无限重试。

## 已实现的版本

| 版本 | 已实现能力 | 文档 |
|---|---|---|
| 2.0–2.1 | 持久化开发/审核闭环、方案审批、并行只读审核、发现导入修复 | [工作流](../workflows-v2.md) |
| 2.2 | 环境检查、按需模型探测、团队模板、人工分诊与历史 | [2.2](../version-2.2.md) |
| 2.3 | 独立验证发现、显式复现命令与日志、筛选 | [2.3](../version-2.3.md) |
| 2.4 | 跨次问题台账、定向验证旧问题、无进展暂停 | [2.4](../version-2.4.md) |
| 2.5 | 多成员调查/提案/质询、人工决策、结构化验收条件 | [2.5](../version-2.5.md) |
| 2.6 | 决策草稿恢复、双页面冲突、失败步骤局部重试、上一版对比 | [2.6](../version-2.6.md) |
| 2.7 | 来源/测试证据、覆盖范围、原始回答与日志、每轮变更证据 | [2.7](../version-2.7.md) |
| 2.8 | 每人必查清单、缺口选择补审、新会话与原报告关联 | [2.8](../version-2.8.md) |
| 2.9 | 关联审核组闭环总览、待办、真实验收测试、人工验收、源码变更失效 | [2.9](../version-2.9.md) |

较新版本会补充旧版文档的限制。例如 2.5 写的“刷新丢失未批准输入”已由 2.6 草稿功能改善；不能据此重新实现一次。

## 代码入口地图

| 文件 | 职责 / 接手注意 |
|---|---|
| `server.js` | HTTP/SSE、工作流共享互斥、静态页面、旧接口兼容；业务尽量放 engine 模块 |
| `engine/run-store.js` | `.studio` 的 JSON 原子保存、记录读取、方案审批；kind 当前只允许 runs/plans/audits/discussions |
| `engine/workflow.js` | 开发→测试→定向复核→整体复核；源码指纹、跨轮 Bug 状态与恢复 |
| `engine/audit-workflow.js` | 审核员并发、解析报告、补审/修复/独立验证入口；检查旧进程 |
| `engine/audit-assignment.js` | 必查项归一化、缺口计算、补审版本摘要 |
| `engine/audit-closure.js` | 只读推导关联组覆盖、发现、修复证据、测试与验收有效性 |
| `engine/audit-closure-actions.js` | 验收测试、人工验收、新源码完整关联审核 |
| `engine/audit-triage.js` | 分诊状态、证据键、版本冲突、可修复性 |
| `engine/issue-ledger.js` | 跨审核/修复的问题聚合及重新出现；与闭环总览范围不同 |
| `engine/finding-verification.js` | 单独验证发现及显式复现命令；不等于批准修复 |
| `engine/planning-workflow.js`、`planning-state.js` | 调查/提案/质询、草稿、预览/审批、局部重试/对比 |
| `engine/process-runner.js` | 子进程、超时、停止进程树、输出限制；CLI 统一桥接 |
| `engine/provider-adapters.ps1`、`agent-bridge.ps1` | 各 Provider 参数、标准输入、会话文件、退出码和审核工具限制 |
| `engine/agent-health.js` | 本地能力检查、真实模型探测、错误分类；不要把探测当作免费操作 |
| `engine/review-evidence.js`、`review-progress.js` | 证据引用验证、覆盖结果、定向复核格式、停滞判断 |
| `public/app.js` | 全局配置、状态、SSE、运行时间线、旧兼容 UI |
| `public/audit.js`、`audit-closure.js` | 审核配置/报告/分诊及闭环验收 UI |
| `public/planning.js`、`issues.js`、`review-evidence.js` | 讨论草稿与决策、问题台账、证据展示 |

当前审核能力目录包含 claude/copilot/codex/pi/mock；以 `audit-config.js` 与 `models-config.json` 的运行时结果为准。旧 CLI 文档提到的其他 Provider 不代表所有新版只读审核入口都支持。

## 持久化与重要接口

默认数据根为工程 `.studio`，可用 `STUDIO_DATA_DIR` 指定；不要把它与目标工程混为一谈。

- `/api/planning`：新版讨论；记录存在 `discussions`，批准方案在 `plans`。
- `/api/runs`：执行与修复；`sourceAudit` 记录原审核，`bugs[].history` 记录逐项验证证据。
- `/api/audits`：只读审核；`reviewers`、`findings`、`triage`、`verificationRuns`、`repairRuns`。
- `parentAudit` / `supplementRuns`：补审和完整重新审核关联，重新审核使用 `mode: RECHECK`。
- `/api/audits/:id/closure`、`closure-test`、`closure-recheck`、`closure-accept`：2.9 闭环。
- 原审核保存 `closureTests` 与 `closureAcceptances`；总览不是另存一份可以随意修改的“完成状态”。
- `/api/status`、`/api/events`、`/api/stop`：共享运行状态、SSE 与停止。

## 已验证的事实

上轮 `npm test` 退出码 0：108 项 Node 测试通过，随后服务器集成、前端契约、PowerShell Provider 和编排测试通过。环境实际使用过 Node 22.22.1；项目仍声明 Node 18+，尚不能把一个环境通过等同于跨版本保证。

独立 Chrome + Playwright 的 2.9 验收 10 项通过，包含真实测试执行、日志、验收恢复、源码过期、新证据使旧说明失效、重新审核、待办及暂缓原因。审核回答使用 Mock，**没有验证真实模型的审核质量或付费 CLI 的全部行为**。

本地证据：

- `.studio/v2.9-regression.log`
- `.studio/playwright-v2.9.cjs`
- `.studio/ui-acceptance-v2.9-1791276325939/results.json` 及截图
- 可迁移文字记录：[2.9 验收](../version-2.9-acceptance.md)

## 不要重新踩的坑

1. 同级补审成功不能掩盖另一补审新发现的缺口。
2. 发现要按审核员实际发现时间合并，不能仅按审核记录创建时间排序。
3. 整轮通过不够；每个 Bug 的最后独立关闭证据必须匹配当前源码。
4. 新源码使旧关闭结论需要重新逐项验证，见 workflow 的 TEST 阶段。
5. 页面输入的说明/分诊必须绑定填写时证据版本，不能轮询后静默套用新版本。
6. 服务重启不证明旧 OS 进程已退出；检查残留 PID，不能重叠启动。

## 当前边界与待验证事项

- 单本地用户、全局一条工作流，审核内部有有限并发；尚无可靠的多实例写入协议或多用户权限模型。
- JSON 读写已有原子替换，但系统化 schema 迁移、坏记录诊断、归档维护仍需建设。
- 2.9 采用完整源码指纹失效，没有可靠依赖图；不能偷偷把旧覆盖标成仍有效。
- 闭环按明确关联审核组汇总，不会自动合并所有项目历史；暂缓不等于修复。
- CLI 只读参数与源码变化检查不是 OS 沙箱；不应承诺恶意工具绝不修改文件。
- 没有统一调用次数/耗时预算、可靠账户剩余额度、完整 token/费用数据。后两项可能 Provider 根本不提供。
- 内置浏览器自动化仍不可用。用户已同意独立浏览器方案，后续无需反复排查内置通道。
- 本次核对有 `restart.ps1` / `restart.bat`，没有发现 `restart.sh`；PowerShell 脚本会强停 3700 监听进程，不能在活动任务中盲目运行。
- 不要修改 `commit.cmd`，不要自动提交、推送或清理现有工作区。没有未完成的后台开发 Agent 任务需要接续。
