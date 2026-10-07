# 跨模型工作记录

## 2026-10-06 / 交接准备 / 尚未开始2.10

- 目标：准备后续版本路线图、可执行任务计划与接手文档，交由其他模型继续。
- 基线：工作区2.9.0；分支 `codex/parallel-audit`；HEAD `ee89f714eedde4e99285a94513c619d1fd67ed1e`。存在大量更早的修改和未跟踪文件，不能reset/clean或只复制HEAD。
- 本轮完成：交接入口、当前状态、工程指南、接手提示词、总体设计、2.10–2.14五份实施计划、根README导航。
- 本轮修改范围：上述Markdown文档；没有改业务源码、运行配置或测试代码。
- 基线验证：上轮2.9的npm test退出0，108项Node测试及其余套件通过；本轮重新读取日志确认计数，没有为了文档变更重跑全部测试。
- 浏览器基线：2.9独立Chrome/Playwright的10项交互检查通过；证据路径见CURRENT_STATE。真实付费模型质量未验证，内置浏览器自动化未恢复。
- 数据：本轮未迁移或改写`.studio`；它被Git忽略，移机时是否包含其中的用户数据由用户决定。
- 后台状态：本轮未启动服务、浏览器或子Agent，无新增进程需要清理。
- 未完成：所有2.10–2.14实现任务尚未开始，计划复选框保持未勾选。
- 下一步：接手模型先核对工作区和环境、运行基线验证，再实施2.10 Task 1（旧记录fixture与兼容性契约），不要直接做五个版本。

后续请追加任务条目，格式见 [MODEL_PROMPTS.md](MODEL_PROMPTS.md)。

## 2026-10-06 / 2.9与交接包 / 提交远程

- 用户明确授权提交代码到远程；本次把此前积累的2.x源码、测试和交接文档统一纳入版本提交。
- 目标：origin（github.com/jitawangzi/dual-agent-studio）的 `codex/parallel-audit` 分支。
- fetch发现远程main已前进到 `0555085`；保留这些远程更新，不在本次提交中擅自合并或覆盖main。
- 提交前重新运行npm test，退出0；108项Node测试及服务器、前端契约、PowerShell套件通过。日志位于忽略的 `.studio/pre-push-regression.log`。
- 不纳入本地 `.studio` 记录、projects.json和独立的未跟踪 `commit.cmd`；后者没有修改。
- 后续版本仍未开始。远程接手请检出交付分支，并重新检查工作区与测试环境。

## 2026-10-07 / 2.10 / Task 1 兼容性 fixture 与旧数据契约

- 本次目标：执行 2.10 计划 Task 1，建立隔离测试 fixture 工具与旧数据兼容性契约，不改动业务逻辑。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。开始前基线 `npm test` 退出码 0。
- 已完成：Task 1。新建 `tests/helpers/studio-fixture.js`（提供 `createFixture` 和 `copyV0Fixtures`）、`tests/fixtures/storage-v0/`（包含去业务信息的 legacy audit、partial/supplement audit、repair run、plan、discussion 及 draft 完整记录）、`tests/storage-compatibility.tests.js`（8 项测试通过：旧审核呈现、闭环推导、问题台账、方案审批校验、讨论草稿、异常错误契约、磁盘只读幂等性往返测试）。修改 `package.json` 将新测试纳入 `npm test`。更新 `docs/superpowers/plans/2026-10-06-v2.10-reliability.md` 复选框。
- 决策：完全沿用原有 RunStore 与各模块只读呈现接口，不修改现有业务逻辑代码；fixture 中的 workspaceRoot 与 workspaceKey 采用动态安全注入，杜绝机器绝对路径硬编码。
- 数据：未改动数据 schema，未修改用户 `.studio` 目录；所有测试均在 `os.tmpdir()` 隔离临时目录运行。
- 验证：执行 `node --test tests/storage-compatibility.tests.js`（8/8 PASS，退出码 0）；执行全量 `npm test`（17 个 Node 测试套件、服务器测试、前端契约、PowerShell 适配器与 orchestrator 编排测试全部 PASS，退出码 0）。全部为 Mock 注入与协议验证，未调用真实付费模型。
- 未完成：Task 2（存储版本、诊断和显式迁移）、Task 3（统一运行租约与残留进程保护）、Task 4（可迁移的验收入口与发布检查）。
- 运行状态：测试创建的临时目录已在 `t.after` 自动清理；除原先已挂起的 3700 端口服务外无新增常驻进程。
- 下一步：实施 2.10 Task 2（存储版本、诊断和显式迁移：`engine/storage-schema.js`、`engine/storage-migration.js`、`tests/storage-migration.tests.js` 等）。

## 2026-10-07 / 2.10 / Task 2 存储版本、诊断和显式迁移

- 本次目标：执行 2.10 计划 Task 2，建立独立 storageVersion 机制、坏数据诊断、迁移版本预览摘要、备份与原子替换升级。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。开始前全量测试通过。
- 已完成：Task 2。
  1. 新建 `engine/storage-schema.js`：定义 `CURRENT_STORAGE_VERSION = 1`，实现 `normalizeRecord`（不改变原输入，缺失时归一化为 0，超出版本报 `UNSUPPORTED_STORAGE_VERSION`）与 `validateRecord`。
  2. 新建 `engine/storage-migration.js`：实现 `planMigration`（扫描待升级 v0 记录并计算确定性批次摘要 `version`）与 `applyMigration`（校验版本冲突，先在 `backups/<operationId>` 持久化 `journal.json` 并复制备份，再原子升级记录）。
  3. 升级 `engine/run-store.js`：引入 `listWithDiagnostics`（隔离损坏文件诊断），`save` 中校验未来版本防降级；`list` 保持原生数组接口兼容。
  4. 升级 `server.js`：新增 `GET /api/maintenance/storage`（只预览诊断与计划）和 `POST /api/maintenance/migrate`（显式迁移，活动任务时 409 保护）。
  5. 升级前端：在 `public/index.html` 顶部增加存储维护入口与弹窗，`public/app.js` 提供诊断查看与迁移控制器。
  6. 新建 `tests/storage-migration.tests.js`（7 项针对性单元与集成测试，覆盖内存归一化、坏记录诊断、版本冲突、备份与原子升级、附件保留与历史验收版本失效防篡改）。
  7. 升级 `tests/server.tests.js`：覆盖存储维护预览及冲突校验接口。
  8. 修改 `package.json`：将新测试套件纳入 `npm test`。
  9. 更新 `docs/superpowers/plans/2026-10-06-v2.10-reliability.md` 复选框。
- 决策：迁移严格显式触发，GET 端点只做诊断与版本哈希计算，绝不自动隐式修改存储；备份目录置于 `store.root/backups/<uuid>`，带完整操作日志。
- 数据：定义 `storageVersion: 1`，旧记录缺省视作 0；迁移时仅升级 `storageVersion` 与 `updatedAt`，其余所有业务字段、原始提示词哈希与验收历史原样保留。
- 验证：`node --test tests/storage-migration.tests.js`（7/7 PASS）；`node tests/server.tests.js`（14/14 PASS）；`npm test`（18 个 Node 测试套件、服务器测试、前端契约、PowerShell 适配器与编排全部 PASS，退出码 0）。
- 未完成：Task 3（统一运行租约与残留进程保护）、Task 4（可迁移的验收入口与发布检查）。
- 运行状态：临时测试目录已清理，无泄漏常驻进程。
- 下一步：实施 2.10 Task 3（统一运行租约与残留进程保护：`engine/runtime-guard.js`、`engine/process-owner.js`、`tests/runtime-guard.tests.js` 等）。

## 2026-10-07 / 2.10 / Task 3 统一运行租约与残留进程保护

- 本次目标：执行 2.10 计划 Task 3，建立统一运行租约机制（RuntimeGuard）和残留进程所有权识别（inspectProcess），并接入普通运行、审核、补审、验收测试、方案推演、模型探测与维护迁移等所有入口。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。开始前全量测试通过。
- 已完成：Task 3。
  1. 新建 `engine/process-owner.js`：实现 `inspectProcess(pid, expectedStartedAt)`，跨平台检查进程存活状态（`ALIVE` / `EXITED` / `UNKNOWN`），通过系统级启动时间比对有效识别 PID 复用。
  2. 新建 `engine/runtime-guard.js`：实现 `RuntimeGuard`，在任何 `await` 发生前的同一 Tick 同步抢占内存槽防竞态；在数据根维护 `instance.lock`（记录 PID、启动时间与 Token），实现幂等释放与孤儿锁识别恢复（`recover()`）。同时同步附加 `.token` 与 `.release()`，支持同步及 `await` 两种模式。
  3. 接入 `engine/run-store.js`：实例化 `this.guard = new RuntimeGuard(this.root)`。
  4. 接入各核心引擎与端点：
     - `engine/workflow.js`：`launch` 同步校验 `guard.isBusy()` 并获取租约，`stop` 与 `finally` 幂等释放；
     - `engine/audit-workflow.js`：`launch` 与 `supplement` 同步校验 `guard.isBusy()` 并获取租约，`stop` 与 `finally` 幂等释放；
     - `engine/audit-closure-actions.js`：`testClosure` 接入 `closure-test` 租约并在完成/中止时安全释放；
     - `engine/planning-workflow.js`：`launch` 与 `approve` 同步校验 `guard.isBusy()` 并获取租约，`stop` 与 `finally` 幂等释放；
     - `server.js`：`/api/agent-health`、`/api/maintenance/migrate` 等端点接入互斥保护。
  5. 新建 `tests/runtime-guard.tests.js`：覆盖 5 组关键生命周期测试（进程检测与 PID 复用识别、同 Tick 并发抢占排他性、幂等释放与伪造 Token 防御、孤儿锁与服务恢复、AuditWorkflow 与 Workflow 跨入口全局互斥）。
  6. 修改 `package.json`：将 `tests/runtime-guard.tests.js` 及语法检查纳入 `npm test`。
  7. 更新 `docs/superpowers/plans/2026-10-06-v2.10-reliability.md` 复选框。
- 决策：保持 `launch` 同步调用契约不变，通过在 `acquire` 中同步预占位 + 同步挂载 `release`，彻底避免 Promise 延迟造成的并发穿透；单实例互斥错误使用统一的 `WORKFLOW_BUSY`。
- 数据：在存储根目录生成 `instance.lock`，任务结束后或异常退出后幂等清理或由 `recover` 判定为孤儿锁回收；不篡改已有业务数据。
- 验证：`node --test tests/runtime-guard.tests.js`（5/5 PASS）；`node --test tests/runtime-guard.tests.js tests/audit-api.tests.js tests/planning-api.tests.js tests/workflow-api.tests.js`（8/8 PASS）；`npm test` 全量测试套件通过（退出码 0）。
- 未完成：已全部完成 Version 2.10（Task 1、Task 2、Task 3、Task 4）。
- 运行状态：临时测试目录已清理，无泄漏常驻进程。
- 下一步：实施 2.10 Task 4。

## 2026-10-07 / 2.10 / Task 4 可迁移的验收入口与发布检查

- 本次目标：执行 2.10 计划 Task 4，将端到端浏览器验收从临时脚本迁移为正式可复现脚本 `scripts/browser-acceptance.cjs`，输出标准化验收文档与发布说明，版本升级至 2.10.0。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。开始前全量测试通过。
- 已完成：Task 4。
  1. 新建 `scripts/browser-acceptance.cjs`：迁移核心交互逻辑，动态智能探测 Playwright 与系统 Chrome 路径，缺失时明确报错；在 `os.tmpdir()` 隔离沙箱启动临时端口服务端，覆盖 11 项端到端交互检查（DOM 加载、存储维护与迁移、人工验收测试门禁、测试日志 HTTP 访问、证据变更导致草稿失效、人工验收持久化与重载恢复、源码修改导致过期证据、重新审核闭环重置授权、HTML/XSS 边界防御转义与暂缓分诊、全局控制台无报错断言），并将结果与截图落盘至 `.studio/acceptance/<id>`。
  2. 修改 `package.json`：新增 `"acceptance": "node scripts/browser-acceptance.cjs"` 脚本，将 `scripts/browser-acceptance.cjs` 语法检查纳入 `npm test`；版本号升级为 `2.10.0`。
  3. 新建 `docs/testing.md`：详细阐述四层测试架构、全量单元与集成套件执行方法、端到端浏览器验收配置与测试隔离原则。
  4. 新建 `docs/version-2.10.md`：发布 2.10.0 正式版本说明，涵盖存储版本与迁移、统一运行租约与进程保护、可迁移验收套件、测试佐证与退出条件清单。
  5. 更新 `docs/superpowers/plans/2026-10-06-v2.10-reliability.md`：全部 4 个 Task 复选框与版本退出条件均已标记完成。
- 决策：坚持零运行时 npm 依赖原则，Playwright 仅作为验收脚本的动态可选工具，不写入 `dependencies`；端到端验收过程产生的所有截图和结果自动收录到归档目录。
- 数据：版本号提升至 `2.10.0`。
- 验证：
  - `npm run acceptance`：11 项检查全部 PASS，生成 3 张截图与 `results.json`，退出码 0（耗时 12.8s）；
  - `npm test`：包含 19 个套件、Node 服务器测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量 PASS（退出码 0）；
  - `git status`：严格保留未跟踪 `commit.cmd` 与用户现有状态，未执行未授权的 Git 提交或推送。
- 未完成：Version 2.10 全阶段开发与验收已全部圆满交付！后续可依据路线图进入 2.11（调用预算与额度守卫）。
- 运行状态：临时沙箱均已在 teardown 钩子清理，服务进程已优雅关闭。

## 2026-10-07 / 2.10 / 审核缺陷修复与全链路复核

- 本次目标：针对只读审核报告 `.studio/review-v2.10-findings.md` 指出的 5 项缺陷（P1 租约未等待穿透、P1 锁混用进程启动时间、P1 迁移慢请求体并发竞争、P2 损坏记录未进入诊断、P2 部分迁移失败断点恢复）进行根因修复与全量测试闭环。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。
- 已完成：
  1. **P1 未等待租约成功即执行任务**：
     - 修改 `engine/audit-workflow.js`、`engine/workflow.js`、`engine/planning-workflow.js`、`engine/audit-closure-actions.js`、`engine/finding-verification.js`；
     - 业务执行、可变状态持久化与 Agent/命令调用严格等待异步租约 `if (lease) await lease;`，在租约拒绝或中止时直接阻断并转入 FAILED/STOPPED，杜绝任何穿透调用。
  2. **P1 锁混用任务时间与 OS 进程启动时间**：
     - 修改 `engine/process-owner.js`：获取本进程高精启动原点并缓存，确保 `inspectProcess` 校验系统级精确启动时间，消除 16 秒 aged-lock 被误判为 EXITED 的缺陷；
     - 修改 `engine/runtime-guard.js`：分别保存 `startedAt`（进程真实启动时间）与 `acquiredAt`（任务获取时间）；引入跨实例排他创建与进程内防重叠注册表，避免同进程多实例竞争穿透。
  3. **P1 迁移慢请求体并发竞争**：
     - 修改 `server.js`：提取统一的 `isWorkflowBusy()`，在 `/api/maintenance/migrate` 请求体解析完成后重新进行忙碌状态与租约校验，慢请求体竞争下直接返回 HTTP 409，严禁非法插入。
  4. **P2 结构损坏记录未进入诊断**：
     - 修改 `engine/storage-schema.js`：实现 `validateRecord` 与 `normalizeRecord`，校验记录 ID、UUID 格式以及工程标识（`workspaceKey`/`workspaceRoot`），支持合法旧版本默认值；
     - 修改 `engine/run-store.js`：`read` 与 `listWithDiagnostics` 全面接入校验，损坏记录被正确隔离入 `errors`，杜绝空对象或坏记录污染列表及迁移计划。
  5. **P2 部分迁移失败断点恢复**：
     - 修改 `engine/storage-migration.js`：识别在途（`IN_PROGRESS`）journal 状态，支持断点在同一 `operationId` 幂等重试，不生成多余备份目录，实现真正的原子化增量升级与恢复。
- 验证结果：
  - `node .studio/review-v2.10-repro.cjs`：5 项复现用例全部由红转绿通过，结果保存至 `.studio/review-v2.10-repro-results.json`，退出码 0；
  - `node .studio/review-v2.10-http.cjs`：HTTP 慢请求体并发测试返回 `{"launchCode":202,"isRunning":true,"migrationCode":409}`，退出码 0；
  - `node --test tests/*.tests.js`：全量 134 项 Node 单元与集成测试 100% 绿色通过，退出码 0；
  - `npm test`：包含 Node 单元测试、服务器测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量通过，退出码 0。
- 数据：未篡改已有业务数据；严格保留未跟踪 `commit.cmd`。
- 运行状态：临时测试目录已清理，无残留进程。

## 2026-10-07 / 2.10 / 第二轮审核缺陷修复与全链路复核

- 本次目标：针对第二轮只读审核报告 `.studio/review-v2.10-r2-findings.md` 指出的 4 项深层缺陷（P1 孤儿锁回收跨进程竞争、P1 启动恢复倒置改写运行中记录、P2 状态写入成功日志写入失败断点恢复、P2 结构损坏 null 与非法 timestamp 破坏维护预览/排序）进行彻底根因修复与全量验证闭环。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。
- 已完成：
  1. **P1 孤儿锁回收跨进程竞争**：
     - 修改 `engine/runtime-guard.js`：引入跨进程原子回收互斥协议（`acquireReclaimMutex` / `releaseReclaimMutex`），在多进程并发检测到同一已退出孤儿锁时，进入互斥临界区重新核实锁持有者状态，杜绝先退出检测但被新实例获取后无条件 unlink 的时序漏洞。
     - 验证：在 `.studio/review-v2.10-r2-edge.cjs` 的 `orphanRace` 用例中，实例 A 成功获取，实例 B 准确拦截并报告 `INSTANCE_LOCKED: Another Studio instance is actively running`，磁盘所有者稳固归属 A，彻底消除双实例竞争穿透。
  2. **P1 启动恢复先写记录，再检查其他实例**：
     - 修改 `server.js`：重构启动阶段恢复时序，将其改造为异步排他检测。在获得有效维护租约或确认无其他活跃实例前，绝不调用 `workflow.recover()` / `auditWorkflow.recover()`。若检测到其他实例处于 `BUSY` 或状态未知，直接安全跳过。
     - 验证：在 `.studio/review-v2.10-r2-edge.cjs` 的 `startup` 用例中，第二服务启动时原持有者的 `RUNNING` 记录完整保留，未被篡改为 `INTERRUPTED`。
  3. **P2 状态写入成功、日志更新失败断点恢复**：
     - 修改 `engine/storage-migration.js`：在重试恢复逻辑中增加前置已升级识别。当磁盘文件已被上一中断操作原子升级至目标 `storageVersion` 且与初始备份内容相符时，准确判定为已迁移项并补齐 `COMPLETED` 及 `afterHash`，消除误判 `MIGRATION_VERSION_CONFLICT` 阻断重试的缺陷。
     - 验证：在 `.studio/review-v2.10-r2-edge.cjs` 的 `journalGap` 用例中，首写故障注入后重试执行返回 `success`，`recordVersion` 成功升至 1。
  4. **P2 结构损坏导致维护预览与列表崩溃**：
     - 修改 `engine/storage-schema.js`：在 `validateRecord` 中增加对 `updatedAt` / `createdAt` 字符串类型的合法性校验；
     - 修改 `engine/run-store.js` 与 `engine/storage-migration.js`：在解析 JSON 后优先对非对象及 `null` 做防御拦截，排序阶段使用 `String(b.updatedAt || '').localeCompare` 增加类型防御，将畸形数据严格隔离入诊断 `errors`。
     - 验证：在 `.studio/review-v2.10-r2-edge.cjs` 的 `nullPreview` 与 `sort` 用例中，null 预览正常返回 `success`，畸形 `updatedAt: 42` 记录安全隔离入 `CORRUPTED_RECORD_STRUCTURE`，健康记录正常返回且无排序异常。
- 验证结果：
  - `node .studio/review-v2.10-r2-edge.cjs`：5 组深层边界用例全部由红转绿，结果保存至 `.studio/review-v2.10-r2-edge-results.json`，退出码 0；
  - `node .studio/review-v2.10-r2-repro.cjs`：第一轮 5 项复现用例保持全部通过，退出码 0；
  - `node .studio/review-v2.10-r2-http.cjs`：慢请求体竞争保持通过（409 拦截），退出码 0；
  - `node --test tests/*.tests.js`：全量 134 项 Node 单元与集成测试全部通过，退出码 0；
  - `npm test`：包含 Node 单元测试、服务器集成测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量通过，退出码 0。
- 数据：未篡改已有业务数据；严格保留未跟踪 `commit.cmd`。
- 运行状态：临时测试目录已清理，无残留进程。

## 2026-10-07 / 2.10 / 第三轮审核缺陷修复与全链路复核

- 本次目标：针对第三轮只读审核报告 `.studio/review-v2.10-r3-findings.md` 指出的 2 项 P2 缺陷（截断迁移日志被忽略导致操作丢失且无诊断、恢复比对使用单向 Object.keys 漏检外部删除业务字段）进行彻底根因修复与全量验证闭环。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。
- 已完成：
  1. **P2 被截断的迁移日志被忽略，操作丢失且无诊断**：
     - 修改 `engine/storage-migration.js`：实现 `inspectBackups(store)` 全面扫描备份目录。当发现 `journal.json` 存在但因截断或语法损坏解析失败时，绝不静默忽略，而是提取目录 ID 作为 `activeOperationId` 保留操作身份，并向诊断 `errors` 中加入 code 为 `CORRUPTED_JOURNAL` 的详细错误信息，确保维护预览界面能够准确识别未完成操作并呈现损坏诊断。
     - 验证：在 `.studio/review-v2.10-r3-migration.cjs` 的 `truncatedJournal` 用例中，重试后 `planMigration` 准确输出 `activeOperationId`（保留原始备份目录 UUID）、`pending: 0`、`errors: 1`（`CORRUPTED_JOURNAL`），新预览安全执行无异常。
  2. **P2 恢复比对漏检被删除的业务字段**：
     - 修改 `engine/storage-migration.js`：实现双向对称比对函数 `recordsMatchExceptVersion`。在剔除允许变动的 `storageVersion` 与 `updatedAt` 后，严格校验当前记录的键集合与备份记录的键集合完全一致，且所有对应值深度相同。无论外部发生删除字段（如 `approval` / `finalPlan`）、增加字段还是修改字段，均能准确拒绝并将 `alreadyMigrated` 判定为 false，抛出 `MIGRATION_VERSION_CONFLICT`。
     - 验证：在 `.studio/review-v2.10-r3-migration.cjs` 的 `deletedFields` 用例中，删除关键字段后的重试准确拦截为 `MIGRATION_VERSION_CONFLICT: Record plans/... modified during migration`，日志状态保持 `IN_PROGRESS`，彻底杜绝数据损毁被误判为迁移成功的漏洞。
- 验证结果：
  - `node .studio/review-v2.10-r3-migration.cjs`：2 项迁移故障用例全部符合预期通过，结果落盘至 `.studio/review-v2.10-r3-migration-results.json`，退出码 0；
  - `node .studio/review-v2.10-r3-edge.cjs`：第二轮 5 组边界用例保持全绿通过，退出码 0；
  - `node --test tests/*.tests.js`：全量 134 项 Node 单元与集成测试全部通过，退出码 0；
  - `npm test`：包含 Node 单元测试、服务器集成测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量通过，退出码 0。
- 数据：未篡改已有业务数据；严格保留未跟踪 `commit.cmd`。
## 2026-10-07 / 2.10 / 第四轮审核缺陷修复与全链路复核

- 本次目标：针对第四轮只读审核报告 `.studio/review-v2.10-r4-findings.md` 指出的 2 项 P2 缺陷（P2 损坏日志仍可产生且空迁移分支误报成功、P2 新日志诊断未进入维护页错误列表且页面误导性提示成功）进行彻底根因修复与全量验证闭环。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。
- 已完成：
  1. **P2 损坏日志仍可产生，执行迁移仍返回成功**：
     - 修改 `engine/storage-migration.js`：将初始、逐项备份、恢复与完成阶段的所有 8 处直接覆盖写入统一改造为 `atomicJson`（临时文件写入 + 原子重命名替换），杜绝写入中断导致 `journal.json` 截断；
     - 在 `applyMigration` 入口处增加前置损坏日志检查：当检测到 `inspectBackups(store).corrupted.length > 0` 时，坚决阻断执行并抛出 `CORRUPTED_JOURNAL: Migration journal in backup ${opInfo} is corrupted or truncated; manual resolution required`，携带原操作 ID 明确报错，彻底杜绝空待迁移项（`entries.length === 0`）静默放行返回 `migrated: 0` 成功的缺陷；
     - 新增单元测试 `tests/storage-migration.tests.js` 覆盖损坏日志下 `applyMigration` 准确阻断与异常抛出契约。
  2. **P2 新日志诊断未进入维护页错误列表**：
     - 修改 `server.js`：重构 `GET /api/maintenance/storage`，将 `plan.errors`（包含 `CORRUPTED_JOURNAL` 维护诊断）合并入 `diagnostics.errors` 并去重，确保摘要计数 `summary.corrupted` 与明细列表数量绝对一致；在 `POST /api/maintenance/migrate` 错误拦截中支持 `/CORRUPTED/` 并准确返回 HTTP 409 Conflict；
     - 修改 `public/app.js` 与 `public/index.html`：在 `refreshStorageMaintenance` 中提取并呈现 `activeOperationId` 及文件路径明细（带 `escapeHtml` 防护）；当 `corrupted > 0` 时，阻断“所有记录均无需迁移”无条件成功绿标，改为醒目的警示提示，并禁用迁移按钮；执行迁移出错时在界面准确渲染红色错误信息。
- 验证结果：
  - `node .studio/review-v2.10-r4-http.cjs`：HTTP 验证完全符合预期，`diagnostics.errors` 准确包含 `CORRUPTED_JOURNAL`（带文件路径），`activeOperationId` 成功呈现，`migrateStatus` 返回 409 拦截，结果落盘至 `.studio/review-v2.10-r4-http-results.json`，退出码 0；
  - `node .studio/review-v2.10-r4-migration.cjs`：原子写与截断测试全部符合预期，`newPreviewRetry` 准确拦截为 `CORRUPTED_JOURNAL` 报错，结果落盘至 `.studio/review-v2.10-r4-migration-results.json`，退出码 0；
  - `node --test tests/*.tests.js`：全量 135 项 Node 单元与集成测试全部通过，退出码 0；
  - `npm test`：包含 Node 单元测试、服务器集成测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量通过，退出码 0。
- 数据：未篡改已有业务数据；严格保留未跟踪 `commit.cmd`。
## 2026-10-07 / 2.10 / 第五轮审核缺陷修复与全链路复核

- 本次目标：针对第五轮只读审核报告 `.studio/review-v2.10-r5-findings.md` 指出的 1 项 P2 缺陷（零待升级记录时未完成迁移在页面没有恢复入口且误报无需迁移）进行彻底根因修复与全量验证闭环。
- 基线：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 保持不变，Node v22.22.1，PowerShell 7.6.6。
- 已完成：
  1. **P2 零待升级记录时，未完成迁移在页面没有恢复入口**：
     - 修改 `public/app.js`：在 `refreshStorageMaintenance` 中重构状态决策分支。当 `entries.length === 0` 且无损坏日志（`corruptedCount === 0`），但存在未完成在途操作（`activeOpId` 存在）时，优先呈现为可恢复状态：展示醒目的操作 ID 恢复卡片；启用迁移按钮并将文案切换为“⚡ 完成挂起迁移”；
     - 修改 `tests/storage-migration.tests.js`：新增针对最终检查点原子中断（`COMPLETED` 状态提交前失败）后同一操作断点恢复的单元测试，锁定 0 待升级记录时恢复的后端契约。
- 验证结果：
  - `node .studio/review-v2.10-r5-atomic.cjs`：包含 `partialTempWrite`、`renameFailure`、`deletedField`、`finalCheckpoint` 在内的 4 组极端故障注入测试全部 100% 绿色通过，`finalCheckpoint` 场景下 `buttonDisabled: false`、提示文案正确呈现未完成状态、后端恢复同一 `operationId` 成功，结果保存至 `.studio/review-v2.10-r5-atomic-results.json`，退出码 0；
  - `node .studio/review-v2.10-r5-http.cjs`：HTTP 维护端点与截断日志 409 拦截保持全绿，退出码 0；
  - `node --test tests/*.tests.js`：全量 136 项 Node 单元与集成测试全部通过，退出码 0；
  - `npm test`：包含 Node 单元测试、服务器集成测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量通过，退出码 0。
- 数据：未篡改已有业务数据；严格保留未跟踪 `commit.cmd`。
- 运行状态：临时测试目录已清理，无残留进程。

## 2026-10-07 / 2.11 / 调用预算与资源使用 (全量 4 个任务闭环)

- **本次目标**：全面实施版本 2.11（调用预算与资源使用）的 4 个任务，完成模型调用追踪、并发安全硬限制、提供方错误分类与人工恢复、启动估算与前端预算交互全链路。
- **基线**：分支 `codex/parallel-audit`，未跟踪 `commit.cmd` 严格保留，Node v22.22.1，PowerShell 7.6.6。
- **已完成任务**：
  1. **Task 1（统一调用记录与真实/未知数据区分）**：
     - 新建 `engine/call-ledger.js`：实现 `beginAttempt`, `markResponded`, `finishAttempt`, `interruptOpenAttempts`, `summarizeCalls`, `normalizeUsage`, `trackedCall`；
     - 接入 `engine/workflow.js`, `engine/audit-workflow.js`, `engine/planning-workflow.js`, `engine/finding-verification.js`, `engine/agent-health.js`；
     - 存储扩展：`health` kind 作为无 workspace 安全存储合法化；
     - 新建 `tests/call-ledger.tests.js`（12 项测试通过）。
  2. **Task 2（并发安全的次数与时间硬预算）**：
     - 新建 `engine/execution-budget.js`：实现 `normalizeBudget`, `ensureBudget`, `reserveAttempt`, `markAttemptStarted`, `settleAttempt`, `cancelReservation`, `remainingBudget`, `adjustBudget`, `startActiveTracking`, `checkpointActiveTracking`, `stopActiveTracking`, `recoverBudget`, `currentActiveSeconds`；
     - `trackedCall` 接入同步互斥预算预留与启动结算，无论成功、失败或格式非法，只要启动一律消耗额度；
     - 工作流超额自动暂停并设置 `pauseReason: 'BUDGET_EXHAUSTED'` 与 `allowedActions`；
     - 新建 `tests/execution-budget.tests.js`（8 项测试通过）。
  3. **Task 3（额度错误分类与人工恢复）**：
     - 新建 `engine/provider-errors.js`：实现 `classifyProviderError`，支持 `AUTH_REQUIRED`, `MODEL_UNAVAILABLE`, `RATE_LIMIT`, `QUOTA_EXHAUSTED`, `TIMEOUT`, `CLI_UPGRADE_REQUIRED`, `UNKNOWN` 错误代码分类；
     - `server.js` 接入 `POST /api/executions/:kind/:id/budget` 和 `POST /api/executions/:kind/:id/resume-budget` 端点；安全处理工作区路径，严格校验版本并提供乐观锁冲突保护（409）；
     - 新建 `tests/provider-errors.tests.js`（6 项测试通过）与 `tests/budget-api.tests.js`（13 项测试通过）。
  4. **Task 4（启动估算、预算 UI 与验收）**：
     - 新建 `engine/execution-estimate.js`：实现 `estimateExecution(kind, config)`，纯静态计算尝试次数范围与预估假设，严禁调用 CLI 或模型；
     - `server.js` 接入 `POST /api/estimate` 端点；
     - 新建 `public/execution-budget.js`：提供预设选择器、自适应输入控件、实时估算渲染、预算看板与统计展示（杜绝显示 0 元费用，明确标注“未提供”）、预算耗尽暂停提示与原地追加额度恢复面板；
     - 更新 `public/index.html`, `public/app.js`, `public/audit.js`, `public/planning.js`, `public/style.css`，为 Dual-Agent Loop、并行审核及团队讨论三大执行流程全量接入预算看板与恢复交互；
     - 更新 `tests/frontend-contract.tests.js` 验证新增 DOM 契约与函数绑定；
     - 更新 `scripts/browser-acceptance.cjs`：加入 2.11 场景端到端浏览器验收（1上限2审核员预算暂停、刷新计数保留、源码变更拦截 409、追加预算后恢复未完成审核员并完成）。
- **验证结果**：
  - `node scripts/browser-acceptance.cjs`：14 项浏览器端到端检查全部 PASS，退出码 0；
  - `npm test`：包含全部 33 个测试套件、服务器测试、前端契约测试、PowerShell 适配器与 orchestrator 编排测试，全量 PASS，退出码 0。
- **版本更新**：`package.json` 版本升级至 `2.11.0`。
- **数据与文件状态**：未篡改已有业务数据；严格保留根目录未跟踪的 `commit.cmd`。






