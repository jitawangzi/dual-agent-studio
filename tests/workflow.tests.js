'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RunStore } = require('../engine/run-store');
const { Workflow, applyReview, sourceSnapshot } = require('../engine/workflow');
const { execute } = require('../engine/process-runner');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v2-test-'));
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const value = 1;');
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, workspace, store: new RunStore(path.join(root, 'state')) };
}
const config = workspaceRoot => ({ workspaceRoot, mode: 'audit', taskPrompt: 'Find and fix bugs',
    verifyCommand: 'node --check app.js', cleanRoundsRequired: 2, maxRounds: 5 });
const review = (more = {}) => ({ verdict: 'APPROVED', summary: 'Reviewed source and tests', scopeComplete: true,
    acceptanceComplete: true, coverage: ['app.js: inspected execution and boundary conditions'], issues: [], verifications: [], ...more });
const bug = (more = {}) => ({ file: 'app.js', severity: 'HIGH', problem: 'Missing null check',
    evidence: 'null input dereferences value', acceptance: 'null input returns empty result', ...more });
const dev = JSON.stringify({ summary: 'Added null guard and regression test', needsDecision: false, fixes: [] });
const pass = async () => ({ code: 0, stdout: 'tests passed', stderr: '' });
async function finish(engine, run) { engine.launch(run); await engine.active.promise; return engine.store.read('runs', run.id); }

test('approval binds exact human revision and workspace; stale or changed plans cannot launch', t => {
    const { store, workspace, root } = fixture(t);
    const plan = store.createPlan(workspace, { finalPlan: 'Initial proposal' });
    const engine = new Workflow(store);
    const options = { ...config(workspace), mode: 'plan', planId: plan.id };
    assert.throws(() => engine.create(options), /PLAN_NOT_APPROVED/);
    const approved = store.approvePlan(plan.id, { version: 1, text: 'Human edited acceptance', workspaceRoot: workspace });
    assert.equal(approved.draftPlan, 'Initial proposal');
    assert.throws(() => store.approvePlan(plan.id, { version: 1, text: 'stale', workspaceRoot: workspace }), /VERSION_CONFLICT/);
    assert.throws(() => engine.create({ ...options, approvalId: approved.approval.id }), /APPROVED_PLAN_CHANGED/);
    const run = engine.create({ ...options, taskPrompt: approved.finalPlan, approvalId: approved.approval.id });
    assert.equal(run.taskPrompt, 'Human edited acceptance');
    assert.equal(run.approval.version, 2);
    assert.throws(() => store.approvedPlan({ ...options, workspaceRoot: root, approvalId: approved.approval.id }), /PLAN_NOT_APPROVED/);
});

test('audit runs review before developer, closes old bug with evidence, then requires another clean review', async t => {
    const { store, workspace } = fixture(t); const roles = []; let n = 0;
    const engine = new Workflow(store, { snapshot: async () => 'source-v1', command: pass,
        agent: async request => {
            roles.push(request.role);
            if (request.role === 'dev') return dev;
            n++;
            return JSON.stringify(n === 1 ? review({ verdict: 'REJECTED', issues: [bug()] }) :
                n === 2 ? review({ verifications: [{ id: 'BUG-0001', result: 'RESOLVED', evidence: 'Null guard inspected; null regression passes' }] }) : review());
        } });
    const result = await finish(engine, engine.create(config(workspace)));
    assert.equal(result.status, 'APPROVED'); assert.deepEqual(roles, ['review', 'dev', 'review', 'review']);
    assert.equal(result.bugs[0].status, 'VERIFIED_CLOSED'); assert.equal(result.cleanRounds, 2);
    assert.equal(result.history.length, 3);
    assert(fs.existsSync(store.file('runs', result.id, 'events.jsonl')));
});

test('omitted bugs never disappear; new findings reset clean streak and recurring findings retain IDs', t => {
    fixture(t);
    const run = { mode: 'audit', bugs: [], history: [], round: 1, cleanRounds: 0, testGate: { status: 'PASS', snapshot: 'x' } };
    applyReview(run, review({ verdict: 'REJECTED', issues: [bug()] }), 'x');
    applyReview(run, review(), 'x');
    assert.equal(run.bugs.length, 1); assert.equal(run.cleanRounds, 0);
    applyReview(run, review({ issues: [bug()] }), 'x'); assert.equal(run.bugs.length, 1);
    applyReview(run, review({ verifications: [{ id: 'BUG-0001', result: 'RESOLVED', evidence: 'test and source verified' }] }), 'x');
    assert.equal(run.cleanRounds, 1);
    applyReview(run, review({ issues: [bug({ id: 'BUG-0001' }), bug({ problem: 'Overflow', evidence: 'large input overflows' })] }), 'x');
    assert.equal(run.bugs[0].status, 'REOPENED'); assert.equal(run.bugs[1].id, 'BUG-0002'); assert.equal(run.cleanRounds, 0);
});

test('partial or contradictory review cannot close any bugs', async t => {
    const { store, workspace } = fixture(t); let n = 0;
    const engine = new Workflow(store, { command: pass, snapshot: async () => 'v1', agent: async request => {
        if (request.role === 'dev') return dev;
        return JSON.stringify(++n === 1 ? review({ issues: [bug()] }) : review({ verifications: [
            { id: 'BUG-0001', result: 'RESOLVED', evidence: 'valid' }, { id: 'UNKNOWN', result: 'RESOLVED', evidence: 'bad' }] }));
    } });
    const run = await finish(engine, engine.create(config(workspace)));
    assert.equal(run.status, 'FAILED'); assert.match(run.error, /INVALID_BUG_VERIFICATION/);
    assert.notEqual(run.bugs[0].status, 'VERIFIED_CLOSED');
});

test('tests fail closed, retries are bounded, and malformed reviewer output is not approved', async t => {
    const { store, workspace } = fixture(t);
    const engine = new Workflow(store, { snapshot: async () => 'v1', command: async () => ({ code: 1, stdout: '', stderr: 'test failed' }), agent: async () => dev });
    const run = await finish(engine, engine.create({ ...config(workspace), mode: 'direct', maxSelfHealAttempts: 2 }));
    assert.equal(run.status, 'NEEDS_ATTENTION'); assert.match(run.error, /TEST_GATE_SELF_HEAL_EXCEEDED/);
    const bad = new Workflow(store, { snapshot: async () => 'v1', command: pass, agent: async () => 'APPROVED' });
    const badRun = await finish(bad, bad.create(config(workspace)));
    assert.equal(badRun.status, 'FAILED'); assert.match(badRun.error, /INVALID_AGENT_JSON/);
});

test('reviewer edits invalidate verification', async t => {
    const { store, workspace } = fixture(t); let source = 'v1';
    const engine = new Workflow(store, { snapshot: async () => source, command: pass,
        agent: async () => { source = 'v2'; return JSON.stringify(review()); } });
    const run = await finish(engine, engine.create(config(workspace)));
    assert.equal(run.status, 'FAILED'); assert.match(run.error, /SOURCE_CHANGED_DURING_REVIEW/);
});

test('interrupted dev recovers through testing and review without replaying mutation', async t => {
    const { store, workspace } = fixture(t); const roles = [];
    const engine = new Workflow(store, { snapshot: async () => 'after-partial-edit', command: pass,
        agent: async request => { roles.push(request.role); return JSON.stringify(review()); } });
    const run = engine.create(config(workspace)); run.phase = 'DEV'; run.status = 'RUNNING'; store.save('runs', run);
    engine.recover(); assert.equal(store.read('runs', run.id).status, 'INTERRUPTED');
    engine.resume(run.id); await engine.active.promise;
    assert.deepEqual(roles, ['review', 'review']); assert.equal(store.read('runs', run.id).status, 'APPROVED');
});

test('stop waits for cancellation, blocks overlap, and preserves a resumable checkpoint', async t => {
    const { store, workspace } = fixture(t);
    let reached; const started = new Promise(r => { reached = r; });
    const engine = new Workflow(store, { snapshot: async () => 'x', command: pass,
        agent: async (_, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); reached();
        }) });
    const run = engine.create(config(workspace)); engine.launch(run); await started;
    assert.throws(() => engine.create(config(workspace)), /WORKFLOW_BUSY/);
    await engine.stop(); assert.equal(engine.active, null);
    const saved = store.read('runs', run.id); assert.equal(saved.status, 'STOPPED'); assert.equal(saved.phase, 'REVIEW');
});

test('disputes pause for human input; decision retains the bug ledger and cannot close a bug itself', async t => {
    const { store, workspace } = fixture(t); let n = 0;
    const engine = new Workflow(store, { snapshot: async () => 'x', command: pass, agent: async request => {
        if (request.role === 'dev') return dev;
        n++; return JSON.stringify(n === 1 ? review({ issues: [bug()] }) : n === 2 ? review({
            verifications: [{ id: 'BUG-0001', result: 'DISPUTED', evidence: 'Business contract is ambiguous' }]
        }) : review({ verifications: [{ id: 'BUG-0001', result: 'RESOLVED', evidence: 'Verified against human-selected contract and test' }] }));
    } });
    const run = await finish(engine, engine.create({ ...config(workspace), cleanRoundsRequired: 1 }));
    assert.equal(run.status, 'NEEDS_ATTENTION');
    engine.decide(run.id, { note: 'Null input must return an empty result', extraRounds: 2 });
    await engine.active.promise;
    const saved = store.read('runs', run.id); assert.equal(saved.status, 'APPROVED');
    assert.equal(saved.bugs.length, 1); assert.equal(saved.decisions.length, 1);
});

test('incomplete scope and unmet approved acceptance prevent success', async t => {
    const { store, workspace } = fixture(t);
    const engine = new Workflow(store, { snapshot: async () => 'x', command: pass, agent: async request => request.role === 'dev' ? dev : JSON.stringify(review({ scopeComplete: false })) });
    const run = await finish(engine, engine.create({ ...config(workspace), maxRounds: 2 }));
    assert.equal(run.status, 'REJECTED_MAX_ROUNDS');
    const r = { mode: 'plan', bugs: [], history: [], round: 1, cleanRounds: 0, testGate: { status: 'PASS', snapshot: 'x' } };
    assert.equal(applyReview(r, review({ acceptanceComplete: false }), 'x').clean, false);
});

test('real source fingerprints catch tracked, untracked and deleted file changes', async t => {
    const { workspace } = fixture(t);
    assert.equal((await execute('git', ['init', '-q'], { cwd: workspace })).code, 0);
    assert.equal((await execute('git', ['add', 'app.js'], { cwd: workspace })).code, 0);
    const initial = await sourceSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const value = 2;');
    assert.notEqual(await sourceSnapshot(workspace), initial);
    const changed = await sourceSnapshot(workspace); fs.writeFileSync(path.join(workspace, 'new.js'), 'new');
    assert.notEqual(await sourceSnapshot(workspace), changed);
    fs.unlinkSync(path.join(workspace, 'new.js')); assert.equal(await sourceSnapshot(workspace), changed);
    fs.unlinkSync(path.join(workspace, 'app.js')); assert.notEqual(await sourceSnapshot(workspace), changed);
});

test('developer scope questions pause even without a fixes array', async t => {
    const { store, workspace } = fixture(t);
    const engine = new Workflow(store, { agent: async () => JSON.stringify({ needsDecision: true, summary: 'Choose the new API contract' }) });
    const run = await finish(engine, engine.create({ ...config(workspace), mode: 'direct' }));
    assert.equal(run.status, 'NEEDS_ATTENTION');
    assert.equal(run.history.length, 0);
});

test('source changes between clean rounds reset the completion streak', async t => {
    const { store, workspace } = fixture(t); let calls = 0;
    const engine = new Workflow(store, { snapshot: async () => ++calls <= 4 ? 'old' : 'new', command: pass,
        agent: async () => JSON.stringify(review()) });
    const run = await finish(engine, engine.create(config(workspace)));
    assert.equal(run.status, 'APPROVED');
    assert.equal(run.history.length, 3);
});

test('process callback failures reject safely instead of escaping the run', async t => {
    const { workspace } = fixture(t);
    await assert.rejects(execute(process.execPath, ['-e', 'console.log("hello"); setInterval(() => {}, 1000)'], {
        cwd: workspace, onOutput: () => { throw new Error('disk full'); }
    }), /PROCESS_CALLBACK_FAILED: disk full/);
});

test('process timeout terminates child execution and reports failure', async t => {
    const { workspace } = fixture(t);
    await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, timeoutMs: 100 }), /EXECUTION_TIMEOUT/);
});

test('2.7 keeps round-specific execution, source fingerprints and reviewer evidence artifacts', async t => {
    const {store,workspace}=fixture(t);
    const engine=new Workflow(store,{snapshot:async()=> 'v1',command:pass,agent:async request=>{
        if(request.role==='dev')return dev;
        const gate=JSON.parse(request.prompt.split('Latest test evidence: ')[1].split('\n')[0]);
        return JSON.stringify(review({acceptanceChecks:[{id:'A-001',result:'PASS',evidence:'actual command output',evidenceRefs:[{kind:'TEST',artifact:gate.artifact,quote:'tests passed',explanation:'recorded test output'}]}],coverageDetails:[{target:'app.js',status:'CHECKED',checks:'source and tests',limitations:'fixture only'}]}));
    }});
    const run=engine.create({...config(workspace),mode:'direct',cleanRoundsRequired:1});
    run.acceptanceCriteria=[{id:'A-001',criterion:'test',verification:'test command'}];
    const saved=await finish(engine,run);
    assert.equal(saved.status,'APPROVED');
    const round=saved.history[0];
    assert.equal(round.testGate.snapshot,'v1');assert.equal(round.changeEvidence.beforeSnapshot,'v1');
    assert(fs.existsSync(store.file('runs',run.id,round.testGate.artifact)));
    assert(fs.existsSync(store.file('runs',run.id,round.reviewArtifact)));
    assert(fs.existsSync(store.file('runs',run.id,round.changeEvidence.artifact)));
    assert.equal(round.reviewVerdict.acceptanceChecks[0].evidenceRefs[0].provenance,'STUDIO_EXECUTION');
});

test('2.7 forged execution evidence fails review without approving or closing bugs', async t => {
    const {store,workspace}=fixture(t);
    const engine=new Workflow(store,{snapshot:async()=> 'v1',command:pass,agent:async()=>JSON.stringify(review({acceptanceChecks:[{id:'A-001',result:'PASS',evidence:'claim',evidenceRefs:[{kind:'TEST',artifact:'fake.txt',quote:'tests passed',explanation:'claim'}]}]}))});
    const run=engine.create({...config(workspace),cleanRoundsRequired:1});run.acceptanceCriteria=[{id:'A-001',criterion:'test',verification:'test command'}];
    const saved=await finish(engine,run);
    assert.equal(saved.status,'FAILED');assert.match(saved.error,/UNVERIFIED_TEST_EVIDENCE/);assert.equal(saved.history.length,0);
});

test('Workflow budget timeout terminates child process before releasing lease and prevents late writes', async t => {
    const { store, workspace } = fixture(t);
    const marker = path.join(workspace, 'late-write-test.txt');
    let pid;
    let invocation;
    let guardWasBusyBeforeEnd = false;
    const engine = new Workflow(store, {
        snapshot: async () => 'snap',
        command: pass,
        agent: async (_, options) => {
            invocation = execute(process.execPath, ['-e', `setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'late write'); console.log('{}'); }, 2000);`], {
                ...options,
                onSpawn: p => {
                    pid = p.pid;
                    options.onSpawn?.(p);
                }
            });
            return (await invocation).stdout;
        }
    });
    const run = engine.create({
        workspaceRoot: workspace,
        mode: 'direct',
        taskPrompt: 'test budget process termination',
        verifyCommand: 'node --check app.js',
        budget: { maxActiveSeconds: 1 }
    });
    engine.launch(run);
    guardWasBusyBeforeEnd = store.guard.isBusy();
    await engine.active.promise;

    let alive = true;
    try {
        process.kill(pid, 0);
    } catch {
        alive = false;
    }

    assert.equal(guardWasBusyBeforeEnd, true, 'guard must be busy during execution');
    assert.equal(alive, false, 'child process must be terminated before workflow promise resolves');
    assert.equal(store.guard.isBusy(), false, 'guard must be released after process exit');
    assert.equal(fs.existsSync(marker), false, 'marker file must not exist at workflow completion');

    if (invocation) await invocation.catch(() => {});
    await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.existsSync(marker), false, 'marker file must not be written after invocation duration');

    const saved = store.read('runs', run.id);
    assert.equal(saved.status, 'STOPPED');
    assert.equal(saved.budget.timeTracking.activeIntervals.filter(i => i.stoppedAt === null).length, 0);
});

