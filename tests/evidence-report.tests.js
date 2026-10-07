/**
 * @file evidence-report.tests.js
 * @author shuyongqiang
 * @description Unit tests for offline HTML report rendering, XSS sanitization, and bundle validation.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const { buildExport } = require('../engine/evidence-export');
const { validateImportedBundle, renderReport, escapeHtml } = require('../engine/evidence-report');

function setupTestBundle(f, customFindings = []) {
    const auditId = crypto.randomUUID();
    f.store.save('audits', {
        id: auditId,
        storageVersion: 1,
        workspaceRoot: f.workspace,
        workspaceKey: f.workspaceKey,
        status: 'COMPLETED',
        scope: 'index.js',
        reviewers: [{ id: 'rev-1', name: 'Security Auditor', status: 'COMPLETED' }],
        findings: customFindings.length ? customFindings : [{
            id: 'F-1',
            category: 'BUG',
            severity: 'HIGH',
            file: 'index.js',
            lineRange: '10-20',
            problem: 'SQL injection vulnerability',
            evidence: 'select * from users where id = ' + 1,
            acceptance: 'Use prepared statements'
        }],
        triage: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    return buildExport(f.store, { auditId, includeArtifacts: false, redactPaths: true });
}

test('validateImportedBundle: accepts valid bundle with correct manifest', (t) => {
    const f = createFixture(t);
    const bundle = setupTestBundle(f);

    const validation = validateImportedBundle(bundle);
    assert.equal(validation.ok, true);
    assert.equal(validation.manifestValid, true);
    assert.equal(validation.errors.length, 0);
});

test('validateImportedBundle: detects tampering in records and artifacts', (t) => {
    const f = createFixture(t);
    const bundle = setupTestBundle(f);

    // Tamper with a finding
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.records.audits[0].findings[0].problem = 'TAMPERED TEXT';

    const validation = validateImportedBundle(tampered);
    assert.equal(validation.ok, false);
    assert.equal(validation.manifestValid, false);
    assert.ok(validation.manifestErrors.some(e => e.includes('RECORDS_SHA256_MISMATCH')));
});

test('validateImportedBundle: rejects future formatVersion and missing fields', (t) => {
    const f = createFixture(t);
    const bundle = setupTestBundle(f);

    // Future version
    const futureVer = { ...bundle, formatVersion: 99 };
    const v1 = validateImportedBundle(futureVer);
    assert.equal(v1.ok, false);
    assert.ok(v1.errors.some(e => e.includes('UNSUPPORTED_FORMAT_VERSION')));

    // Missing manifest
    const noManifest = { ...bundle, manifest: [] };
    const v2 = validateImportedBundle(noManifest);
    assert.equal(v2.ok, false);
    assert.ok(v2.errors.some(e => e.includes('INVALID_OR_MISSING_MANIFEST')));

    // Missing auditId
    const noAudit = { ...bundle, auditId: 'not-a-uuid' };
    const v3 = validateImportedBundle(noAudit);
    assert.equal(v3.ok, false);
    assert.ok(v3.errors.some(e => e.includes('INVALID_OR_MISSING_AUDIT_ID')));
});

test('renderReport: generates valid offline HTML with CSP and safe escaping', (t) => {
    const f = createFixture(t);
    const xssPayloads = [
        {
            id: 'F-XSS-1',
            category: 'BUG',
            severity: 'CRITICAL',
            file: '<script>alert("xss")</script>.js',
            lineRange: '<img src=x onerror=alert(1)>',
            problem: 'Malicious payload in problem <iframe src="javascript:evil()">',
            evidence: '"><svg onload=alert(document.cookie)>',
            acceptance: 'Fix: <a href="javascript:alert(1)">Click</a>'
        }
    ];

    const bundle = setupTestBundle(f, xssPayloads);
    const html = renderReport(bundle);

    // Assert strict CSP
    assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; img-src data:; base-uri \'none\';">'));

    // Assert XSS payloads are strictly escaped
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));

    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));

    assert.ok(!html.includes('<iframe src="javascript:evil()">'));
    assert.ok(html.includes('&lt;iframe src=&quot;javascript:evil()&quot;&gt;'));

    assert.ok(!html.includes('<svg onload=alert(document.cookie)>'));
    assert.ok(html.includes('&lt;svg onload=alert(document.cookie)&gt;'));

    // Assert read-only historical evidence warnings are present
    assert.ok(html.includes('外部历史报告（离线只读），当前源码有效性未知'));
    assert.ok(html.includes('不构成当前工程执行授权'));
    assert.ok(html.includes('Manifest'));
});
