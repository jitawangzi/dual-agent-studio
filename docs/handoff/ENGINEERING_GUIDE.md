# 接手工程约束与验证手册

## 不可退让的规则

1. 后端只用 Node 内置模块；不因为新功能引入运行时数据库、框架或 npm 依赖。浏览器测试工具属于可选开发工具，单独说明。
2. Windows / PowerShell 7 是主要环境。多行提示词走 stdin/临时文件；外部 CLI 后立即检查 `$LASTEXITCODE`；插值冒号使用 `$($value):`。
3. 审核员只读；开发、审核、独立验证会话隔离。失败、超时、缺少证据、格式错误绝不能转成成功。
4. 源码指纹、报告版本、草稿版本和逐项证据分别校验；不要用 UI 禁用按钮代替后端校验。
5. 人工批准必须绑定当时的精确内容；模型建议的命令不可自行执行；暂缓和争议必须可追溯。
6. 单任务互斥和停止等待保持一致；任何预算、重试或恢复都不能使旧进程与新调用并行。
7. `.studio` 是用户数据。测试必须隔离，迁移先备份，不用递归删除解决兼容问题。
8. 不要进行大规模无关重构；先保持接口、旧记录和测试兼容，再小步抽取模块。
9. 本轮交接不授权真实模型调用、发布、推送、自动提交或改写全局代理/工具配置。

## 接手命令

在 PowerShell 中，先读取状态，不做清理：

```powershell
Set-Location D:\project\dual-agent-studio
git status --short
Get-Content package.json
Get-Content AGENTS.md
node --version
pwsh --version
npm test
```

`npm test` 已串联 Node、HTTP、前端契约及 PowerShell 测试。新建测试文件必须加入脚本，否则“新增测试本地通过”不代表以后会回归。现有 `tests/server.tests.js` 使用固定 3788 端口，运行前若被占用，先确认占用者，不要强杀不明进程；新 HTTP 测试优先 `server.listen(0, '127.0.0.1')`。

针对性测试示例：

```powershell
node --test tests/audit-closure.tests.js tests/review-progress.tests.js
node --test tests/planning-workflow.tests.js tests/planning-ui.tests.js
node --check public/audit-closure.js
git diff --check
```

每个任务先写能触发具体错误的测试，确认因预期原因失败，再实现并运行该测试。版本结束执行全量回归；不要为纯文字改动反复调用整套测试或真实模型。

## 测试隔离模板

创建临时 workspace 和独立 `RunStore`；设置 `STUDIO_DATA_DIR` 后才 require server。fixture 清理前检查绝对路径在自己创建的临时根之下，不能对用户工程运行递归删除。下面是后续计划使用的统一 fixture 目标接口（2.10 才创建，不是已存在文件）：

```js
const {createFixture} = require('./helpers/studio-fixture');
const {root, workspace, store} = createFixture(t);
// root：os.tmpdir() 下本测试创建的目录
// workspace：root/project；含简单 app.js
// store：new RunStore(root/state)
```

HTTP 服务清理用 `server.closeAllConnections()` 后等待 `server.close()`；停止自己的工作流并等待进程退出。不要用主服务真实 `.studio` 做试验。Agent 回答可用注入函数验证协议；这些测试须明确标注 Mock，不能冒称真实模型推理质量通过。

## 独立浏览器验收

用户已经同意独立 Chrome + Playwright。当前机器曾使用：

- Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`
- Playwright 1.63.0：`C:/Users/Administrator/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright`
- 参考脚本：`.studio/playwright-v2.9.cjs`（被忽略，不保证新机器存在）

缓存路径只说明现状，不能成为正式测试脚本的硬编码依赖。2.10 要把入口迁入 `scripts/`，通过参数/环境变量定位工具。新浏览器使用隔离上下文，不接管个人登录会话。使用真实本地 API；只阻断 Google Fonts 等外部资源时明确记录，不能假造本地接口成功。

截图验收：至少验证 1500px 桌面、长文本和证据转义，检查按钮遮挡、表单布局、错误信息。每次保存脚本退出码、检查项、页面错误、截图和环境；如浏览器不可用，完成其他检查并明确留下未验收项，不能宣称全量通过。

## 服务与代理

主服务默认 3700，当前启动脚本使用 `node --watch`，代码变更可能已自动重启。先读 `/api/status` 和验证接口再决定是否重启。`restart.ps1` 会杀监听进程并打开浏览器，只在确认服务归属、没有活动工作流时使用；不要无差别停止所有 Node 进程。

远程 Git 使用现有代理 `http://127.0.0.1:10809`，保留环境中已有显式配置。不读取、打印或分享 CLI 凭据。此交接无需访问 GitHub、检索最新模型价格或变更全局配置。

## 每个任务的交付门槛

- 功能：按本版本计划完成，不替换成另一套产品。
- 数据：旧 fixture 仍可读，新增字段默认值清晰，冲突与失效不会丢历史。
- 行为：成功、失败、停止、重启、重复请求、版本过期至少覆盖相关路径。
- UI：有实际操作入口、运行反馈和错误处理；不只实现后端接口。
- 证据：列出真实运行的命令和退出结果；区分单元、HTTP、浏览器、真实模型四层。
- 交接：把改动文件、当前测试、下一任务写入 `docs/handoff/WORK_LOG.md`（接手后创建）。

不自动执行 `git add -A` 或提交所有变更。用户以后授权提交时，也必须先核对原有未提交工作与本次修改；可以按任务准备有边界的提交，但不能漏掉必要未跟踪源码。
