/**
 * @file decision-application.tests.js
 * @author shuyongqiang
 * @description Unit and API tests for human decision recording and idempotent triage application.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const { createCase, presentCase, decideCase, applyDecision } = require('../engine/decision-cases');
const { evidenceKey } = require('../engine/audit-triage');

function setupScenario(f) {
    const auditId = crypto.randomUUID();
    const bugFinding = {
        id: 'F-BUG',
        category: 'BUG',
        severity: 'HIGH',
        file: 'app.js',
        lineRange: '1-5',
        problem: 'Null dereference on empty input',
        evidence: 'return null.value;',
        acceptance: 'Null guard',
        sources: [{ reviewerId: 'rev-1', findingId: 'F-BUG' }]
    };
    const suggFinding = {
        id: 'F-SUGG',
        category: 'SUGGESTION',
        severity: 'LOW',
        file: 'app.js',
        lineRange: '10-15',
        problem: 'Refactor loop into reduce',
        evidence: 'for(let x of items)...',
        acceptance: 'Use reduce',
        sources: [{ reviewerId: 'rev-2', findingId: 'F-SUGG' }]
    };

    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        reviewers: [{ id: 'rev-1', name: 'Reviewer A', status: 'COMPLETED', checklist: [] }],
        findings: [bugFinding, suggFinding],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    const runId = crypto.randomUUID();
    f.store.save('runs', {
        id: runId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'RUNNING',
        bugs: [{ id: 'B-1', problem: 'Null dereference on empty input', status: 'OPEN', category: 'BUG' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    return { auditId, bugFinding, suggFinding, runId };
}

test('decideCase: records decision with version check, non-empty note and business answers', (t) => {
    const f = createFixture(t);
    const { auditId, bugFinding } = setupScenario(f);

    const c = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-BUG',
        question: 'Is this null pointer a real defect?',
        anchor: {
            auditId,
            findingId: 'F-BUG',
            evidenceKey: evidenceKey(bugFinding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-BUG' }]
    });

    // Mock analysis with clarifying question
    const stored = f.store.read('decision-cases', c.id);
    stored.analysis = {
        summary: 'Dispute analysis',
        positions: [],
        options: [],
        questions: [{ id: 'Q-1', text: 'Can input be null?' }]
    };
    f.store.save('decision-cases', stored);

    const presented = presentCase(f.store, c.id);

    // Reject empty note
    assert.throws(() => {
        decideCase(f.store, c.id, {
            workspaceRoot: f.workspace,
            version: presented.version,
            action: 'CONFIRM',
            note: '   ',
            answers: [{ id: 'Q-1', text: 'Yes' }]
        });
    }, /EMPTY_DECISION_NOTE/);

    // Reject missing business answers
    assert.throws(() => {
        decideCase(f.store, c.id, {
            workspaceRoot: f.workspace,
            version: presented.version,
            action: 'CONFIRM',
            note: 'Valid bug confirmed',
            answers: []
        });
    }, /INCOMPLETE_BUSINESS_ANSWERS/);

    // Reject invalid category action (CONFIRM on SUGGESTION or ACCEPT_SUGGESTION on BUG)
    assert.throws(() => {
        decideCase(f.store, c.id, {
            workspaceRoot: f.workspace,
            version: presented.version,
            action: 'ACCEPT_SUGGESTION',
            note: 'Accepting suggestion',
            answers: [{ id: 'Q-1', text: 'Yes' }]
        });
    }, /INVALID_DECISION_ACTION/);

    // Valid decision
    const decided = decideCase(f.store, c.id, {
        workspaceRoot: f.workspace,
        version: presented.version,
        action: 'CONFIRM',
        note: 'Confirmed this must be fixed',
        answers: [{ id: 'Q-1', text: 'Yes, null can happen from upstream' }]
    });

    assert.equal(decided.status, 'DECIDED');
    assert.equal(decided.decisions.length, 1);
    assert.equal(decided.decisions[0].action, 'CONFIRM');
    assert.equal(decided.decisions[0].applied, false);
});

test('applyDecision: applies decision to anchor finding idempotently and logs applicationId', (t) => {
    const f = createFixture(t);
    const { auditId, bugFinding, runId } = setupScenario(f);

    const c = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-BUG',
        question: 'Should we defer this bug?',
        anchor: {
            auditId,
            findingId: 'F-BUG',
            evidenceKey: evidenceKey(bugFinding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-BUG' }]
    });

    const pres1 = presentCase(f.store, c.id);
    const decided = decideCase(f.store, c.id, {
        workspaceRoot: f.workspace,
        version: pres1.version,
        action: 'DEFER',
        note: 'Deferring to next sprint',
        answers: []
    });

    const decisionId = decided.decisions[0].id;
    const pres2 = presentCase(f.store, c.id);

    // First apply call
    const applyRes1 = applyDecision(f.store, {
        caseId: c.id,
        decisionId,
        version: pres2.version,
        workspaceRoot: f.workspace
    });

    assert.ok(applyRes1);
    const auditAfter1 = f.store.read('audits', auditId);
    assert.equal(auditAfter1.triage['F-BUG'].status, 'DEFERRED');
    assert.equal(auditAfter1.triage['F-BUG'].version, 1);
    const history1 = auditAfter1.triage['F-BUG'].history;
    assert.equal(history1.length, 1);
    const applicationId = history1[0].decisionApplicationId;
    assert.ok(applicationId);

    // Second apply call (simulating network retry)
    const applyRes2 = applyDecision(f.store, {
        caseId: c.id,
        decisionId,
        workspaceRoot: f.workspace
    });

    assert.ok(applyRes2);
    assert.equal(applyRes2.alreadyApplied, true);
    assert.equal(applyRes2.applicationId, applicationId);

    // Ensure audit triage history was NOT duplicated!
    const auditAfter2 = f.store.read('audits', auditId);
    assert.equal(auditAfter2.triage['F-BUG'].history.length, 1);
    assert.equal(auditAfter2.triage['F-BUG'].history.filter(x => x.decisionApplicationId === applicationId).length, 1);

    // Ensure run status was NOT altered or auto-approved by decision!
    const run = f.store.read('runs', runId);
    assert.notEqual(run.status, 'APPROVED');
});

test('applyDecision: detects concurrent anchor conflict and rejects overwrite', (t) => {
    const f = createFixture(t);
    const { auditId, bugFinding } = setupScenario(f);

    const c = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-BUG',
        question: 'Should we confirm or dismiss?',
        anchor: {
            auditId,
            findingId: 'F-BUG',
            evidenceKey: evidenceKey(bugFinding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-BUG' }]
    });

    const pres1 = presentCase(f.store, c.id);
    const decided = decideCase(f.store, c.id, {
        workspaceRoot: f.workspace,
        version: pres1.version,
        action: 'CONFIRM',
        note: 'Confirmed bug',
        answers: []
    });

    const decisionId = decided.decisions[0].id;

    // Simulate external manual triage before applying decision
    const audit = f.store.read('audits', auditId);
    audit.triage['F-BUG'] = {
        status: 'DISMISSED',
        note: 'Manually dismissed by admin',
        evidenceKey: evidenceKey(bugFinding),
        verificationKey: '',
        version: 1,
        at: new Date().toISOString(),
        history: []
    };
    f.store.save('audits', audit);

    // Application should fail with ANCHOR_CONFLICT
    assert.throws(() => {
        applyDecision(f.store, {
            caseId: c.id,
            decisionId,
            workspaceRoot: f.workspace
        });
    }, /ANCHOR_CONFLICT/);

    const caseAfter = f.store.read('decision-cases', c.id);
    assert.equal(caseAfter.applications[0].status, 'CONFLICT');
});

test('applyDecision: recovery after injected write failure reuses same applicationId', (t) => {
    const f = createFixture(t);
    const { auditId, bugFinding } = setupScenario(f);

    const c = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-BUG',
        question: 'Defer this finding?',
        anchor: {
            auditId,
            findingId: 'F-BUG',
            evidenceKey: evidenceKey(bugFinding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-BUG' }]
    });

    const pres = presentCase(f.store, c.id);
    const decided = decideCase(f.store, c.id, {
        workspaceRoot: f.workspace,
        version: pres.version,
        action: 'DEFER',
        note: 'Defer this',
        answers: []
    });
    const decisionId = decided.decisions[0].id;

    // First attempt fails during write
    assert.throws(() => {
        applyDecision(f.store, {
            caseId: c.id,
            decisionId,
            workspaceRoot: f.workspace
        }, { injectWriteFailure: true });
    }, /INJECTED_WRITE_FAILURE/);

    const caseAfterFail = f.store.read('decision-cases', c.id);
    assert.equal(caseAfterFail.applications.length, 1);
    assert.equal(caseAfterFail.applications[0].status, 'PENDING');
    const firstApplicationId = caseAfterFail.applications[0].applicationId;

    // Retry should succeed and reuse the exact same applicationId
    const retryRes = applyDecision(f.store, {
        caseId: c.id,
        decisionId,
        workspaceRoot: f.workspace
    });

    assert.ok(retryRes);
    const caseAfterRetry = f.store.read('decision-cases', c.id);
    assert.equal(caseAfterRetry.applications.length, 1);
    assert.equal(caseAfterRetry.applications[0].status, 'APPLIED');
    assert.equal(caseAfterRetry.applications[0].applicationId, firstApplicationId);
});

test('Decision cases HTTP API: create, fetch, decide, apply over HTTP', async (t) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-decision-api-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'app.js'), 'console.log("hello");\n');

    process.env.STUDIO_DATA_DIR = path.join(root, 'state');
    const { server } = require('../server');
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const request = async (url, body, method = 'POST') => {
        const opts = { method };
        if (body !== undefined) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(base + url, opts);
        return { code: r.status, data: await r.json() };
    };

    t.after(async () => {
        await new Promise(r => server.close(r));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const { RunStore, workspaceKey } = require('../engine/run-store');
    const store = new RunStore(process.env.STUDIO_DATA_DIR);
    const auditId = crypto.randomUUID();
    const finding = {
        id: 'F-1',
        category: 'BUG',
        severity: 'HIGH',
        file: 'app.js',
        lineRange: '1-2',
        problem: 'Http test finding',
        evidence: 'console.log',
        acceptance: 'fix',
        sources: []
    };
    store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: fs.realpathSync(workspace),
        workspaceKey: workspaceKey(workspace),
        status: 'COMPLETED',
        scope: 'app.js',
        reviewers: [],
        findings: [finding],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // 1. POST /api/decision-cases
    const createRes = await request('/api/decision-cases', {
        workspaceRoot: workspace,
        title: 'HTTP Decision Case',
        question: 'Should we confirm via HTTP API?',
        anchor: {
            auditId,
            findingId: 'F-1',
            evidenceKey: evidenceKey(finding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' }]
    });
    assert.equal(createRes.code, 201);
    assert.equal(createRes.data.title, 'HTTP Decision Case');
    const caseId = createRes.data.id;
    const version1 = createRes.data.version;

    // 2. GET /api/decision-cases/:id
    const getRes = await request(`/api/decision-cases/${caseId}`, undefined, 'GET');
    assert.equal(getRes.code, 200);
    assert.equal(getRes.data.id, caseId);

    // 3. POST /api/decision-cases/:id/decide
    const decideRes = await request(`/api/decision-cases/${caseId}/decide`, {
        workspaceRoot: workspace,
        version: version1,
        action: 'CONFIRM',
        note: 'Confirmed via HTTP endpoint'
    });
    assert.equal(decideRes.code, 200);
    assert.equal(decideRes.data.status, 'DECIDED');
    const decisionId = decideRes.data.decisions[0].id;
    const version2 = decideRes.data.version;

    // 4. POST /api/decision-cases/:id/apply
    const applyRes = await request(`/api/decision-cases/${caseId}/apply`, {
        workspaceRoot: workspace,
        decisionId,
        version: version2
    });
    assert.equal(applyRes.code, 200);

    // 5. Verify audit triage updated
    const auditRes = await request(`/api/audits/${auditId}`, undefined, 'GET');
    assert.equal(auditRes.code, 200);
    assert.equal(auditRes.data.triage['F-1'].status, 'CONFIRMED');
});

