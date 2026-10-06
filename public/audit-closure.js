'use strict';
(() => {
  const $=id=>document.getElementById(id),esc=value=>escapeHtml(String(value??''));
  let id='',view=null,busy=false,pending=false,sequence=0,noteVersion='';
  const labels={TRIAGE:'待确认',REPAIR:'待修复',VERIFY:'待独立复核',CLOSED:'已独立复核关闭',DEFERRED:'暂缓',DISMISSED:'已排除'};
  const errors={CLOSURE_VERSION_CONFLICT:'证据或源码已变化，请刷新总览后重新判断。',CLOSURE_BLOCKED:'尚未满足验收条件，请处理待办。',CLOSURE_NOTE_REQUIRED:'请填写人工验收说明。',WORKFLOW_BUSY:'其他任务正在运行，请稍后重试。',CLOSURE_EXECUTION_ACK_REQUIRED:'请先确认执行测试命令。'};
  async function request(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(errors[data.error]||data.error);return data;}
  function buttons(){
    for(const button of ['btnRecheckClosure','btnTestClosure','btnAcceptClosure'])$(button).disabled=!id||busy||pending;
    const staleNote=!!$('auditClosureNote').value.trim()&&noteVersion!==view?.version;
    $('auditClosureDraftHint').textContent=staleNote?'证据已变化，请核对总览并重新编辑验收说明。':'';
    $('btnAcceptClosure').disabled||=!view?.ready||!!view?.acceptance?.current||!$('auditClosureNote').value.trim()||staleNote;
    $('btnTestClosure').disabled||=!$('auditClosureExecute').checked||!$('auditClosureCommand').value.trim();
    $('btnStopClosure').disabled=!busy;
  }
  const auditButton=(auditId,label)=>`<button class="btn btn-secondary btn-sm" data-closure-audit="${esc(auditId)}">${esc(label)}</button>`;
  function render(){
    $('auditClosureSummary').textContent=view.acceptance?.current?'已人工验收（当前证据有效）':view.ready?'验收条件已满足，等待人工确认。':view.blockers.join('；');
    $('auditClosureCoverage').innerHTML='<h5>范围与必查项</h5>'+view.coverage.map(c=>`<article class="audit-reviewer-card"><strong>${esc(c.name)} · ${c.complete?'已检查':'待补审 / 重新审核'}</strong><p>${esc(c.scope)}${c.stale?' · 原证据源码已变化':''}</p>${auditButton(c.auditId,'查看审核 / 处理缺口')}<ul>${c.tasks.map(t=>`<li>${esc(t.task)} · ${t.proof?'已检查':'待检查'} ${t.proof?auditButton(t.proof.auditId,'证据来源'):''}</li>`).join('')}${c.gaps.filter(g=>!g.taskId.startsWith('C-')).map(g=>`<li>${esc(g.task)} · ${g.proof?'已补审':'待处理'} ${g.proof?auditButton(g.proof.auditId,'补审证据'):''}</li>`).join('')}</ul></article>`).join('');
    $('auditClosureTodos').innerHTML='<h5>问题与待办</h5>'+(view.findings.length?view.findings.map(f=>`<article class="audit-finding"><strong>${esc(labels[f.state])} · ${esc(f.problem)}</strong><p>${esc(f.note||f.evidence||'请查看来源报告处理')}</p>${f.auditId?auditButton(f.auditId,'查看发现 / 分诊'):''}${f.runId?`<button class="btn btn-secondary btn-sm" data-closure-run="${esc(f.runId)}">查看修复与复核</button>`:''}</article>`).join(''):'<p>尚无发现的问题；这不代表工程没有 Bug。</p>');
    const gate=view.test;
    $('auditClosureTestResult').textContent=gate?`最近测试：${gate.status} · ${gate.command} · ${gate.snapshot===view.snapshot?'当前源码':'证据过期或未完成'}${gate.error?' · '+gate.error:''}`:'尚无真实测试证据。';
    if(gate?.artifact){const link=document.createElement('a');link.textContent=' 查看测试日志';link.target='_blank';link.rel='noopener';link.href=`/api/${gate.runId?'runs':'audits'}/${encodeURIComponent(gate.runId||gate.auditId)}/artifacts?name=${encodeURIComponent(gate.artifact)}`;$('auditClosureTestResult').appendChild(link);}
    $('auditClosureHistory').innerHTML='<h5>人工验收记录</h5>'+view.history.map(a=>`<p>${esc(a.at)} · ${esc(a.note)}${a.id===view.acceptance?.id?(view.acceptance.current?' · 当前有效':' · 证据已变化，需重新验收'): ' · 历史记录'}</p>`).join('');buttons();
  }
  async function load(next=id){
    if(!next)return;
    if(next!==id){id=next;view=null;noteVersion='';$('auditClosureNote').value='';$('auditClosureExecute').checked=false;$('auditClosureCommand').value='';}
    $('auditClosureBox').hidden=false;const token=++sequence;buttons();
    try{const data=await request(`/api/audits/${encodeURIComponent(next)}/closure`);if(token!==sequence||next!==id)return;view=data;render();}
    catch(error){if(token===sequence){view=null;$('auditClosureSummary').textContent='读取闭环失败：'+error.message;buttons();}}
  }
  async function act(action){
    if(!id||busy||pending)return;pending=true;buttons();const selected=id;
    try{
      const body={workspaceRoot:$('workspaceRoot').value.trim()};
      if(action==='accept')Object.assign(body,{version:noteVersion,note:$('auditClosureNote').value});
      if(action==='test')Object.assign(body,{command:$('auditClosureCommand').value,execute:$('auditClosureExecute').checked});
      const data=await request(`/api/audits/${encodeURIComponent(selected)}/closure-${action}`,body);
      if(action!=='accept')updateRunningState(true);
      if(action==='recheck')await window.auditApp.openAudit(data.auditId);else if(id===selected)await load(selected);
      showToast(action==='accept'?'人工验收已记录。':action==='test'?'验收测试已启动。':'已启动当前源码的重新审核。','success');
    }catch(error){showToast(error.message,'error');if(id===selected)await load(selected);}finally{pending=false;buttons();}
  }
  window.auditClosure={load,setBusy:value=>{const ended=busy&&!value;busy=value;buttons();if(ended&&id)load();},clear:()=>{id='';view=null;sequence++;$('auditClosureBox').hidden=true;}};
  document.addEventListener('DOMContentLoaded',()=>{
    $('btnRefreshClosure').onclick=()=>load();$('btnRecheckClosure').onclick=()=>act('recheck');$('btnTestClosure').onclick=()=>act('test');$('btnAcceptClosure').onclick=()=>act('accept');
    $('btnStopClosure').onclick=()=>request('/api/stop',{}).catch(e=>showToast(e.message,'error'));
    for(const name of ['auditClosureNote','auditClosureCommand','auditClosureExecute'])$(name).oninput=buttons;
    $('auditClosureNote').oninput=()=>{noteVersion=view?.version||'';buttons();};
    $('auditClosureBox').onclick=event=>{const target=event.target;if(target.dataset.closureAudit)window.auditApp.openAudit(target.dataset.closureAudit);if(target.dataset.closureRun)window.auditApp.openRun(target.dataset.closureRun);};buttons();
  });
})();
