const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const TEST_PORT = 3788;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function httpRequest(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {}
        };

        let body = null;
        if (data) {
            body = JSON.stringify(data);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request(options, (res) => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(resBody);
                } catch {
                    parsed = resBody;
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForServer(retries = 30, delayMs = 200) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await httpRequest('GET', '/api/models');
            if (res.status === 200) return true;
        } catch {}
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(`Server failed to start on port ${TEST_PORT} within timeout.`);
}

async function runServerTests() {
    console.log(`🧪 Starting Dual-Agent Studio Server Integration Tests on port ${TEST_PORT}...`);

    const serverProcess = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(TEST_PORT) },
        stdio: 'inherit'
    });

    try {
        await waitForServer();
        console.log('✅ Server is listening and healthy.');

        // 1. Test /api/models
        const modelsRes = await httpRequest('GET', '/api/models');
        assert.strictEqual(modelsRes.status, 200, 'GET /api/models should return 200');
        assert(Array.isArray(modelsRes.body.series), 'modelsConfig should contain series array');
        console.log(`✅ GET /api/models verified (${modelsRes.body.series.length} series found).`);

        // 2. Test /api/projects
        const projectsRes = await httpRequest('GET', '/api/projects');
        assert.strictEqual(projectsRes.status, 200, 'GET /api/projects should return 200');
        assert(Array.isArray(projectsRes.body), 'projects should be an array');
        console.log(`✅ GET /api/projects verified.`);

        // 3. Test /api/detect-workspace (Dual fields: verifyCommand & recommendedCommand)
        const detectRes = await httpRequest('POST', '/api/detect-workspace', {
            workspaceRoot: path.join(__dirname, '..')
        });
        assert.strictEqual(detectRes.status, 200, 'POST /api/detect-workspace should return 200');
        assert.strictEqual(detectRes.body.success, true);
        assert(typeof detectRes.body.verifyCommand === 'string', 'verifyCommand must be present in response');
        assert(typeof detectRes.body.recommendedCommand === 'string', 'recommendedCommand must be present in response');
        assert.strictEqual(detectRes.body.verifyCommand, detectRes.body.recommendedCommand, 'verifyCommand and recommendedCommand must match');
        console.log(`✅ POST /api/detect-workspace dual-field contract verified (command: ${detectRes.body.verifyCommand}).`);

        // 4. Test /api/discuss - Validation & 202 Async Response
        const invalidDiscRes = await httpRequest('POST', '/api/discuss', {});
        assert.strictEqual(invalidDiscRes.status, 400, 'Missing vaguePrompt should return 400');
        console.log('✅ POST /api/discuss validation verified (400 on empty prompt).');

        const validDiscRes = await httpRequest('POST', '/api/discuss', {
            workspaceRoot: path.join(__dirname, '..'),
            vaguePrompt: 'Test autonomous requirement alignment',
            maxDiscussionRounds: 1,
            devProvider: 'mock',
            reviewProvider: 'mock'
        });
        assert.strictEqual(validDiscRes.status, 202, 'Valid discussion request must return 202 Accepted immediately');
        assert.strictEqual(validDiscRes.body.success, true);
        console.log('✅ POST /api/discuss 202 Accepted async initiation verified.');

        // 5. Test 409 Conflict guard while discussing
        const conflictDiscRes = await httpRequest('POST', '/api/discuss', {
            workspaceRoot: path.join(__dirname, '..'),
            vaguePrompt: 'Second concurrent discussion attempt'
        });
        assert.strictEqual(conflictDiscRes.status, 409, 'Concurrent /api/discuss must return 409 Conflict');

        const conflictStartRes = await httpRequest('POST', '/api/start', {
            workspaceRoot: path.join(__dirname, '..'),
            taskPrompt: 'Concurrent start during discussion'
        });
        assert.strictEqual(conflictStartRes.status, 409, 'Concurrent /api/start during discussion must return 409 Conflict');
        console.log('✅ 409 Conflict guard verified during active discussion.');

        // 6. Test /api/stop aborting discussion
        const stopDiscRes = await httpRequest('POST', '/api/stop');
        assert.strictEqual(stopDiscRes.status, 200, 'POST /api/stop should return 200');
        assert.strictEqual(stopDiscRes.body.success, true);

        // Small pause to allow abort cleanup
        await new Promise(r => setTimeout(r, 200));

        const statusRes = await httpRequest('GET', '/api/status');
        assert.strictEqual(statusRes.body.isDiscussing, false, 'isDiscussing state must be reset to false after /api/stop');
        console.log('✅ POST /api/stop discussion abort and state reset verified.');

        // 7. Test /api/start validation
        const invalidStartRes = await httpRequest('POST', '/api/start', {});
        assert.strictEqual(invalidStartRes.status, 400, 'Missing mandatory fields must return 400');
        console.log('✅ POST /api/start validation verified.');

        console.log('🎉 All Server Integration Tests Passed Successfully!\n');
    } finally {
        if (serverProcess) {
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/F', '/T', '/PID', String(serverProcess.pid)], { shell: true });
                } else {
                    serverProcess.kill('SIGKILL');
                }
            } catch {}
        }
    }
}

runServerTests().catch(err => {
    console.error('❌ Server Integration Tests Failed:', err);
    process.exit(1);
});
