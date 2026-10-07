'use strict';
/**
 * 2.11 Task 4: Execution Estimate unit tests.
 * @author shuyongqiang
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateExecution } = require('../engine/execution-estimate');

test('estimateExecution: run workflow estimates attempts and returns assumptions', () => {
    // Default config
    const estDefault = estimateExecution('run', {});
    assert.equal(estDefault.minimumAttempts, 2);
    assert.equal(estDefault.maximumAttempts, 4 * (1 + 3 + 1)); // 20
    assert(estDefault.assumptions.length >= 3);

    // Custom rounds and self-heals
    const estCustom = estimateExecution('run', { maxRounds: 2, maxSelfHealAttempts: 1 });
    assert.equal(estCustom.minimumAttempts, 2);
    assert.equal(estCustom.maximumAttempts, 2 * (1 + 1 + 1)); // 6
    assert(estCustom.assumptions.some(a => a.includes('2 轮')));
});

test('estimateExecution: audit workflow estimates attempts for reviewers', () => {
    const est = estimateExecution('audit', {
        reviewers: [
            { id: 'rev-1', provider: 'claude' },
            { id: 'rev-2', provider: 'copilot' },
            { id: 'rev-3', provider: 'codex' }
        ]
    });
    assert.equal(est.minimumAttempts, 3);
    assert.equal(est.maximumAttempts, 6);
    assert(est.assumptions.some(a => a.includes('3 位审核员')));
});

test('estimateExecution: planning workflow estimates attempts for members and rounds', () => {
    const est = estimateExecution('planning', {
        members: [{ id: 'm1' }, { id: 'm2' }],
        rounds: 3
    });
    assert.equal(est.minimumAttempts, 2);
    assert.equal(est.maximumAttempts, 6);
    assert(est.assumptions.some(a => a.includes('最多进行 3 轮')));
});

test('estimateExecution: health probe mode estimates single attempt per provider', () => {
    const est = estimateExecution('health', {
        providers: ['claude', 'copilot']
    });
    assert.equal(est.minimumAttempts, 2);
    assert.equal(est.maximumAttempts, 2);
    assert(est.assumptions.some(a => a.includes('连通性探针')));
});

test('estimateExecution: rejects invalid kind and arguments gracefully', () => {
    assert.throws(() => estimateExecution('invalid-kind'), /UNSUPPORTED_EXECUTION_KIND/);
    assert.throws(() => estimateExecution(null), /INVALID_KIND/);
    assert.throws(() => estimateExecution(''), /INVALID_KIND/);
});
