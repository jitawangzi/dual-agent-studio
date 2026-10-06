'use strict';
const {auditGaps,supplementVersion}=require('./audit-assignment');
const {hash,now}=require('./run-store');
const states=['UNREVIEWED','CONFIRMED','ACCEPTED','NEEDS_CLARIFICATION','DISMISSED','DEFERRED'];
function evidenceKey(finding){return hash(JSON.stringify([finding.category,finding.severity,finding.file,finding.lineRange,finding.problem,finding.evidence,finding.acceptance,
    [...finding.sources].sort((a,b)=>a.reviewerId.localeCompare(b.reviewerId))]));}
function verificationHistory(record,finding){
    return (record.verificationRuns||[]).flatMap(run=>run.items.filter(item=>item.findingId===finding.id).map(item=>({
        ...item,runId:run.id,verifier:run.verifier,reproduction:run.reproduction,createdAt:run.createdAt,finishedAt:item.finishedAt||run.finishedAt,
        stale:record.status==='INVALIDATED'||run.status==='INVALIDATED'||run.snapshot!==record.snapshot||item.evidenceKey!==evidenceKey(finding)
    })));
}
function verificationKey(record,finding){
    const latest=verificationHistory(record,finding).at(-1);
    return latest?hash(JSON.stringify([latest.runId,latest.status,latest.stale,latest.report||null])):'';
}
function decisionFor(record,finding){
    const saved=record.triage?.[finding.id];
    return saved&&saved.evidenceKey===evidenceKey(finding)&&(saved.verificationKey||'')===verificationKey(record,finding)?saved:null;
}
function canRepair(record,finding){const decision=decisionFor(record,finding);return finding.category==='SUGGESTION'?decision?.status==='ACCEPTED':
    ['BUG','RISK'].includes(finding.category)&&decision?.status==='CONFIRMED';}
function applyTriage(record,input){
    if(!['COMPLETED','PARTIAL','STOPPED','INTERRUPTED'].includes(record.status))throw new Error('AUDIT_NOT_READY');
    const finding=record.findings.find(f=>f.id===input.findingId);if(!finding)throw new Error('UNKNOWN_FINDING_ID');
    const key=evidenceKey(finding),previous=record.triage?.[finding.id];
    if(input.evidenceKey!==key||input.version!==(previous?.version||0)||(input.verificationKey||'')!==verificationKey(record,finding))throw new Error('TRIAGE_VERSION_CONFLICT');
    if(!states.includes(input.status))throw new Error('INVALID_TRIAGE_STATUS');
    if(input.status==='CONFIRMED'&&!['BUG','RISK'].includes(finding.category)||input.status==='ACCEPTED'&&finding.category!=='SUGGESTION')throw new Error('INVALID_TRIAGE_CATEGORY');
    if(typeof input.note!=='string'||input.note.length>10000||input.status!=='UNREVIEWED'&&!input.note.trim())throw new Error('TRIAGE_REASON_REQUIRED');
    const entry={status:input.status,note:input.note.trim(),evidenceKey:key,verificationKey:verificationKey(record,finding),version:(previous?.version||0)+1,at:now()};
    record.triage||={};record.triage[finding.id]={...entry,history:[...(previous?.history||[]),entry]};return record;
}
function presentAudit(record){return {...record,gaps:auditGaps(record),supplementVersion:supplementVersion(record),findings:record.findings.map(f=>({...f,evidenceKey:evidenceKey(f),
    verificationKey:verificationKey(record,f),verification:verificationHistory(record,f).at(-1)||null,verificationHistory:verificationHistory(record,f),
    triage:decisionFor(record,f),triageVersion:record.triage?.[f.id]?.version||0,triageHistory:record.triage?.[f.id]?.history||[],repairable:canRepair(record,f)}))};}
module.exports={applyTriage,canRepair,presentAudit,evidenceKey};
