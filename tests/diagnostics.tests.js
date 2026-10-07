/**
 * @file diagnostics.tests.js
 * @author shuyongqiang
 * @description Unit tests for storage overview scan and sanitized diagnostic packaging.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFixture } = require('./helpers/studio-fixture');
const { getStorageOverview, buildDiagnosticPackage } = require('../engine/diagnostics');
const { applyArchive } = require('../engine/record-archive');

test('getStorageOverview: aggregates metrics across record kinds and attachments', (t) => {
    const f = createFixture(t);
    const auditId = crypto.randomUUID();

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

    // Add an attachment file
    const auditDir = path.join(f.store.root, 'audits', auditId);
    fs.writeFileSync(path.join(auditDir, 'evidence.txt'), 'Evidence payload\n', 'utf8');

    // Archive this audit
    applyArchive(f.store, { auditId });

    const overview = getStorageOverview(f.store);

    assert.ok(overview.scannedAt);
    assert.equal(overview.summary.totalRecords >= 1, true);
    assert.equal(overview.summary.totalArchived >= 1, true);
    assert.equal(overview.summary.totalAttachmentFiles >= 1, true);
    assert.equal(overview.summary.totalAttachmentBytes >= 16, true);
    assert.equal(overview.byKind.audits.validCount, 1);
    assert.equal(overview.byKind.audits.archivedCount, 1);
    assert.equal(overview.byKind.audits.attachmentFiles, 1);
});

test('buildDiagnosticPackage: returns sanitized system and storage diagnostics', (t) => {
    const f = createFixture(t);
    const pkg = buildDiagnosticPackage(f.store);

    assert.equal(pkg.formatVersion, 1);
    assert.ok(pkg.system.nodeVersion);
    assert.ok(pkg.system.platform);
    assert.ok(pkg.storage.summary);
    assert.ok(pkg.redactionNotice.includes('Sanitized'));

    // Verify secrets and env vars are NOT exposed
    assert.equal(pkg.system.env, undefined);
    assert.equal(pkg.system.API_KEY, undefined);
});
