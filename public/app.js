// Dual-Agent Studio Frontend Controller (Multi-Engine, Cascading Models & Discussion Support)

let activeTab = 'timeline';
let isRunning = false;
let modelsConfig = { series: [], engineSeriesRules: {} };

// Folder Picker State
let explorerCurrentPath = '';
let explorerParentPath = null;
let explorerSelectedPath = '';

const PREF_KEY = 'dual_agent_studio_prefs';

// --- LIGHTWEIGHT TOAST NOTIFICATION SYSTEM ---
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer') || document.body;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconMap = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  const icon = iconMap[type] || 'ℹ️';

  toast.innerHTML = `<span style="font-size: 16px;">${icon}</span><span>${escapeHtml(String(message))}</span>`;
  
  toast.onclick = () => {
    toast.classList.add('toast-hiding');
    setTimeout(() => toast.remove(), 250);
  };

  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('toast-hiding');
      setTimeout(() => toast.remove(), 250);
    }
  }, duration);
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadModelsConfig();
  loadUserPreferences();
  await initProjects();
  initSSE();
  
  const currentWs = document.getElementById('workspaceRoot')?.value;
  if (currentWs) {
    updateRecentBadgesHighlight(currentWs);
    autoDetectWorkspace(currentWs);
    fetchDiff();
    loadWorkspaceDiscussion(currentWs);
    fetchSessions(currentWs);
  }
  fetchStatus();
  setInterval(fetchStatus, 3000);

  // Auto-save preferences on input changes
  document.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('change', saveUserPreferences);
  });
});

function saveUserPreferences() {
  try {
    const prefs = {
      workspaceRoot: document.getElementById('workspaceRoot')?.value || '',
      featureName: document.getElementById('featureName')?.value || '',
      maxRounds: document.getElementById('maxRounds')?.value || '4',
      maxSelfHealAttempts: document.getElementById('maxSelfHealAttempts')?.value || '3',
      autoCommit: document.getElementById('autoCommit')?.checked ?? true,
      verifyCommand: document.getElementById('verifyCommand')?.value || '',
      devProvider: document.getElementById('devProvider')?.value || 'claude',
      devSeries: document.getElementById('devSeries')?.value || '',
      devModel: document.getElementById('devModel')?.value || '',
      devModelCustom: document.getElementById('devModelCustom')?.value || '',
      devReasoningEffort: document.getElementById('devReasoningEffort')?.value || '',
      reviewProvider: document.getElementById('reviewProvider')?.value || 'copilot',
      reviewSeries: document.getElementById('reviewSeries')?.value || '',
      reviewModel: document.getElementById('reviewModel')?.value || '',
      reviewModelCustom: document.getElementById('reviewModelCustom')?.value || '',
      reviewReasoningEffort: document.getElementById('reviewReasoningEffort')?.value || '',
      vaguePrompt: document.getElementById('vaguePrompt')?.value || '',
      taskPrompt: document.getElementById('taskPrompt')?.value || ''
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.error('Failed to save preferences:', e);
  }
}

function loadUserPreferences() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };
    const setChecked = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.checked = !!val;
    };

    setVal('workspaceRoot', p.workspaceRoot);
    setVal('featureName', p.featureName);
    setVal('maxRounds', p.maxRounds);
    setVal('maxSelfHealAttempts', p.maxSelfHealAttempts);
    setChecked('autoCommit', p.autoCommit);
    setVal('verifyCommand', p.verifyCommand);
    setVal('vaguePrompt', p.vaguePrompt);
    setVal('taskPrompt', p.taskPrompt);

    if (p.devProvider && document.getElementById('devProvider')) {
      document.getElementById('devProvider').value = p.devProvider;
      onDevEngineChange();
      if (p.devSeries && document.getElementById('devSeries')) {
        document.getElementById('devSeries').value = p.devSeries;
        onDevSeriesChange();
        if (p.devModel && document.getElementById('devModel')) {
          document.getElementById('devModel').value = p.devModel;
          onDevModelChange();
        }
      }
      if (p.devModelCustom && document.getElementById('devModelCustom')) {
        document.getElementById('devModelCustom').value = p.devModelCustom;
      }
      if (p.devReasoningEffort && document.getElementById('devReasoningEffort')) {
        document.getElementById('devReasoningEffort').value = p.devReasoningEffort;
      }
    }

    if (p.reviewProvider && document.getElementById('reviewProvider')) {
      document.getElementById('reviewProvider').value = p.reviewProvider;
      onReviewEngineChange();
      if (p.reviewSeries && document.getElementById('reviewSeries')) {
        document.getElementById('reviewSeries').value = p.reviewSeries;
        onReviewSeriesChange();
        if (p.reviewModel && document.getElementById('reviewModel')) {
          document.getElementById('reviewModel').value = p.reviewModel;
          onReviewModelChange();
        }
      }
      if (p.reviewModelCustom && document.getElementById('reviewModelCustom')) {
        document.getElementById('reviewModelCustom').value = p.reviewModelCustom;
      }
      if (p.reviewReasoningEffort && document.getElementById('reviewReasoningEffort')) {
        document.getElementById('reviewReasoningEffort').value = p.reviewReasoningEffort;
      }
    }
  } catch (e) {
    console.error('Failed to load preferences:', e);
  }
}

function renderMarkdown(md) {
  if (!md) return '';
  const codeBlocks = [];
  let text = String(md).replace(/```([a-zA-Z0-9_\-\.]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const id = `___CODE_BLOCK_${codeBlocks.length}___`;
    codeBlocks.push(`<pre class="code-block"><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.trim())}</code></pre>`);
    return id;
  });

  text = escapeHtml(text);

  text = text.replace(/^### (.*$)/gim, '<h4 class="md-h4">$1</h4>');
  text = text.replace(/^## (.*$)/gim, '<h3 class="md-h3">$1</h3>');
  text = text.replace(/^# (.*$)/gim, '<h2 class="md-h2">$1</h2>');
  text = text.replace(/^---$/gim, '<hr class="md-hr">');

  text = text.replace(/^- \[x\] (.*$)/gim, '<div class="md-task-item done"><span class="check-box checked">☑</span> <span>$1</span></div>');
  text = text.replace(/^- \[ \] (.*$)/gim, '<div class="md-task-item"><span class="check-box">☐</span> <span>$1</span></div>');

  text = text.replace(/^\* (.*$)/gim, '<li class="md-li">$1</li>');
  text = text.replace(/^- (.*$)/gim, '<li class="md-li">$1</li>');
  text = text.replace(/^(\d+)\. (.*$)/gim, '<li class="md-num-li"><span class="num-badge">$1.</span> $2</li>');

  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  codeBlocks.forEach((cb, idx) => {
    text = text.replace(`___CODE_BLOCK_${idx}___`, cb);
  });

  text = text.replace(/\r?\n/g, '<br>');
  text = text.replace(/(<\/h[1-6]>|<hr[^>]*>|<\/pre>|<\/div>|<\/li>)<br>/g, '$1');
  text = text.replace(/<br>(<h[1-6]>|<hr[^>]*>|<pre|<div|<li)/g, '$1');

  return `<div class="markdown-body">${text}</div>`;
}

// --- TAB SWITCHING ---
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tab));
  if (activeBtn) activeBtn.classList.add('active');

  const content = document.getElementById(`tab-${tab}`);
  if (content) content.classList.add('active');

  if (tab === 'diff') {
    fetchDiff();
  }
}

// --- REQUIREMENT MODE TOGGLE ---
function toggleReqMode(mode) {
  const directBox = document.getElementById('directReqBox');
  const discussBox = document.getElementById('discussReqBox');
  if (mode === 'direct') {
    if (directBox) directBox.style.display = 'block';
    if (discussBox) discussBox.style.display = 'none';
  } else {
    if (directBox) directBox.style.display = 'none';
    if (discussBox) discussBox.style.display = 'block';
  }
  saveUserPreferences();
}

// --- NATIVE FOLDER PICKER & EXPLORER DIALOG ---
async function openFolderPickerModal() {
  const currentVal = document.getElementById('workspaceRoot')?.value?.trim() || '';
  try {
    const res = await fetch('/api/browse-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPath: currentVal })
    });
    const data = await res.json();
    if (data.path && !data.cancelled) {
      setWorkspace(data.path, true);
    } else if (data.useFallback || data.error) {
      openFolderModal(currentVal || 'D:\\');
    }
  } catch (e) {
    openFolderModal(currentVal || 'D:\\');
  }
}

function closeFolderPickerModal() {
  const modal = document.getElementById('folderModal');
  if (modal) modal.style.display = 'none';
}

function navigateUpFolder() {
  if (explorerParentPath) {
    fetchDirectory(explorerParentPath);
  }
}

function confirmSelectedFolder() {
  const selected = explorerSelectedPath || explorerCurrentPath;
  if (selected) {
    closeFolderPickerModal();
    setWorkspace(selected, true);
  }
}

// Legacy aliases for backward compatibility
function openFolderPicker() { return openFolderPickerModal(); }
function openFolderModal(startPath) {
  const modal = document.getElementById('folderModal');
  if (modal) modal.style.display = 'flex';
  loadDrives();
  fetchDirectory(startPath || '');
}
function closeFolderModal() { return closeFolderPickerModal(); }
function navigateParentFolder() { return navigateUpFolder(); }
function confirmFolderSelection() { return confirmSelectedFolder(); }

async function loadDrives() {
  const drivesContainer = document.getElementById('quickDrives');
  if (!drivesContainer) return;
  drivesContainer.innerHTML = '';
  try {
    const res = await fetch('/api/list-dirs');
    const data = await res.json();
    if (data && data.dirs) {
      data.dirs.forEach(d => {
        const chip = document.createElement('span');
        chip.className = 'drive-chip';
        chip.textContent = d.name;
        chip.onclick = () => fetchDirectory(d.path);
        drivesContainer.appendChild(chip);
      });
    }
  } catch (e) {
    console.error('Failed to load drives:', e);
  }
}

async function fetchDirectory(targetPath) {
  const listEl = document.getElementById('folderList');
  const pathDisplay = document.getElementById('folderCurrentPath');
  const btnUp = document.getElementById('btnNavUp');
  if (!listEl || !pathDisplay) return;

  listEl.innerHTML = '<div class="folder-loading">正在读取目录...</div>';
  pathDisplay.textContent = targetPath || '根目录';

  try {
    const url = targetPath ? `/api/list-dirs?path=${encodeURIComponent(targetPath)}` : '/api/list-dirs';
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || data.error) {
      listEl.innerHTML = `<div class="folder-empty">⚠️ 无法读取目录: ${data.error || '未知错误'}</div>`;
      return;
    }

    explorerCurrentPath = data.currentPath || targetPath;
    explorerParentPath = data.parentPath;
    explorerSelectedPath = explorerCurrentPath;
    pathDisplay.textContent = explorerCurrentPath;
    if (btnUp) btnUp.disabled = !explorerParentPath;

    listEl.innerHTML = '';
    if (!data.dirs || data.dirs.length === 0) {
      listEl.innerHTML = '<div class="folder-empty">此目录下无可见子文件夹</div>';
      return;
    }

    data.dirs.forEach(item => {
      const row = document.createElement('div');
      row.className = 'folder-item';
      row.innerHTML = `
        <span class="folder-item-icon">${item.isDrive ? '💾' : '📁'}</span>
        <span class="folder-item-name">${item.name}</span>
      `;
      row.onclick = () => {
        document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
        explorerSelectedPath = item.path;
        pathDisplay.textContent = item.path;
      };
      row.ondblclick = () => {
        fetchDirectory(item.path);
      };
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="folder-empty">请求异常: ${e.message}</div>`;
  }
}

// --- AUTO DETECT WORKSPACE TEST COMMAND ---
async function autoDetectWorkspace(wsPath) {
  if (!wsPath) return;
  try {
    const res = await fetch('/api/detect-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: wsPath })
    });
    const data = await res.json();
    const recommended = data.verifyCommand || data.recommendedCommand;
    if (recommended) {
      const cmdInput = document.getElementById('verifyCommand');
      if (cmdInput && (!cmdInput.value || cmdInput.value === 'exit 0' || cmdInput.value.includes('gradlew') || cmdInput.value.includes('mvn') || cmdInput.value.includes('npm') || cmdInput.value.includes('pwsh'))) {
        cmdInput.value = recommended;
      }
    }
  } catch (e) {
    console.error('Failed to auto detect workspace:', e);
  }
}

function setWorkspace(wsPath, updateServerProjects = true) {
  if (!wsPath) return;
  const input = document.getElementById('workspaceRoot');
  if (input) input.value = wsPath;

  // Update active highlight in recent projects badges
  updateRecentBadgesHighlight(wsPath);

  // Save to localStorage immediately
  saveUserPreferences();

  // Auto detect framework & test command
  autoDetectWorkspace(wsPath);

  // Refresh git diff & mailbox status for this workspace
  fetchDiff();
  fetchStatus();

  // Load saved discussion & blueprint for this workspace
  loadWorkspaceDiscussion(wsPath);

  // Load active sessions for this workspace
  fetchSessions(wsPath);

  // Register in recent projects on backend
  if (updateServerProjects) {
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: wsPath })
    }).then(res => res.json()).then(data => {
      if (data.projects) {
        renderRecentProjects(data.projects);
      }
    }).catch(() => {});
  }
}

function updateRecentBadgesHighlight(wsPath) {
  const norm = (wsPath || '').trim().toLowerCase().replace(/\\/g, '/');
  document.querySelectorAll('#recentProjects .recent-badge').forEach(badge => {
    const badgePath = (badge.title || '').trim().toLowerCase().replace(/\\/g, '/');
    if (badgePath && badgePath === norm) {
      badge.classList.add('active');
    } else {
      badge.classList.remove('active');
    }
  });
}

// --- RECENT PROJECTS ---
function renderRecentProjects(projects) {
  const container = document.getElementById('recentProjects');
  if (!container) return;
  container.innerHTML = '';
  const currentWs = document.getElementById('workspaceRoot')?.value;

  projects.forEach(p => {
    const badge = document.createElement('span');
    badge.className = 'recent-badge';
    badge.textContent = `📁 ${p.name}`;
    badge.title = p.path;
    badge.onclick = () => {
      setWorkspace(p.path, true);
    };
    container.appendChild(badge);
  });

  if (currentWs) {
    updateRecentBadgesHighlight(currentWs);
  }
}

async function initProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const currentWs = document.getElementById('workspaceRoot')?.value;

    renderRecentProjects(projects);

    if (currentWs) {
      updateRecentBadgesHighlight(currentWs);
    } else if (projects.length > 0) {
      setWorkspace(projects[0].path, false);
    }
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

// --- ENGINE & MODEL CASCADE RULES ---
async function loadModelsConfig() {
  try {
    const res = await fetch('/api/models');
    modelsConfig = await res.json();
    onDevEngineChange();
    onReviewEngineChange();
  } catch (e) {
    console.error('Failed to load models config:', e);
  }
}

function getSeriesForEngine(engine) {
  const rules = modelsConfig.engineSeriesRules || {};
  const allowed = rules[engine] || ['claude', 'gpt', 'gemini', 'deepseek', 'grok', 'glm', 'qwen', 'custom'];
  return (modelsConfig.series || []).filter(s => allowed.includes(s.id));
}

function onDevEngineChange() {
  const engineEl = document.getElementById('devProvider');
  const devSeries = document.getElementById('devSeries');
  if (!engineEl || !devSeries) return;
  const engine = engineEl.value;
  const allowedSeries = getSeriesForEngine(engine);

  devSeries.innerHTML = '';
  allowedSeries.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    devSeries.appendChild(opt);
  });

  if (allowedSeries.length > 0) {
    devSeries.value = allowedSeries[0].id;
  }
  onDevSeriesChange();
}

function onDevSeriesChange() {
  const seriesEl = document.getElementById('devSeries');
  const devModel = document.getElementById('devModel');
  if (!seriesEl || !devModel) return;
  const seriesId = seriesEl.value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  devModel.innerHTML = '';

  if (series && series.models) {
    series.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      devModel.appendChild(opt);
    });
  }
  onDevModelChange();
}

function getEffortsForEngineAndModel(engine, model) {
  if (model && model.effortType === 'none') {
    return [
      { value: 'none', label: 'N/A (非思考模型，直接输出)', default: true }
    ];
  }

  if (engine === 'copilot') {
    return [
      { value: 'high', label: 'High (深度推理 / 严密代码审查 - 推荐)', default: true },
      { value: 'medium', label: 'Medium (均衡推理)', default: false },
      { value: 'low', label: 'Low (快速轻量响应)', default: false },
      { value: 'xhigh', label: 'Extra High (极致长程深度推理)', default: false },
      { value: 'max', label: 'Max (最高算力推理)', default: false },
      { value: 'none', label: 'None (关闭思考 / 常规模式)', default: false }
    ];
  }

  if (engine === 'claude' || engine === 'claude_code') {
    return [
      { value: '16384', label: 'High (16,384 Thinking Tokens - 推荐)', default: true },
      { value: '8192', label: 'Medium (8,192 Thinking Tokens)', default: false },
      { value: '2048', label: 'Low (2,048 Thinking Tokens)', default: false },
      { value: '64000', label: 'Max (64,000 Thinking Tokens)', default: false },
      { value: '0', label: 'Off (关闭思考)', default: false }
    ];
  }

  if (engine === 'antigravity' || engine === 'agy') {
    return [
      { value: 'high', label: 'High (深度推理 / 复杂架构规划 - 推荐)', default: true },
      { value: 'medium', label: 'Medium (均衡推理 / 日常编码)', default: false },
      { value: 'low', label: 'Low (快速轻量响应)', default: false },
      { value: 'none', label: 'Default / None (默认模式)', default: false }
    ];
  }

  if (model && model.efforts && model.efforts.length > 0) {
    return model.efforts.map(eff => ({
      value: eff.value || eff.id,
      label: eff.label,
      default: (eff.id === model.defaultEffort || eff.value === model.defaultEffort)
    }));
  }

  return [
    { value: 'high', label: 'High (深度推理 - 推荐)', default: true },
    { value: 'medium', label: 'Medium (均衡推理)', default: false },
    { value: 'low', label: 'Low (常规快速)', default: false },
    { value: 'none', label: 'None (关闭思考)', default: false }
  ];
}

function onDevModelChange() {
  const engine = document.getElementById('devProvider')?.value;
  const seriesId = document.getElementById('devSeries')?.value;
  const modelId = document.getElementById('devModel')?.value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const model = series?.models?.find(m => m.id === modelId);

  const customInput = document.getElementById('devModelCustom');
  if (customInput && model) {
    customInput.value = model.id;
  }

  const effortSelect = document.getElementById('devReasoningEffort');
  if (!effortSelect) return;
  effortSelect.innerHTML = '';

  const options = getEffortsForEngineAndModel(engine, model);
  options.forEach(eff => {
    const opt = document.createElement('option');
    opt.value = eff.value;
    opt.textContent = eff.label;
    if (eff.default) {
      opt.selected = true;
    }
    effortSelect.appendChild(opt);
  });
}

function onReviewEngineChange() {
  const engineEl = document.getElementById('reviewProvider');
  const reviewSeries = document.getElementById('reviewSeries');
  if (!engineEl || !reviewSeries) return;
  const engine = engineEl.value;
  const allowedSeries = getSeriesForEngine(engine);
  reviewSeries.innerHTML = '';
  allowedSeries.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    reviewSeries.appendChild(opt);
  });

  if (allowedSeries.length > 0) {
    reviewSeries.value = allowedSeries[0].id;
  }
  onReviewSeriesChange();
}

function onReviewSeriesChange() {
  const seriesEl = document.getElementById('reviewSeries');
  const reviewModel = document.getElementById('reviewModel');
  if (!seriesEl || !reviewModel) return;
  const seriesId = seriesEl.value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  reviewModel.innerHTML = '';

  if (series && series.models) {
    series.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      reviewModel.appendChild(opt);
    });
  }
  onReviewModelChange();
}

function onReviewModelChange() {
  const engine = document.getElementById('reviewProvider')?.value;
  const seriesId = document.getElementById('reviewSeries')?.value;
  const modelId = document.getElementById('reviewModel')?.value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const model = series?.models?.find(m => m.id === modelId);

  const customInput = document.getElementById('reviewModelCustom');
  if (customInput && model) {
    customInput.value = model.id;
  }

  const effortSelect = document.getElementById('reviewReasoningEffort');
  if (!effortSelect) return;
  effortSelect.innerHTML = '';

  const options = getEffortsForEngineAndModel(engine, model);
  options.forEach(eff => {
    const opt = document.createElement('option');
    opt.value = eff.value;
    opt.textContent = eff.label;
    if (eff.default) {
      opt.selected = true;
    }
    effortSelect.appendChild(opt);
  });
}

// --- MODEL MANAGER MODAL ---
function openModelManager() {
  const editor = document.getElementById('modelsJsonEditor');
  if (editor) editor.value = JSON.stringify(modelsConfig, null, 2);
  const modal = document.getElementById('modelModal');
  if (modal) modal.style.display = 'flex';
}

function closeModelManager() {
  const modal = document.getElementById('modelModal');
  if (modal) modal.style.display = 'none';
}

async function saveModelsManager() {
  try {
    const raw = document.getElementById('modelsJsonEditor').value;
    const parsed = JSON.parse(raw);
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    });
    if (res.ok) {
      modelsConfig = parsed;
      onDevEngineChange();
      onReviewEngineChange();
      closeModelManager();
      showToast('模型与规则配置已成功保存并实时生效！', 'success');
    } else {
      const err = await res.json();
      showToast('保存失败: ' + err.error, 'error');
    }
  } catch (e) {
    showToast('JSON 格式有误: ' + e.message, 'error');
  }
}

// --- REQUIREMENT DISCUSSION PHASE ---
async function startDiscussion() {
  const ws = document.getElementById('workspaceRoot')?.value?.trim() || '';
  const vague = document.getElementById('vaguePrompt')?.value?.trim() || '';
  const maxDiscussionRounds = parseInt(document.getElementById('maxDiscussionRounds')?.value, 10) || 2;

  if (!ws) {
    showToast('请填写项目物理根目录路径！', 'warning');
    return;
  }
  if (!vague) {
    showToast('请输入您的初步需求或想法！', 'warning');
    return;
  }

  const effectiveDevModel = document.getElementById('devModelCustom')?.value?.trim() || document.getElementById('devModel')?.value;
  const effectiveReviewModel = document.getElementById('reviewModelCustom')?.value?.trim() || document.getElementById('reviewModel')?.value;

  const btn = document.getElementById('btnStartDiscuss');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 双 Agent 正在多轮推演讨论中...';
  }

  switchTab('discussion');
  const container = document.getElementById('discussionMessages');
  const statusBadge = document.getElementById('discussionStatusBadge');
  if (statusBadge) {
    statusBadge.className = 'discussion-status-badge running';
    statusBadge.textContent = `多轮推演中 (最大 ${maxDiscussionRounds} 轮)...`;
  }
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💭</div>
        <p>正在由开发方 (${document.getElementById('devProvider')?.value || 'Dev'}) 与审查方 (${document.getElementById('reviewProvider')?.value || 'Reviewer'}) 展开多轮需求辩论与架构共识推演...</p>
      </div>
    `;
  }
  const gate = document.getElementById('humanDecisionGate');
  if (gate) gate.style.display = 'none';

  const payload = {
    workspaceRoot: ws,
    vaguePrompt: vague,
    maxDiscussionRounds,
    devProvider: document.getElementById('devProvider')?.value,
    devModel: effectiveDevModel,
    devReasoningEffort: document.getElementById('devReasoningEffort')?.value,
    devSessionId: document.getElementById('devSessionId')?.value?.trim() || undefined,
    reviewProvider: document.getElementById('reviewProvider')?.value,
    reviewModel: effectiveReviewModel,
    reviewReasoningEffort: document.getElementById('reviewReasoningEffort')?.value,
    reviewSessionId: document.getElementById('reviewSessionId')?.value?.trim() || undefined
  };

  try {
    const res = await fetch('/api/discuss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (res.status === 202) {
      showToast('双 Agent 需求推演已在后台启动...', 'info');
    } else if (!res.ok) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '💬 启动双 Agent 多轮对齐与共识推演';
      }
      showToast('需求讨论启动失败: ' + (result.error || '未知错误'), 'error');
      if (statusBadge) {
        statusBadge.className = 'discussion-status-badge error';
        statusBadge.textContent = '推演异常';
      }
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💬 启动双 Agent 多轮对齐与共识推演';
    }
    if (statusBadge) {
      statusBadge.className = 'discussion-status-badge error';
      statusBadge.textContent = '推演异常';
    }
    showToast('请求异常: ' + e.message, 'error');
  }
}

async function loadWorkspaceDiscussion(wsPath) {
  if (!wsPath) return;
  try {
    const res = await fetch(`/api/discuss?workspace=${encodeURIComponent(wsPath)}`);
    const data = await res.json();
    let disc = (data && data.success && data.discussion) ? data.discussion : null;

    if (!disc) {
      try {
        const cached = localStorage.getItem('dual_studio_discussion_' + wsPath);
        if (cached) disc = JSON.parse(cached);
      } catch (e) {}
    }

    if (disc) {
      const vagueInput = document.getElementById('vaguePrompt');
      if (vagueInput && !vagueInput.value && disc.vaguePrompt) {
        vagueInput.value = disc.vaguePrompt;
      }

      const statusBadge = document.getElementById('discussionStatusBadge');
      if (statusBadge) {
        statusBadge.className = 'discussion-status-badge success';
        statusBadge.textContent = disc.consensusReached ? '🏆 双方已达成共识 (历史已恢复)' : '🏁 推演完成 (历史已恢复)';
      }

      if (disc.rounds && disc.rounds.length > 0) {
        renderDiscussionRounds(disc.rounds);
      }

      const gate = document.getElementById('humanDecisionGate');
      const editor = document.getElementById('finalPlanEditor');
      if (gate && editor && disc.finalPlan) {
        editor.value = disc.finalPlan;
        if (disc.suggestedFeature && !document.getElementById('featureName').value) {
          document.getElementById('featureName').value = disc.suggestedFeature;
        }
        gate.style.display = 'block';
      }
    }
  } catch (e) {
    console.error('Failed to load saved discussion:', e);
  }
}

// --- WORKSPACE SESSION RESOLUTION & RESET ---
async function fetchSessions(wsPath, feature) {
  if (!wsPath) return;
  try {
    const feat = feature || document.getElementById('featureName')?.value?.trim() || '';
    const res = await fetch(`/api/sessions?workspace=${encodeURIComponent(wsPath)}${feat ? `&feature=${encodeURIComponent(feat)}` : ''}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) {
        const devInput = document.getElementById('devSessionId');
        const revInput = document.getElementById('reviewSessionId');
        if (devInput && data.devSessionId) {
          devInput.value = data.devSessionId;
        }
        if (revInput && data.reviewSessionId) {
          revInput.value = data.reviewSessionId;
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch sessions:', e);
  }
}

async function resetWorkspaceSessions() {
  const ws = document.getElementById('workspaceRoot')?.value?.trim();
  if (!ws) {
    showToast('请先选择或输入工作区物理根目录！', 'warning');
    return;
  }
  const feat = document.getElementById('featureName')?.value?.trim() || '';
  try {
    const res = await fetch('/api/sessions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: ws, feature: feat })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      const devInput = document.getElementById('devSessionId');
      const revInput = document.getElementById('reviewSessionId');
      if (devInput) devInput.value = data.devSessionId;
      if (revInput) revInput.value = data.reviewSessionId;
      showToast('Agent 会话 ID 已成功重置并持久化到工作区！', 'success');
      saveUserPreferences();
    } else {
      showToast(`重置会话失败: ${data.error || '未知错误'}`, 'error');
    }
  } catch (e) {
    showToast(`重置会话请求异常: ${e.message}`, 'error');
  }
}

function renderDiscussionRounds(rounds) {
  const container = document.getElementById('discussionMessages');
  if (!rounds || rounds.length === 0 || !container) return;

  container.innerHTML = '';
  rounds.forEach(msg => {
    const isDev = msg.sender === 'DEV';
    const card = document.createElement('div');
    card.className = `discussion-card ${isDev ? 'dev' : 'reviewer'} ${msg.consensus ? 'consensus' : ''}`;
    
    card.innerHTML = `
      <div class="discussion-card-header">
        <span class="sender-tag">
          ${isDev ? '🛠️ ' : '🔍 '}${escapeHtml(msg.role || (isDev ? '开发方' : '审查方'))}
        </span>
        <div class="round-badge-group">
          <span class="round-chip">Round ${msg.round}</span>
          ${msg.consensus ? '<span class="consensus-chip">🏆 达成共识</span>' : ''}
        </div>
      </div>
      <div class="discussion-body">${renderMarkdown(msg.content)}</div>
    `;
    container.appendChild(card);
  });
}

function approvePlanAndStart() {
  const finalPlan = document.getElementById('finalPlanEditor')?.value?.trim() || '';
  if (!finalPlan) {
    showToast('执行方案不能为空！', 'warning');
    return;
  }

  // Populate into taskPrompt and switch to direct mode execution
  const taskPromptEl = document.getElementById('taskPrompt');
  if (taskPromptEl) taskPromptEl.value = finalPlan;
  toggleReqMode('direct');
  const directRadio = document.querySelector('input[name="reqMode"][value="direct"]');
  if (directRadio) directRadio.checked = true;

  switchTab('timeline');
  startLoop();
}

// --- SSE EVENT HANDLING ---
function initSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    appendLogLine(data);
  });

  eventSource.addEventListener('state_change', (e) => {
    const data = JSON.parse(e.data);
    updateRunningState(data.isRunning);
    if (data.mailbox) {
      renderTimeline(data.mailbox);
    }
  });

  eventSource.addEventListener('mailbox_update', (e) => {
    const mailbox = JSON.parse(e.data);
    if (mailbox) {
      renderTimeline(mailbox);
    }
  });

  eventSource.addEventListener('discussion_message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg) {
      const container = document.getElementById('discussionMessages');
      if (container) {
        const empty = container.querySelector('.empty-state');
        if (empty) empty.remove();

        const isDev = msg.sender === 'DEV';
        const card = document.createElement('div');
        card.className = `discussion-card ${isDev ? 'dev' : 'reviewer'} ${msg.consensus ? 'consensus' : ''}`;
        card.innerHTML = `
          <div class="discussion-card-header">
            <span class="sender-tag">
              ${isDev ? '🛠️ ' : '🔍 '}${escapeHtml(msg.role || (isDev ? '开发方' : '审查方'))}
            </span>
            <div class="round-badge-group">
              <span class="round-chip">Round ${msg.round}</span>
              ${msg.consensus ? '<span class="consensus-chip">🏆 达成共识</span>' : ''}
            </div>
          </div>
          <div class="discussion-body">${renderMarkdown(msg.content)}</div>
        `;
        container.appendChild(card);
      }
    }
  });

  eventSource.addEventListener('discussion_error', (e) => {
    const data = JSON.parse(e.data);
    const btn = document.getElementById('btnStartDiscuss');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💬 启动双 Agent 多轮对齐与共识推演';
    }
    const statusBadge = document.getElementById('discussionStatusBadge');
    if (statusBadge) {
      statusBadge.className = 'discussion-status-badge error';
      statusBadge.textContent = '推演异常/已中止';
    }
    showToast(data.error || '需求推演异常', 'error');
  });

  eventSource.addEventListener('discussion_complete', (e) => {
    const data = JSON.parse(e.data);
    if (data) {
      const statusBadge = document.getElementById('discussionStatusBadge');
      if (statusBadge) {
        statusBadge.className = 'discussion-status-badge success';
        statusBadge.textContent = data.consensusReached ? '🏆 双方已达成共识' : '🏁 推演完成';
      }
      const gate = document.getElementById('humanDecisionGate');
      const editor = document.getElementById('finalPlanEditor');
      if (gate && editor && data.finalPlan) {
        editor.value = data.finalPlan;
        if (data.suggestedFeature && !document.getElementById('featureName').value) {
          document.getElementById('featureName').value = data.suggestedFeature;
        }
        gate.style.display = 'block';
        setTimeout(() => gate.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
      }
      const btn = document.getElementById('btnStartDiscuss');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '💬 启动双 Agent 多轮对齐与共识推演';
      }
      showToast(data.consensusReached ? '双 Agent 达成共识方案！' : '需求推演完成！', 'success');
    }
  });

  eventSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting...');
  };
}

function appendLogLine(log) {
  const consoleEl = document.getElementById('logsConsole');
  if (!consoleEl) return;
  const line = document.createElement('div');
  line.className = `log-line ${log.type || 'stdout'}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(log.time).toLocaleTimeString();

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = log.message;

  line.appendChild(time);
  line.appendChild(msg);
  consoleEl.appendChild(line);

  if (document.getElementById('autoScroll')?.checked) {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

function clearLogs() {
  const consoleEl = document.getElementById('logsConsole');
  if (consoleEl) consoleEl.innerHTML = '';
}

async function fetchStatus() {
  try {
    const ws = document.getElementById('workspaceRoot')?.value?.trim() || '';
    const res = await fetch(`/api/status${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`);
    const data = await res.json();
    updateRunningState(data.isRunning);
    if (data.mailbox) {
      renderTimeline(data.mailbox);
    }
  } catch (e) {
    console.error('Error fetching status:', e);
  }
}

function updateRunningState(running) {
  isRunning = running;
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');

  if (running) {
    if (statusBadge) statusBadge.className = 'status-badge running';
    if (statusText) statusText.textContent = '运行中 (RUNNING)';
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } else {
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
  }
}

function renderTimeline(mb) {
  if (!mb) return;

  const emptyState = document.getElementById('emptyTimeline');
  const roundsList = document.getElementById('roundsList');
  const roundBadge = document.getElementById('roundBadge');
  const currentRoundText = document.getElementById('currentRoundText');
  const maxRoundText = document.getElementById('maxRoundText');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');

  if (roundBadge) roundBadge.style.display = 'inline-block';
  if (currentRoundText) currentRoundText.textContent = mb.round;
  if (maxRoundText) maxRoundText.textContent = mb.maxRounds;

  if (statusBadge && statusText) {
    if (mb.status === 'APPROVED') {
      statusBadge.className = 'status-badge approved';
      statusText.textContent = '🏆 审核通过 (APPROVED)';
    } else if (mb.status === 'REJECTED_MAX_ROUNDS') {
      statusBadge.className = 'status-badge rejected';
      statusText.textContent = '🚫 达到最大轮次 (REJECTED)';
    } else if (mb.status === 'FAILED' || mb.status === 'ERROR') {
      statusBadge.className = 'status-badge rejected';
      statusText.textContent = '❌ 任务执行失败 (FAILED)';
    } else if (mb.status === 'WAITING_DEV') {
      if (isRunning) {
        statusBadge.className = 'status-badge running';
        statusText.textContent = `🛠️ 正在进行第 ${mb.round} 轮开发方自主编码中...`;
      } else {
        statusBadge.className = 'status-badge waiting';
        statusText.textContent = `⏸️ 第 ${mb.round} 轮就绪 (点击启动继续闭环)`;
      }
    } else if (mb.status === 'WAITING_REVIEW') {
      if (isRunning) {
        statusBadge.className = 'status-badge running';
        statusText.textContent = `🔍 正在进行第 ${mb.round} 轮审查方深度评审中...`;
      } else {
        statusBadge.className = 'status-badge waiting';
        statusText.textContent = `⏸️ 第 ${mb.round} 轮待审查 (点击启动继续)`;
      }
    }
  }

  if (emptyState) emptyState.style.display = 'none';
  if (roundsList) roundsList.innerHTML = '';

  if (mb.status === 'FAILED' || mb.status === 'ERROR' || mb.error) {
    const errCard = document.createElement('div');
    errCard.className = 'round-card error-card';
    errCard.innerHTML = `
      <div class="round-card-header" style="background: rgba(239, 68, 68, 0.15); border-left: 4px solid #ef4444; padding: 10px 14px;">
        <span class="round-title" style="color: #f87171; font-weight: 700;">❌ 执行异常中断 (FAILED)</span>
      </div>
      <div class="round-card-body" style="padding: 12px 16px;">
        <p style="color: #fca5a5; margin: 0 0 8px 0; font-size: 13px; font-weight: 600;">${escapeHtml(mb.error || '执行过程中发生未捕获异常，已停止闭环推进。')}</p>
        <p style="color: #94a3b8; font-size: 11.5px; margin: 0;">建议：请查看下方【终端实时日志】查看详细报错输出，修复配置或环境后重新启动。</p>
      </div>
    `;
    if (roundsList) roundsList.appendChild(errCard);
  }

  if (mb.devSessionId && document.getElementById('devSessionId')) {
    document.getElementById('devSessionId').value = mb.devSessionId;
  }
  if ((mb.reviewSessionId || mb.reviewerSessionId) && document.getElementById('reviewSessionId')) {
    document.getElementById('reviewSessionId').value = mb.reviewSessionId || mb.reviewerSessionId;
  }

  const allRounds = [...(mb.history || [])];
  if (mb.currentDevSubmission || mb.currentReviewVerdict) {
    allRounds.push({
      round: mb.round,
      devSubmission: mb.currentDevSubmission,
      reviewVerdict: mb.currentReviewVerdict,
      isLive: true
    });
  }

  allRounds.forEach(r => {
    const card = document.createElement('div');
    card.className = `round-card ${r.isLive ? 'current' : ''}`;

    const verdict = r.reviewVerdict ? r.reviewVerdict.verdict : (r.devSubmission ? 'WAITING_REVIEW' : 'IN_PROGRESS');
    const verdictClass = verdict === 'APPROVED' ? 'approved' : (verdict === 'REJECTED' ? 'rejected' : 'waiting');

    let issuesHtml = '';
    if (r.reviewVerdict && r.reviewVerdict.issues && r.reviewVerdict.issues.length > 0) {
      const rows = r.reviewVerdict.issues.map(iss => `
        <tr>
          <td><code>${iss.file || '-'}:${iss.lineRange || ''}</code></td>
          <td><span class="severity-pill ${iss.severity}">${iss.severity}</span></td>
          <td>${iss.problem || ''}</td>
          <td>${iss.fixSuggestion || ''}</td>
        </tr>
      `).join('');
      issuesHtml = `
        <div class="section-label">审查缺陷列表 (${r.reviewVerdict.issues.length}):</div>
        <table class="issues-table">
          <thead>
            <tr>
              <th>文件位置</th>
              <th>严重度</th>
              <th>问题描述</th>
              <th>修复建议</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    card.innerHTML = `
      <div class="round-card-header">
        <span class="round-title">🎯 第 ${r.round} 轮迭代 ${r.isLive ? '(进行中...)' : ''}</span>
        <span class="verdict-tag ${verdictClass}">${verdict}</span>
      </div>
      ${r.devSubmission ? `
        <div class="card-section">
          <div class="section-label">🛠️ 开发方提交:</div>
          <div class="section-content">${renderMarkdown(r.devSubmission.summary || '无描述')}</div>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 6px;">测试门禁状态: <b class="gate-status ${r.devSubmission.testGateStatus === 'PASS' ? 'pass' : 'fail'}">${r.devSubmission.testGateStatus || 'PENDING'}</b></div>
        </div>
      ` : ''}
      ${r.reviewVerdict ? `
        <div class="card-section">
          <div class="section-label">🔍 审查方报告:</div>
          <div class="section-content">${renderMarkdown(r.reviewVerdict.summary || '无总结')}</div>
          ${issuesHtml}
          ${r.reviewVerdict.nextPromptForDev ? `
            <div class="next-prompt-box">
              <div class="next-prompt-title">⚡ 下轮自愈指令:</div>
              <div class="next-prompt-content">${renderMarkdown(r.reviewVerdict.nextPromptForDev)}</div>
            </div>
          ` : ''}
        </div>
      ` : ''}
    `;

    if (roundsList) roundsList.appendChild(card);
  });
}

// --- LAUNCH & CONTROL LOOP ---
async function startLoop() {
  const ws = document.getElementById('workspaceRoot')?.value?.trim() || '';
  const prompt = document.getElementById('taskPrompt')?.value?.trim() || '';

  if (!ws) {
    showToast('请填写项目物理根目录路径！', 'warning');
    return;
  }
  if (!prompt) {
    showToast('请填写开发任务描述！', 'warning');
    return;
  }

  const effectiveDevModel = document.getElementById('devModelCustom')?.value?.trim() || document.getElementById('devModel')?.value;
  const effectiveReviewModel = document.getElementById('reviewModelCustom')?.value?.trim() || document.getElementById('reviewModel')?.value;

  const payload = {
    workspaceRoot: ws,
    taskPrompt: prompt,
    feature: document.getElementById('featureName')?.value?.trim() || undefined,
    devProvider: document.getElementById('devProvider')?.value,
    devModel: effectiveDevModel || undefined,
    devReasoningEffort: document.getElementById('devReasoningEffort')?.value,
    devSessionId: document.getElementById('devSessionId')?.value?.trim() || undefined,
    reviewProvider: document.getElementById('reviewProvider')?.value,
    reviewModel: effectiveReviewModel || undefined,
    reviewReasoningEffort: document.getElementById('reviewReasoningEffort')?.value,
    reviewSessionId: document.getElementById('reviewSessionId')?.value?.trim() || undefined,
    verifyCommand: document.getElementById('verifyCommand')?.value?.trim() || undefined,
    maxRounds: parseInt(document.getElementById('maxRounds')?.value, 10) || 4,
    maxSelfHealAttempts: parseInt(document.getElementById('maxSelfHealAttempts')?.value, 10) || 3,
    autoCommit: document.getElementById('autoCommit')?.checked ?? true
  };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) {
      showToast(`启动失败: ${result.error}`, 'error');
    } else {
      updateRunningState(true);
      showToast('双 Agent 闭环已成功启动！', 'success');
      switchTab('logs');
    }
  } catch (e) {
    showToast(`请求异常: ${e.message}`, 'error');
  }
}

async function stopLoop() {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const result = await res.json();
    updateRunningState(false);
    showToast(result.message || '已停止运行', 'info');
  } catch (e) {
    showToast(`停止失败: ${e.message}`, 'error');
  }
}

// --- GIT DIFF VIEWER ---
window.lastRawDiff = '';

async function copyDiffToClipboard() {
  const rawDiff = window.lastRawDiff || '';
  if (!rawDiff) {
    showToast('当前工作区无 Diff 内容可复制', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(rawDiff);
    const btn = document.getElementById('btnCopyDiff');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = '✅ 已复制!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    }
    showToast('Diff 已成功复制到剪贴板！', 'success');
  } catch (e) {
    showToast('复制失败: ' + e.message, 'error');
  }
}

async function fetchDiff() {
  const ws = document.getElementById('workspaceRoot')?.value?.trim() || '';
  if (!ws) return;

  const diffCode = document.getElementById('diffCode');
  const diffStats = document.getElementById('diffStats');
  if (diffCode) diffCode.textContent = '正在获取 Git 变更...';

  try {
    const res = await fetch(`/api/diff?workspace=${encodeURIComponent(ws)}`);
    const data = await res.json();
    if (data.error) {
      if (diffCode) diffCode.textContent = `错误: ${data.error}`;
      window.lastRawDiff = '';
      return;
    }

    if (!data.diff && !data.status) {
      if (diffCode) diffCode.textContent = '工作区干净，无未提交的 Git 变更。';
      if (diffStats) diffStats.textContent = '0 files changed';
      window.lastRawDiff = '';
      return;
    }

    window.lastRawDiff = (data.status ? `# Status:\n${data.status}\n\n` : '') + (data.diff || '');

    const lines = (data.diff || '').split('\n');
    let adds = 0, dels = 0;
    const formatted = lines.map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        adds++;
        return `<span class="diff-line-add">${escapeHtml(line)}</span>`;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        dels++;
        return `<span class="diff-line-del">${escapeHtml(line)}</span>`;
      } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('=== Tracked File:') || line.startsWith('=== Untracked File:')) {
        return `<span class="diff-line-hdr">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    }).join('\n');

    if (diffStats) diffStats.textContent = `+${adds} / -${dels}`;
    if (diffCode) diffCode.innerHTML = formatted;
  } catch (e) {
    if (diffCode) diffCode.textContent = `获取 Diff 失败: ${e.message}`;
    window.lastRawDiff = '';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Global Exports
if (typeof window !== 'undefined') {
  window.openFolderPickerModal = openFolderPickerModal;
  window.closeFolderPickerModal = closeFolderPickerModal;
  window.navigateUpFolder = navigateUpFolder;
  window.confirmSelectedFolder = confirmSelectedFolder;
  window.openFolderPicker = openFolderPicker;
  window.openFolderModal = openFolderModal;
  window.closeFolderModal = closeFolderModal;
  window.navigateParentFolder = navigateParentFolder;
  window.confirmFolderSelection = confirmFolderSelection;
  window.showToast = showToast;
  window.startDiscussion = startDiscussion;
  window.approvePlanAndStart = approvePlanAndStart;
  window.startLoop = startLoop;
  window.stopLoop = stopLoop;
  window.fetchDiff = fetchDiff;
  window.copyDiffToClipboard = copyDiffToClipboard;
  window.switchTab = switchTab;
  window.toggleReqMode = toggleReqMode;
  window.openModelManager = openModelManager;
  window.closeModelManager = closeModelManager;
  window.saveModelsManager = saveModelsManager;
  window.clearLogs = clearLogs;
  window.fetchSessions = fetchSessions;
  window.resetWorkspaceSessions = resetWorkspaceSessions;
}