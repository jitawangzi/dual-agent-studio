/**
 * @file decisions.js
 * @author shuyongqiang
 * @description Frontend controller for Version 2.13 Dispute Workbench and Human Decisions.
 */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const esc = val => escapeHtml(String(val ?? ''));

  const STATUS_LABELS = {
    OPEN: '待处理 (OPEN)',
    ANALYZING: '正在仲裁 (ANALYZING)',
    AWAITING_HUMAN: '待人工决策 (AWAITING_HUMAN)',
    DECIDED: '已决策 (DECIDED)',
    NEEDS_REVIEW: '证据变动需重新确认 (NEEDS_REVIEW)'
  };

  const ACTION_LABELS = {
    CONFIRM: '确认缺陷 (CONFIRM -> CONFIRMED)',
    ACCEPT_SUGGESTION: '采纳建议 (ACCEPT_SUGGESTION -> ACCEPTED)',
    DEFER: '暂缓处理 (DEFER -> DEFERRED)',
    DISMISS: '忽略误报 (DISMISS -> DISMISSED)',
    VERIFY_MORE: '补充验证 (VERIFY_MORE)',
    REPLAN: '重做需求讨论 (REPLAN)'
  };

  let cases = [];
  let selectedCase = null;
  let currentWorkspace = '';
  let pendingCreateData = null;

  function getWorkspace() {
    return ($('workspaceRoot')?.value || '').trim();
  }

  async function request(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function renderList() {
    const container = $('decisionCaseList');
    if (!container) return;

    if (!cases.length) {
      container.innerHTML = '<p class="audit-help" style="padding: 12px;">暂无争议决策事项。可从审核发现或问题台账中发起。</p>';
      return;
    }

    container.innerHTML = cases.map(c => {
      const isSelected = selectedCase?.id === c.id;
      const statusClass = c.status === 'DECIDED' ? 'badge-success' :
                          c.status === 'NEEDS_REVIEW' ? 'badge-danger' :
                          c.status === 'AWAITING_HUMAN' ? 'badge-warning' : 'badge-info';
      return `
        <div class="decision-case-card ${isSelected ? 'selected' : ''}" onclick="window.decisionsApp.selectCase('${esc(c.id)}')">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${esc(c.title)}</strong>
            <span class="status-pill ${statusClass}">${esc(STATUS_LABELS[c.status] || c.status)}</span>
          </div>
          <p style="margin:4px 0; font-size:12px; color:var(--text-secondary);">${esc(c.question)}</p>
          <div style="display:flex; gap:8px; align-items:center; font-size:11px; margin-top:4px;">
            <span>引用证据: ${c.references?.length || 0}项</span>
            ${c.stale ? '<span class="status-pill badge-danger">证据失效</span>' : ''}
            ${c.hasUnappliedDecision ? '<span class="status-pill badge-warning">已决策，待应用</span>' : ''}
            <span style="margin-left:auto; color:var(--text-muted);">${new Date(c.updatedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDetail() {
    const container = $('decisionCaseDetail');
    if (!container) return;

    if (!selectedCase) {
      container.innerHTML = '<p class="audit-help" style="padding: 24px; text-align: center;">请从左侧选择一个争议决策事项进行审阅与决策。</p>';
      return;
    }

    const c = selectedCase;
    const isStale = c.stale;
    const isDecided = c.status === 'DECIDED';

    let html = `
      <div class="decision-detail-header">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <h3 style="margin: 0 0 6px 0;">${esc(c.title)}</h3>
            <span class="status-pill ${c.status === 'DECIDED' ? 'badge-success' : c.status === 'NEEDS_REVIEW' ? 'badge-danger' : 'badge-warning'}">
              ${esc(STATUS_LABELS[c.status] || c.status)}
            </span>
            ${c.hasUnappliedDecision ? '<span class="status-pill badge-warning" style="margin-left: 6px;">已决策，待应用</span>' : ''}
            ${isStale ? '<span class="status-pill badge-danger" style="margin-left: 6px;">证据已变动，需重新确认</span>' : ''}
          </div>
          <button class="btn btn-sm btn-secondary" onclick="window.decisionsApp.refreshCurrent()">🔄 刷新</button>
        </div>
        <div class="decision-question-callout" style="margin-top: 12px; padding: 12px; background: rgba(59, 130, 246, 0.08); border-left: 4px solid var(--accent-blue); border-radius: 4px;">
          <strong>争议核心问题：</strong>
          <p style="margin: 4px 0 0 0;">${esc(c.question)}</p>
        </div>
      </div>
    `;

    // Anchor finding under dispute
    if (c.anchor) {
      const af = c.anchor.finding || c.anchor.snapshot?.findingSnapshot;
      html += `
        <div class="panel-section" style="margin-top: 16px;">
          <h4>🎯 目标锚定审核项 (Anchor Finding)</h4>
          <div class="audit-finding" style="margin-top: 8px;">
            <p><strong>${esc(af?.category)} · ${esc(af?.severity)} · ${esc(af?.problem)}</strong></p>
            <p><code>${esc(af?.file)}:${esc(af?.lineRange)}</code></p>
            <p>证据摘要: ${esc(af?.evidence)}</p>
            <p>当前分诊状态: ${esc(af?.triage?.status || 'UNREVIEWED')} ${c.anchor.stale ? '<strong style="color:red;">(锚定版本已冲突/失效)</strong>' : ''}</p>
          </div>
        </div>
      `;
    }

    // Referenced evidence side-by-side
    html += `
      <div class="panel-section" style="margin-top: 16px;">
        <h4>📚 关联观点与证据引用 (${c.references?.length || 0})</h4>
        <p class="modal-tip">并排展示各观点的证据、局限和来源；严格禁止以“多数意见 = 正确”自动判定。</p>
        <div class="decision-comparison-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 8px;">
          ${(c.references || []).map((ref, idx) => {
            const snap = ref.currentSnapshot || ref.snapshot;
            return `
              <div class="decision-ref-card" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px;">
                  <span class="status-pill badge-info">[Ref ${idx}] ${esc(ref.kind)}</span>
                  ${ref.stale ? '<span class="status-pill badge-danger">已失效</span>' : '<span style="color:#10b981;">有效证据</span>'}
                </div>
                <p style="font-weight: bold; margin: 4px 0;">${esc(snap?.problem || snap?.name || snap?.text || ref.itemId)}</p>
                <div style="font-size: 12px; color: var(--text-secondary); max-height: 120px; overflow-y: auto;">
                  ${snap?.evidence ? `<p>证据: ${esc(snap.evidence)}</p>` : ''}
                  ${snap?.checklist ? `<p>清单: ${esc(snap.checklist.join(', '))}</p>` : ''}
                  ${snap?.reportSummary ? `<p>总结: ${esc(snap.reportSummary)}</p>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    // Single-shot arbitration section
    html += `
      <div class="panel-section" style="margin-top: 16px;">
        <h4>🤖 可选单次独立仲裁 (Single-shot Arbitration)</h4>
    `;

    if (c.analysis) {
      const an = c.analysis;
      html += `
        <div class="arbitration-result-box" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; padding: 14px; margin-top: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong>仲裁建议分析 (由 ${esc(an.reviewer?.provider || 'Arbiter')} 提供)</strong>
            <span style="font-size: 11px; color: var(--text-muted);">${new Date(an.analyzedAt).toLocaleString()}</span>
          </div>
          ${an.stale ? '<div class="alert alert-danger" style="margin: 8px 0; padding: 8px;">⚠️ 证据在分析前后发生变化，该分析已被标记失效，仅作历史参考。</div>' : ''}
          <p style="margin: 8px 0; font-size: 13px;">${esc(an.summary)}</p>

          <h5 style="margin: 12px 0 6px 0;">观点对比 (Positions)</h5>
          <div style="display: grid; gap: 8px;">
            ${(an.positions || []).map(p => `
              <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 4px; font-size: 12px;">
                <strong>[Ref ${p.referenceIndex}] 观点:</strong> ${esc(p.claim)}<br>
                <strong>支持证据:</strong> ${esc(p.support)}<br>
                <span style="color: var(--text-muted);">局限与边界: ${esc(p.limitations)}</span>
              </div>
            `).join('')}
          </div>

          <h5 style="margin: 12px 0 6px 0;">建议可选动作 (Options)</h5>
          <div style="display: grid; gap: 8px;">
            ${(an.options || []).map(opt => `
              <div style="border-left: 3px solid #3b82f6; padding: 8px; background: rgba(59, 130, 246, 0.05); border-radius: 0 4px 4px 0; font-size: 12px;">
                <strong>${esc(opt.id)} [${esc(opt.action)}]:</strong> ${esc(opt.reason)}<br>
                <span style="color: #f59e0b;">剩余风险: ${esc(opt.risks)}</span>
              </div>
            `).join('')}
          </div>

          ${(an.questions || []).length ? `
            <h5 style="margin: 12px 0 6px 0;">业务澄清提问 (Questions)</h5>
            <ul style="margin: 0; padding-left: 20px; font-size: 12px;">
              ${an.questions.map(q => `<li><strong>${esc(q.id)}:</strong> ${esc(q.text)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      `;
    }

    // Controls to launch arbitration
    html += `
      <div style="margin-top: 12px; display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
        <div class="form-group" style="margin: 0; min-width: 160px;">
          <label style="font-size: 11px;">仲裁 Provider</label>
          <select id="arbiterProvider" class="form-control" style="font-size: 12px;">
            <option value="mock" selected>Mock (仅验证流程)</option>
            <option value="claude">Claude Code</option>
            <option value="copilot">GitHub Copilot</option>
            <option value="codex">Codex CLI</option>
          </select>
        </div>
        <button id="btnRunArbitration" class="btn btn-sm btn-secondary" onclick="window.decisionsApp.analyzeCurrentCase()">
          🤖 发起单次仲裁
        </button>
        <span style="font-size: 11px; color: var(--text-muted); align-self: center;">单次调用，受预算与运行租约管理；仲裁建议不自动修改源码或分诊。</span>
      </div>
    </div>
    `;

    // Human decision section
    html += `
      <div class="panel-section" style="margin-top: 16px;">
        <h4>⚖️ 人工决策与分诊应用 (Human Decision)</h4>
        <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; padding: 14px; margin-top: 8px;">
    `;

    // Questions form if questions were posed
    if (c.analysis?.questions?.length) {
      html += `
        <div style="margin-bottom: 12px;">
          <h5 style="margin: 0 0 6px 0;">业务问答确认 (必答)</h5>
          ${c.analysis.questions.map(q => `
            <div class="form-group" style="margin-bottom: 8px;">
              <label style="font-size: 12px;">${esc(q.id)}: ${esc(q.text)}</label>
              <input type="text" id="ans-${esc(q.id)}" class="form-control" placeholder="输入业务回答..." style="font-size: 12px;">
            </div>
          `).join('')}
        </div>
      `;
    }

    // Action selector
    const anchorCat = c.anchor?.snapshot?.findingSnapshot?.category;
    html += `
      <div class="form-group" style="margin-bottom: 12px;">
        <label style="font-size: 12px; font-weight: bold;">决策动作 (Action)</label>
        <select id="decisionAction" class="form-control" style="font-size: 12px;">
          ${c.anchor ? (
            ['BUG', 'RISK'].includes(anchorCat) ? '<option value="CONFIRM">确认缺陷 (CONFIRM -> CONFIRMED)</option>' :
            anchorCat === 'SUGGESTION' ? '<option value="ACCEPT_SUGGESTION">采纳建议 (ACCEPT_SUGGESTION -> ACCEPTED)</option>' : ''
          ) : ''}
          <option value="DEFER">暂缓处理 (DEFER -> DEFERRED)</option>
          <option value="DISMISS">忽略误报 (DISMISS -> DISMISSED)</option>
          <option value="VERIFY_MORE">补充验证 (VERIFY_MORE)</option>
          <option value="REPLAN">重做需求讨论 (REPLAN)</option>
        </select>
      </div>
      <div class="form-group" style="margin-bottom: 12px;">
        <label style="font-size: 12px; font-weight: bold;">决策理由 / 依据 (Note, 必填)</label>
        <textarea id="decisionNote" class="form-control" rows="3" placeholder="详细记录人工判断的业务与技术理由（非空）..." style="font-size: 12px;"></textarea>
      </div>
      <div style="display: flex; gap: 10px;">
        <button id="btnSaveDecision" class="btn btn-sm btn-primary" onclick="window.decisionsApp.saveDecision()">
          💾 保存人工决定
        </button>
      </div>
    `;

    // Application section
    if (c.decisions?.length && c.anchor) {
      const latestDecision = c.decisions[c.decisions.length - 1];
      const canApplyTriage = ['CONFIRM', 'ACCEPT_SUGGESTION', 'DEFER', 'DISMISS'].includes(latestDecision.action);

      html += `
        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--border-color);">
          <h5>分诊显式应用</h5>
      `;

      if (latestDecision.applied) {
        html += `
          <div class="alert alert-success" style="padding: 8px; font-size: 12px;">
            ✅ 最新决定已成功应用到原审核项分诊 (Application ID: <code>${esc(latestDecision.applicationId)}</code>)。
          </div>
        `;
      } else if (canApplyTriage) {
        html += `
          <div class="alert alert-warning" style="padding: 8px; font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
            <span>⚠️ <strong>已决策，待应用</strong>：当前人工决定尚未应用到原审核项分诊中。</span>
            <button class="btn btn-sm btn-primary" onclick="window.decisionsApp.applyCurrentDecision('${esc(latestDecision.id)}')">
              ⚡ 显式应用到审核分诊
            </button>
          </div>
        `;
      } else {
        html += `
          <div class="alert alert-info" style="padding: 8px; font-size: 12px;">
            ℹ️ 当前决定动作为 <strong>${esc(latestDecision.action)}</strong>，属于过程指引（需在目标入口启动验证或讨论），无需亦不自动修改审核分诊。
          </div>
        `;
      }

      html += `</div>`;
    }

    // Decision history
    if (c.decisions?.length) {
      html += `
        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-color);">
          <h5>人工决策追加历史 (${c.decisions.length})</h5>
          <div style="display: grid; gap: 8px; margin-top: 8px;">
            ${[...c.decisions].reverse().map(d => `
              <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; font-size: 12px;">
                <div style="display: flex; justify-content: space-between;">
                  <strong>${esc(ACTION_LABELS[d.action] || d.action)}</strong>
                  <span style="color: var(--text-muted);">${new Date(d.decidedAt).toLocaleString()}</span>
                </div>
                <p style="margin: 4px 0;">理由: ${esc(d.note)}</p>
                ${d.answers?.length ? `<p style="margin: 4px 0; color: var(--text-secondary);">问答: ${esc(d.answers.map(a => `${a.id}=${a.text}`).join('; '))}</p>` : ''}
                <div style="font-size: 11px;">
                  ${d.applied ? `<span style="color: #10b981;">已应用 (ID: ${esc(d.applicationId)})</span>` : '<span style="color: #f59e0b;">未应用</span>'}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  async function refresh() {
    const ws = getWorkspace();
    if (!ws) {
      cases = [];
      selectedCase = null;
      renderList();
      renderDetail();
      return;
    }

    try {
      const data = await request(`/api/decision-cases?workspace=${encodeURIComponent(ws)}`);
      cases = Array.isArray(data) ? data : [];
      if (selectedCase) {
        const found = cases.find(c => c.id === selectedCase.id);
        if (found) selectedCase = found;
        else selectedCase = cases[0] || null;
      } else {
        selectedCase = cases[0] || null;
      }
      renderList();
      renderDetail();
    } catch (err) {
      showToast('获取争议决策列表失败: ' + err.message, 'error');
    }
  }

  async function selectCase(id) {
    try {
      const data = await request(`/api/decision-cases/${id}`);
      selectedCase = data;
      renderList();
      renderDetail();
    } catch (err) {
      showToast('获取争议决策详情失败: ' + err.message, 'error');
    }
  }

  async function analyzeCurrentCase() {
    if (!selectedCase) return;
    const ws = getWorkspace();
    const btn = $('btnRunArbitration');
    if (btn) btn.disabled = true;

    try {
      const provider = $('arbiterProvider')?.value || 'mock';
      const result = await request(`/api/decision-cases/${selectedCase.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceRoot: ws,
          version: selectedCase.version,
          reviewer: { provider }
        })
      });
      selectedCase = result;
      showToast('单次仲裁分析完成。', 'success');
      renderList();
      renderDetail();
    } catch (err) {
      showToast('仲裁分析失败: ' + err.message, 'error');
      await refresh();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveDecision() {
    if (!selectedCase) return;
    const ws = getWorkspace();
    const action = $('decisionAction')?.value;
    const note = $('decisionNote')?.value;

    if (!note || !note.trim()) {
      showToast('决策理由为必填项。', 'warning');
      return;
    }

    const answers = [];
    if (selectedCase.analysis?.questions?.length) {
      for (const q of selectedCase.analysis.questions) {
        const input = $(`ans-${q.id}`);
        const text = input ? input.value.trim() : '';
        if (!text) {
          showToast(`请回答业务问题: ${q.id}`, 'warning');
          return;
        }
        answers.push({ id: q.id, text });
      }
    }

    try {
      const result = await request(`/api/decision-cases/${selectedCase.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceRoot: ws,
          version: selectedCase.version,
          action,
          note: note.trim(),
          answers
        })
      });
      selectedCase = result;
      showToast('人工决定已记录。', 'success');
      renderList();
      renderDetail();
    } catch (err) {
      showToast('记录人工决定失败: ' + err.message, 'error');
      await refresh();
    }
  }

  async function applyCurrentDecision(decisionId) {
    if (!selectedCase) return;
    const ws = getWorkspace();

    try {
      const result = await request(`/api/decision-cases/${selectedCase.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceRoot: ws,
          decisionId,
          version: selectedCase.version
        })
      });
      selectedCase = result;
      showToast('决策已成功应用到审核分诊！', 'success');
      renderList();
      renderDetail();
      window.auditApp?.refresh();
      window.issueLedgerApp?.refresh();
    } catch (err) {
      showToast('应用决策分诊失败: ' + err.message, 'error');
      await refresh();
    }
  }

  function openCreateModal(initialData = {}) {
    pendingCreateData = initialData;
    const modal = $('createDecisionModal');
    if (!modal) return;

    $('decisionCreateTitle').value = initialData.title || '';
    $('decisionCreateQuestion').value = initialData.question || '';

    const anchorBox = $('decisionCreateAnchorInfo');
    if (initialData.anchor) {
      anchorBox.style.display = 'block';
      $('decisionCreateAnchorSummary').textContent =
        `锚定项: ${initialData.anchor.findingId} (Audit: ${initialData.anchor.auditId.slice(0, 8)})`;
    } else {
      anchorBox.style.display = 'none';
    }

    const refBox = $('decisionCreateReferencesList');
    if (initialData.references?.length) {
      refBox.innerHTML = initialData.references.map(r => `
        <div style="font-size: 12px; margin-bottom: 4px;">
          🏷️ <strong>${esc(r.kind)}</strong>: ${esc(r.recordId.slice(0, 8))}#${esc(r.itemId)}
        </div>
      `).join('');
    } else {
      refBox.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">无预选证据</span>';
    }

    modal.style.display = 'flex';
  }

  function closeCreateModal() {
    const modal = $('createDecisionModal');
    if (modal) modal.style.display = 'none';
    pendingCreateData = null;
  }

  async function submitCreateCase() {
    const ws = getWorkspace();
    const title = $('decisionCreateTitle').value.trim();
    const question = $('decisionCreateQuestion').value.trim();

    if (!title) {
      showToast('请输入决策事项标题。', 'warning');
      return;
    }
    if (!question) {
      showToast('请输入争议核心业务问题。', 'warning');
      return;
    }

    const payload = {
      workspaceRoot: ws,
      title,
      question,
      anchor: pendingCreateData?.anchor || null,
      references: pendingCreateData?.references || []
    };

    try {
      const created = await request('/api/decision-cases', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      closeCreateModal();
      showToast('争议决策事项创建成功。', 'success');
      await refresh();
      selectedCase = created;
      renderDetail();
      switchTab('decisions');
    } catch (err) {
      showToast('创建决策事项失败: ' + err.message, 'error');
    }
  }

  async function openFromFinding(auditId, findingId) {
    try {
      const audit = await request(`/api/audits/${auditId}`);
      const f = audit.findings?.find(x => x.id === findingId);
      if (!f) throw new Error('未找到对应审核发现');

      openCreateModal({
        title: `关于 ${f.problem} 的争议决策`,
        question: `针对 ${f.file}:${f.lineRange} 的发现是否确认为真实缺陷？`,
        anchor: {
          auditId,
          findingId,
          evidenceKey: f.evidenceKey,
          triageVersion: f.triageVersion || 0,
          verificationKey: f.verificationKey || ''
        },
        references: [
          { kind: 'AUDIT_FINDING', recordId: auditId, itemId: findingId }
        ]
      });
    } catch (err) {
      showToast('读取审核项失败: ' + err.message, 'error');
    }
  }

  async function openFromIssue(issueId) {
    openCreateModal({
      title: `针对问题 ${issueId} 的决策事项`,
      question: `针对该问题的争议如何处置？`,
      anchor: null,
      references: []
    });
  }

  window.decisionsApp = {
    refresh,
    refreshCurrent: () => selectedCase ? selectCase(selectedCase.id) : refresh(),
    selectCase,
    analyzeCurrentCase,
    saveDecision,
    applyCurrentDecision,
    openCreateModal,
    closeCreateModal,
    submitCreateCase,
    openFromFinding,
    openFromIssue
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('btnNewDecisionCase')?.addEventListener('click', () => openCreateModal());
    $('btnSubmitCreateCase')?.addEventListener('click', submitCreateCase);
    $('btnCancelCreateCase')?.addEventListener('click', closeCreateModal);
  });
})();
