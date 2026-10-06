'use strict';
// Execute the real UI controller with a minimal DOM boundary; no browser or paid CLI required.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
function page(records=[]) {
    const elements=new Map(), requests=[], notices=[], loaded=[];
    class Element {
        constructor(tag='div'){this.tag=tag;this.value='';this.textContent='';this.checked=false;this.disabled=false;this.hidden=false;this.children=[];this.listeners={};this.dataset={};this.style={};}
        set innerHTML(html){this.html=html; for(const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
            const element=new Element(match[1]);element.id=match[2];element.value=/\bvalue="([^"]*)"/.exec(match[0])?.[1]||'';
            const field=/data-field="([^"]+)"/.exec(match[0]);if(field)element.dataset.field=field[1];elements.set(element.id,element);
        }}
        get innerHTML(){return this.html||'';}
        appendChild(node){this.children.push(node);return node;}
        replaceChildren(...nodes){this.children=nodes;}
        add(node){this.children.push(node);}
        addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
        querySelector(){return this.removeButton ||= new Element('button');}
        async fire(type,target=this){for(const handler of this.listeners[type]||[])await handler({target});await this['on'+type]?.({target});}
    }
    const root=new Element();root.innerHTML=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
    const caps={maxReviewers:8,maxConcurrency:4,providers:[{id:'codex',name:'Codex',models:[{id:'test-gpt',name:'Test GPT',efforts:[{value:'high',label:'High'}]}]}, {id:'claude',name:'Claude',models:[]},{id:'mock',name:'Mock',models:[]}]};
    const context={document:{getElementById:id=>elements.get(id)||null,createElement:tag=>new Element(tag),addEventListener:(event,cb)=>loaded.push(cb)},
        window:{},Option:class {constructor(text,value){this.textContent=text;this.value=value;}},localStorage:{getItem:()=>null,setItem:()=>{}},
        escapeHtml:value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
        showToast:(message,type)=>notices.push({message,type}),activeTab:'audit',selectedRunId:null,refreshRuns:async()=>{},
        updateRunningState:value=>context.window.auditApp.setBusy(value),switchTab:tab=>{context.activeTab=tab;},
        fetch:async(url,init)=>{const body=init?.body?JSON.parse(init.body):undefined;requests.push({url,body});
            let data;if(url==='/api/audit-capabilities')data=caps;else if(url.startsWith('/api/audits?'))data=records;
            else if(url.startsWith('/api/audit-templates'))data=body?{id:'t1',version:1}:[];
            else if(url==='/api/agent-health')data={ok:true,results:[{provider:'mock',name:'Mock',code:'MOCK_ONLY',auth:'NOT_APPLICABLE'}]};
            else if(url.endsWith('/triage')){data=records[0];data.findings[0].repairable=true;data.findings[0].triage={status:body.status,note:body.note};data.updatedAt='triaged';}
            else if(url.endsWith('/artifacts'))data=[];else if(url.endsWith('/repair'))data={runId:'repair-run'};
            else if(url==='/api/audits')data={auditId:'new-audit'};else data={auditId:'audit-one'};
            return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))};},console};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/review-evidence.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/audit.js'),'utf8'),context);
    const set=(id,value)=>{elements.get(id).value=value;};
    set('workspaceRoot','D:\\fixture');set('auditCommonPrompt','Check edge cases');set('auditConcurrency','2');set('timeoutSeconds','1200');
    return {context,elements,requests,notices,set,records,init:()=>Promise.all(loaded.map(f=>f()))};
}
const result=()=>({id:'audit-one',status:'COMPLETED',updatedAt:'1',createdAt:'2026-10-03T00:00:00Z',feature:'UI fixture',workspaceRoot:'D:\\fixture',scope:'app.js',commonPrompt:'Check',error:'',repairRuns:[],
    reviewers:[{id:'r1',name:'Reader',provider:'mock',status:'COMPLETED',report:{summary:'checked',scopeComplete:true,coverage:['app.js'],findings:[]}}],
    findings:[{id:'f1',category:'BUG',severity:'HIGH',problem:'Null guard',file:'app.js',lineRange:'1',evidence:'dereference',acceptance:'no crash',sources:[],repairable:true,evidenceKey:'proof',triageVersion:1,triage:{status:'CONFIRMED',note:'reproduced'}}]});

test('UI transmits each selected model and effort and resets effort for unknown models',async()=>{
    const p=page();await p.init();
    const model=p.elements.get('auditorModel0'),card=p.elements.get('auditReviewerEditors').children[0];
    assert(model,p.elements.get('auditConfigHint').textContent);
    model.value='test-gpt';await card.fire('input',model);
    const effort=p.elements.get('auditorEffort0');assert.equal(effort.disabled,false);effort.value='high';await card.fire('input',effort);
    await p.context.window.auditApp.start();
    const submitted=p.requests.find(r=>r.url==='/api/audits'&&r.body).body;
    assert.equal(submitted.reviewers[0].model,'test-gpt');assert.equal(submitted.reviewers[0].reasoningEffort,'high');assert.equal(submitted.reviewers.length,2);
    p.context.window.auditApp.setBusy(false);model.value='custom-unknown';await card.fire('input',model);
    assert.equal(effort.disabled,true);assert.equal(effort.value,'');
});

test('UI repair sends selected IDs and development settings without client-authored findings',async()=>{
    const p=page([result()]);await p.init();
    for(const [id,value] of Object.entries({devProvider:'mock',reviewProvider:'mock',verifyCommand:'node --check app.js',maxRounds:'3',cleanRoundsRequired:'2',maxSelfHealAttempts:'3'}))p.set(id,value);
    await p.elements.get('auditFindings').fire('change',{dataset:{finding:'f1'},checked:true});
    assert.equal(p.elements.get('btnRepairAudit').disabled,false);
    await p.elements.get('btnRepairAudit').fire('click');
    const body=p.requests.find(r=>r.url.endsWith('/repair')).body;
    assert.deepEqual(body.findingIds,['f1']);assert.equal(body.devProvider,'mock');assert.equal(body.findings,undefined);
    assert.equal(p.context.selectedRunId,'repair-run');assert.equal(p.context.activeTab,'timeline');
});

test('UI requires acknowledgement for partial results and clears selections no longer in the report',async()=>{
    const audit=result();audit.status='PARTIAL';const p=page([audit]);await p.init();
    await p.elements.get('auditFindings').fire('change',{dataset:{finding:'f1'},checked:true});
    assert.equal(p.elements.get('btnRepairAudit').disabled,true);
    p.elements.get('auditAcceptPartial').checked=true;await p.elements.get('auditAcceptPartial').fire('change');
    assert.equal(p.elements.get('btnRepairAudit').disabled,false);
    audit.findings=[];audit.updatedAt='2';await p.context.window.auditApp.refresh();
    assert.match(p.elements.get('btnRepairAudit').textContent,/（0）/);
    assert.equal(p.elements.get('btnRepairAudit').disabled,true);
});

test('audit completion replaces the running header',async()=>{
    const audit=result();audit.status='RUNNING';const p=page([audit]);await p.init();
    p.context.window.auditApp.setBusy(true);await p.context.window.auditApp.refresh({activeAuditId:audit.id,isRunning:true});
    assert.equal(p.elements.get('statusText').textContent,'并行审核中');
    audit.status='COMPLETED';audit.updatedAt='2';p.context.window.auditApp.setBusy(false);await p.context.window.auditApp.refresh({activeAuditId:null,isRunning:false});
    assert.match(p.elements.get('statusText').textContent,/审核完成/);
});

test('UI records triage before selection and includes server evidence/version in the request',async()=>{
    const audit=result();audit.findings[0].repairable=false;audit.findings[0].triage=null;audit.findings[0].triageVersion=0;
    const p=page([audit]);await p.init();
    await p.elements.get('auditFindings').fire('change',{dataset:{finding:'f1'},checked:true});assert.equal(p.elements.get('btnRepairAudit').disabled,true);
    p.set('triageStatus-f1','CONFIRMED');p.set('triageNote-f1','Reproduced null crash');
    await p.elements.get('auditFindings').fire('click',{dataset:{triage:'f1'}});
    const submitted=p.requests.find(r=>r.url.endsWith('/triage')).body;
    assert.equal(submitted.evidenceKey,'proof');assert.equal(submitted.version,0);assert.equal(submitted.note,'Reproduced null crash');
    await p.elements.get('auditFindings').fire('change',{dataset:{finding:'f1'},checked:true});assert.equal(p.elements.get('btnRepairAudit').disabled,false);
});
test('UI environment check is distinct from model probe and does not include workspace content',async()=>{
    const p=page();await p.init();await p.elements.get('btnCheckAgents').fire('click');
    const submitted=p.requests.find(r=>r.url==='/api/agent-health').body;assert.equal(submitted.mode,'check');assert.equal(submitted.workspaceRoot,undefined);
    assert.match(p.elements.get('auditAgentHealth').textContent,/Mock/);assert.equal(p.elements.get('btnStopAgentCheck').disabled,true);
});

test('verification uses separate selection/model and requires explicit command acknowledgement',async()=>{
    const audit=result();audit.findings[0].repairable=false;const p=page([audit]);await p.init();
    p.set('findingVerifierProvider','codex');await p.elements.get('findingVerifierProvider').fire('change');
    p.set('findingVerifierModel','test-gpt');await p.elements.get('findingVerifierModel').fire('input');
    p.set('findingVerifierEffort','high');await p.elements.get('findingVerifierEffort').fire('change');
    await p.elements.get('auditFindings').fire('change',{dataset:{verifyFinding:'f1'},checked:true});
    assert.equal(p.elements.get('btnVerifyFindings').disabled,false);assert.equal(p.elements.get('btnRepairAudit').disabled,true);
    p.set('findingReproductionCommand','node reproduce.js');await p.elements.get('findingReproductionCommand').fire('input');assert.equal(p.elements.get('btnVerifyFindings').disabled,true);
    p.elements.get('findingExecuteReproduction').checked=true;await p.elements.get('findingExecuteReproduction').fire('change');
    await p.elements.get('btnVerifyFindings').fire('click');const body=p.requests.find(r=>r.url.endsWith('/verify')).body;
    assert.deepEqual(body.findings,[{id:'f1',evidenceKey:'proof'}]);assert.equal(body.verifier.model,'test-gpt');assert.equal(body.verifier.reasoningEffort,'high');assert.equal(body.executeReproduction,true);
});
test('filters clear hidden repair/verification selections while preserving matching triage drafts',async()=>{
    const p=page([result()]);await p.init();
    p.set('triageNote-f1','Unsubmitted evidence');p.set('triageStatus-f1','CONFIRMED');await p.elements.get('auditFindings').fire('input',p.elements.get('triageNote-f1'));
    await p.elements.get('auditFindings').fire('change',{dataset:{finding:'f1'},checked:true});
    await p.elements.get('auditFindings').fire('change',{dataset:{verifyFinding:'f1'},checked:true});
    p.set('findingCategoryFilter','QUESTION');await p.elements.get('findingCategoryFilter').fire('change');
    assert.equal(p.elements.get('btnRepairAudit').disabled,true);assert.equal(p.elements.get('btnVerifyFindings').disabled,true);assert.match(p.elements.get('findingFilterSummary').textContent,/0 \/ 1/);
    await p.elements.get('btnResetFindingFilters').fire('click');assert.match(p.elements.get('auditFindings').innerHTML,/Unsubmitted evidence/);assert.match(p.elements.get('findingFilterSummary').textContent,/1 \/ 1/);
});

test('reproduction consent is cleared when switching audit records or workspaces',async()=>{
    const first=result(),second={...result(),id:'audit-two'},p=page([first,second]);await p.init();
    p.set('findingReproductionCommand','node reproduce.js');p.elements.get('findingExecuteReproduction').checked=true;
    // Polling the same report must preserve the deliberate confirmation.
    await p.context.window.auditApp.refresh();assert.equal(p.elements.get('findingExecuteReproduction').checked,true);
    p.set('auditHistory',second.id);await p.elements.get('auditHistory').fire('change');
    await p.context.window.auditApp.refresh();assert.equal(p.elements.get('findingExecuteReproduction').checked,false);
    p.elements.get('findingExecuteReproduction').checked=true;p.set('workspaceRoot','D:\\other-project');
    p.records.splice(0,p.records.length);await p.context.window.auditApp.refresh();
    assert.equal(p.elements.get('findingReproductionCommand').value,'');assert.equal(p.elements.get('findingExecuteReproduction').checked,false);
});
test('verification evidence is escaped and not-reproduced is explicitly distinct from false positive',async()=>{
    const audit=result();audit.findings[0].verification={status:'COMPLETED',runId:'v1',verifier:{provider:'mock',name:'Check'},reproduction:{command:'',status:'NOT_REQUESTED',code:null,stdout:'<script>danger</script>',stderr:''},report:{verdict:'NOT_REPRODUCED',summary:'Not covered',evidence:'<img onerror=bad>',steps:['suggestion only'],expected:'value',actual:'not seen',limitations:'one check'}};
    const p=page([audit]);await p.init();const html=p.elements.get('auditFindings').innerHTML;
    assert.match(html,/本次未复现，不代表误报或已修复/);assert(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
    p.set('findingVerificationFilter','NOT_REPRODUCED');await p.elements.get('findingVerificationFilter').fire('change');assert.match(p.elements.get('findingFilterSummary').textContent,/1 \/ 1/);
});
test('a retained triage draft keeps its original version when another page updates the decision',async()=>{
    const audit=result(),p=page([audit]);await p.init();p.set('triageNote-f1','Draft before remote update');p.set('triageStatus-f1','CONFIRMED');
    await p.elements.get('auditFindings').fire('input',p.elements.get('triageNote-f1'));
    audit.updatedAt='new';audit.findings[0].triageVersion=2;audit.findings[0].triage={status:'DEFERRED',version:2,note:'Another user decision'};
    await p.context.window.auditApp.refresh();assert.match(p.elements.get('auditFindings').innerHTML,/Draft before remote update/);
    await p.elements.get('auditFindings').fire('click',{dataset:{triage:'f1'}});
    assert.equal(p.requests.find(r=>r.url.endsWith('/triage')).body.version,1);
});

test('2.7 auditor cards show explicit coverage gaps and source provenance',async()=>{
    const audit=result();audit.status='PARTIAL';audit.reviewers[0].report.scopeComplete=false;
    audit.reviewers[0].report.coverageDetails=[{target:'auth/<script>',status:'UNCHECKED',checks:'no environment',limitations:'needs credentials'}];
    audit.findings[0].evidenceRefs=[{kind:'SOURCE',file:'app.js',startLine:1,endLine:2,explanation:'static check',snapshot:'v1'}];
    const p=page([audit]);await p.init();
    assert.match(p.elements.get('auditReviewerResults').innerHTML,/未检查/);
    assert.match(p.elements.get('auditReviewerResults').innerHTML,/auth\/&lt;script&gt;/);
    assert.match(p.elements.get('auditFindings').innerHTML,/Agent 声明/);
});

test('2.8 UI sends checklist assignments and only selected server-owned gaps',async()=>{
 const audit=result();audit.status='PARTIAL';audit.supplementVersion='version-1';audit.gaps=[{reviewerId:'r1',reviewerName:'Reader',taskId:'C-2',task:'error handling',reason:'not checked',status:'UNCHECKED'}];
 const p=page([audit]);await p.init();
 const input=p.elements.get('auditorChecklist0');input.value='null input\ntimeout';await p.elements.get('auditReviewerEditors').children[0].fire('input',input);
 await p.context.window.auditApp.start();const submitted=p.requests.find(r=>r.url==='/api/audits'&&r.body).body;assert.deepEqual(submitted.reviewers[0].checklist,['null input','timeout']);
 p.context.window.auditApp.setBusy(false);await p.context.window.auditApp.openAudit(audit.id);
 await p.elements.get('auditGaps').fire('change',{dataset:{gap:'0'},checked:true});assert.equal(p.elements.get('btnSupplementAudit').disabled,false);
 await p.elements.get('btnSupplementAudit').fire('click');const body=p.requests.find(r=>r.url.endsWith('/supplement')).body;
 assert.equal(body.version,'version-1');assert.deepEqual(body.selections,[{reviewerId:'r1',taskId:'C-2'}]);assert.equal(body.reviewers,undefined);
});
