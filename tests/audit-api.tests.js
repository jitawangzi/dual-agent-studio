'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');

test('HTTP parallel audit persists read-only reports, enforces global exclusion and validates repair selections',async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-audit-api-'));
    const workspace=path.join(root,"workspace ' with spaces");fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'app.js'),'const valid = true;');
    process.env.STUDIO_DATA_DIR=path.join(root,'state');
    const {server}=require('../server');await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=async(url,body)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {code:r.status,data:await r.json()};};
    t.after(async()=>{await request('/api/stop',{});await new Promise(r=>server.close(r));assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const capability=await request('/api/audit-capabilities');assert.equal(capability.code,200);assert(capability.data.providers.some(p=>p.id==='mock'));
    const config={workspaceRoot:workspace,commonPrompt:'Check code without edits',scope:'app.js',reviewers:[{provider:'mock',name:'Logic'},{provider:'mock',name:'Design'}],concurrency:2};
    const checked=await request('/api/agent-health',{mode:'check',reviewers:config.reviewers});assert.equal(checked.code,200);assert.equal(checked.data.results[0].code,'MOCK_ONLY');
    assert.equal((await request('/api/agent-health',{mode:'unknown',reviewers:config.reviewers})).code,400);
    const {AgentHealth}=require('../engine/agent-health');const originalPerform=AgentHealth.prototype.perform;
    let entered;const ready=new Promise(r=>{entered=r;});
    AgentHealth.prototype.perform=async function(reviewers,mode,signal){entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('RUN_CANCELLED')),{once:true}));};
    try{
        const pending=request('/api/agent-health',{mode:'probe',reviewers:config.reviewers});await ready;
        assert.equal((await request('/api/status')).data.isCheckingAgents,true);
        for(const route of ['/api/audits','/api/runs','/api/discuss'])assert.equal((await request(route,config)).code,409);
        assert.equal((await request('/api/stop',{})).code,200);assert.equal((await pending).code,400);
        assert.equal((await request('/api/status')).data.isRunning,false);
    }finally{AgentHealth.prototype.perform=originalPerform;}
    const template=await request('/api/audit-templates',{name:'HTTP team',scope:'project',workspaceRoot:workspace,config:{...config,timeoutSeconds:60}});assert.equal(template.code,200);
    assert.equal((await request('/api/audit-templates?workspace='+encodeURIComponent(workspace))).data.length,1);
    assert.equal((await request('/api/audit-templates')).data.length,0);
    assert.equal((await request('/api/audit-templates/delete',{id:template.data.id,version:0,workspaceRoot:workspace})).code,409);
    assert.equal((await request('/api/audit-templates/delete',{id:template.data.id,version:1,workspaceRoot:workspace})).code,200);
    assert.equal((await request('/api/audits',{...config,reviewers:[{provider:'cursor'}]})).code,400);
    const created=await request('/api/audits',config);assert.equal(created.code,202);
    const status=await request('/api/status');assert.equal(status.data.activeAuditId,created.data.auditId);assert.equal(status.data.isRunning,true);
    assert.equal((await request('/api/runs',{})).code,409);
    assert.equal((await request('/api/discuss',{})).code,409);
    assert.equal((await request('/api/audits',config)).code,409);
    assert.equal((await request('/api/agent-health',{mode:'check',reviewers:config.reviewers})).code,409);
    let audit;
    for(let i=0;i<300;i++){audit=(await request('/api/audits/'+created.data.auditId)).data;if(audit.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(audit.status,'COMPLETED',JSON.stringify(audit));assert.equal(audit.reviewers.length,2);
    assert.notEqual(audit.reviewers[0].sessionId,audit.reviewers[1].sessionId);
    assert.equal(fs.readFileSync(path.join(workspace,'app.js'),'utf8'),'const valid = true;');
    assert.equal((await request('/api/audits?workspace='+encodeURIComponent(workspace))).data.length,1);
    assert.equal((await request('/api/issues')).code,400);
    assert.equal((await request('/api/issues?workspace='+encodeURIComponent(workspace))).code,200);
    const artifacts=await request(`/api/audits/${audit.id}/artifacts`);const answer=artifacts.data.find(n=>n.endsWith('.response.txt'));assert(answer);
    const raw=await fetch(base+`/api/audits/${audit.id}/artifacts?name=${encodeURIComponent(answer)}`);assert.equal(raw.status,200);assert.match(await raw.text(),/Mock audit/);
    assert.equal((await request(`/api/audits/${audit.id}/artifacts?name=missing.txt`)).code,400);
    assert.equal((await request(`/api/audits/${audit.id}/repair`,{findingIds:['fabricated']})).code,400);
    assert.equal((await request(`/api/audits/${audit.id}/retry`,{})).code,400);
    // Seed a persisted report, then exercise triage over HTTP without invoking a paid model.
    const {RunStore}=require('../engine/run-store');const store=new RunStore(process.env.STUDIO_DATA_DIR);
    audit.findings=[{id:'F-test',category:'BUG',severity:'HIGH',file:'app.js',lineRange:'1',problem:'Contract issue',evidence:'Review evidence',acceptance:'Meet contract',sources:[]}];store.save('audits',audit);
    const finding=(await request(`/api/audits/${audit.id}`)).data.findings[0];assert.equal(finding.repairable,false);
    const decision={findingId:finding.id,version:0,evidenceKey:finding.evidenceKey,status:'CONFIRMED',note:'Observed failing input'};
    const triaged=await request(`/api/audits/${audit.id}/triage`,decision);assert.equal(triaged.code,200);assert.equal(triaged.data.findings[0].repairable,true);
    assert.equal((await request(`/api/audits/${audit.id}/triage`,decision)).code,409);
    const verifyConfig={workspaceRoot:workspace,findings:[{id:finding.id,evidenceKey:finding.evidenceKey}],verifier:{provider:'mock'}};
    assert.equal((await request(`/api/audits/${audit.id}/verify`,{...verifyConfig,findings:[{id:finding.id,evidenceKey:'stale'}]})).code,409);
    const verifying=await request(`/api/audits/${audit.id}/verify`,verifyConfig);assert.equal(verifying.code,202);
    assert.equal((await request('/api/status')).data.activeVerificationId,verifying.data.verificationId);
    assert.equal((await request('/api/runs',{})).code,409);
    assert.equal((await request(`/api/audits/${audit.id}/triage`,decision)).code,409);
    let verified;
    for(let i=0;i<300;i++){verified=(await request(`/api/audits/${audit.id}`)).data;if(!['RUNNING','QUEUED'].includes(verified.verificationRuns[0].status))break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(verified.verificationRuns[0].status,'COMPLETED');assert.equal(verified.findings[0].verification.report.verdict,'INSUFFICIENT_EVIDENCE');
    assert.equal(verified.findings[0].repairable,false);assert.equal(verified.findings[0].triageHistory.length,1);
    assert.equal((await request(`/api/audits/${audit.id}/triage`,{...decision,version:1})).code,409);
    const verArtifact=verified.findings[0].verification.responseArtifact;
    assert.equal((await fetch(base+`/api/audits/${audit.id}/artifacts?name=${encodeURIComponent(verArtifact)}`)).status,200);
    // Required task omission stays PARTIAL through the actual Mock provider; supplement preserves parent.
    const assigned=await request('/api/audits',{...config,reviewers:[{provider:'mock',name:'Checklist',checklist:['Inspect null inputs']}]});assert.equal(assigned.code,202);
    let assignedRecord;
    for(let i=0;i<300;i++){assignedRecord=(await request('/api/audits/'+assigned.data.auditId)).data;if(assignedRecord.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(assignedRecord.status,'PARTIAL');assert.equal(assignedRecord.gaps.length,1);
    const supplement={workspaceRoot:workspace,version:assignedRecord.supplementVersion,selections:assignedRecord.gaps.map(g=>({reviewerId:g.reviewerId,taskId:g.taskId}))};
    assert.equal((await request(`/api/audits/${assignedRecord.id}/supplement`,{...supplement,version:'stale'})).code,409);
    assert.equal((await request(`/api/audits/${assignedRecord.id}/supplement`,{...supplement,selections:[]})).code,400);
    const child=await request(`/api/audits/${assignedRecord.id}/supplement`,supplement);assert.equal(child.code,202);
    let childRecord;
    for(let i=0;i<300;i++){childRecord=(await request('/api/audits/'+child.data.auditId)).data;if(childRecord.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(childRecord.parentAudit.id,assignedRecord.id);assert.equal(childRecord.status,'PARTIAL');
    assert.deepEqual((await request('/api/audits/'+assignedRecord.id)).data.reviewers,assignedRecord.reviewers);

});
