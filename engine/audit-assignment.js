'use strict';
const {hash}=require('./run-store');
function normalizeChecklist(value){
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>20)throw new Error('INVALID_AUDIT_CHECKLIST');
    const seen=new Set();
    return value.map(v=>{
        if(typeof v!=='string'||!v.trim()||v.length>2000||seen.has(v.trim()))throw new Error('INVALID_AUDIT_CHECKLIST');
        seen.add(v.trim());return v.trim();
    });
}
function applyChecklist(report,checklist=[]){
    if(!checklist.length){report.taskChecks=[];return report;}
    const supplied=report.taskChecks===undefined?[]:report.taskChecks;
    if(!Array.isArray(supplied)||supplied.length>checklist.length)throw new Error('INVALID_AUDIT_TASK_CHECK');
    const seen=new Set();
    for(const item of supplied){
        if(!item||!checklist.some((_,i)=>item.id===`C-${i+1}`)||seen.has(item.id)||!['CHECKED','UNCHECKED','DISPUTED'].includes(item.status)||typeof item.evidence!=='string'||!item.evidence.trim()||item.evidence.length>16000)throw new Error('INVALID_AUDIT_TASK_CHECK');
        if(report.scopeComplete&&item.status!=='CHECKED')throw new Error('CONTRADICTORY_AUDIT_TASK_CHECK');
        seen.add(item.id);
    }
    report.taskChecks=checklist.map((task,i)=>{
        const id=`C-${i+1}`,item=supplied.find(s=>s.id===id);
        return {id,task,status:item?.status||'UNCHECKED',evidence:item?.evidence.trim()||'Agent 未返回该必查项的结果。'};
    });
    if(report.taskChecks.some(c=>c.status!=='CHECKED'))report.scopeComplete=false;
    return report;
}
function auditGaps(record){
    return (record.reviewers||[]).flatMap(r=>{
        const gaps=[],add=(taskId,task,reason,status)=>gaps.push({reviewerId:r.id,reviewerName:r.name,taskId,task,reason,status});
        for(const [i,task] of (r.checklist||[]).entries()){
            const check=r.status==='COMPLETED'?r.report?.taskChecks?.find(c=>c.id===`C-${i+1}`):null;
            if(check?.status!=='CHECKED')add(`C-${i+1}`,task,check?.evidence||r.error||'尚未完成',check?.status||'UNCHECKED');
        }
        if(r.status==='COMPLETED')for(const [i,c] of (r.report?.coverageDetails||[]).entries()){
            if(c.status!=='CHECKED')add(`G-${i+1}`,c.target,`${c.checks}；${c.limitations}`,c.status);
        }
        if(!gaps.length&&(r.status!=='COMPLETED'||!r.report?.scopeComplete))add('SCOPE',r.scope||record.scope,r.error||r.report?.summary||'审核员未完成范围检查','UNCHECKED');
        return gaps;
    });
}
function supplementVersion(record){return hash(JSON.stringify([record.snapshot,record.status,record.scope,record.commonPrompt,record.reviewers]));}
module.exports={normalizeChecklist,applyChecklist,auditGaps,supplementVersion};
