'use strict';
// Audit UI owns its drafts and selection. Existing development settings are read only on repair.
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => escapeHtml(String(value ?? ''));
  const prefsKey = 'studio_parallel_audit';
  const labels = {CREATED:'准备中',QUEUED:'排队中',RUNNING:'审核中',COMPLETED:'审核完成',PARTIAL:'部分完成',FAILED:'失败',STOPPED:'已停止',INTERRUPTED:'中断',INVALIDATED:'报告已失效'};
  const categories = {BUG:'缺陷',RISK:'实现隐患',SUGGESTION:'优化建议',QUESTION:'待确认问题'};
  const triageLabels={UNREVIEWED:'待验证',CONFIRMED:'确认问题',ACCEPTED:'采纳建议',NEEDS_CLARIFICATION:'待业务确认',DISMISSED:'误报 / 不采纳',DEFERRED:'暂缓'};
  const verificationLabels={NOT_VERIFIED:'尚未验证',REPRODUCED:'已复现（Agent 判断）',SUPPORTED_BY_CODE:'源码证据支持',NOT_REPRODUCED:'本次未复现，不代表误报或已修复',INSUFFICIENT_EVIDENCE:'证据不足',NEEDS_CLARIFICATION:'待业务确认',STALE:'证据已过期'};
  const verificationRunLabels={...labels,COMPLETED:'验证完成',RUNNING:'正在验证',QUEUED:'等待验证',NOT_REQUESTED:'未执行'};
  const verificationError=value=>({VERIFICATION_EVIDENCE_CONFLICT:'审核证据已更新，请刷新后重新选择。',INVALID_VERIFICATION_SELECTION:'每次请选择 1–20 项不同的发现。',REPRODUCTION_REQUIRES_ACKNOWLEDGEMENT:'请确认执行你填写的复现命令。',VERIFICATION_EXECUTION_EVIDENCE_REQUIRED:'验证回答缺少可核对的真实执行证据，本次结论未被采纳。',VERIFICATION_CATEGORY_MISMATCH:'该类别不适用运行复现结论，本次结论未被采纳。',INVALID_VERIFICATION_REPORT:'验证回答格式不完整，请查看原始回答后重试。',EXECUTION_TIMEOUT:'执行超时，本次验证未完成。',RUN_CANCELLED:'验证已停止。'}[value]||value);
  let verifier={name:'独立验证员',provider:'claude',model:'',reasoningEffort:'',prompt:'',scope:''},verifyChosen=new Set();
  const triageDrafts=new Map();
  const filterIds=['findingSearch','findingCategoryFilter','findingSeverityFilter','findingTriageFilter','findingVerificationFilter'];
  let templates=[],templateWorkspace=null,checking=false;
  let capabilities = null, drafts = [], busy = false, starting = false, selectedId = '', record = null;
  let supplementChosen=new Set(),supplementStamp='';
  let workspace = '', requestSequence = 0, renderedVersion = '', chosen = new Set();
  const getWorkspace = () => $('workspaceRoot').value.trim();
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok){
      const messages={TEMPLATE_VERSION_CONFLICT:'模板已被其他页面修改，请刷新后重新选择。',TRIAGE_VERSION_CONFLICT:'报告证据或分诊已更新，请刷新报告后重新判断。',SUPPLEMENT_VERSION_CONFLICT:'审核结果已变化，请刷新并重新选择缺口。',INVALID_SUPPLEMENT_SELECTION:'请选择 1–20 个仍未完成的缺口。',INVALID_AUDIT_CHECKLIST:'必查项每人最多 20 条，每条不超过 2000 字，不能重复。',AUDIT_SOURCE_CHANGED:'源码已变化，请重新发起审核。',TRIAGE_REASON_REQUIRED:'请填写判断依据或复现记录。',FINDING_REQUIRES_TRIAGE:'请先确认问题或采纳建议，并保存分诊。',INVALID_TEMPLATE_NAME:'请填写不超过 100 字的模板名称。',RUN_CANCELLED:'检查已停止。',WORKFLOW_BUSY:'已有任务运行中，请等待完成或先停止。'};
      throw new Error(messages[data.error]||verificationError(data.error)||'请求失败');
    }
    return data;
  }
  function draftConfig(){return {commonPrompt:$('auditCommonPrompt').value.trim(),scope:$('auditScope').value.trim(),
    concurrency:Number($('auditConcurrency').value),timeoutSeconds:Number($('timeoutSeconds').value),reviewers:drafts};}
  async function refreshTemplates(){
    const ws=getWorkspace(),selected=$('auditTemplate').value;
    const items=await request('/api/audit-templates'+(ws?'?workspace='+encodeURIComponent(ws):''));
    if(ws!==getWorkspace())return;
    templates=items;templateWorkspace=ws;$('auditTemplate').replaceChildren(new Option('选择模板',''));
    for(const t of templates)$('auditTemplate').add(new Option(`${t.name} · ${t.scope==='global'?'所有项目':'当前项目'} · v${t.version}`,t.id));
    $('auditTemplate').value=items.some(t=>t.id===selected)?selected:'';
  }
  function selectedTemplate(){const template=templateWorkspace===getWorkspace()&&templates.find(t=>t.id===$('auditTemplate').value);if(!template)throw new Error('请先选择当前工作区的模板');return template;}
  async function templateAction(action){
    if(starting||busy)return;
    starting=true;updateButtons();
    try{
      const selected=action==='create'?null:selectedTemplate();
      if(action==='apply'){
        const c=selected.config;drafts=c.reviewers.map(r=>({...r}));
        $('auditCommonPrompt').value=c.commonPrompt;$('auditScope').value=c.scope;$('auditConcurrency').value=c.concurrency;$('timeoutSeconds').value=c.timeoutSeconds;
        $('auditTemplateName').value=selected.name;$('auditTemplateScope').value=selected.scope;
        saveDrafts();if(typeof saveUserPreferences==='function')saveUserPreferences();renderEditors();$('auditAgentHealth').textContent='模板已应用，启动前将重新检查环境。';
      }else if(action==='delete'){
        await request('/api/audit-templates/delete',{id:selected.id,version:selected.version,workspaceRoot:getWorkspace()});await refreshTemplates();
      }else{
        const saved=await request('/api/audit-templates',{id:selected?.id,version:selected?.version,name:$('auditTemplateName').value,
          scope:selected?.scope||$('auditTemplateScope').value,workspaceRoot:getWorkspace(),config:draftConfig()});
        await refreshTemplates();$('auditTemplate').value=saved.id;
      }
      showToast(action==='apply'?'模板配置已填入，尚未执行。':'模板已保存或删除。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  function healthText(data){
    const codes={MOCK_ONLY:'Mock 流程测试，不代表模型可用',LOCAL_CHECK_PASSED:'本机检查通过',CLI_MISSING:'未找到 CLI，请安装并重新启动 Studio',CLI_INCOMPATIBLE:'CLI 缺少所需参数，请升级',CLI_CHECK_FAILED:'CLI 检查失败或超时'};
    const probes={PASSED:'真实连通成功',FAILED:'真实调用失败，请检查 CLI 登录、额度和模型权限',TIMEOUT:'连通超时',CLI_UPGRADE_REQUIRED:'当前模型要求更新版本的 CLI，请升级后重试',AUTH_REQUIRED:'认证失败，请在对应 CLI 中登录后重试',QUOTA_OR_RATE_LIMIT:'额度或请求频率受限，请检查账户后重试',MODEL_UNAVAILABLE:'模型或思考强度不可用，请检查所选配置',UNEXPECTED_RESPONSE:'回答未满足连通测试要求',SKIPPED:'未执行连通测试',MOCK_ONLY:'未调用真实模型'};
    return data.results.map(r=>`${r.name} · ${r.provider} ${r.version||''} · ${r.model||'默认模型'} / ${r.reasoningEffort||'默认强度'}：${codes[r.code]||r.code}${r.probe?'；'+probes[r.probe]:''}${r.auth==='CONFIGURED'?'；已有登录配置（不代表额度可用）':r.auth==='UNKNOWN'?'；登录状态未确认':''}`).join('\n');
  }
  async function checkAgents(mode){
    if(busy||starting||checking)return;checking=true;starting=true;updateButtons();
    const captured=JSON.stringify(drafts);$('auditAgentHealth').textContent=mode==='probe'?'正在检查环境并测试所选模型…':'正在检查 CLI 安装、版本和参数…';
    try{
      const result=await request('/api/agent-health',{mode,reviewers:drafts});
      $('auditAgentHealth').textContent=healthText(result)+(captured!==JSON.stringify(drafts)?'\n配置已变更，以上是变更前配置的结果。':'');
    }catch(error){$('auditAgentHealth').textContent='检查未完成：'+error.message;}
    finally{checking=false;starting=false;updateButtons();}
  }
  function saveDrafts() {
    try { localStorage.setItem(prefsKey,JSON.stringify({reviewers:drafts,verifier,commonPrompt:$('auditCommonPrompt').value,concurrency:$('auditConcurrency').value})); } catch {}
  }
  function renderVerifier(){
    const provider=$('findingVerifierProvider');provider.replaceChildren();for(const p of capabilities.providers)provider.add(new Option(p.name,p.id));provider.value=verifier.provider;
    const models=providerFor(verifier)?.models||[],preset=$('findingVerifierPreset');preset.replaceChildren(new Option('CLI 默认 / 手动输入',''));
    for(const m of models)preset.add(new Option(m.name,m.id));preset.value=models.some(m=>m.id===verifier.model)?verifier.model:'';
    $('findingVerifierModel').value=verifier.model;$('findingVerifierPrompt').value=verifier.prompt;
    const efforts=models.find(m=>m.id===verifier.model)?.efforts||[],effort=$('findingVerifierEffort');
    if(!efforts.some(e=>e.value===verifier.reasoningEffort))verifier.reasoningEffort='';
    effort.replaceChildren(new Option('CLI / 模型默认',''));for(const e of efforts)effort.add(new Option(e.label,e.value));effort.value=verifier.reasoningEffort;effort.disabled=!efforts.length;
  }
  function verificationStatus(f){const v=f.verification;return !v?'NOT_VERIFIED':v.stale?'STALE':v.status==='COMPLETED'?v.report.verdict:v.status;}
  function visibleFindings(){
    const [search,category,severity,triage,verification]=filterIds.map(id=>$(id).value.trim());
    return (record?.findings||[]).filter(f=>(!category||f.category===category)&&(!severity||f.severity===severity)&&
      (!triage||(f.triage?.status||'UNREVIEWED')===triage)&&(!verification||verificationStatus(f)===verification)&&
      (!search||[f.file,f.problem,f.evidence,f.acceptance,...f.sources.map(s=>s.evidence)].join('\n').toLowerCase().includes(search.toLowerCase())));
  }
  function draftTriage(f){const draft=triageDrafts.get(f.id);return draft?.evidenceKey===f.evidenceKey&&draft?.verificationKey===(f.verificationKey||'')?draft:f.triage;}
  function artifactLink(name,label){return name&&record?`<a target="_blank" rel="noopener" href="/api/audits/${escape(record.id)}/artifacts?name=${encodeURIComponent(name)}">${escape(label)}</a>`:'';}
  function verificationHtml(f){
    const v=f.verification;if(!v)return '<p class="audit-help">独立验证：尚未验证。可选择验证后再分诊。</p>';
    const label=verificationLabels[verificationStatus(f)]||verificationRunLabels[v.status]||v.status,r=v.report;
    return `<div class="audit-verification"><h4>独立验证：${escape(label)}</h4>
      <p>${escape(v.verifier.name)} · ${escape(v.verifier.provider)} / ${escape(v.verifier.model||'默认模型')} / ${escape(v.verifier.reasoningEffort||'默认强度')}</p>
      <p class="audit-help">验证时间：${escape(v.finishedAt||v.createdAt)}。结论对应这次审核的源码版本，修复后需重新审核。</p>
      ${v.stale?'<p class="audit-warning">源码或审核证据已变化，以下结论只供历史参考。</p>':''}
      <p>${escape(verificationError(v.error)||r?.summary||'等待验证结果')}</p>
      ${r?`<p>判断证据：${escape(r.evidence)}</p><p>预期：${escape(r.expected)}\n实际：${escape(r.actual)}</p><p>验证步骤：\n${escape(r.steps.join('\n'))}</p><p>局限：${escape(r.limitations)}</p>`:''}
      <details><summary>命令输出与原始回答</summary><p>复现命令：${escape(v.reproduction.command||'未执行，仅源码检查')}</p>
      <p>执行状态：${escape(v.reproduction.status==='COMPLETED'?'命令执行结束':verificationRunLabels[v.reproduction.status]||v.reproduction.status)}${v.reproduction.code!==null?' · 退出码 '+escape(v.reproduction.code):''}</p>
      <pre>${escape(v.reproduction.stdout||'')}${escape(v.reproduction.stderr||'')}</pre>
      ${v.reproduction.truncated?'<p>输出摘要已截断，请查看完整日志。</p>':''}
      ${artifactLink(v.reproduction.artifact,'完整命令日志')} ${artifactLink(v.promptArtifact,'验证输入')} ${artifactLink(v.responseArtifact,'Agent 原始回答')}</details>
      <details><summary>验证历史（${f.verificationHistory?.length||0}）</summary>${(f.verificationHistory||[]).map(h=>`<p>${escape(h.finishedAt||h.createdAt)} · ${escape(h.stale?'已过期':labels[h.status]||h.status)} · ${escape(verificationLabels[h.report?.verdict]||'')}<br>${escape(h.error||h.report?.summary||'')} ${artifactLink(h.responseArtifact,'原始回答')}</p>`).join('')}</details></div>`;
  }
  function providerFor(draft) { return capabilities.providers.find(p=>p.id===draft.provider); }
  function modelFor(draft) { return providerFor(draft)?.models.find(m=>m.id===draft.model); }
  function updateEfforts(index) {
    const draft=drafts[index], model=modelFor(draft), select=$(`auditorEffort${index}`);
    const efforts=model?.efforts || [];
    if (draft.reasoningEffort && !efforts.some(e=>e.value===draft.reasoningEffort)) draft.reasoningEffort='';
    select.replaceChildren(new Option('CLI / 模型默认',''));
    for (const e of efforts) select.add(new Option(e.label,e.value));
    select.value=draft.reasoningEffort || ''; select.disabled=!efforts.length;
    $(`auditorEffortHint${index}`).textContent=efforts.length?'仅列出引擎与模型字典共同支持的档位。':'默认强度：未知模型或当前适配器没有可选档位。';
  }
  function renderEditors() {
    const container=$('auditReviewerEditors');container.replaceChildren();
    drafts.forEach((draft,index)=>{
      const card=document.createElement('fieldset');card.className='audit-reviewer-card';
      card.innerHTML=`<legend>审核员 ${index+1}</legend>
        <label for="auditorName${index}">名称 / 审核分工</label><input id="auditorName${index}" data-field="name" value="${escape(draft.name)}">
        <label for="auditorProvider${index}">Agent 引擎</label><select id="auditorProvider${index}" data-field="provider"></select>
        <label for="auditorPreset${index}">模型预设</label><select id="auditorPreset${index}"><option value="">默认 / 手动输入模型 ID</option></select>
        <label for="auditorModel${index}">模型 ID（可手动输入）</label><input id="auditorModel${index}" data-field="model" placeholder="留空使用 CLI 默认模型" value="${escape(draft.model)}">
        <label for="auditorEffort${index}">思考强度</label><select id="auditorEffort${index}" data-field="reasoningEffort"></select>
        <small id="auditorEffortHint${index}"></small>
        <label for="auditorPrompt${index}">个人审核提示词</label><textarea id="auditorPrompt${index}" data-field="prompt" rows="3">${escape(draft.prompt)}</textarea>
        <label for="auditorScope${index}">补充检查范围</label><input id="auditorScope${index}" data-field="scope" value="${escape(draft.scope)}" placeholder="留空继承公共范围">
        <label for="auditorChecklist${index}">必查清单（每行一项，最多 20 项；可留空）</label><textarea id="auditorChecklist${index}" data-field="checklist" rows="3" placeholder="例如：空输入与越界处理&#10;权限校验与错误返回">${escape((draft.checklist||[]).join('\n'))}</textarea>
        <button type="button" class="btn btn-sm btn-secondary audit-remove" ${drafts.length===1?'disabled':''}>移除此审核员</button>`;
      container.appendChild(card);
      const provider=$(`auditorProvider${index}`);
      for(const p of capabilities.providers)provider.add(new Option(p.name,p.id));provider.value=draft.provider;
      const preset=$(`auditorPreset${index}`);
      for(const model of providerFor(draft)?.models || [])preset.add(new Option(model.name,model.id));
      preset.value=modelFor(draft)?draft.model:'';
      updateEfforts(index);
      card.addEventListener('input',event=>{
        const field=event.target.dataset.field;if(!field)return;draft[field]=field==='checklist'?event.target.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):event.target.value;
        if(field==='model'){preset.value=modelFor(draft)?draft.model:'';updateEfforts(index);}saveDrafts();
      });
      provider.addEventListener('change',()=>{draft.provider=provider.value;draft.model='';draft.reasoningEffort='';saveDrafts();renderEditors();});
      preset.addEventListener('change',()=>{draft.model=preset.value;$(`auditorModel${index}`).value=draft.model;updateEfforts(index);saveDrafts();});
      card.querySelector('.audit-remove').addEventListener('click',()=>{drafts.splice(index,1);saveDrafts();renderEditors();});
    });
    $('btnAddAuditor').disabled=drafts.length>=capabilities.maxReviewers;
    updateButtons();
  }
  function updateButtons() {
    window.auditClosure?.setBusy(busy||starting);
    const supplementReady=record&&['COMPLETED','PARTIAL','FAILED','STOPPED','INTERRUPTED'].includes(record.status);
    $('btnSupplementAudit').disabled=busy||starting||!supplementReady||!supplementChosen.size;
    $('btnSupplementAudit').textContent=`补审选中缺口（${supplementChosen.size}）`;
    $('btnStartAudit').disabled=!capabilities || busy || starting;
    $('btnRetryAudit').disabled=busy||starting||!record||!['PARTIAL','FAILED','STOPPED','INTERRUPTED'].includes(record.status);
    const ready=record&&['COMPLETED','PARTIAL','STOPPED','INTERRUPTED'].includes(record.status);
    $('btnRepairAudit').disabled=busy||starting||!ready||!chosen.size||(record.status!=='COMPLETED'&&!$('auditAcceptPartial').checked);
    $('btnRepairAudit').textContent=`修复选中问题并独立复核（${chosen.size}）`;
    for(const id of ['btnCheckAgents','btnProbeAgents','btnApplyAuditTemplate','btnSaveAuditTemplate','btnUpdateAuditTemplate','btnDeleteAuditTemplate'])$(id).disabled=!capabilities||busy||starting;
    $('btnStopAgentCheck').disabled=!checking;
    const verificationRunning=(record?.verificationRuns||[]).some(r=>['QUEUED','RUNNING'].includes(r.status));
    $('btnVerifyFindings').disabled=busy||starting||!ready||!verifyChosen.size||(record.status!=='COMPLETED'&&!$('findingVerifyPartial').checked)||
      (!!$('findingReproductionCommand').value.trim()&&!$('findingExecuteReproduction').checked);
    $('btnVerifyFindings').textContent=`独立验证选中发现（${verifyChosen.size}）`;
    $('btnSelectFindingVerification').disabled=busy||starting||!ready;
    $('btnStopFindingVerification').disabled=!verificationRunning;
  }
  async function start() {
    if(busy||starting)return;
    starting=true;updateButtons();saveDrafts();if(typeof saveUserPreferences==='function')saveUserPreferences();
    try{
      const created=await request('/api/audits',{workspaceRoot:getWorkspace(),feature:$('featureName').value.trim()||'并行工程审核',
        commonPrompt:$('auditCommonPrompt').value.trim(),scope:$('auditScope').value.trim(),concurrency:Number($('auditConcurrency').value),
        timeoutSeconds:Number($('timeoutSeconds').value),reviewers:drafts});
      selectedId=created.auditId;chosen.clear();renderedVersion='';workspace=getWorkspace();
      updateRunningState(true);switchTab('audit');await refresh();showToast('并行审核已启动。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  function clearReport() {
    window.auditClosure?.clear();
    record=null;renderedVersion='';supplementChosen.clear();supplementStamp='';$('auditGaps').replaceChildren();$('auditRelated').replaceChildren();chosen.clear();verifyChosen.clear();triageDrafts.clear();$('auditAcceptPartial').checked=false;$('findingVerifyPartial').checked=false;
    $('findingVerificationProgress').textContent='';$('findingFilterSummary').textContent='';
    $('auditSummary').textContent='尚无审核报告。';
    for(const id of ['auditReviewerResults','auditFindings','auditArtifacts','auditRepairLinks'])$(id).replaceChildren();
    $('auditRepairBox').hidden=true;$('auditFindingCount').textContent='';updateButtons();
  }
  async function refresh(status) {
    if(!capabilities)return;
    window.issueLedgerApp?.refresh();
    const ws=getWorkspace(), sequence=++requestSequence;
    if(workspace!==ws){workspace=ws;selectedId='';clearReport();$('findingReproductionCommand').value='';$('findingExecuteReproduction').checked=false;updateButtons();}
    if(templateWorkspace!==ws)refreshTemplates().catch(error=>showToast(error.message,'error'));
    if(!ws){$('auditHistory').replaceChildren(new Option('请选择工作区',''));return;}
    try{
      const records=await request('/api/audits?workspace='+encodeURIComponent(ws));
      if(sequence!==requestSequence||ws!==getWorkspace())return;
      if(!records.some(r=>r.id===selectedId))selectedId=records[0]?.id||'';
      const history=$('auditHistory');history.replaceChildren();
      for(const item of records)history.add(new Option(`${item.feature} · ${labels[item.status]||item.status} · ${new Date(item.createdAt).toLocaleString()}`,item.id));
      if(!records.length){history.add(new Option('暂无审核',''));clearReport();return;}
      history.value=selectedId;
      const selected=records.find(r=>r.id===selectedId);
      if(selected)render(selected);
      if(status?.isCheckingAgents){$('statusText').textContent='Agent 环境 / 连通检查中';$('roundBadge').style.display='none';}
      else if(status?.activeAuditId){$('statusText').textContent=status.activeVerificationId?'独立验证中':'并行审核中';$('roundBadge').style.display='none';}
      else if(record && activeTab==='audit' && !busy){
        $('statusText').textContent=labels[record.status]||record.status;
        $('statusBadge').className='status-badge '+(record.status==='COMPLETED'?'approved':'waiting');
        $('roundBadge').style.display='none';
      }
    }catch(error){if(activeTab==='audit')$('auditSummary').textContent='读取审核记录失败：'+error.message;}
  }
  function render(next) {
    if(record?.id!==next.id){chosen.clear();verifyChosen.clear();triageDrafts.clear();$('auditAcceptPartial').checked=false;$('findingVerifyPartial').checked=false;$('findingExecuteReproduction').checked=false;}
    record=next;
    if(supplementStamp!==next.id+next.supplementVersion){supplementChosen.clear();supplementStamp=next.id+next.supplementVersion;}
    const visibleIds=new Set(visibleFindings().map(f=>f.id));
    chosen=new Set([...chosen].filter(id=>visibleIds.has(id)&&next.findings.some(f=>f.id===id && f.repairable)));
    verifyChosen=new Set([...verifyChosen].filter(id=>visibleIds.has(id)));
    updateButtons();
    const signature=next.id+next.updatedAt;if(signature===renderedVersion)return;renderedVersion=signature;
    window.auditClosure?.load(next.id);
    const completed=next.reviewers.filter(r=>r.status==='COMPLETED').length;
    $('auditSummary').textContent=`${labels[next.status]||next.status} · ${completed}/${next.reviewers.length} 位审核员完成 · ${next.findings.length} 项发现\n`+
      `${next.error || (next.status==='COMPLETED'?'审核范围已按各审核员报告完成，请根据证据判断问题。':'本次审核尚未完整结束，已有报告仅代表已完成的检查。')}\n公共范围：${next.scope}\n公共要求：${next.commonPrompt}`+
      (next.preflight?'\n启动环境检查：\n'+healthText(next.preflight):'');
    renderSupplement();
    $('auditReviewerResults').innerHTML=next.reviewers.map(r=>`<article class="audit-reviewer-card">
      <h4>${escape(r.name)} · ${escape(labels[r.status]||r.status)}</h4>
      <p>${escape(r.provider)} / ${escape(r.model||'CLI 默认模型')} / 思考：${escape(r.reasoningEffort||'默认')}</p>
      <p>${escape(r.error||r.report?.summary||'等待审核结果')}</p>
      ${(r.checklist||[]).length?`<h5>必查项 ${r.report?.taskChecks?.filter(c=>c.status==='CHECKED').length||0}/${r.checklist.length} 已检查</h5><ul>${r.checklist.map((task,i)=>{const c=r.report?.taskChecks?.find(c=>c.id===`C-${i+1}`);return `<li>${escape(task)} · ${escape({CHECKED:'已检查',UNCHECKED:'未检查',DISPUTED:'存在争议'}[c?.status]||'未返回结果')}<br>${escape(c?.evidence||'')}</li>`;}).join('')}</ul>`:''}
      ${reviewEvidenceUI.coverage(r.report)}
      ${artifactLink(r.responseArtifact,'本次原始回答')}
      ${r.report&&!r.report.scopeComplete?'<p class="audit-warning">检查范围未完整覆盖</p>':''}
      <details><summary>配置与独立报告</summary><p>提示词：${escape(r.prompt||'通用审核')}</p><p>范围：${escape(r.scope||next.scope)}</p>
      <pre>${escape(JSON.stringify(r.report || {status:r.status,error:r.error},null,2))}</pre></details></article>`).join('');
    $('auditFindingCount').textContent=`（${next.findings.length}）`;
    renderFindings();
    $('auditRepairBox').hidden=!next.findings.length;$('auditPartialLabel').hidden=next.status==='COMPLETED';
    $('findingVerifyPartialLabel').hidden=next.status==='COMPLETED';
    const verification=next.verificationRuns?.at(-1);
    $('findingVerificationProgress').textContent=verification?`最近验证：${verificationRunLabels[verification.status]||verification.status} · ${verification.items.filter(i=>i.status==='COMPLETED').length}/${verification.items.length} 项完成${verification.error?' · '+verification.error:''}${verification.preflight&&!verification.preflight.ok?'\n'+healthText(verification.preflight):''}`:'尚无独立验证记录。';
    $('auditRepairLinks').replaceChildren();
    for(const repair of next.repairRuns){const button=document.createElement('button');button.className='btn btn-sm btn-secondary';button.textContent='查看修复运行 '+repair.runId.slice(0,8);button.onclick=()=>openRun(repair.runId);$('auditRepairLinks').appendChild(button);}
    request('/api/audits/'+next.id+'/artifacts').then(names=>{
      if(record?.id!==next.id)return;$('auditArtifacts').replaceChildren();
      for(const name of names){const link=document.createElement('a');link.textContent=name;link.href='/api/audits/'+next.id+'/artifacts?name='+encodeURIComponent(name);link.target='_blank';link.rel='noopener';$('auditArtifacts').appendChild(link);}
    }).catch(()=>{});
    updateButtons();
  }
  function renderFindings(){
    if(!record)return;const next=record,visible=visibleFindings();
    $('findingFilterSummary').textContent=`显示 ${visible.length} / ${next.findings.length} 项。改变筛选会清空验证和修复勾选。`;
    const selectable=['COMPLETED','PARTIAL','STOPPED','INTERRUPTED'].includes(next.status);
    $('auditFindings').innerHTML=visible.length?visible.map(f=>`<article class="audit-finding">
      <label class="audit-select-verification"><input type="checkbox" data-verify-finding="${escape(f.id)}" ${verifyChosen.has(f.id)?'checked':''} ${!selectable?'disabled':''}>选择验证：${escape(f.problem)}</label>
      <label class="audit-finding-title"><input type="checkbox" data-finding="${escape(f.id)}" ${chosen.has(f.id)?'checked':''} ${!selectable||!f.repairable?'disabled':''}>
      <strong>${escape(categories[f.category])} · ${escape(f.severity)} · ${escape(f.problem)}</strong></label>
      <p><code>${escape(f.file)}:${escape(f.lineRange)}</code></p>
      <p>证据：${escape(f.evidence)}</p><p>验收条件：${escape(f.acceptance)}</p>
      ${reviewEvidenceUI.refs(f.evidenceRefs,"audits",next.id)}
      ${verificationHtml(f)}
      <div class="audit-triage">
        <p>当前分诊：${escape(triageLabels[f.triage?.status||'UNREVIEWED'])}${!f.triage&&f.triageVersion?'（审核或验证证据已更新，请重新判断）':''}</p>
        <label for="triageStatus-${escape(f.id)}">分诊结论</label>
        <select id="triageStatus-${escape(f.id)}" ${!selectable?'disabled':''}>${Object.entries(triageLabels).filter(([key])=>key!=='CONFIRMED'||['BUG','RISK'].includes(f.category)).filter(([key])=>key!=='ACCEPTED'||f.category==='SUGGESTION').map(([key,label])=>`<option value="${key}" ${key===(draftTriage(f)?.status||'UNREVIEWED')?'selected':''}>${label}</option>`).join('')}</select>
        <label for="triageNote-${escape(f.id)}">判断依据 / 复现记录</label><textarea id="triageNote-${escape(f.id)}" rows="2" maxlength="10000" ${!selectable?'disabled':''} placeholder="记录触发条件、实际结果或业务取舍；这是人工记录，不是系统已验证。">${escape(draftTriage(f)?.note||'')}</textarea>
        <button id="triageSave-${escape(f.id)}" data-triage="${escape(f.id)}" type="button" class="btn btn-sm btn-secondary" ${!selectable?'disabled':''}>保存分诊</button>
        <details><summary>分诊历史（${f.triageHistory?.length||0}）</summary><pre>${escape((f.triageHistory||[]).map(t=>`${t.at} · ${triageLabels[t.status]}\n${t.note}`).join('\n\n')||'尚无记录')}</pre></details>
      </div>
      <details><summary>全部来源与依据（${f.sources.length}）</summary>${f.sources.map(s=>`<div class="audit-source"><strong>${escape(s.reviewerName)} · ${escape(s.provider)} / ${escape(s.model||'默认')} · ${escape(s.severity)}</strong>
      <p>${escape(s.file)}:${escape(s.lineRange)}</p><p>${escape(s.evidence)}</p>${reviewEvidenceUI.refs(s.evidenceRefs,"audits",next.id)}<p>验收：${escape(s.acceptance)}</p><p>建议：${escape(s.fixSuggestion||'无')}</p></div>`).join('')}</details></article>`).join(''):'<p class="audit-help">没有符合当前筛选的发现。请结合审核状态和覆盖范围理解结果。</p>';
  }
  async function openRun(id) {selectedRunId=id;await refreshRuns();switchTab('timeline');}
  function renderSupplement(){
    const gaps=record?.gaps||[],selectable=record&&['COMPLETED','PARTIAL','FAILED','STOPPED','INTERRUPTED'].includes(record.status);
    $('auditGaps').innerHTML=gaps.length?gaps.map((g,i)=>`<label class="audit-source"><input type="checkbox" data-gap="${i}" ${supplementChosen.has(i)?'checked':''} ${!selectable?'disabled':''}>${escape(g.reviewerName)} · ${escape(g.task)} · ${g.status==='DISPUTED'?'存在争议':'未完成'}<br>${escape(g.reason)}</label>`).join(''):'<p>当前没有可选的补审缺口。未设置必查清单的旧报告仅按原范围声明判断。</p>';
    $('auditRelated').innerHTML=(record?.parentAudit?`<p class="audit-warning">本次为补审，仅检查选中缺口。原审核整体状态不自动改变。</p><button class="btn btn-secondary btn-sm" data-audit-link="${escape(record.parentAudit.id)}">查看原审核</button>`:'')+(record?.supplementRuns||[]).map((s,i)=>`<button class="btn btn-secondary btn-sm" data-audit-link="${escape(s.auditId)}">查看补审 ${i+1}</button>`).join('');
  }
  async function supplement(){
    if($('btnSupplementAudit').disabled||!record)return;starting=true;updateButtons();
    try{const result=await request('/api/audits/'+record.id+'/supplement',{workspaceRoot:getWorkspace(),version:record.supplementVersion,
      selections:[...supplementChosen].map(i=>({reviewerId:record.gaps[i].reviewerId,taskId:record.gaps[i].taskId}))});
      selectedId=result.auditId;supplementChosen.clear();renderedVersion='';updateRunningState(true);await refresh();showToast('补审已启动，原审核报告已保留。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  async function retry() {
    if(!record||busy||starting)return;starting=true;updateButtons();
    try{await request('/api/audits/'+record.id+'/retry',{});updateRunningState(true);await refresh();}
    catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  async function triage(id){
    if(!record||busy||starting)return;
    const finding=record.findings.find(f=>f.id===id);if(!finding)return;
    const auditId=record.id;starting=true;updateButtons();
    try{
      const updated=await request('/api/audits/'+auditId+'/triage',{findingId:id,version:draftTriage(finding)?.version??finding.triageVersion??0,evidenceKey:finding.evidenceKey,
        verificationKey:finding.verificationKey||'',
        status:$('triageStatus-'+id).value,note:$('triageNote-'+id).value});
      triageDrafts.delete(id);
      if(selectedId===auditId){renderedVersion='';render(updated);}showToast('分诊已保存。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  async function repair() {
    if($('btnRepairAudit').disabled)return;starting=true;updateButtons();
    try{
      const config={workspaceRoot:getWorkspace(),findingIds:[...chosen],acceptPartial:$('auditAcceptPartial').checked,
        devProvider:$('devProvider').value,reviewProvider:$('reviewProvider').value,
        devModel:$('devModelCustom').value.trim()||$('devModel').value,reviewModel:$('reviewModelCustom').value.trim()||$('reviewModel').value,
        devReasoningEffort:$('devReasoningEffort').value,reviewReasoningEffort:$('reviewReasoningEffort').value,
        verifyCommand:$('verifyCommand').value.trim(),maxRounds:Number($('maxRounds').value),
        cleanRoundsRequired:Number($('cleanRoundsRequired').value),maxSelfHealAttempts:Number($('maxSelfHealAttempts').value),timeoutSeconds:Number($('timeoutSeconds').value)};
      config.maxNoProgressRounds=Number($('maxNoProgressRounds').value)||3;
      const created=await request('/api/audits/'+record.id+'/repair',config);
      updateRunningState(true);await openRun(created.runId);showToast('已选问题已导入修复与独立复核流程。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  async function verifyFindings(){
    if($('btnVerifyFindings').disabled||!record)return;
    starting=true;updateButtons();saveDrafts();
    try{
      await request('/api/audits/'+record.id+'/verify',{workspaceRoot:getWorkspace(),verifier,
        findings:record.findings.filter(f=>verifyChosen.has(f.id)).map(f=>({id:f.id,evidenceKey:f.evidenceKey})),
        acceptPartial:$('findingVerifyPartial').checked,timeoutSeconds:Number($('timeoutSeconds').value),
        reproductionCommand:$('findingReproductionCommand').value.trim(),executeReproduction:$('findingExecuteReproduction').checked});
      verifyChosen.clear();updateRunningState(true);await refresh();showToast('独立验证已启动，结果不会自动替代你的分诊。','success');
    }catch(error){showToast(error.message,'error');}finally{starting=false;updateButtons();}
  }
  function filterChanged(){chosen.clear();verifyChosen.clear();renderFindings();updateButtons();}
  function rememberTriage(event){
    const id=(event.target.id||'').replace(/^triage(?:Status|Note)-/,'');
    const f=record?.findings.find(f=>f.id===id);if(!f)return;
    triageDrafts.set(id,{evidenceKey:f.evidenceKey,verificationKey:f.verificationKey||'',version:draftTriage(f)?.version??f.triageVersion??0,status:$('triageStatus-'+id).value,note:$('triageNote-'+id).value});
  }
  window.auditApp={start,refresh,openRun,openAudit:async id=>{selectedId=id;renderedVersion='';await refresh();switchTab('audit');},setBusy:value=>{busy=value;updateButtons();}};
  document.addEventListener('DOMContentLoaded',async()=>{
    $('btnStartAudit').onclick=start;$('btnRefreshAudits').onclick=()=>Promise.all([refresh(),refreshTemplates()]).catch(error=>showToast(error.message,'error'));$('btnRetryAudit').onclick=retry;$('btnRepairAudit').onclick=repair;
    $('btnSupplementAudit').onclick=supplement;
    $('auditGaps').onchange=event=>{if(busy||starting||event.target.dataset.gap===undefined)return;const index=Number(event.target.dataset.gap);if(!record?.gaps?.[index])return;
      if(event.target.checked&&supplementChosen.size>=20){event.target.checked=false;showToast('每次最多补审 20 项。','error');return;}
      if(event.target.checked)supplementChosen.add(index);else supplementChosen.delete(index);updateButtons();};
    $('auditRelated').onclick=event=>{const id=event.target.dataset.auditLink;if(id)window.auditApp.openAudit(id);};
    $('auditAcceptPartial').onchange=updateButtons;
    $('auditHistory').onchange=()=>{selectedId=$('auditHistory').value;renderedVersion='';chosen.clear();refresh();};
    $('auditFindings').onchange=event=>{
      rememberTriage(event);if(busy||starting)return;
      const verificationId=event.target.dataset.verifyFinding;
      if(verificationId&&visibleFindings().some(f=>f.id===verificationId)){
        if(event.target.checked&&verifyChosen.size>=20){event.target.checked=false;showToast('每次最多验证 20 项。','error');return;}
        if(event.target.checked)verifyChosen.add(verificationId);else verifyChosen.delete(verificationId);updateButtons();return;
      }
      const id=event.target.dataset.finding;if(!id||!visibleFindings().some(f=>f.id===id&&f.repairable))return;
      if(event.target.checked)chosen.add(id);else chosen.delete(id);updateButtons();
    };
    $('auditFindings').oninput=rememberTriage;
    $('auditFindings').onclick=event=>{const id=event.target.dataset.triage;if(id)return triage(id);};
    $('btnVerifyFindings').onclick=verifyFindings;
    $('btnSelectFindingVerification').onclick=()=>{if(busy||starting)return;verifyChosen=new Set(visibleFindings().slice(0,20).map(f=>f.id));renderFindings();updateButtons();};
    $('btnStopFindingVerification').onclick=()=>request('/api/stop',{}).then(()=>refresh()).catch(error=>showToast(error.message,'error'));
    $('findingVerifyPartial').onchange=updateButtons;$('findingExecuteReproduction').onchange=updateButtons;
    $('findingReproductionCommand').oninput=()=>{$('findingExecuteReproduction').checked=false;updateButtons();};
    for(const id of filterIds)$(id)[id==='findingSearch'?'oninput':'onchange']=filterChanged;
    $('btnResetFindingFilters').onclick=()=>{for(const id of filterIds)$(id).value='';filterChanged();};
    $('findingVerifierProvider').onchange=()=>{verifier.provider=$('findingVerifierProvider').value;verifier.model='';verifier.reasoningEffort='';renderVerifier();saveDrafts();};
    $('findingVerifierPreset').onchange=()=>{verifier.model=$('findingVerifierPreset').value;renderVerifier();saveDrafts();};
    $('findingVerifierModel').oninput=()=>{verifier.model=$('findingVerifierModel').value;renderVerifier();saveDrafts();};
    $('findingVerifierEffort').onchange=()=>{verifier.reasoningEffort=$('findingVerifierEffort').value;saveDrafts();};
    $('findingVerifierPrompt').oninput=()=>{verifier.prompt=$('findingVerifierPrompt').value;saveDrafts();};
    $('btnCheckAgents').onclick=()=>checkAgents('check');$('btnProbeAgents').onclick=()=>checkAgents('probe');
    $('btnStopAgentCheck').onclick=()=>request('/api/stop',{}).catch(error=>showToast(error.message,'error'));
    for(const [id,action] of Object.entries({btnApplyAuditTemplate:'apply',btnSaveAuditTemplate:'create',btnUpdateAuditTemplate:'update',btnDeleteAuditTemplate:'delete'}))$(id).onclick=()=>templateAction(action);
    $('auditTemplate').onchange=()=>{const t=templates.find(t=>t.id===$('auditTemplate').value);if(t){$('auditTemplateName').value=t.name;$('auditTemplateScope').value=t.scope;}};
    $('btnAddAuditor').onclick=()=>{if(drafts.length>=8)return;drafts.push({name:`审核员 ${drafts.length+1}`,provider:'codex',model:'',reasoningEffort:'',prompt:'',scope:''});saveDrafts();renderEditors();};
    $('auditCommonPrompt').oninput=saveDrafts;$('auditConcurrency').onchange=saveDrafts;
    try{
      capabilities=await request('/api/audit-capabilities');
      let saved;try{saved=JSON.parse(localStorage.getItem(prefsKey)||'null');}catch{}
      if(saved?.verifier&&capabilities.providers.some(p=>p.id===saved.verifier.provider)){
        for(const key of Object.keys(verifier))if(typeof saved.verifier[key]==='string')verifier[key]=saved.verifier[key];
      }
      if(saved&&Array.isArray(saved.reviewers)&&saved.reviewers.length){drafts=saved.reviewers.slice(0,8).map(r=>({...r,provider:capabilities.providers.some(p=>p.id===r.provider)?r.provider:'codex'}));
        if(typeof saved.commonPrompt==='string')$('auditCommonPrompt').value=saved.commonPrompt;if(saved.concurrency)$('auditConcurrency').value=saved.concurrency;
      }else drafts=[{name:'逻辑与边界',provider:'codex',model:'',reasoningEffort:'',prompt:'重点检查错误处理、边界条件和数据一致性。',scope:''},
        {name:'设计与实现',provider:'claude',model:'',reasoningEffort:'',prompt:'重点检查现有实现的设计约束、耦合和潜在性能问题。',scope:''}];
      $('auditConfigHint').textContent='可配置 1–8 位审核员，最多 4 位同时运行。未知模型使用默认思考强度；模型实际可用性由 CLI 校验。Mock 仅验证流程。';
      renderEditors();renderVerifier();await refresh();
    }catch(error){$('auditConfigHint').textContent='读取配置失败：'+error.message;}
  });
})();
