'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closureView } = require('../engine/audit-closure');
const { RunStore } = require('../engine/run-store');
const { buildManifest } = require('../engine/source-manifest');

test('Targeted review API: preview, validation gates, mode=TARGETED, and closure isolation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-targeted-api-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'engine'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'public'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'engine', 'core.js'), 'function core() { return 1; }\n');
    fs.writeFileSync(path.join(workspace, 'public', 'index.js'), 'console.log("ui");\n');

    process.env.STUDIO_DATA_DIR = path.join(root, 'state');
    const { server } = require('../server');
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const request = async (url, body) => {
        const r = await fetch(base + url, body === undefined ? {} : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { code: r.status, data: await r.json() };
    };

    t.after(async () => {
        await request('/api/stop', {});
        await new Promise(r => server.close(r));
        fs.rmSync(root, { recursive: true, force: true });
    });

    // 1. Create and complete an initial baseline audit
    const baseConfig = {
        workspaceRoot: workspace,
        commonPrompt: 'Baseline audit',
        scope: '全量审核',
        reviewers: [
            {
                provider: 'mock',
                name: '后端审核员',
                scope: 'engine/'
            },
            {
                provider: 'mock',
                name: '前端审核员',
                scope: 'public/'
            }
        ],
        concurrency: 2
    };

    const initialAuditRes = await request('/api/audits', baseConfig);
    assert.equal(initialAuditRes.code, 202);
    const initialId = initialAuditRes.data.auditId;

    // Wait for initial audit to complete
    let baseAudit;
    for (let i = 0; i < 300; i++) {
        baseAudit = (await request(`/api/audits/${initialId}`)).data;
        if (baseAudit.status !== 'RUNNING' && baseAudit.status !== 'CREATED') break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(baseAudit.status, 'COMPLETED');
    assert.ok(baseAudit.snapshot);

    // Save a mock finding onto baseAudit to test issue retention
    const store = new RunStore(process.env.STUDIO_DATA_DIR);
    baseAudit.findings = [{
        id: 'F-CORE-1',
        category: 'BUG',
        severity: 'HIGH',
        file: 'engine/core.js',
        lineRange: '1',
        problem: 'Integer overflow potential',
        evidence: 'core returns raw value without bounds check',
        acceptance: 'Add range check',
        state: 'REPAIR',
        sources: [{ reviewerId: baseAudit.reviewers[0].id, reviewerName: '后端审核员', file: 'engine/core.js', problem: 'Integer overflow potential' }]
    }];
    store.save('audits', baseAudit);

    // 2. Modify one file in workspace: engine/core.js
    fs.writeFileSync(path.join(workspace, 'engine', 'core.js'), 'function core() { return 2; }\n');

    // 3. Test targeted-preview
    const previewRes = await request(`/api/audits/${initialId}/targeted-preview`, { workspaceRoot: workspace });
    assert.equal(previewRes.code, 200);
    const plan = previewRes.data;

    assert.equal(plan.baseAuditId, initialId);
    assert.deepEqual(plan.changedFiles, ['engine/core.js']);
    assert.equal(plan.uncoveredScopes.length, 0);
    assert.equal(plan.requiresFullAudit, false);
    assert.ok(plan.version);
    assert.equal(plan.proposedTasks.length, 1);
    const proposedTask = plan.proposedTasks[0];
    assert.equal(proposedTask.reviewerName, '后端审核员');
    assert.ok(proposedTask.checklist.some(item => item.includes('engine/core.js')));
    assert.ok(proposedTask.sourceFindingIds.includes('F-CORE-1'));
    assert.equal(plan.estimatedAttempts.minimumAttempts, 1);

    // 4. Test start validation failures
    // 4a. Version conflict
    const badVersionRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: 'invalid-version',
        taskIds: [proposedTask.id]
    });
    assert.equal(badVersionRes.code, 409);
    assert.match(badVersionRes.data.error, /PLAN_VERSION_CONFLICT/);

    // 4b. Empty task selection
    const emptyTasksRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: plan.version,
        taskIds: []
    });
    assert.equal(emptyTasksRes.code, 400);
    assert.match(emptyTasksRes.data.error, /EMPTY_TASK_SELECTION/);

    // 4c. Duplicate task selection
    const dupTasksRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: plan.version,
        taskIds: [proposedTask.id, proposedTask.id]
    });
    assert.equal(dupTasksRes.code, 400);
    assert.match(dupTasksRes.data.error, /DUPLICATE_TASK_SELECTION/);

    // 4d. Unknown task ID
    const unknownTaskRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: plan.version,
        taskIds: ['TP-NON-EXISTENT']
    });
    assert.equal(unknownTaskRes.code, 400);
    assert.match(unknownTaskRes.data.error, /UNKNOWN_TASK_ID/);

    // 5. Test requiresFullAudit rejection when unacknowledged
    // Create an unassigned change (e.g. unknown/orphan.js)
    fs.mkdirSync(path.join(workspace, 'unknown'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'unknown', 'orphan.js'), 'console.log("unassigned");\n');

    const previewWithUnassigned = await request(`/api/audits/${initialId}/targeted-preview`, { workspaceRoot: workspace });
    assert.equal(previewWithUnassigned.code, 200);
    assert.equal(previewWithUnassigned.data.requiresFullAudit, true);

    const unackFullAuditRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: previewWithUnassigned.data.version,
        taskIds: [previewWithUnassigned.data.proposedTasks[0].id],
        acknowledgeFullAudit: false
    });
    assert.equal(unackFullAuditRes.code, 409);
    assert.match(unackFullAuditRes.data.error, /FULL_AUDIT_REQUIRED/);

    // Clean up orphan file to restore clean partial state
    fs.unlinkSync(path.join(workspace, 'unknown', 'orphan.js'));
    fs.rmdirSync(path.join(workspace, 'unknown'));

    // Re-preview for clean state
    const cleanPreview = await request(`/api/audits/${initialId}/targeted-preview`, { workspaceRoot: workspace });
    assert.equal(cleanPreview.code, 200);

    // 6. Successfully start targeted review
    const startRes = await request(`/api/audits/${initialId}/targeted-start`, {
        workspaceRoot: workspace,
        version: cleanPreview.data.version,
        taskIds: [cleanPreview.data.proposedTasks[0].id],
        budget: { maxAttempts: 5, maxActiveSeconds: 120 },
        note: '定向复查后端 core 逻辑与未关闭问题'
    });
    assert.equal(startRes.code, 202);
    const targetedAuditId = startRes.data.auditId;

    // Wait for targeted review to complete
    let targetedAudit;
    for (let i = 0; i < 300; i++) {
        targetedAudit = (await request(`/api/audits/${targetedAuditId}`)).data;
        if (targetedAudit.status !== 'RUNNING' && targetedAudit.status !== 'CREATED') break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(['COMPLETED', 'PARTIAL'].includes(targetedAudit.status));
    assert.equal(targetedAudit.parentAudit.mode, 'TARGETED');
    assert.equal(targetedAudit.parentAudit.id, initialId);
    assert.ok(targetedAudit.targetedPlan);
    assert.equal(targetedAudit.targetedPlan.note, '定向复查后端 core 逻辑与未关闭问题');

    // 7. Verify closure isolation:
    // TARGETED mode does NOT satisfy full baseline coverage
    // In closureView, baseline is still root (initialId) whose snapshot is old.
    // The un-rechecked public/ checklist item has no current proof, so ready is false!
    const currentManifest = await buildManifest(workspace);
    const closure = closureView(store, initialId, currentManifest.snapshot);

    assert.equal(closure.baselineId, initialId);
    assert.equal(closure.ready, false);
    assert.ok(closure.blockers.includes('审核范围存在缺口或过期证据') || closure.blockers.some(b => b.includes('缺口')));
    // Root finding F-CORE-1 is still open (not closed by omission in targeted run)
    assert.ok(closure.findings.some(f => f.findingId === 'F-CORE-1' && ['TRIAGE', 'REPAIR'].includes(f.state)));

    // 8. High-risk scenario: checking B via TARGETED does NOT validate stale A on changed codebase
    const workspace2 = path.join(root, 'workspace2');
    fs.mkdirSync(path.join(workspace2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace2, 'src', 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(workspace2, 'src', 'b.js'), 'const b = 1;\n');

    const config2 = {
        workspaceRoot: workspace2,
        commonPrompt: 'Baseline audit 2',
        scope: '全量审核',
        reviewers: [
            { provider: 'mock', name: 'Reviewer A', scope: 'src/a.js' },
            { provider: 'mock', name: 'Reviewer B', scope: 'src/b.js' }
        ]
    };

    const root2Res = await request('/api/audits', config2);
    const root2Id = root2Res.data.auditId;
    let root2Audit;
    for (let i = 0; i < 300; i++) {
        root2Audit = (await request(`/api/audits/${root2Id}`)).data;
        if (root2Audit.status !== 'RUNNING' && root2Audit.status !== 'CREATED') break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(root2Audit.status, 'COMPLETED');

    // Code changes only in b.js
    fs.writeFileSync(path.join(workspace2, 'src', 'b.js'), 'const b = 2;\n');

    const preview2 = await request(`/api/audits/${root2Id}/targeted-preview`, { workspaceRoot: workspace2 });
    assert.equal(preview2.code, 200);
    assert.deepEqual(preview2.data.changedFiles, ['src/b.js']);

    const start2Res = await request(`/api/audits/${root2Id}/targeted-start`, {
        workspaceRoot: workspace2,
        version: preview2.data.version,
        taskIds: [preview2.data.proposedTasks[0].id]
    });
    assert.equal(start2Res.code, 202);

    let targeted2Audit;
    for (let i = 0; i < 300; i++) {
        targeted2Audit = (await request(`/api/audits/${start2Res.data.auditId}`)).data;
        if (targeted2Audit.status !== 'RUNNING' && targeted2Audit.status !== 'CREATED') break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(['COMPLETED', 'PARTIAL'].includes(targeted2Audit.status));

    const manifest2After = await buildManifest(workspace2);
    const closure2 = closureView(store, root2Id, manifest2After.snapshot);

    assert.equal(closure2.ready, false);
    const covA = closure2.coverage.find(c => c.name === 'Reviewer A');
    assert.ok(covA);
    assert.equal(covA.stale, true);
    assert.equal(covA.complete, false);
    assert.ok(closure2.blockers.some(b => b.includes('缺口') || b.includes('过期')));
});
