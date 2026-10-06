'use strict';
globalThis.reviewEvidenceUI = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function link(kind,id,name,label) {
    return name ? `<a target="_blank" rel="noopener" href="/api/${kind==='audits'?'audits':'runs'}/${encodeURIComponent(id)}/artifacts?name=${encodeURIComponent(name)}">${esc(label)}</a>` : '';
  }
  function refs(items,kind,id) {
    if (!items?.length) return '<p class="audit-help">未提供结构化证据；文字结论不代表已执行测试。</p>';
    return items.map(r => r.kind==='TEST'
      ? `<div class="audit-source"><strong>Studio 执行记录 · 退出码 ${esc(r.exitCode)}</strong> ${link(kind,id,r.artifact,'测试原始输出')}<pre>${esc(r.quote)}</pre><p>${esc(r.explanation)}</p><small>源码版本：${esc(r.snapshot)}</small></div>`
      : `<div class="audit-source"><strong>源码依据（Agent 声明，未自动验证内容）</strong><p>${esc(r.file)}:${esc(r.startLine)}–${esc(r.endLine)}</p><p>${esc(r.explanation)}</p><small>源码版本：${esc(r.snapshot)}</small></div>`).join('');
  }
  function coverage(report) {
    const rows=report?.coverageDetails;
    const legacy=(report?.coverage||[]).map(esc).join('；');
    if (!rows?.length) return `<p class="audit-help">未提供结构化覆盖范围。${legacy ? '原始范围声明：'+legacy : '尚无范围报告。'}</p>`;
    return `<p class="audit-help">以下是 Agent 自报的检查范围，不代表整个工程的覆盖率；未列出的模块仍属未知。</p><table class="issues-table"><thead><tr><th>检查对象</th><th>状态</th><th>检查内容与限制</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.target)}</td><td>${esc({CHECKED:'已检查',UNCHECKED:'未检查',DISPUTED:'存在争议'}[r.status])}</td><td>${esc(r.checks)}<br>限制：${esc(r.limitations)}</td></tr>`).join('')}</tbody></table>`;
  }
  return {refs,coverage,link};
})();
