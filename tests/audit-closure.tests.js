'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {RunStore,workspaceKey}=require('../engine/run-store');
const {AuditWorkflow}=require('../engine/audit-workflow');
const {closureView}=require('../engine/audit-closure');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-closure-')),ws=path.join(dir,'project');fs.mkdirSync(ws);fs.writeFileSync(path.join(ws,'app.js'),'const x=1;');
 t.after(()=>{assert.equal(path.dirname(dir),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
 const store=new RunStore(path.join(dir,'state'));
 const engine=new AuditWorkflow(store,{snapshot:async()=> 'v1',preflight:async()=>({ok:true,results:[]}),agent:async()=>JSON.stringify({summary:'checked',scopeComplete:true,coverage:['app.js'],findings:[]}),command:async()=>({code:0,stdout:'passed',stderr:''})});
 return {ws,store,engine};
}
async function audit(f,checklist=[]){const a=f.engine.create({workspaceRoot:f.ws,commonPrompt:'check',scope:'app.js',reviewers:[{provider:'mock',checklist}]});f.engine.launch(a);await f.engine.active.promise;return f.store.read('audits',a.id);}
test('closure resolves selected gaps through supplements, never edits the original, and expires with source',async t=>{
 const f=fixture(t),a=await audit(f,['required']);const original=JSON.stringify(a.reviewers);
 const {presentAudit}=require('../engine/audit-triage');const p=presentAudit(a);
 let view=closureView(f.store,a.id,'v1');assert.equal(view.coverage[0].complete,false);
 f.engine.agent=async()=>JSON.stringify({summary:'checked',scopeComplete:true,coverage:['app.js'],taskChecks:[{id:'C-1',status:'CHECKED',evidence:'source inspected'}],findings:[]});
 const child=await f.engine.supplement(a.id,{workspaceRoot:f.ws,version:p.supplementVersion,selections:p.gaps});await f.engine.active.promise;
 view=closureView(f.store,child.id,'v1');assert.equal(view.rootId,a.id);assert.equal(view.coverage[0].complete,true);assert.equal(view.ready,false);
 assert.equal(JSON.stringify(f.store.read('audits',a.id).reviewers),original);
 assert.equal(closureView(f.store,a.id,'v2').coverage[0].complete,false);
});
test('human acceptance requires current real test, version and note; later failure revokes validity',async t=>{
 const f=fixture(t),a=await audit(f);let view=closureView(f.store,a.id,'v1');
 await assert.rejects(f.engine.acceptClosure(a.id,{workspaceRoot:f.ws,version:view.version,note:'accept'}),/CLOSURE_BLOCKED/);
 f.engine.testClosure(a.id,{workspaceRoot:f.ws,command:'node --check app.js',execute:true});await f.engine.active.promise;
 view=closureView(f.store,a.id,'v1');assert.equal(view.ready,true);
 await assert.rejects(f.engine.acceptClosure(a.id,{workspaceRoot:f.ws,version:'old',note:'accept'}),/VERSION_CONFLICT/);
 await assert.rejects(f.engine.acceptClosure(a.id,{workspaceRoot:f.ws,version:view.version,note:''}),/NOTE_REQUIRED/);
 await f.engine.acceptClosure(a.id,{workspaceRoot:f.ws,version:view.version,note:'Reviewed evidence'});
 assert.equal(closureView(f.store,a.id,'v1').acceptance.current,true);
 assert.equal(closureView(f.store,a.id,'v2').acceptance.current,false);
 f.engine.command=async()=>({code:1,stdout:'',stderr:'failed'});f.engine.testClosure(a.id,{workspaceRoot:f.ws,command:'node --check app.js',execute:true});await f.engine.active.promise;
 view=closureView(f.store,a.id,'v1');assert.equal(view.ready,false);assert.equal(view.acceptance.current,false);
});
test('untriaged findings block acceptance and justified deferral stays visible',async t=>{
 const f=fixture(t),a=await audit(f);a.findings=[{id:'F-1',category:'BUG',severity:'HIGH',file:'app.js',lineRange:'1',problem:'null',evidence:'source',acceptance:'guard',sources:[]}];f.store.save('audits',a);
 let view=closureView(f.store,a.id,'v1');assert.equal(view.findings[0].state,'TRIAGE');
 const {presentAudit}=require('../engine/audit-triage');const p=presentAudit(a).findings[0];f.engine.triage(a.id,{findingId:p.id,evidenceKey:p.evidenceKey,version:0,status:'DEFERRED',note:'Environment unavailable; revisit next release'});
 view=closureView(f.store,a.id,'v1');assert.equal(view.findings[0].state,'DEFERRED');assert.match(view.findings[0].note,/revisit/);
});

test('old closed repair cannot close a newer discovery; stale repair evidence also stays open',async t=>{
 const f=fixture(t),a=await audit(f),finding={id:'F-1',category:'BUG',severity:'HIGH',file:'app.js',lineRange:'1',problem:'null',evidence:'source',acceptance:'guard',sources:[]};
 a.findings=[finding];a.createdAt='2026-10-06T03:00:00Z';f.store.save('audits',a);
 const run={id:crypto.randomUUID(),workspaceRoot:f.ws,workspaceKey:workspaceKey(f.ws),sourceAudit:{id:a.id},createdAt:'2026-10-06T01:00:00Z',status:'APPROVED',lastReview:{snapshot:'v1',at:'2026-10-06T02:00:00Z'},testGate:{status:'PASS',exitCode:0,snapshot:'v1',at:'2026-10-06T02:00:00Z'},bugs:[{...finding,sourceFindingId:'F-1',status:'VERIFIED_CLOSED'}]};f.store.save('runs',run);
 assert.notEqual(closureView(f.store,a.id,'v1').findings[0].state,'CLOSED');
 a.createdAt='2026-10-06T00:00:00Z';f.store.save('audits',a);
 run.bugs[0].history=[{status:'VERIFIED_CLOSED',snapshot:'v0',at:'2026-10-06T02:00:00Z',evidence:'old source'}];f.store.save('runs',run);
 assert.notEqual(closureView(f.store,a.id,'v1').findings[0].state,'CLOSED');
 run.bugs[0].history[0].snapshot='v1';f.store.save('runs',run);
 assert.equal(closureView(f.store,a.id,'v1').findings[0].state,'CLOSED');
 assert.notEqual(closureView(f.store,a.id,'v2').findings[0].state,'CLOSED');
});

test('source recheck keeps original findings and replaces coverage baseline with a fresh linked team',async t=>{
 const f=fixture(t),a=await audit(f);f.engine.snapshot=async()=> 'v2';
 assert.equal(closureView(f.store,a.id,'v2').coverage[0].complete,false);
 const child=f.engine.recheckClosure(a.id,{workspaceRoot:f.ws});await f.engine.active.promise;
 const view=closureView(f.store,a.id,'v2');assert.equal(view.baselineId,child.id);assert.equal(view.coverage[0].complete,true);
 assert.notEqual(child.reviewers[0].sessionId,a.reviewers[0].sessionId);assert.equal(f.store.read('audits',a.id).snapshot,'v1');
});

test('closure test requires consent, reserves workspace, aborts and recovers without granting PASS',async t=>{
 const f=fixture(t),a=await audit(f);assert.throws(()=>f.engine.testClosure(a.id,{workspaceRoot:f.ws,command:'node app.js'}),/ACK_REQUIRED/);
 let started;const ready=new Promise(r=>started=r);
 f.engine.command=async(_cmd,_args,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('RUN_CANCELLED')),{once:true});started();});
 f.engine.testClosure(a.id,{workspaceRoot:f.ws,command:'node app.js',execute:true});await ready;
 assert.throws(()=>f.engine.recheckClosure(a.id,{workspaceRoot:f.ws}),/BUSY/);await f.engine.stop();
 assert.equal(f.store.read('audits',a.id).closureTests[0].status,'STOPPED');assert.equal(f.engine.active,null);
 const saved=f.store.read('audits',a.id);saved.closureTests[0].status='RUNNING';saved.closureTests[0].activePid=process.pid;f.store.save('audits',saved);f.engine.recover();
 assert.equal(f.store.read('audits',a.id).closureTests[0].status,'INTERRUPTED');
 assert.throws(()=>f.engine.testClosure(a.id,{workspaceRoot:f.ws,command:'node app.js',execute:true}),/STILL_RUNNING/);
 assert.throws(()=>f.engine.triage(a.id,{}),/STILL_RUNNING/);
});

test('a successful sibling supplement cannot hide a new gap discovered by an earlier supplement',async t=>{
 const f=fixture(t),a=await audit(f,['original']);const {presentAudit}=require('../engine/audit-triage'),p=presentAudit(a);
 const input={workspaceRoot:f.ws,version:p.supplementVersion,selections:p.gaps};
 f.engine.agent=async()=>JSON.stringify({summary:'new gap',scopeComplete:false,coverage:['app.js'],taskChecks:[{id:'C-1',status:'CHECKED',evidence:'checked'}],coverageDetails:[{target:'extra branch',status:'UNCHECKED',checks:'pending',limitations:'missing'}],findings:[]});
 const child=await f.engine.supplement(a.id,input);await f.engine.active.promise;
 f.engine.agent=async()=>JSON.stringify({summary:'original done',scopeComplete:true,coverage:['app.js'],taskChecks:[{id:'C-1',status:'CHECKED',evidence:'checked'}],findings:[]});
 await f.engine.supplement(a.id,input);await f.engine.active.promise;
 const view=closureView(f.store,a.id,'v1');assert.ok(view.coverage.some(c=>c.auditId===child.id&&!c.complete));
});

test('latest finding occurrence wins across audit creation order',async t=>{
 const f=fixture(t),a=await audit(f),finding={id:'F-1',category:'BUG',severity:'HIGH',file:'app.js',problem:'null',evidence:'source',acceptance:'guard',sources:[{reviewerId:a.reviewers[0].id}]};
 a.createdAt='2026-01-01';a.reviewers[0].finishedAt='2026-01-06';a.findings=[finding];f.store.save('audits',a);
 const child=structuredClone(a);child.id=crypto.randomUUID();child.createdAt='2026-01-02';child.parentAudit={id:a.id,mode:'RECHECK'};child.reviewers[0].finishedAt='2026-01-02';f.store.save('audits',child);
 f.store.save('runs',{id:crypto.randomUUID(),workspaceKey:a.workspaceKey,createdAt:'2026-01-03',sourceAudit:{id:child.id},status:'APPROVED',lastReview:{snapshot:'v1',at:'2026-01-04'},testGate:{status:'PASS',snapshot:'v1',exitCode:0,at:'2026-01-04'},bugs:[{...finding,sourceFindingId:'F-1',status:'VERIFIED_CLOSED'}]});
 const view=closureView(f.store,a.id,'v1');assert.equal(view.findings[0].auditId,a.id);assert.equal(view.findings[0].state,'TRIAGE');assert.equal(view.ready,false);
});

test('closure HTTP executes a real test, rejects stale acceptance and retains invalidated acceptance history',async t=>{
 const f=fixture(t);f.engine.snapshot=require('../engine/workflow').sourceSnapshot;const a=await audit(f);
 process.env.STUDIO_DATA_DIR=f.store.root;const {server}=require('../server');await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,call=async(action,body)=>{const response=await fetch(`${base}/api/audits/${a.id}/${action}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const input={workspaceRoot:f.ws};assert.equal((await call('closure-test',{...input,command:'node --check app.js'})).status,400);
 assert.equal((await call('closure-test',{...input,command:'node --check app.js',execute:true})).status,202);
 let view;for(let i=0;i<100;i++){view=(await call('closure')).data;if(view.test?.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(view.test.status,'PASS');assert.equal(view.ready,true);
 assert.equal((await call('closure-accept',{...input,version:'stale',note:'checked'})).status,409);
 assert.equal((await call('closure-accept',{...input,version:view.version,note:'checked'})).status,200);
 assert.equal((await call('closure')).data.acceptance.current,true);
 await call('closure-accept',{...input,version:view.version,note:'repeat'});assert.equal((await call('closure')).data.history.length,1);
 fs.appendFileSync(path.join(f.ws,'app.js'),'\n// new source');
 const changed=(await call('closure')).data;assert.equal(changed.ready,false);assert.equal(changed.acceptance.current,false);assert.equal(changed.history.length,1);
 assert.equal((await call('closure-accept',{...input,version:view.version,note:'old page'})).status,409);
});
