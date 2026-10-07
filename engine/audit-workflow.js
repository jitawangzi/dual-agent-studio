'use strict';
const {applyChecklist,auditGaps,supplementVersion}=require('./audit-assignment');
const closureActions=require('./audit-closure-actions');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { trackedCall, interruptOpenAttempts } = require('./call-ledger');
const { ensureBudget, startActiveTracking, stopActiveTracking, recoverBudget } = require('./execution-budget');
const {evidenceRefs, coverageDetails, evidenceInstructions}=require('./review-evidence');
const { invokeAgent, execute } = require('./process-runner');
const { sourceSnapshot, parseObject } = require('./workflow');
const { now, hash, workspaceKey } = require('./run-store');
const { normalizeReviewer } = require('./audit-config');
const { checkReviewers } = require('./agent-health');
const { applyTriage, canRepair, presentAudit } = require('./audit-triage');
const { createVerification, driveVerification } = require('./finding-verification');

function text(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_AUDIT: ${field} is required`);
    return value.trim();
}
function limit(value, fallback, max) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('INVALID_AUDIT_LIMIT');
    return n;
}
function parseReport(answer, snapshot, checklist=[]) {
    const report = parseObject(answer);
    if (typeof report.scopeComplete !== 'boolean' || !Array.isArray(report.coverage) || !Array.isArray(report.findings) || report.findings.length > 200) throw new Error('INVALID_AUDIT_REPORT');
    const summary = text(report.summary, 'summary');
    const coverage = report.coverage.map(v => text(v, 'coverage'));
    if (report.scopeComplete && !coverage.length) throw new Error('INVALID_AUDIT_COVERAGE');
    const findings = report.findings.map(f => {
        if (!f || !['BUG','RISK','SUGGESTION','QUESTION'].includes(f.category) || !['LOW','MEDIUM','HIGH','CRITICAL'].includes(f.severity)) throw new Error('INVALID_AUDIT_FINDING');
        const file = text(f.file, 'file').replace(/\\/g, '/');
        if (path.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split('/').includes('..')) throw new Error('INVALID_FINDING_PATH');
        return { evidenceRefs:evidenceRefs(f.evidenceRefs,null,snapshot), category: f.category, severity: f.severity, file,
            lineRange: typeof f.lineRange === 'string' ? f.lineRange : '', problem: text(f.problem,'problem'),
            evidence: text(f.evidence,'evidence'), acceptance: text(f.acceptance,'acceptance'),
            fixSuggestion: typeof f.fixSuggestion === 'string' ? f.fixSuggestion : '' };
    });
    return applyChecklist({summary, taskChecks:report.taskChecks, coverageDetails:coverageDetails(report.coverageDetails,report.scopeComplete), scopeComplete: report.scopeComplete, coverage, findings},checklist);
}
function aggregate(record) {
    const groups = new Map();
    const severity = ['LOW','MEDIUM','HIGH','CRITICAL'];
    for (const reviewer of record.reviewers) {
        if (reviewer.status !== 'COMPLETED') continue;
        for (const f of reviewer.report.findings) {
            const key = hash([f.category, process.platform === 'win32' ? f.file.toLowerCase() : f.file,
                f.problem.toLowerCase().replace(/\s+/g,' ')].join('\n'));
            let item = groups.get(key);
            if (!item) { item = { ...f, id: `F-${key.slice(0,20)}`, sources: [] }; groups.set(key,item); }
            if (severity.indexOf(f.severity) > severity.indexOf(item.severity)) item.severity = f.severity;
            item.sources.push({ reviewerId: reviewer.id, reviewerName: reviewer.name, provider: reviewer.provider,
                model: reviewer.model, ...f });
        }
    }
    return [...groups.values()];
}
function ensureReviewersStopped(record) {
    const processes=[...record.reviewers,...(record.closureTests||[]),...(record.verificationRuns||[]).flatMap(run=>[run,...run.items])];
    for (const reviewer of processes) if (reviewer.activePid) {
        let alive = false;
        try { process.kill(reviewer.activePid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
        if (alive) throw new Error('PREVIOUS_PROCESS_STILL_RUNNING');
        reviewer.activePid = null;
    }
}
class AuditWorkflow {
    constructor(store, {agent=invokeAgent, command=execute, snapshot=sourceSnapshot, catalog={}, preflight=checkReviewers, emit=()=>{}} = {}) {
        this.store=store; this.agent=agent; this.snapshot=snapshot; this.catalog=catalog; this.emit=emit; this.active=null;
        this.preflight=preflight;
        this.command=command;
    }
    save(record) { this.store.save('audits',record); this.emit('audit_update',{id:record.id,workspaceRoot:record.workspaceRoot,status:record.status}); }
    hasLiveClosureTest(){
        return this.store.list('audits').some(a=>(a.closureTests||[]).some(g=>{if(!g.activePid)return false;try{process.kill(g.activePid,0);return true;}catch(e){return e.code!=='ESRCH';}}));
    }
    acceptClosure(id,input){return closureActions.acceptClosure(this,id,input);}
    testClosure(id,input){return closureActions.testClosure(this,id,input);}
    recheckClosure(id,input){return closureActions.recheckClosure(this,id,input);}
    triage(id,input){
        if(this.active)throw new Error('WORKFLOW_BUSY');
        const record=this.store.read('audits',id);ensureReviewersStopped(record);
        applyTriage(record,input);this.save(record);return presentAudit(record);
    }
    recover() {
        for (const record of this.store.list('audits')) {
          let changed=false;
          for(const gate of record.closureTests||[])if(gate.status==='RUNNING'){gate.status='INTERRUPTED';gate.error='服务重启，测试未完成';changed=true;}
          if (['RUNNING','CREATED'].includes(record.status)) {
            record.status='INTERRUPTED'; record.error='服务重启，审核未完成；可在同一源码版本上重试。';
            for (const reviewer of record.reviewers) if (['RUNNING','QUEUED'].includes(reviewer.status)) reviewer.status='INTERRUPTED';
            changed=true;
          }
          for(const run of record.verificationRuns||[])if(['RUNNING','QUEUED'].includes(run.status)){
            run.status='INTERRUPTED';run.error='服务重启，验证未完成；请重新发起验证。';run.finishedAt=now();changed=true;
            if(['RUNNING','QUEUED'].includes(run.reproduction.status))run.reproduction.status='INTERRUPTED';
            for(const item of run.items)if(['RUNNING','QUEUED'].includes(item.status)){item.status='INTERRUPTED';item.error=run.error;}
          }
          if(interruptOpenAttempts(record)>0)changed=true;
          if(recoverBudget(record))changed=true;
          if(changed)this.save(record);
        }
    }
    verify(id,config){
        if(this.active||this.store?.guard?.isBusy())throw new Error('WORKFLOW_BUSY');
        const record=this.store.read('audits',id);ensureReviewersStopped(record);
        if(workspaceKey(config.workspaceRoot)!==record.workspaceKey)throw new Error('AUDIT_WORKSPACE_MISMATCH');
        const run=createVerification(record,config,typeof this.catalog==='function'?this.catalog():this.catalog);
        record.verificationRuns||=[];record.verificationRuns.push(run);this.save(record);
        const lease=this.store?.guard?this.store.guard.acquire({kind:'verification',id,workspaceKey:record.workspaceKey}):null;
        const controller=new AbortController();this.active={id,kind:'verification',verificationId:run.id,controller,promise:null,lease};
        this.active.promise=(async()=>{
            try {
                if (lease) await lease;
                await driveVerification(this,record,run,controller.signal);
            } catch (err) {
                run.status='FAILED';run.error=err.message;this.save(record);
            }
        })().finally(()=>{this.active?.lease?.release?.();this.active=null;this.emit('audit_idle',{id});});return run;
    }
    create(config) {
        if (this.active) throw new Error('WORKFLOW_BUSY');
        const workspaceRoot=fs.realpathSync(text(config.workspaceRoot,'workspaceRoot'));
        if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('INVALID_WORKSPACE');
        if (!Array.isArray(config.reviewers) || !config.reviewers.length || config.reviewers.length>8) throw new Error('INVALID_REVIEWER_COUNT');
        const catalog=typeof this.catalog==='function'?this.catalog():this.catalog;
        const record={id:crypto.randomUUID(),schemaVersion:'1.0',workspaceRoot,workspaceKey:workspaceKey(workspaceRoot),
            feature:typeof config.feature==='string'&&config.feature.trim()?config.feature.trim():'并行工程审核',
            commonPrompt:text(config.commonPrompt,'commonPrompt'),scope:text(config.scope || '自有源码、测试和配置','scope'),
            concurrency:limit(config.concurrency,3,4),timeoutSeconds:limit(config.timeoutSeconds,1200,7200),
            reviewers:config.reviewers.map((r,i)=>({...normalizeReviewer(r,i,catalog),id:crypto.randomUUID(),sessionId:crypto.randomUUID(),
                status:'QUEUED',report:null,error:'',activePid:null,attempt:0})),
            status:'CREATED',snapshot:null,findings:[],triage:{},repairRuns:[],error:'',createdAt:now()};
        ensureBudget(record, config.budget);
        this.save(record); return record;
    }
    launch(record) {
        if(this.active||this.store?.guard?.isBusy())throw new Error('WORKFLOW_BUSY');
        const controller=new AbortController();
        const lease=this.store?.guard?this.store.guard.acquire({kind:'audit',id:record.id,workspaceKey:record.workspaceKey}):null;
        this.active={id:record.id,controller,promise:null,lease};
        this.active.promise=(async()=>{
            try {
                if (lease) await lease;
                if (controller.signal.aborted) throw new Error('RUN_CANCELLED');
                startActiveTracking(record);
                record.status='RUNNING';record.error='';this.save(record);
                await this.drive(record,controller.signal);
            } catch (err) {
                record.status=controller.signal.aborted?'STOPPED':'FAILED';record.error=err.message;this.save(record);
            }
        })().finally(()=>{stopActiveTracking(record);this.active?.lease?.release?.();this.active=null;this.emit('audit_idle',{id:record.id});});
        return record;
    }
    retry(id) {
        if(this.active)throw new Error('WORKFLOW_BUSY');
        const record=this.store.read('audits',id);
        if(!['PARTIAL','FAILED','STOPPED','INTERRUPTED'].includes(record.status))throw new Error('AUDIT_NOT_RETRYABLE');
        ensureReviewersStopped(record);
        for(const r of record.reviewers)if(r.status!=='COMPLETED'||!r.report?.scopeComplete){r.status='QUEUED';r.error='';r.report=null;}
        record.findings=aggregate(record); return this.launch(record);
    }
    async supplement(id,input){
        if(this.active)throw new Error('WORKFLOW_BUSY');
        const parent=this.store.read('audits',id);ensureReviewersStopped(parent);
        if(!['COMPLETED','PARTIAL','FAILED','STOPPED','INTERRUPTED'].includes(parent.status))throw new Error('AUDIT_NOT_READY');
        if(workspaceKey(input.workspaceRoot)!==parent.workspaceKey)throw new Error('AUDIT_WORKSPACE_MISMATCH');
        if(input.version!==supplementVersion(parent))throw new Error('SUPPLEMENT_VERSION_CONFLICT');
        if(!Array.isArray(input.selections)||!input.selections.length||input.selections.length>20)throw new Error('INVALID_SUPPLEMENT_SELECTION');
        const gaps=auditGaps(parent),seen=new Set();
        const selected=input.selections.map(s=>{
            const gap=gaps.find(g=>g.reviewerId===s?.reviewerId&&g.taskId===s?.taskId),key=JSON.stringify([s?.reviewerId,s?.taskId]);
            if(!gap||seen.has(key))throw new Error('INVALID_SUPPLEMENT_SELECTION');seen.add(key);return gap;
        });
        const controller=new AbortController();
        const lease=this.store?.guard?this.store.guard.acquire({kind:'audit',id,workspaceKey:parent.workspaceKey}):null;
        const active={id,controller,promise:null,lease};this.active=active;
        active.promise=(async()=>{
            if (lease) await lease;
            const snapshot=await this.snapshot(parent.workspaceRoot,controller.signal);
            if(controller.signal.aborted)throw new Error('RUN_CANCELLED');
            if(parent.snapshot&&snapshot!==parent.snapshot)throw new Error('AUDIT_SOURCE_CHANGED');
            const reviewers=parent.reviewers.filter(r=>selected.some(g=>g.reviewerId===r.id)).map(r=>({
                ...r,scope:selected.filter(g=>g.reviewerId===r.id).map(g=>g.task).join('；'),checklist:selected.filter(g=>g.reviewerId===r.id).map(g=>g.taskId.startsWith('C-')?g.task:`[${g.taskId}] ${g.task.length>1900?`${g.task.slice(0,1900)}…（完整要求见原缺口及限制）`:g.task}`),
                prompt:`${r.prompt}\n本次只补审必查清单中的选中缺口，不重复宣称原审核整体完成。原缺口及限制：${JSON.stringify(selected.filter(g=>g.reviewerId===r.id))}`
            }));
            const child=this.createUnlockedSupplement(parent,reviewers,selected,snapshot);
            return child;
        })();
        let child;try{child=await active.promise;}finally{if(this.active===active){active.lease?.release?.();this.active=null;}}
        if(controller.signal.aborted)throw new Error('RUN_CANCELLED');
        return this.launch(child);
    }
    createUnlockedSupplement(parent,reviewers,selected,snapshot){
        // create() is synchronous; keep the reservation intact across all asynchronous work.
        const reservation=this.active;this.active=null;
        let child;
        try{child=this.create({workspaceRoot:parent.workspaceRoot,feature:`补审：${parent.feature}`,
            commonPrompt:parent.commonPrompt,scope:`仅补审选中缺口：${selected.map(g=>g.task).join('；')}。原范围仅作上下文：${parent.scope}`,concurrency:parent.concurrency,timeoutSeconds:parent.timeoutSeconds,reviewers});}
        finally{this.active=reservation;}
        child.snapshot=snapshot;
        child.parentAudit={id:parent.id,feature:parent.feature,snapshot:parent.snapshot,version:supplementVersion(parent),selections:selected};
        this.save(child);
        parent.supplementRuns||=[];parent.supplementRuns.push({auditId:child.id,selections:selected,at:now()});this.save(parent);
        return child;
    }
    async stop(){const active=this.active;if(active){active.controller.abort();await active.promise.catch(()=>{});active.lease?.release?.();}}
    prompt(record, reviewer) {
        return `You are an independent READ-ONLY code auditor. Never edit files, commit, fix code, or delegate edits.
Workspace: ${record.workspaceRoot}
Source fingerprint: ${record.snapshot}
Common audit requirements: ${record.commonPrompt}
Shared scope: ${record.scope}
Your additional scope: ${reviewer.scope || 'same as shared scope'}
Required checklist (IDs belong to YOUR report): ${JSON.stringify((reviewer.checklist||[]).map((task,i)=>({id:`C-${i+1}`,task})))}
Return taskChecks [{id:"C-1",status:"CHECKED|UNCHECKED|DISPUTED",evidence:"specific checks performed, or why incomplete"}] for EVERY required item. CHECKED means inspected, not bug-free. Missing results remain UNCHECKED. Any UNCHECKED or DISPUTED item requires scopeComplete=false.
Your additional instructions: ${reviewer.prompt || 'Review correctness and implementation risks.'}
Inspect actual source even without a git diff. Report concrete evidence; distinguish bugs, conditional design risks, optional suggestions and questions requiring business input. Do not invent execution results or assume missing requirements. State missing checks in summary and scopeComplete=false when scope is incomplete. A suggestion is not automatically a bug.
${evidenceInstructions}
Return ONLY JSON:
{"summary":"findings and limitations","scopeComplete":true,"coverage":["actual files and checks"],"findings":[{"category":"BUG|RISK|SUGGESTION|QUESTION","severity":"LOW|MEDIUM|HIGH|CRITICAL","file":"relative/path","lineRange":"10-20","problem":"specific issue","evidence":"code evidence, trigger and impact","acceptance":"what would resolve or verify this","fixSuggestion":"optional approach"}]}
Use findings:[] if no issue is found; never claim absolute bug-freedom.`;
    }
    async drive(record,signal){
        try{
            record.preflight=await this.preflight(record.reviewers.filter(r=>r.status==='QUEUED'),{signal});this.save(record);
            if(!record.preflight.ok)throw new Error('AGENT_PREFLIGHT_FAILED: 请检查审核员环境诊断结果。');
            const snapshot=await this.snapshot(record.workspaceRoot,signal);
            if(record.snapshot&&record.snapshot!==snapshot)throw new Error('AUDIT_SOURCE_CHANGED');
            record.snapshot=snapshot;this.save(record);
            const queue=record.reviewers.filter(r=>r.status==='QUEUED');
            let cursor=0;
            const worker=async()=>{
                while(cursor<queue.length&&!signal.aborted&&!record.sourceChanged){
                    const reviewer=queue[cursor++]; await this.review(record,reviewer,signal);
                }
            };
            // Every child catches its failure; Promise.all waits for all process cleanup.
            const results=await Promise.allSettled(Array.from({length:Math.min(record.concurrency,queue.length)},worker));
            const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
            if(!signal.aborted&&await this.snapshot(record.workspaceRoot,signal)!==record.snapshot)record.sourceChanged=true;
            record.findings=aggregate(record);
            const success=record.reviewers.filter(r=>r.status==='COMPLETED');
            const budgetExhausted=record.reviewers.some(r=>r.status==='STOPPED'&&r.pauseReason==='BUDGET_EXHAUSTED');
            if (budgetExhausted) {
                record.status='STOPPED';
                record.pauseReason='BUDGET_EXHAUSTED';
                record.allowedActions=['INCREASE_BUDGET','MANUAL_RESUME'];
                record.error='BUDGET_EXHAUSTED: 调用次数或运行时间已达到上限，请调整预算后继续。';
            } else {
                record.status=record.sourceChanged?'INVALIDATED':signal.aborted?'STOPPED':
                    success.length===record.reviewers.length&&success.every(r=>r.report.scopeComplete)?'COMPLETED':success.length?'PARTIAL':'FAILED';
            }
            if(record.sourceChanged)record.error='审核期间源码变化，报告已失效，请重新审核。';
        }catch(error){
            if(error.code==='BUDGET_EXHAUSTED'||/BUDGET_EXHAUSTED/.test(error.message)){
                record.status='STOPPED';
                record.pauseReason='BUDGET_EXHAUSTED';
                record.allowedActions=['INCREASE_BUDGET','MANUAL_RESUME'];
                record.error=error.message;
            } else {
                record.status=error.message==='AUDIT_SOURCE_CHANGED'?'INVALIDATED':signal.aborted?'STOPPED':'FAILED';
                record.error=error.message;
            }
        }
        finally{
            for(const reviewer of record.reviewers)if(['QUEUED','RUNNING'].includes(reviewer.status))reviewer.status=signal.aborted?'STOPPED':'INTERRUPTED';
            record.findings=aggregate(record);this.save(record);
        }
        return record;
    }
    async review(record,reviewer,signal){
        reviewer.status='RUNNING';reviewer.attempt++;reviewer.startedAt=now();reviewer.error='';delete reviewer.pauseReason;this.save(record);
        const prefix=`${reviewer.id}-${reviewer.attempt}`;
        const file=name=>this.store.file('audits',record.id,`${prefix}.${name}`);
        const meta={
            stepId:`reviewer:${reviewer.id}:${reviewer.attempt}`,
            role:'audit',
            phase:'review',
            provider:reviewer.provider,
            model:reviewer.model,
            reasoningEffort:reviewer.reasoningEffort,
            sessionId:reviewer.sessionId
        };
        try{
            if(await this.snapshot(record.workspaceRoot,signal)!==record.snapshot){record.sourceChanged=true;throw new Error('AUDIT_SOURCE_CHANGED');}
            const prompt=this.prompt(record,reviewer);fs.writeFileSync(file('prompt.txt'),prompt);
            reviewer.promptArtifact=path.basename(file('prompt.txt'));
            reviewer.report=await trackedCall(record,meta,{
                signal,
                persist:()=>this.save(record),
                invoke:async()=>{
                    let answer;
                    try{
                        answer=await this.agent({provider:reviewer.provider,model:reviewer.model,reasoningEffort:reviewer.reasoningEffort,
                            workspaceRoot:record.workspaceRoot,sessionId:reviewer.sessionId,role:'audit',prompt,
                            sessionDirectory:path.join(this.store.root,'sessions')},{signal,timeoutMs:record.timeoutSeconds*1000,
                            onSpawn:proc=>{reviewer.activePid=proc.pid;this.save(record);},
                            onOutput:(value,type)=>{fs.appendFileSync(file('log.txt'),value);this.emit('log',{message:`[${reviewer.name}] ${value}`,type,time:now()});}});
                    }finally{
                        reviewer.activePid=null;
                    }
                    if(signal.aborted)throw new Error('RUN_CANCELLED');
                    fs.writeFileSync(file('response.txt'),answer);
                    reviewer.responseArtifact=path.basename(file('response.txt'));
                    return answer;
                },
                accept:async answer=>{
                    if(await this.snapshot(record.workspaceRoot,signal)!==record.snapshot){record.sourceChanged=true;throw new Error('AUDIT_SOURCE_CHANGED');}
                    return parseReport(answer,record.snapshot,reviewer.checklist);
                }
            });
            reviewer.status='COMPLETED';
        }catch(error){
            reviewer.status=signal.aborted?'STOPPED':'FAILED';
            reviewer.error=error.message;
            if(error.code==='BUDGET_EXHAUSTED'||/BUDGET_EXHAUSTED/.test(error.message)){
                reviewer.status='STOPPED';
                reviewer.pauseReason='BUDGET_EXHAUSTED';
            }
        }
        finally{reviewer.activePid=null;reviewer.finishedAt=now();record.findings=aggregate(record);this.save(record);}
    }
    async repair(workflow,id,config){
        if(this.active||workflow.active)throw new Error('WORKFLOW_BUSY');
        const record=this.store.read('audits',id);
        if(record.status==='INVALIDATED')throw new Error('AUDIT_INVALIDATED');
        if(!['COMPLETED','PARTIAL','STOPPED','INTERRUPTED'].includes(record.status))throw new Error('AUDIT_NOT_READY');
        ensureReviewersStopped(record);
        if(record.status!=='COMPLETED'&&config.acceptPartial!==true)throw new Error('PARTIAL_AUDIT_REQUIRES_ACKNOWLEDGEMENT');
        if(config.workspaceRoot&&workspaceKey(config.workspaceRoot)!==record.workspaceKey)throw new Error('AUDIT_WORKSPACE_MISMATCH');
        if(!Array.isArray(config.findingIds)||!config.findingIds.length||new Set(config.findingIds).size!==config.findingIds.length)throw new Error('INVALID_FINDING_SELECTION');
        const selected=config.findingIds.map(id=>{const f=record.findings.find(f=>f.id===id);if(!f)throw new Error('UNKNOWN_FINDING_ID');if(f.category==='QUESTION')throw new Error('QUESTION_REQUIRES_CLARIFICATION');return f;});
        if(selected.some(f=>!canRepair(record,f)))throw new Error('FINDING_REQUIRES_TRIAGE');
        const controller=new AbortController();this.active={id,controller,promise:null};
        const perform=async()=>{
            if(await this.snapshot(record.workspaceRoot,controller.signal)!==record.snapshot){record.status='INVALIDATED';record.error='源码已经改变，请重新审核。';this.save(record);throw new Error('AUDIT_SOURCE_CHANGED');}
            if(controller.signal.aborted)throw new Error('RUN_CANCELLED');
            const decisions=selected.map(f=>({findingId:f.id,...record.triage[f.id]}));
            const verificationEvidence=presentAudit(record).findings.filter(f=>selected.some(s=>s.id===f.id)).map(f=>({findingId:f.id,verification:f.verification}));
            const taskPrompt=`人工选择以下审核发现进行修复。只实施选中事项及必要回归测试，未选建议不在本次范围。审查时逐项验证验收条件，保留来源证据；发现新的阻塞缺陷按现有闭环处理。\n${JSON.stringify(selected)}\n人工分诊依据：${JSON.stringify(decisions)}\n独立验证记录（仅供证据参考，仍需修复后独立复核）：${JSON.stringify(verificationEvidence)}`;
            const run=workflow.create({...config,workspaceRoot:record.workspaceRoot,taskPrompt,mode:'direct',autoCommit:false,
                feature:`审核修复：${record.feature}`,scope:record.scope});
            run.sourceAudit={id:record.id,snapshot:record.snapshot,findingIds:selected.map(f=>f.id),decisions,verificationEvidence,acceptedPartial:record.status!=='COMPLETED'};
            run.bugs=selected.map((f,i)=>({id:`BUG-${String(i+1).padStart(4,'0')}`,fingerprint:hash(`${f.file.toLowerCase()}\n${f.problem.toLowerCase().replace(/\s+/g,' ')}`),
                status:'OPEN',firstSeenRound:0,lastSeenRound:0,category:f.category,file:f.file,lineRange:f.lineRange,severity:f.severity,problem:f.problem,
                evidence:f.sources.map(s=>`[${s.reviewerName}] ${s.evidence}`).join('\n'),acceptance:[...new Set(f.sources.map(s=>s.acceptance))].join('\n'),
                fixSuggestion:f.fixSuggestion,sourceFindingId:f.id,history:[{round:0,status:'OPEN',evidence:'人工选择审核发现',snapshot:record.snapshot,at:now()}]}));
            workflow.save(run,'audit_findings_selected',{auditId:id});
            record.repairRuns.push({runId:run.id,findingIds:selected.map(f=>f.id),at:now()});this.save(record);
            workflow.launch(run);return run;
        };
        this.active.promise=perform().finally(()=>{this.active=null;});return this.active.promise;
    }
}
module.exports={AuditWorkflow,parseReport,aggregate};
