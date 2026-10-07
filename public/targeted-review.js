'use strict';
/**
 * Targeted Review UI Module (2.12 Task 4).
 *
 * Provides preview modal, scope inspection, validation acknowledgment,
 * and persistent banner for targeted audit reports.
 *
 * @author shuyongqiang
 */

(function () {
  let currentPlan = null;
  let currentAuditId = null;
  let currentWorkspaceRoot = null;

  function escape(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderTargetedBannerHtml(record) {
    if (!record || (!record.targetedPlan && record.parentAudit?.mode !== 'TARGETED')) {
      return '';
    }
    const plan = record.targetedPlan || {};
    const parent = record.parentAudit || {};
    const baseId = plan.baseAuditId || parent.id || '';
    const requiresFull = plan.requiresFullAudit || parent.requiresFullAudit;
    const taskCount = (plan.selectedTaskIds || []).length;
    const changedCount = (plan.changedFiles || []).length;
    const uncoveredCount = (plan.uncoveredScopes || []).length;

    return `
      <div class="audit-targeted-banner card" style="margin-bottom: 16px; padding: 12px 16px; border-left: 4px solid ${requiresFull ? '#f59e0b' : '#3b82f6'}; background: rgba(59, 130, 246, 0.05);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="badge" style="background: ${requiresFull ? '#f59e0b' : '#3b82f6'}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 4px;">
              🎯 定向复查（局部范围）
            </span>
            <strong style="font-size: 13px;">基准审核：${escape(baseId.slice(0, 8))}…</strong>
          </div>
          <span style="font-size: 12px; color: ${requiresFull ? '#f59e0b' : '#10b981'}; font-weight: 600;">
            ${requiresFull ? '⚠️ 存在全局改动，完整审核仍待完成' : '✅ 局部范围审查完成'}
          </span>
        </div>
        <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 6px 0;">
          本次复查仅针对 <strong>${taskCount}</strong> 项指定任务（共涉及 ${changedCount} 个变更文件${uncoveredCount ? `，未覆盖 ${uncoveredCount} 个范围` : ''}）。未检查的区域不代表通过。
          ${plan.note ? `<br><strong>复查说明：</strong>${escape(plan.note)}` : ''}
        </p>
        <details style="font-size: 12px; color: var(--text-muted);">
          <summary style="cursor: pointer; color: var(--accent); user-select: none;">查看定向复查清单与范围详情</summary>
          <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border);">
            ${plan.reasons && plan.reasons.length ? `
              <div style="margin-bottom: 8px;">
                <strong style="color: #f59e0b;">完整审核触发理由：</strong>
                <ul style="margin: 4px 0 0 16px; padding: 0;">
                  ${plan.reasons.map(r => `<li>${escape(r)}</li>`).join('')}
                </ul>
              </div>` : ''}
            ${plan.changedFiles && plan.changedFiles.length ? `
              <div style="margin-bottom: 6px;">
                <strong>变更文件列表：</strong>
                <code>${escape(plan.changedFiles.join(', '))}</code>
              </div>` : ''}
            ${uncoveredCount ? `
              <div style="margin-bottom: 6px; color: #ef4444;">
                <strong>未分配/未覆盖范围：</strong>
                <code>${escape(plan.uncoveredScopes.map(u => u.path || u).join(', '))}</code>
              </div>` : ''}
          </div>
        </details>
      </div>
    `;
  }

  async function openPreview(auditId, workspaceRoot) {
    currentAuditId = auditId;
    currentWorkspaceRoot = workspaceRoot;
    const modal = document.getElementById('targetedReviewModal');
    if (!modal) return;

    modal.style.display = 'flex';
    document.getElementById('targetedPreviewContent').innerHTML = `
      <div style="text-align: center; padding: 30px; color: var(--text-muted);">
        <p>正在分析工作区变更并生成定向复查计划…</p>
      </div>
    `;

    try {
      const res = await fetch(`/api/audits/${encodeURIComponent(auditId)}/targeted-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '生成定向计划失败');
      }
      currentPlan = data;
      renderPreviewModal();
    } catch (err) {
      document.getElementById('targetedPreviewContent').innerHTML = `
        <div style="padding: 20px; color: #ef4444; background: rgba(239, 68, 68, 0.1); border-radius: 6px;">
          <strong>生成计划出错：</strong> ${escape(err.message)}
        </div>
      `;
    }
  }

  function renderPreviewModal() {
    if (!currentPlan) return;
    const plan = currentPlan;
    const container = document.getElementById('targetedPreviewContent');

    const html = `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <!-- Header status -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--border);">
          <div>
            <strong style="font-size: 14px;">计划版本：<code>${escape(plan.version.slice(0, 12))}</code></strong>
            <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">(基准审核: ${escape((plan.baseAuditId || '').slice(0, 8))})</span>
          </div>
          <span class="badge" style="background: ${plan.requiresFullAudit ? '#f59e0b' : '#10b981'}; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px;">
            ${plan.requiresFullAudit ? '⚠️ 建议全量审核' : '✅ 适用定向复查'}
          </span>
        </div>

        <!-- Changed Files Section -->
        <div>
          <h4 style="font-size: 13px; margin-bottom: 6px;">📁 检测到 ${plan.changedFiles.length} 个变更文件</h4>
          <div style="max-height: 100px; overflow-y: auto; background: var(--bg-input); padding: 8px 12px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px;">
            ${plan.changedFiles.length ? plan.changedFiles.map(f => `<div style="padding: 2px 0;">• ${escape(f)}</div>`).join('') : '<div style="color: var(--text-muted);">（无变更文件，仅复核未关闭问题）</div>'}
          </div>
        </div>

        <!-- Warning / Reasons for full audit -->
        ${plan.requiresFullAudit ? `
          <div style="padding: 10px 14px; background: rgba(245, 158, 11, 0.1); border: 1px solid #f59e0b; border-radius: 6px;">
            <strong style="color: #f59e0b; font-size: 13px;">⚠️ 触发全量审核规则说明：</strong>
            <ul style="margin: 4px 0 0 16px; font-size: 12px; color: var(--text-main);">
              ${plan.reasons.map(r => `<li>${escape(r)}</li>`).join('')}
            </ul>
            <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(245, 158, 11, 0.4);">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; cursor: pointer; color: #f59e0b;">
                <input type="checkbox" id="chkAcknowledgeFullAudit" onchange="window.TargetedReviewUI.updateButtonState()">
                我已知晓本次变更包含全局或高风险改动，本次仅启动定向复查，完整审核仍待完成
              </label>
            </div>
          </div>
        ` : ''}

        <!-- Uncovered Scopes -->
        ${plan.uncoveredScopes && plan.uncoveredScopes.length ? `
          <div style="padding: 10px 14px; background: rgba(239, 68, 68, 0.08); border: 1px solid #ef4444; border-radius: 6px;">
            <strong style="color: #ef4444; font-size: 13px;">⚠️ 存在未匹配到任何审核员范围的变更：</strong>
            <div style="margin-top: 4px; font-size: 12px; font-family: var(--font-mono);">
              ${plan.uncoveredScopes.map(u => `<div>• ${escape(u.path || u)} <span style="color: #ef4444;">(${escape(u.reason || '未分配')})</span></div>`).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Proposed Tasks -->
        <div>
          <h4 style="font-size: 13px; margin-bottom: 6px;">📋 推荐定向任务 (${plan.proposedTasks.length} 项)</h4>
          <div id="targetedTasksList" style="display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto;">
            ${plan.proposedTasks.map((t, idx) => `
              <div class="card" style="padding: 10px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: 6px;">
                <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
                  <input type="checkbox" class="chk-targeted-task" value="${escape(t.id)}" checked onchange="window.TargetedReviewUI.updateButtonState()">
                  <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <strong>${escape(t.reviewerName)} · 任务 ${escape(t.id)}</strong>
                      <span style="font-size: 11px; color: var(--text-muted);">批次 ${t.batch}/${t.totalBatches}</span>
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                      范围：<code>${escape(t.scope || '默认范围')}</code> · ${escape(t.reason)}
                    </div>
                    <details style="margin-top: 6px; font-size: 11px; color: var(--text-muted);">
                      <summary style="cursor: pointer; color: var(--accent);">查看必查清单 (${t.checklist.length} 项)</summary>
                      <ul style="margin: 4px 0 0 16px; padding: 0;">
                        ${t.checklist.map(item => `<li>${escape(item)}</li>`).join('')}
                      </ul>
                    </details>
                  </div>
                </label>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Budget & Estimates -->
        <div style="padding: 10px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 6px; font-size: 12px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span><strong>预估调用次数：</strong> ${plan.estimatedAttempts.minimumAttempts} ~ ${plan.estimatedAttempts.maximumAttempts} 次</span>
            <span style="color: var(--text-muted);">纯静态估算，预览不消耗额度</span>
          </div>
          <ul style="margin: 0 0 0 16px; padding: 0; color: var(--text-muted); font-size: 11px;">
            ${(plan.estimatedAttempts.assumptions || []).map(a => `<li>${escape(a)}</li>`).join('')}
          </ul>
        </div>

        <!-- Note Input -->
        <div class="form-group" style="margin-bottom: 0;">
          <label for="targetedReviewNote" style="font-size: 12px;">定向复查说明（可选）：</label>
          <input type="text" id="targetedReviewNote" placeholder="例如：针对核心逻辑重构与已解决 Bug 的定向复查" style="font-size: 12px; padding: 6px 10px;">
        </div>
      </div>
    `;

    container.innerHTML = html;
    updateButtonState();
  }

  function updateButtonState() {
    const btnStart = document.getElementById('btnConfirmTargetedStart');
    if (!btnStart || !currentPlan) return;

    const checkedTasks = document.querySelectorAll('.chk-targeted-task:checked');
    const chkAck = document.getElementById('chkAcknowledgeFullAudit');

    let canStart = checkedTasks.length > 0;
    if (currentPlan.requiresFullAudit) {
      canStart = canStart && chkAck && chkAck.checked;
    }
    btnStart.disabled = !canStart;
  }

  async function confirmStart() {
    if (!currentPlan || !currentAuditId) return;
    const btnStart = document.getElementById('btnConfirmTargetedStart');
    if (btnStart) btnStart.disabled = true;

    const selectedTasks = Array.from(document.querySelectorAll('.chk-targeted-task:checked')).map(el => el.value);
    const chkAck = document.getElementById('chkAcknowledgeFullAudit');
    const note = document.getElementById('targetedReviewNote')?.value || '';

    try {
      const res = await fetch(`/api/audits/${encodeURIComponent(currentAuditId)}/targeted-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceRoot: currentWorkspaceRoot,
          version: currentPlan.version,
          taskIds: selectedTasks,
          acknowledgeFullAudit: Boolean(chkAck && chkAck.checked),
          note
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '启动定向复查失败');
      }

      closePreview();
      if (window.showToast) {
        window.showToast('定向复查已启动。', 'success');
      }
      if (window.auditApp?.openAudit) {
        await window.auditApp.openAudit(data.auditId);
      }
    } catch (err) {
      if (window.showToast) {
        window.showToast(err.message, 'error');
      } else {
        alert(err.message);
      }
      updateButtonState();
    }
  }

  function closePreview() {
    const modal = document.getElementById('targetedReviewModal');
    if (modal) modal.style.display = 'none';
    currentPlan = null;
  }

  function switchToFullAudit() {
    closePreview();
    if (window.auditClosure?.act) {
      window.auditClosure.act('recheck');
    } else {
      const btn = document.getElementById('btnRecheckClosure');
      if (btn) btn.click();
    }
  }

  window.TargetedReviewUI = {
    renderTargetedBannerHtml,
    openPreview,
    closePreview,
    confirmStart,
    switchToFullAudit,
    updateButtonState
  };
})();
