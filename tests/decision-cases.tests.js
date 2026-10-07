/**
 * @file decision-cases.tests.js
 * @author shuyongqiang
 * @description Unit tests for decision cases and evidence referencing.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const { createCase, presentCase } = require('../engine/decision-cases');
const { evidenceKey } = require('../engine/audit-triage');
const { hash } = require('../engine/run-store');

function setupTestScenario(f) {
    const auditId = crypto.randomUUID();
    const finding1 = {
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
    const finding2 = {
        id: 'F-2',
        category: 'SUGGESTION',
        severity: 'LOW',
        file: 'app.js',
        lineRange: '15-20',
        problem: 'Consider using const instead of let',
        evidence: 'let x = 1;',
        acceptance: 'Use const',
        sources: [{ reviewerId: 'rev-2', findingId: 'F-2' }]
    };
    const audit = {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        reviewers: [
            { id: 'rev-1', name: 'Reviewer A', status: 'COMPLETED', checklist: ['C-1', 'C-2'], report: { summary: 'Found bug' } },
            { id: 'rev-2', name: 'Reviewer B', status: 'COMPLETED', checklist: [], report: { summary: 'Suggestion' } }
        ],
        findings: [finding1, finding2],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    f.store.save('audits', audit);

    const runId = crypto.randomUUID();
    const run = {
        id: runId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'APPROVED',
        bugs: [
            { id: 'B-1', problem: 'Null pointer when input is empty string', status: 'OPEN', category: 'BUG' }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    f.store.save('runs', run);

    const planId = crypto.randomUUID();
    const plan = {
        id: planId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'APPROVED',
        requirements: [
            { id: 'REQ-1', name: 'Safe input handling', description: 'Reject invalid strings' }
        ],
        questions: [
            { id: 'Q-1', text: 'Should empty strings default to empty object or throw?' }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    f.store.save('plans', plan);

    return { auditId, finding1, finding2, runId, planId };
}

test('createCase: rejects empty title or empty question', (t) => {
    const f = createFixture(t);
    const { auditId, finding1 } = setupTestScenario(f);

    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: '',
            question: 'What to do?',
            anchor: null,
            references: []
        });
    }, /EMPTY_TITLE/);

    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: 'Dispute title',
            question: '   ',
            anchor: null,
            references: []
        });
    }, /EMPTY_QUESTION/);
});

test('createCase: rejects cross-workspace references and unknown items', (t) => {
    const f = createFixture(t);
    const { auditId, finding1 } = setupTestScenario(f);

    // Another workspace fixture
    const fOther = createFixture(t);
    const otherAuditId = crypto.randomUUID();
    f.store.save('audits', {
        id: otherAuditId,
        storageVersion: 1,
        workspaceRoot: fOther.workspace,
        workspaceKey: fOther.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        reviewers: [],
        findings: [
            {
                id: 'F-1',
                category: 'BUG',
                severity: 'HIGH',
                file: 'app.js',
                lineRange: '1-10',
                problem: 'Other workspace bug',
                evidence: 'error()',
                acceptance: 'fix',
                sources: []
            }
        ],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // Cross workspace reference to audit finding
    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: 'Cross workspace test',
            question: 'Why cross workspace?',
            anchor: null,
            references: [
                { kind: 'AUDIT_FINDING', recordId: otherAuditId, itemId: 'F-1' }
            ]
        });
    }, /CROSS_WORKSPACE_REFERENCE/);

    // Unknown finding in current workspace audit
    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: 'Unknown item test',
            question: 'Why unknown item?',
            anchor: null,
            references: [
                { kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-999' }
            ]
        });
    }, /UNKNOWN_REFERENCE_ITEM/);

    // Unknown record ID
    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: 'Unknown record test',
            question: 'Why unknown record?',
            anchor: null,
            references: [
                { kind: 'AUDIT_FINDING', recordId: crypto.randomUUID(), itemId: 'F-1' }
            ]
        });
    });
});

test('createCase: rejects duplicate references', (t) => {
    const f = createFixture(t);
    const { auditId } = setupTestScenario(f);

    assert.throws(() => {
        createCase(f.store, {
            workspaceRoot: f.workspace,
            title: 'Duplicate reference test',
            question: 'How to handle duplicate refs?',
            anchor: null,
            references: [
                { kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' },
                { kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' }
            ]
        });
    }, /DUPLICATE_REFERENCE/);
});

test('createCase: cannot forge evidence text from client, uses server snapshot', (t) => {
    const f = createFixture(t);
    const { auditId, finding1 } = setupTestScenario(f);

    const created = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Tamper resistance test',
        question: 'Does server snapshot prevail?',
        anchor: null,
        references: [
            {
                kind: 'AUDIT_FINDING',
                recordId: auditId,
                itemId: 'F-1',
                fakeEvidence: 'CLIENT_INJECTED_FAKE_EVIDENCE',
                problem: 'CLIENT_INJECTED_FAKE_PROBLEM'
            }
        ]
    });

    assert.equal(created.status, 'OPEN');
    assert.equal(created.references.length, 1);
    const ref = created.references[0];
    assert.equal(ref.snapshot.problem, finding1.problem);
    assert.equal(ref.snapshot.evidence, finding1.evidence);
    assert.equal(ref.fakeEvidence, undefined);
});

test('createCase & presentCase: without anchor works as business decision case', (t) => {
    const f = createFixture(t);
    const { planId } = setupTestScenario(f);

    const created = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Business dispute: Empty string semantics',
        question: 'Should empty strings default or fail fast?',
        anchor: null,
        references: [
            { kind: 'PLAN_QUESTION', recordId: planId, itemId: 'Q-1' }
        ]
    });

    assert.ok(created.id);
    assert.equal(created.anchor, null);
    assert.equal(created.references.length, 1);

    const presented = presentCase(f.store, created.id);
    assert.equal(presented.id, created.id);
    assert.equal(presented.anchor, null);
    assert.equal(presented.stale, false);
    assert.equal(presented.status, 'OPEN');
    assert.ok(typeof presented.version === 'string' && presented.version.length === 64);
});

test('createCase & presentCase: with anchor tracks finding and detects evidence staleness', (t) => {
    const f = createFixture(t);
    const { auditId, finding1, runId } = setupTestScenario(f);

    const anchorInput = {
        auditId,
        findingId: 'F-1',
        evidenceKey: evidenceKey(finding1),
        triageVersion: 0,
        verificationKey: ''
    };

    const created = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-1 Null check necessity',
        question: 'Is this null pointer possible in production?',
        anchor: anchorInput,
        references: [
            { kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' },
            { kind: 'RUN_BUG', recordId: runId, itemId: 'B-1' }
        ]
    });

    assert.equal(created.status, 'OPEN');
    assert.ok(created.anchor);
    assert.equal(created.anchor.findingId, 'F-1');

    const presented = presentCase(f.store, created.id);
    assert.equal(presented.stale, false);
    assert.equal(presented.status, 'OPEN');
    assert.equal(presented.anchor.stale, false);
    assert.equal(presented.references[0].stale, false);
    assert.equal(presented.references[1].stale, false);

    const initialVersion = presented.version;

    // Mutate audit finding to simulate source/evidence update
    const audit = f.store.read('audits', auditId);
    audit.findings[0].evidence = 'CHANGED_EVIDENCE_IN_SOURCE';
    f.store.save('audits', audit);

    // Presenting again should detect staleness and mark NEEDS_REVIEW
    const presentedAfterMutation = presentCase(f.store, created.id);
    assert.equal(presentedAfterMutation.stale, true);
    assert.equal(presentedAfterMutation.status, 'NEEDS_REVIEW');
    assert.equal(presentedAfterMutation.anchor.stale, true);
    assert.notEqual(presentedAfterMutation.version, initialVersion);
});
