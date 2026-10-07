# Dual-Agent Studio 测试与验收手册

> **版本适用**: 2.10.0+  
> **维护责任**: `shuyongqiang`  
> **核心原则**: 原生标准库运行、测试环境严格隔离、拒绝假阳性断言、模型 Mock 注入。

---

## 1. 测试层级架构

Dual-Agent Studio 采用四层递进的自动化测试与验证架构：

```text
┌────────────────────────────────────────────────────────┐
│  4. 端到端浏览器验收 (Playwright / Chromium / Headless)   │
│     scripts/browser-acceptance.cjs                     │
├────────────────────────────────────────────────────────┤
│  3. PowerShell 引擎与 CLI 驱动编排集成测试                │
│     tests/orchestrator.tests.ps1                       │
│     tests/provider-adapters.tests.ps1                  │
├────────────────────────────────────────────────────────┤
│  2. HTTP API、前端状态契约与多工作流互斥测试             │
│     tests/server.tests.js                              │
│     tests/frontend-contract.tests.js                   │
│     tests/*-api.tests.js                               │
├────────────────────────────────────────────────────────┤
│  1. 单元逻辑、存储版本归一化与租约防竞态测试             │
│     tests/storage-compatibility.tests.js (v0 兼容契约) │
│     tests/storage-migration.tests.js (v1 显式迁移)      │
│     tests/runtime-guard.tests.js (统一运行租约与孤儿锁) │
│     tests/audit-*.tests.js / tests/workflow.tests.js   │
└────────────────────────────────────────────────────────┘
```

---

## 2. 运行全量单元与集成测试套件

执行标准测试入口：

```powershell
npm test
```

### 该命令执行的完整检查项：
1. **源码语法检查 (`node --check`)**:
   - `server.js`、`engine/runtime-guard.js`、`engine/process-owner.js`
   - `scripts/browser-acceptance.cjs`
   - `public/*.js` 前端所有控制器模块
2. **Node 原生测试套件 (`node --test`)**:
   - `tests/storage-compatibility.tests.js`：旧记录兼容性读取，只读呈现幂等性验证；
   - `tests/storage-migration.tests.js`：存储诊断、确定性批次哈希摘要、备份 journal 与原子写入升级；
   - `tests/runtime-guard.tests.js`：运行租约抢占防竞态、进程存活与 PID 复用识别、多工作流跨入口互斥与服务恢复；
   - `tests/audit-closure.tests.js`、`tests/audit-assignment.tests.js`、`tests/review-evidence.tests.js`
   - `tests/planning-workflow.tests.js`、`tests/planning-api.tests.js`、`tests/planning-ui.tests.js`
   - `tests/workflow.tests.js`、`tests/workflow-api.tests.js`
   - `tests/audit-workflow.tests.js`、`tests/audit-api.tests.js`、`tests/audit-ui.tests.js`、`tests/audit-preparation.tests.js`
   - `tests/finding-verification.tests.js`、`tests/issue-ledger.tests.js`、`tests/review-progress.tests.js`、`tests/issues-ui.tests.js`
3. **HTTP 服务与前端契约测试**:
   - `tests/server.tests.js`
   - `tests/frontend-contract.tests.js`
4. **PowerShell 7 适配器与编排器测试**:
   - `tests/provider-adapters.tests.ps1`
   - `tests/orchestrator.tests.ps1`

---

## 3. 端到端浏览器验收测试 (`npm run acceptance`)

浏览器验收测试验证用户可见操作（UI 交互、门禁阻断、证据变更联动、XSS 防御及重新审核重置凭据），采用隔离的临时工作区和临时数据存储，不依赖也不篡改本地真实数据。

### 3.1 执行方式

```powershell
npm run acceptance
```

或直接执行脚本：

```powershell
node scripts/browser-acceptance.cjs
```

### 3.2 环境变量配置

| 环境变量 | 默认探测位置 | 说明 |
| :--- | :--- | :--- |
| `STUDIO_PLAYWRIGHT_MODULE` | 用户本地 npm 缓存目录 | 指向已安装的 Playwright 模块路径，缺失时明确报错，不自动运行 `npm install` 破坏零依赖约定 |
| `STUDIO_CHROME_PATH` | 标准 Chrome 安装路径 | 指向 Chrome / Chromium 可执行文件路径 |
| `STUDIO_ACCEPTANCE_OUTPUT` | `.studio/acceptance/<id>` | 验收结果输出目录，包含 `results.json` 与各环节截图 |

### 3.3 验证场景覆盖
- **DOM 加载与状态呈现**: 初始页面元素与各工作流面板；
- **旧数据读取与存储维护**: 待迁移记录诊断统计与显式迁移；
- **门禁阻断**: 缺失通过的真实测试时阻断人工验收；
- **真实门禁执行与证据捕获**: 强制命令执行授权，记录测试日志产物；
- **证据变更联动**: 测试证据更新导致已起草的验收说明自动失效；
- **人工验收固化**: 验收结论持久化，并在页面刷新后保持一致；
- **代码变动感知**: 源码变动导致既有验收失效为“过期证据”；
- **重新审核闭环**: 关联补审/复审，保留原报告并重置命令执行授权；
- **边界防御**: 针对包含 HTML 注入字符的缺陷进行转义展示与暂缓分诊。

---

## 4. 安全与隔离约束规范

1. **测试隔离**: 所有新建测试必须使用 `tests/helpers/studio-fixture.js` 的 `createFixture(t)`，临时目录限定在 `os.tmpdir()`，并在测试完成后由 `t.after` 幂等清理。
2. **严禁修改主数据**: 测试严禁指向或删除实际项目的 `.studio/` 或 `.ai-workspace/` 真实数据。
3. **零付费模型调用**: 全链路测试必须采用 Mock 注入，严禁在自动化流水线中触发真实 CLI 外部调用或产生账单费用。
