'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFixture, copyV0Fixtures } = require('./helpers/studio-fixture');
const { presentAudit } = require('../engine/audit-triage');
const { closureView } = require('../engine/audit-closure');
const { issueLedger } = require('../engine/issue-ledger');
const { readDraft } = require('../engine/planning-state');
const { AuditWorkflow } = require('../engine/audit-workflow');

test('createFixture helper provides an isolated workspace and cleans up cleanly', (t) => {
    const f = createFixture(t);
    assert.ok(fs.existsSync(f.root));
    assert.ok(fs.existsSync(f.workspace));
    assert.ok(fs.existsSync(path.join(f.workspace, 'app.js')));
    assert.ok(f.store);
    assert.equal(typeof f.workspaceKey, 'string');
});

test('legacy v0 audit without checklist or closure tests can be read and presented', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const auditId = 'a0000000-0000-0000-0000-000000000001';
    const raw = f.store.read('audits', auditId);
    assert.equal(raw.id, auditId);
    assert.equal(raw.status, 'COMPLETED');
    assert.equal(raw.reviewers[0].checklist, undefined);
    assert.equal(raw.closureTests, undefined);

    const presented = presentAudit(raw);
    assert.equal(presented.id, auditId);
    assert.ok(Array.isArray(presented.findings));
    assert.equal(presented.findings.length, 1);
    assert.equal(presented.findings[0].id, 'F-1');
    assert.ok(typeof presented.findings[0].evidenceKey === 'string' && presented.findings[0].evidenceKey.length === 64);
    assert.equal(presented.findings[0].triageVersion, 0);
    assert.equal(presented.findings[0].verification, null);
    assert.equal(presented.findings[0].repairable, false);
    assert.ok(typeof presented.supplementVersion === 'string' && presented.supplementVersion.length === 64);
});

test('legacy partial and supplement audits resolve closureView without crashing', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const rootId = 'a0000000-0000-0000-0000-000000000001';
    const partialId = 'a0000000-0000-0000-0000-000000000002';
    const suppId = 'a0000000-0000-0000-0000-000000000003';

    const partialRaw = f.store.read('audits', partialId);
    assert.equal(partialRaw.status, 'PARTIAL');

    // On matching snapshot snap-v1:
    // Supplement resolved SCOPE, repair run closed F-1, test gate passed
    const view = closureView(f.store, suppId, 'snap-v1');
    assert.equal(view.rootId, rootId);
    assert.ok(Array.isArray(view.coverage));
    assert.ok(Array.isArray(view.findings));
    assert.equal(view.findings[0].state, 'CLOSED');
    assert.equal(view.coverage[0].complete, true);
    assert.equal(view.ready, true);

    // On newer snapshot snap-v2:
    // Previous closure evidence becomes stale
    const staleView = closureView(f.store, suppId, 'snap-v2');
    assert.equal(staleView.rootId, rootId);
    assert.equal(staleView.ready, false);
    assert.ok(staleView.blockers.length > 0);
});

test('legacy repair runs with bug history are indexed correctly by issueLedger', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const runId = 'b0000000-0000-0000-0000-000000000001';
    const run = f.store.read('runs', runId);
    assert.equal(run.id, runId);
    assert.equal(run.status, 'APPROVED');
    assert.equal(run.bugs[0].status, 'VERIFIED_CLOSED');

    const ledger = issueLedger(f.store, f.workspace);
    assert.ok(Array.isArray(ledger));
    assert.equal(ledger.length, 1);
    const issue = ledger[0];
    assert.equal(issue.problem, 'Missing null check');
    assert.equal(issue.status, 'VERIFIED_CLOSED');
    assert.equal(issue.occurrences.length, 1);
    assert.equal(issue.repairRuns.length, 1);
    assert.equal(issue.repairRuns[0].runId, runId);
});

test('legacy approved plan can be verified via store.approvedPlan', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const planId = 'c0000000-0000-0000-0000-000000000001';
    const plan = f.store.read('plans', planId);
    assert.equal(plan.id, planId);
    assert.equal(plan.status, 'APPROVED');

    const verified = f.store.approvedPlan({
        workspaceRoot: f.workspace,
        planId,
        approvalId: 'c0000000-0000-0000-0000-000000000002',
        taskPrompt: 'Implement safe input validation'
    });
    assert.equal(verified.id, planId);
});

test('legacy discussion draft can be read via readDraft', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const discId = 'd0000000-0000-0000-0000-000000000001';
    const discussion = f.store.read('discussions', discId);
    assert.equal(discussion.id, discId);

    const draft = readDraft(f.store, discussion);
    assert.equal(draft.revision, 1);
    assert.equal(draft.value.selections[0].decision, 'ADOPT');
    assert.equal(draft.value.answers[0].answer, 'Yes, reject empty string');
});

test('error contracts on missing key IDs, non-existent records, and empty workspaces', (t) => {
    const f = createFixture(t);

    assert.throws(() => f.store.file('audits', 'short-id'), /INVALID_RECORD_ID/);
    assert.throws(() => f.store.file('audits', 'not-a-valid-uuid-format-at-all-xyz123'), /INVALID_RECORD_ID/);
    assert.throws(() => issueLedger(f.store, ''), /WORKSPACE_REQUIRED/);
    assert.throws(() => issueLedger(f.store, '   '), /WORKSPACE_REQUIRED/);
    assert.throws(() => f.store.read('audits', crypto.randomUUID()), (err) => err.code === 'ENOENT');
});

test('roundtrip reads and presentations do not mutate disk files', async (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    function collectDiskSnapshots(dir) {
        const result = new Map();
        if (!fs.existsSync(dir)) return result;
        const scan = (curr) => {
            for (const name of fs.readdirSync(curr)) {
                const full = path.join(curr, name);
                if (fs.statSync(full).isDirectory()) scan(full);
                else result.set(full, fs.readFileSync(full));
            }
        };
        scan(dir);
        return result;
    }

    const beforeV0 = collectDiskSnapshots(path.join(f.root, 'state'));

    // Execute read operations
    const audit = f.store.read('audits', 'a0000000-0000-0000-0000-000000000001');
    presentAudit(audit);
    closureView(f.store, 'a0000000-0000-0000-0000-000000000003', 'snap-v1');
    issueLedger(f.store, f.workspace);
    const disc = f.store.read('discussions', 'd0000000-0000-0000-0000-000000000001');
    readDraft(f.store, disc);

    const afterV0 = collectDiskSnapshots(path.join(f.root, 'state'));
    assert.equal(afterV0.size, beforeV0.size);
    for (const [filePath, content] of beforeV0.entries()) {
        assert.ok(afterV0.has(filePath), `Missing file: ${filePath}`);
        assert.deepEqual(afterV0.get(filePath), content, `File was mutated on read: ${filePath}`);
    }

    // Now test with a real 2.9 generated audit
    const engine = new AuditWorkflow(f.store, {
        snapshot: async () => 'v2.9-snap',
        preflight: async () => ({ ok: true, results: [] }),
        agent: async () => JSON.stringify({
            summary: 'clean',
            scopeComplete: true,
            coverage: ['app.js'],
            findings: []
        }),
        command: async () => ({ code: 0, stdout: 'ok', stderr: '' })
    });
    const generated = engine.create({
        workspaceRoot: f.workspace,
        commonPrompt: 'review',
        scope: 'app.js',
        reviewers: [{ provider: 'mock', checklist: ['check-1'] }]
    });
    engine.launch(generated);
    await engine.active.promise;

    const beforeGen = collectDiskSnapshots(path.join(f.root, 'state'));
    const readGen = f.store.read('audits', generated.id);
    presentAudit(readGen);
    closureView(f.store, generated.id, 'v2.9-snap');
    issueLedger(f.store, f.workspace);

    const afterGen = collectDiskSnapshots(path.join(f.root, 'state'));
    assert.equal(afterGen.size, beforeGen.size);
    for (const [filePath, content] of beforeGen.entries()) {
        assert.ok(afterGen.has(filePath), `Missing file: ${filePath}`);
        assert.deepEqual(afterGen.get(filePath), content, `File was mutated on read: ${filePath}`);
    }
});
