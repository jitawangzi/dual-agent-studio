const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const PROJECTS_FILE = path.join(STUDIO_ROOT, 'projects.json');
const MODELS_FILE = path.join(STUDIO_ROOT, 'models-config.json');

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

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

function getDiscussionRecordCandidates(workspaceRoot) {
    return [
        path.join(workspaceRoot, '.ai-workspace', 'requirement-discussion.json'),
        path.join(workspaceRoot, 'requirement-discussion.json')
    ];
}

function readDiscussionRecord(workspaceRoot) {
    if (!workspaceRoot) return null;
    for (const p of getDiscussionRecordCandidates(workspaceRoot)) {
        try {
            if (fs.existsSync(p)) {
                return JSON.parse(fs.readFileSync(p, 'utf-8'));
            }
        } catch {}
    }
    return null;
}

function writeDiscussionRecord(workspaceRoot, record) {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return null;
    const isolatedDir = path.join(workspaceRoot, '.ai-workspace');
    fs.mkdirSync(isolatedDir, { recursive: true });
    const isolatedPath = path.join(isolatedDir, 'requirement-discussion.json');
    fs.writeFileSync(isolatedPath, JSON.stringify(record, null, 2), 'utf-8');
    return isolatedPath;
}

function getStudioProxyUrl(env = process.env) {
    for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'DUAL_AGENT_PROXY', 'ALL_PROXY', 'all_proxy']) {
        if (env[k] && String(env[k]).trim()) return String(env[k]).trim();
    }
    return null;
}

function applyStudioProxyToEnv(env) {
    const proxy = getStudioProxyUrl(env);
    if (!proxy) return env;
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'grpc_proxy', 'GRPC_PROXY']) {
        if (!env[k]) env[k] = proxy;
    }
    return env;
}

function writeTaskPromptFile(text) {
    const p = path.join(os.tmpdir(), `dual_agent_prompt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(p, text || '', 'utf8');
    return p;
}

function cleanupTaskPromptFile(filePath) {
    if (!filePath) return;
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

const DIFF_BLACKLIST = [
    /\.lock$/i, /package-lock\.json$/i, /pnpm-lock\.yaml$/i,
    /\.jar$/i, /\.exe$/i, /\.dll$/i, /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.gif$/i, /\.ico$/i,
    /node_modules[\\/]/i, /\.git[\\/]/i, /build[\\/]/i, /target[\\/]/i, /dist[\\/]/i,
    /review-mailbox\.json$/i, /projects\.json$/i, /\.log$/i, /\.tmp$/i
];

function isDiffBlacklisted(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    return DIFF_BLACKLIST.some(p => p.test(normalized));
}

function runGit(workspaceRoot, args, maxBuffer = 1024 * 1024) {
    return spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        maxBuffer,
        windowsHide: true
    });
}

function getSafeWorkspaceDiff(workspaceRoot, maxTotalChars = 64000, maxFileBytes = 262144) {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
        return { diff: '', status: '', error: 'Workspace path does not exist.' };
    }

    const inside = runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
    if (inside.status !== 0) {
        return { diff: '[Workspace is not a git repository or has no version control initialized. Diff inspection skipped.]', status: '', error: null };
    }

    const chunks = [];
    let total = 0;
    const pushChunk = (text) => {
        if (!text) return;
        if (total >= maxTotalChars) return;
        const remaining = maxTotalChars - total;
        const slice = text.length > remaining ? text.slice(0, remaining) : text;
        chunks.push(slice);
        total += slice.length;
    };

    const headOk = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']).status === 0;
    if (headOk) {
        const nameOut = runGit(workspaceRoot, ['diff', '--name-only', 'HEAD']);
        if (nameOut.status === 0 && nameOut.stdout) {
            for (const relFile of nameOut.stdout.split(/\r?\n/)) {
                if (total >= maxTotalChars) break;
                const trimmed = relFile.trim();
                if (!trimmed || isDiffBlacklisted(trimmed)) continue;
                const fullPath = path.join(workspaceRoot, trimmed);
                try {
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                        const size = fs.statSync(fullPath).size;
                        if (size > maxFileBytes) {
                            pushChunk(`\n=== Tracked File: ${trimmed} (Size: ${size} bytes) - Exceeded 256KB limit, diff skipped ===\n`);
                            continue;
                        }
                    } else {
                        const sizeRes = runGit(workspaceRoot, ['cat-file', '-s', `HEAD:${trimmed.replace(/\\/g, '/')}`]);
                        const headSize = parseInt(String(sizeRes.stdout || '').trim(), 10);
                        if (sizeRes.status === 0 && Number.isFinite(headSize) && headSize > maxFileBytes) {
                            pushChunk(`\n=== Tracked File: ${trimmed} (Deleted from HEAD, Size: ${headSize} bytes) - Exceeded 256KB limit, diff skipped ===\n`);
                            continue;
                        }
                    }
                } catch {}

                const fileDiff = runGit(workspaceRoot, ['diff', 'HEAD', '--', trimmed], maxFileBytes + 8192);
                const diffText = fileDiff.stdout || '';
                if (diffText.length > maxFileBytes) {
                    pushChunk(`\n=== Tracked File: ${trimmed} (Diff size: ${diffText.length} chars) - Exceeded 256KB limit, diff skipped ===\n`);
                } else {
                    pushChunk(diffText);
                }
            }
        }
    }

    const statusRes = runGit(workspaceRoot, ['status', '--porcelain', '-uall']);
    const statusText = statusRes.stdout || '';
    if (total < maxTotalChars && statusText) {
        for (const uLine of statusText.split(/\r?\n/)) {
            if (total >= maxTotalChars) break;
            const m = uLine.trim().match(/^\?\?\s+(.*)$/);
            if (!m) continue;
            const uPath = m[1].trim().replace(/^"|"$/g, '');
            if (isDiffBlacklisted(uPath)) continue;
            const fullUPath = path.join(workspaceRoot, uPath);
            try {
                if (!fs.existsSync(fullUPath) || !fs.statSync(fullUPath).isFile()) continue;
                const size = fs.statSync(fullUPath).size;
                if (size > maxFileBytes) {
                    pushChunk(`\n=== Untracked File: ${uPath} (Size: ${size} bytes) - Exceeded 256KB limit, skipped ===\n`);
                } else {
                    const content = fs.readFileSync(fullUPath, 'utf8');
                    pushChunk(`\n=== Untracked File: ${uPath} ===\n${content}\n`);
                }
            } catch {}
        }
    }

    let diff = chunks.join('');
    if (diff.length >= maxTotalChars) {
        diff += `\n\n[WARNING: Git diff truncated at ${maxTotalChars} characters to protect Reviewer context window. Remaining changes omitted.]`;
    }
    return { diff, status: statusText, error: null };
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

        // Check Root Discussion (.ai-workspace first, then legacy root file)
        const disc = readDiscussionRecord(workspaceRoot);
        if (disc) {
            const cand = role === 'dev' ? disc.devSessionId : disc.reviewSessionId;
            const sanitized = sanitizeSessionId(cand);
            if (sanitized) return { sessionId: sanitized, source: 'discussion' };
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

    // 1. Update or create isolated discussion record under .ai-workspace
    try {
        const existing = readDiscussionRecord(workspaceRoot) || {};
        existing.savedAt = existing.savedAt || new Date().toISOString();
        existing.devSessionId = devSessionId;
        existing.reviewSessionId = reviewSessionId;
        writeDiscussionRecord(workspaceRoot, existing);
    } catch (e) {
        console.error('Failed to persist to .ai-workspace/requirement-discussion.json:', e);
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

function detectDiscussionVerdict(text) {
    const src = String(text || '');
    const needsRefinement = /\[VERDICT:\s*NEEDS_REFINEMENT\]/i.test(src);
    const consensus = /\[VERDICT:\s*CONSENSUS_REACHED\]/i.test(src);
    if (needsRefinement) return { consensus: false, needsRefinement: true };
    if (consensus) return { consensus: true, needsRefinement: false };
    return { consensus: false, needsRefinement: false };
}

function shouldAutoResumeLoop(mailbox, config = {}) {
    if (!mailbox || typeof mailbox !== 'object') return false;
    const status = String(mailbox.status || '');
    if (status !== 'WAITING_DEV' && status !== 'WAITING_REVIEW') return false;
    const round = Number(mailbox.round || 0);
    const maxRounds = Number(config.maxRounds || mailbox.maxRounds || 4);
    if (!Number.isFinite(round) || round < 1) return false;
    if (!Number.isFinite(maxRounds) || round > maxRounds) return false;
    return true;
}

function buildOrchestratorArgs(config, sessionInfo, promptFile) {
    const orchestratorScript = path.join(STUDIO_ROOT, 'engine', 'orchestrator.ps1');
    const psArgs = [
        '-NoProfile',
        '-File', orchestratorScript,
        '-WorkspaceRoot', config.workspaceRoot,
        '-TaskPromptFile', promptFile
    ];

    if (config.feature) psArgs.push('-Feature', config.feature);
    if (config.devProvider) psArgs.push('-DevProvider', config.devProvider);
    if (config.reviewProvider) psArgs.push('-ReviewProvider', config.reviewProvider);
    if (config.devModel) psArgs.push('-DevModel', config.devModel);
    if (config.reviewModel) psArgs.push('-ReviewModel', config.reviewModel);
    if (config.devReasoningEffort) psArgs.push('-DevReasoningEffort', config.devReasoningEffort);
    if (config.reviewReasoningEffort) psArgs.push('-ReviewReasoningEffort', config.reviewReasoningEffort);

    if (sessionInfo.devSessionId) psArgs.push('-DevSessionId', sessionInfo.devSessionId);
    if (sessionInfo.reviewSessionId) psArgs.push('-ReviewSessionId', sessionInfo.reviewSessionId);
    if (config.forceNewSessions) psArgs.push('-ForceNewSessions');
    else psArgs.push('-AutoBindSession');

    if (config.verifyCommand) psArgs.push('-VerifyCommand', config.verifyCommand);
    if (config.maxRounds) psArgs.push('-MaxRounds', String(config.maxRounds));
    if (config.maxSelfHealAttempts) psArgs.push('-MaxSelfHealAttempts', String(config.maxSelfHealAttempts));
    if (config.autoCommit) psArgs.push('-AutoCommit');
    if (config.mailboxPath) psArgs.push('-MailboxPath', config.mailboxPath);
    return psArgs;
}

function psSingleQuote(value) {
    return String(value || '').replace(/'/g, "''");
}

function mapPiThinking(effort) {
    if (!effort) return null;
    const lower = String(effort).trim().toLowerCase();
    if (['none', 'off', 'disable', 'disabled', 'false', '0'].includes(lower)) return 'off';
    if (['minimal', 'min'].includes(lower)) return 'minimal';
    if (['low', 'fast', '2048', '4096'].includes(lower)) return 'low';
    if (['medium', 'med', '8192', '16384'].includes(lower)) return 'medium';
    if (['high', 'think', 'deepthink', '24576', '32768', 'xhigh', 'max', '64000', '65536'].includes(lower)) return 'high';
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(lower)) return lower;
    return 'high';
}

function mapCodexEffort(effort) {
    if (!effort) return null;
    const lower = String(effort).trim().toLowerCase();
    if (['none', 'off', 'disable', 'disabled', 'false'].includes(lower)) return null;
    if (['low', 'fast', 'minimal', 'min', '2048', '4096'].includes(lower)) return 'low';
    if (['medium', 'med', '8192', '16384'].includes(lower)) return 'medium';
    if (['xhigh', 'extra-high', 'max', '64000', '65536'].includes(lower)) return 'xhigh';
    if (['high', 'think', 'deepthink', '24576', '32768'].includes(lower)) return 'high';
    if (['low', 'medium', 'high', 'xhigh'].includes(lower)) return lower;
    return 'high';
}

function buildDiscussionAgentCommand({ provider, model, reasoningEffort, sessionId, safeTmp }) {
    const prov = String(provider || 'copilot').toLowerCase();
    const tmp = psSingleQuote(safeTmp);
    const pipePrompt = `Get-Content -Raw -LiteralPath '${tmp}'`;

    if (prov === 'claude' || prov === 'claude_code') {
        let claudeModel = '';
        if (model) {
            const m = String(model).toLowerCase();
            if (m.includes('sonnet')) claudeModel = ' --model sonnet';
            else if (m.includes('opus')) claudeModel = ' --model opus';
            else if (m.includes('haiku')) claudeModel = ' --model haiku';
            else claudeModel = ` --model '${psSingleQuote(model)}'`;
        }
        return `if (Test-Path "$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe") { ${pipePrompt} | & "$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" --print --dangerously-skip-permissions${claudeModel} } else { ${pipePrompt} | & claude --print --dangerously-skip-permissions${claudeModel} }`;
    }

    if (prov === 'antigravity' || prov === 'agy') {
        let agyArgs = '--dangerously-skip-permissions --print-timeout 10m';
        if (model) agyArgs += ` --model '${psSingleQuote(model)}'`;
        const agyEffort = (reasoningEffort && ['low', 'medium', 'high'].includes(String(reasoningEffort).toLowerCase()))
            ? String(reasoningEffort).toLowerCase()
            : 'high';
        agyArgs += ` --effort '${agyEffort}'`;
        return `if (Get-Command agy, agy.exe -ErrorAction SilentlyContinue) { $txt = ${pipePrompt}; & agy ${agyArgs} --print $txt } else { throw 'PROVIDER_UNAVAILABLE: Antigravity CLI (agy) is not found in PATH.' }`;
    }

    if (prov === 'aider') {
        return `if (Get-Command aider, aider.exe, aider.cmd -ErrorAction SilentlyContinue) { & aider --message-file '${tmp}' --no-auto-commits --yes-always } else { throw 'PROVIDER_UNAVAILABLE: Aider CLI is not found in PATH.' }`;
    }

    if (prov === 'cursor') {
        const modelArg = model ? ` --model '${psSingleQuote(model)}'` : '';
        return `$cursorAgent = @(Get-Command agent, agent.exe, agent.cmd, cursor-agent, cursor-agent.exe, cursor-agent.cmd -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^cursor(\\.|$)' } | Select-Object -First 1); if (-not $cursorAgent) { throw 'PROVIDER_UNAVAILABLE: Cursor Agent CLI (agent / cursor-agent) is not found in PATH.' }; ${pipePrompt} | & $cursorAgent.Source --print --trust --force --sandbox disabled${modelArg}`;
    }

    if (prov === 'codex') {
        const modelArg = model ? ` --model '${psSingleQuote(model)}'` : '';
        const effort = mapCodexEffort(reasoningEffort);
        const effortArg = effort ? ` -c model_reasoning_effort=${effort}` : '';
        return `if (-not (Get-Command codex, codex.exe, codex.cmd -ErrorAction SilentlyContinue)) { throw 'PROVIDER_UNAVAILABLE: OpenAI Codex CLI is not found in PATH.' }; ${pipePrompt} | & codex exec --skip-git-repo-check -a never -s workspace-write${modelArg}${effortArg} -`;
    }

    if (prov === 'pi') {
        const modelArg = model ? ` --model '${psSingleQuote(model)}'` : '';
        const thinking = mapPiThinking(reasoningEffort);
        const thinkArg = thinking ? ` --thinking ${thinking}` : '';
        return `if (-not (Get-Command pi, pi.exe, pi.cmd -ErrorAction SilentlyContinue)) { throw 'PROVIDER_UNAVAILABLE: Pi coding agent CLI is not found in PATH.' }; ${pipePrompt} | & pi -p${modelArg}${thinkArg}`;
    }

    let cmd = `${pipePrompt} | & copilot -s --allow-all`;
    if (model) cmd += ` --model '${psSingleQuote(model)}'`;
    const validSession = sanitizeSessionId(sessionId) || crypto.randomUUID();
    cmd += ` --session-id='${validSession}'`;
    const safeEffort = sanitizeCopilotEffort(reasoningEffort);
    if (safeEffort && safeEffort !== 'none') {
        cmd += ` --reasoning-effort '${safeEffort}'`;
    }
    return cmd;
}

function detectWorkspace(workspaceRoot) {
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
    return { success: true, workspaceRoot, verifyCommand: recommendedCommand, recommendedCommand, framework };
}

module.exports = {
    STUDIO_ROOT,
    PROJECTS_FILE,
    MODELS_FILE,
    CONTENT_SECURITY_POLICY,
    getProjects,
    saveProjects,
    getModelsConfig,
    saveModelsConfig,
    listDrivesAndDirs,
    getMailbox,
    getDiscussionRecordCandidates,
    readDiscussionRecord,
    writeDiscussionRecord,
    getStudioProxyUrl,
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
    mapPiThinking,
    mapCodexEffort
};
