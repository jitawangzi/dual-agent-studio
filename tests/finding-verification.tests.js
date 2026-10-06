'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {RunStore}=require('../engine/run-store');
const {AuditWorkflow}=require('../engine/audit-workflow');
const {Workflow}=require('../engine/workflow');
const {presentAudit}=require('../engine/audit-triage');
const {parseVerification}=require('../engine/finding-verification');
const report=(more={})=>JSON.stringify({verdict:'SUPPORTED_BY_CODE',summary:'Null access supported by code',evidence:'app.js reads x.name',steps:['Inspect app.js and call with null'],expected:'Returns empty',actual:'Source has no guard',limitations:'Static inspection, no command executed',executionQuote:'',...more});
async function fixture(t,options={}){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-verify-')),workspace=path.join(root,'project');fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace,'app.js'),'module.exports = x => x.name;');
    t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const store=new RunStore(path.join(root,'state'));
    const engine=new AuditWorkflow(store,{snapshot:async()=> 'same',preflight:async()=>({ok:true,results:[]}),...options});
    const audit=engine.create({workspaceRoot:workspace,commonPrompt:'Check code',reviewers:[{provider:'mock'}]});
    audit.status='COMPLETED';audit.snapshot='same';audit.findings=[{id:'F-one',category:'BUG',severity:'HIGH',file:'app.js',lineRange:'1',problem:'Null crash',evidence:'x.name on null',acceptance:'Null returns empty',sources:[]}];engine.save(audit);
    const config=()=>({workspaceRoot:workspace,findings:presentAudit(store.read('audits',audit.id)).findings.map(f=>({id:f.id,evidenceKey:f.evidenceKey})),verifier:{provider:'mock',name:'Independent'}});
    const state=()=>store.read('audits',audit.id);
    const verify=async(more={})=>{const run=engine.verify(audit.id,{...config(),...more});await engine.active.promise;return state().verificationRuns.find(v=>v.id===run.id);};
    return {root,workspace,store,engine,audit,config,state,verify};
}
test('independent verification uses new sessions, saved source evidence, and keeps manual triage untouched',async t=>{
    const calls=[];const f=await fixture(t,{agent:async r=>{calls.push(r);return report();}});
    let finding=presentAudit(f.state()).findings[0];f.engine.triage(f.audit.id,{findingId:finding.id,evidenceKey:finding.evidenceKey,version:0,status:'CONFIRMED',note:'Manual code analysis'});
    const run=await f.verify();assert.equal(run.status,'COMPLETED');assert.equal(run.reproduction.status,'NOT_REQUESTED');
    assert.equal(calls[0].role,'verify-finding');assert.notEqual(calls[0].sessionId,f.audit.reviewers[0].sessionId);assert.match(calls[0].prompt,/x.name on null/);
    finding=presentAudit(f.state()).findings[0];assert.equal(finding.repairable,false);assert.equal(finding.triage,null);assert.equal(finding.triageHistory.length,1);
    assert.equal(finding.verification.report.verdict,'SUPPORTED_BY_CODE');
    assert.throws(()=>f.engine.triage(f.audit.id,{findingId:finding.id,evidenceKey:finding.evidenceKey,version:1,status:'CONFIRMED',note:'old page'}),/CONFLICT/);
    f.engine.triage(f.audit.id,{findingId:finding.id,evidenceKey:finding.evidenceKey,verificationKey:finding.verificationKey,version:1,status:'CONFIRMED',note:'Reviewed independent evidence'});
    assert.equal(presentAudit(f.state()).findings[0].repairable,true);
    await f.verify();assert.notEqual(calls[0].sessionId,calls[1].sessionId);assert.equal(presentAudit(f.state()).findings[0].verificationHistory.length,2);
});
test('reproduction claims require an executed command, matching quote and appropriate category',()=>{
    assert.throws(()=>parseVerification(report({verdict:'REPRODUCED'}),{status:'NOT_REQUESTED'},'BUG'),/EVIDENCE_REQUIRED/);
    const execution={status:'COMPLETED',code:1,stdout:'trigger: null crash',stderr:''};
    assert.throws(()=>parseVerification(report({verdict:'REPRODUCED',executionQuote:'invented'}),execution,'BUG'),/EVIDENCE_REQUIRED/);
    assert.throws(()=>parseVerification(report({verdict:'REPRODUCED',executionQuote:'trigger: null crash'}),execution,'QUESTION'),/CATEGORY/);
    assert.equal(parseVerification(report({verdict:'NOT_REPRODUCED',executionQuote:'exitCode: 1'}),execution,'BUG').verdict,'NOT_REPRODUCED');
});
test('real command output is retained and nonzero exit is evidence rather than automatic bug confirmation',async t=>{
    const f=await fixture(t,{agent:async req=>{
        assert.match(req.prompt,/specific-trigger/);return report({verdict:'REPRODUCED',actual:'specific-trigger',executionQuote:'specific-trigger',limitations:'Only this trigger tested'});
    }});
    assert.throws(()=>f.engine.verify(f.audit.id,{...f.config(),reproductionCommand:'exit 1'}),/ACKNOWLEDGEMENT/);
    const run=await f.verify({reproductionCommand:"Write-Output 'specific-trigger'; exit 3",executeReproduction:true});
    assert.equal(run.status,'COMPLETED');assert.equal(run.reproduction.code,3);assert.match(run.reproduction.stdout,/specific-trigger/);
    assert.match(fs.readFileSync(f.store.file('audits',f.audit.id,run.reproduction.artifact),'utf8'),/specific-trigger/);
    assert.equal(f.state().triage?.['F-one'],undefined);assert.equal(presentAudit(f.state()).findings[0].repairable,false);
});
test('malformed findings, missing acknowledgement and stale evidence fail before agent execution',async t=>{
    const f=await fixture(t,{agent:async()=>{throw new Error('must not call');}});
    for(const findings of [[],[{id:'missing',evidenceKey:'x'}],[{id:'F-one',evidenceKey:'stale'}],Array(21).fill({id:'F-one'})])assert.throws(()=>f.engine.verify(f.audit.id,{...f.config(),findings}));
    assert.throws(()=>f.engine.verify(f.audit.id,{...f.config(),verifier:{provider:'cursor'}}),/UNSUPPORTED/);
    const r=f.state();r.status='PARTIAL';f.engine.save(r);assert.throws(()=>f.engine.verify(f.audit.id,f.config()),/ACKNOWLEDGEMENT/);
});
test('source changes before or during verification invalidate every conclusion',async t=>{
    let version='changed',calls=0;
    const f=await fixture(t,{snapshot:async()=>version,agent:async()=>{calls++;version='changed';return report();}});
    const first=await f.verify();assert.equal(first.status,'INVALIDATED');assert.equal(calls,0);assert.equal(f.state().status,'INVALIDATED');
    const restored=f.state();restored.status='COMPLETED';f.engine.save(restored);version='same';
    const second=await f.verify();assert.equal(second.status,'INVALIDATED');assert.equal(calls,1);assert.equal(presentAudit(f.state()).findings[0].verification.stale,true);
});
test('stop cancels verification, leaves queued items unexecuted, and prevents concurrent mutations',async t=>{
    let entered;const ready=new Promise(r=>{entered=r;});let calls=0;
    const f=await fixture(t,{agent:async(req,{signal})=>{calls++;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));}});
    const r=f.state();r.findings.push({...r.findings[0],id:'F-two',problem:'Another issue'});f.engine.save(r);
    f.engine.verify(f.audit.id,f.config());await ready;
    assert.throws(()=>f.engine.verify(f.audit.id,f.config()),/BUSY/);assert.throws(()=>f.engine.triage(f.audit.id,{}),/BUSY/);
    await assert.rejects(f.engine.repair(new Workflow(f.store),f.audit.id,{}),/BUSY/);
    await f.engine.stop();const run=f.state().verificationRuns[0];assert.equal(run.status,'STOPPED');assert.equal(calls,1);assert(run.items.every(i=>i.status==='STOPPED'));assert.equal(f.engine.active,null);
});
test('verification restart recovery preserves live PID protection and never resumes commands automatically',async t=>{
    const f=await fixture(t,{agent:async()=>report()});await f.verify();const r=f.state(),run=r.verificationRuns[0];
    run.status='RUNNING';run.items[0].status='RUNNING';run.items[0].activePid=process.pid;f.engine.save(r);f.engine.recover();
    assert.equal(f.state().verificationRuns[0].status,'INTERRUPTED');assert.equal(f.state().verificationRuns[0].items[0].activePid,process.pid);
    assert.throws(()=>f.engine.verify(f.audit.id,f.config()),/STILL_RUNNING/);assert.throws(()=>f.engine.triage(f.audit.id,{}),/STILL_RUNNING/);
});
test('one invalid answer yields partial verification while retaining valid reports and raw responses',async t=>{
    let calls=0;const f=await fixture(t,{agent:async()=>++calls===1?report():report({verdict:'REPRODUCED',executionQuote:'fake'})});
    const r=f.state();r.findings.push({...r.findings[0],id:'F-two'});f.engine.save(r);const run=await f.verify();
    assert.equal(run.status,'PARTIAL');assert.equal(run.items[0].status,'COMPLETED');assert.equal(run.items[1].status,'FAILED');
    assert.match(run.items[1].error,/EVIDENCE_REQUIRED/);assert(fs.existsSync(f.store.file('audits',f.audit.id,run.items[1].responseArtifact)));
});
test('command timeout or process failure is a failed verification, not a negative finding verdict',async t=>{
    let calls=0;const f=await fixture(t,{command:async()=>{throw new Error('EXECUTION_TIMEOUT');},agent:async()=>{calls++;return report();}});
    const run=await f.verify({reproductionCommand:'test fixture command',executeReproduction:true});assert.equal(run.status,'FAILED');assert.equal(run.reproduction.status,'FAILED');assert.equal(calls,0);assert.equal(run.items[0].report,null);assert.equal(run.items[0].status,'FAILED');
});

test('a command that changes source before failing invalidates the original audit evidence',async t=>{
    let version='same',calls=0;
    const f=await fixture(t,{snapshot:async()=>version,command:async()=>{version='changed';throw new Error('EXECUTION_TIMEOUT');},agent:async()=>{calls++;return report();}});
    const run=await f.verify({reproductionCommand:'test fixture command',executeReproduction:true});
    assert.equal(run.status,'INVALIDATED');assert.equal(f.state().status,'INVALIDATED');assert.equal(calls,0);
    assert.equal(run.reproduction.status,'FAILED');assert.equal(run.reproduction.error,'EXECUTION_TIMEOUT');
    assert.equal(run.items[0].status,'INVALIDATED');assert.equal(presentAudit(f.state()).findings[0].verification.stale,true);
});
test('repair carries the reviewed verification evidence into both provenance and developer instructions',async t=>{
    const f=await fixture(t,{agent:async()=>report()});await f.verify();const finding=presentAudit(f.state()).findings[0];
    f.engine.triage(f.audit.id,{findingId:finding.id,evidenceKey:finding.evidenceKey,verificationKey:finding.verificationKey,version:0,status:'CONFIRMED',note:'Confirmed after independent check'});
    let sent;
    const workflow=new Workflow(f.store,{snapshot:async()=> 'same',agent:async req=>{sent=req.prompt;return JSON.stringify({summary:'Ask human',needsDecision:true});}});
    const run=await f.engine.repair(workflow,f.audit.id,{findingIds:[finding.id],devProvider:'mock',reviewProvider:'mock',verifyCommand:'node --check app.js'});
    if(workflow.active)await workflow.active.promise;
    assert.equal(run.sourceAudit.verificationEvidence[0].verification.report.verdict,'SUPPORTED_BY_CODE');assert.match(sent,/Null access supported by code/);
});
