const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

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

    // CORS Headers for API
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

    // 3. REST API: /api/start
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
                appendLog(`🚀 Starting Dual-Agent Autonomous Loop for: ${config.workspaceRoot}`, 'system');

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
                    // Refresh mailbox state on output
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
                    appendLog(`⏹️ Dual-Agent Loop process exited with code ${code}`, code === 0 ? 'success' : 'error');
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

    // 4. REST API: /api/stop
    if (pathname === '/api/stop' && req.method === 'POST') {
        if (activeProcess) {
            appendLog('⚠️ User requested process cancellation...', 'system');
            try {
                // Kill process tree
                spawn('taskkill', ['/pid', activeProcess.pid, '/f', '/t']);
            } catch {
                activeProcess.kill('SIGTERM');
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

    // 5. REST API: /api/diff
    if (pathname === '/api/diff' && req.method === 'GET') {
        const ws = url.searchParams.get('workspace') || (activeConfig ? activeConfig.workspaceRoot : null);
        if (!ws || !fs.existsSync(ws)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Valid workspace path is required.' }));
            return;
        }

        const gitProc = spawn('git', ['diff', 'HEAD'], { cwd: ws });
        let diffText = '';
        gitProc.stdout.on('data', d => diffText += d.toString('utf-8'));
        gitProc.on('close', () => {
            // Also get git status
            const statProc = spawn('git', ['status', '--porcelain', '-uall'], { cwd: ws });
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

    // 6. REST API: /api/projects
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

    // 7. REST API: /api/logs
    if (pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
        return;
    }

    // 8. Static File Serving (public/)
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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