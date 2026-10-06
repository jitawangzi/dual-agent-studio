'use strict';
const {hash}=require('./run-store');
const {evidenceKey,presentAudit}=require('./audit-triage');

function issueId(workspaceKey,finding){
    const file=finding.file.replace(/\\/g,'/');
    return 'ISS-'+hash(JSON.stringify([workspaceKey,finding.category||'BUG',process.platform==='win32'?file.toLowerCase():file,
        finding.problem.trim().toLowerCase().replace(/\s+/g,' ')])).slice(0,20);
}
// Derived from persisted evidence: no second mutable store and no automatic closure on omission.
function issueLedger(store,workspace){
    if(typeof workspace!=='string'||!workspace.trim())throw new Error('WORKSPACE_REQUIRED');
    const audits=store.list('audits',workspace),runs=store.list('runs',workspace),issues=new Map(),events=[];
    const ensure=(key,f)=>{
        const id=issueId(key,f);
        if(!issues.has(id))issues.set(id,{id,file:f.file,problem:f.problem,category:f.category||'BUG',severity:f.severity,
            status:'OPEN',occurrences:[],history:[],decisions:[],repairRuns:[],needsReview:false});
        return issues.get(id);
    };
    for(const audit of audits){
        const presented=presentAudit(audit);
        for(const f of presented.findings){
            const issue=ensure(audit.workspaceKey,f),key=evidenceKey(f);
            const times=audit.reviewers.filter(r=>f.sources.some(s=>s.reviewerId===r.id)).map(r=>r.finishedAt||r.startedAt).filter(Boolean).sort();
            const at=times.at(-1)||audit.createdAt;
            const occurrence={auditId:audit.id,findingId:f.id,at,snapshot:audit.snapshot,evidenceKey:key,evidence:f.evidence,
                acceptance:f.acceptance,file:f.file,problem:f.problem,severity:f.severity,auditStatus:audit.status,valid:audit.status!=='INVALIDATED',triage:f.triage};
            issue.occurrences.push(occurrence);events.push({issue,at,type:'FOUND',occurrence});
            for(const decision of f.triageHistory||[]){
                const entry={...decision,auditId:audit.id,findingId:f.id,current:decision.version===f.triage?.version};
                issue.decisions.push(entry);events.push({issue,at:decision.at,type:'TRIAGE',decision:entry});
            }
        }
    }
    for(const run of runs)for(const bug of run.bugs||[]){
        const source=audits.find(a=>a.id===run.sourceAudit?.id)?.findings.find(f=>f.id===bug.sourceFindingId);
        const issue=ensure(run.workspaceKey,source||bug);
        issue.repairRuns.push({runId:run.id,bugId:bug.id,status:run.status});
        for(const entry of bug.history||[])events.push({issue,at:entry.at||run.createdAt,type:'REVIEW',runId:run.id,bugId:bug.id,...entry});
    }
    events.sort((a,b)=>a.at.localeCompare(b.at)||({FOUND:0,TRIAGE:1,REVIEW:2}[a.type]-{FOUND:0,TRIAGE:1,REVIEW:2}[b.type]));
    for(const event of events){
        const {issue,...entry}=event;issue.history.push(entry);issue.firstSeenAt||=event.at;issue.updatedAt=event.at;
        if(event.type==='FOUND'){
            const o=event.occurrence;if(!o.valid)continue;
            const changed=issue.latestOccurrence&&(issue.latestOccurrence.evidenceKey!==o.evidenceKey||issue.latestOccurrence.snapshot!==o.snapshot);
            if(issue.reopened||issue.status==='VERIFIED_CLOSED'){issue.status='REOPENED';issue.reopened=true;}
            else if(changed)issue.status='OPEN';
            issue.needsReview=!!changed;issue.latestOccurrence=o;
            Object.assign(issue,{file:o.file,problem:o.problem,severity:o.severity});
        }else if(event.type==='TRIAGE'){
            if(event.decision.current&&event.decision.auditId===issue.latestOccurrence?.auditId){
                issue.lastDecision=event.decision;issue.needsReview=false;
                if(issue.status!=='VERIFIED_CLOSED'&&!(issue.status==='REOPENED'&&['CONFIRMED','UNREVIEWED'].includes(event.decision.status)))issue.status=event.decision.status==='UNREVIEWED'?'OPEN':event.decision.status;
            }
        }else{
            issue.status=event.status;issue.lastReview={runId:event.runId,bugId:event.bugId,evidence:event.evidence,snapshot:event.snapshot,at:event.at};
            if(event.status==='VERIFIED_CLOSED'){issue.reopened=false;issue.needsReview=false;}
        }
    }
    return [...issues.values()].map(issue=>({...issue,occurrences:issue.occurrences.sort((a,b)=>b.at.localeCompare(a.at)),
        decisions:issue.decisions.sort((a,b)=>b.at.localeCompare(a.at)),occurrenceCount:issue.occurrences.length,
        // Invalid reports remain visible as historical evidence, never as current confirmation.
        status:!issue.latestOccurrence&&!issue.lastReview?'STALE':issue.status})).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||a.id.localeCompare(b.id));
}
module.exports={issueId,issueLedger};
