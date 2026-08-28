// Dual-Agent Studio Frontend Controller

let activeTab = 'timeline';
let isRunning = false;

document.addEventListener('DOMContentLoaded', () => {
  initProjects();
  initSSE();
  fetchStatus();
  setInterval(fetchStatus, 3000);
});

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
        fetchDiff();
        fetchStatus();
      };
      container.appendChild(badge);
    });
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

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
        <div>
          <div class="section-label">🛠️ 开发方提交:</div>
          <div style="font-size: 12px; color: #cbd5e1;">${r.devSubmission.summary || '无描述'}</div>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">测试门禁状态: <b>${r.devSubmission.testGateStatus || 'PENDING'}</b></div>
        </div>
      ` : ''}
      ${r.reviewVerdict ? `
        <div>
          <div class="section-label">🔍 审查方报告:</div>
          <div style="font-size: 12px; color: #cbd5e1; font-weight: 500;">${r.reviewVerdict.summary || '无总结'}</div>
          ${issuesHtml}
          ${r.reviewVerdict.nextPromptForDev ? `
            <div style="margin-top: 8px; font-size: 11px; color: #f59e0b; background: rgba(245,158,11,0.1); padding: 6px 10px; border-radius: 4px;">
              <b>下轮自愈指令:</b> ${r.reviewVerdict.nextPromptForDev}
            </div>
          ` : ''}
        </div>
      ` : ''}
    `;

    roundsList.appendChild(card);
  });
}

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

  const payload = {
    workspaceRoot: ws,
    taskPrompt: prompt,
    feature: document.getElementById('featureName').value.trim() || undefined,
    devProvider: document.getElementById('devProvider').value,
    devModel: document.getElementById('devModel').value.trim() || undefined,
    devReasoningEffort: document.getElementById('devReasoningEffort').value,
    reviewProvider: document.getElementById('reviewProvider').value,
    reviewModel: document.getElementById('reviewModel').value.trim() || undefined,
    reviewReasoningEffort: document.getElementById('reviewReasoningEffort').value,
    copilotSessionId: document.getElementById('copilotSessionId').value.trim() || undefined,
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
      return;
    }

    if (!data.diff && !data.status) {
      diffCode.textContent = '工作区干净，无未提交的 Git 变更。';
      diffStats.textContent = '0 files changed';
      return;
    }

    const lines = (data.diff || '').split('\n');
    let adds = 0, dels = 0;
    const formatted = lines.map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        adds++;
        return `<span class="diff-line-add">${escapeHtml(line)}</span>`;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        dels++;
        return `<span class="diff-line-del">${escapeHtml(line)}</span>`;
      } else if (line.startsWith('diff --git') || line.startsWith('index ')) {
        return `<span class="diff-line-hdr">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    }).join('\n');

    diffStats.textContent = `+${adds} / -${dels}`;
    diffCode.innerHTML = formatted;
  } catch (e) {
    diffCode.textContent = `获取 Diff 失败: ${e.message}`;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}