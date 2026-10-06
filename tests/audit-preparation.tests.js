'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {AgentHealth,checkReviewers,inspectProvider,probeFailure}=require('../engine/agent-health');
const {AuditTemplates}=require('../engine/audit-templates');
const {applyTriage,presentAudit,canRepair}=require('../engine/audit-triage');
const {AuditWorkflow}=require('../engine/audit-workflow');
const {RunStore}=require('../engine/run-store');
const localPass=async()=>({ok:true,code:'LOCAL_CHECK_PASSED',auth:'UNKNOWN'});
function fixture(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-preparation-'));
    const workspace=path.join(root,'project');fs.mkdirSync(workspace);
    t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    return {root,workspace,store:new RunStore(path.join(root,'state'))};
}
const finding=(more={})=>({id:'F-one',category:'BUG',severity:'HIGH',file:'app.js',lineRange:'1',problem:'Null dereference',evidence:'x.name on null',acceptance:'null does not throw',sources:[{reviewerId:'r1',evidence:'x.name on null'}],...more});
const record=()=>({status:'COMPLETED',findings:[finding()],triage:{}});
function decision(r,status='CONFIRMED',note='Reproduced null input'){const f=presentAudit(r).findings[0];return {findingId:f.id,evidenceKey:f.evidenceKey,version:f.triageVersion,status,note};}

test('local checks deduplicate providers, preserve independent settings and fail closed',async()=>{
    const seen=[];
    const data=await checkReviewers([{provider:'codex',model:'a'},{provider:'codex',model:'b'},{provider:'claude'}],{inspect:async p=>{seen.push(p);return {ok:p==='codex',code:p==='codex'?'LOCAL_CHECK_PASSED':'CLI_MISSING'};}});
    assert.deepEqual(seen,['codex','claude']);assert.equal(data.ok,false);assert.equal(data.results[1].model,'b');
    const broken=await inspectProvider('codex',{command:async()=>({code:1,stdout:'secret diagnostic text'})});
    assert.equal(broken.ok,false);assert(!JSON.stringify(broken).includes('secret'));
    const nonzero=await inspectProvider('codex',{command:async()=>({code:2,stdout:JSON.stringify({ok:true})})});assert.equal(nonzero.ok,false);
});
test('probe uses an empty isolated workspace and unique session, deduplicates only identical settings',async()=>{
    const seen=[];
    const health=new AgentHealth({inspect:localPass,agent:async request=>{
        seen.push(request);assert.deepEqual(fs.readdirSync(request.workspaceRoot),[]);assert.equal(request.role,'audit');
        assert(!request.prompt.includes('private project'));return request.prompt.match(/STUDIO_OK_[a-f0-9]+/)[0];
    }});
    const result=await health.run({mode:'probe',workspaceRoot:'private project',reviewers:[{provider:'codex',model:'a',prompt:'private project'},{provider:'codex',model:'a'},{provider:'codex',model:'b'}]});
    assert.equal(result.ok,true);assert.equal(seen.length,2);assert.notEqual(seen[0].sessionId,seen[1].sessionId);
    for(const req of seen)assert(!fs.existsSync(req.workspaceRoot));assert.equal(health.active,null);
});
test('mock is explicitly simulated; unsuccessful probes never report connectivity success',async()=>{
    let calls=0;const health=new AgentHealth({inspect:localPass,agent:async()=>{calls++;throw new Error('API_KEY=secret');}});
    const result=await health.run({mode:'probe',reviewers:[{provider:'mock'},{provider:'codex'}]});
    assert.equal(result.ok,false);assert.equal(result.results[0].probe,'MOCK_ONLY');assert.equal(result.results[1].probe,'FAILED');assert.equal(calls,1);
    assert(!JSON.stringify(result).includes('secret'));
    const malformed=new AgentHealth({inspect:localPass,agent:async()=> 'hello'});
    assert.equal((await malformed.run({mode:'probe',reviewers:[{provider:'codex'}]})).results[0].probe,'UNEXPECTED_RESPONSE');
});
test('probe diagnoses a newer-CLI requirement without revealing the raw service response',()=>{
    assert.equal(probeFailure(new Error("The model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.")),'CLI_UPGRADE_REQUIRED');
    assert.equal(probeFailure(new Error('insufficient credits private account data')),'QUOTA_OR_RATE_LIMIT');
    assert.equal(probeFailure(new Error('Unauthorized token=secret')),'AUTH_REQUIRED');
});
test('diagnostics reserve their slot and cancellation settles child work before releasing it',async()=>{
    let entered;const ready=new Promise(r=>{entered=r;});let dir;
    const health=new AgentHealth({inspect:localPass,agent:async(req,{signal})=>{dir=req.workspaceRoot;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
    const work=health.run({mode:'probe',reviewers:[{provider:'codex'}]});const rejection=assert.rejects(work,/RUN_CANCELLED/);await ready;
    assert.throws(()=>health.run({mode:'check',reviewers:[{provider:'mock'}]}),/BUSY/);await health.stop();await rejection;
    assert.equal(health.active,null);assert(!fs.existsSync(dir));
});
test('failed audit preflight prevents all reviewer execution and stores the reason',async t=>{
    const {workspace,store}=fixture(t);let calls=0;
    const engine=new AuditWorkflow(store,{preflight:async()=>({ok:false,results:[{provider:'mock',code:'CLI_MISSING'}]}),agent:async()=>{calls++;}});
    const run=engine.create({workspaceRoot:workspace,commonPrompt:'check',reviewers:[{provider:'mock'}]});engine.launch(run);await engine.active.promise;
    const saved=store.read('audits',run.id);assert.equal(saved.status,'FAILED');assert.equal(calls,0);assert.match(saved.error,/PREFLIGHT/);assert.equal(saved.reviewers[0].attempt,0);
});
test('templates persist configuration only, isolate project scope and reject stale edits/deletion',t=>{
    const {root,workspace}=fixture(t),other=path.join(root,'other');fs.mkdirSync(other);
    const store=new AuditTemplates(path.join(root,'state'),{});
    const input={name:'My team',scope:'project',workspaceRoot:workspace,config:{commonPrompt:'Check code',scope:'app',concurrency:2,timeoutSeconds:60,reviewers:[{provider:'mock',name:'Logic',sessionId:'discard'}],token:'discard'}};
    const project=store.save(input),global=store.save({...input,scope:'global',name:'Shared'});
    assert.equal(store.list(workspace).length,2);assert.deepEqual(store.list(other).map(t=>t.id),[global.id]);
    assert(!JSON.stringify(project).includes('discard'));
    const reopened=new AuditTemplates(path.join(root,'state'),{});assert.equal(reopened.list(workspace)[0].version,1);
    const updated=reopened.save({...input,id:project.id,version:1,name:'Renamed'});assert.equal(updated.version,2);
    assert.throws(()=>store.save({...input,id:project.id,version:1}),/CONFLICT/);
    assert.throws(()=>store.remove({id:project.id,version:1,workspaceRoot:workspace}),/CONFLICT/);
    assert.throws(()=>store.remove({id:project.id,version:2,workspaceRoot:other}),/MISMATCH/);
    store.remove({id:project.id,version:2,workspaceRoot:workspace});assert.equal(store.list(workspace).length,1);
    assert.throws(()=>store.save({...input,config:{...input.config,reviewers:[{provider:'cursor'}]}}),/UNSUPPORTED/);
});
test('triage requires evidence and version, does not authorize questions, and keeps decision history',()=>{
    const r=record();assert.equal(canRepair(r,r.findings[0]),false);
    assert.throws(()=>applyTriage(r,decision(r,'CONFIRMED','')),/REASON/);
    const request=decision(r);applyTriage(r,request);assert.equal(canRepair(r,r.findings[0]),true);
    assert.throws(()=>applyTriage(r,request),/CONFLICT/);
    applyTriage(r,decision(r,'DISMISSED','The input contract forbids null'));assert.equal(canRepair(r,r.findings[0]),false);assert.equal(r.triage['F-one'].history.length,2);
    r.findings[0].category='QUESTION';assert.throws(()=>applyTriage(r,decision(r)),/CATEGORY/);
    r.findings[0].category='SUGGESTION';applyTriage(r,decision(r,'ACCEPTED','Approved simplification'));assert.equal(canRepair(r,r.findings[0]),true);
});
test('new audit evidence invalidates old decisions without erasing history or accepting stale forms',()=>{
    const r=record();applyTriage(r,decision(r));const oldForm=decision(r);
    r.findings[0].sources.push({reviewerId:'r2',evidence:'Contradictory evidence'});
    assert.equal(canRepair(r,r.findings[0]),false);const presented=presentAudit(r).findings[0];assert.equal(presented.triage,null);assert.equal(presented.triageHistory.length,1);
    assert.throws(()=>applyTriage(r,oldForm),/CONFLICT/);applyTriage(r,decision(r,'DEFERRED','Need to investigate disagreement'));assert.equal(r.triage['F-one'].history.length,2);
    r.status='RUNNING';assert.throws(()=>applyTriage(r,decision(r)),/NOT_READY/);
});
