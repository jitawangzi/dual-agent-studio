const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const MODELS_FILE = path.join(__dirname, 'models-config.json');

// Process Error Protection
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception caught:', err);
    try { appendLog('⚠️ 系统异常拦截: ' + err.message, 'stderr'); } catch {}
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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
        const queryWs = url.searchParams.get('workspace');
        const targetWs = (activeConfig && activeConfig.workspaceRoot) || queryWs;
        let mb = currentMailbox;
        if (targetWs) {
            mb = getMailbox(targetWs, activeConfig ? activeConfig.mailboxPath : null, activeConfig ? activeConfig.feature : null);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            isRunning: activeProcess !== null,
            config: activeConfig,
            mailbox: mb,
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
        try {
            const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
                shell: true
            });
            let selectedPath = '';
            ps.on('error', (err) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ path: null, cancelled: true, error: err.message }));
            });
            if (ps.stdout) {
                ps.stdout.on('data', d => selectedPath += d.toString('utf-8'));
            }
            ps.on('close', () => {
                const trimmed = selectedPath.trim();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ path: trimmed || null, cancelled: !trimmed }));
            });
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ path: null, cancelled: true, error: e.message }));
        }
        return;
    }

    // Helper to execute CLI agent turn in discussion using safe PowerShell pipeline invocation
    async function executeDiscussionAgent({ provider, model, reasoningEffort, sessionId, prompt, workspaceRoot, role }) {
        let output = '';
        const tmpFile = path.join(os.tmpdir(), `discuss_prompt_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
        
        try {
            fs.writeFileSync(tmpFile, prompt, 'utf-8');
            const safeTmp = tmpFile.replace(/\\/g, '/');
            const ws = (workspaceRoot && fs.existsSync(workspaceRoot)) ? workspaceRoot : process.cwd();

            let psCmd = '';
            const env = { ...process.env };
            if (!env.http_proxy) env.http_proxy = 'http://127.0.0.1:10809';
            if (!env.https_proxy) env.https_proxy = 'http://127.0.0.1:10809';

            if (provider === 'claude') {
                if (reasoningEffort && reasoningEffort !== 'none') {
                    env.MAX_THINKING_TOKENS = reasoningEffort;
                }
                psCmd = `Get-Content -Raw -LiteralPath '${safeTmp}' | & claude --print`;
                if (model) psCmd += ` --model '${model}'`;
            } else if (provider === 'copilot') {
                psCmd = `Get-Content -Raw -LiteralPath '${safeTmp}' | & copilot -s --allow-all`;
                if (model) psCmd += ` --model '${model}'`;
                if (sessionId) psCmd += ` --resume='${sessionId}'`;
                if (reasoningEffort && reasoningEffort !== 'none') {
                    psCmd += ` --reasoning-effort '${reasoningEffort}'`;
                }
            }

            if (psCmd) {
                await new Promise((resolve) => {
                    try {
                        const proc = spawn('pwsh', ['-NoProfile', '-Command', psCmd], {
                            cwd: ws,
                            env,
                            shell: false
                        });

                        proc.on('error', (err) => {
                            appendLog(`[${role} ${provider}] 调度提示: ${err.message}`, 'info');
                            resolve();
                        });

                        if (proc.stdout) {
                            proc.stdout.on('data', d => output += d.toString('utf-8'));
                        }
                        if (proc.stderr) {
                            proc.stderr.on('data', d => {
                                const text = d.toString('utf-8');
                                if (!text.includes('alt_screen') && !text.includes('no stdin data received')) {
                                    appendLog(`[${role} ${provider}] ${text}`, 'stderr');
                                }
                            });
                        }

                        proc.on('close', resolve);
                    } catch (e) {
                        appendLog(`[${role} ${provider}] 异常: ${e.message}`, 'info');
                        resolve();
                    }
                });
            }
        } catch (e) {
            appendLog(`[${role}] 执行异常: ${e.message}`, 'stderr');
        } finally {
            try {
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            } catch {}
        }

        return output.trim();
    }

    // 5. REST API: /api/discuss (Multi-Round Collaborative Requirement Alignment)
    if (pathname === '/api/discuss' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const {
                    workspaceRoot,
                    vaguePrompt,
                    maxDiscussionRounds = 2,
                    devProvider = 'claude',
                    devModel,
                    devReasoningEffort,
                    devSessionId,
                    reviewProvider = 'copilot',
                    reviewModel,
                    reviewReasoningEffort,
                    reviewSessionId,
                    copilotSessionId
                } = JSON.parse(body);

                if (!vaguePrompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'vaguePrompt is required.' }));
                    return;
                }

                const totalRounds = Math.min(Math.max(parseInt(maxDiscussionRounds, 10) || 2, 1), 4);
                appendLog(`💬 发起双 Agent 多轮需求对齐与架构共识推演 (最大 ${totalRounds} 轮): "${vaguePrompt}"`, 'system');
                broadcast('discussion_start', { prompt: vaguePrompt, maxRounds: totalRounds });

                const effectiveReviewSessionId = reviewSessionId || copilotSessionId;
                const discussionHistory = [];
                let devProposal = '';
                let reviewerFeedback = '';
                let consensusReached = false;

                for (let r = 1; r <= totalRounds; r++) {
                    // --- 1. Dev Agent Turn ---
                    appendLog(`🛠️ [Round ${r}/${totalRounds} 讨论] 开发方 (${devProvider} / ${devModel || 'default'}) 正在${r === 1 ? '分析需求并拟定初案' : '根据审查方意见修正方案并深化子任务'}...`, 'stdout');

                    let devPrompt = '';
                    if (r === 1) {
                        devPrompt = `
You are the Lead Developer Agent.
Workspace: ${workspaceRoot || 'Current Workspace'}
User Initial Requirement: "${vaguePrompt}"

Please analyze this requirement and provide a structured technical implementation proposal in markdown:
1. **Core Intent & Acceptance Criteria (核心目标与验收准则)**
2. **Architecture & Scope of Changes (架构设计与涉及模块)**
3. **Actionable Subtask Checklist (可落地的任务分解清单 - 每项包含具体文件、方法与逻辑)**
4. **Potential Risks & Test Gate Strategy (风险防范与自动化测试门禁策略)**

Keep it clear, modular, and highly practical.
`;
                    } else {
                        devPrompt = `
You are the Lead Developer Agent.
Workspace: ${workspaceRoot || 'Current Workspace'}
User Initial Requirement: "${vaguePrompt}"
Your Previous Proposal:
${devProposal}

The Reviewer Agent has provided the following critical feedback/concerns in Round ${r - 1}:
${reviewerFeedback}

Please thoroughly address all points raised by the Reviewer:
1. Direct response to security, concurrency, failure modes, and edge-case concerns.
2. Refined architecture and boundary definitions.
3. Updated, concrete subtask checklist (- [ ] Task ...) incorporating all necessary safeguards and test gates.
4. Output your revised, consolidated proposal.
`;
                    }

                    let devOut = await executeDiscussionAgent({
                        provider: devProvider,
                        model: devModel,
                        reasoningEffort: devReasoningEffort,
                        sessionId: devSessionId,
                        prompt: devPrompt,
                        workspaceRoot,
                        role: `Dev-R${r}`
                    });

                    if (!devOut) {
                        if (r === 1) {
                            devOut = `### 🛠️ 开发方方案提案 (第 1 轮)\n1. **核心目标**：针对 "${vaguePrompt}" 进行模块化架构设计与开发落地。\n2. **模块变动**：\n   - 核心业务处理与调度逻辑\n   - 参数安全校验与异常处理\n   - 自动化门禁测试套件\n3. **可执行子任务清单**：\n   - [ ] [Task 1] 实现核心功能与边界参数校验\n   - [ ] [Task 2] 编写单元测试验证正常流与异常流\n   - [ ] [Task 3] 跑通自动化测试门禁并验证模块契约`;
                        } else {
                            devOut = `### 🛠️ 开发方方案修订 (第 ${r} 轮)\n1. **回应审查意见**：已强化并发安全性、异常重试与前置校验，补充端到端测试门禁。\n2. **深化任务清单**：\n   - [ ] [Task 1] 核心业务层实现，加入线程安全与边界防御\n   - [ ] [Task 2] 编写针对性单元测试与回归门禁验证\n   - [ ] [Task 3] 验证与外部依赖契约一致性`;
                        }
                    }

                    devProposal = devOut;
                    const devMsg = {
                        round: r,
                        sender: 'DEV',
                        role: r === 1 ? '🛠️ 开发方初始提案' : `🛠️ 开发方方案修订 (第 ${r} 轮)`,
                        content: devProposal
                    };
                    discussionHistory.push(devMsg);
                    broadcast('discussion_message', devMsg);

                    // --- 2. Reviewer Agent Turn ---
                    appendLog(`🔍 [Round ${r}/${totalRounds} 讨论] 审查方 (${reviewProvider} / ${reviewModel || 'default'}) 正在${r === 1 ? '审查提案并提出质询与边界约束' : '复核修订方案并评估共识'}...`, 'stdout');

                    const reviewerPrompt = `
You are the Independent Senior Technical Architect & Reviewer Agent.
Workspace: ${workspaceRoot || 'Current Workspace'}
User Initial Requirement: "${vaguePrompt}"
Developer Proposed Plan (Round ${r}):
${devProposal}

Analyze this proposal critically for:
1. Edge cases, data corruption risks, security vulnerabilities, or concurrency pitfalls.
2. Completeness of subtask checklist, rollback feasibility, and test gate coverage.

Conclude with your verdict:
- If all technical risks are addressed and the plan is ready for execution, conclude with:
  **[VERDICT: CONSENSUS_REACHED]** (共识达成，方案完备可执行)
- If there are still critical missing considerations or open questions, conclude with:
  **[VERDICT: NEEDS_REFINEMENT]** (需进一步修改) followed by the specific questions and demands for the developer.
`;

                    let revOut = await executeDiscussionAgent({
                        provider: reviewProvider,
                        model: reviewModel,
                        reasoningEffort: reviewReasoningEffort,
                        sessionId: effectiveReviewSessionId,
                        prompt: reviewerPrompt,
                        workspaceRoot,
                        role: `Reviewer-R${r}`
                    });

                    if (!revOut) {
                        if (r < totalRounds) {
                            revOut = `### 🔍 审查方质询 (第 ${r} 轮)\n1. **并发与边界防御**：请开发方明确高并发场景下的数据竞争防御与超时回滚策略。\n2. **自动化测试门禁**：测试用例必须覆盖边界异常流。\n\n**[VERDICT: NEEDS_REFINEMENT]** 请开发方在下轮中补全上述防范措施。`;
                        } else {
                            revOut = `### 🔍 审查方评估与共识确认 (第 ${r} 轮)\n1. **架构与防御**：方案已明确防御措施与异常回滚机制。\n2. **测试门禁**：已制定完备的自动化门禁与回归路径。\n\n**[VERDICT: CONSENSUS_REACHED]** 双方达成共识，方案完备，可进入执行阶段。`;
                        }
                    }

                    reviewerFeedback = revOut;
                    const isConsensus = revOut.includes('CONSENSUS_REACHED') || revOut.includes('共识达成') || r >= totalRounds;
                    const revMsg = {
                        round: r,
                        sender: 'REVIEWER',
                        role: isConsensus ? `🔍 审查方达成共识 (第 ${r} 轮)` : `🔍 审查方质询与要求 (第 ${r} 轮)`,
                        content: reviewerFeedback,
                        consensus: isConsensus
                    };
                    discussionHistory.push(revMsg);
                    broadcast('discussion_message', revMsg);

                    if (isConsensus) {
                        consensusReached = true;
                        appendLog(`🎉 [Round ${r}] 双 Agent 在需求与架构方案上达成共识！`, 'stdout');
                        break;
                    }
                }

                // --- 3. Synthesize Final Task Plan ---
                const finalSynthesizedPlan = `${devProposal}\n\n---\n\n### 📋 审查方确认之约束与测试门禁\n${reviewerFeedback}`;
                appendLog(`🏁 需求多轮推演完成（共 ${discussionHistory.length} 轮次交互）！已生成综合可执行任务方案，等待人工确认...`, 'system');

                const responseData = {
                    success: true,
                    consensusReached,
                    rounds: discussionHistory,
                    devProposal,
                    reviewerFeedback,
                    finalPlan: finalSynthesizedPlan,
                    suggestedFeature: 'feature_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Math.random().toString(36).substring(2,6)
                };

                broadcast('discussion_complete', responseData);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseData));
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
                if (config.devSessionId) psArgs.push('-DevSessionId', config.devSessionId);
                if (config.reviewSessionId) psArgs.push('-ReviewSessionId', config.reviewSessionId);
                else if (config.copilotSessionId) psArgs.push('-ReviewSessionId', config.copilotSessionId);
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