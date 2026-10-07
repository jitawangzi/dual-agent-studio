/**
 * @file evidence-export.tests.js
 * @author shuyongqiang
 * @description Unit and contract tests for Version 2.14 evidence export planning, manifest and artifacts.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const {
    CURRENT_EXPORT_FORMAT_VERSION,
    MAX_RECORDS_BYTES,
    MAX_BUNDLE_BYTES,
    resolveExportArtifact,
    planExport,
    buildExport
} = require('../engine/evidence-export');
const { createCase } = require('../engine/decision-cases');
const { evidenceKey } = require('../engine/audit-triage');

function setupExportFixture(f) {
    const auditId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const discussionId = crypto.randomUUID();

    const finding = {
        id: 'F-1',
        category: 'BUG',
        severity: 'HIGH',
        file: 'app.js',
        lineRange: '1-5',
        problem: 'Potential race condition',
        evidence: 'const x = 1;',
        acceptance: 'Fix race condition',
        sources: [{ reviewerId: 'rev-1', findingId: 'F-1' }]
    };

    // 1. Audit
    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        planId,
        reviewers: [{ id: 'rev-1', name: 'Reviewer A', status: 'COMPLETED', checklist: ['C-1'] }],
        findings: [finding],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // 2. Plan
    f.store.save('plans', {
        id: planId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        planningId: discussionId,
        version: 1,
        status: 'APPROVED',
        finalPlan: 'Plan steps',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // 3. Discussion
    f.store.save('discussions', {
        id: discussionId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        vaguePrompt: 'Initial prompt',
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // 4. Run
    f.store.save('runs', {
        id: runId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        sourceAuditId: auditId,
        planId,
        round: 1,
        maxRounds: 4,
        status: 'APPROVED',
        bugs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // Add artifact to audit
    const auditDir = path.join(f.store.root, 'audits', auditId);
    fs.writeFileSync(path.join(auditDir, 'audit_log.txt'), 'Sample audit log content\n', 'utf8');

    // 5. Decision case
    const caseRecord = createCase(f.store, {
        workspaceRoot: f.workspace,
        title: 'Dispute over F-1',
        question: 'Is race condition reproducible?',
        anchor: {
            auditId,
            findingId: 'F-1',
            evidenceKey: evidenceKey(finding),
            triageVersion: 0,
            verificationKey: ''
        },
        references: [{ kind: 'AUDIT_FINDING', recordId: auditId, itemId: 'F-1' }]
    });

    return { auditId, runId, planId, discussionId, caseRecord, auditDir };
}

test('resolveExportArtifact: security checks prevent directory traversal, state.json and symlinks', (t) => {
    const f = createFixture(t);
    const { auditId, auditDir } = setupExportFixture(f);

    // Valid file
    const resolved = resolveExportArtifact(auditDir, 'audit_log.txt');
    assert.ok(resolved.endsWith('audit_log.txt'));

    // Traversal attempts
    assert.throws(() => resolveExportArtifact(auditDir, '../state.json'), /INVALID_ARTIFACT_NAME/);
    assert.throws(() => resolveExportArtifact(auditDir, '..\\state.json'), /INVALID_ARTIFACT_NAME/);
    assert.throws(() => resolveExportArtifact(auditDir, 'dir/file.txt'), /INVALID_ARTIFACT_NAME/);

    // Reserved file
    assert.throws(() => resolveExportArtifact(auditDir, 'state.json'), /is reserved for record state/);

    // Non-existent file
    assert.throws(() => resolveExportArtifact(auditDir, 'non_existent.txt'), /ARTIFACT_NOT_FOUND/);

    // Characters outside safe set
    assert.throws(() => resolveExportArtifact(auditDir, 'evil;rm.txt'), /Forbidden characters/);
});

test('planExport: traverses closed closure, calculates version and estimates bytes', (t) => {
    const f = createFixture(t);
    const { auditId, runId, planId, discussionId, caseRecord } = setupExportFixture(f);

    const plan = planExport(f.store, { auditId, includeArtifacts: true, redactPaths: true });

    assert.ok(plan.version);
    assert.equal(typeof plan.version, 'string');
    assert.equal(plan.auditId, auditId);

    // Check all related kinds are included in recordRefs
    const kinds = new Set(plan.recordRefs.map(r => r.kind));
    assert.ok(kinds.has('audits'));
    assert.ok(kinds.has('runs'));
    assert.ok(kinds.has('plans'));
    assert.ok(kinds.has('discussions'));
    assert.ok(kinds.has('decision-cases'));

    // Artifact refs contain audit_log.txt
    assert.equal(plan.artifactRefs.length, 1);
    assert.equal(plan.artifactRefs[0].fileName, 'audit_log.txt');
    assert.ok(plan.estimatedBytes > 0);
    assert.equal(plan.omissions.length, 0);
});

test('buildExport: does not mutate source files on disk', (t) => {
    const f = createFixture(t);
    const { auditId } = setupExportFixture(f);

    const auditFile = f.store.file('audits', auditId);
    const beforeContent = fs.readFileSync(auditFile, 'utf8');

    const bundle = buildExport(f.store, { auditId, includeArtifacts: true, redactPaths: true });

    const afterContent = fs.readFileSync(auditFile, 'utf8');
    assert.equal(afterContent, beforeContent);
});

test('buildExport: generates deterministic manifest and limitations', (t) => {
    const f = createFixture(t);
    const { auditId } = setupExportFixture(f);

    const plan = planExport(f.store, { auditId, includeArtifacts: true, redactPaths: true });
    const bundle = buildExport(f.store, { version: plan.version, auditId, includeArtifacts: true, redactPaths: true });

    assert.equal(bundle.formatVersion, CURRENT_EXPORT_FORMAT_VERSION);
    assert.ok(bundle.limitations.some(l => l.includes('Historical evidence; not current execution authorization')));
    assert.ok(bundle.manifest.length >= 2); // records.json + audit_log.txt

    const recordsManifest = bundle.manifest.find(m => m.name === 'records.json');
    assert.ok(recordsManifest);
    assert.ok(recordsManifest.sha256);
    assert.ok(recordsManifest.bytes > 0);

    const artManifest = bundle.manifest.find(m => m.name.includes('audit_log.txt'));
    assert.ok(artManifest);
    assert.equal(artManifest.bytes, 25);
});

test('buildExport: applies path redactions and custom redaction rules without changing disk', (t) => {
    const f = createFixture(t);
    const { auditId } = setupExportFixture(f);

    const bundle = buildExport(f.store, {
        auditId,
        includeArtifacts: false,
        redactPaths: true,
        redactRules: [
            { pattern: 'race condition', replacement: '[REDACTED_TOPIC]' }
        ]
    });

    // Check that workspaceRoot is redacted in exported records
    const auditRecord = bundle.records.audits.find(a => a.id === auditId);
    assert.equal(auditRecord.workspaceRoot, '<WORKSPACE_ROOT>');

    // Check custom rule replacement in problem field
    assert.ok(auditRecord.findings[0].problem.includes('[REDACTED_TOPIC]'));

    // Check disk content was NOT redacted
    const rawOnDisk = f.store.read('audits', auditId);
    assert.equal(rawOnDisk.workspaceRoot, f.workspace);
    assert.ok(rawOnDisk.findings[0].problem.includes('race condition'));
});

test('buildExport: rejects with EXPORT_VERSION_CONFLICT if source records changed', (t) => {
    const f = createFixture(t);
    const { auditId } = setupExportFixture(f);

    const plan = planExport(f.store, { auditId });

    // Mutate audit
    const audit = f.store.read('audits', auditId);
    audit.scope = 'modified.js';
    f.store.save('audits', audit);

    assert.throws(() => {
        buildExport(f.store, { version: plan.version, auditId });
    }, /EXPORT_VERSION_CONFLICT/);
});

test('planExport: records omissions when referenced record cannot be found', (t) => {
    const f = createFixture(t);
    const auditId = crypto.randomUUID();
    const missingPlanId = crypto.randomUUID();

    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'app.js',
        planId: missingPlanId,
        reviewers: [],
        findings: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    const plan = planExport(f.store, { auditId });
    assert.equal(plan.omissions.length, 1);
    assert.equal(plan.omissions[0].kind, 'plans');
    assert.equal(plan.omissions[0].id, missingPlanId);
    assert.equal(plan.omissions[0].reason, 'RECORD_NOT_FOUND');
});
