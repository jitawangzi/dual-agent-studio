'use strict';
const fs=require('fs');
const {atomicJson,workspaceKey,now}=require('./run-store');
function readDraft(store,record){
    try{return JSON.parse(fs.readFileSync(store.file('discussions',record.id,'draft.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;return {revision:0,recordVersion:record.version,value:null};}
}
function checkDraft(store,record,input){
    const draft=readDraft(store,record);
    if((input.draftRevision??0)!==draft.revision)throw new Error('DRAFT_VERSION_CONFLICT');
    return draft;
}
function saveDraft(store,record,input){
    if(record.status!=='READY')throw new Error('PLANNING_NOT_READY');
    if(workspaceKey(input.workspaceRoot)!==record.workspaceKey)throw new Error('PLANNING_WORKSPACE_MISMATCH');
    if(input.version!==record.version)throw new Error('PLANNING_VERSION_CONFLICT');
    const previous=checkDraft(store,record,input),value=input.value;
    const string=x=>{if(typeof x!=='string'||x.length>16000)throw new Error('INVALID_DRAFT_TEXT');return x;};
    const proposals=record.members.flatMap(m=>m.proposal.proposals),seen=new Set();
    if(!value||!Array.isArray(value.selections)||value.selections.length!==proposals.length||!Array.isArray(value.answers)||value.answers.length!==record.questions.length)throw new Error('INVALID_DRAFT');
    const selections=value.selections.map(s=>{
        if(!proposals.some(p=>p.id===s.proposalId)||seen.has(s.proposalId)||!['','ADOPT','DEFER'].includes(s.decision)||!Array.isArray(s.acceptance)||s.acceptance.length<1||s.acceptance.length>10)throw new Error('INVALID_DRAFT_SELECTION');
        seen.add(s.proposalId);return {proposalId:s.proposalId,decision:s.decision,reason:string(s.reason),acceptance:s.acceptance.map(c=>({criterion:string(c.criterion),verification:string(c.verification)}))};
    });
    seen.clear();const answers=value.answers.map(a=>{if(!record.questions.some(q=>q.id===a.questionId)||seen.has(a.questionId))throw new Error('INVALID_DRAFT_ANSWER');seen.add(a.questionId);return {questionId:a.questionId,answer:string(a.answer)};});
    const draft={revision:previous.revision+1,recordVersion:record.version,updatedAt:now(),value:{selections,answers}};
    atomicJson(store.file('discussions',record.id,'draft.json'),draft);return draft;
}
// IDs are local to a discussion. Match only unique author/title pairs; ambiguous
// proposals remain additions/removals instead of inventing semantic identity.
function comparePlans(parent,current,decision){
    const view=(r,d)=>r.members.flatMap(m=>(m.proposal?.proposals||[]).map(p=>{
        const s=d?.selections?.find(s=>s.proposalId===p.id);
        return {key:JSON.stringify([p.author,p.title]),title:p.title,author:p.author,approach:p.approach,risks:p.risks,benefits:p.benefits,outOfScope:p.outOfScope,decision:s?.decision||'UNDECIDED',reason:s?.reason||'',acceptance:s?.decision==='DEFER'?[]:s?.acceptance||p.acceptance};
    }));
    const before=view(parent,parent.decision),after=view(current,decision||current.decision),used=new Set(),changes=[];
    for(const item of after){
        const candidates=before.filter(p=>p.key===item.key),unique=after.filter(p=>p.key===item.key).length===1;
        if(candidates.length!==1||!unique){changes.push({kind:'ADDED',after:item});continue;}
        const prior=candidates[0];used.add(prior);
        if(JSON.stringify(prior)!==JSON.stringify(item))changes.push({kind:'CHANGED',before:prior,after:item});
    }
    for(const item of before)if(!used.has(item))changes.push({kind:'REMOVED',before:item});
    const answers=(r,d)=>(d?.answers||[]).map(a=>({question:r.questions.find(q=>q.id===a.questionId)?.question||a.questionId,answer:a.answer}));
    return {parentId:parent.id,parentStatus:parent.status,currentId:current.id,idea:{before:parent.idea,after:current.idea},scope:{before:parent.scope,after:current.scope},answers:{before:answers(parent,parent.decision),after:answers(current,decision||current.decision)},changes};
}
module.exports={readDraft,saveDraft,checkDraft,comparePlans};
