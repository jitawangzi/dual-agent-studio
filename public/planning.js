'use strict';
(() => {
  const $=id=>document.getElementById(id),esc=value=>escapeHtml(String(value??''));
  const labels={CREATED:'准备中',RUNNING:'讨论中',READY:'等待人工取舍',APPROVED:'方案已批准',FAILED:'讨论失败',STOPPED:'已停止',INTERRUPTED:'讨论中断',INVALIDATED:'源码已变化，请重新讨论'};
  const phases={PREFLIGHT:'检查运行环境',INVESTIGATE:'调查工程',PROPOSE:'独立提案',CHALLENGE:'交叉质询',HUMAN_DECISION:'人工决策'};
  const errors={WORKFLOW_BUSY:'已有任务运行中，请等待完成或停止。',PLANNING_SOURCE_CHANGED:'工程源码已变化，请带着意见重新讨论。',PLAN_PREVIEW_CONFLICT:'决策已变化，请重新生成预览。',PLANNING_VERSION_CONFLICT:'记录已更新，请刷新后重新决策。',INVALID_PLANNING_TEXT:'请填完取舍依据、验收条件和业务答复。',INVALID_PLAN_SELECTION:'请对每项建议选择采纳或暂缓。',PLAN_REQUIRES_SELECTED_PROPOSAL:'至少采纳一项建议。'};
  let capabilities=null,team=[],record=null,selection='',workspace='',stamp='',busy=false,working=false,sequence=0,refreshing=false,preview=null;
  const drafts=new Map(),ws=()=>$('workspaceRoot').value.trim();
  errors.DRAFT_VERSION_CONFLICT='草稿已被其他页面修改，请比较并选择要保留的版本。';
  async function request(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){const error=new Error(errors[data.error]||data.error||'请求失败');error.code=data.error;throw error;}return data;}
  const draftState=new Map();
  const localKey=r=>'studio_planning_draft:'+r.workspaceKey+':'+r.id;
  function backup(r){const state=draftState.get(r.id);try{localStorage.setItem(localKey(r),JSON.stringify({version:r.version,revision:state.revision,dirty:state.dirty,value:drafts.get(r.id)}));state.backupError=false;}catch{state.backupError=true;}}
  function draftStatus(){
    const state=record&&draftState.get(record.id);if(!state)return;
    $('planningDraftStatus').textContent=state.conflict?'草稿有版本冲突，尚未覆盖任何内容。':state.saving?'正在保存草稿…':state.error?'保存未完成：'+state.error:state.dirty?'有未同步输入；等待自动保存。':`草稿已同步 · 版本 ${state.revision}`;
    if(state.backupError)$('planningDraftStatus').textContent+=' 浏览器备份不可用，请等待服务端保存成功后再关闭页面。';
    $('planningDraftConflict').hidden=!state.conflict;$('planningRemoteDraft').textContent=state.remote?JSON.stringify(state.remote.value,null,2):'';
    $('planningSaveDraft').disabled=!!state.saving||working;
  }
  async function loadDraft(r){
    const existing=draftState.get(r.id);
    if(existing?.version===r.version){if(existing.conflict&&!existing.remote){existing.remote=await request(`/api/planning/${r.id}/draft`);if(record?.id===r.id)draftStatus();}return;}
    const remote=await request(`/api/planning/${r.id}/draft`);let local;try{local=JSON.parse(localStorage.getItem(localKey(r)));}catch{}
    const valid=remote.recordVersion===r.version,restorable=local?.version===r.version&&local.dirty;
    const same=JSON.stringify(local?.value)===JSON.stringify(remote.value);
    const conflict=!!(restorable&&!same&&local.revision!==remote.revision);
    drafts.set(r.id,restorable&&!same?local.value:valid&&remote.value?remote.value:initialDecision(r));
    draftState.set(r.id,{version:r.version,revision:conflict?local.revision:remote.revision,dirty:!!(restorable&&!same),conflict,remote:conflict?remote:null});
    if(restorable&&!same&&!conflict)draftState.get(r.id).timer=setTimeout(()=>flushDraft(r).catch(()=>{}),600);
  }
  async function flushDraft(r){
    const state=draftState.get(r.id);if(!state||state.version!==r.version)return;
    clearTimeout(state.timer);if(state.saving){await state.saving;return flushDraft(r);}
    if(state.conflict)throw new Error('草稿冲突，请先选择要保留的版本。');if(!state.dirty)return;
    const value=JSON.parse(JSON.stringify(drafts.get(r.id))),key=JSON.stringify(value);state.error='';
    state.saving=(async()=>{try{
      const saved=await request(`/api/planning/${r.id}/draft`,{workspaceRoot:r.workspaceRoot,version:r.version,draftRevision:state.revision,value});
      state.revision=saved.revision;state.dirty=JSON.stringify(drafts.get(r.id))!==key;backup(r);
    }catch(error){state.error=error.message;if(error.code==='DRAFT_VERSION_CONFLICT'){state.conflict=true;state.remote=await request(`/api/planning/${r.id}/draft`);}throw error;}
    finally{state.saving=null;if(record?.id===r.id){draftStatus();buttons();}}})();
    draftStatus();await state.saving;if(state.dirty)return flushDraft(r);
  }
  function changedDraft(){
    const state=draftState.get(record.id);if(!state)return;
    state.dirty=true;state.error='';backup(record);clearTimeout(state.timer);const captured=record;
    state.timer=setTimeout(()=>flushDraft(captured).catch(()=>{}),600);draftStatus();
  }
  function comparisonHtml(result){
    $('planningComparison').hidden=!result;if(!result)return;
    const detail=p=>p?`角色：${p.author}\n提案：${p.title}\n做法：${p.approach}\n收益：${p.benefits}\n风险：${p.risks}\n不包含：${p.outOfScope.join('；')}\n取舍：${{ADOPT:'采纳',DEFER:'暂缓',UNDECIDED:'未决定'}[p.decision]}\n依据：${p.reason}\n验收：${p.acceptance.map(c=>c.criterion+'（'+c.verification+'）').join('\n')}`:'无';
    $('planningComparisonBody').innerHTML=`<p>与上一版（${esc(labels[result.parentStatus]||result.parentStatus)}）比较。按唯一角色名称和标题对应，无法明确对应的内容展示为新增 / 移除；不会自动决定取舍。生成预览后会包含本次人工输入。</p>`+
      (result.scope.before!==result.scope.after?`<p>范围变更：${esc(result.scope.before)} → ${esc(result.scope.after)}</p>`:'')+
      (result.idea.before!==result.idea.after?`<p>需求变更：${esc(result.idea.before)} → ${esc(result.idea.after)}</p>`:'')+
      result.changes.map(c=>`<article class="planning-proposal"><h4>${esc({ADDED:'新增',REMOVED:'移除',CHANGED:'修改'}[c.kind])} · ${esc((c.after||c.before).title)}</h4><div class="planning-diff"><div><b>上一版</b><pre class="planning-plan">${esc(detail(c.before))}</pre></div><div><b>本版</b><pre class="planning-plan">${esc(detail(c.after))}</pre></div></div></article>`).join('')+
      (!result.changes.length?'<p>提案、取舍和验收条件没有变化。</p>':'')+
      `<details><summary>业务答复对比</summary><pre class="planning-plan">上一版：${esc(JSON.stringify(result.answers.before,null,2))}\n本版：${esc(JSON.stringify(result.answers.after,null,2))}</pre></details>`;
  }
  const provider=m=>capabilities?.providers.find(p=>p.id===m.provider);
  function saveTeam(){try{localStorage.setItem('studio_planning_team',JSON.stringify(team));}catch{}}
  function buttons(){
    for(const id of ['planningStart','planningPreview','planningRefine'])$(id).disabled=busy||working||!capabilities;
    $('planningAdd').disabled=busy||working||!capabilities||team.length>=6;
    $('planningApprove').disabled=busy||working||!preview||record?.status!=='READY'||!!draftState.get(record?.id)?.conflict;
    $('planningRetry').hidden=!['FAILED','STOPPED','INTERRUPTED'].includes(record?.status);$('planningRetry').disabled=busy||working;
    $('planningLaunch').disabled=busy||working||record?.status!=='APPROVED';
    $('planningHistory').disabled=working;
    for(const field of $('planningMembers').querySelectorAll('fieldset'))field.disabled=busy||working;
    for(const field of $('planningDecision').querySelectorAll('fieldset, textarea'))field.disabled=working;
    draftStatus();
  }
  function renderTeam(){
    $('planningMembers').replaceChildren();
    team.forEach((m,i)=>{
      const card=document.createElement('fieldset');card.className='audit-reviewer-card';
      card.innerHTML=`<legend>成员 ${i+1}${i===0?' · 兼任工程调查员':''}</legend>
        <label for="plannerName${i}">角色名称</label><input id="plannerName${i}" data-field="name" value="${esc(m.name)}">
        <label for="plannerProvider${i}">Agent 引擎</label><select id="plannerProvider${i}"></select>
        <label for="plannerPreset${i}">模型预设</label><select id="plannerPreset${i}"></select>
        <label for="plannerModel${i}">模型 ID（可手动输入）</label><input id="plannerModel${i}" data-field="model" value="${esc(m.model)}" placeholder="留空使用 CLI 默认模型">
        <label for="plannerEffort${i}">思考强度</label><select id="plannerEffort${i}" data-field="reasoningEffort"></select>
        <label for="plannerPrompt${i}">角色提示词</label><textarea id="plannerPrompt${i}" data-field="prompt" rows="3">${esc(m.prompt)}</textarea>
        <button class="btn btn-sm btn-secondary planner-remove" ${team.length<=2?'disabled':''}>移除成员</button>`;
      $('planningMembers').appendChild(card);
      const engine=$(`plannerProvider${i}`),preset=$(`plannerPreset${i}`),effort=$(`plannerEffort${i}`);
      capabilities.providers.forEach(p=>engine.add(new Option(p.name,p.id)));engine.value=m.provider;
      preset.add(new Option('CLI 默认 / 手动输入',''));(provider(m)?.models||[]).forEach(p=>preset.add(new Option(p.name,p.id)));
      const efforts=()=>{const model=provider(m)?.models.find(p=>p.id===m.model);preset.value=model?m.model:'';
        effort.replaceChildren(new Option('CLI / 模型默认',''));for(const e of model?.efforts||[])effort.add(new Option(e.label,e.value));
        if(!model?.efforts.some(e=>e.value===m.reasoningEffort))m.reasoningEffort='';effort.value=m.reasoningEffort;effort.disabled=!model?.efforts.length;};efforts();
      card.oninput=event=>{const key=event.target.dataset.field;if(key){m[key]=event.target.value;if(key==='model')efforts();saveTeam();}};
      engine.onchange=()=>{m.provider=engine.value;m.model='';m.reasoningEffort='';saveTeam();renderTeam();};
      preset.onchange=()=>{m.model=preset.value;$(`plannerModel${i}`).value=m.model;efforts();saveTeam();};
      effort.onchange=()=>{m.reasoningEffort=effort.value;saveTeam();};
      card.querySelector('.planner-remove').onclick=()=>{team.splice(i,1);saveTeam();renderTeam();};
    });buttons();
  }
  function initialDecision(r){return {selections:r.members.flatMap(m=>(m.proposal?.proposals||[]).map(p=>({proposalId:p.id,decision:'',reason:'',acceptance:p.acceptance.map(c=>({...c}))}))),answers:r.questions.map(q=>({questionId:q.id,answer:''}))};}
  function draft(){if(!drafts.has(record.id))drafts.set(record.id,initialDecision(record));return drafts.get(record.id);}
  function invalidatePreview(){preview=null;$('planningApproval').hidden=true;comparisonHtml(null);buttons();}
  function renderChoices(){
    const d=draft();$('planningChoices').innerHTML=d.selections.map(s=>{
      const p=record.members.flatMap(m=>m.proposal.proposals).find(p=>p.id===s.proposalId);
      return `<fieldset class="planning-choice" data-proposal="${esc(p.id)}"><legend>${esc(p.id)} · ${esc(p.title)}</legend>
        <label>本次取舍<select data-key="decision"><option value="">请选择</option><option value="ADOPT" ${s.decision==='ADOPT'?'selected':''}>采纳</option><option value="DEFER" ${s.decision==='DEFER'?'selected':''}>暂缓</option></select></label>
        <label>判断依据<textarea data-key="reason" rows="2">${esc(s.reason)}</textarea></label>
        <div class="planning-criteria" ${s.decision==='DEFER'?'hidden':''}>${s.acceptance.map((c,i)=>`<div class="planning-criterion" data-index="${i}"><label>验收条件 ${i+1}<textarea data-key="criterion" rows="2">${esc(c.criterion)}</textarea></label><label>验证方法<textarea data-key="verification" rows="2">${esc(c.verification)}</textarea></label><button class="btn btn-sm btn-secondary" data-remove="${i}" ${s.acceptance.length<=1?'disabled':''}>删除条件</button></div>`).join('')}<button class="btn btn-secondary btn-sm" data-add="true" ${s.acceptance.length>=10?'disabled':''}>增加验收条件</button></div></fieldset>`;
    }).join('');
    $('planningQuestions').innerHTML=record.questions.map(q=>`<label class="planning-question">${esc(q.question)}<textarea rows="2" data-question="${esc(q.id)}">${esc(d.answers.find(a=>a.questionId===q.id)?.answer)}</textarea></label>`).join('');
  }
  function render(){
    for(const id of ['planningDecision','planningApproval','planningRefinement'])$(id).hidden=true;
    preview=null;$('planningReport').replaceChildren();comparisonHtml(null);
    if(!record){$('planningStatus').textContent='尚未发起讨论。';$('planningBudgetBox')?.replaceChildren();buttons();return;}
    $('planningStatus').textContent=`${labels[record.status]||record.status} · ${phases[record.phase]||record.phase} · ${Number(!!record.investigation)+record.members.filter(m=>m.proposal).length+record.members.filter(m=>m.challenge).length}/${1+2*record.members.length} 个步骤通过 · 共 ${record.calls.length} 次尝试${record.error?'\n'+(errors[record.error]||record.error):''}`;
    if ($('planningBudgetBox') && window.ExecutionBudgetUI) {
      $('planningBudgetBox').innerHTML =
        window.ExecutionBudgetUI.renderBudgetPauseBanner(record, 'planning', () => refresh()) +
        window.ExecutionBudgetUI.renderBudgetSummaryHtml(record) +
        window.ExecutionBudgetUI.renderCallAttemptsHtml(record.callLedger?.calls);
    }
    const inv=record.investigation,all=record.members.flatMap(m=>m.proposal?.proposals||[]);
    $('planningReport').innerHTML=`<p>需求：${esc(record.idea)}</p><p>范围：${esc(record.scope)}</p>
      <details><summary>本次团队与模型配置</summary>${record.members.map(m=>`<p>${esc(m.name)} · ${esc(m.provider)} / ${esc(m.model||'CLI 默认模型')} / ${esc(m.reasoningEffort||'默认思考强度')}<br>${esc(m.prompt)}</p>`).join('')}</details>
      ${inv?`<article class="planning-proposal"><h4>工程调查</h4><p>${esc(inv.summary)}</p>${inv.observations.map(o=>`<p><b>${esc(o.file)}</b>：${esc(o.evidence)}</p>`).join('')}<p>约束：${esc(inv.constraints.join('；'))}</p></article>`:''}
      ${all.map(p=>`<article class="planning-proposal"><h4>${esc(p.id)} ${esc(p.title)} · ${esc(p.author)}</h4><p>做法：${esc(p.approach)}</p><p>收益：${esc(p.benefits)}</p><p>风险：${esc(p.risks)}</p><p>不包含：${esc(p.outOfScope.join('；')||'未列出')}</p>${record.members.flatMap(m=>(m.challenge?.reviews||[]).filter(r=>r.proposalId===p.id).map(r=>`<blockquote>${esc(m.name)} · ${esc({SUPPORT:'支持',CONCERN:'有异议',NEEDS_INFO:'需要补充信息'}[r.position])}：${esc(r.reason)}</blockquote>`)).join('')}</article>`).join('')}
      <details><summary>调用进度与原始回答</summary>${record.calls.map(c=>`<p>${esc(record.members.find(m=>m.id===c.memberId)?.name)} · ${esc(c.role)} · ${esc({COMPLETED:'回答已验证',INVALID_RESPONSE:'回答格式 / 内容不合规',TIMED_OUT:'调用超时',FAILED:'调用失败',STOPPED:'已停止',INTERRUPTED:'中断',RUNNING:'进行中'}[c.status]||c.status)} ${c.error?esc(c.error):''} ${c.responseArtifact||c.status==='COMPLETED'?`<a target="_blank" rel="noopener" href="/api/planning/${esc(record.id)}/artifacts?name=${encodeURIComponent(c.responseArtifact||c.id+'.response.txt')}">原始回答</a>`:''}</p>`).join('')}</details>`;
    if(record.status==='READY'){$('planningDecision').hidden=false;renderChoices();draftStatus();}
    comparisonHtml(null);if(record.parentId){const id=record.id;request(`/api/planning/${id}/compare`).then(result=>{if(record?.id===id&&!preview)comparisonHtml(result);}).catch(()=>{});}
    $('planningApprovalTitle').textContent=record.status==='APPROVED'?'已批准并锁定的方案':'即将批准的完整方案';
    if(record.status==='APPROVED'){$('planningApproval').hidden=false;$('planningPreviewText').textContent=record.decision.finalPlan;}
    $('planningApprove').hidden=record.status==='APPROVED';$('planningLaunch').hidden=record.status!=='APPROVED';
    $('planningRefinement').hidden=['CREATED','RUNNING'].includes(record.status);buttons();
  }
  async function refresh(){
    const target=ws();if(refreshing&&target===workspace)return;
    if(target!==workspace){workspace=target;selection='';record=null;stamp='';preview=null;$('planningHistory').replaceChildren(new Option('暂无讨论',''));render();}
    if(!target)return;
    refreshing=true;const seq=++sequence;
    try{const records=await request('/api/planning?workspace='+encodeURIComponent(target));if(seq!==sequence||target!==ws())return;
      if(!records.some(r=>r.id===selection))selection=records[0]?.id||'';
      $('planningHistory').replaceChildren(new Option('暂无讨论',''));if(records.length)$('planningHistory').replaceChildren();
      records.forEach(r=>$('planningHistory').add(new Option(`${r.feature} · ${labels[r.status]||r.status} · ${new Date(r.createdAt).toLocaleString()}`,r.id)));$('planningHistory').value=selection;
      const next=records.find(r=>r.id===selection)||null,key=next?next.id+next.updatedAt:'';
      if(next?.status==='READY')await loadDraft(next);if(seq!==sequence||target!==ws())return;record=next;
      if(key!==stamp){stamp=key;render();}
    }catch(error){if(seq===sequence){stamp='';$('planningStatus').textContent='读取讨论失败：'+error.message;}}
    finally{if(seq===sequence)refreshing=false;}
  }
  async function act(task){if(working||busy)return;working=true;buttons();try{await task();}catch(error){
    if(error.code==='DRAFT_VERSION_CONFLICT'&&record?.status==='READY'){const state=draftState.get(record.id);if(state){state.conflict=true;invalidatePreview();try{state.remote=await request(`/api/planning/${record.id}/draft`);}catch{}draftStatus();}}
    showToast(error.message,'error');}finally{working=false;buttons();}}
  async function start(refine=false){return act(async()=>{
    if(!capabilities)throw new Error('模型配置尚未加载');
    const target=ws(),parent=refine?record:null;
    if(!target||(!parent&&!$('vaguePrompt').value.trim()))throw new Error('请填写工程路径和初步想法。');
    if(refine&&!$('planningFeedback').value.trim())throw new Error('请填写补充意见。');
    const budget = window.ExecutionBudgetUI ? window.ExecutionBudgetUI.getBudgetConfig() : null;
    const result=await request('/api/planning',{workspaceRoot:target,idea:parent?.idea||$('vaguePrompt').value,feature:parent?.feature||$('featureName').value||'需求优化方案',scope:$('auditScope').value,members:team,timeoutSeconds:Number($('timeoutSeconds').value),...(parent?{parentId:parent.id,feedback:$('planningFeedback').value}:{}), ...(budget ? { budget } : {})});
    if(target!==ws())return;workspace=target;selection=result.discussionId;stamp='';$('planningFeedback').value='';updateRunningState(true,true);switchTab('discussion');await refresh();
  });}
  window.planningApp={start,refresh,setBusy:value=>{busy=value;buttons();}};
  document.addEventListener('DOMContentLoaded',async()=>{
    $('planningRetry').onclick=()=>act(async()=>{await request(`/api/planning/${record.id}/retry`,{workspaceRoot:ws(),version:record.version});updateRunningState(true,true);stamp='';await refresh();});
    $('planningSaveDraft').onclick=()=>act(()=>flushDraft(record));
    $('planningUseRemote').onclick=()=>act(async()=>{const state=draftState.get(record.id);if(!state.remote)return;drafts.set(record.id,state.remote.value||initialDecision(record));state.revision=state.remote.revision;state.conflict=false;state.dirty=false;state.error='';backup(record);invalidatePreview();renderChoices();draftStatus();});
    $('planningUseLocal').onclick=()=>act(async()=>{const state=draftState.get(record.id);if(!state.remote)return;state.revision=state.remote.revision;state.conflict=false;state.dirty=true;invalidatePreview();await flushDraft(record);draftStatus();});
    $('planningStart').onclick=()=>start();$('planningRefresh').onclick=refresh;
    $('planningHistory').onchange=()=>{selection=$('planningHistory').value;stamp='';refresh();};
    $('planningAdd').onclick=()=>{if(team.length>=6)return;team.push({name:`角色 ${team.length+1}`,provider:'codex',model:'',reasoningEffort:'',prompt:'',scope:''});saveTeam();renderTeam();};
    const editChoice=event=>{const key=event.target.dataset.key;if(!key||!record)return;const row=event.target.closest('[data-proposal]'),s=draft().selections.find(x=>x.proposalId===row.dataset.proposal);
      if(key==='criterion'||key==='verification')s.acceptance[Number(event.target.closest('[data-index]').dataset.index)][key]=event.target.value;else s[key]=event.target.value;
      invalidatePreview();changedDraft();if(key==='decision')row.querySelector('.planning-criteria').hidden=s.decision==='DEFER';};
    $('planningChoices').oninput=editChoice;$('planningChoices').onchange=editChoice;
    $('planningChoices').onclick=event=>{const button=event.target.closest('button');if(!button||!record)return;const s=draft().selections.find(x=>x.proposalId===button.closest('[data-proposal]').dataset.proposal);
      if(button.dataset.add&&s.acceptance.length<10)s.acceptance.push({criterion:'',verification:''});else if(button.dataset.remove!==undefined&&s.acceptance.length>1)s.acceptance.splice(Number(button.dataset.remove),1);else return;invalidatePreview();changedDraft();renderChoices();};
    $('planningQuestions').oninput=event=>{const id=event.target.dataset.question;if(id){draft().answers.find(a=>a.questionId===id).answer=event.target.value;invalidatePreview();changedDraft();}};
    const input=()=>({workspaceRoot:ws(),version:record.version,draftRevision:draftState.get(record.id)?.revision||0,...draft()});
    $('planningPreview').onclick=()=>act(async()=>{await flushDraft(record);const id=record.id,body=input(),key=JSON.stringify(body);const result=await request(`/api/planning/${id}/preview`,body);comparisonHtml(result.comparison);
      if(record?.id!==id||key!==JSON.stringify(input()))throw new Error('决策已变化，请重新生成预览。');preview={...result,inputKey:key};$('planningPreviewText').textContent=result.finalPlan;$('planningApproval').hidden=false;$('planningApprove').hidden=false;$('planningLaunch').hidden=true;});
    $('planningApprove').onclick=()=>act(async()=>{if(!preview||preview.inputKey!==JSON.stringify(input()))throw new Error('请先生成当前取舍的预览。');
      await request(`/api/planning/${record.id}/approve`,{...input(),previewHash:preview.previewHash});stamp='';await refresh();showToast('已批准并锁定方案，尚未实施。','success');});
    $('planningLaunch').onclick=()=>act(async()=>{const id=record?.id,plan=await request('/api/plans/'+record.planId);if(record?.id!==id||plan.workspaceRoot.toLowerCase()!==ws().toLowerCase())throw new Error('工程已切换，请重新选择讨论记录。');
      await startLoop({mode:'plan',planId:plan.id,approvalId:plan.approval.id,taskPrompt:plan.finalPlan,scope:record.scope,feature:record.feature});});
    $('planningRefine').onclick=()=>start(true);
    try{capabilities=await request('/api/audit-capabilities');let saved;try{saved=JSON.parse(localStorage.getItem('studio_planning_team'));}catch{}
      team=Array.isArray(saved)&&saved.length>=2?saved.slice(0,6).map(m=>({...m,provider:capabilities.providers.some(p=>p.id===m.provider)?m.provider:'codex'})):
        [{name:'架构与实现',provider:'codex',model:'',reasoningEffort:'',prompt:'先核对真实实现与限制，提出边界明确、改动适度的方案。',scope:''},{name:'质量与验收',provider:'claude',model:'',reasoningEffort:'',prompt:'关注业务遗漏、失败路径、方案代价和可验证的验收条件。保留分歧。',scope:''}];
      $('planningHint').textContent='2–6 位成员，最多 3 位并行。第一位先调查工程，随后独立提案、互相质询；存在分歧时由你拍板。可补充意见再开一版讨论。Mock 仅演示流程。';renderTeam();await refresh();
    }catch(error){$('planningHint').textContent='加载失败：'+error.message;buttons();}
  });
})();
