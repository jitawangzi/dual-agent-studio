'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {RunStore,workspaceKey}=require('../engine/run-store');
const {issueLedger,issueId}=require('../engine/issue-ledger');
const {applyTriage,evidenceKey}=require('../engine/audit-triage');
const time=n=>`2026-10-04T00:00:${String(n).padStart(2,'0')}.000Z`;
function fixture(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-ledger-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
    t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const store=new RunStore(path.join(root,'state')),key=workspaceKey(workspace);
    const finding={id:'F-original',category:'BUG',file:'app.js',problem:'Null Crash',severity:'HIGH',evidence:'null access',acceptance:'null returns empty',sources:[]};
    const audit=(n,more={})=>store.save('audits',{id:crypto.randomUUID(),workspaceKey:key,workspaceRoot:workspace,createdAt:time(n),status:'COMPLETED',snapshot:'v1',reviewers:[],findings:[structuredClone(finding)],...more});
    return {root,workspace,store,key,finding,audit};
}
test('stable issue IDs join repeated audits, isolate projects/categories and never close omitted findings',t=>{
    const f=fixture(t);f.audit(1);f.audit(2);f.audit(3,{findings:[]});
    const rows=issueLedger(f.store,f.workspace);assert.equal(rows.length,1);assert.equal(rows[0].occurrenceCount,2);assert.equal(rows[0].status,'OPEN');
    assert.equal(rows[0].id,issueId(f.key,{...f.finding,problem:'null   crash'}));
    assert.notEqual(rows[0].id,issueId('another workspace',f.finding));assert.notEqual(rows[0].id,issueId(f.key,{...f.finding,category:'QUESTION'}));
    assert.throws(()=>issueLedger(f.store,''),/WORKSPACE_REQUIRED/);
});
test('repair closure remains recorded and a later finding reopens the same stable issue',t=>{
    const f=fixture(t),a=f.audit(1);
    f.store.save('runs',{id:crypto.randomUUID(),workspaceKey:f.key,workspaceRoot:f.workspace,createdAt:time(2),status:'APPROVED',sourceAudit:{id:a.id},bugs:[{...f.finding,id:'BUG-0001',sourceFindingId:f.finding.id,history:[{at:time(3),status:'VERIFIED_CLOSED',snapshot:'v2',evidence:'regression passed'}]}]});
    assert.equal(issueLedger(f.store,f.workspace)[0].status,'VERIFIED_CLOSED');
    f.audit(4,{findings:[]});assert.equal(issueLedger(f.store,f.workspace)[0].status,'VERIFIED_CLOSED');
    f.audit(5,{snapshot:'v3'});const issue=issueLedger(f.store,f.workspace)[0];assert.equal(issue.status,'REOPENED');assert.equal(issue.repairRuns.length,1);assert.equal(issue.occurrenceCount,2);
    f.store.save('runs',{id:crypto.randomUUID(),workspaceKey:f.key,createdAt:time(6),status:'NEEDS_ATTENTION',sourceAudit:{id:a.id},bugs:[{...f.finding,id:'BUG-0001',sourceFindingId:f.finding.id,history:[{at:time(7),status:'OPEN',evidence:'Still broken'}]}]});
    f.audit(8,{snapshot:'v3'});assert.equal(issueLedger(f.store,f.workspace)[0].status,'REOPENED');
});
test('changed evidence preserves dismissed decision history but requests a new judgment',t=>{
    const f=fixture(t),a=f.audit(1);
    applyTriage(a,{findingId:f.finding.id,evidenceKey:evidenceKey(f.finding),version:0,status:'DISMISSED',note:'Caller excludes null'});
    a.triage[f.finding.id].at=time(2);a.triage[f.finding.id].history[0].at=time(2);f.store.save('audits',a);
    f.audit(3);let issue=issueLedger(f.store,f.workspace)[0];assert.equal(issue.status,'DISMISSED');assert.equal(issue.needsReview,false);
    f.audit(4,{snapshot:'new-caller',findings:[{...f.finding,evidence:'new caller passes null'}]});
    issue=issueLedger(f.store,f.workspace)[0];assert.equal(issue.status,'OPEN');assert.equal(issue.needsReview,true);assert.equal(issue.decisions[0].note,'Caller excludes null');
});
test('invalidated reports are history only and do not reopen a verified repair',t=>{
    const f=fixture(t),a=f.audit(1);
    f.store.save('runs',{id:crypto.randomUUID(),workspaceKey:f.key,createdAt:time(2),status:'APPROVED',sourceAudit:{id:a.id},bugs:[{...f.finding,sourceFindingId:f.finding.id,id:'BUG-0001',history:[{at:time(3),status:'VERIFIED_CLOSED',evidence:'verified'}]}]});
    f.audit(4,{status:'INVALIDATED',snapshot:'bad'});assert.equal(issueLedger(f.store,f.workspace)[0].status,'VERIFIED_CLOSED');
});

test('verified closure clears an earlier evidence-change reminder',t=>{
    const f=fixture(t);f.audit(1);const latest=f.audit(2,{snapshot:'changed'});
    assert.equal(issueLedger(f.store,f.workspace)[0].needsReview,true);
    f.store.save('runs',{id:crypto.randomUUID(),workspaceKey:f.key,createdAt:time(3),status:'APPROVED',sourceAudit:{id:latest.id},bugs:[{...f.finding,id:'BUG-0001',sourceFindingId:f.finding.id,history:[{at:time(4),status:'VERIFIED_CLOSED',evidence:'verified on changed source'}]}]});
    const issue=issueLedger(f.store,f.workspace)[0];assert.equal(issue.status,'VERIFIED_CLOSED');assert.equal(issue.needsReview,false);
});

test('editing an older audit does not replace the severity of the newest valid observation',t=>{
    const f=fixture(t),older=f.audit(1,{findings:[{...f.finding,severity:'LOW'}]});
    f.audit(2,{findings:[{...f.finding,severity:'HIGH'}]});
    // Deterministic ordering: an old record was saved most recently, but its observation is still older.
    older.updatedAt='2099-01-01T00:00:00.000Z';fs.writeFileSync(f.store.file('audits',older.id),JSON.stringify(older));
    assert.equal(issueLedger(f.store,f.workspace)[0].severity,'HIGH');
    f.audit(3,{status:'INVALIDATED',findings:[{...f.finding,severity:'CRITICAL'}]});
    assert.equal(issueLedger(f.store,f.workspace)[0].severity,'HIGH');
});
