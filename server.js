const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./lib/studio-core');

const {
    CONTENT_SECURITY_POLICY,
    getProjects,
    saveProjects,
    getModelsConfig,
    saveModelsConfig,
    listDrivesAndDirs,
    getMailbox,
    readDiscussionRecord,
    writeDiscussionRecord,
    applyStudioProxyToEnv,
    writeTaskPromptFile,
    cleanupTaskPromptFile,
    getSafeWorkspaceDiff,
    sanitizeCopilotEffort,
    sanitizeSessionId,
    resolveEffectiveSessionId,
    resolveStudioSessionIds,
    persistWorkspaceSessions,
    detectDiscussionVerdict,
    shouldAutoResumeLoop,
    buildOrchestratorArgs,
    buildDiscussionAgentCommand,
    detectWorkspace,
    getStudioProxyUrl
} = core;

const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Process Error Protection
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception caught:', err);
    try { appendLog('⚠️ 系统异常拦截: ' + err.message, 'stderr'); } catch {}
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// In-Memory Studio State
let activeProcess = null;             // Orchestrator child process
let activeDiscussionProcess = null;   // Active discussion agent child process
let activeDiscussionAbortController = null; // AbortController for active discussion
let activeConfig = null;
let currentMailbox = null;
let isDiscussing = false;
let discussionGeneration = 0;         // Incremented per discussion or on abort to invalidate stale discussions
let logs = [];
let stoppedByUser = false;
let autoResumeAttempts = 0;
let activePromptFile = null;
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

function launchOrchestratorProcess(config, { isResume = false } = {}) {
    const sessionInfo = resolveStudioSessionIds({
        devSessionId: config.devSessionId,
        reviewSessionId: config.reviewSessionId || config.copilotSessionId,
        workspaceRoot: config.workspaceRoot,
        feature: config.feature,
        mailboxPath: config.mailboxPath,
        forceNew: !!config.forceNewSessions
    });

    const promptFile = writeTaskPromptFile(config.taskPrompt || '');
    activePromptFile = promptFile;
    const psArgs = buildOrchestratorArgs(config, sessionInfo, promptFile);
    const procEnv = applyStudioProxyToEnv({ ...process.env });

    activeProcess = spawn('pwsh', psArgs, {
        cwd: config.workspaceRoot,
        env: procEnv,
        shell: false
    });

    broadcast('state_change', { isRunning: true, isDiscussing, config, autoResume: isResume });

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
        cleanupTaskPromptFile(promptFile);
        if (activePromptFile === promptFile) activePromptFile = null;
        currentMailbox = getMailbox(config.workspaceRoot, config.mailboxPath, config.feature);
        const maxRounds = Number(config.maxRounds || currentMailbox?.maxRounds || 4);
        const canResume = !stoppedByUser
            && shouldAutoResumeLoop(currentMailbox, config)
            && autoResumeAttempts < Math.max(maxRounds, 1);

        if (canResume) {
            autoResumeAttempts += 1;
            const nextRound = currentMailbox.round || autoResumeAttempts + 1;
            appendLog(`🔄 检测到闭环停在 ${currentMailbox.status}（第 ${nextRound} 轮），正在自动续跑，无需手动点击启动...`, 'system');
            broadcast('mailbox_update', currentMailbox);
            activeProcess = null;
            setTimeout(() => {
                if (stoppedByUser || activeProcess) return;
                launchOrchestratorProcess(config, { isResume: true });
            }, 400);
            return;
        }

        appendLog(`⏹️ 双 Agent 闭环进程结束，退出码: ${code}`, code === 0 ? 'success' : 'error');
        activeProcess = null;
        autoResumeAttempts = 0;
        broadcast('state_change', { isRunning: false, isDiscussing, exitCode: code, mailbox: currentMailbox });
    });

    return sessionInfo;
}

// Helper to execute CLI agent turn in discussion using safe PowerShell pipeline invocation with 600s watchdog
async function executeDiscussionAgent({ provider, model, reasoningEffort, sessionId, prompt, workspaceRoot, role, timeoutSeconds = 600, token, signal }) {
    if (signal?.aborted || (token !== undefined && token !== discussionGeneration)) {
        return '';
    }

    let output = '';
    const tmpFile = path.join(os.tmpdir(), `discuss_prompt_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    
    try {
        fs.writeFileSync(tmpFile, prompt, 'utf-8');
        const safeTmp = tmpFile.replace(/\\/g, '/');
        const ws = (workspaceRoot && fs.existsSync(workspaceRoot)) ? workspaceRoot : process.cwd();

        let psCmd = '';
        const env = applyStudioProxyToEnv({ ...process.env });

        const provLower = (provider || 'copilot').toLowerCase();

        if (provLower === 'mock') {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (signal?.aborted || (token !== undefined && token !== discussionGeneration)) {
                return '';
            }
            const roundNum = parseInt((String(role).match(/R(\d+)/) || [])[1] || '1', 10);
            const isDevRole = /^Dev/i.test(String(role || ''));
            if (isDevRole) {
                return [
                    `Mock developer technical proposal (${role}).`,
                    '',
                    '1. **Target Architecture & Technical Strategy**: Implement the requested change in this workspace with focused, testable edits.',
                    '2. **File & Module Modifications**: Touch only the modules required by the user goal.',
                    '3. **Actionable Subtask Checklist**',
                    '- [ ] [Task 1] Apply the core implementation',
                    '- [ ] [Task 2] Cover the change with the existing test gate',
                    '4. **Edge Cases & Test Gate**: Keep verify commands fast and deterministic.'
                ].join('\n');
            }
            if (roundNum <= 1) {
                return 'The first-round proposal still needs a stronger test-gate strategy.\n\n**[VERDICT: NEEDS_REFINEMENT]**';
            }
            return 'The revised plan is concrete and executable.\n\n**[VERDICT: CONSENSUS_REACHED]**';
        }

        if (provLower === 'claude' || provLower === 'claude_code') {
            if (reasoningEffort && reasoningEffort !== 'none') {
                env.MAX_THINKING_TOKENS = reasoningEffort;
            }
        }
        psCmd = buildDiscussionAgentCommand({
            provider: provLower,
            model,
            reasoningEffort,
            sessionId,
            safeTmp
        });

        if (signal?.aborted || (token !== undefined && token !== discussionGeneration)) {
            return '';
        }

        if (psCmd) {
            await new Promise((resolve) => {
                let proc = null;
                let watchdogTimer = null;
                let onAbort = null;

                const cleanup = () => {
                    if (watchdogTimer) clearTimeout(watchdogTimer);
                    if (signal && onAbort) {
                        try { signal.removeEventListener('abort', onAbort); } catch {}
                    }
                    if (activeDiscussionProcess === proc) activeDiscussionProcess = null;
                };

                try {
                    proc = spawn('pwsh', ['-NoProfile', '-Command', psCmd], {
                        cwd: ws,
                        env,
                        shell: false
                    });

                    activeDiscussionProcess = proc;

                    if (signal) {
                        if (signal.aborted) {
                            try {
                                if (process.platform === 'win32') {
                                    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true });
                                } else {
                                    proc.kill('SIGKILL');
                                }
                            } catch {}
                            cleanup();
                            return resolve();
                        }
                        onAbort = () => {
                            try {
                                if (process.platform === 'win32') {
                                    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true });
                                } else {
                                    proc.kill('SIGKILL');
                                }
                            } catch {}
                            cleanup();
                            resolve();
                        };
                        signal.addEventListener('abort', onAbort, { once: true });
                    }

                    // 600s watchdog timer
                    watchdogTimer = setTimeout(() => {
                        appendLog(`[${role} ${provider}] 运行超时 (${timeoutSeconds} 秒)，正在终止进程...`, 'stderr');
                        try {
                            if (process.platform === 'win32') {
                                spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true });
                            } else {
                                proc.kill('SIGKILL');
                            }
                        } catch {}
                    }, timeoutSeconds * 1000);

                    proc.on('error', (err) => {
                        cleanup();
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

                    proc.on('close', () => {
                        cleanup();
                        resolve();
                    });
                } catch (e) {
                    cleanup();
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

async function runBackgroundDiscussion(params, token, signal) {
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
        } = params;

        let wsContext = '';
        try {
            if (workspaceRoot && fs.existsSync(workspaceRoot)) {
                const entries = fs.readdirSync(workspaceRoot).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== 'build' && e !== 'target' && e !== '.git');
                wsContext = `Target Codebase Directory: "${workspaceRoot}"\nVisible Project Structure: ${entries.slice(0, 20).join(', ')}`;
            }
        } catch {}

        const totalRounds = Math.min(Math.max(parseInt(maxDiscussionRounds, 10) || 2, 1), 4);
        appendLog(`💬 发起双 Agent 多轮需求对齐与架构共识推演 (最大 ${totalRounds} 轮): "${vaguePrompt}"`, 'system');

        const resolvedSessions = resolveStudioSessionIds({
            devSessionId,
            reviewSessionId: reviewSessionId || copilotSessionId,
            workspaceRoot,
            forceNew: !!params.forceNewSessions
        });
        const effectiveDevSessionId = resolvedSessions.devSessionId;
        const effectiveReviewSessionId = resolvedSessions.reviewSessionId;

        broadcast('discussion_start', {
            prompt: vaguePrompt,
            maxRounds: totalRounds,
            devSessionId: effectiveDevSessionId,
            reviewSessionId: effectiveReviewSessionId
        });

        const discussionHistory = [];
        let devProposal = '';
        let reviewerFeedback = '';
        let consensusReached = false;

        for (let r = 1; r <= totalRounds; r++) {
            // Check abort signal via scoped token and AbortSignal at the start of each round
            if (signal?.aborted || token !== discussionGeneration || !isDiscussing) {
                appendLog(`⚠️ 需求推演在第 ${r} 轮被中止。`, 'system');
                return;
            }

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
                sessionId: effectiveDevSessionId,
                prompt: devPrompt,
                workspaceRoot,
                role: `Dev-R${r}`,
                timeoutSeconds: 600,
                token,
                signal
            });

            // Check abort after dev turn
            if (signal?.aborted || token !== discussionGeneration || !isDiscussing) {
                appendLog(`⚠️ 需求推演在第 ${r} 轮开发方响应后被中止。`, 'system');
                return;
            }

            if (!devOut) {
                appendLog(`❌ [Round ${r}] 开发方 Agent (${devProvider}) 未返回任何有效输出，需求推演失败。`, 'stderr');
                if (token === discussionGeneration && !signal?.aborted) {
                    broadcast('discussion_error', { error: `开发方 Agent (${devProvider}) 在第 ${r} 轮未返回任何有效输出。` });
                }
                return;
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
                role: `Reviewer-R${r}`,
                timeoutSeconds: 600,
                token,
                signal
            });

            // Check abort after reviewer turn
            if (signal?.aborted || token !== discussionGeneration || !isDiscussing) {
                appendLog(`⚠️ 需求推演在第 ${r} 轮审查方响应后被中止。`, 'system');
                return;
            }

            if (!revOut) {
                appendLog(`❌ [Round ${r}] 审查方 Agent (${reviewProvider}) 未返回任何有效输出，需求推演失败。`, 'stderr');
                if (token === discussionGeneration && !signal?.aborted) {
                    broadcast('discussion_error', { error: `审查方 Agent (${reviewProvider}) 在第 ${r} 轮未返回任何有效输出。` });
                }
                return;
            }

            reviewerFeedback = revOut;
            const verdictInfo = detectDiscussionVerdict(revOut);
            const isConsensus = verdictInfo.consensus;
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

        if (signal?.aborted || token !== discussionGeneration || !isDiscussing) {
            return;
        }

        if (!devProposal || !reviewerFeedback || discussionHistory.length === 0) {
            appendLog(`❌ 需求推演未产出完整方案，跳过生成实施计划。`, 'stderr');
            if (token === discussionGeneration && !signal?.aborted) {
                broadcast('discussion_error', { error: '需求推演未产出完整的开发与审查方案。' });
            }
            return;
        }

        // Final Blueprint
        const finalSynthesizedPlan = `${devProposal}\n\n---\n\n### 📋 审查方确认之约束与测试门禁\n${reviewerFeedback}`;
        appendLog(`🏁 需求多轮推演完成（共 ${discussionHistory.length} 轮次交互）！已生成综合可执行任务方案，等待人工确认...`, 'system');

        const responseData = {
            success: true,
            consensusReached,
            rounds: discussionHistory,
            devProposal,
            reviewerFeedback,
            finalPlan: finalSynthesizedPlan,
            suggestedFeature: 'feature_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Math.random().toString(36).substring(2,6),
            devSessionId: effectiveDevSessionId,
            reviewSessionId: effectiveReviewSessionId
        };

        // Persist Discussion History & Implementation Blueprint to Workspace
        try {
            if (workspaceRoot && fs.existsSync(workspaceRoot)) {
                const discRecord = {
                    savedAt: new Date().toISOString(),
                    vaguePrompt,
                    consensusReached,
                    devSessionId: effectiveDevSessionId,
                    reviewSessionId: effectiveReviewSessionId,
                    rounds: discussionHistory,
                    finalPlan: finalSynthesizedPlan,
                    suggestedFeature: responseData.suggestedFeature
                };

                const isolatedPath = writeDiscussionRecord(workspaceRoot, discRecord);
                const planHeader = `# Technical Implementation Plan & Consensus Blueprint\n\n> **Auto-generated by Dual-Agent Studio** (${new Date().toLocaleString()})\n> **Initial Requirement**: "${vaguePrompt}"\n> **Consensus State**: ${consensusReached ? '✅ Consensus Reached' : '⚠️ Discussion Completed'}\n\n---\n\n`;

                const featDir = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features', responseData.suggestedFeature);
                if (!fs.existsSync(featDir)) {
                    fs.mkdirSync(featDir, { recursive: true });
                }
                fs.writeFileSync(path.join(featDir, 'discussion-history.json'), JSON.stringify(discRecord, null, 2), 'utf-8');
                fs.writeFileSync(path.join(featDir, 'implementation-plan.md'), planHeader + finalSynthesizedPlan, 'utf-8');
                if (isolatedPath) {
                    appendLog(`📦 讨论记录已写入 ${isolatedPath}（未污染目标仓库根目录）`, 'system');
                }
            }
        } catch (e) {
            console.error('Failed to persist discussion plan:', e);
        }

        if (token === discussionGeneration && !signal?.aborted) {
            broadcast('discussion_complete', responseData);
        }
    } catch (err) {
        if (token === discussionGeneration && !signal?.aborted) {
            appendLog(`❌ 需求讨论异常: ${err.message}`, 'stderr');
            broadcast('discussion_error', { error: err.message });
        }
    } finally {
        if (token === discussionGeneration) {
            isDiscussing = false;
            activeDiscussionProcess = null;
            activeDiscussionAbortController = null;
        }
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS + local-only CSP (no third-party fonts/scripts)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

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
        // Replay recent logs so refreshed or newly connected clients get instant history
        for (const l of logs.slice(-100)) {
            res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // 2. REST API: /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
        const queryWs = url.searchParams.get('workspace');
        const queryFeature = url.searchParams.get('feature');
        const targetWs = (activeConfig && activeConfig.workspaceRoot) || queryWs;
        let mb = currentMailbox;
        if (targetWs) {
            mb = getMailbox(targetWs, activeConfig ? activeConfig.mailboxPath : null, (activeConfig ? activeConfig.feature : null) || queryFeature);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            isRunning: activeProcess !== null,
            isDiscussing: isDiscussing,
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

    // 3.1 REST API: /api/sessions (Detect & Reset Workspace Sessions)
    if (pathname === '/api/sessions' && req.method === 'GET') {
        const queryWs = url.searchParams.get('workspace') || url.searchParams.get('workspaceRoot');
        const queryFeature = url.searchParams.get('feature');
        const queryMailbox = url.searchParams.get('mailboxPath');
        const queryDevSessionId = url.searchParams.get('devSessionId');
        const queryReviewSessionId = url.searchParams.get('reviewSessionId') || url.searchParams.get('copilotSessionId');
        const forceNew = url.searchParams.get('forceNew') === 'true' || url.searchParams.get('forceNew') === '1';
        if (!queryWs || !fs.existsSync(queryWs)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Workspace path is required and must exist.' }));
            return;
        }

        const sessionInfo = resolveStudioSessionIds({
            devSessionId: queryDevSessionId,
            reviewSessionId: queryReviewSessionId,
            workspaceRoot: queryWs,
            feature: queryFeature,
            mailboxPath: queryMailbox,
            forceNew
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            workspace: queryWs,
            feature: queryFeature || null,
            devSessionId: sessionInfo.devSessionId,
            reviewSessionId: sessionInfo.reviewSessionId,
            devSource: sessionInfo.devSource,
            reviewSource: sessionInfo.reviewSource,
            source: sessionInfo.source
        }));
        return;
    }

    if (pathname === '/api/sessions/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const params = body ? JSON.parse(body) : {};
                const ws = params.workspaceRoot || params.workspace || url.searchParams.get('workspace') || url.searchParams.get('workspaceRoot');
                if (!ws || !fs.existsSync(ws)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Workspace path is required and must exist.' }));
                    return;
                }

                const newDevSessionId = sanitizeSessionId(params.devSessionId) || crypto.randomUUID();
                let newReviewSessionId = sanitizeSessionId(params.reviewSessionId || params.copilotSessionId) || crypto.randomUUID();
                if (newDevSessionId === newReviewSessionId) {
                    newReviewSessionId = crypto.randomUUID();
                }

                const persisted = persistWorkspaceSessions(ws, newDevSessionId, newReviewSessionId, params.feature);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    workspace: ws,
                    devSessionId: newDevSessionId,
                    reviewSessionId: newReviewSessionId,
                    persisted
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
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

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(detectWorkspace(workspaceRoot)));
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

    // 5. REST API: /api/discuss (Multi-Round Collaborative Requirement Alignment)
    if (pathname === '/api/discuss' && req.method === 'POST') {
        if (activeProcess || isDiscussing) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: activeProcess ? 'An execution loop is currently in progress.' : 'Another discussion is currently in progress.' }));
            return;
        }

        isDiscussing = true;
        let body = '';
        req.on('data', c => body += c);
        req.on('error', () => { isDiscussing = false; });
        req.on('end', () => {
            try {
                const params = JSON.parse(body);
                if (!params.vaguePrompt) {
                    isDiscussing = false;
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'vaguePrompt is required.' }));
                    return;
                }

                const token = ++discussionGeneration;
                activeDiscussionAbortController = new AbortController();
                const signal = activeDiscussionAbortController.signal;

                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Discussion initiated in background.', discussionToken: token }));

                // Run background discussion asynchronously with generation token and abort signal
                runBackgroundDiscussion(params, token, signal);
            } catch (err) {
                isDiscussing = false;
                res.writeHead(400, { 'Content-Type': 'application/json' });
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
            const data = readDiscussionRecord(queryWs);
            if (data) {
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
        if (activeProcess || isDiscussing) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: isDiscussing ? 'A discussion is currently in progress.' : 'A loop is already running. Stop it before starting a new one.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                if (!config.workspaceRoot || !config.taskPrompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'workspaceRoot and taskPrompt are mandatory.' }));
                    return;
                }

                activeConfig = config;
                logs = [];
                stoppedByUser = false;
                autoResumeAttempts = 0;
                appendLog(`🚀 启动双 Agent 全自动闭环: ${config.workspaceRoot}`, 'system');

                // Save to recent projects
                const projects = getProjects();
                if (!projects.some(p => p.path.toLowerCase() === config.workspaceRoot.toLowerCase())) {
                    projects.unshift({ path: config.workspaceRoot, name: path.basename(config.workspaceRoot) });
                    saveProjects(projects);
                }

                launchOrchestratorProcess(config, { isResume: false });

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
        let stoppedSomething = false;

        if (activeProcess) {
            stoppedByUser = true;
            autoResumeAttempts = 0;
            appendLog('⚠️ 用户主动中止运行中的闭环任务...', 'system');
            const pid = activeProcess.pid;
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: true });
                } else {
                    activeProcess.kill('SIGKILL');
                }
            } catch {}
            activeProcess = null;
            broadcast('state_change', { isRunning: false, isDiscussing, stoppedByUser: true });
            stoppedSomething = true;
        }

        if (activeDiscussionProcess || isDiscussing || activeDiscussionAbortController) {
            appendLog('⚠️ 用户主动中止运行中的需求推演与讨论...', 'system');
            discussionGeneration++;
            isDiscussing = false;
            if (activeDiscussionAbortController) {
                try { activeDiscussionAbortController.abort(); } catch {}
                activeDiscussionAbortController = null;
            }
            if (activeDiscussionProcess) {
                const dPid = activeDiscussionProcess.pid;
                try {
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/F', '/T', '/PID', String(dPid)], { shell: true });
                    } else {
                        activeDiscussionProcess.kill('SIGKILL');
                    }
                } catch {}
                activeDiscussionProcess = null;
            }
            broadcast('discussion_error', { error: 'Discussion stopped by user.' });
            stoppedSomething = true;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: stoppedSomething ? 'Process / Discussion stopped.' : 'No active process is currently running.'
        }));
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

        const safe = getSafeWorkspaceDiff(ws);
        if (safe.error && !safe.diff) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: safe.error }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            diff: safe.diff,
            status: safe.status
        }));
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

if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`================================================================`);
        console.log(` 🚀 Dual-Agent Studio is running at: http://localhost:${PORT}`);
        console.log(`================================================================`);
    });
}

module.exports = {
    server,
    getProjects,
    getModelsConfig,
    sanitizeCopilotEffort,
    sanitizeSessionId,
    resolveEffectiveSessionId,
    resolveStudioSessionIds,
    persistWorkspaceSessions,
    listDrivesAndDirs,
    getMailbox,
    detectDiscussionVerdict,
    shouldAutoResumeLoop,
    buildOrchestratorArgs,
    getSafeWorkspaceDiff,
    readDiscussionRecord,
    writeDiscussionRecord,
    getStudioProxyUrl,
    buildDiscussionAgentCommand,
    detectWorkspace,
    CONTENT_SECURITY_POLICY
};