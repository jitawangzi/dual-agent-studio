'use strict';
/**
 * 2.11 Task 3: Execution Budget HTTP API tests.
 * @author shuyongqiang
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createFixture } = require('./helpers/studio-fixture');
const { RunStore } = require('../engine/run-store');
const { ensureBudget } = require('../engine/execution-budget');

test('Execution Budget API endpoints: /api/executions/:kind/:id/budget and resume-budget', async (t) => {
    const f = createFixture(t);
    process.env.PORT = '3789';
    process.env.STUDIO_DATA_DIR = f.store.root;

    // Load server with isolated STUDIO_DATA_DIR
    const serverModule = require('../server.js');
    await new Promise(resolve => serverModule.server.listen(3789, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => serverModule.server.close(resolve)));

    const post = (urlPath, body) => new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3789,
            path: urlPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = {};
                try { json = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });

    // 1. Invalid kind rejected
    const res1 = await post('/api/executions/unknown/123/budget', {});
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error, 'INVALID_EXECUTION_KIND');

    // 2. Non-existent record returns 404
    const res2 = await post('/api/executions/audit/11111111-1111-4111-8111-111111111111/budget', {
        workspaceRoot: f.workspace,
        version: 1,
        budget: { maxAttempts: 5 },
        reason: 'Adjusting budget'
    });
    assert.equal(res2.status, 404);

    // 3. Create stopped audit with budget
    const auditRecord = {
        id: '22222222-2222-4222-8222-222222222222',
        schemaVersion: '1.0',
        version: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'STOPPED',
        pauseReason: 'BUDGET_EXHAUSTED',
        allowedActions: ['INCREASE_BUDGET', 'MANUAL_RESUME'],
        reviewers: [{ id: 'rev1', status: 'STOPPED', pauseReason: 'BUDGET_EXHAUSTED', provider: 'mock' }],
        findings: []
    };
    ensureBudget(auditRecord, { maxAttempts: 1 });
    f.store.save('audits', auditRecord);

    // 4. Workspace mismatch rejected with 403
    const res3 = await post(`/api/executions/audit/${auditRecord.id}/budget`, {
        workspaceRoot: 'C:\\other-workspace',
        version: 1,
        budget: { maxAttempts: 5 },
        reason: 'Mismatch test'
    });
    assert.equal(res3.status, 403);
    assert.equal(res3.body.error, 'WORKSPACE_MISMATCH');

    // 5. Version conflict rejected with 409
    const res4 = await post(`/api/executions/audit/${auditRecord.id}/budget`, {
        workspaceRoot: f.workspace,
        version: 999,
        budget: { maxAttempts: 5 },
        reason: 'Version conflict test'
    });
    assert.equal(res4.status, 409);
    assert.equal(res4.body.error, 'VERSION_CONFLICT');

    // 6. Invalid reason rejected with 400
    const res5 = await post(`/api/executions/audit/${auditRecord.id}/budget`, {
        workspaceRoot: f.workspace,
        version: 1,
        budget: { maxAttempts: 5 },
        reason: ''
    });
    assert.equal(res5.status, 400);

    // 7. Valid budget adjustment succeeds (200)
    const res6 = await post(`/api/executions/audit/${auditRecord.id}/budget`, {
        workspaceRoot: f.workspace,
        version: 1,
        budget: { maxAttempts: 5, maxActiveSeconds: 600 },
        reason: 'User increased quota to allow completion'
    });
    assert.equal(res6.status, 200);
    assert.equal(res6.body.ok, true);
    assert.equal(res6.body.budget.limits.maxAttempts, 5);
    assert.equal(res6.body.version, 2);

    // 8. Health probe budget adjustment without workspaceRoot requirement
    const healthRecord = {
        id: '33333333-3333-4333-8333-333333333333',
        schemaVersion: '1.0',
        version: 1,
        status: 'COMPLETED',
        mode: 'probe'
    };
    ensureBudget(healthRecord, { maxAttempts: 2 });
    f.store.save('health', healthRecord);

    const resHealth = await post(`/api/executions/health/${healthRecord.id}/budget`, {
        version: 1,
        budget: { maxAttempts: 10 },
        reason: 'Increase health quota'
    });
    assert.equal(resHealth.status, 200);
    assert.equal(resHealth.body.ok, true);
    assert.equal(resHealth.body.budget.limits.maxAttempts, 10);

    // 9. resume-budget: rejected if execution not paused by budget
    const activeAudit = {
        id: '44444444-4444-4444-8444-444444444444',
        schemaVersion: '1.0',
        version: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'RUNNING',
        reviewers: [],
        findings: []
    };
    ensureBudget(activeAudit, { maxAttempts: 5 });
    f.store.save('audits', activeAudit);
    const resResumeNotPaused = await post(`/api/executions/audit/${activeAudit.id}/resume-budget`, {
        workspaceRoot: f.workspace,
        version: 1
    });
    assert.equal(resResumeNotPaused.status, 400);
    assert.equal(resResumeNotPaused.body.error, 'EXECUTION_NOT_PAUSED_BY_BUDGET');

    // 10. resume-budget: rejected if budget is still exhausted
    const exhaustedAudit = {
        id: '55555555-5555-4555-8555-555555555555',
        schemaVersion: '1.0',
        version: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'STOPPED',
        pauseReason: 'BUDGET_EXHAUSTED',
        reviewers: [],
        findings: []
    };
    ensureBudget(exhaustedAudit, { maxAttempts: 2 });
    exhaustedAudit.budget.reservations = [
        { id: 'res-1', status: 'SETTLED' },
        { id: 'res-2', status: 'SETTLED' }
    ];
    f.store.save('audits', exhaustedAudit);
    const resStillExhausted = await post(`/api/executions/audit/${exhaustedAudit.id}/resume-budget`, {
        workspaceRoot: f.workspace,
        version: 1
    });
    assert.equal(resStillExhausted.status, 400);
    assert.match(resStillExhausted.body.error, /BUDGET_STILL_EXHAUSTED/);

    // 11. resume-budget: rejected with 409 if sourceSnapshot changed
    const changedAudit = {
        id: '66666666-6666-4666-8666-666666666666',
        schemaVersion: '1.0',
        version: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        snapshot: 'old-fake-snapshot-hash-12345',
        status: 'STOPPED',
        pauseReason: 'BUDGET_EXHAUSTED',
        reviewers: [],
        findings: []
    };
    ensureBudget(changedAudit, { maxAttempts: 10 });
    f.store.save('audits', changedAudit);
    const resSourceChanged = await post(`/api/executions/audit/${changedAudit.id}/resume-budget`, {
        workspaceRoot: f.workspace,
        version: 1
    });
    assert.equal(resSourceChanged.status, 409);
    assert.equal(resSourceChanged.body.error, 'AUDIT_SOURCE_CHANGED');

    // 12. resume-budget on health: clears pauseReason and increments version
    const pausedHealth = {
        id: '77777777-7777-4777-8777-777777777777',
        schemaVersion: '1.0',
        version: 1,
        status: 'STOPPED',
        pauseReason: 'BUDGET_EXHAUSTED',
        allowedActions: ['INCREASE_BUDGET'],
        mode: 'probe'
    };
    ensureBudget(pausedHealth, { maxAttempts: 10 });
    f.store.save('health', pausedHealth);
    const resResumeHealth = await post(`/api/executions/health/${pausedHealth.id}/resume-budget`, {
        version: 1
    });
    assert.equal(resResumeHealth.status, 200);
    assert.equal(resResumeHealth.body.ok, true);
    const reloadedHealth = f.store.read('health', pausedHealth.id);
    assert.equal(reloadedHealth.pauseReason, undefined);
    assert.equal(reloadedHealth.version, 2);

    // 13. POST /api/estimate
    const resEstInvalid = await post('/api/estimate', { kind: 'bad-kind' });
    assert.equal(resEstInvalid.status, 400);
    assert.equal(resEstInvalid.body.error, 'INVALID_EXECUTION_KIND');

    const resEstRun = await post('/api/estimate', { kind: 'run', config: { maxRounds: 3, maxSelfHealAttempts: 2 } });
    assert.equal(resEstRun.status, 200);
    assert.equal(resEstRun.body.ok, true);
    assert.equal(resEstRun.body.estimate.minimumAttempts, 2);
    assert.equal(resEstRun.body.estimate.maximumAttempts, 3 * (1 + 2 + 1));
    assert(Array.isArray(resEstRun.body.estimate.assumptions));
});

