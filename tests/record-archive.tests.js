/**
 * @file record-archive.tests.js
 * @author shuyongqiang
 * @description Unit tests for logical record archiving and idempotent restoration.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const {
    previewArchive,
    applyArchive,
    restoreArchive,
    getArchivedRecordSet,
    listArchives
} = require('../engine/record-archive');

function setupArchiveScenario(f) {
    const auditId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'server.js',
        reviewers: [],
        findings: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    f.store.save('runs', {
        id: runId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        sourceAuditId: auditId,
        round: 1,
        maxRounds: 3,
        status: 'APPROVED',
        bugs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    return { auditId, runId };
}

test('previewArchive & applyArchive: previews associated group and archives idempotently', (t) => {
    const f = createFixture(t);
    const { auditId, runId } = setupArchiveScenario(f);

    const preview = previewArchive(f.store, { auditId });
    assert.equal(preview.auditId, auditId);
    assert.equal(preview.blockers.length, 0);
    assert.ok(preview.recordRefs.some(r => r.kind === 'audits' && r.id === auditId));
    assert.ok(preview.recordRefs.some(r => r.kind === 'runs' && r.id === runId));

    // Apply archive
    const group1 = applyArchive(f.store, { version: preview.version, auditId, note: 'Sprint cleanup' });
    assert.ok(group1.id);
    assert.equal(group1.isArchived, true);
    assert.equal(group1.note, 'Sprint cleanup');

    // Records are in archived set
    const set1 = getArchivedRecordSet(f.store);
    assert.ok(set1.has(`audits:${auditId}`));
    assert.ok(set1.has(`runs:${runId}`));

    // Original files remain readable on disk
    const readAudit = f.store.read('audits', auditId);
    assert.equal(readAudit.id, auditId);

    // Second call is idempotent
    const group2 = applyArchive(f.store, { auditId });
    assert.equal(group2.id, group1.id);
});

test('restoreArchive: restores archived group idempotently and clears from archived set', (t) => {
    const f = createFixture(t);
    const { auditId, runId } = setupArchiveScenario(f);

    const group = applyArchive(f.store, { auditId, note: 'To be restored' });
    assert.ok(getArchivedRecordSet(f.store).has(`audits:${auditId}`));

    // Restore
    const restored = restoreArchive(f.store, { archiveId: group.id });
    assert.equal(restored.isArchived, false);
    assert.ok(restored.restoredAt);

    // Set no longer contains records
    const set2 = getArchivedRecordSet(f.store);
    assert.equal(set2.has(`audits:${auditId}`), false);
    assert.equal(set2.has(`runs:${runId}`), false);

    // Repeating restore is idempotent
    const restored2 = restoreArchive(f.store, { archiveId: group.id });
    assert.equal(restored2.id, group.id);
    assert.equal(restored2.isArchived, false);
});

test('previewArchive: blocks archiving when active task or run is executing', (t) => {
    const f = createFixture(t);
    const { auditId, runId } = setupArchiveScenario(f);

    // Set run to RUNNING
    const run = f.store.read('runs', runId);
    run.status = 'RUNNING';
    f.store.save('runs', run);

    const preview = previewArchive(f.store, { auditId });
    assert.ok(preview.blockers.length > 0);
    assert.ok(preview.blockers.some(b => b.includes('ACTIVE_RUN_CONFLICT')));

    // Attempting apply throws ARCHIVE_BLOCKED
    assert.throws(() => {
        applyArchive(f.store, { auditId });
    }, /ARCHIVE_BLOCKED/);
});

test('applyArchive: rejects with ARCHIVE_VERSION_CONFLICT if records change after preview', (t) => {
    const f = createFixture(t);
    const { auditId } = setupArchiveScenario(f);

    const preview = previewArchive(f.store, { auditId });

    // Mutate audit
    const audit = f.store.read('audits', auditId);
    audit.scope = 'new_scope.js';
    f.store.save('audits', audit);

    assert.throws(() => {
        applyArchive(f.store, { version: preview.version, auditId });
    }, /ARCHIVE_VERSION_CONFLICT/);
});
