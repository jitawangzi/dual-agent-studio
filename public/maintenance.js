/**
 * @file maintenance.js
 * @author shuyongqiang
 * @description Frontend controller for evidence export, archive management, diagnostics, and import viewer (v2.14).
 */
'use strict';

(() => {
  const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const esc = val => (typeof escapeHtml === 'function' ? escapeHtml(String(val ?? '')) : String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast(msg, type) : (typeof window !== 'undefined' && window.showToast ? window.showToast(msg, type) : console.log(`[${type || 'info'}] ${msg}`)));

  let currentExportAuditId = null;
  let currentExportPlan = null;
  let currentArchiveAuditId = null;
  let currentArchivePreview = null;

  async function request(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res;
  }

  // =========================================================================
  // 1. EVIDENCE EXPORT
  // =========================================================================

  async function openExportModal(auditId) {
    currentExportAuditId = auditId;
    const modal = $('exportEvidenceModal');
    if (!modal) return;
    modal.style.display = 'flex';

    $('exportAuditIdDisplay').innerText = auditId;
    $('exportPlanPreview').innerHTML = '<p class="audit-help">正在分析证据闭包与计算体积...</p>';

    await refreshExportPlan();
  }

  function closeExportModal() {
    const modal = $('exportEvidenceModal');
    if (modal) modal.style.display = 'none';
    currentExportAuditId = null;
    currentExportPlan = null;
  }

  async function refreshExportPlan() {
    if (!currentExportAuditId) return;
    const includeArtifacts = $('exportIncludeArtifacts')?.checked || false;
    const redactPaths = $('exportRedactPaths')?.checked ?? true;

    try {
      const res = await request(`/api/audits/${currentExportAuditId}/export-plan`, {
        method: 'POST',
        body: JSON.stringify({ includeArtifacts, redactPaths })
      });
      const plan = await res.json();
      currentExportPlan = plan;

      let html = `
        <div style="font-size: 12px; margin-bottom: 8px;">
          <span>关联记录总数: <strong>${plan.recordRefs?.length || 0}</strong> 项</span> ·
          <span>附件文件: <strong>${plan.artifactRefs?.length || 0}</strong> 个</span> ·
          <span>预估包体积: <strong>${(plan.estimatedBytes / 1024).toFixed(1)} KB</strong></span>
        </div>
      `;

      if (plan.warnings?.length) {
        html += `
          <div class="alert alert-warning" style="padding: 8px; font-size: 12px; margin-bottom: 8px;">
            ${plan.warnings.map(w => `<p style="margin:2px 0;">⚠️ ${esc(w.message || w.reason)}</p>`).join('')}
          </div>
        `;
      }

      if (plan.omissions?.length) {
        html += `
          <div class="alert alert-info" style="padding: 8px; font-size: 12px; margin-bottom: 8px;">
            缺失的非核心外部引用: ${plan.omissions.map(o => `${o.kind}:${o.id}`).join(', ')}
          </div>
        `;
      }

      $('exportPlanPreview').innerHTML = html;
    } catch (err) {
      $('exportPlanPreview').innerHTML = `<p style="color:red; font-size:12px;">分析失败: ${esc(err.message)}</p>`;
    }
  }

  async function downloadExport(format = 'json') {
    if (!currentExportAuditId || !currentExportPlan) return;
    const includeArtifacts = $('exportIncludeArtifacts')?.checked || false;
    const redactPaths = $('exportRedactPaths')?.checked ?? true;

    try {
      const res = await fetch(`/api/audits/${currentExportAuditId}/export-bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: currentExportPlan.version,
          includeArtifacts,
          redactPaths,
          format
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${currentExportAuditId.slice(0, 8)}-evidence.${format === 'html' ? 'html' : 'json'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      toast(`证据报告 (${format.toUpperCase()}) 下载成功！`, 'success');
      closeExportModal();
    } catch (err) {
      toast('导出下载失败: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // 2. LOGICAL ARCHIVE
  // =========================================================================

  async function openArchiveModal(auditId) {
    currentArchiveAuditId = auditId;
    const modal = $('archiveGroupModal');
    if (!modal) return;
    modal.style.display = 'flex';

    $('archiveAuditIdDisplay').innerText = auditId;
    $('archivePreviewContent').innerHTML = '<p class="audit-help">正在分析将隐藏的关联组记录...</p>';
    $('btnConfirmArchive').disabled = true;

    try {
      const res = await request(`/api/audits/${auditId}/archive-preview`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      const preview = await res.json();
      currentArchivePreview = preview;

      if (preview.blockers?.length) {
        $('archivePreviewContent').innerHTML = `
          <div class="alert alert-danger" style="padding: 8px; font-size: 12px;">
            <strong>无法执行归档：</strong>
            ${preview.blockers.map(b => `<p style="margin:2px 0;">🚫 ${esc(b)}</p>`).join('')}
          </div>
        `;
        $('btnConfirmArchive').disabled = true;
        return;
      }

      $('archivePreviewContent').innerHTML = `
        <div style="font-size: 12px;">
          <p>将对以下 <strong>${preview.recordRefs?.length || 0}</strong> 项关联记录执行逻辑归档（在主列表中默认隐藏，保留原始文件与附件）：</p>
          <ul style="max-height: 120px; overflow-y: auto; padding-left: 20px;">
            ${preview.recordRefs.map(r => `<li><code>${esc(r.kind)}/${esc(r.id)}</code></li>`).join('')}
          </ul>
          <p class="modal-tip">逻辑归档不物理删除磁盘文件。可在存储维护窗口中随时一键恢复显示。</p>
        </div>
      `;
      $('btnConfirmArchive').disabled = false;
    } catch (err) {
      $('archivePreviewContent').innerHTML = `<p style="color:red; font-size:12px;">预览失败: ${esc(err.message)}</p>`;
    }
  }

  function closeArchiveModal() {
    const modal = $('archiveGroupModal');
    if (modal) modal.style.display = 'none';
    currentArchiveAuditId = null;
    currentArchivePreview = null;
  }

  async function confirmArchive() {
    if (!currentArchiveAuditId || !currentArchivePreview) return;
    const note = $('archiveNoteInput')?.value || '';

    try {
      await request(`/api/audits/${currentArchiveAuditId}/archive-apply`, {
        method: 'POST',
        body: JSON.stringify({
          version: currentArchivePreview.version,
          note
        })
      });
      toast('该组审查与修复记录已成功归档！', 'success');
      closeArchiveModal();
      window.auditApp?.refresh();
    } catch (err) {
      toast('归档失败: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // 3. STORAGE OVERVIEW & DIAGNOSTICS & ARCHIVE MANAGEMENT
  // =========================================================================

  async function loadStorageOverview() {
    try {
      const res = await request('/api/maintenance/overview');
      const data = await res.json();

      if ($('maintTotalRecords')) $('maintTotalRecords').innerText = data.summary?.totalRecords ?? 0;
      if ($('maintTotalAttachments')) $('maintTotalAttachments').innerText = `${data.summary?.totalAttachmentFiles ?? 0} 个 (${((data.summary?.totalAttachmentBytes || 0) / 1024).toFixed(1)} KB)`;
      if ($('maintArchivedCount')) $('maintArchivedCount').innerText = data.summary?.totalArchived ?? 0;
      if ($('maintTotalDisk')) $('maintTotalDisk').innerText = `${((data.summary?.totalStoreBytes || 0) / 1024 / 1024).toFixed(2)} MB`;
    } catch {}
  }

  async function loadArchivesList() {
    const listEl = $('archivedGroupsList');
    if (!listEl) return;
    try {
      const res = await request('/api/archives');
      const groups = await res.json();

      if (!groups.length) {
        listEl.innerHTML = '<p class="audit-help" style="padding: 12px;">暂无归档记录。</p>';
        return;
      }

      listEl.innerHTML = groups.map(g => `
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong>${g.isArchived ? '📦 已归档' : '✅ 已恢复'} · 审查: <code>${esc(g.primaryAuditId.slice(0, 8))}</code></strong>
            ${g.isArchived ? `
              <button class="btn btn-sm btn-secondary" onclick="window.maintenanceApp.restoreArchiveGroup('${esc(g.id)}')">🔄 恢复显示</button>
            ` : '<span style="font-size: 11px; color: #10b981;">已恢复</span>'}
          </div>
          <p style="margin: 4px 0; font-size: 12px; color: var(--text-secondary);">${esc(g.note || '无归档说明')}</p>
          <div style="font-size: 11px; color: var(--text-muted);">
            归档于: ${new Date(g.archivedAt).toLocaleString()} · 关联记录数: ${g.recordRefs?.length || 0}
          </div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<p style="color:red; font-size:12px;">加载失败: ${esc(err.message)}</p>`;
    }
  }

  async function restoreArchiveGroup(archiveId) {
    try {
      await request(`/api/archives/${archiveId}/restore`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      toast('已成功恢复显示！', 'success');
      loadArchivesList();
      window.auditApp?.refresh();
    } catch (err) {
      toast('恢复失败: ' + err.message, 'error');
    }
  }

  async function downloadDiagnostics() {
    try {
      const res = await fetch('/api/maintenance/diagnostics?download=true');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `studio-diagnostics-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast('系统诊断包下载成功！', 'success');
    } catch (err) {
      toast('下载诊断包失败: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // 4. READ-ONLY IMPORTS
  // =========================================================================

  async function loadImportsList() {
    const listEl = $('importedBundlesList');
    if (!listEl) return;
    try {
      const res = await request('/api/imports');
      const list = await res.json();

      if (!list.length) {
        listEl.innerHTML = '<p class="audit-help" style="padding: 12px;">暂无外部导入报告。</p>';
        return;
      }

      listEl.innerHTML = list.map(b => `
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong>📄 审查快照 <code>${esc(b.auditId.slice(0, 8))}</code></strong>
            <a href="/api/imports/${esc(b.id)}/report" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration: none;">
              🔍 查看只读 HTML 报告
            </a>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
            生成时间: ${new Date(b.generatedAt).toLocaleString()} ·
            记录数: ${b.recordsCount} ·
            附件数: ${b.artifactsCount}
          </div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<p style="color:red; font-size:12px;">加载失败: ${esc(err.message)}</p>`;
    }
  }

  async function handleImportJsonFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);

      const res = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.join('; ') || data.error || `HTTP ${res.status}`);
      }

      toast('外部证据包验证并导入成功！已加入只读查看器。', 'success');
      loadImportsList();
    } catch (err) {
      toast('导入失败: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // 5. STORAGE SUB-TAB SWITCHER
  // =========================================================================

  function switchStorageSubTab(tab) {
    const diagSec = $('storageSectionDiag');
    const archSec = $('storageSectionArchive');
    const impSec = $('storageSectionImport');
    const tabDiag = $('tabBtnStorageDiag');
    const tabArch = $('tabBtnStorageArchive');
    const tabImp = $('tabBtnStorageImport');

    if (diagSec) diagSec.style.display = tab === 'diag' ? 'block' : 'none';
    if (archSec) archSec.style.display = tab === 'archive' ? 'block' : 'none';
    if (impSec) impSec.style.display = tab === 'import' ? 'block' : 'none';

    if (tabDiag) tabDiag.classList.toggle('active', tab === 'diag');
    if (tabArch) tabArch.classList.toggle('active', tab === 'archive');
    if (tabImp) tabImp.classList.toggle('active', tab === 'import');

    if (tab === 'diag') {
      if (typeof window !== 'undefined' && window.refreshStorageMaintenance) {
        window.refreshStorageMaintenance();
      }
      loadStorageOverview();
    } else if (tab === 'archive') {
      loadArchivesList();
    } else if (tab === 'import') {
      loadImportsList();
    }
  }

  // Export to window
  const maintenanceApp = {
    openExportModal,
    closeExportModal,
    refreshExportPlan,
    downloadExport,
    openArchiveModal,
    closeArchiveModal,
    confirmArchive,
    loadStorageOverview,
    loadArchivesList,
    restoreArchiveGroup,
    downloadDiagnostics,
    loadImportsList,
    handleImportJsonFile,
    switchStorageSubTab
  };

  if (typeof window !== 'undefined') {
    window.maintenanceApp = maintenanceApp;
    window.switchStorageSubTab = switchStorageSubTab;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = maintenanceApp;
  }
})();
