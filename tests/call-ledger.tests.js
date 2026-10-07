'use strict';
/**
 * 2.11 Task 1: unified agent call ledger.
 * All agent answers here are Mock injections; no real provider is invoked.
 * @author shuyongqiang
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFixture } = require('./helpers/studio-fixture');
const { beginAttempt, finishAttempt, markResponded, summarizeCalls, interruptOpenAttempts, trackedCall, normalizeUsage } = require('../engine/call-ledger');
const { Workflow } = require('../engine/workflow');
const { AuditWorkflow } = require('../engine/audit-workflow');
const { PlanningWorkflow } = require('../engine/planning-workflow');
const { AgentHealth } = require('../engine/agent-health');
const { RunStore } = require('../engine/run-store');

test('plan example: duplicate completion is not double counted and unknown cost stays null', () => {
    const r = {};
    const id = beginAttempt(r, { stepId: 'review:1', role: 'review', provider: 'mock', startedAt: '2026-10-06T00:00:00Z' });
    assert.equal(finishAttempt(r, id, { status: 'INVALID_RESPONSE', finishedAt: '2026-10-06T00:00:02Z', errorCode: 'INVALID_JSON' }), true);
    assert.equal(finishAttempt(r, id, { status: 'INVALID_RESPONSE', finishedAt: '2026-10-06T00:00:02Z' }), false);
    const s = summarizeCalls(r);
    assert.equal(s.attempts, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.usage.cost, null);
    assert.equal(s.usage.source, 'UNKNOWN');
    assert.equal(s.durationMs, 2000);
    assert.equal(s.mock, 1);
    assert.equal(s.billable, 0);
    assert.equal(r.callLedger.attempts[0].errorCode, 'INVALID_JSON');
});

test('each attempt gets a distinct id, retries are new attempts, invalid metadata and status are rejected', () => {
    const r = {};
    const a = beginAttempt(r, { stepId: 's', role: 'dev', provider: 'claude' });
    finishAttempt(r, a, { status: 'CALL_FAILED', errorCode: 'X' });
    const b = beginAttempt(r, { stepId: 's', role: 'dev', provider: 'claude' });
    assert.notEqual(a, b);
    assert.throws(() => finishAttempt(r, b, { status: 'DONE' }), /INVALID_CALL_STATUS/);
    assert.throws(() => finishAttempt(r, 'nope', { status: 'COMPLETED' }), /UNKNOWN_CALL_ATTEMPT/);
    assert.throws(() => beginAttempt(r, { role: 'dev' }), /CALL_STEP_REQUIRED/);
    finishAttempt(r, b, { status: 'COMPLETED' });
    const s = summarizeCalls(r);
    assert.equal(s.attempts, 2);
    assert.equal(s.completed, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.billable, 2);
    // Metadata only, never prompt copies.
    assert.equal(JSON.stringify(r.callLedger).includes('prompt'), false);
});

test('usage is only trusted from explicit provider adapters; cost requires a currency and all attempts known', () => {
    assert.deepEqual(normalizeUsage({ inputTokens: 10, cost: 1 }), { inputTokens: null, outputTokens: null, cost: null, currency: null, source: 'UNKNOWN' });
    assert.equal(normalizeUsage({ source: 'PROVIDER', cost: 1 }).cost, null);
    const r = {};
    const a = beginAttempt(r, { stepId: 'a', role: 'dev', provider: 'claude' });
    finishAttempt(r, a, { status: 'COMPLETED', usage: { source: 'PROVIDER', inputTokens: 5, outputTokens: 7, cost: 0.5, currency: 'USD' } });
    assert.deepEqual(summarizeCalls(r).usage, { inputTokens: 5, outputTokens: 7, cost: 0.5, currency: 'USD', source: 'PROVIDER' });
    const b = beginAttempt(r, { stepId: 'b', role: 'dev', provider: 'claude' });
    finishAttempt(r, b, { status: 'COMPLETED' });
    const u = summarizeCalls(r).usage;
    assert.equal(u.cost, null);
    assert.equal(u.inputTokens, null);
    assert.equal(u.source, 'UNKNOWN');
});

test('legacy records without a ledger summarize to zero attempts and never invent spend', () => {
    const s = summarizeCalls({ id: 'legacy', calls: [{ status: 'COMPLETED' }] });
    assert.equal(s.attempts, 0);
    assert.equal(s.usage.cost, null);
    assert.equal(s.legacy, true);
});

test('interrupted open attempts keep their consumption and are not completed', () => {
    const r = {};
    const a = beginAttempt(r, { stepId: 'a', role: 'dev', provider: 'claude' });
    markResponded(r, a);
    assert.equal(interruptOpenAttempts(r, { errorCode: 'SERVICE_RESTARTED' }), 1);
    assert.equal(interruptOpenAttempts(r), 0);
    const s = summarizeCalls(r);
    assert.equal(s.attempts, 1);
    assert.equal(s.interrupted, 1);
    assert.equal(s.running, 0);
    assert.equal(r.callLedger.attempts[0].errorCode, 'SERVICE_RESTARTED');
});

test('trackedCall persists before provider, after output and after validation, and classifies failures', async () => {
    const r = {}; const snapshots = [];
    const persist = () => snapshots.push(JSON.parse(JSON.stringify(r.callLedger.attempts.map(a => [a.status, Boolean(a.respondedAt)]))));
    const ok = await trackedCall(r, { stepId: 'a', role: 'dev', provider: 'mock' }, { persist, invoke: async () => {
        assert.deepEqual(snapshots.at(-1), [['RUNNING', false]], 'attempt must be on disk before the provider runs');
        return '{"x":1}';
    }, accept: text => JSON.parse(text) });
    assert.deepEqual(ok, { x: 1 });
    assert.deepEqual(snapshots.map(s => s.at(-1)), [['RUNNING', false], ['RUNNING', true], ['COMPLETED', true]]);

    await assert.rejects(trackedCall(r, { stepId: 'b', role: 'dev', provider: 'mock' }, { persist, invoke: async () => 'not json', accept: text => JSON.parse(text) }));
    await assert.rejects(trackedCall(r, { stepId: 'c', role: 'dev', provider: 'mock' }, { persist, invoke: async () => { throw new Error('EXECUTION_TIMEOUT: 1s'); } }));
    await assert.rejects(trackedCall(r, { stepId: 'd', role: 'dev', provider: 'mock' }, { persist, invoke: async () => { throw new Error('AGENT_EXIT_1'); } }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(trackedCall(r, { stepId: 'e', role: 'dev', provider: 'mock' }, { persist, signal: controller.signal, invoke: async () => { throw new Error('RUN_CANCELLED'); } }));
    await assert.rejects(trackedCall(r, { stepId: 'f', role: 'review', provider: 'mock' }, { persist, invoke: async () => 'ok', accept: () => { throw new Error('AUDIT_SOURCE_CHANGED'); } }));
    assert.deepEqual(r.callLedger.attempts.map(a => a.status), ['COMPLETED', 'INVALID_RESPONSE', 'TIMED_OUT', 'CALL_FAILED', 'STOPPED', 'DISCARDED']);
    assert.equal(r.callLedger.attempts[1].errorCode, 'INVALID_RESPONSE');
    assert.equal(r.callLedger.attempts[3].errorCode, 'AGENT_EXIT_1');
    const s = summarizeCalls(r);
    assert.equal(s.attempts, 6);
    assert.equal(s.failed, 3);
    assert.equal(s.interrupted, 1);
    assert.equal(s.discarded, 1);
});

const review = (more = {}) => JSON.stringify({ verdict: 'APPROVED', summary: 'Reviewed source and tests', scopeComplete: true,
    acceptanceComplete: true, coverage: ['app.js: inspected'], issues: [], verifications: [], ...more });
const pass = async () => ({ code: 0, stdout: 'tests passed', stderr: '' });

test('Workflow records every dev/review attempt, keeps malformed output as a consumed INVALID_RESPONSE attempt', async (t) => {
    const f = createFixture(t);
    let n = 0;
    const engine = new Workflow(f.store, { snapshot: async () => 'v1', command: pass, agent: async req => {
        if (req.role === 'dev') return '{"summary":"x","needsDecision":false,"fixes":[]}';
        n++;
        return n === 1 ? 'this is not json' : review();
    } });
    const run = engine.create({ workspaceRoot: f.workspace, mode: 'audit', taskPrompt: 't', verifyCommand: 'node --check app.js', cleanRoundsRequired: 1, maxRounds: 3 });
    engine.launch(run); await engine.active.promise;
    const saved = f.store.read('runs', run.id);
    assert.equal(saved.status, 'FAILED');
    const attempts = saved.callLedger.attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'INVALID_RESPONSE');
    assert.equal(attempts[0].role, 'review');
    assert.equal(attempts[0].provider, 'copilot');
    assert.equal(attempts[0].sessionId, saved.reviewSessionId);
    assert.ok(attempts[0].stepId.includes('REVIEW'));
    // Raw answer artifact is preserved.
    assert.ok(fs.readdirSync(path.dirname(f.store.file('runs', run.id))).some(n => n.endsWith('.response.txt')));

    // Resume: new attempts are appended; old consumption is kept.
    engine.resume(run.id); await engine.active.promise;
    const resumed = f.store.read('runs', run.id);
    assert.equal(resumed.status, 'APPROVED');
    assert.equal(summarizeCalls(resumed).attempts, 2);
    assert.equal(summarizeCalls(resumed).completed, 1);
});

test('Workflow stop marks the in-flight attempt STOPPED and restart recovery marks open attempts INTERRUPTED', async (t) => {
    const f = createFixture(t);
    let started;
    const ready = new Promise(r => { started = r; });
    const engine = new Workflow(f.store, { snapshot: async () => 'v1', command: pass, agent: (req, { signal }) => new Promise((_, reject) => {
        started(); signal.addEventListener('abort', () => reject(new Error('RUN_CANCELLED')));
    }) });
    const run = engine.create({ workspaceRoot: f.workspace, mode: 'audit', taskPrompt: 't', verifyCommand: 'node --check app.js', cleanRoundsRequired: 1, maxRounds: 3 });
    engine.launch(run); await ready;
    const midway = f.store.read('runs', run.id);
    assert.equal(midway.callLedger.attempts.at(-1).status, 'RUNNING', 'attempt persisted before provider completes');
    await engine.stop();
    const stopped = f.store.read('runs', run.id);
    assert.equal(stopped.status, 'STOPPED');
    assert.equal(stopped.callLedger.attempts.at(-1).status, 'STOPPED');

    // Simulate a crash with an open attempt on disk.
    const crashed = f.store.read('runs', run.id);
    crashed.status = 'RUNNING';
    beginAttempt(crashed, { stepId: 'x', role: 'review', provider: 'copilot' });
    f.store.save('runs', crashed);
    new Workflow(f.store).recover();
    const recovered = f.store.read('runs', run.id);
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.callLedger.attempts.at(-1).status, 'INTERRUPTED');
    assert.equal(summarizeCalls(recovered).attempts, 2);
});

const auditCatalog = { engineSeriesRules: { codex: ['gpt'] }, series: [{ id: 'gpt', models: [{ id: 'test-gpt', efforts: [{ value: 'high' }] }] }] };

test('AuditWorkflow records reviewer attempts with phase metadata, failures and restart interruption', async (t) => {
    const f = createFixture(t);
    const engine = new AuditWorkflow(f.store, { catalog: auditCatalog, preflight: async () => ({ ok: true, results: [] }), snapshot: async () => 'same',
        agent: async req => req.prompt.includes('Check design') ? 'garbage' : JSON.stringify({ summary: 'ok', scopeComplete: true, coverage: ['app.js'], findings: [] }) });
    const record = engine.create({ workspaceRoot: f.workspace, commonPrompt: 'Inspect', scope: 'app.js', concurrency: 2,
        reviewers: [{ name: 'A', provider: 'codex', model: 'test-gpt', reasoningEffort: 'high', prompt: 'Check errors' }, { name: 'B', provider: 'mock', prompt: 'Check design' }] });
    engine.launch(record); await engine.active.promise;
    const saved = f.store.read('audits', record.id);
    const attempts = saved.callLedger.attempts;
    assert.equal(attempts.length, 2);
    const byProvider = Object.fromEntries(attempts.map(a => [a.provider, a]));
    assert.equal(byProvider.codex.status, 'COMPLETED');
    assert.equal(byProvider.codex.model, 'test-gpt');
    assert.equal(byProvider.codex.phase, 'review');
    assert.equal(byProvider.mock.status, 'INVALID_RESPONSE');
    assert.equal(byProvider.mock.billable, false);
    const s = summarizeCalls(saved);
    assert.equal(s.billable, 1);
    assert.equal(s.mock, 1);

    saved.status = 'RUNNING';
    beginAttempt(saved, { stepId: 'reviewer:x', role: 'audit', provider: 'codex' });
    f.store.save('audits', saved);
    engine.recover();
    assert.equal(f.store.read('audits', record.id).callLedger.attempts.at(-1).status, 'INTERRUPTED');
});

test('PlanningWorkflow ledger is separate from business calls and survives restart recovery', (t) => {
    const f = createFixture(t);
    const engine = new PlanningWorkflow(f.store);
    const id = '11111111-1111-4111-8111-111111111111';
    const record = { id, workspaceRoot: f.workspace, workspaceKey: f.workspaceKey, status: 'RUNNING', calls: [{ id: 'c', status: 'RUNNING' }] };
    beginAttempt(record, { stepId: 'plan-propose:m1', role: 'plan-propose', provider: 'claude' });
    f.store.save('discussions', record);
    engine.recover();
    const saved = f.store.read('discussions', id);
    assert.equal(saved.calls[0].status, 'INTERRUPTED');
    assert.equal(saved.callLedger.attempts[0].status, 'INTERRUPTED');
});

test('AgentHealth persists explicit real probes as health records without credentials, check mode records nothing', async (t) => {
    const f = createFixture(t);
    const calls = [];
    const health = new AgentHealth({ store: f.store, catalog: auditCatalog, inspect: async () => ({ ok: true, code: 'OK', version: '1', auth: 'OK' }),
        agent: async req => { calls.push(req); return 'wrong marker'; } });
    const reviewers = [{ name: 'A', provider: 'codex', model: 'test-gpt', reasoningEffort: 'high', prompt: 'x' }, { name: 'B', provider: 'mock', prompt: 'y' }];
    const checked = await health.run({ mode: 'check', reviewers });
    assert.equal(checked.recordId, undefined);
    assert.equal(f.store.list('health').length, 0);

    const probed = await health.run({ mode: 'probe', reviewers });
    assert.equal(calls.length, 1, 'mock reviewers are not probed');
    assert.ok(probed.recordId);
    assert.equal(probed.calls.attempts, 1);
    const saved = f.store.read('health', probed.recordId);
    assert.equal(saved.status, 'COMPLETED');
    assert.equal(saved.callLedger.attempts[0].status, 'INVALID_RESPONSE');
    assert.equal(saved.callLedger.attempts[0].provider, 'codex');
    assert.equal(JSON.stringify(saved).includes('Connectivity test'), false, 'probe prompt is not copied');

    saved.status = 'RUNNING';
    beginAttempt(saved, { stepId: 'probe:x', role: 'health-probe', provider: 'codex' });
    f.store.save('health', saved);
    health.recover();
    const recovered = f.store.read('health', probed.recordId);
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.callLedger.attempts.at(-1).status, 'INTERRUPTED');
});

test('health kind is a valid storage kind without workspace, with path safety preserved', (t) => {
    const f = createFixture(t);
    const store = new RunStore(f.store.root);
    assert.throws(() => store.file('health', '../x'), /INVALID_RECORD_ID/);
    assert.throws(() => store.file('secrets', '11111111-1111-4111-8111-111111111111'), /INVALID_RECORD_ID/);
    const rec = store.save('health', { id: '22222222-2222-4222-8222-222222222222', status: 'COMPLETED', createdAt: new Date().toISOString() });
    assert.equal(store.read('health', rec.id).status, 'COMPLETED');
    assert.equal(store.listWithDiagnostics('health').errors.length, 0);
});
