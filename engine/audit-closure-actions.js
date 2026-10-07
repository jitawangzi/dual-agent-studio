'use strict';
const fs=require('fs'),crypto=require('crypto');
const {now,workspaceKey}=require('./run-store');
const {closureFamily,closureView}=require('./audit-closure');
function guard(engine,id,input){
    if(engine.active || engine.store?.guard?.isBusy())throw new Error('WORKFLOW_BUSY');
    const group=closureFamily(engine.store,id);
    if(workspaceKey(input.workspaceRoot)!==group.root.workspaceKey)throw new Error('AUDIT_WORKSPACE_MISMATCH');
    for(const record of [...group.family,...group.runs])for(const p of [record,...(record.reviewers||[]),...(record.closureTests||[]),...(record.verificationRuns||[]).flatMap(v=>[v,...v.items])])if(p.activePid){
        try{process.kill(p.activePid,0);}catch(error){if(error.code==='ESRCH')continue;}
        throw new Error('PREVIOUS_PROCESS_STILL_RUNNING');
    }
    return group;
}
async function acceptClosure(engine,id,input){
    const {root}=guard(engine,id,input);
    if(typeof input.note!=='string'||!input.note.trim()||input.note.length>10000)throw new Error('CLOSURE_NOTE_REQUIRED');
    const controller=new AbortController(),active={id:root.id,controller,promise:null};engine.active=active;
    active.promise=(async()=>{
        const snapshot=await engine.snapshot(root.workspaceRoot,controller.signal);
        if(controller.signal.aborted)throw new Error('RUN_CANCELLED');
        const view=closureView(engine.store,root.id,snapshot);
        if(input.version!==view.version)throw new Error('CLOSURE_VERSION_CONFLICT');
        if(!view.ready)throw new Error('CLOSURE_BLOCKED');
        if(view.acceptance?.current)return view;
        root.closureAcceptances||=[];root.closureAcceptances.push({id:crypto.randomUUID(),at:now(),version:view.version,snapshot,note:input.note.trim(),deferred:view.findings.filter(f=>f.state==='DEFERRED')});engine.save(root);
        return closureView(engine.store,root.id,snapshot);
    })();
    try{return await active.promise;}finally{if(engine.active===active)engine.active=null;}
}
function testClosure(engine,id,input){
    const {root}=guard(engine,id,input);
    if(input.execute!==true)throw new Error('CLOSURE_EXECUTION_ACK_REQUIRED');
    if(typeof input.command!=='string'||!input.command.trim()||input.command.length>10000)throw new Error('INVALID_TEST_COMMAND');
    const gate={id:crypto.randomUUID(),status:'RUNNING',command:input.command.trim(),at:now(),activePid:null};
    root.closureTests||=[];root.closureTests.push(gate);engine.save(root);
    const controller=new AbortController(),lease=engine.store?.guard?engine.store.guard.acquire({kind:'closure-test',id:gate.id,workspaceKey:root.workspaceKey}):null;
    const active={id:root.id,kind:'closureTest',controller,promise:null,lease};engine.active=active;
    active.promise=(async()=>{
        try{
            if (lease) await lease;
            const before=await engine.snapshot(root.workspaceRoot,controller.signal);
            const result=await engine.command('pwsh',['-NoProfile','-Command',gate.command],{cwd:root.workspaceRoot,signal:controller.signal,timeoutMs:root.timeoutSeconds*1000,
                onSpawn:p=>{gate.activePid=p.pid;engine.save(root);},onOutput:(message,type)=>engine.emit('log',{time:now(),type,message,auditId:root.id})});
            const after=await engine.snapshot(root.workspaceRoot,controller.signal);
            gate.artifact=`closure-test-${gate.id}.txt`;fs.writeFileSync(engine.store.file('audits',root.id,gate.artifact),`${result.stdout}\n${result.stderr}`);
            Object.assign(gate,{exitCode:result.code,snapshot:after,beforeSnapshot:before,sourceChanged:before!==after,status:!controller.signal.aborted&&result.code===0&&before===after?'PASS':'FAIL'});
        }catch(error){gate.status=controller.signal.aborted?'STOPPED':'FAILED';gate.error=error.message;}
        finally{gate.activePid=null;gate.at=now();engine.save(root);active.lease?.release?.();if(engine.active===active)engine.active=null;engine.emit('audit_idle',{id:root.id});}
    })();
    return gate;
}
function recheckClosure(engine,id,input){
    const {root}=guard(engine,id,input);
    const child=engine.create({workspaceRoot:root.workspaceRoot,feature:`重新审核：${root.feature}`,commonPrompt:root.commonPrompt,scope:root.scope,concurrency:root.concurrency,timeoutSeconds:root.timeoutSeconds,reviewers:root.reviewers});
    child.parentAudit={id:root.id,mode:'RECHECK'};engine.save(child);
    root.supplementRuns||=[];root.supplementRuns.push({auditId:child.id,mode:'RECHECK',at:now()});engine.save(root);
    return engine.launch(child);
}
module.exports={acceptClosure,testClosure,recheckClosure};
