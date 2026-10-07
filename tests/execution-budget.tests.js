'use strict';
/**
 * 2.11 Task 2: Concurrency-safe execution budget & resource accounting tests.
 * All agent invocations here use Mock injections; zero real API spend.
 * @author shuyongqiang
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./helpers/studio-fixture');
const {
    normalizeBudget,
    ensureBudget,
    reserveAttempt,
    markAttemptStarted,
    settleAttempt,
    cancelReservation,
    remainingBudget,
    adjustBudget,
    startActiveTracking,
    checkpointActiveTracking,
    stopActiveTracking,
    recoverBudget,
    currentActiveSeconds
} = require('../engine/execution-budget');
const { AuditWorkflow } = require('../engine/audit-workflow');
const { Workflow } = require('../engine/workflow');
const { PlanningWorkflow } = require('../engine/planning-workflow');

test('normalizeBudget validates limits and rejects unknown properties, strings, zero and negative numbers', () => {
    assert.deepEqual(normalizeBudget(null), { maxAttempts: null, maxActiveSeconds: null });
    assert.deepEqual(normalizeBudget(undefined), { maxAttempts: null, maxActiveSeconds: null });
    assert.deepEqual(normalizeBudget({}), { maxAttempts: null, maxActiveSeconds: null });
    assert.deepEqual(normalizeBudget({ maxAttempts: 10, maxActiveSeconds: 300 }), { maxAttempts: 10, maxActiveSeconds: 300 });

    // Zero is not infinite; must be positive integer
    assert.throws(() => normalizeBudget({ maxAttempts: 0 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxActiveSeconds: 0 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: -1 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: 1.5 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: '10' }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: NaN }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: 10001 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxActiveSeconds: 86401 }), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget('not an object'), /INVALID_BUDGET/);
    assert.throws(() => normalizeBudget({ maxAttempts: 5, unknownProp: 1 }), /INVALID_BUDGET/);
});

test('reserveAttempt, markAttemptStarted, settleAttempt manage reservation lifecycle and idempotency', () => {
    const record = {};
    ensureBudget(record, { maxAttempts: 2 });
    const r1 = reserveAttempt(record, { stepId: 'step:1' });
    assert.ok(r1);

    const b1 = remainingBudget(record);
    assert.equal(b1.reservedAttempts, 1);
    assert.equal(b1.usedAttempts, 0);
    assert.equal(b1.remainingAttempts, 1);

    // markAttemptStarted is idempotent
    assert.equal(markAttemptStarted(record, r1), true);
    assert.equal(markAttemptStarted(record, r1), false);

    // settleAttempt settles and is idempotent
    assert.equal(settleAttempt(record, r1, { status: 'COMPLETED' }), true);
    assert.equal(settleAttempt(record, r1, { status: 'COMPLETED' }), false);

    const b2 = remainingBudget(record);
    assert.equal(b2.reservedAttempts, 0);
    assert.equal(b2.usedAttempts, 1);
    assert.equal(b2.remainingAttempts, 1);

    // Second reservation and settle as failed (failures still count)
    const r2 = reserveAttempt(record, { stepId: 'step:2' });
    markAttemptStarted(record, r2);
    settleAttempt(record, r2, { status: 'INVALID_RESPONSE' });

    const b3 = remainingBudget(record);
    assert.equal(b3.usedAttempts, 2);
    assert.equal(b3.remainingAttempts, 0);
    assert.equal(b3.exhausted, true);
    assert.equal(b3.reason, 'MAX_ATTEMPTS_EXCEEDED');

    // Third reservation throws BUDGET_EXHAUSTED
    assert.throws(() => reserveAttempt(record, { stepId: 'step:3' }), /BUDGET_EXHAUSTED/);
});

test('concurrent reservation safety: maxAttempts=1 with 2 concurrent workers allows exactly 1 call', async () => {
    const record = {};
    ensureBudget(record, { maxAttempts: 1 });

    let providerCalls = 0;
    const worker = async (id) => {
        let reservationId;
        try {
            reservationId = reserveAttempt(record, { stepId: `worker:${id}` });
        } catch (err) {
            return { id, status: 'REJECTED_BY_BUDGET', error: err.message };
        }
        markAttemptStarted(record, reservationId);
        // Simulate async provider invocation
        await new Promise(r => setTimeout(r, 10));
        providerCalls++;
        settleAttempt(record, reservationId, { status: 'COMPLETED' });
        return { id, status: 'COMPLETED' };
    };

    const results = await Promise.all([worker(1), worker(2)]);
    assert.equal(providerCalls, 1, 'Only 1 provider call must have been made');
    const completed = results.filter(r => r.status === 'COMPLETED');
    const rejected = results.filter(r => r.status === 'REJECTED_BY_BUDGET');
    assert.equal(completed.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].error.includes('BUDGET_EXHAUSTED'));

    const b = remainingBudget(record);
    assert.equal(b.usedAttempts + b.reservedAttempts, 1);
});

test('reservation cancellation: unstarted reservation can be released, started reservation cannot', () => {
    const record = {};
    ensureBudget(record, { maxAttempts: 1 });
    const resId = reserveAttempt(record, { stepId: 'step:cancel' });
    assert.equal(remainingBudget(record).remainingAttempts, 0);

    // Cancel before start frees the quota
    assert.equal(cancelReservation(record, resId, { reason: 'USER_CANCELLED_BEFORE_START' }), true);
    assert.equal(remainingBudget(record).remainingAttempts, 1);

    // Reserve again and start
    const resId2 = reserveAttempt(record, { stepId: 'step:started' });
    markAttemptStarted(record, resId2);
    // Started reservation cannot be cancelled as free quota
    assert.throws(() => cancelReservation(record, resId2, { reason: 'TRY_FREE_QUOTA' }), /CANNOT_CANCEL_STARTED_RESERVATION/);
    settleAttempt(record, resId2, { status: 'STOPPED' });
    assert.equal(remainingBudget(record).usedAttempts, 1);
});

test('active seconds tracking: accumulates across intervals, pauses during idle, checkpoint tracks crash recovery', () => {
    const record = {};
    ensureBudget(record, { maxActiveSeconds: 100 });

    const t0 = 1000000;
    startActiveTracking(record, { nowMs: t0 });
    checkpointActiveTracking(record, { nowMs: t0 + 5000 });
    stopActiveTracking(record, { nowMs: t0 + 10000 });

    assert.equal(currentActiveSeconds(record, t0 + 10000), 10);
    // While idle/stopped, time does not accumulate
    assert.equal(currentActiveSeconds(record, t0 + 50000), 10);

    // Start a second interval that crashes before clean stop
    const t1 = t0 + 60000;
    startActiveTracking(record, { nowMs: t1 });
    checkpointActiveTracking(record, { nowMs: t1 + 3000 });

    // Crash recovery: closes at checkpoint and marks uncertainActiveTime
    const recovered = recoverBudget(record, { nowMs: t1 + 20000 });
    assert.equal(recovered, true);
    assert.equal(record.budget.timeTracking.uncertainActiveTime, true);
    // Total known active seconds: 10 + 3 = 13
    assert.equal(currentActiveSeconds(record), 13);
});

test('adjustBudget enforces 1-10000 char reason, forbids lowering below used attempts or active time, records history', () => {
    const record = {};
    ensureBudget(record, { maxAttempts: 2, maxActiveSeconds: 50 });

    // Consume 2 attempts and 20s
    const r1 = reserveAttempt(record, { stepId: 's1' });
    markAttemptStarted(record, r1);
    settleAttempt(record, r1, { status: 'COMPLETED' });
    const r2 = reserveAttempt(record, { stepId: 's2' });
    markAttemptStarted(record, r2);
    settleAttempt(record, r2, { status: 'COMPLETED' });

    startActiveTracking(record, { nowMs: 10000 });
    stopActiveTracking(record, { nowMs: 30000 }); // 20s

    assert.throws(() => adjustBudget(record, { maxAttempts: 5 }, { reason: '' }), /INVALID_BUDGET_REASON/);
    assert.throws(() => adjustBudget(record, { maxAttempts: 5 }, { reason: '   ' }), /INVALID_BUDGET_REASON/);
    assert.throws(() => adjustBudget(record, { maxAttempts: 1 }, { reason: 'lower below used' }), /New maxAttempts cannot be less than already used attempts/);
    assert.throws(() => adjustBudget(record, { maxActiveSeconds: 10 }, { reason: 'lower below time' }), /New maxActiveSeconds cannot be less than already accumulated/);

    adjustBudget(record, { maxAttempts: 5, maxActiveSeconds: 120 }, { reason: 'User granted more quota' });
    const b = remainingBudget(record);
    assert.equal(b.maxAttempts, 5);
    assert.equal(b.remainingAttempts, 3);
    assert.equal(b.maxActiveSeconds, 120);
    assert.equal(b.remainingActiveSeconds, 100);
    assert.equal(record.budget.adjustments.length, 1);
    assert.equal(record.budget.adjustments[0].reason, 'User granted more quota');
});

test('AuditWorkflow with budget maxAttempts=1 pauses with pauseReason: BUDGET_EXHAUSTED and preserves report', async (t) => {
    const f = createFixture(t);
    const catalog = { engineSeriesRules: { mock: ['mock'] }, series: [{ id: 'mock', models: [{ id: 'mock', efforts: [{ value: 'none' }] }] }] };
    let agentCalls = 0;
    const engine = new AuditWorkflow(f.store, {
        catalog,
        preflight: async () => ({ ok: true, results: [] }),
        snapshot: async () => 'same',
        agent: async () => {
            agentCalls++;
            return JSON.stringify({ summary: 'ok', scopeComplete: true, coverage: ['app.js'], findings: [] });
        }
    });

    const record = engine.create({
        workspaceRoot: f.workspace,
        commonPrompt: 'Inspect',
        scope: 'app.js',
        concurrency: 2,
        budget: { maxAttempts: 1 },
        reviewers: [
            { name: 'RevA', provider: 'mock', prompt: 'P1' },
            { name: 'RevB', provider: 'mock', prompt: 'P2' }
        ]
    });

    engine.launch(record);
    await engine.active.promise;

    const saved = f.store.read('audits', record.id);
    assert.equal(saved.status, 'STOPPED');
    assert.equal(saved.pauseReason, 'BUDGET_EXHAUSTED');
    assert.deepEqual(saved.allowedActions, ['INCREASE_BUDGET', 'MANUAL_RESUME']);
    assert.equal(agentCalls, 1, 'Only 1 agent call allowed by budget limit');

    const completed = saved.reviewers.filter(r => r.status === 'COMPLETED');
    const stopped = saved.reviewers.filter(r => r.status === 'STOPPED');
    assert.equal(completed.length, 1);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].pauseReason, 'BUDGET_EXHAUSTED');

    // Now increase budget to 2 attempts and resume
    adjustBudget(saved, { maxAttempts: 2 }, { reason: 'Allow 2nd reviewer to finish' });
    f.store.save('audits', saved);

    // Retry/Resume the remaining queued reviewer
    saved.reviewers[1].status = 'QUEUED';
    delete saved.pauseReason;
    delete saved.allowedActions;
    engine.launch(saved);
    await engine.active.promise;

    const finalSaved = f.store.read('audits', record.id);
    assert.equal(finalSaved.status, 'COMPLETED');
    assert.equal(agentCalls, 2);
    assert.equal(finalSaved.reviewers.every(r => r.status === 'COMPLETED'), true);
});

test('service restart recovery marks in-flight STARTED reservations as INTERRUPTED and keeps consumption', () => {
    const record = {};
    ensureBudget(record, { maxAttempts: 3 });
    const r1 = reserveAttempt(record, { stepId: 'step:crashed' });
    markAttemptStarted(record, r1);

    const r2 = reserveAttempt(record, { stepId: 'step:queued' }); // not started

    assert.equal(remainingBudget(record).reservedAttempts, 2);
    recoverBudget(record);

    assert.equal(remainingBudget(record).reservedAttempts, 0);
    assert.equal(remainingBudget(record).usedAttempts, 1); // consumed attempt preserved!
    assert.equal(record.budget.reservations.find(r => r.id === r1).status, 'SETTLED');
    assert.equal(record.budget.reservations.find(r => r.id === r1).outcome.status, 'INTERRUPTED');
    assert.equal(record.budget.reservations.find(r => r.id === r2).status, 'CANCELLED');
});
