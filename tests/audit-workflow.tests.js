'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RunStore } = require('../engine/run-store');
const { Workflow } = require('../engine/workflow');
const { AuditWorkflow } = require('../engine/audit-workflow');
const { auditCapabilities } = require('../engine/audit-config');
const {presentAudit}=require('../engine/audit-triage');
const preflight=async()=>({ok:true,results:[]});
const catalog = { engineSeriesRules: { codex: ['gpt'], claude: ['claude'] }, series: [
    { id: 'gpt', models: [{ id: 'test-gpt', efforts: [{value:'high'}, {value:'medium'}] }] },
    { id: 'claude', models: [{ id: 'test-claude', efforts: [{value:'16384'}] }] }
] };
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-audit-'));
    const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const a = 1;');
    t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, {recursive:true,force:true}); });
    return { store: new RunStore(path.join(root, 'state')), workspace };
}
const finding = (more = {}) => ({ category:'BUG', severity:'HIGH', file:'app.js', lineRange:'1', problem:'Null dereference',
    evidence:'null input dereferences x.name', acceptance:'null input returns empty', fixSuggestion:'guard null', ...more });
const report = (findings = [], more = {}) => JSON.stringify({ summary:'Inspected app.js', scopeComplete:true, coverage:['app.js null handling'], findings, ...more });
const opts = (workspaceRoot, more = {}) => ({workspaceRoot, commonPrompt:'Inspect correctness', scope:'app.js', concurrency:2,
    reviewers:[{name:'A',provider:'codex',model:'test-gpt',reasoningEffort:'high',prompt:'Check errors'},
        {name:'B',provider:'claude',model:'test-claude',reasoningEffort:'16384',prompt:'Check design'}], ...more});
const finish = async (engine, config) => { const record = engine.create(config); engine.launch(record); await engine.active.promise; return engine.store.read('audits', record.id); };

test('bounded concurrency starts independent reviewers together and preserves per-reviewer parameters', async t => {
    const {store, workspace} = fixture(t); const started = []; const releases = [];
    let signalTwo; const two = new Promise(r => { signalTwo = r; });
    const engine = new AuditWorkflow(store, {catalog,preflight, snapshot:async()=> 'same', agent:async req => {
        started.push(req); if (started.length === 2) signalTwo();
        await new Promise(r => releases.push(r)); return report([finding()]);
    }});
    const config = opts(workspace); config.reviewers.push({name:'C',provider:'mock',prompt:'Check regression'});
    const record = engine.create(config); engine.launch(record); const done = engine.active.promise;
    await two;
    assert.equal(started.length,2); assert.equal(new Set(started.map(r=>r.sessionId)).size,2);
    assert.deepEqual(started.map(r=>[r.model,r.reasoningEffort]), [['test-gpt','high'],['test-claude','16384']]);
    assert(started.every(r=> r.role === 'audit' && r.prompt.includes('Inspect correctness')));
    releases.shift()(); releases.shift()();
    while (started.length < 3) await new Promise(r=>setTimeout(r,5));
    releases.shift()(); await done;
    const saved = store.read('audits',record.id);
    assert.equal(saved.status,'COMPLETED'); assert.equal(saved.findings.length,1);
    assert.equal(saved.findings[0].sources.length,3); assert.equal(saved.reviewers[0].report.findings.length,1);
    assert(fs.readdirSync(path.dirname(store.file('audits',record.id))).some(n=> n.endsWith('.response.txt')));
});

test('invalid model effort and providers fail before any execution, custom model permits default only', t => {
    const {store,workspace} = fixture(t); const engine = new AuditWorkflow(store,{catalog,preflight});
    assert(auditCapabilities(catalog).providers.some(p=>p.id === 'codex'));
    for (const reviewer of [{provider:'cursor'}, {provider:'codex',model:'test-gpt',reasoningEffort:'max'},
        {provider:'codex',model:'unknown-model',reasoningEffort:'high'}]) {
        assert.throws(()=>engine.create(opts(workspace,{reviewers:[reviewer]})), /UNSUPPORTED/);
    }
    assert.equal(engine.create(opts(workspace,{reviewers:[{provider:'codex',model:'unknown-model',reasoningEffort:''}]})).reviewers[0].model,'unknown-model');
});

test('one malformed or failed reviewer preserves other reports and does not imply approval', async t => {
    const {store,workspace} = fixture(t);
    const engine = new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'same',agent:async req => req.provider === 'codex' ? report([finding()]) : '{"summary":"broken"}'});
    const run = await finish(engine,opts(workspace));
    assert.equal(run.status,'PARTIAL'); assert.equal(run.findings.length,1);
    assert.equal(run.reviewers[1].status,'FAILED'); assert.match(run.reviewers[1].error,/INVALID/);
    const engine2 = new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'same',agent:async()=> report([], {scopeComplete:false})});
    assert.equal((await finish(engine2,opts(workspace))).status,'PARTIAL');
});

test('source mutation invalidates the audit and forbids repair', async t => {
    const {store,workspace} = fixture(t); let version='before';
    const engine = new AuditWorkflow(store,{catalog,preflight,snapshot:async()=>version,agent:async()=>{version='after'; return report([finding()]);}});
    const run = await finish(engine,opts(workspace)); assert.equal(run.status,'INVALIDATED');
    await assert.rejects(engine.repair(new Workflow(store),run.id,{findingIds:run.findings.map(f=>f.id)}),/INVALIDATED/);
});

test('stop aborts all children, leaves queued workers untouched and waits for settlement', async t => {
    const {store,workspace}=fixture(t); let count=0, ready; const entered=new Promise(r=>{ready=r;});
    const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'same',agent:async(req,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}); if(++count===2)ready();
    })});
    const config=opts(workspace); config.reviewers.push({provider:'mock'});
    const run=engine.create(config); engine.launch(run); await entered;
    assert.throws(()=>engine.create(config),/BUSY/); await engine.stop();
    assert.equal(engine.active,null); assert.equal(count,2); assert.equal(store.read('audits',run.id).status,'STOPPED');
});

test('retry preserves successful reports and rejects stale snapshots', async t=>{
    const {store,workspace}=fixture(t); let version='same', fail=true; const calls=[];
    const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=>version,agent:async req=>{
        calls.push(req.provider); if(req.provider==='claude'&&fail)throw new Error('offline'); return report([finding()]);
    }});
    const run=await finish(engine,opts(workspace)); fail=false;
    engine.retry(run.id); await engine.active.promise;
    assert.deepEqual(calls,['codex','claude','claude']);
    assert.equal(store.read('audits',run.id).status,'COMPLETED');
    const interrupted=store.read('audits',run.id); interrupted.status='RUNNING'; interrupted.reviewers[1].status='RUNNING'; store.save('audits',interrupted);
    engine.recover(); assert.equal(store.read('audits',run.id).status,'INTERRUPTED');
    version='different'; engine.retry(run.id); await engine.active.promise;
    assert.equal(store.read('audits',run.id).status,'INVALIDATED'); assert.equal(calls.length,3);
});

test('selection imports only persisted findings with evidence into repair ledger and retains audit provenance', async t=>{
    const {store,workspace}=fixture(t);
    const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'same',agent:async()=>report([finding(),finding({category:'SUGGESTION',problem:'Simplify nesting'}),finding({category:'QUESTION',problem:'What is contract?'})])});
    const audit=await finish(engine,opts(workspace));
    const workflow=new Workflow(store,{snapshot:async()=> 'same',command:async()=>({code:0,stdout:'pass',stderr:''}),agent:async req=>req.role==='dev'?
        JSON.stringify({summary:'fixed selected bug',needsDecision:false,fixes:[]}):JSON.stringify({verdict:'APPROVED',summary:'Verified',scopeComplete:true,coverage:['app.js'],issues:[],verifications:[{id:'BUG-0001',result:'RESOLVED',evidence:'Regression test passed'}]})});
    const config={findingIds:[audit.findings[0].id],devProvider:'mock',reviewProvider:'mock',verifyCommand:'node --check app.js',cleanRoundsRequired:1,maxRounds:2};
    await assert.rejects(engine.repair(workflow,audit.id,{...config,findingIds:['invented']}),/UNKNOWN/);
    await assert.rejects(engine.repair(workflow,audit.id,{...config,findingIds:[audit.findings[2].id]}),/QUESTION/);
    await assert.rejects(engine.repair(workflow,audit.id,config),/REQUIRES_TRIAGE/);
    const first=presentAudit(audit).findings[0];
    engine.triage(audit.id,{findingId:first.id,evidenceKey:first.evidenceKey,version:0,status:'CONFIRMED',note:'Confirmed null input crash in app.js'});
    const run=await engine.repair(workflow,audit.id,config); const pending=workflow.active?.promise; if(pending)await pending;
    const saved=store.read('runs',run.id); assert.equal(saved.bugs.length,1); assert.equal(saved.sourceAudit.id,audit.id);
    assert.equal(saved.bugs[0].status,'VERIFIED_CLOSED'); assert.match(saved.bugs[0].evidence,/null input/);
    assert.equal(saved.config.autoCommit,false);
});

test('repair refuses an interrupted audit with a live reviewer process', async t=>{
    const {store,workspace}=fixture(t);
    const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'same',agent:async()=>report([finding()])});
    const audit=await finish(engine,opts(workspace));audit.status='INTERRUPTED';audit.reviewers[1].activePid=process.pid;store.save('audits',audit);
    const workflow = new Workflow(store, {agent:async()=>JSON.stringify({summary:'no edits',needsDecision:true}),snapshot:async()=> 'same'});
    await assert.rejects(engine.repair(workflow,audit.id,{findingIds:[audit.findings[0].id],acceptPartial:true,
        verifyCommand:'node --check app.js'}),/PREVIOUS_PROCESS_STILL_RUNNING/);
});

test('2.8 supplement selects only gaps, inherits agent configuration and preserves parent reports',async t=>{
 const {store,workspace}=fixture(t),calls=[];
 const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'v1',agent:async req=>{calls.push(req);return calls.length===1?report([finding()],{scopeComplete:false,taskChecks:[{id:'C-1',status:'CHECKED',evidence:'source inspected'},{id:'C-2',status:'UNCHECKED',evidence:'missing environment'}]}):report([],{taskChecks:[{id:'C-1',status:'CHECKED',evidence:'source inspected after clarification'}]});}});
 const parent=await finish(engine,opts(workspace,{reviewers:[{provider:'codex',model:'test-gpt',reasoningEffort:'high',name:'Boundaries',checklist:['null input','timeout'] }]}));
 assert.equal(parent.status,'PARTIAL');const original=JSON.stringify(parent.reviewers);
 const presented=presentAudit(parent);assert.equal(presented.gaps.length,1);
 const config={workspaceRoot:workspace,version:presented.supplementVersion,selections:presented.gaps.map(g=>({reviewerId:g.reviewerId,taskId:g.taskId}))};
 await assert.rejects(engine.supplement(parent.id,{...config,version:'stale'}),/VERSION_CONFLICT/);
 await assert.rejects(engine.supplement(parent.id,{...config,selections:[{reviewerId:parent.reviewers[0].id,taskId:'C-1'}]}),/INVALID_SUPPLEMENT_SELECTION/);
 const child=await engine.supplement(parent.id,config);await engine.active.promise;
 const saved=store.read('audits',child.id);assert.equal(saved.status,'COMPLETED');assert.deepEqual(saved.reviewers[0].checklist,['timeout']);
 assert.equal(saved.parentAudit.id,parent.id);assert.equal(calls[1].model,'test-gpt');assert.equal(calls[1].reasoningEffort,'high');assert.notEqual(calls[0].sessionId,calls[1].sessionId);
 const unchanged=store.read('audits',parent.id);assert.equal(JSON.stringify(unchanged.reviewers),original);assert.equal(unchanged.status,'PARTIAL');assert.equal(unchanged.findings.length,1);assert.equal(unchanged.supplementRuns[0].auditId,child.id);
});

test('2.8 missing checklist results prevent completion and source changes block supplemental calls',async t=>{
 const {store,workspace}=fixture(t);let snapshot='v1',calls=0;
 const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=>snapshot,agent:async()=>{calls++;return report();}});
 const parent=await finish(engine,opts(workspace,{reviewers:[{provider:'mock',checklist:['required check']}]}));
 assert.equal(parent.status,'PARTIAL');assert.equal(parent.reviewers[0].report.taskChecks[0].status,'UNCHECKED');
 const presented=presentAudit(parent);snapshot='v2';
 await assert.rejects(engine.supplement(parent.id,{workspaceRoot:workspace,version:presented.supplementVersion,selections:presented.gaps}),/AUDIT_SOURCE_CHANGED/);
 assert.equal(calls,1);assert.equal(store.list('audits').length,1);assert.equal(engine.active,null);
});

test('2.8 long coverage gaps remain supplementable without losing their full instructions',async t=>{
 const {store,workspace}=fixture(t),target='x'.repeat(3000);
 const engine=new AuditWorkflow(store,{catalog,preflight,snapshot:async()=> 'v1',agent:async()=>report([],{scopeComplete:false})});
 const parent=await finish(engine,opts(workspace,{reviewers:[{provider:'mock'}]}));
 parent.reviewers[0].report.coverageDetails=[{target,status:'UNCHECKED',checks:'inspect',limitations:'pending'}];store.save('audits',parent);
 const shown=presentAudit(parent);
 const child=await engine.supplement(parent.id,{workspaceRoot:workspace,version:shown.supplementVersion,selections:shown.gaps});await engine.active.promise;
 assert.ok(child.reviewers[0].checklist[0].length<=2000);
 assert.ok(child.reviewers[0].prompt.includes(target));
 assert.equal(child.parentAudit.selections[0].task,target);
});
