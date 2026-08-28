// Dual-Agent Studio Frontend Controller (Multi-Engine, Cascading Models & Discussion Support)

let activeTab = 'timeline';
let isRunning = false;
let modelsConfig = { series: [], engineSeriesRules: {} };

// Folder Picker State
let explorerCurrentPath = '';
let explorerParentPath = null;
let explorerSelectedPath = '';

const PREF_KEY = 'dual_agent_studio_prefs';

document.addEventListener('DOMContentLoaded', async () => {
  await loadModelsConfig();
  loadUserPreferences();
  initProjects();
  initSSE();
  fetchStatus();
  const initWs = document.getElementById('workspaceRoot')?.value;
  if (initWs) autoDetectWorkspace(initWs);
  setInterval(fetchStatus, 3000);

  // Auto-save preferences on input changes
  document.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('change', saveUserPreferences);
  });
});

function saveUserPreferences() {
  try {
    const prefs = {
      workspaceRoot: document.getElementById('workspaceRoot')?.value,
      featureName: document.getElementById('featureName')?.value,
      maxRounds: document.getElementById('maxRounds')?.value,
      verifyCommand: document.getElementById('verifyCommand')?.value,
      autoCommit: document.getElementById('autoCommit')?.checked,
      devProvider: document.getElementById('devProvider')?.value,
      devSeries: document.getElementById('devSeries')?.value,
      devModelCustom: document.getElementById('devModelCustom')?.value,
      devReasoningEffort: document.getElementById('devReasoningEffort')?.value,
      reviewProvider: document.getElementById('reviewProvider')?.value,
      reviewSeries: document.getElementById('reviewSeries')?.value,
      reviewModelCustom: document.getElementById('reviewModelCustom')?.value,
      reviewReasoningEffort: document.getElementById('reviewReasoningEffort')?.value
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (e) {}
}

function loadUserPreferences() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.workspaceRoot) document.getElementById('workspaceRoot').value = p.workspaceRoot;
    if (p.featureName) document.getElementById('featureName').value = p.featureName;
    if (p.maxRounds) document.getElementById('maxRounds').value = p.maxRounds;
    if (p.verifyCommand) document.getElementById('verifyCommand').value = p.verifyCommand;
    if (p.autoCommit !== undefined) document.getElementById('autoCommit').checked = p.autoCommit;

    if (p.devProvider) {
      document.getElementById('devProvider').value = p.devProvider;
      onDevEngineChange();
      if (p.devSeries) {
        document.getElementById('devSeries').value = p.devSeries;
        onDevSeriesChange();
      }
      if (p.devModelCustom) {
        document.getElementById('devModelCustom').value = p.devModelCustom;
      }
      if (p.devReasoningEffort) {
        document.getElementById('devReasoningEffort').value = p.devReasoningEffort;
      }
    }

    if (p.reviewProvider) {
      document.getElementById('reviewProvider').value = p.reviewProvider;
      onReviewEngineChange();
      if (p.reviewSeries) {
        document.getElementById('reviewSeries').value = p.reviewSeries;
        onReviewSeriesChange();
      }
      if (p.reviewModelCustom) {
        document.getElementById('reviewModelCustom').value = p.reviewModelCustom;
      }
      if (p.reviewReasoningEffort) {
        document.getElementById('reviewReasoningEffort').value = p.reviewReasoningEffort;
      }
    }
  } catch (e) {}
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
    directBox.style.display = 'block';
    discussBox.style.display = 'none';
  } else {
    directBox.style.display = 'none';
    discussBox.style.display = 'block';
  }
}

// --- WEB DIRECTORY EXPLORER MODAL (100% Guaranteed Reliability) ---
function openFolderPickerModal() {
  const currentVal = document.getElementById('workspaceRoot').value.trim();
  const startPath = currentVal || 'D:\\project';
  document.getElementById('folderModal').style.display = 'flex';
  loadDrives();
  fetchDirectory(startPath);
}

function closeFolderPickerModal() {
  document.getElementById('folderModal').style.display = 'none';
}

async function loadDrives() {
  const drivesContainer = document.getElementById('quickDrives');
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
    btnUp.disabled = !explorerParentPath;

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

function navigateUpFolder() {
  if (explorerParentPath) {
    fetchDirectory(explorerParentPath);
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
    if (res.ok) {
      const data = await res.json();
      if (data.verifyCommand) {
        document.getElementById('verifyCommand').value = data.verifyCommand;
      }
    }
  } catch (e) {
    console.error('Failed to auto detect workspace:', e);
  }
}

function confirmSelectedFolder() {
  const selected = explorerSelectedPath || explorerCurrentPath;
  if (selected) {
    document.getElementById('workspaceRoot').value = selected;
    closeFolderPickerModal();
    autoDetectWorkspace(selected);
    fetchDiff();
    fetchStatus();
  }
}

// --- RECENT PROJECTS ---
async function initProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const container = document.getElementById('recentProjects');
    container.innerHTML = '';
    projects.forEach(p => {
      const badge = document.createElement('span');
      badge.className = 'recent-badge';
      badge.textContent = `📁 ${p.name}`;
      badge.title = p.path;
      badge.onclick = () => {
        document.getElementById('workspaceRoot').value = p.path;
        autoDetectWorkspace(p.path);
        fetchDiff();
        fetchStatus();
      };
      container.appendChild(badge);
    });
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
  const engine = document.getElementById('devProvider').value;
  const devSeries = document.getElementById('devSeries');
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
  const seriesId = document.getElementById('devSeries').value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const devModel = document.getElementById('devModel');
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

function onDevModelChange() {
  const seriesId = document.getElementById('devSeries').value;
  const modelId = document.getElementById('devModel').value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const model = series?.models?.find(m => m.id === modelId);

  // Automatically update the manual custom input box
  const customInput = document.getElementById('devModelCustom');
  if (customInput && model) {
    customInput.value = model.id;
  }

  const effortSelect = document.getElementById('devReasoningEffort');
  effortSelect.innerHTML = '';

  if (model && model.efforts && model.efforts.length > 0) {
    model.efforts.forEach(eff => {
      const opt = document.createElement('option');
      opt.value = eff.value || eff.id;
      opt.textContent = eff.label;
      if (eff.id === model.defaultEffort || eff.value === model.defaultEffort) {
        opt.selected = true;
      }
      effortSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = 'none';
    opt.textContent = 'N/A (非思考模型，直接生成代码)';
    effortSelect.appendChild(opt);
  }
}

function onReviewEngineChange() {
  const engine = document.getElementById('reviewProvider').value;
  const reviewSeries = document.getElementById('reviewSeries');
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
  const seriesId = document.getElementById('reviewSeries').value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const reviewModel = document.getElementById('reviewModel');
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
  const seriesId = document.getElementById('reviewSeries').value;
  const modelId = document.getElementById('reviewModel').value;
  const series = (modelsConfig.series || []).find(s => s.id === seriesId);
  const model = series?.models?.find(m => m.id === modelId);

  // Automatically update the manual custom input box
  const customInput = document.getElementById('reviewModelCustom');
  if (customInput && model) {
    customInput.value = model.id;
  }

  const effortSelect = document.getElementById('reviewReasoningEffort');
  effortSelect.innerHTML = '';

  if (model && model.efforts && model.efforts.length > 0) {
    model.efforts.forEach(eff => {
      const opt = document.createElement('option');
      opt.value = eff.value || eff.id;
      opt.textContent = eff.label;
      if (eff.id === model.defaultEffort || eff.value === model.defaultEffort) {
        opt.selected = true;
      }
      effortSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = 'none';
    opt.textContent = 'N/A (非思考模型，直接响应)';
    effortSelect.appendChild(opt);
  }
}

// --- MODEL MANAGER MODAL ---
function openModelManager() {
  document.getElementById('modelsJsonEditor').value = JSON.stringify(modelsConfig, null, 2);
  document.getElementById('modelModal').style.display = 'flex';
}

function closeModelManager() {
  document.getElementById('modelModal').style.display = 'none';
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
      alert('模型与规则配置已成功保存并实时生效！');
    } else {
      const err = await res.json();
      alert('保存失败: ' + err.error);
    }
  } catch (e) {
    alert('JSON 格式有误: ' + e.message);
  }
}

// --- REQUIREMENT DISCUSSION PHASE ---
async function startDiscussion() {
  const ws = document.getElementById('workspaceRoot').value.trim();
  const vague = document.getElementById('vaguePrompt').value.trim();

  if (!ws) {
    alert('请填写项目物理根目录路径！');
    return;
  }
  if (!vague) {
    alert('请输入您的初步需求或想法！');
    return;
  }

  const effectiveDevModel = document.getElementById('devModelCustom')?.value.trim() || document.getElementById('devModel').value;
  const effectiveReviewModel = document.getElementById('reviewModelCustom')?.value.trim() || document.getElementById('reviewModel').value;

  const btn = document.getElementById('btnStartDiscuss');
  btn.disabled = true;
  btn.textContent = '⏳ 双 Agent 正在推演讨论中...';

  switchTab('discussion');
  const container = document.getElementById('discussionMessages');
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">💭</div>
      <p>正在由开发方 (${document.getElementById('devProvider').value}) 与审查方 (${document.getElementById('reviewProvider').value}) 展开需求与架构对齐讨论...</p>
    </div>
  `;
  document.getElementById('humanDecisionGate').style.display = 'none';

  const payload = {
    workspaceRoot: ws,
    vaguePrompt: vague,
    devProvider: document.getElementById('devProvider').value,
    devModel: effectiveDevModel,
    devReasoningEffort: document.getElementById('devReasoningEffort').value,
    devSessionId: document.getElementById('devSessionId')?.value.trim() || undefined,
    reviewProvider: document.getElementById('reviewProvider').value,
    reviewModel: effectiveReviewModel,
    reviewReasoningEffort: document.getElementById('reviewReasoningEffort').value,
    reviewSessionId: document.getElementById('reviewSessionId')?.value.trim() || undefined
  };

  try {
    const res = await fetch('/api/discuss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    btn.disabled = false;
    btn.textContent = '💬 启动双 Agent 需求对齐与方案推演';

    if (!res.ok) {
      alert('需求讨论失败: ' + result.error);
      return;
    }

    // Render Discussion Cards
    container.innerHTML = `
      <div class="discussion-card dev">
        <div class="discussion-card-header">
          <span>🛠️ 开发方提案 (${payload.devProvider} / ${payload.devModel})</span>
          <span>方案规划</span>
        </div>
        <div class="discussion-body">${renderMarkdown(result.devProposal)}</div>
      </div>
      <div class="discussion-card reviewer">
        <div class="discussion-card-header">
          <span>🔍 审查方评估与质询 (${payload.reviewProvider} / ${payload.reviewModel})</span>
          <span>安全与门禁约束</span>
        </div>
        <div class="discussion-body">${renderMarkdown(result.reviewerFeedback)}</div>
      </div>
    `;

    // Show Human Decision Gate
    const gate = document.getElementById('humanDecisionGate');
    const editor = document.getElementById('finalPlanEditor');
    editor.value = result.finalPlan;
    if (result.suggestedFeature && !document.getElementById('featureName').value) {
      document.getElementById('featureName').value = result.suggestedFeature;
    }
    gate.style.display = 'block';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '💬 启动双 Agent 需求对齐与方案推演';
    alert('请求异常: ' + e.message);
  }
}

function approvePlanAndStart() {
  const finalPlan = document.getElementById('finalPlanEditor').value.trim();
  if (!finalPlan) {
    alert('执行方案不能为空！');
    return;
  }

  // Populate into taskPrompt and switch to direct mode execution
  document.getElementById('taskPrompt').value = finalPlan;
  toggleReqMode('direct');
  const directRadio = document.querySelector('input[name="reqMode"][value="direct"]');
  if (directRadio) directRadio.checked = true;

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

  eventSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting...');
  };
}

function appendLogLine(log) {
  const consoleEl = document.getElementById('logsConsole');
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

  if (document.getElementById('autoScroll').checked) {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

function clearLogs() {
  document.getElementById('logsConsole').innerHTML = '';
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
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
    statusBadge.className = 'status-badge running';
    statusText.textContent = '运行中 (RUNNING)';
    btnStart.disabled = true;
    btnStop.disabled = false;
  } else {
    btnStart.disabled = false;
    btnStop.disabled = true;
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

  roundBadge.style.display = 'inline-block';
  currentRoundText.textContent = mb.round;
  maxRoundText.textContent = mb.maxRounds;

  if (mb.status === 'APPROVED') {
    statusBadge.className = 'status-badge approved';
    statusText.textContent = '审核通过 (APPROVED)';
  } else if (mb.status === 'REJECTED_MAX_ROUNDS') {
    statusBadge.className = 'status-badge rejected';
    statusText.textContent = '达到最大轮次 (REJECTED)';
  }

  emptyState.style.display = 'none';
  roundsList.innerHTML = '';

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

    roundsList.appendChild(card);
  });
}

// --- LAUNCH & CONTROL LOOP ---
async function startLoop() {
  const ws = document.getElementById('workspaceRoot').value.trim();
  const prompt = document.getElementById('taskPrompt').value.trim();

  if (!ws) {
    alert('请填写项目物理根目录路径！');
    return;
  }
  if (!prompt) {
    alert('请填写开发任务描述！');
    return;
  }

  const effectiveDevModel = document.getElementById('devModelCustom')?.value.trim() || document.getElementById('devModel').value;
  const effectiveReviewModel = document.getElementById('reviewModelCustom')?.value.trim() || document.getElementById('reviewModel').value;

  const payload = {
    workspaceRoot: ws,
    taskPrompt: prompt,
    feature: document.getElementById('featureName').value.trim() || undefined,
    devProvider: document.getElementById('devProvider').value,
    devModel: effectiveDevModel || undefined,
    devReasoningEffort: document.getElementById('devReasoningEffort').value,
    devSessionId: document.getElementById('devSessionId')?.value.trim() || undefined,
    reviewProvider: document.getElementById('reviewProvider').value,
    reviewModel: effectiveReviewModel || undefined,
    reviewReasoningEffort: document.getElementById('reviewReasoningEffort').value,
    reviewSessionId: document.getElementById('reviewSessionId')?.value.trim() || undefined,
    verifyCommand: document.getElementById('verifyCommand').value.trim() || undefined,
    maxRounds: parseInt(document.getElementById('maxRounds').value, 10) || 4,
    autoCommit: document.getElementById('autoCommit').checked
  };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) {
      alert(`启动失败: ${result.error}`);
    } else {
      updateRunningState(true);
      switchTab('logs');
    }
  } catch (e) {
    alert(`请求异常: ${e.message}`);
  }
}

async function stopLoop() {
  if (!confirm('确定要停止正在运行的闭环任务吗？')) return;
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const result = await res.json();
    updateRunningState(false);
  } catch (e) {
    alert(`停止失败: ${e.message}`);
  }
}

// --- GIT DIFF VIEWER ---
window.lastRawDiff = '';

async function copyDiffToClipboard() {
  const rawDiff = window.lastRawDiff || '';
  if (!rawDiff) {
    alert('当前工作区无 Diff 内容可复制');
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
  } catch (e) {
    alert('复制失败: ' + e.message);
  }
}

async function fetchDiff() {
  const ws = document.getElementById('workspaceRoot').value.trim();
  if (!ws) return;

  const diffCode = document.getElementById('diffCode');
  const diffStats = document.getElementById('diffStats');
  diffCode.textContent = '正在获取 Git 变更...';

  try {
    const res = await fetch(`/api/diff?workspace=${encodeURIComponent(ws)}`);
    const data = await res.json();
    if (data.error) {
      diffCode.textContent = `错误: ${data.error}`;
      window.lastRawDiff = '';
      return;
    }

    if (!data.diff && !data.status) {
      diffCode.textContent = '工作区干净，无未提交的 Git 变更。';
      diffStats.textContent = '0 files changed';
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
      } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('=== Untracked File:')) {
        return `<span class="diff-line-hdr">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    }).join('\n');

    diffStats.textContent = `+${adds} / -${dels}`;
    diffCode.innerHTML = formatted;
  } catch (e) {
    diffCode.textContent = `获取 Diff 失败: ${e.message}`;
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