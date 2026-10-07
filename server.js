const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { RunStore, workspaceKey } = require('./engine/run-store');
const { adjustBudget, remainingBudget } = require('./engine/execution-budget');
const { estimateExecution } = require('./engine/execution-estimate');
const { Workflow, sourceSnapshot } = require('./engine/workflow');
const {closureView}=require('./engine/audit-closure');
const { invokeAgent } = require('./engine/process-runner');
const { AuditWorkflow } = require('./engine/audit-workflow');
const { auditCapabilities } = require('./engine/audit-config');
const { AgentHealth } = require('./engine/agent-health');
const { AuditTemplates } = require('./engine/audit-templates');
const { presentAudit } = require('./engine/audit-triage');
const { issueLedger } = require('./engine/issue-ledger');
const { PlanningWorkflow } = require('./engine/planning-workflow');
const { planMigration, applyMigration } = require('./engine/storage-migration');
const { createCase, presentCase, decideCase, applyDecision } = require('./engine/decision-cases');
const { analyzeCase } = require('./engine/decision-analysis');
const { planExport, buildExport } = require('./engine/evidence-export');
const { validateImportedBundle, renderReport } = require('./engine/evidence-report');
const { previewArchive, applyArchive, restoreArchive, listArchives, getArchivedRecordSet } = require('./engine/record-archive');
const { getStorageOverview, buildDiagnosticPackage } = require('./engine/diagnostics');
const runStore = new RunStore(process.env.STUDIO_DATA_DIR || path.join(__dirname, '.studio'));
const agentHealth = new AgentHealth({store: runStore, catalog:getModelsConfig});
const auditTemplates = new AuditTemplates(runStore.root,getModelsConfig);
const workflow = new Workflow(runStore, { emit: (type, data) => {
    if (type === 'log') appendLog(data.message, data.type);
    else broadcast(type, data);
} });
const auditWorkflow = new AuditWorkflow(runStore, { catalog: getModelsConfig, emit: (type, data) => {
    if (type === 'log') appendLog(data.message, data.type);
    else broadcast(type, data);
} });
const planningWorkflow=new PlanningWorkflow(runStore,{catalog:getModelsConfig,emit:(type,data)=>{
    if(type==='log')appendLog(data.message,data.type);else broadcast(type,data);
}});

const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_FILE = process.env.STUDIO_DATA_DIR ? path.join(runStore.root, 'projects.json') : path.join(__dirname, 'projects.json');
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
let activeProcess = null;             // Orchestrator child process
let activeDiscussionProcess = null;   // Active discussion agent child process
let activeDiscussionAbortController = null; // AbortController for active discussion
let activeConfig = null;
let currentMailbox = null;
let isDiscussing = false;
let discussionGeneration = 0;         // Incremented per discussion or on abort to invalidate stale discussions
let logs = [];
const sseClients = new Set();
if (require.main === module) {
    (async () => {
        try {
            if (runStore?.guard) {
                const rec = await runStore.guard.recover();
                if (rec.state === 'BUSY' || rec.reason === 'ANOTHER_INSTANCE_ALIVE' || rec.reason === 'UNKNOWN_PROCESS_STATUS') {
                    return;
                }
            }
            let lease = null;
            try {
                if (runStore?.guard) {
                    lease = await runStore.guard.acquire({ kind: 'maintenance', id: 'server-recovery' });
                }
            } catch {
                return;
            }
            try {
                workflow.recover();
                auditWorkflow.recover();
                planningWorkflow.recover();
                agentHealth.recover();
            } finally {
                lease?.release?.();
            }
        } catch (err) {
            console.error('Server startup recovery failed:', err);
        }
    })();
}

function readRequestJson(req) {
    return new Promise((resolve, reject) => {
        let body = '', bytes = 0;
        req.setEncoding('utf8');
        req.on('data', data => {
            bytes += Buffer.byteLength(data);
            if (bytes > 1024 * 1024) reject(new Error('REQUEST_TOO_LARGE'));
            else body += data;
        });
        req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}
function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

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
        fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
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
            if (fs.existsSync(sopMb)) {
                mbPath = sopMb;
            } else {
                const rootMb = path.join(workspaceRoot, 'review-mailbox.json');
                if (fs.existsSync(rootMb)) {
                    mbPath = rootMb;
                } else {
                    // Check latest feature in .ai-workspace/specs/features/
                    const featBase = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features');
                    if (fs.existsSync(featBase)) {
                        try {
                            const subdirs = fs.readdirSync(featBase, { withFileTypes: true })
                                .filter(d => d.isDirectory())
                                .map(d => path.join(featBase, d.name, 'review-mailbox.json'))
                                .filter(p => fs.existsSync(p))
                                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                            if (subdirs.length > 0) {
                                mbPath = subdirs[0];
                            }
                        } catch {}
                    }
                }
            }
        }
    } else if (!path.isAbsolute(mbPath)) {
        mbPath = path.join(workspaceRoot, mbPath);
    }

    try {
        if (mbPath && fs.existsSync(mbPath)) {
            const raw = fs.readFileSync(mbPath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch {}
    return null;
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

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

function sanitizeSessionId(id) {
    if (!id || typeof id !== 'string') return null;
    const trimmed = id.trim();
    if (SESSION_ID_REGEX.test(trimmed)) {
        return trimmed;
    }
    const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, '');
    if (cleaned.length >= 8) {
        return cleaned.substring(0, 64);
    }
    return null;
}

function resolveEffectiveSessionId({ explicitId, workspaceRoot, feature, mailboxPath, role = 'dev', forceNew = false, autoBind = true }) {
    // 1. Explicit ID
    if (!forceNew && explicitId) {
        const sanitized = sanitizeSessionId(explicitId);
        if (sanitized) return { sessionId: sanitized, source: 'explicit' };
    }

    // 2. Multi-tier resolution: Mailbox > requirement-discussion.json
    if (!forceNew && autoBind && workspaceRoot && fs.existsSync(workspaceRoot)) {
        // Check Mailbox
        const mb = getMailbox(workspaceRoot, mailboxPath, feature);
        if (mb) {
            const cand = role === 'dev' ? mb.devSessionId : (mb.reviewSessionId || mb.reviewerSessionId);
            const sanitized = sanitizeSessionId(cand);
            if (sanitized) return { sessionId: sanitized, source: 'mailbox' };
        }

        // Check Feature Discussion
        if (feature) {
            const featDisc = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features', feature, 'discussion-history.json');
            if (fs.existsSync(featDisc)) {
                try {
                    const disc = JSON.parse(fs.readFileSync(featDisc, 'utf-8'));
                    const cand = role === 'dev' ? disc.devSessionId : disc.reviewSessionId;
                    const sanitized = sanitizeSessionId(cand);
                    if (sanitized) return { sessionId: sanitized, source: 'discussion' };
                } catch {}
            }
        }

        // Check Root Discussion
        const discPath = path.join(workspaceRoot, 'requirement-discussion.json');
        if (fs.existsSync(discPath)) {
            try {
                const disc = JSON.parse(fs.readFileSync(discPath, 'utf-8'));
                const cand = role === 'dev' ? disc.devSessionId : disc.reviewSessionId;
                const sanitized = sanitizeSessionId(cand);
                if (sanitized) return { sessionId: sanitized, source: 'discussion' };
            } catch {}
        }
    }

    // 3. Fallback to fresh UUID
    return { sessionId: crypto.randomUUID(), source: 'generated' };
}

function resolveStudioSessionIds(options = {}) {
    const devRes = resolveEffectiveSessionId({
        explicitId: options.devSessionId,
        workspaceRoot: options.workspaceRoot,
        feature: options.feature,
        mailboxPath: options.mailboxPath,
        role: 'dev',
        forceNew: !!options.forceNew,
        autoBind: options.autoBind !== false
    });

    let reviewRes = resolveEffectiveSessionId({
        explicitId: options.reviewSessionId || options.copilotSessionId,
        workspaceRoot: options.workspaceRoot,
        feature: options.feature,
        mailboxPath: options.mailboxPath,
        role: 'review',
        forceNew: !!options.forceNew,
        autoBind: options.autoBind !== false
    });

    // Dual-Agent Session Isolation: Ensure Dev and Reviewer session IDs never collide
    if (devRes.sessionId === reviewRes.sessionId) {
        reviewRes = { sessionId: crypto.randomUUID(), source: 'generated' };
    }

    return {
        devSessionId: devRes.sessionId,
        devSource: devRes.source,
        reviewSessionId: reviewRes.sessionId,
        reviewSource: reviewRes.source,
        source: (devRes.source === reviewRes.source) ? devRes.source : `${devRes.source}/${reviewRes.source}`
    };
}

function persistWorkspaceSessions(workspaceRoot, devSessionId, reviewSessionId, feature = null) {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return false;

    // 1. Update or create requirement-discussion.json in workspace root
    try {
        const discPath = path.join(workspaceRoot, 'requirement-discussion.json');
        let disc = {};
        if (fs.existsSync(discPath)) {
            try {
                disc = JSON.parse(fs.readFileSync(discPath, 'utf-8'));
            } catch {}
        }
        disc.savedAt = disc.savedAt || new Date().toISOString();
        disc.devSessionId = devSessionId;
        disc.reviewSessionId = reviewSessionId;
        fs.writeFileSync(discPath, JSON.stringify(disc, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to persist to requirement-discussion.json:', e);
    }

    // 2. Update feature discussion-history.json and review-mailbox.json if feature specs exist
    const featBase = path.join(workspaceRoot, '.ai-workspace', 'specs', 'features');
    if (fs.existsSync(featBase)) {
        try {
            const subdirs = fs.readdirSync(featBase, { withFileTypes: true });
            for (const d of subdirs) {
                if (d.isDirectory()) {
                    if (!feature || feature === d.name) {
                        const featDir = path.join(featBase, d.name);
                        const fDiscPath = path.join(featDir, 'discussion-history.json');
                        if (fs.existsSync(fDiscPath)) {
                            try {
                                const fDisc = JSON.parse(fs.readFileSync(fDiscPath, 'utf-8'));
                                fDisc.devSessionId = devSessionId;
                                fDisc.reviewSessionId = reviewSessionId;
                                fs.writeFileSync(fDiscPath, JSON.stringify(fDisc, null, 2), 'utf-8');
                            } catch {}
                        }
                        const fMbPath = path.join(featDir, 'review-mailbox.json');
                        if (fs.existsSync(fMbPath)) {
                            try {
                                const mb = JSON.parse(fs.readFileSync(fMbPath, 'utf-8'));
                                mb.devSessionId = devSessionId;
                                mb.reviewSessionId = reviewSessionId;
                                mb.reviewerSessionId = reviewSessionId;
                                mb.updatedAt = new Date().toISOString();
                                fs.writeFileSync(fMbPath, JSON.stringify(mb, null, 2), 'utf-8');
                            } catch {}
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to persist feature specs:', e);
        }
    }

    // 3. Update sop review-mailbox.json or root review-mailbox.json
    const sopMb = path.join(workspaceRoot, '.ai-sop', 'review-mailbox.json');
    if (fs.existsSync(sopMb)) {
        try {
            const mb = JSON.parse(fs.readFileSync(sopMb, 'utf-8'));
            mb.devSessionId = devSessionId;
            mb.reviewSessionId = reviewSessionId;
            mb.reviewerSessionId = reviewSessionId;
            mb.updatedAt = new Date().toISOString();
            fs.writeFileSync(sopMb, JSON.stringify(mb, null, 2), 'utf-8');
        } catch {}
    }

    const rootMb = path.join(workspaceRoot, 'review-mailbox.json');
    if (fs.existsSync(rootMb)) {
        try {
            const mb = JSON.parse(fs.readFileSync(rootMb, 'utf-8'));
            mb.devSessionId = devSessionId;
            mb.reviewSessionId = reviewSessionId;
            mb.reviewerSessionId = reviewSessionId;
            mb.updatedAt = new Date().toISOString();
            fs.writeFileSync(rootMb, JSON.stringify(mb, null, 2), 'utf-8');
        } catch {}
    }

    return true;
}

// Helper to execute CLI agent turn in discussion using safe PowerShell pipeline invocation with 600s watchdog
async function executeDiscussionAgent({ provider, model, reasoningEffort, sessionId, prompt, workspaceRoot, role, timeoutSeconds = 600, token, signal }) {
    if (signal?.aborted || token !== discussionGeneration) return '';
    const before = await sourceSnapshot(workspaceRoot, signal);
    let discussionProcess = null;
    try {
        const answer = await invokeAgent({ provider, model, reasoningEffort, sessionId, prompt,
            workspaceRoot, role: 'discussion', sessionDirectory: path.join(runStore.root, 'sessions') }, {
            signal, timeoutMs: timeoutSeconds * 1000,
            onSpawn: proc => { discussionProcess = proc; activeDiscussionProcess = proc; },
            onOutput: (text, type) => appendLog(text, type)
        });
        if (before !== await sourceSnapshot(workspaceRoot, signal)) throw new Error('讨论阶段检测到源文件变更，已停止；请检查 Diff。');
        return answer;
    } catch (error) { if (signal?.aborted) return ''; throw error; }
    finally { if (activeDiscussionProcess === discussionProcess) activeDiscussionProcess = null; }
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

        if (params.parentPlanId) {
            const previous = runStore.read('plans', params.parentPlanId);
            if (previous.workspaceKey !== require('./engine/run-store').workspaceKey(workspaceRoot)) throw new Error('PLAN_WORKSPACE_MISMATCH');
            wsContext += `\nPrevious plan (revise using the human's decisions):\n${previous.finalPlan}\nHuman decisions / feedback:\n${String(params.humanFeedback || '')}`;
        }

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
- This phase is READ ONLY. Inspect actual project files before proposing changes; do not implement or commit.
- Start with evidence-backed observations (file paths and behavior), distinguish facts from assumptions.
- The user may not know the exact requirement. Explain the user benefit and the problem being solved.
- Compare at least two options, including a minimal-change option, costs, compatibility, risks and non-goals.
- List unresolved business questions and decisions for the human. Never decide those silently.
- Define observable acceptance criteria and real regression commands. Do not treat agent consensus as human approval.
- Present a short decision brief in Chinese before technical details.
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
0. Read the actual project code. Check whether the proposed problem is real and whether a smaller change suffices.
Identify unsupported assumptions, alternative options, and decisions only the human can make.
This is a read-only discussion; do not implement changes. Report unresolved questions honestly even if you agree technically.
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
            const isConsensus = /\[VERDICT:\s*CONSENSUS_REACHED\]/.test(revOut) && !revOut.includes('NEEDS_REFINEMENT');
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
            workspaceRoot,
            consensusReached,
            rounds: discussionHistory,
            devProposal,
            reviewerFeedback,
            finalPlan: finalSynthesizedPlan,
            suggestedFeature: 'feature_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Math.random().toString(36).substring(2,6),
            devSessionId: effectiveDevSessionId,
            reviewSessionId: effectiveReviewSessionId
        };

        const plan = runStore.createPlan(workspaceRoot, {
            vaguePrompt, consensusReached, devSessionId: effectiveDevSessionId,
            reviewSessionId: effectiveReviewSessionId, rounds: discussionHistory,
            finalPlan: finalSynthesizedPlan, suggestedFeature: responseData.suggestedFeature,
            parentPlanId: params.parentPlanId || null, humanFeedback: params.humanFeedback || ''
        });
        responseData.planId = plan.id;
        responseData.planVersion = plan.version;

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
function isWorkflowBusy() {
    return !!(
        activeProcess !== null ||
        workflow.active !== null ||
        auditWorkflow.active !== null ||
        agentHealth.active !== null ||
        planningWorkflow.active !== null ||
        isDiscussing ||
        (!auditWorkflow.active && auditWorkflow.hasLiveClosureTest()) ||
        (runStore?.guard && runStore.guard.isBusy())
    );
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    // Interrupted test processes remain authoritative until the OS confirms they exited.
    if(req.method==='POST'&&pathname.startsWith('/api/')&&pathname!=='/api/stop'&&!auditWorkflow.active&&auditWorkflow.hasLiveClosureTest()){
        sendJson(res,409,{error:'PREVIOUS_PROCESS_STILL_RUNNING'});return;
    }

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (pathname === '/api/audit-capabilities' && req.method === 'GET') {
        sendJson(res, 200, auditCapabilities(getModelsConfig())); return;
    }
    if (pathname === '/api/agent-health' && req.method === 'POST') {
        try {
            if (isWorkflowBusy()) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
            const body=await readRequestJson(req);
            if (isWorkflowBusy()) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
            let lease = null;
            if (body.mode === 'probe' && runStore?.guard) {
                lease = await runStore.guard.acquire({ kind: 'health-probe', id: crypto.randomUUID() });
            }
            try {
                sendJson(res, 200, await agentHealth.run(body));
            } finally {
                lease?.release?.();
            }
            return;

        }catch(error){sendJson(res,/BUSY/.test(error.message)?409:400,{error:error.message});}
        return;
    }
    if (pathname === '/api/audit-templates' || pathname === '/api/audit-templates/delete') {
        try {
            if(req.method==='GET' && pathname==='/api/audit-templates')sendJson(res,200,auditTemplates.list(url.searchParams.get('workspace')));
            else if(req.method==='POST'){
                const body=await readRequestJson(req);
                sendJson(res,200,pathname.endsWith('/delete')?auditTemplates.remove(body):auditTemplates.save(body));
            }else sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});
        }catch(error){sendJson(res,/CONFLICT|MISMATCH/.test(error.message)?409:400,{error:error.message});}
        return;
    }
    if(pathname==='/api/planning'||pathname.startsWith('/api/planning/')){
        try{
            const parts=pathname.split('/').filter(Boolean),id=parts[2],action=parts[3];
            if(req.method==='GET'&&parts.length<=3){sendJson(res,200,id?runStore.read('discussions',id):runStore.list('discussions',url.searchParams.get('workspace')));return;}
            if(req.method==='GET'&&id&&parts.length===4&&['draft','compare'].includes(action)){sendJson(res,200,action==='draft'?planningWorkflow.draft(id):planningWorkflow.compare(id));return;}
            if(req.method==='GET'&&id&&action==='artifacts'&&parts.length===4){
                runStore.read('discussions',id);const name=url.searchParams.get('name');
                if(name){const content=fs.readFileSync(runStore.file('discussions',id,name),'utf8');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(content);}
                else sendJson(res,200,fs.readdirSync(path.dirname(runStore.file('discussions',id))));return;
            }
            if(req.method==='POST'){
                const body=await readRequestJson(req);
                if(id&&action==='draft'&&parts.length===4){if(planningWorkflow.active){sendJson(res,409,{error:'WORKFLOW_BUSY'});return;}sendJson(res,200,planningWorkflow.draft(id,body));return;}
                if(activeProcess||workflow.active||auditWorkflow.active||agentHealth.active||planningWorkflow.active||isDiscussing){sendJson(res,409,{error:'WORKFLOW_BUSY'});return;}
                if(!id&&parts.length===2){const record=planningWorkflow.create(body);planningWorkflow.launch(record);sendJson(res,202,{discussionId:record.id});return;}
                if(id&&action==='preview'&&parts.length===4){sendJson(res,200,planningWorkflow.preview(id,body));return;}
                if(id&&action==='retry'&&parts.length===4){const record=planningWorkflow.retry(id,body);sendJson(res,202,{discussionId:record.id});return;}
                if(id&&action==='approve'&&parts.length===4){sendJson(res,200,await planningWorkflow.approve(id,body));return;}
            }
            sendJson(res,404,{error:'NOT_FOUND'});
        }catch(error){sendJson(res,/CONFLICT|BUSY|CHANGED|MISMATCH|STILL_RUNNING/.test(error.message)?409:400,{error:error.message});}return;
    }
    if(pathname==='/api/issues'){
        if(req.method!=='GET'){sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});return;}
        try{sendJson(res,200,issueLedger(runStore,url.searchParams.get('workspace')));}
        catch(error){sendJson(res,400,{error:error.message});}return;
    }
    if (pathname === '/api/decision-cases' || pathname.startsWith('/api/decision-cases/')) {
        try {
            const parts = pathname.split('/').filter(Boolean);
            const id = parts[2];
            const action = parts[3];

            if (req.method === 'GET' && parts.length <= 3) {
                if (id) {
                    sendJson(res, 200, presentCase(runStore, id));
                } else {
                    const ws = url.searchParams.get('workspace');
                    const cases = runStore.list('decision-cases', ws).map(c => presentCase(runStore, c.id));
                    sendJson(res, 200, cases);
                }
                return;
            }

            if (req.method === 'POST') {
                const body = await readRequestJson(req);
                if (!id && parts.length === 2) {
                    const created = createCase(runStore, body);
                    sendJson(res, 201, presentCase(runStore, created.id));
                    return;
                }
                if (id && action === 'analyze' && parts.length === 4) {
                    const result = await analyzeCase(runStore, id, body, { catalog: getModelsConfig });
                    sendJson(res, 200, result);
                    return;
                }
                if (id && action === 'decide' && parts.length === 4) {
                    const result = decideCase(runStore, id, body);
                    sendJson(res, 200, result);
                    return;
                }
                if (id && action === 'apply' && parts.length === 4) {
                    const result = applyDecision(runStore, { caseId: id, ...body });
                    sendJson(res, 200, result);
                    return;
                }
            }

            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) {
            const status = /CONFLICT|BUSY|CHANGED|MISMATCH|STILL_RUNNING/.test(error.message) ? 409 :
                           /NOT_FOUND/.test(error.message) ? 404 : 400;
            sendJson(res, status, { error: error.message });
        }
        return;
    }
    if (pathname === '/api/audits' || pathname.startsWith('/api/audits/')) {
        try {
            const parts = pathname.split('/').filter(Boolean), id = parts[2], action = parts[3];
            if(req.method==='GET'&&id&&action==='closure'&&parts.length===4){
                const record=runStore.read('audits',id),snapshot=await sourceSnapshot(record.workspaceRoot);
                sendJson(res,200,closureView(runStore,id,snapshot));return;
            }
            if (req.method === 'GET' && parts.length <= 3) {
                if (id) {
                    sendJson(res, 200, presentAudit(runStore.read('audits', id)));
                } else {
                    const ws = url.searchParams.get('workspace');
                    const includeArchived = url.searchParams.get('includeArchived') === 'true';
                    const archivedSet = getArchivedRecordSet(runStore);
                    let list = runStore.list('audits', ws);
                    if (!includeArchived) {
                        list = list.filter(a => !archivedSet.has(`audits:${a.id}`));
                    }
                    sendJson(res, 200, list.map(presentAudit));
                }
                return;
            }
            if (req.method === 'GET' && id && action === 'artifacts' && parts.length === 4) {
                runStore.read('audits', id);
                const name = url.searchParams.get('name');
                if (name) {
                    const content = fs.readFileSync(runStore.file('audits', id, name), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(content);
                } else sendJson(res, 200, fs.readdirSync(path.dirname(runStore.file('audits', id))));
                return;
            }
            if (req.method === 'POST') {
                const body = await readRequestJson(req);
                if (id && action === 'export-plan' && parts.length === 4) {
                    const plan = planExport(runStore, { auditId: id, ...body });
                    sendJson(res, 200, plan);
                    return;
                }
                if (id && action === 'export-bundle' && parts.length === 4) {
                    const bundle = buildExport(runStore, { auditId: id, ...body });
                    const format = (body.format || url.searchParams.get('format') || 'json').toLowerCase();
                    if (format === 'html') {
                        const html = renderReport(bundle);
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf-8',
                            'Content-Disposition': `attachment; filename="audit-${id.slice(0, 8)}-evidence.html"`,
                            'X-Content-Type-Options': 'nosniff'
                        });
                        res.end(html);
                        return;
                    }
                    const jsonStr = JSON.stringify(bundle, null, 2);
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Disposition': `attachment; filename="audit-${id.slice(0, 8)}-evidence.json"`,
                        'X-Content-Type-Options': 'nosniff'
                    });
                    res.end(jsonStr);
                    return;
                }
                if (id && action === 'archive-preview' && parts.length === 4) {
                    const preview = previewArchive(runStore, { auditId: id });
                    sendJson(res, 200, preview);
                    return;
                }
                if (id && action === 'archive-apply' && parts.length === 4) {
                    const group = applyArchive(runStore, { auditId: id, ...body });
                    sendJson(res, 200, group);
                    return;
                }
                if (id && action === 'targeted-preview' && parts.length === 4) {
                    const plan = await auditWorkflow.targetedPreview(id, body);
                    sendJson(res, 200, plan);
                    return;
                }
                if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
                if (!id && parts.length === 2) {
                    const record = auditWorkflow.create(body); auditWorkflow.launch(record);
                    sendJson(res, 202, { auditId: record.id }); return;
                }
                if (id && action === 'targeted-start' && parts.length === 4) {
                    const record = await auditWorkflow.targetedStart(id, body);
                    sendJson(res, 202, { auditId: record.id });
                    return;
                }
                if (id && action === 'supplement' && parts.length === 4) {
                    const record=await auditWorkflow.supplement(id,body);sendJson(res,202,{auditId:record.id});return;
                }
                if(id&&action==='closure-accept'&&parts.length===4){sendJson(res,200,await auditWorkflow.acceptClosure(id,body));return;}
                if(id&&action==='closure-test'&&parts.length===4){sendJson(res,202,auditWorkflow.testClosure(id,body));return;}
                if(id&&action==='closure-recheck'&&parts.length===4){const record=auditWorkflow.recheckClosure(id,body);sendJson(res,202,{auditId:record.id});return;}
                if (id && action === 'retry' && parts.length === 4) {
                    const record = auditWorkflow.retry(id); sendJson(res, 202, { auditId: record.id }); return;
                }
                if (id && action === 'repair' && parts.length === 4) {
                    const run = await auditWorkflow.repair(workflow, id, body); sendJson(res, 202, { runId: run.id }); return;
                }
                if (id && action === 'triage' && parts.length === 4) {
                    sendJson(res,200,auditWorkflow.triage(id,body)); return;
                }
                if (id && action === 'verify' && parts.length === 4) {
                    const verification=auditWorkflow.verify(id,body);sendJson(res,202,{auditId:id,verificationId:verification.id});return;
                }
            }
            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) { sendJson(res, /BUSY|CONFLICT|SOURCE_CHANGED|INVALIDATED|MISMATCH|STILL_RUNNING|FULL_AUDIT_REQUIRED/.test(error.message) ? 409 : 400, { error: error.message }); }
        return;
    }

    // V2 records: persisted runs, versioned approval and checkpoint recovery.
    if (pathname.startsWith('/api/runs') || pathname.startsWith('/api/plans')) {
        try {
            const parts = pathname.split('/').filter(Boolean);
            const kind = parts[1], id = parts[2], action = parts[3];
            if (!['runs', 'plans'].includes(kind)) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
            if (req.method === 'GET' && kind === 'runs' && id && action === 'artifacts') {
                runStore.read('runs', id);
                const name = url.searchParams.get('name');
                if (name) {
                    const file = runStore.file('runs', id, name);
                    const content = fs.readFileSync(file, 'utf8');
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
                    res.end(content);
                } else sendJson(res, 200, fs.readdirSync(path.dirname(runStore.file('runs', id))));
                return;
            }
            if (req.method === 'GET' && parts.length <= 3) {
                const records = id ? runStore.read(kind, id) : runStore.list(kind, url.searchParams.get('workspace'));
                sendJson(res, 200, records); return;
            }
            const body = await readRequestJson(req);
            if (req.method === 'POST' && kind === 'plans' && id && action === 'approve') {
                sendJson(res, 200, runStore.approvePlan(id, body)); return;
            }
            if (req.method === 'POST' && kind === 'runs') {
                if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
                if (id && action === 'decision') {
                    const run = workflow.decide(id, body);
                    sendJson(res, 202, { success: true, runId: run.id }); return;
                }
                if (id && action === 'resume') {
                    const run = workflow.resume(id);
                    sendJson(res, 202, { success: true, runId: run.id }); return;
                }
                if (!id) {
                    const run = workflow.create(body);
                    workflow.launch(run);
                    sendJson(res, 202, { success: true, runId: run.id }); return;
                }
            }
            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) {
            sendJson(res, /CONFLICT|NOT_APPROVED|CHANGED|BUSY|RESUMABLE/.test(error.message) ? 409 : 400, { error: error.message });
        }
        return;
    }

    if (pathname === '/api/estimate' || pathname === '/api/executions/estimate') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        try {
            const body = await readRequestJson(req);
            const { kind, config } = body || {};
            if (!kind || !['run', 'audit', 'planning', 'health'].includes(kind)) {
                sendJson(res, 400, { error: 'INVALID_EXECUTION_KIND' }); return;
            }
            const estimate = estimateExecution(kind, config || {});
            sendJson(res, 200, { ok: true, estimate });
        } catch (error) {
            sendJson(res, 400, { error: error.message });
        }
        return;
    }

    if (pathname.startsWith('/api/executions/')) {
        try {
            const parts = pathname.split('/').filter(Boolean);
            if (parts.length !== 5) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
            const [ , , kind, id, action ] = parts;
            const KIND_MAP = {
                run: 'runs',
                audit: 'audits',
                planning: 'discussions',
                health: 'health'
            };
            const storageKind = KIND_MAP[kind];
            if (!storageKind) { sendJson(res, 400, { error: 'INVALID_EXECUTION_KIND' }); return; }
            if (!id) { sendJson(res, 400, { error: 'INVALID_EXECUTION_ID' }); return; }

            if (req.method !== 'POST') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }

            if (isWorkflowBusy()) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }

            let record;
            try {
                record = runStore.read(storageKind, id);
            } catch {
                sendJson(res, 404, { error: 'RECORD_NOT_FOUND' }); return;
            }

            const body = await readRequestJson(req);

            if (action === 'budget') {
                const { workspaceRoot, version, budget, reason } = body;
                if (['RUNNING', 'STARTED'].includes(record.status)) {
                    sendJson(res, 409, { error: 'RECORD_ACTIVE' }); return;
                }
                if (kind !== 'health') {
                    let key = null;
                    try { if (workspaceRoot) key = workspaceKey(workspaceRoot); } catch {}
                    if (!workspaceRoot || key !== record.workspaceKey) {
                        sendJson(res, 403, { error: 'WORKSPACE_MISMATCH' }); return;
                    }
                }
                if (version !== undefined && version !== null) {
                    if (record.version !== undefined && record.version !== version) {
                        sendJson(res, 409, { error: 'VERSION_CONFLICT' }); return;
                    }
                }
                adjustBudget(record, budget, { reason });
                record.version = (record.version || 1) + 1;
                runStore.save(storageKind, record);
                sendJson(res, 200, { ok: true, budget: record.budget, version: record.version });
                return;
            }

            if (action === 'resume-budget') {
                const { workspaceRoot, version } = body;
                if (kind !== 'health') {
                    let key = null;
                    try { if (workspaceRoot) key = workspaceKey(workspaceRoot); } catch {}
                    if (!workspaceRoot || key !== record.workspaceKey) {
                        sendJson(res, 403, { error: 'WORKSPACE_MISMATCH' }); return;
                    }
                }
                if (version !== undefined && version !== null) {
                    if (record.version !== undefined && record.version !== version) {
                        sendJson(res, 409, { error: 'VERSION_CONFLICT' }); return;
                    }
                }
                const pausedByBudget = record.pauseReason === 'BUDGET_EXHAUSTED' || record.reviewers?.some?.(r => r.pauseReason === 'BUDGET_EXHAUSTED');
                if (!pausedByBudget && record.status !== 'STOPPED' && record.status !== 'INTERRUPTED') {
                    sendJson(res, 400, { error: 'EXECUTION_NOT_PAUSED_BY_BUDGET' }); return;
                }

                if (kind === 'audit') {
                    if (record.snapshot && await sourceSnapshot(record.workspaceRoot) !== record.snapshot) {
                        record.status = 'INVALIDATED';
                        record.error = '源码已改变，请重新发起审核。';
                        runStore.save('audits', record);
                        sendJson(res, 409, { error: 'AUDIT_SOURCE_CHANGED' }); return;
                    }
                } else if (kind === 'run') {
                    if (record.snapshot && await sourceSnapshot(record.workspaceRoot) !== record.snapshot) {
                        sendJson(res, 409, { error: 'SOURCE_CHANGED' }); return;
                    }
                } else if (kind === 'planning') {
                    if (record.snapshot && await sourceSnapshot(record.workspaceRoot) !== record.snapshot) {
                        record.status = 'INVALIDATED';
                        record.error = '源码已改变，请重新发起规划。';
                        runStore.save('discussions', record);
                        sendJson(res, 409, { error: 'PLANNING_SOURCE_CHANGED' }); return;
                    }
                }

                const rem = remainingBudget(record);
                if (rem.exhausted) {
                    sendJson(res, 400, { error: 'BUDGET_STILL_EXHAUSTED: ' + rem.reason }); return;
                }

                if (kind === 'audit') {
                    for (const r of record.reviewers || []) {
                        if (r.status === 'STOPPED' && r.pauseReason === 'BUDGET_EXHAUSTED') {
                            r.status = 'QUEUED';
                            delete r.pauseReason;
                            r.error = '';
                        }
                    }
                    delete record.pauseReason;
                    delete record.allowedActions;
                    record.version = (record.version || 1) + 1;
                    auditWorkflow.launch(record);
                    sendJson(res, 202, { ok: true, auditId: record.id, status: record.status });
                    return;
                } else if (kind === 'run') {
                    if (record.snapshot && await sourceSnapshot(record.workspaceRoot) !== record.snapshot) {
                        sendJson(res, 409, { error: 'SOURCE_CHANGED' }); return;
                    }
                    delete record.pauseReason;
                    delete record.allowedActions;
                    record.version = (record.version || 1) + 1;
                    runStore.save('runs', record);
                    workflow.resume(record.id);
                    sendJson(res, 202, { ok: true, runId: record.id, status: record.status });
                    return;
                } else if (kind === 'planning') {
                    if (record.snapshot && await sourceSnapshot(record.workspaceRoot) !== record.snapshot) {
                        record.status = 'INVALIDATED';
                        record.error = '源码已改变，请重新发起规划。';
                        runStore.save('discussions', record);
                        sendJson(res, 409, { error: 'PLANNING_SOURCE_CHANGED' }); return;
                    }
                    delete record.pauseReason;
                    delete record.allowedActions;
                    record.version = (record.version || 1) + 1;
                    planningWorkflow.launch(record);
                    sendJson(res, 202, { ok: true, discussionId: record.id, status: record.status });
                    return;
                } else {
                    delete record.pauseReason;
                    delete record.allowedActions;
                    record.version = (record.version || 1) + 1;
                    runStore.save(storageKind, record);
                    sendJson(res, 200, { ok: true, status: record.status });
                    return;
                }
            }

            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) {
            sendJson(res, /BUSY|CONFLICT|SOURCE_CHANGED|INVALIDATED|MISMATCH/.test(error.message) ? 409 : 400, { error: error.message });
        }
        return;
    }

    if (pathname === '/api/archives' || pathname.startsWith('/api/archives/')) {
        try {
            const parts = pathname.split('/').filter(Boolean);
            const id = parts[2];
            const action = parts[3];

            if (req.method === 'GET' && parts.length <= 2) {
                sendJson(res, 200, listArchives(runStore));
                return;
            }
            if (req.method === 'POST') {
                const body = await readRequestJson(req);
                if (id && action === 'restore' && parts.length === 4) {
                    const restored = restoreArchive(runStore, { archiveId: id, ...body });
                    sendJson(res, 200, restored);
                    return;
                }
            }
            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) {
            const status = /CONFLICT|BUSY|CHANGED/.test(error.message) ? 409 :
                           /NOT_FOUND/.test(error.message) ? 404 : 400;
            sendJson(res, status, { error: error.message });
        }
        return;
    }

    if (pathname === '/api/imports' || pathname.startsWith('/api/imports/')) {
        try {
            const parts = pathname.split('/').filter(Boolean);
            const id = parts[2];
            const action = parts[3];
            const importsDir = path.join(runStore.root, 'imports');

            if (req.method === 'GET') {
                if (parts.length === 2) {
                    if (!fs.existsSync(importsDir)) {
                        sendJson(res, 200, []);
                        return;
                    }
                    const list = [];
                    for (const impId of fs.readdirSync(importsDir)) {
                        const file = path.join(importsDir, impId, 'bundle.json');
                        if (fs.existsSync(file)) {
                            try {
                                const b = JSON.parse(fs.readFileSync(file, 'utf8'));
                                list.push({
                                    id: impId,
                                    auditId: b.auditId,
                                    formatVersion: b.formatVersion,
                                    generatedAt: b.generatedAt,
                                    recordsCount: Object.values(b.records || {}).reduce((sum, arr) => sum + (arr?.length || 0), 0),
                                    artifactsCount: Object.keys(b.artifacts || {}).length,
                                    redacted: b.redacted,
                                    limitations: b.limitations
                                });
                            } catch {}
                        }
                    }
                    list.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
                    sendJson(res, 200, list);
                    return;
                }
                if (id && parts.length === 3) {
                    const file = path.join(importsDir, id, 'bundle.json');
                    if (!fs.existsSync(file)) {
                        sendJson(res, 404, { error: 'IMPORT_NOT_FOUND' });
                        return;
                    }
                    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
                    sendJson(res, 200, b);
                    return;
                }
                if (id && action === 'report' && parts.length === 4) {
                    const file = path.join(importsDir, id, 'bundle.json');
                    if (!fs.existsSync(file)) {
                        sendJson(res, 404, { error: 'IMPORT_NOT_FOUND' });
                        return;
                    }
                    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
                    const html = renderReport(b);
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'X-Content-Type-Options': 'nosniff'
                    });
                    res.end(html);
                    return;
                }
            }

            if (req.method === 'POST' && parts.length === 2) {
                const body = await readRequestJson(req);
                const validation = validateImportedBundle(body);
                if (!validation.ok) {
                    sendJson(res, 400, { error: 'INVALID_IMPORT_BUNDLE', details: validation.errors });
                    return;
                }
                const importId = crypto.randomUUID();
                const dir = path.join(importsDir, importId);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(body, null, 2), 'utf8');
                sendJson(res, 201, {
                    success: true,
                    id: importId,
                    importId,
                    auditId: body.auditId,
                    formatVersion: body.formatVersion,
                    generatedAt: body.generatedAt,
                    manifestValid: validation.manifestValid,
                    limitations: body.limitations
                });
                return;
            }

            sendJson(res, 404, { error: 'NOT_FOUND' });
        } catch (error) {
            sendJson(res, 400, { error: error.message });
        }
        return;
    }

    if (pathname.startsWith('/api/maintenance/')) {
        try {
            if (pathname === '/api/maintenance/storage') {
                if (req.method !== 'GET') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
                const plan = planMigration(runStore);
                const kinds = ['runs', 'plans', 'audits', 'discussions', 'decision-cases'];
                const diagnostics = {};
                for (const k of kinds) {
                    diagnostics[k] = runStore.listWithDiagnostics(k, url.searchParams.get('workspace'));
                }
                const businessErrors = kinds.flatMap(k => diagnostics[k].errors);
                const allErrors = [...businessErrors, ...(plan.errors || [])];
                const seen = new Set();
                const dedupedErrors = [];
                for (const err of allErrors) {
                    const key = `${err.kind}:${err.id}:${err.code}:${err.path || ''}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        dedupedErrors.push(err);
                    }
                }
                sendJson(res, 200, {
                    plan,
                    diagnostics: {
                        errors: dedupedErrors,
                        summary: {
                            pending: plan.entries.length,
                            corrupted: dedupedErrors.length,
                            totalRecords: kinds.reduce((acc, k) => acc + diagnostics[k].records.length, 0)
                        }
                    }
                });
                return;
            }
            if (pathname === '/api/maintenance/migrate') {
                if (req.method !== 'POST') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
                if (isWorkflowBusy()) {
                    sendJson(res, 409, { error: 'WORKFLOW_BUSY' });
                    return;
                }
                const body = await readRequestJson(req);
                if (isWorkflowBusy()) {
                    sendJson(res, 409, { error: 'WORKFLOW_BUSY' });
                    return;
                }
                let lease = null;
                if (runStore?.guard) {
                    try {
                        lease = await runStore.guard.acquire({ kind: 'migration', id: crypto.randomUUID() });
                    } catch (err) {
                        sendJson(res, 409, { error: 'WORKFLOW_BUSY' });
                        return;
                    }
                }
                try {
                    const result = applyMigration(runStore, body);
                    sendJson(res, 200, { ok: true, result });
                } finally {
                    lease?.release?.();
                }
                return;
            }
            if (pathname === '/api/maintenance/overview') {
                if (req.method !== 'GET') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
                sendJson(res, 200, getStorageOverview(runStore));
                return;
            }
            if (pathname === '/api/maintenance/diagnostics') {
                if (req.method !== 'GET') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
                const pkg = buildDiagnosticPackage(runStore);
                if (url.searchParams.get('download') === 'true') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Disposition': `attachment; filename="diagnostics-${Date.now()}.json"`,
                        'X-Content-Type-Options': 'nosniff'
                    });
                    res.end(JSON.stringify(pkg, null, 2));
                    return;
                }
                sendJson(res, 200, pkg);
                return;
            }
        } catch (error) {
            sendJson(res, /CONFLICT|BUSY|CORRUPTED/.test(error.message) ? 409 : 400, { error: error.message });
            return;
        }
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
            isRunning: isWorkflowBusy(),
            isCheckingAgents: agentHealth.active !== null,
            activeAuditId: auditWorkflow.active?.id || null,
            activeVerificationId: auditWorkflow.active?.verificationId || null,
            activeRunId: workflow.active?.id || null,
            activePlanningId: planningWorkflow.active?.id || null,
            isDiscussing: isDiscussing || planningWorkflow.active !== null,
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
                    recommendedCommand,
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

    // 5. REST API: /api/discuss (Multi-Round Collaborative Requirement Alignment)
    if (pathname === '/api/discuss' && req.method === 'POST') {
        if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: activeProcess ? 'An execution loop is currently in progress.' : 'Another discussion is currently in progress.' }));
            return;
        }

        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const params = JSON.parse(body);
                if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
                if (!params.vaguePrompt) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'vaguePrompt is required.' }));
                    return;
                }

                if (!params.workspaceRoot || !fs.statSync(params.workspaceRoot).isDirectory()) throw new Error('WORKSPACE_NOT_FOUND');

                isDiscussing = true;
                const token = ++discussionGeneration;
                activeDiscussionAbortController = new AbortController();
                const signal = activeDiscussionAbortController.signal;

                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Discussion initiated in background.', discussionToken: token }));

                // Run background discussion asynchronously with generation token and abort signal
                runBackgroundDiscussion(params, token, signal);
            } catch (err) {
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
            const latest = runStore.list('plans', queryWs).find(plan=>!plan.planningId);
            if (latest) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, discussion: { ...latest, planId: latest.id, planVersion: latest.version } }));
                return;
            }
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
        if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: isDiscussing ? 'A discussion is currently in progress.' : 'A loop is already running. Stop it before starting a new one.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                if (activeProcess || workflow.active || auditWorkflow.active || agentHealth.active || planningWorkflow.active || isDiscussing) { sendJson(res, 409, { error: 'WORKFLOW_BUSY' }); return; }
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

                const sessionInfo = resolveStudioSessionIds({
                    devSessionId: config.devSessionId,
                    reviewSessionId: config.reviewSessionId || config.copilotSessionId,
                    workspaceRoot: config.workspaceRoot,
                    feature: config.feature,
                    mailboxPath: config.mailboxPath,
                    forceNew: !!config.forceNewSessions
                });

                if (sessionInfo.devSessionId) psArgs.push('-DevSessionId', sessionInfo.devSessionId);
                if (sessionInfo.reviewSessionId) psArgs.push('-ReviewSessionId', sessionInfo.reviewSessionId);
                if (config.forceNewSessions) psArgs.push('-ForceNewSessions');
                else psArgs.push('-AutoBindSession');

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
        let stoppedSomething = !!workflow.active || !!auditWorkflow.active || !!agentHealth.active || !!planningWorkflow.active;
        await agentHealth.stop();
        await planningWorkflow.stop();
        try { await auditWorkflow.stop(); } catch (error) { appendLog(error.message, 'system'); }
        await workflow.stop();

        if (activeProcess) {
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
            broadcast('state_change', { isRunning: false, stoppedByUser: true });
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
    getMailbox
};
