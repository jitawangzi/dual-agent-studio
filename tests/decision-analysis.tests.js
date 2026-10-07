/**
 * @file decision-analysis.tests.js
 * @author shuyongqiang
 * @description Unit tests for single-shot structured arbitration analysis.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const { createCase, presentCase } = require('../engine/decision-cases');
const { parseArbitration, analyzeCase } = require('../engine/decision-analysis');
const { evidenceKey } = require('../engine/audit-triage');
const { currentActiveSeconds } = require('../engine/execution-budget');

function setupCaseFixture(f) {
    const auditId = crypto.randomUUID();
    const finding = {
        id: 'F-1',
        category: 'BUG',
        severity: 'HIGH',
        file: 'app.js',
        lineRange: '1-10',
        problem: 'Null pointer when input is empty string',
        evidence: 'if (str.length === 0) return null.val;',
        acceptance: 'Handle empty string safely',
        sources: [{ reviewerId: 'rev-1', findingId: 'F-1' }]
    };
    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        reviewers: [{ id: 'rev-1', name: 'Reviewer A', status: 'COMPLETED', checklist: ['C-1'] }],
        findings: [finding],
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
        status: 'APPROVED',
        bugs: [{ id: 'B-1', problem: 'Null pointer when input is empty string', status: 'OPEN', category: 'BUG' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    const caseRecord = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute: Null check in production',
        question: 'Can empty string happen in production?',
        anchor: {
            auditId,
            findingId: 'F-1',
            evidenceKey: evidenceKey(finding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [
            { kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' },
            { kind: 'RUN_BUG', recordId: runId, itemId: 'B-1' }
        ]
    });

    return { auditId, finding, runId, caseRecord };
}

test('parseArbitration: validates schema, actions and reference indices', () => {
    const valid = JSON.stringify({
        summary: 'Reviewer and Dev disagree on empty string input possibility',
        positions: [
            {
                referenceIndex: 0,
                claim: 'Auditor claims null pointer can crash app',
                support: 'Line 2 directly accesses null.val without guard',
                limitations: 'Only triggers if caller passes empty string'
            },
            {
                referenceIndex: 1,
                claim: 'Bug report in run asserts reproduction is unverified',
                support: 'Bug status is still OPEN without verified reproduction',
                limitations: 'Lack of reproduction does not prove safety'
            }
        ],
        options: [
            {
                id: 'O-1',
                action: 'VERIFY_MORE',
                reason: 'Need upstream contract check',
                risks: 'Delays release until verification is run'
            },
            {
                id: 'O-2',
                action: 'CONFIRM',
                reason: 'Static analysis proves unhandled branch',
                risks: 'Requires fix implementation'
            }
        ],
        questions: [
            { id: 'Q-1', text: 'Does API gateway strip empty payloads?' }
        ]
    });

    const parsed = parseArbitration(valid, 2);
    assert.equal(parsed.positions.length, 2);
    assert.equal(parsed.options.length, 2);
    assert.equal(parsed.questions.length, 1);

    // Invalid referenceIndex (out of bounds)
    assert.throws(() => {
        parseArbitration(JSON.stringify({
            summary: 'Dispute',
            positions: [{ referenceIndex: 99, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'DEFER', reason: 'r', risks: 'rk' }]
        }), 2);
    }, /INVALID_REFERENCE_INDEX/);

    // Invalid action (e.g. directly closing bug)
    assert.throws(() => {
        parseArbitration(JSON.stringify({
            summary: 'Dispute',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'CLOSE_BUG', reason: 'r', risks: 'rk' }]
        }), 2);
    }, /INVALID_OPTION_ACTION/);

    // Duplicate option ID
    assert.throws(() => {
        parseArbitration(JSON.stringify({
            summary: 'Dispute',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [
                { id: 'O-1', action: 'DEFER', reason: 'r1', risks: 'rk1' },
                { id: 'O-1', action: 'CONFIRM', reason: 'r2', risks: 'rk2' }
            ]
        }), 2);
    }, /DUPLICATE_OPTION_ID/);
});

test('analyzeCase: successful single-shot arbitration transitions case to AWAITING_HUMAN', async (t) => {
    const f = createFixture(t);
    const { caseRecord } = setupCaseFixture(f);
    const presented = presentCase(f.store, caseRecord.id);

    const mockAnswer = JSON.stringify({
        summary: 'Disagreement on input sanitization responsibility',
        positions: [
            {
                referenceIndex: 0,
                claim: 'Auditor found null dereference',
                support: 'app.js:2',
                limitations: 'Applies only if caller omits validation'
            }
        ],
        options: [
            {
                id: 'O-1',
                action: 'VERIFY_MORE',
                reason: 'Run reproductive test with empty payload',
                risks: 'May require test environment setup'
            }
        ],
        questions: [
            { id: 'Q-1', text: 'Is empty string allowed in schema?' }
        ]
    });

    let callCount = 0;
    const result = await analyzeCase(f.store, caseRecord.id, {
        workspaceRoot: f.workspace,
        version: presented.version,
        reviewer: { provider: 'mock', model: 'mock-arbiter' }
    }, {
        snapshot: async () => 'snap-1',
        agent: async () => {
            callCount++;
            return mockAnswer;
        }
    });

    assert.equal(callCount, 1);
    assert.equal(result.status, 'AWAITING_HUMAN');
    assert.notEqual(result.status, 'DECIDED'); // Must NOT be decided
    assert.ok(result.analysis);
    assert.equal(result.analysis.options[0].action, 'VERIFY_MORE');
    assert.equal(result.analysis.stale, false);

    // Check call ledger
    const saved = f.store.read('decision-cases', caseRecord.id);
    assert.ok(saved.callLedger);
    assert.equal(saved.callLedger.attempts.length, 1);
    assert.equal(saved.callLedger.attempts[0].status, 'COMPLETED');
});

test('analyzeCase: budget exhaustion blocks analysis and preserves non-decided state', async (t) => {
    const f = createFixture(t);
    const { caseRecord } = setupCaseFixture(f);
    const presented = presentCase(f.store, caseRecord.id);

    // Provide budget with maxAttempts = 1
    const budget = { maxAttempts: 1, maxActiveSeconds: 60 };

    // First attempt succeeds
    await analyzeCase(f.store, caseRecord.id, {
        workspaceRoot: f.workspace,
        version: presented.version,
        reviewer: { provider: 'mock' },
        budget
    }, {
        snapshot: async () => 'snap-1',
        agent: async () => JSON.stringify({
            summary: 'First run',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'DEFER', reason: 'r', risks: 'rk' }],
            questions: []
        })
    });

    const pres2 = presentCase(f.store, caseRecord.id);

    // Second attempt should fail due to budget exhaustion (maxAttempts: 1 already used)
    await assert.rejects(async () => {
        await analyzeCase(f.store, caseRecord.id, {
            workspaceRoot: f.workspace,
            version: pres2.version,
            reviewer: { provider: 'mock' },
            budget
        }, {
            snapshot: async () => 'snap-1',
            agent: async () => 'should not be called'
        });
    }, /BUDGET_EXHAUSTED/);

    const afterExhaustion = presentCase(f.store, caseRecord.id);
    assert.notEqual(afterExhaustion.status, 'DECIDED');
});

test('analyzeCase: source modification during analysis marks analysis stale and NEEDS_REVIEW', async (t) => {
    const f = createFixture(t);
    const { caseRecord } = setupCaseFixture(f);
    const presented = presentCase(f.store, caseRecord.id);

    let snapshotCall = 0;
    const result = await analyzeCase(f.store, caseRecord.id, {
        workspaceRoot: f.workspace,
        version: presented.version,
        reviewer: { provider: 'mock' }
    }, {
        snapshot: async () => {
            snapshotCall++;
            // Return changed fingerprint on second call (post-check)
            return snapshotCall === 1 ? 'snap-before' : 'snap-after';
        },
        agent: async () => JSON.stringify({
            summary: 'Dispute analysis',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'VERIFY_MORE', reason: 'r', risks: 'rk' }],
            questions: []
        })
    });

    assert.equal(result.analysis.stale, true);
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.notEqual(result.status, 'DECIDED');
});

test('analyzeCase: persists budget tracking on success and does not accumulate idle time', async (t) => {
    const f = createFixture(t);
    const { caseRecord } = setupCaseFixture(f);
    const presented = presentCase(f.store, caseRecord.id);

    await analyzeCase(f.store, caseRecord.id, {
        workspaceRoot: f.workspace,
        version: presented.version,
        reviewer: { provider: 'mock' },
        budget: { maxActiveSeconds: 10 }
    }, {
        snapshot: async () => 'snap-1',
        agent: async () => JSON.stringify({
            summary: 'Analysis summary',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'DEFER', reason: 'r', risks: 'rk' }],
            questions: []
        })
    });

    const saved = f.store.read('decision-cases', caseRecord.id);
    assert.equal(saved.status, 'AWAITING_HUMAN');
    assert.equal(f.store.guard.isBusy(), false, 'guard lease must be released');
    const openIntervals = saved.budget.timeTracking.activeIntervals.filter(i => i.stoppedAt === null);
    assert.equal(openIntervals.length, 0, 'no open active interval on disk');

    const activeNow = currentActiveSeconds(saved);
    const activeLater = currentActiveSeconds(saved, Date.now() + 60000);
    assert.equal(activeLater, activeNow, 'idle time while waiting for human decision must not accumulate');
});

test('analyzeCase: persists budget tracking on failure and releases guard lease', async (t) => {
    const f = createFixture(t);
    const { caseRecord } = setupCaseFixture(f);
    const presented = presentCase(f.store, caseRecord.id);

    await assert.rejects(async () => {
        await analyzeCase(f.store, caseRecord.id, {
            workspaceRoot: f.workspace,
            version: presented.version,
            reviewer: { provider: 'mock' },
            budget: { maxActiveSeconds: 10 }
        }, {
            snapshot: async () => 'snap-1',
            agent: async () => { throw new Error('AGENT_CRASHED'); }
        });
    }, /AGENT_CRASHED/);

    const saved = f.store.read('decision-cases', caseRecord.id);
    assert.equal(saved.status, 'OPEN');
    assert.equal(f.store.guard.isBusy(), false, 'guard lease must be released on failure');
    const openIntervals = saved.budget.timeTracking.activeIntervals.filter(i => i.stoppedAt === null);
    assert.equal(openIntervals.length, 0, 'no open active interval on disk after failure');

    const activeNow = currentActiveSeconds(saved);
    const activeLater = currentActiveSeconds(saved, Date.now() + 60000);
    assert.equal(activeLater, activeNow, 'idle time after failure must not accumulate');

    // Second call can run without lock contention
    await analyzeCase(f.store, caseRecord.id, {
        workspaceRoot: f.workspace,
        version: saved.version,
        reviewer: { provider: 'mock' },
        budget: { maxActiveSeconds: 10 }
    }, {
        snapshot: async () => 'snap-1',
        agent: async () => JSON.stringify({
            summary: 'Retry summary',
            positions: [{ referenceIndex: 0, claim: 'c', support: 's', limitations: 'l' }],
            options: [{ id: 'O-1', action: 'DEFER', reason: 'r', risks: 'rk' }],
            questions: []
        })
    });
    assert.equal(f.store.read('decision-cases', caseRecord.id).status, 'AWAITING_HUMAN');
});

