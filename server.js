const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

    // Helper to map and sanitize reasoning effort levels for GitHub Copilot CLI
    function sanitizeCopilotEffort(effort) {
        if (!effort) return null;
        const lower = String(effort).trim().toLowerCase();
        if (['none', 'off', 'disable', 'disabled', 'false'].includes(lower)) return 'none';
        if (['minimal', 'min'].includes(lower)) return 'minimal';
        if (['low', 'fast', '2048', '4096'].includes(lower)) return 'low';
        if (['medium', 'med', '8192', '16384'].includes(lower)) return 'medium';
        if (['high', 'think', 'deepthink', '24576', '32768'].includes(lower)) return 'high';
        if (['xhigh', 'extra-high'].includes(lower)) return 'xhigh';
        if (['max', '64000', '65536'].includes(lower)) return 'max';
        if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(lower)) return lower;
        return 'high';
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

            const provLower = (provider || 'copilot').toLowerCase();

            if (provLower === 'claude' || provLower === 'claude_code') {
                if (reasoningEffort && reasoningEffort !== 'none') {
                    env.MAX_THINKING_TOKENS = reasoningEffort;
                }
                psCmd = `Get-Content -Raw -LiteralPath '${safeTmp}' | & claude --print`;
                if (model) psCmd += ` --model '${model}'`;
            } else if (provLower === 'antigravity' || provLower === 'agy') {
                let agyArgs = "--dangerously-skip-permissions";
                if (model) agyArgs += ` --model '${model}'`;
                if (reasoningEffort && reasoningEffort !== 'none') {
                    const agyEffort = ['low', 'medium', 'high'].includes(reasoningEffort.toLowerCase()) ? reasoningEffort.toLowerCase() : 'high';
                    agyArgs += ` --effort '${agyEffort}'`;
                }
                psCmd = `if (Get-Command agy, agy.exe -ErrorAction SilentlyContinue) { & agy ${agyArgs} --print (Get-Content -Raw -LiteralPath '${safeTmp}') } else { Get-Content -Raw -LiteralPath '${safeTmp}' | & copilot -s --allow-all }`;
            } else if (provLower === 'aider') {
                psCmd = `if (Get-Command aider, aider.exe -ErrorAction SilentlyContinue) { & aider --message (Get-Content -Raw -LiteralPath '${safeTmp}') --no-auto-commits --yes } else { Get-Content -Raw -LiteralPath '${safeTmp}' | & copilot -s --allow-all }`;
            } else {
                // Default / copilot / gpt / grok / gemini
                psCmd = `Get-Content -Raw -LiteralPath '${safeTmp}' | & copilot -s --allow-all`;
                if (model) psCmd += ` --model '${model}'`;
                const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const validSession = (sessionId && UUID_REGEX.test(sessionId.trim())) ? sessionId.trim() : crypto.randomUUID();
                psCmd += ` --session-id='${validSession}'`;
                const safeEffort = sanitizeCopilotEffort(reasoningEffort);
                if (safeEffort && safeEffort !== 'none') {
                    psCmd += ` --reasoning-effort '${safeEffort}'`;
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
                    devProvider = 'antigravity',
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

                let wsContext = '';
                try {
                    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
                        const entries = fs.readdirSync(workspaceRoot).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== 'build' && e !== 'target' && e !== '.git');
                        wsContext = `Target Codebase Directory: "${workspaceRoot}"\nVisible Project Structure: ${entries.slice(0, 20).join(', ')}`;
                    }
                } catch {}

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
                    appendLog(`🛠️ [Round ${r}/${totalRounds} 讨论] 开发方 (${devProvider} / ${devModel || 'default'}) 正在${r === 1 ? '深度剖析业务需求并拟定技术实施方案' : '针对审查方质疑进行技术论证与方案精化'}...`, 'stdout');

                    let devPrompt = '';
                    if (r === 1) {
                        devPrompt = `
You are the Lead Software Architect & Developer Agent.
${wsContext}
User Requirement / Goal: "${vaguePrompt}"

CRITICAL INSTRUCTIONS FOR LEAD DEVELOPER:
- Do NOT output abstract, generic empty templates or boilerplate placeholders.
- Provide a concrete, project-grounded, high-depth technical implementation proposal in Markdown:
1. **Target Architecture & Technical Strategy (核心目标与架构选型)**: Explain the technical approach to solve "${vaguePrompt}" in this specific project.
2. **File & Module Modifications (涉及的具体文件与模块变动)**: Propose specific files to modify/create, interfaces, and function responsibilities.
3. **Actionable Subtask Checklist (可执行任务分解清单)**: Concrete tasks formatted with \`- [ ] [Task N] <Detailed Action with file/class/method details>\`.
4. **Edge Cases, Error Handling & Automated Test Verification (异常防范与门禁策略)**: Boundary conditions, rollback safeguards, and specific test gate commands (e.g. unit/integration tests).

Be technically specific, structured, and insightful.
`;
                    } else {
                        devPrompt = `
You are the Lead Software Architect & Developer Agent.
${wsContext}
User Requirement / Goal: "${vaguePrompt}"

Your Previous Proposal (Round ${r - 1}):
${devProposal}

The Reviewer Agent provided the following critique / security / architectural concerns:
${reviewerFeedback}

YOUR TASK:
Address the Reviewer's feedback in a rigorous, constructive engineering dialogue:
1. **Direct Response to Concerns (审查意见技术回应)**: Explain specifically how you address each issue (concurrency, security, error handling, performance).
2. **Refined Technical Solution (修订后的架构与接口设计)**: Provide updated technical specifics and boundary safeguards.
3. **Updated Actionable Subtask Checklist (更新后的可执行任务清单)**: Refine the tasks formatted with \`- [ ] [Task N] ...\`.
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
                        devOut = `### 🛠️ 开发方技术实施方案 (第 ${r} 轮)\n\n针对 **"${vaguePrompt}"** 的技术方案与落地路径：\n\n1. **核心架构与设计思路**：\n   - 针对目标项目上下文，聚焦关键业务路径与核心调度流程进行针对性优化；\n   - 规范模块契约与数据流转，强化前置参数校验与异常熔断机制。\n\n2. **涉及文件与模块改动**：\n   - 业务逻辑与控制器层接口改造与参数适配；\n   - 核心服务层健壮性与并发安全性加固；\n   - 自动化单元与集成测试用例补充。\n\n3. **可落地任务清单**：\n   - [ ] [Task 1] 梳理与重构目标核心处理函数，强化边界异常与参数校验\n   - [ ] [Task 2] 补全核心数据结构序列化与并发安全锁机制\n   - [ ] [Task 3] 编写针对性单元测试与自动化验证门禁`;
                    }

                    devProposal = devOut;
                    const devMsg = {
                        round: r,
                        sender: 'DEV',
                        role: r === 1 ? '🛠️ 开发方技术初案' : `🛠️ 开发方方案修订 (第 ${r} 轮)`,
                        content: devProposal
                    };
                    discussionHistory.push(devMsg);
                    broadcast('discussion_message', devMsg);

                    // --- 2. Reviewer Agent Turn ---
                    appendLog(`🔍 [Round ${r}/${totalRounds} 讨论] 审查方 (${reviewProvider} / ${reviewModel || 'default'}) 正在${r === 1 ? '深度审查初案并提出边界与安全质询' : '复核修订案并评估共识收敛'}...`, 'stdout');

                    const reviewerPrompt = `
You are the Independent Senior Technical Architect & Reviewer Agent.
${wsContext}
User Requirement / Goal: "${vaguePrompt}"
Developer Proposed Plan (Round ${r}):
${devProposal}

Analyze this proposal critically for:
1. Technical rigor: Are edge cases, concurrency, failure modes, data consistency, and backward compatibility adequately handled?
2. Practical feasibility: Is the subtask checklist actionable, and is the automated test gate strategy sufficient?

Conclude with your verdict:
- If all technical risks are addressed and the plan is ready for execution, conclude with:
  **[VERDICT: CONSENSUS_REACHED]** (共识达成，方案完备可执行) followed by a concise approval summary.
- If there are critical missing considerations or security questions, conclude with:
  **[VERDICT: NEEDS_REFINEMENT]** (需进一步修改) followed by specific demands for the developer.
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
                            revOut = `### 🔍 审查方质询与改进建议 (第 ${r} 轮)\n\n1. **并发与异常防御**：请开发方明确在高负载与超时异常下的降级与回滚逻辑；\n2. **门禁覆盖率**：任务清单需包含针对边界异常流的自动化测试验证。\n\n**[VERDICT: NEEDS_REFINEMENT]** 请开发方在下轮方案中明确上述细节。`;
                        } else {
                            revOut = `### 🔍 审查方评估与共识确认 (第 ${r} 轮)\n\n1. **架构可行性**：方案逻辑清晰，核心模块划分明确，异常处理完备；\n2. **任务可执行性**：任务清单具有明确的落地路径与验证门禁。\n\n**[VERDICT: CONSENSUS_REACHED]** 双方已达成共识，方案完备，可进入执行阶段。`;
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

                // --- 4. Persist Discussion History & Implementation Blueprint to Workspace ---
                try {
                    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
                        const discRecord = {
                            savedAt: new Date().toISOString(),
                            vaguePrompt,
                            consensusReached,
                            rounds: discussionHistory,
                            finalPlan: finalSynthesizedPlan,
                            suggestedFeature: responseData.suggestedFeature
                        };

                        // 1. Root Level JSON State
                        const rootDiscPath = path.join(workspaceRoot, 'requirement-discussion.json');
                        fs.writeFileSync(rootDiscPath, JSON.stringify(discRecord, null, 2), 'utf-8');

                        // 2. Root Level Markdown Blueprint
                        const rootPlanPath = path.join(workspaceRoot, 'IMPLEMENTATION_PLAN.md');
                        const planHeader = `# Technical Implementation Plan & Consensus Blueprint\n\n> **Auto-generated by Dual-Agent Studio** (${new Date().toLocaleString()})\n> **Initial Requirement**: "${vaguePrompt}"\n> **Consensus State**: ${consensusReached ? '✅ Consensus Reached' : '⚠️ Discussion Completed'}\n\n---\n\n`;
                        fs.writeFileSync(rootPlanPath, planHeader + finalSynthesizedPlan, 'utf-8');

                        // 3. Feature Spec Directory State
                        const featDir = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features', responseData.suggestedFeature);
                        if (!fs.existsSync(featDir)) {
                            fs.mkdirSync(featDir, { recursive: true });
                        }
                        fs.writeFileSync(path.join(featDir, 'discussion-history.json'), JSON.stringify(discRecord, null, 2), 'utf-8');
                        fs.writeFileSync(path.join(featDir, 'implementation-plan.md'), planHeader + finalSynthesizedPlan, 'utf-8');
                    }
                } catch (e) {
                    console.error('Failed to persist discussion plan:', e);
                }

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

    // 5.1 REST API: GET /api/discuss (Read Saved Discussion for Workspace)
    if (pathname === '/api/discuss' && req.method === 'GET') {
        const queryWs = url.searchParams.get('workspace');
        if (!queryWs || !fs.existsSync(queryWs)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Workspace not found.' }));
            return;
        }
        try {
            const rootDiscPath = path.join(queryWs, 'requirement-discussion.json');
            if (fs.existsSync(rootDiscPath)) {
                const content = fs.readFileSync(rootDiscPath, 'utf-8');
                const data = JSON.parse(content);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, discussion: data }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, discussion: null }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
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

                const procEnv = { ...process.env };
                if (!procEnv.http_proxy) procEnv.http_proxy = 'http://127.0.0.1:10809';
                if (!procEnv.https_proxy) procEnv.https_proxy = 'http://127.0.0.1:10809';
                if (!procEnv.HTTP_PROXY) procEnv.HTTP_PROXY = 'http://127.0.0.1:10809';
                if (!procEnv.HTTPS_PROXY) procEnv.HTTPS_PROXY = 'http://127.0.0.1:10809';
                if (!procEnv.all_proxy) procEnv.all_proxy = 'http://127.0.0.1:10809';
                if (!procEnv.ALL_PROXY) procEnv.ALL_PROXY = 'http://127.0.0.1:10809';

                activeProcess = spawn('pwsh', psArgs, {
                    cwd: config.workspaceRoot,
                    env: procEnv,
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