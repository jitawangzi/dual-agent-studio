'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFixture, copyV0Fixtures } = require('./helpers/studio-fixture');
const { normalizeRecord, validateRecord, CURRENT_STORAGE_VERSION } = require('../engine/storage-schema');
const { planMigration, applyMigration } = require('../engine/storage-migration');

test('normalizeRecord handles missing version, rejects future version, and never mutates input', () => {
    const raw = {
        id: crypto.randomUUID(),
        feature: 'TestFeature',
        workspaceRoot: '/test',
        workspaceKey: '/test'
    };
    const rawBefore = JSON.stringify(raw);
    const normalized = normalizeRecord('audits', raw);

    assert.equal(normalized.storageVersion, 0);
    assert.equal(normalized.id, raw.id);
    assert.equal(JSON.stringify(raw), rawBefore, 'Input must not be mutated');

    const future = {
        id: crypto.randomUUID(),
        storageVersion: 99
    };
    assert.throws(() => normalizeRecord('audits', future), /UNSUPPORTED_STORAGE_VERSION/);

    const invalid = {
        id: crypto.randomUUID(),
        storageVersion: -1
    };
    assert.throws(() => normalizeRecord('audits', invalid), /INVALID_STORAGE_VERSION/);
});

test('validateRecord detects valid records and reports missing or invalid fields', () => {
    const valid = {
        id: crypto.randomUUID(),
        workspaceRoot: '/test',
        workspaceKey: '/test',
        createdAt: new Date().toISOString(),
        status: 'COMPLETED',
        storageVersion: 1
    };
    const res = validateRecord('audits', valid);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);

    const missingId = {
        workspaceRoot: '/test',
        workspaceKey: '/test',
        createdAt: new Date().toISOString()
    };
    const res2 = validateRecord('audits', missingId);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some(e => e.path === 'id'));

    const badVersion = {
        ...valid,
        storageVersion: 999
    };
    const res3 = validateRecord('audits', badVersion);
    assert.equal(res3.ok, false);
    assert.ok(res3.errors.some(e => e.path === 'storageVersion'));
});

test('RunStore.listWithDiagnostics reports corrupted files without dropping healthy records', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    // Write a corrupted file into an audit record directory
    const corruptId = 'a0000000-0000-0000-0000-000000000099';
    const corruptDir = path.join(f.root, 'state', 'audits', corruptId);
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'state.json'), '{corrupted: json syntax error', 'utf8');

    // Standard list() skips corrupted record silently
    const normalList = f.store.list('audits', f.workspace);
    assert.ok(normalList.length >= 1);
    assert.ok(!normalList.some(r => r.id === corruptId));

    // listWithDiagnostics() returns both valid records and diagnostic errors
    const diag = f.store.listWithDiagnostics('audits', f.workspace);
    assert.ok(Array.isArray(diag.records));
    assert.ok(Array.isArray(diag.errors));
    assert.equal(diag.records.length, normalList.length);
    assert.ok(diag.errors.some(e => e.id === corruptId && e.kind === 'audits'));
});

test('planMigration discovers v0 records, generates deterministic version, and does not alter disk', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const plan1 = planMigration(f.store);
    assert.ok(typeof plan1.version === 'string' && plan1.version.length === 64);
    assert.ok(plan1.entries.length >= 4); // audits, runs, plans, discussions
    assert.ok(plan1.entries.every(e => e.from === 0 && e.to === CURRENT_STORAGE_VERSION));
    assert.ok(plan1.entries.every(e => typeof e.beforeHash === 'string' && e.beforeHash.length === 64));

    // Calling planMigration again produces the exact same version
    const plan2 = planMigration(f.store);
    assert.equal(plan2.version, plan1.version);
    assert.equal(plan2.entries.length, plan1.entries.length);
});

test('applyMigration validates version conflict, creates backup journal, and atomically upgrades records', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    const plan = planMigration(f.store);
    assert.ok(plan.entries.length > 0);

    // Version mismatch throws MIGRATION_VERSION_CONFLICT
    assert.throws(() => applyMigration(f.store, { version: 'wrong-hash' }), /MIGRATION_VERSION_CONFLICT/);

    // Apply migration
    const result = applyMigration(f.store, { version: plan.version });
    assert.equal(result.migrated, plan.entries.length);
    assert.ok(fs.existsSync(result.backupDir));

    // Verify backup journal
    const journalPath = path.join(result.backupDir, 'journal.json');
    assert.ok(fs.existsSync(journalPath));
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.version, plan.version);
    assert.equal(journal.status, 'COMPLETED');

    // Verify each record on disk now has storageVersion = 1 and retained fields
    for (const entry of plan.entries) {
        const upgraded = f.store.read(entry.kind, entry.id);
        assert.equal(upgraded.storageVersion, CURRENT_STORAGE_VERSION);
        assert.ok(upgraded.createdAt);
        assert.ok(upgraded.updatedAt);
        // Verify backup copy exists
        const backupCopy = path.join(result.backupDir, entry.kind, entry.id, 'state.json');
        assert.ok(fs.existsSync(backupCopy));
    }

    // Verify approval hash on plans was preserved
    const planRec = f.store.read('plans', 'c0000000-0000-0000-0000-000000000001');
    assert.equal(planRec.approval.hash, '2ca62e2588becb738c420c2e2d5189d61ee2089d7f8ebd4cc53831babf65f8f6');

    // Subsequent planMigration returns 0 entries
    const postPlan = planMigration(f.store);
    assert.equal(postPlan.entries.length, 0);
});

test('future storageVersion is rejected on store.save', (t) => {
    const f = createFixture(t);
    const futureRecord = {
        id: crypto.randomUUID(),
        feature: 'FutureFeature',
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        storageVersion: 99
    };
    assert.throws(() => f.store.save('audits', futureRecord), /UNSUPPORTED_STORAGE_VERSION/);
});

test('migration preserves attachments and historical human acceptance is not falsely certified', (t) => {
    const f = createFixture(t);
    copyV0Fixtures(f.store, f.workspace, f.workspaceKey);

    // Create an attachment in audit directory
    const auditId = 'a0000000-0000-0000-0000-000000000001';
    const attachmentPath = path.join(f.root, 'state', 'audits', auditId, 'rev-1.response.txt');
    fs.writeFileSync(attachmentPath, 'Raw reviewer output...', 'utf8');

    // Add a historical closureAcceptance that matched old state
    const audit = f.store.read('audits', auditId);
    audit.closureAcceptances = [{
        id: crypto.randomUUID(),
        version: 'old-version-digest',
        snapshot: 'snap-v1',
        note: 'Old note',
        acceptedAt: '2026-10-01T12:00:00Z'
    }];
    f.store.save('audits', audit);

    // Apply migration
    const plan = planMigration(f.store);
    const res = applyMigration(f.store, { version: plan.version });
    assert.ok(res.migrated > 0);

    // Verify attachment still exists untouched
    assert.ok(fs.existsSync(attachmentPath));
    assert.equal(fs.readFileSync(attachmentPath, 'utf8'), 'Raw reviewer output...');

    // Verify draft.json for discussions also exists untouched
    const discDraft = path.join(f.root, 'state', 'discussions', 'd0000000-0000-0000-0000-000000000001', 'draft.json');
    assert.ok(fs.existsSync(discDraft));

    // Verify closureView on root audit: old acceptance version does NOT match new version digest
    const { closureView } = require('../engine/audit-closure');
    const view = closureView(f.store, auditId, 'snap-v1');
    assert.ok(view.acceptance);
    assert.equal(view.acceptance.current, false, 'Historical acceptance with mismatched version must not be current');
});

test('migration interruption supports same-operation retry, preserves first backup, and leaves single completed journal', (t) => {
    const f = createFixture(t);
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    const raw = (id) => {
        const file = f.store.file('audits', id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            id,
            workspaceRoot: f.workspace,
            workspaceKey: f.workspaceKey,
            storageVersion: 0,
            updatedAt: '2026-01-01T00:00:00Z',
            reviewers: [{ name: 'mock', provider: 'mock' }],
            findings: []
        }));
    };
    raw(id1);
    raw(id2);

    const plan = planMigration(f.store);
    assert.equal(plan.entries.length, 2);

    const originalRename = fs.renameSync;
    let writeCount = 0;
    try {
        fs.renameSync = (from, to) => {
            if (to.endsWith('state.json') && ++writeCount === 2) {
                throw new Error('SIMULATED_DISK_WRITE_FAILURE');
            }
            return originalRename(from, to);
        };
        assert.throws(() => applyMigration(f.store, { version: plan.version }), /SIMULATED_DISK_WRITE_FAILURE/);
    } finally {
        fs.renameSync = originalRename;
    }

    const backupsDir = path.join(f.store.root, 'backups');
    const backupDirs = fs.readdirSync(backupsDir);
    assert.equal(backupDirs.length, 1, 'Exactly one backup directory created');

    const opId = backupDirs[0];
    const journal1 = JSON.parse(fs.readFileSync(path.join(backupsDir, opId, 'journal.json'), 'utf8'));
    assert.equal(journal1.status, 'IN_PROGRESS');

    // Retrying with original preview version resumes the same operation
    const retryRes = applyMigration(f.store, { version: plan.version });
    assert.equal(retryRes.operationId, opId);
    assert.equal(retryRes.migrated, 2);

    // Backup directory count remains 1 (no duplicate backup directories)
    assert.equal(fs.readdirSync(backupsDir).length, 1);
    const journal2 = JSON.parse(fs.readFileSync(path.join(backupsDir, opId, 'journal.json'), 'utf8'));
    assert.equal(journal2.status, 'COMPLETED');

    // Subsequent plan finds 0 pending items
    const finalPlan = planMigration(f.store);
    assert.equal(finalPlan.entries.length, 0);
});

test('applyMigration rejects when corrupted journal exists, preserving opId and blocking empty migration', (t) => {
    const f = createFixture(t);
    const opId = crypto.randomUUID();
    const backupDir = path.join(f.store.root, 'backups', opId);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'journal.json'), '{"operationId":', 'utf8');

    const plan = planMigration(f.store);
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.errors.length, 1);
    assert.equal(plan.errors[0].code, 'CORRUPTED_JOURNAL');
    assert.equal(plan.activeOperationId, opId);

    // applyMigration must not return { migrated: 0 }, but throw CORRUPTED_JOURNAL
    assert.throws(
        () => applyMigration(f.store, { version: plan.version }),
        (err) => {
            assert.ok(err.message.includes('CORRUPTED_JOURNAL'));
            assert.ok(err.message.includes(opId));
            return true;
        }
    );
});

test('applyMigration recovers same operation when all records are migrated but final checkpoint was interrupted', (t) => {
    const f = createFixture(t);
    const id = crypto.randomUUID();
    const file = f.store.file('plans', id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        id,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        storageVersion: 0,
        approval: { id: 'appr' },
        finalPlan: 'test'
    }));

    const plan1 = planMigration(f.store);
    assert.equal(plan1.entries.length, 1);

    // Simulate interruption on final COMPLETED journal atomic write
    const origRename = fs.renameSync;
    let interrupted = false;
    try {
        fs.renameSync = (from, to) => {
            if (String(to).endsWith('journal.json')) {
                const j = JSON.parse(fs.readFileSync(from, 'utf8'));
                if (j.status === 'COMPLETED') {
                    interrupted = true;
                    throw new Error('INJECTED_FINAL_CHECKPOINT_FAILURE');
                }
            }
            return origRename(from, to);
        };
        assert.throws(() => applyMigration(f.store, { version: plan1.version }), /INJECTED_FINAL_CHECKPOINT_FAILURE/);
    } finally {
        fs.renameSync = origRename;
    }
    assert.ok(interrupted);

    // Plan finds 0 pending records, 0 errors, but has activeOperationId
    const plan2 = planMigration(f.store);
    assert.equal(plan2.entries.length, 0);
    assert.equal(plan2.errors.length, 0);
    assert.ok(plan2.activeOperationId);

    // Calling applyMigration recovers the operation and finishes it
    const res = applyMigration(f.store, { version: plan2.version });
    assert.equal(res.operationId, plan2.activeOperationId);
    assert.equal(res.migrated, 1);

    // After recovery, activeOperationId is cleared
    const plan3 = planMigration(f.store);
    assert.equal(plan3.activeOperationId, null);
    assert.equal(plan3.entries.length, 0);
});
