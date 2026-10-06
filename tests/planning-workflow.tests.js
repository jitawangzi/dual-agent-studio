'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {PlanningWorkflow,compileDecision,investigation,challenge}=require('../engine/planning-workflow');
const {RunStore}=require('../engine/run-store');
const {Workflow,applyReview}=require('../engine/workflow');
const {comparePlans}=require('../engine/planning-state');
const criterion={criterion:'Invalid input returns a clear error',verification:'Run invalid-input regression and inspect output'};
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-planning-')),workspace=path.join(root,'project');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'app.js'),'const value = 1;');
  t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const store=new RunStore(path.join(root,'records')),engine=new PlanningWorkflow(store,{snapshot:async()=>'v1',preflight:async()=>({ok:true}),agent:answer,...overrides});
  const config={workspaceRoot:workspace,idea:'Improve validation',members:[{name:'Architecture',provider:'mock'},{name:'Quality',provider:'mock'}]};return {root,workspace,store,engine,config};
}
async function answer(request){
  if(request.role==='plan-investigate')return JSON.stringify({summary:'Small source file',observations:[{file:'app.js',evidence:'Contains a constant, no validation'}],constraints:['Keep current API'],questions:['Allow empty input?']});
  if(request.role==='plan-propose')return JSON.stringify({summary:'Validation proposal',questions:[],proposals:[{title:'Validate input',approach:'Add validation at entry',benefits:'Clear failure',risks:'Changed error behavior',acceptance:[criterion],outOfScope:['Architecture rewrite']}]});
  if(request.role==='plan-challenge'){const others=JSON.parse(/^Other proposals: (.+)$/m.exec(request.prompt)[1]);return JSON.stringify({reviews:others.map(p=>({proposalId:p.id,position:'CONCERN',reason:'Clarify empty input semantics first'})),questions:[]});}
  throw new Error('Unexpected role '+request.role);
}
async function ready(f){const r=f.engine.create(f.config);f.engine.launch(r);await f.engine.active.promise;return f.store.read('discussions',r.id);}
function decision(r){return {workspaceRoot:r.workspaceRoot,version:r.version,selections:r.members.flatMap(m=>m.proposal.proposals).map((p,i)=>({proposalId:p.id,decision:i?'DEFER':'ADOPT',reason:i?'Avoid duplicate work':'Bounded improvement',acceptance:[criterion]})),answers:r.questions.map(q=>({questionId:q.id,answer:'Reject empty input'}))};}
test('planning investigates first, independently proposes then challenges with fresh sessions and bounded concurrency',async t=>{
  const calls=[];let active=0,peak=0;const f=fixture(t,{agent:async r=>{calls.push(r);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return answer(r);}});
  f.config.members=Array.from({length:6},(_,i)=>({name:'Member '+i,provider:'mock'}));const r=await ready(f);
  assert.equal(r.status,'READY',r.error);assert.equal(calls.length,13);assert.equal(peak,3);assert.equal(calls[0].role,'plan-investigate');
  assert(calls.slice(1,7).every(c=>c.role==='plan-propose'));assert(calls.slice(7).every(c=>c.role==='plan-challenge'));
  assert.equal(new Set(calls.map(c=>c.sessionId)).size,13);assert.equal(r.questions.length,1);assert(r.members.every(m=>m.challenge.reviews.length===5));
  assert.equal(fs.readdirSync(f.workspace).join(','),'app.js');assert(fs.readdirSync(path.dirname(f.store.file('discussions',r.id))).some(n=>n.endsWith('.response.txt')));
});
test('decision covers every proposal and business question; edited acceptance binds preview and immutable approval',async t=>{
  const f=fixture(t),r=await ready(f),body=decision(r);
  assert.throws(()=>compileDecision(r,{...body,selections:[]}),/INVALID_PLANNING_LIST/);
  assert.throws(()=>compileDecision(r,{...body,answers:[]}),/INVALID_PLANNING_LIST/);
  assert.throws(()=>compileDecision(r,{...body,version:0}),/VERSION_CONFLICT/);
  assert.throws(()=>compileDecision(r,{...body,selections:body.selections.map(s=>({...s,decision:'DEFER'}))}),/REQUIRES_SELECTED/);
  assert.throws(()=>compileDecision(r,{...body,selections:body.selections.map(s=>({...s,reason:''}))}),/INVALID_PLANNING_TEXT/);
  const preview=f.engine.preview(r.id,body);body.selections[0].acceptance[0]={criterion:'Reject blank strings too',verification:'Check blank-string regression'};
  await assert.rejects(f.engine.approve(r.id,{...body,previewHash:preview.previewHash}),/PREVIEW_CONFLICT/);
  const changed=f.engine.preview(r.id,body);assert.notEqual(changed.previewHash,preview.previewHash);
  const plan=await f.engine.approve(r.id,{...body,previewHash:changed.previewHash});assert.equal(plan.status,'APPROVED');assert.equal(plan.finalPlan,changed.finalPlan);assert.equal(plan.requirements[0].id,'A-001');
  const launch={workspaceRoot:f.workspace,planId:plan.id,approvalId:plan.approval.id,taskPrompt:plan.finalPlan};assert.equal(f.store.approvedPlan(launch).id,plan.id);
  plan.requirements[0].criterion='tampered';f.store.save('plans',plan);assert.throws(()=>f.store.approvedPlan(launch),/APPROVED_PLAN_CHANGED/);
  await assert.rejects(f.engine.approve(r.id,{...body,previewHash:changed.previewHash}),/NOT_READY/);
});
test('source changes, failed agents, malformed evidence and incomplete cross reviews fail closed',async t=>{
  let source='v1';const f=fixture(t,{snapshot:async()=>source}),r=await ready(f),body=decision(r),preview=f.engine.preview(r.id,body);source='v2';
  await assert.rejects(f.engine.approve(r.id,{...body,previewHash:preview.previewHash}),/SOURCE_CHANGED/);assert.equal(f.store.read('discussions',r.id).status,'INVALIDATED');assert.equal(f.store.list('plans').length,0);
  f.engine.agent=async req=>{if(req.role==='plan-propose')throw new Error('CLI_CRASH');return answer(req);};const failed=await ready(f);assert.equal(failed.status,'FAILED');assert.throws(()=>f.engine.preview(failed.id,{}),/NOT_READY/);
  assert.throws(()=>investigation(JSON.stringify({summary:'claim',observations:[{file:'../records/state.json',evidence:'bad'}],constraints:[],questions:[]}),f.workspace),/INVALID_INVESTIGATION_PATH/);
  assert.throws(()=>challenge(JSON.stringify({reviews:[],questions:[]}),['P-1-1']),/INVALID_PLANNING_LIST/);
  assert.throws(()=>challenge(JSON.stringify({reviews:[{proposalId:'P-1-1',position:'SUPPORT',reason:'x'},{proposalId:'P-1-1',position:'SUPPORT',reason:'x'}],questions:[]}),['P-1-1','P-2-1']),/INVALID_PLANNING_REVIEW/);
});
test('stop and recovery retain interruption evidence, block live orphan calls and support a new revision',async t=>{
  let entered;const started=new Promise(r=>entered=r);const f=fixture(t,{agent:async(req,{signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('RUN_CANCELLED')),{once:true}));}});
  const r=f.engine.create(f.config);f.engine.launch(r);await started;await f.engine.stop();assert.equal(f.store.read('discussions',r.id).status,'STOPPED');
  const old=f.store.read('discussions',r.id);old.status='RUNNING';old.calls[0].activePid=process.pid;f.store.save('discussions',old);f.engine.recover();assert.equal(f.store.read('discussions',r.id).status,'INTERRUPTED');assert.throws(()=>f.engine.create(f.config),/STILL_RUNNING/);
  old.status='INTERRUPTED';old.calls[0].activePid=null;f.store.save('discussions',old);f.engine.agent=answer;
  const revision=f.engine.create({...f.config,parentId:r.id,feedback:'Keep the public API stable'});assert.equal(revision.parentId,r.id);assert.equal(revision.feedback,'Keep the public API stable');
});
test('approved source is checked before implementation and criterion evidence is required for closure',async t=>{
  const f=fixture(t),r=await ready(f),body=decision(r),preview=f.engine.preview(r.id,body),plan=await f.engine.approve(r.id,{...body,previewHash:preview.previewHash});let calls=0;
  const engine=new Workflow(f.store,{snapshot:async()=>'changed',agent:async()=>{calls++;return '{}';}}),run=engine.create({workspaceRoot:f.workspace,mode:'plan',planId:plan.id,approvalId:plan.approval.id,taskPrompt:plan.finalPlan,verifyCommand:'node --check app.js'});
  engine.launch(run);await engine.active.promise;assert.equal(calls,0);assert.equal(f.store.read('runs',run.id).error,'APPROVED_PLAN_SOURCE_CHANGED');
  const base={mode:'plan',acceptanceCriteria:plan.requirements,bugs:[],history:[],round:1,cleanRounds:0,testGate:{status:'PASS',snapshot:'v1'}};
  const report={verdict:'APPROVED',summary:'Reviewed',coverage:['app.js checked'],scopeComplete:true,acceptanceComplete:true,issues:[],verifications:[]};
  assert.throws(()=>applyReview(structuredClone(base),report,'v1'),/INCOMPLETE_ACCEPTANCE_CHECKS/);
  assert.throws(()=>applyReview(structuredClone(base),{...report,acceptanceChecks:[{id:'A-001',result:'PASS',evidence:''}]},'v1'),/acceptance evidence/);
  const checks=[{id:'A-001',result:'PASS',evidence:'Invalid-input regression passes and source handles blank input'}];assert.equal(applyReview(structuredClone(base),{...report,acceptanceChecks:checks},'v1').clean,true);
  const blocked={...report,verdict:'NEEDS_DECISION',acceptanceComplete:false,acceptanceChecks:[{id:'A-001',result:'BLOCKED',evidence:'Business interpretation unresolved'}]};assert.equal(applyReview(structuredClone(base),blocked,'v1').needsDecision,true);
  assert.throws(()=>applyReview(structuredClone(base),{...blocked,acceptanceComplete:true},'v1'),/CONTRADICTORY_ACCEPTANCE_RESULT/);
});
test('human decision switches to an explicitly approved revision and failed criteria drive another repair before clean reviews',async t=>{
  let source='v1';const f=fixture(t,{snapshot:async()=>source}),r=await ready(f),body=decision(r),preview=f.engine.preview(r.id,body),plan=await f.engine.approve(r.id,{...body,previewHash:preview.previewHash});
  const roles=[];let reviewCount=0;
  const engine=new Workflow(f.store,{snapshot:async()=>source,command:async()=>({code:0,stdout:'Regression passed',stderr:''}),agent:async req=>{
    roles.push(req.role);if(req.role==='dev')return JSON.stringify({summary:'Implemented approved behavior',needsDecision:false,fixes:[]});
    const result=['BLOCKED','FAIL','PASS','PASS'][reviewCount++];
    if(reviewCount>1)assert.match(req.prompt,/Reject empty arrays/);
    return JSON.stringify({verdict:result==='BLOCKED'?'NEEDS_DECISION':result==='PASS'?'APPROVED':'REJECTED',summary:'Checked input semantics',coverage:['app.js and regression'],scopeComplete:true,acceptanceComplete:result==='PASS',issues:[],verifications:[],acceptanceChecks:[{id:'A-001',result,evidence:'Reviewed input guard against regression outcome'}]});
  }});
  const run=engine.create({workspaceRoot:f.workspace,mode:'plan',planId:plan.id,approvalId:plan.approval.id,taskPrompt:plan.finalPlan,scope:'Unapproved scope expansion',verifyCommand:'node --check app.js',maxRounds:5,cleanRoundsRequired:2});
  assert.equal(run.config.scope,plan.scope);
  engine.launch(run);await engine.active.promise;assert.equal(f.store.read('runs',run.id).status,'NEEDS_ATTENTION');
  source='v2';f.config={...f.config,parentId:r.id,feedback:'Reject empty arrays as well',scope:'app.js validation and tests'};const revised=await ready(f),next=decision(revised);next.selections[0].acceptance=[{criterion:'Reject empty arrays',verification:'Run empty-array regression'}];
  const nextPreview=f.engine.preview(revised.id,next),nextPlan=await f.engine.approve(revised.id,{...next,previewHash:nextPreview.previewHash});
  engine.decide(run.id,{note:'Use revised business semantics',planId:nextPlan.id,approvalId:nextPlan.approval.id,extraRounds:4});assert.equal(f.store.read('runs',run.id).lastReview,null);await engine.active.promise;
  const completed=f.store.read('runs',run.id);assert.equal(completed.status,'APPROVED',completed.error);assert.equal(completed.approval.planId,nextPlan.id);assert.equal(completed.acceptanceCriteria[0].criterion,'Reject empty arrays');assert.equal(completed.cleanRounds,2);
  assert.deepEqual(roles,['dev','review','review','dev','review','review']);
  assert.equal(completed.config.scope,nextPlan.scope);assert.equal(completed.history[0].approval.planId,plan.id);assert.equal(completed.history[1].approval.planId,nextPlan.id);
});
test('retry retains valid investigation/proposals, identifies invalid response and only repeats missing work',async t=>{
  const calls=[];let fail=true;const f=fixture(t,{agent:async req=>{calls.push(req.name+':'+req.role);if(fail&&req.name==='Quality'&&req.role==='plan-propose')return 'bad JSON';return answer(req);}});
  const failed=await ready(f);assert.equal(failed.status,'FAILED');assert.equal(failed.calls.find(c=>c.memberId===failed.members[1].id).status,'INVALID_RESPONSE');
  assert(failed.calls.find(c=>c.status==='INVALID_RESPONSE').responseArtifact);assert(failed.members[0].proposal);fail=false;
  assert.throws(()=>f.engine.retry(failed.id,{workspaceRoot:f.workspace,version:0}),/VERSION_CONFLICT/);
  f.engine.retry(failed.id,{workspaceRoot:f.workspace,version:failed.version});await f.engine.active.promise;
  const result=f.store.read('discussions',failed.id);assert.equal(result.status,'READY',result.error);assert.equal(result.version,2);
  assert.equal(calls.filter(c=>c.endsWith('plan-investigate')).length,1);assert.equal(calls.filter(c=>c==='Architecture:plan-propose').length,1);assert.equal(calls.filter(c=>c==='Quality:plan-propose').length,2);assert.equal(calls.filter(c=>c.endsWith('plan-challenge')).length,2);
});
test('challenge-only retry reuses valid peer reviews, but source changes invalidate without another agent call',async t=>{
  const calls=[];let fail=true,source='v1';const f=fixture(t,{snapshot:async()=>source,agent:async req=>{calls.push(req.name+':'+req.role);if(fail&&req.name==='Quality'&&req.role==='plan-challenge')throw new Error('EXECUTION_TIMEOUT');return answer(req);}});
  const failed=await ready(f);assert.equal(failed.calls.at(-1).status,'TIMED_OUT');assert(failed.members[0].challenge);fail=false;
  f.engine.retry(failed.id,{workspaceRoot:f.workspace,version:failed.version});await f.engine.active.promise;assert.equal(f.store.read('discussions',failed.id).status,'READY');assert.equal(calls.filter(c=>c==='Architecture:plan-challenge').length,1);
  fail=true;const another=await ready(f),count=calls.length;source='v2';f.engine.retry(another.id,{workspaceRoot:f.workspace,version:another.version});await f.engine.active.promise;
  assert.equal(f.store.read('discussions',another.id).status,'INVALIDATED');assert.equal(calls.length,count);
});
test('partial drafts survive reload, use compare-and-swap and block stale preview/approval',async t=>{
  const f=fixture(t),r=await ready(f),body=decision(r);const value={selections:body.selections.map(s=>({...s,decision:'',reason:''})),answers:body.answers.map(a=>({...a,answer:''}))};
  const initial=f.engine.draft(r.id);assert.equal(initial.revision,0);
  const saved=f.engine.draft(r.id,{workspaceRoot:f.workspace,version:r.version,draftRevision:0,value});assert.equal(saved.revision,1);assert.equal(saved.value.selections[0].reason,'');
  const restarted=new PlanningWorkflow(f.store);assert.deepEqual(restarted.draft(r.id),saved);
  assert.throws(()=>f.engine.draft(r.id,{workspaceRoot:f.workspace,version:r.version,draftRevision:0,value}),/DRAFT_VERSION_CONFLICT/);
  assert.throws(()=>f.engine.preview(r.id,body),/DRAFT_VERSION_CONFLICT/);
  const preview=f.engine.preview(r.id,{...body,draftRevision:1});
  f.engine.draft(r.id,{workspaceRoot:f.workspace,version:r.version,draftRevision:1,value:{selections:body.selections,answers:body.answers}});
  await assert.rejects(f.engine.approve(r.id,{...body,draftRevision:1,previewHash:preview.previewHash}),/DRAFT_VERSION_CONFLICT/);
  const latest=f.engine.preview(r.id,{...body,draftRevision:2});await f.engine.approve(r.id,{...body,draftRevision:2,previewHash:latest.previewHash});
  assert.throws(()=>f.engine.draft(r.id,{workspaceRoot:f.workspace,version:2,draftRevision:2,value}),/NOT_READY/);
});
test('version comparison ignores local proposal IDs and exposes changed acceptance, removed and added items',async t=>{
  const f=fixture(t),parent=await ready(f),body=decision(parent);parent.decision=compileDecision(parent,body);parent.status='APPROVED';
  const next=structuredClone(parent);next.id='next';next.status='READY';delete next.decision;next.scope='narrow scope';
  next.members[0].proposal.proposals[0].id='P-9-9';next.members[1].proposal.proposals[0].title='A different proposal';
  const nextDecision=decision(next);nextDecision.selections[0].acceptance=[{criterion:'Changed criterion',verification:'New regression'}];
  const comparison=comparePlans(parent,next,nextDecision);assert.deepEqual(comparison.changes.map(c=>c.kind),['CHANGED','ADDED','REMOVED']);assert.equal(comparison.changes[0].after.acceptance[0].criterion,'Changed criterion');assert.equal(comparison.answers.before[0].question,'Allow empty input?');assert.equal(comparison.scope.after,'narrow scope');
});
