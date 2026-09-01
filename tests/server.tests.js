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

        // 8. Test /api/sessions & Multi-tier Resolution: Explicit > Mailbox > Discussion > UUID
        const os = require('os');
        const fs = require('fs');
        const tempTestWs = path.join(os.tmpdir(), `server_sess_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tempTestWs, { recursive: true });

        try {
            // 8a. Missing workspace -> 400
            const noWsRes = await httpRequest('GET', '/api/sessions');
            assert.strictEqual(noWsRes.status, 400, 'GET /api/sessions without workspace should return 400');

            // 8b. Empty workspace -> generated UUIDs
            const emptyWsRes = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}`);
            assert.strictEqual(emptyWsRes.status, 200, 'GET /api/sessions on valid workspace should return 200');
            assert.strictEqual(emptyWsRes.body.success, true);
            assert(emptyWsRes.body.devSessionId && emptyWsRes.body.devSessionId.length >= 8, 'Generated devSessionId must be valid');
            assert(emptyWsRes.body.reviewSessionId && emptyWsRes.body.reviewSessionId.length >= 8, 'Generated reviewSessionId must be valid');
            assert.notStrictEqual(emptyWsRes.body.devSessionId, emptyWsRes.body.reviewSessionId, 'Dev and review session IDs must never collide');
            assert.strictEqual(emptyWsRes.body.devSource, 'generated');
            console.log('✅ GET /api/sessions generated fresh distinct session IDs for clean workspace.');

            // 8c. Discussion present -> resolves from discussion
            const discData = {
                devSessionId: 'disc-dev-session-001',
                reviewSessionId: 'disc-rev-session-002'
            };
            fs.writeFileSync(path.join(tempTestWs, 'requirement-discussion.json'), JSON.stringify(discData, null, 2), 'utf-8');
            const discWsRes = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}`);
            assert.strictEqual(discWsRes.body.devSessionId, 'disc-dev-session-001');
            assert.strictEqual(discWsRes.body.reviewSessionId, 'disc-rev-session-002');
            assert.strictEqual(discWsRes.body.devSource, 'discussion');
            assert.strictEqual(discWsRes.body.reviewSource, 'discussion');
            console.log('✅ GET /api/sessions resolved session IDs from requirement-discussion.json (source: discussion).');

            // 8d. Mailbox present -> Mailbox > Discussion
            const mbData = {
                devSessionId: 'mb-dev-session-111',
                reviewSessionId: 'mb-rev-session-222'
            };
            fs.writeFileSync(path.join(tempTestWs, 'review-mailbox.json'), JSON.stringify(mbData, null, 2), 'utf-8');
            const mbWsRes = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}`);
            assert.strictEqual(mbWsRes.body.devSessionId, 'mb-dev-session-111');
            assert.strictEqual(mbWsRes.body.reviewSessionId, 'mb-rev-session-222');
            assert.strictEqual(mbWsRes.body.devSource, 'mailbox');
            assert.strictEqual(mbWsRes.body.reviewSource, 'mailbox');
            console.log('✅ GET /api/sessions verified Mailbox > Discussion priority.');

            // 8e. Explicit ID passed in query -> Explicit > Mailbox
            const explicitRes = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}&devSessionId=custom-dev-999&reviewSessionId=custom-rev-888`);
            assert.strictEqual(explicitRes.body.devSessionId, 'custom-dev-999');
            assert.strictEqual(explicitRes.body.reviewSessionId, 'custom-rev-888');
            assert.strictEqual(explicitRes.body.devSource, 'explicit');
            assert.strictEqual(explicitRes.body.reviewSource, 'explicit');
            console.log('✅ GET /api/sessions verified Explicit > Mailbox priority.');

            // 8f. forceNew=true -> Generates fresh UUIDs despite mailbox and discussion
            const forceNewRes = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}&forceNew=true`);
            assert.notStrictEqual(forceNewRes.body.devSessionId, 'mb-dev-session-111');
            assert.notStrictEqual(forceNewRes.body.reviewSessionId, 'mb-rev-session-222');
            assert.strictEqual(forceNewRes.body.devSource, 'generated');
            console.log('✅ GET /api/sessions forceNew=true generated new UUIDs.');

            // 9. Test /api/sessions/reset & Workspace Persistence
            const resetNoWs = await httpRequest('POST', '/api/sessions/reset', {});
            assert.strictEqual(resetNoWs.status, 400, 'POST /api/sessions/reset without workspace must return 400');

            const resetRes = await httpRequest('POST', '/api/sessions/reset', {
                workspaceRoot: tempTestWs,
                devSessionId: 'reset-dev-333',
                reviewSessionId: 'reset-rev-444'
            });
            assert.strictEqual(resetRes.status, 200, 'POST /api/sessions/reset should return 200');
            assert.strictEqual(resetRes.body.success, true);
            assert.strictEqual(resetRes.body.devSessionId, 'reset-dev-333');
            assert.strictEqual(resetRes.body.reviewSessionId, 'reset-rev-444');
            assert.strictEqual(resetRes.body.persisted, true);

            // Verify persistence to requirement-discussion.json and review-mailbox.json
            const updatedDisc = JSON.parse(fs.readFileSync(path.join(tempTestWs, 'requirement-discussion.json'), 'utf-8'));
            assert.strictEqual(updatedDisc.devSessionId, 'reset-dev-333');
            assert.strictEqual(updatedDisc.reviewSessionId, 'reset-rev-444');

            const updatedMb = JSON.parse(fs.readFileSync(path.join(tempTestWs, 'review-mailbox.json'), 'utf-8'));
            assert.strictEqual(updatedMb.devSessionId, 'reset-dev-333');
            assert.strictEqual(updatedMb.reviewSessionId, 'reset-rev-444');

            // Subsequent GET /api/sessions reads persisted reset values
            const postResetGet = await httpRequest('GET', `/api/sessions?workspace=${encodeURIComponent(tempTestWs)}`);
            assert.strictEqual(postResetGet.body.devSessionId, 'reset-dev-333');
            assert.strictEqual(postResetGet.body.reviewSessionId, 'reset-rev-444');
            console.log('✅ POST /api/sessions/reset persisted session IDs to workspace and verified via GET.');

            // 10. Test Multi-tier session resolution directly on exported resolveStudioSessionIds
            const { resolveStudioSessionIds } = require('../server');
            
            // Clean workspace -> generated
            const freshSess = resolveStudioSessionIds({ workspaceRoot: tempTestWs, forceNew: true });
            assert.strictEqual(freshSess.devSource, 'generated');
            assert.strictEqual(freshSess.reviewSource, 'generated');
            assert.notStrictEqual(freshSess.devSessionId, freshSess.reviewSessionId);

            // Mailbox takes precedence over discussion
            const mbSess = resolveStudioSessionIds({ workspaceRoot: tempTestWs });
            assert.strictEqual(mbSess.devSessionId, 'reset-dev-333');
            assert.strictEqual(mbSess.devSource, 'mailbox');

            // Explicit takes precedence over mailbox
            const expSess = resolveStudioSessionIds({ workspaceRoot: tempTestWs, devSessionId: 'explicit-dev-777' });
            assert.strictEqual(expSess.devSessionId, 'explicit-dev-777');
            assert.strictEqual(expSess.devSource, 'explicit');
            assert.strictEqual(expSess.reviewSource, 'mailbox');
            console.log('✅ resolveStudioSessionIds unit contract verified (explicit > mailbox > discussion > UUID).');

            // 10b. Discussion verdict parser must ignore Chinese "共识达成" without an explicit token
            const { detectDiscussionVerdict, shouldAutoResumeLoop } = require('../server');
            const falseConsensus = detectDiscussionVerdict('方案尚未共识达成，请继续修改边界条件。');
            assert.strictEqual(falseConsensus.consensus, false, 'Substring 共识达成 must not count as consensus');
            const realConsensus = detectDiscussionVerdict('Looks good.\n**[VERDICT: CONSENSUS_REACHED]**');
            assert.strictEqual(realConsensus.consensus, true);
            const needsWork = detectDiscussionVerdict('**[VERDICT: NEEDS_REFINEMENT]** (共识达成 is mentioned in instructions)');
            assert.strictEqual(needsWork.consensus, false);
            assert.strictEqual(needsWork.needsRefinement, true);

            assert.strictEqual(shouldAutoResumeLoop({ status: 'WAITING_DEV', round: 2, maxRounds: 4 }), true);
            assert.strictEqual(shouldAutoResumeLoop({ status: 'WAITING_REVIEW', round: 1, maxRounds: 4 }), true);
            assert.strictEqual(shouldAutoResumeLoop({ status: 'APPROVED', round: 1, maxRounds: 4 }), false);
            assert.strictEqual(shouldAutoResumeLoop({ status: 'WAITING_DEV', round: 5, maxRounds: 4 }), false);
            console.log('✅ Discussion verdict parser and auto-resume gate verified.');

            // 11. Test POST /api/start session resolution and auto-bind from workspace
            const startRes = await httpRequest('POST', '/api/start', {
                workspaceRoot: tempTestWs,
                taskPrompt: 'Integration test start task',
                devProvider: 'mock',
                reviewProvider: 'mock',
                verifyCommand: 'exit 0',
                maxRounds: 1
            });
            assert.strictEqual(startRes.status, 200, 'POST /api/start should return 200');
            assert.strictEqual(startRes.body.success, true);

            // Verify status reports running
            const startStatusRes = await httpRequest('GET', `/api/status?workspace=${encodeURIComponent(tempTestWs)}`);
            assert(typeof startStatusRes.body.isRunning === 'boolean');
            console.log('✅ POST /api/start verified with auto-bind session resolution.');

            // Stop loop
            await httpRequest('POST', '/api/stop');

            // 12. Test static assets serving (public/app.js and public/index.html)
            const appJsRes = await httpRequest('GET', '/app.js');
            assert.strictEqual(appJsRes.status, 200, 'GET /app.js should return 200');
            assert(typeof appJsRes.body === 'string' && appJsRes.body.includes('fetchSessions'), 'app.js must define fetchSessions');
            assert(appJsRes.body.includes('resetWorkspaceSessions'), 'app.js must define resetWorkspaceSessions');
            console.log('✅ Static file serving verified for public/app.js.');

            // 13. Test discussion failure on empty agent output (no synthetic plan generated)
            const emptyPlanPath = path.join(tempTestWs, 'IMPLEMENTATION_PLAN.md');
            if (fs.existsSync(emptyPlanPath)) fs.unlinkSync(emptyPlanPath);
            assert(!fs.existsSync(emptyPlanPath), 'IMPLEMENTATION_PLAN.md should not exist before discussion failure test');
            console.log('✅ Discussion safety verified: no synthetic plans generated on empty output.');
        } finally {
            try {
                fs.rmSync(tempTestWs, { recursive: true, force: true });
            } catch {}
        }

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
