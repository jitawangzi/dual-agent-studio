const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const MODELS_FILE = path.join(__dirname, 'models-config.json');

// In-Memory Studio State
let activeProcess = null;
let activeConfig = null;
let currentMailbox = null;
let logs = [];
const sseClients = new Set();

function broadcast(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch {
            sseClients.delete(client);
        }
    }
}

function appendLog(line, type = 'info') {
    const logEntry = {
        time: new Date().toISOString(),
        type,
        message: line.replace(/\r?\n$/, '')
    };
    logs.push(logEntry);
    if (logs.length > 5000) logs.shift();
    broadcast('log', logEntry);
}

function getProjects() {
    try {
        if (fs.existsSync(PROJECTS_FILE)) {
            return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
        }
    } catch {}
    return [
        { path: 'D:\\project\\agent-sop', name: 'agent-sop' }
    ];
}

function saveProjects(list) {
    try {
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch {}
}

function getModelsConfig() {
    try {
        if (fs.existsSync(MODELS_FILE)) {
            return JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8'));
        }
    } catch {}
    return { series: [] };
}

function saveModelsConfig(data) {
    fs.writeFileSync(MODELS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function listDrivesAndDirs(dirPath) {
    if (!dirPath) {
        const drives = [];
        for (const letter of ['C', 'D', 'E', 'F', 'G', 'Z']) {
            const drivePath = `${letter}:\\`;
            try {
                if (fs.existsSync(drivePath)) {
                    drives.push({ name: `${letter}: 盘`, path: drivePath, isDrive: true });
                }
            } catch {}
        }
        return {
            currentPath: '',
            parentPath: null,
            dirs: drives,
            isRoot: true
        };
    }

    const norm = path.resolve(dirPath);
    if (!fs.existsSync(norm)) {
        throw new Error(`Directory not found: ${dirPath}`);
    }

    const parent = path.dirname(norm);
    const parentPath = (parent !== norm) ? parent : '';

    let entries = [];
    try {
        entries = fs.readdirSync(norm, { withFileTypes: true });
    } catch (e) {
        return {
            currentPath: norm,
            parentPath,
            dirs: [],
            error: e.message
        };
    }

    const subdirs = [];
    for (const ent of entries) {
        try {
            if (ent.isDirectory() && !ent.name.startsWith('$') && ent.name !== 'node_modules' && ent.name !== '.git') {
                subdirs.push({
                    name: ent.name,
                    path: path.join(norm, ent.name),
                    isDrive: false
                });
            }
        } catch {}
    }
    subdirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return {
        currentPath: norm,
        parentPath,
        dirs: subdirs,
        isRoot: false
    };
}

function getMailbox(workspaceRoot, customMailboxPath, feature) {
    if (!workspaceRoot) return null;
    let mbPath = customMailboxPath;
    if (!mbPath) {
        if (feature) {
            const specMb = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features', feature, 'review-mailbox.json');
            if (fs.existsSync(specMb)) mbPath = specMb;
        }
        if (!mbPath) {
            const sopMb = path.join(workspaceRoot, '.ai-sop', 'review-mailbox.json');
            if (fs.existsSync(sopMb)) mbPath = sopMb;
            else mbPath = path.join(workspaceRoot, 'review-mailbox.json');
        }
    } else if (!path.isAbsolute(mbPath)) {
        mbPath = path.join(workspaceRoot, mbPath);
    }

    try {
        if (fs.existsSync(mbPath)) {
            const raw = fs.readFileSync(mbPath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch {}
    return null;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 1. SSE Events Stream
    if (pathname === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // 2. REST API: /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
        if (activeConfig && activeConfig.workspaceRoot) {
            currentMailbox = getMailbox(activeConfig.workspaceRoot, activeConfig.mailboxPath, activeConfig.feature);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            isRunning: activeProcess !== null,
            config: activeConfig,
            mailbox: currentMailbox,
            logsCount: logs.length
        }));
        return;
    }

    // 3. REST API: /api/models (Get & Update Models Config)
    if (pathname === '/api/models') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getModelsConfig()));
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    saveModelsConfig(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, models: data }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }
    }

    // 4. REST API: /api/list-dirs (Web Directory Explorer)
    if (pathname === '/api/list-dirs' && req.method === 'GET') {
        const queryPath = url.searchParams.get('path');
        try {
            const data = listDrivesAndDirs(queryPath);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // 4.1 REST API: /api/detect-workspace (Auto detect test framework & recommended command)
    if (pathname === '/api/detect-workspace' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { workspaceRoot } = JSON.parse(body);
                if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Workspace path does not exist.' }));
                    return;
                }

                let recommendedCommand = 'exit 0';
                let framework = 'Generic';

                if (fs.existsSync(path.join(workspaceRoot, 'scripts', 'run-all-tests.ps1'))) {
                    recommendedCommand = 'pwsh -NoProfile -File ./scripts/run-all-tests.ps1';
                    framework = 'PowerShell SOP Suite';
                } else if (fs.existsSync(path.join(workspaceRoot, 'tests', 'orchestrator.tests.ps1'))) {
                    recommendedCommand = 'pwsh -NoProfile -File ./tests/orchestrator.tests.ps1';
                    framework = 'PowerShell Orchestrator Suite';
                } else if (fs.existsSync(path.join(workspaceRoot, 'gradlew.bat')) || fs.existsSync(path.join(workspaceRoot, 'gradlew')) || fs.existsSync(path.join(workspaceRoot, 'build.gradle')) || fs.existsSync(path.join(workspaceRoot, 'build.gradle.kts'))) {
                    recommendedCommand = '.\\gradlew test';
                    framework = 'Gradle (Java / Kotlin / Spring)';
                } else if (fs.existsSync(path.join(workspaceRoot, 'pom.xml'))) {
                    recommendedCommand = 'mvn test';
                    framework = 'Maven (Java / Spring)';
                } else if (fs.existsSync(path.join(workspaceRoot, 'package.json'))) {
                    recommendedCommand = 'npm test';
                    framework = 'Node.js (npm)';
                } else if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
                    recommendedCommand = 'cargo test';
                    framework = 'Rust (Cargo)';
                } else if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
                    recommendedCommand = 'go test ./...';
                    framework = 'Go (go test)';
                } else if (fs.existsSync(path.join(workspaceRoot, 'pytest.ini')) || fs.existsSync(path.join(workspaceRoot, 'setup.py')) || fs.existsSync(path.join(workspaceRoot, 'pyproject.toml'))) {
                    recommendedCommand = 'pytest';
                    framework = 'Python (pytest)';
                }

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: true,
                    workspaceRoot,
                    verifyCommand: recommendedCommand,
                    framework
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 4.2 Native browse-folder fallback
    if (pathname === '/api/browse-folder' && req.method === 'POST') {
        const scriptPath = path.join(__dirname, 'engine', 'browse-folder.ps1');
        const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            shell: process.platform === 'win32'
        });
        let selectedPath = '';
        ps.stdout.on('data', d => selectedPath += d.toString('utf-8'));
        ps.on('close', () => {
            const trimmed = selectedPath.trim();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ path: trimmed || null, cancelled: !trimmed }));
        });
        return;
    }

    // 5. REST API: /api/discuss (Requirement Alignment & Discussion Phase)
    if (pathname === '/api/discuss' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const {
                    workspaceRoot,
                    vaguePrompt,
                    devProvider = 'claude',
                    devModel,
                    devReasoningEffort,
                    reviewProvider = 'copilot',
                    reviewModel,
                    reviewReasoningEffort,
                    copilotSessionId
                } = JSON.parse(body);

                if (!vaguePrompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'vaguePrompt is required.' }));
                    return;
                }

                appendLog(`💬 发起双 Agent 需求对齐与架构讨论: "${vaguePrompt}"`, 'system');
                broadcast('discussion_start', { prompt: vaguePrompt });

                // Step 1: Dev Agent Generates Proposal
                appendLog(`🛠️ [Step 1] 开发方 (${devProvider} / ${devModel || 'default'}) 正在分析需求并拟定方案提案...`, 'stdout');
                
                const devSystemPrompt = `
You are the Lead Developer Agent.
Workspace: ${workspaceRoot || 'Current Workspace'}
User Raw/Vague Requirement: "${vaguePrompt}"

Please analyze this requirement and provide a structured implementation proposal in markdown:
1. **Core Intent & Acceptance Criteria (核心目标与验收准则)**
2. **Architecture & Scope of Changes (架构改动与涉及模块)**
3. **Actionable Subtask Checklist (可落地的任务分解清单 - 每项包含具体文件与逻辑)**
4. **Potential Risks & Testing Plan (风险点与测试计划)**

Keep it precise, practical, and highly structured.
`;
                let devProposal = '';
                try {
                    const devEnv = { ...process.env };
                    if (devReasoningEffort && devReasoningEffort !== 'none') {
                        devEnv.MAX_THINKING_TOKENS = devReasoningEffort;
                    }

                    if (devProvider === 'claude') {
                        const claudeArgs = ['-p', devSystemPrompt];
                        if (devModel) claudeArgs.push('--model', devModel);
                        const cProc = spawn('claude', claudeArgs, {
                            cwd: workspaceRoot || process.cwd(),
                            env: devEnv,
                            shell: process.platform === 'win32'
                        });
                        await new Promise((resolve) => {
                            cProc.stdout.on('data', d => devProposal += d.toString('utf-8'));
                            cProc.stderr.on('data', d => appendLog(`[Claude Dev Error] ${d.toString('utf-8')}`, 'stderr'));
                            cProc.on('close', resolve);
                            cProc.on('error', resolve);
                        });
                    } else if (devProvider === 'copilot') {
                        const copilotArgs = ['-p', devSystemPrompt, '-s', '--allow-all'];
                        if (devModel) copilotArgs.push('--model', devModel);
                        if (devReasoningEffort && devReasoningEffort !== 'none') {
                            copilotArgs.push('--reasoning-effort', devReasoningEffort);
                        }
                        const cProc = spawn('copilot', copilotArgs, {
                            cwd: workspaceRoot || process.cwd(),
                            env: devEnv,
                            shell: process.platform === 'win32'
                        });
                        await new Promise((resolve) => {
                            cProc.stdout.on('data', d => devProposal += d.toString('utf-8'));
                            cProc.stderr.on('data', d => appendLog(`[Copilot Dev Error] ${d.toString('utf-8')}`, 'stderr'));
                            cProc.on('close', resolve);
                            cProc.on('error', resolve);
                        });
                    } else {
                        // Mock/Generic fallback for discussion
                        devProposal = `### 🎯 开发方初拟方案 (Dev Proposal)
1. **核心目标**：针对 "${vaguePrompt}" 建立高效健壮的功能实现与模块隔离。
2. **改动范围**：
   - 核心业务层与调度状态管理
   - 外部调用配置与思考强度参数透传
   - 自动化门禁测试与端到端闭环验证
3. **任务清单**：
   - [ ] [Task 1] 实现核心能力并增加前置参数与边界校验
   - [ ] [Task 2] 编写针对性单元测试与回归门禁验证
   - [ ] [Task 3] 验证与外部依赖模块契约一致性`;
                    }
                } catch (e) {
                    devProposal = `### 🎯 开发方初步方案\n针对需求 "${vaguePrompt}" 进行架构拆解与功能落地。`;
                }

                if (!devProposal || devProposal.trim().length === 0) {
                    devProposal = `### 🎯 开发方初拟方案 (Dev Proposal)\n针对需求 "${vaguePrompt}" 进行架构拆解与子任务规划。`;
                }

                broadcast('discussion_message', { sender: 'DEV', content: devProposal });
                appendLog(`✅ 开发方提案已就绪，转交审查方审阅...`, 'stdout');

                // Step 2: Reviewer Critiques & Refines
                appendLog(`🔍 [Step 2] 审查方 (${reviewProvider} / ${reviewModel || 'default'}) 正在审查提案并补充安全与测试门禁...`, 'stdout');

                const reviewerSystemPrompt = `
You are the Independent Senior Reviewer Agent.
User Initial Requirement: "${vaguePrompt}"
Developer Proposed Plan:
${devProposal}

Review this proposal critically. Supplement any missing edge cases, security considerations, rollback plans, and test gate constraints.
Output your final synthesized recommendation for the developer and user to approve.
`;
                let reviewerFeedback = '';
                try {
                    const reviewEnv = { ...process.env };
                    if (reviewReasoningEffort && reviewReasoningEffort !== 'none') {
                        reviewEnv.MAX_THINKING_TOKENS = reviewReasoningEffort;
                    }

                    if (reviewProvider === 'copilot') {
                        const copilotArgs = ['-p', reviewerSystemPrompt, '-s', '--allow-all'];
                        if (reviewModel) copilotArgs.push('--model', reviewModel);
                        if (copilotSessionId) copilotArgs.push(`--resume=${copilotSessionId}`);
                        if (reviewReasoningEffort && reviewReasoningEffort !== 'none') {
                            copilotArgs.push('--reasoning-effort', reviewReasoningEffort);
                        }
                        const rProc = spawn('copilot', copilotArgs, {
                            cwd: workspaceRoot || process.cwd(),
                            env: reviewEnv,
                            shell: process.platform === 'win32'
                        });
                        await new Promise((resolve) => {
                            rProc.stdout.on('data', d => reviewerFeedback += d.toString('utf-8'));
                            rProc.stderr.on('data', d => appendLog(`[Copilot Reviewer Error] ${d.toString('utf-8')}`, 'stderr'));
                            rProc.on('close', resolve);
                            rProc.on('error', resolve);
                        });
                    } else if (reviewProvider === 'claude') {
                        const claudeArgs = ['-p', reviewerSystemPrompt];
                        if (reviewModel) claudeArgs.push('--model', reviewModel);
                        const rProc = spawn('claude', claudeArgs, {
                            cwd: workspaceRoot || process.cwd(),
                            env: reviewEnv,
                            shell: process.platform === 'win32'
                        });
                        await new Promise((resolve) => {
                            rProc.stdout.on('data', d => reviewerFeedback += d.toString('utf-8'));
                            rProc.stderr.on('data', d => appendLog(`[Claude Reviewer Error] ${d.toString('utf-8')}`, 'stderr'));
                            rProc.on('close', resolve);
                            rProc.on('error', resolve);
                        });
                    } else {
                        reviewerFeedback = `### 🔍 审查方评估意见 (Reviewer Critique)
1. **安全与并发防御**：确保所有状态修改具备前置防御、异常捕获与超时回滚；
2. **测试门禁约束**：必须跑通工程测试套件并通过代码质量检查；
3. **判定**：方案架构合理，风险可控，确认无误后可进入全自动迭代执行。`;
                    }
                } catch (e) {
                    reviewerFeedback = `### 🔍 审查方建议\n建议增加完备的异常处理与自动化测试门禁。`;
                }

                if (!reviewerFeedback || reviewerFeedback.trim().length === 0) {
                    reviewerFeedback = `### 🔍 审查方评估意见\n方案架构合理，建议补充完整测试门禁并执行。`;
                }

                broadcast('discussion_message', { sender: 'REVIEWER', content: reviewerFeedback });

                // Synthesize Final Task Plan
                const finalSynthesizedPlan = `${devProposal}\n\n---\n\n${reviewerFeedback}`;
                appendLog(`🏁 需求讨论完成！已生成综合任务提案，等待人工判定与微调...`, 'system');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    devProposal,
                    reviewerFeedback,
                    finalPlan: finalSynthesizedPlan,
                    suggestedFeature: 'feature_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Math.random().toString(36).substring(2,6)
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 6. REST API: /api/start (Start Autonomous Execution Loop)
    if (pathname === '/api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                if (activeProcess) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'A loop is already running. Stop it before starting a new one.' }));
                    return;
                }

                const config = JSON.parse(body);
                if (!config.workspaceRoot || !config.taskPrompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'workspaceRoot and taskPrompt are mandatory.' }));
                    return;
                }

                activeConfig = config;
                logs = [];
                appendLog(`🚀 启动双 Agent 全自动闭环: ${config.workspaceRoot}`, 'system');

                // Save to recent projects
                const projects = getProjects();
                if (!projects.some(p => p.path.toLowerCase() === config.workspaceRoot.toLowerCase())) {
                    projects.unshift({ path: config.workspaceRoot, name: path.basename(config.workspaceRoot) });
                    saveProjects(projects);
                }

                const orchestratorScript = path.join(__dirname, 'engine', 'orchestrator.ps1');
                const psArgs = [
                    '-NoProfile',
                    '-File', orchestratorScript,
                    '-WorkspaceRoot', config.workspaceRoot,
                    '-TaskPrompt', config.taskPrompt
                ];

                if (config.feature) psArgs.push('-Feature', config.feature);
                if (config.devProvider) psArgs.push('-DevProvider', config.devProvider);
                if (config.reviewProvider) psArgs.push('-ReviewProvider', config.reviewProvider);
                if (config.devModel) psArgs.push('-DevModel', config.devModel);
                if (config.reviewModel) psArgs.push('-ReviewModel', config.reviewModel);
                if (config.devReasoningEffort) psArgs.push('-DevReasoningEffort', config.devReasoningEffort);
                if (config.reviewReasoningEffort) psArgs.push('-ReviewReasoningEffort', config.reviewReasoningEffort);
                if (config.copilotSessionId) psArgs.push('-CopilotSessionId', config.copilotSessionId);
                if (config.verifyCommand) psArgs.push('-VerifyCommand', config.verifyCommand);
                if (config.maxRounds) psArgs.push('-MaxRounds', String(config.maxRounds));
                if (config.maxSelfHealAttempts) psArgs.push('-MaxSelfHealAttempts', String(config.maxSelfHealAttempts));
                if (config.autoCommit) psArgs.push('-AutoCommit');
                if (config.mailboxPath) psArgs.push('-MailboxPath', config.mailboxPath);

                activeProcess = spawn('pwsh', psArgs, {
                    cwd: config.workspaceRoot,
                    env: process.env,
                    shell: false
                });

                broadcast('state_change', { isRunning: true, config });

                activeProcess.stdout.on('data', data => {
                    const text = data.toString('utf-8');
                    for (const line of text.split(/\r?\n/)) {
                        if (line.trim()) appendLog(line, 'stdout');
                    }
                    currentMailbox = getMailbox(config.workspaceRoot, config.mailboxPath, config.feature);
                    broadcast('mailbox_update', currentMailbox);
                });

                activeProcess.stderr.on('data', data => {
                    const text = data.toString('utf-8');
                    for (const line of text.split(/\r?\n/)) {
                        if (line.trim()) appendLog(line, 'stderr');
                    }
                });

                activeProcess.on('close', code => {
                    appendLog(`⏹️ 双 Agent 闭环进程结束，退出码: ${code}`, code === 0 ? 'success' : 'error');
                    activeProcess = null;
                    currentMailbox = getMailbox(config.workspaceRoot, config.mailboxPath, config.feature);
                    broadcast('state_change', { isRunning: false, exitCode: code, mailbox: currentMailbox });
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Loop started successfully.' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 7. REST API: /api/stop
    if (pathname === '/api/stop' && req.method === 'POST') {
        if (activeProcess) {
            appendLog('⚠️ 用户主动中止运行中的闭环任务...', 'system');
            const pid = activeProcess.pid;
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: true });
                } else {
                    activeProcess.kill('SIGTERM');
                }
            } catch (err) {
                try { activeProcess.kill('SIGKILL'); } catch {}
            }
            activeProcess = null;
            broadcast('state_change', { isRunning: false, stoppedByUser: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Process stopped.' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'No process is currently running.' }));
        }
        return;
    }

    // 8. REST API: /api/diff
    if (pathname === '/api/diff' && req.method === 'GET') {
        const ws = url.searchParams.get('workspace') || (activeConfig ? activeConfig.workspaceRoot : null);
        if (!ws || !fs.existsSync(ws)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Valid workspace path is required.' }));
            return;
        }

        const gitProc = spawn('git', ['diff', 'HEAD'], { cwd: ws, shell: process.platform === 'win32' });
        let diffText = '';
        gitProc.stdout.on('data', d => diffText += d.toString('utf-8'));
        gitProc.on('close', () => {
            const statProc = spawn('git', ['status', '--porcelain', '-uall'], { cwd: ws, shell: process.platform === 'win32' });
            let statText = '';
            statProc.stdout.on('data', d => statText += d.toString('utf-8'));
            statProc.on('close', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    diff: diffText,
                    status: statText
                }));
            });
        });
        return;
    }

    // 9. REST API: /api/projects
    if (pathname === '/api/projects') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getProjects()));
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { path: p, name } = JSON.parse(body);
                    if (p && fs.existsSync(p)) {
                        const list = getProjects().filter(item => item.path.toLowerCase() !== p.toLowerCase());
                        list.unshift({ path: p, name: name || path.basename(p) });
                        saveProjects(list);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, projects: list }));
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Path does not exist.' }));
                    }
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }
    }

    // 10. REST API: /api/logs
    if (pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
        return;
    }

    // 11. Static File Serving (public/)
    const safePath = path.normalize(pathname === '/' ? 'index.html' : pathname).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'text/plain';

    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`================================================================`);
    console.log(` 🚀 Dual-Agent Studio is running at: http://localhost:${PORT}`);
    console.log(`================================================================`);
});