'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {execute,invokeAgent}=require('./process-runner');
const {normalizeReviewer}=require('./audit-config');
const {trackedCall,interruptOpenAttempts,summarizeCalls}=require('./call-ledger');
const {classifyProviderError,ERROR_CODES}=require('./provider-errors');
function probeFailure(error){
    const classified = classifyProviderError(error);
    if (classified.code === ERROR_CODES.QUOTA_EXHAUSTED || classified.code === ERROR_CODES.RATE_LIMIT) return 'QUOTA_OR_RATE_LIMIT';
    if (classified.code === ERROR_CODES.UNKNOWN) return 'FAILED';
    return classified.code;
}

async function inspectProvider(provider,{signal,command=execute}={}) {
    if(provider==='mock')return {ok:true,code:'MOCK_ONLY',version:'',auth:'NOT_APPLICABLE'};
    try {
        const result=await command('pwsh',['-NoProfile','-File',path.join(__dirname,'agent-health.ps1'),'-Provider',provider],{signal,timeoutMs:60000});
        if(signal?.aborted)throw new Error('RUN_CANCELLED');
        const data=JSON.parse(result.stdout.trim());
        if(result.code!==0||typeof data.ok!=='boolean')throw new Error('INVALID_HEALTH_RESPONSE');
        return {ok:data.ok,code:data.code,version:data.version,auth:data.auth,missing:data.missing||[]};
    }catch(error){if(signal?.aborted)throw new Error('RUN_CANCELLED');return {ok:false,code:'CLI_CHECK_FAILED',version:'',auth:'UNKNOWN'};}
}
async function checkReviewers(reviewers,{signal,inspect=inspectProvider}={}) {
    const providers=new Map(),results=[];
    for(const reviewer of reviewers){
        if(signal?.aborted)throw new Error('RUN_CANCELLED');
        if(!providers.has(reviewer.provider))providers.set(reviewer.provider,await inspect(reviewer.provider,{signal}));
        results.push({name:reviewer.name,provider:reviewer.provider,model:reviewer.model,reasoningEffort:reviewer.reasoningEffort,...providers.get(reviewer.provider)});
    }
    return {ok:results.every(r=>r.ok),checkedAt:new Date().toISOString(),results};
}
class AgentHealth {
    constructor({store=null,catalog={},inspect=inspectProvider,agent=invokeAgent}={}){this.store=store;this.catalog=catalog;this.inspect=inspect;this.agent=agent;this.active=null;}
    recover(){
        if(!this.store)return;
        for(const record of this.store.list('health')){
            let changed=false;
            if(['CREATED','RUNNING'].includes(record.status)){
                record.status='INTERRUPTED';
                record.error='服务重启，健康探针中断';
                changed=true;
            }
            if(interruptOpenAttempts(record)>0)changed=true;
            if(changed)this.store.save('health',record);
        }
    }
    run(config){
        if(this.active)throw new Error('WORKFLOW_BUSY');
        if(!Array.isArray(config.reviewers)||!config.reviewers.length||config.reviewers.length>8)throw new Error('INVALID_REVIEWER_COUNT');
        if(!['check','probe'].includes(config.mode))throw new Error('INVALID_HEALTH_MODE');
        const catalog=typeof this.catalog==='function'?this.catalog():this.catalog;
        const reviewers=config.reviewers.map((r,i)=>normalizeReviewer(r,i,catalog));
        const controller=new AbortController(),active={controller,promise:null};this.active=active;
        active.promise=this.perform(reviewers,config.mode,controller.signal).finally(()=>{this.active=null;});return active.promise;
    }
    async stop(){const active=this.active;if(active){active.controller.abort();await active.promise.catch(()=>{});}}
    async perform(reviewers,mode,signal){
        const result=await checkReviewers(reviewers,{signal,inspect:this.inspect});result.mode=mode;
        if(mode==='check')return result;
        let record=null;
        if(this.store){
            record={
                id:crypto.randomUUID(),
                schemaVersion:'1.0',
                status:'RUNNING',
                mode:'probe',
                createdAt:new Date().toISOString(),
                reviewers:reviewers.map(r=>({provider:r.provider,model:r.model,reasoningEffort:r.reasoningEffort}))
            };
            this.store.save('health',record);
        }
        // Each distinct model/effort is probed once; no project path or prompt is sent.
        const probes=new Map();
        for(const item of result.results){
            if(signal.aborted)throw new Error('RUN_CANCELLED');
            if(!item.ok){item.probe='SKIPPED';continue;}
            if(item.provider==='mock'){item.probe='MOCK_ONLY';continue;}
            const key=JSON.stringify([item.provider,item.model,item.reasoningEffort]);
            if(!probes.has(key)){
                const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'studio-probe-'));
                const marker='STUDIO_OK_'+crypto.randomBytes(12).toString('hex');
                const meta={
                    stepId:`probe:${item.provider}:${item.model||'default'}`,
                    role:'health-probe',
                    phase:'probe',
                    provider:item.provider,
                    model:item.model,
                    reasoningEffort:item.reasoningEffort
                };
                try{
                    if(record){
                        await trackedCall(record,meta,{
                            signal,
                            persist:()=>this.store.save('health',record),
                            invoke:async(attemptId, innerSignal)=>{
                                const effectiveSignal = innerSignal || signal;
                                return this.agent({provider:item.provider,model:item.model,reasoningEffort:item.reasoningEffort,
                                    workspaceRoot:scratch,sessionDirectory:path.join(scratch,'sessions'),sessionId:crypto.randomUUID(),role:'audit',
                                    prompt:`Connectivity test only. Do not read files, invoke tools, or change anything. Reply with exactly ${marker}`},
                                {signal:effectiveSignal,timeoutMs:90000});
                            },
                            accept:answer=>{
                                if(answer.trim()!==marker)throw new Error('UNEXPECTED_RESPONSE');
                                return answer;
                            }
                        });
                        probes.set(key,'PASSED');
                    }else{
                        const answer=await this.agent({provider:item.provider,model:item.model,reasoningEffort:item.reasoningEffort,
                            workspaceRoot:scratch,sessionDirectory:path.join(scratch,'sessions'),sessionId:crypto.randomUUID(),role:'audit',
                            prompt:`Connectivity test only. Do not read files, invoke tools, or change anything. Reply with exactly ${marker}`},
                        {signal,timeoutMs:90000});
                        probes.set(key,answer.trim()===marker?'PASSED':'UNEXPECTED_RESPONSE');
                    }
                }catch(error){
                    if(signal.aborted)throw new Error('RUN_CANCELLED');
                    if(error.message==='UNEXPECTED_RESPONSE')probes.set(key,'UNEXPECTED_RESPONSE');
                    else probes.set(key,probeFailure(error));
                }
                finally{
                    const resolved=path.resolve(scratch),parent=path.resolve(os.tmpdir());
                    if(path.dirname(resolved)===parent&&path.basename(resolved).startsWith('studio-probe-'))fs.rmSync(resolved,{recursive:true,force:true});
                }
            }
            item.probe=probes.get(key);item.ok=item.probe==='PASSED';
        }
        if(record){
            record.status=signal.aborted?'STOPPED':'COMPLETED';
            record.finishedAt=new Date().toISOString();
            this.store.save('health',record);
            result.recordId=record.id;
            result.calls=summarizeCalls(record);
        }
        result.ok=result.results.every(r=>r.ok);return result;
    }
}
module.exports={AgentHealth,checkReviewers,inspectProvider,probeFailure};
