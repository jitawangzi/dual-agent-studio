# Parallel Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户已批准的并行只读审核与人工选项转修复。

**Architecture:** 独立 AuditWorkflow 持久化审核，不重构现有 Workflow。复用 CLI 进程、源码指纹、RunStore；HTTP 层统一互斥，独立前端模块管理审核 UI。

**Tech Stack:** Node.js built-ins, PowerShell 7, Vanilla JS/CSS.

**Spec:** ../specs/2026-10-02-parallel-audit-design.md

## Global Constraints

- 不增加运行时依赖，Windows PowerShell 7 / Node.js 18+。
- 不调用真实收费模型作自动测试。
- 保留现有未提交的 v2 改造及 commit.cmd；在 codex/parallel-audit 分支继续，不提交或推送无关改动。

## Task 1: 审核配置与调度器

Files: engine/audit-config.js, engine/audit-workflow.js, engine/run-store.js, engine/provider-adapters.ps1, tests/audit-workflow.tests.js.

Interfaces: `auditCapabilities(catalog)` returns providers with models/efforts; `new AuditWorkflow(store,{agent,snapshot,catalog,emit})`; create(config), launch(record), stop(), retry(id), recover(), repair(workflow,id,config).

- [ ] 编写行为测试，使用两个未释放的 Agent promise 证明并发真的发生，并验证第 3 个等待空位。
- [ ] 运行 `node --test tests/audit-workflow.tests.js`，确认新导出未实现导致失败。
- [ ] 配置保存 model/effort/会话；调度用有界 worker 池与 AbortController；每个结果独立保存，异常不得丢弃已完成结果。
- [ ] 规范化结果与汇总保留来源；指纹变化 INVALIDATED；记录各 Agent artifacts。
- [ ] 修复入口根据选中 finding IDs 生成现有 Workflow 的 bugs 和 sourceAudit，开发阶段开始；服务端拒绝篡改工作区、未知 IDs 和失效指纹。
- [ ] 跑测试确认并发、失败、取消、重新打开记录、模型参数校验和人工选项约束。

## Task 2: HTTP 集成

Files: server.js, tests/audit-api.tests.js, package.json.

Interfaces: GET /api/audit-capabilities; GET/POST /api/audits; GET /api/audits/:id; GET /api/audits/:id/artifacts; POST /api/audits/:id/retry; POST /api/audits/:id/repair -> {runId}; /api/status adds activeAuditId; /api/stop stops all current audit children.

- [ ] 编写 HTTP 测试 `POST /api/audits` 为 202，忙时 `/api/runs` 为 409，列表按工作区过滤，模型错误 400。
- [ ] 运行 HTTP 测试确认路由缺失失败。
- [ ] 挂接服务端共享互斥、SSE、重启恢复和 artifact 文本读取。
- [ ] 运行实际 PowerShell Mock 审核并检查保存的报告与原始证据。

## Task 3: 页面与验收

Files: public/audit.js, public/index.html, public/app.js, public/style.css, docs/workflows-v2.md.

- [ ] 新增审核员卡片、公共提示词、并发数与审核报告 tab；模型支持输入，未知模型禁用强度。
- [ ] 保留勾选状态与历史记录；呈现失败/未覆盖与完整原报告；人工选中后使用已存 finding IDs 转修复，不传自编 finding。
- [ ] 使用浏览器验证添加审核员、引擎/模型/强度联动、并行执行、刷新恢复和勾选转修复；发现交互缺陷后补对应测试再修复。
- [ ] 完成独立代码审核、完整 `npm test`、`git diff --check`，重启当前工程服务，更新使用说明。

## Execution Notes

当前工作目录含本会话上一版未提交实现，是本次功能必要基础；保留目录并切换功能分支，原文件快照保存于 .studio/parallel-audit-baseline 以供增量审查。用户已经明确授权实施上述方案，不重复请求实施确认。

## 完成记录（2026-10-03）

- Task 1 已完成：审核配置、独立会话、有界并发、部分失败/取消/恢复、指纹失效、逐项转修复与证据台账。8 项调度与状态行为测试通过。
- Task 2 已完成：HTTP 路由、全局互斥、状态、证据读取、Mock PowerShell 端到端测试通过。
- Task 3 实现完成：审核员配置、模型强度联动、报告分类、原始依据、选择与修复入口。4 项前端控制器行为测试通过，包含部分审核确认、失效勾选清理和状态标题更新。
- 独立代码审核发现的旧 PID 存活时转修复、Copilot MCP 工具限制问题均补了失败测试并修复；后续 Claude/Codex 的 MCP 限制也经过参数测试和本机 CLI 配置检查。独立审核后续回合受到工具配额限制，未获得最终完整批准结论。
- 全量 `npm test` 通过：29 项 Node 测试、旧服务端集成、页面契约、Provider 参数和 PowerShell 编排回归。证据在 `.studio/parallel-tests-final.log`；`git diff --check` 无空白错误。
- 未完成的验收项：浏览器原生自动化通道无法连接，重试及内核重置未恢复，因此未声称完成真实页面点击或视觉验收。前端逻辑测试替代了可自动化验证的部分；真实模型端到端调用仍需实际账号联调。
