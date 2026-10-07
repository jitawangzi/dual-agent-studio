# Dual-Agent Studio Version 2.10 - 稳定性与恢复 Release Notes

> **版本发布**: 2.10.0  
> **发布日期**: 2026-10-07  
> **核心主题**: 稳定性与恢复 (Reliability & Recovery)  
> **责任作者**: `shuyongqiang`  
> **环境要求**: Windows / PowerShell 7+ / Node.js 18+ (零外部运行时 npm 依赖)

---

## 1. 版本概述

Dual-Agent Studio 2.10 聚焦于生产环境下的高可靠性、历史数据兼容、意外重启恢复以及跨工作流运行互斥。通过引入独立的存储版本系统、确定性数据迁移计划、系统级进程启动时间校验与统一内存租约，彻底解决了旧记录读取报错、坏数据导致整库瘫痪、服务意外中断后遗留孤儿进程及并发启动导致状态混乱的痛点。

---

## 2. 核心架构与功能改进

### 2.1 存储契约、坏数据隔离与显式迁移 (`engine/storage-schema.js`, `engine/storage-migration.js`)
- **独立存储版本**: 引入 `CURRENT_STORAGE_VERSION = 1`，与既有业务 `schemaVersion` 解耦；
- **只读零修改幂等性**: GET 读取时进行内存视图归一化（`normalizeRecord`），缺失字段赋予安全默认值，绝不隐式改写磁盘文件字节；
- **损坏数据隔离诊断**: `RunStore.listWithDiagnostics` 在扫描目录时将 JSON 解析失败或损坏的文件记录为诊断项，不再抛出异常导致整个工作区任务列表崩溃；
- **确定性迁移摘要防冲突**: `planMigration` 生成包含待迁移记录 ID 与 SHA-256 内容哈希的确定性批次摘要 `version`；若在预览后至执行前磁盘数据被修改，`applyMigration` 立即阻断并报 `MIGRATION_VERSION_CONFLICT`；
- **备份先行机制**: 迁移执行前，先在存储根目录 `backups/<operationId>/` 持久化操作清单 `journal.json` 并复制旧文件，之后使用临时文件重命名执行原子写入；
- **Web 维护中心**: 提供存储维护模态窗，展示各工作流记录总数、待迁移数、损坏文件诊断清单与迁移执行结果。

### 2.2 统一运行租约与进程所有权保护 (`engine/runtime-guard.js`, `engine/process-owner.js`)
- **同 Tick 内存槽抢占**: `RuntimeGuard.acquire` 在同一事件循环 Tick 内同步标记 `activeOwner`，彻底杜绝并发触发下的竞态穿透；
- **系统级进程启动时间校验**: `inspectProcess(pid, expectedStartedAt)` 结合系统级进程启动时间（PowerShell `Get-Process.StartTime` / POSIX `ps -o lstart=`）检测 PID 复用，准确区分 `ALIVE`、`EXITED` 与无法确认的 `UNKNOWN`（保守报错，不盲目杀进程）；
- **跨实例独占锁**: 在存储根目录维护 `instance.lock`（记录 PID、启动时间、租约 Token）；
- **全入口互斥覆盖**: 将普通工作流运行、修复、并行审核、补审、独立验证、验收门禁执行、方案推演、模型健康探测、存储迁移及兼容接口全部接入同一防重叠生命周期，互斥统一响应 `409 WORKFLOW_BUSY`；
- **幂等释放与优雅恢复**: 租约释放携带 Token 校验，避免跨任务误释放；`recover()` 识别孤儿锁与残留死进程，并在重启时标记中断任务，绝不自动重放消耗额度的 Agent 请求。

### 2.3 可迁移的端到端浏览器验收套件 (`scripts/browser-acceptance.cjs`)
- **解耦迁移**: 将验收套件迁入工程正式路径，提供 `npm run acceptance` 标准脚本；
- **自适应环境发现**: 智能发现本地缓存的 Playwright 模块与系统 Chrome 可执行文件，未找到时输出明确环境变量指引，坚持零运行时 npm 依赖原则；
- **完整交互证据链验证**:
  1. 存储维护弹窗打开与迁移执行；
  2. 真实测试门禁执行与强制授权复选框；
  3. 测试日志 HTTP 端点可访问性校验；
  4. 证据更新导致草稿验收说明失效；
  5. 人工验收固化与刷新持久化；
  6. 源码修改导致既有验收失效为“过期证据”；
  7. 重新审核生成关联新记录并重置执行授权；
  8. 包含 XSS/HTML 字符的缺陷安全转义与暂缓分诊；
- **自动归档**: 验收结果 JSON 与截图自动归档至 `.studio/acceptance/<id>`。

---

## 3. 验证与测试结果

Dual-Agent Studio 2.10 经过全量测试套件与浏览器真实环境的严格验证：

| 测试阶段 | 测试套件 / 脚本 | 测试用例数 | 状态 | 耗时 |
| :--- | :--- | :--- | :--- | :--- |
| **存储兼容性** | `tests/storage-compatibility.tests.js` | 8/8 | PASS | 120ms |
| **存储迁移** | `tests/storage-migration.tests.js` | 7/7 | PASS | 150ms |
| **运行租约** | `tests/runtime-guard.tests.js` | 5/5 | PASS | 980ms |
| **全量核心套件** | `npm test` (19 个套件 + CLI 编排) | 全部通过 | PASS | ~16s |
| **浏览器端到端验收** | `scripts/browser-acceptance.cjs` | 11/11 | PASS | 12.8s |

---

## 4. 退出条件检查清单 (Exit Criteria)

- [x] **旧数据不丢**: 旧版本 v0 记录完全兼容，读取呈现零写入，迁移带有完整备份与 journal 日志；
- [x] **坏数据可诊断**: 损坏的 JSON 记录独立诊断展示，不妨碍健康记录的正常查看与流转；
- [x] **并发与停止有测试证据**: 运行租约并发抢占、多入口互斥及终止释放均有自动化用例佐证；
- [x] **验收脚本可从工作区重新运行**: `npm run acceptance` 可在工作区独立运行并生成验收报告。
