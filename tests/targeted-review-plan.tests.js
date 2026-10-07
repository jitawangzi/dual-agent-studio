'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
    buildTargetedPlan,
    parseScopePatterns,
    fileMatchesPattern,
    DEFAULT_EXPANSION_RULES
} = require('../engine/targeted-review-plan');

function createManifest(files, { snapshot = 'snap-1', workspaceKey = 'ws-test' } = {}) {
    const entries = files.map(f => {
        const p = typeof f === 'string' ? f : f.path;
        const sha256 = typeof f === 'object' && f.sha256 ? f.sha256 : crypto.createHash('sha256').update(p).digest('hex');
        const size = typeof f === 'object' && f.size !== undefined ? f.size : 100;
        return {
            path: p,
            kind: 'file',
            mode: 33188,
            size,
            sha256
        };
    }).sort((a, b) => a.path.localeCompare(b.path));

    return {
        version: 1,
        workspaceKey,
        snapshot,
        entries,
        complete: true,
        exclusions: []
    };
}

test('scope pattern parsing and file matching', () => {
    assert.deepEqual(parseScopePatterns('engine/'), ['engine/']);
    assert.deepEqual(parseScopePatterns('engine/, tests/'), ['engine/', 'tests/']);
    assert.deepEqual(parseScopePatterns('public/audit.js; public/app.js'), ['public/audit.js', 'public/app.js']);
    // CJK and natural language texts are ignored as path scopes
    assert.deepEqual(parseScopePatterns('自有源码、测试和配置'), []);
    assert.deepEqual(parseScopePatterns('全量审核'), []);

    assert.equal(fileMatchesPattern('engine/workflow.js', 'engine/'), true);
    assert.equal(fileMatchesPattern('engine/workflow.js', 'engine'), true);
    assert.equal(fileMatchesPattern('engine/workflow.js', 'engine/workflow.js'), true);
    assert.equal(fileMatchesPattern('engine/workflow.js', 'engine/*.js'), true);
    assert.equal(fileMatchesPattern('public/app.js', 'engine/'), false);
    assert.equal(fileMatchesPattern('tests/targeted.tests.js', 'tests/*.tests.js'), true);
    assert.equal(fileMatchesPattern('tests/unit/targeted.tests.js', 'tests/*.tests.js'), false);
    assert.equal(fileMatchesPattern('tests/unit/targeted.tests.js', 'tests/**/*.tests.js'), true);
});

test('buildTargetedPlan: clean path matching assigns tasks to correct reviewers', () => {
    const manifestBefore = createManifest(['engine/runner.js', 'public/app.js'], { snapshot: 'snap-1' });
    const manifestAfter = createManifest([
        { path: 'engine/runner.js', sha256: 'new-hash' },
        'public/app.js'
    ], { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-1',
        manifest: manifestBefore,
        reviewers: [
            { id: 'rev-engine', name: '后端审核员', scope: 'engine/' },
            { id: 'rev-ui', name: '前端审核员', scope: 'public/' }
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan.baseAuditId, 'audit-1');
    assert.equal(plan.requiresFullAudit, false);
    assert.equal(plan.reasons.length, 0);
    assert.deepEqual(plan.changedFiles, ['engine/runner.js']);
    assert.equal(plan.uncoveredScopes.length, 0);

    // Only rev-engine should have a proposed task
    assert.equal(plan.proposedTasks.length, 1);
    const task = plan.proposedTasks[0];
    assert.equal(task.reviewerId, 'rev-engine');
    assert.equal(task.checklist.length, 1);
    assert.match(task.checklist[0], /复查变更文件: engine\/runner\.js/);
    assert.ok(plan.version);
    assert.equal(plan.estimatedAttempts.minimumAttempts, 1);
});

test('buildTargetedPlan: unassigned changed files trigger requiresFullAudit and record uncoveredScopes', () => {
    const manifestBefore = createManifest(['src/core.js', 'unknown/extra.js'], { snapshot: 'snap-1' });
    const manifestAfter = createManifest([
        { path: 'src/core.js', sha256: 'h1' },
        { path: 'unknown/extra.js', sha256: 'h2' }
    ], { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-2',
        reviewers: [
            { id: 'rev-core', name: 'Core Reviewer', scope: 'src/' }
            // No reviewer for unknown/
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan.requiresFullAudit, true);
    assert.ok(plan.reasons.some(r => r.includes('UNCOVERED_SCOPES')));
    assert.equal(plan.uncoveredScopes.length, 1);
    assert.equal(plan.uncoveredScopes[0].path, 'unknown/extra.js');
    assert.equal(plan.uncoveredScopes[0].reason, 'NO_MATCHING_REVIEWER_SCOPE');

    // rev-core still gets proposed task for src/core.js
    assert.equal(plan.proposedTasks.length, 1);
    assert.equal(plan.proposedTasks[0].reviewerId, 'rev-core');
});

test('buildTargetedPlan: public APIs and migrations trigger requiresFullAudit', () => {
    const manifestBefore = createManifest(['db/migrations/001.sql', 'routes/api.js'], { snapshot: 'snap-1' });
    const manifestAfter = createManifest([
        { path: 'db/migrations/001.sql', sha256: 'm-new' },
        { path: 'routes/api.js', sha256: 'r-new' }
    ], { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-3',
        reviewers: [
            { id: 'rev-db', name: 'DB Reviewer', scope: 'db/' },
            { id: 'rev-api', name: 'API Reviewer', scope: 'routes/' }
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan.requiresFullAudit, true);
    assert.ok(plan.reasons.some(r => r.includes('MIGRATION_FILE_CHANGED')));
    assert.ok(plan.reasons.some(r => r.includes('PUBLIC_API_CHANGED')));
});

test('buildTargetedPlan: deleted files retain open issues and trigger requiresFullAudit', () => {
    const manifestBefore = createManifest(['src/old-feature.js', 'src/keep.js'], { snapshot: 'snap-1' });
    const manifestAfter = createManifest(['src/keep.js'], { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-4',
        reviewers: [
            { id: 'rev-src', name: 'Src Reviewer', scope: 'src/' }
        ],
        findings: [
            {
                id: 'F-101',
                file: 'src/old-feature.js',
                problem: 'Memory leak in listener',
                acceptance: 'Clean up listener on dispose',
                category: 'BUG',
                severity: 'HIGH',
                state: 'REPAIR'
            }
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan.requiresFullAudit, true);
    assert.ok(plan.reasons.some(r => r.includes('DELETED_FILES_DETECTED')));
    assert.deepEqual(plan.changedFiles, ['src/old-feature.js']);

    // Issue on deleted file MUST be included in the review task!
    assert.equal(plan.proposedTasks.length, 1);
    const task = plan.proposedTasks[0];
    assert.ok(task.sourceFindingIds.includes('F-101'));
    assert.ok(task.checklist.some(item => item.includes('F-101') && item.includes('文件已删除')));
});

test('buildTargetedPlan: unclosed issues and expired-evidence bugs are included', () => {
    const manifestBefore = createManifest(['src/worker.js'], { snapshot: 'snap-1' });
    const manifestAfter = createManifest([
        { path: 'src/worker.js', sha256: 'worker-new' }
    ], { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-5',
        reviewers: [
            { id: 'rev-worker', name: 'Worker Reviewer', scope: 'src/worker.js' }
        ],
        findings: [
            {
                id: 'F-OPEN',
                file: 'src/worker.js',
                problem: 'Concurrency race in queue',
                acceptance: 'Add mutex guard',
                category: 'BUG',
                severity: 'CRITICAL',
                state: 'REPAIR'
            },
            {
                id: 'F-EXPIRED-BUG',
                file: 'src/worker.js',
                problem: 'Uncaught promise rejection',
                acceptance: 'Add catch block',
                category: 'BUG',
                severity: 'MEDIUM',
                state: 'CLOSED',
                snapshot: 'snap-0' // Old snapshot != snap-2
            },
            {
                id: 'F-DISMISSED',
                file: 'src/worker.js',
                problem: 'Code style issue',
                category: 'SUGGESTION',
                severity: 'LOW',
                state: 'DISMISSED'
            }
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan.proposedTasks.length, 1);
    const task = plan.proposedTasks[0];
    assert.ok(task.sourceFindingIds.includes('F-OPEN'), 'Must include open finding');
    assert.ok(task.sourceFindingIds.includes('F-EXPIRED-BUG'), 'Must include expired proof bug');
    assert.equal(task.sourceFindingIds.includes('F-DISMISSED'), false, 'Must exclude dismissed finding');
    assert.equal(task.checklist.length, 3); // 1 file change + 2 findings
});

test('buildTargetedPlan: splits tasks into explicit batches when checklist exceeds 20 items', () => {
    // Generate 25 changed files for a single reviewer
    const files = Array.from({ length: 25 }, (_, i) => `engine/file_${i + 1}.js`);
    const manifestBefore = createManifest(files, { snapshot: 'snap-1' });
    const manifestAfter = createManifest(files.map(f => ({ path: f, sha256: 'h_' + f })), { snapshot: 'snap-2' });

    const audit = {
        id: 'audit-batch',
        reviewers: [
            { id: 'rev-engine', name: 'Engine Reviewer', scope: 'engine/' }
        ]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    // 25 changed files exceeds 20 threshold, so compareManifests triggers LARGE_CHANGE_SET
    assert.equal(plan.requiresFullAudit, true);
    assert.ok(plan.reasons.some(r => r.includes('LARGE_CHANGE_SET')));

    // Must be split into 2 batches without dropping any items!
    assert.equal(plan.proposedTasks.length, 2);
    const batch1 = plan.proposedTasks[0];
    const batch2 = plan.proposedTasks[1];

    assert.equal(batch1.batch, 1);
    assert.equal(batch1.totalBatches, 2);
    assert.equal(batch1.checklist.length, 20);

    assert.equal(batch2.batch, 2);
    assert.equal(batch2.totalBatches, 2);
    assert.equal(batch2.checklist.length, 5);

    // Sum of items is exactly 25
    assert.equal(batch1.checklist.length + batch2.checklist.length, 25);

    // Estimate execution must count both batches as separate tasks
    assert.equal(plan.estimatedAttempts.minimumAttempts, 2);
    assert.equal(plan.estimatedAttempts.maximumAttempts, 4);
});

test('buildTargetedPlan: missing base manifest triggers requiresFullAudit gracefully', () => {
    const manifestAfter = createManifest(['src/main.js'], { snapshot: 'snap-target' });
    const audit = {
        id: 'audit-no-base',
        reviewers: [{ id: 'rev-main', name: 'Main', scope: 'src/' }]
    };

    const plan = buildTargetedPlan({ audit, manifestBefore: null, manifestAfter });

    assert.equal(plan.requiresFullAudit, true);
    assert.ok(plan.reasons.some(r => r.includes('NO_BASE_MANIFEST')));
    assert.deepEqual(plan.changedFiles, ['src/main.js']);
    assert.equal(plan.proposedTasks.length, 1);
});

test('buildTargetedPlan: deterministic version calculation', () => {
    const manifestBefore = createManifest(['src/app.js'], { snapshot: 's1' });
    const manifestAfter = createManifest([{ path: 'src/app.js', sha256: 's2-hash' }], { snapshot: 's2' });
    const audit = {
        id: 'audit-det',
        reviewers: [{ id: 'rev-app', name: 'App', scope: 'src/' }]
    };

    const plan1 = buildTargetedPlan({ audit, manifestBefore, manifestAfter });
    const plan2 = buildTargetedPlan({ audit, manifestBefore, manifestAfter });

    assert.equal(plan1.version, plan2.version);

    // Modify manifestAfter slightly, version must change
    const manifestAfter2 = createManifest([{ path: 'src/app.js', sha256: 's3-hash' }], { snapshot: 's3' });
    const plan3 = buildTargetedPlan({ audit, manifestBefore, manifestAfter: manifestAfter2 });
    assert.notEqual(plan1.version, plan3.version);
});
