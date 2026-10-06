'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('HTTP workflow: discuss, edit and approve a version, enforce approval, audit and persist evidence', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-api-v2-'));
    const workspace = path.join(root, "project with spaces ' quote");
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'app.js'), 'const valid = true;');
    process.env.STUDIO_DATA_DIR = path.join(root, 'records');
    const { server } = require('../server');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (endpoint, body) => {
        const response = await fetch(base + endpoint, body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { code: response.status, data: await response.json() };
    };
    t.after(async () => {
        await request('/api/stop', {});
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const poll = async check => {
        for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
        throw new Error('Timed out waiting for workflow: ' + JSON.stringify((await request('/api/logs')).data));
    };
    const options = { workspaceRoot: workspace, mode: 'audit', taskPrompt: 'Audit existing source',
        devProvider: 'mock', reviewProvider: 'mock', verifyCommand: 'node --check app.js', maxRounds: 2, cleanRoundsRequired: 2 };
    assert.equal((await request('/api/runs', { ...options, verifyCommand: 'exit 0' })).code, 400);
    const discussion = await request('/api/discuss', { workspaceRoot: workspace, vaguePrompt: 'Improve reliability',
        devProvider: 'mock', reviewProvider: 'mock', maxDiscussionRounds: 1 });
    assert.equal(discussion.code, 202);
    const plan = await poll(async () => {
        const result = await request('/api/discuss?workspace=' + encodeURIComponent(workspace));
        return result.data.discussion?.planId ? result.data.discussion : null;
    });
    await poll(async () => !(await request('/api/status')).data.isDiscussing);
    assert.equal(fs.existsSync(path.join(workspace, 'IMPLEMENTATION_PLAN.md')), false, 'Discussion must not overwrite target repository files');
    const unapproved = await request('/api/runs', { ...options, mode: 'plan', planId: plan.id });
    assert.equal(unapproved.code, 409);
    const approved = await request(`/api/plans/${plan.id}/approve`, { workspaceRoot: workspace, version: 1,
        text: 'Human approved plan: keep app.js valid, no architecture changes.' });
    assert.equal(approved.code, 200); assert.equal(approved.data.version, 2);
    assert.equal((await request(`/api/plans/${plan.id}/approve`, { workspaceRoot: workspace, version: 1, text: 'stale' })).code, 409);
    assert.equal((await request('/api/runs', { ...options, mode: 'plan', planId: plan.id,
        approvalId: approved.data.approval.id, taskPrompt: 'unapproved changes' })).code, 409);
    const started = await request('/api/runs', { ...options, mode: 'plan', planId: plan.id,
        approvalId: approved.data.approval.id, taskPrompt: approved.data.finalPlan });
    assert.equal(started.code, 202);
    assert.equal((await request('/api/runs', options)).code, 409);
    const completed = await poll(async () => {
        const { data } = await request('/api/runs/' + started.data.runId);
        return data.status !== 'RUNNING' ? data : null;
    });
    assert.equal(completed.status, 'APPROVED', completed.error);
    assert.equal(completed.approval.version, 2); assert.equal(completed.cleanRounds, 2);
    const artifacts = await request('/api/runs/' + completed.id + '/artifacts');
    assert(artifacts.data.some(name => name.endsWith('.response.txt')));
    assert(artifacts.data.includes('events.jsonl'));
    const reviewOnly = await request('/api/runs', options); assert.equal(reviewOnly.code, 202);
    const audit = await poll(async () => {
        const { data } = await request('/api/runs/' + reviewOnly.data.runId); return data.status !== 'RUNNING' ? data : null;
    });
    assert.equal(audit.status, 'APPROVED', audit.error);
    const auditArtifacts = (await request('/api/runs/' + audit.id + '/artifacts')).data;
    assert(!auditArtifacts.some(name => name.includes('-dev-')), 'Clean initial audit must never invoke developer');
    assert.equal((await request('/api/runs?workspace=' + encodeURIComponent(workspace))).data.length, 2);
});
