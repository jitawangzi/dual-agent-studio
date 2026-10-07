'use strict';
const {hash}=require('./run-store');
const {auditGaps,supplementVersion}=require('./audit-assignment');
const {presentAudit}=require('./audit-triage');
const {issueId}=require('./issue-ledger');

function closureFamily(store,id){
    const selected=store.read('audits',id),all=store.list('audits',selected.workspaceRoot),byId=new Map(all.map(a=>[a.id,a]));
    let root=selected;const seen=new Set();
    while(root.parentAudit){
        if(seen.has(root.id))throw new Error('INVALID_AUDIT_LINK');seen.add(root.id);
        root=byId.get(root.parentAudit.id);if(!root)throw new Error('MISSING_AUDIT_PARENT');
    }
    const family=[root],ids=new Set([root.id]);
    for(let changed=true;changed;){changed=false;for(const a of all)if(!ids.has(a.id)&&ids.has(a.parentAudit?.id)){family.push(a);ids.add(a.id);changed=true;}}
    family.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const runs=store.list('runs',root.workspaceRoot).filter(r=>ids.has(r.sourceAudit?.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    return {root,family,runs};
}
function closureView(store,id,snapshot){
    const {root,family,runs}=closureFamily(store,id);
    const baseline=family.filter(a=>a.parentAudit?.mode==='RECHECK').at(-1)||root;
    const current=a=>a.snapshot===snapshot&&['COMPLETED','PARTIAL'].includes(a.status);
    function resolve(a,r,taskId,depth=0){
        if(depth>100)return null;
        if(current(a)&&r.status==='COMPLETED'){
            const check=taskId.startsWith('C-')?r.report?.taskChecks?.find(c=>c.id===taskId):taskId.startsWith('G-')?r.report?.coverageDetails?.[Number(taskId.slice(2))-1]:null;
            if(check?.status==='CHECKED'||taskId==='SCOPE'&&r.report?.scopeComplete)return {auditId:a.id,reviewerId:r.id,evidence:check?.evidence||check?.checks||r.report.summary};
        }
        for(const child of family.filter(c=>c.parentAudit?.id===a.id&&c.parentAudit.mode!=='RECHECK'&&c.parentAudit.mode!=='TARGETED'&&c.parentAudit.version===supplementVersion(a)).reverse()){
            const selections=child.parentAudit.selections||[],owners=a.reviewers.filter(x=>selections.some(s=>s.reviewerId===x.id));
            const index=selections.filter(s=>s.reviewerId===r.id).findIndex(s=>s.taskId===taskId),cr=child.reviewers[owners.findIndex(x=>x.id===r.id)];
            if(index<0||!cr)continue;
            const proof=resolve(child,cr,`C-${index+1}`,depth+1);
            if(proof&&complete(child,cr,depth+1))return proof;
        }
        return null;
    }
    function complete(a,r,depth=0){
        if(depth>100)return false;
        if(current(a)&&r.status==='COMPLETED'&&r.report?.scopeComplete)return true;
        const gaps=auditGaps({...a,reviewers:[r]});
        return gaps.length>0&&gaps.every(g=>resolve(a,r,g.taskId,depth+1));
    }
    const coverage=baseline.reviewers.map(r=>({auditId:baseline.id,reviewerId:r.id,name:r.name,scope:r.scope||baseline.scope,
        complete:complete(baseline,r),stale:baseline.snapshot!==snapshot,
        tasks:(r.checklist||[]).map((task,i)=>({task,proof:resolve(baseline,r,`C-${i+1}`)})),
        gaps:auditGaps({...baseline,reviewers:[r]}).map(g=>({...g,proof:resolve(baseline,r,g.taskId)}))}));
    const relevant=new Set([baseline.id]);
    for(let changed=true;changed;){changed=false;for(const a of family)if(!relevant.has(a.id)&&relevant.has(a.parentAudit?.id)&&a.parentAudit.mode!=='RECHECK'&&a.parentAudit.mode!=='TARGETED'){relevant.add(a.id);changed=true;}}
    for(const a of family.filter(a=>a.id!==baseline.id&&relevant.has(a.id)))for(const r of a.reviewers){
        // A sibling may finish the requested task, but it cannot erase additional gaps discovered here.
        const gaps=auditGaps({...a,reviewers:[r]}).filter(g=>!g.taskId.startsWith('C-')).map(g=>({...g,proof:resolve(a,r,g.taskId)}));
        if(gaps.length)coverage.push({auditId:a.id,reviewerId:r.id,name:`${r.name}（补审新增范围）`,scope:r.scope||a.scope,complete:gaps.every(g=>g.proof),stale:a.snapshot!==snapshot,tasks:[],gaps});
    }
    const items=new Map();
    for(const a of family)for(const f of presentAudit(a).findings){
        const key=issueId(a.workspaceKey,f),decision=f.triage;
        const occurrence={id:key,auditId:a.id,findingId:f.id,problem:f.problem,category:f.category,state:
            decision?.status==='DISMISSED'?'DISMISSED':decision?.status==='DEFERRED'?'DEFERRED':f.repairable?'REPAIR':'TRIAGE',note:decision?.note||'',snapshot:a.snapshot,
            observedAt:a.reviewers.filter(r=>(f.sources||[]).some(s=>s.reviewerId===r.id)).map(r=>r.finishedAt||r.startedAt||a.createdAt).sort().at(-1)||a.createdAt};
        if(!items.has(key)||items.get(key).observedAt<=occurrence.observedAt)items.set(key,occurrence);
    }
    const events=runs.flatMap(run=>(run.bugs||[]).map(bug=>({run,bug,at:bug.history?.at(-1)?.at||run.lastReview?.at||run.updatedAt||run.createdAt}))).sort((a,b)=>a.at.localeCompare(b.at));
    for(const {run,bug,at} of events){
        const source=family.find(a=>a.id===run.sourceAudit.id)?.findings.find(f=>f.id===bug.sourceFindingId),key=issueId(root.workspaceKey,source||bug);
        const item=items.get(key)||{id:key,problem:bug.problem,category:bug.category||'BUG',note:''};
        // Newer discoveries must not be closed using older repair evidence.
        if(item.observedAt&&item.observedAt>at)continue;
        const proof=bug.history?.at(-1);
        const closed=run.status==='APPROVED'&&run.lastReview?.snapshot===snapshot&&run.testGate?.status==='PASS'&&run.testGate.snapshot===snapshot&&bug.status==='VERIFIED_CLOSED'&&proof?.status==='VERIFIED_CLOSED'&&proof.snapshot===snapshot;
        if(!['DEFERRED','DISMISSED'].includes(item.state))Object.assign(item,{state:closed?'CLOSED':['AWAITING_VERIFICATION','VERIFIED_CLOSED'].includes(bug.status)?'VERIFY':'REPAIR',runId:run.id,evidence:proof?.evidence||''});
        items.set(key,item);
    }
    const findings=[...items.values()];
    const tests=[...(root.closureTests||[]).map(g=>({...g,auditId:root.id})),...runs.filter(r=>r.testGate).map(r=>({...r.testGate,runId:r.id}))].sort((a,b)=>(a.at||'').localeCompare(b.at||''));
    const test=tests.at(-1)||null,testPassed=!!test&&test.status==='PASS'&&test.exitCode===0&&!test.sourceChanged&&test.snapshot===snapshot;
    const active=family.some(a=>['CREATED','RUNNING'].includes(a.status)||(a.verificationRuns||[]).some(v=>['RUNNING','QUEUED'].includes(v.status)))||runs.some(r=>['RUNNING','CREATED'].includes(r.status))||(root.closureTests||[]).some(g=>g.status==='RUNNING');
    const blockers=[];
    if(active)blockers.push('关联任务仍在运行');
    if(!coverage.every(c=>c.complete))blockers.push('审核范围存在缺口或过期证据');
    if(findings.some(f=>['TRIAGE','REPAIR','VERIFY'].includes(f.state)))blockers.push('仍有待确认、待修复或待复核的问题');
    if(!testPassed)blockers.push('缺少当前源码版本上通过的真实测试');
    const version=hash(JSON.stringify([snapshot,family.map(a=>{const {closureAcceptances,updatedAt,...evidence}=a;return evidence;}),runs]));
    const last=root.closureAcceptances?.at(-1),ready=blockers.length===0;
    return {rootId:root.id,baselineId:baseline.id,snapshot,version,ready,blockers,coverage,findings,test,
        records:family.map(a=>({id:a.id,feature:a.feature,status:a.status,snapshot:a.snapshot,stale:a.snapshot!==snapshot})),
        acceptance:last?{...last,current:ready&&last.version===version&&last.snapshot===snapshot}:null,history:root.closureAcceptances||[]};
}
module.exports={closureFamily,closureView};
