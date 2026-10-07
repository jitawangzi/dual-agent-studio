'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFixture } = require('./helpers/studio-fixture');
const { RuntimeGuard } = require('../engine/runtime-guard');
const { inspectProcess } = require('../engine/process-owner');
const { AuditWorkflow } = require('../engine/audit-workflow');
const { Workflow } = require('../engine/workflow');

test('inspectProcess correctly distinguishes current process, non-existent pid, and pid reuse', async () => {
    // Current process is ALIVE
    const current = await inspectProcess(process.pid);
    assert.equal(current.state, 'ALIVE');
    assert.ok(current.startedAt);

    // Completely invalid/non-existent PID is EXITED
    const nonExistent = await inspectProcess(99999999);
    assert.equal(nonExistent.state, 'EXITED');

    // Expected startedAt mismatch detects PID reuse
    const reused = await inspectProcess(process.pid, '1990-01-01T00:00:00.000Z');
    assert.equal(reused.state, 'EXITED');
});

test('concurrent acquire calls in the same tick: only one succeeds, second fails with WORKFLOW_BUSY', async (t) => {
    const f = createFixture(t);
    const guard = new RuntimeGuard(f.root);

    const owner1 = { kind: 'audit', id: crypto.randomUUID(), workspaceKey: f.workspaceKey };
    const owner2 = { kind: 'run', id: crypto.randomUUID(), workspaceKey: f.workspaceKey };

    // Execute concurrently
    const results = await Promise.allSettled([
        guard.acquire(owner1),
        guard.acquire(owner2)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one acquire must succeed');
    assert.equal(rejected.length, 1, 'Exactly one acquire must be rejected');
    assert.match(rejected[0].reason.message, /WORKFLOW_BUSY/);

    // Release the acquired token
    fulfilled[0].value.release();
    assert.equal(guard.isBusy(), false);

    // After release, a new acquire succeeds
    const lease = await guard.acquire(owner2);
    assert.ok(lease.token);
    lease.release();
});

test('release is idempotent and does not release with wrong token', async (t) => {
    const f = createFixture(t);
    const guard = new RuntimeGuard(f.root);

    const owner = { kind: 'audit', id: crypto.randomUUID(), workspaceKey: f.workspaceKey };
    const lease = await guard.acquire(owner);
    assert.equal(guard.isBusy(), true);

    // Releasing with invalid token fails and keeps active lock
    assert.equal(guard.release('wrong-token'), false);
    assert.equal(guard.isBusy(), true);

    // Releasing with valid token succeeds
    assert.equal(lease.release(), true);
    assert.equal(guard.isBusy(), false);

    // Subsequent release calls are safe no-ops
    assert.equal(lease.release(), false);
    assert.equal(guard.isBusy(), false);
});

test('recover identifies IDLE, BUSY, and orphan lock from dead process', async (t) => {
    const f = createFixture(t);
    const guard = new RuntimeGuard(f.root);

    // Initial clean state is IDLE
    const initial = await guard.recover();
    assert.equal(initial.state, 'IDLE');

    // Active state is BUSY
    const owner = { kind: 'planning', id: crypto.randomUUID(), workspaceKey: f.workspaceKey };
    const lease = await guard.acquire(owner);
    const busy = await guard.recover();
    assert.equal(busy.state, 'BUSY');
    assert.equal(busy.owner.id, owner.id);
    lease.release();

    // Emulate an orphan lock file from an already-exited PID (e.g. 99999999)
    fs.writeFileSync(guard.lockFile, JSON.stringify({
        pid: 99999999,
        startedAt: new Date().toISOString(),
        owner: { kind: 'run', id: crypto.randomUUID() },
        token: crypto.randomUUID()
    }), 'utf8');

    const orphan = await guard.recover();
    assert.equal(orphan.state, 'NEEDS_ATTENTION');
    assert.equal(orphan.reason, 'ORPHAN_LOCK_PREVIOUS_EXITED');

    // Acquiring when previous process exited reclaims the lock safely
    const newLease = await guard.acquire(owner);
    assert.ok(newLease.token);
    newLease.release();
});

test('cross-entry mutual exclusion between AuditWorkflow and Workflow via RunStore guard', async (t) => {
    const f = createFixture(t);

    const auditEngine = new AuditWorkflow(f.store, {
        snapshot: async () => 'v1',
        preflight: async () => ({ ok: true, results: [] }),
        agent: async (_, { signal } = {}) => new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('RUN_CANCELLED'));
            signal?.addEventListener('abort', () => reject(new Error('RUN_CANCELLED')));
        }),
        command: async () => ({ code: 0, stdout: '', stderr: '' })
    });

    const workflowEngine = new Workflow(f.store, {
        snapshot: async () => 'v1',
        command: async () => ({ code: 0, stdout: '', stderr: '' })
    });

    const auditRecord = auditEngine.create({
        workspaceRoot: f.workspace,
        commonPrompt: 'audit',
        scope: 'app.js',
        reviewers: [{ provider: 'mock' }]
    });

    auditEngine.launch(auditRecord);
    // Give event loop a tick to start
    await new Promise(r => setTimeout(r, 10));

    // Trying to start workflow while audit is active throws WORKFLOW_BUSY
    const runRecord = workflowEngine.create({
        workspaceRoot: f.workspace,
        taskPrompt: 'do work',
        verifyCommand: 'npm test'
    });

    assert.throws(() => workflowEngine.launch(runRecord), /WORKFLOW_BUSY/);

    // Stop auditEngine releases guard cleanly
    await auditEngine.stop();
    assert.equal(f.store.guard.isBusy(), false);

    // Now workflow can launch
    workflowEngine.agent = async (_, { signal } = {}) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('RUN_CANCELLED'));
        signal?.addEventListener('abort', () => reject(new Error('RUN_CANCELLED')));
    });
    workflowEngine.launch(runRecord);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(f.store.guard.isBusy(), true);

    await workflowEngine.stop();
    assert.equal(f.store.guard.isBusy(), false);
});

test('foreign process lock rejection blocks agent execution and marks record FAILED', async (t) => {
    const f = createFixture(t);
    let agentCalled = 0;

    const auditEngine = new AuditWorkflow(f.store, {
        snapshot: async () => 'v1',
        preflight: async () => ({ ok: true, results: [] }),
        agent: async () => {
            agentCalled++;
            return JSON.stringify({ summary: 'clean', scopeComplete: true, coverage: ['app.js'], findings: [] });
        }
    });

    const record = auditEngine.create({
        workspaceRoot: f.workspace,
        commonPrompt: 'audit',
        reviewers: [{ provider: 'mock' }]
    });

    // Write a lock file simulating a live foreign process
    const foreignIdentity = await inspectProcess(process.pid);
    fs.writeFileSync(f.store.guard.lockFile, JSON.stringify({
        pid: process.pid === 1 ? 2 : 1, // simulated foreign PID
        processStartedAt: foreignIdentity.startedAt,
        startedAt: foreignIdentity.startedAt,
        token: 'foreign-token',
        owner: { id: 'foreign-owner' }
    }));

    // Mock inspectProcess to report foreign process as ALIVE
    const originalInspect = require('../engine/process-owner').inspectProcess;
    // We can simulate an acquire rejection directly
    f.store.guard.acquire = async () => {
        throw new Error('INSTANCE_LOCKED: Another Studio instance is actively running');
    };

    auditEngine.launch(record);
    await auditEngine.active.promise;

    assert.equal(agentCalled, 0, 'Agent must NEVER be called when lease is rejected');
    const saved = f.store.read('audits', record.id);
    assert.equal(saved.status, 'FAILED');
    assert.match(saved.error, /INSTANCE_LOCKED/);
});

test('stopping workflow during lease acquisition transitions to STOPPED cleanly', async (t) => {
    const f = createFixture(t);
    let agentCalled = 0;

    const workflowEngine = new Workflow(f.store, {
        snapshot: async () => 'v1',
        agent: async () => { agentCalled++; return 'result'; },
        command: async () => ({ code: 0, stdout: '', stderr: '' })
    });

    let resolveLease;
    const slowLease = new Promise(resolve => { resolveLease = resolve; });
    f.store.guard.acquire = () => slowLease;

    const runRecord = workflowEngine.create({
        workspaceRoot: f.workspace,
        taskPrompt: 'test abort during lease',
        verifyCommand: 'npm test'
    });

    workflowEngine.launch(runRecord);
    assert.equal(workflowEngine.active.id, runRecord.id);

    // Stop while lease is pending
    const stopPromise = workflowEngine.stop();
    resolveLease({ token: 'test', release: () => {} });
    await stopPromise;

    assert.equal(agentCalled, 0, 'Agent must not be called if stopped during acquire');
    assert.equal(workflowEngine.active, null, 'Active must be cleared');
    const saved = f.store.read('runs', runRecord.id);
    assert.equal(saved.status, 'STOPPED');
});

test('lock file separates OS process start identity from task lease acquiredAt', async (t) => {
    const f = createFixture(t);
    const guard = new RuntimeGuard(f.root);

    const lease = await guard.acquire({ kind: 'audit', id: crypto.randomUUID() });
    assert.ok(fs.existsSync(guard.lockFile));

    const lock = JSON.parse(fs.readFileSync(guard.lockFile, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.ok(lock.processStartedAt, 'Must record processStartedAt');
    assert.ok(lock.acquiredAt, 'Must record acquiredAt');
    assert.equal(lock.startedAt, lock.processStartedAt, 'startedAt must match processStartedAt for compatibility');

    lease.release();
    assert.equal(fs.existsSync(guard.lockFile), false);
});

