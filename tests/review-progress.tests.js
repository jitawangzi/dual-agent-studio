'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {Workflow}=require('../engine/workflow');
const {RunStore}=require('../engine/run-store');
const {trackProgress}=require('../engine/review-progress');
const review=(more={})=>({verdict:'APPROVED',summary:'Checked source',scopeComplete:true,coverage:['app.js'],issues:[],verifications:[],...more});
const check=(result='RESOLVED')=>({id:'BUG-0001',result,evidence:'Null regression and guard checked'});
const dev=JSON.stringify({summary:'attempted fix',needsDecision:false,fixes:[]});
function fixture(t,agent){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-progress-')),workspace=path.join(root,'project');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'app.js'),'const x=1;');
    t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const store=new RunStore(path.join(root,'state')),engine=new Workflow(store,{snapshot:async()=> 'same',command:async()=>({code:0,stdout:'pass',stderr:''}),agent});
    const run=engine.create({workspaceRoot:workspace,taskPrompt:'fix null',verifyCommand:'node --check app.js',maxRounds:8,cleanRoundsRequired:1,maxNoProgressRounds:2});
    run.sourceAudit={id:'original-audit',verificationEvidence:[]};run.bugs=[{id:'BUG-0001',category:'BUG',file:'app.js',severity:'HIGH',problem:'null crash',evidence:'null',acceptance:'null returns empty',status:'OPEN',history:[]}];
    const finish=async()=>{engine.launch(run);await engine.active.promise;return store.read('runs',run.id);};return {store,engine,run,finish};
}
test('repair explicitly verifies every old issue before a separate overall regression review',async t=>{
    const steps=[];const f=fixture(t,async req=>{
        if(req.role==='dev'){steps.push('dev');return dev;}
        const targeted=req.prompt.startsWith('TARGETED_REPAIR_REVIEW');steps.push(targeted?'target':'overall');
        if(targeted){assert.match(req.prompt,/null returns empty/);assert.match(req.prompt,/Test evidence/);assert.match(req.prompt,/Git diff/);}
        return JSON.stringify(review({verifications:[check()]}));
    });
    const run=await f.finish();assert.equal(run.status,'APPROVED');assert.deepEqual(steps,['dev','target','overall']);assert.equal(run.targetedReviewHistory.length,1);assert.equal(run.bugs[0].status,'VERIFIED_CLOSED');
});
test('missing targeted items and contradictory overall closure cannot close bugs',async t=>{
    for(const missing of [true,false]){
        const f=fixture(t,async req=>req.role==='dev'?dev:JSON.stringify(req.prompt.startsWith('TARGETED_REPAIR_REVIEW')?review({verifications:missing?[]:[check('UNRESOLVED')]}):review({verifications:[check()]})));
        const run=await f.finish();assert.equal(run.status,'FAILED');assert.match(run.error,missing?/INCOMPLETE_TARGETED_REVIEW/:/TARGETED_VERIFICATION_REQUIRED/);assert.notEqual(run.bugs[0].status,'VERIFIED_CLOSED');
    }
});
test('targeted disputes pause before overall review and retain per-issue evidence',async t=>{
    let overall=0;const f=fixture(t,async req=>{if(req.role==='dev')return dev;if(!req.prompt.startsWith('TARGETED_REPAIR_REVIEW'))overall++;return JSON.stringify(review({verifications:[check('DISPUTED')]}));});
    const run=await f.finish();assert.equal(run.status,'NEEDS_ATTENTION');assert.equal(overall,0);assert.equal(run.attention.reason,'TARGETED_DISPUTE');assert.equal(run.bugs[0].status,'DISPUTED');
});

test('source edits by the targeted reviewer invalidate the result before any closure',async t=>{
    let snapshot='same';const f=fixture(t,async req=>{if(req.role==='dev')return dev;snapshot='changed';return JSON.stringify(review({verifications:[check()]}));});
    f.engine.snapshot=async()=>snapshot;const run=await f.finish();assert.equal(run.status,'FAILED');assert.match(run.error,/SOURCE_CHANGED_DURING_REVIEW/);assert.notEqual(run.bugs[0].status,'VERIFIED_CLOSED');
});

test('interrupted targeted review resumes through tests without replaying development or closing early',async t=>{
    let entered,devCalls=0,targetCalls=0,testCalls=0;
    const ready=new Promise(resolve=>{entered=resolve;});
    const f=fixture(t,async(req,{signal})=>{
        if(req.role==='dev'){devCalls++;return dev;}
        if(req.prompt.startsWith('TARGETED_REPAIR_REVIEW')&&++targetCalls===1){
            entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('RUN_CANCELLED')),{once:true}));
        }
        return JSON.stringify(review({verifications:[check()]}));
    });
    f.engine.command=async()=>{testCalls++;return {code:0,stdout:'tests passed',stderr:''};};
    f.engine.launch(f.run);await ready;await f.engine.stop();
    let saved=f.store.read('runs',f.run.id);assert.equal(saved.status,'STOPPED');assert.equal(saved.phase,'TARGET_REVIEW');assert.notEqual(saved.bugs[0].status,'VERIFIED_CLOSED');
    f.engine.resume(saved.id);await f.engine.active.promise;saved=f.store.read('runs',saved.id);
    assert.equal(saved.status,'APPROVED');assert.equal(devCalls,1);assert.equal(targetCalls,2);assert.equal(testCalls,2);
});
test('unchanged unresolved problems pause before exhausting rounds; human decision resets the baseline without closing bugs',async t=>{
    const f=fixture(t,async req=>req.role==='dev'?dev:JSON.stringify(review({verdict:'REJECTED',verifications:[check('UNRESOLVED')]})));
    let run=await f.finish();assert.equal(run.status,'NEEDS_ATTENTION');assert.equal(run.round,3);assert.equal(run.attention.reason,'NO_PROGRESS');assert.equal(run.progressCheckpoint.stalledRounds,2);
    f.engine.decide(run.id,{note:'Try a different guard and test null caller',extraRounds:4});await f.engine.active.promise;run=f.store.read('runs',run.id);
    assert.equal(run.status,'NEEDS_ATTENTION');assert.equal(run.decisions.length,1);assert(run.round>3);assert.notEqual(run.bugs[0].status,'VERIFIED_CLOSED');
});
test('closing an existing issue resets stagnation while adding more issues does not count as progress',()=>{
    const run={round:1,config:{maxNoProgressRounds:2},bugs:[{id:'one',status:'OPEN'}],lastReview:{summary:'still open'},testGate:{status:'PASS'}};
    assert.equal(trackProgress(run,{clean:false},'a'),false);run.round++;run.bugs.push({id:'two',status:'OPEN'});trackProgress(run,{clean:false},'b');assert.equal(run.progressCheckpoint.stalledRounds,1);
    run.round++;run.bugs[0].status='VERIFIED_CLOSED';assert.equal(trackProgress(run,{clean:false},'c'),false);assert.equal(run.progressCheckpoint.stalledRounds,0);
});

test('a source change requires fresh individual verification even for previously closed bugs',async t=>{
 let targeted=false;
 const f=fixture(t,async req=>{
  if(req.role==='dev')return dev;
  if(req.prompt.startsWith('TARGETED_REPAIR_REVIEW')){targeted=true;assert.match(req.prompt,/BUG-0001/);}
  return JSON.stringify(review({verifications:[check()]}));
 });
 f.run.bugs[0].status='VERIFIED_CLOSED';f.run.bugs[0].history=[{status:'VERIFIED_CLOSED',snapshot:'old-source',at:'2026-01-01',evidence:'old proof'}];
 const run=await f.finish();assert.equal(targeted,true);assert.equal(run.status,'APPROVED');assert.equal(run.bugs[0].history.at(-1).snapshot,'same');
});
