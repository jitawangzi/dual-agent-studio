'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
function page({storage=new Map(),remote={draft:{revision:0,recordVersion:1,value:null}}}={}){
  const elements=new Map(),requests=[],notices=[],loaded=[];
  class Element{
    constructor(){this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.children=[];this.dataset={};}
    set innerHTML(html){this.html=html;for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const e=new Element();e.id=match[2];e.value=/\bvalue="([^"]*)"/.exec(match[0])?.[1]||'';elements.set(e.id,e);}}
    get innerHTML(){return this.html||'';}
    appendChild(node){this.children.push(node);return node;} replaceChildren(...nodes){this.children=nodes;} add(node){this.children.push(node);}
    querySelector(){return this.removeButton||=new Element();} querySelectorAll(){return [];}
  }
  new Element().innerHTML=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const proposal={id:'P-1-1',memberId:'m1',author:'Design',title:'<img onerror=bad>',approach:'Source change',benefits:'Clarity',risks:'API change',outOfScope:[],acceptance:[{criterion:'Reject blank',verification:'Run regression'}]};
  const record={id:'discussion1',workspaceRoot:'project',status:'READY',updatedAt:'v1',version:1,phase:'HUMAN_DECISION',createdAt:'2026-10-04',feature:'Test',idea:'Improve',scope:'Source',calls:[],questions:[{id:'Q-1',question:'Allow empty?'}],members:[{id:'m1',name:'Design',provider:'mock',proposal:{proposals:[proposal]}},{id:'m2',name:'Quality',provider:'mock',proposal:{proposals:[]},challenge:{reviews:[{proposalId:'P-1-1',position:'CONCERN',reason:'Clarify semantics'}]}}]};
  const records=[record];
  const context={setTimeout,clearTimeout,document:{getElementById:id=>elements.get(id),createElement:()=>new Element(),addEventListener:(event,cb)=>loaded.push(cb)},window:{},Option:class{constructor(text,value){this.textContent=text;this.value=value;}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    escapeHtml:v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),showToast:message=>notices.push(message),updateRunningState:b=>context.window.planningApp.setBusy(b),switchTab:()=>{},startLoop:async()=>{},
    fetch:async(url,init)=>{const body=init?.body?JSON.parse(init.body):undefined;requests.push({url,body});let data;
      if(url==='/api/audit-capabilities')data={providers:[{id:'codex',name:'Codex',models:[{id:'model-a',name:'Model A',efforts:[{value:'high',label:'High'}]}]},{id:'claude',name:'Claude',models:[]},{id:'mock',name:'Mock',models:[]}]};
      else if(url.includes('/api/planning?'))data=elements.get('workspaceRoot').value==='project'?records:[];
      else if(url.endsWith('/draft')){if(body){if(body.draftRevision!==remote.draft.revision)return {ok:false,json:async()=>({error:'DRAFT_VERSION_CONFLICT'})};remote.draft={revision:remote.draft.revision+1,recordVersion:1,value:body.value};}data=remote.draft;}
      else if(url.endsWith('/preview'))data={finalPlan:'Exact human plan',previewHash:'preview1'};
      else if(url.endsWith('/approve')){record.status='APPROVED';record.updatedAt='v2';record.version++;record.planId='plan1';record.decision={finalPlan:'Exact human plan'};data={id:'plan1'};}
      else data={discussionId:'new'};return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))};},console};
  elements.get('workspaceRoot').value='project';vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/planning.js'),'utf8'),context);
  return {elements,requests,notices,record,context,storage,remote,load:async()=>{for(const cb of loaded)await cb();}};
}
test('planning UI preserves draft across polling and requires a fresh preview after any answer edit',async()=>{
  const p=page();await p.load();const e=id=>p.elements.get(id);
  assert.match(e('planningReport').innerHTML,/&lt;img onerror=bad&gt;/);assert(!e('planningReport').innerHTML.includes('<img onerror'));
  const editReason=value=>e('planningChoices').oninput({target:{dataset:{key:'reason'},value,closest:()=>({dataset:{proposal:'P-1-1'}})}});
  editReason('Human rationale');e('planningQuestions').oninput({target:{dataset:{question:'Q-1'},value:'Reject'}});
  const fetch=p.context.fetch;p.context.fetch=async()=>{throw new Error('Temporary disconnect');};await p.context.window.planningApp.refresh();assert.match(e('planningStatus').textContent,/读取讨论失败/);p.context.fetch=fetch;
  await p.context.window.planningApp.refresh();await e('planningPreview').onclick();
  assert.match(e('planningStatus').textContent,/等待人工取舍/);
  assert.equal(p.requests.find(r=>r.url.endsWith('/preview')).body.selections[0].reason,'Human rationale');assert.equal(e('planningApprove').disabled,false);assert.equal(e('planningApproval').hidden,false);
  e('planningQuestions').oninput({target:{dataset:{question:'Q-1'},value:'Reject blank strings too'}});assert.equal(e('planningApprove').disabled,true);assert.equal(e('planningApproval').hidden,true);
  await e('planningApprove').onclick();assert.equal(p.requests.filter(r=>r.url.endsWith('/approve')).length,0);
  await e('planningPreview').onclick();await e('planningApprove').onclick();const sent=p.requests.find(r=>r.url.endsWith('/approve')).body;assert.equal(sent.previewHash,'preview1');assert.equal(sent.answers[0].answer,'Reject blank strings too');assert.equal(e('planningLaunch').hidden,false);assert.equal(e('planningDecision').hidden,true);
  e('workspaceRoot').value='another';await p.context.window.planningApp.refresh();assert.equal(e('planningApproval').hidden,true);assert.equal(e('planningStatus').textContent,'尚未发起讨论。');
});
test('planning team model presets pass independent model and supported effort; busy prevents launch',async()=>{
  const p=page();await p.load();const e=id=>p.elements.get(id);
  e('plannerPreset0').value='model-a';e('plannerPreset0').onchange();assert.equal(e('plannerModel0').value,'model-a');assert.equal(e('plannerEffort0').disabled,false);
  e('plannerEffort0').value='high';e('plannerEffort0').onchange();e('vaguePrompt').value='Investigate validation';e('timeoutSeconds').value='60';
  p.context.window.planningApp.setBusy(true);await p.context.window.planningApp.start();assert.equal(p.requests.filter(r=>r.url==='/api/planning').length,0);
  p.context.window.planningApp.setBusy(false);await p.context.window.planningApp.start();const body=p.requests.find(r=>r.url==='/api/planning').body;assert.equal(body.members[0].model,'model-a');assert.equal(body.members[0].reasoningEffort,'high');assert.equal(body.members[1].model,'');assert.deepEqual(p.notices,[]);
});
test('draft reload restores saved input and cross-page conflicts preserve local input until an explicit choice',async()=>{
  const p=page();await p.load();const edit=(p,value)=>p.elements.get('planningChoices').oninput({target:{dataset:{key:'reason'},value,closest:()=>({dataset:{proposal:'P-1-1'}})}});
  edit(p,'Original draft');await p.elements.get('planningSaveDraft').onclick();assert.equal(p.remote.draft.revision,1);
  const q=page({storage:p.storage,remote:p.remote});await q.load();assert.match(q.elements.get('planningChoices').innerHTML,/Original draft/);
  edit(p,'Remote edit');await p.elements.get('planningSaveDraft').onclick();edit(q,'Local conflicting edit');await q.elements.get('planningSaveDraft').onclick();
  assert.equal(q.elements.get('planningDraftConflict').hidden,false);assert.equal(p.remote.draft.value.selections[0].reason,'Remote edit');
  const reloaded=page({storage:q.storage,remote:q.remote});await reloaded.load();assert.match(reloaded.elements.get('planningChoices').innerHTML,/Local conflicting edit/);assert.equal(reloaded.elements.get('planningDraftConflict').hidden,false);
  await reloaded.elements.get('planningUseLocal').onclick();assert.equal(p.remote.draft.revision,3);assert.equal(p.remote.draft.value.selections[0].reason,'Local conflicting edit');assert.equal(reloaded.elements.get('planningDraftConflict').hidden,true);
});
