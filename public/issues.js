'use strict';
(() => {
  const $=id=>document.getElementById(id),esc=value=>escapeHtml(String(value??''));
  const labels={OPEN:'待处理',CONFIRMED:'已确认',ACCEPTED:'已采纳',NEEDS_CLARIFICATION:'待业务确认',DISMISSED:'历史误报 / 不采纳',DEFERRED:'暂缓',AWAITING_VERIFICATION:'等待复核',VERIFIED_CLOSED:'复核关闭',REOPENED:'再次出现',DISPUTED:'存在争议',STALE:'历史证据已失效'};
  let records=[],workspace='',sequence=0,signature='',summary='';
  function render(){
    const query=$('issueSearch').value.trim().toLowerCase(),state=$('issueState').value;
    const shown=records.filter(r=>(!query||[r.id,r.file,r.problem].join(' ').toLowerCase().includes(query))&&
      (!state||(state==='changed'?r.needsReview:state==='REOPENED'?r.reopened||r.status==='REOPENED':state==='pending'?!['VERIFIED_CLOSED','DISMISSED','DEFERRED','STALE'].includes(r.status):r.status===state)));
    summary=`显示 ${shown.length} / ${records.length} 项历史问题。状态对应保存的证据，不代表当前源码已实时复查。`;
    $('issueSummary').textContent=summary;
    $('projectIssues').innerHTML=shown.map(r=>`<article class="audit-finding"><h4>${esc(r.problem)}</h4>
      <p><code>${esc(r.id)}</code> · ${esc(labels[r.status]||r.status)}${r.reopened&&r.status!=='REOPENED'?' · 再次出现':''} · ${esc(r.severity)} · ${esc(r.file)}</p>
      <p>在 ${esc(r.occurrenceCount)} 次审核中出现${r.occurrenceCount>1?'（重复发现）':'（首次记录）'}${r.needsReview?'；证据或源码版本变化，请重新确认':''}。</p>
      ${r.lastReview?`<p>最近复核：${esc(r.lastReview.evidence)}</p>`:''}
      ${r.decisions[0]?`<p>最近人工记录：${esc(labels[r.decisions[0].status]||r.decisions[0].status)} · ${esc(r.decisions[0].note)}（历史依据，不自动批准新审核）</p>`:''}
      <details><summary>来源审核与修复记录</summary>${r.occurrences.map(o=>`<p>${esc(o.at)} · ${esc(o.auditStatus)} <button class="btn btn-sm btn-secondary" data-issue-audit="${esc(o.auditId)}">查看审核</button><br>${esc(o.evidence)}</p>`).join('')}
      ${r.repairRuns.map(x=>`<p>${esc(x.bugId)} · ${esc(x.status)} <button class="btn btn-sm btn-secondary" data-issue-run="${esc(x.runId)}">查看修复</button></p>`).join('')}</details>
      <details><summary>完整证据与人工判断历史</summary><pre>${esc(JSON.stringify({history:r.history,decisions:r.decisions},null,2))}</pre></details></article>`).join('')||'<p>没有符合条件的历史问题。</p>';
  }
  async function refresh(){
    const ws=$('workspaceRoot').value.trim(),current=++sequence;
    if(ws!==workspace){workspace=ws;records=[];signature='';render();}
    if(!ws){$('issueSummary').textContent='请选择工作区。';return;}
    try{
      const response=await fetch('/api/issues?workspace='+encodeURIComponent(ws)),data=await response.json();
      if(current!==sequence||ws!==$('workspaceRoot').value.trim())return;
      if(!response.ok)throw new Error(data.error||'读取失败');
      const next=JSON.stringify(data);if(next!==signature){signature=next;records=data;render();}else $('issueSummary').textContent=summary;
    }catch(error){if(current===sequence)$('issueSummary').textContent='读取项目问题台账失败：'+error.message;}
  }
  window.issueLedgerApp={refresh};
  document.addEventListener('DOMContentLoaded',()=>{
    $('btnRefreshIssues').onclick=refresh;$('issueSearch').oninput=render;$('issueState').onchange=render;
    $('projectIssues').onclick=async event=>{
      if(workspace!==$('workspaceRoot').value.trim())return;
      const audit=event.target.dataset.issueAudit,run=event.target.dataset.issueRun;
      if(audit)await window.auditApp.openAudit(audit);
      if(run){await selectRun(run);switchTab('timeline');}
    };
    refresh();
  });
})();
